import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeApiClient } from "../src/providers/api/nodeApiClient.js";
import { buildZCodeSourceHeaders } from "../src/providers/sourceHeaders.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

async function withTempDataBaseDir<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-source-headers-"));
  await mkdir(join(dir, ".zcode", "v2"), { recursive: true });
  setDataBaseDir(dir);
  try {
    return await run();
  } finally {
    setDataBaseDir("");
    await rm(dir, { recursive: true, force: true });
  }
}

test("默认构建不携带计费契约三头（隐私基线）", async () => {
  await withTempDataBaseDir(async () => {
    const headers = buildZCodeSourceHeaders();
    assert.equal("X-Client-Timezone" in headers, false);
    assert.equal("X-Os-Version" in headers, false);
    assert.equal("X-Device-Mid" in headers, false);
  });
});

test("serverContract 携带契约三头，缺 deviceMid 时省略该头不抛错", async () => {
  await withTempDataBaseDir(async () => {
    await writeFile(
      join(getAppConfigDir(), "telemetry-state.json"),
      JSON.stringify({ deviceMid: "11111111-2222-4333-8444-555555555555" }),
      "utf-8",
    );
    const headers = buildZCodeSourceHeaders({ serverContract: true });
    assert.ok(headers["X-Client-Timezone"]);
    assert.ok(headers["X-Os-Version"]);
    assert.equal(headers["X-Device-Mid"], "11111111-2222-4333-8444-555555555555");
  });

  await withTempDataBaseDir(async () => {
    const headers = buildZCodeSourceHeaders({ serverContract: true });
    assert.ok(headers["X-Client-Timezone"]);
    assert.equal("X-Os-Version" in headers, true);
    assert.equal("X-Device-Mid" in headers, false);
  });
});

interface CapturedRequest {
  url: string;
  headers: Headers;
}

function createCapturingApiClient(): { client: NodeApiClient; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const client = new NodeApiClient({
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
    resolveZCodeEndpointOrigin: () => "https://zcode.z.ai",
  });
  return { client, requests };
}

test("billing 路径注入契约头，其余 zcode 路径不注入", async () => {
  await withTempDataBaseDir(async () => {
    await writeFile(
      join(getAppConfigDir(), "telemetry-state.json"),
      JSON.stringify({ deviceMid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
      "utf-8",
    );
    const { client, requests } = createCapturingApiClient();

    await client.request(
      "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.14.1",
      {
        headers: { Authorization: "token" },
      },
    );
    await client.request("https://zcode.z.ai/api/v1/client/configs", {
      headers: { Authorization: "token" },
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.get("X-Client-Timezone") !== null, true);
    assert.equal(requests[0].headers.get("X-Os-Version") !== null, true);
    assert.equal(requests[0].headers.get("X-Device-Mid"), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.equal(requests[0].headers.get("Authorization"), "token");
    assert.equal(requests[1].headers.get("X-Client-Timezone"), null);
    assert.equal(requests[1].headers.get("X-Device-Mid"), null);
  });
});

test("ZCODE_BILLING_CONTRACT_HEADERS=0 关闭 billing 契约头", async () => {
  await withTempDataBaseDir(async () => {
    const { client, requests } = createCapturingApiClient();
    const previous = process.env.ZCODE_BILLING_CONTRACT_HEADERS;
    process.env.ZCODE_BILLING_CONTRACT_HEADERS = "0";
    try {
      await client.request(
        "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.14.1",
        {
          headers: { Authorization: "token" },
        },
      );
    } finally {
      if (previous === undefined) delete process.env.ZCODE_BILLING_CONTRACT_HEADERS;
      else process.env.ZCODE_BILLING_CONTRACT_HEADERS = previous;
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.get("X-Client-Timezone"), null);
  });
});
