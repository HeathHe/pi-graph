import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readLatestV3Attempt } from "../src/v3/attempt.ts";
import { validateAuthorizationV4 } from "../src/v3/authorization.ts";
import { V3GraphHost } from "../src/v3/host.ts";
import { validateGraphSnapshotV3 } from "../src/v3/snapshot.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import type { GraphSpecV3 } from "../src/v3/types.ts";
import { MockSubagents, completeChild } from "./helpers/mock-subagents.ts";

async function fixture() {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "v3-host-")));
	const sourceDir = join(sandbox, "source");
	await mkdir(sourceDir, { recursive: true });
	const runsDir = join(sandbox, "runs");
	await mkdir(runsDir, { recursive: true });
	return { sandbox, sourceDir, runsDir };
}

function hostFor(runsDir: string, mock: MockSubagents, sessionId = "session-test", supervisorEpoch = "epoch-1") {
	return new V3GraphHost({ rpc: new SubagentRpcClient(mock), runsDir, sessionId, supervisorEpoch, preflightAgent: async () => undefined });
}

test("E2E-1: V3 host runs a three-node A/B-parallel-then-C graph end to end", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	await writeFile(join(sourceDir, "input.txt"), "seed\n", "utf8");
	const mock = new MockSubagents();
	mock.behaviors.set("NODE_A", (input) => completeChild({ ...input, writes: [{ path: "out-a.txt", content: "a\n" }] }));
	mock.behaviors.set("NODE_B", (input) => completeChild({ ...input, writes: [{ path: "out-b.txt", content: "b\n" }] }));
	mock.behaviors.set("NODE_C", (input) => completeChild({ ...input, output: "c-output" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "write a and b then c",
		nodes: [
			{ taskId: "node-a", agent: "test-agent", task: "NODE_A write out-a.txt", sideEffect: "local_write", writeScope: [{ kind: "file", path: "out-a.txt" }], validationCommands: ["test -f out-a.txt"] },
			{ taskId: "node-b", agent: "test-agent", task: "NODE_B write out-b.txt", sideEffect: "local_write", writeScope: [{ kind: "file", path: "out-b.txt" }], validationCommands: ["test -f out-b.txt"] },
			{ taskId: "node-c", agent: "test-agent", task: "NODE_C depends on both", dependsOn: ["node-a", "node-b"], sideEffect: "local_read", readScope: [{ kind: "file", path: "input.txt" }] },
		],
	};
	const host = hostFor(runsDir, mock);
	const result = await host.start(spec, sourceDir);
	const snapshot = await host.waitForCompletion(result.graphId);
	assert.equal(snapshot.status, "complete");
	// Side effects are byte-exact on the source cwd.
	assert.equal(await readFile(join(sourceDir, "out-a.txt"), "utf8"), "a\n");
	assert.equal(await readFile(join(sourceDir, "out-b.txt"), "utf8"), "b\n");
	// Dependency order: C dispatched after both A and B were accepted.
	const c = (await readLatestV3Attempt(result.runDir, "node-c"))!.evidence;
	const a = (await readLatestV3Attempt(result.runDir, "node-a"))!.evidence;
	const b = (await readLatestV3Attempt(result.runDir, "node-b"))!.evidence;
	assert.equal(a.phase, "accepted");
	assert.equal(b.phase, "accepted");
	assert.equal(c.phase, "accepted");
	assert.ok(Date.parse(c.dispatch!.dispatchedAt) >= Date.parse(a.child!.completedAt), "C dispatched after A completed");
	assert.ok(Date.parse(c.dispatch!.dispatchedAt) >= Date.parse(b.child!.completedAt), "C dispatched after B completed");
	// Store integrity: snapshot and authorization re-validate on site.
	const persistedSnapshot = validateGraphSnapshotV3(JSON.parse(await readFile(join(result.runDir, "snapshot.json"), "utf8")));
	const persistedAuthorization = validateAuthorizationV4(JSON.parse(await readFile(join(result.runDir, "authorization.json"), "utf8")));
	assert.equal(persistedSnapshot.status, "complete");
	assert.equal(persistedSnapshot.graphDigest, persistedAuthorization.graphDigest);
	assert.equal(persistedSnapshot.runInstanceId, persistedAuthorization.runInstanceId);
	// Zero governance configuration was placed in or read from the fixture.
	const governanceNames = ["model-registry.json", "routing-policy.json", "planning.json"];
	for (const name of governanceNames) {
		await assert.rejects(readFile(join(sandbox, name)), { code: "ENOENT" }, `governance file must not exist: ${name}`);
	}
	// status / list / doctor understand the run.
	const listed = await host.list();
	assert.equal(listed.length, 1);
	assert.equal(listed[0]!.graphId, result.graphId);
	assert.equal(listed[0]!.snapshot.status, "complete");
	const doctor = await host.doctor();
	assert.deepEqual(doctor.issues.filter((issue) => issue.kind === "invalid-run"), []);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandbox, { recursive: true, force: true }));
});

