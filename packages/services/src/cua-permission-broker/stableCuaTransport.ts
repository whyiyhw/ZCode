import { mintBrokerSocketPath } from "@zcode/zcode-cua/broker";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  resolveWindowsCuaRuntime,
  WindowsCuaDevRuntimeResolutionError,
  type WindowsCuaRuntime,
} from "#src/cua-permission-broker/windowsCuaDevRuntime.js";

const logger = createServiceLogger("stable-cua-transport");

export type StableCuaWinRecipe = WindowsCuaRuntime;

let stablePipeName: string | null = null;

export function getStableCuaPipeName(): string {
  stablePipeName ??= mintBrokerSocketPath({ env: process.env });
  return stablePipeName;
}

export interface StableCuaWinResolveOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
}

/**
 * Windows CUA 运行时解析（三层路由 + auto-stage 一次恢复重试 + 成功缓存）。
 *
 * helper host 拉起与 agent spawn env 凭据下发必须共用同一实现：2026-10-19 修复前
 * spawn env 链走无参解析，既看不到 auto-stage 暂存目录（userStagedRoot）也不触发
 * 搬运，公开包用户即使本机有官方安装也拿不到 broker 凭据（fail-closed）。
 *
 * 失败语义：解析最终失败时抛出原始错误——调用方自行决定传播（helper host）还是
 * 收敛为 UNAVAILABLE env（spawn env）。成功结果缓存于实例：recipe 解析含打包资产
 * sha256 校验，agent 每次派生都重算会放大启动延迟；失败不缓存，给 auto-stage
 * 之后的下一次解析留恢复机会。
 */
export function createStableCuaWinRuntimeResolver(deps: {
  userStagedRoot?: string;
  attemptAutoStage: () => Promise<boolean>;
  resolveRuntime?: (
    options: StableCuaWinResolveOptions & { userStagedRoot?: string },
  ) => Promise<StableCuaWinRecipe>;
}) {
  const resolveRuntime = deps.resolveRuntime ?? resolveWindowsCuaRuntime;
  let cached: StableCuaWinRecipe | null = null;
  let failureLogged = false;
  const resolveOptions = (options: StableCuaWinResolveOptions) => ({
    ...options,
    userStagedRoot: deps.userStagedRoot,
  });
  const logFailure = (error: unknown): void => {
    if (failureLogged) return;
    failureLogged = true;
    logger.warn(
      undefined,
      `Windows CUA helper recipe unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  };
  return async (options: StableCuaWinResolveOptions): Promise<StableCuaWinRecipe> => {
    cached ??= await (async () => {
      try {
        return await resolveRuntime(resolveOptions(options));
      } catch (error) {
        if (error instanceof WindowsCuaDevRuntimeResolutionError) {
          if (await deps.attemptAutoStage()) {
            try {
              return await resolveRuntime(resolveOptions(options));
            } catch (retryError) {
              logFailure(retryError);
              throw retryError;
            }
          }
        }
        logFailure(error);
        throw error;
      }
    })();
    return cached;
  };
}
