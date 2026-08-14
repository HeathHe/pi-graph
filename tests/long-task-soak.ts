import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { compileGraph } from "../src/compile.ts";
import { LeaseRegistry } from "../src/leases.ts";
import { loadValidatedRun } from "../src/reconciler.ts";
import { subagentAsyncRoot, type EventBus } from "../src/rpc.ts";
import { GraphRunner, initialSnapshot } from "../src/runner.ts";
import { GraphStore } from "../src/store.ts";
import type { GraphConfig, GraphNodeSpec, GraphSpec } from "../src/types.ts";
import { auditManagedLaunchContracts } from "../src/pi-subagents-preflight.ts";

const graphGuardAcknowledgement = { version: 1, source: "child-runtime", ids: ["pi-graph-guard"], omitted: 0 } as const;

interface SoakMetrics {
	durationMs: number;
	spawns: number;
	retries: number;
	maxActive: number;
	events: number;
	heapDeltaBytes: number;
}

interface ChildStatus {
	runId: string;
	state: string;
	sessionId: string;
	sessionDir: string;
	outputFile?: string;
	error?: string;
	steps?: Array<{ launchContractDigest?: string; runtimeAcknowledgedExtensions: typeof graphGuardAcknowledgement }>;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function marker(task: string): string {
	return task.match(/SOAK_(?:NODE|RESTART|WRITE):([A-Za-z0-9._-]+)/)?.[1] ?? createHash("sha256").update(task).digest("hex").slice(0, 12);
}

function parseGraphChildParams(params: Record<string, unknown>): Record<string, unknown> {
	const workflowScript = params.workflowScript;
	if (workflowScript === undefined) return params;
	if (typeof workflowScript !== "string") throw new Error("Expected a string Graph workflowScript.");
	const match = /^return await runs\.run\(("(?:[^"\\]|\\.)*"), (\{.*\})\);$/u.exec(workflowScript);
	if (!match) throw new Error("Unexpected Graph child workflowScript.");
	return JSON.parse(match[2]!) as Record<string, unknown>;
}

class SoakSubagents implements EventBus {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	private readonly taskAttempts = new Map<string, number>();
	private readonly requestIds = new Set<string>();
	private readonly childStatuses = new Map<string, ChildStatus>();
	private readonly childDelay: (task: string, attempt: number) => number;
	private active = 0;
	readonly asyncDirs = new Set<string>();
	spawns = 0;
	retries = 0;
	maxActive = 0;
	resourceWaits = 0;

	constructor(childDelay: (task: string, attempt: number) => number) {
		this.childDelay = childDelay;
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set();
		set.add(handler);
		this.handlers.set(channel, set);
		return () => {
			set.delete(handler);
			if (!set.size) this.handlers.delete(channel);
		};
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
		if (channel === "pi-graph:state" && (data as { status?: string }).status === "resource_wait") this.resourceWaits += 1;
		if (channel !== "subagents:rpc:v1:request") return;
		const request = data as { requestId: string; method: string; params: Record<string, unknown> };
		if (request.method === "stop") {
			void this.stopChild(request);
			return;
		}
		if (request.method !== "spawn") return;
		assert(!this.requestIds.has(request.requestId), `Duplicate durable dispatch: ${request.requestId}`);
		this.requestIds.add(request.requestId);
		this.spawns += 1;
		const innerParams = parseGraphChildParams(request.params);
		const task = String(innerParams.task ?? "");
		const taskMarker = marker(task);
		const attempt = (this.taskAttempts.get(taskMarker) ?? 0) + 1;
		this.taskAttempts.set(taskMarker, attempt);
		if (attempt > 1) this.retries += 1;
		void this.runChild(request, innerParams, task, taskMarker, attempt);
	}

	listenerCount(): number {
		return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0);
	}

