import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { ChildDispatchUnknownError, ChildPreparePreEmitError, ChildRuntime, type ChildLineage } from "../src/child-runtime.ts";
import { RpcPreEmitError, RpcRejectedError, subagentAsyncRoot, SubagentRpcClient, type EventBus } from "../src/rpc.ts";

class SpawnBus implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	spawns = 0;
	respond = true;
	reject = false;
	payloads: Record<string, unknown>[] = [];
	lineage?: ChildLineage;
	outerParams?: Record<string, unknown>;
	outerIdentity?: { asyncId: string; asyncDir: string };
	innerIdentity?: { asyncId: string; asyncDir: string };
	on(channel: string, handler: (data: unknown) => void) {
		const set = this.handlers.get(channel) ?? new Set();
		set.add(handler);
		this.handlers.set(channel, set);
		return () => set.delete(handler);
	}
	emit(channel: string, data: unknown) {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
		if (channel !== "subagents:rpc:v1:request") return;
		const request = data as { requestId: string; method: string; params: Record<string, unknown> };
		if (request.method !== "spawn") return;
		this.spawns += 1;
		this.payloads.push(request.params);
		if (!this.respond) return;
		if (this.reject) {
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: false, error: { code: "INVALID_WORKFLOW", message: "Unknown workflow." } });
			return;
		}
		void (async () => {
			const outerAsyncId = `outer-${request.requestId.slice(-20)}`;
			const outerAsyncDir = join(subagentAsyncRoot(), outerAsyncId);
			const innerAsyncId = `inner-${request.requestId.slice(-20)}`;
			const innerAsyncDir = join(subagentAsyncRoot(), innerAsyncId);
			this.outerIdentity = { asyncId: outerAsyncId, asyncDir: outerAsyncDir };
			this.innerIdentity = { asyncId: innerAsyncId, asyncDir: innerAsyncDir };
			await mkdir(outerAsyncDir, { recursive: true });
			await mkdir(innerAsyncDir, { recursive: true });
			await writeFile(join(innerAsyncDir, "status.json"), JSON.stringify({
				runId: innerAsyncId,
				state: "running",
				sessionId: this.lineage?.ownerSessionId,
				sessionDir: join(this.lineage!.sessionDir, "child"),
			}));
			await writeFile(join(outerAsyncDir, "status.json"), JSON.stringify({
				runId: outerAsyncId,
				state: "complete",
				sessionDir: request.params.sessionDir,
				workflow: { value: { runId: innerAsyncId, artifactPaths: [innerAsyncDir] } },
			}));
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { details: { asyncId: outerAsyncId, asyncDir: outerAsyncDir } } });
		})();
	}
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-child-runtime-"));
	const sessionDir = join(root, "attempt-1", "session", "inner");
	await mkdir(sessionDir, { recursive: true });
	const ownerSessionId = `owner-${randomUUID()}`;
	const lineage: ChildLineage = {
		runInstanceId: randomUUID(),
		graphId: "graph",
		taskId: "task",
		attempt: 1,
		attemptNonce: randomUUID(),
		sessionDir,
		ownerSessionId,
	};
	const authorizedParams = { agent: "scout", task: "inspect", sessionDir, ownerSessionId };
	const outerParams = { workflowScript: "return await spawnChild();", sessionDir: join(root, "attempt-1", "session", "outer"), ownerSessionId };
	return { root, lineage, authorizedParams, outerParams };
}

function runtime(bus: SpawnBus, timeoutMs = 1_000, ...timings: number[]) {
	return new ChildRuntime(new SubagentRpcClient(bus, timeoutMs), ...(timings as [number, number, number, number, number]));
}

function runtimeWithOwnerSessionFile(bus: SpawnBus, ownerSessionFile: string, timeoutMs = 1_000) {
	return new ChildRuntime(new SubagentRpcClient(bus, timeoutMs), 2_000, 24 * 60 * 60_000, 20, 250, 30_000, ownerSessionFile);
}

async function cleanupBus(bus: SpawnBus) {
	if (bus.outerIdentity) await rm(bus.outerIdentity.asyncDir, { recursive: true, force: true });
	if (bus.innerIdentity) await rm(bus.innerIdentity.asyncDir, { recursive: true, force: true });
}

async function waitForFile(path: string, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try { return await readFile(path, "utf8"); } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
	}
	return readFile(path, "utf8");
}

