---
name: check-doc-sync
description: 回合结束前检查代码改动与文档/断言口径同步。当本回合用过写类工具（Write/Edit/新建或修改文件的 Bash）且改动涉及 packages/ 或 apps/ 代码时必须执行：先跑 node scripts/check-doc-sync.mjs 处理机械违规（新增 ZCODE_* 开关未登记、隐私口径头改动未同步 assert-privacy.mjs、行为变更无文档伴随），再快速核对受影响口径文档（AGENTS.md/COMMUNITY-EDITION/PRIVACY-AUDIT/spec）的描述是否仍成立。纯问答、纯查阅、纯讨论或只改 .md 文档的回合不触发。这是项目级强制收尾步骤，不要省略。
---

# 回合收尾：文档/口径同步检查

背景：2026-09-22 的事故——billing 契约头修复落地时，代码与单测全绿，但 COMMUNITY-EDITION.md 四处旧口径未同步、`scripts/community/assert-privacy.mjs` 仍把新头当全量禁串，下一次 CI 构建会被隐私门禁误挂。机械可提取的口径必须机械校验，不能依赖会话自觉。本 skill 是三层机制的第 1 层：

1. **本 skill（收尾检查）**：回合末即时发现，修复成本最低。
2. **Stop hook（`.zcode/hooks/check-doc-sync-stop.mjs`，机器本地）**：回合结束时机械注入提醒。
3. **pre-push 硬门禁（`.husky/pre-push` → `scripts/check-doc-sync.mjs --push`）**：推送边界强制，不可绕过。

## 何时触发

**必须触发**：本回合动过 `packages/`、`apps/` 下的代码文件（Write/Edit/新建），或动了 `ZCODE_*` 环境开关、隐私口径头（`X-Client-Timezone` / `X-Os-Version` / `X-Device-Mid`）、`scripts/community/assert-privacy.mjs`。
**不触发**：纯问答、纯查阅、纯讨论、只改了 .md 文档。

判定：回看本回合写类工具的调用目标。命中上述路径 → 执行；否则跳过。

## 怎么执行

### 1. 跑机械检查（必做）

```bash
node scripts/check-doc-sync.mjs
```

三类检查（退出码 1 = 有违规，输出自带处置指引）：

- **A** 新增 `ZCODE_*` 环境开关未见于任何跟踪文档或 assert-privacy.mjs；
- **B** 隐私口径三文件（`zcode-source-headers.ts` / `sourceHeaders.ts` / `nodeApiClient.ts`）diff 触及敏感头名，但断言脚本与审计文档均未同步；
- **C** 行为代码有改动而 diff 无任何 .md 伴随（纯重构可 `DOCSYNC_ALLOW_NO_DOCS="<原因>"` 豁免，仅此一项）。

违规处置：按输出指引修——**不是加豁免绕过**。A/B 属于口径债务，修复是本回合任务的一部分。

### 2. 语义抽查（改动触及口径文档时）

机械检查抓不住「名词都在、描述过时」的语义失真。若本回合改动涉及以下任一文档描述的行为，逐条核对该文档相关段落仍成立：

- `AGENTS.md`（命令表、边界规则、日志口径）
- `COMMUNITY-EDITION.md` / `PRIVACY-AUDIT.md`（开关表、断言口径——两文档与 `assert-privacy.mjs` 三方必须一致）
- `DOCUMENTATION.md` 索引的受影响 spec

不确定该查哪些文档时，可派只读 subAgent（`Agent` 工具，`subagent_type: "Explore"`）拿改动文件清单独立核对——独立视角能打破「自己改的自己查不出」的盲区。

### 3. 报告格式

无问题一句话收尾：

> ✅ check-doc-sync 通过（机械检查 + 口径文档核对）。

有问题分条列出「位置 + 问题 + 已修复/待确认」，与回合汇报合并。

## 边界

- 机械检查只能覆盖可提取口径（env 名、头名、断言配对、文档伴随）；语义失真靠第 2 步抽查与 review 兜底。
- 豁免口（`DOCSYNC_ALLOW_NO_DOCS`）只放行检查 C；用它跳过 A/B 属于滥用。
- Stop hook 配置在 `.zcode/config.json`（gitignore，机器本地），新会话生效；换机器需按 AGENTS.md 记录重建。