	private async stopChild(request: { requestId: string; params: Record<string, unknown> }): Promise<void> {
		const asyncId = String(request.params.id ?? "");
		const status = this.childStatuses.get(asyncId);
		if (status) {
			const stopped = { ...status, state: "stopped" };
			this.childStatuses.set(asyncId, stopped);
			await writeFile(join(subagentAsyncRoot(), asyncId, "status.json"), JSON.stringify(stopped));
		}
		this.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			version: 1,
			requestId: request.requestId,
			success: true,
			data: { state: "stopping" },
		});
	}

	private async runChild(
		request: { requestId: string; params: Record<string, unknown> },
		innerParams: Record<string, unknown>,
		task: string,
		taskMarker: string,
		attempt: number,
	): Promise<void> {
		const suffix = createHash("sha256").update(request.requestId).digest("hex").slice(0, 32);
		const usesOuterWorkflow = typeof request.params.workflowScript === "string";
		const outerAsyncId = `pi-graph-soak-outer-${suffix}`;
		const outerAsyncDir = join(subagentAsyncRoot(), outerAsyncId);
		const innerAsyncId = `pi-graph-soak-inner-${suffix}`;
		const innerAsyncDir = join(subagentAsyncRoot(), innerAsyncId);
		if (usesOuterWorkflow) this.asyncDirs.add(outerAsyncDir);
		this.asyncDirs.add(innerAsyncDir);
		if (usesOuterWorkflow) await mkdir(outerAsyncDir, { recursive: true });
		await mkdir(innerAsyncDir, { recursive: true });
		const launchAudit = await auditManagedLaunchContracts({
			tasks: [innerParams],
			cwd: String(innerParams.cwd),
			requireExtensionSeal: true,
			graphWorkspaceKind: "shadow",
		});
		assert.equal(launchAudit.ok, true, launchAudit.issues.join(" "));
		const status: ChildStatus = {
			runId: innerAsyncId,
			state: "running",
			sessionId: "soak-session",
			sessionDir: usesOuterWorkflow ? join(String(innerParams.sessionDir), "child") : String(innerParams.sessionDir),
			steps: [{
				launchContractDigest: launchAudit.contracts[0]?.launchContractDigest,
				runtimeAcknowledgedExtensions: graphGuardAcknowledgement,
			}],
		};
		this.childStatuses.set(innerAsyncId, status);
		await writeFile(join(innerAsyncDir, "status.json"), JSON.stringify(status));
		if (usesOuterWorkflow) await writeFile(join(outerAsyncDir, "status.json"), JSON.stringify({ runId: outerAsyncId, state: "complete", sessionId: "soak-session", sessionDir: request.params.sessionDir, workflow: { value: { runId: innerAsyncId, artifactPaths: [innerAsyncDir] } } }));
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		this.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			version: 1,
			requestId: request.requestId,
			success: true,
			data: { details: { asyncId: usesOuterWorkflow ? outerAsyncId : innerAsyncId, asyncDir: usesOuterWorkflow ? outerAsyncDir : innerAsyncDir } },
		});
		try {
			await delay(this.childDelay(task, attempt));
			if (this.childStatuses.get(innerAsyncId)?.state === "stopped") return;
			if (task.includes("RETRY_ONCE") && attempt === 1) {
				const failed = { ...status, state: "failed", error: "Synthetic first-attempt failure." };
				this.childStatuses.set(innerAsyncId, failed);
				await writeFile(join(innerAsyncDir, "status.json"), JSON.stringify(failed));
				this.emit("subagent:async-complete", { runId: innerAsyncId, asyncDir: innerAsyncDir });
				return;
			}
			if (task.includes("SOAK_WRITE:")) {
				await writeFile(join(String(innerParams.cwd), "shared.txt"), `${taskMarker}\n`);
			}
			const output = String(innerParams.output);
			await mkdir(dirname(output), { recursive: true });
			await writeFile(output, `completed ${taskMarker} attempt ${attempt}\n`);
			const outputLog = join(innerAsyncDir, "output.log");
			await writeFile(outputLog, `completed ${taskMarker} attempt ${attempt}\n`);
			const completed = { ...status, state: "complete", outputFile: outputLog };
			this.childStatuses.set(innerAsyncId, completed);
			await writeFile(join(innerAsyncDir, "status.json"), JSON.stringify(completed));
			this.emit("subagent:async-complete", { runId: innerAsyncId, asyncDir: innerAsyncDir });
		} finally {
			this.active -= 1;
		}
	}

	async cleanup(): Promise<void> {
		await Promise.all([...this.asyncDirs].map((path) => rm(path, { recursive: true, force: true })));
	}
}

function graphConfig(runsDir: string, maxSpawnBudget: number, maxConcurrency = 6): GraphConfig {
	return {
		enabled: true,
		runsDir,
		maxConcurrency,
		readOnlyBurst: maxConcurrency,
		maxSpawnBudget,
		rpcTimeoutMs: 2_000,
		validationTimeoutMs: 10_000,
		notifyOnComplete: false,
		runtimeV2Dispatch: true,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await delay(20);
	assert(predicate(), `Timed out waiting for ${label}.`);
}

async function eventCount(store: GraphStore): Promise<number> {
	const text = await readFile(store.path("events.jsonl"), "utf8");
	const events = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { seq: number });
	for (let index = 1; index < events.length; index += 1) {
		assert(events[index]!.seq > events[index - 1]!.seq, "Graph event sequence must remain monotonic.");
	}
	return events.length;
}

