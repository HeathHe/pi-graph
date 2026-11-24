import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setQuietMode } from "pi-graph-shared-settings/ui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import registerMaestroExtension from "../src/extension/index.ts";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter(Boolean).join("\n");
afterEach(() => { setQuietMode(false, "check"); initTheme("dark", false); });

function registerTools(child = false): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  let active: string[] = [];
  const api = new Proxy({} as ExtensionAPI, { get(_target, key) {
    if (key === "registerTool") return (tool: ToolDefinition) => { tools.set(tool.name, tool); active.push(tool.name); };
    if (key === "getAllTools") return () => [...tools.values()];
    if (key === "getActiveTools") return () => active;
    if (key === "setActiveTools") return (names: string[]) => { active = names; };
    if (key === "events") return { on: () => () => {}, emit() {} };
    return () => undefined;
  } });
  const saved = process.env.PI_TEAMMATE_CHILD;
  if (child) process.env.PI_TEAMMATE_CHILD = "1"; else delete process.env.PI_TEAMMATE_CHILD;
  try { registerMaestroExtension(api); }
  finally { if (saved === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = saved; }
  return tools;
}

test("native Flow renderer lifecycle preserves running rows and canonical context errors", () => {
  const tools = registerTools();
  const childTools = registerTools(true);
  const cases = [
    { tool: tools.get("maestro"), args: { action: "explore", prompts: ["inspect"] } },
    { tool: tools.get("goal"), args: { action: "get" } },
    { tool: tools.get("open-code-review"), args: { action: "health" } },
    { tool: tools.get("run-control"), args: { argv: ["session", "status"] } },
    { tool: tools.get("lsp"), args: { action: "diagnostics", file: "sample.ts", line: 1 } },
    // Todo already uses native context errors: retain its root + proxy contract.
    { tool: tools.get("todo"), args: { action: "list" } },
    { tool: childTools.get("todo"), args: { action: "list" } },
    { tool: childTools.get("ask-user-question"), args: { questions: [{ question: "Which?" }] }, details: { answers: [] } },
    { tool: tools.get("bash_bg"), args: { action: "status", jobId: "job-1" } },
    // An error must also dominate stale running job telemetry.
    { tool: tools.get("bash_bg"), args: { action: "status", jobId: "job-1" }, details: { running: true } },
    { tool: tools.get("browser"), args: { action: "status", name: "main" } },
    { tool: tools.get("computer_use"), args: { action: "status" } },
    { tool: tools.get("resource"), args: { uri: "agent://publication" } },
    { tool: tools.get("session_history"), args: { action: "timeline", scope: "current_session" } },
    { tool: tools.get("smart_search"), args: { mode: "search", query: "renderer lifecycle" } },
    { tool: tools.get("source_check"), args: { claim: "Native context carries tool errors" } },
    ...["plan-enter", "plan-update", "plan-review", "plan-confirm", "plan-decompose", "plan-exit", "plan-status"]
      .map((name) => ({ tool: tools.get(name), args: {} })),
  ];
  for (const quiet of [false, true]) {
    setQuietMode(quiet, "check"); initTheme("dark", false);
    for (const entry of cases) {
      const tool = entry.tool;
      assert.ok(tool, `tool for ${JSON.stringify(entry.args)} must be registered`);
      const label = tool.name.startsWith("plan-") ? "plan" : tool.name === "ask-user-question" ? "ask" : tool.name;
      const component = new ToolExecutionComponent(tool.name, `call-${tool.name}`, entry.args, {}, tool, { requestRender() {} } as never, process.cwd());
      assert.match(plain(component.render(120)), new RegExp(label));
      component.setArgsComplete(); component.markExecutionStarted();
      component.updateResult({ content: [{ type: "text", text: "PARTIAL BODY" }], details: entry.details ?? {}, isError: false }, true);
      assert.match(plain(component.render(120)), new RegExp(label));
      assert.doesNotMatch(plain(component.render(120)), /PARTIAL BODY/);
      component.updateResult({ content: [{ type: "text", text: "COMPLETE BODY" }], details: entry.details ?? {}, isError: false }, false);
      const complete = plain(component.render(120));
      assert.equal(complete.match(new RegExp(label, "g"))?.length, 1, `${label} must not duplicate the settled call`);
      const runningJob = tool.name === "bash_bg" && entry.details && "running" in entry.details && entry.details.running === true;
      assert.match(complete, runningJob ? /•/ : /✓/, `${label} preserves its non-error lifecycle mark`);
      component.setExpanded(true);
      if (label !== "ask") assert.match(plain(component.render(120)), /COMPLETE BODY/);
      // Pi strips isError out of renderResult's first argument. No error detail
      // is present here, so only the native context can prevent a green success.
      component.updateResult({ content: [{ type: "text", text: "ERROR BODY" }], details: entry.details ?? {}, isError: true }, false);
      const error = plain(component.render(120));
      assert.match(error, /[✕✗]/);
      assert.doesNotMatch(error, /•/, "canonical errors must dominate stale running metadata");
      assert.doesNotMatch(error, /✓/);
      assert.match(error, /ERROR BODY/);
      for (let width = 1; width <= 120; width++) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${label} width ${width}`);
      const before = component.render(120);
      initTheme("light", false); component.invalidate();
      assert.match(plain(component.render(120)), /ERROR BODY/);
      assert.notDeepEqual(component.render(120), before, `${label} updates its theme on host invalidation`);
      initTheme("dark", false);
    }
  }
});
