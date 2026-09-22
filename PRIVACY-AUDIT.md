# ZCode 社区版隐私审计报告

- 审计日期：2026-09-21
- 审计对象：本 fork（基于 zai-org/ZCode 开源版 872ad96，含本地三项提交）
- 方法：5 个并行只读审计域（desktop / services+shared+rpc+client+provider / apps/zcode-cli 全部 17 子包 / web+server+zcode-server-cli / 构建与供应链），全部结论带 file:line 证据
- 定位：为"干净社区版"提供整改依据；分级为 高/中/低，通道按 厂商遥测/指纹、内容出网、本地落盘、本机暴露面、供应链 分类

---

## 一、总裁决

**好消息（已核实的安全面）：**

1. **历史全仓快照上传机制（repo_snapshot / uploadCredentialHandle / checkpoints v2）在全部五个范围内 grep 零残留**——偷代码的那条管线确实已从开源代码中移除。
2. **本 fork 构建产物实测不含任何遥测端点**：`packages/desktop/out/main/*.js` 与 bundled agent 均保留 `process.env.*` 运行时读取；官方 3.14.1 asar 里的阿里云烘焙端点来自 z.ai 私有 CI 注入层，不在开源仓库内。
3. **Agent 运行时（CLI）无内容外传旁路**：除模型 API 外，没有任何代码把提示词/工具结果/代码发往第三方；OTLP span 属性经核验只含 token 计数、时延、工具名（非参数），错误消息经脱敏。
4. **Web 前端零第三方资源**：无外部字体/脚本/统计；favicon 内嵌 data URI；生产关 sourcemap。
5. **本会话已完成**：`ZCODE_TELEMETRY_ENABLED` 改为 opt-in 默认关（`packages/shared/src/env.ts:50`，spec 见 `packages/shared/spec/telemetry-master-switch.md`），数仓事件 + ARMS RUM + 远程 crash 三条通道随总闸关闭。

**坏消息（待整改）：**

1. 一批**默认开启且不受遥测开关管辖**的指纹/探测通道（见 A2-A6）。
2. 两个**生产默认开启的本地明文落盘点**：model-io 全量请求/响应（含完整提示词与代码）默认写盘；credentials.json 加密密钥可由本机信息推导。
3. **packages/server 存在本机跨站 WebSocket 劫持暴露面**（恶意网页可读会话、执行终端）。
4. ARMS SDK + OTLP 导出器仍静态打进安装包，可被环境变量一键唤醒。
5. 分发链 install.sh 不校验 sha256。

---

## 二、A 类：厂商遥测与指纹通道

