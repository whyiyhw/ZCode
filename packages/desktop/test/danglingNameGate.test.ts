import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 悬空名称门禁（v3.16.0 / v3.16.1 两次安装包启动崩溃的防复发闸）。
 *
 * 两次事故的根因：desktop 的 main/scheduler/preload 子工程曾不在根 typecheck 列表内，上游
 * 合并带回「调用了不存在符号」的代码（v3.16.0 的 readZCodeAgentTelemetryEnv、v3.16.1 的
 * createCredentialService）时，esbuild/tsup 不做类型检查，坏引用直接进安装包，一启动就在
 * main 进程抛 ReferenceError，且 dev 与单测都走不到。
 *
 * 现状：这三个子工程仍不在根 `pnpm typecheck` 列表内（还压着与启动安全无关的存量空检/窄化
 * 噪音），本测试是它们**当前唯一的类型边界**——只断言 TS2304/TS2552（Cannot find name，含
 * 「Did you mean」建议变体）/TS2305（no exported member）为零，这三类正是「引用了不存在
 * 符号」的崩溃类（v3.16.1 修复中 TS2552 一度被 TS2304 正则漏掉：desktopWindowLifecycle 的
 * browserWindowId 藏在关窗回调里）。存量噪音清零后应把三工程并入根 typecheck 并退役本闸。
 *
 * 已知盲区：`tsc -p` 按引用工程的构建产物（shared/services dist）解析跨包类型，shared 刚改
 * 未重建时 TS2305 可能漏报；shared 自身口径由根 typecheck（tsc -b）把关，此处不重复。
 */

const PROJECTS = [
  "tsconfig.main.json",
  "tsconfig.scheduler.json",
  "tsconfig.preload.json",
] as const;

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Windows 下 pnpm 是 .cmd shim，spawnSync 不带 shell 会 ENOENT 且极易被误判成「无违规」，
// 因此直接用 node 执行 typescript 的 tsc 入口，不经任何 shell。
const tscBinPath = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

function collectDanglingNameErrors(project: string): string[] {
  let output = "";
  try {
    output = execFileSync(process.execPath, [tscBinPath, "-p", project, "--noEmit"], {
      cwd: desktopRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
    });
  } catch (error) {
    // 存量类型错误会让 tsc 以非零码退出，stdout/stderr 里仍带着完整诊断，照常解析。
    const e = error as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    if (!output.trim()) {
      // tsc 本身没跑起来（命令/路径问题）必须显式失败，绝不能当「零违规」放行。
      throw new Error(`tsc 未产出任何诊断输出，门禁无法判定：${String(error)}`);
    }
  }
  return output
    .split(/\r?\n/)
    .filter((line) => /error TS(2304|2305|2552):/.test(line))
    .map((line) => line.trim());
}

describe("desktop 主进程三子工程悬空名称门禁", () => {
  it.each(PROJECTS)(
    "%s 不允许 TS2304/TS2552/TS2305（引用不存在的符号 = 打包版启动 ReferenceError）",
    (project) => {
      const errors = collectDanglingNameErrors(project);
      expect(
        errors,
        `发现悬空名称引用（同类问题曾导致 v3.16.0/v3.16.1 安装包启动崩溃）：\n${errors.join("\n")}`,
      ).toEqual([]);
    },
  );
});
