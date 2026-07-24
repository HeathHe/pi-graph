import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import graphGuard from "../extensions/pi-graph-guard.ts";
import { compileGraph } from "../src/compile.ts";
import { digestFile, prepareWorkspace, reopenWorkspace } from "../src/workspace.ts";
import type { GraphSpec } from "../src/types.ts";

function registerGuard(): ((event: any, ctx: any) => any) {
	const previous = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	let handler: ((event: any, ctx: any) => any) | undefined;
	try {
		graphGuard({ on: (_name: string, value: typeof handler) => { handler = value; } } as any);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
	assert.ok(handler);
	return handler!;
}

test("shadow workspace applies only declared writes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-workspace-"));
	await writeFile(join(cwd, "allowed.md"), "before");
	await writeFile(join(cwd, "outside.md"), "outside");
	const graph = compileGraph({ schemaVersion: 1, goal: "write", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		readScope: [{ kind: "file", path: "allowed.md" }], writeScope: [{ kind: "file", path: "allowed.md" }],
		validationCommands: ["test -f allowed.md"],
	}] } as GraphSpec, cwd);
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir: join(cwd, ".attempt"), strategy: "shadow" });
	await writeFile(join(workspace.cwd, "allowed.md"), "after");
	await writeFile(join(workspace.cwd, "outside.md"), "tampered");
	const changes = await workspace.apply();
	assert.equal(await readFile(join(cwd, "allowed.md"), "utf8"), "after");
	assert.equal(await readFile(join(cwd, "outside.md"), "utf8"), "outside");
	assert.equal(changes.length, 1);
	assert.equal(workspace.contract.allowBash, false);
});

test("apply-back refuses to overwrite a concurrent source edit", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-conflict-"));
	await writeFile(join(cwd, "target.md"), "initial");
	const graph = compileGraph({ schemaVersion: 1, goal: "conflict", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		readScope: [{ kind: "file", path: "target.md" }], writeScope: [{ kind: "file", path: "target.md" }],
		validationCommands: ["test -f target.md"],
	}] } as GraphSpec, cwd);
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir: join(cwd, ".attempt"), strategy: "shadow" });
	await writeFile(join(workspace.cwd, "target.md"), "agent edit");
	await writeFile(join(cwd, "target.md"), "user edit");
	await assert.rejects(() => workspace.apply(), /source changed while node was running/i);
	assert.equal(await readFile(join(cwd, "target.md"), "utf8"), "user edit");
});

test("multi-file apply preflights every target before changing the source", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-preflight-"));
	await writeFile(join(cwd, "first.md"), "first-before");
	await writeFile(join(cwd, "second.md"), "second-before");
	const graph = compileGraph({ schemaVersion: 1, goal: "preflight", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "first.md" }, { kind: "file", path: "second.md" }],
		validationCommands: ["test -f first.md"],
	}] } as GraphSpec, cwd);
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir: join(cwd, ".attempt"), strategy: "shadow" });
	await writeFile(join(workspace.cwd, "first.md"), "first-after");
	await writeFile(join(workspace.cwd, "second.md"), "second-after");
	await writeFile(join(cwd, "second.md"), "user-edit");
	await assert.rejects(() => workspace.apply(), /Source changed while node was running/);
	assert.equal(await readFile(join(cwd, "first.md"), "utf8"), "first-before");
	assert.equal(await readFile(join(cwd, "second.md"), "utf8"), "user-edit");
});

test("Graph Guard blocks undeclared direct paths and read-only bash", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-guard-"));
	await mkdir(join(cwd, ".pi-graph"));
	await writeFile(join(cwd, "allowed.md"), "x");
	await writeFile(join(cwd, ".pi-graph", "node-contract.json"), JSON.stringify({ schemaVersion: 1, graphId: "g", taskId: "n", attempt: 1, attemptDir: cwd, sourceCwd: cwd, workspaceCwd: cwd, readScope: [{ kind: "file", path: join(cwd, "allowed.md") }], writeScope: [], allowBash: false, writeBaseline: {} }));
	const handler = registerGuard();
	assert.equal(handler({ toolName: "read", input: { path: "allowed.md" } }, { cwd }), undefined);
	assert.equal(handler({ toolName: "read", input: { path: "outside.md" } }, { cwd }).block, true);
	assert.equal(handler({ toolName: "bash", input: { command: "pwd" } }, { cwd }).block, true);
	assert.equal(handler({ toolName: "write", input: { path: ".pi-graph/node-contract.json" } }, { cwd }).block, true);
	assert.equal(handler({ toolName: "custom-path-tool", input: { path: "allowed.md" } }, { cwd }).block, true);
});

