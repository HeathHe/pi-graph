import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { capOutput } from "../src/v3/dispatch.ts";
import { waitForAsyncRun, waitForAsyncRunIdentity } from "../src/v3/lifecycle.ts";
import { subagentAsyncRoot, type EventBus } from "../src/v3/rpc.ts";

class Bus implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set();
		set.add(handler);
		this.handlers.set(channel, set);
		return () => { set.delete(handler); };
	}
	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

test("V3 lifecycle reads pi-subagents structured workflow output when outputFile is absent", async () => {
	const asyncId = `v3-workflow-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	try {
		await writeFile(join(asyncDir, "status.json"), JSON.stringify({
			runId: asyncId,
			state: "complete",
			mode: "workflow",
			workflow: {
				value: {
					output: "durable workflow output",
					results: [{ finalOutput: "secondary result" }],
				},
			},
		}));
		const terminal = await waitForAsyncRun({ events: new Bus(), asyncId, asyncDir, timeoutMs: 1_000 });
		assert.equal(terminal.state, "complete");
		assert.equal(terminal.output, "durable workflow output");
	} finally {
		await rm(asyncDir, { recursive: true, force: true });
	}
});

test("V3 dispatch identity waits for 0.56 status publication without requiring a toolCallId", async () => {
	const asyncId = `v3-identity-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	try {
		const publication = new Promise<void>((resolvePublication, rejectPublication) => {
			setTimeout(() => {
				void writeFile(join(asyncDir, "status.json"), JSON.stringify({
					lifecycleArtifactVersion: 3,
					runId: asyncId,
					state: "queued",
					mode: "single",
				})).then(() => resolvePublication(), rejectPublication);
			}, 25);
		});
		assert.equal(await waitForAsyncRunIdentity(asyncId, asyncDir, { timeoutMs: 1_000, pollMs: 10 }), "queued");
		await publication;
	} finally {
		await rm(asyncDir, { recursive: true, force: true });
	}
});

test("V3 dispatch identity rejects a status file for another run", async () => {
	const asyncId = `v3-identity-mismatch-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	try {
		await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "another-run", state: "running" }));
		await assert.rejects(
			waitForAsyncRunIdentity(asyncId, asyncDir, { timeoutMs: 100, pollMs: 10 }),
			/status identity does not match/u,
		);
	} finally {
		await rm(asyncDir, { recursive: true, force: true });
	}
});

test("V3 dispatch identity fails closed when exact status publication never appears", async () => {
	const asyncId = `v3-identity-timeout-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	try {
		await assert.rejects(
			waitForAsyncRunIdentity(asyncId, asyncDir, { timeoutMs: 40, pollMs: 10 }),
			/did not publish durable status identity/u,
		);
	} finally {
		await rm(asyncDir, { recursive: true, force: true });
	}
});

test("V3 dispatch output cap is an exact UTF-8 byte ceiling with no replacement tail", () => {
	const capped = capOutput("界".repeat(30_000));
	assert.ok(Buffer.byteLength(capped, "utf8") <= 64 * 1024);
	assert.equal(capped.includes("�"), false);
	assert.match(capped, /\[output truncated\]$/u);
});
