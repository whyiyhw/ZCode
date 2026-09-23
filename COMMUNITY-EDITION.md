# ZCode 社区版说明：数据上报名录、整改内容与阻断模型

> 本文档说明三件事：原版 ZCode 客户端如何上报数据、本 fork 改了什么、整条链路如何被阻断，以及为什么需要一个社区版本。
> 全部 file:line 级证据见 [PRIVACY-AUDIT.md](PRIVACY-AUDIT.md)；本文只讲机制与结论。

---

## 一、为什么我们需要社区版本

**因为 2026 年 9 月的事件证明，"默认信任"在这类工具上不成立，而"开源"本身也不等于"默认干净"。**

背景（公开报道 + 本机取证双重确认）：9 月 17 日有开发者发现旧版 ZCode 客户端会将用户**整个工作区（含 `.git` 全量历史与 LFS 缓存）** 打包加密后静默上传。我们在本机的取证与该结论吻合：

- `~/.zcode/v2/checkpoints/` 下存在多个工作区的快照队列，其中两个上传失败的孤儿包分别为 227MB（9 月 18 日）与 339MB（9 月 4 日）；
- 明文 `envelope.json` 显示其格式为 `repo_snapshot_encrypted_artifact/v2`：`aes-256-ctr` 加密内容，数据密钥用**服务端 RSA-OAEP 公钥**封装——意味着用户自己都无法解密自己的数据；
- manifest 证实打包内容含 `.git/` 条目（137 个文件条目中 28 个属于 `.git`）；
- `state.json` 的 `captureStage: "prompt"` 表明**在你发出消息的那一刻**触发全仓快照；多个工作区带 `lastAcceptedManifestHash`（服务端已接受上传）；一个工作区 `failureCount: 169`——失败 169 次仍在锲而不舍地重试。

官方在三天内道歉、从代码中移除了该机制、开源了代码库并承诺第三方审计。这些是应予肯定的补救。但开源代码落地后我们审计发现：**采集的管道虽然拆了，让采集变得"默认发生"的设计习惯还在**——遥测总闸硬编码 `true`、指纹头无任何开关、model-io 明文默认落盘、ARMS SDK 常驻安装包可被环境一键唤醒、本地 HTTP/WS 服务无鉴权暴露面。

所以社区版的原则只有一句话：**把"请信任我们"换成"你可以验证"。** 具体为四条底线：

1. 一切采集默认关闭，开启必须显式 opt-in；
2. 指纹最小化——发往第三方端点的请求不携带任何可关联身份的信息；
3. 本地数据受控——明文落盘是例外而非常态；
4. 供应链可校验——分发包必须验哈希，构建产物必须可 grep 断言。

---

## 二、原版是如何上报数据的

### 2.1 历史形态：全仓快照上传（已从开源代码移除，作为事件背景保留）

```text
用户发消息（prompt 阶段）
  └─ checkpoint 管线（旧版闭源客户端）
       ├─ 全工作区打包 tar.gz（含 .git 历史、LFS 缓存）
       ├─ AES-256-CTR 加密；数据密钥由服务端 RSA-OAEP 公钥封装 → 仅厂商可解
       ├─ envelope.json / state.json / manifest 明文落盘 ~/.zcode/v2/checkpoints/<id>/
       ├─ 向 zcode.z.ai 申请 uploadCredentialHandle（服务端下发 OSS 上传凭据）
       └─ 排队上传：成功后清空 pending（不留痕）；失败留存并持续重试
```

开源代码（872ad96）中该管线已零残留（五个审计域 grep `repo_snapshot`/`uploadCredentialHandle`/`pendingUpload` 等特征串全部 0 命中）。**注意"pending 清空 = 无痕"这一设计**：它使普通用户几乎不可能发现自己被上传过——这也是事件由开发者清理磁盘时偶然发现的原因。

### 2.2 开源版仍存在的通道（社区版整改的直接对象）

**A. 三条受同一总闸管辖的遥测通道（2026-09-23 起整栈物理删除，见 PRIVACY-AUDIT.md §十五；下表为审计时记录的历史行为）。** 上游 `packages/shared/src/env.ts` 硬编码 `ZCODE_TELEMETRY_ENABLED = true`；端点（数仓、阿里云 ARMS RUM）由构建/运行环境注入、开源构建产物不内嵌——但官方 CI 会把它们烘焙进产物（实测官方 3.14.1 asar 内含 `proj-xtrace-….aliyuncs.com` 的 RUM 与 OTLP 端点，且环境变量名已被静态替换抹去）：

