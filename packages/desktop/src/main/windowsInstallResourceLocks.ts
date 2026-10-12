// 自动更新子系统已移除（spec/auto-update-removal.md）：本文件原承载更新前的
// Windows 安装资源句柄清理（PowerShell 扫描 + taskkill）。现仅保留启动期
// bundled runtime 完整性诊断所需的资源目录快照。
// 合并取舍（v3.15.1）：上游重新带回的 runWindowsUpdateProcessCleanup /
// findWindowsProcessesReferencingResourceMarkers / probeWindowsPackagedResourceWritable 等
// 安装锁清理机具仅服务于已删除的 auto-update 安装交接链（upstream index.ts 的
// prepareWindowsProcessesForUpdateInstall），按 COMMUNITY-EDITION「自动更新子系统整体删除」
// 口径继续剔除；保留的快照诊断与 NSIS 安装段补丁（scripts/patch-nsis-install-section.mjs）
// 即社区版安装锁修复的存活面。
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WINDOWS_PACKAGED_RESOURCE_DIRS = ["glm", "tools"];

interface WindowsPackagedResourceSnapshotEntry {
  dir: string;
  path: string;
  exists: boolean;
  entries: string[];
}

function listResourceEntries(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .slice(0, 20)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

export function snapshotWindowsPackagedResources(
  resourcesPath: string,
): WindowsPackagedResourceSnapshotEntry[] {
  return WINDOWS_PACKAGED_RESOURCE_DIRS.map((dir) => {
    const path = join(resourcesPath, dir);
    const exists = existsSync(path);
    return {
      dir,
      path,
      exists,
      entries: exists ? listResourceEntries(path) : [],
    };
  });
}