async function runSustainedDag(root: string, requestedDurationMs: number): Promise<SoakMetrics> {
	const runs = join(root, "sustained-runs");
	const layers = 12;
	const width = 6;
	const childDelayMs = Math.max(500, Math.floor(requestedDurationMs / (layers * 1.25)));
	const nodes: GraphNodeSpec[] = [];
	let retryNodes = 0;
	for (let layer = 0; layer < layers; layer += 1) {
		const previous = layer === 0 ? [] : Array.from({ length: width }, (_, index) => `l${layer - 1}n${index}`);
		for (let index = 0; index < width; index += 1) {
			const taskId = `l${layer}n${index}`;
			const retry = (layer * width + index) % 11 === 0;
			if (retry) retryNodes += 1;
			nodes.push({
				taskId,
				agent: "code-scout",
				task: `SOAK_NODE:${taskId}${retry ? " RETRY_ONCE" : ""}`,
				dependsOn: previous,
				outputArtifact: `${taskId}.md`,
				sideEffect: "none",
				timeoutMs: Math.max(10_000, childDelayMs * 4),
				retryPolicy: retry
					? { maxAttempts: 2, backoffMs: 50, retryOn: ["failed"] }
					: { maxAttempts: 1 },
			});
		}
	}
	const budget = nodes.length + retryNodes;
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "soak-sustained",
		goal: "Sustain bounded parallel Graph execution.",
		workspace: "shadow",
		maxConcurrency: width,
		nodes,
	}, root, budget, 2);
	const snapshot = initialSnapshot(graph, root, "soak-session", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new SoakSubagents((task, attempt) => task.includes("RETRY_ONCE") && attempt === 1 ? Math.max(250, childDelayMs / 4) : childDelayMs);
	const beforeHeap = process.memoryUsage().heapUsed;
	const started = performance.now();
	try {
		const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), graphConfig(runs, budget)).run();
		const durationMs = performance.now() - started;
		assert.equal(terminal.status, "complete", JSON.stringify(terminal));
		assert(Object.values(terminal.nodes).every((node) => node.status === "accepted"));
		assert.equal(bus.spawns, budget);
		assert.equal(bus.retries, retryNodes);
		assert.equal(bus.maxActive, width);
		assert.equal((await loadValidatedRun(store, budget)).snapshot.status, "complete");
		await delay(50);
		assert.equal(bus.listenerCount(), 0, "Long DAG leaked event listeners.");
		(globalThis as { gc?: () => void }).gc?.();
		return {
			durationMs,
			spawns: bus.spawns,
			retries: bus.retries,
			maxActive: bus.maxActive,
			events: await eventCount(store),
			heapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap,
		};
	} finally {
		await bus.cleanup();
	}
}

