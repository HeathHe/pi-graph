import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import graphGuard, { clampProviderPayloadMaxTokens, remoteToolViolation } from "../extensions/pi-graph-guard.ts";
import { canonicalDigest } from "../src/v3/digests.ts";
import { isReadOnlyRemoteToolName } from "../src/v3/remote-tools.ts";
import { prepareV3Workspace } from "../src/v3/workspace.ts";
import type { CompiledGraphNodeV3 } from "../src/v3/types.ts";
import type { V3NodeContract } from "../src/v3/workspace.ts";

interface GuardDecision {
	block: true;
	reason: string;
}

type GuardHandler = (
	event: { toolName: string; input: Record<string, unknown> },
	ctx: { cwd: string; abort?: () => void },
) => GuardDecision | undefined;
type ProviderGuardHandler = (
	event: { payload: unknown },
	ctx: { cwd: string; abort(): void; modelRegistry?: { getRegisteredProviderIds?: () => readonly string[] } },
) => unknown;
type InputGuardHandler = (
	event: Record<string, unknown>,
	ctx: {
		cwd: string;
		model?: { provider?: string };
		modelRegistry?: { getRegisteredProviderIds?: () => readonly string[] };
	},
) => { action: "continue" | "handled" } | undefined;

function graphBindings(contract: V3NodeContract): Record<string, unknown> {
	return {
		"pi-graph/1": {
			schemaVersion: 1,
			graphId: contract.graphId,
			taskId: contract.taskId,
			attempt: contract.attempt,
			workspaceCwd: contract.workspaceCwd,
			contractDigest: canonicalDigest(contract),
		},
	};
}

function withChildEnvironment<T>(extensionBindings: unknown, run: () => T): T {
	const previous = process.env.PI_GRAPH_CHILD;
	const previousBindings = process.env.PI_GRAPH_EXTENSION_BINDINGS;
	process.env.PI_GRAPH_CHILD = "1";
	if (extensionBindings === undefined) delete process.env.PI_GRAPH_EXTENSION_BINDINGS;
	else process.env.PI_GRAPH_EXTENSION_BINDINGS = typeof extensionBindings === "string"
		? extensionBindings
		: JSON.stringify(extensionBindings);
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.PI_GRAPH_CHILD;
		else process.env.PI_GRAPH_CHILD = previous;
		if (previousBindings === undefined) delete process.env.PI_GRAPH_EXTENSION_BINDINGS;
		else process.env.PI_GRAPH_EXTENSION_BINDINGS = previousBindings;
	}
}

function registerGuard(contract: V3NodeContract, extensionBindings: unknown = graphBindings(contract)): GuardHandler {
	let handler: GuardHandler | undefined;
	let acknowledged = false;
	withChildEnvironment(extensionBindings, () => {
		graphGuard({ registerTool: () => undefined,
			events: {
				emit: (name: string, payload: unknown) => {
					acknowledged = name === "pi-graph:acknowledge-extension"
						&& (payload as { id?: unknown }).id === "pi-graph-guard";
				},
			},
			on: (name: string, value: GuardHandler) => {
				if (name === "tool_call") handler = value;
			},
		} as never);
	});
	assert.equal(acknowledged, true);
	assert.ok(handler);
	const registered = handler;
	return (event, ctx) => registered(event, { ...ctx, abort: ctx.abort ?? (() => undefined) });
}

function registerProviderGuard(contract: V3NodeContract, extensionBindings: unknown = graphBindings(contract)): ProviderGuardHandler {
	let handler: ProviderGuardHandler | undefined;
	withChildEnvironment(extensionBindings, () => {
		graphGuard({ registerTool: () => undefined,
			events: { emit: () => undefined },
			on: (name: string, value: ProviderGuardHandler) => {
				if (name === "before_provider_request") handler = value;
			},
		} as never);
	});
	assert.ok(handler);
	return handler;
}

function registerInputGuard(contract: V3NodeContract, extensionBindings: unknown = graphBindings(contract)): InputGuardHandler {
	let handler: InputGuardHandler | undefined;
	withChildEnvironment(extensionBindings, () => {
		graphGuard({ registerTool: () => undefined,
			events: { emit: () => undefined },
			on: (name: string, value: InputGuardHandler) => {
				if (name === "input") handler = value;
			},
		} as never);
	});
	assert.ok(handler);
	return handler;
}

