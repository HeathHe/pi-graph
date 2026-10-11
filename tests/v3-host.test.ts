import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readLatestV3Attempt } from "../src/v3/attempt.ts";
import { validateAuthorizationV4 } from "../src/v3/authorization.ts";
import { V3GraphHost } from "../src/v3/host.ts";
import { validateGraphSnapshotV3 } from "../src/v3/snapshot.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import type { GraphSpecV3 } from "../src/v3/types.ts";
import { MockSubagents, completeChild, failChild } from "./helpers/mock-subagents.ts";

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

test("V3 host propagates failFast and never dispatches a later independent branch", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	const mock = new MockSubagents();
	mock.behaviors.set("HOST_FAIL_FAST_FAIL", (input) => failChild(input));
	mock.behaviors.set("HOST_FAIL_FAST_NEVER", (input) => completeChild({ ...input, output: "must-not-run" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "host failFast",
		failFast: true,
		maxConcurrency: 1,
		nodes: [
			{ taskId: "failing", agent: "test-agent", task: "HOST_FAIL_FAST_FAIL", sideEffect: "local_read" },
			{ taskId: "independent", agent: "test-agent", task: "HOST_FAIL_FAST_NEVER", sideEffect: "local_read" },
		],
	};
	const host = hostFor(runsDir, mock);
	const result = await host.start(spec, sourceDir);
	const snapshot = await host.waitForCompletion(result.graphId);
	assert.equal(snapshot.status, "failed");
	assert.equal((await readLatestV3Attempt(result.runDir, "failing"))!.evidence.phase, "failed");
	const independent = (await readLatestV3Attempt(result.runDir, "independent"))!.evidence;
	assert.equal(independent.phase, "failed");
	assert.equal(independent.dispatch, undefined, "failFast terminal evidence must never imply a child dispatch");
	assert.equal(snapshot.nodes?.independent?.phase, "failed");
	assert.equal(mock.spawned.some((entry) => String(entry.params.task).includes("HOST_FAIL_FAST_NEVER")), false);
	assert.equal((await host.status(result.graphId)).status, "failed", "fresh Host projection must not revive failFast work as queued");
	await mock.dispose();
	await rm(sandbox, { recursive: true, force: true });
});

test("V3 Host rejects resume and append after the admitted source directory identity is replaced", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	const mock = new MockSubagents();
	mock.behaviors.set("SOURCE_ID", (input) => completeChild({ ...input, output: "done" }));
	mock.start();
	const host = hostFor(runsDir, mock);
	const handle = await host.start({
		schemaVersion: 3, graphId: "source-identity-drift", goal: "source identity",
		nodes: [{ taskId: "root", agent: "test-agent", task: "SOURCE_ID", sideEffect: "none" }],
	}, sourceDir);
	await host.waitForCompletion(handle.graphId);
	await rename(sourceDir, `${sourceDir}-original`);
	await mkdir(sourceDir);
	await assert.rejects(host.resume(handle.graphId), /source directory or repository identity has changed/u);
	await assert.rejects(host.append(handle.graphId, [], 0), /source directory or repository identity has changed/u);
	await mock.dispose();
	await rm(sandbox, { recursive: true, force: true });
});

