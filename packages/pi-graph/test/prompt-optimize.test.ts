import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_OPTIMIZE_CONFIG,
  loadOptimizeConfig,
  saveOptimizeConfig,
} from "../src/prompt-optimize/config.ts";
import {
  hasCjk,
  looksStructured,
  PROMPT_ROUTE_DOMAIN,
  promptRouteDomain,
} from "../src/prompt-optimize/domain.ts";
import {
  cleanOptimizedText,
  renderOptimizePrompt,
  ROUTE_INSTRUCTIONS,
} from "../src/prompt-optimize/template.ts";
import { classify, resetClassifierForTest } from "pi-graph-agent-runtime/v1/classify";

async function withDefaultsPath(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prompt-optimize-"));
  const path = join(dir, "api-manager.json");
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── config ──────────────────────────────────────────────────────────────

test("optimize config falls back to defaults when the file is missing", async () => {
  await withDefaultsPath(async (path) => {
    assert.deepEqual(await loadOptimizeConfig(path), DEFAULT_OPTIMIZE_CONFIG);
  });
});

test("optimize config round-trips through api-manager.json", async () => {
  await withDefaultsPath(async (path) => {
    await saveOptimizeConfig(
      {
        enabled: false,
        modelRef: "maestro-qwen/qwen3.8-max-preview",
        translateModelRef: "maestro-openai/gpt-5.6",
        thinking: "high",
        maxChars: 1500,
        contextDepth: "session",
        includeGit: false,
        maxFiles: 2,
        knowledgeSearch: false,
        knowledgeTopN: 3,
      },
      path,
    );
    assert.deepEqual(await loadOptimizeConfig(path), {
      enabled: false,
      modelRef: "maestro-qwen/qwen3.8-max-preview",
      translateModelRef: "maestro-openai/gpt-5.6",
      thinking: "high",
      maxChars: 1500,
      contextDepth: "session",
      includeGit: false,
      maxFiles: 2,
      knowledgeSearch: false,
      knowledgeTopN: 3,
    });
  });
});

test("optimize config normalizes malformed entries", async () => {
  await withDefaultsPath(async (path) => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        optimize: {
          enabled: "yes",
          modelRef: 42,
          thinking: "off",
          maxChars: -5,
          contextDepth: "bogus",
          includeGit: "no",
          maxFiles: 99,
          knowledgeSearch: 1,
          knowledgeTopN: -1,
        },
      }),
      "utf8",
    );
    // "off" is NOT in the thinking whitelist; it falls back to default.
    // "yes"/"no"/1 coerce to true/false; numeric/unknown values fall back;
    // maxFiles/knowledgeTopN clamp to caps.
    assert.deepEqual(await loadOptimizeConfig(path), {
      ...DEFAULT_OPTIMIZE_CONFIG,
      enabled: true,
      maxFiles: 10,
      knowledgeSearch: true,
    });
  });
});

test("optimize config clamps maxChars>=1 to avoid floor-to-zero", async () => {
  await withDefaultsPath(async (path) => {
    await writeFile(path, JSON.stringify({ version: 1, optimize: { maxChars: 0.5 } }), "utf8");
    assert.equal((await loadOptimizeConfig(path)).maxChars, DEFAULT_OPTIMIZE_CONFIG.maxChars);
    await writeFile(path, JSON.stringify({ version: 1, optimize: { maxChars: 1 } }), "utf8");
    assert.equal((await loadOptimizeConfig(path)).maxChars, 1);
  });
});

test("optimize config defaults translateModelRef to 'same' and keeps valid refs", async () => {
  await withDefaultsPath(async (path) => {
    assert.equal((await loadOptimizeConfig(path)).translateModelRef, "same");
    await writeFile(path, JSON.stringify({ version: 1, optimize: { translateModelRef: 42 } }), "utf8");
    assert.equal((await loadOptimizeConfig(path)).translateModelRef, "same");
    await writeFile(path, JSON.stringify({ version: 1, optimize: { translateModelRef: " maestro-openai/gpt-5.6 " } }), "utf8");
    assert.equal((await loadOptimizeConfig(path)).translateModelRef, "maestro-openai/gpt-5.6");
  });
});

// ── domain: L0 rules ─────────────────────────────────────────────────────

test("hasCjk detects Chinese and ignores pure-ASCII text", () => {
  assert.equal(hasCjk("修复登录页面的 bug"), true);
  assert.equal(hasCjk("fix the login page"), false);
  assert.equal(hasCjk("fix 登录 page"), true);
  assert.equal(hasCjk(""), false);
});

test("looksStructured detects lists and section labels", () => {
  assert.equal(looksStructured("goal:\n- fix login\n- add tests"), true);
  assert.equal(looksStructured("do this:\n1. first\n2. second"), true);
  assert.equal(looksStructured("Requirements:\nkeep it simple"), true);
  assert.equal(looksStructured("fix the login bug"), false);
  assert.equal(looksStructured("one line\nanother plain line"), false);
});

