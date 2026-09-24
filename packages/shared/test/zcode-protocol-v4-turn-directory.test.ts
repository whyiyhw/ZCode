// 回合导航目录推导单测（口径：packages/shared/spec/conversation-turn-directory.md）。
// 运行：npx tsx --test packages/shared/test/zcode-protocol-v4-turn-directory.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversationTurnDirectoryItems,
  v4ConversationRowsRangeParamsSchema,
  buildConversationTurnDirectoryPreviewText,
  conversationRowsHavePluginReference,
  conversationTurnDirectoryItemSchema,
  CONVERSATION_TURN_DIRECTORY_PREVIEW_MAX_CHARS,
  v4ConversationTurnDirectoryParamsSchema,
  v4ConversationTurnDirectoryResultSchema,
  type ConversationRow,
} from "../src/zcode-protocol-v4/index.js";

interface RowSpec {
  rowId: number;
  turnId: string;
  kind: string;
  origin?: string;
  text?: string;
  state?: string;
  executionKind?: string;
  activeMs?: number;
}

function makeRows(specs: RowSpec[]): ConversationRow[] {
  return specs.map((spec) => {
    const base = {
      rowId: spec.rowId,
      turnId: spec.turnId,
      createdAt: spec.rowId,
      createdAtSeq: spec.rowId,
    };
    if (spec.kind === "turnHeader") {
      return {
        ...base,
        kind: "turnHeader",
        state: spec.state ?? "completedSuccess",
        ...(spec.executionKind ? { executionKind: spec.executionKind } : {}),
        ...(spec.activeMs !== undefined ? { activeMs: spec.activeMs } : {}),
      } as ConversationRow;
    }
    if (spec.kind === "userInput") {
      return {
        ...base,
        kind: "userInput",
        text: spec.text ?? `query ${spec.rowId}`,
        origin: spec.origin ?? "realUser",
      } as ConversationRow;
    }
    return {
      ...base,
      kind: "assistantText",
      text: spec.text ?? `answer ${spec.rowId}`,
      state: "complete",
    } as ConversationRow;
  });
}

test("realUser 过滤：workflowLaunch/背景/goal 不进目录，一个 turn 多条 steer 各占一项", () => {
  const rows = makeRows([
    { rowId: 1, turnId: "t1", kind: "turnHeader", state: "completedSuccess", activeMs: 1200 },
    { rowId: 2, turnId: "t1", kind: "userInput", text: "第一个问题" },
    { rowId: 3, turnId: "t1", kind: "assistantText", text: "第一段回答" },
    { rowId: 4, turnId: "t1", kind: "userInput", text: "追问", origin: "realUser" },
    { rowId: 5, turnId: "t1", kind: "userInput", text: "后台注入", origin: "backgroundResult" },
    { rowId: 6, turnId: "t1", kind: "userInput", text: "workflow 启动", origin: "workflowLaunch" },
    { rowId: 7, turnId: "t1", kind: "assistantText", text: "第二段回答" },
  ]);
  const items = buildConversationTurnDirectoryItems(rows);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => item.rowId),
    [2, 4],
  );
  assert.equal(items[0]?.activeMs, 1200);
  // 两条 query 共享同一 turn 的 assistant 聚合预览。
  assert.equal(items[0]?.assistantPreviewKind, "text");
  assert.equal(items[1]?.assistantPreview, items[0]?.assistantPreview);
  assert.ok(items[0]?.assistantPreview.includes("第一段回答"));
  assert.ok(items[0]?.assistantPreview.includes("第二段回答"));
});

test("kind 三态：无 assistant 文本的 running turn → running；完成 turn → empty", () => {
  const rows = makeRows([
    { rowId: 1, turnId: "t1", kind: "turnHeader", state: "completedSuccess" },
    { rowId: 2, turnId: "t1", kind: "userInput" },
    { rowId: 3, turnId: "t2", kind: "turnHeader", state: "running" },
    { rowId: 4, turnId: "t2", kind: "userInput", text: "正在跑的问题" },
    { rowId: 5, turnId: "t3", kind: "turnHeader", state: "running", executionKind: "controlOnly" },
    { rowId: 6, turnId: "t3", kind: "userInput", text: "控制轮" },
  ]);
  const items = buildConversationTurnDirectoryItems(rows);
  assert.equal(items.length, 3);
  assert.equal(items[0]?.assistantPreviewKind, "empty");
  // running 且无文本 → running 预览 kind；isRunning 仅 running 轮的最后一条 query。
  assert.equal(items[1]?.assistantPreviewKind, "running");
  assert.equal(items[1]?.isRunning, true);
  assert.equal(items[0]?.isRunning, false);
  // controlOnly 轮不产生 running 强调（设置/控制类轮次无导航工作语义）。
  assert.equal(items[2]?.isRunning, false);
  assert.equal(items[2]?.assistantPreviewKind, "empty");
});

