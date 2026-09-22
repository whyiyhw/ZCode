/* eslint-disable max-lines -- 协议与 14 工具的单文件契约测试：fake Helper 夹具与用例
   集中维护，拆分会让协议断言与工具断言失去对照。 */
// Computer Use broker 协议与执行器测试（node --test 直跑，无构建依赖）：
//   node --test packages/zcode-cua/test/
// 覆盖：NDJSON 帧协议 round-trip（fake Helper 用本包服务端原语起真实命名管道）、
// 运行时契约（管道名/请求行校验）、14 工具映射（fake backend）、kill switch 与
// CUA_NOT_READY 信封语义。
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  BrokerError,
  callBrokerMethod,
  dispatchRequest,
  errorResponse,
  errorResponseFromException,
  handleRequestLine,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
  mintBrokerSocketPath,
  notAuthorized,
  okResponse,
  parseRequestLine,
  probeHelperHealth,
  serializeResponse,
  withBrokerPresentation,
} from "../broker.js";
import { createComputerUseRuntime } from "../index.js";

function fakeBackend(overrides = {}) {
  return {
    broker_info: async () => ({
      pid: 4321,
      tcc_grant_owner: "dev.zcode.cua-helper",
      api_version: "ZCodeComputerUseIPC-1",
      framing: "ndjson",
    }),
    list_applications: async () => [{ pid: 1, bundle_id: "app.exe", name: "App", active: true }],
    list_windows: async (params) => ({
      windows: [
        {
          index: 0,
          window_id: 9,
          title: `win-${JSON.stringify(params.app_ref)}`,
          bounds: [0, 0, 10, 10],
        },
      ],
    }),
    capture_app: async () => ({
      state_id: "s-1",
      app: { pid: 1, bundle_id: "app.exe", name: "App" },
      window: { title: "Main", bounds: [0, 0, 100, 100], window_id: 9 },
      elements: [
        {
          role: "Window",
          title: "Main",
          bounds: [0, 0, 100, 100],
          native: "tok-0",
          depth: 0,
          actions: [],
        },
        {
          role: "Button",
          title: "OK",
          bounds: [10, 10, 20, 20],
          native: "tok-1",
          depth: 1,
          actions: ["press"],
          pressable: true,
        },
        {
          role: "TextField",
          title: "Name",
          value: "old",
          bounds: [10, 40, 60, 20],
          native: "tok-2",
          depth: 1,
          editable: true,
        },
      ],
      snapshot_mode: "full",
    }),
    click: async (params) => ({ clicked: params }),
    element_perform_action: async (params) => ({ performed: params }),
    element_set_value: async (params) => ({ set: params }),
    type_text: async (params) => ({ typed: params }),
    press_key: async (params) => ({ pressed: params }),
    scroll: async (params) => ({ scrolled: params }),
    paste: async (params) => ({ pasted: params }),
    request_access: async () => ({ status: "granted" }),
    permission_status: async () => ({ accessibility: "granted", screen_recording: "granted" }),
    cancel_input_holds: async () => ({ cancelled: true }),
    ...overrides,
  };
}