function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

function spawnCrashDriver(driver: string, env: Record<string, string>) {
	const script = resolve(process.cwd(), "tests/helpers", driver);
	return spawn(process.execPath, ["--experimental-strip-types", script], {
		cwd: resolve(process.cwd()),
		stdio: "inherit",
		detached: process.platform !== "win32",
		env: { ...process.env, ...env },
	});
}

async function waitForFile(path: string, needle: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const text = await readFile(path, "utf8");
			if (text.includes(needle)) return;
		} catch {
			/* not yet */
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error(`Timed out waiting for ${path} to contain ${needle}`);
}

async function killAndReap(child: ReturnType<typeof spawnCrashDriver>): Promise<void> {
	killProcessTree(child.pid!);
	await new Promise<void>((resolveExit) => {
		child.on("exit", () => resolveExit());
		child.on("error", () => resolveExit());
		setTimeout(resolveExit, 10_000).unref();
	});
}

test("E2E-2: V3 host resumes a SIGKILLed run without duplicating n1 and re-runs n2 at most once", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	const readyFile = join(sandbox, "ready.txt");
	const child = spawnCrashDriver("v3-host-crash-driver.ts", {
		V3_E2E_RUNS_DIR: runsDir,
		V3_E2E_SOURCE_DIR: sourceDir,
		V3_E2E_READY_FILE: readyFile,
		V3_E2E_SESSION_ID: "session-crashed",
		V3_E2E_EPOCH: "epoch-crashed",
	});
	try {
		// Wait for n2 to be mid-run (n1 already applied).
		await waitForFile(readyFile, "ready", 20_000);
		// n1's committed side effect is already on disk exactly once before the crash.
		assert.equal(await readFile(join(sourceDir, "n1.out"), "utf8"), "n1\n");
		// SIGKILL the driver while n2 is running.
		await killAndReap(child);
	} finally {
		killProcessTree(child.pid!);
	}

	// A fresh process/host adopts the crashed run.
	const mock = new MockSubagents();
	mock.behaviors.set("N1", (input) => completeChild({ ...input, writes: [{ path: "n1.out", content: "n1\n" }] }));
	mock.behaviors.set("N2", (input) => completeChild({ ...input, writes: [{ path: "n2.out", content: "n2\n" }] }));
	mock.behaviors.set("N3", (input) => completeChild({ ...input, output: "n3-output" }));
	mock.start();
	const host = hostFor(runsDir, mock, "session-restarted", "epoch-restarted");
	const adopted = await host.adoptCrashedRuns();
	assert.equal(adopted.length, 1);
	assert.equal(adopted[0]!.graphId, (await host.list())[0]!.graphId);
	const graphId = adopted[0]!.graphId;
	const snapshot = await host.waitForCompletion(graphId);
	assert.equal(snapshot.status, "complete");
	const runDir = host.runDirFor(graphId);

	// n1 committed exactly once: accepted attempt 1, side effect unchanged.
	const n1 = (await readLatestV3Attempt(runDir, "n1"))!.evidence;
	assert.equal(n1.phase, "accepted");
	assert.equal(n1.attempt, 1);
	assert.equal(await readFile(join(sourceDir, "n1.out"), "utf8"), "n1\n");
	// n2 re-ran at most once: the stale child timed out (retry), then the retried attempt completed.
	const n2 = (await readLatestV3Attempt(runDir, "n2"))!.evidence;
	assert.equal(n2.phase, "accepted");
	assert.ok(n2.attempt <= 2, `n2 must re-run at most once, got attempt ${n2.attempt}`);
	assert.equal(await readFile(join(sourceDir, "n2.out"), "utf8"), "n2\n");
	const n3 = (await readLatestV3Attempt(runDir, "n3"))!.evidence;
	assert.equal(n3.phase, "accepted");
	// Store integrity re-validates after recovery.
	validateGraphSnapshotV3(JSON.parse(await readFile(join(runDir, "snapshot.json"), "utf8")));
	validateAuthorizationV4(JSON.parse(await readFile(join(runDir, "authorization.json"), "utf8")));
	// The stale lease was taken over (no lingering block): the run completed, which
	// requires the resumed holder to hold a live lease.
	const doctor = await host.doctor();
	assert.deepEqual(doctor.issues.filter((issue) => issue.kind === "stale-lease"), [], "stale lease must be gone after takeover");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandbox, { recursive: true, force: true }));
});

