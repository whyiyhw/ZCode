import type { Logger } from "@zcode/contracts";
import type { ZCodeProtocolAgentServer } from "./server.js";

/**
 * app-server 的 60 秒维护节拍。
 *
 * 历史上该节拍由资源采样定时器兼任（同一次 tick 顺带做驻留回收与 event store 修剪）；
 * 资源遥测族移除后（spec/resource-telemetry-removal.md）节拍保留、采样与上报删除——
 * session 驻留池回收与瞬态事件淘汰仍依赖这条 60s 心跳，删除节拍会造成多会话内存回归。
 */
const PROTOCOL_MAINTENANCE_INTERVAL_MS = 60_000;

export interface ProtocolMaintenanceBeat {
  stop(): void;
}

export function startProtocolResourceSampler(
  server: ZCodeProtocolAgentServer,
  logger: Logger,
): ProtocolMaintenanceBeat | undefined {
  try {
    const timer = setInterval(() => {
      try {
        server.rebalanceResidentSessions();
      } catch {
        // 单次 rebalance 失败不影响后续节拍。
      }
      try {
        server.pruneSessionEventStores();
        server.pruneDetachedChildPublishers();
      } catch {
        // 兜底淘汰失败只丢当前节拍。
      }
    }, PROTOCOL_MAINTENANCE_INTERVAL_MS);
    timer.unref?.();
    logger.debug("protocol maintenance beat started", {
      intervalMs: PROTOCOL_MAINTENANCE_INTERVAL_MS,
    });
    return {
      stop() {
        clearInterval(timer);
      },
    };
  } catch {
    // 节拍是 best effort，初始化失败不能改变 Agent 启动结果。
    return undefined;
  }
}
