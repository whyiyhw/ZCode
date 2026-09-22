// runtime-staging（auto-stage）测试：tmpdir 伪造运行时夹具，覆盖校验拒收、
// 契约补写、幂等与源发现。node --test 直跑。
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CuaRuntimeStagingError,
  findWindowsCuaHelperSource,
  isAutoStageEnabled,
  stageCuaHelperRuntime,
  verifyCuaHelperRuntime,
} from "../runtime-staging.js";

async function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function buildFixtureRuntime(root, { corruptEntry = false } = {}) {
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "build", "Release"), { recursive: true });
  const entryContent = `console.log("helper ${randomBytes(4).toString("hex")}");\n`;
  const addonContent = randomBytes(64);
  await writeFile(join(root, "dist", "helper.js"), entryContent);
  await writeFile(join(root, "build", "Release", "native.node"), addonContent);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "@zcode/zcode-cua-helper-runtime", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  const manifest = {
    schemaVersion: 1,
    packageName: "@zcode/zcode-cua",
    packageVersion: "9.9.9",
    platform: "win32",
    arch: process.arch === "arm64" ? "arm64" : "x64",
    electronVersion: "41.0.3",
    entry: "dist/helper.js",
    addon: "build/Release/native.node",
    sha256: {
      entry: await sha256(entryContent),
      addon: await sha256(addonContent),
    },
  };
  await writeFile(join(root, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (corruptEntry) {
    await writeFile(join(root, "dist", "helper.js"), "tampered");
  }
  return manifest;
}

async function withTempDirs(run) {
  const base = await mkdtemp(join(tmpdir(), "zcode-cua-staging-"));
  const sourceRoot = join(base, "source-runtime");
  const targetRoot = join(base, "target-runtime");
  await mkdir(sourceRoot, { recursive: true });
  try {
    await run({ base, sourceRoot, targetRoot });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("verifyCuaHelperRuntime：完整校验与三类拒收", async () => {
  await withTempDirs(async ({ sourceRoot }) => {
    const manifest = await buildFixtureRuntime(sourceRoot);
    const verified = await verifyCuaHelperRuntime(sourceRoot, {
      arch: manifest.arch,
      electronVersion: manifest.electronVersion,
    });
    assert.equal(verified.packageVersion, "9.9.9");

    await assert.rejects(
      verifyCuaHelperRuntime(sourceRoot, { arch: manifest.arch === "x64" ? "arm64" : "x64" }),
      (error) => error instanceof CuaRuntimeStagingError && error.code === "arch_mismatch",
    );
    await assert.rejects(
      verifyCuaHelperRuntime(sourceRoot, { electronVersion: "40.0.0" }),
      (error) => error instanceof CuaRuntimeStagingError && error.code === "electron_mismatch",
    );
    await buildFixtureRuntime(sourceRoot, { corruptEntry: true });
    await assert.rejects(
      verifyCuaHelperRuntime(sourceRoot, { arch: manifest.arch }),
      (error) => error instanceof CuaRuntimeStagingError && error.code === "integrity_mismatch",
    );
  });
});

test("stageCuaHelperRuntime：契约补写、幂等与坏源拒收", async () => {
  await withTempDirs(async ({ sourceRoot, targetRoot }) => {
    const manifest = await buildFixtureRuntime(sourceRoot);
    const first = await stageCuaHelperRuntime({
      sourceRoot,
      targetRoot,
      arch: manifest.arch,
      electronVersion: manifest.electronVersion,
    });
    assert.equal(first.staged, true);
    const pkg = JSON.parse(await readFile(join(targetRoot, "package.json"), "utf8"));
    assert.equal(pkg.name, "@zcode/zcode-cua");
    assert.equal(pkg.version, "9.9.9");
    assert.deepEqual(pkg.zcodeCuaRuntime, {
      schema: 1,
      windows: { entry: manifest.entry, nativeAddon: manifest.addon },
    });

    const second = await stageCuaHelperRuntime({
      sourceRoot,
      targetRoot,
      arch: manifest.arch,
    });
    assert.equal(second.staged, false);

    // 坏源拒绝且不碰已有目标。
    await buildFixtureRuntime(sourceRoot, { corruptEntry: true });
    await assert.rejects(
      stageCuaHelperRuntime({ sourceRoot, targetRoot, arch: manifest.arch }),
      (error) => error instanceof CuaRuntimeStagingError && error.code === "integrity_mismatch",
    );
    const still = JSON.parse(await readFile(join(targetRoot, "package.json"), "utf8"));
    assert.equal(still.version, "9.9.9");

    // 好源 + force 覆盖落位。
    await buildFixtureRuntime(sourceRoot);
    const forced = await stageCuaHelperRuntime({
      sourceRoot,
      targetRoot,
      arch: manifest.arch,
      force: true,
    });
    assert.equal(forced.staged, true);
    await verifyCuaHelperRuntime(targetRoot, { arch: manifest.arch });
  });
});

test("findWindowsCuaHelperSource：env 覆盖发现官方安装形态", async () => {
  await withTempDirs(async ({ base, sourceRoot }) => {
    const manifest = await buildFixtureRuntime(sourceRoot);
    void manifest;
    const installRoot = join(base, "official-install");
    await mkdir(join(installRoot, "resources", "tools"), { recursive: true });
    // 把夹具挪进官方安装形态的 resources/tools/cua-helper。
    const { rename } = await import("node:fs/promises");
    await rename(sourceRoot, join(installRoot, "resources", "tools", "cua-helper"));
    const found = await findWindowsCuaHelperSource(
      { ZCODE_CUA_HELPER_SOURCE: installRoot },
      { readRegistry: false },
    );
    assert.equal(found, join(installRoot, "resources", "tools", "cua-helper"));
    const none = await findWindowsCuaHelperSource(
      { ZCODE_CUA_HELPER_SOURCE: join(base, "missing") },
      { readRegistry: false },
    );
    assert.equal(none, null);
  });
});

test("isAutoStageEnabled 默认开、可关闭", () => {
  assert.equal(isAutoStageEnabled({}), true);
  assert.equal(isAutoStageEnabled({ ZCODE_CUA_HELPER_AUTO_STAGE: "1" }), true);
  for (const value of ["0", "false", "off"]) {
    assert.equal(isAutoStageEnabled({ ZCODE_CUA_HELPER_AUTO_STAGE: value }), false);
  }
});
