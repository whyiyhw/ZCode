/* eslint-disable max-lines -- darwin 生产线单一事实源：Helper 安装/验签/LaunchServices
   拉起/冷启动 rendezvous/生命周期恢复/孤儿收割/MCP 注入全部在本文件。契约逐段提取自
   官方 3.14.1 app.asar 的 /out/host/index.js（main/index.js 与 chunk-DLYU5YW3.js 补充），
   提取不到的细节做契约合理实现并标注 [契约推断，待真机验证]（清单见
   spec/computer-use-restore.md「迁移边界」）。Windows 侧常量（HELPER_ADDON_ENV /
   WINDOWS_DEV_CONTROL_PROTOCOL）保持原值——services 的 Windows 宿主链路在用。 */
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  constants as fsConstants,
  cp as copyFs,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat as statFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import {
  CuaHelperError,
  callBrokerMethod,
  mintBrokerSocketPath,
  probeHelperHealth,
} from "./broker.js";
import {
  DEV_HELPER_APP_NAME,
  DEV_CUA_HELPER_BUNDLE_ID,
  HELPER_APP_NAME,
  HELPER_BUNDLE_ID,
} from "./broker-helper-constants.js";

export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";

// ---------------------------------------------------------------------------
// darwin 工具路径与环境常量（官方 host bundle Xt 表原值）
// ---------------------------------------------------------------------------
const DARWIN_TOOLS = Object.freeze({
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  lipo: "/usr/sbin/lipo",
  lsof: "/usr/sbin/lsof",
  open: "/usr/bin/open",
  plist: "/usr/bin/plutil",
  plistBuddy: "/usr/libexec/PlistBuddy",
  ps: "/bin/ps",
  spctl: "/usr/sbin/spctl",
  syspolicyCheck: "/usr/bin/syspolicy_check",
  unzip: "/usr/bin/unzip",
  xattr: "/usr/bin/xattr",
});

const SANITIZED_HELPER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const HELPER_TEAM_IDENTIFIER = "8A5X4JJ39T";
const HELPER_RUNTIME_VERSION = "3.14.1";
const EMBEDDED_HELPER_BUILD_ID = "pipeline-291748-cead36fd";
const LAUNCHER_PID_ENV = "ZCODE_CUA_LAUNCHER_PID";
const INSTALL_VARIANT_ENV = "ZCODE_CUA_HELPER_INSTALL_VARIANT";
const INSTALL_VARIANTS = Object.freeze(["stable", "preview", "dev-desktop", "standalone"]);
const CUA_DEV_MODE_ENV = "ZCODE_CUA_DEV_MODE";
const ALLOW_UNSIGNED_LOCAL_ENV = "ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL";
const DEV_BROKER_EXPOSURE_ENV = "ZCODE_CUA_DEV_EXPOSE_BROKER";
const REFRESH_MARKER_ENV = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";
const PLUGIN_ID_ENV = "ZCODE_PLUGIN_ID";
const PLUGIN_AUTHORITY_ENV = "ZCODE_CUA_PLUGIN_AUTHORITY";
const PACKAGE_SPEC_ENV = "ZCODE_CUA_PACKAGE_SPEC";
const OFFICIAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";
const OFFICIAL_CUA_MCP_SERVER_NAME = "computer-use";
const OFFICIAL_PLUGIN_MCP_SERVER_NAME = "plugin:computer-use:computer-use";
const PERMISSION_BROKER_SOCKET_FLAG = "--permission-broker-socket";
const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
const HELPER_EXECUTABLE_BASENAME = HELPER_APP_NAME.replace(/\.app$/u, "");
const DEV_HELPER_EXECUTABLE_BASENAME = DEV_HELPER_APP_NAME.replace(/\.app$/u, "");
const INSTALL_META_FILE_NAME = ".zcode-cua-helper-meta.json";
const INSTALL_LOCK_FILE_NAME = ".zcode-cua-helper-install-lock";

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isTruthyFlag(value) {
  return value === "1" || value === "true" || value === "on";
}

function readFlag(env, key) {
  return isTruthyFlag(env?.[key]?.trim().toLowerCase());
}

function execFileText(cmd, args) {
  return new Promise((resolveExecution, rejectExecution) => {
    execFileCallback(cmd, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        rejectExecution(
          new Error(
            `${cmd} ${args.join(" ")} failed: ${messageOf(error)}${stderr ? `\n${stderr}` : ""}`,
          ),
        );
        return;
      }
      resolveExecution({ stdout, stderr });
    });
  });
}

function execFileOptional(cmd, args, env, timeoutMs) {
  return new Promise((resolveExecution) => {
    execFileCallback(cmd, args, { encoding: "utf8", env, timeout: timeoutMs }, (error) =>
      resolveExecution(error),
    );
  });
}

// ---------------------------------------------------------------------------
// 环境谓词（官方 isCuaLocalDevelopmentRuntime / dev 门 / 安装变体）
// ---------------------------------------------------------------------------

// 本包无构建期 define 注入，COMPILED_LOCAL_DEVELOPMENT_RUNTIME 以
// process.env.NODE_ENV!=="production" 兜底（与官方 host bundle 的回退分支一致；
// services 侧已验证两条判定在当前打包形态下逐字等价）。
const COMPILED_LOCAL_DEVELOPMENT_RUNTIME = process.env.NODE_ENV !== "production";

export function isCuaLocalDevelopmentRuntime(env = process.env, compiledLocalDevelopmentRuntime) {
  const compiled = compiledLocalDevelopmentRuntime ?? COMPILED_LOCAL_DEVELOPMENT_RUNTIME;
  return compiled && env.ZCODE_RUNTIME_ENV?.trim().toLowerCase() !== "production";
}

function isCuaDevModeRequested(env = process.env) {
  return readFlag(env, CUA_DEV_MODE_ENV);
}

function isUnsignedHelperLocalDevRequested(env = process.env) {
  return isCuaLocalDevelopmentRuntime(env)
    ? readFlag(env, ALLOW_UNSIGNED_LOCAL_ENV) || isCuaDevModeRequested(env)
    : false;
}

function isDevBrokerExposureEnabled(env) {
  if (!isCuaLocalDevelopmentRuntime(env ?? {})) return false;
  return readFlag(env, DEV_BROKER_EXPOSURE_ENV);
}

function isDevHelperMode(env) {
  if (!isCuaLocalDevelopmentRuntime(env)) return false;
  return readFlag(env, ALLOW_UNSIGNED_LOCAL_ENV) || isCuaDevModeRequested(env);
}

function resolveHelperAppName(env = process.env) {
  return isDevHelperMode(env) ? DEV_HELPER_APP_NAME : HELPER_APP_NAME;
}

function resolveLauncherPid(env = process.env) {
  const raw = env[LAUNCHER_PID_ENV];
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 1) return parsed;
  }
  return process.pid;
}

function resolveZcodeHome(env) {
  return env.ZCODE_HOME?.trim() || (env.HOME?.trim() ? join(env.HOME.trim(), ".zcode") : null);
}

function resolveCuaHelperInstallVariant(env = process.env) {
  const raw = env[INSTALL_VARIANT_ENV]?.trim();
  if (raw) return INSTALL_VARIANTS.includes(raw) ? raw : null;
  if (isCuaLocalDevelopmentRuntime(env)) return "dev-desktop";
  if (env.ZCODE_ENV?.trim().toLowerCase() === "test") return "preview";
  return "stable";
}

// 安装根：stable 直接用 ~/.zcode/computer-use；preview 用 preview/ 子目录；
// dev-desktop（或 Dev.app 名）用 dev/ 子目录。variant 非法时返回 null（安装拒绝）。
function resolveCuaHelperInstallRoot(env = process.env) {
  const home = resolveZcodeHome(env);
  if (!home) return null;
  const base = join(home, "computer-use");
  const variant = resolveCuaHelperInstallVariant(env);
  if (!variant) return null;
  if (variant === "dev-desktop" || resolveHelperAppName(env) === DEV_HELPER_APP_NAME) {
    return join(base, "dev");
  }
  if (variant === "preview") return join(base, "preview");
  return base;
}

function recognizedCuaHelperInstallRoots(env = process.env) {
  const home = resolveZcodeHome(env);
  if (!home) return [];
  const base = join(home, "computer-use");
  return [base, join(base, "dev"), ...INSTALL_VARIANTS.map((variant) => join(base, variant))];
}

function productHelperCandidatePaths(env = process.env) {
  const root = resolveCuaHelperInstallRoot(env);
  return root ? [join(root, resolveHelperAppName(env))] : [];
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveExpectedCuaHelperBundleId(env = process.env) {
  const dev = isCuaLocalDevelopmentRuntime(env);
  const explicit = dev ? env.ZCODE_CUA_HELPER_BUNDLE_ID?.trim() : undefined;
  if (explicit) return explicit;
  return dev && isUnsignedHelperLocalDevRequested(env)
    ? DEV_CUA_HELPER_BUNDLE_ID
    : HELPER_BUNDLE_ID;
}

function brokerRuntimeDir(env) {
  const xdg = env.XDG_RUNTIME_DIR;
  if (typeof xdg === "string" && xdg.trim().length > 0) return join(xdg, "zcode-cua");
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (typeof localAppData === "string" && localAppData.trim().length > 0) {
      return join(localAppData, "zcode", "cua-broker");
    }
    return join(homedir(), "AppData", "Local", "zcode", "cua-broker");
  }
  if (process.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
    return join("/tmp", `zcode-cua-${uid}`);
  }
  return join(homedir(), ".zcode", "cua-broker");
}

function isWindowsNamedPipePath(path) {
  return path.startsWith("\\\\.\\pipe\\");
}

// ---------------------------------------------------------------------------
// LaunchServices 拉起（open argv 构造 + 消毒 env）
// ---------------------------------------------------------------------------

const FLAG_ALLOW_UNSIGNED_LAUNCHER_LOCAL_DEV = "--allow-unsigned-launcher-local-dev";
const FLAG_ALLOW_EXTERNAL_BROKER_CLIENT_LOCAL_DEV = "--allow-external-broker-client-local-dev";
const FLAG_GHOST_CURSOR_OVERLAY = "--ghost-cursor-overlay";
const FLAG_BACKGROUND_MODE = "--background-mode";
const FLAG_PIP_MODE = "--pip-mode";
const FLAG_PIP_LIVE_PROBE = "--pip-live-probe";
const FLAG_GHOST_CURSOR_CAPTURE = "--ghost-cursor-capture";
const FLAG_CONTROLLER_VARIANT = "--controller-variant";
const FLAG_DISABLE_CPS_ACTIVATION = "--disable-cps-activation";
const FLAG_BROKER_LAUNCH_DEADLINE = "--broker-launch-deadline-epoch-ms";
const FLAG_BROKER_LAUNCH_CANCEL_FILE = "--broker-launch-cancel-file";
const FLAG_PERMISSION_PREFLIGHT = "--permission-preflight";
const FLAG_PERMISSION_PREFLIGHT_RESULT = "--permission-preflight-result-file";

function cpsActivationDisableRequested(env = process.env) {
  return readFlag(env, "ZCODE_CUA_DISABLE_CPS_ACTIVATION");
}

// open(1) argv：`open -n -g <app> --args --socket <path> ...`。
// 全部可选 flag 与官方 buildHelperOpenArgs 逐一对齐；新增参数必须先进 HelperLaunchSpec。
export function buildHelperOpenArgs(spec, launcherPid) {
  const args = ["-n", "-g", spec.appPath, "--args", "--socket", spec.socketPath];
  const version = spec.version?.trim();
  if (version) args.push("--version", version);
  const expectedBundlePath = spec.expectedAppBundlePath?.trim();
  if (expectedBundlePath) args.push("--expected-app-bundle-path", expectedBundlePath);
  if (spec.controllerVariant) args.push(FLAG_CONTROLLER_VARIANT, spec.controllerVariant);
  if (spec.disableCpsActivation) args.push(FLAG_DISABLE_CPS_ACTIVATION, "1");
  if (spec.brokerLaunchGuard) {
    if (!isSafeCuaHelperBrokerLaunchGuard(spec.socketPath, spec.brokerLaunchGuard)) {
      throw new CuaHelperError(
        "launch_failed",
        "Refusing to pass an unsafe Computer Use Helper broker launch guard to LaunchServices",
      );
    }
    args.push(
      FLAG_BROKER_LAUNCH_DEADLINE,
      String(spec.brokerLaunchGuard.deadlineEpochMs),
      FLAG_BROKER_LAUNCH_CANCEL_FILE,
      spec.brokerLaunchGuard.cancelFilePath,
    );
  }
  args.push("--exit-log", spec.exitLogPath?.trim() || `${spec.socketPath}.exit.log`);
  if (typeof launcherPid === "number" && Number.isInteger(launcherPid) && launcherPid > 0) {
    args.push("--launcher-pid", String(launcherPid));
  }
  if (spec.allowUnsignedLauncherLocalDev === true)
    args.push(FLAG_ALLOW_UNSIGNED_LAUNCHER_LOCAL_DEV);
  if (spec.allowExternalBrokerClientLocalDev === true) {
    args.push(FLAG_ALLOW_EXTERNAL_BROKER_CLIENT_LOCAL_DEV);
  }
  if (spec.ghostCursorOverlay === true) args.push(FLAG_GHOST_CURSOR_OVERLAY);
  if (spec.backgroundMode === true) args.push(FLAG_BACKGROUND_MODE);
  if (spec.pipMode === true) args.push(FLAG_PIP_MODE);
  if (spec.pipLiveProbe === true) args.push(FLAG_PIP_LIVE_PROBE);
  if (spec.ghostCursorCapture === true) args.push(FLAG_GHOST_CURSOR_CAPTURE);
  return args;
}

const ALLOWED_HELPER_LAUNCH_ENV_KEYS = new Set([
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "__CF_USER_TEXT_ENCODING",
  "ZCODE_CUA_PIP_DEBUG",
]);

function isAllowedHelperLaunchEnvKey(key) {
  const upper = key.toUpperCase();
  return ALLOWED_HELPER_LAUNCH_ENV_KEYS.has(upper) || upper.startsWith("LC_");
}

function sanitizeHelperLaunchEnv(env) {
  const source = env ?? process.env;
  const sanitized = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && isAllowedHelperLaunchEnvKey(key)) sanitized[key] = value;
  }
  sanitized.PATH = SANITIZED_HELPER_PATH;
  return sanitized;
}

const LAUNCH_SERVICES_TIMEOUT_MS = 10_000;

function isLaunchServicesTimeout(error, message) {
  if (
    /(?:_LSOpenURLsWithCompletionHandler|LaunchServices|AppleEvent).*(?:-1712|timed out)/iu.test(
      message,
    )
  ) {
    return true;
  }
  if (typeof error !== "object" || error === null) return false;
  const candidate = error;
  return (
    candidate.code === "ETIMEDOUT" || (candidate.killed === true && candidate.signal === "SIGKILL")
  );
}

function formatLaunchServicesErrorMessage(appPath, error) {
  const raw = messageOf(error);
  const base = `Failed to launch ${appPath} via LaunchServices (open): ${raw}`;
  if (!isLaunchServicesTimeout(error, raw)) return base;
  return `${base}
LaunchServices timed out after ${LAUNCH_SERVICES_TIMEOUT_MS}ms while dispatching ZCode Computer Use. This usually means macOS is still verifying the helper, Gatekeeper blocked first launch, the installed bundle still carries a quarantine attribute, or a stale running Helper instance prevented fresh broker arguments from being delivered. Ask the user to open ZCode's CUA readiness panel, reveal the helper, repair the helper install, or fully quit ZCode and retry; diagnostic command: xattr -dr com.apple.quarantine ${JSON.stringify(appPath)}`;
}

function openHelperApp(spec) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    try {
      spec.assertHelperUnchangedBeforeLaunch?.();
      execFileCallback(
        DARWIN_TOOLS.open,
        buildHelperOpenArgs(spec, resolveLauncherPid()),
        {
          env: sanitizeHelperLaunchEnv(spec.env),
          timeout: LAUNCH_SERVICES_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
        (error) => {
          if (error) {
            rejectLaunch(
              new CuaHelperError(
                "launch_failed",
                formatLaunchServicesErrorMessage(spec.appPath, error),
                {
                  cause: error,
                },
              ),
            );
            return;
          }
          resolveLaunch();
        },
      );
    } catch (error) {
      rejectLaunch(
        new CuaHelperError(
          "launch_failed",
          `Refusing to launch a changed ZCode Computer Use: ${messageOf(error)}`,
          { cause: error },
        ),
      );
    }
  });
}

function createLaunchServicesLauncher() {
  return {
    launch: async (spec) => {
      await openHelperApp(spec);
    },
  };
}

// ---------------------------------------------------------------------------
// broker 启动护栏（launch-cancel sentinel）：冷启动窗口内可撤销的启动凭证
// ---------------------------------------------------------------------------

const LAUNCH_GUARD_DIR_NAME = ".launch-cancel";
const LAUNCH_GUARD_MAX_HORIZON_MS = 300_000;
const LAUNCH_GUARD_CLEANUP_GRACE_MS = 5_000;
const LAUNCH_GUARD_SENTINEL_PATTERN =
  /^\.broker-launch-cancel-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sentinel$/u;

function hasAnchorableSocketPath(socketPath) {
  return !isWindowsNamedPipePath(socketPath) && isAbsolute(socketPath);
}

function guardAnchorDirectory(socketPath) {
  return isWindowsNamedPipePath(socketPath)
    ? brokerRuntimeDir(process.env)
    : dirname(resolve(socketPath));
}

function canonicalGuardDirectoryForSocket(socketPath) {
  if (!hasAnchorableSocketPath(socketPath)) return null;
  try {
    return join(realpathSync(guardAnchorDirectory(socketPath)), LAUNCH_GUARD_DIR_NAME);
  } catch {
    return null;
  }
}

function isSafeCuaHelperBrokerLaunchGuard(socketPath, guard) {
  if (
    !Number.isSafeInteger(guard.deadlineEpochMs) ||
    guard.deadlineEpochMs <= 0 ||
    !isAbsolute(guard.cancelFilePath) ||
    !LAUNCH_GUARD_SENTINEL_PATTERN.test(basename(guard.cancelFilePath))
  ) {
    return false;
  }
  const canonical = canonicalGuardDirectoryForSocket(socketPath);
  if (!canonical) return false;
  try {
    return realpathSync(dirname(resolve(guard.cancelFilePath))) === canonical;
  } catch {
    return false;
  }
}

async function prepareCuaHelperBrokerLaunchGuard(request) {
  const now = request.now ?? Date.now;
  if (
    !hasAnchorableSocketPath(request.socketPath) ||
    !Number.isSafeInteger(request.deadlineEpochMs) ||
    request.deadlineEpochMs <= now() ||
    request.deadlineEpochMs - now() > LAUNCH_GUARD_MAX_HORIZON_MS
  ) {
    throw new CuaHelperError(
      "launch_failed",
      "Refusing to prepare an unsafe Computer Use Helper broker launch guard",
    );
  }
  let anchor;
  try {
    const directory = guardAnchorDirectory(request.socketPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    anchor = await realpath(directory);
  } catch (error) {
    throw new CuaHelperError(
      "launch_failed",
      `Failed to resolve the Computer Use Helper broker runtime directory: ${messageOf(error)}`,
      { cause: error },
    );
  }
  const guardDirectory = join(anchor, LAUNCH_GUARD_DIR_NAME);
  await mkdir(guardDirectory, { recursive: true, mode: 0o700 });
  await chmod(guardDirectory, 0o700);
  if ((await realpath(guardDirectory)) !== guardDirectory) {
    throw new CuaHelperError(
      "launch_failed",
      "Refusing to use a redirected Computer Use Helper launch-cancel directory",
    );
  }
  const mintId = request.mintId ?? randomUUID;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = mintId().trim().toLowerCase();
    const candidate = {
      cancelFilePath: join(guardDirectory, `.broker-launch-cancel-${id}.sentinel`),
      deadlineEpochMs: request.deadlineEpochMs,
    };
    if (
      isSafeCuaHelperBrokerLaunchGuard(request.socketPath, candidate) &&
      !existsSync(candidate.cancelFilePath)
    ) {
      return candidate;
    }
  }
  throw new CuaHelperError(
    "launch_failed",
    "Failed to allocate a unique Computer Use Helper broker launch guard",
  );
}

