/**
 * MCP 进程登记表（资源遥测族移除后的保留部分，spec/resource-telemetry-removal.md）。
 *
 * 这里只剩 `process/childProcesses` 协议方法与本地日志所需的进程事实：
 * 连接/owner/pid 的内存登记与 `listProcesses()` 查询。原 5 分钟进程树采样与
 * 生命周期/内存遥测发射已删除；登记语义保持不变，pool 与 mcp index 的调用面不变。
 */
import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";

export type McpTelemetryIsolation = "session" | "workspace";
export type McpTelemetrySource = "builtin" | "plugin" | "custom";

const BUILTIN_NODE_REPL_SERVER_NAME = "node_repl";
const BUILTIN_MCP_ID_PREFIX = "builtin:";
const PLUGIN_MCP_NAMESPACE_PREFIX = "plugin:";
const MCP_ID_SAFE_CHARACTER_PATTERN = /^[A-Za-z0-9._~-]$/;

/**
 * 明文 serverName / pluginName 只在本机 host ↔ CLI 之间流转，不出本机，无需脱敏；
 * Host 用它把 ps 进程树上的 pid 归到具体插件。
 */
export interface McpTrackedProcess {
  pid: number;
  serverName: string;
  mcpSource: McpTelemetrySource;
  /** `plugin:<name>:<key>` 命名空间里的插件名；builtin host MCP（node_repl）由调用方按官方插件表补齐 */
  pluginName?: string;
}

export interface McpProcessTelemetryIdentity {
  mcpId: string;
  mcpInstanceId: string;
}

export interface McpTelemetryTracker {
  acquireOwner(input: { connectionId: string; ownerId: string; sessionId?: string }): void;
  recordSessionStartup(input: {
    configuredCount: number;
    connectedCount: number;
    failedCount: number;
    processCount: number;
    sessionId: string;
  }): void;
  recordProcessCrashed(input: {
    connectionId: string;
    exitCode: number | null;
    signal: string | null;
  }): void;
  recordProcessClosed(input: { connectionId: string }): void;
  recordProcessStarted(input: {
    connectionId: string;
    pid: number;
  }): McpProcessTelemetryIdentity | undefined;
  releaseOwner(input: { connectionId: string; ownerId: string }): void;
  registerConnection(input: {
    connectionId: string;
    isolation: McpTelemetryIsolation;
    serverName: string;
    source?: McpTelemetrySource;
  }): void;
  unregisterConnection(input: { connectionId: string }): void;
  /** 当前仍有存活进程记录的 MCP 连接（纯内存，无 I/O） */
  listProcesses(): McpTrackedProcess[];
}

interface CreateMcpTelemetryTrackerOptions {
  idSalt: string;
  now?: () => number;
  randomId?: () => string;
}

interface TrackedConnection {
  connectionId: string;
  isolation: McpTelemetryIsolation;
  mcpId: string;
  mcpSource: McpTelemetrySource;
  serverName: string;
  owners: Map<string, string | undefined>;
  process?: {
    instanceId: string;
    pid: number;
    startedAt: number;
  };
  unownedAt?: number;
}

