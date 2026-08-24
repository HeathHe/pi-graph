import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { canonicalDigest } from "../src/v3/digests.ts";
import { GraphV3Error } from "../src/v3/errors.ts";
import {
	appendV3GraphNodes,
	cancelV3GraphNodes,
	readV3MutationJournal,
	sealV3Graph,
	V3RevisionConflictError,
} from "../src/v3/mutations.ts";
import { v3EvaluateNodeReadiness, v3ReadyNodes } from "../src/v3/scheduler.ts";
import type { GraphNodeSpecV3, GraphSpecV3, V3NodePhase } from "../src/v3/types.ts";

function node(taskId: string, dependsOn: string[] = [], extra: Partial<GraphNodeSpecV3> = {}): GraphNodeSpecV3 {
	return {
		taskId,
		agent: "worker",
		task: `Execute ${taskId}.`,
		dependsOn,
		sideEffect: "none",
		...extra,
	};
}

function spec(mode: "sealed" | "open" | undefined, nodes: GraphNodeSpecV3[]): GraphSpecV3 {
	return {
		schemaVersion: 3,
		graphId: "dynamic-core",
		goal: "Exercise dynamic topology safely.",
		nodes,
		...(mode === undefined ? {} : { mode }),
	};
}

async function runDirectory(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

const emptyView = { phaseOf: (_taskId: string): V3NodePhase | undefined => undefined };

test("V3 compiler preserves sealed/static projections while open graphs may start empty", () => {
	const historical = compileGraphSpecV3(spec(undefined, [node("root")]));
	const explicitSealed = compileGraphSpecV3(spec("sealed", [node("root")]));
	const open = compileGraphSpecV3(spec("open", [node("root")]));
	assert.equal(Object.prototype.hasOwnProperty.call(historical, "mode"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(explicitSealed, "mode"), false);
	assert.equal(open.mode, "open");
	assert.equal(historical.graphDigest, explicitSealed.graphDigest);
	assert.equal(historical.graphDigest, open.graphDigest, "topology lifecycle is journal authority, not a rewrite of the historical graph projection");
	assert.equal(compileGraphSpecV3(spec("open", [])).nodes.length, 0);
	assert.throws(() => compileGraphSpecV3(spec(undefined, [])), /non-empty unless mode is 'open'/u);
});

test("V3 compiler accepts only direct-dependency accepted/failed conditions", () => {
	const compiled = compileGraphSpecV3(spec(undefined, [
		node("source"),
		node("repair", ["source"], { when: { node: "source", status: "failed" } }),
	]));
	assert.deepEqual(compiled.nodes.find((entry) => entry.taskId === "repair")?.when, { node: "source", status: "failed" });
	assert.throws(() => compileGraphSpecV3(spec(undefined, [
		node("source"),
		node("repair", [], { when: { node: "source", status: "failed" } }),
	])), /must be listed in dependsOn/u);
	assert.throws(() => compileGraphSpecV3(spec(undefined, [
		node("source"),
		node("repair", ["source"], { when: { node: "missing", status: "accepted" } }),
	])), /references unknown task/u);
	assert.throws(() => compileGraphSpecV3({
		...spec(undefined, [node("source")]),
		nodes: [node("source"), { ...node("repair", ["source"]), when: { node: "source", status: "blocked" } }],
	}), /when.status must be 'accepted' or 'failed'/u);
});

test("V3 append persists an immutable digest-chained revision and may reference old or same-batch nodes", async () => {
	const runDir = await runDirectory("pi-graph-v3-mutations-");
	const base = compileGraphSpecV3(spec("open", [node("root", [], { outputArtifact: "artifacts/root.txt" })]));
	let assertCalls = 0;
	let fenceCalls = 0;
	const state = await appendV3GraphNodes({
		runDir,
		baseGraph: base,
		expectedRevision: 0,
		nodes: [
			node("branch", ["root"], { inputArtifacts: ["artifacts/root.txt"], outputArtifact: "artifacts/branch.txt" }),
			node("join", ["branch"], { inputArtifacts: ["artifacts/branch.txt"], when: { node: "branch", status: "accepted" } }),
		],
		capability: {
			assertCurrent: () => { assertCalls += 1; },
			withFence: async (operation) => {
				fenceCalls += 1;
				return operation();
			},
		},
		now: () => "2026-08-24T00:00:00.000Z",
	});
	assert.equal(assertCalls, 2);
	assert.equal(fenceCalls, 1);
	assert.equal(state.revision, 1);
	assert.equal(state.sealed, false);
	assert.deepEqual(state.graph.topologicalOrder, ["root", "branch", "join"]);
	assert.deepEqual(state.graph.nodes.find((entry) => entry.taskId === "join")?.when, { node: "branch", status: "accepted" });
	assert.deepEqual(state.mutations.map((mutation) => mutation.type), ["append"]);
	assert.match(state.mutations[0]!.mutationDigest, /^[a-f0-9]{64}$/u);
	assert.deepEqual(await readV3MutationJournal(runDir, base), state);

	await assert.rejects(appendV3GraphNodes({ runDir, baseGraph: base, expectedRevision: 1, nodes: [node("root")] }), /immutable and already exists/u);
	assert.equal((await readV3MutationJournal(runDir, base)).revision, 1, "invalid append must not publish a revision");
	await assert.rejects(
		appendV3GraphNodes({ runDir, baseGraph: base, expectedRevision: 0, nodes: [node("late")] }),
		(error: unknown) => error instanceof V3RevisionConflictError && error.expectedRevision === 0 && error.currentRevision === 1,
	);
});

test("V3 revision files provide atomic CAS when two appends race", async () => {
	const runDir = await runDirectory("pi-graph-v3-mutation-race-");
	const base = compileGraphSpecV3(spec("open", []));
	const results = await Promise.allSettled([
		appendV3GraphNodes({ runDir, baseGraph: base, expectedRevision: 0, nodes: [node("alpha")] }),
		appendV3GraphNodes({ runDir, baseGraph: base, expectedRevision: 0, nodes: [node("beta")] }),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
	assert.ok(rejected?.reason instanceof V3RevisionConflictError);
	const current = await readV3MutationJournal(runDir, base);
	assert.equal(current.revision, 1);
	assert.equal(current.graph.nodes.length, 1);
	assert.equal(current.mutations.length, 1);
});

test("V3 revision CAS elects exactly one publisher across processes", async () => {
	const runDir = await runDirectory("pi-graph-v3-mutation-process-race-");
	const worker = `
		import { compileGraphSpecV3 } from "./src/v3/compiler.ts";
		import { appendV3GraphNodes } from "./src/v3/mutations.ts";
		const [runDir, taskId] = process.argv.slice(1);
		const base = compileGraphSpecV3({ schemaVersion: 3, graphId: "dynamic-core", goal: "Exercise dynamic topology safely.", mode: "open", nodes: [] });
		process.stdout.write("READY\\n");
		await new Promise((resolve) => process.stdin.once("data", resolve));
		try {
			await appendV3GraphNodes({ runDir, baseGraph: base, expectedRevision: 0, nodes: [{ taskId, agent: "worker", task: taskId, sideEffect: "none" }] });
			process.stdout.write("COMMITTED\\n");
		} catch (error) {
			if (error?.name !== "V3RevisionConflictError") throw error;
			process.stdout.write("CONFLICT\\n");
		}
	`;
	const children = ["alpha", "beta"].map((taskId) => spawn(process.execPath, [
		"--experimental-strip-types", "--input-type=module", "--eval", worker, runDir, taskId,
	], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }));
	const outputs = children.map((child) => {
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild, rejectChild) => {
			child.once("error", rejectChild);
			child.once("close", (code) => resolveChild({ code, stdout, stderr }));
		});
	});
	await Promise.all(children.map((child) => new Promise<void>((resolveReady, rejectReady) => {
		child.once("error", rejectReady);
		child.stdout.on("data", (chunk: string) => { if (chunk.includes("READY")) resolveReady(); });
	})));
	for (const child of children) child.stdin.end("GO\n");
	const results = await Promise.all(outputs);
	assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join("\n"));
	assert.equal(results.filter((result) => result.stdout.includes("COMMITTED")).length, 1);
	assert.equal(results.filter((result) => result.stdout.includes("CONFLICT")).length, 1);
	const current = await readV3MutationJournal(runDir, compileGraphSpecV3(spec("open", [])));
	assert.equal(current.revision, 1);
	assert.equal(current.graph.nodes.length, 1);
});

