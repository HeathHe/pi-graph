import {MAX_MODEL_CANDIDATES,MAX_MODEL_DEGRADATIONS,modelIdentityFields,validateLatestIdentity,validateLatestModelPolicy,type LatestModelIdentity,modelFamilyId,validateModelCapabilities,validateModelRequirements,candidateMeetsRequirements,type ModelCapabilities} from '../src/runtime/model-capabilities.ts';
import {readCustomGraphModels} from "../src/runtime/custom-models.ts";
import {readRoleModelOverride} from "../src/runtime/settings.ts";
import { classifyProviderFailure } from "../src/v3/failure-policy.ts";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	bindGraphNodesV3,
	bindGraphSpecV3,
	v3PreflightAgentLaunch,
	type V3BindingOptions,
	type V3BoundGraphSpec,
	type V3CapabilityCatalogReadOptions,
	type V3PreflightParentModel,
} from "../src/v3/index.ts";
import { readLatestV3Attempt, verifyV3AcceptedAttemptChain } from "../src/v3/attempt.ts";
import { canonicalDigest } from "../src/v3/digests.ts";
import { GraphV3Error } from "../src/v3/errors.ts";
import type { CompiledGraphV3, GraphNodeAuthoringSpecV3, GraphNodeSpecV3, GraphSpecAuthoringV3 } from "../src/v3/types.ts";

const MAX_POLICY_BYTES = 1_048_576;
const ROUTING_ENFORCEMENT = "graph-admission";
const JEV_CHOICES = ["fast", "deep", "research", "review", "human"] as const;

type JevChoice = typeof JEV_CHOICES[number];

interface RoutingCandidate extends Partial<LatestModelIdentity> {
	model: string;
	thinking?: string;
	level: string;
 capabilities?:ModelCapabilities;
}

interface RoutingPolicySnapshot { policy?: RoutingPolicy; catalog?: CapabilityRouteCatalog; policyDigest?: string; catalogDigest?: string; }

interface RoutingProfile {
 candidatePool?:"all-compatible";
 latestPolicy?:"latest-per-tier";approvedLatestIds?:string[];
	enforcement?: string;
	candidates: RoutingCandidate[];
	modelDegradations: number;
	constraints?: {
		requiredInputModalities?:("text"|"image")[];
  requireToolCalls?:boolean;
  maximumAutomaticFallback?:string;
  requireCrossFamilyFromProducers?: boolean;
		producerSource?: "active_main" | "accepted_manifests";
	};
}

interface JevShadowConfig {
	enabled: boolean;
	endpoint: string;
	model: "jev-latest";
	timeoutMs: number;
	credential: { provider: string; env?: string };
	choices: JevChoice[];
}

interface RoutingPolicy {
	schemaVersion: 1;
	enforcement: typeof ROUTING_ENFORCEMENT;
	quarantinedProviderDomains: string[];
	profiles: Record<string, RoutingProfile>;
	jevShadow?: JevShadowConfig;
}

interface CapabilityRouteEntry {
	capabilityId: string;
	agent: string;
	routingProfile: string;
}

interface CapabilityRouteCatalog {
	entries: CapabilityRouteEntry[];
	digest: string;
}

/** First-preflight identity for a same-batch exact-Agent producer used by routing. */
interface FixedProducerAdmissionIdentityV3 {
	taskId: string;
	agent: string;
	agentDefinitionDigest: string;
	requestedModelForBinding: string;
	resolvedModel: string;
}

export interface TrustedProducerModelV3 {
	model: string;
	source: "accepted-attempt-actual" | "accepted-frozen-resolved";
	attempt: number;
}

export interface RoutingAdmissionDecisionV3 {
	taskId: string;
	capabilityIds: string[];
	/** Existing catalog profile inferred without adding authoring capabilities. */
	inferredFromExactRole?: true;
	agent: string;
	profile: string;
	selectedModel: string;
	resolvedModel?: string;
	thinking?: string;
	level: string;
	skipped: Array<{ model: string; reason: string }>;
	latestModelSelection?: import("../src/v3/types.ts").V3LatestModelSelection;
	runtimeFallback?: import("../src/v3/types.ts").V3RuntimeFallbackPlan;
	/** Preserve ordinary constraints even when no multi-candidate plan was formed. */
}

export type JevShadowObservationV3 =
	| { status: "disabled"; reason: "policy_disabled" | "credential_unavailable" | "test_network_disabled" }
	| { status: "error"; reason: string }
	| {
		status: "observed";
		requestedModel: "jev-latest";
		actualModel: string;
		choice: JevChoice;
		confidence?: number;
	};

export interface RoutingAdmissionReceiptV3 {
	schemaVersion: 1;
	mode: typeof ROUTING_ENFORCEMENT | "fixed";
	policyDigest?: string;
	catalogDigest?: string;
	/** Provenance only; never a capability Binding grant. */
	inferredCatalogDigest?: string;
	decisions: RoutingAdmissionDecisionV3[];
	/** Historical receipt fields; new admission never adds automatic parent fallback. */
	parentFallback?: Array<{ taskId: string; model: string; status: "admitted" | "skipped"; reason: string }>;
	parentFallbackPolicyDigest?: string;
	parentFallbackCatalogDigest?: string;
	jevShadow: JevShadowObservationV3;
}

export interface RoutingAdmissionOptionsV3 extends V3BindingOptions {
	/** Trusted Pi getThinkingLevel() captured with the current parent model. */
	/** Legacy input accepted for compatibility; never adds or alters fallback candidates. */
	parentThinking?: string;
	routingPolicyPath?: string;
	modelsPath?: string;
	environment?: NodeJS.ProcessEnv;
	fetchFn?: typeof fetch;
	disableNetwork?: boolean;
	/** Pi owns command/env/auth resolution; Graph never sends raw models.json references. */
	getApiKeyForProvider?: ModelRegistry["getApiKeyForProvider"];
	/** Extension-owned evidence for dependencies already accepted by this Graph. */
	trustedProducerModels?: Readonly<Record<string, TrustedProducerModelV3>>;
	/** Lazy extension-owned resolver so unrelated append dependencies are not inspected. */
	resolveTrustedProducerModel?: (taskId: string) => Promise<TrustedProducerModelV3 | undefined>;
}

export interface RoutedBoundGraphSpecV3 extends V3BoundGraphSpec {
	routingAdmission: RoutingAdmissionReceiptV3;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, details: Record<string, unknown> = {}): never {
	throw new GraphV3Error("CAPABILITY_BINDING_FAILED", message, { details });
}

function nonEmpty(value: unknown, field: string, max = 500): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) fail(`${field} must be a non-empty string of at most ${max} characters.`, { field });
	return value.trim();
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

