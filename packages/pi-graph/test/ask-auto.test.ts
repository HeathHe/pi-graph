import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeAsk, type AskAnswer, type AskQuestionSpec } from "../src/tools/ask.ts";
import { registerPlanAuto, resetPlanAuto } from "../src/tools/plan-auto.ts";
import { registerAskTransport } from "../src/ask-transport.ts";
import { defaultDecisionPolicy } from "../src/decision-policy/config.ts";
import type { PolicyEvaluation } from "../src/decision-policy/service.ts";
import { AskUserQuestionParams } from "../src/extension/schemas.ts";

const inheritedChild = process.env.PI_TEAMMATE_CHILD;
test.before(() => { delete process.env.PI_TEAMMATE_CHILD; });
test.after(() => { resetPlanAuto("test-end"); if (inheritedChild !== undefined) process.env.PI_TEAMMATE_CHILD = inheritedChild; });
const question: AskQuestionSpec = { question: "Which compatible helper?", options: [{ label: "A" }, { label: "B", recommended: true }] };
const internal = (): PolicyEvaluation => ({ domain: "ask", mode: "enforce", backend: "classifier", owner: "internal", candidateType: "unknown", confidence: 0.95, matchedRuleIds: ["code"], rationale: "Existing code", advice: { recommendation: "Use A instead", rationale: "Compatible", matchedRuleIds: ["code"], assumptions: [], needsExternalDecision: false } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function harness(cwd = "/nonexistent-ask-auto") {
  const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const opened = deferred<void>();
  let raw: ((data: string) => unknown) | undefined;
  let editor = "";
  let finish!: (answers: AskAnswer[] | undefined) => void;
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  let session = "ask-auto";
  const notices: string[] = [];
  const ctx = { cwd, mode: "tui", hasUI: true,
    sessionManager: { getSessionId: () => session, getSessionFile: () => undefined },
    ui: {
      notify: (text: string) => notices.push(text), setStatus() {},
      getEditorText: () => editor, setEditorText: (text: string) => { editor = text; },
      onTerminalInput: (callback: typeof raw) => { raw = callback; return () => {}; },
      custom<T>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: T) => void) => unknown) {
        return new Promise<T>((resolve) => {
          finish = (answers) => resolve(answers as T);
          component = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text }, {}, resolve) as typeof component;
          opened.resolve();
        });
      },
    },
  } as unknown as ExtensionContext;
  const api = { registerCommand() {}, registerShortcut() {}, appendEntry() {},
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const list = events.get(event) ?? []; list.push(handler); events.set(event, list);
    },
  } as unknown as ExtensionAPI;
  registerPlanAuto(api, { isPlanMode: () => false, onStateChange() {} });
  for (const handler of events.get("session_start") ?? []) handler({}, ctx);
  const command = (args: string) => { editor = `/auto ${args}`; raw?.("\r"); };
  return { ctx, notices, opened: opened.promise, command,
    enable: () => command("ask on 0.001"), cancel: () => finish(undefined),
    answer: () => finish([{ question: question.question, selected: ["A"] }]),
    render: (width: number) => component!.render(width).join("\n"),
    changeSession: () => { session = "other"; },
  };
}

test("schema exposes an explicit recommendation marker", () => {
  assert.equal(AskUserQuestionParams.properties.questions.items.properties.options.items.properties.recommended.type, "boolean");
});

test("timeout adopts the marked option as machine data, never an AskAnswer", async () => {
  const h = harness(); h.enable();
  const result = await executeAsk({ questions: [question] }, h.ctx);
  assert.deepEqual(result.details.answers, []);
  assert.deepEqual(result.details.recommendations, [{ questionIndex: 0, question: question.question, selected: ["B"], source: "timeout", timeoutMs: 1 }]);
  assert.equal(result.details.cancelled, undefined);
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /NOT user answers or approval/);
  assert.match(h.render(100), /\[推荐\]/);
  assert.match(h.render(65), /\[推荐\]/);
});

test("multi-select adopts every marked choice and preserves original indexes", async () => {
  const h = harness(); h.enable();
  const result = await executeAsk({ questions: [question, { ...question, question: "Which compatible components?", multiSelect: true, options: [{ label: "X", recommended: true }, { label: "Y", recommended: true }, { label: "Z" }] }] }, h.ctx);
  assert.deepEqual(result.details.recommendations?.map((item) => [item.questionIndex, item.selected]), [[0, ["B"]], [1, ["X", "Y"]]]);
});

