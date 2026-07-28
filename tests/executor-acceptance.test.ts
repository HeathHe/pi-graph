import assert from "node:assert/strict";
import test from "node:test";
import { childAcceptanceFor, taskPrompt } from "../src/executor.ts";
import type { CompiledGraph, CompiledNode } from "../src/types.ts";

const DEFAULT_CHILD_ACCEPTANCE = {
	level: "none",
	reason: "Acceptance is enforced by the pi-graph supervisor.",
};

function compiledNode(overrides: Partial<CompiledNode> = {}): CompiledNode {
	return {
		taskId: "research",
		agent: "researcher",
		task: "Research the subject.",
		outputArtifact: "research.md",
		sideEffect: "local_read",
		cwd: process.cwd(),
		dependsOn: [],
		readScope: [],
		writeScope: [],
		retryPolicy: { maxAttempts: 1 },
		...overrides,
	};
}

function compiledGraph(node: CompiledNode): CompiledGraph {
	return {
		schemaVersion: 1,
		projectionVersion: 1,
		graphId: "acceptance-test",
		goal: "Test Graph acceptance layering.",
		nodes: [node],
		maxConcurrency: 1,
		failFast: false,
		workspace: "shadow",
		topologicalOrder: [node.taskId],
		compiledAt: new Date(0).toISOString(),
	};
}

function promptFor(node: CompiledNode): string {
	const workspace = { artifactPaths: {}, cwd: process.cwd() } as Parameters<typeof taskPrompt>[2];
	return taskPrompt(compiledGraph(node), node, workspace);
}

test("child dispatch defaults to disabled child acceptance", () => {
	assert.deepEqual(childAcceptanceFor({}), DEFAULT_CHILD_ACCEPTANCE);
});

test("Graph acceptance never projects into child acceptance, including legacy snapshots", () => {
	for (const acceptance of [
		"引用证据并给出结论。",
		true,
		{ criteria: ["Graph supervisor criterion"] },
		{ level: "verified", arbitraryLegacyField: true },
	]) {
		assert.deepEqual(childAcceptanceFor({ acceptance }), DEFAULT_CHILD_ACCEPTANCE);
	}
});

test("childAcceptance explicitly opts into the child acceptance layer", () => {
	assert.equal(childAcceptanceFor({ childAcceptance: "checked" }), "checked");
	const configured = {
		level: "verified",
		criteria: [{ id: "proof", must: "Cite the verification output." }],
		evidence: ["validation-output"],
	} as const;
	assert.strictEqual(childAcceptanceFor({ childAcceptance: configured }), configured);
});

test("child dispatch defensively rejects invalid childAcceptance values", () => {
	assert.throws(() => childAcceptanceFor({ childAcceptance: true }), /childAcceptance/);
	assert.throws(() => childAcceptanceFor({ childAcceptance: "none" }), /childAcceptance/);
	assert.throws(() => childAcceptanceFor({ childAcceptance: { level: "unknown" } }), /level is unsupported/);
	assert.throws(() => childAcceptanceFor({ childAcceptance: { criteria: [{ must: "Missing id" }] } }), /\.id must be a non-empty string/);
});

test("task prompt includes string Graph acceptance for supervisor enforcement", () => {
	const prompt = promptFor(compiledNode({ acceptance: "引用证据并给出结论。" }));
	assert.match(prompt, /Acceptance criteria \(enforced by Graph supervisor\):/);
	assert.match(prompt, /引用证据并给出结论。/);
});

test("task prompt expands structured and validation-command Graph acceptance", () => {
	const structured = promptFor(compiledNode({
		acceptance: { criteria: ["Report source dates.", { id: "citations", must: "Cite every factual claim." }] },
	}));
	assert.match(structured, /- Report source dates\./);
	assert.match(structured, /- \[citations\] Cite every factual claim\./);

	const deterministic = promptFor(compiledNode({ acceptance: true, validationCommands: ["npm test"] }));
	assert.match(deterministic, /Acceptance is determined by the node's validationCommands\./);
	assert.match(deterministic, /- npm test/);
});

test("task prompt tolerates arbitrary legacy acceptance objects", () => {
	const legacyNode = compiledNode();
	(legacyNode as { acceptance?: unknown }).acceptance = { level: "verified" };
	assert.doesNotThrow(() => promptFor(legacyNode));
	assert.doesNotMatch(promptFor(legacyNode), /Acceptance criteria \(enforced by Graph supervisor\):/);
});