test("Graph Guard blocks parent traversal and control files for bash-enabled nodes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-guard-bash-"));
	await mkdir(join(cwd, ".pi-graph"));
	await writeFile(join(cwd, ".pi-graph", "node-contract.json"), JSON.stringify({ schemaVersion: 1, graphId: "g", taskId: "n", attempt: 1, attemptDir: cwd, sourceCwd: cwd, workspaceCwd: cwd, readScope: [], writeScope: [], allowBash: true, writeBaseline: {} }));
	const handler = registerGuard();
	assert.equal(handler({ toolName: "bash", input: { command: "cd .." } }, { cwd }).block, true);
	assert.equal(handler({ toolName: "bash", input: { command: "cat .pi-graph/node-contract.json" } }, { cwd }).block, true);
	assert.equal(handler({ toolName: "custom-reader", input: { filePath: "/etc/passwd" } }, { cwd }).block, true);
});

test("Graph Guard is inert in an ordinary parent Pi process", () => {
	const previous = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	let registered = false;
	try {
		graphGuard({ on: () => { registered = true; } } as any);
	} finally {
		if (previous !== undefined) process.env.PI_SUBAGENT_CHILD = previous;
	}
	assert.equal(registered, false);
});

test("Graph Guard fails closed when a graph contract is malformed", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-guard-malformed-"));
	await mkdir(join(cwd, ".pi-graph"));
	await writeFile(join(cwd, ".pi-graph", "node-contract.json"), "not-json");
	const handler = registerGuard();
	assert.equal(handler({ toolName: "read", input: { path: "anything.md" } }, { cwd }).block, true);
});

test("shadow workspace copies project agents and injects Graph Guard only in the copy", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-project-agent-"));
	await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
	const sourceAgent = join(cwd, ".pi", "agents", "custom.md");
	await writeFile(sourceAgent, "---\nname: custom\ndescription: Custom test agent\nextensions: /tmp/custom-extension.ts\nsubagentOnlyExtensions: /tmp/existing-child-extension.ts\n---\n\nCustom agent.\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "agent", workspace: "shadow", nodes: [{ taskId: "read", agent: "custom", task: "read", outputArtifact: "result.md", sideEffect: "none" }] } as GraphSpec, cwd);
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir: join(cwd, ".attempt"), strategy: "shadow" });
	const copied = await readFile(join(workspace.cwd, ".pi", "agents", "custom.md"), "utf8");
	assert.match(copied, /subagentOnlyExtensions: .*pi-graph-guard\.ts/);
	assert.match(copied, /extensions: \/tmp\/custom-extension\.ts/);
	assert.match(copied, /subagentOnlyExtensions: \/tmp\/existing-child-extension\.ts, .*pi-graph-guard\.ts/);
	assert.doesNotMatch(await readFile(sourceAgent, "utf8"), /pi-graph-guard/);
	const packageRoot = dirname(createRequire(import.meta.url).resolve("pi-subagents"));
	const jiti = createJiti(import.meta.url);
	const agents = await jiti.import(join(packageRoot, "src", "agents", "agents.ts")) as {
		discoverAgents(cwd: string, scope: "both"): { agents: Array<{ name: string; extensions?: string[]; subagentOnlyExtensions?: string[] }> };
	};
	const piArgs = await jiti.import(join(packageRoot, "src", "runs", "shared", "pi-args.ts")) as {
		buildPiArgs(input: Record<string, unknown>): { args: string[] };
	};
	const effective = agents.discoverAgents(workspace.cwd, "both").agents.find((agent) => agent.name === "custom");
	assert.ok(effective);
	const built = piArgs.buildPiArgs({
		baseArgs: ["pi"],
		task: "test",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
		extensions: effective.extensions,
		subagentOnlyExtensions: effective.subagentOnlyExtensions,
	});
	assert.ok(built.args.includes("--no-extensions"));
	assert.ok(built.args.includes("/tmp/custom-extension.ts"));
	assert.ok(built.args.some((value) => value.endsWith("/extensions/pi-graph-guard.ts")));
});

