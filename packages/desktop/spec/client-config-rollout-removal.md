# Spec: 客户端灰度（rollout）链移除（社区版性能瘦身）

## 行为

- 桌面端不再从 `/api/v1/client/configs` 拉取灰度配置：`SingleFeatureRollout`、`desktopContextPromptRollout`、`rendererActionTraceRollout` 及共用 fetcher 移除；首个 Host fork 前的 ≤2s 有界裁决门与 action-trace 60s refresh 定时器随之消失。
- Desktop Context Prompt（agent 系统提示词的桌面段）改为静态默认**关闭**：Host env 显式注入 `"0"`。需要开启时修改 `desktopHostProcess.ts` 中的常量并重新构建。
- Renderer Action Trace 静态返回 `DISABLED_RENDERER_ACTION_TRACE_CONFIG`；`ZCODE_RENDERER_ACTION_TRACE_ENABLED` / `ZCODE_LOCAL_TTFT_ENABLED` 环境变量仍是本地逃生口（OTLP 管道保留，endpoint 未配置时队列丢弃）。
- 帮助配置（helpConfig）保留：按需读取、独立缓存，无灰度耦合。

## 所有权

- Context prompt 开关的唯一事实来源是 main 进程注入的 Host env 常量（`desktopHostProcess.ts`）；services 层三态解析（`resolveZCodeAgentPresentationSurface`）与远端 env 白名单（`server/src/remote/connect.ts`）保持不动。
- `deviceMid` 仍由 helpConfig 等公开读取路径使用，不随灰度链删除。

## 不变量

- **必须显式注入 `"0"`**：services 层对 env 缺失（undefined）按历史装配语义视为"开启"，只删灰度而不注入常量会导致特性静默全量开启。
- 首个 Local Host spawn 路径上不得存在任何网络请求等待（冷启动无灰度裁决门）。
- main 进程不得残留针对 `/api/v1/client/configs` 的周期性或事件驱动刷新（helpConfig 的用户触发按需读取除外）。

## 失败语义

- 灰度不存在"失败"路径：无请求、无超时、无快照回退。
- env 逃生口非法值（非 truthy 字符串）一律视为关闭，不抛错。

## 迁移边界

- `/api/v1/client/configs` 端点仍有其他消费方（helpConfig、services clientConfigService、provider-node 内置配置刷新），本 spec 只移除 desktop main 的两个 rollout 实例；forceUpdate 残余链已按 `auto-update-removal.md` 清理。
- 上游同步时若 reintroduce 灰度，须保持"首 Host 前无阻塞等待"的本仓库约束。
