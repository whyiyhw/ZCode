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
  /** @deprecated 社区版隐私基线（PRIVACY-AUDIT.md A2）：时区不再外发；字段保留以兼容调用方。 */
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  /** @deprecated 社区版隐私基线（PRIVACY-AUDIT.md A2）：OS 内核版本不再外发；字段保留以兼容调用方。 */
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
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
  const deviceMid = normalizeZCodeSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeZCodeSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  const platform = normalizeZCodeSourceHeaderValue(options.platform);
  const releaseChannel = normalizeZCodeSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeZCodeSourceHeaderValue(options.sourceTitle) ?? "electron";

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