async function readStableJson(pathValue: string, label: string): Promise<unknown> {
	const path = resolve(pathValue);
	let handle;
	try {
		const before = await lstat(path);
		if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_POLICY_BYTES) {
			fail(`${label} must be one regular non-symbolic-link file no larger than ${MAX_POLICY_BYTES} bytes.`, { path });
		}
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail(`${label} changed while it was opened.`, { path });
		const bytes = await handle.readFile();
		const [finished, current] = await Promise.all([handle.stat(), lstat(path)]);
		if (finished.dev !== opened.dev || finished.ino !== opened.ino || current.dev !== opened.dev || current.ino !== opened.ino
			|| finished.size !== opened.size || current.size !== opened.size || finished.mtimeMs !== opened.mtimeMs || current.mtimeMs !== opened.mtimeMs) {
			fail(`${label} changed while it was read.`, { path });
		}
		let decoded: string;
		try {
			decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			fail(`${label} must be valid UTF-8.`, { path, cause: error instanceof Error ? error.message : String(error) });
		}
		try {
			return JSON.parse(decoded) as unknown;
		} catch (error) {
			fail(`${label} must be valid JSON.`, { path, cause: error instanceof Error ? error.message : String(error) });
		}
	} catch (error) {
		if (error instanceof GraphV3Error) throw error;
		fail(`Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`, { path });
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function validatePolicy(value: unknown): RoutingPolicy {
	if (!isRecord(value) || value.schemaVersion !== 1) fail("routing-policy.json requires schemaVersion: 1.");
	if (value.enforcement !== ROUTING_ENFORCEMENT) fail(`routing-policy.json enforcement must be '${ROUTING_ENFORCEMENT}'.`, { enforcement: value.enforcement });
	if (!Array.isArray(value.quarantinedProviderDomains) || value.quarantinedProviderDomains.some((entry) => typeof entry !== "string" || !entry.trim())) fail("quarantinedProviderDomains must be a string array.");
	if (!isRecord(value.profiles)) fail("routing-policy.json profiles must be an object.");
	const profiles: Record<string, RoutingProfile> = {};
	for (const [name, raw] of Object.entries(value.profiles)) {
		if (!isRecord(raw) || !Array.isArray(raw.candidates) || raw.candidates.length === 0) fail(`Routing profile '${name}' requires at least one candidate.`);
  if(raw.candidates.length>MAX_MODEL_CANDIDATES)fail(`Routing profile '${name}' exceeds candidate limit.`);
  if(raw.candidatePool!==undefined&&raw.candidatePool!=='all-compatible')fail('Invalid candidate pool mode');
		const candidates = raw.candidates.map((candidate, index) => {
			if (!isRecord(candidate)) fail(`Routing profile '${name}' candidate ${index} must be an object.`);
   validateLatestIdentity(candidate,raw.latestPolicy!==undefined);
   if(candidate.capabilities!==undefined)validateModelCapabilities(candidate.capabilities);
			return {
    ...modelIdentityFields(candidate),
    ...(candidate.capabilities===undefined?{}:{capabilities:structuredClone(candidate.capabilities)}),
				model: nonEmpty(candidate.model, `${name}.candidates[${index}].model`),
				...(candidate.thinking === undefined ? {} : { thinking: nonEmpty(candidate.thinking, `${name}.candidates[${index}].thinking`, 100) }),
				level: nonEmpty(candidate.level, `${name}.candidates[${index}].level`, 100),
			};
		});
		validateLatestModelPolicy(raw,candidates);
  if (new Set(candidates.map((candidate) => candidate.model)).size !== candidates.length) fail(`Routing profile '${name}' contains duplicate models.`);
		let constraints: RoutingProfile["constraints"];
		if (raw.constraints !== undefined) {
			if (!isRecord(raw.constraints)) fail(`Routing profile '${name}' constraints must be an object.`);
			validateModelRequirements(raw.constraints);
   const producerSource = raw.constraints.producerSource;
			if (producerSource !== undefined && producerSource !== "active_main" && producerSource !== "accepted_manifests") fail(`Routing profile '${name}' has unsupported producerSource.`);
			constraints = {
    ...(raw.constraints.requiredInputModalities===undefined?{}:{requiredInputModalities:raw.constraints.requiredInputModalities as ("text"|"image")[]}),
    ...(raw.constraints.requireToolCalls===undefined?{}:{requireToolCalls:raw.constraints.requireToolCalls as boolean}),
    ...(raw.constraints.maximumAutomaticFallback===undefined?{}:{maximumAutomaticFallback:raw.constraints.maximumAutomaticFallback as string}),
				...(raw.constraints.requireCrossFamilyFromProducers === true ? { requireCrossFamilyFromProducers: true } : {}),
				...(producerSource === undefined ? {} : { producerSource }),
			};
		}
		const degradations = isRecord(raw.budget) ? raw.budget.modelDegradations : 0;
		if (!Number.isSafeInteger(degradations) || (degradations as number) < 0 || (degradations as number) > MAX_MODEL_DEGRADATIONS) fail(`Routing profile '${name}' has invalid modelDegradations budget.`);
		profiles[name] = { ...(raw.latestPolicy==="latest-per-tier"?{latestPolicy:"latest-per-tier" as const,approvedLatestIds:[...(raw.approvedLatestIds as string[])]}:{}), ...(raw.candidatePool==="all-compatible"?{candidatePool:"all-compatible" as const}:{}), modelDegradations: degradations as number, ...(typeof raw.enforcement === "string" ? { enforcement: raw.enforcement } : {}), candidates, ...(constraints ? { constraints } : {}) };
	}
	let jevShadow: JevShadowConfig | undefined;
	if (value.jevShadow !== undefined) {
		const raw = value.jevShadow;
		if (!isRecord(raw) || typeof raw.enabled !== "boolean" || raw.model !== "jev-latest") fail("jevShadow must declare enabled and model 'jev-latest'.");
		const endpoint = nonEmpty(raw.endpoint, "jevShadow.endpoint", 2_000);
		const url = new URL(endpoint);
		if (url.protocol !== "https:" || url.pathname !== "/v1/systemone") fail("jevShadow.endpoint must be an HTTPS /v1/systemone URL.");
		if (!Number.isSafeInteger(raw.timeoutMs) || (raw.timeoutMs as number) < 250 || (raw.timeoutMs as number) > 30_000) fail("jevShadow.timeoutMs must be 250..30000.");
		if (!isRecord(raw.credential)) fail("jevShadow.credential must be an object.");
		const provider = nonEmpty(raw.credential.provider, "jevShadow.credential.provider", 200);
		const env = raw.credential.env === undefined ? undefined : nonEmpty(raw.credential.env, "jevShadow.credential.env", 200);
		if (env && !/^[A-Z_][A-Z0-9_]*$/u.test(env)) fail("jevShadow credential env name is invalid.");
		if (!Array.isArray(raw.choices) || raw.choices.length !== JEV_CHOICES.length || raw.choices.some((entry) => !JEV_CHOICES.includes(entry as JevChoice)) || new Set(raw.choices).size !== JEV_CHOICES.length) {
			fail(`jevShadow.choices must be exactly [${JEV_CHOICES.join(", ")}].`);
		}
		jevShadow = { enabled: raw.enabled, endpoint, model: "jev-latest", timeoutMs: raw.timeoutMs as number, credential: { provider, ...(env ? { env } : {}) }, choices: [...JEV_CHOICES] };
	}
	return {
		schemaVersion: 1,
		enforcement: ROUTING_ENFORCEMENT,
		quarantinedProviderDomains: [...new Set(value.quarantinedProviderDomains.map((entry) => (entry as string).trim()))],
		profiles,
		...(jevShadow ? { jevShadow } : {}),
	};
}

function validateCatalog(value: unknown): CapabilityRouteCatalog {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.capabilities) || value.capabilities.length === 0) fail("subagent-capabilities.json requires a non-empty schemaVersion 1 capability list.");
	const entries = value.capabilities.map((entry, index) => {
		if (!isRecord(entry)) fail(`capabilities[${index}] must be an object.`);
		return {
			capabilityId: nonEmpty(entry.capabilityId, `capabilities[${index}].capabilityId`, 200),
			agent: nonEmpty(entry.agent, `capabilities[${index}].agent`, 500),
			routingProfile: nonEmpty(entry.routingProfile, `capabilities[${index}].routingProfile`, 500),
		};
	});
	if (new Set(entries.map((entry) => entry.capabilityId)).size !== entries.length) fail("subagent-capabilities.json contains duplicate capability IDs.");
	return { entries, digest: canonicalDigest(value) };
}