test("ChildRuntime lookup accepts the exact canonical parent session file identity without changing durable lineage", async () => {
	const { root, lineage } = await fixture();
	const ownerSessionFile = resolve(join(root, "sessions", `${lineage.ownerSessionId}.jsonl`));
	const asyncId = `real-0-47-1-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({
		runId: asyncId,
		state: "running",
		sessionId: ownerSessionFile,
		sessionDir: join(lineage.sessionDir, `async-${asyncId}`),
	}));
	try {
		assert.deepEqual(await runtimeWithOwnerSessionFile(new SpawnBus(), ownerSessionFile).lookup(lineage), { asyncId, asyncDir });
		assert.equal(await runtimeWithOwnerSessionFile(new SpawnBus(), join(root, "sessions", "different.jsonl")).lookup(lineage), null);
		assert.equal(await runtimeWithOwnerSessionFile(new SpawnBus(), ownerSessionFile).lookup({ ...lineage, ownerSessionId: undefined }), null);
		assert.equal(Object.hasOwn(lineage, "ownerSessionFile"), false, "session-file aliases must not enter durable lineage identity");
	} finally {
		await rm(asyncDir, { recursive: true, force: true });
	}
});

test("ChildRuntime emits only outer workflow params, returns the inner identity, and binds inner only", async () => {
	const { root, lineage, authorizedParams, outerParams } = await fixture();
	const bus = new SpawnBus();
	bus.lineage = lineage;
	const childRuntime = runtime(bus);
	const first = await childRuntime.dispatch(lineage, authorizedParams, outerParams);
	const second = await childRuntime.dispatch(lineage, authorizedParams, outerParams);
	assert.deepEqual(second, first);
	assert.deepEqual(first, { ...bus.innerIdentity!, dispatchKey: first.dispatchKey, requestDigest: first.requestDigest });
	assert.notEqual(first.asyncId, bus.outerIdentity?.asyncId);
	assert.equal(bus.spawns, 1);
	assert.equal(bus.payloads[0]?.workflowScript, outerParams.workflowScript);
	assert.equal(Object.hasOwn(bus.payloads[0]!, "agent"), false);
	assert.equal(Object.hasOwn(bus.payloads[0]!, "task"), false);
	const ledger = JSON.parse(await readFile(join(root, "attempt-1", "session", "child-dispatch.json"), "utf8"));
	assert.equal(ledger.phase, "bound");
	assert.equal(ledger.asyncId, bus.innerIdentity?.asyncId);
	assert.equal(ledger.outerAsyncId, undefined);
	assert.equal(ledger.requestDigest, createHash("sha256").update(JSON.stringify(authorizedParams)).digest("hex"));
	await cleanupBus(bus);
});

test("ChildRuntime waits for the exact inner session registration instead of entering dispatch recovery on a visibility race", async () => {
	const { lineage, authorizedParams, outerParams } = await fixture();
	const bus = new SpawnBus();
	bus.lineage = lineage;
	const childRuntime = runtime(bus, 1_000, 2_000, 24 * 60 * 60_000, 6, 5, 1_000);
	const originalLookup = childRuntime.lookup.bind(childRuntime);
	let lookups = 0;
	(childRuntime as unknown as { lookup: typeof childRuntime.lookup }).lookup = async (candidate) => {
		lookups += 1;
		if (lookups <= 3) return null;
		return originalLookup(candidate);
	};
	try {
		const result = await childRuntime.dispatch(lineage, authorizedParams, outerParams);
		assert.equal(result.asyncId, bus.innerIdentity?.asyncId);
		assert.equal(result.asyncDir, bus.innerIdentity?.asyncDir);
		assert.equal(bus.spawns, 1);
		assert.ok(lookups >= 4);
	} finally {
		await cleanupBus(bus);
	}
});

test("ChildRuntime coalesces concurrent workflow dispatch for the same attempt", async () => {
	const { lineage, authorizedParams, outerParams } = await fixture();
	const bus = new SpawnBus();
	bus.lineage = lineage;
	const childRuntime = runtime(bus);
	const results = await Promise.all(Array.from({ length: 20 }, () => childRuntime.dispatch(lineage, authorizedParams, outerParams)));
	assert.equal(bus.spawns, 1);
	assert.equal(new Set(results.map((result) => result.asyncId)).size, 1);
	await cleanupBus(bus);
});

test("ChildRuntime restores prepared state after pre-emit failures", async () => {
	const { root, lineage, authorizedParams, outerParams } = await fixture();
	const bus = new SpawnBus();
	bus.lineage = lineage;
	const childRuntime = runtime(bus);
	let preparedCallbacks = 0;
	await assert.rejects(childRuntime.dispatch(lineage, authorizedParams, outerParams, async () => {
		preparedCallbacks += 1;
		throw new Error("snapshot commit crashed");
	}), ChildPreparePreEmitError);
	assert.equal(bus.spawns, 0);
	assert.equal(JSON.parse(await readFile(join(root, "attempt-1", "session", "child-dispatch.json"), "utf8")).phase, "prepared");
	await assert.rejects(
		childRuntime.dispatch(lineage, authorizedParams, outerParams, async () => { preparedCallbacks += 1; }, () => { throw new Error("live registry drift"); }),
		RpcPreEmitError,
	);
	assert.equal(bus.spawns, 0);
	assert.equal(JSON.parse(await readFile(join(root, "attempt-1", "session", "child-dispatch.json"), "utf8")).phase, "prepared");
	const dispatched = await childRuntime.dispatch(lineage, authorizedParams, outerParams, async () => { preparedCallbacks += 1; });
	assert.equal(preparedCallbacks, 3);
	assert.equal(bus.spawns, 1);
	await cleanupBus(bus);
	assert.ok(dispatched.asyncId.startsWith("inner-"));
});

test("ChildRuntime reports only untombstoned prepared dispatches as replayable", async () => {
	const { lineage, authorizedParams, outerParams } = await fixture();
	const bus = new SpawnBus();
	bus.lineage = lineage;
	const childRuntime = runtime(bus, 1_000, 2_000, 24 * 60 * 60_000, 1, 1, 1_000);
	await assert.rejects(
		childRuntime.dispatch(lineage, authorizedParams, outerParams, async () => { throw new Error("leave prepared"); }),
		ChildPreparePreEmitError,
	);
	assert.equal(await childRuntime.hasReplayablePreparedDispatch(lineage, authorizedParams), true);
	await childRuntime.abandonKnown(lineage, "test tombstone");
	assert.equal(await childRuntime.hasReplayablePreparedDispatch(lineage, authorizedParams), false);
});

test("ChildRuntime preserves explicit workflow spawn rejection and replay semantics", async () => {
	const { lineage, authorizedParams, outerParams } = await fixture();
	const bus = new SpawnBus();
	bus.reject = true;
	const childRuntime = runtime(bus);
	await assert.rejects(childRuntime.dispatch(lineage, authorizedParams, outerParams), RpcRejectedError);
	await assert.rejects(childRuntime.dispatch(lineage, authorizedParams, outerParams), /will not be re-emitted/);
	assert.equal(bus.spawns, 1);
});

test("pre-alias emitting ledger resumes a 0.47.1 launcher without changing durable lineage", async () => {
	const { root, lineage, authorizedParams, outerParams } = await fixture();
	const ownerSessionFile = resolve(join(root, "sessions", `${lineage.ownerSessionId}.jsonl`));
	const bus = new SpawnBus();
	bus.lineage = lineage;
	const childRuntime = runtimeWithOwnerSessionFile(bus, ownerSessionFile);
	const requestDigest = createHash("sha256").update(JSON.stringify(authorizedParams)).digest("hex");
	const dispatchKey = createHash("sha256").update(JSON.stringify({ lineage, requestDigest })).digest("hex");
	const outerAsyncId = `outer-recovered-${randomUUID()}`;
	const outerAsyncDir = join(subagentAsyncRoot(), outerAsyncId);
	const innerAsyncId = `inner-recovered-${randomUUID()}`;
	const innerAsyncDir = join(subagentAsyncRoot(), innerAsyncId);
	await mkdir(outerAsyncDir, { recursive: true });
	await mkdir(innerAsyncDir, { recursive: true });
	await writeFile(join(innerAsyncDir, "status.json"), JSON.stringify({ runId: innerAsyncId, state: "running", sessionId: ownerSessionFile, sessionDir: join(lineage.sessionDir, `async-${innerAsyncId}`) }));
	await writeFile(join(outerAsyncDir, "status.json"), JSON.stringify({ runId: outerAsyncId, state: "complete", workflow: { value: { runId: innerAsyncId, artifactPaths: [innerAsyncDir] } } }));
	const now = new Date().toISOString();
	await writeFile(join(root, "attempt-1", "session", "child-dispatch.json"), JSON.stringify({ schemaVersion: 1, dispatchKey, requestId: `pi-graph-v2-${dispatchKey.slice(0, 40)}`, requestDigest, lineage, phase: "emitting", outerAsyncId, outerAsyncDir, createdAt: now, updatedAt: now }));
	const result = await childRuntime.dispatch(lineage, authorizedParams, outerParams);
	assert.equal(result.asyncId, innerAsyncId);
	assert.equal(bus.spawns, 0);
	const ledger = JSON.parse(await readFile(join(root, "attempt-1", "session", "child-dispatch.json"), "utf8"));
	assert.equal(ledger.phase, "bound");
	assert.equal(ledger.asyncId, innerAsyncId);
	assert.equal(ledger.outerAsyncId, undefined);
	assert.deepEqual(ledger.lineage, lineage);
	assert.equal(Object.hasOwn(ledger.lineage, "ownerSessionFile"), false);
	await rm(outerAsyncDir, { recursive: true, force: true });
	await rm(innerAsyncDir, { recursive: true, force: true });
});

test("ChildRuntime fails closed when workflow output is not an exact authorized inner identity", async () => {
	const { root, lineage, authorizedParams, outerParams } = await fixture();
	const bus = new SpawnBus();
	const childRuntime = runtime(bus);
	const requestDigest = createHash("sha256").update(JSON.stringify(authorizedParams)).digest("hex");
	const dispatchKey = createHash("sha256").update(JSON.stringify({ lineage, requestDigest })).digest("hex");
	const outerAsyncId = `outer-invalid-${randomUUID()}`;
	const outerAsyncDir = join(subagentAsyncRoot(), outerAsyncId);
	await mkdir(outerAsyncDir, { recursive: true });
	await writeFile(join(outerAsyncDir, "status.json"), JSON.stringify({ runId: outerAsyncId, state: "complete", workflow: { value: [{ runId: "one" }, { runId: "two" }] } }));
	const now = new Date().toISOString();
	await writeFile(join(root, "attempt-1", "session", "child-dispatch.json"), JSON.stringify({ schemaVersion: 1, dispatchKey, requestId: `pi-graph-v2-${dispatchKey.slice(0, 40)}`, requestDigest, lineage, phase: "emitting", outerAsyncId, outerAsyncDir, createdAt: now, updatedAt: now }));
	await assert.rejects(childRuntime.dispatch(lineage, authorizedParams, outerParams), ChildDispatchUnknownError);
	assert.equal(bus.spawns, 0);
	await rm(outerAsyncDir, { recursive: true, force: true });
});

test("tombstone stops a known outer launcher and then a late inner child", async () => {
	const { root, lineage, authorizedParams } = await fixture();
	const bus = new SpawnBus();
	const childRuntime = runtime(bus, 20, 10, 1_000, 20, 5, 1_000);
	const requestDigest = createHash("sha256").update(JSON.stringify(authorizedParams)).digest("hex");
	const dispatchKey = createHash("sha256").update(JSON.stringify({ lineage, requestDigest })).digest("hex");
	const outerAsyncId = `outer-abandon-${randomUUID()}`;
	const outerAsyncDir = join(subagentAsyncRoot(), outerAsyncId);
	await mkdir(outerAsyncDir, { recursive: true });
	await writeFile(join(outerAsyncDir, "status.json"), JSON.stringify({ runId: outerAsyncId, state: "running" }));
	const now = new Date().toISOString();
	await writeFile(join(root, "attempt-1", "session", "child-dispatch.json"), JSON.stringify({ schemaVersion: 1, dispatchKey, requestId: `pi-graph-v2-${dispatchKey.slice(0, 40)}`, requestDigest, lineage, phase: "emitting", outerAsyncId, outerAsyncDir, createdAt: now, updatedAt: now }));
	const abandoning = childRuntime.abandon(lineage, authorizedParams, "operator stop");
	const outerStopRequest = await waitForFile(join(outerAsyncDir, "control", "stop.json"));
	const innerAsyncId = `late-inner-${randomUUID()}`;
	const innerAsyncDir = join(subagentAsyncRoot(), innerAsyncId);
	await mkdir(innerAsyncDir, { recursive: true });
	await writeFile(join(innerAsyncDir, "status.json"), JSON.stringify({ runId: innerAsyncId, state: "running", sessionId: lineage.ownerSessionId, sessionDir: join(lineage.sessionDir, "late") }));
	const innerStopRequest = await waitForFile(join(innerAsyncDir, "control", "stop.json"));
	await writeFile(join(innerAsyncDir, "status.json"), JSON.stringify({ runId: innerAsyncId, state: "stopped", sessionId: lineage.ownerSessionId, sessionDir: join(lineage.sessionDir, "late") }));
	const abandoned = await abandoning;
	assert.equal(abandoned.stopped, true);
	assert.equal(abandoned.identity?.asyncId, innerAsyncId);
	// Capture the stop request content at observation time; a concurrent runtime may
	// acknowledge and remove control/stop.json after honoring it.
	assert.equal(JSON.parse(outerStopRequest).type, "stop");
	assert.equal(JSON.parse(innerStopRequest).type, "stop");
	await rm(outerAsyncDir, { recursive: true, force: true });
	await rm(innerAsyncDir, { recursive: true, force: true });
});

test("authorized abandonment and reaper continue to stop late inner children", async () => {
	const { lineage, authorizedParams } = await fixture();
	const childRuntime = runtime(new SpawnBus(), 20, 10, 1_000, 1, 1, 20);
	const requestDigest = createHash("sha256").update(JSON.stringify(authorizedParams)).digest("hex");
	const abandoned = await childRuntime.abandonAuthorized(lineage, requestDigest, "ledger was lost after authorized dispatch");
	assert.equal(abandoned.stopped, false);
	const asyncId = `reaper-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", sessionId: lineage.ownerSessionId, sessionDir: join(lineage.sessionDir, "child") }));
	await waitForFile(join(asyncDir, "control", "stop.json"));
	assert.equal(JSON.parse(await readFile(join(asyncDir, "control", "stop.json"), "utf8")).type, "stop");
	childRuntime.dispose();
	await rm(asyncDir, { recursive: true, force: true });
});

