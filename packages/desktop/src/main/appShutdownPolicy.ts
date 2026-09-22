// 自动更新子系统已移除（spec/auto-update-removal.md）：退出原因只剩 "normal"，
// "update-install" 分支随之删除；Windows 普通退出保留 Host 进程树兜底余量。
export type AppShutdownKind = "normal";

interface AppShutdownPolicy {
  forceKillDelayMs: number;
  waitTimeoutMs: number;
}

interface AppShutdownPolicySelection {
  kind: AppShutdownKind;
  policy: AppShutdownPolicy;
}

const STRICT_SHUTDOWN_POLICY: AppShutdownPolicy = {
  forceKillDelayMs: 7_500,
  waitTimeoutMs: 9_000,
};

const WINDOWS_NORMAL_SHUTDOWN_POLICY: AppShutdownPolicy = {
  // 普通退出仍给 Host 内部 3.5 秒进程树兜底留出执行时间。
  forceKillDelayMs: 4_000,
  waitTimeoutMs: 4_500,
};

export function resolveAppShutdownPolicy(
  kind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicy {
  if (platform === "win32" && kind === "normal") {
    return WINDOWS_NORMAL_SHUTDOWN_POLICY;
  }
  return STRICT_SHUTDOWN_POLICY;
}

export function selectAppShutdownPolicy(
  activeKind: AppShutdownKind | null,
  requestedKind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicySelection {
  return {
    kind: activeKind ?? requestedKind,
    policy: resolveAppShutdownPolicy(activeKind ?? requestedKind, platform),
  };
}
