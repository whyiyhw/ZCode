// darwin PiP 会话客户端（node 传输）。
//
// 契约来源（官方 3.14.1 host bundle 内联的 pip-session/node.ts + pipSessionSchema）：
// - 传输经 broker 线协议：authenticate 握手携带 {clientApiVersion:2, role:"presentation"}
//   （呈现角色即官方的「presentation token 门」——没有独立 token，角色声明由 Helper 在
//   authenticate 阶段校验并据此放行 pip_session_* 方法）；
// - pip_session_handshake 请求 {protocolVersion:2, runtimeId:"zcode-cua-pip-session-v2"}，
//   期望结果 {ready:true, protocolVersion:2, runtimeId:"zcode-cua-pip-session-v2"}，
//   不匹配 → code "version_mismatch" 且本传输被永久禁用（消费方 cuaPipSessionService
//   据 error.code === "version_mismatch" 停用该 socket key）；
// - pip_session_event 请求 {event}，事件四选一（strict：未知键拒绝）：
//   focus-changed{revision,sourceWindowId,sessionId|null} /
//   turn-started{sessionId,turnId,sequenceNumber,eventId} /
//   turn-ended{...turn-started,outcome:"completed"|"failed"} /
//   session-closed{sessionId,sequenceNumber,eventId}；
//   标识符 trim 后 1..255、无 NUL、且不得等于保留值 "__zcode_pip_no_active_session_v2__"；
// - 传输层重试：仅对 broker_unavailable（本包 code "unavailable"）重试，默认 2 次、
//   间隔 50ms；version_mismatch 立即上抛并禁用；
// - send() 经单条尾链串行（官方 enqueue），connect()/send() 共用同一条链。
import { BrokerError, callBrokerMethod } from "./broker.js";