| # | 通道 | 证据 | 默认状态 | 处置 |
|---|---|---|---|---|
| A1 | 数仓事件（user_id/device_mid/分辨率/营销归因/事件明细） | `services/src/telemetry/telemetryCore.ts:368,394-432` | **已关**（fork 总闸默认 false） | 保持 |
| A2 | **全量指纹头随每次 ZCode endpoint API 外发**：`X-Device-Mid`、`X-Client-Timezone`、`X-Os-Version`、语言、平台、渠道 | `shared/src/zcode-source-headers.ts:45-58`；注入点 `services/src/providers/api/nodeApiClient.ts:62-74`（OAuth/计费/配置/分享/反馈全走这里） | **开，无开关** | P0：删 `X-Device-Mid`/时区/OS 版本三头，或并入遥测总闸 |
| A3 | **灰度配置拉取**（启动 + 1h TTL）：`/api/v1/client/configs` 带全套 sourceHeaders | `desktop/src/main/desktopContextPromptRollout.ts:88-124`、`desktopHelpConfig.ts:14-32` | **开，不受遥测开关管** | P0：与 A2 一并收口 |
| A4 | **CLI 对所有模型 provider（含用户自建第三方端点）发指纹头**：`HTTP-Referer: zcode.z.ai`、版本、时区、locale、OS 内核版本 | `apps/zcode-cli/packages/bootstrap/src/model-config.ts:47-66`；注入 `adapters/src/model/model-execution.ts:202-208` | **开，无开关** | P0：仅对官方端点注入 + `ZCODE_SEND_CLIENT_HEADERS=0` 紧急开关 |
| A5 | **Anthropic 协议请求体带 `metadata.user_id = {device_id, session_id}`，对第三方端点同样生效** | `adapters/src/model/anthropic-request-metadata.ts:7-32`；调用 `runner-generate.ts:166`、`runner-stream.ts:284` | **开** | P0：同 A4 按端点放行 |
| A6 | 更新探测每小时心跳：`GET /api/v1/releases/electron/manifest?platform=&device_mid=&channel=` + `X-Device-Mid` 头 | `desktop/src/main/manifestUpdateProvider.ts:77-93,218-223`；`autoUpdater.ts:26` | production flavor 开；**社区构建（preview flavor）关** | P1：删 device_mid；需要彻底断时 patch 掉 `initAutoUpdater` |
| A7 | ARMS RUM 全家桶（jsError/consoleError/crash/api/click/longTask + agent 崩溃 stderr tail ≤4000 字符） | `desktop/src/main/appARMSBootstrap.ts:168-268`、`desktopStabilityTelemetry.ts:464-652`；collectors `desktop/src/shared/armsRumShared.ts:9-19` | **关**（总闸+端点双门），但 SDK 常驻安装包 | P1：从 asar 移除 SDK 与强制注入清单 |
| A8 | 营销归因（utm/channel_id）持久化并附于每个遥测事件 | `services/src/oauth/callbackAttribution.ts:3-17` → `oauthCredentialRepo.ts:226-239` → telemetryCore | 关（随 A1），本地明文常驻 | P2：删持久化 |
| A9 | provider 内置配置远端刷新（版本+平台，无 deviceMid） | `provider-node/src/zcode-builtin-download.ts:50-57`；CLI 接线 `bootstrap/src/app/process-provider-registry-runtime.ts:60-90` | 仅 SEA 打包态启用 | P2：加 kill-switch |
| A10 | 官方端点改道网关：`open.bigmodel.cn`/`api.z.ai` 的 anthropic 端点改发 `zcode.z.ai/api/v1/ultra[-zai]/anthropic` | `adapters/src/model/official-coding-plan-gateway.ts:22-94` | 开（精确匹配官方端点） | 保留但文档显式声明 |

---

## 三、B 类：内容出网通道（用户触发，需裁剪或警示）

| # | 通道 | 证据 | 备注 |
|---|---|---|---|
| B1 | **会话分享发布**：整段对话 + 工作区文件字节 multipart 上传 zcode.z.ai | `services/src/conversation-share/conversationShareHttpClient.ts:275-298`、`conversationShareArtifactSource.ts:158`；有 disclosure 确认 + 服务端安全检查（`conversationShareService.ts:1925,2344-2373`） | P1：社区版改用现成 `createUnsupportedConversationShareService`（`node.ts:2409-2412`）只留导入 |
| B2 | **反馈工单日志直传 OSS**：compact 档 ≤2MB logs/；`full:true` 打包**整个 appConfigDir（上限 1GB）**，可能裹入 setting.json、凭据备份 | `services/src/feedback/feedbackService.ts:232-248`、`feedbackHttpClient.ts:494-544,932-1090`；身份 `X-Device-Mid` + JWT | P0：删 full 档与 OSS 直传；日志白名单化 |
| B3 | 模型 API 本体（提示词/代码进上下文即出境） | 服务本体，非通道缺陷 | 不可移除；靠上下文自觉 + 可选本地模型 |
| B4 | Coding Plan webview 向官网 localStorage 注入 OAuth token + `__zcodeReportContext__`（deviceMid/userId） | `ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts:186-240`；preload origin 门禁 `desktop/src/preload/codingPlanWebview.ts:34-62` | P2：改 postMessage 按需传递 |

---

## 四、C 类：本地敏感落盘

