import { describe, expect, it } from "vitest";
import {
  buildZCodeSourceHeadersFromContext,
  ZCODE_SOURCE_HEADERS,
} from "../src/zcode-source-headers.js";

describe("buildZCodeSourceHeadersFromContext", () => {
  it("builds the shared ZCode endpoint attribution headers", () => {
    expect(
      buildZCodeSourceHeadersFromContext({
        appVersion: " 2.14.0 ",
        arch: "arm64",
        clientLanguage: "zh-CN",
        clientTimezone: "Asia/Shanghai",
        deviceMid: "mid-1",
        endpointOrigin: "https://zcode.z.ai",
        osVersion: "Darwin 25.0.0",
        platform: "darwin",
        releaseChannel: "test",
        sourceTitle: "cli",
      }),
    ).toEqual({
      ...ZCODE_SOURCE_HEADERS,
      "HTTP-Referer": "https://zcode.z.ai",
      "User-Agent": "ZCode/2.14.0",
      "X-ZCode-App-Version": "2.14.0",
      "X-Title": "Z Code@cli",
      "X-Platform": "darwin-arm64",
      "X-Release-Channel": "test",
      "X-Client-Language": "zh-CN",
      "X-Os-Category": "macos",
      // 社区版隐私基线（PRIVACY-AUDIT.md A2/A3）：X-Client-Timezone / X-Os-Version /
      // X-Device-Mid 默认不外发，仅在 serverContract 计费链路携带
      // （覆盖见 zcodeSourceHeadersBillingContract.test.ts / telemetryDeviceMid.test.ts）。
    });
  });

  it("drops invalid optional values without emitting malformed headers", () => {
    const headers = buildZCodeSourceHeadersFromContext({
      appVersion: "bad\nversion",
      clientLanguage: "\n",
      clientTimezone: "",
      deviceMid: "bad\nmid",
      platform: "win32",
      sourceTitle: "electron",
    });

    expect(headers).toMatchObject({
      "User-Agent": "ZCode/unknown",
      "X-Client-Language": "unknown",
      "X-Os-Category": "windows",
      "X-Title": "Z Code@electron",
    });
    // 社区版隐私基线（PRIVACY-AUDIT.md A2）：默认链路不携带时区头。
    expect(headers).not.toHaveProperty("X-Client-Timezone");
    expect(headers).not.toHaveProperty("X-Device-Mid");
    expect(headers).not.toHaveProperty("X-ZCode-App-Version");
  });
});
