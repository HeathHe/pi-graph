import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";

export const RPC_REQUEST = "subagents:rpc:v1:request";
export const RPC_READY = "subagents:rpc:v1:ready";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

interface IndexedAsyncRun {
	asyncId: string;
	asyncDir: string;
	sessionDir: string;
	sessionId?: string;
}

const asyncRunIndexes = new Map<string, Map<string, IndexedAsyncRun>>();
const asyncRunReadTimes = new Map<string, Map<string, number>>();
const ASYNC_STATUS_RECHECK_MS = 1_000;

export interface EventBus {
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
	emit(channel: string, data: unknown): void;
}

interface RpcReply {
	version: 1;
	requestId: string;
	success: boolean;
	data?: unknown;
	error?: { code?: string; message?: string };
}

export class RpcTimeoutError extends Error {
	readonly requestId: string;
	readonly method: string;
	constructor(requestId: string, method: string) {
		super(`pi-subagents RPC '${method}' timed out.`);
		this.name = "RpcTimeoutError";
		this.requestId = requestId;
		this.method = method;
	}
}

export class RpcRejectedError extends Error {
	readonly requestId: string;
	readonly method: string;
	readonly code?: string;
	constructor(requestId: string, method: string, message: string, code?: string) {
		super(message);
		this.name = "RpcRejectedError";
		this.requestId = requestId;
		this.method = method;
		this.code = code;
	}
}

