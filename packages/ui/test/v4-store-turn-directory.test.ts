// store 目录刷新单测（口径：packages/shared/spec/conversation-turn-directory.md）。
// 运行：npx tsx --test packages/ui/test/v4-store-turn-directory.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationSnapshot,
  ConversationTopicFrame,
  ConversationTurnDirectoryItem,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjectionStore } from "../src/v4/conversationProjectionStore.js";
import { conversationTopic, type ConversationTransport } from "../src/v4/transport.js";

const TOPIC = conversationTopic("dir-test");

function makeSnapshot(seq: number): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "dir-test",
    logEpoch: "epoch-1",
    seq,
    revision: 0,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: { fork: { allowed: true } },
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "default" },
    config: {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    workflowRuns: { revision: 0, runs: [] },
    rows: { window: [], totalCount: 0, firstRowId: null },
  } as unknown as ConversationSnapshot;
}

interface DirectoryCall {
  params: unknown;
  resolve(result: {
    items: ConversationTurnDirectoryItem[];
    hasPluginReference: boolean;
    atSeq: number;
    atLogEpoch: string;
  }): void;
}

function createHarness() {
  const frameListeners: Array<
    (frame: ConversationTopicFrame, context?: { deliveryKind: "initial" | "online" }) => void
  > = [];
  const directoryCalls: DirectoryCall[] = [];
  let directoryCallCount = 0;
  const transport = {
    subscribe: async () => ({
      ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" },
    }),
    activate: () => {
      const snapshot = makeSnapshot(100);
      const frame = {
        topic: TOPIC,
        subscriptionId: "sub-1",
        fromSeq: 0,
        toSeq: 100,
        payload: { kind: "snapshot", snapshot },
      } as ConversationTopicFrame;
      for (const listener of frameListeners) listener(frame, { deliveryKind: "initial" });
    },
    resync: async () => ({
      ack: { subscriptionId: "sub-2", mode: "snapshot", logEpoch: "epoch-1" },
    }),
    unsubscribe: async () => {},
    turnDirectory: (params: unknown) => {
      directoryCallCount += 1;
      return new Promise((resolve) => {
        directoryCalls.push({ params, resolve });
      });
    },
    onFrame: (
      listener: (
        frame: ConversationTopicFrame,
        context?: { deliveryKind: "initial" | "online" },
      ) => void,
    ) => {
      frameListeners.push(listener);
      return () => {
        const index = frameListeners.indexOf(listener);
        if (index >= 0) frameListeners.splice(index, 1);
      };
    },
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  } as unknown as ConversationTransport;
  const store = new ConversationProjectionStore(TOPIC, transport);
  // onFrame → handleFrame 的扇入平时由 SessionDataLayer 承担；精简桩直接桥接。
  frameListeners.push((frame, context) => store.handleFrame(frame, context));
  return {
    store,
    get directoryCallCount() {
      return directoryCallCount;
    },
    emitOnline(frame: ConversationTopicFrame) {
      for (const listener of frameListeners) listener(frame, { deliveryKind: "online" });
    },
    /** 手动放行第 N 个在途目录查询（从 1 计）。 */
    settleCall(
      index: number,
      result: DirectoryCall["resolve"] extends (...args: infer R) => void ? R[0] : never,
    ) {
      const call = directoryCalls[index - 1];
      if (!call) throw new Error(`directory call ${index} not in flight`);
      call.resolve(result);
    },
  };
}

const ITEMS: ConversationTurnDirectoryItem[] = [
  {
    rowId: 1,
    turnId: "t1",
    userPreview: "q1",
    assistantPreview: "",
    assistantPreviewKind: "empty",
    isRunning: false,
  },
];

