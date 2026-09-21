import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import { setDataBaseDir } from "@zcode/services/node";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

// fork 隔离改动：Preview 身份的并排安装默认使用独立数据目录 ~/.zcode-preview，
// 不与正式版共用 ~/.zcode 的任务、配置与凭据（上游默认共享，见 desktopRuntimeEnv 的
// "Preview 与生产版共享任务、配置和凭据" 注释）。如需改回共享或指向其他目录，在
// ~/.zcode-preview/.zcode/v2/setting.json 里配置 dataBaseDir 即可。
const PREVIEW_ISOLATED_DATA_BASE_DIR_NAME = ".zcode-preview";

function resolvePreviewIsolatedDataBaseDir(): string | null {
  return isElectronAppPackaged() && ZCODE_PRODUCT_FLAVOR === "preview"
    ? join(homedir(), PREVIEW_ISOLATED_DATA_BASE_DIR_NAME)
    : null;
}

function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const previewDataBaseDir = resolvePreviewIsolatedDataBaseDir();
  const settingsFile = previewDataBaseDir
    ? resolveBootstrapSettingsFile(previewDataBaseDir)
    : resolveBootstrapSettingsFile();
  const dataBaseDir = readBootstrapDataBaseDirFromDisk(settingsFile) ?? previewDataBaseDir;
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
