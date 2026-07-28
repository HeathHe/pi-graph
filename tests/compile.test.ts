import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileGraph, GraphCompileError } from "../src/compile.ts";
import type { GraphSpec } from "../src/types.ts";

function node(taskId: string, overrides: Record<string, unknown> = {}) {
	return { taskId, agent: "researcher", task: `do ${taskId}`, outputArtifact: `${taskId}.md`, sideEffect: "none", ...overrides };
}

test("compiler produces stable topological order for an arbitrary DAG", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	const graph = compileGraph({ schemaVersion: 1, goal: "test", nodes: [node("join", { dependsOn: ["a", "b"] }), node("b"), node("a")] } as GraphSpec, cwd);
	assert.deepEqual(graph.topologicalOrder, ["a", "b", "join"]);
	assert.equal(graph.maxConcurrency, 2);
});

test("compiler rejects cycles and unordered overlapping writers", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	await writeFile(join(cwd, "shared.md"), "x");
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "cycle", nodes: [node("a", { dependsOn: ["b"] }), node("b", { dependsOn: ["a"] })] } as GraphSpec, cwd), GraphCompileError);
	assert.throws(() => compileGraph({
		schemaVersion: 1,
		goal: "writers",
		nodes: [
			node("a", { sideEffect: "local_write", writeScope: [{ kind: "file", path: "shared.md" }], validationCommands: ["test -f shared.md"] }),
			node("b", { sideEffect: "local_write", writeScope: [{ kind: "file", path: "shared.md" }], validationCommands: ["test -f shared.md"] }),
		],
	} as GraphSpec, cwd), /overlapping writeScope/);
});

test("compiler normalizes artifacts and validates management ids", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	assert.throws(() => compileGraph({ schemaVersion: 1, graphId: "../escape", goal: "bad", nodes: [node("a")] } as GraphSpec, cwd), /graphId/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "duplicate", nodes: [node("a", { outputArtifact: "dir/../same.md" }), node("b", { outputArtifact: "same.md" })] } as GraphSpec, cwd), /normalization/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "bad input", nodes: [node("a"), node("b", { dependsOn: ["a"], inputArtifacts: [42] })] } as unknown as GraphSpec, cwd), /non-empty strings/);
});

test("compiler rejects artifact prefix conflicts and malformed runtime values", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	assert.throws(() => compileGraph({ schemaVersion: 1, graphId: 123, goal: "bad", nodes: [node("a")] } as unknown as GraphSpec, cwd), /graphId/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "prefix", nodes: [node("a", { outputArtifact: "foo" }), node("b", { outputArtifact: "foo/bar.md" })] } as GraphSpec, cwd), /Conflicting outputArtifact/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "retry", nodes: [node("a", { retryPolicy: [] })] } as unknown as GraphSpec, cwd), /retryPolicy must be an object/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "acceptance", nodes: [node("a", { acceptance: [] })] } as unknown as GraphSpec, cwd), /acceptance/);
});

test("compiler normalizes Graph and child acceptance inputs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	const graph = compileGraph({
		schemaVersion: 1,
		goal: "acceptance",
		nodes: [node("a", {
			acceptance: { criteria: ["  Cite sources.  ", { id: " proof ", must: " Show validation output. " }] },
			childAcceptance: { level: "checked", criteria: ["  Child report is complete.  ", { id: "child-proof", must: " Include evidence. " }] },
		})],
	} as GraphSpec, cwd);
	assert.deepEqual(graph.nodes[0]?.acceptance, {
		criteria: ["Cite sources.", { id: "proof", must: "Show validation output." }],
	});
	assert.deepEqual(graph.nodes[0]?.childAcceptance, {
		level: "checked",
		criteria: ["Child report is complete.", { id: "child-proof", must: "Include evidence." }],
	});
});

test("compiler rejects malformed Graph and child acceptance inputs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	for (const acceptance of ["   ", null, [], {}, { criteria: [] }, { criteria: [""] }, { criteria: [{ id: "only-id" }] }, { level: "verified" }]) {
		assert.throws(
			() => compileGraph({ schemaVersion: 1, goal: "bad acceptance", nodes: [node("a", { acceptance })] } as unknown as GraphSpec, cwd),
			/acceptance/,
		);
	}
	assert.throws(
		() => compileGraph({ schemaVersion: 1, goal: "bad child level", nodes: [node("a", { childAcceptance: { level: "unknown" } })] } as unknown as GraphSpec, cwd),
		/childAcceptance\.level is unsupported/,
	);
	assert.throws(
		() => compileGraph({ schemaVersion: 1, goal: "bad child criteria", nodes: [node("a", { childAcceptance: { criteria: [{ must: "Missing id" }] } })] } as unknown as GraphSpec, cwd),
		/childAcceptance\.criteria\[0\]\.id/,
	);
});