test("shadow workspace materializes an ancestor legacy project agent with Graph Guard", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-ancestor-agent-"));
	const cwd = join(root, "packages", "app");
	await mkdir(join(root, ".agents"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	await writeFile(join(root, ".agents", "ancestor.md"), "---\nname: ancestor\ndescription: Ancestor test agent\n---\n\nAncestor role.\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "agent", workspace: "shadow", nodes: [{ taskId: "read", agent: "ancestor", task: "read", outputArtifact: "result.md", sideEffect: "none" }] } as GraphSpec, cwd);
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir: join(root, "attempt"), strategy: "shadow" });
	const copied = await readFile(join(workspace.cwd, ".pi", "agents", "ancestor.md"), "utf8");
	assert.match(copied, /Ancestor role/);
	assert.match(copied, /subagentOnlyExtensions: .*pi-graph-guard\.ts/);
});

test("project Agent symlinks are rejected without modifying their targets", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-agent-symlink-"));
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
	const victim = join(root, "victim.md");
	await writeFile(victim, "untouched\n");
	await symlink(victim, join(cwd, ".pi", "agents", "linked.md"));
	const graph = compileGraph({ schemaVersion: 1, goal: "agent", workspace: "shadow", nodes: [{ taskId: "read", agent: "custom", task: "read", outputArtifact: "result.md", sideEffect: "none" }] } as GraphSpec, cwd);
	await assert.rejects(() => prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir: join(root, "attempt"), strategy: "shadow" }), /may not contain symlinks/);
	assert.equal(await readFile(victim, "utf8"), "untouched\n");
});

test("recovered Git workspace cleans up after source becomes dirty", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-git-recovery-"));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Pi Graph Test"]]) {
		assert.equal(spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).status, 0);
	}
	await writeFile(join(cwd, "target.md"), "before\n");
	assert.equal(spawnSync("git", ["-C", cwd, "add", "target.md"], { encoding: "utf8" }).status, 0);
	assert.equal(spawnSync("git", ["-C", cwd, "commit", "-m", "initial"], { encoding: "utf8" }).status, 0);
	const graph = compileGraph({ schemaVersion: 1, goal: "git", workspace: "git", nodes: [{
		taskId: "writer", agent: "code-implementer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"],
	}] } as GraphSpec, cwd);
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir: join(root, graph.graphId, "nodes", "writer", "attempt-1"), strategy: "git" });
	await writeFile(join(workspace.cwd, "target.md"), "after\n");
	await workspace.apply();
	assert.match(spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" }).stdout, /target\.md/);
	const worktreeRoot = workspace.contract.gitWorktreeRoot!;
	await (await reopenWorkspace(graph.nodes[0]!, workspace.cwd, "git")).cleanup();
	assert.equal(existsSync(worktreeRoot), false);
});

test("reopen rejects a modified node contract", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-contract-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	await writeFile(join(cwd, "target.md"), "before\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "contract", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"],
	}] } as GraphSpec, cwd);
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir: join(root, graph.graphId, "nodes", "writer", "attempt-1"), strategy: "shadow" });
	const contractPath = join(workspace.cwd, ".pi-graph", "node-contract.json");
	const contract = JSON.parse(await readFile(contractPath, "utf8"));
	contract.writeScope = [{ kind: "tree", path: workspace.cwd }];
	await writeFile(contractPath, JSON.stringify(contract));
	await assert.rejects(() => reopenWorkspace(graph.nodes[0]!, workspace.cwd, "shadow"), /modified write scope/);
});

test("recovered apply rejects a modified transaction plan", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-plan-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	await writeFile(join(cwd, "target.md"), "before\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "plan", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"],
	}] } as GraphSpec, cwd);
	const attemptDir = join(root, graph.graphId, "nodes", "writer", "attempt-1");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir, strategy: "shadow" });
	await writeFile(join(workspace.cwd, "target.md"), "after\n");
	await workspace.apply();
	const planPath = join(attemptDir, "apply-plan.json");
	const plan = JSON.parse(await readFile(planPath, "utf8"));
	plan.entries[0].sourcePath = join(root, "outside.md");
	await writeFile(planPath, JSON.stringify(plan));
	const recovered = await reopenWorkspace(graph.nodes[0]!, workspace.cwd, "shadow");
	await assert.rejects(() => recovered.apply(), /Invalid graph apply target/);
});