export function createMcpTelemetryTracker(
  options: CreateMcpTelemetryTrackerOptions,
): McpTelemetryTracker {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const connections = new Map<string, TrackedConnection>();

  return {
    acquireOwner(input) {
      const connection = connections.get(input.connectionId);
      if (!connection) return;
      connection.owners.set(input.ownerId, input.sessionId);
      connection.unownedAt = undefined;
    },
    recordProcessCrashed(input) {
      const connection = connections.get(input.connectionId);
      if (!connection?.process) return;
      // 只清 process、不删 entry：pool 的 revalidate 路径会在同一 entry 上原地重连并
      // 重新 recordProcessStarted；提前删 entry 会让重挂的 pid 从 listProcesses 永久消失。
      // entry 终态由 recordProcessClosed / unregisterConnection 收口（与旧登记语义一致）。
      connection.process = undefined;
    },
    recordProcessClosed(input) {
      const connection = connections.get(input.connectionId);
      if (!connection) return;
      connection.process = undefined;
      if (connection.owners.size === 0) connections.delete(input.connectionId);
    },
    recordProcessStarted(input) {
      const connection = connections.get(input.connectionId);
      if (!connection || !Number.isInteger(input.pid) || input.pid <= 0) return undefined;
      const mcpInstanceId = randomId();
      const occurredAt = now();
      connection.process = {
        instanceId: mcpInstanceId,
        pid: input.pid,
        startedAt: occurredAt,
      };
      if (connection.owners.size === 0) connection.unownedAt ??= occurredAt;
      return { mcpId: connection.mcpId, mcpInstanceId };
    },
    recordSessionStartup() {
      // 遥测发射已移除；保留空实现以维持 pool 调用面不变。
    },
    releaseOwner(input) {
      const connection = connections.get(input.connectionId);
      if (!connection || !connection.owners.delete(input.ownerId)) return;
      if (connection.owners.size !== 0) return;
      connection.unownedAt = now();
      // process crash 后最后一个 owner 释放时，pool entry 仍会在 idle grace 内存活。
      // registration 的终态由 pool closeEntry 显式 unregister，owner 释放只记录无主时间。
    },
    registerConnection(input) {
      const mcpSource = input.source ?? resolveMcpSource(input.serverName);
      connections.set(input.connectionId, {
        connectionId: input.connectionId,
        isolation: input.isolation,
        mcpId: resolveMcpId(input.serverName, mcpSource, options.idSalt),
        mcpSource,
        serverName: input.serverName,
        owners: new Map(),
      });
    },
    unregisterConnection(input) {
      const connection = connections.get(input.connectionId);
      if (!connection) return;
      // pool entry 已进入终态，残留 lease 不能继续被视为 owner；确认进程关闭后再删除 registration。
      connection.owners.clear();
      connection.unownedAt ??= now();
      if (!connection.process) connections.delete(input.connectionId);
    },
    listProcesses() {
      const processes: McpTrackedProcess[] = [];
      for (const connection of connections.values()) {
        if (!connection.process) continue;
        const pluginName = resolvePluginName(connection.serverName);
        processes.push({
          pid: connection.process.pid,
          serverName: connection.serverName,
          mcpSource: connection.mcpSource,
          ...(pluginName ? { pluginName } : {}),
        });
      }
      return processes;
    },
  };
}

/** `plugin:<name>:<key>` → `<name>`；非插件命名空间返回 undefined */
export function resolvePluginName(serverName: string): string | undefined {
  if (!serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX)) return undefined;
  const name = serverName.slice(PLUGIN_MCP_NAMESPACE_PREFIX.length).split(":")[0]?.trim();
  return name ? name : undefined;
}

function resolveMcpSource(serverName: string): McpTelemetrySource {
  if (serverName === BUILTIN_NODE_REPL_SERVER_NAME) return "builtin";
  return serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX) ? "plugin" : "custom";
}

function resolveMcpId(serverName: string, source: McpTelemetrySource, idSalt: string): string {
  if (source === "builtin") {
    const publicName = serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX)
      ? serverName.slice(PLUGIN_MCP_NAMESPACE_PREFIX.length)
      : serverName;
    return `${BUILTIN_MCP_ID_PREFIX}${publicName.split(":").map(encodeMcpIdSegment).join(":")}`;
  }
  const digest = createHmac("sha256", idSalt).update(serverName).digest("hex").slice(0, 12);
  return `${source}:${digest}`;
}

function encodeMcpIdSegment(value: string): string {
  // 原因：encodeURIComponent 遇到孤立 surrogate 会抛 URIError，编码不能反向阻断 MCP 启动。
  // Buffer 的 UTF-8 编码会把畸形序列替换为 U+FFFD，再逐字节转义成稳定 `%HH`。
  let encoded = "";
  for (const byte of Buffer.from(value, "utf-8")) {
    const character = String.fromCharCode(byte);
    encoded += MCP_ID_SAFE_CHARACTER_PATTERN.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}
