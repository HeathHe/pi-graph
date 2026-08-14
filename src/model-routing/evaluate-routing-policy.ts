import { createHash, randomUUID } from "node:crypto";
import type {
	IdentityConfidence,
	MaxAuthorizationUse,
	ModelRegistryEntry,
	ModelRoutingConfig,
	RoutingCandidateBinding,
	RoutingDecision,
	RoutingEvaluationInput,
	RoutingLevel,
	ModelInputModality,
	RoutingProfile,
} from "./types.ts";
import { defaultMaxAuthorizationStore, validateMaxAuthorization } from "./runtime-state.ts";
import { sealRoutingDecision, validateRoutingDecision } from "./validate-routing-decision.ts";

const CONFIDENCE_ORDER: Record<IdentityConfidence, number> = {
	unknown: 0,
	selected_only: 1,
	runtime_reported: 2,
	verified: 3,
};

function unique(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function weakestConfidence(values: IdentityConfidence[]): IdentityConfidence {
	if (values.length === 0) return "unknown";
	return values.reduce((weakest, value) => CONFIDENCE_ORDER[value] < CONFIDENCE_ORDER[weakest] ? value : weakest, "verified" as IdentityConfidence);
}

export function availableModelsDigest(availableModels: RoutingEvaluationInput["availableModels"]): string | undefined {
	if (!availableModels) return undefined;
	const normalized = availableModels.map((model) => ({
		fullId: model.fullId ?? `${model.provider}/${model.id}`,
		reasoning: model.reasoning ?? null,
		input: model.input ? [...model.input].sort() : null,
	})).sort((left, right) => left.fullId.localeCompare(right.fullId));
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function selectedModel(model: string, thinking: string | undefined): string {
	return thinking ? `${model}:${thinking}` : model;
}

function defaultLevel(index: number): Exclude<RoutingLevel, "L3"> {
	return index === 0 ? "L0" : index === 1 ? "L1" : "L2";
}

const ROUTING_LEVEL_ORDER: Record<Exclude<RoutingLevel, "L3">, number> = { L0: 0, L1: 1, L2: 2 };

function automaticFallbackCap(profile: RoutingProfile, input: RoutingEvaluationInput): Exclude<RoutingLevel, "L3"> {
	return profile.constraints?.maximumAutomaticFallback ?? (input.taskRisk === "high" ? "L1" : "L2");
}

function registryEntry(config: ModelRoutingConfig, model: string): ModelRegistryEntry {
	const entry = config.registry.models.find((candidate) => candidate.model === model || candidate.aliases?.includes(model));
	if (!entry) throw new Error(`Routing candidate '${model}' is not present in the model registry.`);
	return entry;
}

function selectionAvailabilityIssue(entry: ModelRegistryEntry, thinking: string | undefined, input: RoutingEvaluationInput, requiredInputModalities: ReadonlyArray<"text" | "image"> = []): string | undefined {
	if (!input.availableModels) return undefined;
	const available = input.availableModels.find((candidate) => {
		const fullId = candidate.fullId ?? `${candidate.provider}/${candidate.id}`;
		return fullId === entry.model || entry.aliases?.includes(fullId);
	});
	if (!available) return "is unavailable in the active Pi model registry";
	if (thinking && thinking !== "off" && available.reasoning !== true) return `does not have confirmed reasoning support for thinking '${thinking}'`;
	for (const modality of requiredInputModalities) {
		if (!available.input?.includes(modality)) return `does not have confirmed input modality '${modality}' in the active Pi model registry`;
	}
	return undefined;
}

function availableForSelection(entry: ModelRegistryEntry, thinking: string | undefined, input: RoutingEvaluationInput, requiredInputModalities: ReadonlyArray<"text" | "image"> = []): boolean {
	return selectionAvailabilityIssue(entry, thinking, input, requiredInputModalities) === undefined;
}

function requiredInputModalities(profile: RoutingProfile, input: RoutingEvaluationInput): ModelInputModality[] {
	return [...new Set([...(profile.constraints?.requiredInputModalities ?? []), ...(input.requiredInputModalities ?? [])])].sort();
}

function bindingAvailable(config: ModelRoutingConfig, candidate: RoutingCandidateBinding, input: RoutingEvaluationInput, profile: RoutingProfile): boolean {
	return availableForSelection(registryEntry(config, candidate.model), candidate.thinking, input, requiredInputModalities(profile, input));
}

function resolveProfile(config: ModelRoutingConfig, input: RoutingEvaluationInput): { name: string; profile: RoutingProfile } {
	const name = input.routingProfile ?? (input.agent ? config.policy.agentProfiles?.[input.agent] : undefined);
	if (!name) throw new Error(`No routingProfile is configured${input.agent ? ` for agent '${input.agent}'` : ""}.`);
	const profile = config.policy.profiles[name];
	if (!profile) throw new Error(`Unknown routingProfile '${name}'.`);
	return { name, profile };
}

function decisionBase(
	config: ModelRoutingConfig,
	input: RoutingEvaluationInput,
	profileName: string,
	profile: RoutingProfile,
	eligibleCandidates: RoutingCandidateBinding[],
	identityConfidence: IdentityConfidence,
) {
	const activeModelsDigest = availableModelsDigest(input.availableModels);
	return {
		schemaVersion: 1 as const,
		decisionId: randomUUID(),
		createdAt: (input.now ?? new Date()).toISOString(),
		taskBinding: input.taskBinding,
		...(input.agent ? { agent: input.agent } : {}),
		routingProfile: profileName,
		enforcement: input.enforcement ?? profile.enforcement ?? config.policy.enforcement ?? "shadow",
		...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
		eligibleCandidates,
		producerFamilies: unique((input.producerExecutions ?? []).map((producer) => producer.modelFamily)),
		producerProviderDomains: unique((input.producerExecutions ?? []).map((producer) => producer.providerDomain)),
		identityConfidence,
		budget: {
			providerRetries: profile.budget?.providerRetries ?? 0,
			modelDegradations: profile.budget?.modelDegradations ?? Math.max(0, eligibleCandidates.length - 1),
		},
		configDigest: config.configDigest,
		...(activeModelsDigest ? { availableModelsDigest: activeModelsDigest } : {}),
		...(requiredInputModalities(profile, input).length > 0 ? { requiredInputModalities: requiredInputModalities(profile, input) } : {}),
	};
}

function l3Decision(
	config: ModelRoutingConfig,
	input: RoutingEvaluationInput,
	profileName: string,
	profile: RoutingProfile,
	eligibleCandidates: RoutingCandidateBinding[],
	identityConfidence: IdentityConfidence,
	reason: string,
	previousDecision?: RoutingDecision,
): RoutingDecision {
	const now = (input.now ?? new Date()).toISOString();
	return sealRoutingDecision({
		...decisionBase(config, input, profileName, profile, eligibleCandidates, identityConfidence),
		fallbackLevel: "L3",
		degradationIndex: previousDecision?.degradationIndex ?? 0,
		...(previousDecision ? { parentDecisionId: previousDecision.decisionId } : {}),
		...(input.retryKind ? { retryKind: input.retryKind } : {}),
		reason,
		sealedAt: now,
	});
}

function deriveDecision(
	config: ModelRoutingConfig,
	input: RoutingEvaluationInput,
	profileName: string,
	profile: RoutingProfile,
	previous: RoutingDecision,
	candidateIndex: number,
	retryKind: "provider" | "model_degrade" | "task_retry",
	reason: string,
): RoutingDecision {
	const candidate = previous.eligibleCandidates[candidateIndex];
	if (!candidate) return l3Decision(config, input, profileName, profile, previous.eligibleCandidates, previous.identityConfidence, "No authorized routing candidate remains.", previous);
	const now = (input.now ?? new Date()).toISOString();
	let maxAuthorizationUse: MaxAuthorizationUse | undefined;
	if (previous.maxAuthorizationUse && retryKind === "task_retry" && candidate.selectedModel === previous.selectedModel) {
		const authorization = validateMaxAuthorization(input.maxAuthorization, {
			taskBinding: previous.taskBinding,
			model: candidate.selectedModel,
			now: input.now,
			trustedIssuers: config.policy.maxAuthorizationIssuers ?? {},
		});
		if (authorization.authorizationId !== previous.maxAuthorizationUse.authorizationId) throw new Error("Task retry max authorization does not match the originally consumed grant.");
		maxAuthorizationUse = previous.maxAuthorizationUse;
	}
	return sealRoutingDecision({
		...decisionBase(config, { ...input, requestedModel: previous.requestedModel }, profileName, profile, previous.eligibleCandidates, previous.identityConfidence),
		enforcement: previous.enforcement,
		budget: previous.budget,
		configDigest: previous.configDigest,
		producerFamilies: previous.producerFamilies,
		producerProviderDomains: previous.producerProviderDomains,
		fallbackLevel: candidate.fallbackLevel,
		selectedModel: candidate.selectedModel,
		modelFamily: candidate.modelFamily,
		provider: candidate.provider,
		providerDomain: candidate.providerDomain,
		candidateIndex,
		degradationIndex: retryKind === "model_degrade" ? previous.degradationIndex + 1 : previous.degradationIndex,
		parentDecisionId: previous.decisionId,
		retryKind,
		...(maxAuthorizationUse ? { maxAuthorizationUse } : {}),
		reason,
		sealedAt: now,
	});
}

export function evaluateRoutingPolicy(config: ModelRoutingConfig, input: RoutingEvaluationInput): RoutingDecision {
	if (!input.taskBinding.trim()) throw new Error("Routing evaluation requires a task binding.");
	const { name: profileName, profile } = resolveProfile(config, input);
	const requiredModalities = requiredInputModalities(profile, input);
	const previous = input.previousDecision ? validateRoutingDecision(input.previousDecision) : undefined;
	if (previous) {
		if (JSON.stringify(previous.requiredInputModalities ?? []) !== JSON.stringify(requiredModalities)) throw new Error("Previous RoutingDecision input modalities cannot be relaxed or changed.");
		if (previous.taskBinding !== input.taskBinding || previous.routingProfile !== profileName) throw new Error("Previous RoutingDecision is not bound to this task and profile.");
		if (input.retryKind === "provider") {
			return previous;
		}
		if (input.retryKind === "task_retry") {
			const prior = previous.eligibleCandidates[previous.candidateIndex!];
			if (!prior || !bindingAvailable(config, prior, input, profile)) {
				return l3Decision(config, input, profileName, profile, previous.eligibleCandidates, previous.identityConfidence, "The prior task-retry model is no longer available with the sealed thinking capability.", previous);
			}
			return deriveDecision(config, input, profileName, profile, previous, previous.candidateIndex!, "task_retry", "Task retry preserves the prior model binding.");
		}
		if (input.retryKind === "model_degrade") {
			if (previous.degradationIndex >= previous.budget.modelDegradations) {
				return l3Decision(config, input, profileName, profile, previous.eligibleCandidates, previous.identityConfidence, "Model degradation budget is exhausted.", previous);
			}
			let nextIndex = (previous.candidateIndex ?? -1) + 1;
			while (nextIndex < previous.eligibleCandidates.length && !bindingAvailable(config, previous.eligibleCandidates[nextIndex]!, input, profile)) nextIndex += 1;
			const next = previous.eligibleCandidates[nextIndex];
			const cap = automaticFallbackCap(profile, input);
			if (next && ROUTING_LEVEL_ORDER[next.fallbackLevel] > ROUTING_LEVEL_ORDER[cap]) {
				return l3Decision(config, input, profileName, profile, previous.eligibleCandidates, previous.identityConfidence, `Automatic model degradation is capped at '${cap}'.`, previous);
			}
			return deriveDecision(config, input, profileName, profile, previous, nextIndex, "model_degrade", "A new sealed decision selected the next available authorized degradation candidate.");
		}
		throw new Error("A previous RoutingDecision requires an explicit retry kind.");
	}

	const producerExecutions = input.producerExecutions ?? [];
	const producerFamilies = new Set(producerExecutions.map((producer) => producer.modelFamily).filter(Boolean));
	const producerDomains = new Set(producerExecutions.map((producer) => producer.providerDomain).filter(Boolean));
	const identityConfidence = weakestConfidence(producerExecutions.map((producer) => producer.identityConfidence));
	const enforcement = input.enforcement ?? profile.enforcement ?? config.policy.enforcement ?? "shadow";
	const requiredConfidence = input.taskRisk === "high"
		? profile.constraints?.highRiskMinimumIdentityConfidence ?? profile.constraints?.minimumIdentityConfidence
		: profile.constraints?.minimumIdentityConfidence;

	const eligibleCandidates: RoutingCandidateBinding[] = [];
	const unavailableCandidates: string[] = [];
	let explicitMaxError: string | undefined;
	for (const [index, candidate] of profile.candidates.entries()) {
		const entry = registryEntry(config, candidate.model);
		if (config.policy.quarantinedProviderDomains?.includes(entry.providerDomain)) continue;
		if (requiredModalities.some((modality) => !entry.inputModalities?.includes(modality))) continue;
		if (profile.constraints?.excludeFamilies?.includes(entry.family)) continue;
		if (profile.constraints?.excludeProviderDomains?.includes(entry.providerDomain)) continue;
		if (profile.constraints?.requireCrossFamilyFromProducers && producerFamilies.has(entry.family)) continue;
		if (profile.constraints?.requireProviderDomainSeparation && producerDomains.has(entry.providerDomain)) continue;
		const availabilityIssue = selectionAvailabilityIssue(entry, candidate.thinking, input, requiredModalities);
		if (availabilityIssue) {
			unavailableCandidates.push(`${selectedModel(entry.model, candidate.thinking)} ${availabilityIssue}`);
			continue;
		}
		const fullModel = selectedModel(entry.model, candidate.thinking);
		if (candidate.thinking === "max") {
			if (!profile.constraints?.allowAutomaticMax) {
				if (input.requestedModel !== fullModel) continue;
				try {
					validateMaxAuthorization(input.maxAuthorization, { taskBinding: input.taskBinding, model: fullModel, now: input.now, trustedIssuers: config.policy.maxAuthorizationIssuers ?? {} });
				} catch (error) {
					explicitMaxError = error instanceof Error ? error.message : String(error);
					continue;
				}
			}
		}
		eligibleCandidates.push({
			model: entry.model,
			...(candidate.thinking ? { thinking: candidate.thinking } : {}),
			selectedModel: fullModel,
			modelFamily: entry.family,
			provider: entry.provider,
			providerDomain: entry.providerDomain,
			fallbackLevel: candidate.level ?? defaultLevel(index),
		});
	}

	if (enforcement === "require" && requiredConfidence && CONFIDENCE_ORDER[identityConfidence] < CONFIDENCE_ORDER[requiredConfidence]) {
		return l3Decision(config, input, profileName, profile, eligibleCandidates, identityConfidence, `Routing requires producer identity confidence '${requiredConfidence}', observed '${identityConfidence}'.`);
	}
	if (enforcement === "require" && input.requireAvailableModels && !input.availableModels) {
		return l3Decision(config, input, profileName, profile, eligibleCandidates, identityConfidence, "Controlled routing requires an active Pi model registry snapshot before sealing an executable decision.");
	}
	if (enforcement === "require" && requiredModalities.length > 0 && !input.availableModels) {
		return l3Decision(config, input, profileName, profile, eligibleCandidates, identityConfidence, "Input-capability routing requires an active Pi model registry snapshot before sealing an executable decision.");
	}
	if (enforcement === "require" && profile.constraints?.requireCrossFamilyFromProducers && producerFamilies.size === 0) {
		return l3Decision(config, input, profileName, profile, eligibleCandidates, identityConfidence, "Cross-family routing has no runtime provenance for a substantive producer family.");
	}
	if (eligibleCandidates.length === 0) {
		return l3Decision(config, input, profileName, profile, [], identityConfidence, explicitMaxError ?? (unavailableCandidates.length > 0 ? `No runnable routing candidate remains: ${unavailableCandidates.join("; ")}.` : "No candidate satisfies the routing constraints."));
	}
	let candidateIndex = 0;
	if (input.requestedModel) {
		const requestedIndex = eligibleCandidates.findIndex((candidate) => candidate.selectedModel === input.requestedModel);
		if (requestedIndex >= 0) candidateIndex = requestedIndex;
		else return l3Decision(config, input, profileName, profile, eligibleCandidates, identityConfidence, explicitMaxError ?? `Requested model '${input.requestedModel}' is not eligible for routing profile '${profileName}'.`);
	}
	const candidate = eligibleCandidates[candidateIndex]!;
	const cap = automaticFallbackCap(profile, input);
	if (!input.requestedModel && ROUTING_LEVEL_ORDER[candidate.fallbackLevel] > ROUTING_LEVEL_ORDER[cap]) {
		return l3Decision(config, input, profileName, profile, eligibleCandidates, identityConfidence, `Automatic model selection is capped at '${cap}'.`);
	}
	const now = (input.now ?? new Date()).toISOString();
	let maxAuthorizationUse: MaxAuthorizationUse | undefined;
	if (candidate.thinking === "max" && !profile.constraints?.allowAutomaticMax && input.consumeMaxAuthorization) {
		maxAuthorizationUse = (input.authorizationStore ?? defaultMaxAuthorizationStore).consume(input.maxAuthorization!, { taskBinding: input.taskBinding, model: candidate.selectedModel, now: input.now });
	}
	return sealRoutingDecision({
		...decisionBase(config, input, profileName, profile, eligibleCandidates, identityConfidence),
		fallbackLevel: candidate.fallbackLevel,
		selectedModel: candidate.selectedModel,
		modelFamily: candidate.modelFamily,
		provider: candidate.provider,
		providerDomain: candidate.providerDomain,
		candidateIndex,
		degradationIndex: 0,
		...(maxAuthorizationUse ? { maxAuthorizationUse } : {}),
		reason: candidateIndex === 0 ? "Selected the highest-priority eligible candidate." : "Selected the explicitly requested eligible candidate.",
		sealedAt: now,
	});
}