test("read sources and input artifacts are fingerprinted until source commit", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-input-fingerprint-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	await writeFile(join(cwd, "read.md"), "read-before\n");
	await writeFile(join(cwd, "target.md"), "target-before\n");
	const artifact = join(root, "input.md");
	await writeFile(artifact, "input-before\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "fingerprints", workspace: "shadow", nodes: [
		{ taskId: "producer", agent: "researcher", task: "produce", outputArtifact: "input.md", sideEffect: "none" },
		{
			taskId: "writer", agent: "document-writer", task: "write", dependsOn: ["producer"], inputArtifacts: ["input.md"], outputArtifact: "result.md", sideEffect: "local_write",
			readScope: [{ kind: "file", path: "read.md" }], writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"],
		},
	] } as GraphSpec, cwd);
	const node = graph.nodes.find((candidate) => candidate.taskId === "writer")!;
	const attemptDir = join(root, graph.graphId, "nodes", "writer", "attempt-1");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node, attempt: 1, attemptDir, strategy: "shadow", artifacts: [{ name: "input.md", source: artifact }] });
	await writeFile(join(workspace.cwd, "target.md"), "target-after\n");
	await writeFile(join(cwd, "read.md"), "read-after\n");
	await assert.rejects(() => workspace.apply(), /Read source changed/);
	assert.equal(await readFile(join(cwd, "target.md"), "utf8"), "target-before\n");

	await writeFile(join(cwd, "read.md"), "read-before\n");
	await writeFile(artifact, "input-after\n");
	await assert.rejects(() => workspace.apply(), /Input artifact changed/);
	assert.equal(await readFile(join(cwd, "target.md"), "utf8"), "target-before\n");
});

test("interrupted apply refuses an invalid backup before changing any source file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-invalid-backup-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	await writeFile(join(cwd, "first.md"), "first-before\n");
	await writeFile(join(cwd, "second.md"), "second-before\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "backup", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "first.md" }, { kind: "file", path: "second.md" }], validationCommands: ["test -f first.md"],
	}] } as GraphSpec, cwd);
	const attemptDir = join(root, graph.graphId, "nodes", "writer", "attempt-1");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir, strategy: "shadow" });
	await writeFile(join(workspace.cwd, "first.md"), "first-after\n");
	await writeFile(join(workspace.cwd, "second.md"), "second-after\n");
	await workspace.apply();
	const planPath = join(attemptDir, "apply-plan.json");
	const plan = JSON.parse(await readFile(planPath, "utf8"));
	plan.status = "applying";
	await writeFile(plan.entries[0].backupPath, "corrupt-backup\n");
	await writeFile(join(cwd, "second.md"), "second-before\n");
	await writeFile(planPath, JSON.stringify(plan));
	await assert.rejects(() => reopenWorkspace(graph.nodes[0]!, workspace.cwd, "shadow").then((recovered) => recovered.apply()), /invalid backup/);
	assert.equal(await readFile(join(cwd, "first.md"), "utf8"), "first-after\n");
	assert.equal(await readFile(join(cwd, "second.md"), "utf8"), "second-before\n");
});

test("interrupted apply treats a third source digest as attention, not rollback", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-third-digest-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	await writeFile(join(cwd, "target.md"), "before\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "third", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"],
	}] } as GraphSpec, cwd);
	const attemptDir = join(root, graph.graphId, "nodes", "writer", "attempt-1");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir, strategy: "shadow" });
	await writeFile(join(workspace.cwd, "target.md"), "after\n");
	await workspace.apply();
	const planPath = join(attemptDir, "apply-plan.json");
	const plan = JSON.parse(await readFile(planPath, "utf8"));
	plan.status = "applying";
	await writeFile(planPath, JSON.stringify(plan));
	await writeFile(join(cwd, "target.md"), "third\n");
	await assert.rejects(() => reopenWorkspace(graph.nodes[0]!, workspace.cwd, "shadow").then((recovered) => recovered.apply()), /third digest/);
	assert.equal(await readFile(join(cwd, "target.md"), "utf8"), "third\n");
});

