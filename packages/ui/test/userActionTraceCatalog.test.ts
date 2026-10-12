import { describe, expect, it } from "vitest";
import {
  CORE_USER_ACTION_FEATURES,
  SETTINGS_USER_ACTION_FEATURES,
  USER_ACTION_CATALOG,
} from "../src/lib/userActionTraceCatalog.js";

describe("user action trace catalog", () => {
  // 社区版口径：settings.update 叶子随自动更新子系统删除（PRIVACY-AUDIT §十六保持删除，15→14），
  // conversation.history.feedback 仅剩 copy（赞/踩删除，PRIVACY-AUDIT §十五补记二，94→91）。
  it("固定 24 个 Core 与 14 个 Settings 叶子 feature", () => {
    expect(Object.keys(CORE_USER_ACTION_FEATURES)).toHaveLength(24);
    expect(Object.keys(SETTINGS_USER_ACTION_FEATURES)).toHaveLength(14);
    expect(USER_ACTION_CATALOG.filter((entry) => entry.group === "core")).toHaveLength(91);
    expect(USER_ACTION_CATALOG.filter((entry) => entry.group === "settings")).toHaveLength(42);
  });

  it("feature/action 组合唯一且不使用动态标识", () => {
    const keys = USER_ACTION_CATALOG.map((entry) => `${entry.featureId}:${entry.action}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry.featureId).toMatch(/^[a-z]+(?:[._][a-z]+)+$/u);
      expect(entry.action).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
      expect(entry.featureId).not.toMatch(/taskId|workspacePath|pluginId/iu);
    }
  });

  it("不声明 /event/report sink", () => {
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry).not.toHaveProperty("eventPolicy");
      expect(entry).not.toHaveProperty("elementName");
    }
  });
});
