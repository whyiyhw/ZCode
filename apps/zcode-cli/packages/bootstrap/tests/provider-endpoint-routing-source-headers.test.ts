import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch as readOsArch, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderEndpointRoutingSourceHeaders } from "../src/provider-endpoint-routing-source-headers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("createProviderEndpointRoutingSourceHeaders", () => {
  it("adds runtime attribution and reuses an existing deviceMid for the config GET", async () => {
    const dataBaseDir = await mkdtemp(
      join(tmpdir(), "zcode-routing-source-headers-"),
    );
    tempDirs.push(dataBaseDir);
    const stateDir = join(dataBaseDir, ".zcode", "v2");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "mid-routing-1" }),
      "utf8",
    );

    const headers = await createProviderEndpointRoutingSourceHeaders({
      appVersion: "1.2.3",
      env: {
        ZCODE_DATA_BASE_DIR: dataBaseDir,
        ZCODE_ENV: "test",
        ZCODE_TEST_BASE_URL: "https://routing-config.example.test",
      },
      sourceTitle: "electron",
    });

    // 社区版隐私基线（PRIVACY-AUDIT.md A2）：X-Client-Timezone / X-Os-Version 不属于路由
    // 配置拉取的服务端契约，默认不外发（仅 serverContract 计费链路携带）；X-Device-Mid
    // 默认不外发，仅 ZCODE_SEND_DEVICE_MID=true 显式开启时复用已有设备标识。
    expect(headers).toMatchObject({
      "HTTP-Referer": "https://routing-config.example.test",
      "User-Agent": "ZCode/1.2.3",
      "X-Client-Language": expect.any(String),
      "X-Os-Category": osCategory(process.platform),
      "X-Platform": `${process.platform}-${readOsArch()}`,
      "X-Release-Channel": "test",
      "X-Title": "Z Code@electron",
      "X-ZCode-App-Version": "1.2.3",
    });
    expect(headers).not.toHaveProperty("X-Client-Timezone");
    expect(headers).not.toHaveProperty("X-Os-Version");
    expect(headers).not.toHaveProperty("X-Device-Mid");
    expect(headers).not.toHaveProperty("Authorization");

    // ZCODE_SEND_DEVICE_MID=true（官方计费契约确需时的显式开关）下才复用已有 deviceMid；
    // 开关由 shared 侧 buildZCodeSourceHeadersFromContext 读全局 process.env 判定。
    const previousFlag = process.env.ZCODE_SEND_DEVICE_MID;
    process.env.ZCODE_SEND_DEVICE_MID = "true";
    try {
      const optedIn = await createProviderEndpointRoutingSourceHeaders({
        appVersion: "1.2.3",
        env: {
          ZCODE_DATA_BASE_DIR: dataBaseDir,
          ZCODE_ENV: "test",
          ZCODE_TEST_BASE_URL: "https://routing-config.example.test",
        },
        sourceTitle: "electron",
      });
      expect(optedIn).toMatchObject({ "X-Device-Mid": "mid-routing-1" });
    } finally {
      if (previousFlag === undefined) delete process.env.ZCODE_SEND_DEVICE_MID;
      else process.env.ZCODE_SEND_DEVICE_MID = previousFlag;
    }
  });

  it("defaults to CLI attribution and does not create a missing device identity", async () => {
    const dataBaseDir = await mkdtemp(
      join(tmpdir(), "zcode-routing-no-device-mid-"),
    );
    tempDirs.push(dataBaseDir);

    const headers = await createProviderEndpointRoutingSourceHeaders({
      env: {
        ZCODE_DATA_BASE_DIR: dataBaseDir,
        ZCODE_ENV: "production",
        ZCODE_APP_VERSION: "2.0.0",
      },
    });

    expect(headers).toMatchObject({
      "HTTP-Referer": "https://zcode.z.ai",
      "User-Agent": "ZCode/2.0.0",
      "X-Release-Channel": "production",
      "X-Title": "Z Code@cli",
    });
    expect(headers).not.toHaveProperty("X-Device-Mid");
  });
});

function osCategory(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}
