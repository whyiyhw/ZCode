import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// ARMS 远端 crash 上报已随遥测栈删除（E1+A1）；本地取证 crashReporter 兜底必须启动，
// 否则崩溃现场只剩空目录，无法回溯崩溃原因。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, false);
