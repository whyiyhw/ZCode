import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppErrorBoundary, ScopedErrorBoundary } from "@/ErrorBoundary.js";

// 社区版口径（PRIVACY-AUDIT §十三）：React 错误边界的 ARMS 上报（reactErrorArmsTelemetry）
// 已随遥测栈裁剪；错误经 logger.error 本地落盘 + onCaughtReactError 回调交给宿主，
// 以下用例改为锚定这条保留链路。
describe("AppErrorBoundary", () => {
  it("出错后会渲染 fallback，而不是返回空白内容", () => {
    const boundary = new AppErrorBoundary({
      children: createElement("div", null, "ok"),
    });

    boundary.state = {
      error: new Error("boom"),
      componentStack: "\n    at BrokenPanel",
    };

    const html = renderToStaticMarkup(boundary.render());

    expect(html).toMatch(/应用界面出了点问题|The app ran into a problem/);
    expect(html).toMatch(/重试|Try again/);
    expect(html).toMatch(/刷新应用|Reload app/);
    expect(html).toContain("boom");
    expect(html).toContain("BrokenPanel");
  });

  it("会把非 Error 抛出值包装成 Error 对象", () => {
    const state = AppErrorBoundary.getDerivedStateFromError("plain text failure");

    expect(state.error?.message).toBe("plain text failure");
    expect(state.componentStack).toBe("");
  });

  it("局部边界出错后只渲染区域 fallback", () => {
    const boundary = new ScopedErrorBoundary({
      children: createElement("div", null, "ok"),
      scope: "workspace-chat",
      resetKeys: ["workspace-a", "task-a"],
    });

    boundary.state = {
      error: new Error("chat exploded"),
      componentStack: "\n    at ChatView",
    };

    const html = renderToStaticMarkup(boundary.render());

    expect(html).toMatch(/这块界面出了点问题|This section ran into a problem/);
    expect(html).toMatch(/重试此区域|Try this section again/);
    expect(html).toContain("chat exploded");
    expect(html).toContain("ChatView");
  });

  it("静默局部边界可以隐藏非关键浮层 fallback", () => {
    const boundary = new ScopedErrorBoundary({
      children: createElement("div", null, "ok"),
      scope: "desktop-top-overlay",
      variant: "silent",
    });

    boundary.state = {
      error: new Error("overlay exploded"),
      componentStack: "\n    at DesktopTopOverlay",
    };

    expect(renderToStaticMarkup(boundary.render())).toBe("");
  });

  it("根级边界 componentDidCatch 会把错误交给 onCaughtReactError（boundary 无 scope）", () => {
    const onCaughtReactError = vi.fn();
    const boundary = new AppErrorBoundary({
      children: createElement("div", null, "ok"),
      onCaughtReactError,
    });
    // jsdom 下 setState 在脱离 React 树时会走 noop updater，这里只验证回调副作用。
    boundary.setState = vi.fn();

    boundary.componentDidCatch(new Error("root boom"), {
      componentStack: "\n    at Root",
    });

    expect(onCaughtReactError).toHaveBeenCalledTimes(1);
    const [error] = onCaughtReactError.mock.calls[0]!;
    expect((error as Error).message).toBe("root boom");
  });

  it("局部边界 componentDidCatch 会带 scope 交给 onCaughtReactError", () => {
    const onCaughtReactError = vi.fn();
    const boundary = new ScopedErrorBoundary({
      children: createElement("div", null, "ok"),
      scope: "workspace-chat",
      onCaughtReactError,
    });
    boundary.setState = vi.fn();

    boundary.componentDidCatch(new Error("chat boom"), {
      componentStack: "\n    at ChatView",
    });

    expect(onCaughtReactError).toHaveBeenCalledTimes(1);
    const [error, errorInfo, scope] = onCaughtReactError.mock.calls[0]!;
    expect((error as Error).message).toBe("chat boom");
    expect((errorInfo as { componentStack?: string }).componentStack).toContain("ChatView");
    expect(scope).toBe("workspace-chat");
  });
});
