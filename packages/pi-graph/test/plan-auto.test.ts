import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PLAN_AUTO_KEY, PLAN_AUTO_AUDIT_ENTRY, AUTO_AUDIT_ENTRY, beginPlanAutoCycle, getPlanAutoSnapshot,
  getAskAutoSnapshot, isCurrentAskAutoGrant,
  getPlanAutoState, isCurrentPlanAutoGrant, isCurrentPlanAutoTask, markPlanAutoConfirmed,
  planAutoStatusLabel, registerPlanAuto, resetPlanAuto, revokePlanAuto, updatePlanAutoTaskContext,
} from "../src/tools/plan-auto.ts";
import {
  clearPlan, getMode, initPlan, onAgentEndPlan, onCompactPlan, onSessionStartPlan,
  onSessionShutdownPlan, registerPlanTools, registerPlanCommand, toggleMode, exitModeAndRestore,
  setPlanModeChangeListener,
} from "../src/tools/plan.ts";
import { PlanStore, type PlanStoreOptions } from "../src/tools/plan-store.ts";
import { registerPlanTransport } from "../src/plan-transport.ts";
import { createNewContextController } from "../src/compaction/new-context.ts";
import { CompactionArbiter, compactionRequestFromInstructions } from "../src/compaction/compaction-arbiter.ts";

// Test processes dispatched by a teammate inherit its child marker; simulate the
// interactive parent explicitly, then restore the inherited environment.
const inheritedChild = process.env.PI_TEAMMATE_CHILD;
test.before(() => { delete process.env.PI_TEAMMATE_CHILD; });
test.after(() => { if (inheritedChild !== undefined) process.env.PI_TEAMMATE_CHILD = inheritedChild; });

function harness() {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const events = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const entries: Array<{ customType: string; data: any }> = [];
  const notices: string[] = [];
  let terminal: ((data: string) => any) | undefined;
  let editor = "";
  let plan = true;
  const statuses = new Map<string, string | undefined>();
  const tools = new Map<string, any>();
  const ctx = {
    mode: "tui", hasUI: true, cwd: "D:/scope", isIdle: () => true,
    sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getSessionName: () => "parent", getBranch: () => entries },
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      getEditorText: () => editor,
      setEditorText: (text: string) => { editor = text; },
      onTerminalInput: (handler: (data: string) => any) => { terminal = handler; return () => { terminal = undefined; }; },
    },
  } as unknown as ExtensionContext;
  const api = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: (name: string, shortcut: any) => shortcuts.set(name, shortcut),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => [], setActiveTools() {}, sendUserMessage() {},
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    on: (name: string, handler: any) => { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); },
  } as unknown as ExtensionAPI;
  registerPlanAuto(api, { isPlanMode: () => plan, onStateChange: () => statuses.set("auto", planAutoStatusLabel(ctx)) });
  const emit = async (name: string, event = {}, context = ctx) => {
    for (const handler of events.get(name) ?? []) await handler(event, context);
  };
  const start = async (inPlan = true) => {
    plan = inPlan;
    await emit("session_start", { reason: "startup" });
    if (inPlan) beginPlanAutoCycle(ctx, { markdown: "# Scoped implementation", revision: 1 });
  };
  const submit = (args = "on") => { editor = `/plan-auto${args ? ` ${args}` : ""}`; return terminal?.("\r"); };
  const submitAuto = (args = "") => { editor = `/auto${args ? ` ${args}` : ""}`; return terminal?.("\r"); };
  return { api, ctx, commands, shortcuts, entries, notices, statuses, tools, emit, start, submit, submitAuto,
    setPlan: (value: boolean) => { plan = value; },
    terminal: (data: string) => terminal?.(data),
    setEditor: (text: string) => { editor = text; },
  };
}

test("/auto defaults to status and manages both independently audited preferences", async () => {
  const h = harness(); await h.start(false);
  assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  assert.equal(h.statuses.get("maestro-ask-auto"), undefined);
  for (const args of ["", "status", "plan", "plan status", "ask", "ask status"]) {
    assert.deepEqual(h.submitAuto(args), { consume: true });
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
    assert.equal(getAskAutoSnapshot(h.ctx), undefined);
    assert.match(h.notices.at(-1)!, /Plan:.*off.*Ask:.*off/);
  }
  assert.equal(h.entries.length, 0);
  assert.deepEqual(h.commands.get("auto").getArgumentCompletions("ask o").map((v: any) => v.value), ["ask on", "ask off"]);
  h.submitAuto("on");
  const plan = getPlanAutoSnapshot(h.ctx)!;
  const ask = getAskAutoSnapshot(h.ctx)!;
  assert.equal(plan.confirmPending, false, "unified on is usable in Act");
  assert.deepEqual(ask, { sessionId: "parent", cwd: "D:/scope", generation: ask.generation, timeoutMs: 60_000 });
  assert.ok(Object.isFrozen(ask));
  assert.ok(isCurrentAskAutoGrant(ask, h.ctx));
  assert.match(h.statuses.get("maestro-ask-auto")!, /ASK-AUTO on 60s/);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].customType, AUTO_AUDIT_ENTRY);
  assert.equal(h.entries[0].data.target, "all");
  assert.equal(h.entries[0].data.origin, "terminal");
  assert.equal(h.entries[0].data.replayable, false);
  h.submitAuto("on"); h.submitAuto();
  assert.equal(getAskAutoSnapshot(h.ctx), ask);
  assert.equal(getPlanAutoSnapshot(h.ctx), plan);
  assert.equal(h.entries.length, 1, "status and idempotent on do not create authority");
  assert.match(h.notices.at(-1)!, /Plan:.*on.*Ask:.*on 60s/);
  h.submitAuto("off");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  assert.equal(isCurrentAskAutoGrant(ask, h.ctx), false);
  assert.equal(h.statuses.get("maestro-ask-auto"), undefined);
  assert.equal(h.entries.at(-1)!.data.action, "off");
});