async function connectStore(store: ConversationProjectionStore) {
  await store.connect();
  for (let i = 0; i < 50 && store.getState().snapshot === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(store.getState().snapshot, "initial snapshot 未应用");
}

test("目录刷新：成功写入 items 与 plugin 事实；epoch 漂移 → stale 且不写回", async () => {
  const h = createHarness();
  await connectStore(h.store);

  const first = h.store.refreshTurnNavigatorDirectory();
  h.settleCall(1, { items: ITEMS, hasPluginReference: true, atSeq: 100, atLogEpoch: "epoch-1" });
  assert.equal((await first).status, "hydrated");
  assert.deepEqual(h.store.getState().turnNavigatorDirectory, ITEMS);
  assert.equal(h.store.getState().directoryHasPluginReference, true);
  assert.equal(h.store.getState().directoryLoading, false);

  const second = h.store.refreshTurnNavigatorDirectory();
  h.settleCall(2, { items: [], hasPluginReference: false, atSeq: 100, atLogEpoch: "epoch-OTHER" });
  assert.equal((await second).status, "stale");
  // 旧 epoch 的结果不得写回：目录保持第一次的内容。
  assert.deepEqual(h.store.getState().turnNavigatorDirectory, ITEMS);
  assert.equal(h.store.getState().directoryHasPluginReference, true);
});

test("查询期间 revision 失效（新增 realUser query）→ stale 不写回，组件层按新 key 重查", async () => {
  const h = createHarness();
  await connectStore(h.store);
  const revisionBefore = h.store.getState().turnNavigatorDirectoryRevision;

  const pending = h.store.refreshTurnNavigatorDirectory();
  // 在途期间新增 realUser query 行：shouldInvalidateTurnNavigatorDirectory 递增 revision。
  h.emitOnline({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 100,
    toSeq: 101,
    payload: {
      kind: "deltas",
      deltas: [
        {
          op: "row.appended",
          row: {
            rowId: 900,
            turnId: "t9",
            createdAt: 1,
            createdAtSeq: 1,
            kind: "userInput",
            text: "新 query",
            origin: "realUser",
          },
        },
      ],
    },
  } as ConversationTopicFrame);
  assert.ok(
    h.store.getState().turnNavigatorDirectoryRevision > revisionBefore,
    "realUser query 追加应递增目录 revision",
  );

  h.settleCall(1, { items: ITEMS, hasPluginReference: false, atSeq: 101, atLogEpoch: "epoch-1" });
  assert.equal((await pending).status, "stale");
  assert.equal(h.store.getState().turnNavigatorDirectory, null, "失效结果不得写回");
});

test("在途失效后 store 侧 pending 重查闭环（不依赖组件层依赖变化）", async () => {
  const h = createHarness();
  await connectStore(h.store);

  const first = h.store.refreshTurnNavigatorDirectory();
  // 在途期间新增 realUser query：revision 失效，首查将 stale。
  h.emitOnline({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 100,
    toSeq: 101,
    payload: {
      kind: "deltas",
      deltas: [
        {
          op: "row.appended",
          row: {
            rowId: 900,
            turnId: "t9",
            createdAt: 1,
            createdAtSeq: 1,
            kind: "userInput",
            text: "新 query",
            origin: "realUser",
          },
        },
      ],
    },
  } as ConversationTopicFrame);
  h.settleCall(1, { items: ITEMS, hasPluginReference: false, atSeq: 101, atLogEpoch: "epoch-1" });
  assert.equal((await first).status, "stale");
  // finally 闭环应已自动发起第二次查询。
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.directoryCallCount, 2, "stale 后 store 应自动重查");
  h.settleCall(2, { items: ITEMS, hasPluginReference: false, atSeq: 101, atLogEpoch: "epoch-1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.store.getState().turnNavigatorDirectory, ITEMS);
});

test("turnHeader 终态 upsert 递增目录 revision（isRunning 熄灭驱动）", async () => {
  const h = createHarness();
  await connectStore(h.store);
  const revisionBefore = h.store.getState().turnNavigatorDirectoryRevision;
  h.emitOnline({
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 100,
    toSeq: 101,
    payload: {
      kind: "deltas",
      deltas: [
        {
          op: "row.upserted",
          row: {
            rowId: 800,
            turnId: "t8",
            createdAt: 1,
            createdAtSeq: 1,
            kind: "turnHeader",
            state: "completedSuccess",
          },
        },
      ],
    },
  } as ConversationTopicFrame);
  assert.ok(
    h.store.getState().turnNavigatorDirectoryRevision > revisionBefore,
    "turnHeader upsert 应递增目录 revision",
  );
});

test("并发刷新单飞：共享同一 in-flight 查询，transport 只被调用一次", async () => {
  const h = createHarness();
  await connectStore(h.store);

  const a = h.store.refreshTurnNavigatorDirectory();
  const b = h.store.refreshTurnNavigatorDirectory();
  h.settleCall(1, { items: ITEMS, hasPluginReference: false, atSeq: 100, atLogEpoch: "epoch-1" });
  assert.equal((await a).status, "hydrated");
  assert.equal((await b).status, "hydrated");
  assert.equal(h.directoryCallCount, 1);
});
