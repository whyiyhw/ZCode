// 心跳运行数单测（口径：docs/plans/conversation-telemetry-fact-trim-design.md——turn 链是
// 唯一保留的生产 fact，taskActivityTracker 是其唯一订阅方；shared schema 保留全分支作
// 旧版 CLI 上行的 strict 校验面，非 turn kind 解析后须被无害忽略）。
import { Emitter } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it } from "vitest";
import { createTaskActivityTracker } from "../src/server-core/taskActivityTracker.js";

function fact(
  kind: "turn.started" | "turn.terminal",
  sessionId: string,
): ConversationTelemetryFact {
  const base = {
    version: 1 as const,
    eventId: `${kind}-${sessionId}`,
    eventSeq: 1,
    occurredAt: Date.now(),
    sessionId,
  };
  return kind === "turn.started"
    ? { ...base, kind }
    : { ...base, kind, status: "success" as const };
}

/** 只实现 tracker 依赖的两个事件面的内存版 agent service，按 workspace key 分发。 */
function createFakeAgentService() {
  const lifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  const telemetryByWorkspace = new Map<string, Emitter<ConversationTelemetryFact>>();
  const workspaceKey = (target: ZCodeAgentWorkspaceTarget): string =>
    target.workspaceIdentity?.trim() || target.workspacePath;
  const agentService = {
    onAgentRuntimeLifecycle: lifecycle.event,
    onDynamicConversationTelemetryFact(target: ZCodeAgentWorkspaceTarget) {
      const key = workspaceKey(target);
      let emitter = telemetryByWorkspace.get(key);
      if (!emitter) {
        emitter = new Emitter<ConversationTelemetryFact>();
        telemetryByWorkspace.set(key, emitter);
      }
      return emitter.event;
    },
  } as Pick<IZCodeAgentService, "onAgentRuntimeLifecycle" | "onDynamicConversationTelemetryFact">;
  return {
    agentService,
    fireLifecycle(event: ZCodeAgentRuntimeLifecycleEvent): void {
      lifecycle.fire(event);
    },
    fireFact(target: ZCodeAgentWorkspaceTarget, fired: ConversationTelemetryFact): void {
      telemetryByWorkspace.get(workspaceKey(target))?.fire(fired);
    },
  };
}

function lifecycleEvent(
  overrides: Partial<ZCodeAgentRuntimeLifecycleEvent> & ZCodeAgentWorkspaceTarget,
): ZCodeAgentRuntimeLifecycleEvent {
  const key =
    overrides.workspaceKey ?? (overrides.workspaceIdentity?.trim() || overrides.workspacePath);
  return {
    workspaceKey: key,
    runtimeIdentity: { generation: 1, identity: "rt-1", workspaceKey: key },
    state: "available",
    ...overrides,
  };
}