test("independent Ask timeout updates fence old snapshots; old Plan controls never disable Ask", async () => {
  const h = harness(); await h.start();
  h.submitAuto("ask on 2.5");
  const first = getAskAutoSnapshot(h.ctx)!;
  assert.equal(first.timeoutMs, 2500);
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  h.submitAuto("plan on");
  const plan = getPlanAutoSnapshot(h.ctx)!;
  h.submitAuto("ask on 2.5");
  assert.equal(getAskAutoSnapshot(h.ctx), first);
  h.submitAuto("ask on 3");
  const next = getAskAutoSnapshot(h.ctx)!;
  assert.ok(next.generation > first.generation);
  assert.equal(isCurrentAskAutoGrant(first, h.ctx), false);
  assert.ok(isCurrentAskAutoGrant(next, h.ctx));
  assert.equal(getPlanAutoSnapshot(h.ctx), plan, "Ask updates cannot perturb Plan authority");
  h.submitAuto("ask off");
  assert.equal(getPlanAutoSnapshot(h.ctx), plan);
  h.submitAuto("ask on");
  const defaultAsk = getAskAutoSnapshot(h.ctx)!;
  assert.equal(defaultAsk.timeoutMs, 60_000);
  h.submit("off");
  assert.equal(getAskAutoSnapshot(h.ctx), defaultAsk);
  await h.shortcuts.get(PLAN_AUTO_KEY).handler(h.ctx);
  await h.shortcuts.get(PLAN_AUTO_KEY).handler(h.ctx);
  assert.equal(getAskAutoSnapshot(h.ctx), defaultAsk);
  h.submitAuto("plan on"); h.submitAuto("plan off");
  assert.equal(getAskAutoSnapshot(h.ctx), defaultAsk);
  revokePlanAuto("external-plan-off");
  assert.equal(getAskAutoSnapshot(h.ctx), defaultAsk);
  resetPlanAuto("reload");
  assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  assert.equal(h.statuses.get("maestro-ask-auto"), undefined);
});

test("/auto invalid grammar and timer values are atomic, including mismatched scopes", async () => {
  const h = harness(); await h.start(); h.submitAuto("on");
  const plan = getPlanAutoSnapshot(h.ctx)!;
  const ask = getAskAutoSnapshot(h.ctx)!;
  const audits = h.entries.length;
  for (const args of ["invalid", "plan toggle", "ask toggle", "on 10", "off 10", "status 10", "plan on 10",
    "ask off 10", "ask status 10", "ask 10", "ask on 1 extra", "ask on 0", "ask on -1", "ask on NaN",
    "ask on Infinity", "ask on 1e309", "ask on 2147483.648", "ask on 0.0001", "ask on 0x10", "ask on 1s"]) {
    h.submitAuto(args);
    assert.equal(getPlanAutoSnapshot(h.ctx), plan, args);
    assert.equal(getAskAutoSnapshot(h.ctx), ask, args);
    assert.equal(h.entries.length, audits, args);
  }
  await h.commands.get("auto").handler("ask on invalid", { ...h.ctx, cwd: "invalid-scope" });
  assert.equal(getPlanAutoSnapshot(h.ctx), plan, "invalid command does not even revoke by observing scope");
  assert.equal(getAskAutoSnapshot(h.ctx), ask);
  for (const [seconds, timeout] of [["0.001", 1], ["2147483.647", 2147483647], ["1e-2", 10]] as const) {
    h.submitAuto(`ask on ${seconds}`);
    assert.equal(getAskAutoSnapshot(h.ctx)!.timeoutMs, timeout);
  }
});

test("/auto direct commands, all source hooks, RPC, child and dialogs cannot enable", async () => {
  const h = harness(); await h.start();
  for (const args of ["on", "plan on", "ask on", "ask on 1"]) {
    await h.commands.get("auto").handler(args, h.ctx);
    for (const source of ["extension", "rpc", "interactive", undefined]) {
      await h.emit("input", { text: `/auto ${args}`, source });
      assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
      assert.equal(getAskAutoSnapshot(h.ctx), undefined);
    }
  }
  h.setEditor("/auto on");
  assert.equal(h.terminal("/auto on\r"), undefined, "pasted command is not a physical Enter");
  await h.emit("ui_prompt_start"); h.submitAuto("on");
  assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  await h.emit("ui_prompt_end");
  const prior = process.env.PI_TEAMMATE_CHILD;
  try {
    process.env.PI_TEAMMATE_CHILD = "1";
    h.submitAuto("on"); h.submitAuto("ask on");
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
    assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  } finally {
    if (prior === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = prior;
  }
  h.ctx.mode = "rpc"; h.submitAuto("on");
  assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  h.ctx.mode = "tui"; h.ctx.hasUI = false; h.submitAuto("on");
  assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  h.ctx.hasUI = true; h.submitAuto("on");
  const ask = getAskAutoSnapshot(h.ctx)!;
  await h.commands.get("auto").handler("ask on 1", h.ctx);
  assert.equal(getAskAutoSnapshot(h.ctx), ask, "machine cannot update an already-enabled timeout");
  await h.emit("input", { text: "/auto status", source: "rpc" });
  assert.equal(getAskAutoSnapshot(h.ctx), ask);
  await h.emit("input", { text: "/auto off", source: "extension" });
  assert.equal(getAskAutoSnapshot(h.ctx), undefined, "unattested input may revoke");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
});

test("/auto real Pi command-before-input host paths never create authority", async () => {
  const h = harness(); await h.start();
  const host: any = {
    _extensionRunner: { getCommand: (name: string) => h.commands.get(name), createCommandContext: () => h.ctx,
      emitError: (error: any) => { throw new Error(error.error); } },
    _tryExecuteExtensionCommand: (AgentSession.prototype as any)._tryExecuteExtensionCommand,
    prompt: AgentSession.prototype.prompt,
    _runInputHandlers: async (text: string, images: any, source: string) => {
      await h.emit("input", { text, images, source }); return undefined;
    },
  };
  for (const command of ["/auto on", "/auto ask on 1", "/auto plan on"]) {
    await AgentSession.prototype.sendUserMessage.call(host, command);
    await AgentSession.prototype.sendUserMessage.call(host, command, { expandPromptTemplates: true });
    await AgentSession.prototype.prompt.call(host, command, { source: "rpc" });
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
    assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  }
  h.submitAuto("on");
  await AgentSession.prototype.sendUserMessage.call(host, "/auto off");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  assert.equal(getAskAutoSnapshot(h.ctx), undefined);
});

test("Ask lifecycle and scope fences revoke permanently without replaying audit entries", async () => {
  const h = harness(); await h.start(); h.submitAuto("ask on");
  const first = getAskAutoSnapshot(h.ctx)!;
  const invalidated = { get sessionManager(): never { throw new Error("stale context"); } } as ExtensionContext;
  assert.equal(isCurrentAskAutoGrant(first, invalidated), false);
  assert.equal(getAskAutoSnapshot(h.ctx), first, "stale getter cannot revoke a newer session");
  h.submitAuto("ask off"); h.submitAuto("ask on");
  const second = getAskAutoSnapshot(h.ctx)!;
  assert.equal(isCurrentAskAutoGrant(first, { ...h.ctx, cwd: "old-scope" }), false);
  assert.equal(getAskAutoSnapshot(h.ctx), second, "stale generation does not inspect another scope");
  assert.equal(getPlanAutoSnapshot({ ...h.ctx, cwd: "changed-cwd" }), undefined);
  assert.equal(getAskAutoSnapshot(h.ctx), undefined, "Plan reader observes scope even when only Ask is on");
  h.submitAuto("on");
  assert.equal(getAskAutoSnapshot({ ...h.ctx, sessionManager: { getSessionId: () => "other" } } as ExtensionContext), undefined);
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined, "Ask reader revokes both on actual scope change");
  h.submitAuto("on");
  updatePlanAutoTaskContext({ ...h.ctx, cwd: "different-task-scope" }, { markdown: "foreign", revision: 1 });
  assert.equal(getAskAutoSnapshot(h.ctx), undefined, "task update detecting actual scope change revokes both");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
    await h.start(); h.submitAuto("on");
    const before = getAskAutoSnapshot(h.ctx)!;
    await h.emit(event);
    assert.equal(getAskAutoSnapshot(h.ctx), undefined, event);
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined, event);
    assert.equal(isCurrentAskAutoGrant(before, h.ctx), false, event);
    assert.equal(h.statuses.get("maestro-ask-auto"), undefined, event);
  }
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    await h.start(); h.submitAuto("ask on");
    await h.emit("session_start", { reason });
    assert.equal(getAskAutoSnapshot(h.ctx), undefined, reason);
  }
  h.submitAuto("ask on");
  registerPlanAuto(h.api, { isPlanMode: () => true, onStateChange() {} });
  assert.equal(getAskAutoSnapshot(h.ctx), undefined, "register/reload never replays earlier on audits");
});

