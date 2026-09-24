// 回合导航目录（turn navigator directory）：schema + 纯推导。
//
// 为什么存在：目录必须覆盖全分支 real-user query，而 renderer 的 rows.window 是
// 有界尾窗（宽屏全量常驻 loadAllOlder 已按 B2 方案退役）——目录只能由持有全量
// 投影的 CLI 侧推导，经 v4/conversation/directory 只读查询下发。本包纪律是
// schema 类型 + 纯函数，推导放这里让 CLI handler 与单测共用同一实现。
//
// 语义与 UI 的 renderUnits 派生对齐（对齐点写在各函数注释）：
// 分组按 rowId 全序首见 turnId；realUser 过滤、assistant 文本聚合、running 判定
// 均以行为数据源复刻 conversationTurnRenderUnits 的可见语义，不得各自漂移。
import { z } from "zod";
import type { ConversationRow } from "./rows.js";
import type { UserInputRow } from "./rows.js";

/** 预览截断口径（与退役前的 UI 目录派生一致；服务端截断，行不跨线）。 */
export const CONVERSATION_TURN_DIRECTORY_PREVIEW_MAX_CHARS = 220;
export const CONVERSATION_TURN_DIRECTORY_PREVIEW_MAX_PARAGRAPHS = 2;

export type ConversationTurnDirectoryAssistantPreviewKind = "empty" | "running" | "text";

export const conversationTurnDirectoryItemSchema = z
  .object({
    /** realUser userInput 行的 rowId（跳转锚点）。 */
    rowId: z.number(),
    turnId: z.string(),
    /** 用户 query 预览（已截断；空串时由 UI 用本地化兜底文案）。 */
    userPreview: z.string(),
    /** assistant 文本预览（已截断；kind 非 text 时为空串）。 */
    assistantPreview: z.string(),
    assistantPreviewKind: z.enum(["empty", "running", "text"]),
    /** 仅同一 running turn 的最后一条 query 为 true（多 guide segment 只强调当前工作）。 */
    isRunning: z.boolean(),
    /** turnHeader.activeMs（权威工时，排除等待）；缺 header 时缺席。 */
    activeMs: z.number().nonnegative().optional(),
  })
  .strict();
export type ConversationTurnDirectoryItem = z.infer<typeof conversationTurnDirectoryItemSchema>;

export const v4ConversationTurnDirectoryParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  })
  .strict();
export type V4ConversationTurnDirectoryParams = z.infer<
  typeof v4ConversationTurnDirectoryParamsSchema
>;

export const v4ConversationTurnDirectoryResultSchema = z
  .object({
    // 全分支 real-user query 目录，rowId 升序。
    items: z.array(conversationTurnDirectoryItemSchema),
    // 会话是否出现过 plugin 引用（plugin:// 文本引用图标的全史事实，
    // renderer 尾窗推导会漏历史引用）。
    hasPluginReference: z.boolean(),
    atSeq: z.number().int().nonnegative(),
    atLogEpoch: z.string().min(1),
  })
  .strict();
export type V4ConversationTurnDirectoryResult = z.infer<
  typeof v4ConversationTurnDirectoryResultSchema
>;

function normalizePreviewParagraphs(text: string, maxParagraphs: number): string[] {
  return text
    .trim()
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxParagraphs));
}