| # | 数据 | 位置与证据 | 处置 |
|---|---|---|---|
| C1 | **model-io 全量请求/响应明文 JSONL（含完整系统提示词、代码、工具结果），生产默认开启** | `adapters/src/model/runner-debug.ts:64-68`（`shouldRecordModelIO` 仅 test 关）→ `~/.zcode/cli/rollout/model-io-<session>.jsonl`；轮转 3 文件×64MB；图片已占位、头已脱敏，但**文本正文全量**；当前无上传消费方 | **P0**：改 `ZCODE_MODEL_IO_ENABLED=1` opt-in；锁定 `modelIoFullRetentionEnabled` 协议偏好默认 false（`bootstrap/src/zcode-protocol-v4/model-io-preferences.ts:14-19`） |
| C2 | **credentials.json 加密密钥可推导**：`sha256("zcode-credential-fallback:{platform}:{homedir}:{username}")`，且兼容明文回读；rawProfile（邮箱/头像原始 JSON）一并落盘 | `services/src/credential/providers/credentialCipherProvider.ts:24-38,79-83`；`oauth/repo/oauthCredentialRepo.ts:292-409` | P1：接 OS keychain；短期强制 `ZCODE_CREDENTIAL_SECRET`、删明文回读、rawProfile 不落盘 |
| C3 | 会话库 db.sqlite 未加密（全部消息/工具调用/dwf journal） | `adapters/src/storage/session-store/paths.ts:5-9` | P2 |
| C4 | 日志含工作区路径/session id/device_mid（7 天保留，键名脱敏、值不脱敏） | `~/.zcode/cli/log/`、`~/.zcode/v2/logs/`；`adapters/src/logging/index.ts:223` | P2 |
| C5 | 崩溃 dump 双目录（线程/模块镜像，本地上传关闭 `uploadToServer:false`） | `desktop/src/main/desktopCrashCapture.ts:353-381` | P2：加保留期 |
| C6 | 内嵌浏览器完整站点数据 + Chrome 导入 cookie | `desktop/src/main/browserDataManager.ts:30,123,216` | 已知设计，文档公示 |
| C7 | deviceMid 持久 UUID（`~/.zcode/v2/telemetry-state.json`），永不轮换，计费链路依赖 | `services/src/device/deviceMid.ts:23-28`、`adapters/src/device/cli-device-mid.ts:34-83` | 随 A2/A5 处置 |

---

## 五、D 类：本机/局域网暴露面（packages/server）

| # | 问题 | 证据 | 处置 |
|---|---|---|---|
| D1 | **HTTP/WS 无 Origin/Host 校验且默认无 token：恶意网页可跨站连 `ws://127.0.0.1:3030/ws` 读会话/代码、执行终端** | `server/src/http.ts:304-315`（token 空则不装鉴权）、`:322-329`；WS 无同源限制 | **P0**：WS upgrade + `/api/*` 校验 Origin/Host 白名单 |
| D2 | `/api/rpc-host-capability` 可被 no-cors simple POST 取 ticket → 连 `/ws/host` 成为 trusted-host 解除限制 | `server/src/http.ts:318,331-343`；`shared/src/channels.ts:498` | **P0**：与 D1 一并 |
| D3 | `0.0.0.0` + 无 token 全 LAN 暴露（server-core 已 fail-closed，packages/server 没有） | `server/src/entry-http.ts:14-26`；对照 `zcode-server-cli/src/server-core/http.ts:126-132` | **P0**：移植 fail-closed |
| D4 | `/api/server-info` 回 hostname/workspace 绝对路径；`/api/connect-remote` 未鉴权 SSRF 面 | `server/src/http.ts:147-182,346-365` | P1 |
| D5 | Web OAuth token 存 localStorage（XSS 即窃） | `web/src/auth/browserOAuthCredentialRepo.ts:86-96` | P2 |
| D6 | Windows 命名管道无 DACL，本机其他用户可控 stop/restart/update | `zcode-server-cli/src/runtime/paths.ts:43-46`、`ipc/controlServer.ts:106-126` | P2 |

---

## 六、E 类：构建与供应链

