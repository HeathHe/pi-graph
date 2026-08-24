import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventBus } from "../../src/v3/rpc.ts";
import { RPC_REQUEST, RPC_REPLY_PREFIX, subagentAsyncRoot } from "../../src/v3/rpc.ts";

export type MockChildBehavior = (input: {
	cwd: string;
	asyncDir: string;
	asyncId: string;
	params: Record<string, unknown>;
}) => Promise<void>;

/**
 * An in-memory pi-subagents RPC bridge that simulates async child runs inside the
 * isolated test TMPDIR async root. Behaviors are keyed by a substring of the task
 * body, so each graph node can script its own outcome. waitForAsyncRun observes
 * terminal state by polling status.json, so no completion event is required.
 */
export class MockSubagents implements EventBus {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	private readonly asyncRoot = subagentAsyncRoot();
	private readonly createdDirs: string[] = [];
	private readonly unsubscribers: Array<() => void> = [];
	private readonly requests = new Map<string, { asyncId: string; asyncDir: string }>();
	private nextId = 0;
	readonly spawned: Array<{ asyncId: string; asyncDir: string; params: Record<string, unknown> }> = [];
	readonly spawnRequestIds: string[] = [];
	readonly behaviors = new Map<string, MockChildBehavior>();
	spawnDelayMs = 0;
	stopBehavior: "confirm" | "ignore" = "confirm";

	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set();
		set.add(handler);
		this.handlers.set(channel, set);
		const unsubscribe = () => set.delete(handler);
		return unsubscribe;
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}

	async dispose(): Promise<void> {
		const { rm } = await import("node:fs/promises");
		// Remove only this instance's own listeners and child dirs. The shared async
		// root is used by every mock instance and every test file, so it must never
		// be deleted wholesale (that would destroy in-flight children of other files).
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers.length = 0;
		await Promise.all(this.createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
		this.createdDirs.length = 0;
	}

	private async handleRequest(data: unknown): Promise<void> {
		const request = data as { version: number; requestId: string; method: string; params?: Record<string, unknown> };
		if (request?.version !== 1) return;
		if (request.method === "stop") {
			const params = (request.params ?? {}) as Record<string, unknown>;
			const asyncId = typeof params.id === "string" ? params.id : typeof params.runId === "string" ? params.runId : "";
			const child = this.spawned.find((entry) => entry.asyncId === asyncId);
			if (!child) {
				this.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, { version: 1, requestId: request.requestId, success: false, error: { code: "not_found", message: `Mock async child not found: ${asyncId}` } });
				return;
			}
			if (this.stopBehavior === "ignore") {
				this.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { runId: asyncId, asyncDir: child.asyncDir, state: "stopping" } });
				return;
			}
			const statusPath = join(child.asyncDir, "status.json");
			const current = JSON.parse(await (await import("node:fs/promises")).readFile(statusPath, "utf8")) as Record<string, unknown>;
			await writeFile(statusPath, JSON.stringify({ ...current, runId: asyncId, state: "stopped" }));
			this.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { runId: asyncId, asyncDir: child.asyncDir, state: "stopping" } });
			return;
		}
		if (request.method !== "spawn") return;
		this.spawnRequestIds.push(request.requestId);
		const prior = this.requests.get(request.requestId);
		if (prior) {
			this.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { details: prior } });
			return;
		}
		const params = (request.params ?? {}) as Record<string, unknown>;
		const task = typeof params.task === "string" ? params.task : "";
		let behavior: MockChildBehavior | undefined;
		for (const key of this.behaviors.keys()) {
			if (task.includes(key)) {
				behavior = this.behaviors.get(key);
				break;
			}
		}
		if (!behavior) {
			this.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, { version: 1, requestId: request.requestId, success: false, error: { code: "no_behavior", message: `MockSubagents has no behavior for task: ${task.slice(0, 80)}` } });
			return;
		}
		this.nextId += 1;
		// Real pi-subagents assigns an opaque UUID and retains the stable request
		// separately as status.toolCallId.
		const asyncId = `mock-${this.nextId}-${randomUUID().slice(0, 8)}`;
		const asyncDir = join(this.asyncRoot, asyncId);
		this.requests.set(request.requestId, { asyncId, asyncDir });
		const sessionDir = typeof params.sessionDir === "string" ? params.sessionDir : join(asyncDir, "session");
		await mkdir(asyncDir, { recursive: true });
		await mkdir(join(asyncDir, "control"), { recursive: true });
		await mkdir(sessionDir, { recursive: true });
		this.createdDirs.push(asyncDir);
		const outputFile = join(asyncDir, "output.txt");
		await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, toolCallId: `rpc-spawn-${request.requestId}`, state: "running", sessionDir, outputFile, mode: "single" }));
		this.spawned.push({ asyncId, asyncDir, params });
		this.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { details: { asyncId, asyncDir } } });
		const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
		const delay = this.spawnDelayMs;
		setTimeout(() => {
			void behavior({ cwd, asyncDir, asyncId, params }).catch((error: unknown) => {
				void writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "failed", error: error instanceof Error ? error.message : String(error), sessionDir, outputFile, mode: "single" }));
			});
		}, delay);
	}

	start(): void {
		const unsubscribe = this.on(RPC_REQUEST, (data) => void this.handleRequest(data));
		this.unsubscribers.push(unsubscribe);
	}
}

