# 方案：渲染进程崩溃自愈 + 长会话渲染端 O(n) 拖死修复

> 2026-09-24。对应当日 ZCode Preview 白屏事故的调查结论（会话 `sess_f38887c7`，4 小时约 20 万条事件后渲染进程死亡，窗口白屏挂死 33 分钟）。
> 范围：**一个事故暴露的两个缺陷**，拆成两个独立批次，每批次动手前各自需要用户批准——
> 批次 A（崩溃自愈）：崩了能自己起来，消掉「白屏挂死」这类事故；
> 批次 B（渲染端长会话修复）：把每帧成本从 O(k·n) 压到 O(n+k) 并用**事故级负载实测**验证；若实测仍超帧预算，B2（行窗口上限+目录分离）为强制下一步。B1 详细到可直接实施，B2 只给方向与立项判据。
>
> v2（2026-09-24 双子代理评审后修正）：设计工程师评审（4 Major / 2 Minor，引用抽查 11/12 属实）与红队评审（1 Goal-Killer / 3 Major，引用抽查 14/14 属实）的修正已并入：A1 reason 全集与按 reload 计数、A3 销毁防护、B1 引用恒等性、测试跑法改 tsx、验收加事故级端到端指标与 reason 覆盖矩阵；新增决策点 5（卡死自愈）与 6（B2 最小子集是否提前）。
>
> v3（2026-09-24 实施评审后修正）：两位静态评审独立撞出 give-up 的 destroy→before-quit 确认弹窗挂死（改为注入回调 markForceQuit + app.quit()）；2s 去重窗可吞加载期真崩溃（改 300ms + dom-ready 看门狗）；另修 backoff 恢复感知、冷 launch-failed 策略层 warn、coalesce 断言喂 batch、性能基准、压线边界用例。**性能基准实测否决了「复用服务端 mutable accumulator」的第一版 batch**（Map.set 常数在小 k 帧下反而更慢），改为帧内一次拷贝 + 有序二分定位（20k 行 × 8 delta：3.27ms → 0.58ms）。行为口径以两份 spec 为准。
>
> v4（2026-09-24 攻击实测后修正）：P0——看门狗布尔锚会被「吞掉之前的旧 dom-ready」骗过，快恢复后 300ms 内二次真崩仍白屏挂死（改为吞没时刻时间戳锚）；B1——陈旧 backoff 定时器可多插一次 reload（改为新恢复决策作废旧定时器）。新增 monitor 接线单测（stub webContents + mock 时钟）复现 S1/S6 作回归。batch 经 6112 个对抗序列（含乱序窗口）零分歧、性能三档 11.6×–52.6× 占优后放行。
>
> v5（2026-09-24 真机手工矩阵）：crashed（CDP Page.crash）/ oom（分配循环）/ 外部强杀（TerminateProcess→crashed）三类均 3–4 秒自动恢复且 reattached to existing host（会话连续）；第 4 崩 give-up → markForceQuit + 干净退出（exit 0，未被 quit 确认弹窗挂住）；全程零 "Object has been destroyed"、dump 归档生效。**真机抓到并修复最后一个坑**：render-process-gone 回调内同步 reload() 撞 Chromium NOTREACHED（electron 上游 bug，PR #48715），主进程 exit 3——恢复动作改为 setImmediate 推迟后矩阵全绿。launch-failed 链与 killed 归类由单测覆盖（真机无法稳定构造）。
>
> v6（2026-09-24 B1 事故级实测完成，B2 立项判据**触发**）：新增 `packages/ui/test/v4-frame-load-benchmark.test.ts`（真实 ConversationProjectionStore + SessionDataLayer 接线 + 真实下游 memo 计算，5 万行常驻 + 30ms 节奏流式注入）。结果：**apply+notify p95=0.51ms**（B1 验收线 ≤1ms 达标，批处理把逐条不可变 apply 的事故根因消干净）；**每帧总成本 p95=122.03ms**（p50=76ms，其中 memo 重算占 75.87ms p50 / 121.24ms p95）——超 30ms 帧预算 4 倍，超支全部来自下游 O(n) memo 重算（renderUnits / workflowGraph）。堆 max 184MB 有界。全量档复核（`ZCODE_BENCH_FRAMES=20000`，逻辑 10 分钟、墙钟 24 分钟）：apply p95=0.33ms、每帧总 p95=102.39ms（memo 占 102.17ms）、p99=129ms、max=196ms、堆 max 309MB——与默认档一致，结论稳健。**结论：B2（行窗口上限 + 回合导航目录分离 + memo 增量化）按决策点 3 的口径正式立项**，本基准即其验收基线（B2 落地后同规模 p95 须 ≤ 30ms）。

