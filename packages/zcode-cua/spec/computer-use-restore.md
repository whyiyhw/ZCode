# Spec: Computer Use 能力恢复（占位包补真 + 本地运行时）

## 背景与目标

上游开源时 `packages/zcode-cua` 以 API 兼容占位包形态发布：全部运行时表面 fail-closed，真实实现（SDK 与 Helper 二进制）只随官方闭源产物分发。本 fork 保留的宿主侧启动链（`packages/services/src/cua-permission-broker/`，Windows 全真）与 agent 侧桥接链（node-repl-host `cua-broker`/`cua-bridge`、CLI 凭据注入）因此被占位包卡死。

本变更在 fork 源码内**干净重实现**占位包的客户端与执行器表面（协议按官方产物对齐，属互操作逆向），并以**本地暂存脚本**引入官方 Helper 运行时；专有二进制不入库、不进公开 release。

## 行为

- `packages/zcode-cua` 恢复真实实现后，具备本地运行时的机器上 Computer Use 全链可用：宿主 host 拉起 Helper（Windows：Electron `ELECTRON_RUN_AS_NODE` fork `dist/windows-helper.js`；macOS：LaunchServices 拉起已安装 .app）→ agent 侧 `createComputerUseRuntime` 经 broker socket 执行 14 个工具方法。
- 运行时缺失、manifest 校验失败或 Helper 未 ready 时，保持既有 fail-closed 语义：`BROKER_UNAVAILABLE_ENV` 下发、工具返回 "Computer Use is not available" 系错误，不得静默降级或空转。
- 公开 CI 发布物不含 cua-helper 运行时（`ZCODE_CUA_BUNDLE_HELPER` 不设置时 extraResources 不追加该条目）。

## 所有权

- Helper 生命周期唯一所有者是宿主 host（desktop host 进程内 `createWindowsCuaHelperHost` / darwin `createProductCuaHelperHost`）；agent 进程只消费 `ZCODE_CUA_PERMISSION_BROKER_SOCKET` 凭据，不自行拉起 Helper（darwin standalone 兜底除外，沿用上游语义）。
- broker 线协议（帧格式、方法表、错误码）唯一定义在本包 `broker.js`；宿主健康探测（`probeHelperHealth` → `broker_info`）与 agent RPC（`callBrokerMethod`）复用同一客户端实现。
- 运行时解析（dev `ZCODE_CUA_DEV_ROOT` / product `resources/tools/cua-helper`）唯一实现在 `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts`（已有，本变更不改其判定）。
- 本地暂存唯一入口是 `scripts/prepare-cua-helper.mjs`；暂存目录被 gitignore，属于构建机器私有状态。

## 线协议契约（与官方 0.6.3 对齐）

- 传输：Windows named pipe（`\\.\pipe\zcode-cua-helper-<hex>`）/ macOS Unix domain socket；NDJSON（每行一个 JSON 消息，`\n` 结尾）。
- 请求：`{"id": <非负安全整数>, "method": "<方法名>", "params": <object>}`；`params` 缺省为 `{}`。
- 响应：`{"id": <同请求>, "ok": true, "result": <any>, "presentation"?}` 或 `{"id": <同请求>, "ok": false, "error": {"code": "<code>", "message": "<...>", "details"?}}`。
- 版本握手：`broker_info` 返回 `api_version: "ZCodeComputerUseIPC-1"`、`framing: "ndjson"`、`pid`（承载 broker 的进程 pid）。健康探测 = 调用 `broker_info` 并以 `pid` 与宿主记录的子进程 pid 精确匹配。
- 服务端限制（客户端需容忍）：单行上限 16MB；只读方法可被服务端软超时（默认 15s，错误码 `timeout`）。
- 方法表（43 个，节选分组）：诊断/权限（`broker_info`、`controller_status`、`controller_takeover`、`controller_stop`、`request_access`、`permission_status`、`input_permission_status`、`screen_capture_status`、`screen_capture_probe`、`supports_accessibility`）；观测（`list_applications`、`application_info`、`list_windows`、`capture_app`、`element_at_point`、`read_element`）；动作（`click`、`scroll`、`drag`、`type_text`、`type_text_to_app`、`press_key`、`press_key_to_app`、`hold_key`、`hold_key_to_app`、`cancel_input_holds`、`element_press`、`element_show_menu`、`element_focus`、`element_set_value`、`element_perform_action`、`element_select_text`、`paste`）；焦点/画中画（`prevent_activation`、`reenable_activation`、`is_focus_steal_prevented`、`pip_*`）。
- 错误码：业务侧 `not_authorized` / `permission_denied` / `not_selectable` / `not_settable` / `element_unavailable` / `action_unavailable` / `foreground_required` / `controller_busy`；协议侧 `invalid_request` / `method_not_found` / `timeout` / `internal`；Helper 侧 `helper_unavailable` 及启动链错误码（沿用 `CuaHelperError` 契约）。（`permission_denied` 为 2026-09-22 与真实 Helper 互操作实测确认的代码。）
- controller 仲裁：非只读、非 controller 命令的方法由 Helper 侧 controller lease 仲裁；客户端不绕过，收到 `controller_busy` 按错误路径上抛。

## 运行时契约

