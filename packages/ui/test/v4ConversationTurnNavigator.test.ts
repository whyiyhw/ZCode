import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationTurnDirectoryItem } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import {
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorActiveUnitIndex,
  resolveConversationTurnNavigatorBarVisualState,
  resolveConversationTurnNavigatorHydrationRetryDelayMs,
  resolveConversationTurnNavigatorVisualFocusItemIndex,
  shouldHydrateConversationTurnNavigatorDirectory,
} from "@/v4/conversationTurnNavigatorHelpers.js";

// 社区版口径（PRIVACY-AUDIT §十五，会话分享删除的连带取舍）：上游 v3.15.1 把 rail 条目
// 构建改为客户端 renderUnits 链（buildConversationTurnNavigatorItems），该链仅服务于已删除
// 的会话分享；社区版保留 HEAD 的服务端目录模型（ConversationTurnDirectoryItem[]，推导在
// shared 的 buildConversationTurnDirectoryItems，CLI handler 与单测共用，覆盖见
// packages/shared/test/zcode-protocol-v4-turn-directory.test.ts）。上游带来的 TN02/TN06、
// TN05（客户端建项/realUser 过滤）用例随上游构建链不采用而移除；渲染类用例改按服务端
// 目录 props（directoryItems + unitIndexByRowId）驱动。

function directoryItem(
  overrides: Partial<ConversationTurnDirectoryItem> = {},
): ConversationTurnDirectoryItem {
  return {
    rowId: 2,
    turnId: "turn-1",
    userPreview: "First query",
    assistantPreview: "First answer",
    assistantPreviewKind: "text",
    isRunning: false,
    ...overrides,
  };
}

