import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { V3GraphHost } from "../src/v3/host.ts";
import { initializeV3Run } from "../src/v3/initialize.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import type { GraphSnapshotV3 } from "../src/v3/types.ts";
import { MockSubagents } from "./helpers/mock-subagents.ts";

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "v3-session-isolation-")));
	const sourceDir = join(root, "source");
	const runsDir = join(root, "runs");
	await Promise.all([mkdir(sourceDir), mkdir(runsDir)]);
	const mock = new MockSubagents();
	mock.start();
	const hosts: V3GraphHost[] = [];
	return {
		root, sourceDir, runsDir, mock,
		async seed(graphId: string, sessionId: string) {
			const runDir = join(runsDir, graphId);
			const graph = compileGraphSpecV3({ schemaVersion: 3, graphId, goal: "saved open graph", mode: "open", nodes: [] });
			await initializeV3Run({ trustedRoot: runsDir, runDir, graph, sourceCwd: sourceDir, sessionId, supervisorEpoch: "old-epoch" });
			return runDir;
		},
		host(sessionId: string, onStateChange?: (snapshot: GraphSnapshotV3) => void) {
			const host = new V3GraphHost({ rpc: new SubagentRpcClient(mock), runsDir, sessionId, supervisorEpoch: "new-epoch", onStateChange, preflightAgent: async () => undefined });
			hosts.push(host);
			return host;
		},
		async dispose() {
			for (const host of hosts) {
				const ids = host.listActiveWork().map(item => item.id);
				await host.suspendAll();
				await Promise.all(ids.map(id => host.waitForCompletion(id)));
			}
			await mock.dispose();
			await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
		},
	};
}

async function filesAt(dir: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			for (const [name, value] of Object.entries(await filesAt(join(dir, entry.name)))) files[`${entry.name}/${name}`] = value;
		} else files[entry.name] = (await readFile(join(dir, entry.name))).toString("base64");
	}
	return files;
}

test("session-scoped adoption leaves another session's same-directory graph untouched", async () => {
	const f = await fixture();
	try {
		const runDir = await f.seed("foreign-open", "old-session");
		const before = await filesAt(runDir);
		const published: GraphSnapshotV3[] = [];
		const host = f.host("new-session", snapshot => published.push(snapshot));
		assert.deepEqual(await host.adoptCrashedRuns({ sessionId: "new-session" }), []);
		assert.deepEqual(host.listActiveWork(), []);
		assert.deepEqual(published, [], "startup must not publish the old Graph into the new session UI");
		assert.deepEqual(await filesAt(runDir), before, "startup must not change foreign control, snapshots, leases, or Attempts");
	} finally { await f.dispose(); }
});

test("session-scoped adoption restores only the original session's open graph", async () => {
	const f = await fixture();
	try {
		await f.seed("own-open", "resumed-session");
		const foreign = await f.seed("foreign-open", "another-session");
		const before = await filesAt(foreign);
		const published: GraphSnapshotV3[] = [];
		const host = f.host("resumed-session", snapshot => published.push(snapshot));
		assert.deepEqual(await host.adoptCrashedRuns({ sessionId: "resumed-session" }), [{ graphId: "own-open", outcome: "resumed" }]);
		assert.equal((await host.waitForCompletion("own-open")).status, "idle");
		assert.ok(published.length > 0);
		assert.ok(published.every(snapshot => snapshot.graphId === "own-open"));
		assert.deepEqual(await filesAt(foreign), before);
	} finally { await f.dispose(); }
});

test("adoption uses immutable admission session identity rather than the mutable snapshot", async () => {
	const f = await fixture();
	try {
		const runDir = await f.seed("foreign-snapshot", "original-session");
		const path = join(runDir, "snapshot.json");
		const snapshot = JSON.parse(await readFile(path, "utf8"));
		snapshot.sessionId = "new-session";
		await writeFile(path, JSON.stringify(snapshot));
		const before = await filesAt(runDir);
		assert.deepEqual(await f.host("new-session").adoptCrashedRuns({ sessionId: "new-session" }), []);
		assert.deepEqual(await filesAt(runDir), before);
	} finally { await f.dispose(); }
});