- **Windows product**：`resources/tools/cua-helper/runtime-manifest.json`（schemaVersion 1、packageName `@zcode/zcode-cua`、platform win32、arch 等于本机、electronVersion 精确等于宿主、entry/addon 相对路径与 sha256）。当前官方 0.6.3 钉 electron 41.0.3（= 本 fork 版本）。
- **Windows dev**：`ZCODE_CUA_DEV_ROOT` 指向目录的 `package.json` 满足生产者契约（name 恰为 `@zcode/zcode-cua`、`zcodeCuaRuntime` 恰含 `{schema:1, windows:{entry, nativeAddon}}`、路径 canonical 相对且互异、禁 symlink/逃逸）。暂存脚本负责在副本上补写该契约。
- **macOS**：已安装 Helper `~/.zcode/computer-use/<variant>/ZCode Computer Use.app`（installer 自 `resources/cua-helper/` 复制并校验 lipo arch + codesign + TeamID `8A5X4JJ39T`）；dev 需 `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL` 走 `ZCODE_CUA_BUNDLED_HELPER_APP_PATH`。
- 暂存脚本是运行时进入本仓库构建的唯一通道；版本记录落 `.cua-helper-staging.json`，重跑幂等。

## 不变量

- 无有效凭据（无 `ZCODE_CUA_PERMISSION_BROKER_SOCKET` 且 ensureBrokerAvailable 失败）时，工具执行必须抛错而非假装成功。
- `sanitizeZCodeRuntimeEnv` 对子进程剔除 broker 凭据、node_repl 受信通道定向恢复的既有防线不变（本变更不触碰）。
- 健康探测 pid 不匹配 → 宿主按启动失败处理（`health-pid-mismatch`），不允许"探测失败但继续使用"。
- 公开 release 的 asar/资源树内不得出现 cua-helper 二进制（`assert-privacy` 语义之外的供应链红线，CI 靠"不设 `ZCODE_CUA_BUNDLE_HELPER`"保证）。
- 协议实现不得发明方法名或私有扩展：方法表、帧格式、错误码与官方 0.6.3 逐一对齐，未来官方协议演进（`api_version` 变更）时客户端应显式报版本不匹配而非静默错判。

## 失败语义

- 连接失败/超时 → `BrokerError("unavailable")` 系；`ok:false` → 按错误码还原 `BrokerError`（带 details）。
- 工具层未知方法 → 明确报 `Unknown Computer Use tool`（含已删除工具的引导文案，沿用上游语义）。
- 运行时校验失败 → `WindowsCuaDevRuntimeResolutionError` 九种 reason 原样上抛（宿主已有处理），本包不吞。

## 迁移边界

- 占位包 API 面（subpath、导出名、`.d.ts`）保持兼容；`okResponse`/`errorResponse` 从无 id 形态升级为带 id 形态（与官方协议一致），仅本包内部与测试消费，不影响 services 既有导入。
- darwin 生产线（installer/LaunchServices/PiP）按官方 bundle 契约重实现；**未在真机验证**（本机为 Windows），验收场景中标注待真机补验项。代码内 `[契约推断，待真机验证]` 清单：
  - 无障碍权限请求入口（官方产物无同名入口，TCC 由 Helper 侧承担，`broker-server.js` 请求函数为推断实现）；
  - darwin host 的 transport 等待语义（官方 darwin 无 Windows 式 waitForTransport，冷启动 rename rendezvous 为推断实现）；
  - AX 角色映射与原生 addon 面（官方产物被 tree-shake，按消费面反推）；
  - `createAxReadOnlyMethods`（官方未随产物发布，按方法表消费面实现）；
  - 文件头所述提取方式（asar 主/宿主 bundle 只读切片）覆盖不到的细节。
- 官方 Helper 升级（0.6.3 → 未来版本）需重跑暂存脚本；electron 升级会触发 manifest `incompatible-runtime-manifest` fail-closed，属预期。

## 验收场景

1. （本机已验，2026-09-22）单测：NDJSON 帧解析/序列化 round-trip、请求行校验（非法 id/method/params）、fake Helper（服务端原语起 pipe）与客户端 14 方法映射、错误码还原——`node --test packages/zcode-cua/test/` 14/14。
   1a. （本机已验，2026-09-22）互操作冒烟：按宿主 fork 方式拉起暂存的官方 Helper（`ELECTRON_RUN_AS_NODE` + `ZCODE_CUA_HELPER_ADDON` + `--socket/--parent-pid`），本包客户端完成 `broker_info` 健康握手（`ZCodeComputerUseIPC-1`/ndjson/pid 匹配），`list_applications`/`supports_accessibility`/`input_permission_status`/`screen_capture_status`/`controller_status` 返回真实数据；执行器 `get_app_state` 拿到真实 state_id/219 元素树，元素派发直达 Helper（`not_settable` 真实业务错误还原）；`list_windows` 在非桌面 shell 上下文返回真实 `permission_denied` 诊断（UIPI 提示），待桌面 dev E2E 复验。
   1b. （本机已验，2026-09-22）构建链：desktop host bundle（tsup noExternal 内联）含新客户端（chunk 内 clientApiVersion/管道前缀）；`build-desktop-agent-cli` + `prepare-agent-node-bundle` 产出含真实执行器的 node-repl-host bundle，三官方插件（browser-use/node-repl-host/zcode-cua-plugin）均暂存进 bundled-agents。
2. （本机可验，待用户桌面复验）dev E2E：`node scripts/prepare-cua-helper.mjs` 暂存后 dev.mjs 自动设 `ZCODE_CUA_DEV_ROOT`，`pnpm dev:desktop` 会话内 node_repl 调 `list_windows` 返回真实窗口列表；`stop_computer_control` 可中断。
3. （本机可验，待执行）本地打包：`ZCODE_CUA_BUNDLE_HELPER=1 pnpm bundle:desktop` 产物含 `resources/tools/cua-helper` 且 manifest 校验通过；不设 env 时产物不含该目录。
4. （待真机）macOS：.app 安装/签名校验/LaunchServices 拉起/TCC 权限面板/PiP 会话。