test("default-off waits for a genuine human answer", async () => {
  const h = harness();
  const pending = executeAsk({ questions: [question] }, h.ctx);
  await h.opened; h.answer();
  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["A"]);
  assert.equal(result.details.recommendations, undefined);
});

test("human answers, explicit cancel and abort win before timeout", async () => {
  for (const action of ["answer", "cancel", "abort"] as const) {
    const h = harness(); h.command("ask on 60"); const controller = new AbortController();
    const pending = executeAsk({ questions: [question] }, h.ctx, { signal: controller.signal });
    await h.opened;
    if (action === "abort") controller.abort(); else h[action]();
    const result = await pending;
    assert.equal(result.details.recommendations, undefined);
    assert.equal(result.details.cancelled, action === "answer" ? undefined : true);
  }
});

test("missing, ambiguous, duplicate, none-of-above and unsafe recommendations stay human", async () => {
  const cases: AskQuestionSpec[] = [
    { question: "Which helper?" },
    { ...question, options: [{ label: "A" }, { label: "B" }] },
    { ...question, options: [{ label: "A", recommended: true }, { label: "B", recommended: true }] },
    { ...question, options: [{ label: "A" }, { label: "A", recommended: true }] },
    { ...question, options: [{ label: "A" }, { label: "以上都不是", recommended: true }] },
    { ...question, question: "Approve this Plan?" },
    { ...question, question: "Which backup should I remove?" },
    { ...question, question: "要移除哪个备份？" },
    { ...question, options: [{ label: "A" }, { label: "B", description: "Remove a backup", recommended: true }] },
    { ...question, options: [{ label: "A", description: "Delete backup" }, { label: "B", recommended: true }] },
  ];
  for (const item of cases) {
    const h = harness(); h.enable();
    const pending = executeAsk({ questions: [item] }, h.ctx);
    await h.opened; h.cancel();
    const result = await pending;
    assert.equal(result.details.recommendations, undefined);
    assert.ok(!h.notices.some((text) => text.startsWith("Ask-auto：")));
  }
});

test("financial decisions remain human after the Ask-auto timeout", async () => {
  for (const text of ["Which invoice should I pay?", "Pay now", "Refund the order?", "Transfer money now?", "Wire funds?", "Remit cash?", "Checkout now?", "要转账还是退款？", "是否付款？", "要充值吗？"]) {
    const h = harness(); h.enable();
    const pending = executeAsk({ questions: [{ ...question, question: text }] }, h.ctx);
    await h.opened;
    await new Promise((resolve) => setTimeout(resolve, 15)); h.cancel();
    const result = await pending;
    assert.equal(result.details.recommendations, undefined, text);
    assert.equal(result.details.cancelled, true, text);
    assert.ok(!h.notices.some((notice) => notice.startsWith("Ask-auto：")), text);
  }
});

test("humanOnly, unknown remaining batch and classifier refusal never install fallback", async () => {
  for (const scenario of ["humanOnly", "mixed", "external", "uncertain", "shadow", "degraded", "lowConfidence"] as const) {
    const h = harness(); h.enable();
    const evaluation = internal();
    if (scenario === "external" || scenario === "uncertain") evaluation.owner = scenario;
    if (scenario === "shadow") evaluation.mode = "shadow";
    if (scenario === "degraded") evaluation.degradedReason = "backend failed";
    if (scenario === "lowConfidence") evaluation.confidence = 0.1;
    const pending = executeAsk({ questions: scenario === "mixed" ? [question, { question: "What name?" }] : [question] }, h.ctx,
      scenario === "humanOnly" ? { humanOnly: true } : scenario === "mixed" ? {} : { policyEvaluator: async () => evaluation });
    await h.opened; h.cancel();
    const result = await pending;
    assert.equal(result.details.recommendations, undefined);
    assert.ok(!h.notices.some((text) => text.startsWith("Ask-auto：")), scenario);
  }
});

test("accepted classifier advice takes priority over the marked fallback", async () => {
  const h = harness(); h.enable(); const noticeCount = h.notices.length;
  const result = await executeAsk({ questions: [question] }, h.ctx, { policyEvaluator: async () => internal() });
  assert.equal(result.details.decisions?.[0].evaluation.advice?.recommendation, "Use A instead");
  assert.equal(result.details.recommendations, undefined);
  assert.deepEqual(result.details.answers, []);
  assert.equal(h.notices.length, noticeCount);
});

