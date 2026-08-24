import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	acquireV3RunLease,
	readV3LeaseGenerationLedger,
	readV3RunLease,
	v3LeaseGenerationLedgerPath,
} from "../src/v3/lease.ts";

async function fixture(): Promise<{ root: string; leasePath: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v3-fence-"));
	return { root, leasePath: join(root, "run", "lease.json") };
}

test("a live Supervisor cannot be replaced by a second Runner in the same process", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const first = await acquireV3RunLease(f.leasePath, "run-1", { token: "first" });
	await assert.rejects(
		acquireV3RunLease(f.leasePath, "run-1", { token: "second" }),
		/already supervised by a live lease holder/i,
	);
	await first.assertCurrent();
	await first.release();
});

test("a released Supervisor capability cannot mutate after a successor is acquired", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const first = await acquireV3RunLease(f.leasePath, "run-2", { token: "first" });
	await first.release();
	const second = await acquireV3RunLease(f.leasePath, "run-2", { token: "second" });
	let mutated = false;
	await assert.rejects(
		first.withFence(async () => {
			mutated = true;
		}),
		/Supervisor fence is no longer current/i,
	);
	assert.equal(mutated, false);
	await second.withFence(async () => {
		mutated = true;
	});
	assert.equal(mutated, true);
	await second.release();
});

test("released leases retain a monotonic generation ledger and never reuse a same-token fence", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const first = await acquireV3RunLease(f.leasePath, "run-monotonic", { token: "reused-token" });
	assert.equal(first.generation, 1);
	await first.release();
	assert.equal(await readV3RunLease(f.leasePath), undefined);
	const released = await readV3LeaseGenerationLedger(f.leasePath);
	assert.equal(released?.schemaVersion, 1);
	assert.equal(released?.runInstanceId, "run-monotonic");
	assert.equal(released?.generation, 1);
	assert.equal(released?.state, "released");
	assert.equal(released?.previousTokenDigest, null);
	assert.equal(released?.pid, process.pid);

	const second = await acquireV3RunLease(f.leasePath, "run-monotonic", { token: "reused-token" });
	assert.equal(second.generation, 2, "release + reacquire must consume a fresh durable generation even when token text is reused");
	await assert.rejects(first.assertCurrent(), /Supervisor fence is no longer current/i);
	let staleMutation = false;
	await assert.rejects(first.withFence(async () => { staleMutation = true; }), /Supervisor fence is no longer current/i);
	assert.equal(staleMutation, false);
	await second.release();
	const third = await acquireV3RunLease(f.leasePath, "run-monotonic", { token: "third" });
	assert.equal(third.generation, 3);
	await third.release();
	assert.equal((await readV3LeaseGenerationLedger(f.leasePath))?.generation, 3);
});

test("deleting lease.json cannot bypass a live durable generation or reset its counter", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const first = await acquireV3RunLease(f.leasePath, "run-deleted-lease", { token: "first" });
	assert.equal(first.generation, 1);
	await rm(f.leasePath);
	await assert.rejects(
		acquireV3RunLease(f.leasePath, "run-deleted-lease", { token: "second" }),
		/lease is missing but its active Supervisor generation is still live/i,
	);
	assert.equal((await readV3LeaseGenerationLedger(f.leasePath))?.generation, 1);
	await assert.rejects(first.assertCurrent(), /Supervisor fence is no longer current/i);
	await first.release();
	const second = await acquireV3RunLease(f.leasePath, "run-deleted-lease", { token: "second" });
	assert.equal(second.generation, 2);
	await second.release();
});

test("an interrupted reserved generation is burned before the next lease is published", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const first = await acquireV3RunLease(f.leasePath, "run-reservation", { token: "first" });
	await first.release();
	const released = (await readV3LeaseGenerationLedger(f.leasePath))!;
	await writeFile(v3LeaseGenerationLedgerPath(f.leasePath), `${JSON.stringify({
		...released,
		generation: 2,
		state: "reserved",
		previousTokenDigest: released.tokenDigest,
		tokenDigest: "a".repeat(64),
		updatedAt: new Date().toISOString(),
	})}\n`, "utf8");
	const successor = await acquireV3RunLease(f.leasePath, "run-reservation", { token: "successor" });
	assert.equal(successor.generation, 3, "generation 2 was durably reserved and must never be reused");
	await successor.release();
});

async function waitForLine(child: ReturnType<typeof spawn>): Promise<string> {
	return new Promise((resolveLine, reject) => {
		let stdout = "";
		let stderr = "";
		child.once("error", reject);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => { stderr += chunk; });
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
			const newline = stdout.indexOf("\n");
			if (newline >= 0) resolveLine(stdout.slice(0, newline));
		});
		child.once("exit", (code, signal) => reject(new Error(`lease child exited before reporting (${String(code)}/${String(signal)}): ${stderr}`)));
	});
}

test("a different process cannot replace a live generation and takes a strictly newer generation after process death", { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const leaseModule = pathToFileURL(resolve("src/v3/lease.ts")).href;
	const script = [
		`import { acquireV3RunLease } from ${JSON.stringify(leaseModule)};`,
		`const handle = await acquireV3RunLease(${JSON.stringify(f.leasePath)}, "run-cross-process", { token: "child" });`,
		`process.stdout.write(JSON.stringify({ generation: handle.generation, pid: process.pid }) + "\\n");`,
		"setInterval(() => undefined, 1_000);",
	].join("\n");
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});
	t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
	const reported = JSON.parse(await waitForLine(child)) as { generation: number; pid: number };
	assert.equal(reported.generation, 1);
	assert.notEqual(reported.pid, process.pid);
	await assert.rejects(
		acquireV3RunLease(f.leasePath, "run-cross-process", { token: "parent-too-early" }),
		/already supervised by a live lease holder/i,
	);
	child.kill("SIGTERM");
	await new Promise<void>((resolveExit, reject) => {
		if (child.exitCode !== null) return resolveExit();
		child.once("error", reject);
		child.once("exit", () => resolveExit());
	});
	const parent = await acquireV3RunLease(f.leasePath, "run-cross-process", { token: "parent" });
	assert.equal(parent.generation, 2);
	await parent.release();
});

test("a malformed generation ledger fails closed without publishing a replacement lease", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const first = await acquireV3RunLease(f.leasePath, "run-corrupt", { token: "first" });
	await first.release();
	const ledgerPath = v3LeaseGenerationLedgerPath(f.leasePath);
	await writeFile(ledgerPath, "{ definitely-not-json\n", "utf8");
	await assert.rejects(
		acquireV3RunLease(f.leasePath, "run-corrupt", { token: "replacement" }),
		/generation ledger is not valid JSON/i,
	);
	assert.equal(await readV3RunLease(f.leasePath), undefined);
	assert.equal(await readFile(ledgerPath, "utf8"), "{ definitely-not-json\n", "acquisition must not overwrite malformed authority");
});

test("a valid-looking ledger that disagrees with the live lease fails closed", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const first = await acquireV3RunLease(f.leasePath, "run-mismatch", { token: "first" });
	const path = v3LeaseGenerationLedgerPath(f.leasePath);
	const ledger = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	ledger.tokenDigest = "0".repeat(64);
	await writeFile(path, `${JSON.stringify(ledger)}\n`, "utf8");
	await assert.rejects(
		acquireV3RunLease(f.leasePath, "run-mismatch", { token: "second" }),
		/lease and active Supervisor generation ledger disagree/i,
	);
	await assert.rejects(first.assertCurrent(), /Supervisor fence is no longer current/i);
});