test("recovered abandonment replaces malformed ledger without weakening validation", async () => {
	const { lineage } = await fixture();
	const childRuntime = runtime(new SpawnBus(), 20, 10, 1_000, 1, 1, 20);
	await mkdir(dirname(lineage.sessionDir), { recursive: true });
	await writeFile(join(dirname(lineage.sessionDir), "child-dispatch.json"), "{torn");
	await childRuntime.abandonRecovered(lineage, "replace crash-truncated ledger during stop");
	const ledger = JSON.parse(await readFile(join(dirname(lineage.sessionDir), "child-dispatch.json"), "utf8"));
	assert.equal(ledger.phase, "abandoned");
	assert.equal(ledger.lineage.attemptNonce, lineage.attemptNonce);
	assert.match(ledger.requestDigest, /^[a-f0-9]{64}$/);
	childRuntime.dispose();
});

test("new reaper generation replaces old owner and disposed in-flight lookup cannot stop", async () => {
	const { lineage } = await fixture();
	const first = runtime(new SpawnBus(), 20, 5, 1_000, 1, 1);
	const second = runtime(new SpawnBus(), 20, 5, 1_000, 1, 1);
	const asyncId = `replacement-reaper-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	let releaseLookup!: () => void;
	let lookupStarted!: () => void;
	const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
	const gate = new Promise<void>((resolve) => { releaseLookup = resolve; });
	(first as any).lookup = async () => { lookupStarted(); await gate; return { asyncId, asyncDir }; };
	(second as any).lookup = async () => null;
	(first as any).scheduleTombstoneReaper(lineage);
	await started;
	(second as any).scheduleTombstoneReaper(lineage);
	releaseLookup();
	await new Promise((resolve) => setTimeout(resolve, 25));
	await assert.rejects(readFile(join(asyncDir, "control", "stop.json"), "utf8"), { code: "ENOENT" });
	const reaper = (ChildRuntime as any).reapers.get(join(dirname(lineage.sessionDir), "child-tombstone.json"));
	assert.equal(reaper?.owner, (second as any).reaperOwner);
	first.dispose();
	second.dispose();
	await rm(asyncDir, { recursive: true, force: true });
});
