import type { FailureDetails } from "./types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function classifyChildFailure(status: Record<string, unknown>, _fallback: string): FailureDetails {
	if (status.timedOut === true || status.status === "timed_out") return { kind: "hard_deadline", retryKind: "timeout" };
	if (status.turnBudgetExceeded === true) return { kind: "budget_checkpoint", retryKind: "failed" };
	const failure = record(status.failure);
	const domain = failure?.domain ?? status.failureDomain;
	const code = failure?.code ?? status.failureCode;
	const stage = failure?.stage ?? status.failureStage;
	const retryAfter = failure?.retryAfterMs ?? status.retryAfterMs;
	if (domain === "provider" && typeof code === "string" && typeof stage === "string" && ["prelaunch", "runtime"].includes(stage)) {
		const normalizedCode = code.trim().toLowerCase().replace(/[\s-]+/g, "_");
		const rateLimited = ["rate_limit", "rate_limited", "429"].includes(normalizedCode);
		const transient = new Set([
			"overloaded", "unavailable", "service_unavailable", "timeout", "request_timeout",
			"connection_reset", "connection_error", "408", "425", "500", "502", "503", "504",
		]);
		if (!rateLimited && !transient.has(normalizedCode)) return { kind: "task_failed", retryKind: "failed" };
		const delay = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
			? Math.min(Math.ceil(retryAfter), 3_600_000)
			: undefined;
		return {
			kind: rateLimited ? "provider_rate_limit" : "provider_transient",
			retryKind: "provider",
			...(delay !== undefined ? { retryAfterMs: delay } : {}),
		};
	}
	return { kind: "task_failed", retryKind: "failed" };
}