test("/auto enable is audit-required, atomic on failure, and fenced against synchronous revocation", async () => {
  const h = harness(); await h.start();
  const append = h.api.appendEntry;
  h.api.appendEntry = () => { throw new Error("audit unavailable"); };
  for (const args of ["on", "ask on", "plan on"]) {
    h.submitAuto(args);
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
    assert.equal(getAskAutoSnapshot(h.ctx), undefined);
    assert.match(h.notices.at(-1)!, /审计写入失败/);
  }
  h.api.appendEntry = append; h.submitAuto("ask on 5");
  const existing = getAskAutoSnapshot(h.ctx)!;
  h.api.appendEntry = () => { throw new Error("audit unavailable"); };
  h.submitAuto("on");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined, "no partial Plan enable");
  assert.equal(getAskAutoSnapshot(h.ctx), existing, "failed update leaves the prior audited grant intact");
  h.submitAuto("off");
  assert.equal(getAskAutoSnapshot(h.ctx), undefined, "audit failure cannot prevent revocation");
  h.api.appendEntry = (type, data) => { append(type, data); resetPlanAuto("revoked-in-audit"); };
  h.submitAuto("on");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  assert.match(h.notices.at(-1)!, /授权已变更/);
  await h.emit("session_shutdown");
  h.api.appendEntry = append;
});

test("default off, physical command, completions, idempotence and shortcut share one grant", async () => {
  const h = harness();
  await h.start();
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  assert.match(h.statuses.get("auto")!, /off/);
  assert.deepEqual(h.commands.get("plan-auto").getArgumentCompletions("o").map((v: any) => v.value), ["on", "off"]);
  h.submit("invalid");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  assert.deepEqual(h.submit(), { consume: true });
  const snapshot = getPlanAutoSnapshot(h.ctx)!;
  assert.ok(snapshot.confirmPending);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.taskContext));
  assert.equal(snapshot.taskContext.markdown, "# Scoped implementation");
  assert.match(h.notices.at(-1)!, /standalone\/current/);
  assert.match(h.notices.at(-1)!, /classifier.*LLM fallback/);
  assert.match(h.notices.at(-1)!, /敏感.*人工/);
  h.submit("on");
  assert.equal(getPlanAutoSnapshot(h.ctx)!.generation, snapshot.generation);
  h.submit("status");
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].customType, PLAN_AUTO_AUDIT_ENTRY);
  assert.equal(h.entries[0].data.replayable, false);
  h.submit("");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  const offGeneration = getPlanAutoState(h.ctx).generation;
  h.submit("off");
  assert.equal(getPlanAutoState(h.ctx).generation, offGeneration);
  await h.shortcuts.get(PLAN_AUTO_KEY).handler(h.ctx);
  assert.ok(getPlanAutoSnapshot(h.ctx));
  assert.ok(getPlanAutoSnapshot(h.ctx)!.generation > snapshot.generation);
  await h.shortcuts.get(PLAN_AUTO_KEY).handler(h.ctx);
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
});

test("Act can enable before any Plan cycle, re-enable and rebind each subsequent cycle", async () => {
  const h = harness(); await h.start(false);
  h.submit();
  const waiting = getPlanAutoSnapshot(h.ctx)!;
  assert.equal(waiting.confirmPending, false);
  assert.deepEqual(waiting.taskContext, { markdown: "", revision: 0 });
  assert.match(planAutoStatusLabel(h.ctx), /AUTO on/);
  h.setPlan(true);
  beginPlanAutoCycle(h.ctx, { markdown: "# Scoped task", revision: 1 });
  const snapshot = getPlanAutoSnapshot(h.ctx)!;
  assert.equal(snapshot.confirmPending, true);
  assert.equal(isCurrentPlanAutoGrant(waiting, h.ctx), false);
  assert.equal(markPlanAutoConfirmed(h.ctx, snapshot, { markdown: "# Approved task", revision: 2, handoffKey: "approved-key" }), true);
  h.setPlan(false);
  assert.equal(getPlanAutoSnapshot(h.ctx)!.confirmPending, false);
  assert.equal(isCurrentPlanAutoGrant(snapshot, h.ctx), true);
  assert.equal(isCurrentPlanAutoTask(snapshot, h.ctx), false);
  assert.equal(markPlanAutoConfirmed(h.ctx, snapshot, { markdown: "other", revision: 3 }), false);
  h.submit("status");
  assert.match(h.notices.at(-1)!, /AUTO ask/);
  h.setPlan(true);
  beginPlanAutoCycle(h.ctx, { markdown: "# Next task", revision: 3 });
  const next = getPlanAutoSnapshot(h.ctx)!;
  assert.equal(next.confirmPending, true);
  assert.equal(next.taskContext.handoffKey, undefined);
  assert.equal(isCurrentPlanAutoGrant(snapshot, h.ctx), false);
  h.setPlan(false); h.submit("off"); h.submit();
  assert.equal(getPlanAutoSnapshot(h.ctx)!.confirmPending, false);
  assert.ok(getPlanAutoSnapshot(h.ctx)!.generation > snapshot.generation);
  h.submit("off");
  await h.shortcuts.get(PLAN_AUTO_KEY).handler(h.ctx);
  assert.ok(getPlanAutoSnapshot(h.ctx), "shortcut also enables in Act");
});

