// Delta 应用语义的规范实现（纯函数）。
// 这是协议语义的一部分：coalesce 的「语义保持」就以本函数为裁判——
// applyAll(s, coalesce(ds)) 必须与 applyAll(s, ds) 逐字节一致（黄金测试）。
// 渲染端 store 的帧应用入口是 applyConversationDeltasBatch（见文件尾）：帧内一次
// 拷贝 + 有序二分定位原地应用，语义以本文件的不可变实现为裁判。
import type { ConversationDelta } from "./delta.js";
import type { ConversationSnapshot } from "./snapshot.js";
import type { ConversationRow } from "./rows.js";
import type { StreamablePath } from "./core.js";
import { applyWorkflowRunRemoved, applyWorkflowRunUpdated } from "./workflow-runs-delta.js";

/**
 * 仅供服务端在未发布的候选快照内批量归约使用。
 *
 * 冷恢复/流式逐条调用不可变 apply 时，每次 append/upsert 都复制随历史增长的
 * rows.window，并再次线性查找 rowId，长会话因此退化为 O(N²)。候选快照尚未对外可见，
 * 可以在这条明确的隔离边界内复用同一份数组和增量索引。渲染端帧应用
 * （applyConversationDeltasBatch）刻意不复用本路径：rowIndexById 的 n 次 Map.set
 * 在流式帧的小 k（约 8）规模下常数高于逐条数组拷贝（性能基准实测过），自带
 * 有序二分定位更划算。普通逐条消费者仍使用上面的不可变语义。
 */
export interface MutableConversationSnapshotAccumulator {
  snapshot: ConversationSnapshot;
  rowIndexById: Map<number, number>;
}

export function createMutableConversationSnapshotAccumulator(
  snapshot: ConversationSnapshot,
): MutableConversationSnapshotAccumulator {
  const window = [...snapshot.rows.window];
  return {
    snapshot: {
      ...snapshot,
      rows: { ...snapshot.rows, window },
    },
    rowIndexById: new Map(window.map((row, index) => [row.rowId, index])),
  };
}

// row.delta 只允许作用于流式态行（不变量，服务端保证）。
// 本函数按协议语义实现为：路径不存在/行不存在时 no-op（patch 命中未加载行 = no-op）。
function appendToRow(row: ConversationRow, path: StreamablePath, append: string): ConversationRow {
  switch (path) {
    case "text":
      if (row.kind === "assistantText" || row.kind === "reasoning") {
        return { ...row, text: row.text + append };
      }
      return row;
    case "inputText":
      if (row.kind === "toolCall") {
        return { ...row, inputText: row.inputText + append };
      }
      return row;
    case "output.text":
      if (row.kind === "toolCall" && row.output) {
        return {
          ...row,
          output: { ...row.output, text: row.output.text + append },
        };
      }
      return row;
    case "summaryText":
      if (row.kind === "subagent") {
        return { ...row, summaryText: row.summaryText + append };
      }
      return row;
  }
}

/** 应用单条 delta，返回新快照（入参不被修改）。 */
export function applyConversationDelta(
  snapshot: ConversationSnapshot,
  delta: ConversationDelta,
): ConversationSnapshot {
  switch (delta.op) {
    case "row.appended":
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window: [...snapshot.rows.window, delta.row],
          totalCount: snapshot.rows.totalCount + 1,
          firstRowId: snapshot.rows.firstRowId ?? delta.row.rowId,
        },
      };
    case "row.upserted": {
      const index = snapshot.rows.window.findIndex((row) => row.rowId === delta.row.rowId);
      // 未加载 rowId = no-op（被逐出的行只能经 rows/range 取回）。
      if (index === -1) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = delta.row;
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    case "row.removed": {
      const window = snapshot.rows.window.filter((row) => row.rowId < delta.fromRowId);
      const removed = snapshot.rows.window.length - window.length;
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window,
          // rewind 首轮后 rowId 继续单调递增；若保留旧 firstRowId，UI 会把
          // 旧分支留下的 rowId 空洞误判成“加载更早”。全量和尾窗都必须在从首行
          // 开始裁剪时清空 active-branch 分页锚点与计数，下一次 append 再建立新首行。
          totalCount: removesEntireActiveBranch
            ? 0
            : Math.max(0, snapshot.rows.totalCount - removed),
          firstRowId: removesEntireActiveBranch ? null : snapshot.rows.firstRowId,
        },
      };
    }
    case "row.delta": {
      const index = snapshot.rows.window.findIndex((row) => row.rowId === delta.rowId);
      const target = snapshot.rows.window[index];
      if (index === -1 || target === undefined) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = appendToRow(target, delta.path, delta.append);
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    case "state.updated":
      // 键级整体替换：patch 中在场的键覆盖，绝不深合并。
      return { ...snapshot, ...delta.patch };
    // workflowRuns 是唯一开了增量口子的状态键（delta.ts 的注释讲了为什么）。规则整份住在
    // workflow-runs-delta.ts：两个 twin 都只转调它，两边的语义因此没有走散的余地。
    case "workflowRun.updated":
      return {
        ...snapshot,
        workflowRuns: applyWorkflowRunUpdated(snapshot.workflowRuns, delta),
      };
    case "workflowRun.removed":
      return {
        ...snapshot,
        workflowRuns: applyWorkflowRunRemoved(snapshot.workflowRuns, delta),
      };
  }
}

