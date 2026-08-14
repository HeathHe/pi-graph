import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AsyncRunDeadlineError, requestAsyncStop, waitForAsyncRun, waitForConfirmedStop, waitForObservedProcessTerminal } from "../src/lifecycle.ts";
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

test("owner-bound recovery does not infer an owner when identity is omitted", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-recover-missing-owner-"));
	const expected = join(root, "attempt", "session");
	const asyncDir = join(root, "run-with-owner");
	await mkdir(asyncDir);
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "run-with-owner", state: "running", sessionId: "owner", sessionDir: join(expected, "child") }));
	assert.deepEqual(await recoverRunBySessionDir(expected, root), { asyncId: "run-with-owner", asyncDir }, "legacy unbound lookup remains compatible");
	assert.equal(await recoverRunBySessionDir(expected, root, "missing-owner"), null, "v2 callers must supply the exact authorized owner");
});

test("v2 dispatch recovery accepts only exact authorized owner representations", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-recover-owner-file-"));
	const expected = "/Users/heathhe/.pi/agent/graph-runs/20260813152126-bdd96540-060235/nodes/compute-and-emit-direct-e2e-token/attempt-1/session";
	const ownerSessionId = "direct-final-1786634402";
	const ownerSessionFile = "/tmp/pi-graph-e2e-direct-final.ICHHfw/sessions/2026-08-13T15-20-04-181Z_direct-final-1786634402.jsonl";
	const writeStatus = async (name: string, status: Record<string, unknown>) => {
		const asyncDir = join(root, name);
		await mkdir(asyncDir, { recursive: true });
		await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: name, state: "running", ...status }));
		return asyncDir;
	};

	const exactInnerId = "f0c89173-2561-441b-af5a-c3e60364359d";
	const exactDir = await writeStatus(exactInnerId, { sessionId: ownerSessionFile, sessionDir: join(expected, `async-${exactInnerId}`) });
	assert.deepEqual(await recoverRunBySessionDir(expected, root, ownerSessionId, ownerSessionFile), { asyncId: exactInnerId, asyncDir: exactDir });
	assert.equal(await recoverRunBySessionDir(expected, root, ownerSessionId, "/tmp/pi-graph-e2e-direct-final.ICHHfw/sessions/different.jsonl"), null);
	assert.equal(await recoverRunBySessionDir(expected, root, ownerSessionId), null);

	await writeStatus("missing-owner", { sessionDir: join(expected, "missing-owner") });
	assert.equal(await recoverRunBySessionDir(expected, root, "missing-owner-id", join(root, "sessions", "missing-owner.jsonl")), null);
	await writeStatus("unrelated-path", { sessionId: join(root, "unrelated", "different.jsonl"), sessionDir: join(expected, "unrelated") });
	assert.equal(await recoverRunBySessionDir(expected, root, "unrelated-owner-id", join(root, "sessions", "authorized.jsonl")), null);

	const logicalRoot = await mkdtemp(join(tmpdir(), "pi-graph-recover-logical-owner-"));
	const logicalExpected = join(logicalRoot, "attempt", "session");
	const logicalDir = join(logicalRoot, "logical-owner");
	await mkdir(logicalDir);
	await writeFile(join(logicalDir, "status.json"), JSON.stringify({ runId: "logical-owner", state: "running", sessionId: ownerSessionId, sessionDir: join(logicalExpected, "async-inner") }));
	assert.deepEqual(await recoverRunBySessionDir(logicalExpected, logicalRoot, ownerSessionId, ownerSessionFile), { asyncId: "logical-owner", asyncDir: logicalDir });
});

test("v2 dispatch recovery still rejects ambiguous exact owner matches", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-recover-ambiguous-owner-"));
	const expected = join(root, "attempt", "session");
	const ownerSessionId = "owner";
	const ownerSessionFile = join(root, "sessions", "owner.jsonl");
	for (const [name, sessionId] of [["logical-match", ownerSessionId], ["file-match", ownerSessionFile]] as const) {
		const asyncDir = join(root, name);
		await mkdir(asyncDir);
		await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: name, state: "running", sessionId, sessionDir: join(expected, name) }));
	}
	await assert.rejects(() => recoverRunBySessionDir(expected, root, ownerSessionId, ownerSessionFile), /Multiple pi-subagents runs match/);
});

test("stop confirmation does not treat paused as stopped", async () => {
	const { asyncId, asyncDir } = await asyncRun("stop-confirm");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "paused" }));
	setTimeout(() => void writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "stopped" })), 40);
	assert.equal(await waitForConfirmedStop(asyncDir, 1_000), true);
});

test("process-terminal sidecar proves exit before status projection catches up", async () => {
	const { asyncId, asyncDir } = await asyncRun("process-terminal-sidecar");
	const processInstanceId = `runner-${asyncId}`;
	const observedAt = Date.now();
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "failed" }));
	await writeFile(join(asyncDir, "process-terminal.json"), JSON.stringify({
		version: 1,
		state: "observed",
		runId: asyncId,
		runnerProcessInstanceId: processInstanceId,
		observedAt,
		instances: [{ processInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 1, signal: null }],
	}));
	assert.equal(await waitForObservedProcessTerminal(asyncId, asyncDir, 100), true);
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