test("scope/lifecycle revocation and task-context freshness are irreversible", async () => {
  const h = harness(); await h.start(); h.submit();
  const initial = getPlanAutoSnapshot(h.ctx)!;
  updatePlanAutoTaskContext(h.ctx, { markdown: "# Revised", revision: 2 });
  assert.ok(isCurrentPlanAutoGrant(initial, h.ctx));
  assert.equal(isCurrentPlanAutoTask(initial, h.ctx), false);
  beginPlanAutoCycle(h.ctx, { markdown: "new", revision: 3 });
  assert.equal(getPlanAutoSnapshot(h.ctx)!.confirmPending, true);
  assert.equal(isCurrentPlanAutoGrant(initial, h.ctx), false);
  h.submit();
  const newer = getPlanAutoSnapshot(h.ctx)!;
  assert.equal(isCurrentPlanAutoGrant(initial, { ...h.ctx, cwd: "stale-scope" }), false);
  assert.equal(getPlanAutoSnapshot(h.ctx), newer, "stale generation cannot revoke newer authority");
  const invalidated = { get sessionManager(): never { throw new Error("Pi ctx is stale"); } } as ExtensionContext;
  assert.equal(isCurrentPlanAutoGrant(newer, invalidated), false);
  assert.equal(getPlanAutoSnapshot(h.ctx), newer);
  const otherCwd = { ...h.ctx, cwd: "D:/elsewhere" };
  assert.equal(getPlanAutoSnapshot(otherCwd), undefined);
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  h.submit();
  const otherSession = { ...h.ctx, sessionManager: { getSessionId: () => "fork" } } as ExtensionContext;
  assert.equal(getPlanAutoSnapshot(otherSession), undefined);
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
    await h.start(); h.submit(); const old = getPlanAutoSnapshot(h.ctx)!;
    await h.emit(event);
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined, event);
    assert.equal(isCurrentPlanAutoGrant(old, h.ctx), false, event);
  }
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    await h.start(); h.submit();
    await h.emit("session_start", { reason });
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined, reason);
  }
  assert.ok(h.entries.some((e) => e.data.action === "on"));
  resetPlanAuto("restart");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined, "audit cannot restore authority");
});

test("UI presence, direct commands, injected input, RPC and child cannot grant", async () => {
  const h = harness(); await h.start();
  await h.commands.get("plan-auto").handler("on", h.ctx);
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined, "unattested command with UI");
  for (const source of ["extension", "rpc", "interactive", undefined]) {
    await h.emit("input", { text: "/plan-auto on", source });
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined, `input origin ${source}`);
  }
  const rpc = { ...h.ctx, mode: "rpc", hasUI: true } as ExtensionContext;
  await h.shortcuts.get(PLAN_AUTO_KEY).handler(rpc);
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  const prior = process.env.PI_TEAMMATE_CHILD;
  try {
    process.env.PI_TEAMMATE_CHILD = "1";
    h.submit(); await h.shortcuts.get(PLAN_AUTO_KEY).handler(h.ctx);
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  } finally {
    if (prior === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = prior;
  }
  h.setEditor("/plan-auto on");
  assert.equal(h.terminal("/plan-auto on\r"), undefined, "paste is not a physical Enter event");
  await h.emit("ui_prompt_start");
  h.submit(); await h.shortcuts.get(PLAN_AUTO_KEY).handler(h.ctx);
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined, "dialog Enter is not a command submission");
  await h.emit("ui_prompt_end");
  h.submit(); assert.ok(getPlanAutoSnapshot(h.ctx));
  revokePlanAuto("test");
});

test("failed host audit cannot leave a silent enabled grant", async () => {
  const h = harness(); await h.start();
  h.api.appendEntry = () => { throw new Error("audit unavailable"); };
  h.submit();
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  assert.match(h.notices.at(-1)!, /审计写入失败/);
});

test("real Pi host prompt/sendUserMessage command-before-input contract fails closed", async () => {
  const h = harness(); await h.start();
  const runner = {
    getCommand: (name: string) => h.commands.get(name), createCommandContext: () => h.ctx,
    emitError: (error: any) => { throw new Error(error.error); },
  };
  const host: any = {
    _extensionRunner: runner,
    _tryExecuteExtensionCommand: (AgentSession.prototype as any)._tryExecuteExtensionCommand,
    prompt: AgentSession.prototype.prompt,
    _runInputHandlers: async (text: string, images: any, source: string) => {
      await h.emit("input", { text, images, source });
      return undefined;
    },
  };
  // Actual host implementation is executed, not a string-based imitation.
  await AgentSession.prototype.sendUserMessage.call(host, "/plan-auto on");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  await AgentSession.prototype.sendUserMessage.call(host, "/plan-auto on", { expandPromptTemplates: true });
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined, "even extension command expansion has UI and is denied");
  await AgentSession.prototype.prompt.call(host, "/plan-auto on", { source: "rpc" });
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  h.submit(); assert.ok(getPlanAutoSnapshot(h.ctx));
  await AgentSession.prototype.sendUserMessage.call(host, "/plan-auto status");
  assert.ok(getPlanAutoSnapshot(h.ctx));
  await AgentSession.prototype.sendUserMessage.call(host, "/plan-auto off");
  assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
});

