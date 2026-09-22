import { resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";

/**
 * 社区版模型请求指纹头放行策略（PRIVACY-AUDIT.md A4/A5）。
 *
 * 客户端指纹头（版本、渠道、语言、平台、X-ZCode-Agent、HTTP-Referer 等）以及 Anthropic
 * metadata.user_id（内含持久 device_id）只对官方端点发送；用户自建的第三方 provider
 * 端点仅保留最简 User-Agent。ZCODE_SEND_CLIENT_HEADERS=0 为紧急总闸，官方端点也一并收紧。
 */
const FIXED_OFFICIAL_ZCODE_HOSTS = new Set([
  "zcode.z.ai",
  "z.ai",
  "api.z.ai",
  "chat.z.ai",
  "bigmodel.cn",
  "open.bigmodel.cn",
]);

type SourceHeaderEnv = Record<string, string | undefined>;

function hostnameOf(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isOfficialZCodeProviderEndpoint(
  baseURL: string | undefined,
  env: SourceHeaderEnv = process.env,
): boolean {
  const host = hostnameOf(baseURL);
  if (!host) {
    // 端点不可解析时按非官方处理：宁可少发指纹头，不向未知目标泄露客户端画像。
    return false;
  }
  if (FIXED_OFFICIAL_ZCODE_HOSTS.has(host)) {
    return true;
  }
  return host === hostnameOf(resolveRuntimeZCodeEndpointOrigin(env));
}

export function resolveModelSourceHeadersForEndpoint(
  headers: Record<string, string>,
  baseURL: string | undefined,
  env: SourceHeaderEnv = process.env,
): Record<string, string> {
  if (env.ZCODE_SEND_CLIENT_HEADERS === "0" || !isOfficialZCodeProviderEndpoint(baseURL, env)) {
    const userAgent = headers["User-Agent"];
    return userAgent ? { "User-Agent": userAgent } : {};
  }
  return headers;
}
