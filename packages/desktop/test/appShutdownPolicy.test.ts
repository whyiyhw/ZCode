import { describe, expect, it } from "vitest";
import {
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
} from "../src/main/appShutdownPolicy.js";

describe("app shutdown policy", () => {
  it("shortens frequent normal Windows shutdowns", () => {
    expect(resolveAppShutdownPolicy("normal", "win32")).toEqual({
      forceKillDelayMs: 4_000,
      waitTimeoutMs: 4_500,
    });
  });

  it("does not change non-Windows shutdown budgets", () => {
    expect(resolveAppShutdownPolicy("normal", "darwin")).toEqual({
      forceKillDelayMs: 7_500,
      waitTimeoutMs: 9_000,
    });
    expect(resolveAppShutdownPolicy("normal", "linux")).toEqual({
      forceKillDelayMs: 7_500,
      waitTimeoutMs: 9_000,
    });
  });

  it("selectAppShutdownPolicy 沿用活动退出类型并解析对应预算", () => {
    // 社区版口径（spec/auto-update-removal.md）：自动更新已删，退出原因只剩 "normal"，
    // selectAppShutdownPolicy 不再有 update-install 升级/防降级语义，只保留
    // activeKind 优先 + 平台预算解析。
    expect(selectAppShutdownPolicy("normal", "normal", "win32")).toEqual({
      kind: "normal",
      policy: { forceKillDelayMs: 4_000, waitTimeoutMs: 4_500 },
    });
    expect(selectAppShutdownPolicy(null, "normal", "darwin")).toEqual({
      kind: "normal",
      policy: { forceKillDelayMs: 7_500, waitTimeoutMs: 9_000 },
    });
  });
});