test("same-session deterministic new_context preserves the in-memory grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-auto-reset-"));
  const h = harness();
  Object.defineProperty(h.ctx, "cwd", { value: root });
  try {
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compaction: { newContext: { enabled: true } } }));
    await h.start(); h.submitAuto("on"); const grant = getPlanAutoSnapshot(h.ctx)!;
    const ask = getAskAutoSnapshot(h.ctx)!;
    const arbiter = new CompactionArbiter();
    const controller = createNewContextController(arbiter);
    let compact: any;
    const resetCtx = { ...h.ctx, hasPendingMessages: () => false, compact: (options: any) => { compact = options; } };
    controller.onSessionStart(resetCtx);
    controller.schedule({ source: "tool", actorId: "root" }, resetCtx);
    assert.equal(await controller.onAgentSettled(resetCtx), true);
    const observed = arbiter.observeStart(compactionRequestFromInstructions(compact.customInstructions));
    assert.equal(observed.trigger?.owner, "new-context");
    if (observed.trigger?.owner !== "new-context") assert.fail("missing reset trigger");
    assert.ok(controller.consume(observed.trigger, resetCtx));
    compact.onComplete();
    assert.ok(isCurrentPlanAutoGrant(grant, h.ctx));
    assert.ok(isCurrentAskAutoGrant(ask, h.ctx), "same-session new_context preserves independent Ask grant");
    controller.onSessionShutdown();
  } finally { await h.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); }
});

test("real Plan edits/compaction/exit/clear/reentry preserve enabled state; start/shutdown revoke", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-auto-"));
  const h = harness();
  Object.defineProperty(h.ctx, "cwd", { value: root, configurable: true });
  initPlan(h.api, { storeFactory: (cwd, session) => new PlanStore(cwd, { session, getProcessIdentity: (pid) => `test:${pid}` }) });
  registerPlanTools(h.api);
  try {
    await h.emit("session_start"); await onSessionStartPlan(h.ctx);
    assert.equal(getMode(), "act");
    await toggleMode(h.ctx); assert.equal(getMode(), "plan");
    h.submit(); h.submitAuto("ask on 5");
    const ask = getAskAutoSnapshot(h.ctx)!;
    const initial = getPlanAutoSnapshot(h.ctx)!;
    const updated = await h.tools.get("plan-update").execute("u", { markdown: "# New task", expectedRevision: 0 }, undefined, undefined, h.ctx);
    assert.equal(updated.isError, undefined);
    assert.ok(isCurrentPlanAutoGrant(initial, h.ctx));
    assert.equal(getPlanAutoSnapshot(h.ctx)!.taskContext.markdown, "# New task");
    onCompactPlan(h.ctx);
    await onAgentEndPlan({ messages: [] }, h.ctx);
    assert.ok(isCurrentPlanAutoGrant(initial, h.ctx));
    await exitModeAndRestore(h.ctx);
    const exited = getPlanAutoSnapshot(h.ctx)!;
    assert.equal(exited.confirmPending, false);
    assert.deepEqual(exited.taskContext, { markdown: "", revision: 0 });
    assert.equal(isCurrentPlanAutoGrant(initial, h.ctx), false);
    await toggleMode(h.ctx);
    const reentered = getPlanAutoSnapshot(h.ctx)!;
    assert.equal(reentered.confirmPending, true);
    assert.equal(reentered.taskContext.markdown, "# New task");
    clearPlan();
    assert.ok(getPlanAutoSnapshot(h.ctx));
    assert.equal(isCurrentPlanAutoGrant(reentered, h.ctx), false);
    assert.deepEqual(getPlanAutoSnapshot(h.ctx)!.taskContext, { markdown: "", revision: 0 });
    const beforeEmpty = getPlanAutoSnapshot(h.ctx)!;
    const emptied = await h.tools.get("plan-update").execute("empty", { markdown: "", expectedRevision: updated.details.revision }, undefined, undefined, h.ctx);
    assert.equal(emptied.isError, undefined);
    assert.equal(getPlanAutoSnapshot(h.ctx)!.confirmPending, true);
    assert.equal(isCurrentPlanAutoGrant(beforeEmpty, h.ctx), false);
    assert.equal(getPlanAutoSnapshot(h.ctx)!.taskContext.markdown, "");
    assert.equal(getAskAutoSnapshot(h.ctx), ask, "Plan edit/compaction/exit/clear/reentry leave independent Ask unchanged");
    await onSessionStartPlan(h.ctx); assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
    assert.equal(getAskAutoSnapshot(h.ctx), undefined);
    await toggleMode(h.ctx); h.submitAuto("on");
    onSessionShutdownPlan(h.ctx); assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
    assert.equal(getAskAutoSnapshot(h.ctx), undefined);
  } finally { onSessionShutdownPlan(h.ctx); await h.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); }
});

function pause() {
  let release!: () => void;
  let arrived!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { arrived = resolve; });
  return { release, reached, async hook() { arrived(); await waiting; } };
}

