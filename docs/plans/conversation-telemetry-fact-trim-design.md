# 方案:会话遥测 fact 裁剪第一步(CLI 生产侧只保留 turn 链)

> 2026-09-24。对应 PRIVACY-AUDIT.md §261 保留红线段「其余 fact 种类暂留待后续裁剪」的执行。
> 范围:一次提交,只裁 CLI 生产侧;shared schema 与服务端接收面本轮不动(第二步观察后再裁)。

## 1. 要解决的问题

`v4/telemetry/event` 流的 10 种 fact 中,唯一订阅者 `taskActivityTracker`(server-core 心跳的运行任务数统计)只消费 `turn.started` / `turn.terminal` 两种。其余 **8 种 fact 零消费**——原供给方「桌面埋点」已随全遥测栈删除(bfd11a8),但 CLI 仍在为每个会话持续生产它们:

- 高频 IPC 负载:`stream.chunk`(逐块)、`tool.lifecycle`(每工具调用最多 5 相位)、`model.request.status`、`usage.delta` 等,逐条序列化上送;
- 服务端逐条过 strict zod 解析(`toolPerformanceFactSchema` 等)后 fire 到唯一订阅者 taskActivityTracker 即被忽略(非 turn kind 直接 return);
- 8 条 strict schema 分支自带永续防护义务——注释写明要防止「把 prompt、工具输入或 provider URL 意外外带」,这是 8 个需要持续盯防的数据外带口径面,与本仓隐私瘦身方向冲突。

这是纯本地 IPC(无出网),所以是「裁剪」而非「隐私事故」,但死负载与防护面没有存在理由。

## 2. 现状与约束(已核实的链路事实)

```
CLI 会话事件(SessionEvent)
  └─ v4-gateway.ts:746  telemetryNormalizer.normalize()      [apps/zcode-cli .../zcode-protocol-v4/conversation-telemetry-facts.ts,748 行]
       └─ host.emitConversationTelemetryFact(fact)             [v4-bridge.ts:1328 → V4_NOTIFICATIONS.conversationTelemetryFact]
            └─ zcodeAgentService.ts:1931  schema.parse → fire  [packages/services,emitter L5396 onDynamicConversationTelemetryFact]
                 └─ 唯一订阅者: taskActivityTracker.ts(102 行)  [packages/zcode-server-cli/server-core]
                      └─ 只认 turn.started / turn.terminal → running task count → server-core 心跳
```

约束与红线:

- **turn 链不能断**:taskActivityTracker 依赖 `turn.started`/`turn.terminal` 统计运行任务数,驱动 session 驻留回收心跳;这是 resource-telemetry-removal spec 不变量同级的功能性依赖。
- **turn 链存在跨事件状态**:`sourceCommandByTurn`(BoundedValueMap)在 TurnStarted 记 `inputId`,TurnComplete/TurnError 读出作为 `sourceCommandId` 并 clearTurn。裁剪必须保留这条状态线。
- shared 的 `conversationTelemetryFactRuntimeSchema`(10 分支,全 strict)保留不动:它是接收端校验面,保留可让旧版 CLI 连新版桌面时旧 fact 仍被 strict 校验(fire 后由 taskActivityTracker 忽略非 turn kind,无害),同时把上游 merge 冲突面降到最小(v4 协议目录是上游活跃修改区;评审修正:两个 facts 文件与 schema 文件在 v3.14.3 唯一合并样本内零改动,「活跃」是对目录而非这两个文件)。
- 动态工作流的 UI 观测走独立链(`DwfRun*` 契约 + journal,`dynamic-workflow-run-observation.ts`),不依赖 `workflow.lifecycle` fact——已核实,删之无碍。
- normalizer 与 taskActivityTracker 均**无单测覆盖**(全仓 test/spec 零命中),验证靠类型检查 + grep 断言 + 现有 E2E 冒烟。

## 3. 方案设计

### 3.1 `conversation-telemetry-facts.ts`(748 行 → 预计 ~200 行)

`normalize()` 的 switch 只保留 3 个 case,其余整体删除:

| 保留 | 说明 |
| --- | --- |
| `TurnStarted` | 记 `sourceCommandByTurn`,产 `turn.started`(含 automationAdmission / offPeak 归属) |
| `TurnComplete` | 产 `turn.terminal`(success/interrupted),读并清 turn 状态 |
| `TurnError` | 产 `turn.terminal`(failed),同上 |

删除的 8 个生产分支:`ModelNetworkStatus`(model.request.status)、`ModelStreaming`(stream.chunk)、`ToolCallScheduled/Started/Progress/Result/Error`(tool.lifecycle)、`PermissionRequested/Resolved/Denied`(permission.lifecycle)、`ModelComplete`(usage.delta)、`DynamicWorkflowRunProgress`(workflow.lifecycle)、`SubagentSpawned/Stopped`(subagent.lifecycle)、`CompactCompleted/Failed`(compaction.terminal)。

