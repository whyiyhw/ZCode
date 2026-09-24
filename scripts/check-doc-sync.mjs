#!/usr/bin/env node
// 文档/口径同步门禁（三层收尾机制的第 3 层：git 推送边界硬门禁）。
//
// 用法：
//   node scripts/check-doc-sync.mjs                检查工作区（含暂存与未跟踪文件）vs HEAD
//   node scripts/check-doc-sync.mjs --push         额外覆盖 @{u}...HEAD 已提交未推送范围（pre-push 用）
//   node scripts/check-doc-sync.mjs --base <ref>   额外覆盖 <ref>...HEAD
//
// 四类检查（2026-09-22 事故驱动：billing 契约头修复落地时文档与隐私断言脱节，门禁全绿但
// CI 断言脚本会在下一次构建误挂——机械可提取的口径必须机械校验，不能依赖会话自觉）：
//   A 新增 ZCODE_* 环境开关未见于任何跟踪文档（.md，排除 .zcode/）或隐私断言脚本 → 违规
//   B 隐私口径三文件 diff 触及敏感头名，但 assert-privacy.mjs / PRIVACY-AUDIT /
//     COMMUNITY-EDITION 均无同步 → 违规
//   C 行为代码有改动而本 diff 无任何 .md 伴随 → 违规
//     （确属无需文档——纯重构/样式等——用 DOCSYNC_ALLOW_NO_DOCS="<原因>" 豁免，仅此一项）
//   D 会话遥测 fact 生产/接收口径（常驻状态断言，非 diff 驱动）：CLI 生产侧 fact kind ⊆
//     白名单（turn.started/turn.terminal），shared schema fact kind 集合 == 登记清单。
//     上游 merge 给 schema 加新分支会零冲突自动合并（2026-09-24 三方 merge 模拟实锤），
//     唯一能抓住该静默回潮的关口就是这里。
//
// 退出码：0 通过 / 1 违规 / 2 用法错误。fail-open：git 不可用或非仓库时按通过处理并告警。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ROOT 可被 DOCSYNC_ROOT 覆盖（仅供测试注入临时仓库；正常使用从脚本位置上推）。
const ROOT =
  process.env.DOCSYNC_ROOT?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function gitOk(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// ── 参数 ──
const argv = process.argv.slice(2);
let baseRef = "";
if (argv[0] === "--push") {
  const upstream = gitOk(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  baseRef = upstream?.trim() ?? "";
} else if (argv[0] === "--base") {
  baseRef = argv[1]?.trim() ?? "";
  if (!baseRef) {
    console.error("用法: node scripts/check-doc-sync.mjs [--push | --base <ref>]");
    process.exit(2);
  }
} else if (argv.length > 0) {
  console.error(`未知参数: ${argv[0]}`);
  process.exit(2);
}

// ── 收集变更 ──
if (!gitOk(["rev-parse", "--is-inside-work-tree"])) {
  console.warn("[check-doc-sync] 非 git 仓库，跳过（fail-open）");
  process.exit(0);
}

/** changedFiles：工作区全部变更 + 可选的已提交未推送范围。 */
const changedFiles = new Set();
/** addedByFile / removedByFile：+/- 行文本（未跟踪文件整文件视为新增）。 */
const addedByFile = new Map();
const removedByFile = new Map();

function recordLines(map, file, lines) {
  if (!lines.length) return;
  const bucket = map.get(file) ?? [];
  bucket.push(...lines);
  map.set(file, bucket);
}

// -uall：porcelain 默认把未跟踪目录折叠成一条目录项，行级提取会全部落空。
for (const line of gitOk(["status", "--porcelain=v1", "-uall"])?.split("\n") ?? []) {
  if (line.length < 4) continue;
  let path = line.slice(3);
  if (path.includes(" -> ")) path = path.slice(path.lastIndexOf(" -> ") + 4);
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (!path) continue;
  changedFiles.add(path);
  if (line.startsWith("??")) {
    // 未跟踪文件：内容整体作为新增行参与 A/B 提取。
    const absolute = join(ROOT, path);
    if (existsSync(absolute) && !/(\/dist\/|\/out\/|\/node_modules\/)/.test(`/${path}/`)) {
      try {
        recordLines(addedByFile, path, readFileSync(absolute, "utf-8").split(/\r?\n/));
      } catch {
        // 不可读（二进制/权限）→ 忽略行级检查，文件仍计入变更集
      }
    }
  }
}

function ingestDiff(diffArgs) {
  const out = gitOk(diffArgs);
  if (!out) return;
  let currentFile = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      changedFiles.add(currentFile);
    } else if (line.startsWith("--- a/")) {
      continue;
    } else if (line.startsWith("+") && currentFile) {
      recordLines(addedByFile, currentFile, [line.slice(1)]);
    } else if (line.startsWith("-") && currentFile) {
      recordLines(removedByFile, currentFile, [line.slice(1)]);
    }
  }
}