async function approvalHarness(options: {
  store?: Partial<PlanStoreOptions>;
  restore?: () => Promise<boolean>;
  seed?: (store: PlanStore) => Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-auto-approval-"));
  const h = harness();
  h.ctx.cwd = join(root, "workspace");
  const stores: PlanStore[] = [];
  const messages: string[] = [];
  let overlays = 0;
  const storeOptions = (id: string): PlanStoreOptions => ({ rootDir: join(root, "store"),
    session: { id }, getProcessIdentity: (pid) => `test-process:${pid}`, ...options.store });
  if (options.seed) await options.seed(new PlanStore(h.ctx.cwd, storeOptions("parent")));
  (h.ctx.ui as any).custom = async () => { overlays++; return { action: "close" }; };
  h.api.sendUserMessage = (message: any) => { messages.push(message); };
  initPlan(h.api, { storeFactory: (cwd, session) => {
    const store = new PlanStore(cwd, storeOptions(session.id)); stores.push(store); return store;
  }, ...(options.restore ? { restoreActModel: options.restore } : {}) });
  registerPlanTools(h.api);
  registerPlanCommand(h.api);
  await h.emit("session_start");
  await onSessionStartPlan(h.ctx);
  const run = (name: string, params: any = {}, signal?: AbortSignal) =>
    h.tools.get(name).execute("auto-test", params, signal, undefined, h.ctx);
  await run("plan-enter");
  return { ...h, root, stores, messages, run, overlays: () => overlays,
    async close() {
      setPlanModeChangeListener(undefined);
      onSessionShutdownPlan(h.ctx);
      await h.emit("session_shutdown");
      await rm(root, { recursive: true, force: true });
    } };
}

const resultText = (result: any) => result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

test("human preauthorization confirms exact archive/manifest before Act; update/review and command never auto-approve", async () => {
  let inspectCommit!: () => Promise<void>;
  const h = await approvalHarness({ restore: async () => { await inspectCommit(); return true; } });
  let remoteOpens = 0;
  const dispose = registerPlanTransport({ open() { remoteOpens++; return undefined; } });
  try {
    h.submit();
    const draft = "# Exact draft\n\nBuild the bounded feature.\n";
    await h.run("plan-update", { markdown: draft });
    assert.equal(getMode(), "plan");
    assert.equal(h.stores[0] && (await h.stores[0].load()).manifest.status, "draft");
    await h.run("plan-review");
    assert.equal(h.overlays(), 1, "review remains an interactive editor");
    assert.equal((await h.stores[0].load()).manifest.status, "draft");
    h.ctx.hasUI = false;
    await h.commands.get("plan").handler("approve", h.ctx);
    assert.equal((await h.stores[0].load()).manifest.status, "draft", "only plan-confirm uses auto");
    const before = getPlanAutoSnapshot(h.ctx)!;
    const status = await h.run("plan-status");
    assert.deepEqual(status.details.planAuto, { enabled: true, generation: before.generation, confirmPending: true });
    inspectCommit = async () => {
      const committed = await h.stores[0].load();
      assert.equal(committed.manifest.status, "approved");
      assert.equal(getMode(), "plan", "manifest/archive commit precedes restoring Act");
      assert.equal(await readFile(join(committed.plansDir, committed.manifest.approvedPath!), "utf8"), draft);
      assert.equal(committed.manifest.approvedChecksum, createHash("sha256").update(draft).digest("hex"));
      assert.equal(getPlanAutoSnapshot(h.ctx)?.confirmPending, false);
      assert.equal(h.messages.length, 0);
    };
    const remoteBefore = remoteOpens;
    const approved = await h.run("plan-confirm");
    assert.equal(remoteOpens, remoteBefore, "auto never opens a remote confirm transport");
    assert.equal(h.overlays(), 1, "auto never opens the local confirm UI");
    assert.equal(approved.details.approved, true);
    assert.equal(getMode(), "act");
    assert.deepEqual(approved.details.execution, { backend: "standalone", context: "current" });
    assert.equal(approved.details.approvalAudit.source, "human-preauthorization");
    assert.equal(approved.details.approvalAudit.generation, before.generation);
    assert.equal(approved.details.approvalAudit.result, "handed-off");
    assert.match(resultText(approved), /preauthorized.*no per-confirm click/);
    assert.doesNotMatch(resultText(approved), /user selected Execute/);
    assert.match(resultText(approved), new RegExp(approved.details.handoffKey));
    assert.equal(h.entries.at(-1)!.data.result, "handed-off");
    assert.equal(h.entries.at(-1)!.data.replayable, false);
    assert.equal((await h.run("plan-confirm")).isError, true, "repeated confirm cannot deliver again in Act");
    assert.equal((await h.stores[0].load()).manifest.approvals.length, 1);
    h.submit("off");
    assert.equal(getMode(), "act", "off does not terminate execution already authorized via result");
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
    assert.equal((await h.stores[0].load()).manifest.status, "approved");
  } finally { dispose(); await h.close(); }
});

test("Act enable persists through two real Plan confirmations without another human toggle", async () => {
  const h = await approvalHarness();
  try {
    await h.run("plan-exit");
    h.setPlan(false); h.submit();
    assert.equal(getPlanAutoSnapshot(h.ctx)!.confirmPending, false);
    let previous = getPlanAutoSnapshot(h.ctx)!;
    h.ctx.hasUI = false;
    for (const markdown of ["# First task", "# Second task"]) {
      await h.run("plan-enter");
      assert.equal(isCurrentPlanAutoGrant(previous, h.ctx), false);
      assert.equal(getPlanAutoSnapshot(h.ctx)!.confirmPending, true);
      await h.run("plan-update", { markdown });
      const approved = await h.run("plan-confirm");
      assert.equal(approved.details.approved, true);
      assert.equal(approved.details.approvalAudit.result, "handed-off");
      assert.equal(getMode(), "act");
      previous = getPlanAutoSnapshot(h.ctx)!;
      assert.equal(previous.confirmPending, false);
    }
    assert.equal(h.overlays(), 0);
    assert.equal(h.entries.filter((entry) => entry.data.action === "on").length, 1);
    assert.equal((await h.stores[0].load()).manifest.approvals.length, 2);
    assert.equal(getPlanAutoSnapshot(h.ctx)!.taskContext.markdown, "# Second task");
    h.submit("off");
    await h.run("plan-enter");
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined, "new cycle cannot restore an explicitly disabled preference");
  } finally { await h.close(); }
});

test("auto never inherits old workflow/compact execution or source documents", async () => {
  const h = await approvalHarness({ seed: async (store) => {
    const draft = await store.saveDraft("# Old approved draft", 0);
    await store.approve(draft.markdown, draft.manifest.revision, { execution: {
      backend: "standalone", context: "compact", sourceDocument: "OLD-DECISIONS.md",
    } });
  } });
  try {
    h.submit(); h.ctx.hasUI = false;
    const result = await h.run("plan-confirm");
    assert.equal(result.details.approved, true);
    const loaded = await h.stores[0].load();
    assert.deepEqual(loaded.manifest.execution, { backend: "standalone", context: "current" });
    assert.equal(loaded.manifest.sourceDocuments, undefined);
    assert.equal(loaded.manifest.workflowBinding, undefined);
    assert.doesNotMatch(resultText(result), /OLD-DECISIONS|Decision document:/);
  } finally { await h.close(); }
});