function configuredPaths(options: RoutingAdmissionOptionsV3): { agentDir: string; policyPath: string; catalogPath: string; modelsPath: string } {
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	return {
		agentDir,
		policyPath: resolve(options.routingPolicyPath ?? join(agentDir, "routing-policy.json")),
		catalogPath: resolve(options.path ?? join(agentDir, "subagent-capabilities.json")),
		modelsPath: resolve(options.modelsPath ?? join(agentDir, "models.json")),
	};
}

function capabilityIds(node: Record<string, unknown>): string[] {
	const ids = [typeof node.capabilityId === "string" ? node.capabilityId.trim() : ""];
	if (Array.isArray(node.requires)) ids.push(...node.requires.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()));
	return [...new Set(ids.filter(Boolean))].sort();
}

function modelFamily(model: string): string { return modelFamilyId(model); }

function parentFullModel(parent: V3PreflightParentModel | undefined): string | undefined {
	return parent ? `${parent.provider}/${parent.id}` : undefined;
}

function briefReason(message: string): string {
	return message.replace(/\s+/gu, " ").slice(0, 500);
}

async function routeAuthoringNodes(
	nodesValue: unknown,
	policy: RoutingPolicy,
	catalog: CapabilityRouteCatalog,
	options: RoutingAdmissionOptionsV3,
): Promise<{
	nodes: GraphNodeAuthoringSpecV3[];
	decisions: RoutingAdmissionDecisionV3[];
	fixedProducerIdentities: FixedProducerAdmissionIdentityV3[];
}> {
	if (!Array.isArray(nodesValue)) fail("Graph authoring nodes must be an array.");
	const nodes = cloneJson(nodesValue) as Array<Record<string, unknown>>;
	const byCapability = new Map(catalog.entries.map((entry) => [entry.capabilityId, entry]));
	const byTask = new Map(nodes.map((node) => [typeof node.taskId === "string" ? node.taskId : "", node]));
	const decisions = new Map<string, RoutingAdmissionDecisionV3>();
	const resolving = new Set<string>();
	const fixedProducerIdentities = new Map<string, Promise<FixedProducerAdmissionIdentityV3>>();
	const preflight = options.preflightAgent ?? v3PreflightAgentLaunch;
	const normalizedThinking = (node: Record<string, unknown>): string | false | undefined => {
		if (node.thinking === undefined) return undefined;
		if (node.thinking === false) return false;
		return nonEmpty(node.thinking, `${String(node.taskId)}.thinking`, 100);
	};
	const preflightInput = (node: Record<string, unknown>, agent: string, model?: string, thinking = normalizedThinking(node)) => ({
		agent,
		task: nonEmpty(node.task, `${String(node.taskId)}.task`, 100_000),
		cwd: resolve(options.cwd ?? process.cwd()),
		agentScope: "both" as const,
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(node.turnBudget === undefined ? {} : { turnBudget: node.turnBudget as GraphNodeAuthoringSpecV3["turnBudget"] }),
		...(options.parentToolAllowlist === undefined ? {} : { parentToolAllowlist: [...options.parentToolAllowlist], graphToolFilter: options.graphToolFilter === undefined ? undefined : [...options.graphToolFilter] }),
		...(options.parentModel === undefined ? {} : { parentModel: options.parentModel }),
		...(options.availableModels === undefined ? {} : { availableModels: options.availableModels }),
		...(options.preferredProvider === undefined ? {} : { preferredProvider: options.preferredProvider }),
	});
	const fixedProducerIdentity = (node: Record<string, unknown>): Promise<FixedProducerAdmissionIdentityV3> => {
		const taskId = nonEmpty(node.taskId, "taskId", 200);
		const cached = fixedProducerIdentities.get(taskId);
		if (cached) return cached;
		const pending = (async () => {
			const agent = nonEmpty(node.agent, `${taskId}.agent`, 500);
			const requestedModel = node.model === undefined ? undefined : nonEmpty(node.model, `${taskId}.model`);
			const result = await preflight(preflightInput(node, agent, requestedModel));
			if (!result.ok) fail(`Producer node '${taskId}' failed Pi launch preflight: ${result.message}`, { taskId, agent });
			if (result.name !== agent) fail(`Producer node '${taskId}' resolved ambiguously to Agent '${result.name}'.`, { taskId, requestedAgent: agent, resolvedAgent: result.name });
			if (!result.model) fail(`Producer node '${taskId}' has no preflight-resolved model identity required by cross-family routing.`, { taskId, agent });
			// Freeze an implicit producer model into the authoring node so Binding must
			// emit durable launch evidence. Final alignment below still compares the
			// second preflight with this first routing preflight and fails on drift.
			if (requestedModel === undefined) node.model = result.model;
			return {
				taskId,
				agent,
				agentDefinitionDigest: result.agentDefinitionDigest,
				requestedModelForBinding: requestedModel ?? result.model,
				resolvedModel: result.model,
			};
		})();
		fixedProducerIdentities.set(taskId, pending);
		return pending;
	};

	const routeOne = async (node: Record<string, unknown>): Promise<RoutingAdmissionDecisionV3 | undefined> => {
		const taskId = nonEmpty(node.taskId, "taskId", 200);
		if (decisions.has(taskId)) return decisions.get(taskId);
		const ids = capabilityIds(node);
		const inferred = ids.length === 0;
  if (inferred && typeof node.agent !== "string") return undefined;
  const inferredEntries = inferred ? catalog.entries.filter(entry=>entry.agent===node.agent) : [];
  if (inferred && (inferredEntries.length===0 || new Set(inferredEntries.map(entry=>entry.routingProfile)).size!==1)) return undefined;
		if (resolving.has(taskId)) fail(`Routing dependency cycle detected at '${taskId}'.`, { taskId });
		resolving.add(taskId);
		try {
			const entries = inferred ? inferredEntries : ids.map((id) => byCapability.get(id) ?? fail(`Capability '${id}' has no routing catalog entry.`, { taskId, capabilityId: id }));
			const agents = [...new Set(entries.map((entry) => entry.agent))];
			const profiles = [...new Set(entries.map((entry) => entry.routingProfile))];
			if (agents.length !== 1 || profiles.length !== 1) fail(`Node '${taskId}' capabilities must resolve to one Agent and one routing profile.`, { taskId, agents, profiles });
			if (node.agent !== undefined && node.agent !== agents[0]) fail(`Node '${taskId}' explicit Agent conflicts with routing catalog.`, { taskId, requestedAgent: node.agent, routedAgent: agents[0] });
			const profileName = profiles[0]!;
			if (inferred && !policy.profiles[profileName]) return undefined;
			let profile = policy.profiles[profileName] ?? fail(`Routing profile '${profileName}' is missing.`, { taskId, profile: profileName });
   const override = capturedRoleOverride(agents[0]!,options);
   const authorModel=typeof node.model==='string'?node.model:undefined;
   const configuredPrimary=override?.model??profile.candidates[0]!.model;
   const guidance=`Remove stale explicit model/thinking fields and resubmit only remaining work using the current role/profile configuration; do not replay completed tools.`;
   const policyContext=`task='${taskId}', role='${agents[0]}', profile='${profileName}', configured primary='${configuredPrimary}', allowed=[${profile.candidates.slice(0,8).map(c=>c.model).join(', ')}${profile.candidates.length>8?', ...':''}]`;
   if(profile.latestPolicy&&authorModel&&(!profile.approvedLatestIds?.includes(authorModel)||!profile.candidates.some(c=>c.model===authorModel)))fail(`Explicit requested model '${authorModel}' is not approved (${policyContext}; reason=author_model_not_approved). ${guidance}`,{taskId,agent:agents[0],profile:profileName,requestedModel:authorModel,reason:'author_model_not_approved'});
   if(inferred&&override&&profile.candidatePool!=='all-compatible')return undefined;
   if (override) {
    const models=[...new Set([configuredPrimary,...(override.fallbackModels??profile.candidates.map(c=>c.model).filter(m=>m!==configuredPrimary))])];
    if(profile.latestPolicy&&models.some(m=>!profile.approvedLatestIds?.includes(m)))fail(`Override model is not an approved latest candidate (${policyContext}; reason=author_override_not_approved). ${guidance}`,{taskId});
    if(models.length>MAX_MODEL_CANDIDATES)fail('Role model chain exceeds 63 permitted replacements.');
    profile={...profile,candidates:models.map((model,index)=>{const original=profile.candidates.find(c=>c.model===model);return {...original,model,thinking:override.thinking??original?.thinking,level:original?.level??`settings-${index}`};}),modelDegradations:profile.latestPolicy&&profile.modelDegradations===0?0:override.fallbackModels===undefined?profile.modelDegradations:Math.max(0,models.length-1)};
   }
   let implicitFailure:Extract<Awaited<ReturnType<typeof preflight>>,{ok:false}>|undefined;
   if (inferred) {
    const baseline=await preflight(preflightInput(node,agents[0]!,authorModel));
    if(!baseline.ok){
     const classification=classifyProviderFailure(baseline.message);
     const failureGuidance=!classification.eligible?'Fix the original Agent configuration, working directory, or tool permissions before resubmitting; model fallback cannot repair this error.':'Resolve the reported model/provider configuration or availability error before resubmitting; no automatic replacement was authorized.';
     const identityMatches=baseline.attemptedModel===profile.candidates[0]?.model&&baseline.attemptedAgent===agents[0]&&typeof baseline.attemptedAgentDefinitionDigest==='string'&&/^[a-f0-9]{64}$/.test(baseline.attemptedAgentDefinitionDigest);
     if(profile.latestPolicy&&!authorModel&&profile.candidatePool==='all-compatible'&&classification.eligible&&identityMatches&&profile.modelDegradations>0&&profile.candidates.length>1){implicitFailure=baseline;}
     else if(profile.latestPolicy)fail(`Primary preflight failed (${policyContext}; attempted='${baseline.attemptedModel??'unknown'}'; reason=${authorModel?'explicit_model_failure':!classification.eligible?classification.kind:!identityMatches?'failed_identity_not_approved_primary':'fallback_disabled'}): ${briefReason(baseline.message)}. ${failureGuidance}`,{taskId,agent:agents[0],profile:profileName,classification});
     else return undefined;
    } else {
     if(baseline.name!==agents[0]){if(profile.latestPolicy)fail(`Primary preflight resolved Agent '${baseline.name}' instead of '${agents[0]}' (${policyContext}; reason=agent_identity_mismatch).`);return undefined;}
     if(!baseline.model){if(profile.latestPolicy)fail(`Primary preflight is missing resolved model (${policyContext}; reason=missing_model_identity).`);return undefined;}
     const primary=authorModel??baseline.model.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/,'');
     const first=profile.candidates.find(candidate=>candidate.model===primary);
     const thinking=normalizedThinking(node)===false?'off':normalizedThinking(node)??baseline.thinking;
     if(!first){if(profile.candidatePool==='all-compatible')fail(`Resolved model '${primary}' has no approved capability evidence (${policyContext}; reason=resolved_model_not_approved). ${guidance}`,{taskId});return undefined;}
     if(profile.candidatePool!=='all-compatible'&&first.thinking!==undefined&&thinking!==undefined&&first.thinking!==thinking)return undefined;
     node.model=primary;
     if(node.thinking===undefined&&baseline.thinking!==undefined)node.thinking=baseline.thinking;
    }
    if(profile.constraints?.requireCrossFamilyFromProducers&&(profile.constraints.producerSource==='active_main'?!options.parentModel:!Array.isArray(node.dependsOn)||node.dependsOn.length===0))return undefined;
   }

			const producerModels: string[] = [];
			if (profile.constraints?.requireCrossFamilyFromProducers) {
				if (profile.constraints.producerSource === "active_main") {
					const parent = parentFullModel(options.parentModel);
					if (!parent) fail(`Routing profile '${profileName}' requires the active parent model identity.`, { taskId });
					producerModels.push(parent);
				} else {
					const dependencyIds = Array.isArray(node.dependsOn)
						? node.dependsOn.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
						: [];
					if (dependencyIds.length === 0) fail(`Routing profile '${profileName}' requires at least one producer dependency with trusted model identity.`, { taskId });
					for (const dependencyId of dependencyIds) {
						const dependency = byTask.get(dependencyId);
						let model: string | undefined;
						if (dependency) {
							const routed = await routeOne(dependency);
							model = routed ? routed.resolvedModel : (await fixedProducerIdentity(dependency)).resolvedModel;
						} else {
							model = options.trustedProducerModels?.[dependencyId]?.model
								?? (await options.resolveTrustedProducerModel?.(dependencyId))?.model;
						}
						if (!model) fail(`Node '${taskId}' lacks trusted producer model identity for dependency '${dependencyId}'.`, { taskId, dependencyId, profile: profileName });
						producerModels.push(model);
					}
				}
			}
			const producerFamilies = new Set(producerModels.map(modelFamily));
			const explicitModel = node.model === undefined ? undefined : nonEmpty(node.model, `${taskId}.model`);
			const explicitThinking = node.thinking === false ? "off" : node.thinking === undefined ? undefined : nonEmpty(node.thinking, `${taskId}.thinking`, 100);
			const configuredModels = new Set(profile.candidates.map((candidate) => candidate.model));
			if (explicitModel && !configuredModels.has(explicitModel)) fail(`Node '${taskId}' explicit model is outside routing profile '${profileName}'.`, { taskId, requestedModel: explicitModel, candidates: [...configuredModels] });
			const skipped: Array<{ model: string; reason: string }> = implicitFailure?[{model:implicitFailure.attemptedModel!,reason:briefReason(implicitFailure.message)}]:[];
			const ordered = implicitFailure?profile.candidates.slice(1,profile.modelDegradations+1):explicitModel ? profile.candidates.filter((candidate) => candidate.model === explicitModel) : profile.candidates;
			for (const candidate of ordered) {
				const provider = candidate.model.includes("/") ? candidate.model.slice(0, candidate.model.indexOf("/")) : "";
				if (policy.quarantinedProviderDomains.includes(provider)) {
					skipped.push({ model: candidate.model, reason: "provider_quarantined" });
					continue;
				}
				if (producerFamilies.has(modelFamily(candidate.model))) {
					skipped.push({ model: candidate.model, reason: "producer_family_conflict" });
					continue;
				}
				if (explicitThinking !== undefined && candidate.thinking !== undefined && explicitThinking !== candidate.thinking) {
					fail(`Node '${taskId}' explicit thinking conflicts with routing profile '${profileName}'.`, { taskId, requestedThinking: explicitThinking, routedThinking: candidate.thinking });
				}
                const candidateMetadata=options.availableModels?.find(m=>(m.fullId??`${m.provider}/${m.id}`)===candidate.model);
                if(!candidateMeetsRequirements(candidate,profile.constraints,candidateMetadata)||(profile.candidatePool==='all-compatible'&&!candidate.capabilities?.tools)){
                    skipped.push({model:candidate.model,reason:'capability_requirements_not_met'});continue;
                }
				const result = await preflight(preflightInput(node, agents[0]!, candidate.model, candidate.thinking ?? normalizedThinking(node)));
				if (!result.ok) {
					if (!classifyProviderFailure(result.message).eligible) fail(`Routing preflight failed without eligible provider evidence (${policyContext}; model='${candidate.model}'; reason=non_provider): ${briefReason(result.message)}. Fix the original configuration/path/permissions before resubmitting.`, {taskId, model:candidate.model});
					skipped.push({ model: candidate.model, reason: briefReason(result.message) });
					continue;
				}
                if(implicitFailure&&(result.name!==implicitFailure.attemptedAgent||result.agentDefinitionDigest!==implicitFailure.attemptedAgentDefinitionDigest))fail(`Fallback preflight changed the Agent identity (${policyContext}; reason=agent_identity_drift).`);
                const remainingDegradations=profile.modelDegradations-(implicitFailure?profile.candidates.indexOf(candidate):0);
                if(!candidateMeetsRequirements({...candidate,thinking:result.thinking??candidate.thinking},profile.constraints,candidateMetadata)){skipped.push({model:candidate.model,reason:'admitted_thinking_capability_conflict'});continue;}
                const runtimeCandidates: import("../src/v3/types.ts").V3RuntimeFallbackCandidate[] = [];
                const addCandidate = (choice: RoutingCandidate, admitted: Extract<Awaited<ReturnType<typeof preflight>>, {ok:true}>) => {
                    if (!admitted.model || admitted.name !== agents[0] || admitted.agentDefinitionDigest !== result.agentDefinitionDigest) return;
                    if (canonicalDigest(admitted.toolAllowlist ?? null) !== canonicalDigest(result.toolAllowlist ?? null)
                        || admitted.explicitToolAllowlist !== result.explicitToolAllowlist
                        || canonicalDigest(admitted.extensions) !== canonicalDigest(result.extensions)) return;
                    const provider = choice.model.split("/")[0]!;
                    if (options.extensionRegisteredProviderIds?.includes(provider)) return;
                    const metadata=options.availableModels?.find(m=>(m.fullId??`${m.provider}/${m.id}`)===choice.model);
                    if(!candidateMeetsRequirements({...choice,thinking:admitted.thinking??choice.thinking},profile.constraints,metadata))return;
                    if(profile.candidatePool==='all-compatible'&&!choice.capabilities?.tools)return;
                    const requiresImage = profile.candidatePool==='all-compatible' && profile.constraints?.requiredInputModalities!==undefined
                        ? profile.constraints.requiredInputModalities.includes('image')
                        : /(?:browser-operation|image-analysis|ui-review)/.test(profileName)
                        || options.availableModels?.find(m => (m.fullId ?? `${m.provider}/${m.id}`) === candidate.model)?.input?.includes("image");
                    if (choice.model !== candidate.model && requiresImage
                        && !options.availableModels?.find(m => (m.fullId ?? `${m.provider}/${m.id}`) === choice.model)?.input?.includes("image")) return;
                    runtimeCandidates.push({ requestedModel: choice.model, resolvedModel: admitted.model,
                        ...(admitted.thinking === undefined ? {} : {thinking: admitted.thinking}),
                        agentDefinitionDigest: admitted.agentDefinitionDigest, admissionLaunchContractDigest: admitted.launchContractDigest,
                        ...modelIdentityFields(choice),...(choice.capabilities?{capabilities:structuredClone(choice.capabilities)}:{}),level:choice.level });
                };
                addCandidate(candidate, result);
                if (remainingDegradations > 0) {
                    // An explicit model is the first choice, never an invitation to downgrade
                    // backwards through weaker choices before it in the configured profile.
                    for (const next of (!implicitFailure&&profile.candidatePool==='all-compatible'?profile.candidates.filter(c=>c.model!==candidate.model):profile.candidates.slice(profile.candidates.findIndex(c => c.model === candidate.model) + 1))) {
                        if (runtimeCandidates.length === 0 || runtimeCandidates.length >= remainingDegradations + 1) break;
                        const provider = next.model.split("/")[0]!;
                        if (policy.quarantinedProviderDomains.includes(provider) || producerFamilies.has(modelFamily(next.model))) continue;
                        const checked = await preflight(preflightInput(node, agents[0]!, next.model, next.thinking ?? normalizedThinking(node)));
                        if (!checked.ok) { skipped.push({model:next.model, reason:`fallback_not_admitted: ${briefReason(checked.message)}`}); continue; }
                        addCandidate(next, checked);
                    }
                }
                const planBase = {version:1 as const, sessionContinuationVersion:1 as const, transientRetryLimit:1 as const, profile:profileName, modelDegradations:remainingDegradations,
                    candidates:runtimeCandidates, ...(profile.latestPolicy?{latestPolicy:profile.latestPolicy,approvedLatestIds:profile.approvedLatestIds}:{}), ...(profile.constraints&&(profile.constraints.requiredInputModalities!==undefined||profile.constraints.maximumAutomaticFallback!==undefined||profile.constraints.requireToolCalls!==undefined)?{requirements:{...(profile.constraints.requiredInputModalities===undefined?{}:{requiredInputModalities:profile.constraints.requiredInputModalities}),...(profile.constraints.maximumAutomaticFallback===undefined?{}:{maximumAutomaticFallback:profile.constraints.maximumAutomaticFallback}),...(profile.constraints.requireToolCalls===undefined?{}:{requireToolCalls:profile.constraints.requireToolCalls})}}:{}), excludedFamilies:[...producerFamilies].sort(), requireCrossFamilyFromProducers:profile.constraints?.requireCrossFamilyFromProducers === true};
                const runtimeFallback = runtimeCandidates.length > 1 ? {...planBase, digest:canonicalDigest(planBase)} : undefined;
				node.model = candidate.model;
				if (candidate.thinking !== undefined) node.thinking = candidate.thinking;
				const decision: RoutingAdmissionDecisionV3 = {
					taskId,
					capabilityIds: ids,
					...(inferred ? {inferredFromExactRole:true as const} : {}),
					agent: agents[0]!,
					profile: profileName,
					selectedModel: candidate.model,
					...(result.model === undefined ? {} : { resolvedModel: result.model }),
					...(candidate.thinking === undefined ? {} : { thinking: candidate.thinking }),
					level: candidate.level,
					skipped,
					...(runtimeFallback ? {runtimeFallback} : {}),
                    ...(profile.latestPolicy?{latestModelSelection:{latestPolicy:profile.latestPolicy,approvedLatestIds:profile.approvedLatestIds!,candidate:{requestedModel:candidate.model,resolvedModel:result.model!,...(result.thinking===undefined?{}:{thinking:result.thinking}),agentDefinitionDigest:result.agentDefinitionDigest,admissionLaunchContractDigest:result.launchContractDigest,...modelIdentityFields(candidate),...(candidate.capabilities?{capabilities:structuredClone(candidate.capabilities)}:{}),level:candidate.level}}}:{}),
				};
				decisions.set(taskId, decision);
				return decision;
			}
			fail(`No candidate in routing profile '${profileName}' passed admission for node '${taskId}' (${policyContext}). Reasons: ${skipped.slice(0,8).map(s=>`${s.model}: ${briefReason(s.reason).slice(0,160)}`).join('; ') || 'no eligible candidate'}. Fix the reported configuration or provider availability before resubmitting.`, { taskId, profile: profileName, skipped });
		} finally {
			resolving.delete(taskId);
		}
	};

	for (const node of nodes) await routeOne(node);
	return {
		nodes: nodes as unknown as GraphNodeAuthoringSpecV3[],
		decisions: [...decisions.values()].sort((left, right) => left.taskId.localeCompare(right.taskId)),
		fixedProducerIdentities: await Promise.all([...fixedProducerIdentities.values()]),
	};
}