| 通道                     | 内容                                                                                                                | 频率                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 数仓事件 `/event/report` | user_id、device_mid、分辨率、时区、语言、营销归因（utm/channel_id 持久化）、UI 事件明细                             | 启动 + 每 15 分钟 DAU 心跳 + 事件驱动 |
| 阿里云 ARMS RUM          | jsError/consoleError/crash/api/click/longTask 全开；agent 崩溃 stderr 尾巴 ≤4000 字符；异常堆栈可含代码文件名与行号 | 持续采集批量上报                      |
| OTLP traces/metrics      | token 计数、时延、工具名（不含正文，已核验）                                                                        | 5 分钟周期 / 10% 采样                 |

**B. 不受任何开关管辖的指纹通道。** `buildZCodeSourceHeaders` 给**每一次**打向官方端点的 API 附加 `X-Device-Mid`（持久设备 UUID，永不轮换）、`X-Client-Timezone`、`X-Os-Version`、语言、渠道等全套识别头；CLI 侧更进一步——对**用户自建的第三方模型端点**也发同样指纹头外加 `HTTP-Referer: zcode.z.ai`，Anthropic 协议请求体里还嵌 `metadata.user_id = {device_id, session_id}`。生产身份的安装包每小时向更新清单接口发 `device_mid` 心跳。

**C. 内容出网通道（用户触发，但边界过宽）。** 会话分享曾把整段对话与工作区文件字节上传服务端（有确认对话框）——该功能已于 2026-09-23 随其发布链整体下线（见 PRIVACY-AUDIT.md §十五）；历史上问题反馈的 `full` 档曾把**整个应用数据目录（上限 1GB）**直传厂商 OSS——该路径已在 2026-09-21 移除，反馈功能本身也于 2026-09-23 整体下线（见 PRIVACY-AUDIT.md §十三）。

**D. 本地明文与暴露面。** model-io 全量请求/响应（完整系统提示词、代码、工具结果）在**生产环境默认落盘**；`credentials.json` 的"加密"密钥由 `platform+homedir+username` 推导，等价混淆且兼容明文回读；会话库 db.sqlite 明文；`packages/server` 的 HTTP/WS 默认无 token、无 Origin/Host 校验——恶意网页可跨站连上本机 `ws://127.0.0.1:3030/ws` 读取会话、执行终端命令。

---

## 三、我们改了什么

七项 P0 整改（2026-09-21 实施，门禁 typecheck/lint/architecture 全绿，详见 PRIVACY-AUDIT.md §九）：

| #   | 整改                                  | 位置                                                                            | 效果                                                                                                                                  |
| --- | ------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 遥测总闸改 opt-in 默认关（2026-09-23 起遥测整栈已物理删除，开关随之移除，见 §十五） | `packages/shared/src/env.ts`                                       | 数仓 + ARMS + 远程 crash 三条通道先熄火、后整栈删除                                                                                  |
| 2   | 桌面/服务侧指纹头收口                 | `packages/shared/src/zcode-source-headers.ts`                                   | 删 `X-Client-Timezone`/`X-Os-Version`；`X-Device-Mid` 仅 `ZCODE_SEND_DEVICE_MID=true` 时携带（2026-09-22 修订：`/api/v1/zcode-plan/` 计费路径族按服务端硬契约豁免补回三头，缺头即 400，见 PRIVACY-AUDIT.md §十二） |
| 3   | CLI 指纹头按端点放行                  | 新增 `apps/zcode-cli/packages/adapters/src/model/model-source-header-policy.ts` | 第三方模型端点只收 `User-Agent`；`metadata.user_id` 不再发往第三方且不触发 deviceMid 文件创建；`ZCODE_SEND_CLIENT_HEADERS=0` 紧急总闸 |
| 4   | model-io 落盘改 opt-in                | `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts`                    | 默认不再写明文提示词/代码 JSONL                                                                                                       |
| 5   | 反馈 full 档移除（2026-09-23 已随反馈功能整体下线） | `packages/services/src/feedback/`（五处联动）                                   | 反馈日志恒为 `logs/` ≤2MB；整目录出网上报路径消灭；后续反馈功能整体删除，通道不复存在                    |
| 6   | server fail-closed + Origin/Host 校验 | `packages/server/src/http.ts`                                                   | 非回环监听无 token 拒绝启动；跨站 WS 劫持与 DNS rebinding 被拦                                                                        |
| 7   | 安装脚本强制哈希校验                  | `scripts/zcode-distribution/installer.mjs`                                      | 解压前 sha256 三方一致（latest.json / sha256.txt / 实际文件）                                                                         |