for (const failure of ["off", "off-on", "abort", "context-abort", "switch", "clear", "failure"] as const) {
  test(`precommit ${failure} preserves draft, removes pending/archive, and never restores Act`, async () => {
    const boundary = pause();
    const h = await approvalHarness({ store: { approvalCommitHook: async () => {
      await boundary.hook();
      if (failure === "failure") throw new Error("injected commit failure");
    } } });
    const controller = new AbortController();
    const contextController = new AbortController();
    try {
      h.submit();
      await h.run("plan-update", { markdown: "# Draft before cancellation" });
      h.ctx.signal = contextController.signal;
      h.ctx.hasUI = false;
      const pending = h.run("plan-confirm", {}, controller.signal);
      await boundary.reached;
      assert.equal(getMode(), "plan");
      if (failure === "off") h.submit("off");
      if (failure === "off-on") {
        h.submit("off"); h.ctx.hasUI = true; h.submit("on"); h.ctx.hasUI = false;
      }
      if (failure === "abort") controller.abort();
      if (failure === "context-abort") contextController.abort();
      if (failure === "switch") await h.emit("session_before_switch");
      if (failure === "clear") clearPlan();
      boundary.release();
      const result = await pending;
      assert.equal(result.details.approved, false);
      assert.equal(result.details.approvalAudit.result, "not-approved");
      assert.doesNotMatch(resultText(result), /Begin execution now/);
      assert.equal(getMode(), "plan");
      const loaded = await h.stores[0].load();
      assert.equal(loaded.manifest.status, "draft");
      assert.equal(loaded.markdown, "# Draft before cancellation");
      assert.deepEqual(await readdir(h.stores[0].approvalsDir), []);
      await assert.rejects(readFile(h.stores[0].pendingPath), /ENOENT/);
      assert.equal(h.messages.length, 0);
    } finally { boundary.release(); await h.close(); }
  });
}

test("CAS and empty-content approval failures retain draft and cannot enter Act", async () => {
  const h = await approvalHarness();
  try {
    h.submit(); h.ctx.hasUI = false;
    const empty = await h.run("plan-confirm");
    assert.equal(empty.details.approved, false);
    assert.match(empty.details.approvalAudit.reason, /empty Plan/);
    await h.run("plan-update", { markdown: "# Loaded old revision" });
    const loaded = await h.stores[0].load();
    await h.stores[0].saveDraft("# Concurrent exact revision", loaded.manifest.revision);
    const conflict = await h.run("plan-confirm");
    assert.equal(conflict.details.approved, false);
    assert.match(conflict.details.approvalAudit.reason, /revision conflict/);
    assert.equal((await h.stores[0].load()).markdown, "# Concurrent exact revision");
    assert.equal((await h.stores[0].load()).manifest.status, "draft");
    assert.equal(getMode(), "plan");
    assert.deepEqual(await readdir(h.stores[0].approvalsDir), []);
  } finally { await h.close(); }
});

for (const failure of ["off", "abort", "switch", "restore-fail"] as const) {
  test(`postcommit ${failure} preserves approval, blocks handoff, and never recovers automatic execution`, async () => {
    const boundary = pause();
    const h = await approvalHarness(failure === "restore-fail"
      ? { restore: async () => false }
      : { store: { approvalCleanupHook: boundary.hook } });
    const controller = new AbortController();
    try {
      h.submit(); await h.run("plan-update", { markdown: "# Committed but not handed off" });
      h.ctx.hasUI = false;
      const pending = h.run("plan-confirm", {}, controller.signal);
      if (failure !== "restore-fail") {
        await boundary.reached;
        assert.equal(getPlanAutoSnapshot(h.ctx)?.confirmPending, false, "manifest commit consumes confirm before cleanup");
        if (failure === "off") h.submit("off");
        if (failure === "abort") controller.abort();
        if (failure === "switch") await h.emit("session_before_switch");
        boundary.release();
      }
      const result = await pending;
      assert.equal(result.details.approved, true);
      assert.equal(result.details.approvalAudit.result, "committed-handoff-stopped");
      assert.match(resultText(result), /committed and preserved; execution was not started/);
      assert.doesNotMatch(resultText(result), /Begin execution now/);
      assert.equal((await h.stores[0].load()).manifest.status, "approved");
      assert.equal(h.messages.length, 0);
      // Resume rehydrates approval facts, not a permission to execute.
      onSessionShutdownPlan(h.ctx);
      await onSessionStartPlan(h.ctx);
      assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
      assert.equal(h.messages.length, 0);
      assert.equal(getMode(), "act");
      assert.equal((await h.stores[0].load()).manifest.approvals.length, 1);
    } finally { boundary.release(); await h.close(); }
  });
}

test("off during Act-model restoration and the final tool-result boundary blocks a committed handoff", async () => {
  for (const boundary of ["restore", "result"] as const) {
    let revoke!: () => void;
    const h = await approvalHarness({ restore: async () => { if (boundary === "restore") revoke(); return true; } });
    try {
      revoke = () => h.submit("off");
      h.submit(); await h.run("plan-update", { markdown: "# Fence every boundary" });
      h.ctx.hasUI = false;
      if (boundary === "result") setPlanModeChangeListener(() => { if (getMode() === "act") revoke(); });
      const result = await h.run("plan-confirm");
      assert.equal(result.details.approved, true);
      assert.equal(result.details.approvalAudit.result, "committed-handoff-stopped");
      assert.doesNotMatch(resultText(result), /Begin execution now/);
      assert.equal(h.messages.length, 0);
      assert.equal((await h.stores[0].load()).manifest.status, "approved");
    } finally { await h.close(); }
  }
});

test("reverse concurrent confirm has one committed archive and one execution handoff", async () => {
  const boundary = pause();
  let commits = 0;
  const h = await approvalHarness({ store: { approvalCommitHook: async () => {
    if (++commits === 1) await boundary.hook();
  } } });
  try {
    h.submit(); await h.run("plan-update", { markdown: "# Exactly once" }); h.ctx.hasUI = false;
    const older = h.run("plan-confirm");
    await boundary.reached;
    const newer = h.run("plan-confirm");
    boundary.release();
    const [oldResult, newResult] = await Promise.all([older, newer]);
    assert.equal(oldResult.details.approved, false);
    assert.equal(oldResult.details.error, "E_PLAN_OPERATION_SUPERSEDED");
    assert.equal(newResult.details.approved, false, "the saved approval draft moved the revision; concurrent confirm must honor CAS");
    assert.match(newResult.details.approvalAudit.reason, /revision conflict/);
    assert.equal([oldResult, newResult].filter((r) => /Begin execution now/.test(resultText(r))).length, 0);
    const retried = await h.run("plan-confirm");
    assert.equal(retried.details.approved, true);
    assert.equal(retried.details.approvalAudit.result, "handed-off");
    assert.equal((await h.stores[0].load()).manifest.approvals.length, 1);
    assert.equal(getMode(), "act");
  } finally { boundary.release(); await h.close(); }
});

