import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifySubagentCapabilities } from "../src/v3/runtime-compatibility.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { v3DispatchChild, v3MonitorChild } from "../src/v3/dispatch.ts";
import { MockSubagents, completeChild, nativePing } from "./helpers/mock-subagents.ts";
import { V3GraphHost } from "../src/v3/host.ts";
import { readLatestV3Attempt, writeV3AttemptEvidence } from "../src/v3/attempt.ts";

test("native public capabilities are sufficient without private supervision or byte hashes", () => {
 const ping = nativePing();
 assert.doesNotThrow(() => verifySubagentCapabilities(ping));
 assert.doesNotThrow(() => verifySubagentCapabilities({ ...ping, newField: "future" }));
 for (const key of ["processTerminalProof", "runtimeAcknowledgedExtensions", "asyncSpawn"]) {
  const changed = structuredClone(ping);
  delete (changed.capabilities as Record<string, unknown>)[key];
  assert.throws(() => verifySubagentCapabilities(changed), /owned runtime incompatible/);
 }
});
test("each dispatch rechecks public capabilities before crossing the durable emit boundary", async () => {
 const root = await mkdtemp(join(tmpdir(), "graph-capabilities-"));
 const bus = new MockSubagents(); bus.behaviors.set("inspect", completeChild); bus.start();
 const rpc = new SubagentRpcClient(bus);
 const spec = { agent: "worker", task: "inspect", cwd: root, sessionDir: join(root, "sessions") };
 try {
  const child = await v3DispatchChild(rpc, spec);
  assert.equal((await v3MonitorChild(rpc, child)).terminal, "complete");
  assert.equal(bus.spawned[0].params.noTimeout, undefined);
  rpc.call = async () => ({ capabilities: {} });
  let emitting = false;
  await assert.rejects(v3DispatchChild(rpc, spec, { beforeSpawn: async () => { emitting = true; } }), /owned runtime incompatible/);
  assert.equal(emitting, false); assert.equal(bus.spawned.length, 1);
 } finally { await bus.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("runtime incompatibility is durably recorded as not dispatched, without ambiguous ownership or validation", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "graph-runtime-rejection-")));
	const source = join(root, "source");
	await mkdir(source); await mkdir(join(root, "runs"));
	const bus = new MockSubagents(); bus.start();
	const workspace = join(root, "runs/runtime-rejected/shadow/worker-1/workspace");
	const checkpoint = join(root, "workspace-checkpoint");
	let captured = false;
	const rpc = new SubagentRpcClient(bus, 1000, async () => {
		if (!captured) { await cp(workspace, checkpoint, { recursive: true }); captured = true; }
		throw new Error("pi-subagents runtime incompatible: fixture");
	});
	const host = new V3GraphHost({ rpc, runsDir: join(root, "runs"), sessionId: "session", supervisorEpoch: "epoch", preflightAgent: async () => undefined });
	try {
		const snapshot = await host.start({ schemaVersion: 3, graphId: "runtime-rejected", goal: "verify admission", nodes: [{ taskId: "worker", agent: "worker", task: "must not run", sideEffect: "none" }] }, source);
		const settled = await host.waitForCompletion(snapshot.graphId);
		assert.equal(settled.status, "failed");
		assert.equal(bus.spawned.length, 0);
		const attempt = (await readLatestV3Attempt(join(root, "runs", snapshot.graphId), "worker"))!.evidence;
		assert.equal(attempt.phase, "failed");
		assert.equal(attempt.dispatchIntent?.state, "prepared");
		assert.equal(attempt.dispatch, undefined);
		assert.equal(attempt.child, undefined);
		assert.notEqual(attempt.failure?.kind, "dispatch_unknown");
		assert.match(attempt.failure!.message, /was not dispatched.*runtime incompatible/);
		// Reconstruct the checkpoint left by a host crash before compatibility
		// checking finished. Recovery must not claim it crossed the emit boundary.
		await cp(checkpoint, workspace, { recursive: true });
		await writeV3AttemptEvidence(snapshot.runDir, "worker", attempt.attempt, { ...attempt, phase: "prepared", terminalStatus: undefined, failure: undefined });
		await host.resume(snapshot.graphId);
		const resumed = await host.waitForCompletion(snapshot.graphId);
		const recovered = (await readLatestV3Attempt(snapshot.runDir, "worker"))!.evidence;
		assert.equal(resumed.status, "failed", JSON.stringify(recovered.failure));
		assert.equal(recovered.attempt, attempt.attempt);
		assert.equal(recovered.dispatchIntent?.state, "prepared");
		assert.equal(recovered.dispatch, undefined);
		assert.notEqual(recovered.failure?.kind, "dispatch_unknown");
		assert.match(recovered.failure!.message, /was not dispatched.*runtime incompatible/);
		assert.equal(bus.spawned.length, 0);
	} finally { await bus.dispose(); await rm(root, { recursive: true, force: true }); }
});
