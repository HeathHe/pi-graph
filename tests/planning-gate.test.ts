import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { ProviderCooldownRegistry, providerRetryDelay } from "../src/model-routing/provider-cooldown.ts";
import {
	PlanningGate,
	graphSpecDigest,
	graphSpecFloors,
	maxPlanningTier,
	maxRiskClass,
	parseGraphSpecReview,
	planningProfileKey,
	prePlanningFloors,
	validateTaskAssessment,
	type RiskClass,
	type TaskAssessment,
} from "../src/subagent-router/planning-gate.ts";
import type { GraphSpec } from "../src/types.ts";

const planner = { decisionId: "planner-decision", resolvedModel: "wisdomrouter/gpt-5.6-sol:high", attemptedModels: ["wisdomrouter/gpt-5.6-sol:high"], modelFamily: "gpt", providerDomain: "wisdomrouter" };
const reviewer = { decisionId: "reviewer-decision", resolvedModel: "kimi-coding/k3:high", attemptedModels: ["kimi-coding/k3:high"], modelFamily: "kimi", providerDomain: "moonshot" };
const parentModel = { resolvedModel: "deepseek/deepseek-v4-flash:max", modelFamily: "deepseek", providerDomain: "deepseek", identityConfidence: "runtime_reported" as const };

function assessment(overrides: Partial<TaskAssessment> = {}): TaskAssessment {
	return {
		schemaVersion: 1, taskType: "general", proposedTier: "tactical", confidence: 0.8, reasons: ["multiple steps"], plannedActions: ["inspect", "produce"],
		complexitySignals: {}, riskClass: "R0", riskReasons: [], riskSignals: {}, ...overrides,
	};
}

function spec(goal = "implement the requested change", nodes = 1): GraphSpec {
	return {
		schemaVersion: 1, goal,
		nodes: Array.from({ length: nodes }, (_, index) => ({
			taskId: `work-${index}`, agent: "task-executor", task: `${goal} ${index}`,
			...(index ? { dependsOn: [`work-${index - 1}`] } : {}), outputArtifact: `work-${index}.md`, sideEffect: "none" as const,
		})),
	};
}

function completePlan(gate: PlanningGate, graphSpec: GraphSpec, taskAssessment = assessment(), configDigest = "config-a") {
	gate.beginTurn({ sessionId: "session-a", cwd: "/workspace", prompt: "Please implement this multi-stage task." });
	gate.assessTurn({ sessionId: "session-a", cwd: "/workspace", assessment: taskAssessment, draftSpec: graphSpec, parentModel });
	gate.beginPlanning({ sessionId: "session-a", cwd: "/workspace", configDigest, planningProfile: "test-planning", expectedPlannerModel: planner.resolvedModel });
	gate.completePlanning({ sessionId: "session-a", cwd: "/workspace", configDigest, evidence: planner, output: "# Task Plan\n- work" });
	return gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest, spec: graphSpec });
}

function passReview(binding: ReturnType<PlanningGate["beginReview"]>) {
	return { schemaVersion: 2 as const, reviewedDigest: binding.digest, lineageDigest: binding.lineageDigest, verdict: "pass" as const, findings: [] };
}

test("planning and risk orders are monotonic", () => {
	assert.equal(maxPlanningTier("direct", "tactical"), "tactical");
	assert.equal(maxPlanningTier("strategic", "direct"), "strategic");
	assert.equal(maxRiskClass("R0", "R2", "R1"), "R2");
	assert.equal(maxRiskClass("R3", "R0"), "R3");
	assert.equal(planningProfileKey("tactical", "R3"), "strategicHighRisk");
	assert.equal(planningProfileKey("strategic", "R2"), "strategic");
	assert.equal(planningProfileKey("strategic", "R3"), "strategicHighRisk");
	assert.throws(() => planningProfileKey("direct", "R0"), /do not have/);
});

