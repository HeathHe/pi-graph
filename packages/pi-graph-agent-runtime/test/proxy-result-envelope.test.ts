import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { handleProxyRequest } from "../src/extension/index.ts";
import { dispatchRegisteredChildTool } from "../src/extension/teammate-proxy.ts";
import { registerTeammateChildToolBroker } from "../src/runs/child-extensions.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

// The child-side proxyCall rejects any teammate_proxy_result whose `result`
// lacks a `content` array or an own `details` property — the failure then
// surfaces as "invalid result envelope" and the real error is lost. Every
// proxy reply must satisfy that wire contract.
function assertProxyEnvelope(reply: Record<string, unknown>): void {
  const result = reply.result as Record<string, unknown>;
  assert.ok(result && typeof result === "object", "proxy reply must carry a result object");
  assert.ok(Array.isArray(result.content), "result.content must be an array");
  assert.ok(
    Object.prototype.hasOwnProperty.call(result, "details"),
    "result.details must be an own property",
  );
  assert.ok(
    result.isError === undefined || typeof result.isError === "boolean",
    "result.isError must be boolean when present",
  );
}

function makeState(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map<string, ActiveAgent>(),
    namedAgents: new Map<string, string>(),
  };
}

function makeAgent(correlationId: string, overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  const now = Date.now();
  return {
    agent: "worker",
    correlationId,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
    ...overrides,
  };
}

const stubPi = {
  events: { emit() {} },
  sendMessage() {},
} as never;

test("a throwing teammate dispatch replies with a valid envelope carrying the real error", async () => {
  // context:"fork" with a spawner that has no sessionFile throws inside the
  // teammate case; the catch used to reply without `details`, so the child saw
  // only "invalid result envelope" instead of the fork-snapshot diagnostic.
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid));

  let captured: Record<string, unknown> | undefined;
  await handleProxyRequest(
    stubPi,
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: randomUUID(),
      params: { tasks: [{ agent: "worker", prompt: "noop", context: "fork" }] },
    },
    (msg) => { captured = msg as Record<string, unknown>; },
    parentCid,
  );

  assert.ok(captured, "handleProxyRequest must reply");
  assertProxyEnvelope(captured);
  const result = captured.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /fork-snapshot-invalid/);
});

test("an unsupported proxy tool reply satisfies the envelope contract", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid));

  let captured: Record<string, unknown> | undefined;
  await handleProxyRequest(
    stubPi,
    state,
    {
      type: "teammate_proxy_request",
      tool: "no-such-tool",
      requestId: randomUUID(),
      params: {},
    },
    (msg) => { captured = msg as Record<string, unknown>; },
    parentCid,
  );

  assert.ok(captured, "handleProxyRequest must reply");
  assertProxyEnvelope(captured);
  const result = captured.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unsupported teammate child proxy tool/);
});

test("a broker result without details is normalized to the envelope contract", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid));

  const unregister = registerTeammateChildToolBroker("bare-tool", async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  try {
    let captured: Record<string, unknown> | undefined;
    await handleProxyRequest(
      stubPi,
      state,
      {
        type: "teammate_proxy_request",
        tool: "bare-tool",
        requestId: randomUUID(),
        params: {},
      },
      (msg) => { captured = msg as Record<string, unknown>; },
      parentCid,
    );
    assert.ok(captured, "handleProxyRequest must reply");
    assertProxyEnvelope(captured);
    const result = captured.result as { content: Array<{ text: string }> };
    assert.equal(result.content[0].text, "ok");
  } finally {
    unregister();
  }
});

test("a broker returning a non-object result is converted to an error envelope", async () => {
  const unregister = registerTeammateChildToolBroker("malformed-tool", async () => undefined as never);
  try {
    let captured: Record<string, unknown> | undefined;
    await dispatchRegisteredChildTool(
      {
        type: "teammate_proxy_request",
        tool: "malformed-tool",
        requestId: randomUUID(),
        params: {},
      },
      (msg) => { captured = msg as Record<string, unknown>; },
    );
    assert.ok(captured, "dispatchRegisteredChildTool must reply");
    assertProxyEnvelope(captured);
    const result = captured.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /malformed result/);
  } finally {
    unregister();
  }
});
