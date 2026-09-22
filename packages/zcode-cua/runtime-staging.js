import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Computer Use Helper 运行时的本机搬运（auto-stage）。
//
// 合规边界：只在用户机器上做**本机复制**——从该机器上已有的官方安装把运行时
// 搬到本应用的用户数据目录。不做任何网络下载（运行时无公开分发渠道）；公开
// CI 产物不携带运行时。spec：packages/zcode-cua/spec/computer-use-restore.md。
//
// 三条公开入口：
//   findWindowsCuaHelperSource(env)     发现本机官方安装（env 覆盖 → 注册表 → 标准路径）
//   verifyCuaHelperRuntime(root, opts)  校验运行时目录（manifest 结构 + sha256 实测）
//   stageCuaHelperRuntime(opts)         校验源 → 临时目录复制 → 补写生产者契约 → 原子落位

const MANIFEST_FILE = "runtime-manifest.json";
const RUNTIME_SEGMENTS = ["resources", "tools", "cua-helper"];
const AUTO_STAGE_DISABLE_VALUES = new Set(["0", "false", "off"]);

export class CuaRuntimeStagingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CuaRuntimeStagingError";
    this.code = code;
  }
}

/** 自动搬运默认开启；ZCODE_CUA_HELPER_AUTO_STAGE ∈ {0,false,off} 时关闭（手动 prepare 不受影响）。 */
export function isAutoStageEnabled(env = process.env) {
  const value = env.ZCODE_CUA_HELPER_AUTO_STAGE?.trim().toLowerCase();
  return !AUTO_STAGE_DISABLE_VALUES.has(value ?? "");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/** canonical 相对路径（正斜杠、无盘符/点段），与 windowsCuaDevRuntime 的判定一致。 */
function isCanonicalRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !/^[a-zA-Z]:/u.test(value) &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
  );
}

async function sha256OfFile(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function isRealDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 校验一个 Helper 运行时目录：runtime-manifest.json 的结构与 sha256 实测、
 * arch（必检）与 electronVersion（提供时必检）的精确匹配。
 * 返回解析后的 manifest；任何不符抛 CuaRuntimeStagingError（fail-closed，不猜）。
 */
export async function verifyCuaHelperRuntime(root, options = {}) {
  const manifestPath = join(root, MANIFEST_FILE);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new CuaRuntimeStagingError(
      "invalid_manifest",
      `${manifestPath} missing or not valid JSON.`,
    );
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageName !== "@zcode/zcode-cua" ||
    !isNonEmptyString(manifest.packageVersion) ||
    manifest.platform !== "win32" ||
    (manifest.arch !== "x64" && manifest.arch !== "arm64") ||
    !isNonEmptyString(manifest.electronVersion) ||
    !isCanonicalRelativePath(manifest.entry) ||
    !isCanonicalRelativePath(manifest.addon) ||
    manifest.entry === manifest.addon ||
    !manifest.sha256 ||
    !isHex64(manifest.sha256.entry) ||
    !isHex64(manifest.sha256.addon)
  ) {
    throw new CuaRuntimeStagingError(
      "invalid_manifest",
      `${manifestPath} does not satisfy the runtime manifest contract.`,
    );
  }
  if (options.arch && manifest.arch !== options.arch) {
    throw new CuaRuntimeStagingError(
      "arch_mismatch",
      `runtime arch ${manifest.arch} does not match ${options.arch}.`,
    );
  }
  if (options.electronVersion && manifest.electronVersion !== options.electronVersion) {
    throw new CuaRuntimeStagingError(
      "electron_mismatch",
      `runtime electronVersion ${manifest.electronVersion} does not match ${options.electronVersion}.`,
    );
  }
  for (const [key, relative] of [
    ["entry", manifest.entry],
    ["addon", manifest.addon],
  ]) {
    const artifact = join(root, relative);
    let hash;
    try {
      hash = await sha256OfFile(artifact);
    } catch {
      throw new CuaRuntimeStagingError("missing_artifact", `${key} artifact missing: ${artifact}`);
    }
    if (hash !== manifest.sha256[key]) {
      throw new CuaRuntimeStagingError(
        "integrity_mismatch",
        `${key} sha256 mismatch (expected ${manifest.sha256[key]}, got ${hash}).`,
      );
    }
  }
  return manifest;
}

function candidateInstallRoots(env = process.env) {
  const roots = [];
  if (isNonEmptyString(env.ZCODE_CUA_HELPER_SOURCE)) roots.push(env.ZCODE_CUA_HELPER_SOURCE.trim());
  if (isNonEmptyString(env.LOCALAPPDATA)) roots.push(join(env.LOCALAPPDATA, "Programs", "ZCode"));
  if (isNonEmptyString(env.ProgramFiles)) roots.push(join(env.ProgramFiles, "ZCode"));
  if (isNonEmptyString(env["ProgramFiles(x86)"]))
    roots.push(join(env["ProgramFiles(x86)"], "ZCode"));
  return roots;
}

