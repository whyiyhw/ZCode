// 主窗口渲染进程崩溃自愈策略（2026-09-24 白屏事故复盘）。
// 行为口径：packages/desktop/spec/renderer-crash-recovery.md；
// 方案：docs/plans/renderer-crash-recovery-and-long-session-design.md 批次 A。
//
// 纯决策模块：不 import electron、不持有计时器，时间由调用方注入，全分支可单测。
// 状态所有权：每个主窗口一份实例（desktopWindowLifecycle.createWindow 创建），
// 只记录「本窗口已决出的自动 reload」。风暴预算数的是策略自己决出的 reload，
// 不是 render-process-gone 事件本身——该事件存在同窗重复投递
// （browserGuestManager.ts:3006/4082 记录过投递不可靠），按事件计数会让
// 单次物理崩溃烧掉多份配额，过早触达 give-up。

/** 崩溃风暴滚动窗口内最多自动 reload 次数；超出即 give-up（退出应用）。 */
export const MAX_AUTO_RELOADS = 3;
/** 崩溃风暴的滚动窗口长度（ms）。 */
export const CRASH_STORM_WINDOW_MS = 5 * 60_000;
/** launch-failed 紧跟自动 reload 时的延迟重试间隔（ms），给系统释放内存留时间。 */
export const LAUNCH_FAILED_BACKOFF_MS = 5_000;
/**
 * 同 reason 的 render-process-gone 紧跟一次刚决出的 reload 到达时，视为同一物理
 * 崩溃的重复投递。重复投递与事件本体相邻到达（同一/相邻消息循环 tick）；而新进程
 * 「加载期内真实死亡」最快也要进程 spawn + bundle 解析（远超 300ms），落不进该窗口。
 * 刻意取窄：误判成真崩溃只是多一次 reload + 烧一格配额（风暴预算封顶），误判成
 * 重复则是无人补救的白屏——两种失败的代价不对称。残余风险（<300ms 的加载期死亡
 * 被吞）由接线层的 dom-ready 看门狗兜底（RECOVERY_DOM_READY_WATCHDOG_MS）。
 */
export const DUPLICATE_EVENT_WINDOW_MS = 300;
/** 吞掉疑似重复投递后，等待 dom-ready 的看门狗时长（ms）：仍未就绪则重新决策。 */
export const RECOVERY_DOM_READY_WATCHDOG_MS = 4_000;

export interface RendererCrashRecoveryDecisionInput {
  /** Electron RenderProcessGoneReason 原值；归类全集见 spec 的 8 值表。 */
  reason: string;
  /** 退出流程已置位（forceQuit/explicitQuit）：renderer 死亡属受控退出，不恢复。 */
  appQuitting: boolean;
  windowDestroyed: boolean;
  now: number;
}

/** ignore 的可观测原因：接线层据此决定日志（cold-launch-failed 打 warn，其余静默或 info）。 */
export type RendererCrashRecoveryIgnoreBecause =
  | "app-quitting"
  | "window-destroyed"
  | "clean-exit"
  | "cold-launch-failed"
  | "duplicate-delivery";

export type RendererCrashRecoveryAction =
  | { kind: "ignore"; because: RendererCrashRecoveryIgnoreBecause }
  | { kind: "reload"; attempt: number }
  | { kind: "backoff-reload"; delayMs: number; attempt: number }
  | { kind: "give-up" };

// reason 归类的权威全集表在 spec（renderer-crash-recovery.md）：clean-exit → ignore；
// launch-failed → 条件 backoff；oom/crashed/abnormal-exit/integrity-failure/
// memory-eviction/killed 及一切未归类值（未来 Electron 新枚举，崩溃类新值远比良性
// 新值可能）→ reload 兜底，风暴预算封顶误恢复代价。新增枚举值必须回填 spec 全集表。
const IGNORED_REASONS: ReadonlySet<string> = new Set(["clean-exit"]);

export class RendererCrashRecoveryPolicy {
  /** 本窗口已决出的自动 reload 时间戳（含 backoff-reload），滚动裁剪。 */
  private autoReloadTimestamps: number[] = [];
  private lastDecidedReason: string | null = null;
  private lastDecidedAt: number | null = null;

  decide(input: RendererCrashRecoveryDecisionInput): RendererCrashRecoveryAction {
    if (input.appQuitting) {
      return { kind: "ignore", because: "app-quitting" };
    }
    if (input.windowDestroyed) {
      return { kind: "ignore", because: "window-destroyed" };
    }
    if (IGNORED_REASONS.has(input.reason)) {
      return { kind: "ignore", because: "clean-exit" };
    }
    if (this.isDuplicateDelivery(input)) {
      return { kind: "ignore", because: "duplicate-delivery" };
    }

    const isLaunchFailed = input.reason === "launch-failed";
    const recent = this.countRecentAutoReloads(input.now);
    if (isLaunchFailed && recent === 0) {
      // 与自动恢复无关的加载失败（冷启动/资源缺失）：reload 改变不了资源性失败，
      // 留 because 给调用方记 warn；oom→reload→起不来的链路则落到下面的 backoff。
      return { kind: "ignore", because: "cold-launch-failed" };
    }
    if (recent >= MAX_AUTO_RELOADS) {
      // give-up 也更新决策水位：后续异 reason 事件保持 give-up（幂等），
      // 同 reason 重复投递仍被去重吞掉（彼时调用方已在退出，无行为差异）。
      this.lastDecidedReason = input.reason;
      this.lastDecidedAt = input.now;
      return { kind: "give-up" };
    }

    const attempt = recent + 1;
    this.autoReloadTimestamps.push(input.now);
    this.lastDecidedReason = input.reason;
    this.lastDecidedAt = input.now;
    return isLaunchFailed
      ? { kind: "backoff-reload", delayMs: LAUNCH_FAILED_BACKOFF_MS, attempt }
      : { kind: "reload", attempt };
  }

  private isDuplicateDelivery(input: RendererCrashRecoveryDecisionInput): boolean {
    return (
      this.lastDecidedAt !== null &&
      this.lastDecidedReason === input.reason &&
      input.now - this.lastDecidedAt <= DUPLICATE_EVENT_WINDOW_MS
    );
  }

  private countRecentAutoReloads(now: number): number {
    this.autoReloadTimestamps = this.autoReloadTimestamps.filter(
      (timestamp) => now - timestamp < CRASH_STORM_WINDOW_MS,
    );
    return this.autoReloadTimestamps.length;
  }
}
