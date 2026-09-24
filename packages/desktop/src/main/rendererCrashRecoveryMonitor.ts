// 主窗口渲染进程崩溃自愈接线（2026-09-24 白屏事故复盘）。
// 行为口径：packages/desktop/spec/renderer-crash-recovery.md；
// 决策逻辑在 rendererCrashRecoveryPolicy.ts（纯函数），本模块只负责把决策接到
// webContents 生命周期上：reload / backoff / 看门狗 / give-up 退出。
import type { BrowserWindow } from "electron";
import {
  CRASH_STORM_WINDOW_MS,
  MAX_AUTO_RELOADS,
  RECOVERY_DOM_READY_WATCHDOG_MS,
  RendererCrashRecoveryPolicy,
} from "./rendererCrashRecoveryPolicy.js";

export interface RendererCrashRecoveryMonitorDeps {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  /** forceQuit/explicitQuit 置位后 renderer 死亡属受控退出，不恢复。 */
  isAppQuitting?: () => boolean;
  /**
   * give-up 兜底（崩溃风暴预算耗尽）：由 index.ts 实现为 markForceQuit + app.quit()。
   * 必须走注入回调而不是本模块直接 destroy——destroy 后 window-all-closed → app.quit()
   * 会撞上 before-quit 的退出确认弹窗（生产版 + 会话运行中必弹、无父窗口、默认取消），
   * 无人值守场景会被模态框挂死，spec 承诺的「直接退出」不成立。
   */
  onGiveUp?: () => void;
}

/**
 * 给主窗口挂渲染进程崩溃自愈。reload 复用 desktopWindowLifecycle 的 dom-ready
 * 重挂路径（存活 host 与运行中会话不受影响）；本模块自挂的 dom-ready 监听只记录
 * 就绪时间戳，与重挂 handler 相互独立。每个窗口一份策略实例，多窗口天然隔离。
 */
export function attachRendererCrashRecoveryMonitor(
  win: BrowserWindow,
  label: string,
  deps: RendererCrashRecoveryMonitorDeps,
): void {
  const policy = new RendererCrashRecoveryPolicy();
  // 就绪锚（攻击评审 P0 修正：不能用「动作后是否见过 dom-ready」的布尔——吞掉疑似
  // 重复前刚发生过 dom-ready 时，旧真值会让看门狗误判已恢复，死掉的 renderer 永无人
  // 补救）：看门狗只在「吞掉时刻之后无新 dom-ready」时补救；backoff 只在「决策之后
  // 无新 dom-ready」时执行（用户手动刷新恢复过就不强刷，防冲掉未提交草稿）。
  let lastDomReadyAt = 0;
  // 挂起的恢复定时器（backoff / 看门狗）全局仅允许一个：新恢复决策作废旧定时器，
  // 防止陈旧 backoff 在新一轮恢复进行中再插一枪（攻击评审 B1）。
  let pendingRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPendingRecoveryTimer = (): void => {
    if (pendingRecoveryTimer !== null) {
      clearTimeout(pendingRecoveryTimer);
      pendingRecoveryTimer = null;
    }
  };
  win.webContents.on("dom-ready", () => {
    lastDomReadyAt = Date.now();
  });

  // 恢复动作一律推迟到事件循环下一轮执行：在 render-process-gone 回调内同步调
  // webContents.reload() 会撞 Chromium 的 NOTREACHED "Observers can only be added
  // once!"（electron#48715，2026-09-24 真机复现），把恢复动作变成主进程崩溃——
  // 比不恢复更糟。退出同理。setImmediate 足以避开 crash 清理的竞态。
  const runRecoveryAction = (action: () => void): void => {
    setImmediate(() => {
      if (win.isDestroyed() || (deps.isAppQuitting?.() ?? false)) {
        return;
      }
      action();
    });
  };

  const runRecoveryDecision = (reason: string): void => {
    const action = policy.decide({
      reason,
      appQuitting: deps.isAppQuitting?.() ?? false,
      windowDestroyed: win.isDestroyed(),
      now: Date.now(),
    });
    switch (action.kind) {
      case "reload":
        deps.logger.info(
          `[renderer-recovery] render-process-gone reason=${reason}, auto-reload ${action.attempt}/${MAX_AUTO_RELOADS} (${label})`,
        );
        clearPendingRecoveryTimer();
        runRecoveryAction(() => win.webContents.reload());
        return;
      case "backoff-reload": {
        deps.logger.info(
          `[renderer-recovery] render-process-gone reason=${reason} right after auto-reload, backoff ${action.delayMs}ms then reload ${action.attempt}/${MAX_AUTO_RELOADS} (${label})`,
        );
        clearPendingRecoveryTimer();
        const decidedAt = Date.now();
        pendingRecoveryTimer = setTimeout(() => {
          pendingRecoveryTimer = null;
          if (
            win.isDestroyed() ||
            (deps.isAppQuitting?.() ?? false) ||
            // 决策之后出现过 dom-ready：renderer 已自行恢复（如用户手动刷新）。
            lastDomReadyAt > decidedAt
          ) {
            return;
          }
          win.webContents.reload();
        }, action.delayMs);
        return;
      }
      case "give-up": {
        const summary = `[renderer-recovery] render-process-gone reason=${reason}, auto-reload budget exhausted (${MAX_AUTO_RELOADS} reloads/${CRASH_STORM_WINDOW_MS / 60_000}min), quitting app (${label})`;
        if (deps.logger.error) {
          deps.logger.error(summary);
        } else {
          deps.logger.warn(summary);
        }
        clearPendingRecoveryTimer();
        runRecoveryAction(() => {
          if (deps.onGiveUp) {
            deps.onGiveUp();
          } else {
            win.destroy();
          }
        });
        return;
      }
      case "ignore":
        if (action.because === "cold-launch-failed") {
          deps.logger.warn(
            `[renderer-recovery] render-process-gone reason=launch-failed without prior auto-reload, not recovering (${label})`,
          );
        } else if (action.because === "duplicate-delivery") {
          deps.logger.info(
            `[renderer-recovery] render-process-gone reason=${reason} treated as duplicate delivery, watching for dom-ready (${label})`,
          );
          // 已有挂起的恢复（backoff/看门狗）时不另起看门狗：恢复已在路上，作废有效
          // backoff 会让同一物理尝试烧两格预算、把 5s 恢复拖成 4s 看门狗 + 重决策
          // （验证员二轮实测）。看门狗只兜底「无任何恢复在路上」的吞没。
          if (pendingRecoveryTimer !== null) {
            return;
          }
          // 去重窗刻意取窄（300ms），残余风险是「加载期真死亡（或快恢复后的二次真崩）
          // 被当重复吞掉」。看门狗：约 4s 且**吞掉时刻之后**无新 dom-ready 就重新决策
          // ——真死亡得到补发的 reload；真重复则新 renderer 早已就绪、看门狗空转。
          const swallowedAt = Date.now();
          pendingRecoveryTimer = setTimeout(() => {
            pendingRecoveryTimer = null;
            if (
              win.isDestroyed() ||
              deps.isAppQuitting?.() === true ||
              lastDomReadyAt > swallowedAt
            ) {
              return;
            }
            runRecoveryDecision(reason);
          }, RECOVERY_DOM_READY_WATCHDOG_MS);
        }
        return;
    }
  };

  win.webContents.on("render-process-gone", (_event, details) => {
    runRecoveryDecision(typeof details.reason === "string" ? details.reason : "unknown");
  });
}