| # | 问题 | 证据 | 处置 |
|---|---|---|---|
| E1 | ARMS SDK + OTLP 导出器 + `@babel/runtime` 被强制打进 asar；`patches/@arms__rum-electron` 还在**增强**采集（console.error 多参数、minidump process_type 解析） | `desktop/electron-builder.config.js:110-152`、`scripts/bundle.mjs:88-117`、`patches/@arms__rum-electron@0.0.3.patch` | P1：移除依赖与注入清单，`appARMSBootstrap.ts` 静态 import 改门控动态或删除 |
| E2 | 构建期 env 注入面：`__ZCODE_ENDPOINT_ENV__`（ZCODE_BASE_URL 等 5 键）与 renderer `VITE_*` 烘进产物；`scripts/load-endpoint-env.mjs` 会合并未跟踪 `.env` | `desktop/tsup.config.ts:97-114`、`desktop/vite.config.ts:190-209` | P1：CI 构建前显式 unset 全部遥测 env（清单见下） |
| E3 | **install.sh 不校验 sha256**（sha256.txt 是死文件），BASE_URL 劫持可装入任意代码 | `scripts/zcode-distribution/installer.mjs:3-58`；生成方 `build-zcode.mjs:268-288` | P0：安装脚本加 `sha256sum -c` |
| E4 | 构建机外联：electron/electron-builder 二进制（npmmirror，无哈希校验的镜像回退）、Node 运行时（cdn.npmmirror.com）；native-search 源包与 ripgrep 预编译**已全量钉 sha256** | `mise.toml:7`、`bundle.mjs:160-231`、`native-search-tools-config.mjs:43-173` | P2：按需改镜像 |
| E5 | 内置 provider 配置内联 13 家第三方端点 + zcode-plan 计费端点，随包分发 | `config/provider/zcode-builtin.json`（186KB）→ `__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__` | 保留（功能面），文档公示 |
| E6 | `ZCODE_DEBUG_NETWORK_CAPTURE` 未设视为启用 + debug server CORS 全开（仅 127.0.0.1:4174、不存正文、需手动配代理） | `apps/zcode-cli/packages/debug/server/network-capture.ts:304-414`、`server/index.ts:31` | P2：语义反转 + 收紧 CORS + 发布构建剥离 |

---

## 七、社区版整改路线图

**P0（干净版门槛）——已于 2026-09-21 全部实施，见文末落地记录：**

1. ✅ 遥测总闸默认关（`ZCODE_TELEMETRY_ENABLED` opt-in）。
2. ✅ A2/A3：`shared/src/zcode-source-headers.ts` 删 `X-Client-Timezone`/`X-Os-Version`；`X-Device-Mid` 改 `ZCODE_SEND_DEVICE_MID=true` 显式 opt-in（保留计费契约逃生口），所有走该构建器的 `/client/configs` 拉取随之瘦身。
3. ✅ A4/A5：新增 `apps/zcode-cli/packages/adapters/src/model/model-source-header-policy.ts`——指纹头与 Anthropic `metadata.user_id` 仅对官方端点放行，第三方端点只留 User-Agent，且不再触发 deviceMid 身份文件创建；`ZCODE_SEND_CLIENT_HEADERS=0` 为全量紧急闸；CLI 头集合同步删时区/OS 版本。
4. ✅ C1：`runner-debug.ts` 的 `shouldRecordModelIO` 改为 `ZCODE_MODEL_IO_ENABLED=1` 显式 opt-in（测试态维持不写）。
5. ✅ B2：反馈 full 档整链移除（`compactLogArchive.ts` 恒 compact：仅 `logs/` ≤2MB；`feedbackService`/接口/UI/desktop 注入五处联动）；"OSS 直传"按"裁剪敏感数据面"落地——保留用户主动提交的紧凑日志与图片附件通道，整目录打包出网路径已消灭（该路径原会裹入 rollout/debug 的 model-io 明文与凭据备份）。
6. ✅ D1-D3：`packages/server/src/http.ts` 移植 fail-closed（非回环监听且无 token 拒绝启动）+ 首位中间件做 Origin/Host 双校验（跨站 WS/POST 与 DNS rebinding 阻断；`ZCODE_SERVER_ALLOWED_ORIGINS` 显式放行特殊来源；非浏览器客户端不受影响）+ 绑定层兜底：未显式指定 host 一律绑 `127.0.0.1`（复审曾发现"缺省 host 被分类为回环、实际监听所有接口"的绕过，已修，见第九点六节）。
7. ✅ E3：`installer.mjs` 生成的安装脚本解压前强制 sha256 校验（latest.json 的 sha256 字段优先，sha256.txt 兜底；sha256sum/shasum 双兼容），已通过 `sh -n` 语法验证。

**P1：** E1（摘除 ARMS SDK）、~~A6（更新探测去 device_mid）~~（已随 2026-09-22 更新子系统整体删除而消灭，见 §十一）、B1（裁分享发布链）、C2（凭据密钥强化）、E2（✅ 已落地：`.github/workflows/community-build.yml` 在 job 级清空全部遥测 env，桌面出包后运行 `scripts/community/assert-privacy.mjs` 断言门禁——社区产物 PASS 10/10、官方 3.14.1 产物 FAIL 10/10 双向验证通过；断言集变更需先更新本文件 §七/§9.5 口径）。