test("Flash assessment is strict and low estimates are upgraded by deterministic floors", () => {
	assert.throws(() => validateTaskAssessment({ ...assessment(), confidence: 2 }), /between 0 and 1/);
	const underestimated = assessment({ proposedTier: "direct", riskClass: "R0", plannedActions: ["one"], complexitySignals: { competingDirections: true }, riskSignals: { production: true, externalWrite: true } });
	const floors = prePlanningFloors("deploy this to production", underestimated, spec("deploy", 3));
	assert.equal(floors.tier, "strategic");
	assert.equal(floors.risk, "R3");
	assert.equal(maxPlanningTier(underestimated.proposedTier, floors.tier), "strategic");
	assert.equal(maxRiskClass(underestimated.riskClass, floors.risk), "R3");
});

test("ordinary action count alone does not upgrade a trivial direct assessment", () => {
	const trivial = assessment({
		proposedTier: "direct",
		confidence: 0.99,
		reasons: ["simple arithmetic"],
		plannedActions: ["assess the request", "compute 2 + 3", "answer with the result"],
		complexitySignals: {},
		riskClass: "R0",
		riskReasons: [],
		riskSignals: {},
	});
	const empty = { schemaVersion: 1, goal: "answer 2+3", nodes: [] } as GraphSpec;
	assert.deepEqual(prePlanningFloors("What is 2+3?", trivial, empty), { tier: "direct", risk: "R0" });
});

test("prompt-only domain-general floors upgrade underreported complex work", () => {
	const underreported = assessment({ proposedTier: "direct", plannedActions: ["do it"], complexitySignals: {}, riskClass: "R0", riskSignals: {} });
	const empty = { schemaVersion: 1, goal: "underreported", nodes: [] } as GraphSpec;
	for (const prompt of [
		"把现有登录、订单、支付模块拆开，保持数据一致并确保旧客户端不中断",
		"将三个部门和两家供应商的流程迁移到新平台，业务不能中断",
		"Migrate the customer workflow while preserving backward compatibility and zero downtime.",
		"合并两个社群成员库并保持身份和权限一致",
	]) {
		const floor = prePlanningFloors(prompt, underreported, empty);
		assert.equal(floor.tier, "strategic", prompt);
		assert.equal(floor.risk, "R2", prompt);
	}
	const coordination = prePlanningFloors("Coordinate multiple teams and systems with interdependent data sources.", underreported, empty);
	assert.equal(coordination.tier, "strategic");
	assert.equal(coordination.risk, "R0", "planning complexity must not manufacture external-action risk");
});

test("Graph structure and external actions produce post-spec floors", () => {
	assert.deepEqual(graphSpecFloors(spec("one")), { tier: "tactical", risk: "R0" });
	assert.equal(graphSpecFloors(spec("three", 3)).tier, "strategic");
	const parallelByDefault: GraphSpec = { schemaVersion: 1, goal: "parallel", nodes: [
		{ taskId: "left", agent: "worker", task: "left", outputArtifact: "left.md", sideEffect: "none" },
		{ taskId: "right", agent: "worker", task: "right", outputArtifact: "right.md", sideEffect: "none" },
	] };
	assert.equal(graphSpecFloors(parallelByDefault).tier, "strategic", "the floor must use compileGraph's default maxConcurrency=2 when parallel work exists");
	const external: GraphSpec = { schemaVersion: 1, goal: "publish", nodes: [{ taskId: "send", agent: "worker", task: "send", output: { type: "connector-record" }, sideEffect: "external_write", externalAction: { service: "mail", action: "send", target: "x", requiresApproval: true, reversible: false, verifyByReadback: true } }] };
	assert.equal(graphSpecFloors(external).risk, "R3");
});