async function startFakeHelper(backend) {
  const socketPath = mintBrokerSocketPath();
  const server = createServer((conn) => {
    let buffer = "";
    // 客户端超时销毁连接时服务端在途 write 会 EPIPE；吞掉，不影响后续连接。
    conn.on("error", () => undefined);
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        void handleRequestLine(backend, line).then((response) => {
          conn.write(serializeResponse(response));
        });
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { socketPath, close: () => new Promise((resolve) => server.close(resolve)) };
}

const CONTEXT = { sessionId: "sess_test", runtimeScope: "main", workspaceKey: "ws" };

// ---------------------------------------------------------------------------
// 协议原语
// ---------------------------------------------------------------------------
test("parseRequestLine 校验非法请求", () => {
  assert.deepEqual(parseRequestLine("{bad json"), {
    ok: false,
    id: 0,
    code: "invalid_request",
    message: "request is not valid JSON",
  });
  assert.equal(parseRequestLine('{"method":"click"}').ok, false);
  assert.equal(parseRequestLine('{"id":-1,"method":"click"}').code, "invalid_request");
  assert.equal(parseRequestLine('{"id":1,"method":""}').code, "invalid_request");
  assert.equal(parseRequestLine('{"id":1,"method":"click","params":[]}').code, "invalid_request");
  const parsed = parseRequestLine('{"id":7,"method":"click","params":{"x":1}}');
  assert.deepEqual(parsed, { ok: true, request: { id: 7, method: "click", params: { x: 1 } } });
  assert.deepEqual(parseRequestLine('{"id":7,"method":"click"}').request.params, {});
});

test("响应信封与序列化", () => {
  assert.deepEqual(okResponse(1, { a: 1 }), { id: 1, ok: true, result: { a: 1 } });
  assert.equal(serializeResponse(okResponse(1, null)).endsWith("\n"), true);
  const err = errorResponse(2, "not_settable", "refuse", { element: 3 });
  assert.deepEqual(err, {
    id: 2,
    ok: false,
    error: { code: "not_settable", message: "refuse", details: { element: 3 } },
  });
  assert.equal(errorResponse(2, "x", "m", {}).error.details, undefined);
  const fromException = errorResponseFromException(3, notAuthorized("no"));
  assert.equal(fromException.error.code, "not_authorized");
});

test("dispatchRequest：方法表白名单与 presentation 通道", async () => {
  const unknown = await dispatchRequest(fakeBackend(), { id: 1, method: "nope", params: {} });
  assert.equal(unknown.error.code, "method_not_found");
  const backend = fakeBackend({
    capture_app: async () => withBrokerPresentation("frame", { primary: { appKey: "k" } }),
  });
  const presented = await dispatchRequest(backend, { id: 2, method: "capture_app", params: {} });
  assert.deepEqual(presented, {
    id: 2,
    ok: true,
    result: "frame",
    presentation: { primary: { appKey: "k" } },
  });
  const failed = await dispatchRequest(
    fakeBackend({
      click: async () => {
        throw notAuthorized("denied");
      },
    }),
    { id: 3, method: "click", params: {} },
  );
  assert.equal(failed.error.code, "not_authorized");
  assert.equal(isBrokerMethod("broker_info"), true);
  assert.equal(isBrokerMethod("click"), true);
  assert.equal(isBrokerMethod("nope"), false);
  assert.equal(isReadOnlyBrokerMethod("list_windows"), true);
  assert.equal(isReadOnlyBrokerMethod("click"), false);
});

test("mintBrokerSocketPath：win32 命名管道契约", () => {
  const path = mintBrokerSocketPath();
  if (process.platform === "win32") {
    assert.match(path, /^\\\\\.\\pipe\\zcode-cua-helper-[0-9a-f]{16}$/u);
  } else {
    assert.match(path, /broker-[0-9a-f]{16}\.sock$/u);
  }
});

// ---------------------------------------------------------------------------
// 客户端 ↔ fake Helper round-trip（真实 named pipe / unix socket）
// ---------------------------------------------------------------------------
test("callBrokerMethod：握手、成功、错误与 delivery state", async () => {
  const helper = await startFakeHelper(fakeBackend());
  try {
    const apps = await callBrokerMethod({
      socketPath: helper.socketPath,
      method: "list_applications",
    });
    assert.equal(apps[0].bundle_id, "app.exe");
    await assert.rejects(
      callBrokerMethod({
        socketPath: helper.socketPath,
        method: "list_applications",
        timeoutMs: 1,
      }),
      (error) => error instanceof BrokerError && error.code === "timeout",
    );
    await assert.rejects(
      callBrokerMethod({
        socketPath: "\\\\.\\pipe\\definitely-missing-zcode",
        method: "broker_info",
        timeoutMs: 800,
      }),
      (error) =>
        error instanceof BrokerError &&
        error.code === "unavailable" &&
        error.details.request_delivery_state === "not_sent",
    );
    const health = await probeHelperHealth(helper.socketPath, { timeoutMs: 3000 });
    assert.equal(health.pid, 4321);
    assert.equal(health.bundleId, "dev.zcode.cua-helper");
    const missing = await probeHelperHealth("\\\\.\\pipe\\definitely-missing-zcode", {
      timeoutMs: 300,
    });
    assert.deepEqual(missing, { bundleId: null, pid: null });
  } finally {
    await helper.close();
  }
});

// ---------------------------------------------------------------------------
// 执行器：14 工具映射（fake Helper）
// ---------------------------------------------------------------------------
async function withRuntime(backend, run) {
  const helper = await startFakeHelper(backend);
  const runtime = createComputerUseRuntime({ brokerSocketPath: helper.socketPath });
  try {
    await run(runtime);
  } finally {
    await runtime.dispose().catch(() => undefined);
    await helper.close();
  }
}

test("list_apps / list_windows / get_app_state", async () => {
  await withRuntime(fakeBackend(), async (runtime) => {
    const apps = await runtime.execute({ toolName: "list_apps", arguments: {}, context: CONTEXT });
    const parsed = JSON.parse(apps.content[0].text);
    assert.equal(parsed[0].bundle_id, "app.exe");

    const windows = await runtime.execute({
      toolName: "list_windows",
      arguments: { app_ref: { bundle_id: "app.exe" } },
      context: CONTEXT,
    });
    assert.match(JSON.parse(windows.content[0].text).windows[0].title, /app\.exe/);
    await assert.rejects(
      runtime.execute({ toolName: "list_windows", arguments: {}, context: CONTEXT }),
      (error) => error.code === "INVALID_INPUT",
    );

    const state = await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 1 }, include_screenshot: false },
      context: CONTEXT,
    });
    assert.equal(state.structuredContent.state_id, "s-1");
    assert.equal(state.structuredContent.elements.length, 3);
    assert.equal(state.structuredContent.elements[1].index, 1);
    assert.match(state.content.at(-1).text, /\[1\] Button "OK" \(pressable\)/u);
  });
});

