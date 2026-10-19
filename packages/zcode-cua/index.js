/* eslint-disable max-lines -- 14 个工具的执行器集中在单一运行时文件：会话/kill switch/
   settle/输入保持等组件仅在此消费，拆分会让工具面契约失去单一阅读位置。 */
import { BrokerError, callBrokerMethod, resolveBrokerSocketPath } from "./broker.js";

// Computer Use runtime —— 14 个模型可见工具的执行器。
// 协议与工具面契约见 spec/computer-use-restore.md 与
// apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs（MIT，
// 模型侧 SDK 的权威契约：Codex `cua` 同构、state_id 强校验、possibly_sent 防重放）。
//
// 与官方 0.6.3 producer 的已文档化差异（spec「迁移边界」）：
// - 快照恒为 full（无 delta/no_change 压缩；Helper 仍可能自行返回其 snapshot_mode）；
// - 元素索引位移不做 relocation（明确报 element_index_shifted，让模型重观察）；
// - settle 为固定 300ms 稳定窗（无自适应轮询）；
// - 不附加宿主专用的 app-associations / PiP session 展示元数据；
// - 坐标动作不携带 frame_provenance（point-only）。

const MAX_SESSION_COUNT = 128;
const MAX_STATES_PER_SESSION = 8;
const MAX_MODEL_VISIBLE_TREES = 16;
const READ_TIMEOUT_MS = 5_000;
const ACTION_TIMEOUT_MS = 30_000;
const CAPTURE_APP_TIMEOUT_MS = 20_000;
const CANCEL_HOLDS_TIMEOUT_MS = 2_000;
const SETTLE_POST_ACTION_MS = 300;
const WARMUP_RETRY_DEADLINE_MS = 2_000;
const ENSURE_BROKER_COOLDOWN_MS = 5_000;
const REFRESH_MARKER_POLL_BASE_MS = 50;
const REFRESH_MARKER_POLL_CAP_MS = 250;

const REMOVED_TOOL_GUIDANCE = Object.freeze({
  open_application:
    "It no longer exists on any platform: get_app_state binds an app and transparently launches it in the background when it is not running, so there is nothing to open first. Nothing in this surface fronts a window or takes the user's focus.",
});

const KILL_SWITCH_EXEMPT_TOOLS = new Set(["request_access", "stop_computer_control"]);

const TOOL_NAMES = [
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
  "request_access",
  "stop_computer_control",
];

class ComputerUseError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ComputerUseError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function textResult(value, extra = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], ...extra };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// broker_unavailable 异常在工具层转为非 error 的 CUA_NOT_READY 信封，交给
// 模型侧 SDK（client.mjs）按 retryable 决策——绝不静默成功。
function notReadyResultForException(error) {
  const details = error instanceof BrokerError && error.details ? error.details : {};
  const delivery = details.request_delivery_state;
  let reasonCode = "broker_not_accepting";
  let retryable = true;
  let message =
    "The Computer Use helper is not accepting requests right now. Retry the same tool call after a brief wait.";
  if (delivery === "possibly_sent") {
    reasonCode = "broker_response_ambiguous";
    retryable = false;
    message =
      "The request may already have been delivered to the helper, but the response was lost. Do not replay it automatically; observe the target state first.";
  } else if (details.refresh_marker_retryable === true) {
    reasonCode = "permission_refresh_in_progress";
    retryable = true;
    message = "A Computer Use permission refresh is in progress. Retry after it completes.";
  } else if (details.refresh_marker_retryable === false) {
    reasonCode = "permission_refresh_invalid";
    retryable = false;
    message = "The Computer Use permission refresh marker is invalid. Retry a fresh session.";
  }
  return textResult({
    kind: "CUA_NOT_READY",
    reasonCode,
    retryable,
    message,
    ...(details.tool !== undefined ? { tool: details.tool } : {}),
  });
}

function isBrokerUnavailableException(error) {
  return (
    error instanceof BrokerError &&
    (error.code === "unavailable" || error.code === "timeout" || error.code === "not_authorized")
  );
}