test("direct assessments cannot enter Graph planning", () => {
	const gate = new PlanningGate();
	gate.beginTurn({ sessionId: "session-a", cwd: "/workspace", prompt: "answer" });
	const state = gate.assessTurn({ sessionId: "session-a", cwd: "/workspace", assessment: assessment({ proposedTier: "direct", plannedActions: ["answer"] }), parentModel });
	assert.equal(state.effectiveTier, "direct");
	assert.throws(() => gate.beginPlanning({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", planningProfile: "none", expectedPlannerModel: planner.resolvedModel }), /must not start a Graph/);
});

test("repeated assessment is monotonic and cannot downgrade the same turn", () => {
	const gate = new PlanningGate();
	const graphSpec = spec("high risk", 3);
	gate.beginTurn({ sessionId: "session-a", cwd: "/workspace", prompt: "deploy production" });
	const first = gate.assessTurn({
		sessionId: "session-a", cwd: "/workspace",
		assessment: assessment({ proposedTier: "strategic", riskClass: "R3", riskSignals: { production: true, externalWrite: true, irreversible: true } }),
		draftSpec: graphSpec, parentModel,
	});
	assert.equal(first.effectiveTier, "strategic");
	assert.equal(first.effectiveRiskClass, "R3");
	const second = gate.assessTurn({ sessionId: "session-a", cwd: "/workspace", assessment: assessment({ proposedTier: "direct", riskClass: "R0" }), parentModel });
	assert.equal(second.effectiveTier, "strategic");
	assert.equal(second.effectiveRiskClass, "R3");
	assert.deepEqual(second.flashDraft, graphSpec);
});

test("receipt binds exact GraphSpec and the complete derivation lineage", () => {
	const gate = new PlanningGate();
	const graphSpec = spec();
	const binding = completePlan(gate, graphSpec);
	const receipt = gate.completeReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", review: passReview(binding), reviewer });
	assert.equal(receipt.finalGraphSpecDigest, graphSpecDigest(graphSpec));
	assert.equal(receipt.parentDraftDigest, graphSpecDigest(graphSpec));
	assert.equal(receipt.lineageDigest, binding.lineageDigest);
	assert.equal(receipt.planner.decisionId, "planner-decision");
	assert.equal(receipt.reviewer.decisionId, "reviewer-decision");
	assert.equal(gate.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: graphSpec, toolCallId: "start-1" }).receiptId, receipt.receiptId);
	assert.equal(gate.commitStart({ sessionId: "session-a", cwd: "/workspace", toolCallId: "start-1", runId: "run-1" }).consumedByRunId, "run-1");
	assert.throws(() => gate.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: graphSpec, toolCallId: "start-2" }), /already consumed/);
});