随之删除仅服务这些分支的内部状态与辅助函数(逐个核对,非机械删):

- 状态:`firstStreamChunks`(BoundedKeySet)、`toolNameByCall`、`modelBySession`、`completedModelRequests`;`BoundedKeySet` 类整体删除,`BoundedValueMap` 保留(`sourceCommandByTurn` 仍在用);
- 辅助:`toToolPerformanceFact`、`skillTelemetryFactFields`、`mirroredSubagentToolFields`、`streamingParentToolCallId`(注意:它是唯一 export 的辅助函数,先确认无外部引用再删)、`providerHostname`、`totalTokensOf`、`compactTerminalStatus`、`isStepUsageQuerySource`、`isStepUsageModelComplete`、`modelRequestQueueKey`、`cronCreateAutomationId`、`CompletedModelRequestIdentity` / `ToolPerformanceFact` 类型;
- `clearTurn` / `clearSession` 收敛为只清 `sourceCommandByTurn`;
- imports 收敛:contracts 的十几个 payload 类型、`getModelUsageTotalTokens` 删;`SessionEventType`、`parseAutomationRunId`、shared 的 schema/type import 保留。
- `optionalString` / `nonNegative` / `recordValue` / `eventTimestamp` / `terminalStatus` / `automationAdmission` 按保留 case 的实际引用决定去留(实施时以 typecheck 未用告警兜底核对)。

### 3.2 删除 `conversation-telemetry-workflow-facts.ts`(119 行,整文件)

唯一调用方是被删的 `DynamicWorkflowRunProgress` case;它只服务 `workflow.lifecycle` fact。

### 3.3 不动面(第一步的「协议兼容缓冲」设计)

- `packages/shared/src/zcode-protocol-v4/telemetry.ts`(10 分支 schema)——不动;
- services 接收面(`zcodeAgentService` / `zcodeAgentConnectionScope` / `zcodeAgent` 接口)——不动;
- `taskActivityTracker` 与 server-core 心跳——不动;
- `v4-gateway` 接线——不动(`normalize` 对被删事件天然返回 null,不再上送;`clearSession` 调用点保持)。

### 3.4 已知取舍

| 取舍 | 接受理由 |
| --- | --- |
| 上游 merge 带回 fact 生产分支时需再裁(评审实测:被删区域的上游演进**必然显式冲突**,不会静默溜回;schema 侧加分支则零冲突自动合并——已用 check-doc-sync 检查 D 常驻断言兜住) | 方向已由保留红线定死,冲突裁决是机械劳动;比留着 8 条防护面便宜 |
| 新版 CLI 连旧版桌面时,旧桌面(若有埋点消费 8 种 fact)拿不到数据 | 社区版桌面无埋点;桌面与 CLI 同仓同版本分发,混布窗口极小 |
| shared schema 留 8 个「暂时无人触发」的分支 | 换取旧对端兼容 + 上游 merge 缓冲;第二步观察后再收缩,见 §7 决策点 1 |

## 4. 不做什么

- 不裁 shared schema(第二步,观察一两个上游版本后另行批准);
- 不动 services 侧资源遥测的四个 `onDynamic*` no-op 垫片(那是 resource-telemetry-removal 的另一件事,有独立移除条件);
- 不动 `adapters/src/mcp/telemetry.ts`、`runner-telemetry.ts`、model-io 记录等保留红线内的其他项;
- 不动 dynamic-workflow 引擎与观测链(`DwfRun*` / journal);
- 不新增单测重建(现状零覆盖,本方案以 grep 断言 + typecheck + 现有 E2E 冒烟验收;是否补 turn 链单测见 §7 决策点 3)。

## 5. 验收标准

1. `rg '"model\.request\.status"|"stream\.chunk"|"tool\.lifecycle"|"permission\.lifecycle"|"usage\.delta"|"subagent\.lifecycle"|"workflow\.lifecycle"|"compaction\.terminal"' apps/zcode-cli` 零命中(排除 dist)——**已固化为 `scripts/check-doc-sync.mjs` 检查 D 常驻断言**(生产白名单 + schema kind 登记,pre-push 自动执行),不再依赖一次性命令;`conversation-telemetry-workflow-facts.ts` 文件已删;
2. `rg "turn\.started|turn\.terminal"` 确认 CLI 生产侧仍产出两种 fact,`taskActivityTracker.ts` 源码无改动(git diff 为空);
3. `pnpm typecheck` 通过;`pnpm lint` 0 errors(注:oxlint `ignorePatterns` 含 `apps/zcode-cli`,该目录不参与 lint——CLI 源码以 typecheck 与 grep 断言覆盖);
4. `pnpm architecture:check --changed` 0 violations;
5. `node scripts/check-doc-sync.mjs` 通过;
6. 文档口径同步:PRIVACY-AUDIT §261 保留红线段改为「CLI 生产侧只生产 turn.started/turn.terminal(纯本地 IPC,无出网);其余 fact 种类生产侧已裁剪,shared schema 暂保留作旧对端 strict 校验面」;`resource-telemetry-removal.md` 迁移边界补一行指向本次裁剪;
7. 手动冒烟(环境允许时):启动 desktop + CLI 会话,server-core 心跳正常、运行任务数随会话起止变化。