describe("Core-local TaskActivityTracker", () => {
  it("turn.started/turn.terminal 驱动运行数；非 turn kind 无害忽略且不触发变更事件", () => {
    const fake = createFakeAgentService();
    const tracker = createTaskActivityTracker(fake.agentService);
    const changes: number[] = [];
    tracker.onDidChangeRunningTaskCount((count) => changes.push(count));
    const target = { workspacePath: "D:/w/a", workspaceIdentity: "ia" };

    fake.fireLifecycle(lifecycleEvent(target));
    expect(tracker.readRunningTaskCount()).toBe(0);
    expect(changes).toEqual([]);

    fake.fireFact(target, fact("turn.started", "s1"));
    fake.fireFact(target, fact("turn.started", "s2"));
    expect(tracker.readRunningTaskCount()).toBe(2);
    expect(changes).toEqual([1, 2]);

    // 旧版 CLI 上行的非 turn fact（shared schema 仍放行的分支）不得影响运行数。
    fake.fireFact(target, { kind: "usage.delta", sessionId: "s1" } as ConversationTelemetryFact);
    fake.fireFact(target, { kind: "tool.lifecycle", sessionId: "s3" } as ConversationTelemetryFact);
    expect(tracker.readRunningTaskCount()).toBe(2);
    expect(changes).toEqual([1, 2]);

    fake.fireFact(target, fact("turn.terminal", "s1"));
    expect(tracker.readRunningTaskCount()).toBe(1);
    expect(changes).toEqual([1, 2, 1]);
    tracker.dispose();
  });

  it("counts authoritative turn facts for all workspace clients and deduplicates by workspaceKey + sessionId", () => {
    const fake = createFakeAgentService();
    const tracker = createTaskActivityTracker(fake.agentService);
    const targetA = { workspacePath: "/same/path", workspaceIdentity: "ssh://host-a/repo" };
    const targetB = { workspacePath: "/same/path", workspaceIdentity: "ssh://host-b/repo" };

    fake.fireLifecycle(lifecycleEvent(targetA));
    fake.fireLifecycle(lifecycleEvent(targetB));

    fake.fireFact(targetA, fact("turn.started", "session-1"));
    fake.fireFact(targetA, fact("turn.started", "session-1"));
    fake.fireFact(targetB, fact("turn.started", "session-1"));
    expect(tracker.readRunningTaskCount()).toBe(2);

    fake.fireFact(targetA, fact("turn.terminal", "session-1"));
    expect(tracker.readRunningTaskCount()).toBe(1);

    fake.fireLifecycle(
      lifecycleEvent({ ...targetB, state: "unavailable" }),
    );
    expect(tracker.readRunningTaskCount()).toBe(0);
    tracker.dispose();
  });

  it("workspace 以 identity 优先去重：空白 identity 回退路径，跨 workspace 汇总", () => {
    const fake = createFakeAgentService();
    const tracker = createTaskActivityTracker(fake.agentService);

    fake.fireLifecycle(lifecycleEvent({ workspacePath: "D:/w/a", workspaceIdentity: "  ia  " }));
    fake.fireLifecycle(lifecycleEvent({ workspacePath: "D:/w/a" }));
    fake.fireLifecycle(lifecycleEvent({ workspacePath: "D:/w/b", workspaceIdentity: "ib" }));

    fake.fireFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, fact("turn.started", "s1"));
    // 同路径但无 identity 的 workspace 是独立条目（key 回退到路径），运行数累加。
    fake.fireFact({ workspacePath: "D:/w/a" }, fact("turn.started", "s2"));
    fake.fireFact({ workspacePath: "D:/w/b", workspaceIdentity: "ib" }, fact("turn.started", "s3"));
    expect(tracker.readRunningTaskCount()).toBe(3);

    // 终态按 sessionId 维度：关掉路径 key 下的会话不影响 identity key 的。
    fake.fireFact({ workspacePath: "D:/w/a" }, fact("turn.terminal", "s2"));
    expect(tracker.readRunningTaskCount()).toBe(2);
    tracker.dispose();
  });

  it("available 重注册丢弃旧会话集合；unavailable 按 runtimeIdentity 匹配才摘除", () => {
    const fake = createFakeAgentService();
    const tracker = createTaskActivityTracker(fake.agentService);
    const target = { workspacePath: "D:/w/a", workspaceIdentity: "ia" };

    fake.fireLifecycle(lifecycleEvent(target));
    fake.fireFact(target, fact("turn.started", "s1"));
    expect(tracker.readRunningTaskCount()).toBe(1);

    // 同 workspace 新 runtime available：旧集合整体作废（陈旧 run 防护）。
    fake.fireLifecycle(
      lifecycleEvent({
        workspacePath: "D:/w/a",
        workspaceIdentity: "ia",
        runtimeIdentity: { generation: 2, identity: "rt-2", workspaceKey: "ia" },
      }),
    );
    expect(tracker.readRunningTaskCount()).toBe(0);
    fake.fireFact(target, fact("turn.started", "s2"));
    expect(tracker.readRunningTaskCount()).toBe(1);

    // runtimeIdentity 不匹配的 unavailable（陈旧事件）不得摘除现任 workspace。
    fake.fireLifecycle(
      lifecycleEvent({
        workspacePath: "D:/w/a",
        workspaceIdentity: "ia",
        state: "unavailable",
        runtimeIdentity: { generation: 1, identity: "rt-1", workspaceKey: "ia" },
      }),
    );
    expect(tracker.readRunningTaskCount()).toBe(1);

    fake.fireLifecycle(
      lifecycleEvent({
        workspacePath: "D:/w/a",
        workspaceIdentity: "ia",
        state: "unavailable",
        runtimeIdentity: { generation: 2, identity: "rt-2", workspaceKey: "ia" },
      }),
    );
    expect(tracker.readRunningTaskCount()).toBe(0);
    tracker.dispose();
  });

  it("dispose 幂等且摘除全部订阅；dispose 后事件不再生效", () => {
    const fake = createFakeAgentService();
    const tracker = createTaskActivityTracker(fake.agentService);
    fake.fireLifecycle(lifecycleEvent({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }));
    fake.fireFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, fact("turn.started", "s1"));
    expect(tracker.readRunningTaskCount()).toBe(1);

    tracker.dispose();
    tracker.dispose();
    expect(tracker.readRunningTaskCount()).toBe(0);

    // dispose 后生命周期重挂载与事实上行都不再生效。
    fake.fireLifecycle(lifecycleEvent({ workspacePath: "D:/w/c", workspaceIdentity: "ic" }));
    fake.fireFact({ workspacePath: "D:/w/a", workspaceIdentity: "ia" }, fact("turn.started", "s2"));
    expect(tracker.readRunningTaskCount()).toBe(0);
  });

  it("publishes count changes immediately for Supervisor task-activity snapshots", () => {
    const lifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
    const telemetry = new Emitter<ConversationTelemetryFact>();
    const agentService = {
      onAgentRuntimeLifecycle: lifecycle.event,
      onDynamicConversationTelemetryFact: () => telemetry.event,
    } as Pick<IZCodeAgentService, "onAgentRuntimeLifecycle" | "onDynamicConversationTelemetryFact">;
    const tracker = createTaskActivityTracker(agentService);
    const counts: number[] = [];
    const subscription = tracker.onDidChangeRunningTaskCount((count) => counts.push(count));
    lifecycle.fire({
      workspacePath: "/repo",
      workspaceKey: "/repo",
      runtimeIdentity: { generation: 1, identity: "runtime", workspaceKey: "/repo" },
      state: "available",
    });
    telemetry.fire(fact("turn.started", "session"));
    telemetry.fire(fact("turn.terminal", "session"));
    expect(counts).toEqual([1, 0]);
    subscription.dispose();
    tracker.dispose();
  });
});