第二批整改：**性能瘦身三连删**（2026-09-22 实施，spec 见 `packages/desktop/spec/`，验证与文件清单见 PRIVACY-AUDIT.md §十一）——以「个人开发者不需要且常驻消耗 CPU/内存/网络」为标准整链删除，顺带消灭了 §二.B 所述「每小时 device_mid 更新心跳」在社区版的存在基础：

| #   | 删除                              | 净效果                                                                                                                                                                                                        |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | 客户端灰度（rollout）链           | 首个 Host 前的 ≤2s 网络裁决门与 60s 刷新定时器消失；Desktop Context Prompt 静态默认关（显式注入 `"0"`）                                                                                                       |
| 9   | 自动更新子系统（约 25-30 文件）   | 无每小时 manifest 轮询、无启动即查、无强更 gate、无更新 UI/设置项/i18n；升级 = 重装                                                                                                                           |
| 10  | 资源遥测族（约 50 文件，跨 6 包） | main 10s 采样 / 网络遥测 / DAU 15min 心跳 / renderer 60s heap / 24h 目录扫描 / host↔main 资源消息与 `processResourceTelemetry` capability 全部消失；CLI 60s 节拍保留但只剩会话驻留回收与 event store 修剪职责 |

## 四、如何阻断整个链路

社区版采用五层纵深，**任何一层失效都不至于恢复采集**：

```text
层 1  默认值        所有采集点 default-off（开关表见下）；不开 = 代码路径直接 return
层 2  端点不注入    社区构建不注入 ARMS/数仓/OTLP 端点 env；产物可 grep 断言零命中
层 3  身份最小化    自动更新/强更/灰度/资源遥测子系统已整体删除（不再依赖构建身份放行）；
                    第三方端点零指纹；deviceMid 不再因模型请求被创建
层 4  网络白名单    剩余出站仅：zcode.z.ai（账号/配置）、模型 API（推理本体）、
                    cdn-zcode.z.ai（插件/资源按需）；异常域名即回归信号
层 5  供应链校验    install.sh sha256 强校验；native-search 源包全量钉哈希（上游已有）
```

**开关一览（全部默认安全方向）：**

| 环境变量                       | 语义                                        | 默认                   |
| ------------------------------ | ------------------------------------------- | ---------------------- |

| `ZCODE_BILLING_CONTRACT_HEADERS=0` | 计费契约三头（时区/OS 版本/设备标识，仅 `/api/v1/zcode-plan/` 路径）紧急关闭闸 | 开（该路径族默认携带） |
| `ZCODE_SEND_DEVICE_MID=true`   | 全局 `X-Device-Mid` 指纹头（历史逃生口；计费路径已由上一行覆盖） | 关                     |
| `ZCODE_SEND_CLIENT_HEADERS=0`  | CLI 指纹头与 anthropic metadata 紧急总闸    | 开（仅官方端点收全集） |
| `ZCODE_MODEL_IO_ENABLED=1`     | model-io 全量落盘（诊断用）                 | 关                     |
| `ZCODE_SERVER_ALLOWED_ORIGINS` | server 额外放行 Origin 白名单               | 空                     |

**产物级验证（自 2026-09-21 起随每次出包执行，清单见 PRIVACY-AUDIT.md §七；2026-09-22 起口径见 §十二）：** 对 asar 与内置 agent grep：`proj-xtrace`/`apm/trace` 应 0 命中（已实测 0）；计费契约头 `X-Client-Timezone`/`X-Os-Version` 自 §十二 起改为「成对出现」断言——头名必须与 scoped 实现证据（`/api/v1/zcode-plan/` 前缀判定 + `ZCODE_BILLING_CONTRACT_HEADERS` kill-switch）同时在 asar，证明是路径级豁免而非无条件回滚；新开关字符串应在（实测在）。ARMS SDK 与遥测整栈已于 2026-09-23 物理删除（§十五）；`sdk.rum.aliyuncs` 等字符串现为零命中硬断言。

**CI 门禁**：`.github/workflows/community-build.yml` 把上述断言变成会挂构建的硬门禁——所有作业在 job 级显式清空遥测端点环境变量，桌面出包后自动运行 `scripts/community/assert-privacy.mjs`（断言集与本节口径一致，零依赖可本地复跑）。该脚本已经双向验证：社区产物 PASS（10/10），官方 3.14.1 产物 FAIL（10/10，并枚举出其烘焙的 proj-xtrace 上报端点）。流水线同时产出三平台桌面安装包与 CLI/Web 发行树，`install.sh` 所需的 latest.json/releases 目录结构可一键发布到 gh-pages。

