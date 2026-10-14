import { describe, expect, it } from "vitest";
import { encodeProviderConfigFile } from "@zcode/provider-node";
import type { ProviderConfigLayerUpdate } from "@zcode/provider";
import {
  importLegacyCliConfiguredDefault,
  importLegacyCliPersonalProviderConfig,
} from "../src/app/legacy-cli-personal-provider-config-importer.js";

// 根因：上游 v3.15.1 带来的旧断言假设 Personal 文件是
// { providers: 按 id 键控的对象, models: 扁平规则列表 } 的历史形状；
// 当前产品里 ProviderConfigMap.toJSON() 输出规则数组（templateId/providerName 属于规则外层身份，
// 不在 config 内），ModelConfigRules 按 toPersonalJSON() 分组输出，实际落盘由 encodeProviderConfigFile
// 组装为 { schemaVersion, config: { providerConfigRules, modelConfigRules, defaultModelSelection } }。
// 这里直接走真实编码器断言迁移结果，保证与当前落盘口径一致。
function encoded(update: ProviderConfigLayerUpdate): ReturnType<typeof encodeProviderConfigFile> {
  return encodeProviderConfigFile(update);
}

describe("importLegacyCliPersonalProviderConfig", () => {
  it("Standalone 与 Desktop 一样丢弃内置套餐配置，API 只迁 Key", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          "builtin:bigmodel-coding-plan": {
            kind: "anthropic",
            source: "custom",
            options: { apiKey: "discard", apiKeyRequired: false },
            models: { old: {} },
          },
          "builtin:bigmodel": {
            kind: "anthropic",
            source: "custom",
            name: "old",
            options: { apiKey: " kept ", baseURL: "https://old.test" },
            models: { old: {} },
          },
          "builtin:zai": { kind: "anthropic", source: "builtin", options: { apiKey: "" } },
          "account:zai-start-plan": {
            kind: "anthropic",
            source: "custom",
            options: { apiKey: "discard" },
          },
          "legacy-builtin": {
            kind: "anthropic",
            source: "builtin",
            options: { apiKey: "discard" },
          },
        },
      },
    });
    expect(update.providers.keys()).toEqual(["bigmodel-api"]);
    // 根因：templateId 属于 ProviderConfigRule 外层身份，不再出现在 config.toJSON() 里。
    expect(update.providers.getRule("bigmodel-api")?.templateId).toBe("bigmodel-api");
    expect(update.providers.get("bigmodel-api")?.toJSON()).toEqual({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "kept" },
    });
  });

  it("旧 CLI Provider 直接迁移为完整 Personal Provider", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          openai: {
            kind: "openai",
            options: {
              apiKey: "secret",
              baseURL: "https://api.openai.com/v1",
            },
            models: {},
          },
        },
      },
    });

    expect(update.providers.get("openai")?.group).toBe("standard-personal");
  });

  it("只把旧用户文件显式声明的 Provider 投影为 Personal Config", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        model: "custom/model-a",
        provider: {
          custom: {
            kind: "openai-compatible",
            name: "Custom API",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com/v1",
              includeUsage: false,
            },
            models: {
              "model-a": {
                headers: { "X-Model-Route": "legacy" },
                limit: { context: 128_000, output: 16_000 },
                modalities: { input: ["text", "image", "video"] },
                reasoning: {
                  enabled: true,
                  levels: ["low", "high"],
                  defaultLevel: "high",
                  providerOptionsByLevel: {
                    low: { openaiCompatible: { reasoningEffort: "low" } },
                    high: { openaiCompatible: { reasoningEffort: "high" } },
                  },
                },
                structured_output: true,
                tool_call: true,
              },
            },
          },
        },
      },
    });

    // 根因：上游旧期望把 label 放在 config 上；当前产品把展示名作为规则外层 providerName，
    // 且默认选择与 Provider/模型规则由同一次迁移产出，真实编码会一并落盘。
    expect(encoded(update)).toEqual({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "custom",
              providerName: "Custom API",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "secret" },
                api: {
                  type: "openai-chat-completions",
                  baseUrl: "https://custom.example.com/v1",
                },
                personalModelIds: ["model-a"],
                modelOrder: ["model-a"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: "custom",
              modelId: "model-a",
              config: {
                properties: {
                  contextWindow: 128_000,
                },
              },
            },
          ],
          manualProviderModelRules: [],
        },
        defaultModelSelection: { providerId: "custom", modelId: "model-a" },
      },
    });
  });

  it("不把只有 model 选择、没有 provider 定义的内容迁成 Provider", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: { model: "missing/model-a" },
    });

    // 根因：Provider 为空时编码为空规则集合而非空对象/空列表；
    // main model 选择本身仍迁移为 Environment 默认选择（见 importLegacyCliConfiguredDefault）。
    expect(encoded(update)).toEqual({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId: "missing", modelId: "model-a" },
      },
    });
  });

  it("不把旧 CLI 中已退出产品的 ZAPI 迁成 Personal Provider", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          "builtin:zapi": {
            kind: "anthropic",
            options: { baseURL: "https://retired.example.com", apiKey: "retired" },
            models: { retired: {} },
          },
          custom: {
            kind: "openai-compatible",
            options: { baseURL: "https://custom.example.com", apiKey: "current" },
            models: { current: {} },
          },
        },
      },
    });

    // 根因：providers.toJSON() 已是规则数组，键控视图用 keys() 断言。
    expect(update.providers.keys()).toEqual(["custom"]);
  });

  it("忽略旧 model options 中没有正式语义的任意字段", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          custom: {
            kind: "openai-compatible",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com/v1",
            },
            models: {
              "model-a": {
                limit: { context: 128_000, output: 16_000 },
                options: {
                  openaiCompatible: {
                    reasoningSummary: "auto",
                    metadata: { source: "legacy" },
                  },
                },
              },
              "model-b": {
                options: { reasoningSummary: "concise" },
              },
            },
          },
        },
      },
    });

    // 根因：models 编码已按 Personal 口径分组为 providerModelRules/manualProviderModelRules。
    const modelRules = encoded(update).config.modelConfigRules.providerModelRules;
    expect(modelRules).toHaveLength(1);
    expect(modelRules[0]?.config).not.toHaveProperty("requestParameters");
  });

  it("不迁移历史 model options 中的输出上限", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          custom: {
            kind: "openai-compatible",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com/v1",
            },
            models: {
              direct: {
                options: { max_tokens: 24_000 },
              },
              wrapped: {
                options: {
                  extra_body: { max_tokens: 12_000, reasoning_format: "parsed" },
                },
              },
            },
          },
        },
      },
    });

    // 根因：models 为空时是分组空规则集合，不再是空列表。
    expect(encoded(update).config.modelConfigRules).toEqual({
      providerModelRules: [],
      manualProviderModelRules: [],
    });
  });

  it("忽略没有生产消费方的 reasoning replay 元数据", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          custom: {
            kind: "openai-compatible",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com/v1",
            },
            models: {
              "model-a": {
                interleaved: { field: "reasoning_content" },
                reasoningContentField: "reasoning_content",
              },
            },
          },
        },
      },
    });

    // 根因：providers 是规则数组，存在性用 has() 断言；models 空用分组规则长度断言。
    expect(update.providers.has("custom")).toBe(true);
    expect(encoded(update).config.modelConfigRules.providerModelRules).toHaveLength(0);
  });

  it("忽略旧 Provider Schema 接受但运行时没有消费的扩展字段", () => {
    const update = importLegacyCliPersonalProviderConfig({
      input: {
        provider: {
          custom: {
            kind: "openai-compatible",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com/v1",
              timeout: 30_000,
              chunkTimeout: 5_000,
              legacyExtension: { unused: true },
            },
            models: { "model-a": {} },
          },
        },
      },
    });

    expect(update.providers.has("custom")).toBe(true);
  });

  it("无 API Key Provider 在正式类型建立前继续留在兼容链路", () => {
    expect(() =>
      importLegacyCliPersonalProviderConfig({
        input: {
          provider: {
            local: {
              kind: "openai-compatible",
              options: {
                apiKeyRequired: false,
                baseURL: "http://127.0.0.1:11434/v1",
              },
              models: { "model-a": {} },
            },
          },
        },
      }),
    ).toThrow(/local/);
  });
});

describe("importLegacyCliConfiguredDefault", () => {
  it("把旧用户文件的 main model 迁移为 Environment Configured Default", () => {
    expect({
      schemaVersion: 1,
      configuredDefault: importLegacyCliConfiguredDefault({
        model: {
          main: "custom/model-a",
          lite: "custom/model-b",
        },
      }),
    }).toEqual({
      schemaVersion: 1,
      configuredDefault: {
        providerId: "custom",
        modelId: "model-a",
      },
    });
  });

  it("没有显式 model 时不产生迁移文档", () => {
    expect(importLegacyCliConfiguredDefault({ provider: {} })).toBeNull();
  });

  it("不把已退出产品的 ZAPI 迁成 Environment Configured Default", () => {
    expect(importLegacyCliConfiguredDefault({ model: "builtin:zapi/retired" })).toBeNull();
  });
});
