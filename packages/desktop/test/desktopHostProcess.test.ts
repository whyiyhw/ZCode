import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import {
  disposeHostProcess,
  disposeHostProcessAndWait,
  listDisposingHostProcesses,
  loadWindow,
  spawnHostProcess,
} from "../src/main/desktopHostProcess.js";

vi.mock("../src/main/databaseStartupRelay.js", () => ({
  bindDatabaseStartupRelay: (_win: unknown, _child: unknown, startupId: string) => ({
    receive: vi.fn(),
    startupId,
  }),
}));

const electronMock = vi.hoisted(() => ({
  fork: vi.fn(),
  isPackaged: false,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  electronMock.isPackaged = false;
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/zcode-test"),
    get isPackaged() {
      return electronMock.isPackaged;
    },
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  MessageChannelMain: class {
    port1 = {};
    port2 = {};
  },
  utilityProcess: {
    fork: electronMock.fork,
  },
  webContents: {
    getAllWebContents: vi.fn(() => []),
  },
}));

class MockUtilityProcess extends EventEmitter {
  pid: number | undefined = 12345;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}

describe("desktopHostProcess loadWindow", () => {
  it("生产包忽略继承的开发服务器地址并加载内置页面", async () => {
    electronMock.isPackaged = true;
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5174");
    const window = {
      loadFile: vi.fn().mockResolvedValue(undefined),
      loadURL: vi.fn().mockResolvedValue(undefined),
    };

    await loadWindow(window as never);

    expect(window.loadURL).not.toHaveBeenCalled();
    expect(window.loadFile).toHaveBeenCalledOnce();
  });
});

describe("desktopHostProcess CUA operation state routing", () => {
  // 社区版口径（PRIVACY-AUDIT §十三）：Agent 异常上报（onAgentProcessException 钩子，
  // 转发至 desktopStabilityTelemetry 的 ARMS sendEvent）已随遥测整栈删除，
  // spawnHostProcess 不再有该选项，原 schema 校验路由用例移除。
  it("routes valid state with its Host source and clears the source on exit", () => {
    const child = new MockUtilityProcess();
    electronMock.fork.mockReturnValue(child);
    const onCuaOperationStateChanged = vi.fn();
    const onCuaOperationStateSourceExited = vi.fn();
    const win = {
      id: 7,
      webContents: {
        id: 11,
        postMessage: vi.fn(),
      },
    };

    spawnHostProcess(
      win as never,
      "local-window",
      { type: HostMessageTypes.InitLocal, workspacePath: "C:\\repo" },
      {
        hostProcessLocalEnv: {},
        logger: { info: vi.fn(), warn: vi.fn() },
        broadcastHub: { register: vi.fn(), unregister: vi.fn() } as never,
        windowHostProcessMap: new Map(),
        hostRunningTaskCountMap: new Map(),
        onCuaOperationStateChanged,
        onCuaOperationStateSourceExited,
      },
    );

    const initStartupId = child.postMessage.mock.calls[0]![0].databaseStartupId;
    expect(win.webContents.postMessage.mock.calls[0]![1]).toEqual({
      databaseStartupId: initStartupId,
    });
    const state = {
      type: HostResponseTypes.CuaOperationState,
      active: true,
      sessionId: "sess-1",
      turnId: "turn-1",
      workspacePath: "C:\\repo",
    };
    child.emit("message", state);

    expect(onCuaOperationStateChanged).toHaveBeenCalledWith(child, state);

    child.emit("message", { ...state, sessionId: "" });
    expect(onCuaOperationStateChanged).toHaveBeenCalledTimes(1);

    child.emit("exit", 0);
    expect(onCuaOperationStateSourceExited).toHaveBeenCalledOnce();
    expect(onCuaOperationStateSourceExited).toHaveBeenCalledWith(child);
  });
});

describe("desktopHostProcess local media preview authorization", () => {
  it("returns the canonical path produced by Main to the requesting Host", async () => {
    const child = new MockUtilityProcess();
    electronMock.fork.mockReturnValue(child);
    const authorizeLocalMediaPreviewPath = vi.fn(async () => "/real/video.mp4");
    const win = {
      id: 7,
      webContents: {
        id: 11,
        postMessage: vi.fn(),
      },
    };

    spawnHostProcess(
      win as never,
      "local-window",
      { type: HostMessageTypes.InitLocal, workspacePath: "/repo" },
      {
        hostProcessLocalEnv: {},
        logger: { info: vi.fn(), warn: vi.fn() },
        broadcastHub: { register: vi.fn(), unregister: vi.fn() } as never,
        windowHostProcessMap: new Map(),
        hostRunningTaskCountMap: new Map(),
        authorizeLocalMediaPreviewPath,
      },
    );

    child.emit("message", {
      type: HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest,
      requestId: "preview-request-1",
      path: "/linked/video.mp4",
    });

    await vi.waitFor(() => {
      expect(authorizeLocalMediaPreviewPath).toHaveBeenCalledWith("/linked/video.mp4");
      expect(child.postMessage).toHaveBeenCalledWith({
        type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
        requestId: "preview-request-1",
        ok: true,
        path: "/real/video.mp4",
      });
    });
  });
});

// 社区版口径：资源采样遥测（host 自采 heap 样本来源）已删除，对应 describe 移除。

describe("desktopHostProcess disposeHostProcessAndWait", () => {
  it("fire-and-forget 回收中的 Host 保留到 exit，供 app barrier 接管", () => {
    const child = new MockUtilityProcess();
    const timers = new WeakMap();
    const logger = { info: vi.fn(), warn: vi.fn() };

    disposeHostProcess(child as never, "window-closed", timers, logger, 10_000);
    expect(listDisposingHostProcesses()).toContain(child);

    child.emit("exit", 0);
    expect(listDisposingHostProcesses()).not.toContain(child);
  });

  it("运行中的 Electron UtilityProcess 没有 exitCode 时仍会发送 Dispose 并等待退出", async () => {
    const child = new MockUtilityProcess();
    const timers = new WeakMap();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    let resolved = false;

    const promise = disposeHostProcessAndWait(child as never, "app-before-quit-1", timers, logger, {
      forceKillDelayMs: 10_000,
      waitTimeoutMs: 10_000,
    }).then(() => {
      resolved = true;
    });

    expect(child.postMessage).toHaveBeenCalledTimes(1);
    expect(child.postMessage).toHaveBeenCalledWith({ type: HostMessageTypes.Dispose });

    await Promise.resolve();
    expect(resolved).toBe(false);

    child.pid = undefined;
    child.emit("exit", 0);

    await promise;
    expect(resolved).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("已观察到退出的 Electron UtilityProcess 不再重复发送 Dispose", async () => {
    const child = new MockUtilityProcess();

    const timers = new WeakMap();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const firstDispose = disposeHostProcessAndWait(child as never, "first-dispose", timers, logger);

    child.pid = undefined;
    child.emit("exit", 0);
    await firstDispose;

    await disposeHostProcessAndWait(child as never, "already-exited", timers, logger);

    expect(child.postMessage).toHaveBeenCalledTimes(1);
  });
});

// 社区版口径：MCP 资源样本来源（processResourceMcpTelemetrySource）与 PRT-010
// tool-exec 资源上报（desktopResourceTelemetry 的 ARMS perf_tool_exec_resource）已随
// 资源采样遥测删除，对应 describe 与顶层用例移除。

