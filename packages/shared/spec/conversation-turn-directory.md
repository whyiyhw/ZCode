# Spec：回合导航目录命令（v4/conversation/turnDirectory）+ 行窗口按需口径

> 2026-09-25。B2 第一刀（行窗口按需化），方案：`docs/plans/conversation-window-on-demand-and-directory-design.md`（决策点已拍板）。
> 取代「宽屏打开会话 → loadAllOlder 全量常驻」——全量常驻是 2026-09-24 白屏事故 n=5 万的来源，`loadAllOlder` 已删除。

## 行为定义

**命令契约**（只读、无状态、超时重发安全，与 rowsRange/plans 同族）：

- params：`{sessionId, clientMode?}`（clientMode 决定行可见性档位，与 rowsRange 同口径）。
- result：`{items, hasPluginReference, atSeq, atLogEpoch}`；`items` 为全分支 real-user query 目录，rowId 升序。
- 条目：`{rowId（跳转锚点）, turnId, userPreview（≤220 字/2 段截断，空串由 UI 本地化兜底）, assistantPreview, assistantPreviewKind: empty|running|text, isRunning, activeMs?}`。

**推导语义**（`buildConversationTurnDirectoryItems`，shared 纯函数，CLI publisher 全量投影行喂入）：

- 分组按 rowId 全序首见 turnId；条目粒度 = realUser userInput 行（同 turn 的多条 steer 各占一项）。
- origin ≠ realUser（workflowLaunch/background/goal/mailbox/synthetic）不进目录。
- assistant 预览 = 该 turn 全部 assistantText 行文本按序聚合截断（与退役前 UI 的 renderUnits 派生等价：轮尾拆分只剥 marker/artifact，从不剥 assistantText）。
- isRunning：turnHeader.state === "running" 且 executionKind ≠ "controlOnly"，仅该 turn 最后一条 query。
- `hasPluginReference`：userInput 行文本含 `(plugin://`（plugin 引用图标的全史事实；UI 的尾窗推导已删除，改读本字段）。

**五层链路**：schema（shared/turn-directory.ts）→ CLI handler（publisher `getTurnNavigatorDirectory` + gateway `turnDirectory`，冷会话复用 hydration 管线）→ JSON-RPC 分派（server.ts）→ host 只读透传（zcodeAgentService `conversationTurnDirectoryV4`，不建 runtime）→ UI transport `turnDirectory`。

## 窗口与失效口径

- **打开会话不再全量加载**：snapshot 尾 60 行 + 滚动按需 `loadOlder`（200/页，既有行为）。回合导航 rail 的数据源是 store.`turnNavigatorDirectory`（服务端全分支），rail 显隐 = items.length ≥ 2（原 not-enough-queries 终态由服务端 items 天然判定，客户端不再为计数拉历史）。
- **失效与重查**：`turnNavigatorDirectoryRevision` 递增条件 = snapshot 整体替换 / row.removed / realUser userInput 增删 / **turnHeader upsert（轮次终态迁移——isRunning 强调与 running 预览必须随轮次边界熄灭）**。store `refreshTurnNavigatorDirectory` 以 generation + logEpoch + revision 三重防护防旧写回；查询期间 revision 变化 → 返回 stale 并挂起 pending 重查（store 侧 finally 闭环，不依赖组件层依赖变化）；闭环重查失败不被丢弃——store 内 250ms/1s×2 有界退避重试（成功即重置，close 清理计时器），组件退避机器观察不到 store 内部发起的重查。
- **兜底口径**：目录未拉取（`turnNavigatorDirectory === null`——窄屏不触发目录查询、3 连败 terminal、旧 CLI 无此命令）时，rail 条目用同一纯函数从当前窗口行推导、plugin 引用图标退回窗口行谓词——与退役前行为等价，目录链路故障不夺走既有能力；目录已拉取（非 null，含空目录）则一律以服务端事实为准。
- **跳转**：窗口内条目走既有 scrollToQuery；**窗口外条目阶段 1 显式放弃**（unitIndex=-1 守卫 + 日志），阶段 2 由 `rowsRange({aroundRowId})` 区间拉取接管（届时修订本 spec）。

## 验收场景

1. 纯推导单测：realUser 过滤、多 query 拆项、assistant 聚合截断（220 字/2 段）、kind 三态、isRunning 仅末条 query、controlOnly 不 running、activeMs 透传、plugin 谓词。
2. store 单测：目录写入、epoch 漂移 stale、revision 失效 stale、并发单飞。
3. 手工：宽屏打开长会话不触发 rowsRange 循环（日志零「补拉」），rail 条目数 = 全分支 query 数；流式新增 query 后 rail 自动补项（revision 失效重查）。