function truncatePreview(text: string, maxChars: number): string {
  const normalizedMaxChars = Math.max(8, maxChars);
  if (text.length <= normalizedMaxChars) {
    return text;
  }
  return `${text.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
}

/**
 * 预览文本聚合：段落规范化（≤maxParagraphs 段）+ 截断（≤maxChars）。
 * 无可展示段落时返回空串——本地化兜底文案是 UI 侧事实，协议不承载。
 */
export function buildConversationTurnDirectoryPreviewText(
  texts: readonly string[],
  options?: { maxChars?: number; maxParagraphs?: number },
): string {
  const maxChars = options?.maxChars ?? CONVERSATION_TURN_DIRECTORY_PREVIEW_MAX_CHARS;
  const maxParagraphs =
    options?.maxParagraphs ?? CONVERSATION_TURN_DIRECTORY_PREVIEW_MAX_PARAGRAPHS;
  const paragraphs = normalizePreviewParagraphs(texts.join("\n\n"), maxParagraphs);
  if (paragraphs.length === 0) {
    return "";
  }
  return truncatePreview(paragraphs.join("\n"), maxChars);
}

/**
 * 是否出现 plugin 文本引用（plugin 引用图标的全史判定口径）。
 * 与 UI 退役前的 hasPluginReferenceUserRows 逐字对齐：userInput 行文本含 "(plugin://"。
 */
export function conversationRowsHavePluginReference(rows: readonly ConversationRow[]): boolean {
  return rows.some((row) => row.kind === "userInput" && row.text?.includes("(plugin://"));
}

interface TurnDirectoryDraft {
  turnId: string;
  header: ConversationRow | undefined;
  realUserInputs: UserInputRow[];
  assistantTexts: string[];
  activeMs: number | undefined;
}

function resolveTurnRunning(header: ConversationRow | undefined): boolean {
  if (!header || header.kind !== "turnHeader") {
    // 全量投影每 turn 必有 header；防御性兜底与 UI 终态回退同向（不显 running）。
    return false;
  }
  // controlOnly 轮（设置/控制类）不产生可导航工作；header.state 是投影权威轮次边界，
  // 已终态主轮不因 background 行重新推成 running（与 resolveTurnRunning 同语义）。
  return header.executionKind !== "controlOnly" && header.state === "running";
}

/**
 * 从全量行推导回合导航目录。语义对齐（与 conversationTurnRenderUnits 的差异点均已核实为等价）：
 * - 分组：按 rowId 全序首见 turnId（同 render units 的 getOrCreateUnit）。
 * - realUser 过滤：origin === "realUser"（workflowLaunch/背景/goal 等天然排除；
 *   UI 侧 visibleUserInputs 对 workflowLaunch 的额外排除不影响 realUser 子集）。
 * - assistant 文本 = 该 turn 全部 assistantText 行文本按序聚合（UI 的
 *   assistantTextRows 取自 flowRows，而轮尾拆分只剥 marker/artifact 行，从不剥
 *   assistantText——两者等价）。
 * - timelineOnly turn 无 realUser 输入，天然不产条目。
 * - isRunning：header.state === "running" 且非 controlOnly，仅该 turn 最后一条 query。
 */
export function buildConversationTurnDirectoryItems(
  rows: readonly ConversationRow[],
): ConversationTurnDirectoryItem[] {
  const drafts: TurnDirectoryDraft[] = [];
  const draftByTurnId = new Map<string, TurnDirectoryDraft>();
  for (const row of rows) {
    let draft = draftByTurnId.get(row.turnId);
    if (!draft) {
      draft = {
        turnId: row.turnId,
        header: undefined,
        realUserInputs: [],
        assistantTexts: [],
        activeMs: undefined,
      };
      drafts.push(draft);
      draftByTurnId.set(row.turnId, draft);
    }
    if (row.kind === "turnHeader") {
      draft.header = row;
      if (row.activeMs !== undefined) {
        draft.activeMs = row.activeMs;
      }
      continue;
    }
    if (row.kind === "userInput" && row.origin === "realUser") {
      draft.realUserInputs.push(row);
      continue;
    }
    if (row.kind === "assistantText") {
      draft.assistantTexts.push(row.text);
    }
  }

  const items: ConversationTurnDirectoryItem[] = [];
  for (const draft of drafts) {
    if (draft.realUserInputs.length === 0) {
      continue;
    }
    const isRunningTurn = resolveTurnRunning(draft.header);
    const assistantPreviewKind =
      draft.assistantTexts.length > 0 ? "text" : isRunningTurn ? "running" : "empty";
    const assistantPreview =
      assistantPreviewKind === "text"
        ? buildConversationTurnDirectoryPreviewText(draft.assistantTexts)
        : "";
    draft.realUserInputs.forEach((row, queryIndex) => {
      items.push({
        rowId: row.rowId,
        turnId: draft.turnId,
        userPreview: buildConversationTurnDirectoryPreviewText([row.text]),
        assistantPreview,
        assistantPreviewKind,
        isRunning: isRunningTurn && queryIndex === draft.realUserInputs.length - 1,
        ...(draft.activeMs !== undefined ? { activeMs: draft.activeMs } : {}),
      });
    });
  }
  return items;
}