test("元素动作经 native token 派发；坐标动作走 click", async () => {
  const calls = [];
  await withRuntime(
    fakeBackend({
      element_set_value: async (params) => {
        calls.push(["element_set_value", params]);
        return { ok: true };
      },
      click: async (params) => {
        calls.push(["click", params]);
        return { ok: true };
      },
      element_perform_action: async (params) => {
        calls.push(["element_perform_action", params]);
        return { ok: true };
      },
    }),
    async (runtime) => {
      await runtime.execute({
        toolName: "get_app_state",
        arguments: { app_ref: { pid: 1 } },
        context: CONTEXT,
      });
      await runtime.execute({
        toolName: "set_value",
        arguments: { target: { type: "element", index: 2 }, value: "new" },
        context: CONTEXT,
      });
      assert.deepEqual(calls[0], [
        "element_set_value",
        { native: "tok-2", value: "new", strategy: "auto" },
      ]);
      await runtime.execute({
        toolName: "left_click",
        arguments: { target: { type: "element", index: 1 } },
        context: CONTEXT,
      });
      assert.deepEqual(calls[1], [
        "element_perform_action",
        { native: "tok-1", action: "AXPress" },
      ]);
      await runtime.execute({
        toolName: "left_click",
        arguments: { target: { type: "coordinate", x: 5, y: 5 } },
        context: CONTEXT,
      });
      assert.equal(calls[2][0], "click");
      assert.deepEqual(calls[2][1].point, { x: 5, y: 5 });
    },
  );
});

test("type 三分支与 key 校验", async () => {
  const calls = [];
  await withRuntime(
    fakeBackend({
      element_set_value: async (params) => {
        calls.push(["element_set_value", params]);
        return {};
      },
      type_text: async (params) => {
        calls.push(["type_text", params]);
        return {};
      },
      type_text_to_app: async (params) => {
        calls.push(["type_text_to_app", params]);
        return {};
      },
      press_key: async (params) => {
        calls.push(["press_key", params]);
        return {};
      },
    }),
    async (runtime) => {
      await runtime.execute({
        toolName: "get_app_state",
        arguments: { app_ref: { pid: 1 } },
        context: CONTEXT,
      });
      await runtime.execute({
        toolName: "type",
        arguments: { text: "hello", target: { type: "element", index: 2 } },
        context: CONTEXT,
      });
      assert.deepEqual(calls[0][1], { native: "tok-2", value: "hello" });
      await runtime.execute({ toolName: "type", arguments: { text: "plain" }, context: CONTEXT });
      assert.deepEqual(calls[1][1], { text: "plain", strategy: "auto" });
      await runtime.execute({
        toolName: "type",
        arguments: { text: "toapp", app_ref: "app.exe" },
        context: CONTEXT,
      });
      assert.deepEqual(calls[2][1], {
        text: "toapp",
        app_ref: { bundle_id: "app.exe" },
        strategy: "auto",
      });
      await runtime.execute({ toolName: "key", arguments: { text: "ctrl+s" }, context: CONTEXT });
      assert.deepEqual(calls[3][1], { text: "ctrl+s", strategy: "auto" });
      await assert.rejects(
        runtime.execute({
          toolName: "key",
          arguments: { text: "ctrl+badtoken" },
          context: CONTEXT,
        }),
        (error) => error.code === "INVALID_INPUT" && error.message.includes("action_sent=false"),
      );
    },
  );
});

