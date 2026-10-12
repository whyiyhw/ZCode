import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { WorkspaceHeaderActionSection as WorkspaceHeaderActionSectionType } from "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { createSettingsTestServices } from "./lib/settingsTestServices.js";

const capturedHeaderHelp = vi.hoisted(() => {
  // 社区版口径（PRIVACY-AUDIT §十三/§十四/§十五）：反馈中心（openSubmit/openFeatureRequest/
  // captureWindowScreenshot 截图上报）、社群入口（openCommunity）、会话分享入口均已下线，
  // 对应捕获桩不再保留。
  return {
    openExternal: vi.fn(),
    exportLogs: vi.fn(async () => ({ success: true })),
    menuItems: [] as Array<{
      onSelect: (() => void | Promise<void>) | undefined;
    }>,
    editorButtonProps: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/WorkspaceEditorButtonGroup.js", () => ({
  WorkspaceEditorButtonGroup: (props: Record<string, unknown>) => {
    capturedHeaderHelp.editorButtonProps.push(props);
    return createElement("div", { "data-testid": "workspace-editor-buttons" });
  },
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-content" }, children),
  // 桌面端帮助菜单在「资源管理器」项前有一条分隔线，mock 必须导出否则 SSR 渲染直接抛错。
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void | Promise<void>;
  }) => {
    capturedHeaderHelp.menuItems.push({ onSelect });
    return createElement("button", { type: "button" }, children);
  },
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    exportLogs: capturedHeaderHelp.exportLogs,
    openExternal: capturedHeaderHelp.openExternal,
  }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  dismissToast: vi.fn(),
  toast: vi.fn(() => 1),
}));

describe("WorkspaceHeaderActionSection", () => {
  // 快捷键特性后组件经 useShortcutCommandLabel 读设置，裸渲染需提供最小 ServiceProvider。
  // 等形包装：withSettingsServices(Comp, props) ≡ createElement(ServiceProvider, …, createElement(Comp, props))。
  function withSettingsServices(
    Component: typeof WorkspaceHeaderActionSectionType,
    props: Parameters<typeof WorkspaceHeaderActionSectionType>[0],
  ): ReactNode {
    return createElement(
      ServiceProvider,
      { services: createSettingsTestServices() },
      createElement(Component, props),
    );
  }

  // staging 新增用例：同样需要 Provider 包装（组件在快捷键特性后读设置）
  it("leaves the collapse action to the open side pane header", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");
    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: true,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );
    expect(html).not.toContain("sidePane.collapse");
    expect(html).not.toContain("sidePane.expand");
  });

  it("hides the editor selector but keeps shared actions in the draft variant", async () => {
    capturedHeaderHelp.editorButtonProps = [];
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        variant: "draft",
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );

    expect(capturedHeaderHelp.editorButtonProps).toHaveLength(0);
    expect(html).not.toContain('data-testid="workspace-editor-buttons"');
    expect(html).toContain("workspaceHeader.help.menu");
    expect(html).toContain("terminal.toggle");
    expect(html).toContain("sidePane.expand");
  });

  // 社区版口径（PRIVACY-AUDIT §十五）：会话分享 UI 入口（ConversationShareMenu /
  // conversationShare.trigger）已整体删除，「分享入口可见性」与「未登录隐藏分享」用例不再保留。

  it("renders the help menu trigger before the terminal toggle", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );

    expect(html).not.toContain("chat.summaryPanel.toggle");
    expect(html).toContain("workspaceHeader.help.menu");
    // 社区版口径（PRIVACY-AUDIT §十三/§十四）：issueReport/productRequest/community 菜单项已下线。
    expect(html).toContain("workspaceHeader.help.docs");
    expect(html).not.toContain("titleBar.menu.help.exportLogs");
    expect(html).toContain("terminal.toggle");
    expect(html).toContain("sidePane.expand");
    expect(html.indexOf("workspaceHeader.help.menu")).toBeLessThan(html.indexOf("terminal.toggle"));
  });

  it("hides the help menu and terminal toggle in narrow remote mode", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
        simplifyForNarrowRemote: true,
      }),
    );

    expect(html).not.toContain("workspaceHeader.help.menu");
    // 社区版口径（PRIVACY-AUDIT §十三）：issueReport 已下线，改用现存文档项断言菜单整体隐藏。
    expect(html).not.toContain("workspaceHeader.help.docs");
    expect(html).not.toContain("terminal.toggle");
    expect(html).toContain("sidePane.expand");
  });

  it("hides only the help menu when Windows caption menu owns help actions", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
        hideHelpMenu: true,
      }),
    );

    expect(html).not.toContain("workspaceHeader.help.menu");
    // 社区版口径（PRIVACY-AUDIT §十三）：issueReport 已下线，改用现存文档项断言菜单整体隐藏。
    expect(html).not.toContain("workspaceHeader.help.docs");
    expect(html).toContain("terminal.toggle");
    expect(html).toContain("sidePane.expand");
  });

  it("routes the docs help menu entry to the product docs URL", async () => {
    // 社区版口径（PRIVACY-AUDIT §十三/§十四）：反馈路由（openSubmit/openFeatureRequest/
    // openCommunity）与 issue 上报截图流程已下线，仅保留文档入口路由断言。
    capturedHeaderHelp.menuItems = [];
    capturedHeaderHelp.openExternal.mockClear();
    capturedHeaderHelp.exportLogs.mockClear();
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );

    // 非 desktop 渲染时帮助菜单只剩文档项。
    expect(capturedHeaderHelp.menuItems).toHaveLength(1);
    capturedHeaderHelp.menuItems[0]?.onSelect?.();

    expect(capturedHeaderHelp.openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://zcode.z.ai/docs",
    );
    expect(capturedHeaderHelp.exportLogs).not.toHaveBeenCalled();
  });

  it("passes SSH remote context to the editor button group", async () => {
    capturedHeaderHelp.editorButtonProps = [];
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");
    const remoteTarget = {
      kind: "ssh",
      host: "jumpserver.example.com",
      port: 2222,
      username: "asset01@root@192.168.100.166",
      sshConfigAlias: "zcode",
    };

    renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/root/demo-project",
        workspaceIdentity:
          "remote:ssh:jumpserver.example.com:2222:asset01@root@192.168.100.166:/root/demo-project",
        remoteTarget,
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );

    expect(capturedHeaderHelp.editorButtonProps[0]).toMatchObject({
      workspaceAbsPath: "/root/demo-project",
      workspaceIdentity:
        "remote:ssh:jumpserver.example.com:2222:asset01@root@192.168.100.166:/root/demo-project",
      remoteTarget,
    });
  });
});
