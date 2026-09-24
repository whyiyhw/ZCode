// applyConversationDeltasBatch 黄金等价测试（口径：packages/shared/spec/conversation-delta-batch-apply.md）。
// 裁判标准：batch(帧应用) 与逐条不可变折叠在任意 delta 序列上 JSON 逐字节一致；
// 无 row 操作帧复用原 rows 引用；已发布快照永不被改写；coalesce 语义保持不变量。
// 运行：npx tsx --test packages/shared/test/zcode-protocol-v4-apply-batch.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConversationDeltas,
  applyConversationDeltasBatch,
  coalesceConversationDeltas,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
} from "../src/zcode-protocol-v4/index.js";

// ── 夹具 ──
// 快照只对 apply 的触达面有结构要求（顶层键 + rows + workflowRuns）；A 区深字段
// 以最小结构占位、经一次 cast 满足类型——等价性与引用断言都不依赖 A 区内容。
function makeRow(
  rowId: number,
  createdAtSeq: number,
  state: "streaming" | "complete",
): ConversationRow {
  return {
    rowId,
    turnId: `turn-${Math.floor(rowId / 3)}`,
    createdAt: createdAtSeq,
    createdAtSeq,
    kind: "assistantText",
    text: `text-${rowId}`,
    state,
  };
}

function makeSnapshot(rows: ConversationRow[], seq: number): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "sess-test",
    logEpoch: "epoch-1",
    seq,
    revision: 0,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: { fork: { allowed: true } },
    inputRouting: { mode: "enqueue" },
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
    rows: {
      window: rows,
      totalCount: rows.length,
      firstRowId: rows.length > 0 ? rows[0].rowId : null,
    },
  } as unknown as ConversationSnapshot;
}

// 确定性 PRNG（mulberry32）：随机序列可复现，失败可定位到种子与迭代号。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RowModel {
  rowId: number;
  state: "streaming" | "complete";
}

interface SequenceModel {
  // rowId 单调唯一是协议不变量（rowBaseFields 注释），生成器必须遵守：
  // 非法重复 rowId 会让不可变版 findIndex（首个）与 mutable 版 rowIndexById（末位）分歧。
  nextRowId: number;
  nextSeq: number;
  rows: RowModel[];
  revision: number;
  workflowRevision: number;
}

function generateDelta(rand: () => number, model: SequenceModel): ConversationDelta {
  const roll = rand();
  if (roll < 0.3 || model.rows.length === 0) {
    const rowId = model.nextRowId++;
    const state = rand() < 0.7 ? "streaming" : "complete";
    model.rows.push({ rowId, state });
    return { op: "row.appended", row: makeRow(rowId, model.nextSeq++, state) };
  }
  if (roll < 0.45) {
    if (rand() < 0.2) {
      // 未加载 rowId 的 upsert：两版实现都必须 no-op（协议：被逐出的行只能经 rows/range 取回）。
      return {
        op: "row.upserted",
        row: makeRow(model.nextRowId + 10_000, model.nextSeq++, "complete"),
      };
    }
    const target = model.rows[Math.floor(rand() * model.rows.length)];
    target.state = "complete";
    return { op: "row.upserted", row: makeRow(target.rowId, model.nextSeq++, "complete") };
  }
  if (roll < 0.7) {
    const streaming = model.rows.filter((row) => row.state === "streaming");
    if (streaming.length > 0) {
      // row.delta 仅允许作用于流式态行（服务端保证）；text path 只对 assistantText 生效。
      const target = streaming[Math.floor(rand() * streaming.length)];
      return { op: "row.delta", rowId: target.rowId, path: "text", append: `-x${model.nextSeq++}` };
    }
    return { op: "state.updated", patch: { revision: ++model.revision } };
  }
  if (roll < 0.78) {
    const target = model.rows[Math.floor(rand() * model.rows.length)];
    model.rows = model.rows.filter((row) => row.rowId < target.rowId);
    return { op: "row.removed", fromRowId: target.rowId };
  }
  if (roll < 0.93) {
    return { op: "state.updated", patch: { revision: ++model.revision } };
  }
  if (roll < 0.98) {
    return {
      op: "workflowRun.updated",
      runId: "run-1",
      revision: ++model.workflowRevision,
      run: {},
    };
  }
  return { op: "workflowRun.removed", runId: "run-1", revision: ++model.workflowRevision };
}

