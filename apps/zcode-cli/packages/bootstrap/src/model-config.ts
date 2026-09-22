import type {
  AiSdkModelExecutionConfig,
  AiSdkNetworkConfig,
  EnvRecord,
} from "@zcode/adapters/model";
import {
  resolveRuntimeZCodeEnv,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_APP_VERSION_ENV,
} from "@zcode/shared";
import {
  createRuntimePlatformHeaders,
  normalizePrintableHeaderValue,
} from "./runtime-platform-headers.js";

export type ModelProviderSourceTitle = "cli" | "electron";

interface RuntimeExecutionConfigOptions {
  appVersion?: string;
  network?: AiSdkNetworkConfig;
  sourceTitle?: ModelProviderSourceTitle;
}

export function createRuntimeAiSdkModelExecutionConfig(
  env: EnvRecord = process.env,
  options: RuntimeExecutionConfigOptions = {},
): AiSdkModelExecutionConfig {
  const network = normalizeAiSdkNetworkConfig(options.network);
  return {
    defaultHeaders: buildCliZCodeSourceHeaders(env, options),
    env,
    ...(network ? { network } : {}),
  };
}

function normalizeAiSdkNetworkConfig(
  network: AiSdkNetworkConfig | undefined,
): AiSdkNetworkConfig | undefined {
  if (!network?.caCertFile && !network?.httpProxy && !network?.noProxy) return undefined;
  return {
    ...(network.caCertFile ? { caCertFile: network.caCertFile } : {}),
    ...(network.httpProxy ? { httpProxy: network.httpProxy } : {}),
    ...(network.noProxy ? { noProxy: network.noProxy } : {}),
  };
}

function buildCliZCodeSourceHeaders(
  env: EnvRecord,
  options: Pick<RuntimeExecutionConfigOptions, "appVersion" | "sourceTitle"> = {},
): Record<string, string> {
  // 社区版隐私基线（PRIVACY-AUDIT.md A4）：该头集合经 adapters 侧 model-source-header-policy
  // 按端点放行——仅官方端点收到全集，第三方 provider 只会收到最简 User-Agent；
  // 时区不外发，与 shared 侧 zcode-source-headers 策略一致。
  const sourceTitle = options.sourceTitle ?? detectDefaultProviderSourceTitle();
  const appVersion = resolveAppVersionForHeaders(env, options);
  const locale = normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().locale);
  return {
    "HTTP-Referer": resolveRuntimeZCodeEndpointOrigin(env),
    "User-Agent": `ZCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    "X-Release-Channel": resolveRuntimeZCodeEnv(env),
    "X-Client-Language": locale ?? "unknown",
    "X-ZCode-Agent": "glm",
    ...createRuntimePlatformHeaders(),
  };
}

function resolveAppVersionForHeaders(
  env: EnvRecord,
  options: Pick<RuntimeExecutionConfigOptions, "appVersion">,
): string | undefined {
  return normalizePrintableHeaderValue(env[ZCODE_APP_VERSION_ENV] ?? options.appVersion);
}

function detectDefaultProviderSourceTitle(): ModelProviderSourceTitle {
  return process.argv.includes("app-server") || process.argv.includes("agent-server")
    ? "electron"
    : "cli";
}
