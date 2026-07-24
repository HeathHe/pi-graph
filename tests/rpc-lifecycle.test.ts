import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AsyncRunDeadlineError, requestAsyncStop, waitForAsyncRun, waitForConfirmedStop } from "../src/lifecycle.ts";
import { recoverRunBySessionDir, RpcTimeoutError, SubagentRpcClient, subagentAsyncRoot, type EventBus } from "../src/rpc.ts";

class Bus implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	on(channel: string, handler: (data: unknown) => void) { const set = this.handlers.get(channel) ?? new Set(); set.add(handler); this.handlers.set(channel, set); return () => set.delete(handler); }
	emit(channel: string, data: unknown) { for (const handler of this.handlers.get(channel) ?? []) handler(data); }
}

async function asyncRun(prefix: string): Promise<{ asyncId: string; asyncDir: string }> {
	const asyncId = `${prefix}-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	return { asyncId, asyncDir };
}

test("RPC client correlates replies and times out missing bridges", async () => {
	const bus = new Bus();
	bus.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as { requestId: string };
		bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { pong: true } });
	});
	assert.deepEqual(await new SubagentRpcClient(bus, 100).call("ping"), { pong: true });
	await assert.rejects(() => new SubagentRpcClient(new Bus(), 10).call("ping"), RpcTimeoutError);
});

test("lifecycle exposes paused as a terminal supervisor state", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("paused");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "paused", mode: "single" }));
	assert.equal((await waitForAsyncRun({ events: bus, asyncId, asyncDir, timeoutMs: 1_000 })).state, "paused");
});

test("dispatch recovery matches descendant session directories and owner session", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-recover-"));
	const asyncDir = join(root, "run-1");
	await mkdir(asyncDir);
	const expected = join(root, "attempt", "session");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "run-1", state: "running", sessionId: "owner", sessionDir: join(expected, "async-run-1") }));
	assert.deepEqual(await recoverRunBySessionDir(expected, root, "owner"), { asyncId: "run-1", asyncDir });
	assert.equal(await recoverRunBySessionDir(expected, root, "other"), null);
});

test("stop confirmation does not treat paused as stopped", async () => {
	const { asyncId, asyncDir } = await asyncRun("stop-confirm");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "paused" }));
	setTimeout(() => void writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "stopped" })), 40);
	assert.equal(await waitForConfirmedStop(asyncDir, 1_000), true);
});

test("deadline quiescence may accept already-terminal failed or safe complete children", async () => {
	const failed = await asyncRun("deadline-failed");
	await writeFile(join(failed.asyncDir, "status.json"), JSON.stringify({ runId: failed.asyncId, state: "failed" }));
	assert.equal(await waitForConfirmedStop(failed.asyncDir, 20), false);
	assert.equal(await waitForConfirmedStop(failed.asyncDir, 20, { acceptFailed: true }), true);

	const complete = await asyncRun("deadline-complete");
	await writeFile(join(complete.asyncDir, "status.json"), JSON.stringify({ runId: complete.asyncId, state: "complete" }));
	assert.equal(await waitForConfirmedStop(complete.asyncDir, 20, { acceptComplete: true }), true);
});

test("lifecycle resolves from authoritative status and completion event", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("lifecycle");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", startedAt: Date.now(), mode: "single" }));
	const waiting = waitForAsyncRun({ events: bus, asyncId, asyncDir, timeoutMs: 1_000 });
	const output = join(asyncDir, "output.md");
	await writeFile(output, "done");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "complete", startedAt: Date.now(), mode: "single", outputFile: output }));
	bus.emit("subagent:async-complete", { runId: asyncId, asyncDir });
	const result = await waiting;
	assert.equal(result.state, "complete");
	assert.equal(result.output, "done");
});

test("lifecycle has no implicit deadline when timeoutMs is omitted", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("no-default-deadline");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", mode: "single" }));
	const waiting = waitForAsyncRun({ events: bus, asyncId, asyncDir });
	await new Promise((resolve) => setTimeout(resolve, 30));
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "complete", mode: "single" }));
	bus.emit("subagent:async-complete", { runId: asyncId, asyncDir });
	assert.equal((await waiting).state, "complete");
});

test("lifecycle reports only an explicitly configured hard deadline", async () => {
	const { asyncId, asyncDir } = await asyncRun("explicit-deadline");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", mode: "single" }));
	await assert.rejects(
		() => waitForAsyncRun({ events: new Bus(), asyncId, asyncDir, timeoutMs: 20 }),
		AsyncRunDeadlineError,
	);
});

test("lifecycle rejects immediately when monitoring starts with an aborted signal", async () => {
	const { asyncId, asyncDir } = await asyncRun("aborted");
	const controller = new AbortController();
	controller.abort("stop");
	await assert.rejects(() => waitForAsyncRun({ events: new Bus(), asyncId, asyncDir, timeoutMs: 10_000, signal: controller.signal }), /monitoring aborted/);
});

test("portable stop fallback writes the pi-subagents control request", async () => {
	const { asyncDir } = await asyncRun("stop-request");
	await requestAsyncStop(asyncDir);
	const request = JSON.parse(await (await import("node:fs/promises")).readFile(join(asyncDir, "control", "stop.json"), "utf8"));
	assert.equal(request.type, "stop");
	assert.equal(request.source, "pi-graph");
});

test("lifecycle rejects status identity mismatches and output paths outside the async run", async () => {
	const first = await asyncRun("identity-mismatch");
	await writeFile(join(first.asyncDir, "status.json"), JSON.stringify({ runId: `${first.asyncId}-other`, state: "complete" }));
	await assert.rejects(() => waitForAsyncRun({ events: new Bus(), ...first, timeoutMs: 1_000 }), /status identity/);

	const second = await asyncRun("output-escape");
	const outside = join(tmpdir(), `${second.asyncId}-outside.md`);
	await writeFile(outside, "outside");
	await writeFile(join(second.asyncDir, "status.json"), JSON.stringify({ runId: second.asyncId, state: "complete", outputFile: outside }));
	await assert.rejects(() => waitForAsyncRun({ events: new Bus(), ...second, timeoutMs: 1_000 }), /escapes its async run directory/);
});