test("final GraphSpec escalation invalidates the old plan", () => {
	const gate = new PlanningGate();
	gate.beginTurn({ sessionId: "session-a", cwd: "/workspace", prompt: "research" });
	gate.assessTurn({ sessionId: "session-a", cwd: "/workspace", assessment: assessment(), draftSpec: spec("draft"), parentModel });
	gate.beginPlanning({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", planningProfile: "tactical", expectedPlannerModel: planner.resolvedModel });
	gate.completePlanning({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", evidence: planner, output: "plan" });
	assert.throws(() => gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: spec("expanded", 3) }), /raises the required gate/);
});

test("planner completion rejects any automatic model downgrade", () => {
	const gate = new PlanningGate();
	const graphSpec = spec();
	gate.beginTurn({ sessionId: "session-a", cwd: "/workspace", prompt: "plan" });
	gate.assessTurn({ sessionId: "session-a", cwd: "/workspace", assessment: assessment(), draftSpec: graphSpec, parentModel });
	gate.beginPlanning({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", planningProfile: "strategic", expectedPlannerModel: "wisdomrouter/gpt-5.6-sol:high" });
	assert.throws(() => gate.completePlanning({
		sessionId: "session-a", cwd: "/workspace", configDigest: "config-a",
		evidence: { ...planner, resolvedModel: "kimi-coding/k3:high" }, output: "plan",
	}), /Automatic planner downgrade is forbidden/);
});

test("planner and reviewer reject hidden weak attempts before the authorized model", () => {
	const graphSpec = spec();
	const gate = new PlanningGate();
	gate.beginTurn({ sessionId: "session-a", cwd: "/workspace", prompt: "plan" });
	gate.assessTurn({ sessionId: "session-a", cwd: "/workspace", assessment: assessment(), draftSpec: graphSpec, parentModel });
	gate.beginPlanning({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", planningProfile: "strategic", expectedPlannerModel: planner.resolvedModel });
	assert.throws(() => gate.completePlanning({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", evidence: { ...planner, attemptedModels: ["weak/model:low", planner.resolvedModel] }, output: "plan" }), /every model attempt/);
	gate.completePlanning({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", evidence: planner, output: "plan" });
	const binding = gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: graphSpec });
	assert.throws(() => gate.completeReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", review: passReview(binding), reviewer: { ...reviewer, attemptedModels: ["weak/reviewer:low", reviewer.resolvedModel] } }), /every model attempt/);
});

test("receipt fails closed for missing stages, changed inputs, config drift, and session reset", () => {
	const empty = new PlanningGate();
	empty.beginTurn({ sessionId: "session-a", cwd: "/workspace", prompt: "task" });
	assert.throws(() => empty.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: spec(), toolCallId: "start" }), /requires plan_graph/);
	const gate = new PlanningGate();
	const original = spec();
	const binding = completePlan(gate, original);
	gate.completeReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", review: passReview(binding), reviewer });
	assert.throws(() => gate.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: spec("changed"), toolCallId: "changed" }), /changed after review/);
	assert.throws(() => gate.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-b", spec: original, toolCallId: "config" }), /configuration changed/);
	gate.resetSession("session-a");
	assert.throws(() => gate.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: original, toolCallId: "reset" }), /No active planning-gate turn/);
});

test("review digest, lineage, verdict, findings, and reviewer independence fail closed", () => {
	for (const variant of ["revise", "digest", "lineage", "same-provider", "major-pass"] as const) {
		const gate = new PlanningGate();
		const graphSpec = spec();
		const binding = completePlan(gate, graphSpec);
		assert.throws(() => gate.completeReview({
			sessionId: "session-a", cwd: "/workspace", configDigest: "config-a",
			review: {
				schemaVersion: 2, reviewedDigest: variant === "digest" ? "f".repeat(64) : binding.digest,
				lineageDigest: variant === "lineage" ? "e".repeat(64) : binding.lineageDigest,
				verdict: variant === "revise" ? "revise" : "pass",
				findings: variant === "revise" || variant === "major-pass" ? [{ severity: "major", code: "missing", message: "missing acceptance" }] : [],
			},
			reviewer: variant === "same-provider" ? { ...planner, decisionId: "review" } : reviewer,
		}), variant === "revise" ? /Exactly one corrected GraphSpec.*major:missing: missing acceptance/ : variant === "digest" || variant === "lineage" ? /complete planning lineage/ : variant === "same-provider" ? /different model families/ : /pass with a critical or major/);
	}
});

test("one validated revise verdict permits exactly one changed-spec re-review", () => {
	const gate = new PlanningGate();
	const original = spec("original");
	const first = completePlan(gate, original);
	assert.throws(() => gate.completeReview({
		sessionId: "session-a", cwd: "/workspace", configDigest: "config-a",
		review: { schemaVersion: 2, reviewedDigest: first.digest, lineageDigest: first.lineageDigest, verdict: "revise", findings: [{ severity: "major", code: "fix", message: "correct the retry boundary", taskId: "work-0" }] },
		reviewer,
	}), /Exactly one corrected GraphSpec.*major:fix:work-0: correct the retry boundary/);
	assert.throws(() => gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: original }), /must change/);
	const corrected = spec("corrected");
	const second = gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: corrected });
	const receipt = gate.completeReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", review: passReview(second), reviewer });
	assert.equal(receipt.finalGraphSpecDigest, graphSpecDigest(corrected));
	assert.throws(() => gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: spec("third") }), /exhausted/);
});

test("a second revise verdict exhausts the active plan and cannot loop", () => {
	const gate = new PlanningGate();
	const first = completePlan(gate, spec("first"));
	assert.throws(() => gate.completeReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", review: { schemaVersion: 2, reviewedDigest: first.digest, lineageDigest: first.lineageDigest, verdict: "revise", findings: [] }, reviewer }), /Exactly one corrected/);
	const second = gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: spec("second") });
	assert.throws(() => gate.completeReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", review: { schemaVersion: 2, reviewedDigest: second.digest, lineageDigest: second.lineageDigest, verdict: "revise", findings: [{ severity: "minor", code: "still", message: "still incomplete" }] }, reviewer }), /No further review is allowed.*minor:still: still incomplete/);
	assert.throws(() => gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: spec("third") }), /exhausted/);
});