test("compiler verifies existing scope kinds", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	await mkdir(join(cwd, "directory"));
	await writeFile(join(cwd, "file.md"), "x");
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "kind", nodes: [node("a", { readScope: [{ kind: "file", path: "directory" }] })] } as GraphSpec, cwd), /non-file/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "kind", nodes: [node("a", { readScope: [{ kind: "tree", path: "file.md" }] })] } as GraphSpec, cwd), /non-directory/);
});

test("input artifacts require a dependency path from their producer", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "artifact", nodes: [node("a"), node("b", { inputArtifacts: ["a.md"] })] } as GraphSpec, cwd), /requires a dependency path/);
	assert.doesNotThrow(() => compileGraph({ schemaVersion: 1, goal: "artifact", nodes: [node("a"), node("b", { dependsOn: ["a"], inputArtifacts: ["a.md"] })] } as GraphSpec, cwd));
});

test("compiler rejects unsafe retry and excessive spawn budget", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "unsafe", nodes: [node("a", { sideEffect: "external_write", idempotent: true, retryPolicy: { maxAttempts: 2 } })] } as GraphSpec, cwd), /external writes cannot retry/);
	await writeFile(join(cwd, "target.md"), "x");
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "bash", nodes: [node("a", { sideEffect: "local_write", writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"], allowBash: true, retryPolicy: { maxAttempts: 2 } })] } as GraphSpec, cwd), /bash-enabled local writes cannot retry/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "budget", nodes: [node("a", { retryPolicy: { maxAttempts: 2 } })] } as GraphSpec, cwd, 1), /exceed spawn budget/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "provider budget", nodes: [node("a", { retryPolicy: { maxAttempts: 1, maxProviderRetries: 2 } })] } as GraphSpec, cwd, 2), /exceed spawn budget/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "external provider retry", nodes: [node("a", { sideEffect: "external_write", retryPolicy: { maxAttempts: 1, maxProviderRetries: 1 } })] } as GraphSpec, cwd), /external writes cannot use provider retries/);
	const compiled = compileGraph({ schemaVersion: 1, goal: "provider retry", nodes: [node("a", { resourceClass: "provider:kimi", retryPolicy: { maxAttempts: 1, maxProviderRetries: 2 } })] } as GraphSpec, cwd, 3);
	assert.equal(compiled.nodes[0]?.retryPolicy.maxProviderRetries, 2);
	assert.equal(compiled.nodes[0]?.resourceClass, "provider:kimi");
});

test("thinking overrides require an explicit unsuffixed model", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "thinking", nodes: [node("a", { thinking: "high" })] } as GraphSpec, cwd), /requires an explicit model/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "thinking", nodes: [node("a", { model: "openai-codex/gpt-5.6-sol:max", thinking: "high" })] } as GraphSpec, cwd), /not both/);
	assert.doesNotThrow(() => compileGraph({ schemaVersion: 1, goal: "thinking", nodes: [node("a", { model: "openai-codex/gpt-5.6-sol", thinking: "max" })] } as GraphSpec, cwd));
});

test("strict contract policy gates capability and acceptance without breaking legacy specs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	assert.doesNotThrow(() => compileGraph({ schemaVersion: 1, goal: "legacy", nodes: [node("a")] } as GraphSpec, cwd));
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "strict", nodes: [node("a")] } as GraphSpec, cwd), /requires capabilityId/);
	assert.throws(() => compileGraph({
		schemaVersion: 1,
		contractPolicy: "strict",
		goal: "strict",
		nodes: [node("a", { capabilityId: "read.research" })],
	} as GraphSpec, cwd), /requires observable acceptance/);
	assert.throws(() => compileGraph({
		schemaVersion: 1,
		contractPolicy: "strict",
		goal: "strict false",
		nodes: [node("a", { capabilityId: "read.research", acceptance: false })],
	} as GraphSpec, cwd), /requires observable acceptance/);
	assert.throws(() => compileGraph({
		schemaVersion: 1,
		contractPolicy: "strict",
		goal: "strict empty",
		nodes: [node("a", { capabilityId: "read.research", acceptance: {} })],
	} as unknown as GraphSpec, cwd), /acceptance\.criteria/);
	assert.doesNotThrow(() => compileGraph({
		schemaVersion: 1,
		contractPolicy: "strict",
		goal: "strict",
		nodes: [node("a", { capabilityId: "read.research", acceptance: "Evidence is cited." })],
	} as GraphSpec, cwd));
	assert.doesNotThrow(() => compileGraph({
		schemaVersion: 1,
		contractPolicy: "strict",
		goal: "strict deterministic",
		nodes: [node("a", { capabilityId: "read.research", acceptance: true, validationCommands: ["test -f package.json"] })],
	} as GraphSpec, cwd));
});