## 1. 要解决的问题

事故复现链（已核实，证据在源码 + `~/.zcode-preview/.zcode/v2/logs/2026-09-24.log`）：

1. **渲染进程被超长会话拖死**：`sess_f38887c7` 流式追加期间（30ms/逻辑帧），渲染端每个 delta 做一次 O(n) 数组拷贝 + O(n) findIndex（`packages/shared/src/zcode-protocol-v4/apply.ts:73-118`，注释自认「长会话退化为 O(N²)」，mutable 优化只给了服务端）；`rows.window` 客户端只增不减，宽屏打开会话还自动 `loadAllOlder` 全量常驻（`packages/ui/src/v4/conversationProjectionStore.ts:1023-1170`）；每帧 setState 同步通知（`:375-378`）触发 `buildConversationTurnRenderUnits` 等一组 O(n) memo 全量重算。渲染吞吐跟不上帧率后，`@tanstack/react-virtual` 内部 `useReducer` 的更新队列无界堆积（崩溃转储栈停在该处），进程死亡。重启时 crash-capture 注明 dump 无 v8 oom 标注——具体原生死点无直接注脚，但「更新队列风暴 + 每帧 O(n)」是栈与代码路径共同支撑的结论。
2. **崩了不恢复**：主窗口的 `render-process-gone` 监听只复位快捷键录制态（`packages/desktop/src/main/index.ts:1486-1488`），全仓库没有任何 reload/重建路径；app 级崩溃监听 `registerCrashEventMonitor`（`desktopCrashCapture.ts:411`）是死代码（唯一调用点 `appCrashCaptureBootstrap.ts:7` 只调了 `initializeCrashCapture`）——所以当天日志里连一条崩溃记录都没有。Electron 语义下 renderer 死后 BrowserWindow 仍存活（白屏），close-to-tray 又不让窗口销毁，只能手动重启。

评审补充确认的两个残余形态（v2）：

3. **「活着但卡死」不在批次 A 射程内**：JS 主线程被队列风暴饱和时不发 `render-process-gone`，全仓唯一 unresponsive 处理是日志（`desktopCrashCapture.ts:448-454`）。B1 落地后死亡概率下降、卡死形态占比上升。是否补卡死自愈见决策点 5。
4. **慢速自愈循环**：间隔 >5 分钟的反复拖死永不触达 give-up，且每次 reload 后宽屏自动 `loadAllOlder` 重新全量常驻。该形态只能由批次 B 根治——A 的风暴预算只防快循环，这是显式前提而非缺陷。

## 2. 现状与约束（已核实的链路事实）

```
事件流（桌面 continuous 链路）：
CLI 投影 ──v4 wire 帧──▶ main(zcodeAgentService:1977) ──MessagePort──▶ renderer
  ▶ agentConversationTransport.ts:495（wire 解码，有界 32 并发/32MiB）
  ▶ sessionDataLayer.ts:64（按 topic 扇入）
  ▶ conversationProjectionStore.ts:636 applyFrame
       :710 applyConversationDeltas   ← 逐 delta 不可变 apply（O(n)/条）
       :375 setState → 同步逐 listener 通知（无批处理）
  ▶ useConversationProjection(useSyncExternalStore) → SessionPane O(n) memo 群
  ▶ @tanstack/react-virtual（崩溃栈的 useReducer 在此）

服务端处处有界（非本次根因）：snapshot 只带尾 60 行、事件日志 retention 2000、
订户缓冲 500 ops/1MiB、flush 30ms（core.ts:64-100）。
```