function nodeContract(cwd: string, overrides: Partial<V3NodeContract> = {}): V3NodeContract {
	return {
		schemaVersion: 1,
		graphId: "graph-test",
		taskId: "node-test",
		attempt: 1,
		attemptDir: join(cwd, "attempt-1"),
		sourceCwd: cwd,
		workspaceCwd: cwd,
		readScope: [],
		writeScope: [],
		sideEffect: "none",
		allowBash: false,
		readOnly: false,
		toolFilter: [],
		writeBaseline: {},
		readBaseline: {},
		protectedSourceRoots: [],
		protectedWorkspaceRoots: [],
		inputBaseline: {},
		...overrides,
	};
}

async function guardFixture(overrides: Partial<V3NodeContract> = {}): Promise<{
	cwd: string;
	handler: GuardHandler;
	writeContract(contract: object): Promise<void>;
}> {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-graph-v3-guard-")));
	await mkdir(join(cwd, ".pi-graph"));
	const writeContract = async (contract: object) => {
		await writeFile(join(cwd, ".pi-graph", "node-contract.json"), `${JSON.stringify(contract)}\n`, "utf8");
	};
	const contract = nodeContract(cwd, overrides);
	await writeContract(contract);
	return { cwd, handler: registerGuard(contract), writeContract };
}

function assertBlocked(decision: GuardDecision | undefined, pattern: RegExp): void {
	assert.equal(decision?.block, true);
	assert.match(decision?.reason ?? "", pattern);
}

test("V3 remote tool classifier accepts conservative reads and rejects mutations", () => {
	for (const toolName of [
		"web_search",
		"fetch_content",
		"get_search_content",
		"gmail_search",
		"googleDriveListFiles",
		"notion_query_database",
	]) {
		assert.equal(isReadOnlyRemoteToolName(toolName), true, toolName);
		assert.equal(remoteToolViolation(toolName, { toolFilter: [toolName] }), null, toolName);
	}

	for (const toolName of [
		"gmail_send_email",
		"gmail_get_deleteMessage",
		"gmail_mark_as_read",
		"gmailGetMarkRead",
		"slack_post_message",
		"calendar_create_event",
		"drive_search_and_delete",
		"unknown_connector_action",
	]) {
		assert.equal(isReadOnlyRemoteToolName(toolName), false, toolName);
		assert.match(remoteToolViolation(toolName, { toolFilter: [toolName] }) ?? "", /not an attested read-only/u, toolName);
	}

	assert.match(
		remoteToolViolation("gmail_search", { toolFilter: ["web_search"] }) ?? "",
		/outside the exact graph toolFilter/u,
	);
});

test("Graph Guard permits only exact toolFilter remote reads", async () => {
	const { cwd, handler } = await guardFixture({
		readOnly: true,
		toolFilter: ["web_search", "fetch_content", "get_search_content", "gmail_send_email"],
	});
	assert.equal(handler({ toolName: "web_search", input: { query: "durable DAG" } }, { cwd }), undefined);
	assert.equal(handler({ toolName: "fetch_content", input: { url: "https://example.test" } }, { cwd }), undefined);
	assert.equal(handler({ toolName: "get_search_content", input: { id: "result-1" } }, { cwd }), undefined);
	assertBlocked(handler({ toolName: "gmail_search", input: { query: "anything" } }, { cwd }), /outside the graph toolFilter/u);
	assertBlocked(handler({ toolName: "gmail_send_email", input: { to: "x@example.test" } }, { cwd }), /not an attested read-only/u);
});

