import { arch as readOsArch } from "node:os";
import { describe, expect, it } from "vitest";
import { createRuntimePlatformHeaders } from "../src/runtime-platform-headers.js";

describe("createRuntimePlatformHeaders", () => {
  it("builds runtime platform headers from the current agent runtime host", () => {
    const osCategory =
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

    // 社区版隐私基线（PRIVACY-AUDIT.md A4）：X-Os-Version（OS 内核版本）不外发，
    // 仅保留平台/架构类别，与 src/runtime-platform-headers.ts 的裁剪口径一致。
    expect(createRuntimePlatformHeaders()).toEqual({
      "X-Os-Category": osCategory,
      "X-Platform": `${process.platform}-${readOsArch()}`,
    });
    expect(createRuntimePlatformHeaders()).not.toHaveProperty("X-Os-Version");
  });
});
