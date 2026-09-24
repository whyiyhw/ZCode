# 方案：会话行窗口按需化 + 回合导航目录服务端化（B2 第一刀）

> 2026-09-24。上游方案：`renderer-crash-recovery-and-long-session-design.md` v6（B2 立项判据已触发：5 万行常驻下每帧总成本 p95=102ms，超支全部来自 O(n) memo 重算）。
> 范围：**B2 三件套中的「拧 n」一刀**——行窗口有界 + 目录分离 + 跳转按需拉取；memo 增量化（O(delta) 派生）明确不在本期（见 §4）。分两个独立批准阶段实施。

## 1. 要解决的问题

事故级会话（5 万行）打开即全量常驻的机制：宽屏（≥864px）打开会话 → `shouldHydrateConversationTurnNavigatorDirectory` 命中 → `loadAllOlder()` 按页（200 行/页）把**全部分支历史**前插进 `rows.window` 并常驻（`conversationProjectionStore.ts:1019-1173`）。动机只有一个：回合导航 rail 需要全分支的 real-user query 列表（「至少 2 条」的判定还要数完全史，`:1109-1112`）。

后果（基准实测）：n=50k 常驻 → 每帧 O(n) memo 重算 p95=102ms（预算 30ms）+ 堆 max 309MB 无界增长。

目标：打开会话 n 有界（尾窗 + 按需 + 淘汰上限 K），回合导航**完整覆盖全分支**（不降级），流式每帧 p95 ≤ 30ms（B2 验收基线）。

## 2. 现状与约束（已核实）

### 协议层：按需是一等公民，淘汰是「静默合法但不可表达」

- **snapshot 尾窗语义**：wire snapshot 只带尾 60 行，`totalCount/firstRowId` 是全序口径（`conversation-topic-publisher.ts:296-326`）——「window=60 行 / totalCount=5 万」本就是协议常态。
- **被逐出行 no-op**：`row.upserted/row.delta` 对不在窗口的 rowId 是协议成文的 no-op（「被逐出的行只能经 rows/range 取回」，apply.ts:88）——客户端可以合法地不持有某些行。
- **rowsRange 分页**：`beforeRowId` 游标 + `hasMore` + `atLogEpoch` 陈旧防护（transport.ts:503-525），服务端从全量投影切片（与订阅流同源归约）。
- **头部淘汰无协议表达**：`rowsWindowSchema` 没有「窗口左端点」字段。客户端本地裁 `window` 数组不破坏任何 delta 语义（升序保持、no-op 兜底），但**必须不动 `firstRowId`/`totalCount`**——`firstRowId` 是全序首行，是「到顶判定」（`hasOlderRows`，`conversationProjectionStore.ts:222-231`）和「整支删除判定」（apply.ts `removesEntireActiveBranch`）的锚。

### 三条硬约束（违反即自旋或错乱）

1. 本地淘汰只裁 `window`，`firstRowId`/`totalCount` 保持权威值。
2. `loadOlder` 在途守卫（`:1001-1003`）以「`window[0].rowId` 飞行期间不变」识别权威侧截断/snapshot 替换——本地淘汰同样移动 `window[0]`，若不加区分，合法结果会被误作废（自旋重拉）。
3. resync 走 snapshot 档时窗口整体替换为尾 60（`:645-686`「规则 1」），已加载历史**确定丢失**——现状如此（`:964-966` 注释成文），本方案不恶化。

### 现成的样板与钩子

- **plans 五层样板**：`v4/conversation/plans` 已实现「全分支轻量查询」的完整链路（schema transport.ts:527-544 → CLI `getPlans` conversation-topic-publisher.ts:458-479 → JSON-RPC 分派 server.ts:484 → host 只读透传 zcodeAgentService.ts:5214 → UI transport agentConversationTransport.ts:344 + store `refreshPlans` 的 revision+epoch 双校验防旧写回 `:1180-1217`）——目录命令整体照抄此模式。
- **滚动向上加载已存在**：原生 scroll 事件驱动（`shouldTriggerLoadOlder`：scrollTop ≤ max(64px, 2 视口)，timelineScrollAnchor.ts:249-274）+ prepend 滚动锚定完备（`:185-247`）——按需加载的 UI 钩子零新增。
- **服务端有全量投影**：CLI publisher 内部快照是全量行（findRow/rowsRange 数据源），`getPlans` 就是同处扫全量 rows 的先例。

