# Changelog

## [3.15.0](https://github.com/whyiyhw/ZCode/compare/v3.14.3...v3.15.0) (2026-09-27)

### Features

* **shared,ui:** 回合导航目录服务端化 + loadAllOlder 全量常驻退役（B2 阶段 1） ([b90325a](https://github.com/whyiyhw/ZCode/commit/b90325add6d7ab88f052d786d50ced4a62cfca8e))
  * 新命令 v4/conversation/turnDirectory（五层：schema/纯推导 → CLI publisher
  * store 新增 turnNavigatorDirectory / directoryHasPluginReference /
  * ConversationTurnNavigator 数据源切到服务端目录（本地化兜底文案留在
  * loadAllOlder 及全量常驻入口彻底删除（2026-09-24 白屏事故 n=5 万的

* **shared,ui:** 行窗口淘汰 + aroundRowId 区间跳转（B2 阶段 2） ([8a73f54](https://github.com/whyiyhw/ZCode/commit/8a73f5437a705027d1b991f8659467a454c205f6))
  * 协议：rowsRange params 增加 aroundRowId（跳转拉取：以目标为中心向前的
  * store 窗口淘汰（K=2000，决策点 2）：流式追加/loadOlder 合并顶过上限时
  * store 跳转：jumpToRow（aroundRowId 区间整体替换窗口 ≤200 行，epoch/
  * UI：目录窗口外条目点击 → jumpToRow 后由 pendingJump 布局效应在新
  * 已知取舍（spec 成文）：跳转时在途 delta 内容随旧窗口丢弃（seq 水位

* update v3.14.3 ([29628c9](https://github.com/whyiyhw/ZCode/commit/29628c9acdb81b703bbd4080c207a0e7ce5e276e))
  * The concurrency limit of a running workflow can now be adjusted directly, without stopping the task.
  * Optimized the reuse logic when modifying and restarting workflows.
  * Improved the real-time status display for large workflows.
  * Improved the efficiency of workflow script submission and modification, reducing token consumption.
  * Fixed an issue where workflows could cause the interface to crash in some cases.
  * Fixed an issue where buttons on workflow cards were sometimes pushed out of the interface.
  * Fixed an issue where the workflow tool took up too much context.


### Bug Fixes

* **cli:** publisher 目录命令的 import type 误用与 aroundRowId 闭包 narrowing ([e81ce4e](https://github.com/whyiyhw/ZCode/commit/e81ce4e030db4f418b2bec695cc6dfe1600adfbf))

* **desktop,shared:** 渲染进程崩溃自愈与 delta 帧批量 apply ([97aac38](https://github.com/whyiyhw/ZCode/commit/97aac38966c3b3ae9a647b119ed16b700a6c39c0))
  * rendererCrashRecoveryPolicy（纯决策）+ rendererCrashRecoveryMonitor（接线）：
  * give-up 经 markForceQuit + app.quit() 退出（绕过 quit 确认弹窗挂死）
  * 恢复动作 setImmediate 推迟：render-process-gone 回调内同步 reload() 撞
  * 激活死代码 registerCrashEventMonitor（含 webContents 销毁防护）
  * applyConversationDeltasBatch：帧内一次拷贝 + 有序二分定位（线性兜底），
  * conversationProjectionStore delta 帧路径切换

* **desktop:** mac 打包未启用签名时改用 ad-hoc 封签，避免 Release 包被 Gatekeeper 判「已损坏」 ([5314d41](https://github.com/whyiyhw/ZCode/commit/5314d41b11281f7f4dfc1a1f6210620b04b6e416))

* **scripts:** third-party 生成脚本逐项目 spawn 防Windows EMFILE + 正规重生成 inventory ([90f4dc7](https://github.com/whyiyhw/ZCode/commit/90f4dc70e3adcf122c01d81bc83294443bb12c75))
  * npm-overrides.json 删 7 个已不在生产图的 stale 条目
  * inventory.json / THIRD-PARTY-NOTICES.md 由脚本正规重生成
  * licenses.mjs check 全过（1721 实装包 + 14 项待补齐）

* **services,ui:** 目录命令 trusted carrier 的 facade 注册 + active 解析 -1 过滤落到 fallback ([9a33f5b](https://github.com/whyiyhw/ZCode/commit/9a33f5b34be66a85a37d8dee03e44ebbfeeac8f9))

* **ui,services:** 目录快照的失效面与兜底闭环（实施评审 4 项 Major） ([fb2d3f8](https://github.com/whyiyhw/ZCode/commit/fb2d3f87c576622098b815d447da9dd405412a61))
  * isRunning 熄灭：turnHeader upsert（轮次终态迁移）纳入目录失效面——快照型
  * 在途失效重查闭环：refreshTurnNavigatorDirectory 挂 directoryQueryPending，
  * 兜底口径：目录未拉取（窄屏不触发查询 / 3 连败 terminal / 旧 CLI 无此命令）
  * clientMode 断链：host 层照 rowsRange 补 readTrustedZCodeAgentV4Connection
  * minor：active 解析跳过窗口外 -1 条目、注释命令名修正、benchmark 桩补

* **ui:** 攻击实测 P1/P2/B1——rewind 水位重锚、vintage 倒退防护、按钮收回 ([6300a54](https://github.com/whyiyhw/ZCode/commit/6300a547fba4dfa7160322b3d78722bf61edd5e9))
  * P1（Critical）：row.removed（edit/retry 截断）重锚实时尾部高水位到截断后
  * P2（Major）：jumpToRow 的 atSeq < current.seq 视为陈旧读整体丢弃——
  * B1：脱离解除时按当前 following 收回回底按钮（置位有 effect 夺回显示，

* **ui:** 目录闭环重查失败挂有界退避重试（攻击实测 F1） ([5ae3400](https://github.com/whyiyhw/ZCode/commit/5ae340050bc22efbfd81a3f6d82ab3457656b61b))

* **ui:** 跳转水位/脱离不变量/满窗死路等六项评审修复（2 Critical + 4 Major） ([7c19dba](https://github.com/whyiyhw/ZCode/commit/7c19dbaccabe4197946e1511df17c2ccabfeaeec))
  * C1a seq 水位：跳转提交 seq = max(本地, result.atSeq)——保留落后水位会让
  * C1b 脱离态 append 丢弃：跳转历史区间后实时 append 不拼入窗口（窗口连续
  * M1 pendingJump 生命周期：失败即清 + 换会话清零 + 成功 2s 超时兜底，
  * M2 满窗死路：预裁方案否决（会在窗口中间挖洞破坏连续性），改迟滞淘汰——
  * M3 脱离态回底可见：窗口底不是实时底，回底按钮脱离态一律显示（唯一
  * M2-b 跳转一次性抑制首轮自动补拉（mid-turn 开窗不在落点链式拉历史）
  * minor：snapshot 真重置高水位（rewind 兼容）、benchmark 上限常量化、

* **ui:** 验证员二轮——闭包冻结与会话隔离收口 ([d866738](https://github.com/whyiyhw/ZCode/commit/d86673868ea0f5add7e8fd96f1df38f3c7b8d56f))
  * commitFollowing deps 补 detachedFromLiveTail：[] 闭包冻结在首渲染
  * handleBackToBottom deps 补 detachedFromLiveTail/onJumpToTail（同因
  * pendingJumpQueryRef 换会话清零：独立 sessionKey effect（rowId 跨会话
  * scrollToQuery deps 补 onJumpToRow（跨 lease 调旧会话 store 的存量缺口


### Chores

* **release:** Release 说明同步 ad-hoc 封签后的 mac 首开口径 ([0fd8e9f](https://github.com/whyiyhw/ZCode/commit/0fd8e9f0c1d40075437a35e5bffe52ab4e6aff8e))

* 同步 third-party inventory 输入哈希（upstream merge 后 15 项漂移） ([e62011e](https://github.com/whyiyhw/ZCode/commit/e62011ef045d9522540d1c5f41b67c12312d39ed))
  * 3 个 upstream 许可文本——上游合并已移除）。全量 2863 项输入 +


### Documentation

* 崩溃恢复方案 §3.3 B2 已实施标注 + §5 验收终态数字补齐 ([7f7ace9](https://github.com/whyiyhw/ZCode/commit/7f7ace9de0d82161c62aab434b05628ab8f45d0f)), closes [#3]() [#4]()
  * §3.3 从「方向，不随本轮实施」改为「✅ 已实施」，指向独立 B2 方案文档，

* 方案 §8 阶段 2/3 实施记录补齐（含全部评审发现与真机结果） ([998bb1e](https://github.com/whyiyhw/ZCode/commit/998bb1e2e116aa1015c49cc27a644a732d131c31))

* 补记帧负载基准全量档复核数字（apply p95=0.33ms / 总 p95=102ms） ([50e664d](https://github.com/whyiyhw/ZCode/commit/50e664dc98be4d8c7750c5909e9f5dfa1cc6a025))


### Refactorings

* **cli:** trim conversation telemetry facts to turn-only production ([49efe73](https://github.com/whyiyhw/ZCode/commit/49efe734ac51ed798faa8000829de3a0fd7a2b28))

* **shared,services:** remove leftover forceUpdate config chain ([82c9d1e](https://github.com/whyiyhw/ZCode/commit/82c9d1e224b4868e3df7eb782c31344fdf728c79))
  * shared：forceUpdate.ts（semver 比较/resolveForceUpdateRequirement）、
  * services：getForceUpdateConfig 接口方法、service wiring、

* 清理全部 62 条 oxlint 告警并启用 lint --deny-warnings ([9b1a99f](https://github.com/whyiyhw/ZCode/commit/9b1a99f01e8fa4ec4e55aa940239c39675301701))
