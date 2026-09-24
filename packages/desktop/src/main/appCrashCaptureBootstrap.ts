import { logger } from "./logger.js";
import {
  initializeCrashCapture,
  registerCrashEventMonitor,
  type CrashCapturePaths,
} from "./desktopCrashCapture.js";

// 先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// ARMS 远端 crash 上报已随遥测栈删除（E1+A1）；本地取证 crashReporter 兜底必须启动，
// 否则崩溃现场只剩空目录，无法回溯崩溃原因。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, false);
// 2026-09-24 白屏事故复盘：app 级 gone/unresponsive 监听此前从未注册
// （registerCrashEventMonitor 是死代码，当天主进程日志零崩溃记录），崩溃只剩下次
// 启动时的 dump 归档可查。激活本地取证日志与 dump 延迟归档；远端上报维持删除态。
registerCrashEventMonitor(logger, crashCapturePaths);