async function configuredCredential(config: JevShadowConfig, options: RoutingAdmissionOptionsV3): Promise<string | undefined> {
	const environment = options.environment ?? process.env;
	const fromEnvironment = config.credential.env ? environment[config.credential.env]?.trim() : undefined;
	if (fromEnvironment) return fromEnvironment;
	try {
		const credential = await options.getApiKeyForProvider?.(config.credential.provider);
		return typeof credential === "string" && credential.trim() ? credential.trim() : undefined;
	} catch {
		// Shadow credentials must not fail admission or expose resolver errors.
		return undefined;
	}
}

function jevState(goal: string, nodes: readonly GraphNodeAuthoringSpecV3[], decisions: readonly RoutingAdmissionDecisionV3[]): Record<string, unknown> {
	const byTask = new Map(decisions.map((decision) => [decision.taskId, decision]));
	return {
		goal,
		nodes: nodes.map((node) => {
			const decision = byTask.get(node.taskId);
			return {
				taskId: node.taskId,
				task: node.task,
				sideEffect: node.sideEffect,
				...(decision ? { routingProfile: decision.profile, selectedModel: decision.selectedModel } : { routingMode: "fixed" }),
			};
		}),
	};
}

export async function observeJevRoutingShadowV3(
	config: JevShadowConfig | undefined,
	input: { goal: string; nodes: readonly GraphNodeAuthoringSpecV3[]; decisions: readonly RoutingAdmissionDecisionV3[] },
	options: RoutingAdmissionOptionsV3,
	_modelsPath: string,
): Promise<JevShadowObservationV3> {
	if (!config?.enabled) return { status: "disabled", reason: "policy_disabled" };
	if (options.disableNetwork || (!options.fetchFn && (options.environment?.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT))) return { status: "disabled", reason: "test_network_disabled" };
	const credential = await configuredCredential(config, options);
	if (!credential) return { status: "disabled", reason: "credential_unavailable" };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const response = await (options.fetchFn ?? fetch)(config.endpoint, {
			method: "POST",
			headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "jev-latest",
				state: jevState(input.goal, input.nodes, input.decisions),
				questions: {
					route: {
						type: "choice",
						instructions: "Classify the coordination shape only. This shadow result must not choose a concrete model or authorize execution.",
						criteria: {
							fast: "One bounded, low-risk unit with a clear acceptance check",
							deep: "Complex implementation or multiple coupled changes",
							research: "Evidence gathering or long-document research is primary",
							review: "Independent verification or critique is primary",
							human: "Information or authority is insufficient, or the decision is high risk",
						},
					},
				},
			}),
			signal: controller.signal,
		});
		if (!response.ok) return { status: "error", reason: `http_${response.status}` };
		const raw = await response.text();
		if (raw.length > MAX_POLICY_BYTES) return { status: "error", reason: "response_too_large" };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			return { status: "error", reason: "invalid_json" };
		}
		if (!isRecord(parsed) || typeof parsed.model !== "string" || !isRecord(parsed.answers) || !isRecord(parsed.answers.route)) return { status: "error", reason: "invalid_contract" };
		const choice = parsed.answers.route.choice;
		if (typeof choice !== "string" || !config.choices.includes(choice as JevChoice)) return { status: "error", reason: "choice_outside_closed_set" };
		const confidence = parsed.answers.route.confidence;
		return {
			status: "observed",
			requestedModel: "jev-latest",
			actualModel: parsed.model,
			choice: choice as JevChoice,
			...(typeof confidence === "number" && Number.isFinite(confidence) ? { confidence } : {}),
		};
	} catch (error) {
		return { status: "error", reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "request_failed" };
	} finally {
		clearTimeout(timer);
	}
}