describe("conversation turn navigator helpers", () => {
  it("TN01/TN07：宽 conversation 允许探测完整目录，窄 conversation 零请求", () => {
    const base = {
      canLoadOlder: true,
      containerWidthPx: 864,
      hasLoadHandler: true,
      loadingOlder: false,
    };

    expect(
      shouldHydrateConversationTurnNavigatorDirectory({
        ...base,
        containerWidthPx: 863,
      }),
    ).toBe(false);
    expect(
      shouldHydrateConversationTurnNavigatorDirectory({
        ...base,
      }),
    ).toBe(true);
    expect(
      shouldHydrateConversationTurnNavigatorDirectory({
        ...base,
      }),
    ).toBe(true);
  });

  it("TN07：暂时失败只安排两次有界退避重试", () => {
    expect(resolveConversationTurnNavigatorHydrationRetryDelayMs(1)).toBe(250);
    expect(resolveConversationTurnNavigatorHydrationRetryDelayMs(2)).toBe(1_000);
    expect(resolveConversationTurnNavigatorHydrationRetryDelayMs(3)).toBeNull();
  });

  // 社区版口径（PRIVACY-AUDIT §十五）：上游 TN02/TN06、TN05 用例断言的客户端建项函数
  // buildConversationTurnNavigatorItems 属上游 renderUnits 构建链（仅服务已删除的会话分享），
  // 社区版不采用；realUser 过滤与多 query 建项语义已由服务端目录推导覆盖
  // （packages/shared/test/zcode-protocol-v4-turn-directory.test.ts）。

  it("resolves the active turn from the currently visible virtual rows", () => {
    const items = [
      { key: "turn-1", turnId: "turn-1", unitIndex: 0 },
      { key: "turn-2", turnId: "turn-2", unitIndex: 4 },
      { key: "turn-3", turnId: "turn-3", unitIndex: 7 },
    ].map((item) => ({
      ...item,
      assistantPreview: "answer",
      assistantPreviewKind: "text" as const,
      isRunning: false,
      rowId: item.unitIndex + 10,
      userPreview: item.turnId,
    }));

    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx: 390,
        viewportHeightPx: 360,
        virtualItems: [
          { index: 4, start: 360, size: 220 },
          { index: 7, start: 760, size: 160 },
        ],
      }),
    ).toBe(4);
    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx: 650,
        viewportHeightPx: 280,
        virtualItems: [
          { index: 5, start: 610, size: 120 },
          { index: 6, start: 730, size: 80 },
        ],
      }),
    ).toBe(7);
    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx: 0,
        viewportHeightPx: 400,
        virtualItems: [],
      }),
    ).toBe(0);
  });

  it("TN06：同一 turn 内根据可见 row 锚点解析 active query", () => {
    expect(
      resolveConversationTurnNavigatorActiveQueryRowId({
        positions: [
          { rowId: 11, start: 80, end: 140 },
          { rowId: 12, start: 360, end: 420 },
          { rowId: 13, start: 700, end: 760 },
        ],
        scrollOffsetPx: 330,
        viewportHeightPx: 300,
      }),
    ).toBe(12);
    expect(
      resolveConversationTurnNavigatorActiveQueryRowId({
        positions: [
          { rowId: 11, start: 80, end: 140 },
          { rowId: 12, start: 360, end: 420 },
          { rowId: 13, start: 700, end: 760 },
        ],
        scrollOffsetPx: 520,
        viewportHeightPx: 120,
      }),
    ).toBe(12);
  });

  it("keeps scroll active compact until hover or focus creates a mountain", () => {
    expect(
      resolveConversationTurnNavigatorVisualFocusItemIndex({
        activeItemIndex: 3,
        interactionItemIndex: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveConversationTurnNavigatorVisualFocusItemIndex({
        activeItemIndex: 3,
        interactionItemIndex: 1,
      }),
    ).toBe(1);
    expect(
      resolveConversationTurnNavigatorBarVisualState({
        itemIndex: 3,
        visualFocusItemIndex: undefined,
      }),
    ).toMatchObject({ tone: "idle", scaleX: 1 });
    expect(
      resolveConversationTurnNavigatorBarVisualState({
        itemIndex: 3,
        visualFocusItemIndex: 3,
      }),
    ).toMatchObject({ colorTone: "focus", tone: "peak", scaleX: 2.6 });
    expect(
      resolveConversationTurnNavigatorBarVisualState({
        itemIndex: 2,
        visualFocusItemIndex: 3,
      }),
    ).toMatchObject({ colorTone: "muted", tone: "near", scaleX: 1.7 });
    expect(
      resolveConversationTurnNavigatorBarVisualState({
        itemIndex: 1,
        visualFocusItemIndex: 3,
      }),
    ).toMatchObject({ colorTone: "muted", tone: "mid", scaleX: 1.25 });
    expect(
      resolveConversationTurnNavigatorBarVisualState({
        itemIndex: 0,
        visualFocusItemIndex: 3,
      }),
    ).toMatchObject({ tone: "idle", scaleX: 1 });
    expect(
      resolveConversationTurnNavigatorBarVisualState({
        itemIndex: 0,
        visualFocusItemIndex: undefined,
      }),
    ).toMatchObject({ tone: "idle", scaleX: 1 });
  });

  it("positions the compact rail at the owning timeline vertical center", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationTurnNavigator, {
          // 社区版：服务端目录 props（directoryItems + unitIndexByRowId）替代上游 renderUnits
          directoryItems: [
            directoryItem(),
            directoryItem({
              rowId: 5,
              turnId: "turn-2",
              userPreview: "Second query",
              assistantPreview: "Second answer",
            }),
          ],
          unitIndexByRowId: new Map([
            [2, 0],
            [5, 1],
          ]),
          onJumpToQuery: () => {},
          scrollOffsetPx: 0,
          viewportHeightPx: 500,
          virtualItems: [
            { index: 0, size: 120, start: 0 },
            { index: 1, size: 120, start: 120 },
          ],
        }),
      ),
    );

    expect(html).toContain("top-1/2");
    expect(html).toContain("-translate-y-1/2");
    expect(html).not.toContain("top-12");
    expect(html).toContain("invisible");
    expect(html).toContain("opacity-0");
    expect(html).toContain("-translate-x-2");
    expect(html).toContain("@min-[864px]/conversation:visible");
    expect(html).toContain("@min-[864px]/conversation:opacity-100");
    expect(html).toContain("@min-[864px]/conversation:translate-x-0");
    expect(html).toContain("transition-[opacity,transform,visibility]");
    expect(html).toContain("motion-reduce:transition-none");
  });

  it("TN03：rail 只允许纵向滚动，山峰放大不产生横向滚动条", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationTurnNavigator, {
          // 社区版：服务端目录 props（directoryItems + unitIndexByRowId）替代上游 renderUnits
          directoryItems: [
            directoryItem(),
            directoryItem({
              rowId: 4,
              turnId: "turn-2",
              userPreview: "Second query",
              assistantPreview: "",
              assistantPreviewKind: "empty",
            }),
          ],
          unitIndexByRowId: new Map([
            [2, 0],
            [4, 1],
          ]),
          onJumpToQuery: () => {},
          scrollOffsetPx: 0,
          viewportHeightPx: 500,
          virtualItems: [
            { index: 0, size: 120, start: 0 },
            { index: 1, size: 120, start: 120 },
          ],
        }),
      ),
    );

    expect(html).toContain("overflow-x-hidden");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("!scrollbar-hide");
  });
});