test("V3 revision publication survives pre- and post-publish process crashes without exposing partial authority", async () => {
	const prePublishRun = await runDirectory("pi-graph-v3-mutation-pre-publish-crash-");
	const base = compileGraphSpecV3(spec("open", []));
	// A process killed while writing its private staging inode may leave any
	// prefix behind, but it must not become a journal revision.
	await writeFile(join(prePublishRun, ".mutation-staging-dead-process.tmp"), "{\"partial\":");
	assert.equal((await readV3MutationJournal(prePublishRun, base)).revision, 0);
	assert.equal((await appendV3GraphNodes({ runDir: prePublishRun, baseGraph: base, expectedRevision: 0, nodes: [node("root")] })).revision, 1);

	const postPublishRun = await runDirectory("pi-graph-v3-mutation-post-publish-crash-");
	await appendV3GraphNodes({ runDir: postPublishRun, baseGraph: base, expectedRevision: 0, nodes: [node("root")] });
	const revision = join(postPublishRun, "mutation-journal", "revision-0000000000000001.json");
	// Model SIGKILL after the atomic link CAS but before staging unlink. The
	// final authority has nlink=2, yet is complete, digest-valid, and readable.
	await link(revision, join(postPublishRun, ".mutation-staging-dead-after-link.tmp"));
	const recovered = await readV3MutationJournal(postPublishRun, base);
	assert.equal(recovered.revision, 1);
	assert.equal(recovered.graph.nodes[0]?.taskId, "root");
});