const ROW_OPS = new Set(["row.appended", "row.upserted", "row.removed", "row.delta"]);

function runGoldenIteration(baseRows: ConversationRow[], deltas: ConversationDelta[]): void {
  const base = makeSnapshot(baseRows, 42);
  const before = structuredClone(base);

  const viaBatch = applyConversationDeltasBatch(base, deltas);
  const viaFold = applyConversationDeltas(base, deltas);

  assert.equal(
    JSON.stringify(viaBatch),
    JSON.stringify(viaFold),
    `batch 与逐条折叠分歧，deltas=${JSON.stringify(deltas)}`,
  );
  assert.equal(
    JSON.stringify(base),
    JSON.stringify(before),
    "已发布快照被改写（batch 破坏不可变语义）",
  );

  const touchesRows = deltas.some((delta) => ROW_OPS.has(delta.op));
  if (deltas.length > 0) {
    if (touchesRows) {
      assert.notEqual(viaBatch.rows, base.rows, "row 帧后 rows 必须换新引用");
      assert.notEqual(viaBatch.rows.window, base.rows.window, "row 帧后 window 必须换新引用");
    } else {
      // 引用恒等保底：纯状态帧（state.updated / workflow twin）不得让下游 memo 失效。
      assert.equal(viaBatch.rows, base.rows, "无 row 操作帧必须复用原 rows 引用");
      assert.equal(viaBatch.rows.window, base.rows.window, "无 row 操作帧必须复用原 window 引用");
    }
  }

  // 协议黄金不变量在 batch 入口同样成立：batch(s, coalesce(ds)) ≡ fold(s, ds)。
  const coalesced = coalesceConversationDeltas(deltas);
  assert.equal(
    JSON.stringify(applyConversationDeltasBatch(base, coalesced)),
    JSON.stringify(viaFold),
    "coalesce 语义保持在 batch 入口被破坏",
  );
}

test("随机序列黄金等价（确定性种子，多规模覆盖）", () => {
  const rand = mulberry32(20260924);
  for (let iteration = 0; iteration < 400; iteration++) {
    const initialRowCount = Math.floor(rand() * 40);
    const model: SequenceModel = {
      nextRowId: 1,
      nextSeq: 1,
      rows: [],
      revision: 0,
      workflowRevision: 0,
    };
    // 基础行先于 delta 生成构造，model 状态与夹具行保持一致（row.delta 只瞄 streaming 行）。
    const baseRows: ConversationRow[] = [];
    for (let i = 0; i < initialRowCount; i++) {
      const rowId = model.nextRowId++;
      const state = rand() < 0.5 ? "streaming" : "complete";
      model.rows.push({ rowId, state });
      baseRows.push(makeRow(rowId, rowId, state));
    }
    const deltaCount = 1 + Math.floor(rand() * 12);
    const deltas: ConversationDelta[] = [];
    for (let i = 0; i < deltaCount; i++) {
      deltas.push(generateDelta(rand, model));
    }
    runGoldenIteration(baseRows, deltas);
  }
});

test("空帧返回原快照引用", () => {
  const snapshot = makeSnapshot([makeRow(1, 1, "streaming")], 7);
  assert.equal(applyConversationDeltasBatch(snapshot, []), snapshot);
});

