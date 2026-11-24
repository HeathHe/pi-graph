import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import type { SupportedSettingsLocale } from "pi-graph-shared-settings/v1";
import { getTuiLocale, registerTuiLocaleEvents } from "../src/tui/locale.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createClassifierSettingsProvider } from "../src/classifier/settings-provider.ts";
import { classifierModelCatalog, configuredPanelValues, modelOptions, panelChanges, saveClassifierPanel } from "../src/classifier/panel-model.ts";
import { ClassifierSettingsOverlay, classifierEngineRows, showClassifierSettings, type ClassifierPanelState } from "../src/tui/classifier-settings.ts";
import { defaultDecisionPolicy } from "../src/decision-policy/config.ts";
import registerClassifier from "../src/classifier/extension.ts";

const theme = { fg(_role: string, text: string) { return text; }, bold(text: string) { return text; } };
const down = "\x1b[B";
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 20)); };
async function harness(locale: SupportedSettingsLocale = "en", renderTheme = theme) {
  const cwd = await mkdtemp(join(tmpdir(), "classifier-tui-"));
  const domains = [{ name: "retry-error", modes: ["off", "shadow"] as const }, { name: "custom", modes: ["off", "shadow", "jev"] as const }];
  const applied: unknown[] = [];
  const provider = createClassifierSettingsProvider({ getDomains: () => domains, apply: config => { applied.push(config); } });
  const context = { cwd, locale: "en" as const };
  const snapshot = await provider.read({ context });
  const engine = configuredPanelValues(snapshot);
  const policy = defaultDecisionPolicy();
  const state: ClassifierPanelState = { snapshot, engine, engineInitial: { ...engine }, policy, policyInitial: structuredClone(policy), group: "engine", selected: 0, notice: "" };
  const controller = new AbortController();
  const results: string[] = [];
  let lastSave: Promise<typeof snapshot> | undefined;
  const overlay = new ClassifierSettingsOverlay({ locale, state, engineRows: () => classifierEngineRows(provider, locale),
    classifierModels: { options: [{ reference: "typesafe/jev-1", label: "typesafe/jev-1 · 中文分类模型" }] },
    llmModels: { options: [{ reference: "openai/gpt-5", label: "openai/gpt-5" }] },
    theme: renderTheme, requestRender() {}, done: intent => { results.push(intent); }, signal: controller.signal,
    saveEngine: changes => lastSave = saveClassifierPanel(provider, context, state.snapshot, changes, () => { if (controller.signal.aborted) throw new Error("Stale panel"); }),
  });
  return { cwd, domains, applied, provider, context, state, controller, results, overlay, waitSave: async () => { assert.ok(lastSave); await lastSave; }, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test("typed authenticated catalog never substitutes generic models; old/missing/failed APIs explain unavailability", async () => {
  const calls: unknown[] = [];
  const registry = { getAvailable: () => { throw new Error("Must not use LLMs"); },
    getAvailableOfType: async (...args: unknown[]) => { calls.push(args); return [{ provider: "typesafe", id: "jev-1", name: "JEV" }]; }, getModelOfType() {}, classify() {} };
  const signal = new AbortController().signal;
  assert.deepEqual((await classifierModelCatalog("0.99.0", registry, signal)).options, [{ reference: "typesafe/jev-1", label: "typesafe/jev-1 · JEV" }]);
  assert.deepEqual(calls, [["classifier", undefined, { signal }]]);
  assert.match((await classifierModelCatalog("0.98.0", registry)).unavailable!, /unavailable/);
  assert.equal(calls.length, 1);
  assert.match((await classifierModelCatalog("0.99.0", {})).unavailable!, /native/);
  assert.match((await classifierModelCatalog("0.99.0", { ...registry, getAvailableOfType: async () => [] })).unavailable!, /No authenticated/);
  assert.match((await classifierModelCatalog("0.99.0", { ...registry, getAvailableOfType: async () => { throw new Error("auth failed"); } })).unavailable!, /auth failed/);
  assert.deepEqual(modelOptions([{ provider: "openai", id: "gpt-5" }, { provider: "openai", id: "gpt-5" }]), [{ reference: "openai/gpt-5", label: "openai/gpt-5" }]);
});

test("live domain rows use supported modes and newly registered domains appear", async () => {
  const h = await harness();
  try {
    assert.deepEqual(classifierEngineRows(h.provider, "en").find(row => row.key === "classifier.domains.retry-error")?.choices, ["off", "shadow"]);
    h.domains.push({ name: "late-domain", modes: ["off", "shadow", "jev"] });
    const rows = classifierEngineRows(h.provider, "en");
    assert.ok(rows.some(row => row.key === "classifier.cacheTtlMs"));
    h.state.selected = rows.findIndex(row => row.key === "classifier.domains.late-domain");
    h.overlay.handleInput("\r"); h.overlay.handleInput(down); h.overlay.handleInput(down); h.overlay.handleInput("\r");
    assert.equal(h.state.engine["classifier.domains.late-domain"], "jev");
  } finally { await h.cleanup(); }
});

test("picker supports pasted search, Enter/Esc, auto/inherit; unavailable saved model is not lost", async () => {
  const h = await harness();
  try {
    h.state.engine["classifier.model"] = "legacy/unavailable";
    h.state.selected = 2;
    h.overlay.handleInput("\r");
    assert.match(h.overlay.render(120).join("\n"), /Configured unavailable \(preserved\): legacy\/unavailable/);
    h.overlay.handleInput("\x1b");
    assert.equal(h.state.engine["classifier.model"], "legacy/unavailable");
    h.overlay.handleInput("\r"); h.overlay.handleInput("\x1b[20"); h.overlay.handleInput("0~jev"); h.overlay.handleInput("-1\x1b[201~"); h.overlay.handleInput("\r");
    assert.equal(h.state.engine["classifier.model"], "typesafe/jev-1");
    h.overlay.handleInput("\r"); h.overlay.handleInput("\r");
    assert.equal(h.state.engine["classifier.model"], "");
    h.overlay.handleInput("\t"); h.state.selected = 4;
    h.overlay.handleInput("\r"); h.overlay.handleInput("gpt-5"); h.overlay.handleInput("\r");
    assert.equal(h.state.policy.classification.model, "openai/gpt-5");
    h.overlay.handleInput("\r"); h.overlay.handleInput("\r");
    assert.equal(h.state.policy.classification.model, "inherit");
  } finally { await h.cleanup(); }
});

test("policy enabled modes require confirmed rules; rule summary is read-only and file cancellation is independent", async () => {
  const h = await harness();
  try {
    h.overlay.handleInput("\r"); h.overlay.handleInput(down); h.overlay.handleInput("\r");
    assert.equal(h.state.engine["classifier.enabled"], true);
    h.overlay.handleInput("\t"); h.overlay.handleInput("\r"); h.overlay.handleInput(down); h.overlay.handleInput("\r");
    assert.equal(h.state.policy.ask.mode, "off");
    assert.match(h.state.notice, /\/skill:decision-policy/);
    h.state.policy.rules = [{ id: "test", domain: "ask", instruction: "Use project convention" }];
    h.overlay.handleInput("\r"); h.overlay.handleInput(down); h.overlay.handleInput(down); h.overlay.handleInput("\r");
    assert.equal(h.state.policy.ask.mode, "enforce");
    h.state.selected = 10; h.overlay.handleInput("\r");
    assert.match(h.state.notice, /read-only/);
    h.overlay.handleInput("\x12");
    assert.equal(h.state.policy.ask.mode, "off");
    assert.equal(h.state.engine["classifier.enabled"], true);
    h.overlay.handleInput("\t"); h.overlay.handleInput("\x12");
    assert.equal(h.state.engine["classifier.enabled"], false);
  } finally { await h.cleanup(); }
});

test("numeric paste validates integer/decimal; narrow rendering matrix covers menu, edit, picker, confirmation", async () => {
  const h = await harness();
  const assertWidths = () => {
    for (let width = 1; width <= 120; width++) for (const line of h.overlay.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  };
  try {
    assertWidths(); h.state.selected = 3; h.overlay.handleInput("\r"); assertWidths();
    h.overlay.handleInput("\x15"); h.overlay.handleInput("-2.5"); h.overlay.handleInput("\r");
    assert.match(h.state.notice, /Invalid numeric/);
    h.overlay.handleInput("\x15"); h.overlay.handleInput("1234"); h.overlay.handleInput("\r");
    assert.equal(h.state.engine["classifier.timeoutMs"], 1234);
    h.state.selected = 2; h.overlay.handleInput("\r"); assertWidths(); h.overlay.handleInput("\x1b");
    h.overlay.handleInput("\x13"); assertWidths(); h.overlay.handleInput("\x1b");
    h.overlay.handleInput("\t"); h.state.selected = 3; h.overlay.handleInput("\r"); h.overlay.handleInput("\x15"); h.overlay.handleInput("0.9"); h.overlay.handleInput("\r");
    assert.equal(h.state.policy.minConfidence, 0.9);
    h.overlay.handleInput("\x1b"); assert.match(h.state.notice, /Esc again/); h.overlay.handleInput("\x1b");
    assert.deepEqual(h.results, ["close"]);
  } finally { await h.cleanup(); }
});

test("numeric editor and provider enforce declared bounds without altering existing invalid pins", async () => {
  const h = await harness();
  try {
    for (const [key, low, high] of [["classifier.timeoutMs", 499, 30001], ["classifier.maxCallsPerSession", 0, 501]] as const) {
      const row = classifierEngineRows(h.provider, "en").findIndex(row => row.key === key);
      for (const value of [low, high]) {
        h.state.selected = row;
        h.overlay.handleInput("\r"); h.overlay.handleInput("\x15"); h.overlay.handleInput(String(value)); h.overlay.handleInput("\r");
        assert.match(h.state.notice, /Invalid numeric/);
        h.overlay.handleInput("\x1b");
        const validation = await h.provider.validate!({ context: h.context, changes: [{ operation: "set", scope: "project", key, value }] });
        assert.equal(validation.valid, false);
      }
    }
    h.overlay.handleInput("\t");
    for (const [row, value] of [[5, 99], [6, 1001], [8, 120001], [9, 0]]) {
      h.state.selected = row;
      h.overlay.handleInput("\r"); h.overlay.handleInput("\x15"); h.overlay.handleInput(String(value)); h.overlay.handleInput("\r");
      assert.match(h.state.notice, /Invalid numeric/);
      h.overlay.handleInput("\x1b");
    }
    // A pre-existing pin is retained until its own row is explicitly edited.
    h.state.engine["classifier.timeoutMs"] = 1;
    h.overlay.handleInput("\t"); h.state.selected = 3; h.overlay.handleInput("\r"); h.overlay.handleInput("\x1b");
    assert.equal(h.state.engine["classifier.timeoutMs"], 1);
  } finally { await h.cleanup(); }
});

test("classifier publication remains committed success if cancellation arrives during lock release", async (t) => {
  const h = await harness();
  const lockfile = createRequire(import.meta.url)("proper-lockfile");
  const original = lockfile.lock;
  let entered!: () => void;
  const released = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  t.mock.method(lockfile, "lock", async (...args: unknown[]) => {
    const release = await original(...args);
    return async () => { entered(); await gate; await release(); };
  });
  try {
    const pending = saveClassifierPanel(h.provider, h.context, h.state.snapshot,
      [{ operation: "set", scope: "project", key: "classifier.enabled", value: true }],
      () => { if (h.controller.signal.aborted) throw new Error("Stale panel"); });
    await released;
    assert.equal(JSON.parse(await readFile(join(h.cwd, ".pi", "classifier.json"), "utf8")).enabled, true);
    h.controller.abort(); resume();
    const committed = await pending;
    assert.equal(committed.effective.values.find(value => value.key === "classifier.enabled")?.value, true);
    assert.equal(h.applied.length, 1);
  } finally { resume(); t.mock.restoreAll(); await h.cleanup(); }
});

test("provider CAS saves cache TTL and configured values without persisting env overrides", async () => {
  const h = await harness();
  const previous = process.env.PI_CLASSIFIER;
  try {
    process.env.PI_CLASSIFIER = "1";
    const snapshot = await h.provider.read({ context: h.context });
    assert.equal(configuredPanelValues(snapshot)["classifier.enabled"], false);
    assert.equal(snapshot.effective.values.find(value => value.key === "classifier.enabled")?.value, true);
    h.state.snapshot = snapshot; h.state.selected = 4;
    h.overlay.handleInput("\r"); h.overlay.handleInput("\x15"); h.overlay.handleInput("10000"); h.overlay.handleInput("\r");
    h.overlay.handleInput("\x13"); h.overlay.handleInput("\r"); await h.waitSave();
    const saved = JSON.parse(await readFile(join(h.cwd, ".pi", "classifier.json"), "utf8"));
    assert.equal(saved.cacheTtlMs, 10000); assert.equal(saved.enabled, false);
    assert.equal(h.applied.length, 1); assert.match(h.state.notice, /saved/);
    assert.equal(panelChanges(h.state.engineInitial, h.state.engine).length, 0);
    const stale = snapshot;
    await assert.rejects(saveClassifierPanel(h.provider, h.context, stale, [{ operation: "set", scope: "project", key: "classifier.enabled", value: true }], () => {}), /revision conflict/);
  } finally { if (previous === undefined) delete process.env.PI_CLASSIFIER; else process.env.PI_CLASSIFIER = previous; await h.cleanup(); }
});

test("failed publication keeps UI draft and does not publish runtime; late/disposed save cannot update UI", async () => {
  const h = await harness();
  try {
    h.state.engine["classifier.enabled"] = true;
    await writeFile(join(h.cwd, "external.json"), "{}");
    const failing = new ClassifierSettingsOverlay({ locale: "en", state: h.state, engineRows: () => classifierEngineRows(h.provider, "en"), classifierModels: { options: [] }, llmModels: { options: [] }, theme, signal: h.controller.signal, requestRender() {}, done() {}, saveEngine: async () => { throw new Error("disk failed"); } });
    failing.handleInput("\x13"); failing.handleInput("\r"); await flush();
    assert.match(h.state.notice, /Save failed: disk failed/); assert.equal(h.state.engine["classifier.enabled"], true); assert.equal(h.applied.length, 0);
    let resolve!: (value: typeof h.state.snapshot) => void;
    const pending = new Promise<typeof h.state.snapshot>(done => { resolve = done; });
    const late = new ClassifierSettingsOverlay({ locale: "en", state: h.state, engineRows: () => classifierEngineRows(h.provider, "en"), classifierModels: { options: [] }, llmModels: { options: [] }, theme, signal: h.controller.signal, requestRender() {}, done() {}, onDispose: () => h.controller.abort(), saveEngine: () => pending });
    late.handleInput("\x13"); late.handleInput("\r"); const notice = h.state.notice;
    late.dispose(); resolve(h.state.snapshot); await flush();
    assert.equal(h.controller.signal.aborted, true); assert.equal(h.state.notice, notice); assert.equal(h.state.engine["classifier.enabled"], true);
  } finally { await h.cleanup(); }
});

test("cancellation after prepare cleans the staged lock/file without committing", async () => {
  const h = await harness();
  try {
    let checks = 0;
    await assert.rejects(saveClassifierPanel(h.provider, h.context, h.state.snapshot, [{ operation: "set", scope: "project", key: "classifier.enabled", value: true }], () => { if (++checks === 2) throw new Error("Stale panel"); }), /Stale panel/);
    await assert.rejects(readFile(join(h.cwd, ".pi", "classifier.json")), { code: "ENOENT" });
    assert.equal(h.applied.length, 0);
    const retry = await h.provider.prepare!({ context: h.context, transactionId: "retry", changes: [] });
    assert.equal(retry.prepared, true);
    await h.provider.abort!({ context: h.context, transactionId: "retry", prepareToken: retry.prepareToken! });
  } finally { await h.cleanup(); }
});

function commandHost() {
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const commands = new Map<string, any>();
  const pi = { on(name: string, handler: (...args: any[]) => any) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; }, registerCommand(name: string, command: any) { commands.set(name, command); } };
  registerClassifier(pi as never);
  return { pi, handlers, command: commands.get("classifier").handler };
}

test("headless empty/panel/config/status are status-only; legacy on/off/mode/test/reset remain independent of policy", async () => {
  const h = await harness();
  const host = commandHost();
  const notifications: string[] = [];
  const ctx = { cwd: h.cwd, hasUI: false, ui: { notify: (text: string) => notifications.push(text) }, modelRegistry: {} };
  try {
    for (const command of ["", "panel", "config", "status"]) await host.command(command, ctx);
    assert.match(notifications[0]!, /panel unavailable/); assert.match(notifications[3]!, /Classifier:/);
    await host.command("on", ctx); assert.equal(JSON.parse(await readFile(join(h.cwd, ".pi", "classifier.json"), "utf8")).enabled, true);
    await assert.rejects(readFile(join(h.cwd, ".pi", "decision-policy.json")), { code: "ENOENT" });
    await host.command("mode retry-error jev", ctx); assert.match(notifications.at(-1)!, /does not support/);
    await host.command("mode signal-type off", ctx); assert.match(notifications.at(-1)!, /saved/);
    await host.command("test signal-type hello", ctx); assert.match(notifications.at(-1)!, /layer=rule/);
    await host.command("off", ctx);
    await writeFile(join(h.cwd, ".pi", "classifier.json"), JSON.stringify({ enabled: true, cacheTtlMs: 5000, model: "legacy", domains: { retired: "jev" } }));
    await host.command("reset", ctx);
    const reset = JSON.parse(await readFile(join(h.cwd, ".pi", "classifier.json"), "utf8"));
    assert.equal(reset.enabled, false); assert.equal(reset.cacheTtlMs, undefined); assert.equal(reset.model, undefined); assert.equal(reset.domains.retired, undefined);
    await writeFile(join(h.cwd, ".pi", "classifier.json"), "{");
    await host.command("reset", ctx);
    assert.equal(JSON.parse(await readFile(join(h.cwd, ".pi", "classifier.json"), "utf8")).enabled, false);
    for (const name of ["session_before_switch", "session_before_fork", "session_shutdown"]) assert.equal(host.handlers.get(name)?.length, 1);
  } finally { await h.cleanup(); }
});

test("policy save failure reopens a fresh handle, reloads only policy and keeps configuration human", async () => {
  const h = await harness();
  const child = process.env.PI_TEAMMATE_CHILD;
  const managed = process.env.PI_TEAMMATE_MANAGED_WINDOW;
  delete process.env.PI_TEAMMATE_CHILD; delete process.env.PI_TEAMMATE_MANAGED_WINDOW;
  const { isDecisionPolicyConfiguring } = await import("../src/decision-policy/extension.ts");
  let opens = 0; let confirms = 0;
  const controller = new AbortController();
  const ctx = { cwd: h.cwd, hasUI: true, sessionManager: { getSessionId: () => "recovery-session" }, modelRegistry: { getAvailable: () => [] },
    ui: { notify() {}, confirm: async () => { if (++confirms === 1) throw new Error("host confirmation failed"); return true; },
      custom: async (factory: any) => new Promise(resolve => {
        const overlay = factory({ requestRender() {} }, theme, {}, resolve);
        assert.equal(isDecisionPolicyConfiguring(ctx as never), true);
        if (++opens === 1) {
          overlay.handleInput("\r"); overlay.handleInput(down); overlay.handleInput("\r"); // unsaved engine draft
          overlay.handleInput("\t");
        } else if (opens === 2) {
          assert.match(overlay.render(140).join("\n"), /policy reloaded, engine draft preserved/);
          overlay.handleInput("\t");
          assert.match(overlay.render(140).join("\n"), /Enabled:\s+true/);
          overlay.handleInput("\t");
        }
        if (opens <= 2) {
          for (let i = 0; i < 2; i++) overlay.handleInput(down);
          overlay.handleInput("\r"); overlay.handleInput(down); overlay.handleInput("\r");
          overlay.handleInput("\x13"); overlay.handleInput("\r");
        } else { overlay.handleInput("\x1b"); overlay.handleInput("\x1b"); }
        overlay.dispose();
      }),
    },
  };
  try {
    await showClassifierSettings(ctx as never, h.provider, controller, () => { if (controller.signal.aborted) throw new Error("Cancelled"); }, "en");
    assert.equal(opens, 3); assert.equal(confirms, 2);
    assert.equal(JSON.parse(await readFile(join(h.cwd, ".pi", "decision-policy.json"), "utf8")).backend, "classifier");
    await assert.rejects(readFile(join(h.cwd, ".pi", "classifier.json")), { code: "ENOENT" });
    assert.equal(isDecisionPolicyConfiguring(ctx as never), false);
  } finally {
    if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
    if (managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = managed;
    await h.cleanup();
  }
});

test("unified wrapper settles custom overlay before policy host confirmation; draft groups remain independent", async () => {
  const h = await harness();
  const child = process.env.PI_TEAMMATE_CHILD;
  const managed = process.env.PI_TEAMMATE_MANAGED_WINDOW;
  delete process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_MANAGED_WINDOW;
  let overlayActive = false; let opens = 0; let confirms = 0;
  const controller = new AbortController();
  const ctx = { cwd: h.cwd, hasUI: true, sessionManager: { getSessionId: () => "test-session" }, modelRegistry: { getAvailable: () => [] },
    ui: {
      notify() {}, setStatus() {},
      confirm: async () => { assert.equal(overlayActive, false, "host confirmation must not nest custom UI"); confirms++; return true; },
      custom: async (factory: any) => {
        overlayActive = true;
        const result = await new Promise(resolve => {
          const overlay = factory({ requestRender() {} }, theme, {}, (intent: string) => { overlayActive = false; resolve(intent); });
          if (++opens === 1) { overlay.handleInput("\t"); for (let i = 0; i < 2; i++) overlay.handleInput(down); overlay.handleInput("\r"); overlay.handleInput(down); overlay.handleInput("\r"); overlay.handleInput("\x13"); overlay.handleInput("\r"); }
          else overlay.handleInput("\x1b");
          overlay.dispose();
        });
        return result;
      },
    },
  };
  try {
    await showClassifierSettings(ctx as never, h.provider, controller, () => { if (controller.signal.aborted) throw new Error("Cancelled"); }, "en");
    assert.equal(confirms, 1); assert.equal(opens, 2);
    assert.equal(JSON.parse(await readFile(join(h.cwd, ".pi", "decision-policy.json"), "utf8")).backend, "classifier");
    await assert.rejects(readFile(join(h.cwd, ".pi", "classifier.json")), { code: "ENOENT" });
  } finally {
    if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
    if (managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = managed;
    await h.cleanup();
  }
});

// Use Pi's real ANSI foreground/background renderer, not an identity theme.
const ansiTheme = new Theme({ accent: 39, text: 252, muted: 244, dim: 240, warning: 214, thinkingXhigh: 99 } as ConstructorParameters<typeof Theme>[0],
  { customMessageBg: 235, selectedBg: 237 } as ConstructorParameters<typeof Theme>[1], "256color");
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

for (const locale of ["en", "zh-CN"] as const) {
  test(`classifier ${locale}: ANSI hierarchy, aligned values, all modes fit 1..120 and narrow help remains available`, async () => {
    const h = await harness(locale, ansiTheme);
    const matrix = () => {
      for (let width = 1; width <= 120; width++) for (const line of h.overlay.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${locale}/${width}: ${line}`);
      }
    };
    try {
      const rendered = h.overlay.render(120);
      assert.ok(rendered.some(line => line.includes(ansiTheme.getFgAnsi("accent"))));
      assert.ok(rendered.some(line => line.includes(ansiTheme.getFgAnsi("muted"))));
      const enabled = plain(rendered.find(line => plain(line).includes(locale === "en" ? "> Enabled:" : "> 启用:"))!);
      const endpoint = plain(rendered.find(line => plain(line).includes(locale === "en" ? "JEV endpoint:" : "JEV 端点:"))!);
      assert.equal(visibleWidth(enabled.slice(0, enabled.indexOf(locale === "en" ? "false" : "停用"))),
        visibleWidth(endpoint.slice(0, endpoint.indexOf(locale === "en" ? "auto" : "自动"))));
      assert.match(plain(rendered.join("\n")), locale === "en" ? /\[ Engine \]/ : /\[ 引擎 \]/);
      assert.equal(classifierEngineRows(h.provider, locale)[0]!.label, locale === "en" ? "Enabled" : "启用");
      for (const key of ["Esc", "Enter", "Ctrl+S", "Ctrl+R", "F5", "F6"]) assert.ok(plain(h.overlay.render(24).join("\n")).includes(key), key);
      matrix();
      h.state.selected = 2; h.overlay.handleInput("\r");
      h.overlay.handleInput("\x1b[20"); h.overlay.handleInput("0~中文"); h.overlay.handleInput("分类模型\x1b[201~");
      assert.match(plain(h.overlay.render(120).join("\n")), /中文分类模型/);
      matrix(); h.overlay.handleInput("\r");
      assert.equal(h.state.engine["classifier.model"], "typesafe/jev-1");
      assert.match(h.state.notice, locale === "en" ? /Unsaved draft/ : /草稿未保存/);
      h.state.selected = 3; h.overlay.handleInput("\r"); matrix();
      h.overlay.handleInput("\x15"); h.overlay.handleInput("\x1b[200~1234\x1b[201~"); h.overlay.handleInput("\r");
      h.overlay.handleInput("\x13"); matrix(); h.overlay.handleInput("\x1b");
      assert.deepEqual(h.results, [], "nested Esc only returns to menu");
      h.overlay.handleInput("\t"); matrix();
      assert.match(plain(h.overlay.render(120).join("\n")), locale === "en" ? /Ask mode/ : /提问模式/);
      h.state.selected = 2; h.overlay.handleInput("\r"); matrix(); h.overlay.handleInput(down); h.overlay.handleInput("\r");
      assert.equal(h.state.policy.backend, "classifier");
      h.overlay.handleInput("\x13"); matrix(); h.overlay.handleInput("\x1b");
      h.state.selected = 3; h.overlay.handleInput("\r"); matrix(); h.overlay.handleInput("\x1b");
      h.overlay.handleInput("\t"); h.overlay.handleInput("\x13"); h.overlay.handleInput("\r"); await h.waitSave();
      assert.match(h.state.notice, locale === "en" ? /saved; policy draft untouched/ : /已保存；策略草稿未变更/);
      const saved = JSON.parse(await readFile(join(h.cwd, ".pi", "classifier.json"), "utf8"));
      assert.equal(saved.model, "typesafe/jev-1"); assert.equal(saved.timeoutMs, 1234);
      assert.equal(h.state.policy.backend, "classifier", "other file draft survives save");
    } finally { await h.cleanup(); }
  });
}

test("classifier zh-CN save failure keeps selection, raw draft and retry semantics", async () => {
  const h = await harness("zh-CN", ansiTheme);
  try {
    h.state.engine["classifier.model"] = "missing/原始模型"; h.state.selected = 2;
    const failing = new ClassifierSettingsOverlay({ locale: "zh-CN", state: h.state, engineRows: () => classifierEngineRows(h.provider, "zh-CN"),
      classifierModels: { options: [], unavailable: "No authenticated classifier models available." }, llmModels: { options: [] }, theme: ansiTheme,
      signal: h.controller.signal, requestRender() {}, done() {}, saveEngine: async () => { throw new Error("disk failed"); } });
    failing.handleInput("\x13"); failing.handleInput("\r"); await flush();
    assert.equal(h.state.notice, "保存失败：disk failed"); assert.equal(h.state.selected, 2);
    assert.equal(h.state.engine["classifier.model"], "missing/原始模型"); assert.equal(h.applied.length, 0);
    failing.handleInput("\r");
    assert.match(plain(failing.render(120).join("\n")), /已配置模型不可用（已保留）：missing\/原始模型/);
    assert.match(plain(failing.render(120).join("\n")), /没有已认证的可用分类器模型/);
    failing.handleInput("不存在");
    assert.match(plain(failing.render(120).join("\n")), /没有匹配的候选项/);
    for (let width = 1; width <= 120; width++) for (const line of failing.render(width)) assert.ok(visibleWidth(line) <= width);
    failing.handleInput("\x1b"); assert.equal(h.state.engine["classifier.model"], "missing/原始模型");
  } finally { await h.cleanup(); }
});

test("classifier follows shared locale events unless an explicit locale is supplied", () => {
  const original = getTuiLocale();
  let update!: (payload: unknown) => void;
  const unbind = registerTuiLocaleEvents({ on(_event, handler) { update = handler; } });
  const provider = createClassifierSettingsProvider();
  try {
    update({ version: 1, locale: "zh-CN", generation: "classifier-test" });
    assert.equal(classifierEngineRows(provider)[0]!.label, "启用");
    assert.equal(classifierEngineRows(provider, "en")[0]!.label, "Enabled");
    update({ version: 1, locale: "en", generation: "classifier-test-en" });
    assert.equal(classifierEngineRows(provider)[0]!.label, "Enabled");
  } finally { update({ version: 1, locale: original, generation: "classifier-test-restore" }); unbind(); }
});
