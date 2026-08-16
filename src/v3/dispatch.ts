import { assertAsyncRunIdentity, SubagentRpcClient } from "./rpc.ts";
import { AsyncRunDeadlineError, waitForAsyncRun, type AsyncTerminal } from "./lifecycle.ts";
import { v3PreflightAgent as preflightAgentPublic } from "./preflight.ts";
import { canonicalDigest } from "./digests.ts";
import type { V3ChildOutcome } from "./types.ts";

const OUTPUT_CAP = 64 * 1024;

export interface V3DispatchSpec {
	agent: string;
	task: string;
	cwd: string;
	sessionDir: string;
}

export interface V3DispatchBinding {
	asyncId: string;
	asyncDir: string;
	requestDigest: string;
	dispatchedAt: string;
}

export class V3DispatchError extends Error {
	readonly kind: "agent_unavailable" | "spawn_failed" | "monitor_timeout" | "monitor_unknown" | "aborted";
	constructor(kind: V3DispatchError["kind"], message: string) {
		super(message);
		this.name = "V3DispatchError";
		this.kind = kind;
	}
}

export async function v3PreflightAgent(spec: Pick<V3DispatchSpec, "agent">, sourceCwd: string, sessionId?: string): Promise<void> {
	const result = await preflightAgentPublic({ agent: spec.agent, cwd: sourceCwd, sessionId });
	if (!result.ok) throw new V3DispatchError("agent_unavailable", `Agent '${spec.agent}' is not available: ${result.message}`);
}

export async function v3DispatchChild(
	rpc: SubagentRpcClient,
	spec: V3DispatchSpec,
	options: { stableRequestId?: string; beforeEmit?: () => void } = {},
): Promise<V3DispatchBinding> {
	const params: Record<string, unknown> = {
		agent: spec.agent,
		task: spec.task,
		cwd: spec.cwd,
		...(spec.sessionDir ? { sessionDir: spec.sessionDir } : {}),
	};
	const requestDigest = canonicalDigest(params);
	let response: { asyncId: string; asyncDir: string };
	try {
		response = await rpc.spawn(params, options.stableRequestId, options.beforeEmit);
	} catch (error) {
		throw new V3DispatchError("spawn_failed", `V3 child dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		assertAsyncRunIdentity(response.asyncId, response.asyncDir);
	} catch (error) {
		throw new V3DispatchError("monitor_unknown", `V3 child dispatch returned an ambiguous run identity: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		asyncId: response.asyncId,
		asyncDir: response.asyncDir,
		requestDigest,
		dispatchedAt: new Date().toISOString(),
	};
}

export async function v3MonitorChild(
	rpc: SubagentRpcClient,
	identity: { asyncId: string; asyncDir: string },
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<V3ChildOutcome> {
	try {
		const terminal: AsyncTerminal = await waitForAsyncRun({
			events: rpc.events,
			asyncId: identity.asyncId,
			asyncDir: identity.asyncDir,
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.signal ? { signal: options.signal } : {}),
		});
		return {
			terminal: terminal.state,
			output: capOutput(terminal.output),
			completedAt: new Date().toISOString(),
		};
	} catch (error) {
		if (error instanceof AsyncRunDeadlineError) {
			throw new V3DispatchError("monitor_timeout", `V3 child exceeded its monitor deadline: ${identity.asyncId}`);
		}
		if (error instanceof Error && error.message.includes("aborted")) {
			throw new V3DispatchError("aborted", `V3 child monitoring aborted: ${identity.asyncId}`);
		}
		throw new V3DispatchError("monitor_unknown", `V3 child monitoring is ambiguous: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function capOutput(output: string): string {
	if (Buffer.byteLength(output, "utf8") <= OUTPUT_CAP) return output;
	return Buffer.from(output, "utf8").subarray(0, OUTPUT_CAP).toString("utf8") + "\n[output truncated]";
}