test("未知参数被 strict schema 拒绝", async () => {
  await withRuntime(fakeBackend(), async (runtime) => {
    await assert.rejects(
      runtime.execute({
        toolName: "list_windows",
        arguments: { app_ref: "a", extra: 1 },
        context: CONTEXT,
      }),
      (error) =>
        error.code === "INVALID_INPUT" && error.message.includes('Unknown argument "extra"'),
    );
  });
});

test("stop_computer_control：本地 latch + 会话隔离", async () => {
  await withRuntime(fakeBackend(), async (runtime) => {
    const stop = await runtime.execute({
      toolName: "stop_computer_control",
      arguments: { reason: "test" },
      context: CONTEXT,
    });
    const parsed = JSON.parse(stop.content[0].text);
    assert.equal(parsed.stopped, true);
    assert.equal(parsed.reason, "test");
    await assert.rejects(
      runtime.execute({ toolName: "list_apps", arguments: {}, context: CONTEXT }),
      (error) => error.code === "CONTROL_STOPPED",
    );
    // kill switch 豁免工具仍可用。
    const access = await runtime.execute({
      toolName: "request_access",
      arguments: {},
      context: CONTEXT,
    });
    const report = JSON.parse(access.content[0].text);
    assert.equal(report.guard.stopped, true);
    assert.equal(report.broker.connected, true);
    // 新会话不受旧会话 latch 影响。
    const fresh = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: { ...CONTEXT, sessionId: "sess_other" },
    });
    assert.equal(JSON.parse(fresh.content[0].text).length, 1);
  });
});

test("subagent 拒绝", async () => {
  await withRuntime(fakeBackend(), async (runtime) => {
    const result = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: { ...CONTEXT, runtimeScope: "subagent" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Computer Use is not available in subagent");
  });
});

test("未知工具给出删除指引", async () => {
  await withRuntime(fakeBackend(), async (runtime) => {
    await assert.rejects(
      runtime.execute({ toolName: "open_application", arguments: {}, context: CONTEXT }),
      (error) => error.message.includes("get_app_state binds an app"),
    );
  });
});

test("Helper 不可达：CUA_NOT_READY 信封而非 error", async () => {
  const runtime = createComputerUseRuntime({
    brokerSocketPath: "\\\\.\\pipe\\definitely-missing-zcode",
  });
  try {
    const result = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: CONTEXT,
    });
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.kind, "CUA_NOT_READY");
    assert.equal(typeof parsed.retryable, "boolean");
  } finally {
    await runtime.dispose().catch(() => undefined);
  }
});

test("元素索引位移被拒绝", async () => {
  let flip = false;
  await withRuntime(
    fakeBackend({
      capture_app: async () => ({
        state_id: "s-2",
        app: { pid: 1, bundle_id: "app.exe" },
        window: { title: "Main" },
        elements: flip
          ? [{ role: "Pane", title: "changed", native: "tok-x", depth: 0 }]
          : [
              { role: "Window", title: "Main", native: "tok-0", depth: 0 },
              { role: "Button", title: "OK", native: "tok-1", depth: 1 },
            ],
        snapshot_mode: "full",
      }),
    }),
    async (runtime) => {
      // 第一次观察进模型可见台账；第二次静默观察（tree_shown_to_model=false）
      // 换树但不更新台账——随后的元素动作必须检出索引位移。
      await runtime.execute({
        toolName: "get_app_state",
        arguments: { app_ref: { pid: 1 } },
        context: CONTEXT,
      });
      flip = true;
      await runtime.execute({
        toolName: "get_app_state",
        arguments: { app_ref: { pid: 1 }, tree_shown_to_model: false },
        context: CONTEXT,
      });
      await assert.rejects(
        runtime.execute({
          toolName: "set_value",
          arguments: { target: { type: "element", index: 0 }, value: "x" },
          context: CONTEXT,
        }),
        (error) =>
          error.code === "ELEMENT_INDEX_SHIFTED" && error.message.includes("action_sent=false"),
      );
    },
  );
});
