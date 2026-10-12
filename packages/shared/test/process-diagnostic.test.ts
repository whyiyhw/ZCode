import { describe, expect, it } from "vitest";
import {
  parseZCodeProcessDiagnostic,
  ZCODE_PROCESS_DIAGNOSTIC_PREFIX,
  ZCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS,
} from "@zcode/shared/process-diagnostic";

const diagnostic = {
  version: 1,
  errorId: "1f51b7dc-c52a-46ad-bc97-d2f984e6e3de",
  kind: "uncaughtException",
  origin: "uncaughtException",
  name: "TypeError",
  message: "test exception",
  stack: "TypeError: test exception\n    at run (C:\\repo\\cli.js:1:2)",
  occurredAt: 123,
};

describe("CLI process diagnostic contract", () => {
  it("preserves multiline stack in one stderr frame", () => {
    const line = ZCODE_PROCESS_DIAGNOSTIC_PREFIX + JSON.stringify(diagnostic);
    expect(line.split("\n")).toHaveLength(1);
    expect(parseZCodeProcessDiagnostic(line)).toEqual(diagnostic);
    // 社区版口径（PRIVACY-AUDIT §十三）：agent-process-exception Host 消息随 Agent 异常
    // 上报链路一并裁剪，诊断帧仅保留本地 stderr 解析契约，不再断言 Host IPC 投递。
  });

  it("rejects unknown versions, extra fields, malformed/oversized data and ordinary logs", () => {
    for (const value of [
      { ...diagnostic, version: 2 },
      { ...diagnostic, taskId: "private" },
      { ...diagnostic, kind: "console.error" },
      { ...diagnostic, message: "x".repeat(4001) },
    ]) {
      expect(
        parseZCodeProcessDiagnostic(ZCODE_PROCESS_DIAGNOSTIC_PREFIX + JSON.stringify(value)),
      ).toBeUndefined();
    }
    for (const line of [
      "Error: ordinary stderr",
      ZCODE_PROCESS_DIAGNOSTIC_PREFIX + "{",
      ZCODE_PROCESS_DIAGNOSTIC_PREFIX + "x".repeat(ZCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS),
    ]) {
      expect(parseZCodeProcessDiagnostic(line)).toBeUndefined();
    }
  });
});
