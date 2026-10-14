import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { getModelIoDir, getProjectMemoryRoot } from "../src/app/paths.js";

describe("getProjectMemoryRoot", () => {
  it("uses an opaque workspace identity and the canonical memory suffix", () => {
    const first = getProjectMemoryRoot(
      "/tmp/zcode-cli",
      "/workspace/first",
      "  remote:ssh:host:/workspace/app  ",
    );
    const second = getProjectMemoryRoot(
      "/tmp/zcode-cli",
      "/workspace/second",
      "remote:ssh:host:/workspace/app",
    );

    // 期望原先写死 POSIX 分隔符；Windows 上宿主 path.join 返回反斜杠（`\tmp\...`）。
    // 期望值与实现同源（join）构造；project hash 源自 identity 字符串本身，跨平台不变。
    expect(first).toBe(
      join("/tmp/zcode-cli", "memories", "projects", "project-dce7d1610bbf24dd", "memory"),
    );
    expect(second).toBe(first);
  });

  it("normalizes the workspace path only when identity is absent", () => {
    const relativeRoot = getProjectMemoryRoot("/tmp/zcode-cli", ".");
    const absoluteRoot = getProjectMemoryRoot("/tmp/zcode-cli", resolve("."));
    const blankIdentityRoot = getProjectMemoryRoot("/tmp/zcode-cli", ".", "   ");

    expect(relativeRoot).toBe(absoluteRoot);
    expect(blankIdentityRoot).toBe(absoluteRoot);
    // 后缀分隔符在 POSIX 上是 `/`、Windows 上是 `\`（宿主 join 语义），两种都接受。
    expect(relativeRoot).toMatch(/[\\/]memories[\\/]projects[\\/].+[\\/]memory$/);
  });
});

describe("getModelIoDir", () => {
  it("derives debug and rollout from the configured CLI storage root", () => {
    // 期望写死 POSIX 分隔符在 Windows 上必败（getModelIoDir 用宿主 join，返回反斜杠）；
    // 期望值改用 join 构造，与实现保持同一分隔符口径。
    expect(getModelIoDir("/custom/storage/cli", true)).toBe(join("/custom/storage/cli", "debug"));
    expect(getModelIoDir("/custom/storage/cli", false)).toBe(join("/custom/storage/cli", "rollout"));
  });
});