test("off, new grant or session changes invalidate a waiting fallback", async () => {
  for (const action of ["off", "newGrant", "session"] as const) {
    const h = harness(); h.enable();
    const pending = executeAsk({ questions: [question] }, h.ctx);
    await h.opened;
    if (action === "session") h.changeSession();
    else if (action === "off") h.command("ask off");
    else { h.command("ask off"); h.enable(); }
    // Allow the scheduled timeout to check its stale snapshot, then explicitly cancel.
    await new Promise((resolve) => setTimeout(resolve, 15)); h.cancel();
    const result = await pending;
    assert.equal(result.details.recommendations, undefined);
    assert.equal(result.details.cancelled, true);
  }
});

test("a disabled policy allows fallback but edits and malformed policy cannot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ask-auto-policy-"));
  try {
    await mkdir(join(cwd, ".pi")); const file = join(cwd, ".pi", "decision-policy.json");
    const policy = defaultDecisionPolicy();
    await writeFile(file, JSON.stringify(policy));
    const h = harness(cwd); h.enable();
    const result = await executeAsk({ questions: [question] }, h.ctx);
    assert.equal(result.details.recommendations?.[0].source, "timeout");
    const edited = harness(cwd); edited.enable();
    const pending = executeAsk({ questions: [question] }, edited.ctx);
    await edited.opened;
    await writeFile(file, "{broken");
    await new Promise((resolve) => setTimeout(resolve, 15)); edited.cancel();
    assert.equal((await pending).details.recommendations, undefined);
    const invalid = harness(cwd); invalid.enable();
    const blocked = executeAsk({ questions: [question] }, invalid.ctx);
    await invalid.opened; invalid.cancel();
    assert.equal((await blocked).details.recommendations, undefined);
    assert.ok(!invalid.notices.some((text) => text.startsWith("Ask-auto：")));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("enabling policy between classification and dialog startup cannot arm the timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ask-auto-policy-enable-"));
  try {
    await mkdir(join(cwd, ".pi")); const file = join(cwd, ".pi", "decision-policy.json");
    const policy = defaultDecisionPolicy(); await writeFile(file, JSON.stringify(policy));
    const h = harness(cwd); h.enable();
    const pending = executeAsk({ questions: [question] }, h.ctx, { policyEvaluator: async () => {
      await writeFile(file, JSON.stringify({ ...policy, revision: policy.revision + 1, ask: { mode: "enforce" } }));
      return { ...internal(), mode: "off", advice: undefined };
    } });
    await h.opened; h.cancel();
    const result = await pending;
    assert.equal(result.details.recommendations, undefined);
    assert.ok(!h.notices.some((text) => text.startsWith("Ask-auto：")));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("timeout closes both local and remote waits and preserves recommendation markers", async () => {
  const h = harness(); h.enable(); const cancelled: string[] = [];
  const dispose = registerAskTransport({ open(request) {
    assert.equal(request.questions[0].options?.[1].recommended, true);
    return { promise: new Promise(() => {}), cancel: (reason) => { cancelled.push(reason); } };
  } });
  try {
    const result = await executeAsk({ questions: [question] }, h.ctx, { toolCallId: "timeout-call" });
    assert.equal(result.details.recommendations?.length, 1);
    assert.deepEqual(cancelled, ["aborted"]);
  } finally { dispose(); }
});

test("child relay preserves root timeout provenance without inventing answers", async () => {
  const h = harness();
  const descriptor = Object.getOwnPropertyDescriptor(process, "send");
  const child = process.env.PI_TEAMMATE_CHILD;
  const recommendations = [{ questionIndex: 0, question: question.question, selected: ["B"], source: "timeout", timeoutMs: 60_000 }];
  process.env.PI_TEAMMATE_CHILD = "1";
  Object.defineProperty(process, "send", { configurable: true,
    value(message: { requestId: string; payload: { questions: AskQuestionSpec[] } }, callback: (error: null) => void) {
      assert.equal(message.payload.questions[0].options?.[1].recommended, true);
      callback(null);
      queueMicrotask(() => process.emit("message", { type: "teammate_interaction_response", requestId: message.requestId,
        result: { action: "answer", answers: [], recommendations } }));
      return true;
    },
  });
  try {
    const result = await executeAsk({ questions: [question] }, h.ctx);
    assert.deepEqual(result.details.answers, []);
    assert.deepEqual(result.details.recommendations, recommendations);
  } finally {
    if (descriptor) Object.defineProperty(process, "send", descriptor);
    else delete process.send;
    if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
  }
});

test("malformed recommendation marker is rejected at the host boundary", async () => {
  const h = harness();
  const result = await executeAsk({ questions: [{ question: "Which helper?", options: [{ label: "A", recommended: "yes" }] }] } as unknown as Parameters<typeof executeAsk>[0], h.ctx);
  assert.equal(result.isError, true);
});
