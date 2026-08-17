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
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "unsafe", nodes: [node("a", { sideEffect: "external_write", idempotent: true, retryPolicy: { maxAttempts: 2 } })] } as GraphSpec, cwd), /contractPolicy 'strict'/);
	await writeFile(join(cwd, "target.md"), "x");
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "bash", nodes: [node("a", { sideEffect: "local_write", writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"], allowBash: true, retryPolicy: { maxAttempts: 2 } })] } as GraphSpec, cwd), /child Bash is disabled/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "runtime v2 bash", nodes: [node("a", { sideEffect: "local_write", writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"], allowBash: true })] } as GraphSpec, cwd, 20, 2), /child Bash is disabled/);
	assert.doesNotThrow(() => compileGraph({ schemaVersion: 1, goal: "runtime v2 package validator", nodes: [node("a", { sideEffect: "local_write", writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["npm test"] })] } as GraphSpec, cwd, 20, 2));
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "routed bash", nodes: [node("a", { sideEffect: "local_write", writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"], allowBash: true, routingProfile: "worker" })] } as GraphSpec, cwd), /child Bash is disabled/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "budget", nodes: [node("a", { retryPolicy: { maxAttempts: 2 } })] } as GraphSpec, cwd, 1), /exceed spawn budget/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "provider budget", nodes: [node("a", { retryPolicy: { maxAttempts: 1, maxProviderRetries: 2 } })] } as GraphSpec, cwd, 2), /exceed spawn budget/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "multiplicative provider budget", nodes: [node("a", { retryPolicy: { maxAttempts: 2, maxProviderRetries: 2 } })] } as GraphSpec, cwd, 4), /Worst-case 6 child launches/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "external provider retry", nodes: [node("a", { sideEffect: "external_write", retryPolicy: { maxAttempts: 1, maxProviderRetries: 1 } })] } as GraphSpec, cwd), /contractPolicy 'strict'/);
	const compiled = compileGraph({ schemaVersion: 1, goal: "provider retry", nodes: [node("a", { resourceClass: "provider:kimi", retryPolicy: { maxAttempts: 1, maxProviderRetries: 2 } })] } as GraphSpec, cwd, 3);
	assert.equal(compiled.workspace, "auto");
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "git provider retry", workspace: "git", nodes: [node("a", { retryPolicy: { maxAttempts: 1, maxProviderRetries: 1 } })] } as GraphSpec, cwd), /git workspace cannot use provider retries/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "git controlled routing", workspace: "git", nodes: [node("a", { routingProfile: "worker" })] } as GraphSpec, cwd), /git workspace cannot use controlled model routing/);
	assert.equal(compiled.nodes[0]?.retryPolicy.maxProviderRetries, 2);
	assert.equal(compiled.nodes[0]?.resourceClass, "provider:kimi");
});

test("typed outputs receive deterministic internal artifacts while legacy file outputs remain compatible", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-typed-output-"));
	const typed = compileGraph({ schemaVersion: 1, goal: "research", nodes: [{ taskId: "sources", agent: "researcher", task: "collect", output: { type: "citation-set", mediaType: "application/json" }, sideEffect: "external_read" }] } as GraphSpec, cwd);
	assert.equal(typed.nodes[0]?.outputArtifact, "_typed/sources.json");
	assert.equal(typed.nodes[0]?.output?.type, "citation-set");
	assert.equal(compileGraph({ schemaVersion: 1, goal: "legacy", nodes: [node("legacy")] } as GraphSpec, cwd).nodes[0]?.outputArtifact, "legacy.md");
	assert.equal(compileGraph({ schemaVersion: 1, goal: "path", nodes: [{ taskId: "typed", agent: "worker", task: "work", output: { type: "decision", path: "decisions/final.json" }, sideEffect: "none" }] } as GraphSpec, cwd).nodes[0]?.outputArtifact, "decisions/final.json");
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "conflict", nodes: [{ taskId: "typed", agent: "worker", task: "work", outputArtifact: "actual.json", output: { type: "json", path: "declared.json" }, sideEffect: "none" }] } as GraphSpec, cwd), /must resolve to the same artifact path/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "missing", nodes: [{ taskId: "missing", agent: "worker", task: "work", sideEffect: "none" }] } as GraphSpec, cwd), /outputArtifact or typed output/);
});

