# third-party：三方许可材料与声明生成

本目录存放第三方许可声明的**数据源**，生成与校验逻辑在 `scripts/licenses.mjs` 及其依赖脚本（`generate-third-party-notices.mjs`、`third-party-notices.mjs`、`third-party-npm.mjs`）。

## 命令

```bash
node scripts/licenses.mjs notices   # 生成根目录 THIRD-PARTY-NOTICES.md
node scripts/licenses.mjs check     # 门禁：allowlist 之外或许可未知的包即退出码 1
node scripts/licenses.mjs check --strict  # 发布前：额外要求材料齐备（inventory.reviewRequired 为空）
```

## 数据口径

- 实装清单 = 全 workspace `node_modules` 的递归集合（含嵌套版本与符号链接）；prod 判定按 `pnpm-lock.yaml` 生产图中的精确版本。
- 声明按生产依赖的精确版本收集真实许可文件（版权与全文），不是 SPDX 标识的转写。
- 商用/半开放检查作用于全量实装包（prod + dev）；仅构建依赖的例外须在 `scripts/licenses.mjs` 的 `WEAK_ALLOW` 登记人工复核结论。

## 目录内容

| 条目                       | 用途                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `inventory.json`           | 版本、来源引用与哈希的机器可读清单；`reviewRequired` 列出待补齐/核验项   |
| `npm-overrides.json`       | 许可信息缺失或不准确时的手工覆盖表                                       |
| `copied-components.json`   | 从上游直接复制进仓库的源码/资源组件（如 shadcn 组件），钉住来源 revision |
| `embedded-components.json` | 随依赖二进制内嵌的组件（如 @napi-rs/canvas 内的 Skia）                   |
| `native-search/`           | 原生搜索工具的源包与全量哈希钉扎（`sources.json`）                       |
| `runtime/`                 | 随发行树内嵌的 Node 运行时许可文本与 `sources.json`                      |
| `upstream/`                | 上游许可文本与来源清单                                                   |

## 新鲜度与分发

- 输入（`pnpm-lock.yaml`、`pnpm-workspace.yaml`、各覆盖表、运行时许可）都以哈希记录在 `inventory.json`；输入变化后未重新生成会直接报错并提示重跑 `notices`。
- 声明在发行物中的位置：桌面安装包内为 `resources/THIRD-PARTY-NOTICES.md`；CLI/Web 发行树为 `agent/THIRD-PARTY-NOTICES.md`（`scripts/build-zcode.mjs` 组包时复制）。声明是各平台分发的保守并集，并非每个平台都包含全部列出的组件。
