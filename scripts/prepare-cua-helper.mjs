#!/usr/bin/env node
// 从官方 ZCode 安装暂存 Computer Use Helper 运行时到本仓库 bundled-tools。
//
// 专有二进制只进本地构建机，不入库（.gitignore 排除）、不进公开 release
// （electron-builder 仅在 ZCODE_CUA_BUNDLE_HELPER 显式开启时才打包，CI 不设）。
// 校验与搬运逻辑复用 @zcode/zcode-cua/runtime-staging（与运行时 auto-stage 同一实现）。
//
// 用法：
//   node scripts/prepare-cua-helper.mjs                       # win32，自动探测官方安装
//   node scripts/prepare-cua-helper.mjs --source D:/soft/zcode
//   node scripts/prepare-cua-helper.mjs --platform darwin --source /path/to/ZCode.app
//   node scripts/prepare-cua-helper.mjs --force               # 同版本也重新暂存
import { statSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  findWindowsCuaHelperSource,
  stageCuaHelperRuntime,
} from "../packages/zcode-cua/runtime-staging.js";

const repoRoot = resolve(import.meta.dirname, "..");
const OFFICIAL_INSTALL_CANDIDATES = ["D:/soft/zcode", "C:/Program Files/ZCode"];

function parseArgs(argv) {
  const options = {
    platform: process.platform,
    source: process.env.ZCODE_CUA_HELPER_SOURCE,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--platform") options.platform = argv[++index];
    else if (arg === "--force") options.force = true;
    else {
      console.error(
        `用法: node scripts/prepare-cua-helper.mjs [--source <官方安装目录>] [--platform win32|darwin] [--force]`,
      );
      process.exit(2);
    }
  }
  return options;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function isRealDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function readDesktopElectronVersion() {
  const pkg = JSON.parse(await readFile(join(repoRoot, "packages/desktop/package.json"), "utf8"));
  return pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? null;
}

async function stageWindows(options) {
  // 手动 prepare 的探测面比 auto-stage 宽：显式 --source / env 之外还认
  // OFFICIAL_INSTALL_CANDIDATES（含本机构器自定义安装位）。
  const env = options.source
    ? { ...process.env, ZCODE_CUA_HELPER_SOURCE: options.source }
    : process.env;
  const sourceRuntime =
    (await findWindowsCuaHelperSource(env, {
      extraRoots: OFFICIAL_INSTALL_CANDIDATES,
      readRegistry: false,
    })) ?? (options.source ? join(options.source, "resources", "tools", "cua-helper") : null);
  if (!sourceRuntime || !isRealDirectory(sourceRuntime)) {
    fail(
      "未找到官方 ZCode 安装。用 --source <官方安装目录> 或设置 ZCODE_CUA_HELPER_SOURCE（目录内需有 resources/tools/cua-helper）。",
    );
  }
  const electronVersion = await readDesktopElectronVersion();
  const target = join(
    repoRoot,
    "packages/desktop/bundled-tools",
    `win32-${process.arch}`,
    "cua-helper",
  );
  try {
    const { staged, manifest } = await stageCuaHelperRuntime({
      sourceRoot: sourceRuntime,
      targetRoot: target,
      arch: process.arch,
      // 仓库 electron 与运行时不一致时产品路由会 fail-closed；这里提前拒绝并给出指引，
      // 但 dev 路由（ZCODE_CUA_DEV_ROOT）不校验 electron 版本，--force 可越过。
      electronVersion: options.force ? undefined : (electronVersion ?? undefined),
      force: options.force,
    });
    console.log(
      staged
        ? `✓ 已暂存 @zcode/zcode-cua ${manifest.packageVersion} → ${target}`
        : `✓ 已暂存 ${manifest.packageVersion}（${target}），版本一致跳过；--force 可强制重暂存。`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  await writeFile(
    join(target, ".cua-helper-staging.json"),
    `${JSON.stringify(
      {
        source: sourceRuntime,
        stagedAt: new Date().toISOString(),
        script: "scripts/prepare-cua-helper.mjs",
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `  dev 态由 packages/desktop/scripts/dev.mjs 自动设置 ZCODE_CUA_DEV_ROOT 指向该目录。`,
  );
}

async function stageDarwin(options) {
  const source = options.source ?? process.env.ZCODE_CUA_HELPER_SOURCE;
  if (!source) {
    fail(
      "darwin 暂存必须 --source 指向官方 macOS 安装根（目录内需有 resources/cua-helper/ZCode Computer Use.app）。",
    );
  }
  const sourceApp = join(source, "resources", "cua-helper", "ZCode Computer Use.app");
  if (!isRealDirectory(sourceApp)) fail(`${sourceApp} 不存在。`);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const target = join(repoRoot, "packages/desktop/bundled-tools", `darwin-${arch}`, "cua-helper");
  await rm(target, { recursive: true, force: true });
  await mkdir(join(repoRoot, "packages/desktop/bundled-tools", `darwin-${arch}`), {
    recursive: true,
  });
  await cp(join(source, "resources", "cua-helper"), target, { recursive: true });
  await writeFile(
    join(target, ".cua-helper-staging.json"),
    `${JSON.stringify({ source: join(source, "resources", "cua-helper"), stagedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`✓ 已暂存 macOS Helper.app → ${target}`);
  console.log("  注意：darwin 链路需真机验证（安装器 lipo/codesign/TeamID 校验）。");
}

const options = parseArgs(process.argv.slice(2));
if (options.platform === "win32") await stageWindows(options);
else if (options.platform === "darwin") await stageDarwin(options);
else fail(`不支持的平台：${options.platform}`);
