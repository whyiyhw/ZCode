import type {
  AgentExecutionTelemetryPort,
  ModelExecutionTelemetryPort,
} from "@zcode/contracts/telemetry";
import type { ModelStatusSink } from "@zcode/contracts/model";
import { NoopAgentExecutionTelemetry } from "./agent-trace-runtime.js";

type EnvRecord = Record<string, string | undefined>;

const noopExecution = new NoopAgentExecutionTelemetry();

export interface CreateModelTelemetryOptions {
  owner?: never;
  sessionId?: string;
}

export interface ModelTelemetryBootstrap {
  agentExecution: AgentExecutionTelemetryPort;
  enabled: boolean;
  modelExecution: ModelExecutionTelemetryPort;
  statusSink?: ModelStatusSink;
  shutdown(): Promise<void>;
}

/**
 * 遥测出网链（OTLP 导出器与进程级 Owner 准备）已于 2026-09-23 整体删除
 * （PRIVACY-AUDIT.md §十五）。本工厂保留同名 API 供 runtime 注入点使用，
 * 恒返回 Noop 执行端口；model-io 本地记录（ZCODE_MODEL_IO_ENABLED）不经此链。
 */
export function createModelTelemetry(
  _options: CreateModelTelemetryOptions = {},
): ModelTelemetryBootstrap {
  return {
    agentExecution: noopExecution,
    enabled: false,
    modelExecution: noopExecution,
    async shutdown() {},
  };
}

export type { EnvRecord };