test("interrupted apply promotes an all-after disk state to committed", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-all-after-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	await writeFile(join(cwd, "target.md"), "before\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "promote", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"],
	}] } as GraphSpec, cwd);
	const attemptDir = join(root, graph.graphId, "nodes", "writer", "attempt-1");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir, strategy: "shadow" });
	await writeFile(join(workspace.cwd, "target.md"), "after\n");
	await workspace.apply();
	const planPath = join(attemptDir, "apply-plan.json");
	const plan = JSON.parse(await readFile(planPath, "utf8"));
	plan.status = "applying";
	await writeFile(planPath, JSON.stringify(plan));
	const writes = await (await reopenWorkspace(graph.nodes[0]!, workspace.cwd, "shadow")).apply();
	assert.equal(writes.length, 1);
	assert.equal(JSON.parse(await readFile(planPath, "utf8")).status, "committed");
	assert.equal(await readFile(join(cwd, "target.md"), "utf8"), "after\n");
});

test("digestFile reports non-missing I/O failures instead of treating them as absent", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-digest-error-"));
	await assert.rejects(() => digestFile(root));
	assert.equal(await digestFile(join(root, "missing.md")), undefined);
});

test("source apply rejects a parent directory replaced by a symlink", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-source-parent-symlink-"));
	const cwd = join(root, "project");
	const outside = join(root, "outside");
	await mkdir(join(cwd, "docs"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(cwd, "docs", "target.md"), "before\n");
	await writeFile(join(outside, "target.md"), "outside\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "parent", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "tree", path: "docs" }], atomic: true, scopeJustification: "Exercise a guarded tree apply.", validationCommands: ["test -f docs/target.md"],
	}] } as GraphSpec, cwd);
	const attemptDir = join(root, graph.graphId, "nodes", "writer", "attempt-1");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir, strategy: "shadow" });
	await writeFile(join(workspace.cwd, "docs", "target.md"), "after\n");
	await rm(join(cwd, "docs"), { recursive: true });
	await symlink(outside, join(cwd, "docs"));
	await assert.rejects(() => workspace.apply(), /source parent changed into a symlink/i);
	assert.equal(await readFile(join(outside, "target.md"), "utf8"), "outside\n");
});

test("interrupted apply recovery rejects a parent swapped to a symlink", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-recovery-parent-symlink-"));
	const cwd = join(root, "project");
	const outside = join(root, "outside");
	await mkdir(join(cwd, "docs"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(cwd, "docs", "first.md"), "first-before\n");
	await writeFile(join(cwd, "docs", "second.md"), "second-before\n");
	const graph = compileGraph({ schemaVersion: 1, goal: "recovery parent", workspace: "shadow", nodes: [{
		taskId: "writer", agent: "document-writer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "tree", path: "docs" }], atomic: true, scopeJustification: "Exercise guarded recovery.", validationCommands: ["test -f docs/first.md"],
	}] } as GraphSpec, cwd);
	const attemptDir = join(root, graph.graphId, "nodes", "writer", "attempt-1");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir, strategy: "shadow" });
	await writeFile(join(workspace.cwd, "docs", "first.md"), "first-after\n");
	await writeFile(join(workspace.cwd, "docs", "second.md"), "second-after\n");
	await workspace.apply();
	const planPath = join(attemptDir, "apply-plan.json");
	const plan = JSON.parse(await readFile(planPath, "utf8"));
	plan.status = "applying";
	await writeFile(planPath, JSON.stringify(plan));
	await rm(join(cwd, "docs"), { recursive: true });
	await writeFile(join(outside, "first.md"), "first-after\n");
	await writeFile(join(outside, "second.md"), "second-before\n");
	await symlink(outside, join(cwd, "docs"));

	await assert.rejects(() => reopenWorkspace(graph.nodes[0]!, workspace.cwd, "shadow").then((recovered) => recovered.apply()), /source parent changed into a symlink/i);
	assert.equal(await readFile(join(outside, "first.md"), "utf8"), "first-after\n");
	assert.equal(await readFile(join(outside, "second.md"), "utf8"), "second-before\n");
});