async function routeInput(
	nodes: unknown,
	goal: string,
	options: RoutingAdmissionOptionsV3,
	): Promise<{
		nodes: GraphNodeAuthoringSpecV3[];
		receipt: RoutingAdmissionReceiptV3;
		catalogValue?: unknown;
		routingSnapshot?: RoutingPolicySnapshot;
		fixedProducerIdentities: FixedProducerAdmissionIdentityV3[];
	}> {
	if (!Array.isArray(nodes)) fail("Graph authoring nodes must be an array.");
	const fixedNodes = cloneJson(nodes) as GraphNodeAuthoringSpecV3[];
 const required=nodes.some(node=>isRecord(node)&&capabilityIds(node).length>0);
 const fixed=(routingSnapshot?:RoutingPolicySnapshot)=>({...(routingSnapshot?{routingSnapshot}:{}),nodes:fixedNodes,fixedProducerIdentities:[],receipt:{schemaVersion:1 as const,mode:"fixed" as const,decisions:[],jevShadow:{status:"disabled" as const,reason:"policy_disabled" as const}}});
 if(!required && !nodes.some(node=>isRecord(node)&&typeof node.agent==="string")) return fixed();
 const paths=configuredPaths(options);
 const explicitCatalog=options.catalog===undefined?undefined:cloneJson(options.catalog);
 let policyValue:unknown,catalogValue:unknown,policy:RoutingPolicy,catalog:CapabilityRouteCatalog;
 try {
  policyValue=await readStableJson(paths.policyPath,"routing-policy.json");
  catalogValue=explicitCatalog===undefined?await readStableJson(paths.catalogPath,"subagent-capabilities.json"):explicitCatalog;
  policy=validatePolicy(policyValue);catalog=validateCatalog(catalogValue);
 }catch(error){if(required||(isRecord(policyValue)&&isRecord(policyValue.profiles)&&Object.values(policyValue.profiles).some(p=>isRecord(p)&&p.latestPolicy!==undefined)))throw error;return fixed();}
	const routed = await routeAuthoringNodes(nodes, policy, catalog, options);
	const routingSnapshot={policy,catalog,policyDigest:canonicalDigest(policyValue),catalogDigest:catalog.digest};
	if (!required && routed.decisions.length===0) return fixed(routingSnapshot);
	const jevShadow = await observeJevRoutingShadowV3(policy.jevShadow, { goal, nodes: routed.nodes, decisions: routed.decisions }, options, paths.modelsPath);
	return {
		nodes: routed.nodes,
		routingSnapshot,
		catalogValue,
		fixedProducerIdentities: routed.fixedProducerIdentities,
		receipt: {
			schemaVersion: 1,
			mode: ROUTING_ENFORCEMENT,
			policyDigest: canonicalDigest(policyValue),
			...(required ? {catalogDigest:catalog.digest} : {inferredCatalogDigest:catalog.digest}),
			decisions: routed.decisions,
			jevShadow,
		},
	};
}