test("prompt-route rules: CJK drafts are terminal translate", () => {
  const verdict = promptRouteDomain.rules({ text: "帮我优化这个登录流程" });
  assert.deepEqual(verdict, { label: "translate", terminal: true });
});

test("prompt-route rules: mixed CJK/English still routes to translate", () => {
  const verdict = promptRouteDomain.rules({ text: "fix auth.ts 的登录逻辑" });
  assert.deepEqual(verdict, { label: "translate", terminal: true });
});

test("prompt-route rules: rough English is provisional format", () => {
  const verdict = promptRouteDomain.rules({ text: "fix the login bug" });
  assert.deepEqual(verdict, { label: "format", terminal: false });
});

test("prompt-route rules: structured English is provisional polish", () => {
  const verdict = promptRouteDomain.rules({ text: "Requirements:\n- fix login\n- add tests" });
  assert.deepEqual(verdict, { label: "polish", terminal: false });
});

test("prompt-route decide maps JEV route choice to a label", () => {
  const decided = promptRouteDomain.decide({
    route: { type: "choice", choice: "polish", confidence: 0.9 },
  });
  assert.deepEqual(decided, { label: "polish", confidence: 0.9 });
  assert.equal(promptRouteDomain.decide({ route: { type: "choice", choice: "bogus" } }), undefined);
  assert.equal(promptRouteDomain.decide({}), undefined);
});

test("prompt-route fallback is format", () => {
  assert.deepEqual(promptRouteDomain.fallback("x"), { label: "format", confidence: 0 });
});

// ── domain: engine integration ───────────────────────────────────────────

test("classify() uses rules when the classifier engine is disabled", async () => {
  resetClassifierForTest();
  const zh = await classify(promptRouteDomain, { text: "优化登录逻辑" });
  assert.equal(zh.label, "translate");
  assert.equal(zh.layer, "rule");
  assert.equal(zh.confidence, 1);

  const en = await classify(promptRouteDomain, { text: "fix the login bug" });
  assert.equal(en.label, "format");
  assert.equal(en.layer, "rule");
});

test("prompt-route domain name and modes are registered for the classifier", () => {
  assert.equal(promptRouteDomain.name, PROMPT_ROUTE_DOMAIN);
  assert.deepEqual(promptRouteDomain.modes, ["off", "shadow", "jev"]);
});

// ── template ─────────────────────────────────────────────────────────────

test("renderOptimizePrompt includes the route instruction, context sections, and the prompt", () => {
  const out = renderOptimizePrompt({
    route: "translate",
    recentMessages: ["user: fix the bug"],
    projectTree: "src/index.ts",
    gitLog: "abc123 feat: x",
    mentionedFiles: ["### a.ts\n```\ncode\n```"],
    knowledgeHits: [{ id: "spec:1", name: "Rule A", summary: "do X", category: "review" }],
    prompt: "修复登录 bug",
  });
  assert.match(out, /Route=translate/);
  assert.match(out, /RecentMessages:/);
  assert.match(out, /ProjectTree:/);
  assert.match(out, /GitLog:/);
  assert.match(out, /MentionedFiles:/);
  assert.match(out, /KnowledgeHits:/);
  assert.match(out, /PromptToOptimize:/);
  assert.match(out, /修复登录 bug/);
  assert.match(out, /\[review\] Rule A: do X/);
});

test("renderOptimizePrompt carries a route instruction for every route", () => {
  for (const route of ["translate", "format", "polish"] as const) {
    const out = renderOptimizePrompt({
      route,
      recentMessages: [],
      projectTree: undefined,
      gitLog: undefined,
      mentionedFiles: [],
      knowledgeHits: [],
      prompt: "x",
    });
    assert.ok(out.includes(ROUTE_INSTRUCTIONS[route]));
  }
});

test("cleanOptimizedText strips fences, headings, and surrounding quotes", () => {
  assert.equal(cleanOptimizedText("```\noptimized\n```"), "optimized");
  assert.equal(cleanOptimizedText("# Heading\nbody"), "body");
  assert.equal(cleanOptimizedText('"wrapped"'), "wrapped");
});

// ── engine: effectiveOptimizeModelRef ────────────────────────────────────

import { effectiveOptimizeModelRef } from "../src/prompt-optimize/engine.ts";

test("effectiveOptimizeModelRef follows modelRef except on the translate route", () => {
  const config = { ...DEFAULT_OPTIMIZE_CONFIG, modelRef: "fx/opt", translateModelRef: "fx/trans" };
  assert.equal(effectiveOptimizeModelRef(config, "translate"), "fx/trans");
  assert.equal(effectiveOptimizeModelRef(config, "format"), "fx/opt");
  assert.equal(effectiveOptimizeModelRef(config, "polish"), "fx/opt");
});

test("effectiveOptimizeModelRef honors 'same' and 'session' translate refs", () => {
  const same = { ...DEFAULT_OPTIMIZE_CONFIG, modelRef: "fx/opt", translateModelRef: "same" };
  assert.equal(effectiveOptimizeModelRef(same, "translate"), "fx/opt");
  const session = { ...DEFAULT_OPTIMIZE_CONFIG, modelRef: "fx/opt", translateModelRef: "session" };
  assert.equal(effectiveOptimizeModelRef(session, "translate"), "session");
});

