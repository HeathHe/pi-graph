import type { AsyncTerminal } from "../lifecycle.ts";
import type { IdentityConfidence, ModelExecution, ModelRoutingConfig, RoutingDecision, RoutingLevel } from "./types.ts";

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;
const THINKING_VALUE = /^(?:off|minimal|low|medium|high|xhigh|max)$/;

export function baseModel(model: string): string {
	return model.replace(THINKING_SUFFIX, "");
}

export function modelWithThinking(model: string, thinking?: unknown): string {
	if (THINKING_SUFFIX.test(model)) return model;
	return typeof thinking === "string" && THINKING_VALUE.test(thinking)
		? `${model}:${thinking}`
		: model;
}

export function modelThinkingConflict(model: string, thinking: unknown): string | undefined {
	if (thinking === undefined) return undefined;
	if (typeof thinking !== "string" || !THINKING_VALUE.test(thinking)) return "Runtime reported an invalid thinking level.";
	const suffix = model.match(THINKING_SUFFIX)?.[1];
	return suffix && suffix !== thinking
		? `Runtime model suffix '${suffix}' conflicts with the independent thinking level '${thinking}'.`
		: undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(record).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const output = value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim());
	return output.length ? output : undefined;
}

export interface RuntimeModelReport {
	resolvedModel?: string;
	attemptedModels?: string[];
	thinking?: string;
	providerRequestId?: string;
	conflicts?: string[];
}

export function extractRuntimeModelReport(terminal: AsyncTerminal | undefined): RuntimeModelReport {
	if (!terminal) return {};
	const sources = [...records(terminal.status.steps), ...records(terminal.completion?.results), terminal.status, ...(terminal.completion ? [terminal.completion] : [])];
	const conflicts: string[] = [];
	for (const source of sources) {
		if (Object.hasOwn(source, "model") && (typeof source.model !== "string" || !source.model.trim())) conflicts.push("Runtime reported an invalid resolved model.");
		if (Object.hasOwn(source, "thinking") && (typeof source.thinking !== "string" || !THINKING_VALUE.test(source.thinking))) conflicts.push("Runtime reported an invalid thinking level.");
		if (typeof source.model === "string" && source.model.trim()) {
			const issue = modelThinkingConflict(source.model.trim(), source.thinking);
			if (issue) conflicts.push(issue);
		}
		if (Object.hasOwn(source, "attemptedModels")) {
			if (!Array.isArray(source.attemptedModels) || source.attemptedModels.some((entry) => typeof entry !== "string" || !entry.trim())) {
				conflicts.push("Runtime reported invalid attempted-model evidence.");
			} else {
				for (const attempted of source.attemptedModels) {
					const issue = modelThinkingConflict(attempted, source.thinking);
					if (issue) conflicts.push(issue);
				}
			}
		}
		if (Object.hasOwn(source, "providerRequestId") && (typeof source.providerRequestId !== "string" || !source.providerRequestId.trim())) conflicts.push("Runtime reported an invalid provider request id.");
	}
	const models = sources.flatMap((source) => typeof source.model === "string" && source.model.trim() ? [source.model.trim()] : []);
	const thinkingValues = sources.flatMap((source) => typeof source.thinking === "string" && THINKING_VALUE.test(source.thinking) ? [source.thinking] : []);
	const providerRequestIds = sources.flatMap((source) => typeof source.providerRequestId === "string" && source.providerRequestId.trim() ? [source.providerRequestId.trim()] : []);
	const modelSet = new Set(models);
	const thinkingSet = new Set(thinkingValues);
	const requestIdSet = new Set(providerRequestIds);
	const suffixedThinking = sources.flatMap((source) => [
		...(typeof source.model === "string" ? [source.model] : []),
		...(Array.isArray(source.attemptedModels) ? source.attemptedModels.filter((value): value is string => typeof value === "string") : []),
	]).flatMap((model) => model.match(THINKING_SUFFIX)?.[1] ?? []);
	if (modelSet.size > 1) conflicts.push(`Runtime reported conflicting resolved models: ${[...modelSet].join(", ")}.`);
	if (thinkingSet.size > 1) conflicts.push(`Runtime reported conflicting thinking levels: ${[...thinkingSet].join(", ")}.`);
	if (thinkingSet.size > 0 && suffixedThinking.some((suffix) => !thinkingSet.has(suffix))) conflicts.push("Runtime model suffix conflicts with thinking evidence reported by another runtime source.");
	if (requestIdSet.size > 1) conflicts.push("Runtime reported conflicting provider request ids.");
	const rawResolvedModel = models[0];
	const thinking = thinkingValues[0];
	const attemptedModels = sources.flatMap((source) => (stringArray(source.attemptedModels) ?? []).map((model) => modelWithThinking(model, typeof source.thinking === "string" ? source.thinking : thinking)));
	const distinctAttemptedModels = [...new Set(attemptedModels)];
	const resolvedModel = rawResolvedModel ? modelWithThinking(rawResolvedModel, thinking) : undefined;
	const providerRequestId = providerRequestIds[0];
	return {
		...(resolvedModel ? { resolvedModel } : {}),
		...(distinctAttemptedModels.length ? { attemptedModels: distinctAttemptedModels } : {}),
		...(thinking ? { thinking } : {}),
		...(providerRequestId ? { providerRequestId } : {}),
		...(conflicts.length ? { conflicts: [...new Set(conflicts)] } : {}),
	};
}