test("V3 cancel records tombstones, enforces cascade atomically, and prevents appending onto cancelled branches", async () => {
	const runDir = await runDirectory("pi-graph-v3-cancel-");
	const base = compileGraphSpecV3(spec("open", [node("root"), node("branch", ["root"]), node("leaf", ["branch"])]));
	const cancelled = await cancelV3GraphNodes({
		runDir,
		baseGraph: base,
		expectedRevision: 0,
		taskIds: ["branch"],
		view: emptyView,
		now: () => "2026-08-24T01:00:00.000Z",
	});
	assert.deepEqual(cancelled.cancelledTaskIds, ["branch"]);
	assert.deepEqual(cancelled.mutations[0], {
		schemaVersion: 1,
		graphId: base.graphId,
		baseGraphDigest: base.graphDigest,
		baseSourceGraphSpecDigest: base.sourceGraphSpecDigest,
		revision: 1,
		previousMutationDigest: null,
		type: "cancel",
		requestedTaskIds: ["branch"],
		taskIds: ["branch"],
		cascade: false,
		at: "2026-08-24T01:00:00.000Z",
		mutationDigest: cancelled.mutations[0]!.mutationDigest,
	});
	await assert.rejects(
		appendV3GraphNodes({ runDir, baseGraph: base, expectedRevision: 1, nodes: [node("poisoned", ["branch"])] }),
		/depends on a cancelled branch/u,
	);
	assert.equal((await readV3MutationJournal(runDir, base)).revision, 1);

	const cascadingRun = await runDirectory("pi-graph-v3-cascade-");
	await assert.rejects(cancelV3GraphNodes({
		runDir: cascadingRun,
		baseGraph: base,
		expectedRevision: 0,
		taskIds: ["branch"],
		cascade: true,
		view: { phaseOf: (taskId) => taskId === "leaf" ? "running" : undefined },
	}), /cannot be cancelled while phase is 'running'/u);
	assert.equal((await readV3MutationJournal(cascadingRun, base)).revision, 0, "a rejected cascade must leave no partial tombstones");
	const cascaded = await cancelV3GraphNodes({
		runDir: cascadingRun,
		baseGraph: base,
		expectedRevision: 0,
		taskIds: ["branch"],
		cascade: true,
		view: emptyView,
	});
	assert.deepEqual(cascaded.cancelledTaskIds, ["branch", "leaf"]);
	assert.deepEqual(cascaded.mutations[0]?.type === "cancel" ? cascaded.mutations[0].taskIds : [], ["branch", "leaf"]);
});

test("V3 cancel never overwrites accepted/running authority and seal permanently closes mutations", async () => {
	const runDir = await runDirectory("pi-graph-v3-seal-");
	const base = compileGraphSpecV3(spec("open", [node("root")]));
	await assert.rejects(cancelV3GraphNodes({
		runDir,
		baseGraph: base,
		expectedRevision: 0,
		taskIds: ["root"],
		view: { phaseOf: () => "accepted" },
	}), /cannot be cancelled while phase is 'accepted'/u);
	const sealed = await sealV3Graph({ runDir, baseGraph: base, expectedRevision: 0, now: () => "2026-08-24T02:00:00.000Z" });
	assert.equal(sealed.revision, 1);
	assert.equal(sealed.sealed, true);
	assert.equal(sealed.mutations[0]?.type, "seal");
	await assert.rejects(appendV3GraphNodes({ runDir, baseGraph: base, expectedRevision: 1, nodes: [node("later")] }), /sealed and cannot be appended/u);
	await assert.rejects(cancelV3GraphNodes({ runDir, baseGraph: base, expectedRevision: 1, taskIds: ["root"], view: emptyView }), /sealed and cannot be cancelled/u);
	await assert.rejects(sealV3Graph({ runDir, baseGraph: base, expectedRevision: 1 }), /already sealed/u);
	assert.equal((await readV3MutationJournal(runDir, base)).revision, 1);
});