崩溃恢复侧已有的地基（**全部是现成的，只差触发**）：

- `desktopWindowLifecycle.ts:111-156`：dom-ready 处理器对 renderer reload 的场景已支持——给存活 host 补挂一条新 RPC MessagePort（"renderer reloaded, reattached to existing host"），运行中会话不丢；注释明确 host/CLI 生命周期属于窗口而非 renderer 加载周期。reattach 失败的 fallback（`:150-155`）只在 host 已死时触发，彼时会话本已丢失，不击穿承诺。
- `primaryWindowCoordinator.ts:34-58`：用户触发（托盘/dock/activate）时发现 `isCrashed()` 窗口会 destroy 后重建——但崩溃当时无入口调用它。
- `desktopCrashCapture.ts:411-457`：`registerCrashEventMonitor`（render/child-process-gone 日志 + dump 延迟归档 + unresponsive 日志）完整实现，从未被调用。

约束与红线：

- **reload 优先于 destroy+recreate**：destroy 主窗口会走 closed 清理链，host 连带 CLI 一起死，运行中会话直接消失（dom-ready 注释原话，这是「会话身份易失」病根）。自动恢复必须走 reload，复用既有重挂路径。
- **不能误恢复**：退出应用（`forceQuitRef`/`explicitQuitRef`，index.ts:659-671，退出各路径同步置位先于窗口关闭）与受控终止时 renderer 死亡是预期行为，自动 reload 会干扰退出流程。
- **崩溃风暴兜底**：renderer 起来即崩的循环里无脑 reload 会烧 CPU；必须有次数上限。`render-process-gone` 存在同窗重复投递的社区报告，本仓 `browserGuestManager.ts:3006/4082` 也记录了该事件族投递不可靠——**计数基准必须是策略自己发出的 reload 次数**，不能数原始事件。
- 协议不变量：apply.ts:4「客户端 store 的 apply 逻辑是本函数的宿主化改写，不得引入额外分支」；`applyConversationDeltas(s, coalesce(ds)) ≡ applyAll(s, ds)` 黄金等价是裁判。不可变语义的意义在「已发布快照不被后续事件篡改」——帧内 mutable、帧间各持一份新数组不破坏它。
- **memo 引用恒等性是隐式契约**（v2 评审确认）：不可变版对无 row 操作的帧（`state.updated`/workflow twin，apply.ts:121/124-133）原样保留 `rows.window` 引用，SessionPane/ConversationTimeline 的 memo（`SessionPane.tsx:1244-1247`、`ConversationTimeline.tsx:392-413`）以此为 key 免于重算——batch 版必须保住这条性质。
- Main 不承载业务状态；恢复动作只属于窗口/进程层（本方案不违反）。
- 测试基建（v2 修正）：现有 5 个测试均在 `packages/*/test/*.test.ts`（node:test），**用 `npx tsx --test` 跑**（root devDep tsx；Node 原生 strip types 不做 `.js`→`.ts` 改写，`node --test` 直跑 ERR_MODULE_NOT_FOUND）；**ui 包测试须先 `cd packages/ui`**——ui 源码用 `@/` 别名，tsx 按 cwd 解析 tsconfig paths，从仓库根跑报 ERR_MODULE_NOT_FOUND（desktop/shared 无别名，根跑正常）；CI（community-build.yml check job）只跑 typecheck+lint 不跑单测，本方案不改变 CI。

## 3. 方案设计

### 3.1 批次 A：主窗口崩溃自愈

**A1 恢复策略（纯函数模块，可单测）** — 新建 `packages/desktop/src/main/rendererCrashRecoveryPolicy.ts`：

```
decide(input: { reason; appQuitting; windowDestroyed; autoReloadsInStormWindow }):
  "ignore" | "reload" | "backoff-reload" | "give-up"
```

reason 按 Electron 41 全集（`electron.d.ts:11514`，8 值）显式归类，不留「其它未知类」的含糊口径：

