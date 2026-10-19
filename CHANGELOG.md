# Changelog

## [3.17.0](https://github.com/whyiyhw/ZCode/compare/v3.16.2...v3.17.0) (2026-10-19)

### Features

* **build:** ZCODE_CUA_BUNDLE_HELPER 本地出包开关——显式带上已暂存的 CUA Helper 运行时 ([642107f](https://github.com/whyiyhw/ZCode/commit/642107ff0b23a2617a928813346c68f0a2e36db3))
  * electron-builder.config.js：shouldPackageComputerUseHelper 增加
  * 新增 electronBuilderCuaHelperBundling.test.ts（3/3）：占位默认不注入、
  * computer-use-producer-detection.md 验收补开关例外口径

* **cua:** 恢复 v3.16.0 被整包回退的 Computer Use 真实现（补 v3.15.1 导出面） ([a495068](https://github.com/whyiyhw/ZCode/commit/a495068879c4683f30a0509ad7d892b19c1d3bff))
  * 自 0e1e50e3（实现）+ 9b1a99f0（lint 清理）恢复 9 文件；3 个私有函数
  * spec 补「维护史」（回退始末与盲区：.mjs 测试不在 vitest 收集范围，
  * 验证：node --test 18/18、typecheck/lint/doc-sync 全绿、全量 pnpm


### Documentation

* 落档发布门禁——真实启动冒烟通过后才能发布安装包 ([04e11b0](https://github.com/whyiyhw/ZCode/commit/04e11b09bcd959fc5084b441f35e0609fa7d68b6))
  * PRIVACY-AUDIT.md §十五补记追加用户裁定（2026-10-15）：v3.16.0 与 v3.16.1
  * docs/desktop/zcode-preview-packaging.md 追记 2026-10-15 节：冒烟四步标准流程

## [3.16.2](https://github.com/whyiyhw/ZCode/compare/v3.16.1...v3.16.2) (2026-10-15)

### Bug Fixes

* **desktop:** 清剿 v3.15.1 合并残留的悬空引用，补悬空名称门禁（v3.16.1 启动崩溃） ([2053dd8](https://github.com/whyiyhw/ZCode/commit/2053dd8e0c2b602a89fcbd8a8c6638173449d481))
  * 恢复丢失的 import（被引符号全部健在，纯合并损伤）：hostname（node:os）、
  * 类型入口错位：IStorageService 改取自 @zcode/services；StorageRootSpec 改取自
  * RemoteUsageRemoteKind 在 shared 从未存在，改用生产方口径 RemoteTarget["kind"]
  * 复审补刀：desktopWindowLifecycle 关窗回调的 browserWindowId（TS2552 建议变体，
  * tsconfig.main lib 补 DOM（browserPlaywrightExecutor 在页面上下文用 document）
  * 新增 danglingNameGate.test.ts：三子工程 TS2304/TS2305/TS2552 必须为零，
  * 登记 docs/monitoring/remote-usage-arms-telemetry.md 失效（ARMS 通道已随 §十五 删除）

## [3.16.1](https://github.com/whyiyhw/ZCode/compare/v3.16.0...v3.16.1) (2026-10-15)

### Bug Fixes

* **desktop:** 摘除 v3.15.1 合并残留的打包遥测注入链，修复安装包启动 ReferenceError ([73299c2](https://github.com/whyiyhw/ZCode/commit/73299c2751fe5eb8df7954915c0c7a4ef687efb4))
  * desktopRuntimeEnv.ts 打包分支恒返回空对象（ZCODE_BASE_URL 等链接由
  * tsup 删除该 define、resolveBuildPackagedAgentTelemetryEnv（含 CI release 门控）
  * e2e 构建缓存指纹移除 CI/CI_COMMIT_*/ZCODE_PACKAGED_AGENT_OTEL_* 六个失效变量
  * 新增打包态契约测试（不读本地 .env、恒空对象）防上游合并回潮
  * 同步 PRIVACY-AUDIT §十五补记、build-time-optional-capabilities 与 TTFT checklist 口径


### Chores

* **release:** oxfmt 收敛 CHANGELOG 存量格式（v3.16.0 手工编辑后未过 fmt 门禁） ([1b8b829](https://github.com/whyiyhw/ZCode/commit/1b8b829c6f1f1305cb0e5ec2950cfebebb90e0a8))

* **release:** 修正 CHANGELOG 各版本 compare 链接（writer 生成 vnull/空版本的存量缺陷） ([574b5b1](https://github.com/whyiyhw/ZCode/commit/574b5b16ec4ad32b9d6fa59883463c9a1944e86d))

## [3.16.0](https://github.com/whyiyhw/ZCode/compare/v3.15.1...v3.16.0) (2026-10-15)

### Bug Fixes

- **bootstrap:** vitest unit 项目 include 限定 \*.test.ts（Node 24 兼容） ([afe4178](https://github.com/whyiyhw/ZCode/commit/afe4178e186f52dcceefff9bfb436f39392245f3))

- **build:** 修复全量 pnpm build 四层失败——cua prebuilt/合并丢失/残留入口/vendor 行尾 ([fcfb474](https://github.com/whyiyhw/ZCode/commit/fcfb4749c2a8737dccb378c0c5fb3c0d221d42f1))

- **shared:** Windows 原子替换 rename 重试窗扩至 10 次/5.6s ([0f3cb27](https://github.com/whyiyhw/ZCode/commit/0f3cb27607ed2d54a45f1d320cae3a4950f73a69))

### Chores

- **git:** fmt 管辖类型统一 checkout LF——oxfmt 行尾口径落地 ([202e57a](https://github.com/whyiyhw/ZCode/commit/202e57aaa6fa99d0f83febf59fc59a5aed30ce2b))

### Refactorings

- **telemetry:** 裁剪跟进收尾——normalize 签名收敛 memoryEnabled、陈旧注释纠偏、taskActivityTracker 补单测 ([bf844b2](https://github.com/whyiyhw/ZCode/commit/bf844b2c6589fecf057b4d14ddad0ba74cda42b3))

## [3.15.0](https://github.com/whyiyhw/ZCode/compare/v3.14.3...v3.15.0) (2026-09-27)

### Features

- **shared,ui:** 回合导航目录服务端化 + loadAllOlder 全量常驻退役（B2 阶段 1） ([b90325a](https://github.com/whyiyhw/ZCode/commit/b90325add6d7ab88f052d786d50ced4a62cfca8e))
  - 新命令 v4/conversation/turnDirectory（五层：schema/纯推导 → CLI publisher
  - store 新增 turnNavigatorDirectory / directoryHasPluginReference /
  - ConversationTurnNavigator 数据源切到服务端目录（本地化兜底文案留在
  - loadAllOlder 及全量常驻入口彻底删除（2026-09-24 白屏事故 n=5 万的

- **shared,ui:** 行窗口淘汰 + aroundRowId 区间跳转（B2 阶段 2） ([8a73f54](https://github.com/whyiyhw/ZCode/commit/8a73f5437a705027d1b991f8659467a454c205f6))
  - 协议：rowsRange params 增加 aroundRowId（跳转拉取：以目标为中心向前的
  - store 窗口淘汰（K=2000，决策点 2）：流式追加/loadOlder 合并顶过上限时
  - store 跳转：jumpToRow（aroundRowId 区间整体替换窗口 ≤200 行，epoch/
  - UI：目录窗口外条目点击 → jumpToRow 后由 pendingJump 布局效应在新
  - 已知取舍（spec 成文）：跳转时在途 delta 内容随旧窗口丢弃（seq 水位

### Bug Fixes

- **cli:** publisher 目录命令的 import type 误用与 aroundRowId 闭包 narrowing ([e81ce4e](https://github.com/whyiyhw/ZCode/commit/e81ce4e030db4f418b2bec695cc6dfe1600adfbf))

- **desktop,shared:** 渲染进程崩溃自愈与 delta 帧批量 apply ([97aac38](https://github.com/whyiyhw/ZCode/commit/97aac38966c3b3ae9a647b119ed16b700a6c39c0))
  - rendererCrashRecoveryPolicy（纯决策）+ rendererCrashRecoveryMonitor（接线）：
  - give-up 经 markForceQuit + app.quit() 退出（绕过 quit 确认弹窗挂死）
  - 恢复动作 setImmediate 推迟：render-process-gone 回调内同步 reload() 撞
  - 激活死代码 registerCrashEventMonitor（含 webContents 销毁防护）
  - applyConversationDeltasBatch：帧内一次拷贝 + 有序二分定位（线性兜底），
  - conversationProjectionStore delta 帧路径切换

- **desktop:** mac 打包未启用签名时改用 ad-hoc 封签，避免 Release 包被 Gatekeeper 判「已损坏」 ([5314d41](https://github.com/whyiyhw/ZCode/commit/5314d41b11281f7f4dfc1a1f6210620b04b6e416))

- **scripts:** third-party 生成脚本逐项目 spawn 防Windows EMFILE + 正规重生成 inventory ([90f4dc7](https://github.com/whyiyhw/ZCode/commit/90f4dc70e3adcf122c01d81bc83294443bb12c75))
  - npm-overrides.json 删 7 个已不在生产图的 stale 条目
  - inventory.json / THIRD-PARTY-NOTICES.md 由脚本正规重生成
  - licenses.mjs check 全过（1721 实装包 + 14 项待补齐）

- **services,ui:** 目录命令 trusted carrier 的 facade 注册 + active 解析 -1 过滤落到 fallback ([9a33f5b](https://github.com/whyiyhw/ZCode/commit/9a33f5b34be66a85a37d8dee03e44ebbfeeac8f9))

- **ui,services:** 目录快照的失效面与兜底闭环（实施评审 4 项 Major） ([fb2d3f8](https://github.com/whyiyhw/ZCode/commit/fb2d3f87c576622098b815d447da9dd405412a61))
  - isRunning 熄灭：turnHeader upsert（轮次终态迁移）纳入目录失效面——快照型
  - 在途失效重查闭环：refreshTurnNavigatorDirectory 挂 directoryQueryPending，
  - 兜底口径：目录未拉取（窄屏不触发查询 / 3 连败 terminal / 旧 CLI 无此命令）
  - clientMode 断链：host 层照 rowsRange 补 readTrustedZCodeAgentV4Connection
  - minor：active 解析跳过窗口外 -1 条目、注释命令名修正、benchmark 桩补

- **ui:** 攻击实测 P1/P2/B1——rewind 水位重锚、vintage 倒退防护、按钮收回 ([6300a54](https://github.com/whyiyhw/ZCode/commit/6300a547fba4dfa7160322b3d78722bf61edd5e9))
  - P1（Critical）：row.removed（edit/retry 截断）重锚实时尾部高水位到截断后
  - P2（Major）：jumpToRow 的 atSeq < current.seq 视为陈旧读整体丢弃——
  - B1：脱离解除时按当前 following 收回回底按钮（置位有 effect 夺回显示，

- **ui:** 目录闭环重查失败挂有界退避重试（攻击实测 F1） ([5ae3400](https://github.com/whyiyhw/ZCode/commit/5ae340050bc22efbfd81a3f6d82ab3457656b61b))

- **ui:** 跳转水位/脱离不变量/满窗死路等六项评审修复（2 Critical + 4 Major） ([7c19dba](https://github.com/whyiyhw/ZCode/commit/7c19dbaccabe4197946e1511df17c2ccabfeaeec))
  - C1a seq 水位：跳转提交 seq = max(本地, result.atSeq)——保留落后水位会让
  - C1b 脱离态 append 丢弃：跳转历史区间后实时 append 不拼入窗口（窗口连续
  - M1 pendingJump 生命周期：失败即清 + 换会话清零 + 成功 2s 超时兜底，
  - M2 满窗死路：预裁方案否决（会在窗口中间挖洞破坏连续性），改迟滞淘汰——
  - M3 脱离态回底可见：窗口底不是实时底，回底按钮脱离态一律显示（唯一
  - M2-b 跳转一次性抑制首轮自动补拉（mid-turn 开窗不在落点链式拉历史）
  - minor：snapshot 真重置高水位（rewind 兼容）、benchmark 上限常量化、

- **ui:** 验证员二轮——闭包冻结与会话隔离收口 ([d866738](https://github.com/whyiyhw/ZCode/commit/d86673868ea0f5add7e8fd96f1df38f3c7b8d56f))
  - commitFollowing deps 补 detachedFromLiveTail：[] 闭包冻结在首渲染
  - handleBackToBottom deps 补 detachedFromLiveTail/onJumpToTail（同因
  - pendingJumpQueryRef 换会话清零：独立 sessionKey effect（rowId 跨会话
  - scrollToQuery deps 补 onJumpToRow（跨 lease 调旧会话 store 的存量缺口

### Chores

- release v3.15.0 ([61d30b7](https://github.com/whyiyhw/ZCode/commit/61d30b7ca41abd5bc9a344779c98baab6da648fe))

- **release:** Release 说明同步 ad-hoc 封签后的 mac 首开口径 ([0fd8e9f](https://github.com/whyiyhw/ZCode/commit/0fd8e9f0c1d40075437a35e5bffe52ab4e6aff8e))

- 同步 third-party inventory 输入哈希（upstream merge 后 15 项漂移） ([e62011e](https://github.com/whyiyhw/ZCode/commit/e62011ef045d9522540d1c5f41b67c12312d39ed))
  - 3 个 upstream 许可文本——上游合并已移除）。全量 2863 项输入 +

### Documentation

- 崩溃恢复方案 §3.3 B2 已实施标注 + §5 验收终态数字补齐 ([7f7ace9](https://github.com/whyiyhw/ZCode/commit/7f7ace9de0d82161c62aab434b05628ab8f45d0f)), closes [#3]() [#4]()
  - §3.3 从「方向，不随本轮实施」改为「✅ 已实施」，指向独立 B2 方案文档，

- 方案 §8 阶段 2/3 实施记录补齐（含全部评审发现与真机结果） ([998bb1e](https://github.com/whyiyhw/ZCode/commit/998bb1e2e116aa1015c49cc27a644a732d131c31))

- 补记帧负载基准全量档复核数字（apply p95=0.33ms / 总 p95=102ms） ([50e664d](https://github.com/whyiyhw/ZCode/commit/50e664dc98be4d8c7750c5909e9f5dfa1cc6a025))

### Refactorings

- **cli:** trim conversation telemetry facts to turn-only production ([49efe73](https://github.com/whyiyhw/ZCode/commit/49efe734ac51ed798faa8000829de3a0fd7a2b28))

- **shared,services:** remove leftover forceUpdate config chain ([82c9d1e](https://github.com/whyiyhw/ZCode/commit/82c9d1e224b4868e3df7eb782c31344fdf728c79))
  - shared：forceUpdate.ts（semver 比较/resolveForceUpdateRequirement）、
  - services：getForceUpdateConfig 接口方法、service wiring、

- 清理全部 62 条 oxlint 告警并启用 lint --deny-warnings ([9b1a99f](https://github.com/whyiyhw/ZCode/commit/9b1a99f01e8fa4ec4e55aa940239c39675301701))

## [3.14.3](https://github.com/whyiyhw/ZCode/compare/v3.14.2...v3.14.3) (2026-09-23)

### Features

- **privacy:** drop assistant message like/dislike interaction and mechanism ([ccf9597](https://github.com/whyiyhw/ZCode/commit/ccf959742726302112678c5908034ffb89858f3b))
  - 按钮/乐观回滚/onFeedbackChange 五层 prop 链与 AssistantFeedbackHandler 导出
  - setAssistantFeedback 命令、row feedback 字段（旧快照按未知键剥除）、
  - assistant-feedback-persistence/handler、v4-bridge 持久化分支、gateway 裁决、
  - services setAssistantMessageFeedback 与 ZCodeAssistantMessageFeedback 类型
  - 保留：权限拒绝自由文本、workflow 编译反馈、action-trace copy 动作

- **privacy:** drop feedback, community, conversation-share and full telemetry stack ([bfd11a8](https://github.com/whyiyhw/ZCode/commit/bfd11a80c83153b9cfa5d56abeab435f7d907693))
  - 问题上报/给产品提需求整体下线（反馈中心、FeatureRequest、工单、OSS 直传；PRIVACY-AUDIT §十三）
  - 用户社群入口与 helpConfig 拉取链下线（§十四）
  - 会话分享发布链 + web 落地页 + deep link 导入 + CLI sharedContext 生产链下线（§十五）；
  - ARMS RUM SDK、数仓遥测、本地 TTFT OTLP、CLI OTLP exporter 整栈删除（§十五）；
  - assert-privacy 遥测字符串升级为零命中硬断言；ZCODE*TELEMETRY*\* / ARMS env 开关注销
  - 顺带清除存量死代码：V4ChatPane / networkErrorClassifier / armsRumShared

- **release:** bump version to 3.14.3 ([e37ab7f](https://github.com/whyiyhw/ZCode/commit/e37ab7f0804d8d83ed17432a890dff14963af5da))
  - 删除「问题上报」「给产品提需求」「用户社群」「会话分享」四个功能整链
  - 删除遥测整栈：ARMS RUM SDK、数仓上报、本地 TTFT OTLP、CLI OTLP 导出、
  - 删除 assistant 消息赞/踩交互与 setAssistantFeedback 协议命令全链
  - 清除存量死代码（V4ChatPane / networkErrorClassifier / armsRumShared）
  - 保留红线：deviceMid（计费契约）、action-trace 调试链、model-io、

- update v3.14.3 ([328c1a0](https://github.com/whyiyhw/ZCode/commit/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f))
  - The concurrency limit of a running workflow can now be adjusted directly, without stopping the task.
  - Optimized the reuse logic when modifying and restarting workflows.
  - Improved the real-time status display for large workflows.
  - Improved the efficiency of workflow script submission and modification, reducing token consumption.
  - Fixed an issue where workflows could cause the interface to crash in some cases.
  - Fixed an issue where buttons on workflow cards were sometimes pushed out of the interface.
  - Fixed an issue where the workflow tool took up too much context.

### Bug Fixes

- **cli:** 修复隐私删除遗留的 CLI typecheck 断点 ([196d665](https://github.com/whyiyhw/ZCode/commit/196d665e3323ba8ddabd805939b4b8a1a547a0b7))
  - contracts 的 local-turn-preparation.ts 删除后，core 侧 model.ts /
  - telemetry 的 provider-endpoint.ts 属误删：它是 model-api-recorder

### Documentation

- 同步隐私删除与 Computer Use 恢复后的口径文档 ([68b1162](https://github.com/whyiyhw/ZCode/commit/68b116281d960ecfee3531bbe44d738029695752))
  - .env.example 移除 ZCODE_CONVERSATION_SHARE_WEB_URL（会话分享链已于
  - COMMUNITY-EDITION / DOCUMENTATION 清理 telemetry-master-switch spec
  - README / NOTICE / zcode-cua 包描述从「占位包不可用」更新为
  - NOTICE 移除分享链路与桌面自动更新的过期表述

## [3.14.2](https://github.com/whyiyhw/ZCode/compare/v3.14.1...v3.14.2) (2026-09-22)

### Bug Fixes

- **billing:** restore zcode-plan contract headers on billing paths ([f243a67](https://github.com/whyiyhw/ZCode/commit/f243a679d2371421a49f0d33889392ccac400ca9))
  - shared buildZCodeSourceHeadersFromContext 新增 serverContract 选项，
  - nodeApiClient 按 /api/v1/zcode-plan/ 路径前缀判定契约请求，
  - CI 编译步骤补 ZCODE_ENV=production + ZCODE_PREVIEW_IDENTITY=1
  - PRIVACY-AUDIT §十二豁免记录、COMMUNITY-EDITION 四处口径同步、
  - 单测 4 例；E2E：dev runtime billing/balance 400 -> 200

- **release:** bump version to 3.14.2 ([cb62bff](https://github.com/whyiyhw/ZCode/commit/cb62bfff711cdc986b31c1ca06e2413ade0e6f2e))

### Chores

- **gates:** add three-layer doc-sync enforcement (skill + stop hook + pre-push) ([6c6a496](https://github.com/whyiyhw/ZCode/commit/6c6a496718181237c6ac5f9841ea86c55fbeb6ca))
  - scripts/check-doc-sync.mjs 三类检查：A 新增 ZCODE\_\* 环境开关须见于
  - .husky/pre-push：verify:pre-push + check-doc-sync --push
  - .agents/skills/check-doc-sync：回合收尾检查（含语义抽查）
  - Stop hook 本机接线在 .zcode/（gitignored，见 AGENTS.md 记录）
  - AGENTS.md 核心原则与命令表登记

## [3.14.1](https://github.com/whyiyhw/ZCode/compare/v3.14.0...v3.14.1) (2026-09-22)

### Features

- **cua:** auto-stage helper runtime from local official install on first run ([b287e15](https://github.com/whyiyhw/ZCode/commit/b287e155bae4e97b856807ca310eb2a21240e1ea))
  - packages/zcode-cua/runtime-staging.js (new ./runtime-staging export):
  - windowsCuaDevRuntime: userStagedRoot route between ZCODE_CUA_DEV_ROOT
  - node.ts: auto-stage retry wrapper (once per process, 5min failure
  - prepare-cua-helper.mjs refactored onto the shared staging module.
  - tests: 4 new runtime-staging cases (18/18 total); spec runtime

- **cua:** restore Computer Use with clean-room client and local-only helper staging ([0e1e50e](https://github.com/whyiyhw/ZCode/commit/0e1e50e323eb9f7283526320b05590e49d64a9f3))
  - broker.js: real named-pipe/UDS NDJSON client aligned with official
  - index.js: createComputerUseRuntime executor for the 14 model-facing
  - broker-server.js / frame-contract.js / pip-session-node.js: darwin
  - scripts/prepare-cua-helper.mjs: stages the official Helper runtime
  - electron-builder: ZCODE_CUA_BUNDLE_HELPER opt-in extraResources so
  - apps/zcode-cli/packages/zcode-cua-plugin: MIT wrapper (skill/docs/
  - tests: node --test suite (14 cases) covering protocol round-trip on
  - spec: packages/zcode-cua/spec/computer-use-restore.md (wire

### Bug Fixes

- **release:** bump version to 3.14.1 ([009cdbc](https://github.com/whyiyhw/ZCode/commit/009cdbc0e78b2ce7d6c3ccd1cbdeb485a3d8dc02))

### Documentation

- align docs with code and add documentation index ([2b3d4b6](https://github.com/whyiyhw/ZCode/commit/2b3d4b6cb17ac0c97badd87d9971093287304f82))
  - Create DOCUMENTATION.md as the layered doc index (instructions → spec
  - Create third-party/README.md (referenced by README and
  - README: drop a duplicated bootstrap paragraph, add the three missing
  - AGENTS.md: add a log-location section (prod/dev vs Preview roots,

## [3.14.0](https://github.com/whyiyhw/ZCode/compare/v3.14.0...v3.14.0) (2026-09-22)

### Features

- **desktop:** isolate data dir for Preview side-by-side installs ([55d0461](https://github.com/whyiyhw/ZCode/commit/55d0461d2ba3447b23f38a44ca479b6d3f4ddc45))

- **privacy:** telemetry master switch, model source-header policy, feedback slimming ([77a3f2f](https://github.com/whyiyhw/ZCode/commit/77a3f2fa52c57b1980e423ef7d6ed9ed8f97390d))
  - 遥测/ARMS 总闸默认关闭，端点环境变量显式清空基线（PRIVACY-AUDIT E2）
  - 模型请求源 header 策略收口：新增 model-source-header-policy，指纹类头
  - 反馈链路瘦身：compactLogArchive/feedbackService/feedbackSubmissionJob
  - installer 与 node-repl-host dist-types 同步本轮契约变化
  - armsRumShared 仅为 oxfmt 缩进重排，无行为变化

- update to v3.15.1 ([aac4755](https://github.com/whyiyhw/ZCode/commit/aac4755666d09fdcd70272fcf063c077a639015f))
  - Add UI plugins and inline Gen UI experiences
  - Update desktop, remote workspace, and agent capabilities
  - Expand built-in plugins and regression coverage

### Bug Fixes

- **build:** build shared dist explicitly in build:zcode for clean machines ([d2cfb83](https://github.com/whyiyhw/ZCode/commit/d2cfb83180e0502f748924a201d29837e6ffae88))

- **ci:** clean release asset names, drop builder-debug from release ([ee7484f](https://github.com/whyiyhw/ZCode/commit/ee7484ff02a6bae25f0e6bfe28a45aaab0f447a0))
  - bundle 步骤注入 ZCODE_ENV=production：产物后缀按它区分后端环境，缺省 test
  - release glob 的 _.yml/_.json 收紧为 latest\*.yml/latest.json，剔除

- **ci:** linux packaging toolchain and tag-build implicit publish ([b86d4d3](https://github.com/whyiyhw/ZCode/commit/b86d4d305df0a303d76374ae8a6528460916399b))
  - linux：目标含 rpm/pacman（fpm），ubuntu runner 缺 bsdtar（pacman .MTREE）
  - 所有平台：git tag 检出触发 electron-builder 隐式 publishing，构建完成后

- **ci:** release job needs explicit --repo; include deb/rpm/pacman artifacts ([6c76f41](https://github.com/whyiyhw/ZCode/commit/6c76f413234d4a84d3b98264408e1675a05e2385))
  - release job 无 checkout，gh 无法从本地 git 推断仓库（not a git repository），
  - 产物 glob 补齐 linux 的 deb/rpm/pkg.tar.zst，否则被静默排除在 Release 之外

- **services:** keep Preview settings file inside the isolated data root ([8e92b53](https://github.com/whyiyhw/ZCode/commit/8e92b538543e386f52b1a66abd957bb2ae2a3668))

- support Windows in build:zcode packaging ([e9c0f2e](https://github.com/whyiyhw/ZCode/commit/e9c0f2e240101dca2a7af6800335013f9fb59d7a))
  - Reuse spawn-command.mjs runCommand so pnpm resolves through the cmd
  - Invoke tar with a relative archive path (cwd = release dir) and -C
  - Document the verified Windows build pipeline in README.md and

### Documentation

- privacy audit and community edition guide ([90c68cc](https://github.com/whyiyhw/ZCode/commit/90c68cc2098df47da21af60f75b451b0ead572ac))
  - PRIVACY-AUDIT.md：全量隐私审计（数据流清单、开关收口矩阵、§9.5 产物断言
  - COMMUNITY-EDITION.md：社区版说明（保留/移除能力分层、构建与发行方式、

- **spec:** removal specs for rollout chain, auto-update, resource telemetry ([7a15950](https://github.com/whyiyhw/ZCode/commit/7a1595079113aac10a4d3eeb90ffa0b11857ef6e))
  - client-config-rollout-removal.md：灰度链移除；Context Prompt 静态注入 "0"
  - auto-update-removal.md：更新子系统整体移除；旧 settings 残留字段须被 zod strip
  - resource-telemetry-removal.md：资源遥测族删除清单；红线（CLI 60s 节拍保留、

### Refactorings

- **cli:** drop resource telemetry emission, keep 60s protocol beat ([8807980](https://github.com/whyiyhw/ZCode/commit/880798033b62da45b6e730cdd4335790275e24ee))
  - 删除 exec 侧 bash 资源采样与 tool-exec 资源上报链路
  - MCP telemetry 重写为纯进程注册表：保留 recordProcessStarted/crashed 与
  - resource-sampler 的 60s 节拍改为 ProtocolMaintenanceBeat：只承担
  - 删除 process-resource-sampler 与 5min 进程树采样

- **desktop,shared,ui:** remove rollout chain, auto-update subsystem, resource telemetry family ([ca7cae5](https://github.com/whyiyhw/ZCode/commit/ca7cae5171ed6fff4ce68d087cb51c92e4edbaae))
  - 删除 SingleFeatureRollout/ContextPromptRollout/ActionTraceRollout 与共享 fetcher，
  - Desktop Context Prompt 静态注入 ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV="0"
  - action trace 改静态 DISABLED 配置，ZCODE_RENDERER_ACTION_TRACE_ENABLED/
  - 删除 electron-updater 依赖、manifest provider、forceUpdate 门控、更新状态窗、
  - 旧 settings 残留字段由 zod strip（appSettingsSchema 已无对应键）
  - 删除 main/host/scheduler/renderer 全部采样聚合与上报链路、网络遥测中间件、
  - shared 契约同步收敛：channels/platform/protocol/validation/zcode-protocol
  - services 保留四个 onDynamic\* no-op 垫片（恒返回 Event.None）：旧版桌面端
  - 资源管理器窗口改用独立 app.getAppMetrics()，不依赖本族

## [3.15.0](https://github.com/whyiyhw/ZCode/compare/v3.14.3...v3.15.0) (2026-09-27)

### Features

- **shared,ui:** 回合导航目录服务端化 + loadAllOlder 全量常驻退役（B2 阶段 1） ([b90325a](https://github.com/whyiyhw/ZCode/commit/b90325add6d7ab88f052d786d50ced4a62cfca8e))
  - 新命令 v4/conversation/turnDirectory（五层：schema/纯推导 → CLI publisher
  - store 新增 turnNavigatorDirectory / directoryHasPluginReference /
  - ConversationTurnNavigator 数据源切到服务端目录（本地化兜底文案留在
  - loadAllOlder 及全量常驻入口彻底删除（2026-09-24 白屏事故 n=5 万的

- **shared,ui:** 行窗口淘汰 + aroundRowId 区间跳转（B2 阶段 2） ([8a73f54](https://github.com/whyiyhw/ZCode/commit/8a73f5437a705027d1b991f8659467a454c205f6))
  - 协议：rowsRange params 增加 aroundRowId（跳转拉取：以目标为中心向前的
  - store 窗口淘汰（K=2000，决策点 2）：流式追加/loadOlder 合并顶过上限时
  - store 跳转：jumpToRow（aroundRowId 区间整体替换窗口 ≤200 行，epoch/
  - UI：目录窗口外条目点击 → jumpToRow 后由 pendingJump 布局效应在新
  - 已知取舍（spec 成文）：跳转时在途 delta 内容随旧窗口丢弃（seq 水位

- update v3.14.3 ([29628c9](https://github.com/whyiyhw/ZCode/commit/29628c9acdb81b703bbd4080c207a0e7ce5e276e))
  - The concurrency limit of a running workflow can now be adjusted directly, without stopping the task.
  - Optimized the reuse logic when modifying and restarting workflows.
  - Improved the real-time status display for large workflows.
  - Improved the efficiency of workflow script submission and modification, reducing token consumption.
  - Fixed an issue where workflows could cause the interface to crash in some cases.
  - Fixed an issue where buttons on workflow cards were sometimes pushed out of the interface.
  - Fixed an issue where the workflow tool took up too much context.

### Bug Fixes

- **cli:** publisher 目录命令的 import type 误用与 aroundRowId 闭包 narrowing ([e81ce4e](https://github.com/whyiyhw/ZCode/commit/e81ce4e030db4f418b2bec695cc6dfe1600adfbf))

- **desktop,shared:** 渲染进程崩溃自愈与 delta 帧批量 apply ([97aac38](https://github.com/whyiyhw/ZCode/commit/97aac38966c3b3ae9a647b119ed16b700a6c39c0))
  - rendererCrashRecoveryPolicy（纯决策）+ rendererCrashRecoveryMonitor（接线）：
  - give-up 经 markForceQuit + app.quit() 退出（绕过 quit 确认弹窗挂死）
  - 恢复动作 setImmediate 推迟：render-process-gone 回调内同步 reload() 撞
  - 激活死代码 registerCrashEventMonitor（含 webContents 销毁防护）
  - applyConversationDeltasBatch：帧内一次拷贝 + 有序二分定位（线性兜底），
  - conversationProjectionStore delta 帧路径切换

- **desktop:** mac 打包未启用签名时改用 ad-hoc 封签，避免 Release 包被 Gatekeeper 判「已损坏」 ([5314d41](https://github.com/whyiyhw/ZCode/commit/5314d41b11281f7f4dfc1a1f6210620b04b6e416))

- **scripts:** third-party 生成脚本逐项目 spawn 防Windows EMFILE + 正规重生成 inventory ([90f4dc7](https://github.com/whyiyhw/ZCode/commit/90f4dc70e3adcf122c01d81bc83294443bb12c75))
  - npm-overrides.json 删 7 个已不在生产图的 stale 条目
  - inventory.json / THIRD-PARTY-NOTICES.md 由脚本正规重生成
  - licenses.mjs check 全过（1721 实装包 + 14 项待补齐）

- **services,ui:** 目录命令 trusted carrier 的 facade 注册 + active 解析 -1 过滤落到 fallback ([9a33f5b](https://github.com/whyiyhw/ZCode/commit/9a33f5b34be66a85a37d8dee03e44ebbfeeac8f9))

- **ui,services:** 目录快照的失效面与兜底闭环（实施评审 4 项 Major） ([fb2d3f8](https://github.com/whyiyhw/ZCode/commit/fb2d3f87c576622098b815d447da9dd405412a61))
  - isRunning 熄灭：turnHeader upsert（轮次终态迁移）纳入目录失效面——快照型
  - 在途失效重查闭环：refreshTurnNavigatorDirectory 挂 directoryQueryPending，
  - 兜底口径：目录未拉取（窄屏不触发查询 / 3 连败 terminal / 旧 CLI 无此命令）
  - clientMode 断链：host 层照 rowsRange 补 readTrustedZCodeAgentV4Connection
  - minor：active 解析跳过窗口外 -1 条目、注释命令名修正、benchmark 桩补

- **ui:** 攻击实测 P1/P2/B1——rewind 水位重锚、vintage 倒退防护、按钮收回 ([6300a54](https://github.com/whyiyhw/ZCode/commit/6300a547fba4dfa7160322b3d78722bf61edd5e9))
  - P1（Critical）：row.removed（edit/retry 截断）重锚实时尾部高水位到截断后
  - P2（Major）：jumpToRow 的 atSeq < current.seq 视为陈旧读整体丢弃——
  - B1：脱离解除时按当前 following 收回回底按钮（置位有 effect 夺回显示，

- **ui:** 目录闭环重查失败挂有界退避重试（攻击实测 F1） ([5ae3400](https://github.com/whyiyhw/ZCode/commit/5ae340050bc22efbfd81a3f6d82ab3457656b61b))

- **ui:** 跳转水位/脱离不变量/满窗死路等六项评审修复（2 Critical + 4 Major） ([7c19dba](https://github.com/whyiyhw/ZCode/commit/7c19dbaccabe4197946e1511df17c2ccabfeaeec))
  - C1a seq 水位：跳转提交 seq = max(本地, result.atSeq)——保留落后水位会让
  - C1b 脱离态 append 丢弃：跳转历史区间后实时 append 不拼入窗口（窗口连续
  - M1 pendingJump 生命周期：失败即清 + 换会话清零 + 成功 2s 超时兜底，
  - M2 满窗死路：预裁方案否决（会在窗口中间挖洞破坏连续性），改迟滞淘汰——
  - M3 脱离态回底可见：窗口底不是实时底，回底按钮脱离态一律显示（唯一
  - M2-b 跳转一次性抑制首轮自动补拉（mid-turn 开窗不在落点链式拉历史）
  - minor：snapshot 真重置高水位（rewind 兼容）、benchmark 上限常量化、

- **ui:** 验证员二轮——闭包冻结与会话隔离收口 ([d866738](https://github.com/whyiyhw/ZCode/commit/d86673868ea0f5add7e8fd96f1df38f3c7b8d56f))
  - commitFollowing deps 补 detachedFromLiveTail：[] 闭包冻结在首渲染
  - handleBackToBottom deps 补 detachedFromLiveTail/onJumpToTail（同因
  - pendingJumpQueryRef 换会话清零：独立 sessionKey effect（rowId 跨会话
  - scrollToQuery deps 补 onJumpToRow（跨 lease 调旧会话 store 的存量缺口

### Chores

- **release:** Release 说明同步 ad-hoc 封签后的 mac 首开口径 ([0fd8e9f](https://github.com/whyiyhw/ZCode/commit/0fd8e9f0c1d40075437a35e5bffe52ab4e6aff8e))

- 同步 third-party inventory 输入哈希（upstream merge 后 15 项漂移） ([e62011e](https://github.com/whyiyhw/ZCode/commit/e62011ef045d9522540d1c5f41b67c12312d39ed))
  - 3 个 upstream 许可文本——上游合并已移除）。全量 2863 项输入 +

### Documentation

- 崩溃恢复方案 §3.3 B2 已实施标注 + §5 验收终态数字补齐 ([7f7ace9](https://github.com/whyiyhw/ZCode/commit/7f7ace9de0d82161c62aab434b05628ab8f45d0f)), closes [#3]() [#4]()
  - §3.3 从「方向，不随本轮实施」改为「✅ 已实施」，指向独立 B2 方案文档，

- 方案 §8 阶段 2/3 实施记录补齐（含全部评审发现与真机结果） ([998bb1e](https://github.com/whyiyhw/ZCode/commit/998bb1e2e116aa1015c49cc27a644a732d131c31))

- 补记帧负载基准全量档复核数字（apply p95=0.33ms / 总 p95=102ms） ([50e664d](https://github.com/whyiyhw/ZCode/commit/50e664dc98be4d8c7750c5909e9f5dfa1cc6a025))

### Refactorings

- **cli:** trim conversation telemetry facts to turn-only production ([49efe73](https://github.com/whyiyhw/ZCode/commit/49efe734ac51ed798faa8000829de3a0fd7a2b28))

- **shared,services:** remove leftover forceUpdate config chain ([82c9d1e](https://github.com/whyiyhw/ZCode/commit/82c9d1e224b4868e3df7eb782c31344fdf728c79))
  - shared：forceUpdate.ts（semver 比较/resolveForceUpdateRequirement）、
  - services：getForceUpdateConfig 接口方法、service wiring、

- 清理全部 62 条 oxlint 告警并启用 lint --deny-warnings ([9b1a99f](https://github.com/whyiyhw/ZCode/commit/9b1a99f01e8fa4ec4e55aa940239c39675301701))