test("V3 Host refuses symbolic-link run roots and authority files", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	const mock = new MockSubagents();
	mock.behaviors.set("SAFE_AUTH", (input) => completeChild({ ...input, output: "done" }));
	mock.start();
	const host = hostFor(runsDir, mock);
	const handle = await host.start({
		schemaVersion: 3, graphId: "safe-authority", goal: "safe authority",
		nodes: [{ taskId: "root", agent: "test-agent", task: "SAFE_AUTH", sideEffect: "none" }],
	}, sourceDir);
	await host.waitForCompletion(handle.graphId);
	const authorization = join(handle.runDir, "authorization.json");
	const saved = join(handle.runDir, "authorization.saved.json");
	await rename(authorization, saved);
	await symlink(saved, authorization);
	await assert.rejects(host.status(handle.graphId), /authorization\.json must be a single regular non-symbolic-link file/u);
	await rm(authorization);
	await rename(saved, authorization);
	const alias = join(runsDir, "run-root-alias");
	await symlink(handle.runDir, alias, "dir");
	await assert.rejects(host.loadRun(alias), /run root must be a direct, canonical, non-symbolic-link child/u);
	await mock.dispose();
	await rm(sandbox, { recursive: true, force: true });
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

test("E2E-2: V3 host resumes a SIGKILLed run fail-closed when stale child termination cannot be confirmed", async () => {
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
		// The full suite runs four files concurrently and this crash driver performs
		// real fsyncs plus two child transitions before publishing readiness.
		await waitForFile(readyFile, "ready", 60_000);
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
	const snapshot = await host.stop(graphId);
	assert.equal(snapshot.status, "needs_attention");
	const runDir = host.runDirFor(graphId);

	// n1 committed exactly once: accepted attempt 1, side effect unchanged.
	const n1 = (await readLatestV3Attempt(runDir, "n1"))!.evidence;
	assert.equal(n1.phase, "accepted");
	assert.equal(n1.attempt, 1);
	assert.equal(await readFile(join(sourceDir, "n1.out"), "utf8"), "n1\n");
	// The killed Mock process owned the child. A new RPC bridge cannot confirm its
	// termination, so timeout must fail closed instead of dispatching a duplicate.
	const n2 = (await readLatestV3Attempt(runDir, "n2"))!.evidence;
	assert.equal(n2.phase, "needs_attention");
	assert.equal(n2.attempt, 1);
	assert.equal(n2.failure!.kind, "dispatch_unknown");
	assert.equal(await readLatestV3Attempt(runDir, "n3"), undefined);
	assert.equal(snapshot.nodes?.n3?.phase, "blocked");
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

test("E2E-2c: SIGKILL after spawn but before dispatch binding fails closed without re-dispatch", async () => {
	const { sandbox, sourceDir, runsDir } = await fixture();
	const readyFile = join(sandbox, "dispatch-window-ready.txt");
	const child = spawnCrashDriver("v3-dispatch-window-crash-driver.ts", {
		V3_E2E_RUNS_DIR: runsDir,
		V3_E2E_SOURCE_DIR: sourceDir,
		V3_E2E_READY_FILE: readyFile,
	});
	try {
		await waitForFile(readyFile, "spawned-before-binding", 20_000);
		// Give the detached mock Child time to publish terminal status while the
		// caller remains suspended before returning the spawn binding.
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
		await killAndReap(child);
	} finally {
		killProcessTree(child.pid!);
	}
	const mock = new MockSubagents();
	mock.behaviors.set("DISPATCH_WINDOW", (input) => completeChild({ ...input, output: "duplicate" }));
	mock.start();
	const host = hostFor(runsDir, mock, "dispatch-window-restarted", "dispatch-window-restarted");
	const adopted = await host.adoptCrashedRuns();
	assert.equal(adopted.length, 1);
	const snapshot = await host.waitForCompletion(adopted[0]!.graphId);
	assert.equal(snapshot.status, "needs_attention");
	const attempt = (await readLatestV3Attempt(host.runDirFor(adopted[0]!.graphId), "window"))!.evidence;
	assert.equal(attempt.attempt, 1);
	assert.equal(attempt.phase, "needs_attention");
	assert.equal(attempt.failure?.kind, "dispatch_unknown");
	assert.equal(attempt.child, undefined);
	assert.equal(mock.spawned.length, 0, "recovery must not spawn a replacement when the original child identity is unknown");
	await mock.dispose();
	await rm(sandbox, { recursive: true, force: true });
});

test("V3 host stop marks a fresh run stopped without dispatching downstream children", async () => {
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
	// Stop an admitted child, rather than racing workspace preparation under load.
 const dispatchDeadline = Date.now() + 10000;
 while (!(await readLatestV3Attempt(result.runDir, "slow"))?.evidence.dispatch) {
  assert.ok(Date.now() < dispatchDeadline, "slow child must be admitted before stop");
  await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
 }
	const snapshot = await host.stop(result.graphId);
	assert.equal(snapshot.status, "stopped");
	const slow = (await readLatestV3Attempt(result.runDir, "slow"))!.evidence;
	assert.equal(slow.phase, "aborted");
	assert.equal(snapshot.nodes?.later?.phase, "blocked");
	const later = await readLatestV3Attempt(result.runDir, "later");
	assert.equal(later, undefined, "a dependency-blocked node must not fabricate an Attempt");
	assert.ok(mock.spawned.length <= 1, "only the first node may be dispatched before stop");
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

test("E2E-3: a zero-config clean install has no governance files and E2E-1 passes from the packed layout", async () => {
	// Pack the package exactly as it ships (npm pack = the install artifact).
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "pi-graph-e2e3-")));
	const packDir = join(sandbox, "pack");
	const unpackDir = join(sandbox, "unpack");
	await mkdir(packDir, { recursive: true });
	await mkdir(unpackDir, { recursive: true });
	const repoRoot = resolve(new URL("..", import.meta.url).pathname);
	const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: repoRoot, encoding: "utf8" });
	assert.equal(pack.status, 0, pack.stderr || pack.stdout);
	const packed = (JSON.parse(pack.stdout) as Array<{ filename: string; files?: Array<{ path: string }> }>)[0]!;
	const tarball = join(packDir, packed.filename);
	const extract = spawnSync("tar", ["-xzf", tarball, "-C", unpackDir], { encoding: "utf8" });
	assert.equal(extract.status, 0, extract.stderr || extract.stdout);
	const pkgRoot = join(unpackDir, "package");

	// Governance config files and governance modules must not exist anywhere in the install.
	async function collectFiles(dir: string): Promise<string[]> {
		const out: string[] = [];
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...await collectFiles(p));
			else out.push(p);
		}
		return out;
	}
	const installedFiles = (await collectFiles(pkgRoot)).map((p) => p.slice(pkgRoot.length + 1));
	const governanceNames = ["model-registry.json", "routing-policy.json", "planning.json"];
	const governanceHits = installedFiles.filter((p) =>
		governanceNames.some((name) => p.endsWith(name))
		|| /^(?:src\/)?(?:model-routing|subagent-router)\//u.test(p)
		|| p.endsWith("model-routing-adapter.ts") || p.endsWith("recommend.ts")
		|| p.endsWith("subagent-model-router.ts") || p.endsWith("routing-shadow-report.ts")
		|| p.endsWith("shadow-report.ts"),
	);
	assert.deepEqual(governanceHits, [], `zero-config install must contain no governance artifacts: ${governanceHits.join(", ")}`);
	const legacyCore = installedFiles.filter((path) => path.startsWith("src/") && !path.startsWith("src/v3/") && !path.startsWith("src/runtime/"));
	assert.deepEqual(legacyCore, [], `the installed package must ship only the V3 core and owned SDK runtime: ${legacyCore.join(", ")}`);

	// Extension load manifest == retained set.
	const installedPackageJson = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
		peerDependencies?: Record<string,string>;dependencies?:Record<string,string>;
	};
	assert.deepEqual(installedPackageJson.pi?.extensions, ["./extensions/pi-graph.ts", "./extensions/pi-graph-guard.ts"]);
	assert.equal(installedPackageJson.peerDependencies?.["pi-subagents"],undefined);
 assert.equal(installedPackageJson.dependencies?.["pi-subagents"],undefined);
 assert.ok(installedFiles.includes("src/runtime/child-runner.mjs"));
	assert.ok(installedFiles.includes("agents/graph-worker.md"), "packed layout must include the opt-in fallback Agent");
	const graphWorker = await readFile(join(pkgRoot, "agents/graph-worker.md"), "utf8");
	assert.match(graphWorker, /name: graph-worker/u);
	assert.match(graphWorker, /package: pi-graph/u);
	assert.match(graphWorker, /tools: read, grep, find, ls, write, edit/u);
	assert.doesNotMatch(graphWorker, /tools:.*\bbash\b/u);

	// Provide runtime and peer dependencies exactly like `npm install` would, then run E2E-1
	// against the installed layout (clean fixture, zero governance config) and confirm it passes.
	await mkdir(join(pkgRoot, "node_modules"), { recursive: true });
	await symlink(join(repoRoot, "node_modules", "jiti"), join(pkgRoot, "node_modules", "jiti"), "dir");
	await symlink(join(repoRoot, "node_modules", "yaml"), join(pkgRoot, "node_modules", "yaml"), "dir");
	const { V3GraphHost: InstalledV3GraphHost } = await import(join(pkgRoot, "src/v3/host.ts")) as typeof import("../src/v3/host.ts");
	const { readLatestV3Attempt: installedReadAttempt } = await import(join(pkgRoot, "src/v3/attempt.ts")) as typeof import("../src/v3/attempt.ts");
	const { validateGraphSnapshotV3: installedValidateSnapshot } = await import(join(pkgRoot, "src/v3/snapshot.ts")) as typeof import("../src/v3/snapshot.ts");
	const { validateAuthorizationV4: installedValidateAuth } = await import(join(pkgRoot, "src/v3/authorization.ts")) as typeof import("../src/v3/authorization.ts");

	const fixtureDir = join(sandbox, "fixture");
	const sourceDir = join(fixtureDir, "source");
	const runsDir = join(fixtureDir, "runs");
	await mkdir(sourceDir, { recursive: true });
	await mkdir(runsDir, { recursive: true });
	await writeFile(join(sourceDir, "input.txt"), "seed\n", "utf8");
	const mock = new MockSubagents();
	mock.behaviors.set("NODE_A", (input) => completeChild({ ...input, writes: [{ path: "out-a.txt", content: "a\n" }] }));
	mock.behaviors.set("NODE_B", (input) => completeChild({ ...input, writes: [{ path: "out-b.txt", content: "b\n" }] }));
	mock.behaviors.set("NODE_C", (input) => completeChild({ ...input, output: "c-output" }));
	mock.start();
	const installedHost = new InstalledV3GraphHost({ rpc: new SubagentRpcClient(mock), runsDir, sessionId: "session-e2e3", supervisorEpoch: "epoch-e2e3", preflightAgent: async () => undefined });
	const installedResult = await installedHost.start({
		schemaVersion: 3,
		goal: "write a and b then c",
		nodes: [
			{ taskId: "node-a", agent: "test-agent", task: "NODE_A write out-a.txt", sideEffect: "local_write", writeScope: [{ kind: "file", path: "out-a.txt" }], validationCommands: ["test -f out-a.txt"] },
			{ taskId: "node-b", agent: "test-agent", task: "NODE_B write out-b.txt", sideEffect: "local_write", writeScope: [{ kind: "file", path: "out-b.txt" }], validationCommands: ["test -f out-b.txt"] },
			{ taskId: "node-c", agent: "test-agent", task: "NODE_C depends on both", dependsOn: ["node-a", "node-b"], sideEffect: "local_read", readScope: [{ kind: "file", path: "input.txt" }] },
		],
	}, sourceDir);
	const installedSnapshot = await installedHost.waitForCompletion(installedResult.graphId);
	assert.equal(installedSnapshot.status, "complete");
	assert.equal(await readFile(join(sourceDir, "out-a.txt"), "utf8"), "a\n");
	assert.equal(await readFile(join(sourceDir, "out-b.txt"), "utf8"), "b\n");
	const installedC = (await installedReadAttempt(installedResult.runDir, "node-c"))!.evidence;
	const installedA = (await installedReadAttempt(installedResult.runDir, "node-a"))!.evidence;
	const installedB = (await installedReadAttempt(installedResult.runDir, "node-b"))!.evidence;
	assert.equal(installedA.phase, "accepted");
	assert.equal(installedB.phase, "accepted");
	assert.equal(installedC.phase, "accepted");
	assert.ok(Date.parse(installedC.dispatch!.dispatchedAt) >= Date.parse(installedA.child!.completedAt));
	assert.ok(Date.parse(installedC.dispatch!.dispatchedAt) >= Date.parse(installedB.child!.completedAt));
	const persistedSnapshot = installedValidateSnapshot(JSON.parse(await readFile(join(installedResult.runDir, "snapshot.json"), "utf8")));
	const persistedAuthorization = installedValidateAuth(JSON.parse(await readFile(join(installedResult.runDir, "authorization.json"), "utf8")));
	assert.equal(persistedSnapshot.status, "complete");
	assert.equal(persistedSnapshot.graphDigest, persistedAuthorization.graphDigest);
	for (const name of governanceNames) {
		await assert.rejects(readFile(join(fixtureDir, name)), { code: "ENOENT" }, `governance file must not exist in the E2E-3 fixture: ${name}`);
	}
	await mock.dispose();
	await rm(sandbox, { recursive: true, force: true });
});
