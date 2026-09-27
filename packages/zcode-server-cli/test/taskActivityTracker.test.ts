// 心跳运行数单测（口径：docs/plans/conversation-telemetry-fact-trim-design.md——turn 链是
// 唯一保留的生产 fact，taskActivityTracker 是其唯一订阅方；shared schema 保留全分支作
// 旧版 CLI 上行的 strict 校验面，非 turn kind 解析后须被无害忽略）。
// 运行：npx tsx --test packages/zcode-server-cli/test/taskActivityTracker.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { IDisposable } from "@zcode/rpc";
import type {
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { createTaskActivityTracker } from "../src/server-core/taskActivityTracker.js";

interface FactListener {
  (fact: ConversationTelemetryFact): void;
}

function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

/** 只实现 tracker 依赖的两个事件面的内存版 agent source，按 workspace key 分发。 */
function createFakeAgentSource() {
  const lifecycleListeners = new Set<(event: ZCodeAgentRuntimeLifecycleEvent) => void>();
  const factListeners = new Map<string, Set<FactListener>>();
  const trackerDisposables = new Set<IDisposable>();
  return {
    source: {
      onAgentRuntimeLifecycle(
        listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void,
      ): IDisposable {
        lifecycleListeners.add(listener);
        const disposable = {
          dispose: () => {
            lifecycleListeners.delete(listener);
            trackerDisposables.delete(disposable);
          },
        };
        trackerDisposables.add(disposable);
        return disposable;
      },
      onDynamicConversationTelemetryFact(target: ZCodeAgentWorkspaceTarget) {
        const key = workspaceKey(target);
        const listeners = factListeners.get(key) ?? new Set<FactListener>();
        factListeners.set(key, listeners);
        return (listener: FactListener): IDisposable => {
          listeners.add(listener);
          const disposable = {
            dispose: () => {
              listeners.delete(listener);
              trackerDisposables.delete(disposable);
            },
          };
          trackerDisposables.add(disposable);
          return disposable;
        };
      },
    },
    emitLifecycle(event: ZCodeAgentRuntimeLifecycleEvent): void {
      for (const listener of lifecycleListeners) listener(event);
    },
    emitFact(target: ZCodeAgentWorkspaceTarget, kind: string, sessionId: string): void {
      const fact = { kind, sessionId } as ConversationTelemetryFact;
      for (const listener of factListeners.get(workspaceKey(target)) ?? []) {
        listener(fact);
      }
    },
    /** tracker.dispose() 应已摘除其全部订阅。 */
    hasLiveSubscriptions(): boolean {
      return trackerDisposables.size > 0;
    },
  };
}

function lifecycleEvent(
  overrides: Partial<ZCodeAgentRuntimeLifecycleEvent> & ZCodeAgentWorkspaceTarget,
): ZCodeAgentRuntimeLifecycleEvent {
  const key = overrides.workspaceKey ?? workspaceKey(overrides);
  return {
    workspaceKey: key,
    runtimeIdentity: { generation: 1, identity: "rt-1", workspaceKey: key },
    state: "available",
    ...overrides,
  };
}

test("turn.started/turn.terminal 驱动运行数；非 turn kind 无害忽略且不触发变更事件", () => {
  const fake = createFakeAgentSource();
  const tracker = createTaskActivityTracker(fake.source);
  const changes: number[] = [];
  tracker.onDidChangeRunningTaskCount((count) => changes.push(count));

  fake.emitLifecycle(lifecycleEvent({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }));
  assert.equal(tracker.readRunningTaskCount(), 0);
  assert.deepEqual(changes, []);

  fake.emitFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, "turn.started", "s1");
  fake.emitFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, "turn.started", "s2");
  assert.equal(tracker.readRunningTaskCount(), 2);
  assert.deepEqual(changes, [1, 2]);

  // 旧版 CLI 上行的非 turn fact（shared schema 仍放行的分支）不得影响运行数。
  fake.emitFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, "usage.delta", "s1");
  fake.emitFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, "tool.lifecycle", "s3");
  assert.equal(tracker.readRunningTaskCount(), 2);
  assert.deepEqual(changes, [1, 2]);

  fake.emitFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, "turn.terminal", "s1");
  assert.equal(tracker.readRunningTaskCount(), 1);
  assert.deepEqual(changes, [1, 2, 1]);
  tracker.dispose();
});