// 注册表读取单独可注入，测试环境不碰真注册表。
function readRegistryInstallLocation(regQuery = defaultRegQuery) {
  if (process.platform !== "win32") return [];
  const locations = [];
  // 官方 NSIS 每用户安装常缺 InstallLocation；DisplayIcon / UninstallString 的
  // 可执行文件路径同样能定位安装根，一并解析。
  const valuePatterns = [
    /InstallLocation\s+REG_SZ\s+(\S.*)$/gimu,
    /DisplayIcon\s+REG_SZ\s+"?([^"\r\n]+?)"?\s*$/gimu,
    /UninstallString\s+REG_SZ\s+"?([^"\r\n]+?\.exe)"?\s*(?:\/.*)?$/gimu,
  ];
  for (const hive of ["HKCU", "HKLM"]) {
    for (const view of ["64", "32"]) {
      try {
        const output = regQuery(
          hive,
          `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
          view,
        );
        for (const pattern of valuePatterns) {
          for (const match of output.matchAll(pattern)) {
            const raw = match[1]?.trim();
            if (!raw) continue;
            // Uninstall/DisplayIcon 是文件路径：取目录；InstallLocation 已是目录。
            const location = raw.toLowerCase().endsWith(".exe") ? dirname(raw) : raw;
            if (location && location !== ".") locations.push(location);
          }
        }
      } catch {
        // 注册表键不存在或拒绝访问都属正常——回退路径候选。
      }
    }
  }
  return locations;
}

function defaultRegQuery(hive, key, view) {
  return execFileSync(
    "reg",
    ["query", `${hive}\\${key}`, "/s", `/reg:${view === "64" ? "64" : "32"}`],
    { encoding: "utf8", timeout: 5000, windowsHide: true },
  ).toString();
}

/**
 * 发现本机官方安装中的 Helper 运行时目录。
 * 优先级：ZCODE_CUA_HELPER_SOURCE 覆盖 → 注册表 InstallLocation → 标准安装路径。
 * 返回运行时目录（<安装根>/resources/tools/cua-helper）或 null。
 */
export async function findWindowsCuaHelperSource(env = process.env, options = {}) {
  const roots = [
    ...(options.extraRoots ?? []),
    ...candidateInstallRoots(env),
    ...(options.readRegistry === false ? [] : readRegistryInstallLocation(options.regQuery)),
  ];
  for (const root of roots) {
    const runtimeRoot = join(root, ...RUNTIME_SEGMENTS);
    if (existsSync(join(runtimeRoot, MANIFEST_FILE)) && (await isRealDirectory(runtimeRoot))) {
      return runtimeRoot;
    }
  }
  return null;
}

/**
 * 把源运行时搬运到目标目录（用户数据根下的 cua-helper-runtime）。
 * - 先整目录校验（verifyCuaHelperRuntime），坏源直接拒；
 * - 复制到兄弟临时目录后补写 package.json 生产者契约（name=@zcode/zcode-cua +
 *   zcodeCuaRuntime{schema, windows{entry, nativeAddon}}），再原子改名落位；
 * - 幂等：目标已存在且版本与 sha 一致时跳过（force 可强制）；
 * - 失败清理临时目录，不留半成品。
 */
export async function stageCuaHelperRuntime(options) {
  const { sourceRoot, targetRoot, arch, electronVersion, force = false } = options;
  if (!isNonEmptyString(sourceRoot) || !isNonEmptyString(targetRoot)) {
    throw new CuaRuntimeStagingError(
      "invalid_arguments",
      "sourceRoot and targetRoot are required.",
    );
  }
  const manifest = await verifyCuaHelperRuntime(sourceRoot, { arch, electronVersion });
  if (!force && existsSync(join(targetRoot, MANIFEST_FILE))) {
    try {
      const existing = await verifyCuaHelperRuntime(targetRoot, { arch });
      if (
        existing.packageVersion === manifest.packageVersion &&
        existing.sha256.entry === manifest.sha256.entry &&
        existing.sha256.addon === manifest.sha256.addon
      ) {
        return { staged: false, manifest };
      }
    } catch {
      // 目标损坏或版本陈旧 → 走重新搬运。
    }
  }
  const stagingRoot = `${targetRoot}.staging-${randomBytes(6).toString("hex")}`;
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    await mkdir(dirname(targetRoot), { recursive: true });
    await cp(sourceRoot, stagingRoot, { recursive: true });
    const packageJsonPath = join(stagingRoot, "package.json");
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
    // 落位前再验一次暂存副本，防止复制过程中磁盘损坏静默通过。
    await verifyCuaHelperRuntime(stagingRoot, { arch });
    const previousRoot = `${targetRoot}.previous-${randomBytes(4).toString("hex")}`;
    const hadPrevious = existsSync(targetRoot);
    if (hadPrevious) await rename(targetRoot, previousRoot);
    try {
      await rename(stagingRoot, targetRoot);
    } catch (error) {
      if (hadPrevious) await rename(previousRoot, targetRoot).catch(() => undefined);
      throw error;
    }
    if (hadPrevious)
      await rm(previousRoot, { recursive: true, force: true }).catch(() => undefined);
    return { staged: true, manifest };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** 用户数据根下自动搬运的目标目录名（由 services 侧拼完整路径）。 */
export const USER_STAGED_RUNTIME_DIR_NAME = "cua-helper-runtime";
