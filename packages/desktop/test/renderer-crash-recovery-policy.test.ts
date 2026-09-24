// 崩溃自愈策略单测（口径：packages/desktop/spec/renderer-crash-recovery.md）。
// 运行：npx tsx --test packages/desktop/test/renderer-crash-recovery-policy.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  CRASH_STORM_WINDOW_MS,
  DUPLICATE_EVENT_WINDOW_MS,
  LAUNCH_FAILED_BACKOFF_MS,
  MAX_AUTO_RELOADS,
  RendererCrashRecoveryPolicy,
} from "../src/main/rendererCrashRecoveryPolicy.js";

const CRASH_REASONS = [
  "oom",
  "crashed",
  "abnormal-exit",
  "integrity-failure",
  "memory-eviction",
  "killed",
];

test("reason 全集：崩溃类 reload、clean-exit ignore、未知值兜底 reload", () => {
  for (const reason of CRASH_REASONS) {
    const policy = new RendererCrashRecoveryPolicy();
    assert.deepEqual(
      policy.decide({ reason, appQuitting: false, windowDestroyed: false, now: 1000 }),
      {
        kind: "reload",
        attempt: 1,
      },
    );
  }
  assert.deepEqual(
    new RendererCrashRecoveryPolicy().decide({
      reason: "clean-exit",
      appQuitting: false,
      windowDestroyed: false,
      now: 1000,
    }),
    { kind: "ignore", because: "clean-exit" },
  );
  // 未归类值（未来 Electron 新枚举）：按崩溃类兜底，风暴预算封顶误恢复代价。
  assert.deepEqual(
    new RendererCrashRecoveryPolicy().decide({
      reason: "some-future-reason",
      appQuitting: false,
      windowDestroyed: false,
      now: 1000,
    }),
    { kind: "reload", attempt: 1 },
  );
});

test("退出中 / 窗口已销毁：崩溃类也不恢复", () => {
  const quitting = new RendererCrashRecoveryPolicy();
  assert.deepEqual(
    quitting.decide({ reason: "oom", appQuitting: true, windowDestroyed: false, now: 1000 }),
    { kind: "ignore", because: "app-quitting" },
  );
  const destroyed = new RendererCrashRecoveryPolicy();
  assert.deepEqual(
    destroyed.decide({ reason: "oom", appQuitting: false, windowDestroyed: true, now: 1000 }),
    { kind: "ignore", because: "window-destroyed" },
  );
});

test("launch-failed：冷启动 ignore 且不占配额；紧跟自动 reload 则 backoff 并计风暴", () => {
  const policy = new RendererCrashRecoveryPolicy();
  // 冷路径：与自动恢复无关的加载失败。
  assert.deepEqual(
    policy.decide({
      reason: "launch-failed",
      appQuitting: false,
      windowDestroyed: false,
      now: 1000,
    }),
    { kind: "ignore", because: "cold-launch-failed" },
  );
  // 冷 launch-failed 不计配额：随后的 oom 仍是 attempt 1。
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 4000 }),
    { kind: "reload", attempt: 1 },
  );
  // oom → reload → 起不来（launch-failed 紧跟）→ backoff 重试，占 attempt 2。
  assert.deepEqual(
    policy.decide({
      reason: "launch-failed",
      appQuitting: false,
      windowDestroyed: false,
      now: 8000,
    }),
    { kind: "backoff-reload", delayMs: LAUNCH_FAILED_BACKOFF_MS, attempt: 2 },
  );
  // 链条继续烧配额直到 give-up。
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 12000 }),
    { kind: "reload", attempt: 3 },
  );
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 16000 }),
    { kind: "give-up" },
  );
});

test("风暴预算按已决出的 reload 计数：超出即 give-up，窗口滚动过期后重置", () => {
  const policy = new RendererCrashRecoveryPolicy();
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 0 }),
    {
      kind: "reload",
      attempt: 1,
    },
  );
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 3000 }),
    { kind: "reload", attempt: 2 },
  );
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 6000 }),
    { kind: "reload", attempt: 3 },
  );
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 9000 }),
    { kind: "give-up" },
  );
  // 5 分钟窗口外的旧 reload 滚动过期，重新从 attempt 1 开始。
  assert.deepEqual(
    policy.decide({
      reason: "oom",
      appQuitting: false,
      windowDestroyed: false,
      now: 6000 + CRASH_STORM_WINDOW_MS + 1,
    }),
    { kind: "reload", attempt: 1 },
  );
});