function freezeRuntimeFallback(nodes: GraphNodeSpecV3[], receipt: RoutingAdmissionReceiptV3): void {
 for (const decision of receipt.decisions) {
  const node = nodes.find(n => n.taskId === decision.taskId), plan = decision.runtimeFallback;
  if (!node?.launch || !node.binding || (!plan&&!decision.latestModelSelection)) continue;
  const first = plan?.candidates[0]??decision.latestModelSelection!.candidate;
  if (first.requestedModel !== node.launch.requestedModel || first.thinking !== node.launch.thinking || first.agentDefinitionDigest !== node.binding.agentDefinitionDigest || first.resolvedModel !== node.launch.resolvedModel
   || first.admissionLaunchContractDigest !== node.binding.admissionLaunchContractDigest) fail("Fallback admission drifted before freezing.", {taskId:node.taskId});
  const {hintDigest: _, ...base} = node.launch;
  const frozen = {...base, ...(plan?{runtimeFallback:plan}:{}),...(decision.latestModelSelection?{latestModelSelection:decision.latestModelSelection}:{})};
  node.launch = {...frozen, hintDigest:canonicalDigest(frozen)};
 }
}

function assertRoutingBindingAlignment(
	nodes: readonly GraphNodeSpecV3[],
	receipt: RoutingAdmissionReceiptV3,
	catalog: V3BoundGraphSpec["catalog"] | undefined,
	fixedProducerIdentities: readonly FixedProducerAdmissionIdentityV3[],
): void {
	if (receipt.mode !== ROUTING_ENFORCEMENT) return;
	if (receipt.catalogDigest !== undefined || receipt.decisions.some(decision=>decision.capabilityIds.length>0)) {
		if (!receipt.catalogDigest || catalog?.digest !== receipt.catalogDigest) {
		fail("Routing admission and Binding did not use the same capability catalog digest.", { routingCatalogDigest: receipt.catalogDigest, bindingCatalogDigest: catalog?.digest });
		}
	} else if (!receipt.inferredCatalogDigest || !receipt.decisions.every(decision=>decision.inferredFromExactRole===true || decision.capabilityIds.length===0 && (decision.profile===`role-settings:${decision.agent}` && decision.level==="role-settings" || decision.profile===`parent-model:${decision.agent}` && decision.level==="parent-model"))) {
		fail("Exact-role routing lacks captured catalog provenance.");
	}
	const byTask = new Map(nodes.map((node) => [node.taskId, node]));
	for (const decision of receipt.decisions) {
		const node = byTask.get(decision.taskId);
		if (!node || node.agent !== decision.agent || (decision.capabilityIds.length>0 && node.binding?.catalogDigest !== receipt.catalogDigest) || node.launch?.requestedModel !== decision.selectedModel) {
			fail(`Routing admission and Binding diverged for node '${decision.taskId}'.`, {
				taskId: decision.taskId,
				routedAgent: decision.agent,
				boundAgent: node?.agent,
				routedModel: decision.selectedModel,
				boundRequestedModel: node?.launch?.requestedModel,
			});
		}
	}
	for (const identity of fixedProducerIdentities) {
		const node = byTask.get(identity.taskId);
		if (
			!node
			|| node.agent !== identity.agent
			|| node.binding?.resolvedAgent !== identity.agent
			|| node.binding.agentDefinitionDigest !== identity.agentDefinitionDigest
			|| node.launch?.requestedModel !== identity.requestedModelForBinding
			|| node.launch.resolvedModel !== identity.resolvedModel
		) {
			fail(`Routing admission and Binding diverged for fixed producer node '${identity.taskId}'.`, {
				taskId: identity.taskId,
				routedAgent: identity.agent,
				boundAgent: node?.agent,
				routedAgentDefinitionDigest: identity.agentDefinitionDigest,
				boundAgentDefinitionDigest: node?.binding?.agentDefinitionDigest,
				routedRequestedModel: identity.requestedModelForBinding,
				boundRequestedModel: node?.launch?.requestedModel,
				routedResolvedModel: identity.resolvedModel,
				boundResolvedModel: node?.launch?.resolvedModel,
			});
		}
	}
}

