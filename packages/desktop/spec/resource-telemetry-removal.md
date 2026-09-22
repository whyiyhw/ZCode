# Spec: 资源遥测族移除（社区版性能瘦身）

## 行为

- 桌面端不再存在任何资源/网络/DAU 类采样与上报：main 进程 10s 资源采样与 5min 上报、网络遥测 5min flush、DAU 15min 心跳、renderer 每窗 60s heap 采样、每 24h 数据目录体积扫描、MCP 进程资源采样（5min）及其跨进程样本消息全部移除。
- 随之移除 host / scheduler 进程的自采资源样本与 `[memory]` 周期日志、services 侧 memoryDiagnostics 计数注册，以及 main↔host 的资源样本消息类型与远程协议 capability `processResourceTelemetry`。
- `ZCODE_TELEMETRY_ENABLED` 总闸语义不变，但其管辖面缩小为剩余遥测（数仓事件、ARMS RUM、远程 crash）。

## 所有权

- 资源管理器（任务管理器）窗口的进程数据独立来源 `app.getAppMetrics()`（`resourceManagerWindow.ts`），不属于本族，不受本次删除影响。
- `appTelemetryCore` 与 `ReportTelemetryEvent` IPC 是 renderer 数仓事件通路，独立存活，出口仍由总闸管辖。
- ARMS 稳定性监控（`registerDesktopStabilityMonitors` / `desktopStabilityTelemetry`）属于崩溃/无响应监控，不随本族删除。

## 不变量

- **CLI app-server 的 60s 资源节拍必须保留**（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/resource-sampler.ts`）：该 interval 兼做 session 驻留回收与 event store 修剪的心跳，删除节拍会导致 app-server 多会话内存回归；只允许移除其遥测发射与 [memory] 日志部分。
- 删除后 main/host/scheduler/renderer 不得残留任何以**进程 CPU/内存资源遥测**为目的的 `setInterval`（host 的 `startupDiskSampler` 2s 磁盘可用空间采样属数据库启动诊断，族外保留；cron 20s 轮询、CUA 面板重定位等同理）。
- 桌面构建产物不得再引用 `processResourceTelemetry` capability；远端旧版 CLI 按 capability 协商容错（未声明即不上行）。
- **旧版桌面端兼容垫片**：`zcodeAgentConnectionScope` 与 `zcodeAgentService` 保留四个 `onDynamic*` 资源事件 no-op 实现（恒返回 `RpcEvent.None`，接口 @deprecated）——旧端 Host 在远程连接时无条件订阅这些事件，服务端缺方法会在旧端触发的 RPC 读循环里抛 "Event not found" 击穿 server 进程；确认无旧对端后一并移除。
- MCP tracker 只剩进程登记表：`recordProcessCrashed` 只清 process 不删 entry（pool 的 revalidate 原地重连依赖该语义），entry 终态由 `recordProcessClosed` / `unregisterConnection` 收口。
- scheduler↔main 私有协议的 `scheduler-resource-sample` 消息变体与 `NodeSelfResourceSample` 导入一并移除（该工程不在根 typecheck 覆盖内，曾因此漏网，见 PRIVACY-AUDIT §十一）。

## 失败语义

- 本地 `[memory]` 周期日志随之消失；排查内存问题改用 `ZCODE_TELEMETRY_ENABLED=true` 开启 ARMS 链路或进程级工具（任务管理器窗口仍可用）。
- E2E 的 `perf_*` 趋势断言与 `agent_metric_probe` 审计合同随之失效，不做替代。

## 迁移边界

- 旧安装遗留的 `userData/zcode-data-size-telemetry.json` 成为孤儿文件，无消费方，不做启动期清理（避免为删除引入新代码路径）。
- 旧 setting.json 与本族无耦合字段，无迁移动作。
