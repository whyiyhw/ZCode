import { readFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { join } from "node:path";
import {
  buildZCodeSourceHeadersFromContext,
  normalizeZCodeSourceHeaderValue,
  ZCODE_ENV,
  ZCODE_SOURCE_HEADERS,
  ZCODE_VERSION,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

export { ZCODE_SOURCE_HEADERS };

const log = createServiceLogger("source-headers");

interface ZCodeSourceHeaderOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  platform?: NodeJS.Platform;
  releaseChannel?: string;
  /** 计费等服务端硬契约链路：补 X-Client-Timezone / X-Os-Version / X-Device-Mid（PRIVACY-AUDIT.md A2 豁免）。 */
  serverContract?: boolean;
}

let cachedDeviceMid: { stateFile: string; value: string } | null = null;
let warnedContractMissingDeviceMid = false;

function normalizePrintableHeaderValue(value: string | undefined): string | undefined {
  return normalizeZCodeSourceHeaderValue(value);
}

function resolveClientLanguage(): string {
  return normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().locale) ?? "unknown";
}

function readExistingDeviceMid(): string | undefined {
  const stateFile = join(getAppConfigDir(), "telemetry-state.json");
  if (cachedDeviceMid?.stateFile === stateFile) {
    return cachedDeviceMid.value;
  }

  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as { deviceMid?: unknown };
    const deviceMid = normalizePrintableHeaderValue(
      typeof parsed.deviceMid === "string" ? parsed.deviceMid : undefined,
    );
    if (!deviceMid) {
      return undefined;
    }

    cachedDeviceMid = { stateFile, value: deviceMid };
    return deviceMid;
  } catch {
    // deviceMid 的生命周期由 desktop/telemetry 负责；这里仅复用已存在值，不生成新身份。
    return undefined;
  }
}

export function buildZCodeSourceHeaders(
  options: ZCodeSourceHeaderOptions = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const appVersion = normalizePrintableHeaderValue(options.appVersion ?? ZCODE_VERSION);
  const releaseChannel = normalizePrintableHeaderValue(options.releaseChannel ?? ZCODE_ENV);
  const clientLanguage =
    normalizePrintableHeaderValue(options.clientLanguage) ?? resolveClientLanguage();
  const deviceMid = readExistingDeviceMid();

  if (options.serverContract && !deviceMid && !warnedContractMissingDeviceMid) {
    // 计费契约链路缺设备标识时服务端可能仍拒绝请求；只提示一次，deviceMid 的生成
    // 归 desktop/telemetry 所有，这里不越权造新身份。
    warnedContractMissingDeviceMid = true;
    log.warn(
      "zcode-plan 计费契约头缺少 X-Device-Mid（telemetry-state.json 无 deviceMid）；" +
        "官方计费接口可能继续返回 parameter error。登录一次官方账号或恢复 telemetry 状态可补齐。",
    );
  }

  // 默认（非契约链路）时区与 OS 内核版本不进入头集合（PRIVACY-AUDIT.md A2/A3），
  // 避免每次请求白白计算被丢弃的指纹值；serverContract 链路按官方构建语义补齐。
  return buildZCodeSourceHeadersFromContext({
    appVersion,
    arch,
    clientLanguage,
    deviceMid,
    platform,
    releaseChannel,
    sourceTitle: "electron",
    ...(options.serverContract
      ? {
          clientTimezone: normalizePrintableHeaderValue(
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
          osVersion: normalizePrintableHeaderValue(osRelease()),
          serverContract: true,
        }
      : {}),
  });
}