test("Graph Guard denies legacy communication even with explicit old tool opt-in", async () => {
	const { cwd, handler } = await guardFixture({
		readOnly: true,
		toolFilter: ["contact_supervisor", "read", "write", "bash", "intercom", "subagent", "subagent_supervisor", "unknown_connector_action"],
	});
	try {
		for (const input of [
			{ reason: "need_decision", message: "Need an approved scope decision." },
			{ reason: "progress_update", message: "Implementation applied." },
			{ reason: "interview_request", interview: { title: "Scope", questions: [{ filePath: "/original/source.ts", cwd: "~", question: "Which scope?" }] } },
		]) {
			assertBlocked(handler({ toolName: "contact_supervisor", input }, { cwd }), /only graph_mailbox/);
		}
		assert.equal(isReadOnlyRemoteToolName("contact_supervisor"), false, "coordination is not reclassified as read-only remote I/O");
		for (const toolName of ["intercom", "subagent", "subagent_supervisor", "unknown_connector_action"]) {
			assertBlocked(handler({ toolName, input: {} }, { cwd }), /only graph_mailbox|not an attested read-only/u);
		}
		assertBlocked(handler({ toolName: "fetch_content", input: { url: "https://example.test" } }, { cwd }), /outside the graph toolFilter/u);
		assertBlocked(handler({ toolName: "read", input: { path: "/original/source.ts" } }, { cwd }), /outside declared read scope/u);
		assertBlocked(handler({ toolName: "write", input: { path: "new.ts", content: "no" } }, { cwd }), /read-only/u);
		assertBlocked(handler({ toolName: "bash", input: { command: "pwd" } }, { cwd }), /bash is disabled/u);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("Graph Guard always denies retired contact_supervisor regardless of filter", async () => {
	for (const toolFilter of [[], ["read"], ["contact_supervisor_extra"], ["Contact_supervisor"]]) {
		const { cwd, handler } = await guardFixture({ toolFilter });
		try {
			assertBlocked(handler({ toolName: "contact_supervisor", input: { reason: "need_decision", message: "blocked" } }, { cwd }), /only graph_mailbox/u);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}
});

test("native supervisor contact cannot bypass missing, malformed, changed contracts or invalid bindings", async () => {
	const { cwd, handler, writeContract } = await guardFixture({ toolFilter: ["contact_supervisor"] });
	const contract = nodeContract(cwd, { toolFilter: ["contact_supervisor"] });
	const event = { toolName: "contact_supervisor", input: { reason: "need_decision", message: "blocked" } };
	let aborts = 0;
	const ctx = { cwd, abort: () => { aborts += 1; } };
	try {
		await rm(join(cwd, ".pi-graph", "node-contract.json"));
		assertBlocked(handler(event, ctx), /failing closed/u);
		await writeFile(join(cwd, ".pi-graph", "node-contract.json"), "not-json");
		assertBlocked(handler(event, ctx), /failing closed/u);
		const malformed = { ...contract, allowBash: true } as unknown as V3NodeContract;
		await writeContract(malformed);
		assertBlocked(registerGuard(malformed)(event, ctx), /failing closed/u);
		await writeContract({ ...contract, readOnly: true });
		assertBlocked(handler(event, ctx), /failing closed/u);
		await writeContract(contract);
		assertBlocked(registerGuard(contract, { "pi-graph/1": {} })(event, ctx), /failing closed/u);
		assert.equal(aborts, 5);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("Graph Guard enforces toolFilter and readOnly for local file tools", async () => {
	const { cwd, writeContract } = await guardFixture();
	await writeFile(join(cwd, "allowed.md"), "before\n", "utf8");
	const contract = nodeContract(cwd, {
		readOnly: true,
		toolFilter: ["read", "write", "edit"],
		readScope: [{ kind: "file", path: join(cwd, "allowed.md") }],
		writeScope: [{ kind: "file", path: join(cwd, "allowed.md") }],
	});
	await writeContract(contract);
	const handler = registerGuard(contract);

	assert.equal(handler({ toolName: "read", input: { path: "allowed.md" } }, { cwd }), undefined);
	assertBlocked(handler({ toolName: "grep", input: { path: "allowed.md", pattern: "before" } }, { cwd }), /outside the graph toolFilter/u);
	assertBlocked(handler({ toolName: "write", input: { path: "allowed.md", content: "after" } }, { cwd }), /graph is read-only/u);
	assertBlocked(handler({ toolName: "edit", input: { path: "allowed.md", oldText: "before", newText: "after" } }, { cwd }), /graph is read-only/u);
});

test("Graph Guard allows declared local writes only for a writable V3 graph", async () => {
	const { cwd, writeContract } = await guardFixture();
	await writeFile(join(cwd, "allowed.md"), "before\n", "utf8");
	const contract = nodeContract(cwd, {
		writeScope: [{ kind: "file", path: join(cwd, "allowed.md") }],
		sideEffect: "local_write",
	});
	await writeContract(contract);
	const handler = registerGuard(contract);

	assert.equal(handler({ toolName: "write", input: { path: "allowed.md", content: "after" } }, { cwd }), undefined);
	assert.equal(handler({ toolName: "read", input: { path: "allowed.md" } }, { cwd }), undefined);
	assertBlocked(handler({ toolName: "write", input: { path: "outside.md", content: "no" } }, { cwd }), /outside declared write scope/u);
	assertBlocked(handler({ toolName: "read", input: { path: "outside.md" } }, { cwd }), /outside declared read scope/u);
});

test("Graph Guard always rejects bash", async () => {
	const { cwd, handler, writeContract } = await guardFixture({ toolFilter: ["bash"] });
	assertBlocked(handler({ toolName: "bash", input: { command: "pwd" } }, { cwd }), /bash is disabled/u);

	const invalidContract = { ...nodeContract(cwd, { toolFilter: ["bash"] }), allowBash: true } as unknown as V3NodeContract;
	await writeContract(invalidContract);
	assertBlocked(registerGuard(invalidContract)({ toolName: "bash", input: { command: "pwd" } }, { cwd }), /contract.*malformed/u);
});

test("Graph Guard clamps provider-native output token fields without mutating the input", () => {
	const payloads = [
		{ max_tokens: 32_000, model: "anthropic" },
		{ max_completion_tokens: 32_000, model: "openai-chat" },
		{ max_output_tokens: 32_000, model: "openai-responses" },
		{ maxTokens: 32_000, model: "mistral" },
		{ options: { maxTokens: 32_000 }, context: {}, model: "pi-messages" },
		{ inferenceConfig: { maxTokens: 32_000 }, modelId: "bedrock" },
		{ generationConfig: { maxOutputTokens: 32_000 }, contents: [] },
	] as const;
	for (const payload of payloads) {
		const before = JSON.stringify(payload);
		const result = clampProviderPayloadMaxTokens(payload, 4_096);
		assert.equal(result.ok, true);
		assert.equal(JSON.stringify(payload), before);
		assert.match(JSON.stringify(result.ok ? result.payload : {}), /4096/u);
	}
	const codex = clampProviderPayloadMaxTokens({ model: "gpt", input: [], instructions: "work", text: { verbosity: "low" } }, 2_048);
	assert.equal(codex.ok, true);
	assert.equal(codex.ok ? codex.payload.max_output_tokens : undefined, 2_048);
	assert.deepEqual(clampProviderPayloadMaxTokens({ arbitrary: true }, 1_024), { ok: false });
});

test("Graph Guard enforces maxTokens at the child provider boundary and fails closed for unknown payloads", async () => {
	const { cwd, writeContract } = await guardFixture({ maxTokens: 2_048 });
	const initial = nodeContract(cwd, { maxTokens: 2_048 });
	const handler = registerProviderGuard(initial);
	let aborts = 0;
	const ctx = { cwd, abort: () => { aborts += 1; } };
	assert.deepEqual(
		handler({ payload: { model: "test", max_tokens: 8_192 } }, ctx),
		{ model: "test", max_tokens: 2_048 },
	);
	assert.equal(aborts, 0);
	assert.equal(handler({ payload: { arbitrary: true } }, ctx), null);
	assert.equal(aborts, 1);

	const withoutLimit = nodeContract(cwd);
	await writeContract(withoutLimit);
	assert.equal(registerProviderGuard(withoutLimit)({ payload: { arbitrary: true } }, ctx), undefined);
	assert.equal(aborts, 1);
	const invalidLimit = { ...nodeContract(cwd), maxTokens: 1 } as V3NodeContract;
	await writeContract(invalidLimit);
	assert.equal(registerProviderGuard(invalidLimit)({ payload: { max_tokens: 8_192 } }, ctx), null);
	assert.equal(aborts, 2);
});

test("Graph Guard handles input before extension-registered streamSimple Providers can bypass payload hooks", async () => {
	const { cwd } = await guardFixture();
	const contract = nodeContract(cwd);
	const handler = registerInputGuard(contract);

	assert.deepEqual(handler({}, {
		cwd,
		model: { provider: "models-json-provider" },
		modelRegistry: { getRegisteredProviderIds: () => ["child-extension-provider"] },
	}), { action: "continue" }, "standard models.json Providers remain admitted");

	assert.deepEqual(handler({}, {
		cwd,
		model: { provider: "child-extension-provider" },
		modelRegistry: { getRegisteredProviderIds: () => ["child-extension-provider"] },
	}), { action: "handled" }, "an extension-registered Provider must be stopped before its stream starts");

	assert.deepEqual(handler({}, { cwd, model: { provider: "unknown" } }), { action: "handled" }, "missing Provider-registration evidence fails closed");
});

test("Graph Guard accepts normalized nested artifact names in required contracts", async () => {
	const { cwd, writeContract } = await guardFixture();
	const contract = nodeContract(cwd, {
		inputBaseline: {
			"graph/research/out": { sourcePath: join(cwd, "artifact.md"), digest: null },
		},
	});
	await writeContract(contract);
	const handler = registerInputGuard(contract);
	assert.deepEqual(handler({}, {
		cwd,
		model: { provider: "models-json-provider" },
		modelRegistry: { getRegisteredProviderIds: () => [] },
	}), { action: "continue" });
});

test("Graph Guard blocks path-bearing pseudo-remote tools and protected control paths", async () => {
	const { cwd, writeContract } = await guardFixture();
	await mkdir(join(cwd, "nested", ".git"), { recursive: true });
	await writeFile(join(cwd, "nested", ".git", "config"), "secret\n", "utf8");
	const contract = nodeContract(cwd, {
		readScope: [{ kind: "tree", path: cwd }],
		writeScope: [{ kind: "tree", path: cwd }],
		sideEffect: "local_write",
		toolFilter: ["read", "write", "custom_reader"],
	});
	await writeContract(contract);
	const handler = registerGuard(contract);

	assertBlocked(handler({ toolName: "custom_reader", input: { filePath: "/etc/passwd" } }, { cwd }), /path-bearing tool/u);
	assertBlocked(handler({ toolName: "read", input: { path: "nested/.git/config" } }, { cwd }), /control paths/u);
	assertBlocked(handler({ toolName: "write", input: { path: ".pi-graph/node-contract.json", content: "{}" } }, { cwd }), /control files are read-only/u);
	assertBlocked(handler({ toolName: "read", input: { path: ".pi/agents/researcher.md" } }, { cwd }), /control paths|not child-readable/u);
	assertBlocked(handler({ toolName: "read", input: { path: "../outside.txt" } }, { cwd }), /outside declared read scope/u);
});

test("Graph Guard rejects the removed legacy contract field and malformed V3 contracts", async () => {
	const { cwd, writeContract } = await guardFixture();
	for (const legacyField of [{ resourceScopes: [] }, { extensionProviderIds: ["legacy-provider"] }]) {
		const legacy = { ...nodeContract(cwd), ...legacyField } as unknown as V3NodeContract;
		await writeContract(legacy);
		assertBlocked(registerGuard(legacy)({ toolName: "read", input: { path: "anything.md" } }, { cwd }), /contract.*malformed/u);
	}

	await writeFile(join(cwd, ".pi-graph", "node-contract.json"), "not-json", "utf8");
	assertBlocked(registerGuard(nodeContract(cwd))({ toolName: "read", input: { path: "anything.md" } }, { cwd }), /contract.*malformed/u);
});

test("required Graph Guard binding fails closed when its contract is missing or drifts", async () => {
	const { cwd, writeContract } = await guardFixture({ toolFilter: ["read"] });
	const original = nodeContract(cwd, { toolFilter: ["read"] });
	const toolHandler = registerGuard(original);
	const providerHandler = registerProviderGuard(original);
	let aborts = 0;
	const abort = () => { aborts += 1; };

	await rm(join(cwd, ".pi-graph", "node-contract.json"));
	assertBlocked(toolHandler({ toolName: "read", input: { path: "anything.md" } }, { cwd, abort }), /failing closed/u);
	assert.equal(providerHandler({ payload: { max_tokens: 1_024 } }, { cwd, abort }), null);
	assert.equal(aborts, 2, "both tool and provider denial must abort the child run");

	await writeContract({ ...original, readOnly: true });
	assertBlocked(toolHandler({ toolName: "read", input: { path: "anything.md" } }, { cwd, abort }), /changed/u);
	assert.equal(providerHandler({ payload: { max_tokens: 1_024 } }, { cwd, abort }), null);
	assert.equal(aborts, 4, "a digest mismatch must fail closed at both boundaries");
});

test("Graph Guard stays inert for ordinary child bindings without pi-graph/1", () => {
	let acknowledged = false;
	const registered: string[] = [];
	withChildEnvironment({ "another-extension/1": { enabled: true } }, () => {
		graphGuard({ registerTool: () => undefined,
			events: { emit: (name: string) => { acknowledged = name === "pi-graph:acknowledge-extension"; } },
			on: (name: string) => { registered.push(name); },
		} as never);
	});
	assert.equal(acknowledged, true, "autoload acknowledgement remains available to pi-subagents");
	assert.deepEqual(registered, [], "ambient subagents must not inherit graph enforcement hooks");
});

test("malformed required Graph Guard binding aborts and blocks without reading ambient policy", async () => {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-graph-v3-invalid-binding-")));
	const invalidBindings = { "pi-graph/1": { schemaVersion: 1, graphId: "graph-test" } };
	const placeholder = nodeContract(cwd);
	const toolHandler = registerGuard(placeholder, invalidBindings);
	const providerHandler = registerProviderGuard(placeholder, invalidBindings);
	let aborts = 0;
	const abort = () => { aborts += 1; };
	assertBlocked(toolHandler({ toolName: "read", input: { path: "anything.md" } }, { cwd, abort }), /failing closed/u);
	assert.equal(providerHandler({ payload: { max_tokens: 1_024 } }, { cwd, abort }), null);
	assert.equal(aborts, 2);
});

test("V3 workspace persists only the pure Guard contract", async () => {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "pi-graph-v3-contract-")));
	const sourceCwd = join(sandbox, "source");
	const runDir = join(sandbox, "run");
	await mkdir(sourceCwd);
	await mkdir(runDir);
	const graphNode: CompiledGraphNodeV3 = {
		taskId: "research",
		agent: "test-agent",
		task: "Research current primary sources.",
		dependsOn: [],
		inputArtifacts: [],
		outputArtifact: "graph/research/out",
		readScope: [],
		writeScope: [],
		sideEffect: "none",
		retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 },
		validationCommands: [],
		readOnly: true,
		toolFilter: ["fetch_content", "get_search_content", "read", "web_search"],
		launch: { schemaVersion: 1, maxTokens: 4_096, hintDigest: "a".repeat(64) },
	};
	const prepared = await prepareV3Workspace({
		runInstanceId: "run-1",
		graphId: "graph-1",
		node: graphNode,
		attempt: 1,
		runDir,
		sourceCwd,
		workspace: "shadow",
	});
	try {
		const persisted = JSON.parse(await readFile(join(prepared.workspaceCwd, ".pi-graph", "node-contract.json"), "utf8")) as Record<string, unknown>;
		assert.equal("resourceScopes" in persisted, false);
		assert.equal(persisted.allowBash, false);
		assert.equal(persisted.readOnly, true);
		assert.deepEqual(persisted.toolFilter, graphNode.toolFilter);
		assert.equal(persisted.maxTokens, 4_096);
	} finally {
		await prepared.cleanup();
		await rm(sandbox, { recursive: true, force: true });
	}
});

test("Graph Guard is inert in an ordinary parent Pi process", () => {
	const previous = process.env.PI_GRAPH_CHILD;
	delete process.env.PI_GRAPH_CHILD;
	let registered = false;
	try {
		graphGuard({ registerTool: () => undefined, on: (event: string) => { if (event !== "session_start") registered = true; } } as never);
	} finally {
		if (previous !== undefined) process.env.PI_GRAPH_CHILD = previous;
	}
	assert.equal(registered, false);
});

test("inherited guard preserves readonly/filter ceilings and allows parent-authorized shell/external/path tools", async () => {
 const tools = ["bash", "read", "write", "fake_external_write"];
 for (const readOnly of [false, true]) {
  const f = await guardFixture({ permissionPolicy: "inherited", parentToolAllowlist: tools, allowBash: !readOnly, readOnly });
  try {
   assert.equal(f.handler({ toolName: "read", input: { path: "/outside/workspace" } }, { cwd: f.cwd }), undefined);
   for (const toolName of ["bash", "write", "fake_external_write"]) {
    const result = f.handler({ toolName, input: { command: "echo ok", path: "/outside/workspace" } }, { cwd: f.cwd });
    if (readOnly) assertBlocked(result, /read-only/); else assert.equal(result, undefined);
   }
   assertBlocked(f.handler({ toolName: "ungranted", input: {} }, { cwd: f.cwd }), /parent tool ceiling/);
   assertBlocked(f.handler({ toolName: "contact_supervisor", input: {} }, { cwd: f.cwd }), /only graph_mailbox/);
  } finally { await rm(f.cwd, { recursive: true, force: true }); }
 }
 const empty = await guardFixture({ permissionPolicy: "inherited", parentToolAllowlist: [], allowBash: true });
 try { assertBlocked(empty.handler({ toolName: "read", input: {} }, { cwd: empty.cwd }), /parent tool ceiling/); }
 finally { await rm(empty.cwd, { recursive: true, force: true }); }
 const filtered = await guardFixture({ permissionPolicy: "inherited", parentToolAllowlist: tools, allowBash: true, toolFilter: ["read"] });
 try { assertBlocked(filtered.handler({ toolName: "bash", input: {} }, { cwd: filtered.cwd }), /toolFilter/); }
 finally { await rm(filtered.cwd, { recursive: true, force: true }); }
});

test("typed readonly tools require both the parent ceiling and Graph filter; bash/write remain denied", async () => {
 const tool="graph_readonly_sha256";
 for(const policy of ["strict","inherited"] as const){
  for(const [parentToolAllowlist,toolFilter,blocked] of [[[tool],[tool],false],[[],[tool],true],[[tool],["read"],true]] as const){
   const f=await guardFixture({permissionPolicy:policy,readOnly:true,parentToolAllowlist:[...parentToolAllowlist],toolFilter:[...toolFilter]});
   try{const result=f.handler({toolName:tool,input:{path:"file"}},{cwd:f.cwd});assert.equal(result?.block===true,blocked);for(const name of ["bash","write","edit"])assert.equal(f.handler({toolName:name,input:{command:"touch x",path:"x"}},{cwd:f.cwd})?.block,true);}
   finally{await rm(f.cwd,{recursive:true,force:true});}
  }
 }
});

test('owned control paths stay protected when file authority is inherited',async()=>{
 const f=await guardFixture({permissionPolicy:'inherited',parentToolAllowlist:['read','write','edit'],allowBash:true});const previous=process.env.PI_GRAPH_PROTECTED_ROOTS;
 try{process.env.PI_GRAPH_PROTECTED_ROOTS=JSON.stringify({writes:[join(f.cwd,'control')],reads:[join(f.cwd,'control')]});assertBlocked(f.handler({toolName:'write',input:{path:join(f.cwd,'control','proof.json'),content:'forged'}},{cwd:f.cwd}),/control paths are protected/);assertBlocked(f.handler({toolName:'read',input:{path:join(f.cwd,'control','auth.json')}},{cwd:f.cwd}),/control paths are protected/);assert.equal(f.handler({toolName:'write',input:{path:join(f.cwd,'business.txt'),content:'allowed'}},{cwd:f.cwd}),undefined);}finally{if(previous===undefined)delete process.env.PI_GRAPH_PROTECTED_ROOTS;else process.env.PI_GRAPH_PROTECTED_ROOTS=previous;await rm(f.cwd,{recursive:true,force:true})}
});
