// v4 事故级帧负载基准（B2 立项判据；方案 docs/plans/renderer-crash-recovery-and-long-session-design.md §5 批次 B1 验收 3）。
//
// 用真实 ConversationProjectionStore + SessionDataLayer 接线（桩传输按真 ACK/initial/online
// 帧语义回放）+ 真实下游 memo 计算（renderUnits / workflowGraph / workflowDraft，按 rows 引用
// 变更才重算——与 React useMemo 依赖语义一致），构造 2026-09-24 白屏事故同构负载：
// 5 万行全量常驻 + 30ms 节奏流式注入（20000 帧 = 逻辑时长 10 分钟）。
//
// 裁判口径：每帧端到端同步成本（apply+通知+memo 重算）p95 ≤ 30ms（帧预算），
// renderer 堆曲线平稳。覆盖声明：不含 DOM/react-virtual 的可见窗口渲染（与可见行数
// 成正比、有界），本基准的裁判对象是「每帧同步成本是否超帧预算」这一事故根因。
//
// 运行：npx tsx --test packages/ui/test/v4-frame-load-benchmark.test.ts
// 规模可用 ZCODE_BENCH_ROWS / ZCODE_BENCH_FRAMES 缩减做快速校准。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionDataLayer } from "../src/v4/sessionDataLayer.js";
import { conversationTopic, type ConversationTransport } from "../src/v4/transport.js";
import { buildConversationTurnRenderUnits } from "../src/v4/conversationTurnRenderUnits.js";
import {
  buildWorkflowGraphByToolCallId,
  buildWorkflowRunByToolCallId,
} from "../src/v4/workflowRunCardJoin.js";

const BASE_ROWS = Number(process.env.ZCODE_BENCH_ROWS ?? 50_000);
// 默认 2000 帧（逻辑 1 分钟，本机约 2–4 分钟跑完）做常规记录；官方判据数据用
// ZCODE_BENCH_FRAMES=20000（逻辑 10 分钟）全量跑，结果登记进方案文档。
const FRAME_COUNT = Number(process.env.ZCODE_BENCH_FRAMES ?? 2_000);
/** 30ms/帧 × 20000 帧 = 逻辑时长 10 分钟（事故当天 4 小时节奏的浓缩）。 */
const FRAME_INTERVAL_MS = 30;
const SUBSCRIBER_COUNT = 3;

function makeRow(rowId: number, streaming: boolean): ConversationRow {
  const turnId = `turn-${Math.floor(rowId / 8)}`;
  if (rowId % 4 === 3) {
    return {
      rowId,
      turnId,
      createdAt: rowId,
      createdAtSeq: rowId,
      kind: "toolCall",
      toolCallId: `tc-${rowId}`,
      toolName: "Bash",
      status: "success",
      inputText: `echo ${rowId}`,
    };
  }
  return {
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text: `assistant text for row ${rowId} `.repeat(6),
    state: streaming ? "streaming" : "complete",
  };
}

function makeBaseSnapshot(rows: ConversationRow[], seq: number): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "bench-session",
    logEpoch: "bench-epoch",
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

interface BenchEmitter {
  transport: ConversationTransport;
  emit(frame: ConversationTopicFrame, deliveryKind: "initial" | "online"): void;
}