async function runSuspendResume(root: string): Promise<{ spawns: number; suspendedRunning: number; durationMs: number }> {
	const runs = join(root, "resume-runs");
	const nodes: GraphNodeSpec[] = Array.from({ length: 3 }, (_, index) => ({
		taskId: `branch-${index}`,
		agent: "code-scout",
		task: `SOAK_RESTART:branch-${index}`,
		outputArtifact: `branch-${index}.md`,
		sideEffect: "none",
		timeoutMs: 15_000,
	}));
	nodes.push({
		taskId: "join",
		agent: "code-scout",
		task: "SOAK_RESTART:join",
		dependsOn: ["branch-0", "branch-1", "branch-2"],
		outputArtifact: "join.md",
		sideEffect: "none",
		timeoutMs: 15_000,
	});
	const budget = nodes.length;
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "soak-suspend-resume",
		goal: "Recover long-running children without duplicate dispatch.",
		workspace: "shadow",
		maxConcurrency: 3,
		nodes,
	}, root, budget, 2);
	const initial = initialSnapshot(graph, root, "soak-session", 2);
	const firstStore = new GraphStore(runs, graph.graphId);
	await firstStore.initialize(graph, initial);
	const bus = new SoakSubagents(() => 3_500);
	const started = performance.now();
	try {
		const firstRunner = new GraphRunner(graph, initial, firstStore, bus, new LeaseRegistry(join(runs, ".control", "leases")), graphConfig(runs, budget, 3));
		const firstRun = firstRunner.run();
		try {
			await waitFor(() => bus.maxActive === 3, 15_000, "three active children before suspension");
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)} Snapshot: ${JSON.stringify(await firstStore.loadSnapshot())}`);
		}
		firstRunner.suspend();
		const suspended = await firstRun;
		const suspendedRunning = Object.values(suspended.nodes).filter((node) => node.status === "running").length;
		assert.equal(suspended.status, "running");
		assert.equal(suspendedRunning, 3);
		const spawnsBeforeResume = bus.spawns;
		const resumedStore = new GraphStore(runs, graph.graphId);
		const resumedSnapshot = await resumedStore.loadSnapshot();
		const terminal = await new GraphRunner(graph, resumedSnapshot, resumedStore, bus, new LeaseRegistry(join(runs, ".control", "leases")), graphConfig(runs, budget, 3)).run();
		assert.equal(terminal.status, "complete");
		assert.equal(spawnsBeforeResume, 3);
		assert.equal(bus.spawns, 4, "Resume must monitor the three existing children and spawn only the downstream join.");
		assert.equal((await loadValidatedRun(resumedStore, budget)).snapshot.status, "complete");
		await delay(50);
		assert.equal(bus.listenerCount(), 0, "Suspend/resume leaked event listeners.");
		return { spawns: bus.spawns, suspendedRunning, durationMs: performance.now() - started };
	} finally {
		await bus.cleanup();
	}
}

async function activeReservationFiles(root: string): Promise<string[]> {
	const output: string[] = [];
	async function visit(path: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (entry.name === ".history") continue;
			const target = join(path, entry.name);
			if (entry.isDirectory()) await visit(target);
			else output.push(target);
		}
	}
	await visit(root);
	return output;
}

async function runWriteContention(root: string): Promise<{ resourceWaits: number; spawns: number; finalValue: string; durationMs: number }> {
	const runs = join(root, "contention-runs");
	const source = join(root, "shared.txt");
	await writeFile(source, "initial\n");
	const started = performance.now();
	const bus = new SoakSubagents((task) => task.includes("SOAK_WRITE:A") ? 2_500 : 1_000);
	const makeGraph = (id: "a" | "b", value: "A" | "B") => compileGraph({
		schemaVersion: 1,
		graphId: `soak-writer-${id}`,
		goal: `Serialize writer ${value}.`,
		workspace: "shadow",
		nodes: [{
			taskId: "write",
			agent: "document-writer",
			task: `SOAK_WRITE:${value}`,
			outputArtifact: `${id}.md`,
			sideEffect: "local_write",
			writeScope: [{ kind: "file", path: "shared.txt" }],
			validationCommands: ["test -f shared.txt"],
			timeoutMs: 15_000,
		}],
	} satisfies GraphSpec, root, 1, 2);
	const graphA = makeGraph("a", "A");
	const graphB = makeGraph("b", "B");
	const storeA = new GraphStore(runs, graphA.graphId);
	const storeB = new GraphStore(runs, graphB.graphId);
	const snapshotA = initialSnapshot(graphA, root, "soak-session", 2);
	const snapshotB = initialSnapshot(graphB, root, "soak-session", 2);
	await storeA.initialize(graphA, snapshotA);
	await storeB.initialize(graphB, snapshotB);
	const config = graphConfig(runs, 1, 2);
	try {
		const [terminalA, terminalB] = await Promise.all([
			new GraphRunner(graphA, snapshotA, storeA, bus, new LeaseRegistry(join(runs, ".control", "leases")), config).run(),
			new GraphRunner(graphB, snapshotB, storeB, bus, new LeaseRegistry(join(runs, ".control", "leases")), config).run(),
		]);
		assert.equal(terminalA.status, "complete");
		assert.equal(terminalB.status, "complete");
		assert.equal(bus.spawns, 2);
		assert(bus.resourceWaits > 0, "Overlapping writers did not exercise resource_wait.");
		assert.equal((await activeReservationFiles(join(runs, ".control", "source-reservations"))).length, 0);
		await delay(50);
		assert.equal(bus.listenerCount(), 0, "Write contention leaked event listeners.");
		return {
			resourceWaits: bus.resourceWaits,
			spawns: bus.spawns,
			finalValue: (await readFile(source, "utf8")).trim(),
			durationMs: performance.now() - started,
		};
	} finally {
		await bus.cleanup();
	}
}

async function main(): Promise<void> {
	const requestedDurationMs = Number(process.env.PI_GRAPH_SOAK_MS ?? 60_000);
	assert(Number.isInteger(requestedDurationMs) && requestedDurationMs >= 15_000 && requestedDurationMs <= 1_800_000, "PI_GRAPH_SOAK_MS must be 15000..1800000.");
	const root = await mkdtemp(join(tmpdir(), "pi-graph-long-task-soak-"));
	let peakRss = process.memoryUsage().rss;
	const sampler = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
	}, 250);
	try {
		const sustained = await runSustainedDag(root, requestedDurationMs);
		const resume = await runSuspendResume(root);
		const contention = await runWriteContention(root);
		console.log(JSON.stringify({
			ok: true,
			requestedDurationMs,
			totalDurationMs: Math.round(sustained.durationMs + resume.durationMs + contention.durationMs),
			peakRssBytes: peakRss,
			sustained: { ...sustained, durationMs: Math.round(sustained.durationMs) },
			resume: { ...resume, durationMs: Math.round(resume.durationMs) },
			contention: { ...contention, durationMs: Math.round(contention.durationMs) },
		}, null, 2));
	} finally {
		clearInterval(sampler);
		await rm(root, { recursive: true, force: true });
	}
}

await main();
