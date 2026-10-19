import { describe, expect, it, vi } from "vitest";
import { createStableCuaWinRuntimeResolver } from "#src/cua-permission-broker/stableCuaTransport.js";
import { WindowsCuaDevRuntimeResolutionError } from "#src/cua-permission-broker/windowsCuaDevRuntime.js";

const recipe = {
  command: "node.exe",
  entryPath: "C:/helper/dist/windows-helper.js",
  root: "C:/helper",
  addonPath: "C:/helper/build/Release/ax_native.node",
  commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
};

const resolutionError = () =>
  new WindowsCuaDevRuntimeResolutionError("invalid-runtime-manifest", "boom");

const options = { platform: "win32" as const, env: {} };

// 修复回归锚（2026-10-19）：spawn env 与 helper host 必须共用同一条
// 「三层路由 + auto-stage 一次恢复」解析，且成功缓存、失败不缓存。
describe("createStableCuaWinRuntimeResolver", () => {
  it("解析失败（ResolutionError）→ auto-stage 成功 → 重试成功返回 recipe", async () => {
    const resolveRuntime = vi
      .fn()
      .mockRejectedValueOnce(resolutionError())
      .mockResolvedValueOnce(recipe);
    const attemptAutoStage = vi.fn().mockResolvedValue(true);
    const resolve = createStableCuaWinRuntimeResolver({ attemptAutoStage, resolveRuntime });

    await expect(resolve(options)).resolves.toEqual(recipe);
    expect(resolveRuntime).toHaveBeenCalledTimes(2);
    expect(attemptAutoStage).toHaveBeenCalledTimes(1);
  });

  it("解析失败且 auto-stage 失败 → 抛原始错误", async () => {
    const error = resolutionError();
    const resolveRuntime = vi.fn().mockRejectedValue(error);
    const attemptAutoStage = vi.fn().mockResolvedValue(false);
    const resolve = createStableCuaWinRuntimeResolver({ attemptAutoStage, resolveRuntime });

    await expect(resolve(options)).rejects.toThrow(error);
    expect(resolveRuntime).toHaveBeenCalledTimes(1);
  });

  it("auto-stage 成功但重试仍失败 → 抛重试错误", async () => {
    const retryError = resolutionError();
    const resolveRuntime = vi
      .fn()
      .mockRejectedValueOnce(resolutionError())
      .mockRejectedValueOnce(retryError);
    const attemptAutoStage = vi.fn().mockResolvedValue(true);
    const resolve = createStableCuaWinRuntimeResolver({ attemptAutoStage, resolveRuntime });

    await expect(resolve(options)).rejects.toThrow(retryError);
    expect(resolveRuntime).toHaveBeenCalledTimes(2);
  });

  it("非 ResolutionError 不触发 auto-stage，直接抛出", async () => {
    const error = new Error("plain io error");
    const resolveRuntime = vi.fn().mockRejectedValue(error);
    const attemptAutoStage = vi.fn().mockResolvedValue(true);
    const resolve = createStableCuaWinRuntimeResolver({ attemptAutoStage, resolveRuntime });

    await expect(resolve(options)).rejects.toThrow(error);
    expect(attemptAutoStage).not.toHaveBeenCalled();
  });

  it("userStagedRoot 透传给底层解析", async () => {
    const resolveRuntime = vi.fn().mockResolvedValue(recipe);
    const resolve = createStableCuaWinRuntimeResolver({
      userStagedRoot: "C:/data/cua-helper-runtime",
      attemptAutoStage: vi.fn(),
      resolveRuntime,
    });

    await resolve(options);

    expect(resolveRuntime).toHaveBeenCalledWith({
      ...options,
      userStagedRoot: "C:/data/cua-helper-runtime",
    });
  });

  it("成功结果缓存；失败不缓存（下次重新解析，为 auto-stage 恢复留机会）", async () => {
    const resolveRuntime = vi.fn().mockResolvedValue(recipe);
    const resolve = createStableCuaWinRuntimeResolver({
      attemptAutoStage: vi.fn(),
      resolveRuntime,
    });

    await resolve(options);
    await resolve(options);
    expect(resolveRuntime).toHaveBeenCalledTimes(1);

    const failing = vi.fn().mockRejectedValue(resolutionError());
    const resolveFailing = createStableCuaWinRuntimeResolver({
      attemptAutoStage: vi.fn().mockResolvedValue(false),
      resolveRuntime: failing,
    });
    await expect(resolveFailing(options)).rejects.toThrow();
    await expect(resolveFailing(options)).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