class KillSwitch {
  #stopped = false;
  #reason = null;
  stop(reason) {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#reason = typeof reason === "string" && reason.length > 0 ? reason : null;
  }
  ensureRunning() {
    if (this.#stopped) {
      throw new ComputerUseError(
        "CONTROL_STOPPED",
        `Computer control was stopped (${this.#reason ?? "no reason given"}). Start a new session to continue.`,
      );
    }
  }
  status() {
    return { stopped: this.#stopped, ...(this.#reason ? { stop_reason: this.#reason } : {}) };
  }
}

class InputHoldRegistry {
  #nextId = 0;
  #active = new Map();
  #claimed = new Set();
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
  }
  begin() {
    const key = `${this.sessionKey}:hold:${++this.#nextId}`;
    const entry = { key, ended: false };
    this.#active.set(key, entry);
    return {
      key,
      end: () => {
        entry.ended = true;
        this.#active.delete(key);
      },
    };
  }
  activeKeys() {
    return [...this.#active.keys()];
  }
  claimCancellation(key) {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }
}

class ActionSettler {
  #pending = new Map();
  defer(key) {
    const deadline = Date.now() + SETTLE_POST_ACTION_MS;
    const previous = this.#pending.get(key);
    this.#pending.set(key, previous && previous > deadline ? previous : deadline);
  }
  async wait(key) {
    const deadline = this.#pending.get(key);
    if (deadline === undefined) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    if (this.#pending.get(key) === deadline && deadline <= Date.now()) this.#pending.delete(key);
  }
}

// 会话级状态缓存：Helper 返回的 state_id + 元素数组；模型可见树指纹用于索引位移校验。
class AccessibilitySession {
  #states = new Map();
  #stateCounter = 0;
  #modelVisibleTrees = new Map();
  rememberCapture(capture, appKey) {
    const stateId =
      typeof capture.state_id === "string" && capture.state_id.length > 0
        ? capture.state_id
        : `s-${++this.#stateCounter}`;
    const counter = Number.parseInt(stateId.replace(/^s-/, ""), 10);
    if (Number.isFinite(counter)) this.#stateCounter = Math.max(this.#stateCounter, counter);
    const elements = Array.isArray(capture.elements) ? capture.elements : [];
    // appKey 跟随观察落进状态条目：元素动作即使不携带 app_ref，索引校验也必须
    // 对着产生该观察的应用的模型可见台账进行，而不是动作自己的目标键。
    const entry = { stateId, elements, capture, appKey };
    this.#states.set(stateId, entry);
    for (const key of this.#states.keys()) {
      if (this.#states.size <= MAX_STATES_PER_SESSION) break;
      if (key === stateId) continue;
      this.#states.delete(key);
    }
    return entry;
  }
  rememberModelVisibleTree(appKey, stateId, elements) {
    this.#modelVisibleTrees.set(appKey, {
      stateId,
      fingerprints: elements.map((element) => ({
        role: element.role ?? "",
        title: element.title ?? "",
      })),
    });
    while (this.#modelVisibleTrees.size > MAX_MODEL_VISIBLE_TREES) {
      const oldest = this.#modelVisibleTrees.keys().next().value;
      this.#modelVisibleTrees.delete(oldest);
    }
  }
  latestState() {
    let latest = null;
    for (const entry of this.#states.values()) latest = entry;
    return latest;
  }
  observationForIndex(target) {
    const entry = this.latestState();
    if (!entry) {
      throw new ComputerUseError(
        "STALE_STATE",
        "No app observation is available for this session yet; call get_app_state first. action_sent=false.",
      );
    }
    const index = target.index;
    if (!Number.isInteger(index) || index < 0 || index >= entry.elements.length) {
      throw new ComputerUseError(
        "INDEX_OUT_OF_RANGE",
        `Element index ${String(index)} is out of range for the current observation (${entry.elements.length} elements). Call get_app_state again. action_sent=false.`,
      );
    }
    const visible = this.#modelVisibleTrees.get(entry.appKey);
    if (visible && visible.stateId === entry.stateId) {
      const fingerprint = visible.fingerprints[index];
      const element = entry.elements[index];
      if (
        fingerprint &&
        element &&
        (fingerprint.role !== (element.role ?? "") || fingerprint.title !== (element.title ?? ""))
      ) {
        throw new ComputerUseError(
          "ELEMENT_INDEX_SHIFTED",
          `The app changed since it was last observed; element [${index}] no longer matches. Call get_app_state again and re-select the element. action_sent=false.`,
        );
      }
    }
    const element = entry.elements[index];
    if (!element || typeof element.native !== "string" || element.native.length === 0) {
      throw new ComputerUseError(
        "ELEMENT_UNAVAILABLE",
        `Element [${index}] did not resolve to a native element token. Re-observe the app. action_sent=false.`,
      );
    }
    return { element, state: entry };
  }
  dispose() {
    this.#states.clear();
    this.#modelVisibleTrees.clear();
  }
}

function settleTargetKey(appRef) {
  if (!appRef || typeof appRef !== "object") return "*";
  if (Number.isInteger(appRef.pid) && appRef.pid > 0) return `pid:${appRef.pid}`;
  if (typeof appRef.bundle_id === "string" && appRef.bundle_id.length > 0) {
    return `bundle:${appRef.bundle_id.toLowerCase()}`;
  }
  if (typeof appRef.name === "string" && appRef.name.length > 0) {
    return `name:${appRef.name.toLowerCase()}`;
  }
  return "*";
}

function normalizeAppRef(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return normalizeAppRef(parsed);
      }
    } catch {
      // 裸字符串按 bundle_id 处理。
    }
    return { bundle_id: trimmed };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = {};
  if (typeof value.bundle_id === "string" && value.bundle_id.trim())
    ref.bundle_id = value.bundle_id.trim();
  if (Number.isInteger(value.pid) && value.pid > 0) ref.pid = value.pid;
  if (Number.isInteger(value.window_id)) ref.window_id = value.window_id;
  if (typeof value.name === "string" && value.name.trim()) ref.name = value.name.trim();
  return Object.keys(ref).length > 0 ? ref : null;
}