| reason                                                                        | 动作                                                                                        | 依据                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `clean-exit`                                                                  | ignore                                                                                      | 受控退出                                                                                                                      |
| `killed`                                                                      | 非退出中 → reload                                                                           | 本应用自身路径不用 killed 终止 renderer（退出由 appQuitting 守卫）；现实中 killed = 杀软/任务管理器误杀，恰是无人值守白屏场景 |
| `oom` / `crashed` / `abnormal-exit` / `integrity-failure` / `memory-eviction` | reload                                                                                      | 崩溃类全集；memory-eviction 是「长会话内存无界」下 Windows 驱逐 renderer 的对口形态                                           |
| `launch-failed`                                                               | 近期（风暴窗口内）有自动 reload → **backoff-reload**（延迟 5s）并计风暴；否则 ignore + warn | oom→reload→内存未释放→起不来是高概率序列，直接 ignore 会永久白屏且不进风暴计数                                                |

- `appQuitting || windowDestroyed` → ignore。
- **风暴计数 = 策略已发出的 auto-reload/backoff-reload 次数**（3 次 / 5 分钟滚动窗口），不数原始事件——同窗重复投递天然免疫。
- 参数 `MAX_AUTO_RELOADS=3`、`CRASH_STORM_WINDOW_MS=5min`、`LAUNCH_FAILED_BACKOFF_MS=5s` 为模块常量（决策点 4 可调）。

**A2 接线（主窗口路径）** — `desktopWindowLifecycle.ts` 的 `createWindow`（dom-ready 处理器旁）：

```
win.webContents.on("render-process-gone", (_e, details) => {
  const action = policy.decide({ reason: details.reason,
    appQuitting: options.isAppQuitting?.() ?? false,
    windowDestroyed: win.isDestroyed(), ... });
  log + dispatch(action)   // reload / setTimeout(backoff-reload) / give-up / nothing
})
```

- `isAppQuitting` 由 index.ts 注入（`forceQuitRef.current || explicitQuitRef.current`）。
- per-webContents 持策略状态（随 createWindow 实例化，多窗口天然隔离）。
- reload 后不做任何额外事：既有 dom-ready 重挂路径负责补挂 host MessagePort。
- **显式声明的行为**（v2）：win32 下 dom-ready 无条件 `win.show(); win.focus()`（`desktopWindowLifecycle.ts:117-120`）——关到托盘后隐藏态崩溃自愈时窗口会主动弹出并抢回焦点。这是设计选择（崩溃恢复应让用户看见），写进 spec 固化口径，防后人改 show 时引入「隐藏中静默恢复」的漂移。
- 与 index.ts:1486 的既有监听（快捷键复位）分层共存，互不替代。

**事件顺序与所有权**：

```
渲染进程死亡 (oom)
 │
 ├─ main: app "render-process-gone"            [registerCrashEventMonitor(A3)：warn 日志 + dump 归档]
 ├─ main: win.webContents "render-process-gone" [A2 handler → policy]
 │     ├─ decide → "reload" ──▶ webContents.reload()
 │     ├─ decide → "backoff-reload" ──▶ 5s 后 reload（launch-failed 链）
 │     └─ decide → "give-up" ──▶ 决策点 1 的兜底动作 + error 日志
 ├─ renderer 重新加载 → dom-ready                [desktopWindowLifecycle.ts:111 既有路径]
 │     ├─ windowHostProcessMap 命中存活 host → 补挂 MessagePort(:129-149)
 │     └─ host / CLI / 运行中会话 / 后台闲时任务 全程未重启
 └─ renderer 重新订阅 v4 帧 → 投影恢复（30s off-peak 心跳随 renderer 恢复）
```

**A3 激活崩溃事件日志（含销毁防护）** — `appCrashCaptureBootstrap.ts:7` 后追加 `registerCrashEventMonitor(logger, crashCapturePaths)`。这段代码是首次激活的死代码，其 app 级 handler 直接调 `webContents.getURL()/getType()` 无 `isDestroyed()` 防护——退出收尾期窗口销毁后事件若送达会抛 "Object has been destroyed"（index.ts:1476-1478 注释是同类教训原话）。**激活同时必须在 handler 开头加 `if (webContents.isDestroyed()) return;`**（或等效 try/catch），并把该行为写进 spec。内部 once-guard 防重复注册；与 index.ts:1466 既有 browser-window-created 监听独立共存。