function publishCuaHelperBrokerLaunchCancellation(socketPath, guard) {
  if (!isSafeCuaHelperBrokerLaunchGuard(socketPath, guard)) {
    throw new CuaHelperError(
      "termination_failed",
      "Refusing to publish an unsafe Computer Use Helper broker launch cancellation sentinel",
    );
  }
  try {
    writeFileSync(guard.cancelFilePath, "canceled\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST") return;
    throw error;
  }
}

async function cleanupCuaHelperBrokerLaunchGuard(guard) {
  await rm(guard.cancelFilePath, { force: true });
}

function scheduleCuaHelperBrokerLaunchGuardCleanup(guard, options = {}) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const delayMs = Math.max(1_000, guard.deadlineEpochMs - now() + LAUNCH_GUARD_CLEANUP_GRACE_MS);
  setTimer(() => {
    cleanupCuaHelperBrokerLaunchGuard(guard).catch(() => undefined);
  }, delayMs).unref?.();
}

// ---------------------------------------------------------------------------
// 权限刷新 marker（socketPath.permission-refresh.json）
// ---------------------------------------------------------------------------

export function cuaBrokerRefreshMarkerPath(socketPath) {
  const trimmed = socketPath.trim();
  if (!trimmed) {
    throw new Error("CUA broker refresh marker requires a non-empty socket path");
  }
  return `${trimmed}.permission-refresh.json`;
}

const REFRESH_MARKER_DEFAULT_DEADLINE_MS = 30_000;
const REFRESH_MARKER_MAX_DEADLINE_MS = 120_000;
const activeRefreshMarkers = new Map();

