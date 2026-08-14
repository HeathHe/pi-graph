import assert from "node:assert/strict";
import test from "node:test";
import { planningChildIdentity, planningEvidenceFromAsyncTerminal } from "../src/subagent-router/planning-runtime.ts";
import type { AsyncTerminal } from "../src/lifecycle.ts";
import type { RoutingDecision } from "../src/model-routing/types.ts";

const selectedModel = "wisdomrouter/gpt-5.6-sol:high";
const decision = {
	decisionId: "sealed-decision",
	selectedModel,
	modelFamily: "gpt",
	providerDomain: "wisdomrouter",
} as RoutingDecision;

function terminal(overrides: Record<string, unknown> = {}): AsyncTerminal {
	return {
		state: "complete",
		status: {
			runId: "child-run",
			state: "complete",
			steps: [{
				agent: "planner",
				status: "complete",
				model: "wisdomrouter/gpt-5.6-sol",
				thinking: "high",
				attemptedModels: ["wisdomrouter/gpt-5.6-sol"],
				modelAttempts: [{ model: "wisdomrouter/gpt-5.6-sol", success: true }],
				launchContractDigest: "launch-digest",
				...overrides,
			}],
		},
		output: "# Execution-ready plan",
	};
}

test("planning runtime binds the exact durable child identity", () => {
	const asyncRoot = "/tmp/pi-subagents/async-subagent-runs";
	assert.deepEqual(planningChildIdentity({
		state: "complete",
		status: { workflow: { value: { runId: "child-run", artifactPaths: [`${asyncRoot}/child-run`] } } },
		output: "",
	}, asyncRoot), { asyncId: "child-run", asyncDir: `${asyncRoot}/child-run` });
	assert.throws(() => planningChildIdentity({
		state: "complete",
		status: { workflow: { value: { runId: "child-run", artifactPaths: ["/tmp/forged/child-run"] } } },
		output: "",
	}, asyncRoot), /exact public async run directory/);
});

test("planning runtime accepts only complete exact-model provenance", () => {
	const result = planningEvidenceFromAsyncTerminal({ terminal: terminal(), decision, expectedAgent: "planner", expectedLaunchContractDigest: "launch-digest" });
	assert.equal(result.evidence.resolvedModel, selectedModel);
	assert.deepEqual(result.evidence.attemptedModels, [selectedModel, selectedModel]);
	assert.equal(result.output, "# Execution-ready plan");
});

test("planning runtime rejects weak attempts even when the final model is exact", () => {
	assert.throws(() => planningEvidenceFromAsyncTerminal({
		terminal: terminal({
			attemptedModels: ["weak/model", "wisdomrouter/gpt-5.6-sol"],
			modelAttempts: [{ model: "weak/model", success: false }, { model: "wisdomrouter/gpt-5.6-sol", success: true }],
		}),
		decision,
		expectedAgent: "planner",
		expectedLaunchContractDigest: "launch-digest",
	}), /attempted a model other/);
});

test("planning runtime fails closed on missing attempts, wrong agent, or launch drift", () => {
	for (const [overrides, pattern] of [
		[{ attemptedModels: undefined, modelAttempts: undefined }, /complete attempted-model provenance/],
		[{ agent: "other" }, /authorized Agent/],
		[{ launchContractDigest: "changed" }, /launch contract differs/],
	] as const) {
		assert.throws(() => planningEvidenceFromAsyncTerminal({ terminal: terminal(overrides), decision, expectedAgent: "planner", expectedLaunchContractDigest: "launch-digest" }), pattern);
	}
});