### 目录需要什么（agent 考古结论）

目录条目粒度 = **realUser userInput 行**（不是 turn；一个 turn 的多条 steer 各占一项，导航 helpers `:182-190` 注释成文）。每条目需：`rowId`（跳转锚点）、`turnId`、`userPreview`（≤220 字符/2 段）、`assistantPreview`、`isRunning`；可零成本附带 turnHeader 的 `activeMs`。条目数 = 全分支 real-user query 数。

### 受窗口有界影响的消费方（除导航外）

| 消费方                                                       | 判定                          | 处理                                                                            |
| ------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------- |
| `hasPluginReferenceUserRows`（SessionPane:519）              | **全史语义，会漏**            | 目录命令顺带返回 `hasPluginReference` 布尔（服务端全量判定）                    |
| workflow graph/draft/provenance（workflowRunCardJoin:146+）  | 老 run 启动行出窗后侧栏图缺失 | 本期接受降级（见决策点 3）；workflow run 卡片本身走 `workflowRuns` 状态不受影响 |
| `resolveLatestCompletedAssistantPreviewTurn` / pptx 自动打开 | 最新端语义                    | 天然正确（最多不触发，不错）                                                    |
| Plan 详情 live markdown / `resolveMcpUnavailableNotice`      | 有既有降级路径                | 接受                                                                            |
| 会话内 find（1200 行上限 auto-load）                         | 本就有界降级                  | 走保留的 `loadOlder`，语义不变                                                  |
| optimistic overlay 收口 / 首轮自动补拉                       | 尾部语义                      | 天然兼容（补拉与淘汰的互斥见 §3.4）                                             |

## 3. 方案设计

### 3.1 新命令：`v4/conversation/directory`（回合导航目录）

五层照抄 plans 样板：

- **schema**（shared/transport.ts）：`directoryParams = {sessionId, clientMode?}`；`directoryResult = { items: DirectoryItem[], atLogEpoch, atSeq, hasPluginReference }`，`DirectoryItem = {rowId, turnId, userPreview, assistantPreview, assistantPreviewKind, isRunning, activeMs?}`。预览截断（220 字/2 段）在**服务端做**（目录是轻量契约，行不跨线）。
- **CLI handler**（conversation-topic-publisher.ts 新 `getTurnNavigatorDirectory()`）：扫投影全量 rows，realUser userInput 行建条目；`isRunning` = 该行属于当前 running turn；复用 helpers 的预览截断常量（常量搬到 shared，单一口径）。
- **JSON-RPC 分派 + host 只读透传 + UI transport 方法**：与 plans 逐层同构。

### 3.2 store 目录态与宽屏触发链改造

- `ConversationProjectionStore` 新增 `directory: DirectoryItem[] | null` 状态 + `refreshDirectory()`（照 `refreshPlans` 的 revision+epoch 双校验防旧分支写回）；失效复用既有 `turnNavigatorDirectoryRevision`（realUser query 增删、row.removed、snapshot 替换时递增——机制已存在，`:658/:738-742`）。
- 宽屏触发链（ConversationTimeline:545-615 hydration effect）从 `onLoadAllOlder()` 改为 `onRefreshDirectory()`；终态缓存语义从「hydrated=全量常驻完成」改为「directory 已拉取」，`not-enough-queries`（<2 条）由服务端 `items.length` 直接判定——客户端不再为计数拉任何历史行。
- `ConversationTurnNavigator` 数据源从 renderUnits 派生改为 `store.directory`；`activeQueryRowId` 追踪保持现有几何扫描逻辑（依赖挂载行，不受影响）。
- **`loadAllOlder` 删除**（连同 not-enough-queries 探测逻辑），全量常驻的入口彻底移除。

### 3.3 窗口淘汰（有界化）

