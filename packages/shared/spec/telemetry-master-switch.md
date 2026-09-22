# Spec: 遥测总开关（ZCODE_TELEMETRY_ENABLED）

## 行为

- `ZCODE_TELEMETRY_ENABLED` 是数仓事件上报与 ARMS RUM（含远程 crash 上报）的总开关，唯一定义点为 `packages/shared/src/env.ts`。
- 本 fork 基线：默认关闭；仅当环境变量 `ZCODE_TELEMETRY_ENABLED` 恰为字符串 `"true"` 时开启（显式 opt-in）。
- 上游（zai-org）默认 `true`，依赖"上报端点未配置即不上报"兜底；本仓库自行构建不注入端点，但仍将默认值收紧为关闭，防止任何环境意外继承端点配置后静默上报。

## 所有权

- 常量在模块加载时求值一次；无运行时可变状态，无第二写入路径。
- 消费方（services `telemetryCore`、desktop `appARMSBootstrap` / `appCrashCaptureBootstrap`）只读取该常量，不各自重复判定开关。

## 不变量

- 开关为 false 时，数仓与 ARMS 出口在任何端点配置下都必须保持不联网。
- Agent 侧 OTLP 链路由 `OTEL_EXPORTER_OTLP_ENDPOINT` 独立门控（默认 Noop），不归本开关管辖。

## 失败语义

- 环境变量缺失或值不是 `"true"`（含 `True`/`1`/`yes`）一律视为关闭；不抛错、不告警。

## 迁移边界

- 本变更为 fork 本地隐私策略，不回馈上游；后续同步上游 `env.ts` 时必须保留 opt-in 语义（见 AGENTS.md「保留与任务无关的本地改动」）。