const PIP_SESSION_PROTOCOL_VERSION = 2;
const PIP_SESSION_RUNTIME_ID = "zcode-cua-pip-session-v2";
const PIP_SESSION_RESERVED_IDENTIFIER = "__zcode_pip_no_active_session_v2__";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 官方用 zod strict 判别联合校验事件；本包无 zod 依赖，按同一形状手写校验，
// 并像 zod 的 .trim() 一样返回修剪后的规范化副本。
function parseIdentifier(value, field) {
  if (typeof value !== "string") {
    throw new Error(`PiP session event ${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 255) {
    throw new Error(`PiP session event ${field} must be 1-255 characters after trim`);
  }
  if (trimmed.includes("\0")) {
    throw new Error(`PiP session event ${field} cannot contain NUL`);
  }
  if (trimmed === PIP_SESSION_RESERVED_IDENTIFIER) {
    throw new Error(`PiP session event ${field} is reserved by the PiP session runtime`);
  }
  return trimmed;
}

function parseSequence(value, field) {
  if (typeof value === "boolean" || !Number.isInteger(value) || value < 0) {
    throw new Error(`PiP session event ${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertStrictKeys(event, allowed) {
  for (const key of Object.keys(event ?? {})) {
    if (!allowed.has(key)) {
      throw new Error(`PiP session event ${event?.kind} has unknown field "${key}"`);
    }
  }
}

function parsePipSessionEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("PiP session event must be an object");
  }
  switch (event.kind) {
    case "focus-changed": {
      assertStrictKeys(event, new Set(["kind", "revision", "sourceWindowId", "sessionId"]));
      return {
        kind: "focus-changed",
        revision: parseSequence(event.revision, "revision"),
        sourceWindowId: parseIdentifier(event.sourceWindowId, "sourceWindowId"),
        sessionId: event.sessionId === null ? null : parseIdentifier(event.sessionId, "sessionId"),
      };
    }
    case "turn-started": {
      assertStrictKeys(
        event,
        new Set(["kind", "sessionId", "turnId", "sequenceNumber", "eventId"]),
      );
      return {
        kind: "turn-started",
        sessionId: parseIdentifier(event.sessionId, "sessionId"),
        turnId: parseIdentifier(event.turnId, "turnId"),
        sequenceNumber: parseSequence(event.sequenceNumber, "sequenceNumber"),
        eventId: parseIdentifier(event.eventId, "eventId"),
      };
    }
    case "turn-ended": {
      assertStrictKeys(
        event,
        new Set(["kind", "sessionId", "turnId", "sequenceNumber", "eventId", "outcome"]),
      );
      if (event.outcome !== "completed" && event.outcome !== "failed") {
        throw new Error('PiP session event outcome must be "completed" or "failed"');
      }
      return {
        kind: "turn-ended",
        sessionId: parseIdentifier(event.sessionId, "sessionId"),
        turnId: parseIdentifier(event.turnId, "turnId"),
        sequenceNumber: parseSequence(event.sequenceNumber, "sequenceNumber"),
        eventId: parseIdentifier(event.eventId, "eventId"),
        outcome: event.outcome,
      };
    }
    case "session-closed": {
      assertStrictKeys(event, new Set(["kind", "sessionId", "sequenceNumber", "eventId"]));
      return {
        kind: "session-closed",
        sessionId: parseIdentifier(event.sessionId, "sessionId"),
        sequenceNumber: parseSequence(event.sequenceNumber, "sequenceNumber"),
        eventId: parseIdentifier(event.eventId, "eventId"),
      };
    }
    default:
      throw new Error(`PiP session event kind must be one of the four session kinds`);
  }
}

export function createPipSessionClient(options = {}) {
  const socketPath = options.socketPath;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const reconnectAttempts = Math.max(0, options.reconnectAttempts ?? 2);
  const reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? 50);
  // peerChecker 保留在选项面上（消费方可注入），但本包 broker 客户端经 socket 所有权与
  // 凭据环境门控（对齐 Windows 已验链路），不在此处重复校验。
  let closed = false;
  let handshakeCompleted = false;
  let mismatchError = null;
  let tail = Promise.resolve();
  let diagnosticEmitted = false;
  const emitDiagnostic = (diagnostic) => {
    // 官方实现只在首个诊断上上报一次（latch）；version_mismatch 永远优先于
    // transport_unavailable 被看到。
    if (diagnosticEmitted) return;
    diagnosticEmitted = true;
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      /* 消费方诊断回调异常不拖垮投递 */
    }
  };
  const disableForMismatch = (error) => {
    handshakeCompleted = false;
    mismatchError = error;
    emitDiagnostic({ code: "version_mismatch", message: error.message });
  };

  const callWithReconnect = async (method, params) => {
    let lastError;
    for (let attempt = 0; attempt <= reconnectAttempts; attempt += 1) {
      try {
        return await callBrokerMethod({
          socketPath,
          method,
          params,
          timeoutMs,
          authenticateParams: { role: "presentation" },
        });
      } catch (error) {
        lastError = error;
        if (error instanceof BrokerError && error.code === "version_mismatch") {
          disableForMismatch(error);
          throw error;
        }
        const unavailable =
          error instanceof BrokerError &&
          (error.code === "unavailable" || error.code === "timeout");
        if (!unavailable || attempt === reconnectAttempts) {
          if (
            unavailable &&
            attempt === reconnectAttempts &&
            error instanceof BrokerError &&
            error.code === "unavailable"
          ) {
            emitDiagnostic({ code: "transport_unavailable", message: error.message });
          }
          throw error;
        }
        if (reconnectDelayMs > 0) await delay(reconnectDelayMs);
      }
    }
    throw lastError;
  };

  const ensureHandshake = async () => {
    if (closed) throw new Error("PiP session client is closed");
    if (mismatchError) throw mismatchError;
    if (handshakeCompleted) return;
    const result = await callWithReconnect("pip_session_handshake", {
      protocolVersion: PIP_SESSION_PROTOCOL_VERSION,
      runtimeId: PIP_SESSION_RUNTIME_ID,
    });
    if (
      !result ||
      result.ready !== true ||
      result.protocolVersion !== PIP_SESSION_PROTOCOL_VERSION ||
      result.runtimeId !== PIP_SESSION_RUNTIME_ID
    ) {
      const error = new BrokerError(
        "PiP session handshake returned a different protocol/runtime; Auto-PiP is disabled",
        { code: "version_mismatch" },
      );
      disableForMismatch(error);
      throw error;
    }
    handshakeCompleted = true;
  };

  const enqueue = (operation) => {
    const next = tail.then(operation, operation);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    connect: () => enqueue(ensureHandshake),
    send: (event) =>
      enqueue(async () => {
        if (mismatchError) throw mismatchError;
        const parsed = parsePipSessionEvent(event);
        await ensureHandshake();
        return await callWithReconnect("pip_session_event", { event: parsed });
      }),
    get enabled() {
      return !closed && mismatchError === null;
    },
    close() {
      closed = true;
      handshakeCompleted = false;
    },
  };
}