/** Explicit role settings apply even without a capability catalog; task-level choices win. */
async function fixedRoleSettings(nodes: GraphNodeAuthoringSpecV3[], options:RoutingAdmissionOptionsV3):Promise<RoutingAdmissionDecisionV3[]> {
 const decisions:RoutingAdmissionDecisionV3[]=[];const preflight=options.preflightAgent??v3PreflightAgentLaunch;
 for(const node of nodes){
  if(capabilityIds(node as unknown as Record<string,unknown>).length||!node.agent)continue;
  const override=capturedRoleOverride(node.agent,options);if(!override)continue;
  const primary=node.model??override.model;
  if(primary!==undefined)node.model=primary;
  if(node.thinking===undefined&&override.thinking!==undefined)node.thinking=override.thinking;
  const models=[...new Set([primary,...(override.fallbackModels??[])].filter((m):m is string=>typeof m==='string'))];
  if(models.length>MAX_MODEL_CANDIDATES)fail('Role model chain exceeds 63 permitted replacements.');
  const admitted:import('../src/v3/types.ts').V3RuntimeFallbackCandidate[]=[];
  let first:Awaited<ReturnType<typeof preflight>>|undefined;
  for(const model of models){const result=await preflight({agent:node.agent,task:node.task,cwd:resolve(options.cwd??process.cwd()),model,thinking:node.thinking,turnBudget:node.turnBudget,availableModels:options.availableModels,parentModel:options.parentModel,preferredProvider:options.preferredProvider,...(options.parentToolAllowlist===undefined?{}:{parentToolAllowlist:[...options.parentToolAllowlist],graphToolFilter:options.graphToolFilter===undefined?undefined:[...options.graphToolFilter]})});
   if(!result.ok){if(!first)fail(result.message);continue;}
   if(!first)first=result;
   if(!first.ok||!result.model||result.agentDefinitionDigest!==first.agentDefinitionDigest||canonicalDigest(result.extensions)!==canonicalDigest(first.extensions)||canonicalDigest(result.toolAllowlist)!==canonicalDigest(first.toolAllowlist))continue;
   if(options.extensionRegisteredProviderIds?.includes(model.split('/')[0]!))continue;
   const image=options.availableModels?.find(m=>(m.fullId??`${m.provider}/${m.id}`)===models[0])?.input?.includes('image');
   if(admitted.length&&image&&!options.availableModels?.find(m=>(m.fullId??`${m.provider}/${m.id}`)===model)?.input?.includes('image'))continue;
   admitted.push({requestedModel:model,resolvedModel:result.model,thinking:result.thinking,agentDefinitionDigest:result.agentDefinitionDigest,admissionLaunchContractDigest:result.launchContractDigest});
  }
  if(first?.ok&&primary){node.thinking=first.thinking??node.thinking;const base={version:1 as const,sessionContinuationVersion:1 as const, transientRetryLimit:1 as const,profile:`role-settings:${node.agent}`,modelDegradations:Math.max(0,models.length-1),candidates:admitted,excludedFamilies:[],requireCrossFamilyFromProducers:false};
   decisions.push({taskId:node.taskId,capabilityIds:[],agent:node.agent,profile:base.profile,selectedModel:primary,resolvedModel:first.model,thinking:first.thinking,level:'role-settings',skipped:[],...(admitted.length>1?{runtimeFallback:{...base,digest:canonicalDigest(base)}}:{})});}
 }
 return decisions;
}

