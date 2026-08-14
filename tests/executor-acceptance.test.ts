import assert from "node:assert/strict";
import test from "node:test";
import { childAcceptanceFor, taskPrompt, validateTypedOutput } from "../src/executor.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("task prompt declares string Graph acceptance without claiming semantic machine enforcement", () => {
	const prompt = promptFor(compiledNode({ acceptance: "引用证据并给出结论。" }));
	assert.match(prompt, /persisted for Supervisor\/parent inspection/);
	assert.doesNotMatch(prompt, /enforced by Graph supervisor/);
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

test("typed outputs enforce format, media type, and inline JSON Schema", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-typed-acceptance-"));
	const path = join(cwd, "output.json");
	const citationNode = compiledNode({ output: { type: "citation-set", mediaType: "application/json", schema: JSON.stringify({ type: "array", minItems: 1 }) } });
	await writeFile(path, JSON.stringify([{ url: "https://example.com", title: "Example" }]));
	await assert.doesNotReject(validateTypedOutput(citationNode, path));
	await writeFile(path, "not json");
	await assert.rejects(validateTypedOutput(citationNode, path), /valid JSON/);
	await writeFile(path, JSON.stringify([{ title: "missing url" }]));
	await assert.rejects(validateTypedOutput(citationNode, path), /absolute HTTP/);
	await writeFile(path, JSON.stringify([]));
	await assert.rejects(validateTypedOutput(citationNode, path), /JSON Schema/);
	await writeFile(path, Buffer.from([0xff, 0xfe, 0x41]));
	await assert.rejects(validateTypedOutput(compiledNode({ output: { type: "text" } }), path), /valid UTF-8/);
});

test("task prompt tolerates arbitrary legacy acceptance objects", () => {
	const legacyNode = compiledNode();
	(legacyNode as { acceptance?: unknown }).acceptance = { level: "verified" };
	assert.doesNotThrow(() => promptFor(legacyNode));
	assert.doesNotMatch(promptFor(legacyNode), /Graph acceptance criteria/);
});
