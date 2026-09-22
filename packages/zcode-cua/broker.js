/* eslint-disable max-lines -- broker 线协议（客户端 RPC + 服务端原语 + 方法表）单一事实源，
   拆分会把与官方 Helper 对齐的协议常量分散到多处。 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { readdirSync, statSync, unlinkSync } from "node:fs";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

// ---------------------------------------------------------------------------
// 方法表（与官方 0.6.3 Helper 的 BROKER_METHODS 逐一对齐；协议笔记见
// spec/computer-use-restore.md）。方法名不得发明私有扩展——Helper 端按此表
// 白名单分发，未知方法回 method_not_found。
// ---------------------------------------------------------------------------
export const BROKER_METHODS = [
  // 诊断
  "broker_info",
  "controller_status",
  "controller_takeover",
  "controller_stop",
  "request_access",
  "permission_status",
  "input_permission_status",
  "screen_capture_status",
  "screen_capture_probe",
  "supports_accessibility",
  // 观测
  "list_applications",
  "application_info",
  "list_windows",
  "capture_app",
  "element_at_point",
  "read_element",
  // 动作
  "click",
  "scroll",
  "drag",
  "type_text",
  "type_text_to_app",
  "press_key",
  "press_key_to_app",
  "hold_key",
  "hold_key_to_app",
  "cancel_input_holds",
  "element_press",
  "element_show_menu",
  "element_focus",
  "element_set_value",
  "element_perform_action",
  "element_select_text",
  "paste",
  // Phase 0 不抢焦点
  "prevent_activation",
  "reenable_activation",
  "is_focus_steal_prevented",
  // 实时画中画（darwin）
  "pip_start",
  "pip_stop",
  "pip_is_running",
  "pip_clear_dismissed",
  "pip_session_handshake",
  "pip_session_event",
];

const BROKER_METHOD_SET = new Set(BROKER_METHODS);
export function isBrokerMethod(method) {
  return BROKER_METHOD_SET.has(method);
}

// 只读集与官方一致：这些方法不参与 Helper 侧 controller 仲裁，允许并发观测。
const READ_ONLY_BROKER_METHODS = new Set([
  "broker_info",
  "controller_status",
  "request_access",
  "input_permission_status",
  "screen_capture_status",
  "screen_capture_probe",
  "supports_accessibility",
  "permission_status",
  "list_applications",
  "application_info",
  "list_windows",
  "capture_app",
  "element_at_point",
  "read_element",
  "is_focus_steal_prevented",
  "pip_is_running",
  "pip_clear_dismissed",
  "pip_session_handshake",
]);

export function isReadOnlyBrokerMethod(method) {
  return READ_ONLY_BROKER_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// Socket 路径（与官方宿主实现语义对齐）
// ---------------------------------------------------------------------------
const WINDOWS_NAMED_PIPE_PREFIX = "\\\\.\\pipe\\zcode-cua-helper-";
const BROKER_SOCKET_FILENAME = "broker.sock";
const STALE_SOCKET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function brokerRuntimeDir(env = process.env) {
  const xdg = env.XDG_RUNTIME_DIR;
  if (typeof xdg === "string" && xdg.trim().length > 0) {
    return join(xdg, "zcode-cua");
  }
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (typeof localAppData === "string" && localAppData.trim().length > 0) {
      return join(localAppData, "zcode", "cua-broker");
    }
    return join(homedir(), "AppData", "Local", "zcode", "cua-broker");
  }
  if (process.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
    return join("/tmp", `zcode-cua-${uid}`);
  }
  return join(homedir(), ".zcode", "cua-broker");
}

// Unix socket 文件随宿主异常退出可能残留；铸造新路径前清理超过 24h 的旧节点，
// 避免长期运行机器上 tmpdir 无限积累。失败静默——清理不是铸造的前置条件。
// 保持同步：宿主 host 的 socketPathFactory 契约是 () => string（Helper spawn
// 关键路径上一次小目录扫描，官方实现同为同步）。
function cleanupStaleBrokerSockets(dir) {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!/^broker-[0-9a-f]{16}\.sock$/u.test(name)) continue;
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > STALE_SOCKET_MAX_AGE_MS) unlinkSync(path);
      } catch {
        // 单个文件清理失败不影响其余条目。
      }
    }
  } catch {
    // 目录不存在或不可读：留给真正 bind 的调用方报错。
  }
}

export function mintBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  if (process.platform === "win32") {
    // 命名管道无文件系统节点，无需陈旧清理；16 位 hex 满足 Helper 端
    // /zcode-cua-helper-(?:[0-9a-f]{8,}|default)/ 管道名校验。
    return `${WINDOWS_NAMED_PIPE_PREFIX}${randomBytes(8).toString("hex")}`;
  }
  const dir = options.dir ?? brokerRuntimeDir(env);
  cleanupStaleBrokerSockets(dir);
  return join(dir, `broker-${randomBytes(8).toString("hex")}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const explicit = env[BROKER_SOCKET_ENV];
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit;
  if (process.platform === "win32") return `${WINDOWS_NAMED_PIPE_PREFIX}default`;
  if (options.dir) return join(options.dir, BROKER_SOCKET_FILENAME);
  return join(brokerRuntimeDir(env), BROKER_SOCKET_FILENAME);
}

// ---------------------------------------------------------------------------
// 客户端 RPC（NDJSON：每行一个 JSON 消息）
// 连接生命周期：每请求一条新连接；先发 authenticate 握手（id=0，clientApiVersion=2），
// 握手成功后才写业务行（id 从 1 起单调）。auth 后的任何失败都可能已被 Helper 执行
// （possibly_sent）——上层据此禁止盲目重试动作类请求。
// 服务端限制：单行上限 16MB；只读方法可被软超时（错误码 timeout）。
// ---------------------------------------------------------------------------
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CUA_BROKER_IPC_VERSION = 2;
let nextRequestId = 0;
function requestLineFor(id, method, params) {
  return `${JSON.stringify({ id, method, params: params ?? {} })}\n`;
}

export async function callBrokerMethod(args) {
  if (!args || typeof args !== "object") {
    throw new BrokerError("callBrokerMethod requires an arguments object.");
  }
  const socketPath = args.socketPath;
  const method = args.method;
  if (typeof socketPath !== "string" || socketPath.trim().length === 0) {
    throw new BrokerError("callBrokerMethod requires a socketPath.");
  }
  if (typeof method !== "string" || method.length === 0) {
    throw new BrokerError("callBrokerMethod requires a non-empty method.");
  }
  const timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? args.timeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
  // 业务 id 从 1 起单调递增：0 恒留给 authenticate 握手（对齐官方客户端）。
  const id = ++nextRequestId;
  if (!Number.isSafeInteger(nextRequestId + 1)) nextRequestId = 0;

  // authenticate 握手参数扩展点（对齐官方客户端 PermissionBrokerClient 的
  // authenticateParams）：PiP 呈现通道需要 {role:"presentation"} 声明连接角色，
  // Helper 端据此门控 pip_session_* 方法。缺省不携带，Windows 既有行为不变。
  const authenticateParams =
    args.authenticateParams && typeof args.authenticateParams === "object"
      ? args.authenticateParams
      : undefined;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let authed = false;
    let buffer = "";
    let deliveryState = "not_sent";
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () =>
        fail(
          new BrokerError(`Computer Use broker request timed out after ${timeoutMs}ms.`, {
            code: "timeout",
            details: { request_delivery_state: deliveryState },
          }),
        ),
      timeoutMs,
    );
    const socket = createConnection(socketPath);
    // 超时/对端关闭后 destroy 与在途 write 竞争会抛 EPIPE——静默吞掉，
    // 结局由 fail/resolve 统一仲裁。
    socket.on("error", (error) => {
      if (settled) return;
      fail(
        new BrokerError(
          `Computer Use broker connection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { code: "unavailable", details: { request_delivery_state: deliveryState } },
        ),
      );
    });
    socket.on("connect", () => {
      // 生产 Helper 要求先完成 authenticate 握手（auth id 恒为 0）。
      try {
        socket.write(
          requestLineFor(0, "authenticate", {
            clientApiVersion: CUA_BROKER_IPC_VERSION,
            ...(authenticateParams ?? {}),
          }),
        );
      } catch {
        /* destroy 竞争由 error/close 事件收口 */
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          let response;
          try {
            response = JSON.parse(line);
          } catch {
            fail(
              new BrokerError("Computer Use broker response is not valid JSON.", {
                code: "unavailable",
                details: {
                  broker_response_state: "invalid_json",
                  request_delivery_state: deliveryState,
                },
              }),
            );
            return;
          }
          if (!response || typeof response !== "object") {
            fail(
              new BrokerError("Computer Use broker response is not an object.", {
                code: "unavailable",
                details: {
                  broker_response_state: "non_object",
                  request_delivery_state: deliveryState,
                },
              }),
            );
            return;
          }
          if (!authed && response.id === 0) {
            if (response.ok === true) {
              authed = true;
              deliveryState = "possibly_sent";
              try {
                socket.write(requestLineFor(id, method, args.params));
              } catch {
                /* destroy 竞争由 error/close 事件收口 */
              }
            } else {
              const error =
                response.error && typeof response.error === "object" ? response.error : {};
              fail(
                new BrokerError(
                  typeof error.message === "string" && error.message.length > 0
                    ? error.message
                    : "Computer Use broker rejected the authenticate handshake.",
                  {
                    code:
                      typeof error.code === "string" && error.code.length > 0
                        ? error.code
                        : "not_authorized",
                    details: { request_delivery_state: "not_sent" },
                  },
                ),
              );
            }
            return;
          }
          if (response.id === id) {
            if (typeof response.ok !== "boolean") {
              fail(
                new BrokerError("Computer Use broker response has no boolean ok.", {
                  code: "unavailable",
                  details: {
                    broker_response_state: "invalid_envelope",
                    request_delivery_state: deliveryState,
                  },
                }),
              );
              return;
            }
            if (response.ok === true) {
              settled = true;
              clearTimeout(timer);
              socket.end();
              resolve(response.result);
            } else {
              const error =
                response.error && typeof response.error === "object" ? response.error : {};
              const message =
                typeof error.message === "string" && error.message.length > 0 ? error.message : "";
              const code =
                typeof error.code === "string" && error.code.length > 0 ? error.code : "internal";
              if (!message && !code) {
                fail(
                  new BrokerError("Computer Use broker error envelope is empty.", {
                    code: "unavailable",
                    details: { request_delivery_state: deliveryState },
                  }),
                );
                return;
              }
              fail(
                new BrokerError(message || code, {
                  code,
                  ...(error.details !== undefined && typeof error.details === "object"
                    ? { details: error.details }
                    : {}),
                }),
              );
            }
            return;
          }
          // id 不匹配的行属于其它并发请求——当前实现一连接一请求，不应出现；
          // 忽略并继续，避免协议噪音误杀有效响应。
        }
        newlineIndex = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_BYTES) {
        fail(
          new BrokerError("Computer Use broker response line exceeds 16MB.", {
            code: "unavailable",
            details: { request_delivery_state: deliveryState },
          }),
        );
      }
    });
    socket.on("close", () => {
      if (!settled && !authed) {
        // 握手前断开：请求必然未送达。
        fail(
          new BrokerError("Computer Use broker connection closed before the handshake completed.", {
            code: "unavailable",
            details: { error_type: "connection_closed", request_delivery_state: "not_sent" },
          }),
        );
      } else if (!settled) {
        fail(
          new BrokerError("Computer Use broker connection closed before a response.", {
            code: "unavailable",
            details: { error_type: "connection_closed", request_delivery_state: deliveryState },
          }),
        );
      }
    });
  });
}

