import { reportedTotalTokens } from "./usage-summary.ts";
import { readV3AttemptEvidence } from "./attempt.ts";
import type {
	V3AttemptEvidence,
	V3ChildTokenUsageObservation,
	V3UsageBudgetHint,
	V3UsageBudgetLimitHint,
} from "./types.ts";

export type V3UsageBudgetMetric = "tokens" | "costUsd";

export interface V3UsageBudgetUsage {
	tokens?: number;
	costUsd?: number;
}

export interface V3UsageBudgetBlock {
	reason: V3UsageBudgetMetric | "missing_evidence";
	message: string;
}

/**
 * A node usage budget is a lifetime budget, not a fresh allowance per Attempt.
 * `remaining` is therefore the only budget that may be sent to a later child.
 */
export interface V3UsageBudgetDecision {
	remaining?: V3UsageBudgetHint;
	used: V3UsageBudgetUsage;
	blocked?: V3UsageBudgetBlock;
}

function crossedDispatchBoundary(evidence: V3AttemptEvidence): boolean {
	return evidence.dispatch !== undefined || evidence.dispatchIntent?.state === "emitting";
}

const reportedTokens = reportedTotalTokens;

function usageSum(left: number, right: number): number {
	return left + right;
}

function remainingLimit(limit: V3UsageBudgetLimitHint, used: number): V3UsageBudgetLimitHint {
	const hard = limit.hard - used;
	const soft = limit.soft !== undefined && used < limit.soft ? limit.soft - used : undefined;
	return { ...(soft === undefined ? {} : { soft }), hard };
}

function exhausted(metric: V3UsageBudgetMetric, limit: V3UsageBudgetLimitHint, used: number): V3UsageBudgetBlock | undefined {
	if (used < limit.hard) return undefined;
	const unit = metric === "tokens" ? "tokens" : "USD";
	return {
		reason: metric,
		message: `Node usage budget exhausted for ${metric}: reported ${used} ${unit}, hard limit ${limit.hard} ${unit}.`,
	};
}

/** Pure evaluator used by admission gates, retry recovery, and focused tests. */
export function evaluateV3UsageBudget(
	budget: V3UsageBudgetHint | undefined,
	attempts: readonly V3AttemptEvidence[],
): V3UsageBudgetDecision {
	if (!budget) return { used: {} };
	let tokens = 0;
	let costUsd = 0;
	const missing: Array<{ attempt: number; metrics: V3UsageBudgetMetric[] }> = [];

	for (const evidence of attempts) {
		if (!crossedDispatchBoundary(evidence)) continue;
		// A terminal child observation is the best available usage evidence. The
		// latest Attempt projection is the bounded fallback for interrupted runs.
		const usage = (evidence.child?.observation ?? evidence.observation)?.usage;
		const missingMetrics: V3UsageBudgetMetric[] = [];
		if (budget.tokens) {
			const value = reportedTokens(usage);
			if (value === undefined) missingMetrics.push("tokens");
			else tokens = usageSum(tokens, value);
		}
		if (budget.costUsd) {
			const raw = usage?.costUsd;
            const value = raw!==undefined&&Number.isFinite(raw)&&raw>=0?raw:undefined;
			if (value === undefined) missingMetrics.push("costUsd");
			else costUsd = usageSum(costUsd, value);
		}
		if (missingMetrics.length > 0) missing.push({ attempt: evidence.attempt, metrics: missingMetrics });
	}

	const used: V3UsageBudgetUsage = {
		...(budget.tokens ? { tokens } : {}),
		...(budget.costUsd ? { costUsd } : {}),
	};
	if (missing.length > 0) {
		const details = missing.map((entry) => `Attempt ${entry.attempt} (${entry.metrics.join(", ")})`).join("; ");
		return {
			used,
			blocked: {
				reason: "missing_evidence",
				message: `Node usage budget cannot be proven because dispatched Attempt evidence is missing configured usage metrics: ${details}.`,
			},
		};
	}
	const tokenBlock = budget.tokens ? exhausted("tokens", budget.tokens, tokens) : undefined;
	if (tokenBlock) return { used, blocked: tokenBlock };
	const costBlock = budget.costUsd ? exhausted("costUsd", budget.costUsd, costUsd) : undefined;
	if (costBlock) return { used, blocked: costBlock };
	return {
		used,
		remaining: {
			...(budget.tokens ? { tokens: remainingLimit(budget.tokens, tokens) } : {}),
			...(budget.costUsd ? { costUsd: remainingLimit(budget.costUsd, costUsd) } : {}),
		},
	};
}

/**
 * Rebuild the residual allowance for `nextAttempt` from immutable earlier
 * Attempt evidence. A gap is itself missing budget evidence and fails closed.
 */
export async function readV3UsageBudgetDecision(
	runDir: string,
	taskId: string,
	nextAttempt: number,
	budget: V3UsageBudgetHint | undefined,
): Promise<V3UsageBudgetDecision> {
	if (!budget) return { used: {} };
	const attempts: V3AttemptEvidence[] = [];
	for (let attempt = 1; attempt < nextAttempt; attempt += 1) {
		let evidence: V3AttemptEvidence | undefined;
		try {
			evidence = await readV3AttemptEvidence(runDir, taskId, attempt);
		} catch (error) {
			const partial = evaluateV3UsageBudget(budget, attempts);
			return {
				used: partial.used,
				blocked: {
					reason: "missing_evidence",
					message: `Node usage budget cannot be proven because Attempt ${attempt} evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`,
				},
			};
		}
		if (!evidence) {
			const partial = evaluateV3UsageBudget(budget, attempts);
			return {
				used: partial.used,
				blocked: {
					reason: "missing_evidence",
					message: `Node usage budget cannot be proven because Attempt ${attempt} evidence is missing.`,
				},
			};
		}
		attempts.push(evidence);
	}
	return evaluateV3UsageBudget(budget, attempts);
}
