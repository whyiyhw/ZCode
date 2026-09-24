# Spec：会话 delta 帧批量应用（applyConversationDeltasBatch）

> 2026-09-24 白屏事故（渲染端逐条不可变 apply 在长会话下退化为 O(N²)，更新队列风暴拖死渲染进程）修复产物。
> 方案：`docs/plans/renderer-crash-recovery-and-long-session-design.md` 批次 B1。

## 行为定义

`applyConversationDeltasBatch(snapshot, deltas)` 是渲染端（`conversationProjectionStore.applyFrame`）的帧应用入口：把一帧 delta 批量应用到已发布快照并返回新快照。

语义契约（黄金测试背书：`packages/shared/test/zcode-protocol-v4-apply-batch.test.ts`）：

1. **逐字节等价**：对任意合法 delta 序列，`batch(s, ds)` 与逐条不可变折叠 `applyConversationDeltas(s, ds)` 的结果 JSON 逐字节一致；协议不变量 `applyAll(s, coalesce(ds)) ≡ applyAll(s, ds)` 在 batch 入口同样成立。
2. **发布不可变**：入参快照（含其 rows.window 与所有嵌套对象）永不被改写；每次调用产生新对象，accumulator「不得暴露给订阅者后继续写」的约束因每次新建而天然满足。
3. **引用恒等保底**：帧内不含任何 row 操作（`row.appended/upserted/removed/delta`，只有 `state.updated` / `workflowRun.*`）时，结果**复用原 `snapshot.rows` 引用**（含 `rows.window` 数组引用）。理由：下游 memo（SessionPane 的 workflowGraph 等、ConversationTimeline 的 renderUnits）以 `rows.window` 引用为缓存 key，workflow 节点进度 tick、turn 相位迁移这类纯状态帧不得触发 O(n) 重算。含 row 操作的帧则必须换新 `rows` 与 `rows.window` 引用。
4. **空帧**：`deltas` 为空时返回原快照引用（不新建对象）。

## 实现边界

- 帧内一次拷贝 `rows.window` 后原地应用 row 操作，row 定位走**有序二分**（`rows.window` 按 rowId 升序是行日志窗口的结构不变量：append 尾追、removed 截尾、upsert/delta 原位、loadOlder 前插更早行），二分失配时线性 findIndex 兜底——上游若破坏有序性，语义只退化慢、不退化错。帧内非 row 操作（state.updated / workflow twin）转调既有不可变纯函数 `applyConversationDelta`。命中路径帧成本 O(n + k·log n)；二分未命中的 no-op 帧（被逐出行的 upsert 等）每条退化为 O(n) 线性兜底，属防御形状，实测与逐条折叠同量级。
- **刻意不复用**服务端的 mutable accumulator（`rowIndexById` 的 n 次 Map.set 在流式帧的小 k 规模下常数高于逐条数组拷贝——性能基准实测证伪过第一版）；该路径仍仅供服务端候选快照大批量归约。
- 语义一致性的裁判是黄金测试（契约 1），不是「与某实现共用代码」。
- 无 row-op 帧走逐条不可变折叠（引用恒等，见契约 3）。
- 服务端（CLI product-projection）的候选快照推进不经过本函数，维持各自的 mutable accumulator 用法。

## 合法输入前提（协议侧）

- rowId 会话内单调唯一。非法的重复 rowId 下，不可变版 `findIndex`（首个命中）与 mutable 版 `rowIndexById`（末位命中）行为分歧——黄金测试生成器必须遵守该不变量，本函数不对非法输入提供一致性保证。

## 验收场景

1. 随机序列（确定性种子、rowId 单调、含裁剪/no-op/twin/coalesce 组合）黄金等价全绿；coalesce 断言直接喂 batch 入口（`batch(s, coalesce(ds)) ≡ fold(s, ds)`）。
2. 纯状态帧引用恒等断言、row 帧换引用断言、发布不可变断言全绿。
3. 性能基准（记录型）：20k 行 × 8 delta/帧，同机同轮相对比较 batch < fold，绝对耗时随测试输出留档（`packages/shared/test/zcode-protocol-v4-apply-batch.test.ts`）。
4. 渲染端 store（`conversationProjectionStore.ts`）delta 帧路径已切换为 batch 调用；断档检测读的 `current.seq` 语义不变。