ingestDiff(["diff", "HEAD", "-U0"]);
if (baseRef) ingestDiff(["diff", `${baseRef}...HEAD`, "-U0"]);

if (changedFiles.size === 0) {
  console.log("[check-doc-sync] 无变更，通过");
  process.exit(0);
}

// ── 分类 ──
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const isTestPath = /(\.test\.|\.spec\.|\/test\/|\/tests\/|\/__tests__\/)/;
const isBuildPath = /(\/dist\/|\/out\/|\/node_modules\/|^packages\/desktop\/dist)/;
const isBehaviorCode = (p) =>
  /^(packages|apps)\//.test(p) && CODE_EXT.test(p) && !isTestPath.test(p) && !isBuildPath.test(p);
const isScriptCode = (p) => p.startsWith("scripts/") && CODE_EXT.test(p) && !isTestPath.test(p);
const isDoc = (p) => p.endsWith(".md");

// ── 检查 A：新增 ZCODE_* 开关必须有文档登记 ──
// 编译期常量不是环境开关，已知组合直接放行。
const KNOWN_NON_ENV = new Set([
  "ZCODE_VERSION",
  "ZCODE_COMMIT",
  "ZCODE_BUILD_TIME",
  "ZCODE_ENV",
  "ZCODE_PRODUCT_FLAVOR",
]);
const ENV_NAME_RE = /\bZCODE_[A-Z][A-Z0-9_]+\b/g;

const newEnvNames = new Set();
for (const [file, lines] of addedByFile) {
  if (!isBehaviorCode(file) && !isScriptCode(file)) continue;
  for (const line of lines) {
    // 行内需有 env 语境（process.env.X / readEnv(env, "X") 等），排除 ZCODE_* 纯代码常量。
    if (!/env/i.test(line)) continue;
    for (const match of line.matchAll(ENV_NAME_RE)) {
      if (!KNOWN_NON_ENV.has(match[0])) newEnvNames.add(match[0]);
    }
  }
}

const ASSERT_PRIVACY_PATH = "scripts/community/assert-privacy.mjs";
const assertPrivacyContent = existsSync(join(ROOT, ASSERT_PRIVACY_PATH))
  ? readFileSync(join(ROOT, ASSERT_PRIVACY_PATH), "utf-8")
  : "";

function isEnvDocumented(name) {
  if (assertPrivacyContent.includes(name)) return true;
  for (const file of changedFiles) {
    if (!isDoc(file) || file.startsWith(".zcode/")) continue;
    const absolute = join(ROOT, file);
    if (existsSync(absolute)) {
      try {
        if (readFileSync(absolute, "utf-8").includes(name)) return true;
      } catch {
        // 不可读 → 交给 git grep 兜底
      }
    }
  }
  // 跟踪文档全文检索（排除本地 .zcode/，与上面 changed-docs 互补覆盖已提交文档）。
  const tracked = gitOk(["grep", "-l", "-F", "-e", name, "--", "*.md", ":(exclude).zcode/**"]);
  return Boolean(tracked?.trim());
}

const violations = [];

const undocumented = [...newEnvNames].filter((name) => !isEnvDocumented(name));
if (undocumented.length) {
  violations.push(
    `【A】新增环境开关未见于任何文档或隐私断言脚本：${undocumented.join(", ")}\n` +
      `    处置：在受影响文档（AGENTS.md / COMMUNITY-EDITION.md / PRIVACY-AUDIT.md / 相关 spec）登记语义与默认值；\n` +
      `    若属隐私口径开关，同步 scripts/community/assert-privacy.mjs 断言集。`,
  );
}

// ── 检查 B：隐私口径敏感头改动必须伴随断言/审计文档同步 ──
const PRIVACY_TRIO = [
  "packages/shared/src/zcode-source-headers.ts",
  "packages/services/src/providers/sourceHeaders.ts",
  "packages/services/src/providers/api/nodeApiClient.ts",
];
const SENSITIVE_HEADER_TOKENS = ["X-Client-Timezone", "X-Os-Version", "X-Device-Mid"];