**P2：** A8/A9、B4、C3-C6、D4-D6、E4/E6、`zcode doctor --privacy` 敏感目录清单命令、CI 防回归 grep（禁止 rollout 目录出现新消费方、禁止 span 新增正文属性）。

**验证清单（每次社区构建后）：**

- 产物 grep：`aliyuncs.com`（遥测端点）应为 0 命中（dashscope 为 provider 功能面，除外）；`process.env.ZCODE_ARMS_RUM_ENDPOINT` 保持运行时读。
- 运行时出站域名白名单：`zcode.z.ai`（账号/计费/配置）、`api.z.ai`/`open.bigmodel.cn`（模型推理）、`cdn-zcode.z.ai`（插件/远程资产，按需）。出现其余域名即回归。
- 功能回归：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

---

## 八、遗留事项

- 本机 `~/.zcode/v2/checkpoints/` 下两个历史快照孤儿包（227MB/339MB）与 manifests 清单的处置，见会话前述结论（凭据轮换优先）。
- 日常宿主仍是官方 3.14.1（烘焙了阿里云端点、遥测开启）——社区版就绪前的最大现实暴露面。

## 九、P0 整改落地记录（2026-09-21）

改动面（git status）：16 个文件修改 + 2 个新增（`model-source-header-policy.ts`、`shared/spec/`），净行为：

| 新增环境开关 | 语义 | 默认 |
|---|---|---|
| `ZCODE_TELEMETRY_ENABLED=true` | 数仓/ARMS/远程 crash 总闸 | 关 |
| `ZCODE_SEND_DEVICE_MID=true` | `X-Device-Mid` 指纹头（官方计费契约逃生口） | 关 |
| `ZCODE_SEND_CLIENT_HEADERS=0` | CLI 指纹头与 anthropic metadata 紧急总闸 | 开（仅官方端点） |
| `ZCODE_MODEL_IO_ENABLED=1` | model-io 全量请求/响应落盘 | 关 |
| `ZCODE_SERVER_ALLOWED_ORIGINS` | server 额外放行的 Origin 白名单（逗号分隔） | 空 |

验证结果（真实执行）：

- 根 workspace `pnpm typecheck`：exit 0（覆盖 shared/services/server/ui/web/desktop）。
- CLI 子 workspace：`turbo` 二进制缺失无法整仓跑，改为对本次改动涉及的 `adapters`、`bootstrap` 两包直接 `tsc --noEmit`：均 exit 0；其余 14 个子包未改动。
- `pnpm lint`：0 错误；71 条警告均为存量（`services/node.ts` 的 `commandsService` 未使用等无关文件），本次改动文件单独 lint 全部 0 警告。
- `pnpm architecture:check --changed`：0 violations（基线 0，无新增）。
- 生成的 `install.sh` 通过 `sh -n` 语法检查。
- 无任何测试文件引用被改符号（已全量 grep 确认）；仓库本身无统一测试命令可跑。

遗留事项：

- 本机已存在的 `~/.zcode/cli/rollout/` 历史 model-io 明文文件需手动清理（新版本不再生成）。
- `modelIoFullRetentionEnabled` 协议偏好锁死、ARMS SDK 摘除（E1）、更新探测去 device_mid（A6）归入 P1。

## 九点五、社区版产物构建与验证（2026-09-21 22:40）

构建链：`rm -rf bundled-agents`（强制重建 agent）→ `ZCODE_SKIP_REMOTE_ASSETS=1 pnpm --filter @zcode/desktop build` → `ZCODE_DESKTOP_DIST_DIR=dist-community ZCODE_PREVIEW_IDENTITY=1 pnpm run bundle -- --os win --arch x64 --skip-prepare --skip-build`。

