import { afterEach, describe, expect, it, vi } from "vitest";

// ZCODE_CUA_BUNDLE_HELPER 是本地出包显式带上 Windows CUA Helper 运行时的唯一口子：
// 开源占位包（zcodeCuaPlaceholder）默认不注入（公开 CI 口径），开关=1 时 extraResources
// 必须追加 tools/cua-helper 主树与 node_modules 两条映射，afterPack 的 Windows finalize
// 校验门同步打开。规范：packages/zcode-cua/spec/computer-use-restore.md 验收场景 3。
describe("electron-builder Windows CUA Helper 打包开关", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadExtraResourceTargets() {
    const { default: desktopBuilderConfig } = await import("../electron-builder.config.js");
    return (desktopBuilderConfig.extraResources ?? []).map((entry) => entry?.to);
  }

  it("占位包且未设开关：win32 目标也不注入 cua-helper 资源", async () => {
    vi.stubEnv("ZCODE_TARGET_OS", "win32");
    vi.stubEnv("ZCODE_TARGET_ARCH", "x64");
    vi.stubEnv("ZCODE_CUA_BUNDLE_HELPER", "");

    const targets = await loadExtraResourceTargets();

    expect(targets).not.toContain("tools/cua-helper");
    expect(targets).not.toContain("tools/cua-helper/node_modules");
  });

  it("ZCODE_CUA_BUNDLE_HELPER=1：注入主树与 node_modules 两条映射", async () => {
    vi.stubEnv("ZCODE_TARGET_OS", "win32");
    vi.stubEnv("ZCODE_TARGET_ARCH", "x64");
    vi.stubEnv("ZCODE_CUA_BUNDLE_HELPER", "1");

    const targets = await loadExtraResourceTargets();

    expect(targets).toContain("tools/cua-helper");
    expect(targets).toContain("tools/cua-helper/node_modules");
  });

  it("非 Windows 目标不注入 Windows cua-helper 资源映射", async () => {
    vi.stubEnv("ZCODE_TARGET_OS", "darwin");
    vi.stubEnv("ZCODE_TARGET_ARCH", "arm64");
    vi.stubEnv("ZCODE_CUA_BUNDLE_HELPER", "1");

    const targets = await loadExtraResourceTargets();

    expect(targets).not.toContain("tools/cua-helper");
  });
});
