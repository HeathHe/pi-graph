import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	IdentityConfidence,
	ModelInputModality,
	ModelRegistry,
	ModelRegistryEntry,
	ModelRoutingConfig,
	RoutingEnforcement,
	RoutingPolicy,
	RoutingPolicyBudget,
	RoutingPolicyCandidate,
	RoutingPolicyConstraints,
	RoutingProfile,
	ThinkingLevel,
} from "./types.ts";

export interface ModelRoutingConfigInput {
	registry?: ModelRegistry;
	policy?: RoutingPolicy;
	registryPath?: string;
	policyPath?: string;
	agentDir?: string;
}

export class ModelRoutingConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelRoutingConfigError";
	}
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CONFIDENCE_LEVELS = new Set<IdentityConfidence>(["unknown", "selected_only", "runtime_reported", "verified"]);
const ENFORCEMENT = new Set<RoutingEnforcement>(["shadow", "require"]);
const INPUT_MODALITIES = new Set<ModelInputModality>(["text", "image"]);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new ModelRoutingConfigError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
	assert(typeof value === "string" && Boolean(value.trim()), `${label} must be a non-empty string.`);
	return value.trim();
}

function stringArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	assert(Array.isArray(value), `${label} must be an array.`);
	const output = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
	assert(new Set(output).size === output.length, `${label} must not contain duplicates.`);
	return output;
}

function parseRegistryEntry(value: unknown, index: number): ModelRegistryEntry {
	assert(isRecord(value), `model-registry.models[${index}] must be an object.`);
	const model = nonEmptyString(value.model, `model-registry.models[${index}].model`);
	assert(model.includes("/"), `model-registry.models[${index}].model must use provider/model form.`);
	assert(!/(?:^|:)(?:off|minimal|low|medium|high|xhigh|max)$/.test(model), `model-registry.models[${index}].model must not include a thinking suffix.`);
	const provider = nonEmptyString(value.provider, `model-registry.models[${index}].provider`);
	assert(model.startsWith(`${provider}/`), `model-registry.models[${index}].provider must match model.`);
	const aliases = stringArray(value.aliases, `model-registry.models[${index}].aliases`);
	let thinkingLevels: ThinkingLevel[] | undefined;
	let inputModalities: ModelInputModality[] | undefined;
	if (value.thinkingLevels !== undefined) {
		assert(Array.isArray(value.thinkingLevels), `model-registry.models[${index}].thinkingLevels must be an array.`);
		thinkingLevels = value.thinkingLevels.map((entry, thinkingIndex) => {
			assert(typeof entry === "string" && THINKING_LEVELS.has(entry as ThinkingLevel), `model-registry.models[${index}].thinkingLevels[${thinkingIndex}] is unsupported.`);
			return entry as ThinkingLevel;
		});
		assert(new Set(thinkingLevels).size === thinkingLevels.length, `model-registry.models[${index}].thinkingLevels must not contain duplicates.`);
	}
	if (value.inputModalities !== undefined) {
		assert(Array.isArray(value.inputModalities), `model-registry.models[${index}].inputModalities must be an array.`);
		inputModalities = value.inputModalities.map((entry, modalityIndex) => {
			assert(typeof entry === "string" && INPUT_MODALITIES.has(entry as ModelInputModality), `model-registry.models[${index}].inputModalities[${modalityIndex}] is unsupported.`);
			return entry as ModelInputModality;
		});
		assert(inputModalities.length > 0, `model-registry.models[${index}].inputModalities must not be empty.`);
		assert(new Set(inputModalities).size === inputModalities.length, `model-registry.models[${index}].inputModalities must not contain duplicates.`);
	}
	return {
		model,
		family: nonEmptyString(value.family, `model-registry.models[${index}].family`),
		provider,
		providerDomain: nonEmptyString(value.providerDomain, `model-registry.models[${index}].providerDomain`),
		...(aliases ? { aliases } : {}),
		...(thinkingLevels ? { thinkingLevels } : {}),
		...(inputModalities ? { inputModalities } : {}),
	};
}

