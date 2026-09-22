#!/usr/bin/env node
// 社区版产物隐私断言（PRIVACY-AUDIT.md §七验证清单 / §9.5 的可执行化）。
//
// 用法：
//   node scripts/community/assert-privacy.mjs --root <桌面打包输出目录，如 packages/desktop/dist-community>
//   node scripts/community/assert-privacy.mjs --asar <app.asar 路径> [--agent <zcode.cjs 路径>]
//
// 退出码：0 = 全部通过；1 = 存在违规（CI 中应挂构建）。零依赖，跨平台。

import process from "node:process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── 断言集（与 PRIVACY-AUDIT.md §9.5 的实测口径一致，改动前先更新审计文档）──

/** app.asar 中必须为零命中的真实上报端点特征（官方 CI 烘焙产物里存在，社区构建不得出现）。 */
const ASAR_FORBIDDEN = ["proj-xtrace", "apm/trace/opentelemetry"];

/** app.asar 与内置 agent 中都必须为零命名的指纹头（社区版已移除）。 */
const BOTH_FORBIDDEN = ["X-Client-Timezone", "X-Os-Version"];

/** app.asar 中必须存在的 opt-in 开关（证明收口逻辑已编入产物）。 */
const ASAR_REQUIRED = ["ZCODE_SEND_DEVICE_MID", "ZCODE_TELEMETRY_ENABLED"];

/** 内置 agent（resources/glm/zcode.cjs）中必须存在的 opt-in 开关。 */
const AGENT_REQUIRED = ["ZCODE_MODEL_IO_ENABLED", "ZCODE_SEND_CLIENT_HEADERS"];

/** 休眠 SDK 死代码特征：仅报告不判失败（总闸默认 false 使其不可达；物理摘除见 P1=E1）。 */
const DORMANT_INFO = ["sdk.rum.aliyuncs", "rum/web/v2"];

function countOccurrences(buffer, needle) {
  const needleBuffer = Buffer.from(needle, "utf-8");
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = buffer.indexOf(needleBuffer, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + 1;
  }
}

function listUniqueUrls(buffer) {
  const text = buffer.toString("latin1");
  const urls = new Set();
  for (const match of text.matchAll(/https:\/\/[a-zA-Z0-9.-]*aliyuncs[a-zA-Z0-9./_-]*/g)) {
    urls.add(match[0]);
  }
  return [...urls];
}

function findFileRecursive(root, fileName, maxDepth = 8) {
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "app.asar.unpacked" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name === fileName) {
        candidates.push(fullPath);
      }
    }
  };
  walk(root, 0);
  return candidates;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root" || arg === "--asar" || arg === "--agent") {
      options[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      console.error(`[assert-privacy] 未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.root && !options.asar) {
  console.error("[assert-privacy] 缺少 --root 或 --asar 参数");
  process.exit(2);
}

let asarPath = options.asar;
let agentPath = options.agent;
if (options.root) {
  if (!asarPath) {
    const asarCandidates = findFileRecursive(options.root, "app.asar");
    if (asarCandidates.length !== 1) {
      console.error(
        `[assert-privacy] 在 ${options.root} 下预期找到 1 个 app.asar，实际 ${asarCandidates.length} 个`,
      );
      process.exit(1);
    }
    asarPath = asarCandidates[0];
  }
  if (!agentPath) {
    const agentCandidates = findFileRecursive(options.root, "zcode.cjs");
    if (agentCandidates.length !== 1) {
      console.error(
        `[assert-privacy] 在 ${options.root} 下预期找到 1 个内置 agent zcode.cjs，实际 ${agentCandidates.length} 个`,
      );
      process.exit(1);
    }
    agentPath = agentCandidates[0];
  }
}

const asar = readFileSync(asarPath);
const agent = readFileSync(agentPath);
console.log(`[assert-privacy] app.asar: ${asarPath} (${asar.length} bytes)`);
console.log(`[assert-privacy] agent:   ${agentPath} (${agent.length} bytes)`);

let passed = 0;
let failed = 0;
const check = (ok, label) => {
  if (ok) {
    passed += 1;
    console.log(`[PASS] ${label}`);
  } else {
    failed += 1;
    console.log(`[FAIL] ${label}`);
  }
};

for (const pattern of ASAR_FORBIDDEN) {
  const count = countOccurrences(asar, pattern);
  check(count === 0, `asar 不含上报端点特征 "${pattern}"（实际 ${count}）`);
}
for (const pattern of BOTH_FORBIDDEN) {
  check(
    countOccurrences(asar, pattern) === 0,
    `asar 不含指纹头 "${pattern}"（实际 ${countOccurrences(asar, pattern)}）`,
  );
  check(
    countOccurrences(agent, pattern) === 0,
    `agent 不含指纹头 "${pattern}"（实际 ${countOccurrences(agent, pattern)}）`,
  );
}
for (const pattern of ASAR_REQUIRED) {
  const count = countOccurrences(asar, pattern);
  check(count > 0, `asar 含 opt-in 开关 "${pattern}"（实际 ${count}）`);
}
for (const pattern of AGENT_REQUIRED) {
  const count = countOccurrences(agent, pattern);
  check(count > 0, `agent 含 opt-in 开关 "${pattern}"（实际 ${count}）`);
}

for (const pattern of DORMANT_INFO) {
  console.log(
    `[INFO] 休眠 SDK 字符串 "${pattern}"：asar ${countOccurrences(asar, pattern)} 处 / agent ${countOccurrences(agent, pattern)} 处（总闸默认关，不可达；物理摘除 = P1/E1）`,
  );
}
const aliyunUrls = [...listUniqueUrls(asar), ...listUniqueUrls(agent)];
if (aliyunUrls.length > 0) {
  console.log(`[INFO] aliyuncs URL 清单（人工复核，应仅剩 provider 功能端点与休眠 SDK 模板）：`);
  for (const url of aliyunUrls) {
    console.log(`       ${url}`);
  }
}

const total = passed + failed;
console.log(`[assert-privacy] RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed}/${total})`);
process.exit(failed === 0 ? 0 : 1);
