# 文档体系索引

本仓库的文档分四层（指令 → 规格 → 契约 → 说明）加两类旁支（本地计划、构建产物镜像）。本文件是索引与维护规则；各文档自身的口径以其内容为准。

## 分层结构

### 1. Agent 指令层（会话自动注入）

| 文件                                                 | 读者       | 作用                                                                                   |
| ---------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                               | 编码 agent | 仓库级硬约束：spec-first 原则、命令表、验证要求、UI/平台边界、协议、日志规范与落盘位置 |
| [apps/zcode-cli/AGENTS.md](apps/zcode-cli/AGENTS.md) | 编码 agent | CLI 包级补充指令                                                                       |
| `apps/zcode-cli/packages/tui/SUBAGENTS.md`           | 子代理     | TUI 子代理行为说明                                                                     |

用户级 `~/.zcode/AGENTS.md`（不入库）承载本机环境约束，与仓库层叠加生效。

### 2. 规格层（spec-first 工作流）

`packages/<pkg>/spec/*.md`。规则（见 AGENTS.md 核心原则）：**新增或修改行为前先更新对应 spec；目录不存在时按需创建**；spec 写行为、所有权、接口与验收场景。删除功能时同步清理说明与技能中的引用。

当前存量：`packages/desktop/spec/`（auto-update-removal、client-config-rollout-removal、resource-telemetry-removal、renderer-crash-recovery）、`packages/shared/spec/conversation-delta-batch-apply.md`、`packages/server/spec/local-exposure-hardening.md`、`packages/zcode-cua/spec/computer-use-restore.md`（Computer Use 恢复：线协议契约、本地运行时边界与验收）。

### 3. 架构契约层（文档与工具联动）

| 条目                                      | 作用                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.agents/skills/architecture-governance/` | SKILL.md 主流程 + `references/`（module-contract、policy-schema、rule-catalog、golden-module、troubleshooting） |
| `pnpm architecture:check --changed`       | 模块/分层边界检查（`.architecture-baseline.json` 记基线豁免）                                                   |
| `pnpm architecture:context <module-id>`   | 生成目标模块的受控阅读包（模块契约的消费形式）                                                                  |
| `pnpm verify:pre-push`                    | push 门禁 = lint + architecture:check --changed                                                                 |

### 4. Skills 层（按需加载）

`.agents/skills/` 下每个技能一个目录：`SKILL.md`（frontmatter 声明触发条件）+ `references/` 细节参考。主文档薄、参考厚，按需展开。现有：agent-browser、ai-elements、architecture-governance、check-doc-sync、dep-refs、dogfood、electron、feature-boundary-planner、react-best-practices。

### 5. 人工说明层（仓库根）

| 文件                                                                      | 作用                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [README.md](README.md) / [README.en.md](README.en.md)                     | 初始化、开发运行、配置、打包、仓库结构（中/英）              |
| [COMMUNITY-EDITION.md](COMMUNITY-EDITION.md)                              | 社区版定位、数据上报名录、整改机制与阻断模型（讲机制与结论） |
| [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md)                                      | file:line 级取证证据，是 COMMUNITY-EDITION 的证据层          |
| [CONTEXT.md](CONTEXT.md)                                                  | 插件商店领域词汇表；改商店相关 UI 前读                       |
| [DESIGN.md](DESIGN.md)                                                    | UI 设计规范；改 UI 前读                                      |
| [NOTICE.md](NOTICE.md) / [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 项目声明与第三方版权（后者由脚本生成，勿手改）               |
| [third-party/README.md](third-party/README.md)                            | 三方许可数据源与声明生成/门禁流程                            |

### 6. 包内 README（就地维护）

各包自带：`config/README.md`（随客户端发布的内置默认配置）、`harness/remote/README.md`、`apps/zcode-cli/README.md` 及其下 browser-use-plugin `docs/`、`packages/formal-proof`、`packages/zcode-cua`、dynamic-workflow 系列等。不集中索引，随包演进。

### 7. 计划层（分两档）

- `docs/plans/*.md`（入库）：跨回合生效的工程实施方案——含 merge 操作预案、被 spec/审计引用的口径依据（如 `conversation-telemetry-fact-trim-design.md` 被 PRIVACY-AUDIT 保留红线引用）。实施完成不删除，作为后续 merge 裁决与裁剪批次的依据存档。
- `.zcode/plans/*.md`（gitignore）：会话产出的一次性实施方案暂存，不进版本库、不共享。

### 8. 构建产物镜像（不手改）

`packages/desktop/bundled-agents/` 与 `packages/desktop/dist-community/win-unpacked/resources/` 下的 agent 文档/技能副本随构建复制；修改源在 `apps/zcode-cli/packages/` 下对应包。

## 维护规则

1. **谁主管谁更新**：改行为的 PR 同步改对应 spec 与说明；命令表（AGENTS.md、README）以 `package.json` 实际脚本为准。
2. **说明只写存在的东西**：删除功能时同步清理 README/技能中的引用；引用文件路径写全路径，避免与真实目录歧义的缩写。
3. **证据链配对**：COMMUNITY-EDITION.md（结论）与 PRIVACY-AUDIT.md（证据）同步更新；PRIVACY-AUDIT 中的 file:line 是调查时快照，以符号搜索复核为准。
4. **版本单点**：版本号只在根 `package.json`，经 `build-metadata.mjs` 注入 `__ZCODE_VERSION__`；无 CHANGELOG，变更记录以 git 历史与 PRIVACY-AUDIT 的落地记录为准。
