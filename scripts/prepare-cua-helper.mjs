#!/usr/bin/env node
// 从官方 ZCode 安装暂存 Computer Use Helper 运行时到本仓库 bundled-tools。
//
// 专有二进制只进本地构建机，不入库（.gitignore 排除）、不进公开 release
// （electron-builder 仅在 ZCODE_CUA_BUNDLE_HELPER 显式开启时才打包，CI 不设）。
//
// 用法：
//   node scripts/prepare-cua-helper.mjs                       # win32，自动探测官方安装
//   node scripts/prepare-cua-helper.mjs --source D:/soft/zcode
//   node scripts/prepare-cua-helper.mjs --platform darwin --source /path/to/ZCode.app
//   node scripts/prepare-cua-helper.mjs --force               # 同版本也重新暂存
//
// 幂等：暂存记录落 <target>/.cua-helper-staging.json，entry/addon sha 一致时跳过。
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

async function sha256OfFile(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function isRealDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function detectWindowsSource() {
  for (const candidate of OFFICIAL_INSTALL_CANDIDATES) {
    if (isRealDirectory(join(candidate, "resources", "tools", "cua-helper"))) return candidate;
  }
  return null;
}

async function readDesktopElectronVersion() {
  const pkg = JSON.parse(await readFile(join(repoRoot, "packages/desktop/package.json"), "utf8"));
  return pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? null;
}

async function stageWindows(options) {
  const source = options.source ?? detectWindowsSource();
  if (!source) {
    fail(
      "未找到官方 ZCode 安装。用 --source <官方安装目录> 或设置 ZCODE_CUA_HELPER_SOURCE（目录内需有 resources/tools/cua-helper）。",
    );
  }
  const sourceRuntime = join(source, "resources", "tools", "cua-helper");
  if (!isRealDirectory(sourceRuntime)) fail(`${sourceRuntime} 不存在或不是目录。`);

  const manifestPath = join(sourceRuntime, "runtime-manifest.json");
  if (!existsSync(manifestPath)) fail(`${manifestPath} 缺失——这不是完整运行时目录。`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.packageName !== "@zcode/zcode-cua") {
    fail(`runtime-manifest.json 结构不符：${JSON.stringify(manifest).slice(0, 200)}`);
  }
  if (manifest.platform !== "win32")
    fail(`manifest platform=${manifest.platform}，与 win32 暂存不符。`);
  const hostArch = process.arch;
  if (manifest.arch !== hostArch) {
    fail(`manifest arch=${manifest.arch} 与本机 ${hostArch} 不符。`);
  }
  const electronVersion = await readDesktopElectronVersion();
  if (electronVersion && manifest.electronVersion !== electronVersion) {
    fail(
      `manifest electronVersion=${manifest.electronVersion} 与本仓库 electron ${electronVersion} 不一致；` +
        "产品路由会 fail-closed。请升级官方安装或对齐 electron 版本（dev 路由 ZCODE_CUA_DEV_ROOT 不校验 electron 版本，可继续）。",
    );
  }
  for (const [key, relative] of [
    ["entry", manifest.entry],
    ["addon", manifest.addon],
  ]) {
    const artifact = join(sourceRuntime, relative);
    if (!existsSync(artifact)) fail(`运行时缺 ${key}: ${artifact}`);
    const actual = await sha256OfFile(artifact);
    if (actual !== manifest.sha256[key]) {
      fail(
        `${key} sha256 不匹配（期望 ${manifest.sha256[key]}，实测 ${actual}）——运行时可能损坏。`,
      );
    }
  }

  const arch =
    manifest.arch === "x64"
      ? "x64"
      : manifest.arch === "arm64"
        ? "arm64"
        : fail(`未知 arch: ${manifest.arch}`);
  const target = join(repoRoot, "packages/desktop/bundled-tools", `win32-${arch}`, "cua-helper");
  const recordPath = join(target, ".cua-helper-staging.json");
  if (!options.force && existsSync(recordPath)) {
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    if (
      record.entrySha256 === manifest.sha256.entry &&
      record.addonSha256 === manifest.sha256.addon
    ) {
      console.log(
        `✓ 已暂存 ${manifest.packageVersion}（${target}），版本一致跳过；--force 可强制重暂存。`,
      );
      return;
    }
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(join(repoRoot, "packages/desktop/bundled-tools", `win32-${arch}`), {
    recursive: true,
  });
  await cp(sourceRuntime, target, { recursive: true });

  // dev 路由生产者契约：package.json 必须名为 @zcode/zcode-cua 且带
  // zcodeCuaRuntime{schema, windows{entry, nativeAddon}}（键集精确，见
  // windowsCuaDevRuntime.ts requireExpectedPackage）。产品路由读 runtime-manifest.json，
  // 已随目录复制。
  const packageJsonPath = join(target, "package.json");
  const pkg = existsSync(packageJsonPath)
    ? JSON.parse(await readFile(packageJsonPath, "utf8"))
    : {};
  pkg.name = "@zcode/zcode-cua";
  pkg.version = manifest.packageVersion;
  pkg.type = pkg.type ?? "module";
  pkg.zcodeCuaRuntime = {
    schema: 1,
    windows: { entry: manifest.entry, nativeAddon: manifest.addon },
  };
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

  await writeFile(
    recordPath,
    `${JSON.stringify(
      {
        packageVersion: manifest.packageVersion,
        source: sourceRuntime,
        stagedAt: new Date().toISOString(),
        electronVersion: manifest.electronVersion,
        entry: manifest.entry,
        entrySha256: manifest.sha256.entry,
        addonSha256: manifest.sha256.addon,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`✓ 已暂存 @zcode/zcode-cua ${manifest.packageVersion} → ${target}`);
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
