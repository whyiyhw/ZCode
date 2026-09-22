// 自动更新子系统已移除（spec/auto-update-removal.md）：本文件原承载更新前的
// Windows 安装资源句柄清理（PowerShell 扫描 + taskkill）。现仅保留启动期
// bundled runtime 完整性诊断所需的资源目录快照。
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
