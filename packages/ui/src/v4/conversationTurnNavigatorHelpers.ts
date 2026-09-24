export type ConversationTurnNavigatorAssistantPreviewKind = "empty" | "running" | "text";

export interface ConversationTurnNavigatorItem {
  key: string;
  turnId: string;
  unitIndex: number;
  rowId: number;
  userPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
  isRunning: boolean;
}

export interface ConversationTurnNavigatorVirtualItem {
  index: number;
  start: number;
  size: number;
}

interface ResolveConversationTurnNavigatorActiveUnitIndexOptions {
  items: readonly ConversationTurnNavigatorItem[];
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export interface ConversationTurnNavigatorQueryPosition {
  rowId: number;
  start: number;
  end: number;
}

interface ResolveConversationTurnNavigatorActiveQueryRowIdOptions {
  positions: readonly ConversationTurnNavigatorQueryPosition[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

type ConversationTurnNavigatorBarTone = "idle" | "mid" | "near" | "peak";
type ConversationTurnNavigatorBarColorTone = "focus" | "muted";

interface ConversationTurnNavigatorBarVisualState {
  colorTone: ConversationTurnNavigatorBarColorTone;
  opacity: number;
  scaleX: number;
  tone: ConversationTurnNavigatorBarTone;
}

interface ResolveConversationTurnNavigatorBarVisualStateOptions {
  itemIndex: number;
  visualFocusItemIndex: number | undefined;
}

interface ResolveConversationTurnNavigatorVisualFocusItemIndexOptions {
  activeItemIndex: number;
  interactionItemIndex: number | undefined;
}

const CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864;

export type ConversationTurnNavigatorHydrationResult =
  | { status: "hydrated"; logEpoch: string }
  | { status: "retryable-failure"; logEpoch: string }
  | { status: "stale"; logEpoch: string };

export function shouldHydrateConversationTurnNavigatorDirectory(params: {
  containerWidthPx: number;
  hasLoadHandler: boolean;
}): boolean {
  // 目录来自服务端 turnDirectory 查询（全分支），与会话是否还有更早行、是否正在
  // loadOlder 都无关——已加载到底的会话同样需要目录。
  return (
    params.hasLoadHandler && params.containerWidthPx >= CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX
  );
}

export function resolveConversationTurnNavigatorHydrationRetryDelayMs(
  failedAttemptCount: number,
): number | null {
  if (failedAttemptCount === 1) return 250;
  if (failedAttemptCount === 2) return 1_000;
  return null;
}

function resolveFiniteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveConversationTurnNavigatorActiveUnitIndex({
  items,
  virtualItems,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveUnitIndexOptions): number | undefined {
  if (items.length === 0) {
    return undefined;
  }

  // 窗口外条目 unitIndex = -1（目录全分支 > 行窗口），不参与几何锚定——
  // 主循环与 fallback 都只用窗口内条目，防止退化态 fallback 命中最旧窗口外条目
  // （修复的修复：只过滤主循环 map 是 no-op，fallback 遍历的是原数组）。
  const windowItems = items.filter((item) => item.unitIndex >= 0);
  if (windowItems.length === 0) {
    return undefined;
  }
  const itemByUnitIndex = new Map(windowItems.map((item) => [item.unitIndex, item]));
  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));

  let activeUnitIndex: number | undefined;
  let activeDistance = Number.POSITIVE_INFINITY;
  for (const virtualItem of virtualItems) {
    const item = itemByUnitIndex.get(virtualItem.index);
    if (!item) {
      continue;
    }
    const rowStart = resolveFiniteNonNegative(virtualItem.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(virtualItem.size));
    if (rowEnd < viewportStart || rowStart > viewportEnd) {
      continue;
    }
    const distanceToViewportStart = rowStart <= viewportStart ? 0 : rowStart - viewportStart;
    if (distanceToViewportStart < activeDistance) {
      activeUnitIndex = item.unitIndex;
      activeDistance = distanceToViewportStart;
    }
  }

  if (activeUnitIndex !== undefined) {
    return activeUnitIndex;
  }

  const topVirtualIndex = virtualItems.find((item) => {
    const rowStart = resolveFiniteNonNegative(item.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(item.size));
    return rowEnd >= viewportStart && rowStart <= viewportEnd;
  })?.index;
  if (topVirtualIndex === undefined) {
    return windowItems[0]?.unitIndex;
  }

  return (
    windowItems.find((item) => item.unitIndex >= topVirtualIndex)?.unitIndex ??
    windowItems.findLast((item) => item.unitIndex <= topVirtualIndex)?.unitIndex ??
    windowItems[0]?.unitIndex
  );
}

export function resolveConversationTurnNavigatorActiveQueryRowId({
  positions,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveQueryRowIdOptions): number | undefined {
  if (positions.length === 0) return undefined;

  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));
  const normalized = positions
    .map((position) => {
      const start = resolveFiniteNonNegative(position.start);
      return {
        rowId: position.rowId,
        start,
        end: Math.max(start, resolveFiniteNonNegative(position.end)),
      };
    })
    .sort((left, right) => left.start - right.start || left.rowId - right.rowId);

  const visible = normalized.filter(
    (position) => position.end >= viewportStart && position.start <= viewportEnd,
  );
  if (visible.length > 0) {
    return visible.reduce((nearest, candidate) =>
      Math.abs(candidate.start - viewportStart) < Math.abs(nearest.start - viewportStart)
        ? candidate
        : nearest,
    ).rowId;
  }

  return (
    normalized.findLast((position) => position.start <= viewportStart)?.rowId ??
    normalized.find((position) => position.start > viewportStart)?.rowId
  );
}

export function resolveConversationTurnNavigatorBarVisualState({
  itemIndex,
  visualFocusItemIndex,
}: ResolveConversationTurnNavigatorBarVisualStateOptions): ConversationTurnNavigatorBarVisualState {
  if (visualFocusItemIndex === undefined) {
    return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
  }

  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) {
    return { colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak" };
  }
  if (distance === 1) {
    return { colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near" };
  }
  if (distance === 2) {
    return { colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid" };
  }
  return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
}

export function resolveConversationTurnNavigatorVisualFocusItemIndex({
  interactionItemIndex,
}: ResolveConversationTurnNavigatorVisualFocusItemIndexOptions): number | undefined {
  return interactionItemIndex;
}
