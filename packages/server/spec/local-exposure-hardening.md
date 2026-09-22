# Spec: packages/server 本机暴露面加固（绑定、鉴权与 Origin/Host 校验）

## 行为

- 绑定 host 在 `createHttpServer` 内单一解析：`resolveBindHost(options.host)`，未显式指定（缺失/空白）时收敛为 `127.0.0.1`，并原样传给 `@hono/node-server` 的 `serve({ hostname })`。回环判定（`isLoopbackBindHost`）与真实监听面共用同一值。
- 非回环绑定 host（`0.0.0.0`、局域网 IP、域名等）且未配置 `ZCODE_SERVER_AUTH_TOKEN` 时，`createHttpServer` 直接抛错拒绝启动（fail-closed），与 `zcode-server-cli` server-core 的规则一致。
- 回环判定集合固定为 `127.0.0.1` / `::1` / `localhost`（大小写不敏感）。
- 首位全局中间件（注册在 token 鉴权之前）对所有 HTTP 与 WebSocket upgrade 请求生效（WS 经 `createNodeWebSocket({ app })` + `upgradeWebSocket` 走同一条 Hono 中间件链）：
  - 回环绑定时校验 `Host` 头 hostname，非回环 hostname 一律 403（阻断 DNS rebinding 读取 `/api`、`/ws` 与静态资源）；Host 头缺失则放行。
  - 携带 `Origin` 的请求（浏览器跨站 no-cors POST、WS upgrade）仅允许三类：`ZCODE_SERVER_ALLOWED_ORIGINS` 显式白名单（逗号分隔、整串精确匹配）、Origin hostname 为回环、Origin hostname 与 `Host` 头 hostname 一致（同源）。其余 403。
  - 不携带 `Origin` 的客户端（CLI、桌面、服务端代理、curl 等非浏览器）不受该中间件影响。
- 特殊来源（如沙箱 iframe 的 `Origin: null`）默认拒绝，只能经 `ZCODE_SERVER_ALLOWED_ORIGINS` 显式放行。

## 所有权

- 绑定 host、回环判定、Origin/Host 校验的唯一实现都在 `packages/server/src/http.ts`；`entry-http.ts` 只透传环境变量（`ZCODE_SERVER_HOST`/`HOST`），不做二次默认。
- token 鉴权语义（`isTokenProtectedPath` 只覆盖 `/ws` 与 `/api`）保持原有所有权不变，本加固不改变其判定范围。

## 不变量

- 「回环分类」与「实际监听地址」必须同源：禁止在任何一层把「未指定 host」单独假定为回环或对外。缺省 host 曾透传给 `server.listen(port, undefined)` 绑 `::`（所有接口），而分类层按回环处理，导致默认部署跳过 fail-closed、被非浏览器客户端伪造 `Host: localhost` 绕过全部校验——修复即绑定层兜底（PRIVACY-AUDIT.md D3）。
- 回环绑定下 Host 校验不可按路径豁免；Origin 校验必须先于（或独立于）token 鉴权结论，不得因配置了 token 而跳过。

## 失败语义

- 非回环 + 无 token：启动即抛错（不监听任何端口）。
- Host/Origin 校验失败：返回 `403 {"error": "Forbidden host" | "Forbidden origin"}`，不进入业务路由。
- `ZCODE_SERVER_ALLOWED_ORIGINS` 解析失败不适用（纯字符串拆分，空项忽略；无法造成拒绝服务）。

## 迁移边界

- 行为变化：此前缺省 host 绑定所有接口（Node `listen(port, undefined)` → `::`），现默认仅回环。依赖局域网访问的部署必须显式设置 `ZCODE_SERVER_HOST`（如 `0.0.0.0`）并配置 `ZCODE_SERVER_AUTH_TOKEN`。
- 本变更为 fork 本地安全策略，不回馈上游；同步上游 `http.ts` 时必须保留 fail-closed 与绑定层兜底语义（见 AGENTS.md「保留与任务无关的本地改动」）。
