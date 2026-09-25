// 行窗口淘汰 + 区间跳转单测（B2 阶段 2；口径见 spec/conversation-turn-directory.md 窗口节）。
// 运行：cd packages/ui && npx tsx --test test/v4-store-window-jump.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  CONVERSATION_WINDOW_MAX_ROWS,
  ConversationProjectionStore,
  shouldAutoLoadIncompleteLeadingTurn,
  trimConversationWindowFromHead,
} from "../src/v4/conversationProjectionStore.js";
import { conversationTopic, type ConversationTransport } from "../src/v4/transport.js";

const TOPIC = conversationTopic("jump-test");

function row(
  rowId: number,
  kind: "turnHeader" | "assistantText" | "userInput" = "assistantText",
): ConversationRow {
  const base = {
    rowId,
    turnId: `turn-${Math.floor(rowId / 10)}`,
    createdAt: rowId,
    createdAtSeq: rowId,
  };
  if (kind === "turnHeader") return { ...base, kind, state: "completedSuccess" } as ConversationRow;
  if (kind === "userInput")
    return { ...base, kind, text: `q${rowId}`, origin: "realUser" } as ConversationRow;
  return { ...base, kind, text: `t${rowId}`, state: "complete" } as ConversationRow;
}

function snapshotWith(rows: ConversationRow[], firstRowId: number | null): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "jump-test",
    logEpoch: "epoch-1",
    seq: 10_000,
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
    rows: { window: rows, totalCount: 5_000, firstRowId },
  } as unknown as ConversationSnapshot;
}

test("淘汰纯函数：turn 边界对齐、残缺标记、不足上限不动", () => {
  // 无需淘汰
  assert.equal(
    trimConversationWindowFromHead(Array.from({ length: 100 }, (_, i) => row(i + 1))),
    null,
  );
  // 每 10 行一个 turn（header 在 x1 位）：2100 行 → 从 minStart 起找首个 header
  const rows: ConversationRow[] = [];
  for (let i = 1; i <= 2100; i++) {
    rows.push(i % 10 === 1 ? row(i, "turnHeader") : row(i));
  }
  // 迟滞：触发线 K=2000，裁到 T1 = K - 200（一页余量）。
  const trimmed = trimConversationWindowFromHead(rows);
  assert.ok(trimmed);
  assert.equal(trimmed.truncatedAtLimit, false);
  assert.ok(trimmed.window.length <= 1_800, "裁剪目标线 T1 = K - 一页余量");
  assert.equal(trimmed.window[0]?.kind, "turnHeader", "裁剪须落在 turn 边界");
  assert.ok(trimmed.window.length > 1_800 - 10, "尽量贴近目标线（不裁掉整个 turn）");
  // 巨型单轮：2100 行全是一个 turn（仅 row1 是 header，在窗口外）
  const giant: ConversationRow[] = [
    row(1, "turnHeader"),
    ...Array.from({ length: 2100 }, (_, i) => row(i + 2)),
  ];
  const giantTrim = trimConversationWindowFromHead(giant);
  assert.ok(giantTrim);
  assert.equal(giantTrim.truncatedAtLimit, true);
  assert.equal(giantTrim.window.length, 1_800);
  assert.notEqual(giantTrim.window[0]?.kind, "turnHeader");
});

test("首轮补拉抑制：淘汰上限的残缺头部不触发自动补拉（防补拉-淘汰循环）", () => {
  const giantRows = Array.from({ length: CONVERSATION_WINDOW_MAX_ROWS }, (_, i) => row(i + 1));
  const giantSnapshot = snapshotWith(giantRows, 1);
  assert.equal(shouldAutoLoadIncompleteLeadingTurn(giantSnapshot, false), false);
  // 冷快照尾窗截断（小窗口缺 header）仍应触发补拉。
  const tailRows = Array.from({ length: 60 }, (_, i) => row(i + 4941));
  const tailSnapshot = snapshotWith(tailRows, 1);
  assert.equal(shouldAutoLoadIncompleteLeadingTurn(tailSnapshot, false), true);
});

interface JumpHarness {
  store: ConversationProjectionStore;
  emitOnline(deltas: unknown[]): void;
  emitOnlineAt(fromSeq: number, toSeq: number, deltas: unknown[]): void;
  emitSnapshot(rows: ConversationRow[]): void;
  resolveRowsRange(rows: ConversationRow[], atLogEpoch?: string): void;
  resolveRowsRangeAt(rows: ConversationRow[], atSeq: number): void;
  get rowsRangeCalls(): unknown[];
}