## 6. 工作量

约 0.5 天(AI 辅助):代码裁剪 + grep/typecheck/lint/doc-sync 验证 + 两处文档同步,单次提交(代码 + 文档伴随,同 ca7cae5 惯例)。

## 7. 待拍板的决策点

1. **shared schema 是否本轮一并裁到 2 分支?** 倾向:不(两步走)。一步到位会让 v4 协议文件的 merge 冲突面立刻最大化,且失去旧对端 strict 校验缓冲;但若你判断社区版用户总是桌面+CLI 同步升级、上游 merge 频率可控,一步到位也成立。
2. **`streamingParentToolCallId` 是 export 符号**,删除前需确认全仓无外部引用(实施时核查;若有引用则说明还有隐性消费方,需回来重新评估该分支)。
3. **是否顺手为 turn 链补一个最小单测**(taskActivityTracker 现零覆盖,是心跳功能依赖)?倾向:补一个(裁剪类改动的回归保护成本低);也可维持现状靠 E2E。

## 8. 实施与评审补记(2026-09-24)

三个独立子代理评审(运行时正确性 / 零消费者红队 / 上游 merge 维护者)全部放行:保留的三个 case 与 HEAD 逐字节一致;73 项真实源码运行时断言(schema.parse 全路径、JSON 往返、互斥红线、状态线、13 种被删事件走 default)全过;四条核心断言(唯一消费者、fire 无害、构建产物、CI/E2E)五路攻击未打穿。

**决策点落定**:① shared schema 两步走(未裁);② `streamingParentToolCallId` 全仓零引用,已删;③ 未补单测——bootstrap 无测试基建,引入 runner 超出本次范围。

**常驻断言(评审建议采纳)**:`scripts/check-doc-sync.mjs` 新增检查 D——D1 生产侧 kind 白名单(锚定 `conversationTelemetryFactSchema.parse` 调用点 1000 字符窗口,防接收方/转发层同文件无关 kind 误报),D2 shared schema kind 集合 == 登记清单。正向通过、负向(伪造 parse kind)实测拦截。

### 下次 merge 操作预案

| 文件 | 预计形态 | 裁决动作 |
| --- | --- | --- |
| `conversation-telemetry-facts.ts` | 上游动了被删区域才会显式大空冲突块(唯一样本内两文件零改动,概率被高估但 v3.14.3 主题与 workflow 同源,趋势真实) | 冲突块保 HEAD(空侧)= 再裁;对保留区域(三 turn case + helper + imports)跑一次上游 diff,确认自动合并的 turn 链演进 |
| `conversation-telemetry-workflow-facts.ts` | modify/delete 冲突 | `git rm` 保删除(只服务 workflow.lifecycle,无 turn 链依赖) |
| `packages/shared/src/zcode-protocol-v4/telemetry.ts` | **大概率零冲突自动合并——最需人工看** | merge 后必 diff:上游加 fact 分支 → 登记 check-doc-sync 检查 D2(第二步裁剪候选);上游改 turn 两分支字段 → 对照 normalizer 产出,required 字段缺失须同步补生产,否则运行时 parse throw(低概率窄缝,E2E/心跳冒烟可抓) |
| `v4-gateway.ts` / `v4-bridge.ts` | 自动合并(本地未动) | 无需手动;normalize 签名变更由 typecheck 兜底 |
| merge 后验证 | — | `node scripts/check-doc-sync.mjs`(检查 D)+ `pnpm typecheck` + 心跳冒烟 |

### 下次裁剪候选(非本次范围)

- `normalize` 的 `runtimeMetadata` 签名收敛为 `{ memoryEnabled?: boolean }`(`modelName`/`modelProvider` 已无消费者),连带删 v4-gateway 的 config 取值块;
- `zcodeAgentConnectionScope.ts:870` 附近指向已不存在的 renderer 订阅者的陈旧注释(bfd11a8 遗留,非本次引入);
- 陈旧打包副本(`bundled-agents`/`dist-community` 内旧 zcode.cjs 仍产 8 种 fact)在 CLI 重建后自然收敛,重建前「不再生产」仅对源码成立。