const touchedSensitiveHeaders = [];
for (const file of PRIVACY_TRIO) {
  const lines = [...(addedByFile.get(file) ?? []), ...(removedByFile.get(file) ?? [])];
  for (const token of SENSITIVE_HEADER_TOKENS) {
    if (lines.some((line) => line.includes(token)))
      touchedSensitiveHeaders.push(`${file}: ${token}`);
  }
}

if (touchedSensitiveHeaders.length) {
  const synced = [ASSERT_PRIVACY_PATH, "PRIVACY-AUDIT.md", "COMMUNITY-EDITION.md"].some((p) =>
    changedFiles.has(p),
  );
  if (!synced) {
    violations.push(
      `【B】隐私口径文件触及敏感头名（${touchedSensitiveHeaders.join("；")}），\n` +
        `    但 scripts/community/assert-privacy.mjs / PRIVACY-AUDIT.md / COMMUNITY-EDITION.md 均未同步。\n` +
        `    处置：头集变化必须同步断言清单（禁串↔契约豁免口径）与审计记录，否则下一次 CI 隐私门禁会误挂。`,
    );
  }
}

// ── 检查 C：行为变更必须有文档伴随 ──
const behaviorFiles = [...changedFiles].filter(
  (p) =>
    /^(packages|apps)\//.test(p) &&
    CODE_EXT.test(p) &&
    !isTestPath.test(p) &&
    !isBuildPath.test(p) &&
    !/\/spec\//.test(p),
);
const docFiles = [...changedFiles].filter((p) => isDoc(p) && !p.startsWith(".zcode/"));
const noDocsEscape = process.env.DOCSYNC_ALLOW_NO_DOCS?.trim();

if (behaviorFiles.length > 0 && docFiles.length === 0) {
  if (noDocsEscape) {
    console.log(`[check-doc-sync] 检查C 豁免（DOCSYNC_ALLOW_NO_DOCS=${noDocsEscape}）`);
  } else {
    violations.push(
      `【C】行为代码 ${behaviorFiles.length} 个文件变更，但无任何 .md 文档伴随：\n` +
        `    ${behaviorFiles.slice(0, 6).join("\n    ")}${behaviorFiles.length > 6 ? "\n    ..." : ""}\n` +
        `    处置：按 AGENTS.md「先更新对应 spec」同步文档；确属无需文档（纯重构/样式）时，\n` +
        `    用 DOCSYNC_ALLOW_NO_DOCS="<原因>" 豁免本项（其余检查不受影响）。`,
    );
  }
}

// ── 检查 D：会话遥测 fact 生产/接收口径（常驻状态断言，非 diff 驱动）──
// 2026-09-24 fact 裁剪第一步（docs/plans/conversation-telemetry-fact-trim-design.md）后，
// CLI 生产侧只允许 turn.started / turn.terminal（taskActivityTracker 心跳依赖的 turn 链）；
// shared schema 暂保留 10 分支作旧版 CLI 上行事实的 strict 校验面（解析后无人订阅，无害）。
// 上游 merge 是两条口径的主要回潮通道，固化为常驻断言：
//   D1 生产侧：引用 conversationTelemetryFactSchema 的源码里构造的 fact kind ⊆ 生产白名单
//   D2 接收侧：shared telemetry schema 的 fact kind 集合 == 登记清单（新增/消失都须显式登记）
const TELEMETRY_FACT_PRODUCED_ALLOW = new Set(["turn.started", "turn.terminal"]);
const TELEMETRY_FACT_SCHEMA_REGISTRY = new Set([
  "turn.started",
  "model.request.status",
  "stream.chunk",
  "tool.lifecycle",
  "permission.lifecycle",
  "usage.delta",
  "subagent.lifecycle",
  "workflow.lifecycle",
  "turn.terminal",
  "compaction.terminal",
]);
const TELEMETRY_FACT_SCHEMA_PATH = "packages/shared/src/zcode-protocol-v4/telemetry.ts";

// 生产侧扫描面 = 含 fact 构造咽喉（conversationTelemetryFactSchema.parse）的文件：
// 已跟踪（git grep）+ 工作区未跟踪 ts（git grep 看不见）。不能用裸 schema 符号名或
// emit 函数名圈文件——接收方 safeParse 文件与 emit 转发层（v4-bridge/gateway）同文件内
// 有其他子系统的 kind: 字面量，会误报（2026-09-24 首次运行实锤）；kind 提取必须锚定在
// parse 调用点 1000 字符窗口内，防止同文件无关 kind 混入。
const TELEMETRY_FACT_PARSE_RE =
  /conversationTelemetryFactSchema\.parse\([\s\S]{0,1000}?kind:\s*"([^"]+)"/g;