- 上限 `CONVERSATION_WINDOW_MAX_ROWS = 2000`（决策点 2）：`mergeOlderRows` 合并后、以及 `applyFrame` 应用后（仅当无在途 loadOlder 时）检查，超限则从头裁到 ≤K。
- **裁剪以 turn 边界对齐**：裁到最近的 turnHeader 行之后，避免残留半 turn 反复触发「首 turn 不完整自动补拉」（`shouldAutoLoadIncompleteLeadingTurn`）形成补拉-淘汰循环；单个 turn 超过 K 的极端情况允许残缺，并置 `headTruncatedAtLimit` 标记抑制该补拉。
- 只裁 `window` 数组；`firstRowId`/`totalCount` 不动（硬约束 1）。

### 3.4 在途互斥（硬约束 2 的解法）

**淘汰时机收敛到合并点，不改守卫**：`loadOlder` 在途期间本地淘汰挂起（记 pending trim），合并时一并裁剪——在途期间 `window[0]` 只会因权威侧变化移动，原守卫语义完整保留。实现为 store 内一个 `trimPending` 标志 + 在 `loadOlder` finally 与 `applyFrame` 出口统一执行。

### 3.5 跳转到窗口外条目：`aroundRowId` 区间拉取

- **协议小扩展**：`rowsRange` params 增加可选 `aroundRowId`（与 `beforeRowId` 互斥，zod refine 校验）：返回以该 rowId 为中心的连续区间（前 K/2 行 + 目标行 + 后续行直到 K 上限，不足则贴边）。
- **客户端语义（区间替换）**：点击窗口外目录条目 → `jumpToRow(rowId)` → store 用 `rowsRange({aroundRowId, limit: K})` 拉取 → **整体替换 window**（升序连续区间，`firstRowId`/`totalCount` 不动）→ `scrollToQuery` 按现有路径定位。跳回最新：目录最后一条（running 条目）即尾部锚点。
- **流式并发**：running 会话跳往历史时，流式 `row.delta` 打在窗口外旧尾行 = 协议 no-op（既定语义）；新 `row.appended` 尾追新窗口后升序保持。回到尾部后再拉一次尾部区间即恢复流式视图。本期接受此语义（决策点 1 备选了「窗口开洞 + gap 占位」的完整方案，改动大不进本期）。
- `scrollToQuery`（ConversationTimeline:1213-1282）目标行不在 window 时的静默 no-op 改为：先回调 store `jumpToRow`，拉取完成后再定位（12 次 rAF 重试已够）。

### 3.6 窗口生命周期（所有权与事件顺序）

```
打开会话（宽屏）
  ├─ subscribe → snapshot（尾 60 行）          [n=60]
  ├─ 首turn缺header → 自动补拉 1 页             [n≤260]
  ├─ 宽屏 ≥864px → refreshDirectory()          [目录=全分支，0 行入窗]
  ├─ 用户上滚 → loadOlder（200/页，prepend锚定） [n+=200/页]
  │     └─ 合并点：超 K=2000 → 从头按turn边界裁  [n≤2000]
  ├─ 点目录窗口外条目 → rowsRange(aroundRowId)   [window=目标区间≤K]
  └─ 断档 resync → snapshot 整体替换（尾60）     [重置；目录仍在（服务端权威），
                                                   已加载历史接受丢失=现状语义]
流式帧（30ms）
  └─ row.delta/append → batch apply → memo O(n≤K)
```

### 3.7 验收基准扩展

`v4-frame-load-benchmark.test.ts` 增加 B 模式：打开「50k 行会话」的目录化模拟——base window 只 2000 行 + directory 项（数万）拉取一次 + 流式 2000 帧。断言每帧总成本 p95 ≤ 30ms（B2 验收基线首次落地为绿）。

## 4. 不做什么

- **memo 增量化不做**（B2 第二刀，防御纵深）：n 有界后 renderUnits O(2000)≈3ms/帧，预算内；增量维护的正确性风险不值得在本期承担。实测若淘汰上限被调到 8000 仍超预算再立项。
- **窗口开洞 + gap 占位不做**：跳转用区间替换（§3.5），窗口永远连续，全部既有不变量保持。
- **resync snapshot 保留合并不做**：接受重置（与现状一致，`:964-966` 先例）。
- **不改 `rowsWindowSchema`**：不加窗口左端点字段——本地淘汰是客户端私有事实，协议无需表达（firstRowId/totalCount 语义不动即可）。
- **老 workflow run 启动行的图/provenance 不按需补拉**：接受侧栏降级（卡片与详情主体走 workflowRuns 状态不受影响）。
- **不做会话长度产品治理**（护栏提示等，另议）。
- **sessions-index 链路不动**（B2 立项时已判定量级远小于行数链路）。

