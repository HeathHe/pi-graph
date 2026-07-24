import type { FailureDetails } from "./types.ts";

const RATE_LIMIT_PATTERN = /\b(?:429|rate[ _-]?limit(?:ed|ing)?|too many requests|quota exceeded)\b/i;
const TRANSIENT_PATTERN = /\b(?:408|425|500|502|503|504|overloaded|temporarily unavailable|econnreset|etimedout|connection reset|socket hang up)\b/i;

function statusText(status: Record<string, unknown>, fallback: string): string {
	const parts = [
		fallback,
		typeof status.error === "string" ? status.error : "",
		typeof status.message === "string" ? status.message : "",
	];
	return parts.filter(Boolean).join(" ");
}

function retryAfterMs(text: string): number | undefined {
	const milliseconds = text.match(/\bretry[- ]?after(?:\s*[:=]\s*|\s+)(\d+)\s*ms\b/i);
	if (milliseconds) return Math.min(Number(milliseconds[1]), 3_600_000);
	const seconds = text.match(/\bretry[- ]?after(?:\s*[:=]\s*|\s+)(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i);
	if (seconds) return Math.min(Math.ceil(Number(seconds[1]) * 1_000), 3_600_000);
	return undefined;
}

export function classifyChildFailure(status: Record<string, unknown>, fallback: string): FailureDetails {
	const text = statusText(status, fallback);
	if (status.timedOut === true) return { kind: "hard_deadline", retryKind: "timeout" };
	if (status.turnBudgetExceeded === true) return { kind: "budget_checkpoint", retryKind: "failed" };
	if (RATE_LIMIT_PATTERN.test(text)) {
		const delay = retryAfterMs(text);
		return {
			kind: "provider_rate_limit",
			retryKind: "provider",
			...(delay !== undefined ? { retryAfterMs: delay } : {}),
		};
	}
	if (TRANSIENT_PATTERN.test(text)) return { kind: "provider_transient", retryKind: "provider" };
	return { kind: "task_failed", retryKind: "failed" };
}