- **产物**：`packages/desktop/dist-community/ZCode Preview-3.14.0-win-x64.exe`（143MB，未签名 NSIS）+ `dist-community/win-unpacked/`（可直接运行）。
- **身份教训**：首次构建未设 `ZCODE_PREVIEW_IDENTITY=1`，烤成 production 身份（`ZCode-` 命名）——那会激活 autoUpdater 每小时 device_mid 探测与 forceUpdateGuard 启动外联（A6/M2）。已用 Preview 身份重建（updater/force-update 仅对 production flavor 生效，`index.ts:1945-1946,2188-2198`），中间产物已删除。
- **产物级验证（asar + 内置 agent 全部 grep 实测）**：
  - `proj-xtrace`、`apm/trace/opentelemetry`：**0 命中**——官方 CI 烘焙的阿里云上报端点不存在于社区构建；
  - 残留 `sdk.rum.aliyuncs`（8 处）与 `rum/web/v2`（1 处）均为**打包在内的 ARMS SDK 自身代码字符串**（remote-config 模板、pako 懒加载 blob），仅在 SDK `init()` 后可达，而总闸默认 false 使其不可达——与 P1 项 E1（SDK 摘除）一致；
  - `X-Client-Timezone` / `X-Os-Version`：asar 与内置 agent 均 **0 命中**；
  - `ZCODE_SEND_DEVICE_MID`（asar 2 处）、`ZCODE_MODEL_IO_ENABLED` + `ZCODE_SEND_CLIENT_HEADERS`（内置 agent `resources/glm/zcode.cjs` 3 处）：新开关已编入产物；
  - `packages/server/dist/http.js` 含 `Forbidden origin` 与 `Non-loopback host` 守卫（Web/CLI 发行链路同样生效）。
- **运行旧构建注意**：`dist/win-unpacked/` 里的旧 Preview（P0 整改前代码）仍在运行时请切换到 `dist-community/win-unpacked/`（数据目录同为 `%APPDATA%\ZCode Preview`，无缝接管）后关闭旧实例。

## 九点六、P0 复审修正（2026-09-21 22:45）

对第九节落地记录的复审发现一处会让 D1-D3 防护在默认部署下失效的残留绕过，本轮已修复：

- **D3 残留绕过（已修）**：原实现把"未显式指定 host"在**分类层**当回环处理，但真实监听是 `serve({ hostname: undefined })` → Node `listen(port, undefined)` 绑 `::`（所有接口）。默认部署（不设 `ZCODE_SERVER_HOST`、不设 token）因此跳过 fail-closed、实际暴露在局域网；浏览器访问会被 Host 校验挡住，但非浏览器客户端伪造 `Host: localhost` 即可同时绕过 Host/Origin 校验拿到全部 services（读会话、执行终端）。修复：**绑定层**兜底（`options.host ?? "127.0.0.1"`，对齐 server-core `http.ts:126`），回环分类与真实监听面同源。行为变化：依赖缺省绑所有接口的部署必须显式 `ZCODE_SERVER_HOST`（如 `0.0.0.0`）+ token。spec 见 `packages/server/spec/local-exposure-hardening.md`。
- **运行时断言（真实执行，临时 tsx 脚本，验证后已删）**：① `serve()` 缺省 hostname 实测绑 `::`（修复前提成立）；② `host: "0.0.0.0"` 无 token 启动即抛 `Non-loopback host 0.0.0.0 requires ZCODE_SERVER_AUTH_TOKEN ...`；③ 默认配置（不传 host/token）完整起服后 `server.address()` 为 `127.0.0.1`。
- **死代码清理**：`FeedbackLogArchiveRequest/Result` 整链移除——host 侧 pending map 与响应分支、main 侧转发、`shared/channels.ts` 两个消息类型、`shared/validation.ts` 两个 schema 及 union 注册、`exportLogs.ts` 的 `createFeedbackLogArchiveFromExportLogs` 与孤儿 import。host 已不再发起 full 打包，该链路新版本不可达。
- **指纹计算清理**：`services/src/providers/sourceHeaders.ts` 不再计算/传递已被丢弃的时区与 OS 内核版本。telemetry 事件 payload 里的 `client_timezone`/`device_os_version` 属遥测通道（A1，默认关），不在本次范围。
- **提交噪声**：node-repl-host 8 个 `dist-types/*.d.ts` 仅行尾差异（内容 diff 为 0 行），已还原，不随本次提交。
- 验证：`pnpm typecheck` exit 0；`pnpm lint` 0 错误、71 条警告与首轮完全一致（对 HEAD 比对符号出现次数确认本次未新增）；`pnpm architecture:check --changed` 0 violations；被删符号全仓 grep 零残留。
- ⚠️ **九点五节的 `dist-community` 产物构建于本修正之前**——其中的 `packages/server/dist/http.js` 含 Origin/Host 守卫但**不含绑定层兜底**，默认部署（Web/CLI 发行链路）仍存在上述绕过，需要重新打包。