test("a review attempt is single-use for the active plan, even when parsing or execution fails", () => {
	const gate = new PlanningGate();
	const graphSpec = spec();
	completePlan(gate, graphSpec);
	assert.throws(
		() => gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: graphSpec }),
		/exhausted the active plan's review budget/,
	);
	gate.beginTurn({ sessionId: "session-a", cwd: "/workspace", prompt: "retry in a new user turn" });
	gate.assessTurn({ sessionId: "session-a", cwd: "/workspace", assessment: assessment(), draftSpec: graphSpec, parentModel });
	gate.beginPlanning({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", planningProfile: "test-planning", expectedPlannerModel: planner.resolvedModel });
	gate.completePlanning({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", evidence: planner, output: "# Task Plan\n- work" });
	assert.doesNotThrow(() => gate.beginReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: graphSpec }));
});

test("new turns invalidate receipts and failed reservations can be released", () => {
	const gate = new PlanningGate(); const graphSpec = spec(); const binding = completePlan(gate, graphSpec);
	gate.completeReview({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", review: passReview(binding), reviewer });
	gate.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: graphSpec, toolCallId: "start-a" });
	assert.throws(() => gate.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: graphSpec, toolCallId: "start-b" }), /already reserved/);
	gate.releaseStart({ sessionId: "session-a", cwd: "/workspace", toolCallId: "start-a" });
	assert.doesNotThrow(() => gate.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: graphSpec, toolCallId: "start-b" }));
	gate.beginTurn({ sessionId: "session-a", cwd: "/workspace", prompt: "a new user turn" });
	assert.throws(() => gate.reserveStart({ sessionId: "session-a", cwd: "/workspace", configDigest: "config-a", spec: graphSpec, toolCallId: "new-turn" }), /requires plan_graph/);
});

test("Graph start obtains the routing digest from the router-owned resolver", async () => {
	const gate = new PlanningGate(); gate.setConfigDigestResolver(async () => "a".repeat(64)); assert.equal(await gate.currentConfigDigest(), "a".repeat(64));
	gate.setConfigDigestResolver(async () => "custom-config"); await assert.rejects(() => gate.currentConfigDigest(), /invalid digest/);
});

test("strict review parser requires v2 and both digests", () => {
	assert.throws(() => parseGraphSpecReview("Verdict: pass"), /strict JSON/);
	assert.throws(() => parseGraphSpecReview(JSON.stringify({ schemaVersion: 1, reviewedDigest: "a".repeat(64), verdict: "pass", findings: [] })), /invalid schemaVersion/);
	assert.equal(parseGraphSpecReview(JSON.stringify({ schemaVersion: 2, reviewedDigest: "a".repeat(64), lineageDigest: "b".repeat(64), verdict: "pass", findings: [] })).verdict, "pass");
});

test("provider retry uses full jitter above Retry-After and cooldown permits one half-open probe", async () => {
	assert.equal(providerRetryDelay({ attempt: 2, baseMs: 1_000, retryAfterMs: 1_500, random: () => 0.25 }), 1_500);
	assert.equal(providerRetryDelay({ attempt: 2, baseMs: 1_000, retryAfterMs: 0, random: () => 0.5 }), 1_000);
	const registry = new ProviderCooldownRegistry(); registry.trip("graph-a\0moonshot", 1); await new Promise((resolve) => setTimeout(resolve, 5));
	const release = await registry.acquireAfterFailure("graph-a\0moonshot", "probe-a"); let secondResolved = false;
	const second = registry.acquireAfterFailure("graph-a\0moonshot", "probe-b").then((value) => { secondResolved = true; return value; });
	await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(secondResolved, false); release(); const releaseSecond = await second; assert.equal(secondResolved, true); releaseSecond();
});

test("process-level planning and cooldown gates are shared across Extension loaders", () => {
	const firstLoader = createJiti(import.meta.url, { moduleCache: false }); const secondLoader = createJiti(import.meta.url, { moduleCache: false });
	const planningUrl = new URL("../src/subagent-router/planning-gate.ts", import.meta.url).href;
	assert.equal((firstLoader(planningUrl) as { planningGate: PlanningGate }).planningGate, (secondLoader(planningUrl) as { planningGate: PlanningGate }).planningGate);
	const cooldownUrl = new URL("../src/model-routing/provider-cooldown.ts", import.meta.url).href;
	assert.equal((firstLoader(cooldownUrl) as { providerCooldowns: ProviderCooldownRegistry }).providerCooldowns, (secondLoader(cooldownUrl) as { providerCooldowns: ProviderCooldownRegistry }).providerCooldowns);
});