function parseTargetArg(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.type === "element") {
    if (!Number.isInteger(value.index) || value.index < 0) return null;
    if ("frame_id" in value) return null;
    return { type: "element", index: value.index };
  }
  if (value.type === "coordinate") {
    const allowed = new Set(["type", "x", "y", "frame_id"]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) return null;
    }
    if (!Number.isInteger(value.x) || value.x < 0) return null;
    if (!Number.isInteger(value.y) || value.y < 0) return null;
    return {
      type: "coordinate",
      x: value.x,
      y: value.y,
      ...(typeof value.frame_id === "string" ? { frame_id: value.frame_id } : {}),
    };
  }
  return null;
}

function strictSchema(input, shape) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const allowed = new Set(Object.keys(shape));
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new ComputerUseError("INVALID_INPUT", `Unknown argument "${key}". action_sent=false.`);
    }
  }
  const result = {};
  for (const [key, spec] of Object.entries(shape)) {
    const raw = source[key];
    if (raw === undefined) {
      if (spec.required) {
        throw new ComputerUseError(
          "INVALID_INPUT",
          `Missing required argument "${key}". action_sent=false.`,
        );
      }
      if (spec.default !== undefined) result[key] = spec.default;
      continue;
    }
    result[key] = spec.parse(raw, key);
  }
  return result;
}

function expectString(value, key) {
  if (typeof value !== "string") {
    throw new ComputerUseError(
      "INVALID_INPUT",
      `Argument "${key}" must be a string. action_sent=false.`,
    );
  }
  return value;
}

function expectInt(
  value,
  key,
  { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {},
) {
  if (typeof value === "boolean" || !Number.isInteger(value)) {
    throw new ComputerUseError(
      "INVALID_INPUT",
      `Argument "${key}" must be an integer. action_sent=false.`,
    );
  }
  if (value < min || value > max) {
    throw new ComputerUseError(
      "INVALID_INPUT",
      `Argument "${key}" must be between ${min} and ${max}. action_sent=false.`,
    );
  }
  return value;
}

function expectBool(value, key) {
  if (typeof value !== "boolean") {
    throw new ComputerUseError(
      "INVALID_INPUT",
      `Argument "${key}" must be a boolean. action_sent=false.`,
    );
  }
  return value;
}

function expectAppRef(value, key) {
  const ref = normalizeAppRef(value);
  if (!ref) {
    throw new ComputerUseError(
      "INVALID_INPUT",
      `Argument "${key}" must be an app reference (bundle id string or {bundle_id, pid, window_id, name}). action_sent=false.`,
    );
  }
  return ref;
}

function expectTarget(value, key) {
  const target = parseTargetArg(value);
  if (!target) {
    throw new ComputerUseError(
      "INVALID_INPUT",
      `Argument "${key}" must be {type:"element", index} or {type:"coordinate", x, y}. action_sent=false.`,
    );
  }
  return target;
}

const PUBLIC_KEY_TOKENS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "escape",
  "esc",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "shift",
  "ctrl",
  "control",
  "alt",
  "option",
  "meta",
  "cmd",
  "command",
  "super",
  "win",
  ...Array.from({ length: 16 }, (_, index) => `f${index + 1}`),
]);

function validateKeyChord(text) {
  const tokens = text
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  for (const token of tokens) {
    if (!PUBLIC_KEY_TOKENS.has(token)) {
      throw new ComputerUseError(
        "INVALID_INPUT",
        `key text contains unsupported key token "${token}". action_sent=false.`,
      );
    }
  }
}

function elementCenter(element) {
  const bounds = element.bounds;
  if (Array.isArray(bounds) && bounds.length === 4) {
    const [x, y, w, h] = bounds.map(Number);
    if ([x, y, w, h].every(Number.isFinite)) {
      return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
    }
  }
  return null;
}

function formatAppStateTree(elements) {
  const lines = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const depth = Number.isInteger(element.depth) ? element.depth : 0;
    const flags = [];
    if (element.pressable) flags.push("pressable");
    if (element.editable) flags.push("editable");
    if (element.has_menu) flags.push("has_menu");
    if (element.focused) flags.push("focused");
    const value =
      typeof element.value === "string" && element.value.length > 0 ? ` = ${element.value}` : "";
    const title =
      typeof element.title === "string" && element.title.length > 0 ? ` "${element.title}"` : "";
    lines.push(
      `${"  ".repeat(depth)}[${index}] ${element.role ?? "unknown"}${title}${value}${flags.length ? ` (${flags.join(" ")})` : ""}`,
    );
  }
  return lines.join("\n");
}

function actionReceipt(dispatchStatus, extra = {}) {
  return {
    schema: "zcode-cua-action-receipt-v1",
    action_sent: true,
    dispatch_status: dispatchStatus,
    retry_action: false,
    ...extra,
  };
}

