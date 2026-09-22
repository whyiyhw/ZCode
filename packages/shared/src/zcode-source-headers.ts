import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "./zcodeEndpoint.js";

export const ZCODE_SOURCE_HEADERS = {
  "User-Agent": "ZCode/unknown",
  "HTTP-Referer": DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  "X-Title": "Z Code@electron",
} as const;

export interface BuildZCodeSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  /** 默认不外发（PRIVACY-AUDIT.md A2）；仅在 serverContract 链路作为计费契约值携带。 */
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  /** 默认不外发（PRIVACY-AUDIT.md A2）；仅在 serverContract 链路作为计费契约值携带。 */
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
  /**
   * 服务端硬契约链路（PRIVACY-AUDIT.md A2 豁免记录）：zcode-plan 计费接口缺失
   * X-Client-Timezone / X-Os-Version / X-Device-Mid 时返回 400 "parameter error"
   * （2026-09-22 dev 实测：production 环境且鉴权通过仍被拒）。仅由计费路径按需
   * 开启；语义对齐官方构建——时区缺失回退 "unknown"，OS 内核版本与设备标识仅
   * 在已有值时携带，其余请求维持社区版隐私基线。
   */
  serverContract?: boolean;
}

export function normalizeZCodeSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildZCodeSourceHeadersFromContext(
  options: BuildZCodeSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeZCodeSourceHeaderValue(options.appVersion);
  const arch = normalizeZCodeSourceHeaderValue(options.arch);
  const clientLanguage = normalizeZCodeSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeZCodeSourceHeaderValue(options.clientTimezone);
  const deviceMid = normalizeZCodeSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeZCodeSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  const osVersion = normalizeZCodeSourceHeaderValue(options.osVersion);
  const platform = normalizeZCodeSourceHeaderValue(options.platform);
  const releaseChannel = normalizeZCodeSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeZCodeSourceHeaderValue(options.sourceTitle) ?? "electron";
  const serverContract = options.serverContract === true;

  // 社区版隐私基线（PRIVACY-AUDIT.md A2/A3）：X-Client-Timezone 与 X-Os-Version 不属于任何已知
  // 服务端契约，直接移除；X-Device-Mid 是持久设备标识，默认不发送，仅显式设置
  // ZCODE_SEND_DEVICE_MID=true（官方计费等服务端契约确需时）才携带。
  const sendDeviceMid =
    typeof process !== "undefined" && process.env.ZCODE_SEND_DEVICE_MID === "true";

  return {
    ...ZCODE_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `ZCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(sendDeviceMid && deviceMid ? { "X-Device-Mid": deviceMid } : {}),
    ...(serverContract
      ? {
          "X-Client-Timezone": clientTimezone ?? "unknown",
          ...(osVersion ? { "X-Os-Version": osVersion } : {}),
          ...(deviceMid && !sendDeviceMid ? { "X-Device-Mid": deviceMid } : {}),
        }
      : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
