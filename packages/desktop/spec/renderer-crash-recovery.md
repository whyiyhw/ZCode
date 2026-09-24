# Spec：主窗口渲染进程崩溃自愈

> 2026-09-24 白屏事故（渲染进程死亡后窗口白屏挂死 33 分钟、主进程零崩溃日志）复盘产物。
> 方案：`docs/plans/renderer-crash-recovery-and-long-session-design.md` 批次 A（当日已拍板实施）。

## 行为定义

主窗口渲染进程死亡（`render-process-gone`）后，主进程按策略自动 `webContents.reload()` 恢复；
恢复依赖 `desktopWindowLifecycle.ts` dom-ready 处理器既有的 host MessagePort 重挂路径
（"renderer reloaded, reattached to existing host"），**存活 host、CLI 子进程与运行中会话不受影响**。

**恢复动作必须推迟到事件循环下一轮**（`setImmediate`）执行：在 `render-process-gone`
回调内同步调用 `webContents.reload()` 会撞 Chromium 的 NOTREACHED "Observers can only
be added once!"（electron 上游 bug，issue「Calling reload() immediately after
forcefullyCrashRenderer」/ 修复 PR #48715；本机 Electron 41 于 2026-09-24 真机复现，
主进程 exit 3）——恢复动作自己把主进程带走，比不恢复更糟。give-up 的退出同理推迟。
该约束已由 monitor 单测与真机矩阵背书，重构时不得回退为同步调用。

## 所有权与接口

| 项                       | 归属                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| 决策逻辑                 | `packages/desktop/src/main/rendererCrashRecoveryPolicy.ts`（纯函数，无 electron 依赖，时间注入） |
| 每窗口策略实例与监听注册 | `desktopWindowLifecycle.ts` `createWindow`（主窗口路径，随窗口创建实例化，多窗口天然隔离）       |
| 退出守卫输入             | index.ts 注入 `isAppQuitting()`（= `forceQuitRef.current \|\| explicitQuitRef.current`）         |
| 事件日志与 dump 归档     | `desktopCrashCapture.ts` `registerCrashEventMonitor`（`appCrashCaptureBootstrap.ts` 激活）       |

决策接口：`decide({ reason, appQuitting, windowDestroyed, now }) → ignore{because} | reload{attempt} | backoff-reload{delayMs,attempt} | give-up`；接线（定时器/看门狗/give-up 回调）在 `rendererCrashRecoveryMonitor.ts` 的 `attachRendererCrashRecoveryMonitor`。

## reason 归类全集（Electron 41 `RenderProcessGoneReason`，8 值）

| reason                                                                        | 动作                                                                          | 依据                                                                                         |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `clean-exit`                                                                  | ignore                                                                        | 受控退出                                                                                     |
| `killed`                                                                      | reload（非退出中）                                                            | 本应用自身无以 killed 终止 renderer 的路径；现实中 = 杀软/任务管理器误杀（无人值守白屏场景） |
| `oom` / `crashed` / `abnormal-exit` / `integrity-failure` / `memory-eviction` | reload                                                                        | 崩溃类；memory-eviction 对应长会话内存无界期间 Windows 的驱逐                                |
| `launch-failed`                                                               | 风暴窗口内已有自动 reload → backoff 5s 后 reload 并计风暴；否则 ignore + warn | oom→reload→内存未释放→起不来是高概率序列，直接 ignore 会永久白屏                             |
| 未归类值（未来 Electron 新枚举）                                              | reload（兜底）                                                                | 崩溃类新值比良性新值可能；风暴预算封顶误恢复代价。**新增枚举值必须回填本表**                 |

## 风暴预算与去重