const telemetryProducerFiles = (
  gitOk([
    "grep",
    "-l",
    "-F",
    "conversationTelemetryFactSchema.parse",
    "--",
    "apps",
    "packages",
  ]) ?? ""
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !isTestPath.test(line) && !isBuildPath.test(line));
for (const line of gitOk(["status", "--porcelain=v1", "-uall"])?.split("\n") ?? []) {
  if (!line.startsWith("??")) continue;
  const path = line.slice(3).trim();
  if (!/^(apps|packages)\//.test(path) || !/\.tsx?$/.test(path)) continue;
  if (isTestPath.test(path) || isBuildPath.test(`/${path}/`)) continue;
  try {
    if (readFileSync(join(ROOT, path), "utf-8").includes("conversationTelemetryFactSchema.parse")) {
      telemetryProducerFiles.push(path);
    }
  } catch {
    // 不可读 → 跳过（不作为生产面证据）
  }
}

const producedViolations = [];
for (const file of telemetryProducerFiles) {
  let content;
  try {
    content = readFileSync(join(ROOT, file), "utf-8");
  } catch {
    continue;
  }
  for (const match of content.matchAll(TELEMETRY_FACT_PARSE_RE)) {
    if (!TELEMETRY_FACT_PRODUCED_ALLOW.has(match[1])) {
      producedViolations.push(`${file}: kind "${match[1]}"`);
    }
  }
}
if (producedViolations.length) {
  violations.push(
    `【D1】会话遥测 fact 生产白名单越界（仅允许 turn.started / turn.terminal）：\n` +
      `    ${producedViolations.slice(0, 6).join("\n    ")}${producedViolations.length > 6 ? "\n    ..." : ""}\n` +
      `    处置：上游 merge 带回/新增的 fact 生产分支一律不落地（口径见 docs/plans/conversation-telemetry-fact-trim-design.md\n` +
      `    与 PRIVACY-AUDIT 保留红线）；确需恢复生产时，先更新方案与红线口径，再扩本文件 TELEMETRY_FACT_PRODUCED_ALLOW。`,
  );
}

// 接收侧：schema 文件被整删（第二步裁剪完成态）时跳过；存在则集合必须与登记清单一致。
const telemetrySchemaAbsolute = join(ROOT, TELEMETRY_FACT_SCHEMA_PATH);
if (existsSync(telemetrySchemaAbsolute)) {
  const schemaKinds = new Set(
    [
      ...readFileSync(telemetrySchemaAbsolute, "utf-8").matchAll(
        /kind:\s*z\.literal\("([^"]+)"\)/g,
      ),
    ].map((match) => match[1]),
  );
  const kindAdded = [...schemaKinds].filter((kind) => !TELEMETRY_FACT_SCHEMA_REGISTRY.has(kind));
  const kindRemoved = [...TELEMETRY_FACT_SCHEMA_REGISTRY].filter((kind) => !schemaKinds.has(kind));
  if (kindAdded.length > 0 || kindRemoved.length > 0) {
    violations.push(
      `【D2】shared telemetry schema 的 fact kind 集合与登记清单不一致：` +
        `新增 ${JSON.stringify(kindAdded)} / 消失 ${JSON.stringify(kindRemoved)}\n` +
        `    处置：上游 merge 给 packages/shared/src/zcode-protocol-v4/telemetry.ts 加了新 fact 分支时，\n` +
      `    生产侧不落地（D1 已断），在此显式登记（第二步裁剪候选）；kind 被上游删除或第二步裁剪\n` +
      `    收缩 schema 时，同步收缩本清单。`,
    );
  }
}

// ── 汇总 ──
if (violations.length) {
  console.error(`✗ 文档/口径同步检查失败（${violations.length} 项）：\n`);
  for (const v of violations) console.error(`${v}\n`);
  process.exit(1);
}

console.log(
  `✓ 文档/口径同步检查通过：${changedFiles.size} 个变更文件（行为 ${behaviorFiles.length} / 文档 ${docFiles.length} / 其他 ${changedFiles.size - behaviorFiles.length - docFiles.length}）` +
    (baseRef ? `，含 ${baseRef}...HEAD 已提交范围` : ""),
);