test("resource scope access cannot disguise an external write as a safe side effect", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-resource-scope-"));
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "masked", nodes: [node("masked", { resourceScopes: [{ kind: "connector", resource: "crm", access: "write" }], sideEffect: "none" })] } as GraphSpec, cwd), /write resourceScope requires sideEffect 'external_write'/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "masked read", nodes: [node("masked", { resourceScopes: [{ kind: "connector", resource: "crm", access: "read" }], sideEffect: "none" })] } as GraphSpec, cwd), /resourceScopes require an external sideEffect/);
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "read", nodes: [node("read", { capabilityId: "crm.read", acceptance: "Records are cited.", resourceScopes: [{ kind: "connector", resource: "crm", access: "read" }], sideEffect: "external_read" })] } as GraphSpec, cwd), /toolNames/);
	const remoteRead = node("read", { capabilityId: "mail.search", acceptance: "Messages are cited.", resourceScopes: [{ kind: "mailbox", resource: "primary", access: "read", toolNames: ["gmail_search"], toolInput: { query: "from:example" } }], sideEffect: "external_read" });
	assert.doesNotThrow(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "read", nodes: [remoteRead] } as GraphSpec, cwd, 20, 2));
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "masked write", nodes: [node("read", { ...remoteRead, resourceScopes: [{ kind: "mailbox", resource: "primary", access: "read", toolNames: ["gmail_send_email"], toolInput: { to: "x@example.com" } }] })] } as GraphSpec, cwd, 20, 2), /read-only tools/);
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "camel case masked write", nodes: [node("read", { ...remoteRead, resourceScopes: [{ kind: "mailbox", resource: "primary", access: "read", toolNames: ["gmail_get_deleteMessage"], toolInput: { id: "message-1" } }] })] } as GraphSpec, cwd, 20, 2), /read-only tools/);
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "camel case send", nodes: [node("read", { ...remoteRead, resourceScopes: [{ kind: "mailbox", resource: "primary", access: "read", toolNames: ["gmailGetSendNow"], toolInput: { id: "message-1" } }] })] } as GraphSpec, cwd, 20, 2), /read-only tools/);
	for (const toolName of ["gmail_mark_as_read", "gmailGetMarkRead", "gmail_get_trashMessage", "gmail_readAndArchive"]) {
		assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "semantic masked write", nodes: [node("read", { ...remoteRead, resourceScopes: [{ kind: "mailbox", resource: "primary", access: "read", toolNames: [toolName], toolInput: { id: "message-1" } }] })] } as GraphSpec, cwd, 20, 2), /read-only tools/);
	}
	assert.doesNotThrow(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "camel case read", nodes: [node("read", { ...remoteRead, resourceScopes: [{ kind: "mailbox", resource: "primary", access: "read", toolNames: ["gmailGetMessage"], toolInput: { id: "message-1" } }] })] } as GraphSpec, cwd, 20, 2));
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "unbound read", nodes: [node("read", { ...remoteRead, resourceScopes: [{ kind: "mailbox", resource: "primary", access: "read", toolNames: ["gmail_search"] }] })] } as GraphSpec, cwd, 20, 2), /exact toolInput/);
});

test("compiler rejects direct writes into runtime and repository control directories", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-control-scope-"));
	for (const path of [".pi-graph/node-contract.json", ".pi/agents/worker.md", ".pi-subagents/state.json", ".git/config"]) {
		assert.throws(() => compileGraph({ schemaVersion: 1, goal: "control file", nodes: [node("writer", { sideEffect: "local_write", writeScope: [{ kind: "file", path }], validationCommands: ["test -f target.md"] })] } as GraphSpec, cwd), /protected Graph runtime, Agent, or Git control paths/);
	}
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "control tree", nodes: [node("writer", { sideEffect: "local_write", writeScope: [{ kind: "tree", path: ".pi-graph" }], atomic: true, scopeJustification: "invalid control scope", validationCommands: ["test -f target.md"] })] } as GraphSpec, cwd), /protected Graph runtime, Agent, or Git control paths/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "nested control", nodes: [node("writer", { sideEffect: "local_write", writeScope: [{ kind: "tree", path: "nested/.git" }], atomic: true, scopeJustification: "invalid nested control scope", validationCommands: ["test -f target.md"] })] } as GraphSpec, cwd), /protected Graph runtime, Agent, or Git control paths/);
});