test("explicit status and resume still work for historical graphs from another session", async () => {
	const f = await fixture();
	try {
		await f.seed("historical-open", "old-session");
		const host = f.host("new-session");
		assert.deepEqual(await host.adoptCrashedRuns({ sessionId: "new-session" }), []);
		assert.equal((await host.status("historical-open")).graphId, "historical-open");
		assert.equal((await host.resume("historical-open")).status, "idle");
	} finally { await f.dispose(); }
});

test("extension startup, new, fork, resume, and reload respect Pi session identity", { timeout: 30_000 }, async () => {
	const f = await fixture();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let shutdown: (() => Promise<void>) | undefined;
	try {
		const agentDir = join(f.root, "agent");
		await mkdir(agentDir);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ graph: { runsDir: f.runsDir } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const jiti = createJiti(import.meta.url);
		const extension = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href).default;
		const { listBackgroundWorkProviders } = jiti(new URL("../src/runtime/background-work.ts",import.meta.url).href);
		const runDir = await f.seed("saved-open", "original-session");
		const hooks = new Map<string, (event: unknown, ctx?: unknown) => Promise<void>>();
		const states: GraphSnapshotV3[] = [];
		const widgets: unknown[] = [];
		const wakes: unknown[] = [];
  let graphTool:any;
		f.mock.on("pi-graph:state", value => states.push(value as GraphSnapshotV3));
		f.mock.on("pi-graph:background-work", value => wakes.push(value));
		extension({ events: f.mock, on: (name: string, handler: any) => hooks.set(name, handler), registerTool(tool:any) { graphTool=tool; }, registerCommand() {} });
		shutdown = async () => { await hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }); };
		const context = (sessionId: string) => ({
			cwd: f.sourceDir, mode: "tui",
			sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(f.root, `${sessionId}.jsonl`), getBranch: () => [] },
			ui: { theme: { fg: (_: string, value: string) => value }, setStatus() {}, setWidget: (_key: string, widget: unknown) => widgets.push(widget), notify() {} },
		});
		for (const reason of ["startup", "new", "fork"] as const) {
			const before = await filesAt(runDir);
			states.length = widgets.length = wakes.length = 0;
			await hooks.get("session_start")!({ type: "session_start", reason }, context(`new-${reason}`));
			assert.deepEqual(states, [], `${reason}: no old graph state must be published`);
			assert.ok(widgets.every(widget => widget === undefined), `${reason}: no old summary must appear`);
			assert.deepEqual(wakes, [], `${reason}: no old graph should enter background work`);
			assert.deepEqual(await filesAt(runDir), before);
			await shutdown();
		}
		for (const reason of ["resume", "reload"] as const) {
			states.length = widgets.length = 0;
			await hooks.get("session_start")!({ type: "session_start", reason }, context("original-session"));
			const deadline = Date.now() + 5_000;
			while (!states.some(snapshot => snapshot.status === "idle") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
			assert.ok(states.some(snapshot => snapshot.graphId === "saved-open" && snapshot.status === "idle"), `${reason}: the original Graph must recover`);
			assert.ok(widgets.every(widget => widget === undefined), `${reason}: idle graphs do not occupy the live widget`);
   const visible=await graphTool.execute("restored-status",{action:"status",id:"saved-open"},undefined,undefined,context("original-session"));
   assert.notEqual(visible.isError,true,JSON.stringify(visible));
   assert.match(visible.content[0].text,/saved-open/,`${reason}: restored Graph remains visible through public status`);
			const active = () => listBackgroundWorkProviders().find((provider: any) => provider.name === "pi-graph")!.listActiveWork();
			while (active().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
			assert.deepEqual(active(), [], "wait for the idle Supervisor to settle before shutdown commits pause intent");
			await shutdown();
		}
	} finally {
		await shutdown?.();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await f.dispose();
	}
});