function createJumpHarness(initialRows: ConversationRow[], firstRowId: number | null): JumpHarness {
  const frameListeners: Array<
    (frame: ConversationTopicFrame, ctx?: { deliveryKind: string }) => void
  > = [];
  const rowsRangeCalls: unknown[] = [];
  let pendingRowsRange:
    | ((result: {
        rows: ConversationRow[];
        atSeq: number;
        atRevision: number;
        atLogEpoch: string;
        hasMore: boolean;
      }) => void)
    | null = null;
  const snapshot = snapshotWith(initialRows, firstRowId);
  const transport = {
    subscribe: async () => ({
      ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" },
    }),
    activate: () => {
      for (const listener of frameListeners) {
        listener(
          {
            topic: TOPIC,
            subscriptionId: "sub-1",
            fromSeq: 0,
            toSeq: 10_000,
            payload: { kind: "snapshot", snapshot },
          } as ConversationTopicFrame,
          { deliveryKind: "initial" },
        );
      }
    },
    rowsRange: (params: unknown) => {
      rowsRangeCalls.push(params);
      return new Promise((resolve) => {
        pendingRowsRange = resolve;
      });
    },
    onFrame: (
      listener: (frame: ConversationTopicFrame, ctx?: { deliveryKind: string }) => void,
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
  frameListeners.push((frame, context) => store.handleFrame(frame, context as never));
  return {
    store,
    emitOnline: (deltas: unknown[]) => {
      const currentSeq = store.getState().snapshot?.seq ?? 10_000;
      for (const listener of frameListeners) {
        listener(
          {
            topic: TOPIC,
            subscriptionId: "sub-1",
            fromSeq: currentSeq,
            toSeq: currentSeq + deltas.length,
            payload: { kind: "deltas", deltas },
          } as ConversationTopicFrame,
          { deliveryKind: "online" },
        );
      }
    },
    resolveRowsRange: (rows: ConversationRow[], atLogEpoch = "epoch-1") => {
      assert.ok(pendingRowsRange, "rowsRange 不在途");
      pendingRowsRange({ rows, atSeq: 10_000, atRevision: 1, atLogEpoch, hasMore: false });
      pendingRowsRange = null;
    },
    resolveRowsRangeAt: (rows: ConversationRow[], atSeq: number) => {
      assert.ok(pendingRowsRange, "rowsRange 不在途");
      pendingRowsRange({ rows, atSeq, atRevision: 1, atLogEpoch: "epoch-1", hasMore: false });
      pendingRowsRange = null;
    },
    emitOnlineAt: (fromSeq: number, toSeq: number, deltas: unknown[]) => {
      for (const listener of frameListeners) {
        listener(
          {
            topic: TOPIC,
            subscriptionId: "sub-1",
            fromSeq,
            toSeq,
            payload: { kind: "deltas", deltas },
          } as ConversationTopicFrame,
          { deliveryKind: "online" },
        );
      }
    },
    emitSnapshot: (rows: ConversationRow[]) => {
      for (const listener of frameListeners) {
        listener(
          {
            topic: TOPIC,
            subscriptionId: "sub-1",
            fromSeq: 0,
            toSeq: 20_000,
            payload: { kind: "snapshot", snapshot: snapshotWith(rows, null) },
          } as ConversationTopicFrame,
          { deliveryKind: "online" },
        );
      }
    },
    get rowsRangeCalls() {
      return rowsRangeCalls;
    },
  };
}

async function connectJumpStore(store: ConversationProjectionStore) {
  await store.connect();
  for (let i = 0; i < 50 && store.getState().snapshot === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(store.getState().snapshot);
}

test("jumpToRow：区间替换窗口、epoch 守卫、脱离标记；jumpToTail 恢复", async () => {
  const tail = Array.from({ length: 60 }, (_, i) =>
    row(i + 4941, i === 4940 ? "turnHeader" : undefined),
  );
  const h = createJumpHarness(tail, 1);
  await connectJumpStore(h.store);
  assert.equal(h.store.getState().detachedFromLiveTail, false);

  // 跳到历史：服务端返回目标区间（rowId 300 附近）。
  const jump = h.store.jumpToRow(300);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((h.rowsRangeCalls[0] as { aroundRowId?: number })?.aroundRowId, 300);
  h.resolveRowsRange(Array.from({ length: 200 }, (_, i) => row(i + 201)));
  assert.equal(await jump, true);
  const state = h.store.getState();
  assert.equal(state.snapshot?.rows.window.length, 200);
  assert.equal(state.snapshot?.rows.window[0]?.rowId, 201);
  // firstRowId/totalCount 保持权威值不动。
  assert.equal(state.snapshot?.rows.firstRowId, 1);
  assert.equal(state.snapshot?.rows.totalCount, 5_000);
  assert.equal(state.detachedFromLiveTail, true, "窗口尾(400) < 高水位(5000) 应脱离");

  // epoch 漂移的结果整体丢弃、窗口不动。
  const staleJump = h.store.jumpToRow(350);
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.resolveRowsRange(
    Array.from({ length: 50 }, (_, i) => row(i + 351)),
    "epoch-OTHER",
  );
  assert.equal(await staleJump, false);
  assert.equal(h.store.getState().snapshot?.rows.window[0]?.rowId, 201);

  // 回底：区间拉回尾部，脱离解除。
  const tailJump = h.store.jumpToTail();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    (h.rowsRangeCalls[2] as { aroundRowId?: number; beforeRowId?: number })?.aroundRowId,
    undefined,
  );
  h.resolveRowsRange(Array.from({ length: 60 }, (_, i) => row(i + 4941)));
  assert.equal(await tailJump, true);
  assert.equal(h.store.getState().detachedFromLiveTail, false);

  // 跳转在途与 loadOlder 互斥：jump 挂起时 loadOlder 直接 no-op。
  const held = h.store.jumpToRow(200);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await h.store.loadOlder();
  // 此前已有 4 次合法调用（300 / 350 stale / tail / 在途 200）：loadOlder 不得新增。
  assert.equal(h.rowsRangeCalls.length, 4, "在途 jump 期间 loadOlder 不得发起 rowsRange");
  h.resolveRowsRange(Array.from({ length: 200 }, (_, i) => row(i + 101)));
  assert.equal(await held, true);
});

test("流式追加把窗口顶过上限：淘汰在 applyFrame 落地，firstRowId/totalCount 不动", async () => {
  // 构造 2005 行的已加载窗口（模拟用户已上滚加载）。
  const rows: ConversationRow[] = [];
  for (let i = 1; i <= 2005; i++) {
    rows.push(i % 10 === 1 ? row(i, "turnHeader") : row(i));
  }
  const h = createJumpHarness(rows, 1);
  await connectJumpStore(h.store);
  assert.equal(h.store.getState().snapshot?.rows.window.length, 2005);

  // 一条 append 帧触发淘汰：窗口回到 turn 边界对齐的 ≤2000。
  h.emitOnline([{ op: "row.appended", row: row(2006) }]);
  const state = h.store.getState();
  assert.ok(
    (state.snapshot?.rows.window.length ?? 0) <= CONVERSATION_WINDOW_MAX_ROWS,
    "超限窗口应在流式帧后淘汰",
  );
  assert.equal(state.snapshot?.rows.window[0]?.kind, "turnHeader", "淘汰须落在 turn 边界");
  assert.equal(state.snapshot?.rows.firstRowId, 1, "firstRowId 是全序权威值不动");
  assert.equal(state.snapshot?.rows.totalCount, 5_001, "totalCount 随 append 权威 +1");
  assert.equal(state.detachedFromLiveTail, false);
});

test("评审 C1a：跳转后 seq 对齐 atSeq，在途重叠帧静默丢弃（无重复行）", async () => {
  const tail = Array.from({ length: 60 }, (_, i) => row(i + 4941));
  const h = createJumpHarness(tail, 1);
  await connectJumpStore(h.store);
  const baseSeq = h.store.getState().snapshot?.seq ?? 0;

  const jump = h.store.jumpToRow(300);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // 服务端区间取自 atSeq = baseSeq + 20（客户端落后 20 条水位）。
  h.resolveRowsRangeAt(
    Array.from({ length: 200 }, (_, i) => row(i + 201)),
    baseSeq + 20,
  );
  assert.equal(await jump, true);
  assert.equal(h.store.getState().snapshot?.seq, baseSeq + 20, "seq 水位必须对齐窗口内容的 atSeq");

  // 在途重叠帧 (baseSeq, baseSeq+20] 到达：toSeq ≤ 抬升后的 seq → 静默丢弃。
  h.emitOnlineAt(baseSeq, baseSeq + 5, [
    { op: "row.appended", row: row(5001) },
    { op: "row.appended", row: row(5002) },
  ]);
  const state = h.store.getState();
  const windowRowIds = (state.snapshot?.rows.window ?? []).map((r) => r.rowId);
  assert.ok(!windowRowIds.includes(5001), "重叠帧的 append 不得双重应用");
  assert.equal(state.snapshot?.seq, baseSeq + 20, "迟到帧不得推进 seq");

  // 后续新帧 (atSeq, ...] 衔接：seq 推进；跳转落点在历史区间 → 仍脱离 →
  // 实时 append 按设计丢弃（C1b），内容经 jumpToTail 补回。
  h.emitOnlineAt(baseSeq + 20, baseSeq + 21, [{ op: "row.appended", row: row(5003) }]);
  const after = h.store.getState();
  assert.equal(after.snapshot?.seq, baseSeq + 21, "新帧应推进 seq 水位");
  assert.ok(
    !(after.snapshot?.rows.window ?? []).some((r) => r.rowId === 5003),
    "脱离态的实时 append 丢弃（与 C1b 口径一致）",
  );
});

test("评审 C1b：脱离态实时 append 丢弃（窗口连续不变量）+ 高水位仍抬升", async () => {
  const tail = Array.from({ length: 60 }, (_, i) => row(i + 4941));
  const h = createJumpHarness(tail, 1);
  await connectJumpStore(h.store);

  const jump = h.store.jumpToRow(300);
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.resolveRowsRange(Array.from({ length: 200 }, (_, i) => row(i + 201)));
  assert.equal(await jump, true);
  assert.equal(h.store.getState().detachedFromLiveTail, true);

  // 实时新行 append：不得拼进历史窗口（rowId 5001 与窗口尾 400 之间有空洞）。
  h.emitOnline([{ op: "row.appended", row: row(5001) }]);
  const state = h.store.getState();
  const windowRowIds = (state.snapshot?.rows.window ?? []).map((r) => r.rowId);
  assert.ok(!windowRowIds.includes(5001), "脱离态实时 append 必须丢弃");
  assert.equal(windowRowIds[windowRowIds.length - 1], 400, "窗口尾保持跳转区间尾（连续不变量）");
  assert.equal(state.detachedFromLiveTail, true, "脱离不得被实时 append 误解除");
  // state.updated 照常应用。
  assert.equal(state.snapshot?.seq, h.store.getState().snapshot?.seq ?? 0);
});

test("评审 m2：snapshot 重置高水位（rewind 后脱离标记清除）", async () => {
  const tail = Array.from({ length: 60 }, (_, i) => row(i + 4941));
  const h = createJumpHarness(tail, 1);
  await connectJumpStore(h.store);
  const jump = h.store.jumpToRow(300);
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.resolveRowsRange(Array.from({ length: 200 }, (_, i) => row(i + 201)));
  assert.equal(await jump, true);
  assert.equal(h.store.getState().detachedFromLiveTail, true);

  // rewind 后 resync snapshot：新全序从 1 重新计数（apply.ts 的 rewind 语义）。
  const rewound = Array.from({ length: 60 }, (_, i) => row(i + 1));
  h.emitSnapshot(rewound);
  assert.equal(
    h.store.getState().detachedFromLiveTail,
    false,
    "snapshot 是权威当前态，高水位须真重置（max 语义会让 rewind 后永久脱离）",
  );
});

test("评审 M2-b：跳转窗口一次性抑制首轮自动补拉", async () => {
  const tail = Array.from({ length: 60 }, (_, i) => row(i + 4941));
  const h = createJumpHarness(tail, 1);
  await connectJumpStore(h.store);
  assert.equal(h.store.consumeLeadingTurnBackfillSuppression(), false);

  const jump = h.store.jumpToRow(300);
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.resolveRowsRange(
    Array.from({ length: 200 }, (_, i) => row(i + 201, i === 0 ? "turnHeader" : undefined)),
  );
  assert.equal(await jump, true);
  // 一次性消费：第一次 true，之后 false（mid-turn 开窗不触发链式补拉）。
  assert.equal(h.store.consumeLeadingTurnBackfillSuppression(), true);
  assert.equal(h.store.consumeLeadingTurnBackfillSuppression(), false);
});

test("评审 M2-a：迟滞淘汰保证满窗翻页不进死路（饱和巨轮 3 进 1 退）", async () => {
  // 2000 行巨型单轮窗口（无内部 header 可对齐）+ 60 行页。
  const rows: ConversationRow[] = [
    row(1, "turnHeader"),
    ...Array.from({ length: 1999 }, (_, i) => row(i + 2)),
  ];
  const h = createJumpHarness(rows, -10_000);
  await connectJumpStore(h.store);
  assert.equal(h.store.getState().snapshot?.rows.window.length, 2000);

  // 第一轮（饱和态）：合并 2060 > K → 迟滞裁到 T1=1800，此轮新拉页可能被裁。
  const first = h.store.loadOlder(60);
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.resolveRowsRange(Array.from({ length: 60 }, (_, i) => row(-59 + i)));
  await first;
  const afterFirst = h.store.getState().snapshot?.rows.window ?? [];
  assert.ok(afterFirst.length <= 1800, "饱和巨轮触发迟滞裁剪到 T1");

  // 第二轮（有余量）：1860 < K=2000，合并点不裁——新拉页必须完整并入（死路解除）。
  const second = h.store.loadOlder(60);
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.resolveRowsRange(Array.from({ length: 60 }, (_, i) => row(-119 + i)));
  await second;
  const afterSecond = h.store.getState().snapshot?.rows.window ?? [];
  assert.ok(
    afterSecond.some((r) => r.rowId === -90),
    "有余量时新拉页必须完整并入（评审 M2-a 死路解除）",
  );
  assert.ok(afterSecond.length <= 2000, "合并后仍在触发线内");
});