const HEALTH_PROBE_DEFAULTS = {
  timeoutMs: 10_000,
  pollIntervalMs: 200,
  perTryTimeoutMs: 1_500,
};

// 健康探测：轮询 broker_info 直到拿到 pid 或超时。返回 null pid/host 视为
// 不匹配（启动失败），绝不抛错——调用方按 fail-closed 语义处理探测失败。
export async function probeHelperHealth(socketPath, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : HEALTH_PROBE_DEFAULTS.timeoutMs;
  const pollIntervalMs =
    Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
      ? options.pollIntervalMs
      : HEALTH_PROBE_DEFAULTS.pollIntervalMs;
  const perTryTimeoutMs =
    Number.isFinite(options.perTryTimeoutMs) && options.perTryTimeoutMs > 0
      ? options.perTryTimeoutMs
      : HEALTH_PROBE_DEFAULTS.perTryTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const info = await callBrokerMethod({
        socketPath,
        method: "broker_info",
        timeoutMs: perTryTimeoutMs,
      });
      if (info && typeof info === "object") {
        const pid =
          typeof info.pid === "number" && Number.isSafeInteger(info.pid) ? info.pid : null;
        const bundleId =
          typeof info.tcc_grant_owner === "string" && info.tcc_grant_owner.length > 0
            ? info.tcc_grant_owner
            : typeof info.bundle_id === "string" && info.bundle_id.length > 0
              ? info.bundle_id
              : null;
        if (pid !== null) return { bundleId, pid };
      }
    } catch {
      // Helper 冷启动期间管道尚未 bind 或未完成认领窗口——继续轮询。
    }
    if (Date.now() + pollIntervalMs >= deadline) {
      return { bundleId: null, pid: null };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

// ---------------------------------------------------------------------------
// 服务端协议原语（测试 fake Helper 复用；与官方 brokerProtocol.ts 语义一致）
// ---------------------------------------------------------------------------

// presentation 标记：backend 返回值用它声明「result + 展示通道元数据」二元组。
// Symbol 保证不会与业务 result 字段冲突。
const BROKER_PRESENTED_RESULT = Symbol("zcode.cua.broker-presented-result");
export function withBrokerPresentation(result, presentation) {
  return { [BROKER_PRESENTED_RESULT]: true, result, presentation };
}
function isBrokerPresentedResult(value) {
  return typeof value === "object" && value !== null && value[BROKER_PRESENTED_RESULT] === true;
}

function validRequestId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseRequestLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, id: 0, code: "invalid_request", message: "request is not valid JSON" };
  }
  if (typeof value !== "object" || value === null) {
    return { ok: false, id: 0, code: "invalid_request", message: "request must be a JSON object" };
  }
  const record = value;
  const rawId = record.id;
  const id = validRequestId(rawId) ? rawId : 0;
  if (!validRequestId(rawId)) {
    return {
      ok: false,
      id,
      code: "invalid_request",
      message: "request.id must be a non-negative safe integer",
    };
  }
  if (typeof record.method !== "string" || record.method.length === 0) {
    return {
      ok: false,
      id,
      code: "invalid_request",
      message: "request.method must be a non-empty string",
    };
  }
  const params = record.params;
  if (
    params !== undefined &&
    (typeof params !== "object" || params === null || Array.isArray(params))
  ) {
    return { ok: false, id, code: "invalid_request", message: "request.params must be an object" };
  }
  return { ok: true, request: { id, method: record.method, params: params ?? {} } };
}

