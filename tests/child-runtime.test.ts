import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ChildDispatchUnknownError, ChildRuntime, type ChildLineage } from "../src/child-runtime.ts";
import { RpcRejectedError, subagentAsyncRoot, SubagentRpcClient, type EventBus } from "../src/rpc.ts";

class SpawnBus implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	spawns = 0;
	respond = true;
	reject = false;
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
		if (!this.respond) return;
		if (this.reject) {
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: false, error: { code: "INVALID_AGENT", message: "Unknown agent." } });
			return;
		}
		const asyncId = `child-${request.requestId.slice(-20)}`;
		const asyncDir = join(subagentAsyncRoot(), asyncId);
		void (async () => {
			await mkdir(asyncDir, { recursive: true });
			await writeFile(join(asyncDir, "status.json"), JSON.stringify({
				runId: asyncId,
				state: "running",
				sessionId: request.params.ownerSessionId,
				sessionDir: join(request.params.sessionDir as string, "child"),
			}));
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { details: { asyncId, asyncDir } } });
		})();
	}
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-child-runtime-"));
	const sessionDir = join(root, "attempt-1", "session");
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
	const params = { agent: "scout", task: "inspect", sessionDir, ownerSessionId };
	return { root, lineage, params };
}

test("ChildRuntime binds one deterministic dispatch and reuses lookup without another spawn", async () => {
	const { root, lineage, params } = await fixture();
	const bus = new SpawnBus();
	const runtime = new ChildRuntime(new SubagentRpcClient(bus, 1_000));
	const first = await runtime.dispatch(lineage, params);
	const second = await runtime.dispatch(lineage, params);
	assert.deepEqual(second, first);
	assert.equal(bus.spawns, 1);
	const ledger = JSON.parse(await readFile(join(root, "attempt-1", "child-dispatch.json"), "utf8"));
	assert.equal(ledger.phase, "bound");
	assert.equal(ledger.lineage.attemptNonce, lineage.attemptNonce);
	await rm(first.asyncDir, { recursive: true, force: true });
});

test("ChildRuntime coalesces concurrent dispatch for the same attempt", async () => {
	const { lineage, params } = await fixture();
	const bus = new SpawnBus();
	const runtime = new ChildRuntime(new SubagentRpcClient(bus, 1_000));
	const results = await Promise.all(Array.from({ length: 20 }, () => runtime.dispatch(lineage, params)));
	assert.equal(bus.spawns, 1);
	assert.equal(new Set(results.map((result) => result.asyncId)).size, 1);
	await rm(results[0]!.asyncDir, { recursive: true, force: true });
});

test("ChildRuntime never re-emits a request after an unknown durable emit", async () => {
	const { root, lineage, params } = await fixture();
	const bus = new SpawnBus();
	bus.respond = false;
	const runtime = new ChildRuntime(new SubagentRpcClient(bus, 20));
	await assert.rejects(runtime.dispatch(lineage, params), ChildDispatchUnknownError);
	await assert.rejects(runtime.dispatch(lineage, params), /will not be re-emitted/);
	assert.equal(bus.spawns, 1);
	assert.equal(JSON.parse(await readFile(join(root, "attempt-1", "child-dispatch.json"), "utf8")).phase, "emitting");
});

test("ChildRuntime preserves an explicit spawn rejection instead of reporting an unknown outcome", async () => {
	const { lineage, params } = await fixture();
	const bus = new SpawnBus();
	bus.reject = true;
	const runtime = new ChildRuntime(new SubagentRpcClient(bus, 1_000));
	await assert.rejects(runtime.dispatch(lineage, params), RpcRejectedError);
	assert.equal(bus.spawns, 1);
});

test("ChildRuntime abandon tombstones the request and stops a late discovered child", async () => {
	const { root, lineage, params } = await fixture();
	const bus = new SpawnBus();
	bus.respond = false;
	const runtime = new ChildRuntime(new SubagentRpcClient(bus, 20), 10, 1_000, 1, 1);
	await assert.rejects(runtime.dispatch(lineage, params), ChildDispatchUnknownError);
	const asyncId = `late-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", sessionId: lineage.ownerSessionId, sessionDir: join(lineage.sessionDir, "late") }));
	const abandoned = await runtime.abandon(lineage, params, "operator stop");
	assert.equal(abandoned.stopped, true);
	assert.equal(JSON.parse(await readFile(join(root, "attempt-1", "child-tombstone.json"), "utf8")).dispatchKey.length, 64);
	assert.equal(JSON.parse(await readFile(join(asyncDir, "control", "stop.json"), "utf8")).type, "stop");
	await rm(asyncDir, { recursive: true, force: true });
	const laterId = `later-${randomUUID()}`;
	const laterDir = join(subagentAsyncRoot(), laterId);
	await mkdir(laterDir, { recursive: true });
	await writeFile(join(laterDir, "status.json"), JSON.stringify({ runId: laterId, state: "running", sessionId: lineage.ownerSessionId, sessionDir: join(lineage.sessionDir, "later") }));
	const enforced = await runtime.enforceTombstone(lineage);
	assert.equal(enforced?.stopped, true);
	assert.equal(JSON.parse(await readFile(join(laterDir, "control", "stop.json"), "utf8")).type, "stop");
	await rm(laterDir, { recursive: true, force: true });
});

test("tombstone reaper stops a child that appears after the immediate abandonment scan", async () => {
	const { lineage, params } = await fixture();
	const bus = new SpawnBus();
	bus.respond = false;
	const runtime = new ChildRuntime(new SubagentRpcClient(bus, 20), 10, 1_000, 1, 1);
	const originalLookup = runtime.lookup.bind(runtime);
	(runtime as any).lookup = async () => null;
	await runtime.abandon(lineage, params, "late process");
	(runtime as any).lookup = originalLookup;
	const asyncId = `reaper-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", sessionId: lineage.ownerSessionId, sessionDir: join(lineage.sessionDir, "reaper") }));
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		try {
			assert.equal(JSON.parse(await readFile(join(asyncDir, "control", "stop.json"), "utf8")).type, "stop");
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	assert.equal(JSON.parse(await readFile(join(asyncDir, "control", "stop.json"), "utf8")).type, "stop");
	await rm(asyncDir, { recursive: true, force: true });
});