function customRegistryOptions(options:RoutingAdmissionOptionsV3):RoutingAdmissionOptionsV3 {
 const custom=readCustomGraphModels(resolve(options.cwd??process.cwd()),options.agentDir);
 if(!custom.length)return options;
 return {...options,availableModels:[...(options.availableModels??[]),...custom.map(m=>({...m,fullId:`${m.provider}/${m.id}`}))]};
}

const roleOverrideSnapshotKey = Symbol("trusted-binding-role-overrides");
type RoleOverrideSnapshot = Map<string, ReturnType<typeof readRoleModelOverride>>;
function beginRoleOverrideSnapshot(options:RoutingAdmissionOptionsV3):RoutingAdmissionOptionsV3 {
 return Object.assign({...options},{[roleOverrideSnapshotKey]:new Map() as RoleOverrideSnapshot});
}
function capturedRoleOverride(agent:string,options:RoutingAdmissionOptionsV3):ReturnType<typeof readRoleModelOverride> {
 const cache=(options as RoutingAdmissionOptionsV3 & {[roleOverrideSnapshotKey]?:RoleOverrideSnapshot})[roleOverrideSnapshotKey];
 if(cache?.has(agent))return cache.get(agent);
 const value=readRoleModelOverride(agent,resolve(options.cwd??process.cwd()),options.agentDir);
 const frozen=value===undefined?undefined:structuredClone(value);
 cache?.set(agent,frozen);return frozen;
}

export async function bindGraphSpecWithRoutingV3(input: GraphSpecAuthoringV3 | unknown, options: RoutingAdmissionOptionsV3 = {}): Promise<RoutedBoundGraphSpecV3> {
	options=beginRoleOverrideSnapshot(customRegistryOptions(options));
	if (!isRecord(input) || !Array.isArray(input.nodes)) fail("GraphSpec V3 routing input requires nodes.");
	// Mirror Binding: the authored spec owns its filter, including an absent filter.
	const graphToolFilter = Array.isArray(input.toolFilter) && input.toolFilter.every(tool => typeof tool === "string") ? [...input.toolFilter] as string[] : undefined;
	options = { ...options, graphToolFilter };
	const routed = await routeInput(input.nodes, typeof input.goal === "string" ? input.goal : "Graph admission", options);
	routed.receipt.decisions.push(...await fixedRoleSettings(routed.nodes.filter(node=>!routed.receipt.decisions.some(d=>d.taskId===node.taskId)),options));
	const authoring = cloneJson(input) as Record<string, unknown>;
	authoring.nodes = routed.nodes;
	const bound = await bindGraphSpecV3(authoring, { ...options, ...(routed.catalogValue === undefined ? {} : { catalog: routed.catalogValue }) });
	freezeRuntimeFallback(bound.spec.nodes, routed.receipt);
	assertRoutingBindingAlignment(bound.spec.nodes, routed.receipt, bound.catalog, routed.fixedProducerIdentities);
	return { ...bound, routingAdmission: routed.receipt };
}

export async function bindGraphNodesWithRoutingV3(
	nodes: readonly GraphNodeAuthoringSpecV3[] | unknown,
	options: RoutingAdmissionOptionsV3 & { contractPolicy?: "standard" | "strict" } = {},
): Promise<{ nodes: GraphNodeSpecV3[]; routingAdmission: RoutingAdmissionReceiptV3; catalog?: V3BoundGraphSpec["catalog"] }> {
	options=beginRoleOverrideSnapshot(customRegistryOptions(options));
	const routed = await routeInput(nodes, "Append Graph nodes", options);
	routed.receipt.decisions.push(...await fixedRoleSettings(routed.nodes.filter(node=>!routed.receipt.decisions.some(d=>d.taskId===node.taskId)),options));
	const bound = await bindGraphNodesV3(routed.nodes, { ...options, ...(routed.catalogValue === undefined ? {} : { catalog: routed.catalogValue }) });
	freezeRuntimeFallback(bound.nodes, routed.receipt);
	assertRoutingBindingAlignment(bound.nodes, routed.receipt, bound.catalog, routed.fixedProducerIdentities);
	return { ...bound, routingAdmission: routed.receipt };
}

/** Resolve existing producer identity only from an accepted Attempt and durable Graph evidence. */
export async function readAcceptedProducerModelsV3(input: {
	runDir: string;
	graph: Pick<CompiledGraphV3, "graphId" | "nodes">;
	runInstanceId: string;
	taskIds: readonly string[];
}): Promise<Record<string, TrustedProducerModelV3>> {
	const byTask = new Map(input.graph.nodes.map((node) => [node.taskId, node]));
	const output: Record<string, TrustedProducerModelV3> = {};
	for (const taskId of [...new Set(input.taskIds)]) {
		const node = byTask.get(taskId) ?? fail(`Existing producer dependency '${taskId}' is not present in the admitted Graph.`, { taskId });
		const latest = await readLatestV3Attempt(input.runDir, taskId);
		if (!latest || latest.evidence.phase !== "accepted" || latest.evidence.terminalStatus !== "accepted") {
			fail(`Existing producer dependency '${taskId}' has no accepted Attempt.`, { taskId });
		}
		const verified = await verifyV3AcceptedAttemptChain(input.runDir, taskId, latest.attempt, {
			runInstanceId: input.runInstanceId,
			graphId: input.graph.graphId,
			method: node.sideEffect === "local_write" ? "machine-verified" : "declared",
		});
		if (!verified.ok || !verified.attempt) fail(`Existing producer dependency '${taskId}' has no trusted accepted evidence.`, { taskId, reasons: verified.reasons });
		const actualModels = [
			verified.attempt.child?.observation?.actualModel,
			verified.attempt.observation?.actualModel,
			verified.attempt.dispatch?.observation?.actualModel,
		].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
		const actual = [...new Set(actualModels)][0];
		if (new Set(actualModels).size > 1) fail(`Existing producer dependency '${taskId}' has conflicting runtime actual-model observations.`, { taskId });
		const frozen = node.launch?.resolvedModel;
		if (actual && frozen && modelFamily(actual) !== modelFamily(frozen)) {
			fail(`Existing producer dependency '${taskId}' runtime and frozen model families disagree.`, { taskId, actualModel: actual, frozenResolvedModel: frozen });
		}
		const model = actual ?? frozen;
		if (!model) fail(`Existing producer dependency '${taskId}' has no trusted actual or frozen resolved model identity.`, { taskId });
		output[taskId] = { model, source: actual ? "accepted-attempt-actual" : "accepted-frozen-resolved", attempt: latest.attempt };
	}
	return output;
}

export type { JevChoice, JevShadowConfig, RoutingPolicy, RoutingProfile };