test("同 reason 紧跟刚决出的 reload 视为重复投递吞掉；异 reason 不受影响", () => {
  const policy = new RendererCrashRecoveryPolicy();
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 0 }),
    {
      kind: "reload",
      attempt: 1,
    },
  );
  // 同 reason 100ms 内重复到达 = 同一物理崩溃的重复投递。
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 100 }),
    { kind: "ignore", because: "duplicate-delivery" },
  );
  // 异 reason（新物理失败，如 reload 后新进程以 crashed 形态死亡）不吞。
  assert.deepEqual(
    policy.decide({ reason: "crashed", appQuitting: false, windowDestroyed: false, now: 400 }),
    { kind: "reload", attempt: 2 },
  );
  // 同 reason 超过去重窗后照常计数（真崩溃不被吞）。
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 1000 }),
    { kind: "reload", attempt: 3 },
  );
});

test("去重窗边界：恰好压线（<=）吞掉、超线 1ms 计数（去重窗刻意取窄防白屏）", () => {
  const policy = new RendererCrashRecoveryPolicy();
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 0 }),
    {
      kind: "reload",
      attempt: 1,
    },
  );
  // 恰好 DUPLICATE_EVENT_WINDOW_MS：含等号，视为重复。
  assert.deepEqual(
    policy.decide({
      reason: "oom",
      appQuitting: false,
      windowDestroyed: false,
      now: DUPLICATE_EVENT_WINDOW_MS,
    }),
    { kind: "ignore", because: "duplicate-delivery" },
  );
  // 超 1ms：按新崩溃计数（接线层看门狗依赖此口径补发恢复）。
  assert.deepEqual(
    policy.decide({
      reason: "oom",
      appQuitting: false,
      windowDestroyed: false,
      now: DUPLICATE_EVENT_WINDOW_MS + 1,
    }),
    { kind: "reload", attempt: 2 },
  );
});

test("风暴窗边界：恰好满窗已过期（<，不含等号），差 1ms 仍在窗内", () => {
  const policy = new RendererCrashRecoveryPolicy();
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 0 }),
    {
      kind: "reload",
      attempt: 1,
    },
  );
  // 距上次 reload 恰好 CRASH_STORM_WINDOW_MS：已过期，attempt 重置为 1。
  assert.deepEqual(
    policy.decide({
      reason: "oom",
      appQuitting: false,
      windowDestroyed: false,
      now: CRASH_STORM_WINDOW_MS,
    }),
    { kind: "reload", attempt: 1 },
  );
  // 仍在窗内（距上一次 attempt 1 的 reload 差 1ms）：attempt 2。
  assert.deepEqual(
    policy.decide({
      reason: "oom",
      appQuitting: false,
      windowDestroyed: false,
      now: 2 * CRASH_STORM_WINDOW_MS - 1,
    }),
    { kind: "reload", attempt: 2 },
  );
});

test("give-up 之后窗口仍在的后续事件保持 give-up（幂等）", () => {
  const policy = new RendererCrashRecoveryPolicy();
  for (const now of [0, 3000, 6000]) {
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now });
  }
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 9000 }),
    {
      kind: "give-up",
    },
  );
  // give-up 也记录决策水位：异 reason 的后续事件保持 give-up，不回退成 reload。
  assert.deepEqual(
    policy.decide({ reason: "crashed", appQuitting: false, windowDestroyed: false, now: 9500 }),
    { kind: "give-up" },
  );
  // give-up 决策的同 reason 重复投递仍被去重吞掉（彼时应用已在退出，无行为差异）。
  assert.deepEqual(
    policy.decide({ reason: "crashed", appQuitting: false, windowDestroyed: false, now: 9600 }),
    { kind: "ignore", because: "duplicate-delivery" },
  );
  assert.deepEqual(
    policy.decide({ reason: "oom", appQuitting: false, windowDestroyed: false, now: 12000 }),
    {
      kind: "give-up",
    },
  );
  // give-up 也不是终态死刑：风暴窗滚动过期后配额重置（应用若未退出可再次恢复）。
  assert.deepEqual(
    policy.decide({
      reason: "oom",
      appQuitting: false,
      windowDestroyed: false,
      now: 9000 + CRASH_STORM_WINDOW_MS + 1,
    }),
    { kind: "reload", attempt: 1 },
  );
});

test("常量口径与 spec 一致", () => {
  assert.equal(MAX_AUTO_RELOADS, 3);
  assert.equal(CRASH_STORM_WINDOW_MS, 5 * 60_000);
  assert.equal(LAUNCH_FAILED_BACKOFF_MS, 5_000);
  assert.equal(DUPLICATE_EVENT_WINDOW_MS, 300);
});
