import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import graphGuard, { remoteToolViolation } from "../extensions/pi-graph-guard.ts";
import { isReadOnlyRemoteToolName } from "../src/v3/remote-tools.ts";
import { prepareV3Workspace } from "../src/v3/workspace.ts";
import type { CompiledGraphNodeV3 } from "../src/v3/types.ts";
import type { V3NodeContract } from "../src/v3/workspace.ts";

interface GuardDecision {
	block: true;
	reason: string;
}

type GuardHandler = (event: { toolName: string; input: Record<string, unknown> }, ctx: { cwd: string }) => GuardDecision | undefined;

function registerGuard(): GuardHandler {
	const previous = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	let handler: GuardHandler | undefined;
	let acknowledged = false;
	try {
		graphGuard({
			events: {
				emit: (name: string, payload: unknown) => {
					acknowledged = name === "subagent:acknowledge-extension"
						&& (payload as { id?: unknown }).id === "pi-graph-guard";
				},
			},
			on: (_name: string, value: GuardHandler) => {
				handler = value;
			},
		} as never);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
	assert.equal(acknowledged, true);
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
	await writeContract(nodeContract(cwd, overrides));
	return { cwd, handler: registerGuard(), writeContract };
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

test("Graph Guard enforces toolFilter and readOnly for local file tools", async () => {
	const { cwd, handler, writeContract } = await guardFixture();
	await writeFile(join(cwd, "allowed.md"), "before\n", "utf8");
	await writeContract(nodeContract(cwd, {
		readOnly: true,
		toolFilter: ["read", "write", "edit"],
		readScope: [{ kind: "file", path: join(cwd, "allowed.md") }],
		writeScope: [{ kind: "file", path: join(cwd, "allowed.md") }],
	}));

	assert.equal(handler({ toolName: "read", input: { path: "allowed.md" } }, { cwd }), undefined);
	assertBlocked(handler({ toolName: "grep", input: { path: "allowed.md", pattern: "before" } }, { cwd }), /outside the graph toolFilter/u);
	assertBlocked(handler({ toolName: "write", input: { path: "allowed.md", content: "after" } }, { cwd }), /graph is read-only/u);
	assertBlocked(handler({ toolName: "edit", input: { path: "allowed.md", oldText: "before", newText: "after" } }, { cwd }), /graph is read-only/u);
});

test("Graph Guard allows declared local writes only for a writable V3 graph", async () => {
	const { cwd, handler, writeContract } = await guardFixture();
	await writeFile(join(cwd, "allowed.md"), "before\n", "utf8");
	await writeContract(nodeContract(cwd, {
		writeScope: [{ kind: "file", path: join(cwd, "allowed.md") }],
		sideEffect: "local_write",
	}));

	assert.equal(handler({ toolName: "write", input: { path: "allowed.md", content: "after" } }, { cwd }), undefined);
	assert.equal(handler({ toolName: "read", input: { path: "allowed.md" } }, { cwd }), undefined);
	assertBlocked(handler({ toolName: "write", input: { path: "outside.md", content: "no" } }, { cwd }), /outside declared write scope/u);
	assertBlocked(handler({ toolName: "read", input: { path: "outside.md" } }, { cwd }), /outside declared read scope/u);
});

test("Graph Guard always rejects bash", async () => {
	const { cwd, handler, writeContract } = await guardFixture({ toolFilter: ["bash"] });
	assertBlocked(handler({ toolName: "bash", input: { command: "pwd" } }, { cwd }), /bash is disabled/u);

	await writeContract({ ...nodeContract(cwd, { toolFilter: ["bash"] }), allowBash: true });
	assertBlocked(handler({ toolName: "bash", input: { command: "pwd" } }, { cwd }), /contract is malformed/u);
});

test("Graph Guard blocks path-bearing pseudo-remote tools and protected control paths", async () => {
	const { cwd, handler, writeContract } = await guardFixture();
	await mkdir(join(cwd, "nested", ".git"), { recursive: true });
	await writeFile(join(cwd, "nested", ".git", "config"), "secret\n", "utf8");
	await writeContract(nodeContract(cwd, {
		readScope: [{ kind: "tree", path: cwd }],
		writeScope: [{ kind: "tree", path: cwd }],
		sideEffect: "local_write",
		toolFilter: ["read", "write", "custom_reader"],
	}));

	assertBlocked(handler({ toolName: "custom_reader", input: { filePath: "/etc/passwd" } }, { cwd }), /path-bearing tool/u);
	assertBlocked(handler({ toolName: "read", input: { path: "nested/.git/config" } }, { cwd }), /control paths/u);
	assertBlocked(handler({ toolName: "write", input: { path: ".pi-graph/node-contract.json", content: "{}" } }, { cwd }), /control files are read-only/u);
	assertBlocked(handler({ toolName: "read", input: { path: ".pi/agents/researcher.md" } }, { cwd }), /control paths|not child-readable/u);
	assertBlocked(handler({ toolName: "read", input: { path: "../outside.txt" } }, { cwd }), /outside declared read scope/u);
});

test("Graph Guard rejects the removed legacy contract field and malformed V3 contracts", async () => {
	const { cwd, handler, writeContract } = await guardFixture();
	await writeContract({ ...nodeContract(cwd), resourceScopes: [] });
	assertBlocked(handler({ toolName: "read", input: { path: "anything.md" } }, { cwd }), /contract is malformed/u);

	await writeFile(join(cwd, ".pi-graph", "node-contract.json"), "not-json", "utf8");
	assertBlocked(handler({ toolName: "read", input: { path: "anything.md" } }, { cwd }), /contract is malformed/u);
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
	} finally {
		await prepared.cleanup();
		await rm(sandbox, { recursive: true, force: true });
	}
});

test("Graph Guard is inert in an ordinary parent Pi process", () => {
	const previous = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	let registered = false;
	try {
		graphGuard({ on: () => { registered = true; } } as never);
	} finally {
		if (previous !== undefined) process.env.PI_SUBAGENT_CHILD = previous;
	}
	assert.equal(registered, false);
});
