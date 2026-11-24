import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setQuietMode } from "pi-graph-shared-settings/ui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import registerTeammateExtension from "../src/extension/index.ts";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter(Boolean).join("\n");
afterEach(() => { setQuietMode(false, "check"); initTheme("dark", false); });

function tools(): Map<string, ToolDefinition> {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("pi-graph-teammate.root-registry")];
  const registered = new Map<string, ToolDefinition>();
  const pi = new Proxy({
    events: { on: () => () => {}, emit() {} },
    registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); },
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
  const child = process.env.PI_TEAMMATE_CHILD;
  const legacy = process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS;
  delete process.env.PI_TEAMMATE_CHILD;
  process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS = "1";
  try { registerTeammateExtension(pi as unknown as ExtensionAPI); }
  finally {
    if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
    if (legacy === undefined) delete process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS; else process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS = legacy;
  }
  return registered;
}

function host(tool: ToolDefinition, args: Record<string, unknown>) {
  return new ToolExecutionComponent(tool.name, `call-${tool.name}`, args, {}, tool, { requestRender() {} } as never, process.cwd());
}

const progress = {
  mode: "single" as const, results: [],
  progress: [{ agent: "general", name: "worker", correlationId: "worker-id", taskIndex: 0, dependencies: [], status: "running" as const }],
};
const final = {
  mode: "single" as const,
  results: [{ agent: "general", name: "worker", task: "inspect", exitCode: 0, correlationId: "worker-id", model: "test", durationMs: 1000,
    messages: [{ role: "assistant", content: "FULL FINAL OUTPUT" }],
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 } }],
};

test("native teammate call-only/partial/final handoff never blanks or duplicates the running row", () => {
  const tool = tools().get("teammate")!;
  for (const quiet of [false, true]) {
    setQuietMode(quiet, "check");
    initTheme("dark", false);
    const component = host(tool, { agent: "general", name: "worker", prompt: "SECRET PROMPT", background: false });
    assert.match(plain(component.render(120)), /… teammate @worker/);
    component.setArgsComplete();
    component.markExecutionStarted();
    assert.match(plain(component.render(120)), /… teammate @worker/);
    component.updateResult({ content: [{ type: "text", text: "working" }], details: progress, isError: false }, true);
    const streaming = plain(component.render(120));
    assert.match(streaming, /running/);
    assert.equal(streaming.match(/@worker/g)?.length, 1, "partial result replaces call placeholder in native composition");
    assert.doesNotMatch(streaming, /SECRET PROMPT/);
    component.updateResult({ content: [{ type: "text", text: "done" }], details: final, isError: false }, false);
    const complete = plain(component.render(120));
    assert.doesNotMatch(complete, /… teammate/);
    component.setExpanded(true);
    if (!quiet) assert.match(plain(component.render(120)), /FULL FINAL OUTPUT/);
    for (let width = 1; width <= 120; width++) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `teammate width ${width}`);
    }
    const before = component.render(120);
    initTheme("light", false);
    component.invalidate();
    assert.match(plain(component.render(120)), quiet ? /@worker/ : /FULL FINAL OUTPUT/);
    assert.notDeepEqual(component.render(120), before, "native invalidation picks up the changed theme");
    // A second execution must not inherit the first execution's result marker.
    assert.match(plain(host(tool, { agent: "general", name: "fresh" }).render(120)), /… teammate @fresh/);
  }
});

test("native teammate errors arrive through context, not result.isError", () => {
  const tool = tools().get("teammate")!;
  for (const quiet of [false, true]) {
    setQuietMode(quiet, "check"); initTheme("dark", false);
    for (const args of [{ agent: "general" }, { mode: "expert", tasks: [{ prompt: "inspect" }] }]) {
      const component = host(tool, args);
      component.updateResult({ content: [{ type: "text", text: "Dispatch rejected" }], details: { mode: "single", results: [] }, isError: true }, false);
      const text = plain(component.render(120));
      assert.match(text, /[✗✕].*Dispatch rejected|[✗✕].*Leader completed with issues/);
      assert.doesNotMatch(text, /✓/);
      if (args.mode) assert.equal(text.match(/EXPERT/g)?.length, 1);
      component.setExpanded(true);
      assert.match(plain(component.render(120)), /Dispatch rejected/);
    }
  }
});

test("native auxiliary tools retain running state and settle to a single error-aware surface", () => {
  const registered = tools();
  const cases = [
    { name: "teammate-list", args: { view: "active" }, details: { agents: [] } },
    { name: "teammate-send", args: { to: "worker", mode: "follow_up" }, details: { delivered: true } },
    { name: "observe", args: { action: "wait", targets: [{ kind: "teammate", id: "worker" }] }, details: { result: { action: "wait", observations: [] } } },
    { name: "teammate-watch", args: { name: "worker" }, details: { output: [] } },
    { name: "teammate-wait", args: { name: "worker" }, details: { status: "completed", output: [] } },
    { name: "teammate-monitor", args: { action: "status", targets: ["worker"] }, details: { output: [] } },
  ];
  for (const quiet of [false, true]) {
    setQuietMode(quiet, "check"); initTheme("dark", false);
    for (const entry of cases) {
      const component = host(registered.get(entry.name)!, entry.args);
      assert.match(plain(component.render(120)), new RegExp(entry.name));
      component.markExecutionStarted();
      component.updateResult({ content: [{ type: "text", text: "PARTIAL BODY" }], details: entry.details, isError: false }, true);
      assert.match(plain(component.render(120)), new RegExp(entry.name));
      assert.doesNotMatch(plain(component.render(120)), /PARTIAL BODY/);
      component.updateResult({ content: [{ type: "text", text: "COMPLETE BODY" }], details: entry.details, isError: false }, false);
      if (quiet) assert.equal(plain(component.render(120)).match(new RegExp(entry.name, "g"))?.length, 1);
      component.setExpanded(true);
      const summaryOnly = ["teammate-watch", "teammate-wait", "teammate-monitor"].includes(entry.name);
      if (!quiet || !summaryOnly) assert.match(plain(component.render(120)), /COMPLETE BODY/);
      component.updateResult({ content: [{ type: "text", text: "ERROR BODY" }], details: entry.details, isError: true }, false);
      const text = plain(component.render(120));
      if (quiet) { assert.match(text, /✕/); assert.doesNotMatch(text, /✓/); }
      else assert.match(text, /ERROR BODY/);
      for (let width = 1; width <= 120; width++) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${entry.name} width ${width}`);
      const before = component.render(120);
      initTheme("light", false); component.invalidate();
      assert.ok(component.render(120).length > 0);
      if (quiet || entry.name !== "teammate-list") assert.notDeepEqual(component.render(120), before);
      initTheme("dark", false);
    }
  }
});