test("isRunning：running turn 的多条 query 仅最后一条为 true", () => {
  const rows = makeRows([
    { rowId: 1, turnId: "t1", kind: "turnHeader", state: "running" },
    { rowId: 2, turnId: "t1", kind: "userInput", text: "q1" },
    { rowId: 3, turnId: "t1", kind: "userInput", text: "q2（最新 steer）" },
    { rowId: 4, turnId: "t1", kind: "assistantText", text: "流式回答…" },
  ]);
  const items = buildConversationTurnDirectoryItems(rows);
  assert.deepEqual(
    items.map((item) => item.isRunning),
    [false, true],
  );
});

test("预览截断：≤220 字符、≤2 段；空文本产出空串（本地化兜底归 UI）", () => {
  const longText = "a".repeat(500);
  const items = buildConversationTurnDirectoryItems(
    makeRows([
      { rowId: 1, turnId: "t1", kind: "turnHeader", state: "completedSuccess" },
      { rowId: 2, turnId: "t1", kind: "userInput", text: `${longText}\n\n第二段\n\n第三段` },
    ]),
  );
  const preview = items[0]?.userPreview ?? "";
  assert.ok(preview.length <= CONVERSATION_TURN_DIRECTORY_PREVIEW_MAX_CHARS);
  assert.ok(preview.endsWith("..."));
  // 只保留前两段：第三段内容不得出现。
  assert.ok(!preview.includes("第三段"));

  assert.equal(buildConversationTurnDirectoryPreviewText(["  ", "\n\n"]), "");
  assert.equal(buildConversationTurnDirectoryPreviewText([]), "");
});

test("plugin 引用谓词：userInput 文本含 (plugin:// 即真，assistant 行不算", () => {
  assert.equal(
    conversationRowsHavePluginReference(
      makeRows([{ rowId: 1, turnId: "t1", kind: "userInput", text: "帮我装 (plugin://foo/bar)" }]),
    ),
    true,
  );
  assert.equal(
    conversationRowsHavePluginReference(
      makeRows([{ rowId: 1, turnId: "t1", kind: "assistantText", text: "(plugin://foo)" }]),
    ),
    false,
  );
});

test("schema：params/result/item 严格解析", () => {
  assert.equal(v4ConversationTurnDirectoryParamsSchema.parse({ sessionId: "s1" }).sessionId, "s1");
  assert.throws(() => v4ConversationTurnDirectoryParamsSchema.parse({ sessionId: "s1", extra: 1 }));
  const item = conversationTurnDirectoryItemSchema.parse({
    rowId: 3,
    turnId: "t1",
    userPreview: "q",
    assistantPreview: "a",
    assistantPreviewKind: "text",
    isRunning: false,
    activeMs: 42,
  });
  assert.equal(item.activeMs, 42);
  const result = v4ConversationTurnDirectoryResultSchema.parse({
    items: [item],
    hasPluginReference: false,
    atSeq: 10,
    atLogEpoch: "e1",
  });
  assert.equal(result.items.length, 1);
  assert.throws(() =>
    v4ConversationTurnDirectoryResultSchema.parse({
      items: [],
      hasPluginReference: false,
      atSeq: 10,
      atLogEpoch: "e1",
      unknown: 1,
    }),
  );
});

test("条目按行序输出；跨 turn 保持 rowId 升序", () => {
  const rows = makeRows([
    { rowId: 1, turnId: "t1", kind: "turnHeader", state: "completedSuccess" },
    { rowId: 2, turnId: "t1", kind: "userInput" },
    { rowId: 5, turnId: "t2", kind: "turnHeader", state: "completedSuccess" },
    { rowId: 6, turnId: "t2", kind: "userInput" },
  ]);
  const items = buildConversationTurnDirectoryItems(rows);
  assert.deepEqual(
    items.map((item) => item.rowId),
    [2, 6],
  );
});

test("rowsRange 参数：aroundRowId 与 beforeRowId 互斥（跳转拉取语义）", () => {
  assert.equal(
    v4ConversationRowsRangeParamsSchema.parse({ sessionId: "s1", aroundRowId: 42, limit: 200 })
      .aroundRowId,
    42,
  );
  assert.throws(() =>
    v4ConversationRowsRangeParamsSchema.parse({
      sessionId: "s1",
      beforeRowId: 100,
      aroundRowId: 42,
      limit: 200,
    }),
  );
  // 两个游标都缺省（从尾部向前）与仅 beforeRowId 仍是合法形状。
  assert.equal(v4ConversationRowsRangeParamsSchema.parse({ sessionId: "s1", limit: 60 }).limit, 60);
  assert.equal(
    v4ConversationRowsRangeParamsSchema.parse({ sessionId: "s1", beforeRowId: 100, limit: 60 })
      .beforeRowId,
    100,
  );
});