export function validateModelRegistry(value: unknown): ModelRegistry {
	assert(isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.models), "model-registry.json must be schemaVersion 1 with a models array.");
	const models = value.models.map(parseRegistryEntry);
	assert(models.length > 0, "model-registry.models must not be empty.");
	const identifiers = new Set<string>();
	for (const entry of models) {
		for (const identifier of [entry.model, ...(entry.aliases ?? [])]) {
			assert(!identifiers.has(identifier), `Duplicate model registry identifier: ${identifier}`);
			identifiers.add(identifier);
		}
	}
	return { schemaVersion: 1, models };
}

function parseCandidate(value: unknown, profile: string, index: number): RoutingPolicyCandidate {
	assert(isRecord(value), `routing-policy.profiles.${profile}.candidates[${index}] must be an object.`);
	const thinking = value.thinking;
	assert(thinking === undefined || (typeof thinking === "string" && THINKING_LEVELS.has(thinking as ThinkingLevel)), `routing-policy.profiles.${profile}.candidates[${index}].thinking is unsupported.`);
	const level = value.level;
	assert(level === undefined || ["L0", "L1", "L2"].includes(level as string), `routing-policy.profiles.${profile}.candidates[${index}].level must be L0, L1, or L2.`);
	return {
		model: nonEmptyString(value.model, `routing-policy.profiles.${profile}.candidates[${index}].model`),
		...(thinking !== undefined ? { thinking: thinking as ThinkingLevel } : {}),
		...(level !== undefined ? { level: level as "L0" | "L1" | "L2" } : {}),
	};
}

function parseConstraints(value: unknown, profile: string): RoutingPolicyConstraints | undefined {
	if (value === undefined) return undefined;
	assert(isRecord(value), `routing-policy.profiles.${profile}.constraints must be an object.`);
	const supportedFields = new Set([
		"excludeFamilies",
		"excludeProviderDomains",
		"requireCrossFamilyFromProducers",
		"requireProviderDomainSeparation",
		"allowAutomaticMax",
		"producerSource",
		"minimumIdentityConfidence",
		"highRiskMinimumIdentityConfidence",
		"maximumAutomaticFallback",
		"requiredInputModalities",
	]);
	for (const field of Object.keys(value)) {
		assert(supportedFields.has(field), `routing-policy.profiles.${profile}.constraints contains unknown field '${field}'.`);
	}
	for (const field of ["requireCrossFamilyFromProducers", "requireProviderDomainSeparation", "allowAutomaticMax"] as const) {
		assert(value[field] === undefined || typeof value[field] === "boolean", `routing-policy.profiles.${profile}.constraints.${field} must be boolean.`);
	}
	for (const field of ["minimumIdentityConfidence", "highRiskMinimumIdentityConfidence"] as const) {
		assert(value[field] === undefined || (typeof value[field] === "string" && CONFIDENCE_LEVELS.has(value[field] as IdentityConfidence)), `routing-policy.profiles.${profile}.constraints.${field} is unsupported.`);
	}
	assert(value.producerSource === undefined || value.producerSource === "active_main" || value.producerSource === "accepted_manifests", `routing-policy.profiles.${profile}.constraints.producerSource is unsupported.`);
	assert(value.maximumAutomaticFallback === undefined || ["L0", "L1", "L2"].includes(value.maximumAutomaticFallback as string), `routing-policy.profiles.${profile}.constraints.maximumAutomaticFallback must be L0, L1, or L2.`);
	const requiredInputModalities = stringArray(value.requiredInputModalities, `routing-policy.profiles.${profile}.constraints.requiredInputModalities`);
	assert(value.requiredInputModalities === undefined || requiredInputModalities!.length > 0, `routing-policy.profiles.${profile}.constraints.requiredInputModalities must not be empty.`);
	for (const modality of requiredInputModalities ?? []) {
		assert(INPUT_MODALITIES.has(modality as ModelInputModality), `routing-policy.profiles.${profile}.constraints.requiredInputModalities contains unsupported modality '${modality}'.`);
	}
	return {
		...(stringArray(value.excludeFamilies, `routing-policy.profiles.${profile}.constraints.excludeFamilies`) ? { excludeFamilies: stringArray(value.excludeFamilies, `routing-policy.profiles.${profile}.constraints.excludeFamilies`)! } : {}),
		...(stringArray(value.excludeProviderDomains, `routing-policy.profiles.${profile}.constraints.excludeProviderDomains`) ? { excludeProviderDomains: stringArray(value.excludeProviderDomains, `routing-policy.profiles.${profile}.constraints.excludeProviderDomains`)! } : {}),
		...(value.requireCrossFamilyFromProducers !== undefined ? { requireCrossFamilyFromProducers: value.requireCrossFamilyFromProducers as boolean } : {}),
		...(value.requireProviderDomainSeparation !== undefined ? { requireProviderDomainSeparation: value.requireProviderDomainSeparation as boolean } : {}),
		...(value.allowAutomaticMax !== undefined ? { allowAutomaticMax: value.allowAutomaticMax as boolean } : {}),
		...(value.producerSource !== undefined ? { producerSource: value.producerSource as "active_main" | "accepted_manifests" } : {}),
		...(value.minimumIdentityConfidence !== undefined ? { minimumIdentityConfidence: value.minimumIdentityConfidence as IdentityConfidence } : {}),
		...(value.highRiskMinimumIdentityConfidence !== undefined ? { highRiskMinimumIdentityConfidence: value.highRiskMinimumIdentityConfidence as IdentityConfidence } : {}),
		...(value.maximumAutomaticFallback !== undefined ? { maximumAutomaticFallback: value.maximumAutomaticFallback as "L0" | "L1" | "L2" } : {}),
		...(requiredInputModalities ? { requiredInputModalities: requiredInputModalities as ModelInputModality[] } : {}),
	};
}