test("V3 cancel reads Attempt authority inside the same live Supervisor fence as publication", async () => {
	const runDir = await runDirectory("pi-graph-v3-cancel-fence-");
	const base = compileGraphSpecV3(spec("open", [node("root")]));
	let insideFence = false;
	let phaseReads = 0;
	await assert.rejects(cancelV3GraphNodes({
		runDir,
		baseGraph: base,
		expectedRevision: 0,
		taskIds: ["root"],
		capability: {
			assertCurrent: () => undefined,
			withFence: async (operation) => {
				insideFence = true;
				try {
					return await operation();
				} finally {
					insideFence = false;
				}
			},
		},
		view: {
			phaseOf: async () => {
				phaseReads += 1;
				assert.equal(insideFence, true, "Attempt authority must not be read before acquiring the publication fence");
				return "prepared" as const;
			},
		},
	}), /cannot be cancelled while phase is 'prepared'/u);
	assert.equal(phaseReads, 1);
	assert.equal((await readV3MutationJournal(runDir, base)).revision, 0);
});

test("V3 mutation journal fails closed on record tampering", async () => {
	const runDir = await runDirectory("pi-graph-v3-mutation-tamper-");
	const base = compileGraphSpecV3(spec("open", []));
	await appendV3GraphNodes({ runDir, baseGraph: base, expectedRevision: 0, nodes: [node("root")] });
	const path = join(runDir, "mutation-journal", "revision-0000000000000001.json");
	const record = JSON.parse(await readFile(path, "utf8"));
	record.nodes[0].task = "rewritten historical definition";
	await writeFile(path, JSON.stringify(record));
	await assert.rejects(readV3MutationJournal(runDir, base), /digest does not match/u);
	// Demonstrate that merely recomputing the leaf digest cannot detach it from its base identity.
	record.mutationDigest = canonicalDigest(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "mutationDigest")));
	record.baseGraphDigest = "0".repeat(64);
	await writeFile(path, JSON.stringify(record));
	await assert.rejects(readV3MutationJournal(runDir, base), /not bound to the base graph/u);
});

test("V3 scheduler readiness handles accepted/failed conditions and cancelled branches without side effects", () => {
	const graph = compileGraphSpecV3(spec("open", [
		node("source"),
		node("gate"),
		node("publish", ["source"], { when: { node: "source", status: "accepted" } }),
		node("repair", ["source"], { when: { node: "source", status: "failed" } }),
		node("repair-after-gate", ["source", "gate"], { when: { node: "source", status: "failed" } }),
		node("ordinary", ["source"]),
	]));
	const publish = graph.nodes.find((entry) => entry.taskId === "publish")!;
	const repair = graph.nodes.find((entry) => entry.taskId === "repair")!;
	const repairAfterGate = graph.nodes.find((entry) => entry.taskId === "repair-after-gate")!;
	const ordinary = graph.nodes.find((entry) => entry.taskId === "ordinary")!;
	assert.deepEqual(v3EvaluateNodeReadiness(publish, () => "accepted"), { state: "ready" });
	assert.equal(v3EvaluateNodeReadiness(repair, () => "accepted").state, "skipped");
	assert.deepEqual(v3EvaluateNodeReadiness(repair, () => "failed"), { state: "ready" });
	assert.equal(v3EvaluateNodeReadiness(publish, () => "failed").state, "skipped");
	assert.equal(v3EvaluateNodeReadiness(repair, () => "running").state, "waiting");
	assert.equal(v3EvaluateNodeReadiness(repair, () => "cancelled").state, "blocked");
	assert.equal(v3EvaluateNodeReadiness(ordinary, () => "failed").state, "blocked");
	assert.deepEqual(
		v3EvaluateNodeReadiness(repairAfterGate, (taskId) => taskId === "source" ? "failed" : undefined),
		{ state: "waiting", detail: "waiting for: gate" },
		"a matching condition must not bypass unrelated dependencies",
	);
	assert.deepEqual(
		v3EvaluateNodeReadiness(repairAfterGate, (taskId) => taskId === "source" ? "failed" : "accepted"),
		{ state: "ready" },
	);
	assert.deepEqual(v3ReadyNodes(graph, {
		phaseOf: (taskId) => taskId === "source" ? "failed" : taskId === "gate" ? "queued" : undefined,
	}).map((entry) => entry.taskId), ["repair"]);
});