function factsFor(model: string, decision?: RoutingDecision, config?: ModelRoutingConfig): { family: string; providerDomain: string } | undefined {
	const base = baseModel(model);
	const decisionCandidate = decision?.eligibleCandidates.find((candidate) => candidate.model === base || candidate.selectedModel === model);
	if (decisionCandidate) return { family: decisionCandidate.modelFamily, providerDomain: decisionCandidate.providerDomain };
	const registry = config?.registry.models.find((entry) => entry.model === base || entry.aliases?.includes(base));
	return registry ? { family: registry.family, providerDomain: registry.providerDomain } : undefined;
}

export function createModelExecution(input: {
	terminal?: AsyncTerminal;
	decision?: RoutingDecision;
	legacyRequestedModel?: string;
	config?: ModelRoutingConfig;
}): ModelExecution | undefined {
	const report = extractRuntimeModelReport(input.terminal);
	const decisionApplied = input.decision?.enforcement === "require";
	const selectedModel = (decisionApplied ? input.decision?.selectedModel : undefined) ?? input.legacyRequestedModel ?? report.resolvedModel;
	if (!selectedModel || !report.resolvedModel) return undefined;
	const facts = factsFor(report.resolvedModel, input.decision, input.config);
	const confidence: IdentityConfidence = facts ? "runtime_reported" : "unknown";
	const routingViolations: string[] = [];
	routingViolations.push(...(report.conflicts ?? []));
	if (decisionApplied && selectedModel !== report.resolvedModel) {
		routingViolations.push(`Resolved model '${report.resolvedModel}' does not match sealed selection '${selectedModel}'.`);
	}
	const distinctAttempted = new Set(report.attemptedModels ?? []);
	if (decisionApplied && distinctAttempted.size > 1) {
		routingViolations.push(`Managed execution attempted multiple models: ${[...distinctAttempted].join(", ")}.`);
	}
	if (decisionApplied && [...distinctAttempted].some((model) => model !== report.resolvedModel || model !== selectedModel)) {
		routingViolations.push(`Managed execution attempted a model that differs from the sealed and resolved model: ${[...distinctAttempted].join(", ")}.`);
	}
	return {
		requestedModel: (decisionApplied ? input.decision?.requestedModel : undefined) ?? input.legacyRequestedModel ?? selectedModel,
		selectedModel,
		resolvedModel: report.resolvedModel,
		modelFamily: facts?.family ?? "unknown",
		providerDomain: facts?.providerDomain ?? "unknown",
		fallbackLevel: decisionApplied ? input.decision!.fallbackLevel : "L0" as RoutingLevel,
		identityConfidence: confidence,
		...(report.attemptedModels ? { attemptedModels: report.attemptedModels } : {}),
		...(report.providerRequestId ? { providerRequestId: report.providerRequestId } : {}),
		...(routingViolations.length ? { routingViolations } : {}),
	};
}