function parseBudget(value: unknown, profile: string): RoutingPolicyBudget | undefined {
	if (value === undefined) return undefined;
	assert(isRecord(value), `routing-policy.profiles.${profile}.budget must be an object.`);
	for (const field of ["providerRetries", "modelDegradations"] as const) {
		assert(value[field] === undefined || (Number.isInteger(value[field]) && (value[field] as number) >= 0 && (value[field] as number) <= 10), `routing-policy.profiles.${profile}.budget.${field} must be 0..10.`);
	}
	return {
		...(value.providerRetries !== undefined ? { providerRetries: value.providerRetries as number } : {}),
		...(value.modelDegradations !== undefined ? { modelDegradations: value.modelDegradations as number } : {}),
	};
}

function parseProfile(value: unknown, name: string): RoutingProfile {
	assert(isRecord(value) && Array.isArray(value.candidates) && value.candidates.length > 0, `routing-policy.profiles.${name}.candidates must be a non-empty array.`);
	assert(value.enforcement === undefined || (typeof value.enforcement === "string" && ENFORCEMENT.has(value.enforcement as RoutingEnforcement)), `routing-policy.profiles.${name}.enforcement is unsupported.`);
	return {
		candidates: value.candidates.map((candidate, index) => parseCandidate(candidate, name, index)),
		...(parseConstraints(value.constraints, name) ? { constraints: parseConstraints(value.constraints, name) } : {}),
		...(parseBudget(value.budget, name) ? { budget: parseBudget(value.budget, name) } : {}),
		...(value.enforcement !== undefined ? { enforcement: value.enforcement as RoutingEnforcement } : {}),
	};
}