export class RpcPreEmitError extends Error {
	readonly cause: unknown;
	constructor(cause: unknown) {
		super(`RPC request was rejected before emit: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "RpcPreEmitError";
		this.cause = cause;
	}
}

export class SubagentRpcClient {
	readonly events: EventBus;
	private readonly timeoutMs: number;
	constructor(events: EventBus, timeoutMs = 10_000) {
		this.events = events;
		this.timeoutMs = timeoutMs;
	}

	call(method: "ping" | "status" | "spawn" | "interrupt" | "stop" | "resume", params?: unknown, stableRequestId?: string, beforeEmit?: () => void): Promise<unknown> {
		const requestId = stableRequestId ?? `pi-graph-${randomUUID()}`;
		return new Promise((resolvePromise, reject) => {
			let settled = false;
			const unsubscribe = this.events.on(`${RPC_REPLY_PREFIX}${requestId}`, (raw) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (typeof unsubscribe === "function") unsubscribe();
				const reply = raw as RpcReply;
				if (reply?.success) resolvePromise(reply.data);
				else reject(new RpcRejectedError(requestId, method, reply?.error?.message ?? `pi-subagents RPC '${method}' failed.`, reply?.error?.code));
			});
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				if (typeof unsubscribe === "function") unsubscribe();
				reject(new RpcTimeoutError(requestId, method));
			}, this.timeoutMs);
			try {
				beforeEmit?.();
			} catch (error) {
				settled = true;
				clearTimeout(timer);
				if (typeof unsubscribe === "function") unsubscribe();
				reject(new RpcPreEmitError(error));
				return;
			}
			this.events.emit(RPC_REQUEST, { version: 1, requestId, method, params, source: { extension: "pi-graph" } });
		});
	}

	async spawn(params: Record<string, unknown>, stableRequestId?: string, beforeEmit?: () => void): Promise<{ asyncId: string; asyncDir: string }> {
		const response = await this.call("spawn", params, stableRequestId, beforeEmit) as { details?: { asyncId?: string; asyncDir?: string }; isError?: boolean; text?: string };
		const asyncId = response?.details?.asyncId;
		const asyncDir = response?.details?.asyncDir;
		if (response?.isError || !asyncId || !asyncDir) throw new RpcRejectedError(stableRequestId ?? "unknown", "spawn", response?.text ?? "pi-subagents RPC spawn returned no async run identity.");
		assertAsyncRunIdentity(asyncId, asyncDir);
		return { asyncId, asyncDir };
	}
}

function sanitize(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function subagentAsyncRoot(): string {
	let scope = "shared";
	if (typeof process.getuid === "function") scope = `uid-${process.getuid()}`;
	else {
		try {
			scope = `user-${sanitize(userInfo().username)}`;
		} catch {
			scope = `home-${sanitize(homedir())}`;
		}
	}
	return join(tmpdir(), `pi-subagents-${scope}`, "async-subagent-runs");
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function assertAsyncRunIdentity(asyncId: string, asyncDir: string, asyncRoot = subagentAsyncRoot()): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(asyncId) || resolve(asyncDir) !== resolve(join(asyncRoot, asyncId))) {
		throw new Error("pi-subagents returned an invalid async run identity.");
	}
}

export function assertAsyncRunDirectory(asyncDir: string, asyncRoot = subagentAsyncRoot()): string {
	const asyncId = asyncDir.split(sep).at(-1) ?? "";
	assertAsyncRunIdentity(asyncId, asyncDir, asyncRoot);
	return asyncId;
}

export async function recoverRunBySessionDir(
	sessionDir: string,
	asyncRoot = subagentAsyncRoot(),
	ownerSessionId?: string,
	ownerSessionFile?: string,
): Promise<{ asyncId: string; asyncDir: string } | null> {
	let entries;
	try {
		entries = await readdir(asyncRoot, { withFileTypes: true });
	} catch {
		return null;
	}
	const expected = resolve(sessionDir);
	const directories = entries.filter((entry) => entry.isDirectory());
	const current = new Set(directories.map((entry) => entry.name));
	const index = asyncRunIndexes.get(asyncRoot) ?? new Map<string, IndexedAsyncRun>();
	const readTimes = asyncRunReadTimes.get(asyncRoot) ?? new Map<string, number>();
	asyncRunIndexes.set(asyncRoot, index);
	asyncRunReadTimes.set(asyncRoot, readTimes);
	for (const name of index.keys()) if (!current.has(name)) index.delete(name);
	for (const name of readTimes.keys()) if (!current.has(name)) readTimes.delete(name);
	const now = Date.now();
	const unread = directories.filter((entry) => {
		const record = index.get(entry.name);
		const needsIdentity = !record || (ownerSessionId !== undefined && record.sessionId === undefined);
		return needsIdentity && now - (readTimes.get(entry.name) ?? 0) >= ASYNC_STATUS_RECHECK_MS;
	});
	for (let offset = 0; offset < unread.length; offset += 64) {
		const batch = unread.slice(offset, offset + 64);
		const found = await Promise.all(batch.map(async (entry) => {
			const asyncDir = join(asyncRoot, entry.name);
			try {
				const status = JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")) as { runId?: string; sessionDir?: string; sessionId?: string };
				if (status.runId !== entry.name) return null;
				assertAsyncRunIdentity(status.runId, asyncDir, asyncRoot);
				if (typeof status.sessionDir !== "string" || !status.sessionDir) return null;
				return { asyncId: status.runId, asyncDir, sessionDir: resolve(status.sessionDir), ...(typeof status.sessionId === "string" ? { sessionId: status.sessionId } : {}) };
			} catch {
				// A concurrently-created run may not have committed status.json yet.
				return null;
			}
			}));
			for (let position = 0; position < batch.length; position += 1) {
				readTimes.set(batch[position]!.name, now);
				const record = found[position];
				if (record) index.set(record.asyncId, record);
			}
		}
	const canonicalOwnerSessionFile = ownerSessionFile && isAbsolute(ownerSessionFile) ? resolve(ownerSessionFile) : undefined;
	const matches = [...index.values()]
		.filter((record) => current.has(record.asyncId))
		.filter((record) => !ownerSessionId || record.sessionId === ownerSessionId
			|| (canonicalOwnerSessionFile !== undefined && typeof record.sessionId === "string" && isAbsolute(record.sessionId) && resolve(record.sessionId) === canonicalOwnerSessionFile))
		.filter((record) => within(expected, record.sessionDir))
		.map(({ asyncId, asyncDir }) => ({ asyncId, asyncDir }));
	if (matches.length > 1) throw new Error(`Multiple pi-subagents runs match graph attempt session root: ${sessionDir}`);
	return matches[0] ?? null;
}