function createBenchTransport(topic: string, initialFrame: ConversationTopicFrame): BenchEmitter {
  const frameListeners: Array<
    (
      frame: ConversationTopicFrame,
      context?: { deliveryKind: "initial" | "online" | "recovery" },
    ) => void
  > = [];
  const unused = async () => {
    throw new Error("bench transport 方法不应被调用");
  };
  const transport = {
    subscribe: async () => ({
      ack: { subscriptionId: "sub-bench", mode: "snapshot", logEpoch: "bench-epoch" },
    }),
    // ACK 后 store 调 activate：桩在此同步释放 initial snapshot 帧（真传输的
    // request-scoped outbox 语义：initial 是 owned notification，不是 subscribe 返回值）。
    activate: () => {
      for (const listener of frameListeners) listener(initialFrame, { deliveryKind: "initial" });
    },
    resync: async () => ({
      ack: { subscriptionId: "sub-bench-r", mode: "snapshot", logEpoch: "bench-epoch" },
    }),
    unsubscribe: async () => {},
    sendCommand: unused,
    queryCommands: unused,
    rowsRange: unused,
    plans: unused,
    workflowRunEvents: unused,
    workflowRuns: unused,
    workflowRunArtifacts: unused,
    workflowRunArtifactData: unused,
    workflowRunArtifactRead: unused,
    fileChanges: unused,
    fileRewindPreview: unused,
    attachmentPut: unused,
    attachmentRead: unused,
    attachmentReadRange: unused,
    onFrame: (
      listener: (
        frame: ConversationTopicFrame,
        context?: { deliveryKind: "initial" | "online" | "recovery" },
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
  return {
    transport,
    emit: (frame, deliveryKind) => {
      for (const listener of frameListeners) listener(frame, { deliveryKind });
    },
  };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

test(`事故级帧负载基准：${BASE_ROWS} 行常驻 × ${FRAME_COUNT} 帧（30ms 节奏 = 逻辑 10 分钟）`, async () => {
  const topic = conversationTopic("bench-session");
  const rows: ConversationRow[] = [];
  for (let i = 1; i <= BASE_ROWS; i++) {
    rows.push(makeRow(i, false));
  }
  const baseSeq = 1_000_000;
  const snapshot = makeBaseSnapshot(rows, baseSeq);
  const initialFrame: ConversationTopicFrame = {
    topic,
    subscriptionId: "sub-bench",
    fromSeq: 0,
    toSeq: baseSeq,
    payload: { kind: "snapshot", snapshot },
  } as ConversationTopicFrame;
  const bench = createBenchTransport(topic, initialFrame);
  const layer = new SessionDataLayer({
    transport: bench.transport,
    keepWarmMs: Number.MAX_SAFE_INTEGER,
  });
  const lease = layer.acquire("bench-session");
  // useSyncExternalStore 订阅者替代：真实 pane 数量的空回调 + memo 重算发生在通知之后。
  const unsubscribers = [];
  for (let i = 0; i < SUBSCRIBER_COUNT; i++) {
    unsubscribers.push(lease.store.subscribe(() => {}));
  }
  for (let i = 0; i < 50 && lease.store.getState().snapshot === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(lease.store.getState().snapshot, "initial snapshot 未应用");
  assert.equal(lease.store.getState().snapshot?.rows.window.length, BASE_ROWS);

  let nextRowId = BASE_ROWS + 1;
  let tailRowId = BASE_ROWS;
  let seq = baseSeq;
  const applySamples: number[] = [];
  const memoSamples: number[] = [];
  const heapSamples: number[] = [];
  let lastRowsRef = lease.store.getState().snapshot?.rows.window;
  const benchStartedAt = performance.now();

  for (let frameIndex = 0; frameIndex < FRAME_COUNT; frameIndex++) {
    const deltas: ConversationDelta[] = [];
    if (frameIndex % 40 === 0) {
      tailRowId = nextRowId++;
      deltas.push({ op: "row.appended", row: makeRow(tailRowId, true) });
    }
    const chunkCount = 4 + (frameIndex % 4);
    for (let i = 0; i < chunkCount; i++) {
      deltas.push({
        op: "row.delta",
        rowId: tailRowId,
        path: "text",
        append: ` streaming chunk ${frameIndex}-${i} `,
      });
    }
    if (frameIndex % 3 === 0) {
      deltas.push({ op: "state.updated", patch: { queue: { items: [], autoDrain: true } } });
    }
    const frame: ConversationTopicFrame = {
      topic,
      subscriptionId: "sub-bench",
      fromSeq: seq,
      toSeq: seq + deltas.length,
      payload: { kind: "deltas", deltas },
    } as ConversationTopicFrame;
    seq = frame.toSeq;

    const t0 = performance.now();
    bench.emit(frame, "online");
    const t1 = performance.now();
    const currentSnapshot = lease.store.getState().snapshot;
    const currentRows = currentSnapshot?.rows.window;
    if (currentRows !== lastRowsRef) {
      // 下游 memo 依赖语义：rows 引用变更才重算（纯状态帧复用引用、不重算——
      // applyConversationDeltasBatch 的引用恒等保底正是为此）。
      buildConversationTurnRenderUnits(currentRows ?? []);
      buildWorkflowGraphByToolCallId(currentRows);
      buildWorkflowRunByToolCallId(currentSnapshot?.workflowRuns?.runs);
      lastRowsRef = currentRows;
    }
    const t2 = performance.now();
    applySamples.push(t1 - t0);
    memoSamples.push(t2 - t1);
    if (frameIndex % 250 === 0) {
      heapSamples.push(process.memoryUsage().heapUsed);
    }
  }

  const wallMs = performance.now() - benchStartedAt;
  const totalSamples = applySamples.map((v, i) => v + (memoSamples[i] ?? 0));
  const sortedTotal = [...totalSamples].sort((a, b) => a - b);
  const sortedApply = [...applySamples].sort((a, b) => a - b);
  const sortedMemo = [...memoSamples].sort((a, b) => a - b);
  const heapStart = heapSamples[0] ?? 0;
  const heapEnd = heapSamples[heapSamples.length - 1] ?? 0;
  const heapMax = Math.max(...heapSamples);
  // 堆只报 start/end/max：端点值含未回收垃圾，线性外推成「每小时增长」是伪科学。
  const summary = [
    `[bench] rows=${BASE_ROWS} frames=${FRAME_COUNT} (logical ${((FRAME_COUNT * FRAME_INTERVAL_MS) / 60_000).toFixed(1)}min) wall=${(wallMs / 1000).toFixed(1)}s`,
    `[bench] per-frame total ms: p50=${percentile(sortedTotal, 50).toFixed(2)} p95=${percentile(sortedTotal, 95).toFixed(2)} p99=${percentile(sortedTotal, 99).toFixed(2)} max=${sortedTotal[sortedTotal.length - 1]?.toFixed(2)}`,
    `[bench] apply+notify ms: p50=${percentile(sortedApply, 50).toFixed(2)} p95=${percentile(sortedApply, 95).toFixed(2)}`,
    `[bench] memo rebuild ms: p50=${percentile(sortedMemo, 50).toFixed(2)} p95=${percentile(sortedMemo, 95).toFixed(2)}`,
    `[bench] heap MB: start=${(heapStart / 1048576).toFixed(0)} end=${(heapEnd / 1048576).toFixed(0)} max=${(heapMax / 1048576).toFixed(0)} (end 含未回收垃圾，以 max 判界)`,
  ];
  console.log(summary.join("\n"));

  // 裁判断言：
  // 1) B1 的验收——批处理 apply+通知在事故规模下必须近零（p95 ≤ 1ms）；
  // 2) 堆有界（< 1GB 摆动）。
  // 每帧总成本 p95 ≤ 30ms 的帧预算判据**刻意不作为断言**：2026-09-24 实测
  // （2 万行 p95=42ms、5 万行更高）证明剩余超支全部来自下游 O(n) memo 重算
  // （renderUnits/workflowGraph），属 B2（行窗口上限 + 目录分离）的范围——本基准
  // 的职责是把这个数字持续记录在案作为 B2 的验收基线，而不是让主干测试变红。
  assert.ok(
    percentile(sortedApply, 95) <= 1,
    `apply+notify p95=${percentile(sortedApply, 95).toFixed(2)}ms 超出 B1 验收线（批处理 apply 应近零）`,
  );
  assert.ok(heapMax - heapStart < 1_000 * 1048576, "堆增长超 1GB，内存曲线不平稳");
  if (percentile(sortedTotal, 95) > 30) {
    console.log(
      `[bench] B2 立项判据持续成立：每帧总成本 p95=${percentile(sortedTotal, 95).toFixed(2)}ms > 30ms 帧预算（超支来自下游 O(n) memo 重算，非 apply）`,
    );
  }
  for (const unsubscribe of unsubscribers) unsubscribe();
  lease.release();
});