当前改动面：22 个文件修改 + 3 个新增（`model-source-header-policy.ts`、`packages/shared/spec/`、`packages/server/spec/`）。

## 九点七、CLI/Web 发行树本地构建与全链路验证（2026-09-21 23:38）

`pnpm build:zcode --base-url https://whyiyhw.github.io/ZCode/zcode-dist/` 本地出树（`dist/zcode/`），逐环验证：

- **树与哈希**：`latest.json` / `releases/<v>/sha256.txt` / 实算 sha256 三方一致（`14e62d37…2ea4`）；baseUrl 正确烘焙。
- **install.sh 双向实证**：测试副本仅替换 TMP_DIR（Git Bash 下 Windows curl 不写 MSYS 路径、GNU tar 把 `D:/` 当远端主机——两处均为本机环境怪癖，非脚本缺陷；原版脚本面向 Linux/macOS，CI 原生跑）：正常安装 exit 0 且装出的 `zcode --help` 可执行；tarball 篡改 1 字节 → `sha256 mismatch ... refusing to install` exit 1。Docker/Alpine 原生验证因守护进程未运行未执行，留待 CI 首跑。
- **解包实跑**：`node bin/zcode.mjs --help` exit 0；`--web --port 3999` 起服后四发实测：无 Origin 200 / 恶意 Origin 403 / 伪造 Host 403 / localhost Origin 200——**D1/D2 守卫在发行版运行态生效**（server bundle 含 `Forbidden origin`/`Non-loopback host`，`agent/zcode.cjs` 含 `ZCODE_MODEL_IO_ENABLED`×1、`ZCODE_SEND_CLIENT_HEADERS`×2，`proj-xtrace` 全树零命中）。
- **依赖副本核验**：发行树内 `agent/node_modules/@zcode/shared/dist/zcode-source-headers.js` 与根 dist、源码三者一致（`ZCODE_SEND_DEVICE_MID`×2）；grep 到的 `X-Client-Timezone` 为新代码注释中的说明文字，非发送逻辑。
- 首次冒烟失败的三个坑均为测试装置问题（workspace 目录建错层级导致 spawn cwd ENOENT 等），已修正后通过。

## 十、覆盖范围补遗（第二轮验证）

全部 15 个 packages 与 apps/zcode-cli 均已覆盖。四个未派 agent 的包做了直查验证：

- `packages/formal-proof/src`：`fetch/https.request/WebSocket` 零命中，纯本地模块。
- `packages/ui/src`：仅 `components/ai-elements/image-preview-dialog.tsx:104`、`prompt-input.tsx:38` 两处 `fetch`，均为取本地 blob/data 附件 URL 做预览，非网络出站；`canOpenCommunity` 在 ui 层无调用点（web 侧嫌疑排除，不存在自动轮询）。
- `packages/model-option-map`：零网络。
- `packages/zcode-cua`：占位实现（`index.js` 首行 "Computer Use is not available in this build"），broker 为本地 socket，与 NOTICE.md 声明一致。

## 十一、性能瘦身落地记录（2026-09-22）

以「个人开发者不需要且常驻消耗 CPU/内存/网络」为标准，三段删除（spec 见 `packages/desktop/spec/`：`client-config-rollout-removal.md`、`auto-update-removal.md`、`resource-telemetry-removal.md`）：

