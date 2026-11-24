import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserTool } from "../src/tools/browser-tool.ts";
import { GatewayBrowserService } from "../src/gateway/services/browser-service.ts";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { observeBrowserRunApis, type BrowserManagerLike } from "../src/tools/browser/manager.ts";
import { attachBrowserRunFailureDiagnostics, browserRunFailureDiagnostics, BrowserRunDiagnosticCapture, createBrowserRunDeadline } from "../src/tools/browser/run-diagnostics.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("run diagnostic capture bounds text, screenshot metadata and exposed operation names without arguments", async () => {
  const capture = new BrowserRunDiagnosticCapture();
  let resolve!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  const apis = observeBrowserRunApis("test", { evaluate: (_script: string) => pending }, {}, {}, undefined, undefined, capture.operation);
  const result = apis.page.evaluate("SECRET_SCRIPT_AND_ARGUMENTS");
  capture.captureText("x".repeat(10_000));
  capture.captureText("tail");
  const diagnostics = capture.snapshot(10, 20, Array.from({ length: 12 }, () => ({ path: "p".repeat(2_000), mimeType: "image/png", bytes: 4 })));
  assert.deepEqual(diagnostics.activeOperations, ["page.evaluate"]);
  assert.equal(diagnostics.lastOperation, "page.evaluate");
  assert.equal(diagnostics.activeOperationCount, 1);
  assert.equal(diagnostics.partialText.length, 8_192);
  assert.equal(diagnostics.partialTextTruncated, true);
  assert.equal(diagnostics.screenshots.length, 8);
  assert.equal(diagnostics.screenshots[0].path?.length, 1_024);
  assert.equal(diagnostics.screenshotsTruncated, true);
  assert.ok(!JSON.stringify(diagnostics).includes("SECRET"));
  resolve();
  await result;
  assert.equal(capture.snapshot(10, 20, []).activeOperationCount, 0);
});

test("run diagnostic capture keeps pending counts with bounded storage under fan-out", () => {
  const capture = new BrowserRunDiagnosticCapture();
  const finish = Array.from({ length: 10_000 }, (_, i) => capture.operation(`page.operation${i % 32}`));
  const before = capture.snapshot(10, 20, []);
  assert.equal(before.activeOperationCount, 10_000);
  assert.equal(before.activeOperations.length, 16);
  assert.equal(Object.getOwnPropertyDescriptor(capture, "active")?.value.size, 16);
  for (const settle of finish) { settle(); settle(); }
  const after = capture.snapshot(20, 20, []);
  assert.equal(after.activeOperationCount, 0);
  assert.deepEqual(after.activeOperations, []);
  assert.equal(before.activeOperationCount, 10_000, "published snapshots must not mutate when calls settle");
});

test("run deadline exposes decreasing remaining allowance and rejects exhaustion", async () => {
  const deadline = createBrowserRunDeadline(60);
  assert.ok(deadline.remaining() <= 60);
  await sleep(25);
  assert.ok(deadline.remaining() <= 40);
  await sleep(50);
  assert.throws(deadline.remaining, /Browser operation timed out after 60ms/);
});

function toolThrowing(error: Error) {
  const manager = { async run() { throw error; } } as unknown as BrowserManagerLike;
  const tool = createBrowserTool(manager);
  return () => tool.execute("id", { action: "run", code: "return 1;" } as never, undefined, undefined, { cwd: process.cwd() } as never);
}

test("browser tool returns isError and structured evidence only for enriched run failures", async () => {
  const original = new Error("Browser operation timed out after 1000ms.");
  const capture = new BrowserRunDiagnosticCapture();
  capture.captureText("submitted once");
  const diagnostics = capture.snapshot(1000, 1000, []);
  attachBrowserRunFailureDiagnostics(original, diagnostics);
  assert.equal(browserRunFailureDiagnostics(original), diagnostics);
  const result = await toolThrowing(original)();
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(result.details.diagnostics, diagnostics);
  assert.deepEqual(result.details.error, { name: "Error", message: original.message });
  assert.match(result.content.map((item) => item.type === "text" ? item.text : "").join(""), /submitted once/);
  const ordinary = new Error("ordinary gateway/extension failure");
  await assert.rejects(toolThrowing(ordinary), (error) => error === ordinary);
});

test("gateway retains its existing browser_action_failed and cancelled error envelopes", async () => {
  const root = process.cwd();
  let failure = new Error("enriched managed run failure");
  attachBrowserRunFailureDiagnostics(failure, new BrowserRunDiagnosticCapture().snapshot(10, 20, []));
  const manager = {
    async open(options: { name: string }) {
      return { name: options.name, kind: "headless", connection: { channel: "managed", ownership: "owned", capabilities: { page: true, cdp: true, cookies: true } }, url: "about:blank", title: "test", reused: false };
    },
    async run() { throw failure; },
    async close() { return true; },
  } as unknown as BrowserManagerLike;
  const service = new GatewayBrowserService({ policy: new GatewayPolicy({ workspaceRoot: root }), manager });
  const owner = createGatewayPrincipal("http", "deadline-test", { authenticated: true, scopes: ["gateway.browser"], workspacePath: root });
  try {
    assert.equal((await service.handle(owner, { action: "open", name: "main" })).ok, true);
    const result = await service.handle(owner, { action: "run", name: "main", code: "return 1;" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "browser_action_failed");
    assert.equal(result.error?.message, failure.message);
    failure = new Error("abort"); failure.name = "AbortError";
    const cancelled = await service.handle(owner, { action: "run", name: "main", code: "return 1;" });
    assert.equal(cancelled.error?.code, "cancelled");
    assert.equal(cancelled.status, "cancelled");
  } finally { await service.shutdown(); }
});

test("AbortError keeps its original identity and is never converted to diagnostics or a result", async () => {
  const aborted = new Error("caller cancellation");
  aborted.name = "AbortError";
  attachBrowserRunFailureDiagnostics(aborted, new BrowserRunDiagnosticCapture().snapshot(0, 1000, []));
  assert.equal(browserRunFailureDiagnostics(aborted), undefined);
  await assert.rejects(toolThrowing(aborted), (error) => error === aborted);
});
