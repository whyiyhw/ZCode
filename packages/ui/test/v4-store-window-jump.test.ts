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

function row(rowId: number, kind: "turnHeader" | "assistantText" | "userInput" = "assistantText"): ConversationRow {
  const base = { rowId, turnId: `turn-${Math.floor(rowId / 10)}`, createdAt: rowId, createdAtSeq: rowId };
  if (kind === "turnHeader") return { ...base, kind, state: "completedSuccess" } as ConversationRow;
  if (kind === "userInput") return { ...base, kind, text: `q${rowId}`, origin: "realUser" } as ConversationRow;
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
    config: { provider: "", model: "", thought: "", thoughtLevels: [], followupMode: "queue", mode: "build" },
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
  assert.equal(trimConversationWindowFromHead(Array.from({ length: 100 }, (_, i) => row(i + 1))), null);
  // 每 10 行一个 turn（header 在 x1 位）：2100 行 → 从 minStart 起找首个 header
  const rows: ConversationRow[] = [];
  for (let i = 1; i <= 2100; i++) {
    rows.push(i % 10 === 1 ? row(i, "turnHeader") : row(i));
  }
  const trimmed = trimConversationWindowFromHead(rows);
  assert.ok(trimmed);
  assert.equal(trimmed.truncatedAtLimit, false);
  assert.ok(trimmed.window.length <= CONVERSATION_WINDOW_MAX_ROWS);
  assert.equal(trimmed.window[0]?.kind, "turnHeader", "裁剪须落在 turn 边界");
  assert.ok(trimmed.window.length > CONVERSATION_WINDOW_MAX_ROWS - 10, "尽量贴近上限（不裁掉整个 turn）");
  // 巨型单轮：2100 行全是一个 turn（仅 row1 是 header，在窗口外）
  const giant: ConversationRow[] = [row(1, "turnHeader"), ...Array.from({ length: 2100 }, (_, i) => row(i + 2))];
  const giantTrim = trimConversationWindowFromHead(giant);
  assert.ok(giantTrim);
  assert.equal(giantTrim.truncatedAtLimit, true);
  assert.equal(giantTrim.window.length, CONVERSATION_WINDOW_MAX_ROWS);
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
  resolveRowsRange(rows: ConversationRow[], atLogEpoch?: string): void;
  get rowsRangeCalls(): unknown[];
}

function createJumpHarness(initialRows: ConversationRow[], firstRowId: number | null): JumpHarness {
  const frameListeners: Array<(frame: ConversationTopicFrame, ctx?: { deliveryKind: string }) => void> = [];
  const rowsRangeCalls: unknown[] = [];
  let pendingRowsRange: ((result: { rows: ConversationRow[]; atSeq: number; atRevision: number; atLogEpoch: string; hasMore: boolean }) => void) | null = null;
  const snapshot = snapshotWith(initialRows, firstRowId);
  const transport = {
    subscribe: async () => ({ ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" } }),
    activate: () => {
      for (const listener of frameListeners) {
        listener(
          { topic: TOPIC, subscriptionId: "sub-1", fromSeq: 0, toSeq: 10_000, payload: { kind: "snapshot", snapshot } } as ConversationTopicFrame,
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
    onFrame: (listener: (frame: ConversationTopicFrame, ctx?: { deliveryKind: string }) => void) => {
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
  const tail = Array.from({ length: 60 }, (_, i) => row(i + 4941, i === 4940 ? "turnHeader" : undefined));
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
  h.resolveRowsRange(Array.from({ length: 50 }, (_, i) => row(i + 351)), "epoch-OTHER");
  assert.equal(await staleJump, false);
  assert.equal(h.store.getState().snapshot?.rows.window[0]?.rowId, 201);

  // 回底：区间拉回尾部，脱离解除。
  const tailJump = h.store.jumpToTail();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((h.rowsRangeCalls[2] as { aroundRowId?: number; beforeRowId?: number })?.aroundRowId, undefined);
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