/** 按序应用一串 delta。 */
export function applyConversationDeltas(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): ConversationSnapshot {
  let current = snapshot;
  for (const delta of deltas) {
    current = applyConversationDelta(current, delta);
  }
  return current;
}

/**
 * 在未发布候选快照上原地应用单条 delta；语义必须与 applyConversationDelta 一致。
 * 调用者不得把 accumulator.snapshot 暴露给订阅者后继续调用本函数。
 */
export function applyConversationDeltaMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  delta: ConversationDelta,
): void {
  const snapshot = accumulator.snapshot;
  switch (delta.op) {
    case "row.appended":
      accumulator.rowIndexById.set(delta.row.rowId, snapshot.rows.window.length);
      snapshot.rows.window.push(delta.row);
      snapshot.rows.totalCount += 1;
      snapshot.rows.firstRowId ??= delta.row.rowId;
      return;
    case "row.upserted": {
      const index = accumulator.rowIndexById.get(delta.row.rowId);
      if (index === undefined) return;
      snapshot.rows.window[index] = delta.row;
      return;
    }
    case "row.removed": {
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      let writeIndex = 0;
      for (const row of snapshot.rows.window) {
        if (row.rowId >= delta.fromRowId) continue;
        snapshot.rows.window[writeIndex] = row;
        writeIndex += 1;
      }
      const removed = snapshot.rows.window.length - writeIndex;
      snapshot.rows.window.length = writeIndex;
      snapshot.rows.totalCount = removesEntireActiveBranch
        ? 0
        : Math.max(0, snapshot.rows.totalCount - removed);
      snapshot.rows.firstRowId = removesEntireActiveBranch ? null : snapshot.rows.firstRowId;
      accumulator.rowIndexById.clear();
      snapshot.rows.window.forEach((row, index) => accumulator.rowIndexById.set(row.rowId, index));
      return;
    }
    case "row.delta": {
      const index = accumulator.rowIndexById.get(delta.rowId);
      if (index === undefined) return;
      const target = snapshot.rows.window[index];
      if (target === undefined) return;
      snapshot.rows.window[index] = appendToRow(target, delta.path, delta.append);
      return;
    }
    case "state.updated":
      // 与不可变实现相同：patch 在场键整体替换，不能深合并。
      Object.assign(snapshot, delta.patch);
      return;
    // 与不可变实现调同一个纯函数：workflowRuns 是状态键不是 rows 窗口，没有「原地追加」可优化，
    // 而 accumulator.snapshot 本来就是候选快照自己的对象，赋一个新容器不会碰到已发布的快照。
    case "workflowRun.updated":
      snapshot.workflowRuns = applyWorkflowRunUpdated(snapshot.workflowRuns, delta);
      return;
    case "workflowRun.removed":
      snapshot.workflowRuns = applyWorkflowRunRemoved(snapshot.workflowRuns, delta);
  }
}

/** 按序原地应用一串 delta，仅适用于未发布的候选快照。 */
export function applyConversationDeltasMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) applyConversationDeltaMutable(accumulator, delta);
}

const ROW_DELTA_OPS: ReadonlySet<string> = new Set([
  "row.appended",
  "row.upserted",
  "row.removed",
  "row.delta",
]);

