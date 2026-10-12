/**
 * 会话创建入口来源（UI 记账用纯类型）。
 * 社区版说明：该类型原先定义在 sessionCreateTelemetry.ts（遥测契约，2026-09-23 已随遥测栈
 * 整体删除，见 PRIVACY-AUDIT.md §十五）；上游 v3.15.1 起在 UI 会话创建路径复用该标记做
 * 界面簿记，故以独立纯类型恢复——不含任何 schema 与上报语义。
 */
export type SessionCreateSource = "group" | "project" | "session";