test("duplicate confirm while committed cleanup is pending cannot reuse consumed authorization", async () => {
  const boundary = pause();
  const h = await approvalHarness({ store: { approvalCleanupHook: boundary.hook } });
  try {
    h.submit(); await h.run("plan-update", { markdown: "# Cleanup boundary" }); h.ctx.hasUI = false;
    const older = h.run("plan-confirm");
    await boundary.reached;
    assert.equal(getPlanAutoSnapshot(h.ctx)?.confirmPending, false);
    const newer = await h.run("plan-confirm");
    assert.equal(newer.details.approved, false, "without pending authorization the second confirm uses manual path");
    boundary.release();
    const oldResult = await older;
    assert.equal(oldResult.details.approved, true);
    assert.equal(oldResult.details.approvalAudit.result, "committed-handoff-stopped");
    assert.doesNotMatch(resultText(oldResult), /Begin execution now/);
    assert.equal((await h.stores[0].load()).manifest.approvals.length, 1);
    assert.equal(h.messages.length, 0);
  } finally { boundary.release(); await h.close(); }
});

for (const phase of ["precommit", "postcommit"] as const) {
  test(`real lifecycle replacement during ${phase} cannot append audit or handoff into another session`, async () => {
    const boundary = pause();
    const h = await approvalHarness({ store: phase === "precommit"
      ? { approvalCommitHook: boundary.hook } : { approvalCleanupHook: boundary.hook } });
    try {
      h.submit(); await h.run("plan-update", { markdown: "# Prior session" }); h.ctx.hasUI = false;
      const pending = h.run("plan-confirm");
      await boundary.reached;
      onSessionShutdownPlan(h.ctx);
      (h.ctx.sessionManager as any).getSessionId = () => "replacement";
      await onSessionStartPlan(h.ctx);
      const auditCount = h.entries.length;
      boundary.release();
      const result = await pending;
      assert.equal(result.details.approved, phase === "postcommit");
      assert.equal(result.details.error, "E_PLAN_OPERATION_SUPERSEDED");
      assert.doesNotMatch(resultText(result), /Begin execution now/);
      assert.equal(h.entries.length, auditCount, "stale audit never goes to the replacement session");
      assert.equal(h.messages.length, 0);
      assert.equal(getMode(), "act");
      assert.equal((await h.stores[0].load()).manifest.status, phase === "precommit" ? "draft" : "approved");
      assert.equal((await h.stores[1].load()).manifest.status, "draft");
    } finally { boundary.release(); await h.close(); }
  });
}

test("reverse update cancels an inflight auto approval and preserves the new draft without executing", async () => {
  const boundary = pause();
  const h = await approvalHarness({ store: { approvalCommitHook: boundary.hook } });
  try {
    h.submit(); const first = await h.run("plan-update", { markdown: "# Old draft" }); h.ctx.hasUI = false;
    const pending = h.run("plan-confirm");
    await boundary.reached;
    const update = h.run("plan-update", { markdown: "# New draft", expectedRevision: first.details.revision + 1 });
    boundary.release();
    const [result, saved] = await Promise.all([pending, update]);
    assert.equal(result.details.approved, false);
    assert.equal(saved.details.status, "draft");
    assert.equal((await h.stores[0].load()).markdown, "# New draft");
    assert.equal(getMode(), "plan");
    assert.equal(h.messages.length, 0);
    assert.deepEqual(await readdir(h.stores[0].approvalsDir), []);
  } finally { boundary.release(); await h.close(); }
});

test("the store freshness guard runs immediately before the manifest rename", async () => {
  let afterHook = false;
  let checks = 0;
  let committed = false;
  const h = await approvalHarness({ store: { approvalCommitHook: async () => { afterHook = true; } } });
  try {
    const saved = await h.run("plan-update", { markdown: "# Guard the manifest temp write" });
    await assert.rejects(h.stores[0].approve("# Guard the manifest temp write", saved.details.revision, {
      execution: { backend: "standalone", context: "current" },
      assertCurrent() {
        if (afterHook && ++checks === 3) throw new Error("revoked at final manifest rename fence");
      },
      onCommitted() { committed = true; },
    }), /final manifest rename fence/);
    assert.equal(checks, 3, "after hook, after lock ownership await, and immediately before manifest rename");
    assert.equal(committed, false);
    assert.equal((await h.stores[0].load()).manifest.status, "draft");
    assert.deepEqual(await readdir(h.stores[0].approvalsDir), []);
    await assert.rejects(readFile(h.stores[0].pendingPath), /ENOENT/);
  } finally { await h.close(); }
});

test("revocation from a synchronous host audit listener cannot leak the execution tool result", async () => {
  const h = await approvalHarness();
  try {
    h.submit(); await h.run("plan-update", { markdown: "# Audit boundary" }); h.ctx.hasUI = false;
    const append = h.api.appendEntry;
    let revoked = false;
    h.api.appendEntry = (type, data: any) => {
      append(type, data);
      if (data.result === "handed-off" && !revoked) { revoked = true; h.submit("off"); }
    };
    const result = await h.run("plan-confirm");
    assert.equal(revoked, true);
    assert.equal(result.details.approved, true);
    assert.equal(result.details.approvalAudit.result, "committed-handoff-stopped");
    assert.doesNotMatch(resultText(result), /Begin execution now/);
    assert.equal(h.entries.at(-1)!.data.result, "committed-handoff-stopped");
    assert.equal(getPlanAutoSnapshot(h.ctx), undefined);
  } finally { await h.close(); }
});

test("a stale workflow-backed Plan is not an automatic workflow selection", async () => {
  const h = await approvalHarness({ seed: async (store) => {
    const draft = await store.saveDraft("# Old workflow draft", 0);
    await store.approve(draft.markdown, draft.manifest.revision, { execution: {
      backend: "workflow", workflowTarget: "new", context: "compact", sourceDocument: "OLD-WORKFLOW.md",
    } });
  } });
  try {
    h.submit(); h.ctx.hasUI = false;
    const result = await h.run("plan-confirm");
    assert.equal(result.details.approved, true);
    assert.deepEqual(result.details.execution, { backend: "standalone", context: "current" });
    const loaded = await h.stores[0].load();
    assert.equal(loaded.manifest.workflowBinding, undefined);
    assert.equal(loaded.manifest.sourceDocuments, undefined);
    assert.doesNotMatch(resultText(result), /OLD-WORKFLOW|Workflow Session .*bound/);
    onSessionShutdownPlan(h.ctx); await onSessionStartPlan(h.ctx);
    assert.equal(h.messages.length, 0, "restart does not recover an auto standalone handoff");
  } finally { await h.close(); }
});