**A4 日志口径**（遵循 AGENTS.md 日志分级）：恢复动作 info（`[renderer-recovery] render-process-gone reason=oom, reload #2/3`）；give-up 用 error；受控终止的 ignore 不刷屏（A3 的 info/warn 分级已按 reason 处理）。

**A5 测试**：

- 单测 `packages/desktop/test/renderer-crash-recovery-policy.test.ts`（node:test，**`npx tsx --test` 运行**）：8 值 reason 全覆盖分类、退出中/已销毁忽略、风暴计数按 reload 计、launch-failed 的 backoff 分支、5 分钟窗口过期重置。
- 手工验证（dev:desktop，验收用）：DevTools `process.crash()`（reason=crashed）→ 恢复链 + 会话连续（日志有 reattached 无 respawn）；**reason 覆盖矩阵**（v2）——oom 用 renderer 内分配循环模拟、killed 用任务管理器杀 renderer 进程、launch-failed 用 oom 后紧接 reload 模拟；连崩 3 次后第 4 次按兜底停止并留 error；正常退出与关到托盘无伪恢复日志；崩溃时主进程日志必有 `render-process-gone` warn（A3 生效）。

**A6 卡死自愈（可选，决策点 5）**：`webContents.on("unresponsive")` 启动 60s 计时，期间 `'responsive'` 到达即取消；超时且非退出中 → `webContents.forcefullyCrashRenderer()` 把「卡死」降级为「崩溃」交给 A 链处理（计入同一风暴预算）。风险：误杀长阻塞但健康的 renderer（如超长 loadAllOlder 合并），会丢未提交草稿——60s 阈值与风暴预算是保守护栏。默认不进批次 A，等拍板。

### 3.2 批次 B1：渲染端每帧批量 apply（shared 协议库 + store 接线）

- shared 新导出 `applyConversationDeltasBatch(snapshot, deltas): ConversationSnapshot`（apply.ts）：内部 `createMutableConversationSnapshotAccumulator`（一次 window 拷贝 + 一次 rowIndexById 建立，`apply.ts:24-35`）→ 帧内逐 delta `applyConversationDeltaMutable`（`:153`，已核实覆盖全部 7 个 op 且语义与不可变版逐分支一致）→ 返回新快照对象。
- **引用恒等性保底**（v2，评审 M1）：batch wrapper 先 O(k) 扫一遍 `delta.op`——帧内无任何 row 操作（`row.appended/upserted/removed/delta`）时**直接复用原 `snapshot.rows` 引用**（仅顶层浅合并），保证 workflow 进度 tick、turn 相位迁移这类纯状态帧不触发下游 O(n) memo 重算。mutable 路径遇 row op 置 rows-dirty 标志同效。
- 不变量：每次调用产生新 window 数组，发布后的快照永不再被写——对外等价于不可变语义；`apply.ts:4` 的「宿主化改写不得引入额外分支」通过「复用同一 mutable 实现而非新写分支」满足（已核实 store 是纯直调共享函数，`conversationProjectionStore.ts:710` 是全仓唯一客户端调用点，帧后钩子 713-744 只消费终态+原始 deltas，替换点正确）。
- `conversationProjectionStore.ts:710` 改调 batch 版本。断档检测读的 `current.seq` 在 apply 前后语义不变，无时序影响。
- 黄金测试（`packages/shared/test/`，目录按需创建）：随机 delta 序列（含 row.removed 裁剪、no-op 分支、workflow twin、coalesce 组合）下 `batch(s, ds) ≡ 逐条不可变 apply(s, ds)` 以 `JSON.stringify` 相等为口径（先例：`workflow-runs-delta.ts:17-19` canonicalJSON）；生成器显式遵守「rowId 单调唯一」协议不变量（重复 rowId 是非法序列，会让 findIndex 首个 vs rowIndexById 末位分歧，测出假阴性）。**补引用恒等断言**：无 row-op 帧的结果 `rows === 原 rows`（JSON 相等测不出这条）。
- 性能基准（记录型，宽松阈值防 CI 抖动）：20k 行 window × 8 delta/帧，对比 batch 前后耗时，期望一个数量级差。
- **效果上界（诚实，v2 强化）**：B1 消掉 O(k·n) 的 k 乘子与每帧 k 次大数组分配，但每帧仍剩 O(n) 项（batch 自身的拷贝+Map 重建、renderUnits/workflowGraph 等 memo 群、react reconciliation），内存仍无界——「不再被拖死」**由验收里的事故级实测裁决**（见下），不以 B1 落地为默认成立。