test("lifecycle prefers the durable output file over completion summaries", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("durable-output");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", mode: "single" }));
	const waiting = waitForAsyncRun({ events: bus, asyncId, asyncDir, timeoutMs: 1_000 });
	const output = join(asyncDir, "output.log");
	const strictJson = '{"schemaVersion":2,"verdict":"pass"}';
	await writeFile(output, strictJson);
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "complete", mode: "single", outputFile: output }));
	bus.emit("subagent:async-complete", {
		runId: asyncId,
		asyncDir,
		results: [{ summary: "Async: spec-reviewer is detached", finalOutput: "event final output" }],
	});
	assert.equal((await waiting).output, strictJson);
});

test("planning lifecycle waits for the matching completion finalOutput instead of returning the combined output log", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("planning-final-output");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", mode: "single" }));
	const waiting = waitForAsyncRun({
		events: bus,
		asyncId,
		asyncDir,
		timeoutMs: 1_000,
		preferCompletionFinalOutput: true,
	});
	const output = join(asyncDir, "output-0.log");
	await writeFile(output, "review task input\n{not the final JSON}");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "complete", mode: "single", outputFile: output }));
	bus.emit("subagent:async-complete", {
		runId: `${asyncId}-other`,
		asyncDir: join(subagentAsyncRoot(), `${asyncId}-other`),
		results: [{ finalOutput: "wrong run" }],
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	bus.emit("subagent:async-complete", {
		runId: asyncId,
		asyncDir,
		results: [{ summary: "detached launcher summary", finalOutput: '{"schemaVersion":2,"verdict":"pass"}' }],
	});
	assert.equal((await waiting).output, '{"schemaVersion":2,"verdict":"pass"}');
});

test("planning lifecycle uses the normalized completion summary when the event omits finalOutput", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("planning-summary-output");
	const output = join(asyncDir, "output.log");
	await writeFile(output, "task input plus child output");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "complete", mode: "single", outputFile: output }));
	const waiting = waitForAsyncRun({ events: bus, asyncId, asyncDir, timeoutMs: 1_000, preferCompletionFinalOutput: true });
	bus.emit("subagent:async-complete", {
		runId: asyncId,
		asyncDir,
		results: [{ summary: '{"schemaVersion":2,"verdict":"pass"}' }],
	});
	assert.equal((await waiting).output, '{"schemaVersion":2,"verdict":"pass"}');
});

test("planning lifecycle does not require the combined output file when an exact completion output is available", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("planning-no-combined-output");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({
		runId: asyncId,
		state: "complete",
		mode: "single",
		outputFile: join(asyncDir, "not-yet-created.log"),
	}));
	const waiting = waitForAsyncRun({ events: bus, asyncId, asyncDir, timeoutMs: 1_000, preferCompletionFinalOutput: true });
	bus.emit("subagent:async-complete", {
		runId: asyncId,
		asyncDir,
		results: [{ finalOutput: '{"schemaVersion":2,"verdict":"pass"}' }],
	});
	assert.equal((await waiting).output, '{"schemaVersion":2,"verdict":"pass"}');
});

test("planning lifecycle fails closed when a matching completion omits all usable output", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("planning-empty-completion");
	const output = join(asyncDir, "output.log");
	await writeFile(output, "combined log must not be accepted");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "complete", mode: "single", outputFile: output }));
	const waiting = waitForAsyncRun({ events: bus, asyncId, asyncDir, timeoutMs: 1_000, preferCompletionFinalOutput: true });
	bus.emit("subagent:async-complete", { runId: asyncId, asyncDir, results: [{}] });
	await assert.rejects(() => waiting, /did not include usable final output/);
});

test("planning lifecycle fails closed after a bounded grace when terminal status outlives its completion event", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("planning-missed-completion");
	const output = join(asyncDir, "output.log");
	await writeFile(output, "combined log must not be accepted after recovery");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "complete", mode: "single", outputFile: output }));
	await assert.rejects(
		() => waitForAsyncRun({
			events: bus,
			asyncId,
			asyncDir,
			timeoutMs: 1_000,
			preferCompletionFinalOutput: true,
			completionEventGraceMs: 20,
		}),
		/not observed within 20ms of terminal status/,
	);
});

test("lifecycle prefers finalOutput over summary when no durable output file exists", async () => {
	const bus = new Bus();
	const { asyncId, asyncDir } = await asyncRun("completion-final-output");
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", mode: "single" }));
	const waiting = waitForAsyncRun({ events: bus, asyncId, asyncDir, timeoutMs: 1_000 });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "complete", mode: "single" }));
	bus.emit("subagent:async-complete", {
		runId: asyncId,
		asyncDir,
		results: [{ summary: "launcher summary", finalOutput: "reviewer final output" }],
	});
	assert.equal((await waiting).output, "reviewer final output");
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