**诚实的边界，两条不承诺的事：**

1. **模型推理本身仍是数据出境**。你放进上下文的代码、diff、终端输出会发给所配置的模型 API——这是服务本体，不是后门，任何客户端实现都无法改变。若你的威胁模型是"厂商一个字符都不能看"，请使用本地模型。社区版做到的是把出境面收敛为"你主动喂进上下文的内容"，并让发往第三方端点的请求不携带身份指纹。
2. **官方端点仍收到最简指纹**（版本、平台类别）。账号/计费功能要求与官方后端通信；其中 `/api/v1/zcode-plan/` 计费路径族因服务端硬契约额外携带时区/OS 内核版本/设备标识三头（缺头即 400，2026-09-22 实测定界，路径级豁免见 PRIVACY-AUDIT.md §十二），`ZCODE_BILLING_CONTRACT_HEADERS=0` 可紧急关闭。

## 五、与上游的关系

本 fork 不预期上游合并这些改动（上游有自身的发布节奏与合规约束），因此采取独立维护策略：

- 上游历史被 squash 为单提交、无可考古演进史，**每次同步上游都按全新代码审**：重点盯网络端点、权限默认值、遥测门控；
- `packages/shared/src/env.ts` 等已知冲突点在合并时保留 opt-in 语义（spec：`packages/shared/spec/telemetry-master-switch.md`）；
- P1/P2 路线图（ARMS SDK 摘除、凭据接入 OS keychain、CI 构建断言、`zcode doctor --privacy` 等）见 PRIVACY-AUDIT.md §七；第二批性能瘦身的边界与红线（CLI 60s 维护节拍、MCP 进程登记表保留）见 §十一与 `packages/desktop/spec/resource-telemetry-removal.md`。

## 六、Computer Use 能力恢复（2026-09-22）

上游开源时 `packages/zcode-cua` 是 API 兼容占位包（全部表面 fail-closed），真实实现只随官方闭源产物分发。本 fork 在源码内**干净重实现**了客户端与 14 个模型可见工具的执行器（协议按官方 0.6.3 产物对齐，属互操作逆向），并以**本地暂存脚本**引入官方 Helper 运行时。规格与验收见 `packages/zcode-cua/spec/computer-use-restore.md`。

边界与红线：

- **运行时仅本地自用**：`node scripts/prepare-cua-helper.mjs` 从本机官方安装暂存 Helper 到 `packages/desktop/bundled-tools/`（gitignore、不入库）；CI 不设 `ZCODE_CUA_BUNDLE_HELPER`，公开 release 恒不含专有二进制；本地自用出包显式设该 env 才会打进 `resources/tools/cua-helper`。
- **协议不发明**：43 方法白名单、NDJSON 帧、authenticate 握手、错误码、id 分配（auth=0/业务从 1 起）与官方逐一对齐；已与真实 Helper 互操作实测（broker_info 握手、list_applications/capture_app 真实数据、业务错误码还原）。
- **防重放语义保留**：possibly_sent 状态的动作请求绝不自动重试，以 CUA_NOT_READY 信封交给模型侧决策。
- macOS 侧（.app 安装/LaunchServices/TCC/PiP）按契约实现，**未在真机验证**，清单见 spec 迁移边界。
- 插件 wrapper（skill/docs/client 脚本）取自官方 MIT 文件（`apps/zcode-cli/packages/zcode-cua-plugin/`），保留 Z.ai 署名。
- **首次运行自动激活（Windows）**：安装后无需手动脚本——宿主在 Helper 运行时缺失时自动从**本机已有的官方安装**（`ZCODE_CUA_HELPER_SOURCE` / 注册表卸载项 / 标准路径三级发现）搬运运行时到 `~/.zcode/cua-helper-runtime`，sha256 实测校验后生效；纯本机复制、无网络、不构成分发，`ZCODE_CUA_HELPER_AUTO_STAGE=0` 可关闭。无官方安装的机器给出指引并保持不可用（fail-closed）。

一句话总结：**上游开源给了我们"能看"的条件，社区版把它变成"可证"的现实——默认不采、指纹最小、本地受控、分发包可验，且每一项主张都有可复现的 grep 与命令作为证据。**
