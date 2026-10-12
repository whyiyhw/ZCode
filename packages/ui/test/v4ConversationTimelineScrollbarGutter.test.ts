import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows 工作区经 git autocrlf 是 CRLF，断言按 LF 编写；读取后归一化行尾，Linux 上是无操作。
const readTimelineSource = () =>
  readFileSync("packages/ui/src/v4/ConversationTimeline.tsx", "utf8").replaceAll("\r\n", "\n");

describe("ConversationTimeline scrollbar gutter", () => {
  it("reserves stable scrollbar space on the shared conversation viewport", () => {
    const source = readTimelineSource();

    expect(source).toContain("overflow-y-auto [scrollbar-gutter:stable]");
  });

  // 社区版口径（PRIVACY-AUDIT §十五）：会话分享发布链下线，ConversationTimeline 的
  // backgroundScrollLocked（分享滚动锁定）与 hideTurnNavigator（分享独占左栏）逻辑已剔除，
  // 上游 v3.15.1 带回的两条源码断言（scroll lock 标记 / 分享模式隐藏 turn navigator）随删除
  // 口径移除；这里仅保留标记不回流的防回归断言（注意源码注释里仍会提到这两个词，故断言用
  // 只存在于被删代码里的完整标记串）。
  it("社区版：不回流分享滚动锁定与分享独占左栏标记", () => {
    const source = readTimelineSource();

    expect(source).not.toContain("data-v4-timeline-scroll-locked");
    expect(source).not.toContain("hideTurnNavigator ? null : (");
  });
});