export async function publishCuaBrokerRefreshMarker(socketPath, options = {}) {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? REFRESH_MARKER_DEFAULT_DEADLINE_MS;
  if (
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > REFRESH_MARKER_MAX_DEADLINE_MS
  ) {
    throw new Error(
      `CUA broker refresh marker deadline must be within 1-${REFRESH_MARKER_MAX_DEADLINE_MS}ms, got ${deadlineMs}`,
    );
  }
  const markerPath = cuaBrokerRefreshMarkerPath(socketPath);
  if (activeRefreshMarkers.has(markerPath)) {
    throw new Error("CUA broker permission refresh is already active for this transport");
  }
  const markerIdentity = Symbol("cua-broker-refresh-marker");
  activeRefreshMarkers.set(markerPath, { id: markerIdentity });
  const startEpochMs = now();
  const deadlineEpochMs = startEpochMs + deadlineMs;
  if (
    !Number.isSafeInteger(startEpochMs) ||
    !Number.isSafeInteger(deadlineEpochMs) ||
    deadlineEpochMs <= startEpochMs
  ) {
    activeRefreshMarkers.delete(markerPath);
    throw new Error("CUA broker refresh marker clock produced an invalid deadline");
  }
  const payload = `${JSON.stringify({ schema: 1, kind: "permission_refresh", deadlineEpochMs })}\n`;
  const stagingPath = `${markerPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(stagingPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(stagingPath, 0o600);
    await rename(stagingPath, markerPath);
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    if (activeRefreshMarkers.get(markerPath)?.id === markerIdentity)
      activeRefreshMarkers.delete(markerPath);
    throw error;
  }
  return {
    path: markerPath,
    deadlineEpochMs,
    complete: async () => {
      if (activeRefreshMarkers.get(markerPath)?.id !== markerIdentity) return;
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await rm(markerPath, { force: true });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      if (lastError) throw lastError;
      if (activeRefreshMarkers.get(markerPath)?.id === markerIdentity) {
        activeRefreshMarkers.delete(markerPath);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 屏幕录制 preflight / 权限请求（经 LaunchServices）
// ---------------------------------------------------------------------------

const PREFLIGHT_TIMEOUT_MS = 8_000;
const PREFLIGHT_STATES = new Set(["granted", "denied", "unknown"]);

function buildHelperScreenRecordingPreflightOpenArgs(appPath, resultFilePath) {
  return [
    "-W",
    "-n",
    "-g",
    appPath,
    "--args",
    FLAG_PERMISSION_PREFLIGHT,
    "screen_recording",
    FLAG_PERMISSION_PREFLIGHT_RESULT,
    resultFilePath,
  ];
}

function parseHelperScreenRecordingPreflightResult(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.permission !== "screen_recording") return null;
  const state = parsed.state;
  return typeof state === "string" && PREFLIGHT_STATES.has(state) ? state : null;
}

function readHelperPreflightResultFile(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function removeHelperPreflightResultFile(path) {
  try {
    unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

async function readHelperScreenRecordingPreflightViaLaunchServices(request) {
  const dependencies = request.dependencies ?? {};
  const readResult = dependencies.readResult ?? readHelperPreflightResultFile;
  const removeResult = dependencies.removeResult ?? removeHelperPreflightResultFile;
  const timeoutMs = request.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  try {
    const launchError = await execFileOptional(
      DARWIN_TOOLS.open,
      buildHelperScreenRecordingPreflightOpenArgs(request.appPath, request.resultFilePath),
      sanitizeHelperLaunchEnv(request.env),
      timeoutMs,
    );
    return launchError
      ? null
      : parseHelperScreenRecordingPreflightResult(readResult(request.resultFilePath));
  } finally {
    removeResult(request.resultFilePath);
  }
}

// [契约推断，待真机验证] 无障碍权限请求：官方产物中没有同名入口（无障碍 TCC 由 Helper
// 进程自身在请求 AX API 时触发系统弹窗）。这里的契约合理实现：经 LaunchServices 拉起
// 已安装 Helper（不携带 broker 参数），让 Helper 进程触发系统 TCC 提示，open 接单即算
// 成功发起；失败按 reason 上抛。
export async function requestHelperAccessibilityPermissionViaLaunchServices(options = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "not_darwin" };
  }
  const appPath = options.appPath ?? firstExistingPath(productHelperCandidatePaths(process.env));
  if (!appPath) return { ok: false, reason: "helper_not_installed" };
  const launchError = await execFileOptional(
    DARWIN_TOOLS.open,
    ["-n", "-g", appPath],
    sanitizeHelperLaunchEnv(options.env),
    LAUNCH_SERVICES_TIMEOUT_MS,
  );
  return launchError ? { ok: false, reason: messageOf(launchError) } : { ok: true };
}

// 屏幕录制权限请求复用官方 preflight 链路（open -W -n -g --args --permission-preflight
// screen_recording --permission-preflight-result-file <tmp>）：state=granted 视为成功。
export async function requestHelperScreenRecordingPermissionViaLaunchServices(options = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "not_darwin" };
  }
  const appPath = options.appPath ?? firstExistingPath(productHelperCandidatePaths(process.env));
  if (!appPath) return { ok: false, reason: "helper_not_installed" };
  const resultFilePath =
    options.resultFilePath ??
    join(
      brokerRuntimeDir(process.env),
      SCREEN_RECORDING_PREFLIGHT_DIR,
      `.screen-recording-preflight-${randomUUID()}.json`,
    );
  try {
    await mkdir(dirname(resultFilePath), { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, reason: "result_directory_unavailable" };
  }
  const state = await readHelperScreenRecordingPreflightViaLaunchServices({
    appPath,
    resultFilePath,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (state === null) return { ok: false, reason: "preflight_failed" };
  return state === "granted" ? { ok: true } : { ok: false, reason: state };
}

// ---------------------------------------------------------------------------
// Helper 权限主体身份（TCC 授权对象）：PlistBuddy 直读 Info.plist
// ---------------------------------------------------------------------------

function plistValue(appPath, key) {
  return new Promise((resolveValue, rejectValue) => {
    execFileCallback(
      DARWIN_TOOLS.plistBuddy,
      ["-c", `Print :${key}`, join(appPath, "Contents", "Info.plist")],
      { encoding: "utf8", env: sanitizeHelperLaunchEnv(undefined), timeout: 2_000 },
      (error, stdout) => {
        if (error) {
          rejectValue(error);
          return;
        }
        resolveValue(stdout.trim());
      },
    );
  });
}

export async function resolveHelperPermissionSubjectIdentity(appPath) {
  const canonicalAppPath = await realpath(appPath);
  const [bundleId, displayName, executableName] = await Promise.all([
    plistValue(canonicalAppPath, "CFBundleIdentifier"),
    plistValue(canonicalAppPath, "CFBundleDisplayName"),
    plistValue(canonicalAppPath, "CFBundleExecutable"),
  ]);
  const resolvedDisplayName = displayName.trim() || basename(canonicalAppPath, ".app");
  if (!bundleId.trim() || !resolvedDisplayName || !executableName.trim()) {
    throw new CuaHelperError(
      "verification_failed",
      `ZCode Computer Use Info.plist is missing its permission identity at ${canonicalAppPath}`,
    );
  }
  const executablePath = await realpath(
    join(canonicalAppPath, "Contents", "MacOS", executableName.trim()),
  );
  return {
    appPath: canonicalAppPath,
    executablePath,
    displayName: resolvedDisplayName,
    bundleId: bundleId.trim(),
  };
}

// ---------------------------------------------------------------------------
// 安装器：安装计划 / 验签依赖 / 安装租约 / 暂存 / 提升 / 元数据
// ---------------------------------------------------------------------------

function normalizeHelperPlatform(value) {
  switch (value.toLowerCase()) {
    case "mac":
    case "macos":
    case "osx":
    case "darwin":
      return "darwin";
    default:
      return value;
  }
}

function normalizeHelperArch(value) {
  switch (value.toLowerCase()) {
    case "aarch64":
    case "arm64":
      return "arm64";
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    default:
      throw new CuaHelperError("install_failed", `Unsupported ZCode Computer Use arch: ${value}`);
  }
}

function normalizeHelperBuildId(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(trimmed)) {
    throw new CuaHelperError(
      "install_failed",
      "ZCODE_CUA_HELPER_BUILD_ID must use 1-128 ASCII letters, digits, dots, underscores, or hyphens",
    );
  }
  return trimmed;
}

function resolveExpectedCuaHelperBuildId(
  env = process.env,
  embeddedBuildId = EMBEDDED_HELPER_BUILD_ID,
) {
  const explicit = isCuaLocalDevelopmentRuntime(env)
    ? env.ZCODE_CUA_HELPER_BUILD_ID?.trim()
    : undefined;
  return normalizeHelperBuildId(explicit ?? embeddedBuildId);
}

function redactHelperDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const segments = (url.split(/[?#]/u)[0] ?? url).split("/");
    return segments[segments.length - 1] || "<redacted-url>";
  }
}

// 安装计划（官方 resolveCuaHelperInstallPlan）。下载源只认显式 env 覆盖——官方把默认
// 下载基址钉在内网制品服务上，本仓库红线是不得把内部服务地址写进源码（AGENTS.md 日志
// 节），未配置覆盖时直接 fail-closed 并给出指引，不回退任何内置地址。
function resolveCuaHelperInstallPlan(options = {}) {
  const env = options.env ?? process.env;
  const dev = isCuaLocalDevelopmentRuntime(env);
  const platform = normalizeHelperPlatform(
    (dev ? (options.targetPlatform ?? env.ZCODE_TARGET_OS) : undefined) ?? process.platform,
  );
  if (platform !== "darwin") {
    throw new CuaHelperError(
      "install_failed",
      `ZCode Computer Use auto-install is only supported on macOS, got ${platform}`,
    );
  }
  const arch = normalizeHelperArch(
    (dev ? (options.targetArch ?? env.ZCODE_TARGET_ARCH ?? env.npm_config_arch) : undefined) ??
      process.arch,
  );
  const version = dev
    ? options.version?.trim() || env.ZCODE_CUA_HELPER_VERSION?.trim() || "0.0.0"
    : HELPER_RUNTIME_VERSION;
  if (!resolveZcodeHome(env)) {
    throw new CuaHelperError(
      "install_failed",
      "Cannot resolve ${ZCODE_HOME:-$HOME/.zcode}; set ZCODE_HOME or HOME before installing ZCode Computer Use.",
    );
  }
  const platformKey = `${platform}-${arch}`;
  const expectedBuildId = resolveExpectedCuaHelperBuildId(env, options.embeddedBuildId);
  if (!dev && !expectedBuildId) {
    throw new CuaHelperError(
      "install_failed",
      "Packaged ZCode is missing its embedded Computer Use Helper build identity; refusing an unpinned Helper install",
    );
  }
  const bundledAppPath = options.bundledAppPath?.trim() || null;
  if (!dev && !bundledAppPath) {
    throw new CuaHelperError(
      "install_failed",
      "Packaged ZCode is missing its bundled ZCode Computer Use.app path",
    );
  }
  let source;
  if (bundledAppPath) {
    source = { kind: "bundled", appPath: bundledAppPath };
  } else {
    const fileName = `ZCode-CUA-Helper-${version}-mac-${arch}.zip`;
    const explicitUrl = env.ZCODE_CUA_HELPER_DOWNLOAD_URL?.trim();
    const baseUrl = env.ZCODE_CUA_HELPER_DOWNLOAD_BASE_URL?.trim().replace(/\/+$/u, "");
    if (!explicitUrl && !baseUrl) {
      throw new CuaHelperError(
        "install_failed",
        "ZCode Computer Use download source is not configured; set ZCODE_CUA_HELPER_DOWNLOAD_URL or ZCODE_CUA_HELPER_DOWNLOAD_BASE_URL, or provision resources/cua-helper with the bundled .app.",
      );
    }
    source = {
      kind: "download",
      fileName,
      url: explicitUrl || `${baseUrl}/${expectedBuildId ?? ""}/${fileName}`,
    };
  }
  const installRoot = resolveCuaHelperInstallRoot(env);
  if (!installRoot) {
    throw new CuaHelperError(
      "install_failed",
      `Cannot resolve a safe Computer Use Helper install root from ${INSTALL_VARIANT_ENV}.`,
    );
  }
  return {
    version,
    platform,
    arch,
    platformKey,
    installRoot,
    appPath: join(installRoot, resolveHelperAppName(env)),
    source,
    expectedBundleId: resolveExpectedCuaHelperBundleId(env),
    expectedTeamIdentifier: dev
      ? env.ZCODE_CUA_HELPER_TEAM_ID?.trim() || HELPER_TEAM_IDENTIFIER
      : HELPER_TEAM_IDENTIFIER,
    expectedBuildId,
    allowUnsignedLocalDev: isUnsignedHelperLocalDevRequested(env),
  };
}

// Mach-O 架构读取：fork spec 口径是 /usr/sbin/lipo -archs 子进程封装（官方 host bundle
// 实际内联了等价的 Mach-O 头解析器；两者输出同一架构集合，lipo 路线便于注入替换与
// cuaHelperInstaller.ts 的归一化包装）。
async function lipoReadExecutableArchs(executablePath) {
  if (process.platform !== "darwin") {
    throw new CuaHelperError(
      "verification_failed",
      `Reading Computer Use Helper executable archs requires macOS (lipo); got ${process.platform}`,
    );
  }
  const { stdout } = await execFileText(DARWIN_TOOLS.lipo, ["-archs", executablePath]);
  return stdout
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function codesignVerifyCodeSignature(appPath) {
  if (process.platform !== "darwin") {
    throw new CuaHelperError(
      "verification_failed",
      `Verifying the Computer Use Helper code signature requires macOS (codesign); got ${process.platform}`,
    );
  }
  await execFileText(DARWIN_TOOLS.codesign, ["--verify", "--deep", "--strict", appPath]);
}

async function codesignVerifyTeamIdentifier(appPath) {
  if (process.platform !== "darwin") {
    throw new CuaHelperError(
      "verification_failed",
      `Inspecting the Computer Use Helper TeamIdentifier requires macOS (codesign); got ${process.platform}`,
    );
  }
  const { stdout, stderr } = await execFileText(DARWIN_TOOLS.codesign, [
    "-dv",
    "--verbose=4",
    appPath,
  ]);
  const raw = `${stdout}\n${stderr}`;
  const teamIdentifier = raw.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() || null;
  return teamIdentifier === "not set" ? null : teamIdentifier;
}

async function plutilReadBundleInfo(appPath) {
  const { stdout } = await execFileText(DARWIN_TOOLS.plist, [
    "-convert",
    "json",
    "-o",
    "-",
    join(appPath, "Contents", "Info.plist"),
  ]);
  const parsed = JSON.parse(stdout);
  const readString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    bundleId: readString(parsed.CFBundleIdentifier),
    version: readString(parsed.CFBundleShortVersionString),
    buildVersion: readString(parsed.CFBundleVersion),
    executableName: readString(parsed.CFBundleExecutable),
    buildId: readString(parsed.ZCodeCUAHelperBuildId),
  };
}

async function spctlAssessGatekeeper(appPath) {
  // 优先 syspolicy_check（新系统）；不存在时回退 spctl。
  if (existsSync(DARWIN_TOOLS.syspolicyCheck)) {
    await execFileText(DARWIN_TOOLS.syspolicyCheck, ["distribution", appPath]);
    return;
  }
  await execFileText(DARWIN_TOOLS.spctl, ["-a", "-vv", "-t", "exec", appPath]);
}

export const defaultCuaHelperVerifierDependencies = {
  readExecutableArchs: lipoReadExecutableArchs,
  verifyCodeSignature: codesignVerifyCodeSignature,
  verifyTeamIdentifier: codesignVerifyTeamIdentifier,
  readBundleInfo: plutilReadBundleInfo,
  assessGatekeeper: spctlAssessGatekeeper,
};

function isExpectedHelperVersion(bundleInfo, expectedVersion) {
  if (expectedVersion === undefined) return true;
  return bundleInfo.version === expectedVersion && bundleInfo.buildVersion === expectedVersion;
}

function describeHelperVersionMismatch(bundleInfo, expectedVersion) {
  const version = bundleInfo.version ?? "<missing>";
  const buildVersion = bundleInfo.buildVersion ?? "<missing>";
  return `${HELPER_APP_NAME} version mismatch: expected short/build ${expectedVersion}, got short ${version}, build ${buildVersion}`;
}

// bundle 验签（官方 verifyCuaHelperBundle）：bundleId / 版本 / buildId / 可执行架构 /
// 代码签名 / TeamID / Gatekeeper。dev 未签名模式放宽到「尽力 inspect」。
async function verifyCuaHelperBundle(appPath, plan, dependencies, options = {}) {
  const bundleInfo = await dependencies.readBundleInfo(appPath);
  if (bundleInfo.bundleId !== plan.expectedBundleId) {
    throw new CuaHelperError(
      "verification_failed",
      `${HELPER_APP_NAME} bundle id ${bundleInfo.bundleId ?? "<missing>"} does not match ${plan.expectedBundleId}`,
    );
  }
  const expectedVersion = plan.source.kind === "bundled" ? undefined : plan.version;
  if (!isExpectedHelperVersion(bundleInfo, expectedVersion)) {
    throw new CuaHelperError(
      "verification_failed",
      describeHelperVersionMismatch(bundleInfo, plan.version),
    );
  }
  if (plan.expectedBuildId && bundleInfo.buildId !== plan.expectedBuildId) {
    throw new CuaHelperError(
      "verification_failed",
      `${HELPER_APP_NAME} build id ${bundleInfo.buildId ?? "<missing>"} does not match ${plan.expectedBuildId}`,
    );
  }
  if (!bundleInfo.executableName) {
    throw new CuaHelperError(
      "verification_failed",
      `${HELPER_APP_NAME} Info.plist is missing CFBundleExecutable`,
    );
  }
  const executablePath = join(appPath, "Contents", "MacOS", bundleInfo.executableName);
  const archs = await dependencies.readExecutableArchs(executablePath);
  if (!archs.includes(plan.arch)) {
    throw new CuaHelperError(
      "verification_failed",
      `${HELPER_APP_NAME} executable archs [${archs.join(", ") || "<none>"}] do not include ${plan.arch}`,
    );
  }
  if (plan.allowUnsignedLocalDev) {
    const teamIdentifier = await dependencies.verifyTeamIdentifier(appPath).catch(() => null);
    return { bundleInfo, teamIdentifier, releaseEligible: false, mode: "local_dev_unsigned" };
  }
  await dependencies.verifyCodeSignature(appPath);
  const teamIdentifier = await dependencies.verifyTeamIdentifier(appPath);
  if (!teamIdentifier) {
    throw new CuaHelperError(
      "verification_failed",
      `${HELPER_APP_NAME} is not signed with a stable Apple TeamIdentifier`,
    );
  }
  if (!plan.expectedTeamIdentifier) {
    throw new CuaHelperError(
      "verification_failed",
      `${HELPER_APP_NAME} release verification requires a pinned Apple TeamIdentifier; refusing to trust an unpinned signing team as the TCC owner`,
    );
  }
  if (teamIdentifier !== plan.expectedTeamIdentifier) {
    throw new CuaHelperError(
      "verification_failed",
      `${HELPER_APP_NAME} TeamIdentifier ${teamIdentifier} does not match ${plan.expectedTeamIdentifier}`,
    );
  }
  if (!options.skipGatekeeperAssessment) await dependencies.assessGatekeeper(appPath);
  return { bundleInfo, teamIdentifier, releaseEligible: true, mode: "release" };
}

// 安装租约：installRoot 下的属主独占锁文件（darwin O_EXLOCK）。
function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwnedSecureDirectory(path, info) {
  const uid = currentUid();
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (uid !== undefined && info.uid !== uid) ||
    (Number(info.mode) & 0o022) !== 0
  ) {
    throw new CuaHelperError(
      "install_failed",
      `Refusing insecure ZCode Computer Use install-lock directory ${path}; it must be a real owner-controlled directory without group/other write access`,
    );
  }
}

function assertOwnedSecureLockFile(path, info) {
  const uid = currentUid();
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.nlink !== 1 ||
    (uid !== undefined && info.uid !== uid) ||
    (Number(info.mode) & 0o511) !== 0o600
  ) {
    throw new CuaHelperError(
      "install_failed",
      `Refusing insecure ZCode Computer Use install lock ${path}; it must be a real owner-only regular file with exactly one link`,
    );
  }
}

class HelperInstallLockContendedError extends Error {
  constructor(path) {
    super(`ZCode Computer Use install lock is held by another owner: ${path}`);
    this.name = "HelperInstallLockContendedError";
  }
}

function isLockContendedError(error) {
  const code = error?.code;
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

async function prepareHelperInstallLockFile(installRoot) {
  const canonicalRoot = await realpath(installRoot).catch((error) => {
    throw new CuaHelperError(
      "install_failed",
      `Cannot resolve ZCode Computer Use install-lock directory ${installRoot}: ${messageOf(error)}`,
      { cause: error },
    );
  });
  assertOwnedSecureDirectory(installRoot, await lstat(installRoot));
  const lockPath = join(installRoot, INSTALL_LOCK_FILE_NAME);
  // darwin 专属 O_EXLOCK（排他文件锁）；node 在 darwin 上从 fs.constants 导出。
  const O_EXLOCK_FLAG = fsConstants.O_EXLOCK ?? 0x00200000;
  const exclusiveFlags =
    fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | O_EXLOCK_FLAG | fsConstants.O_NONBLOCK;
  let handle;
  try {
    handle = await openFile(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | exclusiveFlags,
      0o600,
    );
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw new CuaHelperError(
        "install_failed",
        `Cannot create ZCode Computer Use install lock ${lockPath}: ${messageOf(error)}`,
        { cause: error },
      );
    }
    try {
      assertOwnedSecureLockFile(lockPath, await lstat(lockPath));
      handle = await openFile(lockPath, exclusiveFlags);
    } catch (contended) {
      if (isLockContendedError(contended)) throw new HelperInstallLockContendedError(lockPath);
      throw new CuaHelperError(
        "install_failed",
        `Refusing unsafe ZCode Computer Use install lock ${lockPath}: ${messageOf(contended)}`,
        { cause: contended },
      );
    }
  }
  try {
    const [handleStat, linkStat, canonicalLock] = await Promise.all([
      handle.stat(),
      lstat(lockPath),
      realpath(lockPath),
    ]);
    assertOwnedSecureLockFile(lockPath, handleStat);
    assertOwnedSecureLockFile(lockPath, linkStat);
    if (
      canonicalLock !== join(canonicalRoot, INSTALL_LOCK_FILE_NAME) ||
      handleStat.dev !== linkStat.dev ||
      handleStat.ino !== linkStat.ino
    ) {
      throw new CuaHelperError(
        "install_failed",
        `ZCode Computer Use install lock changed while it was being opened: ${lockPath}`,
      );
    }
    return { lockPath, identity: { device: linkStat.dev, inode: linkStat.ino }, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertInstallLeaseDescriptorHeld(lease, released) {
  if (released) {
    throw new CuaHelperError(
      "install_failed",
      "ZCode Computer Use install lease has already been released",
    );
  }
  try {
    const handleStat = fstatSync(lease.handle.fd);
    const linkStat = lstatSync(lease.lockPath);
    assertOwnedSecureLockFile(lease.lockPath, handleStat);
    assertOwnedSecureLockFile(lease.lockPath, linkStat);
    if (
      handleStat.dev !== lease.identity.device ||
      handleStat.ino !== lease.identity.inode ||
      linkStat.dev !== lease.identity.device ||
      linkStat.ino !== lease.identity.inode
    ) {
      throw new CuaHelperError(
        "install_failed",
        `ZCode Computer Use install lock changed while its lease was held: ${lease.lockPath}`,
      );
    }
  } catch (error) {
    if (error instanceof CuaHelperError) throw error;
    throw new CuaHelperError(
      "install_failed",
      `ZCode Computer Use install lease is no longer verifiable: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

function delayWithAbort(ms, signal) {
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(
        new CuaHelperError(
          "install_failed",
          "ZCode Computer Use install lease acquisition was aborted",
        ),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireLockedInstallLockFile(installRoot, waitTimeoutMs, signal) {
  const deadline = Date.now() + waitTimeoutMs;
  for (;;) {
    if (signal?.aborted) {
      throw new CuaHelperError(
        "install_failed",
        "ZCode Computer Use install lease acquisition was aborted",
      );
    }
    try {
      return await prepareHelperInstallLockFile(installRoot);
    } catch (error) {
      if (!(error instanceof HelperInstallLockContendedError)) throw error;
      if (Date.now() >= deadline) {
        throw new CuaHelperError(
          "install_failed",
          `Failed to acquire ZCode Computer Use install lease: timed out after ${waitTimeoutMs}ms; ${error.message}`,
          { cause: error },
        );
      }
      await delayWithAbort(50, signal);
    }
  }
}

async function acquireMacOSCuaHelperInstallLease(plan, options = {}) {
  if (process.platform !== "darwin") {
    throw new CuaHelperError(
      "install_failed",
      `ZCode Computer Use install lease requires macOS (O_EXLOCK); got ${process.platform}`,
    );
  }
  if (options.signal?.aborted) {
    throw new CuaHelperError(
      "install_failed",
      "ZCode Computer Use install lease acquisition was aborted",
    );
  }
  const waitTimeoutMs =
    typeof options.waitTimeoutMs === "number" &&
    Number.isFinite(options.waitTimeoutMs) &&
    options.waitTimeoutMs > 0
      ? options.waitTimeoutMs
      : 120_000;
  const lease = await acquireLockedInstallLockFile(plan.installRoot, waitTimeoutMs, options.signal);
  try {
    const lockStat = await lstat(lease.lockPath);
    assertOwnedSecureLockFile(lease.lockPath, lockStat);
    if (lockStat.dev !== lease.identity.device || lockStat.ino !== lease.identity.inode) {
      throw new CuaHelperError(
        "install_failed",
        `ZCode Computer Use install lock changed before its lease was used: ${lease.lockPath}`,
      );
    }
  } catch (error) {
    await lease.handle.close().catch(() => undefined);
    throw error instanceof CuaHelperError
      ? error
      : new CuaHelperError(
          "install_failed",
          `Failed to acquire ZCode Computer Use install lease: ${messageOf(error)}`,
          { cause: error },
        );
  }
  let released = false;
  let releasePromise;
  return {
    assertHeld: () => assertInstallLeaseDescriptorHeld(lease, released),
    release: () => {
      releasePromise ??= (async () => {
        if (!released) {
          await lease.handle.close();
          released = true;
        }
      })();
      return releasePromise;
    },
  };
}

// zip 安全：先 unzip -Z1 列条目拒绝绝对/.. 逃逸，再 ditto -x -k 解压，最后符号链接
// 逃逸检查。
function isUnsafeZipEntryName(name) {
  return (
    name.length === 0 ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(name) ||
    name.split(/[\\/]/u).some((segment) => segment === "..")
  );
}

async function assertSafeZipArchiveEntries(zipPath) {
  const { stdout } = await execFileText(DARWIN_TOOLS.unzip, ["-Z1", zipPath]);
  const entries = stdout
    .split("\n")
    .map((entry) => entry.replace(/\r$/u, ""))
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (isUnsafeZipEntryName(entry)) {
      throw new CuaHelperError(
        "install_failed",
        `refusing to extract Computer Use Helper archive: unsafe zip entry path ${JSON.stringify(entry)}`,
      );
    }
  }
}

async function assertNoSymlinkEscape(root) {
  const canonicalRoot = await realpath(root);
  const withinRoot = (candidate) =>
    candidate === canonicalRoot ||
    candidate.startsWith(`${canonicalRoot}${process.platform === "win32" ? "\\" : "/"}`);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(entryPath);
        const resolved = resolve(directory, target);
        if (!withinRoot(resolved)) {
          throw new CuaHelperError(
            "install_failed",
            `refusing extracted Computer Use Helper: symlink escapes staging (${entryPath} -> ${target})`,
          );
        }
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
}

async function defaultExtractZip(zipPath, targetDir) {
  await assertSafeZipArchiveEntries(zipPath);
  await execFileText(DARWIN_TOOLS.ditto, ["-x", "-k", zipPath, targetDir]);
  await assertNoSymlinkEscape(targetDir);
}

async function defaultClearQuarantine(appPath) {
  if (process.platform !== "darwin") return;
  await execFileText(DARWIN_TOOLS.xattr, ["-dr", "com.apple.quarantine", appPath]).catch(
    (error) => {
      const message = messageOf(error);
      if (!/No such xattr|No such file|No such file or directory|not found/iu.test(message))
        throw error;
    },
  );
}

function assertSafeHelperDownloadUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new CuaHelperError(
      "download_failed",
      `invalid ZCode Computer Use download URL: ${redactHelperDownloadUrl(url)}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CuaHelperError(
      "download_failed",
      `refusing to download ZCode Computer Use over unsupported scheme "${parsed.protocol}" (only http/https are allowed)`,
    );
  }
}

const HELPER_DOWNLOAD_TIMEOUT_DEFAULT_MS = 30_000;
const HELPER_DOWNLOAD_MAX_BYTES_DEFAULT = 200 * 1024 * 1024;

function resolveMaxDownloadBytes(env) {
  const raw = env.ZCODE_CUA_HELPER_MAX_DOWNLOAD_BYTES?.trim();
  if (!raw) return HELPER_DOWNLOAD_MAX_BYTES_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : HELPER_DOWNLOAD_MAX_BYTES_DEFAULT;
}

async function defaultDownloadFile(url, targetPath) {
  assertSafeHelperDownloadUrl(url);
  const timeoutMs = (() => {
    const raw = process.env.ZCODE_CUA_HELPER_DOWNLOAD_TIMEOUT_MS?.trim();
    if (!raw) return HELPER_DOWNLOAD_TIMEOUT_DEFAULT_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : HELPER_DOWNLOAD_TIMEOUT_DEFAULT_MS;
  })();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`download timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error("empty response body");
    const maxBytes = resolveMaxDownloadBytes(process.env);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(
        `ZCode Computer Use download declares ${declaredLength} bytes, exceeding max ${maxBytes}`,
      );
    }
    let received = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > maxBytes) {
        throw new Error(`ZCode Computer Use download exceeded max size ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(chunk));
    }
    await writeFile(targetPath, Buffer.concat(chunks));
  } catch (error) {
    throw controller.signal.aborted
      ? new Error(`download timed out after ${timeoutMs}ms`, { cause: error })
      : error;
  } finally {
    clearTimeout(timer);
  }
}

function findHelperAppRecursively(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === HELPER_APP_NAME) return path;
    const nested = findHelperAppRecursively(path);
    if (nested) return nested;
  }
  return null;
}

async function stageBundledHelperApp(bundledAppPath, stagingRoot) {
  if (!existsSync(bundledAppPath)) {
    throw new CuaHelperError(
      "helper_missing",
      `Bundled ZCode Computer Use.app is missing at ${bundledAppPath}`,
    );
  }
  const stagedPath = join(stagingRoot, HELPER_APP_NAME);
  await copyFs(bundledAppPath, stagedPath, {
    recursive: true,
    errorOnExist: true,
    preserveTimestamps: true,
  }).catch((error) => {
    throw new CuaHelperError(
      "install_failed",
      `Failed to stage bundled ZCode Computer Use.app: ${messageOf(error)}`,
      { cause: error },
    );
  });
  return stagedPath;
}

async function stageDownloadedHelperApp(context, stagingRoot, source) {
  const { plan, logger, dependencies } = context;
  logger?.info?.(
    undefined,
    `installing local-development cua helper ${plan.version} ${plan.platformKey} from ${redactHelperDownloadUrl(source.url)}`,
  );
  const zipPath = join(stagingRoot, source.fileName);
  const extractRoot = join(stagingRoot, "extract");
  await dependencies.downloadFile(source.url, zipPath).catch((error) => {
    const redacted = redactHelperDownloadUrl(source.url);
    throw new CuaHelperError(
      "download_failed",
      `Failed to download ZCode Computer Use from ${redacted}: ${messageOf(error).split(source.url).join(redacted)}`,
      { cause: error },
    );
  });
  await mkdir(extractRoot, { recursive: true });
  await dependencies.extractZip(zipPath, extractRoot).catch((error) => {
    throw new CuaHelperError(
      "install_failed",
      `Failed to extract ZCode Computer Use archive ${zipPath}: ${messageOf(error)}`,
      { cause: error },
    );
  });
  const helperAppPath = findHelperAppRecursively(extractRoot);
  if (!helperAppPath) {
    throw new CuaHelperError(
      "install_failed",
      `ZCode Computer Use archive did not contain ${HELPER_APP_NAME}`,
    );
  }
  return helperAppPath;
}

async function promoteHelperApp(stagedPath, targetPath) {
  const targetDirectory = dirname(targetPath);
  await mkdir(targetDirectory, { recursive: true });
  const backupPath = join(
    targetDirectory,
    `.${HELPER_APP_NAME}.backup-${process.pid}-${Date.now()}`,
  );
  let backedUp = false;
  if (existsSync(targetPath)) {
    await rm(backupPath, { recursive: true, force: true });
    await rename(targetPath, backupPath);
    backedUp = true;
  }
  try {
    await rename(stagedPath, targetPath);
  } catch (error) {
    if (backedUp) {
      await rm(targetPath, { recursive: true, force: true });
      await rename(backupPath, targetPath);
    }
    throw new CuaHelperError(
      "install_failed",
      `Failed to promote ${HELPER_APP_NAME} into ${targetPath}: ${messageOf(error)}`,
      { cause: error },
    );
  }
  if (backedUp) await rm(backupPath, { recursive: true, force: true });
}

async function clearHelperQuarantine(appPath, context) {
  await context.dependencies.clearQuarantine(appPath).catch((error) => {
    context.logger?.warn?.(
      undefined,
      `cua helper installed and verified, but quarantine cleanup failed: ${messageOf(error)}`,
    );
  });
}

async function writeInstallMeta(plan, verification) {
  await writeFile(
    join(plan.installRoot, INSTALL_META_FILE_NAME),
    `${JSON.stringify(
      {
        provider: "zcode-cua-helper",
        version: plan.version,
        buildId: verification.bundleInfo.buildId,
        platform: plan.platformKey,
        source:
          plan.source.kind === "bundled"
            ? "bundled:zcode-app"
            : redactHelperDownloadUrl(plan.source.url),
        bundleId: verification.bundleInfo.bundleId,
        displayName: basename(plan.appPath, ".app"),
        teamIdentifier: verification.teamIdentifier ?? null,
        verificationMode: verification.mode,
        releaseEligible: verification.releaseEligible,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

// dev 本地 payload 漂移检测：bundled 源在 dev 未签名模式下，比较可执行体/Info.plist/
// Resources 树是否变化，变化则整包替换。
async function localDevPayloadTreeChanged(left, right) {
  const readEntries = async (directory) => {
    try {
      return await readdir(directory, { withFileTypes: true });
    } catch {
      return null;
    }
  };
  const [leftEntries, rightEntries] = await Promise.all([readEntries(left), readEntries(right)]);
  if (leftEntries === null || rightEntries === null) return leftEntries !== rightEntries;
  const leftByName = new Map(leftEntries.map((entry) => [entry.name, entry]));
  const rightByName = new Map(rightEntries.map((entry) => [entry.name, entry]));
  if (leftByName.size !== rightByName.size) return true;
  for (const [name, rightEntry] of rightByName) {
    const leftEntry = leftByName.get(name);
    if (!leftEntry) return true;
    const leftPath = join(left, name);
    const rightPath = join(right, name);
    if (rightEntry.isDirectory() !== leftEntry.isDirectory()) return true;
    if (rightEntry.isSymbolicLink() !== leftEntry.isSymbolicLink()) return true;
    if (rightEntry.isDirectory()) {
      if (await localDevPayloadTreeChanged(leftPath, rightPath)) return true;
      continue;
    }
    if (rightEntry.isSymbolicLink()) {
      const [leftTarget, rightTarget] = await Promise.all([
        readlink(leftPath),
        readlink(rightPath),
      ]);
      if (leftTarget !== rightTarget) return true;
      continue;
    }
    const [leftBytes, rightBytes] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
    if (!leftBytes.equals(rightBytes)) return true;
  }
  return false;
}

async function shouldRefreshLocalDevBundledHelper(plan, executableName) {
  if (!plan.allowUnsignedLocalDev || plan.source.kind !== "bundled" || !executableName)
    return false;
  const probes = [
    ["Contents", "MacOS", executableName],
    ["Contents", "Info.plist"],
  ];
  for (const probe of probes) {
    const installed = join(plan.appPath, ...probe);
    const bundled = join(plan.source.appPath, ...probe);
    try {
      const [installedBytes, bundledBytes] = await Promise.all([
        readFile(installed),
        readFile(bundled),
      ]);
      if (!installedBytes.equals(bundledBytes)) return true;
    } catch {
      return true;
    }
  }
  return localDevPayloadTreeChanged(
    join(plan.appPath, "Contents", "Resources"),
    join(plan.source.appPath, "Contents", "Resources"),
  );
}

const ensureInstalledSingleFlight = new Map();

async function ensureCuaHelperInstalled(context) {
  const key = resolve(context.plan.appPath);
  const inFlight = ensureInstalledSingleFlight.get(key);
  if (inFlight) return inFlight;
  const operation = (async () => {
    await mkdir(context.plan.installRoot, { recursive: true, mode: 0o700 });
    const lease = await context.dependencies.acquireInstallLease(context.plan);
    try {
      lease.assertHeld();
      return await ensureCuaHelperInstalledUnderLease(context, lease);
    } finally {
      await lease.release();
    }
  })().finally(() => {
    if (ensureInstalledSingleFlight.get(key) === operation) ensureInstalledSingleFlight.delete(key);
  });
  ensureInstalledSingleFlight.set(key, operation);
  return operation;
}

async function ensureCuaHelperInstalledUnderLease(context, lease) {
  const { plan, logger, dependencies } = context;
  lease.assertHeld();
  if (existsSync(plan.appPath)) {
    try {
      const verification = await verifyCuaHelperBundle(plan.appPath, plan, dependencies);
      if (await shouldRefreshLocalDevBundledHelper(plan, verification.bundleInfo.executableName)) {
        logger?.info?.(
          undefined,
          `local bundled cua helper payload changed; replacing ${plan.appPath}`,
        );
      } else {
        lease.assertHeld();
        await clearHelperQuarantine(plan.appPath, context);
        try {
          await writeInstallMeta(plan, verification);
        } catch (error) {
          logger?.warn?.(
            undefined,
            `verified installed cua helper but failed to refresh install metadata: ${messageOf(error)}`,
          );
        }
        logger?.info?.(
          undefined,
          plan.allowUnsignedLocalDev
            ? `local unsigned cua helper ${plan.version} already installed at ${plan.appPath}`
            : `cua helper ${plan.version} already installed at ${plan.appPath}`,
        );
        return plan.appPath;
      }
    } catch (error) {
      if (plan.allowUnsignedLocalDev && plan.source.kind !== "bundled") {
        throw new CuaHelperError(
          "verification_failed",
          `Local unsigned ZCode Computer Use.app failed dev verification: ${messageOf(error)}. Rebuild and reinstall it at ${plan.appPath}, or unset ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL for the signed release path.`,
          { cause: error },
        );
      }
      logger?.warn?.(
        undefined,
        `installed cua helper is not usable, reinstalling: ${messageOf(error)}`,
      );
    }
  }
  if (plan.allowUnsignedLocalDev && plan.source.kind !== "bundled") {
    throw new CuaHelperError(
      "helper_missing",
      `Local unsigned ZCode Computer Use.app is not installed at ${plan.appPath}. Build the Helper locally and copy it there, or unset ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL for the signed release installer.`,
    );
  }
  const stagingRoot = await mkdtemp(join(plan.installRoot, ".cua-helper-install-"));
  try {
    const stagedPath =
      plan.source.kind === "bundled"
        ? await stageBundledHelperApp(plan.source.appPath, stagingRoot)
        : await stageDownloadedHelperApp(context, stagingRoot, plan.source);
    const verification = await verifyCuaHelperBundle(stagedPath, plan, dependencies);
    lease.assertHeld();
    await promoteHelperApp(stagedPath, plan.appPath);
    lease.assertHeld();
    await clearHelperQuarantine(plan.appPath, context);
    try {
      await writeInstallMeta(plan, verification);
    } catch (error) {
      logger?.warn?.(
        undefined,
        `installed cua helper but failed to write install metadata: ${messageOf(error)}`,
      );
    }
    logger?.info?.(undefined, `installed cua helper ${plan.version} at ${plan.appPath}`);
    return plan.appPath;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export function createCuaHelperInstaller(options = {}) {
  const context = {
    plan:
      options.plan ??
      resolveCuaHelperInstallPlan({ env: options.env, bundledAppPath: options.bundledAppPath }),
    logger: options.logger,
    dependencies: {
      downloadFile: defaultDownloadFile,
      extractZip: defaultExtractZip,
      clearQuarantine: defaultClearQuarantine,
      acquireInstallLease: acquireMacOSCuaHelperInstallLease,
      ...defaultCuaHelperVerifierDependencies,
      ...options.dependencies,
    },
  };
  return {
    ensureInstalled: () => ensureCuaHelperInstalled(context),
    verifyInstalled: async (appPath, verifyOptions) => {
      await verifyCuaHelperBundle(appPath, context.plan, context.dependencies, verifyOptions);
    },
  };
}

// ---------------------------------------------------------------------------
// bundle 完整性 attestation（验签前后的 TOCTOU 防线）
// ---------------------------------------------------------------------------

const BUNDLE_ATTESTATION_MAX_ENTRIES = 4096;

function statSignature(path) {
  const info = statSync(path, { bigint: true });
  return `${info.dev}:${info.ino}:${info.mode}:${info.ctimeNs}:${info.size}`;
}

function lstatSignature(path) {
  const info = lstatSync(path, { bigint: true });
  return `${info.dev}:${info.ino}:${info.mode}:${info.ctimeNs}:${info.size}`;
}

function captureCuaHelperBundleAttestation(appPath) {
  const contents = join(appPath, "Contents");
  const root = realpathSync(contents);
  const pending = [{ absolutePath: contents, relativePath: "Contents" }];
  const signatures = [`app:${statSignature(appPath)}`];
  while (pending.length > 0) {
    if (signatures.length >= BUNDLE_ATTESTATION_MAX_ENTRIES) {
      throw new Error(
        `ZCode Computer Use bundle exceeds ${BUNDLE_ATTESTATION_MAX_ENTRIES} attestation entries`,
      );
    }
    const entry = pending.shift();
    const info = lstatSync(entry.absolutePath, { bigint: true });
    if (info.isSymbolicLink()) {
      const target = readlinkSync(entry.absolutePath);
      const resolved = realpathSync(entry.absolutePath);
      const relativeToRoot = relative(root, resolved);
      if (
        relativeToRoot === ".." ||
        relativeToRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(relativeToRoot)
      ) {
        throw new Error(
          `ZCode Computer Use contains an out-of-bundle symlink: ${entry.relativePath} -> ${target}`,
        );
      }
      signatures.push(
        `${entry.relativePath}:symlink:${lstatSignature(entry.absolutePath)}:${target}:${statSignature(entry.absolutePath)}`,
      );
      continue;
    }
    signatures.push(`${entry.relativePath}:${statSignature(entry.absolutePath)}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(entry.absolutePath).sort()) {
        pending.push({
          absolutePath: join(entry.absolutePath, name),
          relativePath: `${entry.relativePath}/${name}`,
        });
      }
    }
  }
  return signatures.join("|");
}

function assertCuaHelperBundleAttestationUnchanged(appPath, attestation) {
  let current;
  try {
    current = captureCuaHelperBundleAttestation(appPath);
  } catch (error) {
    throw new Error(
      `ZCode Computer Use changed or became unreadable after verification: ${messageOf(error)}`,
    );
  }
  if (current !== attestation) {
    throw new Error("ZCode Computer Use changed after signature verification");
  }
}

// ---------------------------------------------------------------------------
// 进程证据 / 孤儿收割 / 活体身份
// ---------------------------------------------------------------------------

const PS_COLUMNS = ["-awwxo", "pid=,ppid=,uid=,command="];
const REAPER_MAX_REAP = 32;

function helperExecutablePathForApp(appPath) {
  return join(appPath, "Contents", "MacOS", HELPER_EXECUTABLE_BASENAME);
}

function standaloneHelperExecutablePaths(env = process.env) {
  const candidates = productHelperCandidatePaths(env);
  const roots = recognizedCuaHelperInstallRoots(env);
  const known = roots.flatMap((root) => [
    join(root, HELPER_APP_NAME),
    join(root, DEV_HELPER_APP_NAME),
  ]);
  return [...new Set([...candidates, ...known])].map((appPath) =>
    join(appPath, "Contents", "MacOS", HELPER_EXECUTABLE_BASENAME),
  );
}

function extractFlagValue(command, flag) {
  const tokens = command.split(/\s+/u);
  const index = tokens.indexOf(flag);
  return index < 0 || index + 1 >= tokens.length ? null : (tokens[index + 1] ?? null);
}

function isPathWithinDir(candidate, directory) {
  if (candidate === directory) return true;
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return candidate.startsWith(prefix);
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function extractHelperOwnerPid(command) {
  const raw = extractFlagValue(command, "--launcher-pid");
  if (raw !== null) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function commandStartsWithExactExecutable(command, executable) {
  return command === executable || command.startsWith(`${executable} `);
}

function commandMayStartWithHelperBundleExecutable(command) {
  if (!command.startsWith("/")) return false;
  const marker = `/Contents/MacOS/${HELPER_EXECUTABLE_BASENAME}`;
  let index = command.indexOf(marker);
  while (index > 0) {
    const end = index + marker.length;
    if (end === command.length || /\s/u.test(command[end])) return true;
    index = command.indexOf(marker, index + 1);
  }
  return false;
}

function commandHasExactFlagValue(command, flag, value) {
  const needle = ` ${flag} ${value}`;
  let index = command.indexOf(needle);
  while (index >= 0) {
    const end = index + needle.length;
    if (end === command.length || /\s/u.test(command[end])) return true;
    index = command.indexOf(needle, index + 1);
  }
  return false;
}

function rowLooksLikeHelperProcess(row, currentUid, executablePaths, socketPath) {
  if (
    row.uid !== currentUid ||
    !executablePaths.some((path) => commandStartsWithExactExecutable(row.command, path))
  ) {
    return false;
  }
  return socketPath ? commandHasExactFlagValue(row.command, "--socket", socketPath) : true;
}

function isReapableOrphanHelper(row, context) {
  if (
    row.ppid !== 1 ||
    row.pid === context.selfPid ||
    !rowLooksLikeHelperProcess(row, context.currentUid, context.executablePaths)
  ) {
    return false;
  }
  const socketPath = extractFlagValue(row.command, "--socket");
  if (!socketPath || !isPathWithinDir(socketPath, context.runtimeDir)) return false;
  const ownerPid = extractHelperOwnerPid(row.command);
  if (ownerPid === null) return false;
  const ownerEvidence = context.ownerEvidenceProvider(ownerPid);
  return ownerEvidence.state === "dead" || ownerEvidence.identity === "unrelated";
}

function parsePsProcessRows(output) {
  const rows = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const [, pid, ppid, uid, command] = match;
    rows.push({ pid: Number(pid), ppid: Number(ppid), uid: Number(uid), command });
  }
  return rows;
}

function defaultListProcesses() {
  return parsePsProcessRows(execFileSync(DARWIN_TOOLS.ps, [...PS_COLUMNS], { encoding: "utf8" }));
}

function addCanonicalPathAliases(paths, canonicalize) {
  const aliased = new Set(paths);
  for (const path of paths) {
    try {
      aliased.add(canonicalize(path));
    } catch {
      /* 无权限 canonicalize 的路径只保留原值 */
    }
  }
  return [...aliased];
}

function isLikelyZCodeDevOwnerCommand(lower) {
  return /(?:^|\s|\/)(?:node|electron)(?:\s|$)/u.test(lower)
    ? lower.includes("/z-code/") ||
        lower.includes("/zcode/") ||
        lower.includes("packages/services") ||
        lower.includes("apps/zcode") ||
        lower.includes("dev.zcode")
    : false;
}

function isLikelyZCodeOwnerCommand(command) {
  const lower = command.replaceAll("\\", "/").toLowerCase();
  if (lower.includes("zcode cua helper") || lower.includes("zcode-cua")) return false;
  if (
    /\bzcode-host(?:-|$)/u.test(lower) ||
    /\bzcode-main(?:\s|-)/u.test(lower) ||
    lower.includes("/zcode.app/contents/macos/") ||
    lower.includes("zcode.app/contents/macos/") ||
    /\bzcode(?:\s|$)/u.test(lower)
  ) {
    return true;
  }
  return isLikelyZCodeDevOwnerCommand(lower);
}

function createDefaultOwnerEvidenceProvider({
  getRows,
  currentUid,
  selfPid,
  isProcessAlive,
  deadPids,
}) {
  return (pid) => {
    if (pid === selfPid) return { state: "alive", identity: "zcode-owner", reason: "self" };
    if (!isProcessAlive(pid)) {
      deadPids.add(pid);
      return { state: "dead", reason: "pid not alive" };
    }
    if (!deadPids.has(pid)) {
      return { state: "alive", identity: "zcode-owner", reason: "live owner; spared by default" };
    }
    const row = getRows().find(
      (candidate) => candidate.pid === pid && candidate.uid === currentUid,
    );
    return row && !isLikelyZCodeOwnerCommand(row.command)
      ? {
          state: "alive",
          identity: "unrelated",
          command: row.command,
          reason: "pid observed dead earlier is alive again with a non-ZCode command line",
        }
      : {
          state: "alive",
          identity: "zcode-owner",
          command: row?.command,
          reason: "pid reused after death; command still matches ZCode",
        };
  };
}

// 孤儿收割：启动时一次，按 bundle 可执行路径 + runtime 目录内 socket + launcher-pid
// 属主证据识别被宿主异常退出抛下的 Helper，SIGTERM 前重查防 pid 复用误杀。
export async function reapOrphanedHelpers(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const logger = options.logger;
  const result = { scanned: 0, reaped: [] };
  if (platform !== "darwin") return result;
  const currentUid =
    options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (currentUid == null) return result;
  const selfPid = options.selfPid ?? process.pid;
  const maxReap = options.maxReap ?? REAPER_MAX_REAP;
  const listProcesses = options.listProcesses ?? defaultListProcesses;
  const killProcess = options.killProcess ?? ((pid) => process.kill(pid, "SIGTERM"));
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const canonicalizePath = options.canonicalizePath ?? realpathSync.native;
  let rows;
  try {
    rows = listProcesses();
  } catch (error) {
    logger?.warn?.(undefined, `cua helper reaper: process listing failed: ${messageOf(error)}`);
    return result;
  }
  result.scanned = rows.length;
  const deadPids = new Set();
  let snapshot = rows;
  const ownerEvidenceProvider =
    options.ownerEvidenceProvider ??
    createDefaultOwnerEvidenceProvider({
      getRows: () => snapshot,
      currentUid,
      selfPid,
      isProcessAlive,
      deadPids,
    });
  const context = {
    currentUid,
    selfPid,
    executablePaths: addCanonicalPathAliases(
      standaloneHelperExecutablePaths(env),
      canonicalizePath,
    ),
    runtimeDir: brokerRuntimeDir(env),
    ownerEvidenceProvider,
  };
  for (const row of rows) {
    if (result.reaped.length >= maxReap) {
      logger?.warn?.(undefined, `cua helper reaper: hit per-run cap (${maxReap}); stopping`);
      break;
    }
    snapshot = rows;
    if (!isReapableOrphanHelper(row, context)) continue;
    let recheck;
    try {
      recheck = listProcesses();
    } catch (error) {
      logger?.warn?.(
        undefined,
        `cua helper reaper: pre-SIGTERM recheck failed for pid ${row.pid}: ${messageOf(error)}`,
      );
      continue;
    }
    snapshot = recheck;
    const confirmed = recheck.find((candidate) => candidate.pid === row.pid) ?? null;
    if (confirmed && isReapableOrphanHelper(confirmed, context)) {
      try {
        killProcess(confirmed.pid);
        result.reaped.push(confirmed.pid);
      } catch (error) {
        logger?.warn?.(
          undefined,
          `cua helper reaper: SIGTERM of orphaned Helper pid ${confirmed.pid} failed: ${messageOf(error)}`,
        );
      }
    }
  }
  if (result.reaped.length > 0) {
    logger?.info?.(
      undefined,
      `cua helper reaper: SIGTERM'd ${result.reaped.length} orphaned Helper(s): ${result.reaped.join(", ")}`,
    );
  }
  return result;
}

// pid 证据（终止路径用）：判定 pid 当前是否仍是我们启动的那个 Helper。
function createDefaultHelperPidEvidenceProvider(options = {}) {
  const platform = options.platform ?? process.platform;
  const currentUid =
    options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  const listProcesses = options.listProcesses ?? defaultListProcesses;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const canonicalizePath = options.canonicalize ?? realpathSync.native;
  const knownExecutablePaths = addCanonicalPathAliases(
    standaloneHelperExecutablePaths(options.env ?? process.env),
    canonicalizePath,
  );
  const logger = options.logger;
  return (pid, context) => {
    if (platform !== "darwin" || currentUid === null) {
      return { state: "helper", reason: "non-darwin / no uid; identity recheck unavailable" };
    }
    let rows;
    try {
      rows = listProcesses();
    } catch (error) {
      logger?.warn?.(
        undefined,
        `cua helper kill-path: process listing failed for pid ${pid} (${messageOf(error)}); skipping SIGTERM as a pid-reuse precaution`,
      );
      return { state: "unknown", reason: "process listing failed" };
    }
    const row = rows.find((candidate) => candidate.pid === pid);
    if (!row) {
      return isProcessAlive(pid)
        ? { state: "unknown", reason: "pid alive but absent from ps snapshot" }
        : { state: "dead", reason: "pid not alive" };
    }
    const executablePaths = context?.helperAppPath
      ? addCanonicalPathAliases(
          [helperExecutablePathForApp(context.helperAppPath), ...knownExecutablePaths],
          canonicalizePath,
        )
      : knownExecutablePaths;
    const matched = executablePaths.find((path) =>
      commandStartsWithExactExecutable(row.command, path),
    );
    if (
      matched &&
      (!context?.socketPath ||
        commandHasExactFlagValue(row.command, "--socket", context.socketPath))
    ) {
      return { state: "helper", reason: "ps command matches Helper executable path" };
    }
    if (matched && context?.socketPath) {
      const socketArg = extractFlagValue(row.command, "--socket");
      return socketArg === null ||
        (context.socketPath.startsWith(socketArg) && row.command.trimEnd().endsWith(socketArg))
        ? {
            state: "unknown",
            reason: "Helper argv is incomplete; exact random socket cannot be verified",
            command: row.command,
          }
        : {
            state: "unrelated",
            reason: "pid now belongs to a Helper launched for a different random socket",
            command: row.command,
          };
    }
    if (
      context?.socketPath &&
      commandHasExactFlagValue(row.command, "--socket", context.socketPath) &&
      commandMayStartWithHelperBundleExecutable(row.command)
    ) {
      return {
        state: "unknown",
        reason:
          "Helper-shaped argv and exact random socket match, but canonical executable identity cannot be proven",
        command: row.command,
      };
    }
    const trimmedCommand = row.command.trimEnd();
    if (
      trimmedCommand.length > 0 &&
      executablePaths.some((path) => path.startsWith(trimmedCommand))
    ) {
      return {
        state: "unknown",
        reason: "ps command may be a truncated Helper executable path",
        command: row.command,
      };
    }
    return {
      state: "unrelated",
      reason: context?.socketPath
        ? "pid no longer matches the Helper executable and random socket"
        : "pid reused by non-Helper process",
      command: row.command,
    };
  };
}

// lsof：unix socket 的属主 pid 集合。
function listUnixSocketOwnerPids(socketPath) {
  return new Promise((resolvePids, rejectPids) => {
    const args = ["-n", "-P", "-Fpcfn", "--", socketPath];
    execFileCallback(DARWIN_TOOLS.lsof, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      const pids = [...stdout.matchAll(/^p([0-9]+)$/gmu)]
        .map((match) => Number(match[1]))
        .filter((pid) => Number.isInteger(pid) && pid > 1);
      if (!error) {
        resolvePids(pids);
        return;
      }
      const code = error.code;
      if (
        (code === 1 || code === "1") &&
        pids.length === 0 &&
        (!existsSync(socketPath) || stderr.trim().length === 0)
      ) {
        resolvePids([]);
        return;
      }
      rejectPids(
        new Error(
          `${DARWIN_TOOLS.lsof} ${args.join(" ")} failed: ${messageOf(error)}${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    });
  });
}

async function listProcessesAsync() {
  const { stdout } = await execFileText(DARWIN_TOOLS.ps, [...PS_COLUMNS]);
  return parsePsProcessRows(stdout);
}

async function discoverCuaHelperLaunchProcesses(request, dependencies) {
  const deps = dependencies ?? {};
  const listSocketOwners = deps.listUnixSocketOwnerPids ?? listUnixSocketOwnerPids;
  const listProcesses = deps.listProcesses ?? listProcessesAsync;
  const currentUid =
    deps.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  const canonicalize = deps.canonicalize ?? realpathSync;
  if (currentUid === null)
    return { state: "unknown", pids: [], detail: "current uid is unavailable" };
  let socketOwners = [];
  let socketError = null;
  try {
    socketOwners = [...new Set(await listSocketOwners(request.socketPath))];
  } catch (error) {
    socketError = messageOf(error).split(request.socketPath).join("<socket>");
  }
  let rows;
  try {
    rows = await listProcesses();
  } catch (error) {
    return {
      state: "unknown",
      pids: [],
      detail: `process inspection failed: ${messageOf(error).split(request.socketPath).join("<socket>")}`,
    };
  }
  const helperExecutables = [request.helperAppPath];
  try {
    helperExecutables.push(canonicalize(request.helperAppPath));
  } catch {
    /* canonicalize 失败只保留原路径 */
  }
  const executablePaths = [...new Set(helperExecutables.map(helperExecutablePathForApp))];
  const observed = rows
    .filter((row) =>
      rowLooksLikeHelperProcess(row, currentUid, executablePaths, request.socketPath),
    )
    .map((row) => row.pid);
  if (observed.length > 0) {
    const ownerSet = new Set(socketOwners);
    return {
      state: "observed",
      pids: [...new Set(observed)].sort(
        (left, right) => Number(ownerSet.has(right)) - Number(ownerSet.has(left)),
      ),
      ...(socketError ? { detail: `socket inspection failed: ${socketError}` } : {}),
    };
  }
  if (socketOwners.length > 0) {
    return {
      state: "unknown",
      pids: [],
      detail: "random Helper socket still has an owner whose exact launch argv is unverified",
    };
  }
  return socketError
    ? { state: "unknown", pids: [], detail: `socket inspection failed: ${socketError}` }
    : { state: "absent", pids: [] };
}

// 活体身份验证：broker_info 上报的 pid 必须独占 socket 属主、满足钉死的 codesign
// requirement、且托管路径落在已验签 bundle 内；全部通过才把凭据发给 agent。
const CODESIGN_IDENTIFIER_PATTERN = /^[A-Za-z0-9.-]+$/u;

function resolveCuaHelperLiveCodeRequirement(request) {
  const expectedBundleId = request.expectedBundleId.trim();
  if (!CODESIGN_IDENTIFIER_PATTERN.test(expectedBundleId)) {
    throw new CuaHelperError(
      "verification_failed",
      "ZCode Computer Use live verification received an unsafe bundle identifier",
    );
  }
  if (request.allowAdHocLocalDev) {
    if (expectedBundleId !== DEV_CUA_HELPER_BUNDLE_ID) {
      throw new CuaHelperError(
        "verification_failed",
        "Ad-hoc Computer Use Helper live verification is restricted to the isolated dev bundle identifier",
      );
    }
    return `identifier "${expectedBundleId}"`;
  }
  const env = request.env ?? process.env;
  const teamId =
    (isCuaLocalDevelopmentRuntime(env) ? env.ZCODE_CUA_HELPER_TEAM_ID?.trim() : undefined) ||
    HELPER_TEAM_IDENTIFIER;
  if (!CODESIGN_IDENTIFIER_PATTERN.test(teamId)) {
    throw new CuaHelperError(
      "verification_failed",
      "ZCode Computer Use live verification received an unsafe TeamIdentifier",
    );
  }
  return `anchor apple generic and identifier "${expectedBundleId}" and certificate leaf[subject.OU] = "${teamId}"`;
}

async function verifyProcessCodeSignature(pid, requirement) {
  await execFileText(DARWIN_TOOLS.codesign, [
    "--verify",
    "--strict",
    `-R=${requirement}`,
    String(pid),
  ]);
}

async function readProcessHostingPaths(pid) {
  const { stdout, stderr } = await execFileText(DARWIN_TOOLS.codesign, ["--hosting", String(pid)]);
  return `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => isAbsolute(line));
}

async function verifyCuaHelperLiveProcessIdentity(request) {
  if (
    request.reportedPid === null ||
    !Number.isInteger(request.reportedPid) ||
    request.reportedPid <= 1
  ) {
    throw new CuaHelperError(
      "verification_failed",
      "ZCode Computer Use broker_info did not report a valid process id",
    );
  }
  let owners;
  try {
    owners = [...new Set(await listUnixSocketOwnerPids(request.socketPath))];
  } catch (error) {
    throw new CuaHelperError(
      "verification_failed",
      "Could not resolve the live process listening on the ZCode Computer Use socket",
      { cause: error },
    );
  }
  if (owners.length !== 1) {
    throw new CuaHelperError(
      "verification_failed",
      `ZCode Computer Use socket has ${owners.length} live owners; expected exactly one`,
    );
  }
  const pid = owners[0];
  if (pid !== request.reportedPid) {
    throw new CuaHelperError(
      "verification_failed",
      `ZCode Computer Use broker_info pid ${request.reportedPid} does not own its broker socket`,
    );
  }
  const requirement = resolveCuaHelperLiveCodeRequirement(request);
  try {
    await verifyProcessCodeSignature(pid, requirement);
  } catch (error) {
    throw new CuaHelperError(
      "verification_failed",
      "The live ZCode Computer Use process does not satisfy the expected code-signing identity",
      { cause: error },
    );
  }
  let hostingPaths;
  try {
    hostingPaths = await readProcessHostingPaths(pid);
  } catch (error) {
    throw new CuaHelperError(
      "verification_failed",
      "Could not resolve the live ZCode Computer Use process hosting path",
      { cause: error },
    );
  }
  const bundleMacrosDirectory = resolve(realpathSync(request.helperAppPath), "Contents", "MacOS");
  const hostedByBundle = hostingPaths.some((path) => {
    try {
      const canonical = realpathSync(path);
      const relativePath = relative(bundleMacrosDirectory, canonical);
      return (
        relativePath.length > 0 &&
        relativePath !== ".." &&
        !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        !isAbsolute(relativePath)
      );
    } catch {
      return false;
    }
  });
  if (!hostedByBundle) {
    throw new CuaHelperError(
      "verification_failed",
      "The live ZCode Computer Use process is not hosted by the verified Helper bundle",
    );
  }
  let reconfirmed;
  try {
    reconfirmed = [...new Set(await listUnixSocketOwnerPids(request.socketPath))];
  } catch (error) {
    throw new CuaHelperError(
      "verification_failed",
      "Could not re-confirm the live ZCode Computer Use socket owner after code-signature verification",
      { cause: error },
    );
  }
  if (reconfirmed.length !== 1 || reconfirmed[0] !== pid) {
    throw new CuaHelperError(
      "verification_failed",
      "ZCode Computer Use socket ownership changed during live process verification",
    );
  }
  return { pid };
}

// ---------------------------------------------------------------------------
// 冷启动 rendezvous：host 先占住 final socket，Helper 绑 .pending，验签通过后原子让渡
// ---------------------------------------------------------------------------

const RESERVATION_SOCKET_SUFFIX = ".host-reservation";
const RESERVATION_PENDING_SUFFIX = ".pending";
const RESERVATION_PATH_BUDGET = 100;

function currentUidOrNull() {
  const getuid = process.getuid;
  return typeof getuid === "function" ? getuid.call(process) : null;
}

function assertCurrentUserOwner(path, info) {
  const uid = currentUidOrNull();
  if (uid !== null && info.uid !== uid) {
    throw new Error(`refusing to use broker path not owned by current user: ${path}`);
  }
}

async function ensureSocketDirectory(socketPath) {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await statFile(directory);
  assertCurrentUserOwner(directory, info);
  if ((info.mode & 0o511) !== 0o700) await chmod(directory, 0o700);
}

async function unlinkIfOwnedSocket(path) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return;
  }
  if (!info.isSocket()) return;
  const uid = currentUidOrNull();
  if (uid !== null && info.uid !== uid) return;
  await unlink(path).catch(() => undefined);
}

function listenOn(server, path) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

async function createTransportReservation(request) {
  const { socketPath } = request;
  const logger = request.logger;
  if (isWindowsNamedPipePath(socketPath)) return null;
  const reservationPath = `${socketPath}${RESERVATION_SOCKET_SUFFIX}`;
  const pendingSocketPath = `${socketPath}${RESERVATION_PENDING_SUFFIX}`;
  if (reservationPath.length > RESERVATION_PATH_BUDGET) {
    logger?.warn?.(
      undefined,
      `cua transport rendezvous disabled: socket path budget exceeded (${reservationPath.length} > ${RESERVATION_PATH_BUDGET})`,
    );
    return null;
  }
  let server = null;
  try {
    await ensureSocketDirectory(socketPath);
    await unlinkIfOwnedSocket(reservationPath);
    server = createServer((connection) => {
      connection.destroy();
    });
    server.on("error", (error) => {
      logger?.warn?.(undefined, `cua transport reservation listener error: ${messageOf(error)}`);
    });
    await listenOn(server, reservationPath);
    await chmod(reservationPath, 0o600);
    await rename(reservationPath, socketPath);
  } catch (error) {
    if (server) await closeServer(server).catch(() => undefined);
    await unlinkIfOwnedSocket(reservationPath);
    logger?.warn?.(
      undefined,
      `cua transport rendezvous disabled: reservation failed (${messageOf(error)})`,
    );
    return null;
  }
  const listener = server;
  let state = "reserved";
  let transitionTail = null;
  const singleFlight = (operation) => {
    const next = (transitionTail ?? Promise.resolve()).then(operation, operation);
    transitionTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    pendingSocketPath,
    get holdsPublishedPath() {
      return state === "reserved";
    },
    publish: () =>
      singleFlight(async () => {
        if (state === "reserved") {
          await rename(pendingSocketPath, socketPath);
          state = "published";
          await closeServer(listener);
        }
      }),
    release: () =>
      singleFlight(async () => {
        if (state === "reserved") {
          state = "released";
          await closeServer(listener);
          await unlinkIfOwnedSocket(socketPath);
        }
      }),
    unlinkPublishedIfOwned: () =>
      singleFlight(async () => {
        if (state === "published") await unlinkIfOwnedSocket(socketPath);
      }),
  };
}

// ---------------------------------------------------------------------------
// dev broker 凭据外露（ZCODE_CUA_DEV_EXPOSE_BROKER=1 时写 ~/.zcode/computer-use/run）
// ---------------------------------------------------------------------------

function resolveDevBrokerCredentialsFilePath(env = process.env) {
  const home = resolveZcodeHome(env);
  return home ? join(home, "computer-use", "run", "broker-credentials.json") : null;
}

async function writeDevBrokerCredentialsFile(request) {
  if (!isDevBrokerExposureEnabled(request.env)) return;
  const filePath = resolveDevBrokerCredentialsFilePath(request.env ?? process.env);
  if (!filePath) {
    request.logger?.warn?.(
      undefined,
      "ZCODE_CUA_DEV_EXPOSE_BROKER=1 but ZCODE_HOME/HOME is not resolvable; skipping broker credential exposure (no path to write to).",
    );
    return;
  }
  const directory = join(filePath, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const stagingPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(stagingPath, `${JSON.stringify({ socket: request.socketPath })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(stagingPath, 0o600);
  await rename(stagingPath, filePath);
  request.logger?.warn?.(
    undefined,
    `ZCODE_CUA_DEV_EXPOSE_BROKER=1: wrote broker socket path to ${filePath} for the external test harness. NEVER enable this in production.`,
  );
}

// ---------------------------------------------------------------------------
// 产品 Helper Host（darwin 生产线核心）
// ---------------------------------------------------------------------------

const TERMINATION_TERM_GRACE_MS = 10_000;
const TERMINATION_KILL_GRACE_MS = 1_000;
const TERMINATION_POLL_INTERVAL_MS = 100;
const FAILED_LAUNCH_CLEANUP_QUIET_MS = 500;
const FAILED_LAUNCH_CLEANUP_POLL_INTERVAL_MS = 100;
const FAILED_LAUNCH_CLEANUP_DELAY_MS = 250;
const BROKER_LAUNCH_DEADLINE_SLACK_MS = 5_000;
const HEALTH_TIMEOUT_DEFAULT_MS = 5_000;
const SCREEN_CAPTURE_PROBE_TIMEOUT_MS = 6_500;
const PERMISSION_STATUS_TIMEOUT_MS = 3_000;
const SCREEN_RECORDING_PREFLIGHT_DIR = ".screen-recording-preflight";

function defaultKillProcess(pid, signal) {
  process.kill(pid, signal);
}

function defaultTerminationDelay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function mintRandomSecret() {
  return randomBytes(32).toString("hex");
}

function tupleOf(handle) {
  return { socketPath: handle.socketPath, pluginAuthority: handle.pluginAuthority };
}

class ProductCuaHelperHost {
  #options;
  #handle = null;
  #resolverPluginAuthority;
  #pluginAuthorityMintError = null;
  #startInFlight = null;
  #pendingTermination = null;
  #terminationInFlight = null;
  #pendingFailedLaunch = null;
  #failedLaunchCleanupInFlight = null;
  #restartAfterCurrentStartInFlight = null;
  #restartPreservingTransportInFlight = null;
  #pendingRefreshMarker = null;
  #reservation = null;
  #pendingReservedTuple = null;
  #stopGeneration = 0;
  #collectHelperPidEvidence;

  constructor(options) {
    this.#options = options;
    this.#collectHelperPidEvidence =
      options.collectHelperPidEvidence ??
      createDefaultHelperPidEvidenceProvider({ env: options.env, logger: options.logger });
  }

  get running() {
    return this.#handle !== null;
  }

  get socketPath() {
    return this.#handle?.socketPath ?? null;
  }

  get pluginAuthority() {
    return this.#resolverPluginAuthority ?? null;
  }

  // 预留 tuple：handle 尚未就绪、但 host 已占住 final socket（rendezvous 进行中）。
  // 下发这组凭据是安全的——final 上是 host 占位，未验签的 Helper 绑在 .pending 上
  // 够不到它；client 连上占位会被立刻 destroy 并按 broker_unavailable 退避重试。
  get reservedTransport() {
    if (this.#handle || !this.#reservation?.holdsPublishedPath) return null;
    return this.#pendingReservedTuple ?? null;
  }

  #resolveResolverPluginAuthority() {
    if (this.#resolverPluginAuthority !== undefined) return this.#resolverPluginAuthority;
    if (this.#pluginAuthorityMintError) throw this.#pluginAuthorityMintError;
    try {
      this.#resolverPluginAuthority = (this.#options.mintPluginAuthority ?? mintRandomSecret)();
      return this.#resolverPluginAuthority;
    } catch (error) {
      this.#pluginAuthorityMintError = new CuaHelperError(
        "launch_failed",
        `Failed to mint ZCode Computer Use resolver plugin authority: ${messageOf(error)}`,
        { cause: error },
      );
      throw this.#pluginAuthorityMintError;
    }
  }

  async start() {
    if (this.#restartPreservingTransportInFlight) {
      return this.#restartPreservingTransportInFlight.then((result) => result.handle);
    }
    if (this.#restartAfterCurrentStartInFlight) return this.#restartAfterCurrentStartInFlight;
    if (this.#startInFlight) return this.#startInFlight;
    if (this.#handle) {
      const stopGeneration = this.#stopGeneration;
      const refreshed = await this.#retryCompletedRefreshMarkerForLiveHandle();
      this.#assertNotExternallyStopped(stopGeneration);
      const handle = refreshed?.handle ?? this.#handle;
      if (!handle) {
        throw new CuaHelperError(
          "launch_failed",
          "ZCode Computer Use handle became unavailable during start()",
        );
      }
      return handle;
    }
    const stopGeneration = this.#stopGeneration;
    await this.#finishPendingTermination("before start");
    await this.#finishPendingFailedLaunch("before start");
    this.#assertNotExternallyStopped(stopGeneration);
    if (this.#handle) return this.#handle;
    if (this.#startInFlight) return this.#startInFlight;
    const startup = this.#doStart(stopGeneration, undefined, "cold-start").finally(async () => {
      if (this.#startInFlight === startup) this.#startInFlight = null;
      await this.#releaseReservationIfUnpublished();
    });
    this.#startInFlight = startup;
    return startup;
  }

  async #doStart(stopGeneration, restart, mode = "restart") {
    const env = this.#options.env ?? process.env;
    const socketPath =
      restart?.socketPath ??
      (this.#options.mintSocketPath ?? (() => mintBrokerSocketPath({ env })))();
    const pluginAuthority = this.#resolveResolverPluginAuthority();
    const reservation =
      mode === "cold-start" && !restart
        ? await (this.#options.createTransportReservation ?? createTransportReservation)({
            socketPath,
            logger: this.#options.logger,
          })
        : null;
    this.#reservation = reservation;
    this.#pendingReservedTuple = reservation ? { socketPath, pluginAuthority } : null;
    const launchSocketPath = reservation?.pendingSocketPath ?? socketPath;
    const installedPath = restart
      ? undefined
      : await this.#options.helperInstaller?.ensureInstalled();
    const candidates = restart
      ? [restart.helperAppPath]
      : [...(installedPath ? [installedPath] : []), ...(this.#options.helperAppCandidates ?? [])];
    const helperAppPath = restart?.helperAppPath ?? firstExistingPath(candidates);
    if (!helperAppPath) {
      throw new CuaHelperError(
        "helper_missing",
        `ZCode Computer Use is not ready (${candidates.length} internal candidate(s) checked). Restart ZCode or reinstall the Computer Use component.`,
      );
    }
    const attestation = this.#options.helperInstaller
      ? captureCuaHelperBundleAttestation(helperAppPath)
      : null;
    const freshlyInstalled = installedPath !== undefined && helperAppPath === installedPath;
    await this.#options.helperInstaller?.verifyInstalled(helperAppPath, {
      skipGatekeeperAssessment: freshlyInstalled,
    });
    if (attestation) assertCuaHelperBundleAttestationUnchanged(helperAppPath, attestation);
    const healthTimeoutMs = this.#options.healthTimeoutMs ?? HEALTH_TIMEOUT_DEFAULT_MS;
    const now = this.#options.failedLaunchCleanupNow ?? Date.now;
    const deadlineSlackMs = Math.max(
      0,
      this.#options.brokerLaunchDeadlineSlackMs ?? BROKER_LAUNCH_DEADLINE_SLACK_MS,
    );
    const guard = await (
      this.#options.prepareBrokerLaunchGuard ?? prepareCuaHelperBrokerLaunchGuard
    )({
      socketPath: launchSocketPath,
      deadlineEpochMs: now() + healthTimeoutMs + deadlineSlackMs,
      now,
    });
    const controllerVariant = resolveCuaHelperInstallVariant(env);
    try {
      await (this.#options.launcher ?? createLaunchServicesLauncher()).launch({
        appPath: helperAppPath,
        expectedAppBundlePath: helperAppPath,
        ...(controllerVariant ? { controllerVariant } : {}),
        ...(cpsActivationDisableRequested(env) ? { disableCpsActivation: true } : {}),
        socketPath: launchSocketPath,
        brokerLaunchGuard: guard,
        ...(attestation
          ? {
              assertHelperUnchangedBeforeLaunch: () =>
                assertCuaHelperBundleAttestationUnchanged(helperAppPath, attestation),
            }
          : {}),
        env,
        allowUnsignedLauncherLocalDev: isUnsignedHelperLocalDevRequested(env),
        allowExternalBrokerClientLocalDev:
          isUnsignedHelperLocalDevRequested(env) || isDevBrokerExposureEnabled(env),
        version: isCuaLocalDevelopmentRuntime(env)
          ? env.ZCODE_VERSION?.trim() || HELPER_RUNTIME_VERSION
          : HELPER_RUNTIME_VERSION,
        ghostCursorOverlay: this.#options.ghostCursorOverlay === true,
        pipMode: this.#options.pipMode === true,
        pipLiveProbe: this.#options.pipLiveProbe === true,
      });
    } catch (error) {
      const failure =
        error instanceof CuaHelperError
          ? error
          : new CuaHelperError(
              "launch_failed",
              `Failed to launch ${helperAppPath}: ${messageOf(error)}`,
              { cause: error },
            );
      await this.#recordAndCleanupFailedLaunch(
        { socketPath: launchSocketPath, helperAppPath, guard },
        failure,
      );
      throw failure;
    }
    let health;
    let verifiedPid;
    try {
      health = await (
        this.#options.healthProbe ?? ((path, timeoutMs) => probeHelperHealth(path, { timeoutMs }))
      )(launchSocketPath, healthTimeoutMs);
      if (!health || health.pid === null) {
        throw new CuaHelperError(
          "health_timeout",
          `ZCode Computer Use did not become ready within ${healthTimeoutMs}ms. It may have failed to launch or lacks required permissions.`,
        );
      }
      const expectedBundleId = this.#options.expectedBundleId ?? HELPER_BUNDLE_ID;
      verifiedPid = (
        await (this.#options.verifyLiveProcessIdentity ?? verifyCuaHelperLiveProcessIdentity)({
          socketPath: launchSocketPath,
          reportedPid: health.pid,
          helperAppPath,
          expectedBundleId,
          allowAdHocLocalDev: isUnsignedHelperLocalDevRequested(env),
          env,
        })
      ).pid;
      if (expectedBundleId && health.bundleId !== expectedBundleId) {
        await this.#terminateHelperPid(verifiedPid, "unexpected bundle id", {
          socketPath: launchSocketPath,
          helperAppPath,
        });
        throw new CuaHelperError(
          "unexpected_bundle_id",
          `ZCode Computer Use reported bundle id ${health.bundleId ?? "<missing>"} (expected ${expectedBundleId}). Refusing to inject broker credentials because TCC ownership is not the signed ZCode Computer Use.`,
        );
      }
      if (this.#stopGeneration !== stopGeneration) {
        await this.#terminateHelperPid(verifiedPid, "stopped-during-start", {
          socketPath: launchSocketPath,
          helperAppPath,
        });
        throw new CuaHelperError("launch_failed", "ZCode Computer Use start aborted by stop()");
      }
      await (this.#options.cleanupBrokerLaunchGuard ?? cleanupCuaHelperBrokerLaunchGuard)(guard);
      if (this.#stopGeneration !== stopGeneration) {
        await this.#terminateHelperPid(verifiedPid, "stopped-during-launch-guard-cleanup", {
          socketPath: launchSocketPath,
          helperAppPath,
        });
        throw new CuaHelperError("launch_failed", "ZCode Computer Use start aborted by stop()");
      }
      await this.#reservation?.publish();
    } catch (error) {
      // 活体身份校验失败时尽力拿到 socket 属主 pid：这个进程可能是未通过验签的
      // Helper，必须进入失败清理（官方经 CuaHelperLiveProcessIdentityError
      // .observedSocketOwnerPid 传递；这里直接重查 lsof）。
      let observedSocketOwnerPid = null;
      try {
        const owners = await listUnixSocketOwnerPids(launchSocketPath);
        if (owners.length === 1) observedSocketOwnerPid = owners[0];
      } catch {
        /* 拿不到属主时交由失败清理的发现环收敛 */
      }
      await this.#recordAndCleanupFailedLaunch(
        { socketPath: launchSocketPath, helperAppPath, guard },
        error,
        observedSocketOwnerPid,
      );
      throw error instanceof CuaHelperError
        ? error
        : new CuaHelperError(
            "verification_failed",
            `Failed to verify the live ZCode Computer Use process identity: ${messageOf(error)}`,
            { cause: error },
          );
    }
    this.#handle = {
      socketPath,
      launchSocketPath,
      pluginAuthority,
      helperAppPath,
      bundleId: health.bundleId,
      pid: verifiedPid,
    };
    this.#pendingReservedTuple = null;
    await writeDevBrokerCredentialsFile({
      socketPath,
      env,
      logger: this.#options.logger,
    }).catch((error) => {
      this.#options.logger?.warn?.(
        undefined,
        `ZCODE_CUA_DEV_EXPOSE_BROKER: failed to write broker credentials file: ${messageOf(error)}`,
      );
    });
    this.#options.logger?.info?.(
      undefined,
      `cua helper ready at ${helperAppPath} pid=${health.pid ?? "?"}`,
    );
    this.#options.logger?.debug?.(undefined, `cua helper socket=${socketPath}`);
    return this.#handle;
  }

  // [契约推断，待真机验证] darwin 官方 host 没有 waitForTransport（Windows 专属）；
  // fork 的 node.ts 消费面按「有则等待」调用，这里给出等价语义：已有 handle 直接返回
  // tuple；冷启动期优先暴露预留 tuple（rendezvous 语义），否则等待共享 startup。
  async waitForTransport(timeoutMs = 10_000) {
    if (this.#handle) return tupleOf(this.#handle);
    const reserved = this.reservedTransport;
    if (reserved) return reserved;
    const startup = this.#startInFlight;
    if (!startup) {
      throw new CuaHelperError("launch_failed", "ZCode Computer Use is not starting");
    }
    const handle = await waitForCuaHelperStartup(startup, timeoutMs);
    return tupleOf(handle);
  }

  async stop() {
    const stopGeneration = ++this.#stopGeneration;
    const startup = this.#startInFlight;
    if (startup) {
      try {
        await startup;
      } catch {
        /* 启动失败由 stopCurrentHandle 收敛 */
      }
    }
    if (stopGeneration === this.#stopGeneration) {
      await this.#stopCurrentHandle("stop", { allowSigkill: true }, true);
      await this.#completeRefreshMarkerAfterTransportRetired();
    }
  }

  async #stopCurrentHandle(reason, policy, allowPendingTermination = false) {
    const handle = this.#handle;
    if (handle?.pid == null && handle) {
      throw new CuaHelperError(
        "termination_failed",
        `Cannot terminate ZCode Computer Use (${reason}): live pid is unknown`,
      );
    }
    this.#handle = null;
    if (handle?.pid != null) {
      await this.#terminateHelperPid(
        handle.pid,
        reason,
        { socketPath: handle.launchSocketPath, helperAppPath: handle.helperAppPath },
        policy,
        allowPendingTermination,
      );
      await this.#finishPendingFailedLaunch(reason);
      await this.#releasePublishedReservation();
      return;
    }
    await this.#finishPendingTermination(reason, policy, allowPendingTermination);
    await this.#finishPendingFailedLaunch(reason);
    await this.#releasePublishedReservation();
  }

  async #releaseReservationIfUnpublished() {
    const reservation = this.#reservation;
    if (reservation?.holdsPublishedPath) {
      await reservation.release().catch(() => undefined);
      if (this.#reservation === reservation) {
        this.#reservation = null;
        this.#pendingReservedTuple = null;
      }
    }
  }

  async #releasePublishedReservation() {
    const reservation = this.#reservation;
    if (reservation) {
      await reservation.unlinkPublishedIfOwned().catch(() => undefined);
      if (this.#reservation === reservation) {
        this.#reservation = null;
        this.#pendingReservedTuple = null;
      }
    }
  }

  #assertNotExternallyStopped(stopGeneration) {
    if (this.#stopGeneration !== stopGeneration) {
      throw new CuaHelperError("launch_failed", "ZCode Computer Use restart aborted by stop()");
    }
  }

  #beginFreshRestart(stopGeneration) {
    const startup = (async () => {
      this.#assertNotExternallyStopped(stopGeneration);
      await this.#stopCurrentHandle("restart");
      await this.#completeRefreshMarkerAfterTransportRetired();
      this.#assertNotExternallyStopped(stopGeneration);
      return await this.#doStart(stopGeneration, undefined, "restart");
    })().finally(() => {
      if (this.#startInFlight === startup) this.#startInFlight = null;
    });
    this.#startInFlight = startup;
    return startup;
  }

  async #completeRefreshMarkerAfterTransportRetired() {
    const pending = this.#pendingRefreshMarker;
    if (pending) {
      pending.oldTransportRetired = true;
      await pending.handle.complete();
      if (this.#pendingRefreshMarker === pending) this.#pendingRefreshMarker = null;
    }
  }

  async #retryCompletedRefreshMarkerForLiveHandle() {
    const pending = this.#pendingRefreshMarker;
    const handle = this.#handle;
    if (!pending || !pending.oldTransportRetired || !handle) return null;
    if (handle.socketPath !== pending.socketPath) {
      throw new CuaHelperError(
        "termination_failed",
        "Cannot complete CUA permission refresh marker: live Helper transport no longer matches the pending marker",
      );
    }
    await pending.handle.complete();
    if (this.#pendingRefreshMarker === pending) this.#pendingRefreshMarker = null;
    return { handle, reused: true };
  }

  #beginTransportPreservingRestart(stopGeneration, handle) {
    const inFlight = (async () => {
      this.#assertNotExternallyStopped(stopGeneration);
      if (handle.pid == null) {
        throw new CuaHelperError(
          "termination_failed",
          "Cannot refresh ZCode Computer Use permissions: verified live pid is unavailable",
        );
      }
      const existing = this.#pendingRefreshMarker;
      if (existing && existing.socketPath !== handle.socketPath) {
        throw new CuaHelperError(
          "termination_failed",
          "Cannot replace a pending CUA permission refresh marker with a different transport",
        );
      }
      const markerHandle =
        existing?.handle ??
        (await publishCuaBrokerRefreshMarker(handle.socketPath, {
          deadlineMs:
            (this.#options.terminationTermGraceMs ?? TERMINATION_TERM_GRACE_MS) +
            LAUNCH_SERVICES_TIMEOUT_MS +
            (this.#options.healthTimeoutMs ?? HEALTH_TIMEOUT_DEFAULT_MS) +
            BROKER_LAUNCH_DEADLINE_SLACK_MS,
        }));
      const marker = existing ?? {
        socketPath: handle.socketPath,
        handle: markerHandle,
        oldTransportRetired: false,
      };
      this.#pendingRefreshMarker = marker;
      this.#assertNotExternallyStopped(stopGeneration);
      await this.#stopCurrentHandle("permission refresh", {
        allowSigkill: false,
        termGraceMs: this.#options.terminationTermGraceMs ?? TERMINATION_TERM_GRACE_MS,
      });
      marker.oldTransportRetired = true;
      this.#assertNotExternallyStopped(stopGeneration);
      const restarted = await this.#doStart(
        stopGeneration,
        { helperAppPath: handle.helperAppPath, socketPath: handle.socketPath },
        "restart",
      );
      await markerHandle.complete();
      if (this.#pendingRefreshMarker === marker) this.#pendingRefreshMarker = null;
      this.#assertNotExternallyStopped(stopGeneration);
      return restarted;
    })().finally(() => {
      if (this.#restartPreservingTransportInFlight === inFlight) {
        this.#restartPreservingTransportInFlight = null;
      }
    });
    this.#restartPreservingTransportInFlight = inFlight;
    return inFlight.then((handleAfter) => ({ handle: handleAfter, reused: true }));
  }

  async #finishPendingTermination(reason, policy, allowPendingTermination = false) {
    const pending = this.#pendingTermination;
    if (pending) {
      await this.#terminateHelperPid(
        pending.pid,
        reason,
        { socketPath: pending.socketPath, helperAppPath: pending.helperAppPath },
        policy ?? pending.policy,
        allowPendingTermination,
      );
      return;
    }
    await this.#terminationInFlight;
  }

  async #recordAndCleanupFailedLaunch(context, error, observedSocketOwnerPid = null) {
    const pending = this.#pendingFailedLaunch;
    if (
      pending &&
      (pending.socketPath !== context.socketPath || pending.helperAppPath !== context.helperAppPath)
    ) {
      throw new CuaHelperError(
        "termination_failed",
        "A previous failed ZCode Computer Use launch is still unresolved; refusing to replace its lifecycle blocker",
        { cause: error },
      );
    }
    this.#pendingFailedLaunch ??= {
      ...context,
      context: `startup failed: ${messageOf(error)}`,
      cancellationPublished: false,
    };
    this.#ensureFailedLaunchRevoked(this.#pendingFailedLaunch);
    try {
      if (observedSocketOwnerPid != null) {
        await this.#terminateHelperPid(
          observedSocketOwnerPid,
          "live process identity verification failed",
          context,
        );
      }
      await this.#finishPendingFailedLaunch("startup failure");
    } catch (cleanupError) {
      throw new CuaHelperError(
        "termination_failed",
        `ZCode Computer Use startup failed and the launched process could not be conclusively cleaned up: ${messageOf(cleanupError)}`,
        { cause: error },
      );
    }
  }

  async #finishPendingFailedLaunch(reason) {
    if (!this.#pendingFailedLaunch) {
      await this.#failedLaunchCleanupInFlight;
      return;
    }
    if (this.#failedLaunchCleanupInFlight) {
      await this.#failedLaunchCleanupInFlight;
      if (this.#pendingFailedLaunch) await this.#finishPendingFailedLaunch(reason);
      return;
    }
    const pending = this.#pendingFailedLaunch;
    this.#ensureFailedLaunchRevoked(pending);
    const cleanup = this.#runFailedLaunchCleanup(pending, reason)
      .then(() => {
        if (this.#pendingFailedLaunch === pending) this.#pendingFailedLaunch = null;
      })
      .finally(() => {
        if (this.#failedLaunchCleanupInFlight === cleanup) this.#failedLaunchCleanupInFlight = null;
      });
    this.#failedLaunchCleanupInFlight = cleanup;
    await cleanup;
  }

  async #runFailedLaunchCleanup(pending, reason) {
    const discover =
      this.#options.discoverLaunchedHelperProcesses ?? discoverCuaHelperLaunchProcesses;
    const pollIntervalMs = Math.max(
      1,
      this.#options.failedLaunchCleanupPollIntervalMs ?? FAILED_LAUNCH_CLEANUP_POLL_INTERVAL_MS,
    );
    const quietPollsNeeded = Math.max(
      1,
      Math.ceil(
        Math.max(0, this.#options.failedLaunchCleanupQuietMs ?? FAILED_LAUNCH_CLEANUP_QUIET_MS) /
          pollIntervalMs,
      ),
    );
    const delayMs = this.#options.failedLaunchCleanupDelay ?? defaultTerminationDelay;
    const now = this.#options.failedLaunchCleanupNow ?? Date.now;
    const deadlineEpochMs = pending.guard.deadlineEpochMs;
    // 轮询上限：静默窗 + sentinel 截止窗各留余量；超限仍未安静则按终止失败上抛，
    // 不允许失败清理无限自旋。
    const deadlinePolls = pending.cancellationPublished
      ? 0
      : Math.ceil(Math.max(0, deadlineEpochMs - now()) / pollIntervalMs);
    const maxPolls = Math.max(32, quietPollsNeeded + 8, deadlinePolls + quietPollsNeeded + 8);
    let quietPolls = 0;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const discovery = await discover({
        socketPath: pending.socketPath,
        helperAppPath: pending.helperAppPath,
      });
      if (discovery.state === "unknown") {
        throw new CuaHelperError(
          "termination_failed",
          `Cannot confirm failed ZCode Computer Use launch cleanup (${reason}): ${discovery.detail ?? "process identity is unknown"}`,
        );
      }
      if (discovery.state === "observed") {
        quietPolls = 0;
        const pids = [...new Set(discovery.pids)].filter((pid) => Number.isInteger(pid) && pid > 1);
        if (pids.length === 0) {
          throw new CuaHelperError(
            "termination_failed",
            `Failed ZCode Computer Use launch discovery returned observed without a valid pid (${reason})`,
          );
        }
        for (const pid of pids) {
          await this.#terminateHelperPid(pid, pending.context, {
            socketPath: pending.socketPath,
            helperAppPath: pending.helperAppPath,
          });
        }
      } else {
        quietPolls += 1;
        const deadlineReached = pending.cancellationPublished || now() >= deadlineEpochMs;
        if (quietPolls >= quietPollsNeeded && deadlineReached) return;
      }
      await delayMs(pollIntervalMs);
    }
    throw new CuaHelperError(
      "termination_failed",
      `Failed ZCode Computer Use launch did not reach a safely revoked quiet state (${reason})${
        pending.cancellationPublishError
          ? `; cancel sentinel: ${pending.cancellationPublishError}`
          : ""
      }`,
    );
  }

  #ensureFailedLaunchRevoked(pending) {
    if (pending.cancellationPublished) return;
    try {
      (this.#options.publishBrokerLaunchCancellation ?? publishCuaHelperBrokerLaunchCancellation)(
        pending.socketPath,
        pending.guard,
      );
      pending.cancellationPublished = true;
      pending.cancellationPublishError = undefined;
      try {
        (
          this.#options.scheduleBrokerLaunchGuardCleanup ??
          scheduleCuaHelperBrokerLaunchGuardCleanup
        )(pending.guard);
      } catch (error) {
        this.#options.logger?.warn?.(
          undefined,
          `failed to schedule cua helper launch-cancel cleanup: ${messageOf(error)}`,
        );
      }
    } catch (error) {
      pending.cancellationPublishError = messageOf(error);
    }
  }

  async #terminateHelperPid(
    pid,
    reason,
    context = {},
    policy = {},
    allowPendingTermination = false,
  ) {
    if (pid == null) return;
    if (this.#pendingTermination && this.#pendingTermination.pid !== pid) {
      throw new CuaHelperError(
        "termination_failed",
        `Cannot terminate ZCode Computer Use pid ${pid} (${reason}): pid ${this.#pendingTermination.pid} is still pending termination`,
      );
    }
    const effectivePolicy =
      !allowPendingTermination && this.#pendingTermination
        ? this.#pendingTermination.policy
        : {
            allowSigkill: policy.allowSigkill ?? true,
            termGraceMs:
              policy.termGraceMs ??
              this.#options.terminationTermGraceMs ??
              TERMINATION_TERM_GRACE_MS,
          };
    this.#pendingTermination ??= {
      pid,
      context: reason,
      ...context,
      policy: effectivePolicy,
    };
    if (this.#terminationInFlight) {
      await this.#terminationInFlight;
      if (this.#pendingTermination?.pid === pid) {
        await this.#terminateHelperPid(
          pid,
          reason,
          context,
          effectivePolicy,
          allowPendingTermination,
        );
      }
      return;
    }
    const termination = this.#runTerminationSequence(pid, reason, context, effectivePolicy)
      .catch((error) => {
        throw error instanceof CuaHelperError
          ? error
          : new CuaHelperError(
              "termination_failed",
              `Failed to confirm ZCode Computer Use pid ${pid} termination (${reason}): ${messageOf(error)}`,
              { cause: error },
            );
      })
      .then(() => {
        if (this.#pendingTermination?.pid === pid) this.#pendingTermination = null;
      })
      .finally(() => {
        if (this.#terminationInFlight === termination) this.#terminationInFlight = null;
      });
    this.#terminationInFlight = termination;
    await termination;
  }

  async #runTerminationSequence(pid, reason, context, policy) {
    if (
      this.#signalHelperIfStillOwned(pid, "SIGTERM", reason, context) &&
      !(await this.#waitForHelperDeparture(pid, policy.termGraceMs, reason, context))
    ) {
      if (!policy.allowSigkill) {
        throw new CuaHelperError(
          "termination_failed",
          `ZCode Computer Use pid ${pid} remained alive after SIGTERM (${reason}); SIGKILL is disabled for permission refresh`,
        );
      }
      if (
        this.#signalHelperIfStillOwned(pid, "SIGKILL", reason, context) &&
        !(await this.#waitForHelperDeparture(
          pid,
          this.#options.terminationKillGraceMs ?? TERMINATION_KILL_GRACE_MS,
          reason,
          context,
        ))
      ) {
        throw new CuaHelperError(
          "termination_failed",
          `ZCode Computer Use pid ${pid} remained alive after SIGTERM and SIGKILL (${reason})`,
        );
      }
    }
  }

  #signalHelperIfStillOwned(pid, signal, reason, context) {
    const evidence = this.#readHelperPidEvidence(pid, context);
    if (evidence.state === "unknown") {
      throw new CuaHelperError(
        "termination_failed",
        `Cannot safely signal ZCode Computer Use pid ${pid} (${reason}): ${evidence.reason ?? "process identity is unknown"}`,
      );
    }
    if (evidence.state !== "helper") {
      if (evidence.state === "unrelated") {
        const suffix = evidence.command ? ` (now: ${evidence.command})` : "";
        this.#options.logger?.warn?.(
          undefined,
          `skipping ${signal} of cua helper pid ${pid} (${reason}): ${evidence.reason ?? "pid no longer looks like our Helper"}${suffix}`,
        );
      }
      return false;
    }
    try {
      (this.#options.killProcess ?? defaultKillProcess)(pid, signal);
    } catch (error) {
      this.#options.logger?.warn?.(
        undefined,
        `failed to send ${signal} to cua helper pid ${pid} (${reason}): ${messageOf(error)}`,
      );
    }
    return true;
  }

  async #waitForHelperDeparture(pid, graceMs, reason, context) {
    const pollIntervalMs = Math.max(
      1,
      this.#options.terminationPollIntervalMs ?? TERMINATION_POLL_INTERVAL_MS,
    );
    const polls = Math.max(1, Math.ceil(Math.max(0, graceMs) / pollIntervalMs));
    const delayMs = this.#options.terminationDelay ?? defaultTerminationDelay;
    for (let poll = 0; poll < polls; poll += 1) {
      await delayMs(pollIntervalMs);
      const evidence = this.#readHelperPidEvidence(pid, context);
      if (evidence.state === "unknown") {
        throw new CuaHelperError(
          "termination_failed",
          `Cannot confirm ZCode Computer Use pid ${pid} departure (${reason}): ${evidence.reason ?? "process identity is unknown"}`,
        );
      }
      if (evidence.state !== "helper") return true;
    }
    return false;
  }

  #readHelperPidEvidence(pid, context) {
    try {
      return this.#collectHelperPidEvidence(pid, context);
    } catch (error) {
      return { state: "unknown", reason: messageOf(error) };
    }
  }

  async restart() {
    return this.#startInFlight
      ? this.#startInFlight
      : this.#beginFreshRestart(this.#stopGeneration);
  }

  async restartAfterCurrentStart() {
    if (this.#restartAfterCurrentStartInFlight) return this.#restartAfterCurrentStartInFlight;
    const stopGeneration = this.#stopGeneration;
    const inFlight = (async () => {
      for (;;) {
        this.#assertNotExternallyStopped(stopGeneration);
        const startup = this.#startInFlight;
        if (!startup) break;
        try {
          await startup;
        } catch {
          /* 共享 startup 失败后由 beginFreshRestart 重启 */
        }
      }
      const handle = await this.#beginFreshRestart(stopGeneration);
      this.#assertNotExternallyStopped(stopGeneration);
      return handle;
    })().finally(() => {
      if (this.#restartAfterCurrentStartInFlight === inFlight) {
        this.#restartAfterCurrentStartInFlight = null;
      }
    });
    this.#restartAfterCurrentStartInFlight = inFlight;
    return inFlight;
  }

  async restartAfterCurrentStartPreservingTransport(restartOptions = {}) {
    if (this.#restartPreservingTransportInFlight) return this.#restartPreservingTransportInFlight;
    const stopGeneration = this.#stopGeneration;
    const inFlight = (async () => {
      for (;;) {
        this.#assertNotExternallyStopped(stopGeneration);
        const startup = this.#startInFlight;
        if (!startup) break;
        try {
          await startup;
        } catch {
          /* 同上 */
        }
      }
      this.#assertNotExternallyStopped(stopGeneration);
      const refreshed = await this.#retryCompletedRefreshMarkerForLiveHandle();
      if (refreshed) return refreshed;
      const handle = this.#handle;
      if (!handle) {
        restartOptions.beforeFreshStart?.();
        const fresh = await this.#beginFreshRestart(stopGeneration);
        this.#assertNotExternallyStopped(stopGeneration);
        return { handle: fresh, reused: false };
      }
      return this.#beginTransportPreservingRestart(stopGeneration, handle);
    })().finally(() => {
      if (this.#restartPreservingTransportInFlight === inFlight) {
        this.#restartPreservingTransportInFlight = null;
      }
    });
    this.#restartPreservingTransportInFlight = inFlight;
    return inFlight;
  }

  async checkHealth(timeoutMs = 1_000) {
    if (!this.#handle) {
      throw new Error("CuaHelperHost.checkHealth called before start(); start the helper first");
    }
    const health = await (
      this.#options.healthProbe ??
      ((path, timeout) => probeHelperHealth(path, { timeoutMs: timeout }))
    )(this.#handle.socketPath, timeoutMs);
    if (!health || health.pid === null) {
      throw new CuaHelperError(
        "health_timeout",
        `ZCode Computer Use did not respond to a health probe within ${timeoutMs}ms.`,
      );
    }
    return health;
  }

  async queryPermissionStatus(timeoutMs = PERMISSION_STATUS_TIMEOUT_MS) {
    if (!this.#handle) {
      throw new Error(
        "CuaHelperHost.queryPermissionStatus called before start(); start the helper first",
      );
    }
    return await (
      this.#options.permissionStatusProbe ??
      ((path, timeout) =>
        callBrokerMethod({
          socketPath: path,
          method: "permission_status",
          timeoutMs: timeout,
        }))
    )(this.#handle.socketPath, timeoutMs);
  }

  async queryScreenRecordingPreflight(timeoutMs) {
    if (!this.#handle) return null;
    const preflight =
      this.#options.screenRecordingPreflight ?? readHelperScreenRecordingPreflightViaLaunchServices;
    const resultFilePath = join(
      dirname(this.#handle.socketPath),
      SCREEN_RECORDING_PREFLIGHT_DIR,
      `.screen-recording-preflight-${randomUUID()}.json`,
    );
    try {
      await mkdir(dirname(resultFilePath), { recursive: true, mode: 0o700 });
    } catch {
      return null;
    }
    return preflight({
      appPath: this.#handle.helperAppPath,
      resultFilePath,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  async queryScreenCaptureProbe(timeoutMs = SCREEN_CAPTURE_PROBE_TIMEOUT_MS) {
    if (!this.#handle) {
      throw new Error(
        "CuaHelperHost.queryScreenCaptureProbe called before start(); start the helper first",
      );
    }
    return await (
      this.#options.screenCaptureProbe ??
      ((path, timeout) =>
        callBrokerMethod({
          socketPath: path,
          method: "screen_capture_probe",
          timeoutMs: timeout,
        }))
    )(this.#handle.socketPath, timeoutMs);
  }
}

// 产品工厂：ghost cursor overlay / PiP=true 是 producer 固定产品策略（官方
// createProductCuaHelperHost 原样钉死），consumer 不传伪动态 getter。
export function createProductCuaHelperHost(options = {}) {
  const env = options.env ?? process.env;
  const helperInstaller =
    options.helperInstaller === false
      ? undefined
      : (options.helperInstaller ??
        createCuaHelperInstaller({
          logger: options.logger,
          env,
          bundledAppPath: options.bundledHelperAppPath,
        }));
  return new ProductCuaHelperHost({
    launcher: options.launcher ?? createLaunchServicesLauncher(),
    helperAppCandidates: productHelperCandidatePaths(env),
    helperInstaller,
    healthTimeoutMs: options.healthTimeoutMs,
    expectedBundleId: resolveExpectedCuaHelperBundleId(env),
    logger: options.logger,
    env,
    ghostCursorOverlay: true,
    verifyLiveProcessIdentity: options.verifyLiveProcessIdentity,
    ...(options.screenRecordingPreflight
      ? { screenRecordingPreflight: options.screenRecordingPreflight }
      : {}),
    pipMode: true,
  });
}

// ---------------------------------------------------------------------------
// agent env 退避标记（WeakMap 世代计数，官方 mark/has/clear 语义）
// ---------------------------------------------------------------------------

const agentEnvRecoveryStates = new WeakMap();

function recoveryStateFor(host) {
  let state = agentEnvRecoveryStates.get(host);
  if (!state) {
    state = { generation: 0, pendingGeneration: null };
    agentEnvRecoveryStates.set(host, state);
  }
  return state;
}

function pendingCuaProductHelperRecoveryGeneration(host) {
  return agentEnvRecoveryStates.get(host)?.pendingGeneration ?? null;
}

function commitCuaProductHelperRecoveryGeneration(host, generation) {
  const state = agentEnvRecoveryStates.get(host);
  if (!state || state.pendingGeneration !== generation) return false;
  state.pendingGeneration = null;
  return true;
}

export function markCuaProductHelperAgentEnvUnavailable(host) {
  const state = recoveryStateFor(host);
  state.generation += 1;
  state.pendingGeneration = state.generation;
  return state.generation;
}

export function hasCuaProductHelperAgentEnvUnavailable(host) {
  return pendingCuaProductHelperRecoveryGeneration(host) !== null;
}

export function clearCuaProductHelperAgentEnvUnavailable(host) {
  const state = agentEnvRecoveryStates.get(host);
  if (state) state.pendingGeneration = null;
}

// ---------------------------------------------------------------------------
// caller deadline race（官方 waitForCuaHelperStartup）
// ---------------------------------------------------------------------------

const WAIT_FOR_HELPER_STARTUP_DEFAULT_MS = 10_000;

export async function waitForCuaHelperStartup(
  startup,
  deadlineMs = WAIT_FOR_HELPER_STARTUP_DEFAULT_MS,
) {
  let timer;
  try {
    return await Promise.race([
      startup,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new CuaHelperError(
              "caller_timeout",
              `ZCode Computer Use is still starting after ${deadlineMs}ms; retry the task shortly`,
            ),
          );
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MCP server 识别 / 注入 / 解析器
// ---------------------------------------------------------------------------

function zcodeCuaArgLeaf(value) {
  return (
    value
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .pop() ?? value
  );
}

function matchesZCodeCuaSpec(value) {
  const normalized = value.replace(/_/g, "-");
  return (
    normalized === "zcode-cua" ||
    normalized.startsWith("zcode-cua[") ||
    normalized.startsWith("zcode-cua@") ||
    normalized.startsWith("zcode-cua==") ||
    normalized.startsWith("zcode-cua.")
  );
}

function hasZCodeCuaPackageBoundary(value) {
  return (
    value === "zcode-cua" ||
    value.startsWith("zcode-cua[") ||
    value.startsWith("zcode-cua@") ||
    value.startsWith("zcode-cua==") ||
    value.startsWith("zcode-cua.")
  );
}

function matchesZCodeCuaSpecBroad(value) {
  const normalized = value.toLowerCase().replace(/_/g, "-");
  if (hasZCodeCuaPackageBoundary(normalized)) return true;
  const dotted = normalized.replace(/([a-z0-9])\.(?=[a-z0-9])/g, "$1-");
  return hasZCodeCuaPackageBoundary(dotted);
}

function isZCodeCuaMcpServerName(name, pluginId) {
  const normalized = name.trim().toLowerCase();
  if (normalized === OFFICIAL_CUA_MCP_SERVER_NAME) return true;
  return (
    normalized === OFFICIAL_PLUGIN_MCP_SERVER_NAME &&
    pluginId?.trim().toLowerCase() === OFFICIAL_CUA_PLUGIN_ID
  );
}

function isZCodeCuaMcpCommand(command) {
  return matchesZCodeCuaSpec(command) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(command));
}

function isZCodeCuaMcpPackageArg(arg) {
  return matchesZCodeCuaSpec(arg) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(arg));
}

function resolvesToZCodeCuaPackage(server) {
  const candidates = [];
  const push = (value) => {
    if (!value) return;
    candidates.push(value);
    const leaf = zcodeCuaArgLeaf(value);
    if (leaf !== value) candidates.push(leaf);
  };
  push(server.command);
  if (server.args) for (const arg of server.args) push(arg);
  push(server.packageSpec);
  return candidates.some(matchesZCodeCuaSpecBroad);
}

function asCommandServer(server) {
  if (
    typeof server !== "object" ||
    server === null ||
    !("command" in server) ||
    typeof server.command !== "string"
  ) {
    return null;
  }
  return server;
}

function normalizeAgentMcpArgs(args) {
  return Array.isArray(args) ? args.filter((arg) => typeof arg === "string") : [];
}

function normalizeAgentMcpEnv(env) {
  return Array.isArray(env)
    ? env.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.name === "string" &&
          typeof entry.value === "string",
      )
    : [];
}

function upsertEnv(entries, name, value) {
  const next = entries.filter((entry) => entry.name !== name).map((entry) => ({ ...entry }));
  next.push({ name, value });
  return next;
}

// 「疑似 zcode-cua 形状的 agent MCP server」判定：命中后才进入 broker 注入/剥离分支。
export function isPotentialZCodeCuaAgentMcpServer(server) {
  const commandServer = asCommandServer(server);
  if (!commandServer) return false;
  const name = "name" in server && typeof server.name === "string" ? server.name : "";
  if (name.trim().toLowerCase().startsWith("plugin:")) {
    const env = normalizeAgentMcpEnv(commandServer.env);
    const pluginId = env.find((entry) => entry.name === PLUGIN_ID_ENV)?.value;
    if (isZCodeCuaMcpServerName(name, pluginId)) return true;
    const packageSpec = env.find((entry) => entry.name === PACKAGE_SPEC_ENV)?.value;
    if (packageSpec && isZCodeCuaMcpPackageArg(packageSpec)) return true;
  } else if (name && isZCodeCuaMcpServerName(name)) {
    return true;
  }
  if (isZCodeCuaMcpCommand(commandServer.command)) return true;
  return normalizeAgentMcpArgs(commandServer.args).some(isZCodeCuaMcpPackageArg);
}

function isOfficialZCodeCuaPluginCandidate(server) {
  const commandServer = asCommandServer(server);
  if (!commandServer) return false;
  const name = "name" in server && typeof server.name === "string" ? server.name : "";
  if (name.trim().toLowerCase() !== OFFICIAL_PLUGIN_MCP_SERVER_NAME) return false;
  return (
    normalizeAgentMcpEnv(commandServer.env)
      .find((entry) => entry.name === PLUGIN_ID_ENV)
      ?.value.trim()
      .toLowerCase() === OFFICIAL_CUA_PLUGIN_ID
  );
}

function isAuthorizedOfficialZCodeCuaPluginServer(server, pluginAuthority) {
  const authority = pluginAuthority?.trim();
  if (!authority || !isOfficialZCodeCuaPluginCandidate(server)) return false;
  return normalizeAgentMcpEnv(server.env).some(
    (entry) => entry.name === PLUGIN_AUTHORITY_ENV && entry.value === authority,
  );
}

function optionArgsBeforeTerminator(args) {
  const terminator = args.indexOf("--");
  return terminator === -1 ? args : args.slice(0, terminator);
}

function hasSeparateOptionValue(value) {
  return value !== undefined && value !== "--" && !value.startsWith("--");
}

function upsertFlag(args, flag, value) {
  const terminator = args.indexOf("--");
  const optionArgs = optionArgsBeforeTerminator(args);
  const positionalArgs = terminator === -1 ? [] : args.slice(terminator);
  const kept = [];
  for (let index = 0; index < optionArgs.length; index += 1) {
    if (optionArgs[index] === flag) {
      if (hasSeparateOptionValue(optionArgs[index + 1])) index += 1;
      continue;
    }
    if (!optionArgs[index]?.startsWith(`${flag}=`)) kept.push(optionArgs[index]);
  }
  args.splice(0, args.length, ...kept, flag, value, ...positionalArgs);
}

function injectPermissionBrokerAgentMcpServer(server, credentials) {
  if (!isAuthorizedOfficialZCodeCuaPluginServer(server, credentials.pluginAuthority)) return server;
  if (!credentials.socketPath || credentials.socketPath.trim().length === 0) {
    throw new Error("injectPermissionBrokerAgentMcpServers requires a non-empty socketPath");
  }
  const args = normalizeAgentMcpArgs(server.args);
  upsertFlag(args, PERMISSION_BROKER_SOCKET_FLAG, credentials.socketPath);
  const markerPath = cuaBrokerRefreshMarkerPath(credentials.socketPath);
  let env = upsertEnv(normalizeAgentMcpEnv(server.env), BROKER_SOCKET_ENV, credentials.socketPath);
  env = upsertEnv(env, REFRESH_MARKER_ENV, markerPath);
  return { ...server, args, env };
}

function injectPermissionBrokerAgentMcpServers(servers, credentials) {
  if (!servers || servers.length === 0 || !credentials.pluginAuthority?.trim()) return servers;
  const injected = servers.map((server) =>
    injectPermissionBrokerAgentMcpServer(server, credentials),
  );
  return injected.some((server, index) => server !== servers[index]) ? injected : servers;
}

function isUnbrokeredZCodeCuaAgentMcpServer(server) {
  const commandServer = asCommandServer(server);
  if (!commandServer) return false;
  const env = normalizeAgentMcpEnv(commandServer.env);
  const packageSpec = env.find((entry) => entry.name === PACKAGE_SPEC_ENV)?.value;
  const resolvesToCua = resolvesToZCodeCuaPackage({
    command: commandServer.command,
    args: normalizeAgentMcpArgs(commandServer.args),
    packageSpec,
  });
  return resolvesToCua
    ? !env.find((entry) => entry.name === BROKER_SOCKET_ENV)?.value?.trim()
    : false;
}

function omitUnbrokeredZCodeCuaAgentMcpServers(servers) {
  if (!servers || servers.length === 0) return servers;
  const filtered = servers.filter((server) => !isUnbrokeredZCodeCuaAgentMcpServer(server));
  return filtered.length === servers.length ? servers : filtered;
}

// 权限重启统一走「保 transport 的重启」：换代 marker 必须先于新代发布（官方
// restartCuaHelperPreservingTransport 的顺序约束）。
function restartCuaHelperPreservingTransport(host, markUnavailableGeneration) {
  let generationPublished = false;
  const beforeFreshStart = () => {
    if (!generationPublished) {
      generationPublished = true;
      markUnavailableGeneration();
    }
  };
  return (
    host.restartAfterCurrentStartPreservingTransport
      ? host.restartAfterCurrentStartPreservingTransport({ beforeFreshStart })
      : (beforeFreshStart(),
        host.restartAfterCurrentStart().then((handle) => ({ handle, reused: false })))
  ).then((result) => {
    if (!result.reused && !generationPublished) {
      throw new CuaHelperError(
        "launch_failed",
        "Computer Use Helper fresh permission restart launched before the unavailable generation was published",
      );
    }
    return result;
  });
}

// MCP server 解析器（官方 createCuaProductMcpServerResolver）：
// - 无 zcode-cua server：host 未运行时后台预热；原样返回。
// - 有疑似但无授权 official 插件 server：全部剥掉（agent 不应绕过 product broker）。
// - 有授权：等 Helper ready，只保留「非疑似或授权且 authority 是当前世代」的 server，
//   注入 socket + refresh marker，再剥掉无凭据的 zcode-cua 形状 server。
export function createCuaProductMcpServerResolver(host, options = {}) {
  let startInFlight = null;
  let restartInFlight = null;
  let restartAfterGrantInFlight = null;
  let reconcileInFlight = null;
  let nextAnonymousGrantId = 0;
  let lifecycleTail = Promise.resolve();
  const grantOperations = new Map();
  const completedGrants = new Set();

  const startHelper = () => {
    if (startInFlight) return startInFlight;
    const startup = host.start().finally(() => {
      if (startInFlight === startup) startInFlight = null;
    });
    startInFlight = startup;
    return startup;
  };

  const restartHelper = () => {
    if (restartInFlight) return restartInFlight;
    const previousRestart = restartAfterGrantInFlight;
    const operation = (async () => {
      if (previousRestart) await previousRestart.catch(() => undefined);
      return (
        await restartCuaHelperPreservingTransport(host, () =>
          markCuaProductHelperAgentEnvUnavailable(host),
        )
      ).handle;
    })().finally(() => {
      if (restartInFlight === operation) restartInFlight = null;
    });
    restartInFlight = operation;
    return operation;
  };

  const restartHelperAfterPermissionGrant = () => {
    if (restartAfterGrantInFlight) return restartAfterGrantInFlight;
    const previousRestart = restartInFlight;
    const operation = (async () => {
      if (previousRestart) await previousRestart.catch(() => undefined);
      return restartCuaHelperPreservingTransport(host, () =>
        markCuaProductHelperAgentEnvUnavailable(host),
      );
    })().finally(() => {
      if (restartAfterGrantInFlight === operation) restartAfterGrantInFlight = null;
    });
    restartAfterGrantInFlight = operation;
    return operation;
  };

  const currentLifecyclePromise = () =>
    restartAfterGrantInFlight
      ? restartAfterGrantInFlight.then((result) => result.handle)
      : (restartInFlight ?? startInFlight);

  const readLiveHelperTuple = () => {
    const running = host.running;
    const socketPath = host.socketPath;
    const pluginAuthority = host.pluginAuthority;
    return !running || !socketPath || !pluginAuthority ? null : { socketPath, pluginAuthority };
  };

  const helperTupleChanged = (tuple) => {
    const current = readLiveHelperTuple();
    return (
      current !== null &&
      (current.socketPath !== tuple.socketPath || current.pluginAuthority !== tuple.pluginAuthority)
    );
  };

  const reconcileSpawnAdmissionIfNeeded = async () => {
    for (;;) {
      if (!reconcileInFlight) {
        reconcileInFlight = (async () => {
          for (;;) {
            const lifecycle = currentLifecyclePromise();
            if (lifecycle) {
              await waitForCuaHelperStartup(lifecycle);
              continue;
            }
            const pendingGeneration = pendingCuaProductHelperRecoveryGeneration(host);
            if (pendingGeneration === null) return;
            if (
              readLiveHelperTuple() &&
              commitCuaProductHelperRecoveryGeneration(host, pendingGeneration)
            ) {
              return;
            }
            return;
          }
        })().finally(() => {
          reconcileInFlight = null;
        });
      }
      await reconcileInFlight;
      if (!hasCuaProductHelperAgentEnvUnavailable(host)) return;
    }
  };

  const stabilizeHelperTuple = async () => {
    for (;;) {
      const lifecycle = currentLifecyclePromise();
      if (lifecycle) {
        try {
          await waitForCuaHelperStartup(lifecycle);
        } catch (error) {
          if (!hasCuaProductHelperAgentEnvUnavailable(host)) {
            markCuaProductHelperAgentEnvUnavailable(host);
          }
          throw error;
        }
        continue;
      }
      await reconcileSpawnAdmissionIfNeeded();
      if (currentLifecyclePromise() || hasCuaProductHelperAgentEnvUnavailable(host)) continue;
      const tuple = readLiveHelperTuple();
      if (tuple) return tuple;
      markCuaProductHelperAgentEnvUnavailable(host);
      throw new CuaHelperError(
        "launch_failed",
        "ZCode Computer Use lifecycle completed without a live broker credential tuple",
      );
    }
  };

  const ensureHelperReady = async () => {
    const tuple = readLiveHelperTuple();
    if (!currentLifecyclePromise() && tuple) {
      try {
        await host.checkHealth(1_000);
      } catch {
        if (options.hasActiveTurn?.()) {
          throw new CuaHelperError(
            "restart_deferred_active_turn",
            "cua helper is unhealthy but an agent turn is active; deferring restart to the next request boundary",
          );
        }
        if (!currentLifecyclePromise() && !helperTupleChanged(tuple)) restartHelper();
      }
    } else if (!currentLifecyclePromise() && !tuple) {
      startHelper();
    }
    return stabilizeHelperTuple();
  };

  const warmHelperForBuiltInPlugin = () => {
    if (host.running || currentLifecyclePromise()) return;
    startHelper().catch(() => undefined);
  };

  const resolveMcpServersImpl = async (servers) => {
    const potential = servers?.filter(isPotentialZCodeCuaAgentMcpServer);
    if (!servers || !potential?.length) {
      if (!host.running) {
        warmHelperForBuiltInPlugin();
        return servers;
      }
      try {
        await ensureHelperReady();
      } catch {
        /* 预热失败不阻塞非 CUA server 的解析 */
      }
      return servers;
    }
    const currentAuthority = host.pluginAuthority ?? undefined;
    if (
      !potential.some(
        (server) =>
          isOfficialZCodeCuaPluginCandidate(server) &&
          isAuthorizedOfficialZCodeCuaPluginServer(server, currentAuthority),
      )
    ) {
      return servers.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server));
    }
    let tuple;
    try {
      tuple = await ensureHelperReady();
    } catch {
      if (!hasCuaProductHelperAgentEnvUnavailable(host))
        markCuaProductHelperAgentEnvUnavailable(host);
      return servers.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server));
    }
    const kept = servers.filter(
      (server) =>
        !isPotentialZCodeCuaAgentMcpServer(server) ||
        isAuthorizedOfficialZCodeCuaPluginServer(server, tuple.pluginAuthority),
    );
    return injectPermissionBrokerAgentMcpServers(kept, tuple);
  };

  const recoverHelper = async () => {
    await restartHelper();
    await reconcileSpawnAdmissionIfNeeded();
  };

  const restartAfterPermissionGrant = async (onboardingSessionId) => {
    const sessionId =
      onboardingSessionId?.trim() || `anonymous-grant-${(nextAnonymousGrantId += 1)}`;
    if (completedGrants.has(sessionId)) return Promise.resolve();
    const existing = grantOperations.get(sessionId);
    if (existing) return existing;
    const previousTail = lifecycleTail;
    const operation = (async () => {
      await previousTail.catch(() => undefined);
      await restartHelperAfterPermissionGrant();
      completedGrants.add(sessionId);
      if (completedGrants.size > 64) {
        const oldest = completedGrants.values().next().value;
        if (oldest) completedGrants.delete(oldest);
      }
    })().finally(() => {
      if (grantOperations.get(sessionId) === operation) grantOperations.delete(sessionId);
    });
    grantOperations.set(sessionId, operation);
    lifecycleTail = operation.catch(() => undefined);
    return operation;
  };

  return {
    async resolveMcpServers(servers) {
      const resolved = await resolveMcpServersImpl(servers);
      return omitUnbrokeredZCodeCuaAgentMcpServers(resolved);
    },
    async restart() {
      await recoverHelper();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      await restartAfterPermissionGrant(onboardingSessionId);
    },
    async reconcileRecoveredHelper() {
      if (currentLifecyclePromise()) return;
      if (hasCuaProductHelperAgentEnvUnavailable(host) && readLiveHelperTuple()) {
        await reconcileSpawnAdmissionIfNeeded();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// workspace 注册表 / 生命周期管理器 / 官方插件开关
// ---------------------------------------------------------------------------

export class CuaProductHelperWorkspaceRegistry {
  #targetsByWorkspaceKey = new Map();

  setEnabled(context, enabled) {
    if (!enabled) {
      this.#targetsByWorkspaceKey.delete(context.workspaceKey);
      return;
    }
    const target = {
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
    };
    this.#targetsByWorkspaceKey.set(context.workspaceKey, target);
  }

  snapshot() {
    return [...this.#targetsByWorkspaceKey.values()];
  }

  pruneDisabled(keep) {
    for (const [key, target] of this.#targetsByWorkspaceKey) {
      if (!keep(target)) this.#targetsByWorkspaceKey.delete(key);
    }
  }
}

// Helper 实例生命周期管理器（官方 Yh 语义）：串行转移（enqueue）、退役中实例、
// 终态后拒绝新 acquire、dispose 收敛 current + retiring。
export class CuaHelperLifecycleManager {
  #stopInstance;
  #current;
  #retiring;
  #terminal = false;
  #transitionTail = Promise.resolve();
  #disposePromise;

  constructor(dispose) {
    this.#stopInstance = dispose;
  }

  get disposed() {
    return this.#terminal;
  }

  isCurrent(managed) {
    return !this.#terminal && this.#current === managed;
  }

  peek() {
    return this.#terminal ? undefined : this.#current;
  }

  acquire(options) {
    return this.#enqueue(async () => {
      if (this.#terminal) return undefined;
      await this.#finishRetiringInstance();
      if (this.#terminal) return undefined;
      if (options && typeof options.isAdmitted === "function" && !options.isAdmitted()) {
        await this.#stopCurrentIfNeeded(options.shouldRetainCurrent);
        return undefined;
      }
      if (this.#current) return this.#current;
      this.#current = options?.create?.();
      return this.#current;
    });
  }

  reconcile(shouldRetainCurrent) {
    return this.#enqueue(async () => {
      if (this.#terminal) return;
      await this.#finishRetiringInstance();
      if (this.#terminal) return;
      await this.#stopCurrentIfNeeded(shouldRetainCurrent);
    });
  }

  dispose(managed) {
    if (this.#disposePromise) return this.#disposePromise;
    this.#terminal = true;
    const target = managed ?? this.#current;
    this.#disposePromise = this.#enqueue(async () => {
      const current = target ?? this.#current;
      const retiring = this.#retiring;
      this.#current = undefined;
      this.#retiring = undefined;
      const instances = [retiring, current].filter(
        (instance, index, all) => instance !== undefined && all.indexOf(instance) === index,
      );
      const failures = [];
      for (const instance of instances) {
        try {
          await this.#stopInstance(instance);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Failed to stop Computer Use Helper instances");
    });
    return this.#disposePromise;
  }

  async #stopCurrentIfNeeded(shouldRetainCurrent) {
    const current = this.#current;
    if (!current || shouldRetainCurrent?.(current)) return;
    this.#current = undefined;
    this.#retiring = current;
    await this.#finishRetiringInstance();
  }

  async #finishRetiringInstance() {
    const retiring = this.#retiring;
    if (!retiring) return;
    await this.#stopInstance(retiring);
    if (this.#retiring === retiring) this.#retiring = undefined;
  }

  #enqueue(operation) {
    const next = this.#transitionTail.then(operation, operation);
    this.#transitionTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const ZCODE_PROJECT_CONFIG_FILE_NAMES = Object.freeze([
  "zcode.json",
  join(".zcode", "config.json"),
]);

function hasWorktreeMarker(directory) {
  const marker = join(directory, ".git");
  try {
    if (!existsSync(marker)) return false;
    const info = statSync(marker);
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

function getProjectConfigDirectories(startDirectory) {
  const directories = [];
  let current = startDirectory;
  for (;;) {
    directories.push(current);
    if (hasWorktreeMarker(current)) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [startDirectory];
}

function readJsonObject(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function discoverZCodeProjectConfigPaths(workingDirectory) {
  return getProjectConfigDirectories(resolve(workingDirectory ?? process.cwd())).flatMap(
    (directory) =>
      ZCODE_PROJECT_CONFIG_FILE_NAMES.map((fileName) => join(directory, fileName)).filter((path) =>
        existsSync(path),
      ),
  );
}

// 判定式（与 fork official-plugin-definitions.ts 的 enabledPlugins[id] ?? defaultEnabled
// 同构）：默认关（product 决策），用户显式开启过的落盘 true 不受默认值影响。
function resolveOfficialCuaPluginEnablementState(request) {
  let mcpEnabled = true;
  let pluginsEnabled = true;
  let pluginEnabled = false;
  const configPaths = [
    ...(request.userConfigPath ? [request.userConfigPath] : []),
    ...discoverZCodeProjectConfigPaths(request.workingDirectory),
    ...(request.projectConfigPath ? [request.projectConfigPath] : []),
  ];
  for (const configPath of configPaths) {
    const parsed = readJsonObject(configPath);
    if (!parsed) continue;
    if (hasOwn(parsed, "features")) {
      const features = readObject(parsed.features);
      if (features) {
        if (hasOwn(features, "mcp")) mcpEnabled = features.mcp === true;
      } else {
        mcpEnabled = false;
      }
    }
    if (hasOwn(parsed, "plugins")) {
      const plugins = readObject(parsed.plugins);
      if (!plugins) {
        pluginsEnabled = false;
        pluginEnabled = false;
        continue;
      }
      if (hasOwn(plugins, "enabled")) pluginsEnabled = plugins.enabled === true;
      if (hasOwn(plugins, "enabledPlugins")) {
        const enabledPlugins = readObject(plugins.enabledPlugins);
        if (enabledPlugins) {
          if (hasOwn(enabledPlugins, request.pluginId)) {
            pluginEnabled = enabledPlugins[request.pluginId] === true;
          }
        } else {
          pluginEnabled = false;
        }
      }
    }
  }
  return { enabled: mcpEnabled && pluginsEnabled && pluginEnabled };
}

export function isOfficialCuaPluginEnabledForWorkspace(options = {}) {
  const home = (options.env ?? process.env).HOME?.trim() || homedir();
  return resolveOfficialCuaPluginEnablementState({
    pluginId: OFFICIAL_CUA_PLUGIN_ID,
    workingDirectory: options.workingDirectory,
    projectConfigPath: options.projectConfigPath,
    userConfigPath: options.userConfigPath ?? join(home, ".zcode", "cli", "config.json"),
  }).enabled;
}

// ---------------------------------------------------------------------------
// screen capture probe 成功判定（官方 isForeignWindowScreenCaptureProbeSuccess 全量谓词）
// ---------------------------------------------------------------------------

const PROBE_MAX_ATTEMPTED_WINDOWS = 3;
const PROBE_MIN_BOUNDS_WIDTH = 96;
const PROBE_MIN_BOUNDS_HEIGHT = 64;

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function pngDimensionsMatchWindow(rasterSize, windowContext) {
  const widthRatio = rasterSize.width / windowContext.bounds.width;
  const heightRatio = rasterSize.height / windowContext.bounds.height;
  if (
    !Number.isFinite(widthRatio) ||
    !Number.isFinite(heightRatio) ||
    widthRatio < 0.75 ||
    widthRatio > 4.5 ||
    heightRatio < 0.75 ||
    heightRatio > 4.5
  ) {
    return false;
  }
  return Math.max(widthRatio, heightRatio) / Math.min(widthRatio, heightRatio) <= 1.35;
}

function isDecodedNonPlaceholderPng(stats, rasterSize) {
  if (
    !stats ||
    stats.width !== rasterSize.width ||
    stats.height !== rasterSize.height ||
    !positiveSafeInteger(stats.sampleWidth) ||
    stats.sampleWidth > 64 ||
    !positiveSafeInteger(stats.sampleHeight) ||
    stats.sampleHeight > 64 ||
    !positiveSafeInteger(stats.sampledPixelCount) ||
    stats.sampledPixelCount > 4096 ||
    stats.sampledPixelCount !== stats.sampleWidth * stats.sampleHeight ||
    !Number.isSafeInteger(stats.visiblePixelCount) ||
    stats.visiblePixelCount < 0 ||
    stats.visiblePixelCount > stats.sampledPixelCount ||
    !Number.isSafeInteger(stats.distinctColorBucketCount) ||
    stats.distinctColorBucketCount < 0 ||
    stats.distinctColorBucketCount > stats.visiblePixelCount ||
    !Number.isSafeInteger(stats.dominantColorPixelCount) ||
    stats.dominantColorPixelCount < 0 ||
    stats.dominantColorPixelCount > stats.visiblePixelCount ||
    !Number.isSafeInteger(stats.maxChannelRange) ||
    stats.maxChannelRange < 0 ||
    stats.maxChannelRange > 255
  ) {
    return false;
  }
  const visibleFloor = Math.max(4, Math.ceil(stats.sampledPixelCount * 0.005));
  const nonDominantFloor = Math.max(3, Math.ceil(stats.sampledPixelCount * 0.0025));
  return (
    stats.visiblePixelCount >= visibleFloor &&
    stats.distinctColorBucketCount >= 3 &&
    stats.visiblePixelCount - stats.dominantColorPixelCount >= nonDominantFloor &&
    stats.maxChannelRange >= 24
  );
}

function validFiniteDimension(value, minimum) {
  return Number.isFinite(value) && value >= minimum && value <= 32768;
}

function validTargetBounds(bounds) {
  return (
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every((value) => typeof value === "number" && Number.isFinite(value)) &&
    validFiniteDimension(bounds[2], PROBE_MIN_BOUNDS_WIDTH) &&
    validFiniteDimension(bounds[3], PROBE_MIN_BOUNDS_HEIGHT)
  );
}

export function isScreenCaptureProbeSuccess(probe) {
  if (
    probe?.ok !== true ||
    probe.status !== "granted" ||
    probe.probed !== true ||
    probe.evidence !== "foreign_window" ||
    probe.content_evidence !== "decoded_visible_non_uniform" ||
    !Number.isSafeInteger(probe.probe_pid) ||
    probe.probe_pid <= 0 ||
    !Number.isSafeInteger(probe.target_window_id) ||
    probe.target_window_id <= 0 ||
    !Number.isSafeInteger(probe.target_owner_pid) ||
    probe.target_owner_pid <= 0 ||
    probe.target_owner_pid === probe.probe_pid ||
    probe.target_on_screen !== true ||
    !validTargetBounds(probe.target_bounds) ||
    !Number.isSafeInteger(probe.png_width) ||
    probe.png_width <= 0 ||
    !Number.isSafeInteger(probe.png_height) ||
    probe.png_height <= 0 ||
    !Number.isSafeInteger(probe.candidate_count) ||
    probe.candidate_count <= 0 ||
    !Number.isSafeInteger(probe.attempted_window_count) ||
    probe.attempted_window_count <= 0 ||
    probe.attempted_window_count > PROBE_MAX_ATTEMPTED_WINDOWS ||
    probe.attempted_window_count > probe.candidate_count ||
    !Number.isSafeInteger(probe.sample_width) ||
    probe.sample_width <= 0 ||
    !Number.isSafeInteger(probe.sample_height) ||
    probe.sample_height <= 0 ||
    !Number.isSafeInteger(probe.sampled_pixel_count) ||
    !Number.isSafeInteger(probe.visible_pixel_count) ||
    !Number.isSafeInteger(probe.distinct_color_bucket_count) ||
    !Number.isSafeInteger(probe.dominant_color_pixel_count) ||
    !Number.isSafeInteger(probe.max_channel_range) ||
    typeof probe.byte_length !== "number" ||
    probe.byte_length <= 0
  ) {
    return false;
  }
  const rasterSize = { width: probe.png_width, height: probe.png_height };
  const windowContext = {
    windowId: probe.target_window_id,
    ownerPid: probe.target_owner_pid,
    ownerBundleId: null,
    ownerName: null,
    ownerActive: false,
    title: null,
    bounds: {
      x: probe.target_bounds[0],
      y: probe.target_bounds[1],
      width: probe.target_bounds[2],
      height: probe.target_bounds[3],
    },
    onScreen: true,
  };
  return (
    pngDimensionsMatchWindow(rasterSize, windowContext) &&
    isDecodedNonPlaceholderPng(
      {
        width: rasterSize.width,
        height: rasterSize.height,
        sampleWidth: probe.sample_width,
        sampleHeight: probe.sample_height,
        sampledPixelCount: probe.sampled_pixel_count,
        visiblePixelCount: probe.visible_pixel_count,
        distinctColorBucketCount: probe.distinct_color_bucket_count,
        dominantColorPixelCount: probe.dominant_color_pixel_count,
        maxChannelRange: probe.max_channel_range,
      },
      rasterSize,
    )
  );
}

// ---------------------------------------------------------------------------
// AX 角色映射与原生 addon 面（[契约推断，待真机验证]：官方产物被 tree-shake，
// 仅 ROLE 映射表与 join("build","Release","ax_native.node") 相对形状可考）
// ---------------------------------------------------------------------------

export const ROLE_TO_KIND = Object.freeze({
  Button: "button",
  SplitButton: "button",
  MenuItem: "menuitem",
  Menu: "menuitem",
  MenuBar: "menuitem",
  Edit: "textfield",
  Document: "textarea",
  Password: "securefield",
  ComboBox: "combobox",
  CheckBox: "checkbox",
  RadioButton: "radio",
  Hyperlink: "link",
  Slider: "slider",
  ProgressBar: "slider",
  Text: "text",
  StatusBar: "text",
  Image: "image",
  ListItem: "row",
  DataItem: "row",
  TreeItem: "row",
  TabItem: "tab",
  Custom: "",
  Pane: "",
  Window: "",
  Group: "",
});

export function roleToKind(role) {
  return ROLE_TO_KIND[role];
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function findInTreeAddonPath(options = {}) {
  const startDirectory = options.fromDirectory ?? moduleDirectory;
  const relativeAddonPath = join("build", "Release", "ax_native.node");
  let current = startDirectory;
  for (;;) {
    const candidate = join(current, relativeAddonPath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolveInTreeAddonPath(options = {}) {
  return findInTreeAddonPath(options);
}

export function resolvePackagedNativeAddonPath(options = {}) {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath?.trim();
  if (!resourcesPath) return undefined;
  return findInTreeAddonPath({ fromDirectory: resourcesPath });
}

export function loadRealNativeAddon(options = {}) {
  const addonPath =
    options.addonPath ?? resolveInTreeAddonPath() ?? resolvePackagedNativeAddonPath();
  if (!addonPath) {
    throw new CuaHelperError(
      "helper_unavailable",
      "Computer Use native addon is not available in this build.",
    );
  }
  try {
    const require = createRequire(pathToFileURL(import.meta.url).href);
    return require(addonPath);
  } catch (error) {
    throw new CuaHelperError(
      "helper_unavailable",
      `Failed to load the Computer Use native addon at ${addonPath}: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

// [契约推断，待真机验证] 官方 createAxReadOnlyMethods 未随产物发布；按消费面实现：
// 把原生 AX source 的只读观测方法包装成 backend 方法表条目（registry 提供 admission）。
export function createAxReadOnlyMethods(source, registry, options = {}) {
  const readOnlyMethodNames = [
    "list_applications",
    "application_info",
    "list_windows",
    "capture_app",
    "element_at_point",
    "read_element",
    "supports_accessibility",
  ];
  const methods = {};
  for (const methodName of readOnlyMethodNames) {
    const handler = source?.[methodName];
    if (typeof handler !== "function") continue;
    methods[methodName] = async (params) => {
      if (registry && typeof registry.isAdmitted === "function" && !registry.isAdmitted()) {
        throw new CuaHelperError(
          "helper_unavailable",
          "Computer Use native backend is not admitted.",
        );
      }
      return await handler.call(source, params, options);
    };
  }
  return methods;
}
