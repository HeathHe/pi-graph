import { assertAsyncRunIdentity, SubagentRpcClient } from "./rpc.ts";
import {
	AsyncRunDeadlineError,
	findAsyncRunByToolCallId,
	readAsyncRunState,
	requestAsyncStop,
	waitForAsyncRun,
	waitForConfirmedStop,
	type AsyncTerminal,
} from "./lifecycle.ts";
import { v3PreflightAgent as preflightAgentPublic } from "./preflight.ts";
import { canonicalDigest } from "./digests.ts";
import type { V3ChildOutcome, V3DispatchBinding } from "./types.ts";

const OUTPUT_CAP = 64 * 1024;

export interface V3DispatchSpec {
	agent: string;
	task: string;
	cwd: string;
	sessionDir: string;
	/** Project scope selects the frozen Agent definition materialized in the shadow workspace. */
	agentScope?: "project";
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
	const params = v3DispatchParams(spec);
	const requestDigest = canonicalDigest(params);
	let response: { asyncId: string; asyncDir: string };
	try {
		response = await rpc.spawn(params, options.stableRequestId, options.beforeEmit);
	} catch (error) {
		throw new V3DispatchError("spawn_failed", `V3 child dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		assertAsyncRunIdentity(response.asyncId, response.asyncDir);
		if (options.stableRequestId) {
			const toolCallId = v3ExpectedDispatchToolCallId(options.stableRequestId);
			const state = await readAsyncRunState(response.asyncId, response.asyncDir, toolCallId);
			if (state === undefined) throw new Error("pi-subagents returned an async run without durable status identity.");
		}
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

function v3DispatchParams(spec: V3DispatchSpec): Record<string, unknown> {
	return {
		agent: spec.agent,
		task: spec.task,
		cwd: spec.cwd,
		...(spec.sessionDir ? { sessionDir: spec.sessionDir } : {}),
		...(spec.agentScope ? { agentScope: spec.agentScope } : {}),
	};
}

export function v3DispatchRequestDigest(spec: V3DispatchSpec): string {
	return canonicalDigest(v3DispatchParams(spec));
}

/** pi-subagents records the RPC execution id separately from its opaque async UUID. */
export function v3ExpectedDispatchToolCallId(stableRequestId: string): string {
	return `rpc-spawn-${stableRequestId}`;
}

/** Recover a spawn whose RPC reply was lost after the durable emit boundary. */
export async function v3RecoverDispatchBinding(
	stableRequestId: string,
	requestDigest: string,
	dispatchedAt: string,
): Promise<V3DispatchBinding | undefined> {
	const identity = await findAsyncRunByToolCallId(v3ExpectedDispatchToolCallId(stableRequestId));
	if (!identity) return undefined;
	return { ...identity, requestDigest, dispatchedAt };
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

/**
 * Request termination through the public RPC and confirm it from the durable
 * child lifecycle projection. Merely aborting the local monitor is never proof
 * that the child stopped.
 */
export async function v3StopChild(
	rpc: SubagentRpcClient,
	identity: { asyncId: string; asyncDir: string },
	options: { timeoutMs?: number } = {},
): Promise<"stopped" | "failed" | "complete"> {
	assertAsyncRunIdentity(identity.asyncId, identity.asyncDir);
	const observed = await readAsyncRunState(identity.asyncId, identity.asyncDir);
	if (observed === "stopped" || observed === "failed" || observed === "complete") return observed;
	let rpcError: unknown;
	try {
		await rpc.call("stop", { id: identity.asyncId });
	} catch (error) {
		rpcError = error;
		// The public bridge may be between sessions; the lifecycle control file is
		// the portable durable fallback used by pi-subagents itself.
		await requestAsyncStop(identity.asyncDir).catch(() => undefined);
	}
	const confirmed = await waitForConfirmedStop(identity.asyncDir, options.timeoutMs ?? 30_000, {
		acceptFailed: true,
		acceptComplete: true,
	});
	if (!confirmed) {
		throw new V3DispatchError(
			"monitor_unknown",
			`V3 child stop could not be confirmed for ${identity.asyncId}${rpcError instanceof Error ? `: ${rpcError.message}` : ""}.`,
		);
	}
	const terminal = await readAsyncRunState(identity.asyncId, identity.asyncDir);
	if (terminal !== "stopped" && terminal !== "failed" && terminal !== "complete") {
		throw new V3DispatchError("monitor_unknown", `V3 child ${identity.asyncId} left an unexpected state after confirmed stop: ${String(terminal)}.`);
	}
	return terminal;
}

export function capOutput(output: string): string {
	if (Buffer.byteLength(output, "utf8") <= OUTPUT_CAP) return output;
	const marker = "\n[output truncated]";
	const budget = OUTPUT_CAP - Buffer.byteLength(marker, "utf8");
	const bytes = Buffer.from(output, "utf8");
	let end = budget;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	while (end > 0) {
		try {
			return decoder.decode(bytes.subarray(0, end)) + marker;
		} catch {
			end -= 1;
		}
	}
	return marker.slice(0, OUTPUT_CAP);
}