export function okResponse(id, result, presentation) {
  return {
    id,
    ok: true,
    result: result ?? null,
    ...(presentation === undefined ? {} : { presentation }),
  };
}

export function errorResponse(id, code, message, details) {
  const error = { code, message };
  if (details !== undefined && Object.keys(details).length > 0) {
    error.details = { ...details };
  }
  return { id, ok: false, error };
}

export function errorResponseFromException(id, error) {
  if (error instanceof BrokerError) {
    return errorResponse(id, error.code, error.message, error.details);
  }
  const message = error instanceof Error ? error.message : String(error);
  return errorResponse(id, "internal", message);
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

export async function dispatchRequest(backend, request) {
  if (!isBrokerMethod(request.method)) {
    return errorResponse(
      request.id,
      "method_not_found",
      `unknown broker method: ${request.method}`,
    );
  }
  const handler = backend[request.method];
  if (typeof handler !== "function") {
    return errorResponse(
      request.id,
      "method_not_found",
      `broker backend does not implement: ${request.method}`,
    );
  }
  try {
    const result = await handler(request.params);
    return isBrokerPresentedResult(result)
      ? okResponse(request.id, result.result, result.presentation)
      : okResponse(request.id, result);
  } catch (error) {
    return errorResponseFromException(request.id, error);
  }
}

export async function handleRequestLine(backend, line) {
  const parsed = parseRequestLine(line);
  if (!parsed.ok) {
    return errorResponse(parsed.id, parsed.code, parsed.message);
  }
  // authenticate 是连接层握手元方法（不在业务方法表内）；fake Helper 直接回执。
  if (parsed.request.method === "authenticate") {
    return okResponse(parsed.request.id, null);
  }
  return await dispatchRequest(backend, parsed.request);
}
