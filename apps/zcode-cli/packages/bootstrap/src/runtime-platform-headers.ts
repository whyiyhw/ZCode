import { arch as readOsArch } from "node:os";

const PRINTABLE_HEADER_VALUE_PATTERN = /^[\x20-\x7e]+$/;

export function createRuntimePlatformHeaders(): Record<string, string> {
  // 社区版隐私基线（PRIVACY-AUDIT.md A4）：OS 内核版本（readOsRelease）不再外发，
  // 仅保留平台/架构类别；与 shared 侧 zcode-source-headers 的策略保持一致。
  const platform = normalizePrintableHeaderValue(process.platform);
  const architecture = normalizePrintableHeaderValue(readOsArch());
  return {
    ...(platform && architecture ? { "X-Platform": `${platform}-${architecture}` } : {}),
    "X-Os-Category": normalizeOsCategory(process.platform),
  };
}

export function normalizePrintableHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !PRINTABLE_HEADER_VALUE_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