/**
 * 行定位（仅供 batch 帧内使用）：rows.window 按 rowId 升序是行日志窗口的结构
 * 不变量（append 尾追、removed 截尾、upsert/delta 原位、loadOlder 前插更早行），
 * 二分为主路径；万一上游破坏有序性，线性兜底保证语义只退化慢、不退化错。
 */
function locateRowIndex(window: readonly ConversationRow[], rowId: number): number {
  let low = 0;
  let high = window.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const midRowId = window[mid]?.rowId;
    if (midRowId === undefined) {
      break;
    }
    if (midRowId === rowId) {
      return mid;
    }
    if (midRowId < rowId) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return window.findIndex((row) => row.rowId === rowId);
}

/**
 * 把一帧 delta 批量应用到已发布快照，语义与 {@link applyConversationDeltas} 逐字节一致
 * （黄金测试背书：packages/shared/test/zcode-protocol-v4-apply-batch.test.ts；
 * 行为口径：packages/shared/spec/conversation-delta-batch-apply.md）。
 *
 * 为什么存在：渲染端逐条不可变 apply 让每条 delta 都复制随历史增长的 rows.window 并
 * 线性查找 rowId（O(k·n)/帧），数万行的长会话在 30ms 流式帧下退化成 O(N²)，更新
 * 队列风暴拖死渲染进程（2026-09-24 白屏事故，栈停在 react-virtual 的 useReducer
 * 更新队列）。本函数帧内只拷贝一次 window，row 定位走有序二分（O(n + k·log n)），
 * 帧结束时返回组装完毕的新对象，已发布快照不被篡改。刻意**不**走服务端的
 * mutable accumulator：其 rowIndexById 需要 n 次 Map.set，在流式帧的 k≈8 规模下
 * 常数反而高于逐条数组拷贝（性能基准实测过），只适合服务端大批量归约。
 *
 * 引用恒等保底：帧内不含任何 row 操作（只有 state.updated / workflowRun twin）时
 * 复用原 snapshot.rows——下游 memo（SessionPane/ConversationTimeline）以
 * rows.window 引用为缓存 key，workflow 节点进度 tick、turn 相位迁移这类纯状态帧
 * 不得触发 O(n) 重算。纯状态帧走逐条不可变折叠：不触碰 rows，每条只是顶层浅合并。
 */
export function applyConversationDeltasBatch(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): ConversationSnapshot {
  if (deltas.length === 0) {
    return snapshot;
  }
  const touchesRows = deltas.some((delta) => ROW_DELTA_OPS.has(delta.op));
  if (!touchesRows) {
    return applyConversationDeltas(snapshot, deltas);
  }
  // 帧内工作集：一次性拷贝 window，row 操作原地应用，非 row 操作（state.updated /
  // workflow twin）转调既有不可变纯函数——顶层结果对象随转调换新，rows 引用不变。
  const window = [...snapshot.rows.window];
  const rows = { ...snapshot.rows, window };
  let next: ConversationSnapshot = { ...snapshot, rows };
  for (const delta of deltas) {
    switch (delta.op) {
      case "row.appended":
        window.push(delta.row);
        rows.totalCount += 1;
        rows.firstRowId ??= delta.row.rowId;
        continue;
      case "row.upserted": {
        const index = locateRowIndex(window, delta.row.rowId);
        // 未加载 rowId = no-op（协议：被逐出的行只能经 rows/range 取回）。
        if (index !== -1) {
          window[index] = delta.row;
        }
        continue;
      }
      case "row.removed": {
        const removesEntireActiveBranch =
          rows.firstRowId !== null && delta.fromRowId <= rows.firstRowId;
        let writeIndex = 0;
        for (const row of window) {
          if (row.rowId >= delta.fromRowId) {
            continue;
          }
          window[writeIndex] = row;
          writeIndex += 1;
        }
        const removed = window.length - writeIndex;
        window.length = writeIndex;
        rows.totalCount = removesEntireActiveBranch ? 0 : Math.max(0, rows.totalCount - removed);
        rows.firstRowId = removesEntireActiveBranch ? null : rows.firstRowId;
        continue;
      }
      case "row.delta": {
        const index = locateRowIndex(window, delta.rowId);
        const target = index === -1 ? undefined : window[index];
        if (target !== undefined) {
          window[index] = appendToRow(target, delta.path, delta.append);
        }
        continue;
      }
      default:
        next = applyConversationDelta(next, delta);
        continue;
    }
  }
  return next;
}