export interface MockWrite {
	path: string;
	content: string;
}

export async function completeChild(input: { cwd: string; asyncDir: string; asyncId: string; writes?: MockWrite[]; output?: string }): Promise<void> {
	const { writeFile: write, mkdir: mk, readFile: read } = await import("node:fs/promises");
	const { join: joinPath, dirname } = await import("node:path");
	for (const writeEntry of input.writes ?? []) {
		const target = joinPath(input.cwd, writeEntry.path);
		await mk(dirname(target), { recursive: true });
		await write(target, writeEntry.content, "utf8");
	}
	const output = input.output ?? `output for ${input.asyncId}`;
	const outputFile = joinPath(input.asyncDir, "output.txt");
	await write(outputFile, output, "utf8");
	const previous = JSON.parse(await read(joinPath(input.asyncDir, "status.json"), "utf8")) as Record<string, unknown>;
	await write(joinPath(input.asyncDir, "status.json"), JSON.stringify({ ...previous, runId: input.asyncId, state: "complete", outputFile, sessionDir: joinPath(input.asyncDir, "session"), mode: "single" }));
}

export async function failChild(input: { asyncDir: string; asyncId: string }): Promise<void> {
	const { writeFile: write, readFile: read } = await import("node:fs/promises");
	const { join: joinPath } = await import("node:path");
	const previous = JSON.parse(await read(joinPath(input.asyncDir, "status.json"), "utf8")) as Record<string, unknown>;
	await write(joinPath(input.asyncDir, "status.json"), JSON.stringify({ runId: input.asyncId, ...(typeof previous.toolCallId === "string" ? { toolCallId: previous.toolCallId } : {}), state: "failed", error: "synthetic failure", sessionDir: joinPath(input.asyncDir, "session"), mode: "single" }));
}

export async function pauseChild(input: { asyncDir: string; asyncId: string }): Promise<void> {
	const { writeFile: write, readFile: read } = await import("node:fs/promises");
	const { join: joinPath } = await import("node:path");
	const previous = JSON.parse(await read(joinPath(input.asyncDir, "status.json"), "utf8")) as Record<string, unknown>;
	await write(joinPath(input.asyncDir, "status.json"), JSON.stringify({ runId: input.asyncId, ...(typeof previous.toolCallId === "string" ? { toolCallId: previous.toolCallId } : {}), state: "paused", sessionDir: joinPath(input.asyncDir, "session"), mode: "single" }));
}