### 3.3 批次 B2：行窗口上限 + 目录分离（✅ 已实施，详见独立方案）

> **2026-09-25 更新**：B2 已由独立方案 `conversation-window-on-demand-and-directory-design.md` 落地（阶段 1 目录命令五层 + loadAllOlder 退役 → 阶段 2 窗口淘汰 + aroundRowId 跳转）。实施路径与本节原方向的差异：memo 增量化**未做**——窗口有界（n≤2000）后 renderUnits O(2000)≈3ms/帧已够预算，增量维护的正确性风险不值得承担；实际方案是「目录服务端化 + 窗口迟滞淘汰 + 区间跳转」。验收：同基准 p95 从 122ms → **5.40ms**（c7cf20f 硬断言）。

核心矛盾：turn navigator（回合导航）依赖全量行，`loadAllOlder` 全量常驻正是为它；直接给 `rows.window` 设上限会砍掉导航。方向：**行内容有界 + 轻量目录全量常驻**（rowId/turn 元数据的小对象），回读走已有 `rowsRange`（200 行/页）。

**触发条件（v2 由验收强制供数；v6 实测后已触发）**：B1 验收中的事故级实测数据自动成为 B2 立项判据——p95 超预算或内存曲线不平稳即立项，不再依赖「有人记得去测」。**2026-09-24 实测（packages/ui/test/v4-frame-load-benchmark.test.ts，5 万行 × 30ms 节奏）：每帧总成本 p95=122ms > 30ms 预算（超支全部来自下游 O(n) memo 重算；apply p95=0.51ms 已达标）→ B2 正式立项，该基准为 B2 验收基线。**次要放大器 sessions-index 链路（`sessionsIndexStore.ts:121` 每帧 new Map、`useWorkspaceSessionsIndexItems.ts:156-213` 每 tick 全量聚合排序，O(s log s)，s=会话数）量级远小于行数链路，不列根因，B2 实测时纳入测量。

## 4. 不做什么

- 不改服务端 publisher/coalesce/retention——服务端处处有界，非本次根因。
- 不做 setState 通知合帧（rAF/微任务批处理）——30ms 帧率本身合理，放大器是每帧 O(n) 成本；B1/B2 解决后收益边际化，且引入时序复杂度违反「不能用超时掩盖同步问题」。
- 不动 legacy `zcode-protocol` 会话事件链；不改 `primaryWindowCoordinator` 用户触发重建路径（保留为兜底）。
- 不加远端崩溃上报（遥测栈已按既定方向删除，本地取证为主）。
- 不处理 14:20:33 那轮 turn `failed`——渲染端死掉后台照常执行并正常结算是设计如此，非缺陷。
- 不给辅助窗口（资源管理器/browser guest）加同款恢复——各自已有清理逻辑，主窗口才是事故面。
- **卡死（unresponsive）自愈默认不在批次 A**（决策点 5 可推翻）——`forcefullyCrashRenderer` 有误杀长阻塞 renderer 的风险，先以显式口径「卡死本轮只记日志」示人。
- **慢速自愈循环（间隔 >5 分钟）不由 A 根治**——风暴预算只防快循环，慢循环的根治在 B（每帧成本与内存），这是写明的前提。
- 不改变 CI 不跑单测的现状（测试本地 `npx tsx --test` 跑，CI 接入另立话题）。

