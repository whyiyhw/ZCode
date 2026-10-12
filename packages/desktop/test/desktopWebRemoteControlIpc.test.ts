import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels, type WebRemoteControlContext } from "@zcode/shared";
import type { WebRemoteControlStartAuthorization } from "../src/main/webRemoteControlManager.js";

type IpcHandler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
}));

function withStartAuthorization(manager: {
  start(windowId: number, context: WebRemoteControlContext): Promise<unknown>;
  resetPairing(windowId: number, context: WebRemoteControlContext): Promise<unknown>;
  stop(windowId: number): Promise<void>;
  getStatus(windowId: number): unknown;
}) {
  return {
    ...manager,
    authorizeStart: vi.fn(
      (windowId: number, context: WebRemoteControlContext): WebRemoteControlStartAuthorization => ({
        token: `ticket-${windowId}`,
        expiresAt: Date.now() + 30_000,
        windowId,
        workspaceKey: context.workspaceIdentity?.trim() || context.workspacePath,
        ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
      }),
    ),
    startAuthorized: vi.fn(
      (
        windowId: number,
        context: WebRemoteControlContext,
        _authorization: WebRemoteControlStartAuthorization,
      ) => manager.start(windowId, context),
    ),
    resetPairingAuthorized: vi.fn(
      (
        windowId: number,
        context: WebRemoteControlContext,
        _authorization: WebRemoteControlStartAuthorization,
      ) => manager.resetPairing(windowId, context),
    ),
  };
}

vi.mock("electron", () => ({
  app: {
    getLocale: vi.fn(() => "zh-CN"),
    getPreferredSystemLanguages: vi.fn(() => ["zh-CN"]),
  },
  BrowserWindow: {
    fromWebContents: h.fromWebContents,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
  },
  dialog: {
    showMessageBox: h.showMessageBox,
  },
}));

// 社区版口径（PRIVACY-AUDIT §十六）：web-remote-control 保留，但其 usage 遥测上报分支
// （reportRemoteUsageEvent / web_remote_control_start_result 埋点）已随遥测栈删除，
// registerWebRemoteControlIpcHandlers 只剩窗口校验与 manager 委派；以下保留业务委派与
// 票据授权断言，移除埋点上报与「reporter 抛错容错」用例。
describe("Web Remote Control IPC", () => {
  beforeEach(() => {
    h.handlers.clear();
    h.fromWebContents.mockReset();
    h.fromWebContents.mockReturnValue({ id: 17 });
    h.showMessageBox.mockReset();
    h.showMessageBox.mockResolvedValue({ response: 1 });
  });

  it("显式启动委派给 manager 并透传结果，不叠加原生弹窗", async () => {
    const start = vi.fn(async () => ({ status: "running" }));
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      webRemoteControlManager: withStartAuthorization({
        start,
        resetPairing: vi.fn(),
        stop: vi.fn(),
        getStatus: vi.fn(),
      }),
    });

    const context = { workspacePath: "/workspace/local" };
    const result = await h.handlers.get(PlatformChannels.StartWebRemoteControl)?.(
      { sender: { id: 73 } },
      context,
    );

    expect(result).toEqual({ status: "running" });
    expect(start).toHaveBeenCalledWith(17, context);
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });

  it("重新配对委派给 manager 并透传结果", async () => {
    const resetPairing = vi.fn(async () => ({ status: "running" }));
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      webRemoteControlManager: withStartAuthorization({
        start: vi.fn(),
        resetPairing,
        stop: vi.fn(),
        getStatus: vi.fn(),
      }),
    });

    const context = {
      workspacePath: "/workspace/remote",
      workspaceIdentity: "remote:wsl:Ubuntu:/workspace/remote",
      remoteSessionId: "remote-session-1",
    };
    const result = await h.handlers.get(PlatformChannels.ResetWebRemoteControlPairing)?.(
      { sender: { id: 74 } },
      context,
    );

    expect(result).toEqual({ status: "running" });
    expect(resetPairing).toHaveBeenCalledWith(17, context);
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });

  it("启动失败时保留原错误向 renderer 透传", async () => {
    const error = Object.assign(new Error("relay websocket closed"), {
      code: "RELAY_CLOSED",
    });
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      webRemoteControlManager: withStartAuthorization({
        start: vi.fn(async () => {
          throw error;
        }),
        resetPairing: vi.fn(),
        stop: vi.fn(),
        getStatus: vi.fn(),
      }),
    });

    const operation = h.handlers.get(PlatformChannels.StartWebRemoteControl)?.(
      { sender: { id: 75 } },
      { workspacePath: "/workspace/local" },
    );

    await expect(operation).rejects.toBe(error);
  });

  it("内部票据只在 manager 提供的目标绑定接口中使用一次", async () => {
    const authorization: WebRemoteControlStartAuthorization = {
      token: "ticket-1",
      expiresAt: Date.now() + 30_000,
      windowId: 17,
      workspaceKey: "/workspace/local",
    };
    const authorizeStart = vi.fn(() => authorization);
    const startAuthorized = vi.fn(async () => ({ status: "running" }));
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      webRemoteControlManager: {
        startAuthorized,
        authorizeStart,
        resetPairingAuthorized: vi.fn(),
        stop: vi.fn(),
        getStatus: vi.fn(),
      },
    });

    const context = { workspacePath: "/workspace/local" };
    await expect(
      h.handlers.get(PlatformChannels.StartWebRemoteControl)?.({ sender: { id: 78 } }, context),
    ).resolves.toEqual({ status: "running" });
    expect(authorizeStart).toHaveBeenCalledWith(17, context);
    expect(startAuthorized).toHaveBeenCalledWith(17, context, authorization);
  });
});