- **计数基准 = 策略自己决出的自动 reload（含 backoff-reload）次数**，不数 `render-process-gone` 事件——该事件存在同窗重复投递（`browserGuestManager.ts:3006/4082` 记录过），按事件计数会让单次物理崩溃烧多份配额。
- 上限：5 分钟滚动窗口（`CRASH_STORM_WINDOW_MS`，过期判定不含等号）内 3 次（`MAX_AUTO_RELOADS`）；窗口外的旧 reload 滚动过期。
- **重复投递去重（300ms，含等号）**：同 reason 事件在刚决出恢复决策（reload / backoff / give-up）后 300ms 内到达视为重复，ignore。重复投递与事件本体相邻到达；新进程「加载期真实死亡」最快也要进程 spawn + bundle 解析（远超 300ms）。窗口刻意取窄：误判成真崩溃只是多一次 reload + 烧一格配额（风暴预算封顶），误判成重复则是白屏——代价不对称。**看门狗兜底（时间戳锚）**：吞掉疑似重复后约 4 秒（`RECOVERY_DOM_READY_WATCHDOG_MS`）且**吞掉时刻之后无新 dom-ready** 则重新决策，把「加载期真死亡 / 快恢复后二次真崩被误吞」补发成 reload。锚必须是吞没时刻之后的 dom-ready（攻击评审 P0 修正：布尔锚会被吞掉之前的旧 dom-ready 骗过，死 renderer 永无人补救）。give-up 也记录决策水位：异 reason 后续事件保持 give-up（幂等）；风暴窗滚动过期后配额重置。
- **backoff 恢复感知与定时器互斥**：backoff 定时器到期时若**决策之后**出现过 dom-ready（如用户手动刷新恢复），不再强制 reload，避免冲掉未提交草稿；挂起的恢复定时器（backoff / 看门狗）每窗口同时至多一个，新恢复决策作废旧定时器，防止陈旧 backoff 在新一轮恢复进行中多插一次 reload。**吞没事件不作废挂起中的恢复**——已有 backoff/看门狗在途时，重复投递只吞不另起看门狗，否则同一物理尝试会烧两格预算并把 5s 恢复拖成「4s 看门狗 + 重决策」。
- **give-up（第 4 次）**：经 index.ts 注入的 `onCrashRecoveryGiveUp` 执行 `markForceQuit("renderer-recovery:give-up") + app.quit()`，全平台统一退出。**必须走 markForceQuit**：直接 destroy → win32 `window-all-closed` → `app.quit()` 会撞上 before-quit 的退出确认弹窗（生产版 + 会话运行中必弹、无父窗口、默认取消），无人值守场景被模态框挂死；markForceQuit 让 before-quit 跳过确认。这是 close-to-tray 语义在崩溃风暴下的显式例外（2026-09-24 拍板；退出链为实施评审修正）。
- 慢速循环（间隔 >5 分钟）**不由本机制根治**——由批次 B（每帧成本与内存）根治，风暴预算只防快循环。

## 可观测与边界说明

- ignore 动作携带 `because`（app-quitting / window-destroyed / clean-exit / cold-launch-failed / duplicate-delivery）：cold-launch-failed 打策略层 warn（reason 表的「ignore + warn」由此落地），duplicate-delivery 打 info（含看门狗提示），其余静默。
- 退出确认弹窗的等待期（darwin Cmd+Q / win32 last-window-close 的 confirm 模态期间）`isAppQuitting` 尚为 false——此窗口期内崩溃会被多 reload 一次，用户确认退出后 renderer 随窗口正常销毁，无害；win32 下恢复期 dom-ready 的 show+focus 可能把窗口弹到弹窗前，可接受。

## 显式声明的行为

- **隐藏态恢复示回**：关到托盘后隐藏状态崩溃自愈时，win32 下 dom-ready 的既有 `win.show(); win.focus()`（`desktopWindowLifecycle.ts:117-120`）会让窗口主动弹出并抢回焦点。这是设计选择（崩溃恢复应让用户看见），不得在重构中静默移除。
- **卡死（unresponsive）不自愈**：进程活着但主线程永久卡死只记日志（`registerCrashEventMonitor`）。`forcefullyCrashRenderer` 降级方案因误杀风险被否（2026-09-24 拍板），B2 落地后按残余形态再议。
- 恢复动作日志 info（`[renderer-recovery] ... reason=X, auto-reload N/3`）；give-up 用 error。

## 崩溃事件取证（registerCrashEventMonitor 激活）

- app 级 `render-process-gone` / `child-process-gone` / `unresponsive` 落日志，dump 双次延迟归档；远端上报维持删除态。
- **销毁防护**：handler 取 `webContents.id/getType/getURL` 前必须先 `isDestroyed()` 防护（退出收尾期事件可能在 webContents 销毁后送达——index.ts 关窗收尾曾因此抛 "Object has been destroyed"）。

## 验收场景

1. reason 全集分类、退出中/已销毁忽略、按 reload 计风暴、launch-failed backoff 分支、窗口过期重置、重复投递去重（含 300ms 与风暴窗的压线边界）——单测 `packages/desktop/test/renderer-crash-recovery-policy.test.ts`（`npx tsx --test`）全绿；接线层交错场景（快恢复后二次真崩的看门狗补发、真重复空转、陈旧 backoff 作废、backoff 恢复感知、give-up 注入回调）——`packages/desktop/test/renderer-crash-recovery-monitor.test.ts` 全绿。
2. 手工：`process.crash()` 后窗口自动恢复、运行中会话连续（日志有 reattached 无 killing previous host）；oom 用 renderer 分配循环模拟、killed 用任务管理器杀 renderer、launch-failed 用 oom→reload 链模拟；第 4 次崩溃直接退出应用并留 error；正常退出/关到托盘无伪恢复日志；退出全程无 "Object has been destroyed"。