test("E2E-2b: V3 host does not re-dispatch a node whose child completed before the crash (write-commit window)", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	const readyFile = join(sandbox, "ready.txt");
	const child = spawnCrashDriver("v3-host-crash-driver-2.ts", {
		V3_E2E_RUNS_DIR: runsDir,
		V3_E2E_SOURCE_DIR: sourceDir,
		V3_E2E_READY_FILE: readyFile,
		V3_E2E_SESSION_ID: "session-crashed-2",
		V3_E2E_EPOCH: "epoch-crashed-2",
	});
	try {
		// The driver kills itself once n2 crosses its post-child-completion boundary.
		await waitForFile(readyFile, "started", 20_000);
		await new Promise<void>((resolveExit) => {
			child.on("exit", () => resolveExit());
			child.on("error", () => resolveExit());
			setTimeout(resolveExit, 20_000).unref();
		});
	} finally {
		killProcessTree(child.pid!);
	}

	const mock = new MockSubagents();
	mock.behaviors.set("N1", (input) => completeChild({ ...input, writes: [{ path: "n1.out", content: "n1\n" }] }));
	mock.behaviors.set("N2", (input) => completeChild({ ...input, writes: [{ path: "n2.out", content: "n2\n" }] }));
	mock.behaviors.set("N3", (input) => completeChild({ ...input, output: "n3-output" }));
	mock.start();
	const host = hostFor(runsDir, mock, "session-restarted-2", "epoch-restarted-2");
	const graphId = (await host.adoptCrashedRuns())[0]!.graphId;
	const snapshot = await host.waitForCompletion(graphId);
	assert.equal(snapshot.status, "complete");
	const runDir = host.runDirFor(graphId);
	// n2 must NOT be re-dispatched: its child had already completed, so resume continues
	// verification/apply and accepts attempt 1 without a duplicate dispatch.
	const n2 = (await readLatestV3Attempt(runDir, "n2"))!.evidence;
	assert.equal(n2.phase, "accepted");
	assert.equal(n2.attempt, 1, "n2 must not re-run after its child completed");
	assert.equal(await readFile(join(sourceDir, "n2.out"), "utf8"), "n2\n");
	const n1 = (await readLatestV3Attempt(runDir, "n1"))!.evidence;
	assert.equal(n1.attempt, 1);
	assert.equal(await readFile(join(sourceDir, "n1.out"), "utf8"), "n1\n");
	const n3 = (await readLatestV3Attempt(runDir, "n3"))!.evidence;
	assert.equal(n3.phase, "accepted");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandbox, { recursive: true, force: true }));
});

test("V3 host stop marks a fresh run stopped without dispatching children", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	const mock = new MockSubagents();
	mock.behaviors.set("STOP", () => new Promise<void>(() => undefined));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "stop me",
		nodes: [
			{ taskId: "slow", agent: "test-agent", task: "STOP node", sideEffect: "local_read" },
			{ taskId: "later", agent: "test-agent", task: "STOP later", dependsOn: ["slow"], sideEffect: "local_read" },
		],
	};
	const host = hostFor(runsDir, mock);
	const result = await host.start(spec, sourceDir);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	const snapshot = await host.stop(result.graphId);
	assert.equal(snapshot.status, "stopped");
	const slow = (await readLatestV3Attempt(result.runDir, "slow"))!.evidence;
	assert.equal(slow.phase, "aborted");
	const later = (await readLatestV3Attempt(result.runDir, "later"))!.evidence;
	assert.equal(later.phase, "aborted");
	assert.equal(mock.spawned.length, 1, "only the first node was dispatched before stop");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandbox, { recursive: true, force: true }));
});

test("V3 host list, status, and doctor classify runs by on-site format", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	const mock = new MockSubagents();
	mock.behaviors.set("P", (input) => completeChild({ ...input, output: "p" }));
	mock.start();
	const host = hostFor(runsDir, mock);
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "probe",
		nodes: [{ taskId: "p", agent: "test-agent", task: "P node", sideEffect: "local_read" }],
	};
	const result = await host.start(spec, sourceDir);
	await host.waitForCompletion(result.graphId);
	const status = await host.status(result.graphId);
	assert.equal(status.status, "complete");
	assert.equal(status.graphId, result.graphId);
	const listed = await host.list();
	assert.equal(listed.length, 1);
	assert.equal(listed[0]!.supervised, false, "completed runs are no longer supervised");
	const doctor = await host.doctor();
	assert.equal(doctor.supervised.length, 0);
	assert.deepEqual(doctor.issues.filter((issue) => issue.kind === "invalid-run"), []);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandbox, { recursive: true, force: true }));
});
