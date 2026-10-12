import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { buildZCodeSourceHeaders } from "../src/providers/sourceHeaders.js";
// 社区版：遥测整栈（telemetryCore）已删除，但 deviceMid 是 X-Device-Mid 计费契约红线，
// 本体保留在 device/deviceMid.ts；本测试只覆盖 deviceMid 本身的落盘与复用语义，
// 原「与 telemetry 上报共享身份」的集成用例随遥测栈一并删除。
import { ensureDeviceMid } from "../src/device/deviceMid.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("ensureTelemetryDeviceMid", () => {
  const tempDirs: string[] = [];

  function createIsolatedDataBaseDir(): { dataBaseDir: string; stateFile: string } {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-remote-device-mid-"));
    tempDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);
    return {
      dataBaseDir,
      stateFile: join(dataBaseDir, ".zcode", "v2", "telemetry-state.json"),
    };
  }

  afterEach(() => {
    setDataBaseDir(null);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("远端主机没有 telemetry-state.json 时，确保后计费契约来源头才带上同一个 X-Device-Mid", async () => {
    // 复现远端事故前提：全新主机没有任何进程写过 state 文件，来源头缺 X-Device-Mid。
    const { stateFile } = createIsolatedDataBaseDir();
    expect(existsSync(stateFile)).toBe(false);
    expect(buildZCodeSourceHeaders({ serverContract: true })["X-Device-Mid"]).toBeUndefined();

    const deviceMid = await ensureDeviceMid();

    expect(deviceMid).toMatch(UUID_PATTERN);
    expect(JSON.parse(readFileSync(stateFile, "utf-8"))).toEqual({ deviceMid });
    // 与 NodeApiClient 实际注入来源头的同一读取路径必须拿到同一个值。
    // 社区版隐私基线：X-Device-Mid 仅在 serverContract 计费契约链路携带，默认请求不发送。
    expect(buildZCodeSourceHeaders()["X-Device-Mid"]).toBeUndefined();
    expect(buildZCodeSourceHeaders({ serverContract: true })["X-Device-Mid"]).toBe(deviceMid);
  });

  it("已有 deviceMid 时复用现值，不改写 state 文件里的其他字段", async () => {
    const { stateFile } = createIsolatedDataBaseDir();
    mkdirSync(join(stateFile, ".."), { recursive: true });
    const existing = JSON.stringify(
      { deviceMid: "existing-device-mid", lastDailyActiveDate: "2026-09-12" },
      null,
      2,
    );
    writeFileSync(stateFile, existing, "utf-8");

    await expect(ensureDeviceMid()).resolves.toBe("existing-device-mid");

    expect(readFileSync(stateFile, "utf-8")).toBe(existing);
  });
});