test("workspace 以 identity 优先去重：空白 identity 回退路径，跨 workspace 汇总", () => {
  const fake = createFakeAgentSource();
  const tracker = createTaskActivityTracker(fake.source);

  fake.emitLifecycle(lifecycleEvent({ workspacePath: "D:/w/a", workspaceIdentity: "  ia  " }));
  fake.emitLifecycle(lifecycleEvent({ workspacePath: "D:/w/a" }));
  fake.emitLifecycle(lifecycleEvent({ workspacePath: "D:/w/b", workspaceIdentity: "ib" }));

  fake.emitFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, "turn.started", "s1");
  // 同路径但无 identity 的 workspace 是独立条目（key 回退到路径），运行数累加。
  fake.emitFact({ workspacePath: "D:/w/a" }, "turn.started", "s2");
  fake.emitFact({ workspacePath: "D:/w/b", workspaceIdentity: "ib" }, "turn.started", "s3");
  assert.equal(tracker.readRunningTaskCount(), 3);

  // 终态按 sessionId 维度：关掉路径 key 下的会话不影响 identity key 的。
  fake.emitFact({ workspacePath: "D:/w/a" }, "turn.terminal", "s2");
  assert.equal(tracker.readRunningTaskCount(), 2);
  tracker.dispose();
});

test("available 重注册丢弃旧会话集合；unavailable 按 runtimeIdentity 匹配才摘除", () => {
  const fake = createFakeAgentSource();
  const tracker = createTaskActivityTracker(fake.source);
  const target = { workspacePath: "D:/w/a", workspaceIdentity: "ia" } as const;

  fake.emitLifecycle(
    lifecycleEvent({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }),
  );
  fake.emitFact(target, "turn.started", "s1");
  assert.equal(tracker.readRunningTaskCount(), 1);

  // 同 workspace 新 runtime available：旧集合整体作废（陈旧 run 防护）。
  fake.emitLifecycle(
    lifecycleEvent({
      workspacePath: "D:/w/a",
      workspaceIdentity: "ia",
      runtimeIdentity: { generation: 2, identity: "rt-2", workspaceKey: "ia" },
    }),
  );
  assert.equal(tracker.readRunningTaskCount(), 0);
  fake.emitFact(target, "turn.started", "s2");
  assert.equal(tracker.readRunningTaskCount(), 1);

  // runtimeIdentity 不匹配的 unavailable（陈旧事件）不得摘除现任 workspace。
  fake.emitLifecycle(
    lifecycleEvent({
      workspacePath: "D:/w/a",
      workspaceIdentity: "ia",
      state: "unavailable",
      runtimeIdentity: { generation: 1, identity: "rt-1", workspaceKey: "ia" },
    }),
  );
  assert.equal(tracker.readRunningTaskCount(), 1);

  fake.emitLifecycle(
    lifecycleEvent({
      workspacePath: "D:/w/a",
      workspaceIdentity: "ia",
      state: "unavailable",
      runtimeIdentity: { generation: 2, identity: "rt-2", workspaceKey: "ia" },
    }),
  );
  assert.equal(tracker.readRunningTaskCount(), 0);
  tracker.dispose();
});

test("dispose 幂等且摘除全部订阅；undefined source 退化为常零", () => {
  const fake = createFakeAgentSource();
  const tracker = createTaskActivityTracker(fake.source);
  fake.emitLifecycle(lifecycleEvent({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }));
  fake.emitFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, "turn.started", "s1");
  assert.equal(tracker.readRunningTaskCount(), 1);

  tracker.dispose();
  tracker.dispose();
  assert.equal(tracker.readRunningTaskCount(), 0);
  assert.equal(fake.hasLiveSubscriptions(), false);

  // dispose 后生命周期重挂载与事实上行都不再生效。
  fake.emitLifecycle(lifecycleEvent({ workspacePath: "D:/w/c", workspaceIdentity: "ic" }));
  fake.emitFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, "turn.started", "s2");
  assert.equal(tracker.readRunningTaskCount(), 0);

  const trackerWithoutSource = createTaskActivityTracker(undefined);
  assert.equal(trackerWithoutSource.readRunningTaskCount(), 0);
  trackerWithoutSource.dispose();
});