export function validateRoutingPolicy(value: unknown): RoutingPolicy {
	assert(isRecord(value) && value.schemaVersion === 1 && isRecord(value.profiles), "routing-policy.json must be schemaVersion 1 with a profiles object.");
	assert(value.enforcement === undefined || (typeof value.enforcement === "string" && ENFORCEMENT.has(value.enforcement as RoutingEnforcement)), "routing-policy.enforcement is unsupported.");
	const quarantinedProviderDomains = stringArray(value.quarantinedProviderDomains, "routing-policy.quarantinedProviderDomains");
	const profiles = Object.fromEntries(Object.entries(value.profiles).map(([name, profile]) => [nonEmptyString(name, "routing-policy profile name"), parseProfile(profile, name)]));
	assert(Object.keys(profiles).length > 0, "routing-policy.profiles must not be empty.");
	let planningReviewProfiles: RoutingPolicy["planningReviewProfiles"];
	let planningProfiles: RoutingPolicy["planningProfiles"];
	if (value.planningProfiles !== undefined) {
		assert(isRecord(value.planningProfiles), "routing-policy.planningProfiles must be an object.");
		const planningConfig = value.planningProfiles;
		const expected = ["tactical", "strategic", "strategicHighRisk"] as const;
		for (const field of Object.keys(planningConfig)) assert((expected as readonly string[]).includes(field), `routing-policy.planningProfiles contains unknown field '${field}'.`);
		planningProfiles = Object.fromEntries(expected.map((field) => {
			const profile = nonEmptyString(planningConfig[field], `routing-policy.planningProfiles.${field}`);
			assert(Boolean(profiles[profile]), `routing-policy.planningProfiles.${field} references unknown profile '${profile}'.`);
			const bound = profiles[profile]!;
			assert(bound.enforcement === "require", `routing-policy.planningProfiles.${field} profile '${profile}' must use enforcement 'require'.`);
			assert(bound.candidates.length === 1 && (bound.candidates[0]!.level ?? "L0") === "L0", `routing-policy.planningProfiles.${field} profile '${profile}' must contain exactly one L0 candidate.`);
			assert(bound.budget?.modelDegradations === 0, `routing-policy.planningProfiles.${field} profile '${profile}' must set budget.modelDegradations to 0.`);
			return [field, profile];
		})) as NonNullable<RoutingPolicy["planningProfiles"]>;
	}
	if (value.planningReviewProfiles !== undefined) {
		assert(isRecord(value.planningReviewProfiles), "routing-policy.planningReviewProfiles must be an object.");
		const reviewConfig = value.planningReviewProfiles;
		for (const field of Object.keys(reviewConfig)) assert(["byPlannerProviderDomain", "byPlannerModelFamily", "defaultProfile"].includes(field), `routing-policy.planningReviewProfiles contains unknown field '${field}'.`);
		const profileMap = (candidate: unknown, label: string): Record<string, string> | undefined => {
			if (candidate === undefined) return undefined;
			assert(isRecord(candidate), `${label} must be an object.`);
			return Object.fromEntries(Object.entries(candidate).map(([key, profile]) => {
				const normalizedKey = nonEmptyString(key, `${label} key`);
				const normalizedProfile = nonEmptyString(profile, `${label}.${normalizedKey}`);
				assert(Boolean(profiles[normalizedProfile]), `${label}.${normalizedKey} references unknown profile '${normalizedProfile}'.`);
				return [normalizedKey, normalizedProfile];
			}));
		};
		const byPlannerProviderDomain = profileMap(reviewConfig.byPlannerProviderDomain, "routing-policy.planningReviewProfiles.byPlannerProviderDomain");
		const byPlannerModelFamily = profileMap(reviewConfig.byPlannerModelFamily, "routing-policy.planningReviewProfiles.byPlannerModelFamily");
		const defaultProfile = reviewConfig.defaultProfile === undefined ? undefined : nonEmptyString(reviewConfig.defaultProfile, "routing-policy.planningReviewProfiles.defaultProfile");
		if (defaultProfile) assert(Boolean(profiles[defaultProfile]), `routing-policy.planningReviewProfiles.defaultProfile references unknown profile '${defaultProfile}'.`);
		assert(Boolean(defaultProfile || Object.keys(byPlannerProviderDomain ?? {}).length || Object.keys(byPlannerModelFamily ?? {}).length), "routing-policy.planningReviewProfiles must contain at least one mapping or a defaultProfile.");
		planningReviewProfiles = {
			...(byPlannerProviderDomain ? { byPlannerProviderDomain } : {}),
			...(byPlannerModelFamily ? { byPlannerModelFamily } : {}),
			...(defaultProfile ? { defaultProfile } : {}),
		};
	}
	let agentProfiles: Record<string, string> | undefined;
	let maxAuthorizationIssuers: Record<string, Record<string, string>> | undefined;
	if (value.agentProfiles !== undefined) {
		assert(isRecord(value.agentProfiles), "routing-policy.agentProfiles must be an object.");
		agentProfiles = Object.fromEntries(Object.entries(value.agentProfiles).map(([agent, profile]) => {
			const normalizedAgent = nonEmptyString(agent, "routing-policy agent name");
			const normalizedProfile = nonEmptyString(profile, `routing-policy.agentProfiles.${agent}`);
			assert(Boolean(profiles[normalizedProfile]), `routing-policy.agentProfiles.${agent} references unknown profile '${normalizedProfile}'.`);
			return [normalizedAgent, normalizedProfile];
		}));
	}
	if (value.maxAuthorizationIssuers !== undefined) {
		assert(isRecord(value.maxAuthorizationIssuers), "routing-policy.maxAuthorizationIssuers must be an object.");
		maxAuthorizationIssuers = Object.fromEntries(Object.entries(value.maxAuthorizationIssuers).map(([issuer, keys]) => {
			const normalizedIssuer = nonEmptyString(issuer, "routing-policy max authorization issuer");
			assert(isRecord(keys), `routing-policy.maxAuthorizationIssuers.${issuer} must be an object.`);
			const normalizedKeys = Object.fromEntries(Object.entries(keys).map(([keyId, publicKey]) => [
				nonEmptyString(keyId, `routing-policy.maxAuthorizationIssuers.${issuer} key id`),
				nonEmptyString(publicKey, `routing-policy.maxAuthorizationIssuers.${issuer}.${keyId}`),
			]));
			assert(Object.keys(normalizedKeys).length > 0, `routing-policy.maxAuthorizationIssuers.${issuer} must contain at least one public key.`);
			return [normalizedIssuer, normalizedKeys];
		}));
	}
	return {
		schemaVersion: 1,
		profiles,
		...(value.enforcement !== undefined ? { enforcement: value.enforcement as RoutingEnforcement } : {}),
		...(quarantinedProviderDomains ? { quarantinedProviderDomains } : {}),
		...(planningReviewProfiles ? { planningReviewProfiles } : {}),
		...(planningProfiles ? { planningProfiles } : {}),
		...(agentProfiles ? { agentProfiles } : {}),
		...(maxAuthorizationIssuers ? { maxAuthorizationIssuers } : {}),
	};
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function loadModelRoutingConfig(input: ModelRoutingConfigInput = {}): Promise<ModelRoutingConfig> {
	const agentDir = resolve(input.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const registryPath = resolve(input.registryPath ?? join(agentDir, "model-registry.json"));
	const policyPath = resolve(input.policyPath ?? join(agentDir, "routing-policy.json"));
	let rawRegistry: unknown = input.registry;
	let rawPolicy: unknown = input.policy;
	try {
		if (rawRegistry === undefined) rawRegistry = JSON.parse(await readFile(registryPath, "utf8"));
		if (rawPolicy === undefined) rawPolicy = JSON.parse(await readFile(policyPath, "utf8"));
	} catch (error) {
		throw new ModelRoutingConfigError(`Model routing configuration could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
	}
	const registry = validateModelRegistry(rawRegistry);
	const policy = validateRoutingPolicy(rawPolicy);
	const knownModels = new Set(registry.models.flatMap((entry) => [entry.model, ...(entry.aliases ?? [])]));
	for (const [profileName, profile] of Object.entries(policy.profiles)) {
		for (const [index, candidate] of profile.candidates.entries()) {
			assert(knownModels.has(candidate.model), `routing-policy.profiles.${profileName}.candidates[${index}] references unknown model '${candidate.model}'.`);
			const entry = registry.models.find((model) => model.model === candidate.model || model.aliases?.includes(candidate.model));
			assert(!candidate.thinking || !entry?.thinkingLevels || entry.thinkingLevels.includes(candidate.thinking), `routing-policy.profiles.${profileName}.candidates[${index}] uses unsupported thinking '${candidate.thinking}'.`);
			for (const modality of profile.constraints?.requiredInputModalities ?? []) {
				assert(entry?.inputModalities?.includes(modality), `routing-policy.profiles.${profileName}.candidates[${index}] model '${candidate.model}' does not declare required input modality '${modality}'.`);
			}
		}
	}
	return {
		registry,
		policy,
		configDigest: digest({ registry, policy }),
		...(input.registry === undefined ? { registryPath } : {}),
		...(input.policy === undefined ? { policyPath } : {}),
	};
}
