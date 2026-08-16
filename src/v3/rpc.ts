import { randomUUID } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const RPC_REQUEST = "subagents:rpc:v1:request";
export const RPC_READY = "subagents:rpc:v1:ready";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

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