// ── command flow: revert state machine ───────────────────────────────────

import { registerPromptOptimize } from "../src/prompt-optimize/index.ts";

type OptimizeApi = {
  registerShortcut: (k: string, o: { handler: (ctx: unknown) => Promise<void> }) => void;
  registerCommand: (n: string, o: { handler: (a: string, ctx: unknown) => Promise<void> }) => void;
  on: (e: string, h: () => void) => void;
};

function optimizeHarness(defaultsPath: string) {
  let editorText = "";
  const notifs: string[] = [];
  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    ui: {
      notify: (m: string) => { notifs.push(m); },
      getEditorText: () => editorText,
      setEditorText: (t: string) => { editorText = t; },
    },
    sessionManager: { getBranch: () => [], getSessionId: () => "s1" },
    model: { provider: "fx", id: "glm-5.2" },
    modelRegistry: { getAll: () => [{ provider: "fx", id: "glm-5.2" }] },
  } as never;
  const handlers: { shortcut?: (ctx: unknown) => Promise<void>; command?: (a: string, ctx: unknown) => Promise<void> } = {};
  const commandNames: string[] = [];
  const api = {
    registerShortcut: (_k: string, o: { handler: (ctx: unknown) => Promise<void> }) => { handlers.shortcut = o.handler; },
    registerCommand: (n: string, o: { handler: (a: string, ctx: unknown) => Promise<void> }) => {
      commandNames.push(n);
      handlers.command = o.handler;
    },
    on: () => {},
  } as unknown as OptimizeApi;
  registerPromptOptimize(api as never, { defaultsPath });
  return { ctx, handlers, notifs, commandNames, getEditorText: () => editorText };
}

test("/prompt-enhance is the primary command and /optimize stays an alias", async () => {
  await withDefaultsPath(async (path) => {
    const h = optimizeHarness(path);
    assert.deepEqual(h.commandNames, ["prompt-enhance", "optimize"]);
  });
});

test("api-manager arg maps prompt-enhance/optimize to the optimize action", async () => {
  const { actionFromArg } = await import("../src/providers/api-provider-ops.ts");
  assert.equal(actionFromArg("prompt-enhance"), "optimize");
  assert.equal(actionFromArg("optimize"), "optimize");
  assert.equal(actionFromArg("prompt-optimize"), "optimize");
  // The legacy enhance feature keeps its own action — the prompt-enhance
  // alias was reassigned to the optimize panel, /api-manager enhance is unchanged.
  assert.equal(actionFromArg("enhance"), "enhance");
});

test("/optimize revert reports nothing to revert before any optimization", async () => {
  await withDefaultsPath(async (path) => {
    const h = optimizeHarness(path);
    await h.handlers.command?.("revert", h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /没有可回退/);
  });
});

test("/optimize on|off toggles persist and notify", async () => {
  await withDefaultsPath(async (path) => {
    const h = optimizeHarness(path);
    await h.handlers.command?.("off", h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /已停用/);
    assert.equal((await loadOptimizeConfig(path)).enabled, false);
    await h.handlers.command?.("on", h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /已启用/);
    assert.equal((await loadOptimizeConfig(path)).enabled, true);
  });
});

test("/optimize with empty editor notifies 'nothing to optimize'", async () => {
  await withDefaultsPath(async (path) => {
    const h = optimizeHarness(path);
    await h.handlers.command?.("", h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /为空|没有可优化/);
  });
});

test("runOptimize warns and returns early without UI (hasUI false)", async () => {
  await withDefaultsPath(async (path) => {
    const h = optimizeHarness(path);
    const noUiCtx = { ...h.ctx, hasUI: false } as never;
    await h.handlers.command?.("some draft", noUiCtx);
    assert.match(h.notifs.at(-1) ?? "", /交互模式/);
    assert.equal(h.getEditorText(), "");
  });
});

test("runOptimize does not touch the editor when the feature is disabled", async () => {
  await withDefaultsPath(async (path) => {
    await writeFile(path, JSON.stringify({ version: 1, optimize: { ...DEFAULT_OPTIMIZE_CONFIG, enabled: false } }), "utf8");
    const h = optimizeHarness(path);
    h.ctx.ui.setEditorText("my draft");
    // Use the shortcut path; disabled config short-circuits before any LLM call.
    await h.handlers.shortcut?.(h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /已关闭/);
    assert.equal(h.getEditorText(), "my draft");
  });
});

test("/optimize route reports the classifier verdict for the given text", async () => {
  await withDefaultsPath(async (path) => {
    const h = optimizeHarness(path);
    await h.handlers.command?.("route 修复登录页面的bug", h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /prompt-route.*translate.*layer=rule/);
    await h.handlers.command?.("route fix the login bug", h.ctx);
    assert.match(h.notifs.at(-1) ?? "", /prompt-route.*format/);
  });
});
