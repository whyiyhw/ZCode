// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DesktopCommandIds } from "@zcode/shared";
import { EmbeddedWebsiteHeader } from "@/components/EmbeddedWebsiteHeader.js";

const { executeDesktopCommand } = vi.hoisted(() => ({
  executeDesktopCommand: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ executeDesktopCommand }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("嵌入页（CodingPlan）的网页关闭与窗口关闭分开，三种窗口操作走现有命令", () => {
  // 社区版口径（PRIVACY-AUDIT §十六）：奖励中心与升级 overlay 已下线，
  // EmbeddedWebsiteHeader 现仅剩 CodingPlan 嵌入页消费，行为断言保持不变。
  const onClose = vi.fn();
  render(
    createElement(EmbeddedWebsiteHeader, {
      title: "Rewards",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      onBack: vi.fn(),
      onForward: vi.fn(),
      onReload: vi.fn(),
      onClose,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "common.close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(executeDesktopCommand).not.toHaveBeenCalled();
  for (const [id, command] of [
    ["minimize", DesktopCommandIds.MinimizeWindow],
    ["maximize", DesktopCommandIds.ToggleMaximizeWindow],
    ["close", DesktopCommandIds.CloseWindow],
  ]) {
    fireEvent.click(screen.getByTestId(`window-control-${id}`));
    expect(executeDesktopCommand).toHaveBeenLastCalledWith(command);
  }
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("登录页与 CodingPlan 嵌入页接入覆盖层窗控", async () => {
  // 社区版口径（PRIVACY-AUDIT §十六）：奖励中心（rewards/RewardsWebview）与升级 overlay
  // 已下线，接入方只剩登录页与 CodingPlan 嵌入页。
  const read = (file: string) => readFile(resolve(__dirname, "../src", file), "utf8");
  expect(await read("WelcomeScreen.tsx")).toContain("<DesktopOverlayWindowControls />");
  expect(await read("settings/CodingPlanEmbeddedWebviewDialog.tsx")).toContain(
    "<EmbeddedWebsiteHeader",
  );
});

it("登录页原生拖拽层避开窗控，并先于 no-drag 按钮声明", async () => {
  const source = await readFile(resolve(__dirname, "../src/WelcomeScreen.tsx"), "utf8");
  const drag = source.indexOf("[app-region:drag]");
  expect(drag).toBeGreaterThan(-1);
  expect(drag).toBeLessThan(source.indexOf("<DesktopOverlayWindowControls />"));
  expect(source).toContain("platform-windows-desktop:right-[134px]");
  expect(source).toContain("platform-linux-desktop:right-[134px]");
});