export function createComputerUseRuntime(options = {}) {
  const env = options.env ?? process.env;
  const socketPath = options.brokerSocketPath ?? resolveBrokerSocketPath({ env });
  const refreshMarkerPath =
    options.refreshMarkerPath ?? env.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER ?? null;
  const ensureBrokerAvailable = options.ensureBrokerAvailable ?? null;

  // ---- BrokerClient：claim / refresh 栅栏 / warmup 重试 / 动作串行 ----
  let claimPromise = null;
  let lastEnsureAt = 0;
  let globalActionTail = Promise.resolve();
  let globalLongInputHoldActive = false;

  async function readRefreshMarker() {
    if (!refreshMarkerPath || typeof refreshMarkerPath !== "string") return null;
    try {
      const { readFile, stat } = await import("node:fs/promises");
      const info = await stat(refreshMarkerPath);
      if (!info.isFile()) return null;
      const raw = await readFile(refreshMarkerPath, "utf8");
      if (raw.length > 4096) return { retryable: false };
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        parsed.schema !== 1 ||
        parsed.kind !== "permission_refresh" ||
        !Number.isFinite(parsed.deadlineEpochMs)
      ) {
        return { retryable: false };
      }
      return { retryable: true, deadlineEpochMs: parsed.deadlineEpochMs };
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return null;
      return { retryable: false };
    }
  }

  async function waitUntilRefreshClear(deadlineMs) {
    if (!refreshMarkerPath) return false;
    let observed = false;
    for (;;) {
      const marker = await readRefreshMarker();
      if (!marker) return observed;
      observed = true;
      claimPromise = null;
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) return observed;
      const markerRemaining =
        marker.retryable && Number.isFinite(marker.deadlineEpochMs)
          ? marker.deadlineEpochMs - Date.now()
          : Number.POSITIVE_INFINITY;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(
            10,
            Math.min(
              REFRESH_MARKER_POLL_CAP_MS,
              REFRESH_MARKER_POLL_BASE_MS,
              markerRemaining,
              remaining,
            ),
          ),
        ),
      );
    }
  }

  async function ensureBrokerForRetry() {
    if (!ensureBrokerAvailable) return false;
    const now = Date.now();
    if (now - lastEnsureAt < ENSURE_BROKER_COOLDOWN_MS) return true;
    lastEnsureAt = now;
    try {
      await ensureBrokerAvailable();
    } catch {
      // 钩子异常吞掉：重试环最终给出真实错误。
    }
    return true;
  }

  async function claimBrokerOnce() {
    if (!claimPromise) {
      claimPromise = callBrokerMethod({
        socketPath,
        method: "broker_info",
        timeoutMs: READ_TIMEOUT_MS,
      })
        .then(() => undefined)
        .catch(() => {
          claimPromise = null;
        });
    }
    await claimPromise;
  }

  async function invoke(method, params, kind, timeoutOverrideMs) {
    const timeoutMs =
      timeoutOverrideMs ??
      (kind === "read"
        ? READ_TIMEOUT_MS
        : kind === "capture"
          ? CAPTURE_APP_TIMEOUT_MS
          : ACTION_TIMEOUT_MS);
    const absoluteDeadline = Date.now() + timeoutMs;
    await claimBrokerOnce();
    await waitUntilRefreshClear(absoluteDeadline);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await callBrokerMethod({ socketPath, method, params, timeoutMs });
      } catch (error) {
        if (!(error instanceof BrokerError) || error.code !== "unavailable") throw error;
        const details = error.details && typeof error.details === "object" ? error.details : {};
        // possibly_sent 绝不重试——请求可能已被执行，重放会重复点击/输入。
        if (details.request_delivery_state !== "not_sent") throw error;
        if (Date.now() >= absoluteDeadline) throw error;
        const launched = await ensureBrokerForRetry();
        const refreshObserved = await waitUntilRefreshClear(absoluteDeadline);
        const retryDeadline =
          launched || refreshObserved
            ? absoluteDeadline
            : Math.min(absoluteDeadline, Date.now() + WARMUP_RETRY_DEADLINE_MS);
        if (Date.now() >= retryDeadline) throw error;
        const backoff = Math.min(750, 150 * 2 ** (attempt - 1));
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(10, Math.min(backoff, retryDeadline - Date.now()))),
        );
      }
    }
  }

  async function callBroker(method, params, kind, timeoutOverrideMs) {
    if (kind === "read" || kind === "capture") {
      return await invoke(method, params, kind, timeoutOverrideMs);
    }
    const task = globalActionTail.then(() => invoke(method, params, kind, timeoutOverrideMs));
    // 链式队列的错误不能把后续动作一并拒绝。
    globalActionTail = task.catch(() => undefined);
    return await task;
  }

  // ---- 会话表 ----
  const sessions = new Map();
  let sessionAdmission = Promise.resolve();

  function sessionKeyFor(context) {
    const workspaceKey =
      context.workspaceKey?.trim() ||
      context.workspaceIdentity?.trim() ||
      context.workspacePath?.trim() ||
      "__unknown_workspace__";
    return [
      workspaceKey,
      context.remoteSessionId?.trim() || "__local__",
      context.sessionId.trim(),
    ].join("\0");
  }

  function createSession(context) {
    const sessionKey = sessionKeyFor(context);
    return {
      broker: { invoke, callBroker },
      session: new AccessibilitySession(),
      sessionKey,
      killSwitch: new KillSwitch(),
      inputHolds: new InputHoldRegistry(sessionKey),
      settler: new ActionSettler(),
    };
  }

  async function sessionFor(context) {
    const key = sessionKeyFor(context);
    const previousAdmission = sessionAdmission;
    let releaseAdmission = () => void 0;
    sessionAdmission = new Promise((resolve) => {
      releaseAdmission = resolve;
    });
    await previousAdmission;
    try {
      let session = sessions.get(key);
      if (!session) {
        if (sessions.size >= MAX_SESSION_COUNT) {
          const oldest = sessions.keys().next().value;
          if (oldest) {
            const evicted = sessions.get(oldest);
            sessions.delete(oldest);
            await cancelHeldKeys(evicted).catch(() => undefined);
          }
        }
        session = createSession(context);
        sessions.set(key, session);
      }
      return session;
    } finally {
      releaseAdmission();
    }
  }

  async function cancelHeldKeys(deps) {
    const keys = deps.inputHolds.activeKeys();
    const targets = keys.length > 0 ? keys : [deps.sessionKey];
    for (const key of targets) {
      if (!deps.inputHolds.claimCancellation(key)) continue;
      await deps.broker
        .invoke("cancel_input_holds", { session_key: key }, "action", CANCEL_HOLDS_TIMEOUT_MS)
        .catch(() => undefined);
    }
  }

  async function withActionPolicy(toolName, handler, deps, input) {
    // subagent 拒绝：Computer Use 只允许主会话驱动。
    if ((input.context.runtimeScope ?? "main") === "subagent") {
      return errorResult("Computer Use is not available in subagent");
    }
    if (!KILL_SWITCH_EXEMPT_TOOLS.has(toolName)) deps.killSwitch.ensureRunning();
    const appKey = settleTargetKey(input.appRef ?? null);
    await deps.settler.wait(appKey);
    try {
      const result = await handler();
      if (!KILL_SWITCH_EXEMPT_TOOLS.has(toolName)) deps.settler.defer(appKey);
      return result;
    } catch (error) {
      if (isBrokerUnavailableException(error)) {
        return notReadyResultForException(
          error instanceof BrokerError
            ? new BrokerError(error.message, {
                code: error.code,
                details: { ...error.details, tool: toolName },
              })
            : error,
        );
      }
      throw error;
    }
  }

  // ---- 工具实现 ----
  function resolveElementForAction(deps, target) {
    if (target.type !== "element") return null;
    return deps.session.observationForIndex(target);
  }

  const toolHandlers = {
    async list_apps(deps) {
      const result = await deps.broker.callBroker("list_applications", {}, "read");
      return textResult(result);
    },

    async list_windows(deps, input) {
      const args = strictSchema(input.arguments, {
        app_ref: { required: true, parse: expectAppRef },
      });
      const result = await deps.broker.callBroker(
        "list_windows",
        { app_ref: args.app_ref },
        "read",
      );
      return textResult(result);
    },

    async get_app_state(deps, input) {
      const args = strictSchema(input.arguments, {
        app_ref: { required: true, parse: expectAppRef },
        include_screenshot: { parse: expectBool, default: false },
        disable_diffing: { parse: expectBool, default: false },
        tree_shown_to_model: { parse: expectBool, default: true },
      });
      const appKey = settleTargetKey(args.app_ref);
      await deps.settler.wait(appKey);
      const capture = await deps.broker.callBroker(
        "capture_app",
        {
          app_ref: args.app_ref,
          include_screenshot: args.include_screenshot === true,
          ...(args.disable_diffing === true ? { force_full: true } : {}),
        },
        "capture",
      );
      const entry = deps.session.rememberCapture(capture, appKey);
      if (args.tree_shown_to_model !== false) {
        deps.session.rememberModelVisibleTree(appKey, entry.stateId, entry.elements);
      }
      const elements = entry.elements;
      const structured = {
        state_id: entry.stateId,
        app: capture.app ?? null,
        window: capture.window ?? null,
        elements: elements.map((element, index) => ({
          index,
          role: element.role ?? "",
          kind: element.kind ?? "",
          title: element.title ?? null,
          value: element.value ?? null,
          bounds: element.bounds ?? null,
          enabled: element.enabled !== false,
          editable: element.editable === true,
          actions: Array.isArray(element.actions) ? element.actions : [],
          focused: element.focused === true,
          default_action: element.default_action === true,
          pressable: element.pressable === true,
          has_menu: element.has_menu === true,
          owner_pid: element.owner_pid ?? null,
          depth: element.depth ?? 0,
        })),
        has_image: args.include_screenshot === true,
        snapshot_mode: typeof capture.snapshot_mode === "string" ? capture.snapshot_mode : "full",
        text: formatAppStateTree(elements),
      };
      const content = [];
      if (
        args.include_screenshot === true &&
        typeof capture.screenshot === "string" &&
        capture.screenshot.length > 0
      ) {
        content.push({ type: "image", data: capture.screenshot, mimeType: "image/jpeg" });
      }
      content.push({ type: "text", text: structured.text });
      return { content, structuredContent: structured };
    },

    async left_click(deps, input) {
      const args = strictSchema(input.arguments, {
        target: { required: true, parse: expectTarget },
        modifiers: { parse: expectString, default: "" },
        strategy: { parse: expectString, default: "auto" },
        return_state: { parse: expectString, default: "none" },
        app_ref: { parse: expectAppRef },
        mouse_button: { parse: expectString, default: "left" },
        click_count: { parse: (v, k) => expectInt(v, k, { min: 1, max: 3 }), default: 1 },
      });
      const observation = resolveElementForAction(deps, args.target);
      if (observation && args.strategy !== "event") {
        try {
          await deps.broker.callBroker(
            "element_perform_action",
            { native: observation.element.native, action: "AXPress" },
            "action",
          );
        } catch (error) {
          if (
            error instanceof BrokerError &&
            error.code === "action_unavailable" &&
            args.strategy !== "a11y"
          ) {
            const point = elementCenter(observation.element);
            if (!point) throw error;
            await deps.broker.callBroker(
              "click",
              {
                point,
                button: args.mouse_button,
                clicks: args.click_count,
                modifiers: args.modifiers,
                strategy: args.strategy,
                ...(args.app_ref ? { app_ref: args.app_ref } : {}),
              },
              "action",
            );
          } else {
            throw error;
          }
        }
      } else {
        await deps.broker.callBroker(
          "click",
          {
            point: { x: args.target.x, y: args.target.y },
            button: args.mouse_button,
            clicks: args.click_count,
            modifiers: args.modifiers,
            strategy: args.strategy,
            ...(args.app_ref ? { app_ref: args.app_ref } : {}),
          },
          "action",
        );
      }
      return textResult({
        note: `Clicked (button=${args.mouse_button}, clicks=${args.click_count}).`,
        action_receipt: actionReceipt("accepted"),
      });
    },

    async scroll(deps, input) {
      const args = strictSchema(input.arguments, {
        target: { required: true, parse: expectTarget },
        scroll_direction: { required: true, parse: expectString },
        scroll_amount: { required: true, parse: (v, k) => expectInt(v, k, { min: 0, max: 100 }) },
        strategy: { parse: expectString, default: "auto" },
        return_state: { parse: expectString, default: "none" },
        app_ref: { parse: expectAppRef },
      });
      if (!["up", "down", "left", "right"].includes(args.scroll_direction)) {
        throw new ComputerUseError(
          "INVALID_INPUT",
          "scroll_direction must be one of up/down/left/right. action_sent=false.",
        );
      }
      if (args.strategy === "a11y") {
        throw new ComputerUseError(
          "ACTION_UNAVAILABLE",
          "scroll has no accessibility actuation; use the raw event strategy. action_sent=false.",
        );
      }
      if (args.scroll_amount < 1) {
        return textResult({
          note: `Scrolled 0 ${args.scroll_direction} (amount below the minimum). action_sent=false.`,
        });
      }
      const observation = resolveElementForAction(deps, args.target);
      const point = observation
        ? elementCenter(observation.element)
        : { x: args.target.x, y: args.target.y };
      await deps.broker.callBroker(
        "scroll",
        {
          point: point ?? { x: args.target.x, y: args.target.y },
          direction: args.scroll_direction,
          amount: args.scroll_amount,
          ...(args.app_ref ? { app_ref: args.app_ref } : {}),
        },
        "action",
      );
      return textResult({
        note: `Scrolled ${args.scroll_amount} ${args.scroll_direction}.`,
        action_receipt: actionReceipt("accepted"),
      });
    },

    async left_click_drag(deps, input) {
      const args = strictSchema(input.arguments, {
        from_target: { required: true, parse: expectTarget },
        to: { required: true, parse: expectTarget },
        modifiers: { parse: expectString, default: "" },
        return_state: { parse: expectString, default: "none" },
        app_ref: { parse: expectAppRef },
      });
      const start = { x: args.from_target.x, y: args.from_target.y };
      const end = { x: args.to.x, y: args.to.y };
      await deps.broker.callBroker(
        "drag",
        {
          start,
          end,
          modifiers: args.modifiers,
          ...(args.app_ref ? { app_ref: args.app_ref } : {}),
        },
        "action",
      );
      return textResult({
        note: `Dragged from (${start.x}, ${start.y}) to (${end.x}, ${end.y}).`,
        action_receipt: actionReceipt("accepted"),
      });
    },

    async type(deps, input) {
      const args = strictSchema(input.arguments, {
        text: { required: true, parse: expectString },
        target: { parse: expectTarget },
        app_ref: { parse: expectAppRef },
        strategy: { parse: expectString, default: "auto" },
        return_state: { parse: expectString, default: "none" },
      });
      if (args.text.length === 0) {
        return textResult({ note: "Typed 0 character(s). action_sent=false." });
      }
      const observation = args.target
        ? resolveElementForAction(deps, args.target)
        : null;
      if (observation && args.strategy !== "event") {
        await deps.broker.callBroker(
          "element_set_value",
          { native: observation.element.native, value: args.text },
          "action",
        );
      } else if (args.app_ref) {
        await deps.broker.callBroker(
          "type_text_to_app",
          { text: args.text, app_ref: args.app_ref, strategy: args.strategy },
          "action",
        );
      } else {
        await deps.broker.callBroker(
          "type_text",
          { text: args.text, strategy: args.strategy },
          "action",
        );
      }
      return textResult({
        note: `Typed ${args.text.length} character(s).`,
        action_receipt: actionReceipt("accepted"),
      });
    },

    async set_value(deps, input) {
      const args = strictSchema(input.arguments, {
        target: { required: true, parse: expectTarget },
        value: { required: true, parse: expectString },
        strategy: { parse: expectString, default: "auto" },
        return_state: { parse: expectString, default: "none" },
        app_ref: { parse: expectAppRef },
      });
      const observation = resolveElementForAction(deps, args.target);
      await deps.broker.callBroker(
        "element_set_value",
        { native: observation.element.native, value: args.value, strategy: args.strategy },
        "action",
      );
      return textResult({
        note: `Set the value of element [${args.target.index}].`,
        action_receipt: actionReceipt("accepted"),
      });
    },

    async select_text(deps, input) {
      const args = strictSchema(input.arguments, {
        target: { required: true, parse: expectTarget },
        text_range: {
          parse: (value) => {
            let range = value;
            if (typeof range === "string") {
              try {
                range = JSON.parse(range);
              } catch {
                range = null;
              }
            }
            if (
              !Array.isArray(range) ||
              range.length !== 2 ||
              !range.every((n) => Number.isInteger(n) && n >= 0)
            ) {
              throw new ComputerUseError(
                "INVALID_INPUT",
                "text_range must be a two-element array of non-negative integers. action_sent=false.",
              );
            }
            return range;
          },
        },
        return_state: { parse: expectString, default: "none" },
        app_ref: { parse: expectAppRef },
      });
      const observation = resolveElementForAction(deps, args.target);
      await deps.broker.callBroker(
        "element_select_text",
        {
          native: observation.element.native,
          ...(args.text_range ? { text_range: args.text_range } : {}),
        },
        "action",
      );
      return textResult({
        note: `Selected text on element [${args.target.index}].`,
        action_receipt: actionReceipt("accepted"),
      });
    },

    async key(deps, input) {
      const args = strictSchema(input.arguments, {
        text: { required: true, parse: expectString },
        repeat: { parse: (v, k) => expectInt(v, k, { min: 1, max: 100 }) },
        hold_seconds: {
          parse: (value) => {
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 30) {
              throw new ComputerUseError(
                "INVALID_INPUT",
                "hold_seconds must be a number in [0, 30]. action_sent=false.",
              );
            }
            return value;
          },
        },
        app_ref: { parse: expectAppRef },
        strategy: { parse: expectString, default: "auto" },
        return_state: { parse: expectString, default: "none" },
      });
      validateKeyChord(args.text);
      if ((args.hold_seconds ?? 0) > 0) {
        if (globalLongInputHoldActive) {
          throw new ComputerUseError(
            "INPUT_BUSY",
            "key hold: another key hold is already active; rejected before broker dispatch and no events were sent. action_sent=false.",
          );
        }
        globalLongInputHoldActive = true;
        const hold = deps.inputHolds.begin();
        try {
          await deps.broker.callBroker(
            args.app_ref ? "hold_key_to_app" : "hold_key",
            {
              text: args.text,
              duration: args.hold_seconds,
              session_key: hold.key,
              ...(args.app_ref ? { app_ref: args.app_ref } : {}),
              strategy: args.strategy,
            },
            "action",
          );
        } finally {
          hold.end();
          globalLongInputHoldActive = false;
        }
        return textResult({
          note: `Held ${args.text} for ${args.hold_seconds}s.`,
          action_receipt: actionReceipt("accepted"),
        });
      }
      const repeat = args.repeat ?? 1;
      for (let index = 0; index < repeat; index += 1) {
        await deps.broker.callBroker(
          args.app_ref ? "press_key_to_app" : "press_key",
          {
            text: args.text,
            ...(args.app_ref ? { app_ref: args.app_ref } : {}),
            strategy: args.strategy,
          },
          "action",
        );
      }
      return textResult({
        note: `Pressed ${args.text}${repeat > 1 ? ` ×${repeat}` : ""}.`,
        action_receipt: actionReceipt("accepted"),
      });
    },

    async perform_action(deps, input) {
      const args = strictSchema(input.arguments, {
        target: { required: true, parse: expectTarget },
        action: { required: true, parse: expectString },
        return_state: { parse: expectString, default: "none" },
        app_ref: { parse: expectAppRef },
      });
      const observation = resolveElementForAction(deps, args.target);
      const alias = {
        press: "press",
        axpress: "press",
        invoke: "press",
        click: "press",
        show_menu: "show_menu",
        showmenu: "show_menu",
        axshowmenu: "show_menu",
        menu: "show_menu",
        pick: "pick",
        axpick: "pick",
        select: "pick",
        selection: "pick",
      };
      const normalized = args.action.trim().toLowerCase();
      const canonical = alias[normalized] ?? args.action;
      const available = Array.isArray(observation.element.actions)
        ? observation.element.actions
        : [];
      const canonicalAvailable = new Set(
        available.map((a) => alias[String(a).trim().toLowerCase()] ?? a),
      );
      if (!canonicalAvailable.has(canonical) && !available.includes(args.action)) {
        throw new ComputerUseError(
          "ACTION_UNAVAILABLE",
          `refused: action "${args.action}" is not available on element [${args.target.index}]; allowed: [${available.join(", ")}]. action_sent=false.`,
        );
      }
      await deps.broker.callBroker(
        "element_perform_action",
        { native: observation.element.native, action: args.action },
        "action",
      );
      return textResult({
        note: `Performed "${args.action}" on element [${args.target.index}].`,
        action_receipt: actionReceipt("accepted"),
      });
    },

    async paste(deps, input) {
      const args = strictSchema(input.arguments, {
        text: { required: true, parse: expectString },
        format: { parse: expectString, default: "text" },
        app_ref: { parse: expectAppRef },
        return_state: { parse: expectString, default: "none" },
      });
      if (!["text", "md", "html"].includes(args.format)) {
        throw new ComputerUseError(
          "INVALID_INPUT",
          "format must be text/md/html. action_sent=false.",
        );
      }
      await deps.broker.callBroker(
        "paste",
        {
          text: args.text,
          format: args.format,
          ...(args.app_ref ? { app_ref: args.app_ref } : {}),
        },
        "action",
      );
      return textResult({
        note: "Pasted text. The paste shortcut cannot target a specific field; verify the insertion point and use set_value if it landed wrong.",
        action_receipt: actionReceipt("accepted"),
      });
    },

    async request_access(deps, input) {
      const args = strictSchema(input.arguments, {
        capabilities: {
          parse: (value) => {
            let list = value;
            if (typeof list === "string") {
              try {
                list = JSON.parse(list);
              } catch {
                list = null;
              }
            }
            if (list === undefined || list === null) return undefined;
            if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
              throw new ComputerUseError(
                "INVALID_INPUT",
                "capabilities must be a string array. action_sent=false.",
              );
            }
            return list;
          },
        },
      });
      const brokerInfo = await deps.broker.callBroker("broker_info", {}, "read");
      const report =
        process.platform === "darwin"
          ? await deps.broker.callBroker("permission_status", {}, "read")
          : await deps.broker.callBroker(
              "request_access",
              args.capabilities ? { capabilities: args.capabilities } : {},
              "read",
            );
      return textResult({
        ...(report && typeof report === "object" ? report : { status: report }),
        requested_capabilities: args.capabilities ?? [],
        broker: { ...brokerInfo, connected: true },
        side_effects: {
          permission_prompted: false,
          automation_warmup_attempted: false,
          screen_capture_attempted: false,
        },
        guard: deps.killSwitch.status(),
      });
    },

    async stop_computer_control(deps, input) {
      const args = strictSchema(input.arguments, {
        reason: { parse: expectString },
      });
      deps.killSwitch.stop(args.reason ?? null);
      await cancelHeldKeys(deps);
      const guard = deps.killSwitch.status();
      return textResult({
        stopped: true,
        reason: guard.stop_reason ?? null,
        guard,
      });
    },
  };

  const toolSet = new Set(TOOL_NAMES);

  return {
    async execute(execInput) {
      if (!execInput || typeof execInput !== "object") {
        throw new Error("Computer Use execute requires an input object.");
      }
      const context = execInput.context ?? {
        sessionId: "__default__",
        runtimeScope: "main",
        workspaceKey: "__unknown_workspace__",
      };
      if (typeof context.sessionId !== "string" || context.sessionId.trim().length === 0) {
        throw new Error("Computer Use execute requires a non-empty context.sessionId.");
      }
      const toolName = execInput.toolName;
      if (!toolSet.has(toolName)) {
        const replacement = REMOVED_TOOL_GUIDANCE[toolName];
        throw new Error(
          `Unknown Computer Use tool: ${String(toolName)}.` +
            (replacement ? ` ${replacement}` : ""),
        );
      }
      const deps = await sessionFor(context);
      const handler = toolHandlers[toolName];
      return await withActionPolicy(toolName, () => handler(deps, execInput), deps, {
        context,
        appRef: null,
      });
    },

    async closeSession(context) {
      const key = sessionKeyFor(
        context ?? { sessionId: "__default__", workspaceKey: "__unknown_workspace__" },
      );
      const session = sessions.get(key);
      if (!session) return;
      await cancelHeldKeys(session).catch(() => undefined);
      session.session.dispose();
      sessions.delete(key);
    },

    async dispose() {
      for (const session of sessions.values()) {
        await cancelHeldKeys(session).catch(() => undefined);
        session.session.dispose();
      }
      sessions.clear();
    },
  };
}