## 5. 验收标准

阶段 1（目录化 + loadAllOlder 退役）：

1. 单测：目录命令五层 schema/服务端构建（realUser 粒度、预览截断、hasPluginReference）全绿；store `refreshDirectory` 的 revision/epoch 失效与旧写回防护全绿。
2. 手工/单测：宽屏打开 50k 行会话不再触发任何 rowsRange 循环（日志零「完整问题目录补拉」），目录条目数 = 全分支 real-user query 数。
3. `loadAllOlder` 及其引用全链删除（grep 零残留），find 的 1200 行 auto-load 走 loadOlder 正常。
4. typecheck / lint / architecture:check / 既有 24 测试真实通过。

阶段 2（窗口淘汰 + 跳转）：

5. 单测：淘汰只裁 window、firstRowId/totalCount 不动；按 turn 边界裁剪；单 turn 超 K 的残缺抑制补拉。
6. 单测：loadOlder 在途期间淘汰挂起（在途守卫不被本地淘汰误伤）；合并点统一裁剪。
7. 单测 + 手工：`aroundRowId` 区间拉取（协议 refine 校验、服务端贴边逻辑）；跳转窗口外条目 → 拉取 → 定位成功；跳回尾部恢复流式。
8. 基准 B 模式：50k 行会话（目录化 + n≤2000）流式 2000 帧，每帧总成本 **p95 ≤ 30ms**，apply p95 ≤ 1ms 不回退。
9. 回归：真机抽查滚动上翻 prepend 锚定不跳动、目录跳转、正常退出无伪日志。

## 6. 工作量（AI 辅助日历工期口径）

| 阶段 | 内容                                                                                | 估计     |
| ---- | ----------------------------------------------------------------------------------- | -------- |
| 1    | 目录命令五层 + store 目录态 + navigator 数据源切换 + 宽屏链改造 + loadAllOlder 退役 | 2–3 天   |
| 2    | 窗口淘汰 + 在途互斥 + aroundRowId 协议/拉取 + 跳转接线 + 受影响消费方口径           | 2–3 天   |
| 3    | 基准 B 模式 + 真机抽查 + spec/文档收尾                                              | 0.5–1 天 |

## 7. 决策点（2026-09-25 已批准，全部按推荐落定）

1. **跳转语义**：✅ 区间替换（窗口永远连续；开洞+gap 占位作为后续增强另立）。
2. **窗口上限 K**：✅ 2000。
3. **老 workflow run 图/provenance 出窗降级**：✅ 接受。
4. **loadAllOlder**：✅ 彻底删除。
5. **预览截断常量**：✅ 搬 shared 单一口径。

## 8. 实施记录

- **阶段 1（b90325a + 评审修复 fb2d3f8/9a33f5b/5ae3400）**：目录命令五层 + store 目录态 + 导航数据源切换 + loadAllOlder 退役。四轮 subagent 评审拦下并修复：isRunning 不随轮次终态熄灭（turnHeader upsert 纳入失效面）、在途失效后目录停摆（store pending 闭环 + 失败退避）、窄屏/失败/旧 CLI 下 rail 与 plugin 图标全灭（窗口行同函数兜底）、clientMode 三层断链（facade trusted carrier 注册）。
- **阶段 2**：窗口淘汰（K=2000，turn 边界对齐，残缺头部抑制首轮补拉，loadOlder 在途互斥）+ `rowsRange({aroundRowId})` 区间跳转（窗口整体替换 ≤200 行——协议 rowsRange 上限，足够落点上下文；非方案原文的 K 行）+ `detachedFromLiveTail` 高水位回底。spec 同步于 packages/shared/spec/conversation-turn-directory.md。
- **阶段 3（待做）**：基准 B 模式断言（n≤K 流式 p95 ≤ 30ms）+ 真机抽查。
