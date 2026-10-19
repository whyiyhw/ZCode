import { describe, expect, it } from "vitest";
import {
  BROKER_METHODS,
  BrokerError,
  callBrokerMethod,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
  parseRequestLine,
} from "../broker.js";

// 占位桩探测器（2026-10-19 加固）：v3.16.0（fcfb4749）曾为修全量 build 把本包整包
// 回退为上游占位桩——占位版 API 兼容，typecheck/lint/build/冒烟全部绿灯，只有运行时
// 才抛 "Computer Use is not available in this build"（spec「维护史」盲区记录）。
// 本文件用同步、跨平台的行为断言锁定 fork 真实现特征：任何形式的占位回退都会在此
// 立即红灯。协议全量行为由 node --test 的 computer-use.test.mjs 覆盖（CI 另跑）。
describe("占位桩探测器：真实现特征断言", () => {
  it("isBrokerMethod 认识 broker_info（占位版恒 false）", () => {
    expect(isBrokerMethod("broker_info")).toBe(true);
    expect(isBrokerMethod("list_applications")).toBe(true);
  });

  it("isReadOnlyBrokerMethod 区分只读观测方法（占位版恒 false）", () => {
    expect(isReadOnlyBrokerMethod("list_windows")).toBe(true);
    expect(isReadOnlyBrokerMethod("click")).toBe(false);
  });

  it("parseRequestLine 解析合法行并回 ok 信封（占位版恒 undefined）", () => {
    const parsed = parseRequestLine('{"id":1,"method":"broker_info","params":{}}');
    expect(parsed).toEqual({
      ok: true,
      request: { id: 1, method: "broker_info", params: {} },
    });
  });

  it("parseRequestLine 拒绝非法行并给出 invalid_request 诊断（占位版恒 undefined）", () => {
    const parsed = parseRequestLine("not-json");
    expect(parsed?.ok).toBe(false);
    expect(parsed?.code).toBe("invalid_request");
  });

  it("callBrokerMethod 做参数校验而非无条件拒绝（占位版恒抛 not available）", async () => {
    await expect(callBrokerMethod({ method: "broker_info" })).rejects.toThrow(BrokerError);
    await expect(callBrokerMethod({ method: "broker_info" })).rejects.toThrow(/socketPath/);
  });

  it("BROKER_METHODS 方法表与官方对齐（占位版无此导出）", () => {
    // 实现为 42 个方法（spec 行文记 43 属计数口径差异，以实现为准）。
    expect(BROKER_METHODS.length).toBe(42);
    expect(BROKER_METHODS).toContain("broker_info");
    expect(BROKER_METHODS).toContain("element_perform_action");
  });
});
