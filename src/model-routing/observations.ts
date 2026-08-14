import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RoutingObservation, RoutingObservationComparison } from "./types.ts";

export interface RoutingObservationLogOptions {
	path?: string;
	agentDir?: string;
}

export interface RoutingShadowSummary {
	totalRecords: number;
	decisionRecords: number;
	resultRecords: number;
	incompleteDecisionRecords: number;
	runtimeIncompatibleRecords: number;
	comparableSamples: number;
	comparisons: Record<RoutingObservationComparison, number>;
	resultOutcomes: { success: number; error: number };
	profiles: Record<string, { decisions: number; match: number; mismatch: number; unrouted: number; blocked: number; error: number }>;
	firstObservedAt?: string;
	lastObservedAt?: string;
	recommendation: "collect_more" | "investigate" | "candidate";
	recommendationReason: string;
}

const appendQueues = new Map<string, Promise<void>>();

export function routingObservationLogPath(options: RoutingObservationLogOptions = {}): string {
	if (options.path) return resolve(options.path);
	if (process.env.PI_MODEL_ROUTING_OBSERVATIONS_PATH) return resolve(process.env.PI_MODEL_ROUTING_OBSERVATIONS_PATH);
	const agentDir = resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	return join(agentDir, "model-routing", "shadow-observations.jsonl");
}

export async function persistRoutingObservation(
	observation: RoutingObservation,
	options: RoutingObservationLogOptions = {},
): Promise<string> {
	const path = routingObservationLogPath(options);
	const previous = appendQueues.get(path) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(async () => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(observation)}\n`, "utf8");
	});
	appendQueues.set(path, next);
	try {
		await next;
	} finally {
		if (appendQueues.get(path) === next) appendQueues.delete(path);
	}
	return path;
}

export async function persistRoutingObservationSafely(
	observation: RoutingObservation,
	options: RoutingObservationLogOptions = {},
): Promise<string | undefined> {
	try {
		return await persistRoutingObservation(observation, options);
	} catch {
		return undefined;
	}
}

export async function readRoutingObservations(options: RoutingObservationLogOptions = {}): Promise<RoutingObservation[]> {
	const path = routingObservationLogPath(options);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const observations: RoutingObservation[] = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			observations.push(JSON.parse(line) as RoutingObservation);
		} catch {
			// A partial or corrupt line must not hide otherwise valid shadow evidence.
			continue;
		}
	}
	return observations;
}

function comparisonCounts(): Record<RoutingObservationComparison, number> {
	return { match: 0, mismatch: 0, unrouted: 0, blocked: 0, error: 0 };
}

export function summarizeRoutingObservations(
	observations: RoutingObservation[],
	options: { minimumComparableSamples?: number } = {},
): RoutingShadowSummary {
	const minimumComparableSamples = options.minimumComparableSamples ?? 10;
	const shadow = observations.filter((observation) => observation.mode === "shadow");
	const decisions = shadow.filter((observation) => observation.phase !== "tool_result");
	const results = shadow.filter((observation) => observation.phase === "tool_result");
	const comparisons = comparisonCounts();
	const profiles: RoutingShadowSummary["profiles"] = {};
	const resultKeys = new Set(results.map((observation) => `${observation.toolCallId}:${observation.taskIndex}`));
	const comparableObservations = results;
	const incompleteDecisionRecords = decisions.filter((observation) => !resultKeys.has(`${observation.toolCallId}:${observation.taskIndex}`)).length;
	for (const observation of comparableObservations) {
		const comparison = observation.comparison ?? (observation.error ? "error" : undefined);
		if (comparison) comparisons[comparison] += 1;
	}
	for (const observation of comparableObservations) {
		const comparison = observation.comparison ?? (observation.error ? "error" : undefined);
		const profileName = observation.routingProfile ?? observation.decision?.routingProfile;
		if (!profileName) continue;
		const profile = profiles[profileName] ?? { decisions: 0, match: 0, mismatch: 0, unrouted: 0, blocked: 0, error: 0 };
		profile.decisions += 1;
		if (comparison) profile[comparison] += 1;
		profiles[profileName] = profile;
	}
	const resultOutcomes = {
		success: results.filter((observation) => observation.outcome === "success").length,
		error: results.filter((observation) => observation.outcome === "error").length,
	};
	const runtimeIncompatibleRecords = shadow.filter((observation) => observation.runtimeCompatibility === "runtime_incompatible").length;
	const comparableSamples = comparisons.match + comparisons.mismatch;
	let recommendation: RoutingShadowSummary["recommendation"] = "candidate";
	let recommendationReason = "Comparable shadow samples agree and no blocking or observation errors were recorded. This is evidence for manual review, not automatic authorization to enable require mode.";
	if (runtimeIncompatibleRecords > 0 || comparisons.mismatch > 0 || comparisons.blocked > 0 || comparisons.error > 0 || resultOutcomes.error > 0) {
		recommendation = "investigate";
		recommendationReason = runtimeIncompatibleRecords > 0
			? `${runtimeIncompatibleRecords} runtime_incompatible record(s) were excluded from comparable samples; update the pi-graph adapter before enabling require mode.`
			: "One or more shadow decisions disagreed with an existing input model, reached L3, failed evaluation, or ended with a tool error.";
	} else if (incompleteDecisionRecords > 0 || comparableSamples < minimumComparableSamples) {
		recommendation = "collect_more";
		recommendationReason = incompleteDecisionRecords > 0
			? `${incompleteDecisionRecords} decision record(s) have no terminal result and are excluded from readiness evidence.`
			: `Only ${comparableSamples} comparable sample(s) are available; collect at least ${minimumComparableSamples} before considering enforcement.`;
	}
	const timestamps = shadow.map((observation) => observation.observedAt).filter(Boolean).sort();
	return {
		totalRecords: shadow.length,
		decisionRecords: decisions.length,
		resultRecords: results.length,
		incompleteDecisionRecords,
		runtimeIncompatibleRecords,
		comparableSamples,
		comparisons,
		resultOutcomes,
		profiles,
		...(timestamps[0] ? { firstObservedAt: timestamps[0] } : {}),
		...(timestamps.at(-1) ? { lastObservedAt: timestamps.at(-1) } : {}),
		recommendation,
		recommendationReason,
	};
}
