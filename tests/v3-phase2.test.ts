import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { V3GraphHost } from "../src/v3/host.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { graphV3Error } from "../src/v3/errors.ts";
import type { GraphSpecV3 } from "../src/v3/types.ts";
import { MockSubagents, completeChild } from "./helpers/mock-subagents.ts";

const GOVERNANCE_MODULES = ["subagent-router", "model-routing", "model-routing-adapter", "recommend", "subagent-model-router"];

async function fixture() {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "v3-phase2-")));
	const sourceDir = join(sandbox, "source");
	await mkdir(sourceDir, { recursive: true });
	const runsDir = join(sandbox, "runs");
	await mkdir(runsDir, { recursive: true });
	return { sandbox, sourceDir, runsDir };
}

test("D4: a governance-free V3 start never fails on a planning gate or routing config", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	// Deliberately place broken/absent governance config: a V3 run must never consult it.
	const mock = new MockSubagents();
	mock.behaviors.set("NODE_P", (input) => completeChild({ ...input, output: "p" }));
	mock.start();
	const host = new V3GraphHost({ rpc: new SubagentRpcClient(mock), runsDir, sessionId: "s", supervisorEpoch: "e", preflightAgent: async () => undefined });
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "gate death probe",
		nodes: [{ taskId: "p", agent: "test-agent", task: "NODE_P", sideEffect: "local_read" }],
	};
	const result = await host.start(spec, sourceDir);
	const snapshot = await host.waitForCompletion(result.graphId);
	assert.equal(snapshot.status, "complete");
	// No governance config file may exist in or be created by the run.
	for (const name of ["model-registry.json", "routing-policy.json", "planning.json", "capability.json"]) {
		await assert.rejects(readFile(join(sandbox, name)), { code: "ENOENT" }, `governance file must not exist: ${name}`);
	}
	await mock.dispose();
	await rm(sandbox, { recursive: true, force: true });
});

test("D4: a legacy GraphSpec v1 start is rejected instead of entering a planning gate", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	const mock = new MockSubagents();
	mock.start();
	const host = new V3GraphHost({ rpc: new SubagentRpcClient(mock), runsDir, sessionId: "s", supervisorEpoch: "e", preflightAgent: async () => undefined });
	const legacySpec = { schemaVersion: 1, goal: "legacy", nodes: [{ taskId: "a", agent: "x", task: "a" }] };
	let code = "";
	try {
		await host.start(legacySpec as unknown as GraphSpecV3, sourceDir);
	} catch (error) {
		code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
	}
	assert.equal(code, "INVALID_SCHEMA_VERSION", "V3 admission must reject legacy schemaVersion");
	// No run directory may have been created by the rejected legacy start.
	const entries = await readdir(runsDir);
	assert.deepEqual(entries, []);
	await mock.dispose();
	await rm(sandbox, { recursive: true, force: true });
});

test("D1: the production entry layer and the full core have zero governance imports", async () => {
	const entryFiles = ["extensions/pi-graph.ts", "extensions/pi-graph-guard.ts"];
	const found: string[] = [];
	for (const file of entryFiles) {
		const source = await readFile(resolve(file), "utf8");
		for (const line of source.split("\n")) {
			if (/from\s+"\.\..*\/(subagent-router|model-routing|recommend|model-routing-adapter)/u.test(line)) found.push(`${file}: ${line.trim()}`);
		}
	}
	assert.deepEqual(found, [], "retained extensions must not import governance modules");
	// Assert (was reported in the D1 probe) that every retained core source file has
	// zero imports into the archived governance module set. Imports inside the
	// governance module set itself are governance-internal and go to archive together.
	const coreFiles = (await readdir("src", { recursive: true })).filter((name) => typeof name === "string" && name.endsWith(".ts"))
		.filter((name) => !name.startsWith("model-routing/") && !name.startsWith("subagent-router/") && name !== "model-routing-adapter.ts" && name !== "recommend.ts");
	const coreEdges: string[] = [];
	for (const name of coreFiles) {
		const source = await readFile(resolve("src", name), "utf8");
		for (const line of source.split("\n")) {
			if (/from\s+"\.\.?\/(subagent-router|model-routing|model-routing-adapter|recommend)/u.test(line)) coreEdges.push(`${name}: ${line.trim()}`);
		}
	}
	console.log(`D1 report: remaining core->governance import edges = ${coreEdges.length}`);
	for (const edge of coreEdges) console.log(`  D1 ${edge}`);
	assert.deepEqual(coreEdges, [], "the full core must have zero imports into the archived governance module set");
});

test("D5: loading the extension in an empty session produces zero graph activity", { timeout: 45_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-phase2-d5-"));
	const agentDir = join(root, "agent");
	const runsDir = join(root, "runs");
	await mkdir(agentDir, { recursive: true });
	await mkdir(runsDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ graph: { enabled: true, runsDir, history: { autoCompact: false, autoPrune: false, emergencyPurge: false } } }));
	const child = spawn(join(resolve(process.cwd()), "node_modules", ".bin", "pi"), [
		"--mode", "rpc", "--offline", "--no-session", "--no-context-files", "--no-skills", "--no-extensions",
		"--extension", join(resolve(process.cwd()), "extensions", "pi-graph.ts"),
	], {
		cwd: root,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const messages: Array<Record<string, unknown>> = [];
	let buffer = "";
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	let extensionAlive = false;
	const liveness = new Promise<void>((resolveLiveness, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (!extensionAlive) reject(new Error(`Pi RPC exited before the extension loaded (${String(code)}/${String(signal)}): ${stderr}`));
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let message: Record<string, unknown>;
				try {
					message = JSON.parse(line) as Record<string, unknown>;
				} catch {
					// pi may interleave non-JSON log lines on stdout; ignore them.
					continue;
				}
				messages.push(message);
				if (message.id === "commands" && message.type === "response") {
					extensionAlive = true;
					// Only observe commands; never invoke the graph tool.
					child.stdin.write(`${JSON.stringify({ id: "list", type: "prompt", message: "/graphs list" })}\n`);
					resolveLiveness();
				}
			}
		});
	});
	try {
		child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
		await liveness;
		// Give pi a bounded grace to answer /graphs list or produce any activity, then
		// assert the empty-session invariants from every observed message.
		await new Promise((resolveGrace) => setTimeout(resolveGrace, 3_000));
		// No graph tool call was invoked and no graph state wake was emitted.
		assert.equal(messages.some((m) => m.type === "tool_call"), false, "no tool call may occur without invoking graph");
		assert.equal(messages.some((m) => String(m.channel ?? "").includes("pi-graph:state")), false, "no graph state wake without a run");
		// The empty runs directory contains no graph runs (legacy .control lock infra is allowed).
		const graphRuns = (await readdir(runsDir)).filter((name) => !name.startsWith("."));
		assert.deepEqual(graphRuns, [], "empty session must not create graph runs");
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		await rm(root, { recursive: true, force: true });
	}
});
