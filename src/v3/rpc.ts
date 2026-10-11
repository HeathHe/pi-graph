import { verifySubagentCapabilities } from "./runtime-compatibility.ts";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const RPC_REQUEST = "pi-graph:runtime:v1:request";
export const RPC_READY = "pi-graph:runtime:v1:ready";
export const RPC_REPLY_PREFIX = "pi-graph:runtime:v1:reply:";

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
		super(`pi-graph runtime RPC '${method}' timed out.`);
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
	private readonly verifyRuntime?: () => Promise<void>;
	constructor(events: EventBus, timeoutMs = 10_000, verifyRuntime?: () => Promise<void>) {
		this.events = events;
		this.timeoutMs = timeoutMs;
		this.verifyRuntime = verifyRuntime;
	}

	call(method: "ping" | "status" | "spawn" | "interrupt" | "stop" | "resume", params?: unknown, stableRequestId?: string, beforeEmit?: () => void): Promise<unknown> {
		const requestId = stableRequestId ?? `pi-graph-${randomUUID()}`;
		return new Promise((resolvePromise, reject) => {
			let settled = false;
			const unsubscribe = this.events.on(`${RPC_REPLY_PREFIX}${requestId}`, (raw) => {
				if (settled) return;
				const reply = raw as RpcReply;
				if (reply?.version !== 1 || reply.requestId !== requestId) return;
				settled = true;
				clearTimeout(timer);
				if (typeof unsubscribe === "function") unsubscribe();
				if (reply?.success) resolvePromise(reply.data);
				else reject(new RpcRejectedError(requestId, method, reply?.error?.message ?? `pi-graph runtime RPC '${method}' failed.`, reply?.error?.code));
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

	async requireNativeRuntime(): Promise<void> {
		// Recheck each dispatch: the host can outlive an extension reload.
		verifySubagentCapabilities(await this.call("ping"));
		await this.verifyRuntime?.();
	}

	async spawn(params: Record<string, unknown>, stableRequestId?: string, beforeEmit?: () => void): Promise<{ asyncId: string; asyncDir: string }> {
		const response = await this.call("spawn", params, stableRequestId, beforeEmit) as { details?: { asyncId?: string; asyncDir?: string }; isError?: boolean; text?: string };
		const asyncId = response?.details?.asyncId;
		const asyncDir = response?.details?.asyncDir;
		if (response?.isError || !asyncId || !asyncDir) throw new RpcRejectedError(stableRequestId ?? "unknown", "spawn", response?.text ?? "pi-graph runtime RPC spawn returned no async run identity.");
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
	return join(process.env.PI_GRAPH_RUNTIME_ROOT?.trim() ? resolve(process.env.PI_GRAPH_RUNTIME_ROOT.trim()) : join(tmpdir(), `pi-graph-runtime-${scope}`), "async-subagent-runs");
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function assertAsyncRunIdentity(asyncId: string, asyncDir: string, asyncRoot = subagentAsyncRoot()): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(asyncId) || resolve(asyncDir) !== resolve(join(asyncRoot, asyncId))) {
		throw new Error("pi-graph runtime returned an invalid async run identity.");
	}
}

export function assertAsyncRunDirectory(asyncDir: string, asyncRoot = subagentAsyncRoot()): string {
	const asyncId = asyncDir.split(sep).at(-1) ?? "";
	assertAsyncRunIdentity(asyncId, asyncDir, asyncRoot);
	return asyncId;
}