test("strict external writes require target scope, approval, idempotency, readback, and compensation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-external-contract-"));
	const externalNode = {
		taskId: "send", agent: "worker", task: "send approved message", capabilityId: "mail.send", output: { type: "connector-record" as const }, sideEffect: "external_write" as const,
		acceptance: "The remote record is read back and matches the expected state.", resourceScopes: [{ kind: "mailbox" as const, resource: "account:primary/outbox", access: "write" as const }],
		externalAction: { service: "mail", account: "primary", action: "send", target: "message:approved", idempotencyKey: "send-approved-v1", requiresApproval: true, approvalRef: "approval:user-turn-7", reversible: true, compensation: "Delete the draft or send a correction if delivery cannot be recalled.", expectedState: "One sent message with the approved content.", verifyByReadback: true },
		idempotent: true, retryPolicy: { maxAttempts: 2, maxProviderRetries: 1 },
	};
	assert.doesNotThrow(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "send", nodes: [externalNode] } as GraphSpec, cwd, 5, 1));
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "send", nodes: [externalNode] } as GraphSpec, cwd, 5, 2), /trusted approval broker/);
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "send", nodes: [{ ...externalNode, resourceScopes: [] }] } as GraphSpec, cwd), /write resourceScope/);
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "send", nodes: [{ ...externalNode, externalAction: { ...externalNode.externalAction, approvalRef: undefined } }] } as GraphSpec, cwd), /approvalRef/);
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "send", nodes: [{ ...externalNode, externalAction: { ...externalNode.externalAction, idempotencyKey: undefined } }] } as GraphSpec, cwd), /idempotencyKey/);
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "send", nodes: [{ ...externalNode, externalAction: { ...externalNode.externalAction, verifyByReadback: false } }] } as GraphSpec, cwd), /verifyByReadback/);
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "send", nodes: [{ ...externalNode, externalAction: { ...externalNode.externalAction, compensation: undefined } }] } as GraphSpec, cwd), /compensation/);
	assert.throws(() => compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "send", nodes: [{ ...externalNode, externalAction: { ...externalNode.externalAction, reversible: false }, retryPolicy: { maxAttempts: 2, maxProviderRetries: 0 } }] } as GraphSpec, cwd), /irreversible external writes cannot retry/);
});

test("thinking overrides require an explicit unsuffixed model", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-compile-"));
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "thinking", nodes: [node("a", { thinking: "high" })] } as GraphSpec, cwd), /requires an explicit model/);
	assert.throws(() => compileGraph({ schemaVersion: 1, goal: "thinking", nodes: [node("a", { model: "openai-codex/gpt-5.6-sol:max", thinking: "high" })] } as GraphSpec, cwd), /not both/);
	// D1: max-authorization admission (model-table "structured authorization" validation) moved to the
	// governance archive; a legacy `thinking: "max"` spec compiles as frozen pass-through instead.
	assert.doesNotThrow(() => compileGraph({ schemaVersion: 1, graphId: "thinking-max", goal: "thinking", nodes: [node("a", { model: "openai-codex/gpt-5.6-sol", thinking: "max" })] } as GraphSpec, cwd));
	assert.doesNotThrow(() => compileGraph({ schemaVersion: 1, goal: "thinking", nodes: [node("a", { model: "openai-codex/gpt-5.6-sol", thinking: "high" })] } as GraphSpec, cwd));
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

test("compiler rejects read and write scopes that intersect the configured Graph runs root", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-protected-runs-"));
	const runsRoot = join(cwd, "graph-runs");
	assert.throws(() => compileGraph({
		schemaVersion: 1,
		goal: "read runtime state",
		nodes: [node("reader", { readScope: [{ kind: "tree", path: "graph-runs/.control" }] })],
	} as GraphSpec, cwd, 20, 2, [runsRoot]), /readScope intersects protected Graph runs root/);
	assert.throws(() => compileGraph({
		schemaVersion: 1,
		goal: "write runtime state",
		nodes: [node("writer", {
			sideEffect: "local_write",
			writeScope: [{ kind: "file", path: "graph-runs/other/snapshot.json" }],
			validationCommands: ["test -f graph-runs/other/snapshot.json"],
		})],
	} as GraphSpec, cwd, 20, 2, [runsRoot]), /writeScope intersects protected Graph runs root/);
});