## 5. 验收标准

批次 A：

1. `npx tsx --test packages/desktop/test/renderer-crash-recovery-policy.test.ts` 全绿（8 值 reason 全覆盖 / 退出忽略 / 按 reload 计风暴 / launch-failed backoff / 窗口过期重置）。
2. 手工 reason 覆盖矩阵：`process.crash()`（crashed）、分配循环（oom）、任务管理器杀 renderer（killed）、oom→reload 链（launch-failed backoff）四类均可触发恢复链；恢复后运行中会话连续（日志有 reattached 无 respawn）；第 4 次崩溃按兜底动作停止并留 error；正常退出与关到托盘无伪恢复日志；隐藏态恢复窗口主动示回（A2 声明行为）；崩溃时主进程日志必有 `render-process-gone` warn（A3 生效）；退出全流程无 "Object has been destroyed"（A3 防护生效）。
3. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 真实通过。

批次 B1：

1. 黄金等价测试全绿（JSON.stringify 相等 + rowId 单调唯一生成器 + 无 row-op 帧引用恒等断言）。
2. 性能基准记录在案（20k 行 × 8 delta/帧，前后对比）。
3. **事故级端到端实测（v2 强制项；v6 已完成）**：✅ `packages/ui/test/v4-frame-load-benchmark.test.ts`（真实 store + 真实下游 memo，5 万行常驻 + 30ms 节奏流式注入，默认 2000 帧常规记录 / `ZCODE_BENCH_FRAMES=20000` 全量档）。实测：apply+notify p95=0.51ms（B1 验收线 ≤1ms 达标）；每帧总成本 p95=122ms、memo 重算占 121ms——超 30ms 帧预算，**B2 立项判据触发**（超支归因：下游 O(n) memo，非 apply）。堆 max 184MB 有界。**B2 落地后同基准复测：p95 = 5.40ms（30ms 预算的 1/6），验收基线转为绿色硬断言（c7cf20f）。**
4. 手工：超长会话流式追加期间 UI 保持响应——已被第 3 条的量化基准取代（benchmark 即真实 store + 真实 memo 链路的端到端测量，不再依赖手工手感）。
5. typecheck / lint / architecture 真实通过。

两批次共同的收尾：spec 先行（A → `packages/desktop/spec/renderer-crash-recovery.md`，**spec 里枚举 8 值 reason 全集并显式归类**、写死隐藏态示回与 A3 防护；B1 → `packages/shared/spec/` 按需创建，写行为、所有权、接口与验收场景）；回合末跑 `node scripts/check-doc-sync.mjs`。

## 6. 工作量（AI 辅助日历工期口径）

| 批次             | 内容                                                                             | 估计     |
| ---------------- | -------------------------------------------------------------------------------- | -------- |
| A                | 策略模块 + 接线 + 激活监听（含防护）+ 单测 + reason 矩阵手工验证 + spec          | 1–1.5 天 |
| A6（若拍板纳入） | unresponsive→forcefullyCrashRenderer + 验证                                      | +0.5 天  |
| B1               | shared batch 导出 + 黄金/性能测试 + store 接线 + **事故级负载注入与实测** + spec | 2–3 天   |
| B2               | 独立 spec 细化 0.5 天 + 实施 2–4 天（另批，届时再估）                            | 不在本轮 |

## 7. 决策点（2026-09-24 已全部拍板）

1. **give-up 兜底动作**：✅ destroy 主窗口（win32 下 `window-all-closed` → 应用退出）。
2. **launch-failed 语义**：✅ 确认默认「风暴窗口内已有自动 reload → backoff 5s 重试并计风暴，否则 ignore + warn」。
3. **B2 立项方式**：✅ B1 验收强制产出事故级实测数据，超标即 B2 立项。
4. **风暴参数**：✅ 用默认（3 次 / 5 分钟 / backoff 5s）。
5. **卡死自愈（A6）**：✅ 本轮不做，B2 落地后按残余形态再议。

批准范围：批次 A + 批次 B1 即日实施；B2 与 A6 不在本轮。