1. **灰度链移除**：`singleFeatureRollout` / `desktopContextPromptRollout` / `rendererActionTraceRollout` 及共用 fetcher 整删；首 Host fork 前 ≤2s 裁决门与 action-trace 60s refresh 定时器消失；Desktop Context Prompt 静态默认关闭（Host env 显式注入 `"0"`——services 层对 env 缺失按历史语义视为开启，必须显式注入防静默翻转）；action trace 静态 `DISABLED` + `ZCODE_RENDERER_ACTION_TRACE_ENABLED` / `ZCODE_LOCAL_TTFT_ENABLED` env 逃生口；helpConfig 保留（按需、零常驻）。
2. **自动更新子系统整删**：`autoUpdater` / `manifestUpdateProvider` / `forceUpdateGuard` / `forceUpdatePrompt` 四文件 + 更新状态窗 + 设置页两个开关 + ui 十个组件 + shared 契约（13 个 channel、`DesktopCommandIds.CheckForUpdates`、`IPlatformService` 13 个方法、4 个 settings 字段、`update.ts`）+ i18n 各 50 条 key。净效果：无每小时 manifest 轮询、无启动即查、无强更 gate、`appShutdownPolicy` 只剩 `"normal"`。旧 setting.json 残留字段由 zod 默认 strip 语义丢弃。
3. **资源遥测族整删**（约 50 文件，跨 desktop/services/shared/rpc/ui/CLI）：main 10s 采样/5min 上报、网络遥测 5min flush（含 rpc `network-telemetry-middleware` 与 services agent-model 网络观测）、DAU 15min 心跳（`appTelemetryRuntime` + `SyncTelemetryContext` 链）、renderer 每窗 60s heap、24h 数据目录扫描（5 文件）、远程用量 ARMS、MCP 遥测、host/scheduler 60s 自采、services/ui memoryDiagnostics 计数注册、host↔main 资源样本消息类型与 `processResourceTelemetry` capability（server/zcode-server-cli 同步摘除）、CLI 侧 `processResourceSample`/`toolExecResource`/`mcpResourceSamples`/`mcpTelemetry` 四类通知发射与 bash 慢命令采样。
   - **保留红线**：CLI app-server 的 60s 节拍改写为纯维护节拍（`zcode-protocol/resource-sampler.ts`：session 驻留回收 + event store 修剪），采样与上报删除；MCP tracker 裁剪为纯进程登记表，`listProcesses` 继续支撑 `process/childProcesses` 协议方法（资源管理器窗口）；资源管理器窗口 `getAppMetrics` 独立采样不受影响。
   - 遗留：旧安装 `userData/zcode-data-size-telemetry.json` 成为孤儿文件（无消费方，不做启动期清理）。

验证（真实执行）：根 `pnpm typecheck` exit 0（注意覆盖面：该脚本只构建 desktop 的 host 工程；main/scheduler/preload/renderer 是独立工程，评审后已补跑并经 git-stash 基线对比确认**零新增错误**——scheduler 工程曾因 root 门禁不覆盖漏进 `NodeSelfResourceSample` 悬空导入，评审抓出后已删）；CLI 子包 adapters（含 dist 重建）/bootstrap `tsc` 通过；`pnpm lint` 0 错误、57 条警告（基线 71，`--fix` 顺带清理了改动文件中的存量未用 import；终轮 55 条）；`pnpm architecture:check --changed` 0 violations；对**已删模块**的引用 grep（`singleFeatureRollout|desktopContextPromptRollout|rendererActionTraceRollout|autoUpdater|manifestUpdateProvider|forceUpdateGuard|desktopZCodeDataSizeTelemetry|desktopRemoteUsageArmsTelemetry|desktopMcpTelemetry|desktopNetworkTelemetry|appTelemetryRuntime|memoryDiagnostics|network-telemetry-middleware|hostNetworkTelemetry|hostSelfResourceTelemetry|NodeSelfResourceSample|scheduler-resource-sample|processResourceTelemetry`）在 src 内 0 命中（`rollout`/`processResource` 的其他域命中——CLI model-io 的 rollout 目录、资源管理器的 hostResourceUsage——属保留功能，不在删除面）。

评审补修（2026-09-22 四路子代理评审后）：旧版桌面端 Host 连新 zcode-server 会对已删的四个动态事件发起订阅、在新端 RPC 读循环抛 "Event not found" 击穿 server——已在 `zcodeAgentConnectionScope`/`zcodeAgentService` 补 no-op 垫片（恒返回 `RpcEvent.None`，接口标注 @deprecated）；MCP tracker `recordProcessCrashed` 恢复旧登记语义（只清 process 不删 entry，保 revalidate 原地重连后 pid 不丢）；顺带清理孤儿变量/注释/死方法（含 `electron-updater` 依赖移除）与 dist 陈旧产物。
