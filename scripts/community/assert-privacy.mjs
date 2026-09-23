#!/usr/bin/env node
// 社区版产物隐私断言（PRIVACY-AUDIT.md §七验证清单 / §9.5 的可执行化）。
//
// 用法：
//   node scripts/community/assert-privacy.mjs --root <桌面打包输出目录，如 packages/desktop/dist-community>
//   node scripts/community/assert-privacy.mjs --asar <app.asar 路径> [--agent <zcode.cjs 路径>]
//
// 退出码：0 = 全部通过；1 = 存在违规（CI 中应挂构建）。零依赖，跨平台。

import process from "node:process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ── 断言集（与 PRIVACY-AUDIT.md §9.5 的实测口径 + §十二计费契约豁免一致，改动前先更新审计文档）──

/** app.asar 中必须为零命中的真实上报端点特征（官方 CI 烘焙产物里存在，社区构建不得出现）。 */
const ASAR_FORBIDDEN = ["proj-xtrace", "apm/trace/opentelemetry"];

/**
 * 计费契约头（PRIVACY-AUDIT.md §十二豁免，2026-09-22）：`/api/v1/zcode-plan/` 路径族
 * 服务端强制要求 X-Client-Timezone / X-Os-Version / X-Device-Mid，缺失即 400。
 * 因此这两个头名不再是全量禁串——改为「成对证明」：只要它们出现，scoped 实现的
 * 证据串必须同时出现（路径前缀判定 + kill-switch），证明不是无条件回滚成全量外发。
 */
const CONTRACT_HEADER_NAMES = ["X-Client-Timezone", "X-Os-Version"];
const CONTRACT_SCOPED_PROOF = ["/api/v1/zcode-plan/", "ZCODE_BILLING_CONTRACT_HEADERS"];

/** app.asar 中必须存在的 opt-in 开关（证明收口逻辑已编入产物）。 */
// 遥测栈已于 2026-09-23 整体删除（PRIVACY-AUDIT.md §十五），ZCODE_TELEMETRY_ENABLED 不再存在。
const ASAR_REQUIRED = ["ZCODE_SEND_DEVICE_MID"];

/** 内置 agent（resources/glm/zcode.cjs）中必须存在的 opt-in 开关。 */
const AGENT_REQUIRED = ["ZCODE_MODEL_IO_ENABLED", "ZCODE_SEND_CLIENT_HEADERS"];

/** 遥测栈删除（2026-09-23，原 P1=E1）后应为零命中；保留为回归探针。 */
const TELEMETRY_REMOVED_PROBES = ["sdk.rum.aliyuncs", "rum/web/v2"];

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
// 计费契约豁免的正向断言：scoped 实现（路径前缀 + kill-switch + 契约头名）必须都在 asar。
// 若未来服务端取消该契约，移除相应头时须同步改回禁串口径并更新 PRIVACY-AUDIT.md §十二。
for (const pattern of CONTRACT_SCOPED_PROOF) {
  const count = countOccurrences(asar, pattern);
  check(count > 0, `asar 含计费契约 scoped 实现证据 "${pattern}"（实际 ${count}）`);
}
for (const pattern of CONTRACT_HEADER_NAMES) {
  const count = countOccurrences(asar, pattern);
  check(
    count > 0,
    `asar 含计费契约头 "${pattern}"（实际 ${count}；仅 /api/v1/zcode-plan/ 路径携带）`,
  );
  const agentCount = countOccurrences(agent, pattern);
  console.log(
    `[INFO] 计费契约头 "${pattern}"：agent ${agentCount} 处（shared 依赖副本可含契约实现代码；CLI 模型链路不调用 serverContract，且 ZCODE_SEND_CLIENT_HEADERS 总闸在 agent 必在）`,
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

for (const pattern of TELEMETRY_REMOVED_PROBES) {
  const asarCount = countOccurrences(asar, pattern);
  const agentCount = countOccurrences(agent, pattern);
  check(
    asarCount === 0 && agentCount === 0,
    `遥测已删除，残留字符串 "${pattern}" 应为零命中（asar ${asarCount} / agent ${agentCount}）`,
  );
}
const aliyunUrls = [...listUniqueUrls(asar), ...listUniqueUrls(agent)];
if (aliyunUrls.length > 0) {
  console.log(`[INFO] aliyuncs URL 清单（人工复核，应仅剩 provider 功能端点）：`);
  for (const url of aliyunUrls) {
    console.log(`       ${url}`);
  }
}

const total = passed + failed;
console.log(`[assert-privacy] RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed}/${total})`);
process.exit(failed === 0 ? 0 : 1);