test("纯状态帧：结果换新顶层对象但复用 rows 引用", () => {
  const snapshot = makeSnapshot([makeRow(1, 1, "streaming")], 7);
  const out = applyConversationDeltasBatch(snapshot, [
    { op: "state.updated", patch: { revision: 9 } },
    { op: "workflowRun.updated", runId: "run-1", revision: 2, run: {} },
  ]);
  assert.equal(out.rows, snapshot.rows);
  assert.equal(out.rows.window, snapshot.rows.window);
  assert.notEqual(out, snapshot);
  assert.equal(out.revision, 9);
});

test("row.removed 裁剪整个 active 分支：totalCount 清零、firstRowId 置空", () => {
  const snapshot = makeSnapshot([makeRow(1, 1, "complete"), makeRow(2, 2, "streaming")], 7);
  const out = applyConversationDeltasBatch(snapshot, [{ op: "row.removed", fromRowId: 1 }]);
  assert.equal(out.rows.window.length, 0);
  assert.equal(out.rows.totalCount, 0);
  assert.equal(out.rows.firstRowId, null);
});

test("row.upserted 未加载 rowId 为 no-op（与逐条折叠一致）", () => {
  const snapshot = makeSnapshot([makeRow(1, 1, "streaming")], 7);
  const out = applyConversationDeltasBatch(snapshot, [
    { op: "row.upserted", row: makeRow(999, 9, "complete") },
  ]);
  assert.equal(out.rows.window.length, 1);
  assert.equal(out.rows.window[0]?.rowId, 1);
});

test("流式追加帧：append 与 row.delta 混合的终态与逐条折叠一致", () => {
  const snapshot = makeSnapshot([makeRow(1, 1, "streaming")], 7);
  const deltas: ConversationDelta[] = [
    { op: "row.appended", row: makeRow(2, 2, "streaming") },
    { op: "row.delta", rowId: 1, path: "text", append: "-a" },
    { op: "row.delta", rowId: 2, path: "text", append: "-b" },
    { op: "row.upserted", row: makeRow(2, 3, "complete") },
    { op: "row.delta", rowId: 1, path: "text", append: "-c" },
  ];
  const viaBatch = applyConversationDeltasBatch(snapshot, deltas);
  const viaFold = applyConversationDeltas(snapshot, deltas);
  assert.equal(JSON.stringify(viaBatch), JSON.stringify(viaFold));
  const row1 = viaBatch.rows.window.find((row) => row.rowId === 1);
  assert.equal(row1 && row1.kind === "assistantText" ? row1.text : undefined, "text-1-a-c");
});

test("性能基准（记录型）：20k 行 × 8 delta/帧，batch 显著快于逐条折叠", () => {
  const rows: ConversationRow[] = Array.from({ length: 20_000 }, (_, i) =>
    makeRow(i + 1, i + 1, "streaming"),
  );
  const snapshot = makeSnapshot(rows, 1);
  const deltas: ConversationDelta[] = [
    { op: "row.appended", row: makeRow(20_001, 20_001, "streaming") },
    ...Array.from({ length: 7 }, (_, i) => ({
      op: "row.delta" as const,
      rowId: 20_000 - i,
      path: "text" as const,
      append: "-x",
    })),
  ];
  const measure = (fn: () => unknown): number => {
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      fn();
    }
    return (performance.now() - start) / 20;
  };
  // 先预热再计时，降低 JIT 干扰；断言用同机同轮的相对比较，绝对数值仅记录。
  applyConversationDeltas(snapshot, deltas);
  applyConversationDeltasBatch(snapshot, deltas);
  const foldMs = measure(() => applyConversationDeltas(snapshot, deltas));
  const batchMs = measure(() => applyConversationDeltasBatch(snapshot, deltas));
  console.log(
    `[perf] 20k rows x 8 deltas/frame: fold=${foldMs.toFixed(2)}ms batch=${batchMs.toFixed(2)}ms`,
  );
  assert.ok(batchMs < foldMs, `batch(${batchMs.toFixed(2)}ms) 应快于 fold(${foldMs.toFixed(2)}ms)`);
});
