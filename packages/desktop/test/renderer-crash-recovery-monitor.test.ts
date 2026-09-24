// 崩溃自愈接线单测（口径：packages/desktop/spec/renderer-crash-recovery.md）。
// 用 stub webContents + mock 定时器/时钟复现攻击评审的交错场景（S1/S6）作回归。
// 运行：npx tsx --test packages/desktop/test/renderer-crash-recovery-monitor.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { attachRendererCrashRecoveryMonitor } from "../src/main/rendererCrashRecoveryMonitor.js";

interface RecoveryHarness {
  crash(reason: string): Promise<void>;
  domReady(): void;
  /** 依序记录 reload/destroy/give-up 等接线层动作。 */
  actions: string[];
  logs: string[];
}

function createHarness(deps?: { onGiveUp?: () => void }): RecoveryHarness {
  const listeners = new Map<string, Array<(event: unknown, details: unknown) => void>>();
  const actions: string[] = [];
  const logs: string[] = [];
  const win = {
    isDestroyed: () => false,
    destroy: () => actions.push("destroy"),
    webContents: {
      on: (event: string, listener: (event: unknown, details: unknown) => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(listener);
        listeners.set(event, arr);
      },
      reload: () => actions.push("reload"),
    },
  };
  attachRendererCrashRecoveryMonitor(win as never, "local-test", {
    logger: {
      info: (...args: unknown[]) => logs.push(String(args[0])),
      warn: (...args: unknown[]) => logs.push(String(args[0])),
      error: (...args: unknown[]) => logs.push(String(args[0])),
    },
    onGiveUp: deps?.onGiveUp,
  });
  return {
    // 恢复动作经 setImmediate 推迟（electron#48715 规避），断言前先冲刷。
    crash: async (reason: string) => {
      for (const listener of listeners.get("render-process-gone") ?? []) {
        listener({}, { reason, exitCode: 1 });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    domReady: () => {
      for (const listener of listeners.get("dom-ready") ?? []) {
        listener({}, undefined);
      }
    },
    actions,
    logs,
  };
}

test("S1 回归：快恢复后 300ms 内二次真崩被吞，看门狗按吞没时刻补发 reload", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = createHarness();
  await h.crash("oom");
  assert.deepEqual(h.actions, ["reload"]);
  t.mock.timers.tick(250);
  h.domReady();
  t.mock.timers.tick(10);
  // 260ms 的同 reason 二次真崩落在去重窗内被吞——此刻不允许直接二次 reload。
  await h.crash("oom");
  assert.deepEqual(h.actions, ["reload"], "二次真崩在去重窗内应被吞");
  assert.ok(h.logs.some((line) => line.includes("duplicate delivery")));
  // 吞掉时刻之后没有新 dom-ready：看门狗必须补发 reload（布尔锚旧实现在此挂死）。
  t.mock.timers.tick(4_001);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.actions, ["reload", "reload"], "看门狗应补发 reload");
});

test("真重复投递：吞掉后 renderer 正常就绪，看门狗空转", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = createHarness();
  await h.crash("oom");
  t.mock.timers.tick(100);
  await h.crash("oom");
  assert.deepEqual(h.actions, ["reload"]);
  t.mock.timers.tick(900);
  h.domReady();
  t.mock.timers.tick(4_000);
  assert.deepEqual(h.actions, ["reload"], "吞掉之后已就绪，看门狗不得再 reload");
});

test("S6 回归：新恢复决策作废陈旧 backoff 定时器", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = createHarness();
  await h.crash("oom");
  t.mock.timers.tick(1_000);
  // launch-failed 紧跟 → backoff 定时器挂在 ~6.1s。
  await h.crash("launch-failed");
  assert.deepEqual(h.actions, ["reload"]);
  t.mock.timers.tick(2_000);
  h.domReady();
  t.mock.timers.tick(500);
  // 用户手动恢复后又真崩：reload#2 同时必须清掉陈旧 backoff。
  await h.crash("oom");
  assert.deepEqual(h.actions, ["reload", "reload"]);
  t.mock.timers.tick(5_000);
  assert.deepEqual(h.actions, ["reload", "reload"], "陈旧 backoff 不得再插一次 reload");
});

test("B1 锁死：backoff 挂起中（无 dom-ready）异 reason 二次崩，陈旧 backoff 不补枪", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = createHarness();
  await h.crash("oom");
  t.mock.timers.tick(1_000);
  // launch-failed → backoff 定时器 @~6.1s；全程不给 dom-ready，
  // 让恢复感知守卫帮不上忙，只有「新决策作废旧定时器」能拦住它。
  await h.crash("launch-failed");
  t.mock.timers.tick(500);
  await h.crash("oom");
  assert.deepEqual(h.actions, ["reload", "reload"]);
  t.mock.timers.tick(10_000);
  assert.deepEqual(h.actions, ["reload", "reload"], "无 dom-ready 时陈旧 backoff 也必须已被作废");
});

test("吞没不误杀挂起中的 backoff：重复投递后 backoff 仍按期执行", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = createHarness();
  await h.crash("oom");
  t.mock.timers.tick(1_000);
  await h.crash("launch-failed");
  t.mock.timers.tick(100);
  // 刚决出 backoff 的同 reason 重复投递：吞掉即可，不得作废 backoff 换看门狗
  // （否则同一物理尝试烧两格预算、5s 恢复拖成 ~14s）。
  await h.crash("launch-failed");
  assert.deepEqual(h.actions, ["reload"]);
  t.mock.timers.tick(5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.actions, ["reload", "reload"], "backoff 应按期执行而不是被看门狗顶替");
  assert.ok(h.logs.some((line) => line.includes("duplicate delivery")));
});

test("backoff 到期前 renderer 已自行恢复则不强刷", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = createHarness();
  await h.crash("oom");
  t.mock.timers.tick(500);
  await h.crash("launch-failed");
  t.mock.timers.tick(1_500);
  h.domReady();
  t.mock.timers.tick(4_000);
  assert.deepEqual(h.actions, ["reload"], "决策后已就绪，backoff 到期不得强刷");
});

test("give-up 走注入回调退出，不直接 destroy", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let giveUps = 0;
  const h = createHarness({
    onGiveUp: () => {
      giveUps += 1;
    },
  });
  await h.crash("oom");
  t.mock.timers.tick(3_000);
  await h.crash("oom");
  t.mock.timers.tick(3_000);
  await h.crash("oom");
  assert.deepEqual(h.actions, ["reload", "reload", "reload"]);
  t.mock.timers.tick(3_000);
  await h.crash("oom");
  assert.equal(giveUps, 1);
  assert.ok(
    h.actions.every((action) => action === "reload"),
    "give-up 不得走 destroy 回退",
  );
  assert.ok(h.logs.some((line) => line.includes("quitting app")));
});
