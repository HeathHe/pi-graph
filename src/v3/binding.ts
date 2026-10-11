import { classifyProviderFailure } from "./failure-policy.ts";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { compileGraphSpecV3 } from "./compiler.ts";
import { canonicalDigest, canonicalJson } from "./digests.ts";
import { GraphV3Error, graphV3Error } from "./errors.ts";
import {
	v3PreflightAgentLaunch,
	type V3AgentLaunchPreflightInput,
	type V3AgentLaunchPreflightResult,
	type V3PreflightAvailableModel,
	type V3PreflightParentModel,
} from "./preflight.ts";
import type {
	CompiledGraphV3,
	GraphContractPolicyV3,
	GraphNodeAuthoringSpecV3,
	GraphNodeSpecV3,
	GraphSpecAuthoringV3,
	GraphSpecV3,
	V3CapabilityEntryBinding,
	V3NodeBinding,
	V3NodeLaunchHints,
	V3ToolBudgetHint,
	V3TurnBudgetHint,
	V3UsageBudgetHint,
	V3UsageBudgetLimitHint,
} from "./types.ts";

export const V3_CAPABILITY_CATALOG_SCHEMA_VERSION = 1 as const;
export const V3_CAPABILITY_CATALOG_MAX_BYTES = 1_048_576;
export const V3_CAPABILITY_CATALOG_MAX_ENTRIES = 512;
export const V3_DEFAULT_TEMPORARY_AGENT = "pi-graph.graph-worker";

const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const SPECIAL_NODE_FIELDS = new Set(["capabilityId", "requires", "model", "thinking", "turnBudget", "toolBudget", "usageBudget", "maxTokens"]);

export interface V3CapabilityCatalogEntry {
	capabilityId: string;
	agent: string;
	entryDigest: string;
	/** Only a fixed policy becomes a Pi launch hint. Other policy modes are catalog evidence, not graph routing. */
	fixedModel?: string;
}

export interface V3CapabilityCatalog {
	schemaVersion: typeof V3_CAPABILITY_CATALOG_SCHEMA_VERSION;
	digest: string;
	path?: string;
	entries: V3CapabilityCatalogEntry[];
}

export interface V3CapabilityCatalogReadOptions {
	path?: string;
	agentDir?: string;
	maxBytes?: number;
}

export interface V3BindingOptions extends V3CapabilityCatalogReadOptions {
	parentToolAllowlist?: string[];
	graphToolFilter?: string[];
	/** Source workspace used by pi-subagents public preflight. Defaults to process.cwd(). */
	cwd?: string;
	/** Injectable public-preflight seam for deterministic tests. */
	preflightAgent?: (input: V3AgentLaunchPreflightInput) => Promise<V3AgentLaunchPreflightResult>;
	/** Parsed/in-memory catalog injection for tests and hosts that already captured stable bytes. */
	catalog?: unknown;
	/** Default false. Only an entirely unmatched capability request may use this fallback. */
	allowTemporaryAgent?: boolean;
	/** Exact package Agent used by the explicit opt-in fallback. */
	temporaryAgent?: string;
	/** Pi host model-registry snapshot captured at the public tool boundary. */
	availableModels?: readonly V3PreflightAvailableModel[];
	/** Pi host's current in-memory model. */
	parentModel?: V3PreflightParentModel;
	/** Provider used to disambiguate an unqualified requested model. */
	preferredProvider?: string;
	/** Provider IDs currently registered or overridden by Pi extensions. */
	extensionRegisteredProviderIds?: readonly string[];
}

export interface V3BindGraphNodesOptions extends V3BindingOptions {
	contractPolicy?: GraphContractPolicyV3;
}

export interface V3BoundGraphSpec {
	spec: GraphSpecV3;
	compiled: CompiledGraphV3;
	catalog?: Pick<V3CapabilityCatalog, "schemaVersion" | "digest" | "path">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bindingError(message: string, options: { taskId?: string; field?: string; details?: Record<string, unknown>; cause?: unknown } = {}): never {
	throw new GraphV3Error("CAPABILITY_BINDING_FAILED", message, options);
}

function text(value: unknown, label: string, options: { taskId?: string; maxLength?: number } = {}): string {
	if (typeof value !== "string" || value.trim().length === 0) bindingError(`${label} must be a non-empty string.`, { taskId: options.taskId, field: label });
	const normalized = value.trim();
	if (normalized.length > (options.maxLength ?? 500)) bindingError(`${label} is too long.`, { taskId: options.taskId, field: label });
	return normalized;
}

function capabilityId(value: unknown, label: string, taskId?: string): string {
	const normalized = text(value, label, { taskId, maxLength: 200 });
	if (!CAPABILITY_ID_PATTERN.test(normalized)) bindingError(`${label} is not a portable capability ID.`, { taskId, field: label });
	return normalized;
}

const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function stripThinkingSuffix(model: string): string {
	const colon = model.lastIndexOf(":");
	return colon > 0 && THINKING_SUFFIXES.has(model.slice(colon + 1)) ? model.slice(0, colon) : model;
}

function providerForModel(model: string, availableModels: readonly V3PreflightAvailableModel[] | undefined): string | undefined {
	const base = stripThinkingSuffix(model);
	const exact = availableModels?.find((entry) => (entry.fullId ?? `${entry.provider}/${entry.id}`) === base);
	if (exact) return exact.provider;
	const slash = base.indexOf("/");
	return slash > 0 ? base.slice(0, slash) : undefined;
}

function extensionProvidersFor(
	preflight: Extract<V3AgentLaunchPreflightResult, { ok: true }>,
	options: V3BindingOptions,
): string[] {
	const registered = new Set(options.extensionRegisteredProviderIds ?? []);
	if (registered.size === 0) return [];
	return [...new Set([...(preflight.model ? [preflight.model] : []), ...preflight.modelCandidates]
		.flatMap((model) => {
			const provider = providerForModel(model, options.availableModels);
			return provider && registered.has(provider) ? [provider] : [];
		}))].sort();
}

function canonicalClone<T>(value: T, label: string): T {
	try {
		return JSON.parse(canonicalJson(value)) as T;
	} catch (error) {
		throw new GraphV3Error("CAPABILITY_BINDING_FAILED", `${label} must contain only finite, acyclic JSON values.`, { cause: error });
	}
}

function normalizeFixedModel(value: Record<string, unknown>, capability: string): string | undefined {
	if (value.modelPolicy === undefined) return undefined;
	if (!isRecord(value.modelPolicy)) graphV3Error("CAPABILITY_CATALOG_INVALID", `Capability '${capability}' modelPolicy must be an object.`, { field: "modelPolicy" });
	const mode = text(value.modelPolicy.mode, `capabilities.${capability}.modelPolicy.mode`, { maxLength: 100 });
	if (mode !== "fixed") return undefined;
	return text(value.modelPolicy.model, `capabilities.${capability}.modelPolicy.model`, { maxLength: 500 });
}

/** Validate both source and installed catalog shapes without interpreting routingProfile. */
export function validateV3CapabilityCatalog(value: unknown, path?: string): V3CapabilityCatalog {
	if (!isRecord(value)) graphV3Error("CAPABILITY_CATALOG_INVALID", "subagent-capabilities.json must contain an object.");
	if (value.schemaVersion !== V3_CAPABILITY_CATALOG_SCHEMA_VERSION) graphV3Error("CAPABILITY_CATALOG_INVALID", "subagent-capabilities.json requires schemaVersion: 1.", { field: "schemaVersion" });
	if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > V3_CAPABILITY_CATALOG_MAX_ENTRIES) {
		graphV3Error("CAPABILITY_CATALOG_INVALID", `subagent-capabilities.json must contain 1..${V3_CAPABILITY_CATALOG_MAX_ENTRIES} capabilities.`, { field: "capabilities" });
	}
	const entries = value.capabilities.map((raw, index) => {
		if (!isRecord(raw)) graphV3Error("CAPABILITY_CATALOG_INVALID", `capabilities[${index}] must be an object.`, { field: "capabilities" });
		const id = capabilityId(raw.capabilityId, `capabilities[${index}].capabilityId`);
		const agent = text(raw.agent, `capabilities[${index}].agent`, { maxLength: 500 });
		if (raw.routingProfile !== undefined) text(raw.routingProfile, `capabilities[${index}].routingProfile`, { maxLength: 500 });
		return {
			capabilityId: id,
			agent,
			entryDigest: canonicalDigest(raw),
			...(normalizeFixedModel(raw, id) ? { fixedModel: normalizeFixedModel(raw, id) } : {}),
		};
	});
	entries.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
	const duplicate = entries.find((entry, index) => entries[index - 1]?.capabilityId === entry.capabilityId);
	if (duplicate) graphV3Error("CAPABILITY_CATALOG_INVALID", `Duplicate capabilityId '${duplicate.capabilityId}'.`, { field: "capabilityId" });
	return {
		schemaVersion: V3_CAPABILITY_CATALOG_SCHEMA_VERSION,
		digest: canonicalDigest(value),
		...(path === undefined ? {} : { path }),
		entries,
	};
}

function catalogPath(options: V3CapabilityCatalogReadOptions): string {
	if (options.path !== undefined) return resolve(text(options.path, "capability catalog path", { maxLength: 4_096 }));
	const agentDir = options.agentDir === undefined ? getAgentDir() : resolve(text(options.agentDir, "agentDir", { maxLength: 4_096 }));
	return join(agentDir, "subagent-capabilities.json");
}

/** Read stable, bounded, non-link catalog bytes from Pi's Agent directory. */
export async function readV3CapabilityCatalog(options: V3CapabilityCatalogReadOptions = {}): Promise<V3CapabilityCatalog> {
	const path = catalogPath(options);
	const maxBytes = options.maxBytes ?? V3_CAPABILITY_CATALOG_MAX_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > V3_CAPABILITY_CATALOG_MAX_BYTES) graphV3Error("CAPABILITY_CATALOG_INVALID", `Capability catalog maxBytes must be 1..${V3_CAPABILITY_CATALOG_MAX_BYTES}.`, { field: "maxBytes" });
	let handle;
	try {
		const before = await lstat(path);
		if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) graphV3Error("CAPABILITY_CATALOG_INVALID", `Capability catalog must be one regular non-symbolic-link file: ${path}`);
		if (before.size > maxBytes) graphV3Error("CAPABILITY_CATALOG_INVALID", `Capability catalog exceeds ${maxBytes} bytes.`, { details: { path, size: before.size, maxBytes } });
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) graphV3Error("CAPABILITY_CATALOG_INVALID", "Capability catalog changed while it was opened.", { details: { path } });
		const bytes = await handle.readFile();
		const [finished, current] = await Promise.all([handle.stat(), lstat(path)]);
		if (finished.dev !== opened.dev || finished.ino !== opened.ino || current.dev !== opened.dev || current.ino !== opened.ino
			|| finished.nlink !== 1 || current.nlink !== 1 || finished.size !== opened.size || current.size !== opened.size
			|| finished.mtimeMs !== opened.mtimeMs || current.mtimeMs !== opened.mtimeMs) {
			graphV3Error("CAPABILITY_CATALOG_INVALID", "Capability catalog changed while it was read.", { details: { path } });
		}
		let decoded: string;
		try {
			decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			throw new GraphV3Error("CAPABILITY_CATALOG_INVALID", "Capability catalog must be valid UTF-8.", { details: { path }, cause: error });
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(decoded) as unknown;
		} catch (error) {
			throw new GraphV3Error("CAPABILITY_CATALOG_INVALID", "Capability catalog is not valid JSON.", { details: { path }, cause: error });
		}
		return validateV3CapabilityCatalog(parsed, path);
	} catch (error) {
		if (error instanceof GraphV3Error) throw error;
		throw new GraphV3Error("CAPABILITY_CATALOG_INVALID", `Could not read capability catalog '${path}': ${error instanceof Error ? error.message : String(error)}`, { details: { path }, cause: error });
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function normalizeTurnBudget(value: unknown, taskId: string): V3TurnBudgetHint | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).some((field) => field !== "maxTurns" && field !== "graceTurns")) bindingError("turnBudget must contain maxTurns and optional graceTurns.", { taskId, field: "turnBudget" });
	if (!Number.isSafeInteger(value.maxTurns) || (value.maxTurns as number) < 1) bindingError("turnBudget.maxTurns must be a positive safe integer.", { taskId, field: "turnBudget.maxTurns" });
	if (value.graceTurns !== undefined && (!Number.isSafeInteger(value.graceTurns) || (value.graceTurns as number) < 0)) bindingError("turnBudget.graceTurns must be a non-negative safe integer.", { taskId, field: "turnBudget.graceTurns" });
	return { maxTurns: value.maxTurns as number, ...(value.graceTurns === undefined ? {} : { graceTurns: value.graceTurns as number }) };
}

function normalizeToolBudget(value: unknown, taskId: string): V3ToolBudgetHint | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).some((field) => field !== "soft" && field !== "hard" && field !== "block")) bindingError("toolBudget must contain hard and optional soft/block.", { taskId, field: "toolBudget" });
	if (!Number.isSafeInteger(value.hard) || (value.hard as number) < 1) bindingError("toolBudget.hard must be a positive safe integer.", { taskId, field: "toolBudget.hard" });
	if (value.soft !== undefined && (!Number.isSafeInteger(value.soft) || (value.soft as number) < 1 || (value.soft as number) > (value.hard as number))) bindingError("toolBudget.soft must be a positive integer no greater than hard.", { taskId, field: "toolBudget.soft" });
	let block: string[] | "*" | undefined;
	if (value.block === "*") block = "*";
	else if (value.block !== undefined) {
		if (!Array.isArray(value.block) || value.block.length === 0) bindingError("toolBudget.block must be '*' or a non-empty string array.", { taskId, field: "toolBudget.block" });
		block = value.block.map((entry, index) => text(entry, `toolBudget.block[${index}]`, { taskId, maxLength: 200 }));
		if (new Set(block).size !== block.length) bindingError("toolBudget.block must not contain duplicates.", { taskId, field: "toolBudget.block" });
		block.sort();
	}
	return { ...(value.soft === undefined ? {} : { soft: value.soft as number }), hard: value.hard as number, ...(block === undefined ? {} : { block }) };
}

function normalizeUsageLimit(value: unknown, label: string, taskId: string): V3UsageBudgetLimitHint {
	if (!isRecord(value) || Object.keys(value).some((field) => field !== "soft" && field !== "hard")) bindingError(`${label} must contain hard and optional soft.`, { taskId, field: label });
	if (typeof value.hard !== "number" || !Number.isFinite(value.hard) || value.hard <= 0) bindingError(`${label}.hard must be a positive number.`, { taskId, field: `${label}.hard` });
	if (value.soft !== undefined && (typeof value.soft !== "number" || !Number.isFinite(value.soft) || value.soft <= 0 || value.soft > value.hard)) bindingError(`${label}.soft must be a positive number no greater than hard.`, { taskId, field: `${label}.soft` });
	return { ...(typeof value.soft === "number" ? { soft: value.soft } : {}), hard: value.hard };
}

function normalizeUsageBudget(value: unknown, taskId: string): V3UsageBudgetHint | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).some((field) => field !== "tokens" && field !== "costUsd")) bindingError("usageBudget must contain tokens and/or costUsd.", { taskId, field: "usageBudget" });
	const tokens = value.tokens === undefined ? undefined : normalizeUsageLimit(value.tokens, "usageBudget.tokens", taskId);
	const costUsd = value.costUsd === undefined ? undefined : normalizeUsageLimit(value.costUsd, "usageBudget.costUsd", taskId);
	if (!tokens && !costUsd) bindingError("usageBudget must contain tokens and/or costUsd.", { taskId, field: "usageBudget" });
	return { ...(tokens ? { tokens } : {}), ...(costUsd ? { costUsd } : {}) };
}

function normalizeMaxTokens(value: unknown, taskId: string): number | undefined {
	if (value === undefined) return undefined;
	// Pi's OpenAI Responses adapters reject max_output_tokens below 16. One
	// portable public contract therefore uses 16 as its provider-safe minimum.
	if (!Number.isSafeInteger(value) || (value as number) < 16) {
		bindingError("maxTokens must be a safe integer of at least 16.", { taskId, field: "maxTokens" });
	}
	return value as number;
}

function nodeCapabilities(node: Record<string, unknown>, taskId: string): string[] {
	const ids: string[] = [];
	if (node.capabilityId !== undefined) ids.push(capabilityId(node.capabilityId, "capabilityId", taskId));
	if (node.requires !== undefined) {
		if (!Array.isArray(node.requires) || node.requires.length === 0) bindingError("requires must be a non-empty capability ID array.", { taskId, field: "requires" });
		ids.push(...node.requires.map((entry, index) => capabilityId(entry, `requires[${index}]`, taskId)));
	}
	if (new Set(ids).size !== ids.length) bindingError("capabilityId/requires must not repeat a capability.", { taskId, field: "requires" });
	return ids.sort();
}

function publicNodeWithoutBindingFields(node: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(node).filter(([field]) => !SPECIAL_NODE_FIELDS.has(field) && field !== "binding" && field !== "launch"));
}

function launchHintInput(node: Record<string, unknown>, matches: readonly V3CapabilityCatalogEntry[], taskId: string): Omit<V3NodeLaunchHints, "schemaVersion" | "hintDigest"> | undefined {
	const requestedModel = node.model === undefined ? undefined : text(node.model, "model", { taskId, maxLength: 500 });
	const fixedModels = [...new Set(matches.flatMap((entry) => entry.fixedModel ? [entry.fixedModel] : []))];
	if (fixedModels.length > 1) bindingError(`Capabilities for node '${taskId}' declare conflicting fixed model hints.`, { taskId, field: "model", details: { models: fixedModels } });
	if (requestedModel && fixedModels[0] && requestedModel !== fixedModels[0]) bindingError(`Node '${taskId}' model conflicts with its fixed capability model policy.`, { taskId, field: "model", details: { requestedModel, fixedModel: fixedModels[0] } });
	const resolvedModel = requestedModel ?? fixedModels[0];
	let thinking: string | undefined;
	if (node.thinking === false) thinking = "off";
	else if (node.thinking !== undefined) thinking = text(node.thinking, "thinking", { taskId, maxLength: 100 });
	const turnBudget = normalizeTurnBudget(node.turnBudget, taskId);
	const toolBudget = normalizeToolBudget(node.toolBudget, taskId);
	const maxTokens = normalizeMaxTokens(node.maxTokens, taskId);
	const usageBudget = normalizeUsageBudget(node.usageBudget, taskId);
	const base = {
		...(requestedModel === undefined ? {} : { requestedModel }),
		...(resolvedModel === undefined ? {} : { resolvedModel }),
		...(thinking === undefined ? {} : { thinking }),
		...(turnBudget === undefined ? {} : { turnBudget }),
		...(toolBudget === undefined ? {} : { toolBudget }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(usageBudget === undefined ? {} : { usageBudget }),
	};
	return Object.keys(base).length === 0 ? undefined : base;
}

function catalogSummary(catalog: V3CapabilityCatalog | undefined): V3BoundGraphSpec["catalog"] {
	return catalog === undefined ? undefined : {
		schemaVersion: catalog.schemaVersion,
		digest: catalog.digest,
		...(catalog.path === undefined ? {} : { path: catalog.path }),
	};
}

async function catalogFor(options: V3BindingOptions, required: boolean): Promise<V3CapabilityCatalog | undefined> {
	if (!required) return undefined;
	if (options.catalog !== undefined) return validateV3CapabilityCatalog(options.catalog, options.path === undefined ? undefined : resolve(options.path));
	try {
		return await readV3CapabilityCatalog(options);
	} catch (error) {
		const cause = error instanceof Error ? error.cause : undefined;
		if (options.allowTemporaryAgent === true && isRecord(cause) && cause.code === "ENOENT") return undefined;
		throw error;
	}
}

async function bindNode(
	rawNode: unknown,
	policy: GraphContractPolicyV3,
	catalog: V3CapabilityCatalog | undefined,
	options: V3BindingOptions,
	toolEvidence?: Array<{ agent: string; explicit: boolean; allowlist: string[] | undefined }>,
): Promise<GraphNodeSpecV3> {
	if (!isRecord(rawNode)) bindingError("Every graph node must be an object.", { field: "nodes" });

 if(rawNode.fallbackAgents!==undefined) {
  if(!Array.isArray(rawNode.fallbackAgents)||rawNode.fallbackAgents.length<1||rawNode.fallbackAgents.length>8||typeof rawNode.agent!=="string"||rawNode.requires!==undefined||rawNode.capabilityId!==undefined||rawNode.model!==undefined)bindingError("fallbackAgents requires exact agent authoring without capability/model overrides");
  const agents=[rawNode.agent,...rawNode.fallbackAgents];
  if(agents.some(a=>typeof a!=="string"||!a.trim())||new Set(agents).size!==agents.length)bindingError("fallbackAgents must name distinct exact roles");
  if(!options.parentToolAllowlist)bindingError("fallbackAgents requires a trusted parent tool ceiling");
  const candidates=agents.map(agent=>{
   const entries=catalog?.entries.filter(e=>e.agent===agent)??[];
   const models=[...new Set(entries.map(e=>e.fixedModel).filter((v):v is string=>!!v))];
   if(models.length!==1 || entries.some(e=>!e.fixedModel))bindingError(`Fallback role '${agent}' requires an existing unambiguous fixed-model catalog definition`);
   return {agent,model:models[0]!,state:"unprobed" as "unprobed"|"provider-unavailable"|"selected",failureKind:undefined as string|undefined};
  });
  const {fallbackAgents:_fallback,...base}=rawNode;
  for(const candidate of candidates) {
   let denied:string|undefined;
   const preflightAgent:NonNullable<V3BindingOptions["preflightAgent"]>=async input=>{
    const {model:_override,...definitionInput}=input;
    const result=await(options.preflightAgent??v3PreflightAgentLaunch)(definitionInput);
    if(!result.ok){denied=result.message;return result;}
    if(result.model!==candidate.model || !result.explicitToolAllowlist || !result.toolAllowlist || result.toolAllowlist.some(t=>!options.parentToolAllowlist!.includes(t)))bindingError("Fallback candidate changes fixed model or exceeds the explicit parent tool ceiling");
    return result;
   };
   try{
    const selected=await bindNode({...base,agent:candidate.agent,model:candidate.model},policy,catalog,{...options,preflightAgent},toolEvidence);
    candidate.state="selected";
    const {bindingDigest:_digest,...basis}=selected.binding!;
    const binding={...basis,authoringNodeDigest:canonicalDigest(rawNode),fallbackAdmission:{catalogDigest:catalog!.digest,candidates:candidates.map(c=>({agent:c.agent,model:c.model,state:c.state,...(c.failureKind?{failureKind:c.failureKind}:{})})),runtimeAutomaticFallback:false as const}};
    selected.binding={...binding,bindingDigest:canonicalDigest(binding)};
    return selected;
   }
   catch(error){if(!denied||!classifyProviderFailure(denied).eligible)throw error;candidate.state="provider-unavailable";candidate.failureKind=classifyProviderFailure(denied).kind;}
  }
  bindingError("All explicit fallbackAgents unavailable with provider evidence; no child dispatched");
 }
	const taskId = text(rawNode.taskId, "taskId", { maxLength: 200 });
	if (rawNode.binding !== undefined || rawNode.launch !== undefined) bindingError("Public authoring may not provide reserved binding/launch evidence.", { taskId, field: rawNode.binding !== undefined ? "binding" : "launch" });
	const requestedAgent = rawNode.agent === undefined ? undefined : text(rawNode.agent, "agent", { taskId, maxLength: 500 });
	const capabilityIds = nodeCapabilities(rawNode, taskId);
	if (policy === "strict" && capabilityIds.length === 0) bindingError(`Strict node '${taskId}' requires capabilityId or requires.`, { taskId, field: "capabilityId" });
	const byId = new Map((catalog?.entries ?? []).map((entry) => [entry.capabilityId, entry]));
	const matches = capabilityIds.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
	const unmatched = capabilityIds.filter((id) => !byId.has(id));
	const matchedAgents = [...new Set(matches.map((entry) => entry.agent))];
	const completeCatalogMatch = unmatched.length === 0 && matchedAgents.length === 1;
	let resolvedAgent: string;
	let resolution: V3NodeBinding["resolution"];
	if (capabilityIds.length === 0) {
		if (!requestedAgent) bindingError(`Node '${taskId}' requires agent, capabilityId, or requires.`, { taskId, field: "agent" });
		resolvedAgent = requestedAgent;
		resolution = "exact-agent";
	} else if (completeCatalogMatch) {
		resolvedAgent = matchedAgents[0]!;
		if (requestedAgent && requestedAgent !== resolvedAgent) bindingError(`Node '${taskId}' agent '${requestedAgent}' conflicts with capability Agent '${resolvedAgent}'.`, { taskId, field: "agent", details: { requestedAgent, resolvedAgent } });
		resolution = "capability-catalog";
	} else {
		if (requestedAgent) bindingError(`Node '${taskId}' capabilities do not resolve to its explicit Agent; explicit Agents never use temporary fallback.`, { taskId, field: "agent", details: { requestedAgent, unmatched, agents: matchedAgents } });
		if (policy === "strict") bindingError(`Strict node '${taskId}' has no single complete capability contract.`, { taskId, field: "requires", details: { unmatched, agents: matchedAgents } });
		if (matches.length > 0) {
			bindingError(
				unmatched.length > 0
					? `Node '${taskId}' has a partial capability match; temporary fallback is allowed only when every requested capability is unknown.`
					: `Node '${taskId}' capabilities resolve to multiple Agents; temporary fallback cannot replace conflicting catalog contracts.`,
				{ taskId, field: "requires", details: { unmatched, agents: matchedAgents } },
			);
		}
		if (options.allowTemporaryAgent !== true) bindingError(`No single Agent binding exists for capabilities [${capabilityIds.join(", ")}].`, { taskId, field: "requires", details: { unmatched, agents: matchedAgents, temporaryAgentEnabled: false } });
		resolvedAgent = text(options.temporaryAgent ?? V3_DEFAULT_TEMPORARY_AGENT, "temporaryAgent", { taskId, maxLength: 500 });
		resolution = "temporary-agent";
	}
	const launchInput = launchHintInput(rawNode, resolution === "capability-catalog" ? matches : [], taskId);
	const baseNode = publicNodeWithoutBindingFields(rawNode);
	const preflight = await (options.preflightAgent ?? v3PreflightAgentLaunch)({
		agent: resolvedAgent,
		task: text(rawNode.task, "task", { taskId, maxLength: 100_000 }),
		cwd: resolve(options.cwd ?? process.cwd()),
		// Capability catalogs commonly point at user or package Agents. The
		// workspace freeze repeats this exact `both` resolution and verifies the
		// definition digest before publishing a runnable profile.
		agentScope: "both",
		...(launchInput?.resolvedModel === undefined ? {} : { model: launchInput.resolvedModel }),
		...(launchInput?.thinking === undefined ? {} : { thinking: launchInput.thinking }),
		...(launchInput?.turnBudget === undefined ? {} : { turnBudget: launchInput.turnBudget }),
		...(options.parentToolAllowlist === undefined ? {} : { parentToolAllowlist: options.parentToolAllowlist, graphToolFilter: options.graphToolFilter }),
		...(options.parentModel === undefined ? {} : { parentModel: options.parentModel }),
		...(options.availableModels === undefined ? {} : { availableModels: options.availableModels }),
		...(options.preferredProvider === undefined ? {} : { preferredProvider: options.preferredProvider }),
	});
	if (!preflight.ok) bindingError(`Agent '${resolvedAgent}' failed Pi launch preflight for node '${taskId}': ${preflight.message}`, { taskId, field: "agent" });
	if (preflight.name !== resolvedAgent) bindingError(`Agent '${resolvedAgent}' resolved ambiguously to '${preflight.name}' during Pi launch preflight.`, { taskId, field: "agent", details: { requested: resolvedAgent, resolved: preflight.name } });
	toolEvidence?.push({ agent: resolvedAgent, explicit: preflight.explicitToolAllowlist === true, allowlist: preflight.toolAllowlist });
	if (launchInput?.thinking !== undefined && preflight.model === undefined) {
		bindingError(`Node '${taskId}' declares thinking but Pi preflight resolved no model; refusing to silently ignore it.`, { taskId, field: "thinking" });
	}
	const extensionProviderIds = extensionProvidersFor(preflight, options);
	if (extensionProviderIds.length > 0) {
		bindingError(
			`Node '${taskId}' resolves model provider${extensionProviderIds.length === 1 ? "" : "s"} [${extensionProviderIds.join(", ")}] through Pi extension-registered or overridden Providers. `
			+ "pi-graph cannot admit extension Providers because custom streamSimple implementations bypass the child provider-request Guard.",
			{ taskId, field: "model", details: { providers: extensionProviderIds } },
		);
	}
	const needsEvidence = capabilityIds.length > 0 || launchInput !== undefined || policy === "strict" || !!preflight.customModelDefinitions?.length;
	baseNode.agent = preflight.name;
	if (!needsEvidence) return baseNode as unknown as GraphNodeSpecV3;
	const effectiveLaunchInput=launchInput??(preflight.customModelDefinitions?.length?{requestedModel:preflight.model}:undefined);
 const launchBase = effectiveLaunchInput === undefined ? undefined : {
		schemaVersion: 1 as const,
		...effectiveLaunchInput,
  ...(preflight.customModelDefinitions?.length?{customModelDefinitions:preflight.customModelDefinitions}:{}),
		...(preflight.model === undefined ? {} : { resolvedModel: preflight.model }),
		...(preflight.thinking === undefined ? {} : { thinking: preflight.thinking }),
	};
	const launch = launchBase === undefined ? undefined : { ...launchBase, hintDigest: canonicalDigest(launchBase) };
	// Preserve historical exact-Agent bytes and digests when no adapter-only
	// field was used. Exact nodes with Pi execution hints still get evidence.
	const capabilityEntries: V3CapabilityEntryBinding[] = matches.map((entry) => ({
		capabilityId: entry.capabilityId,
		agent: entry.agent,
		entryDigest: entry.entryDigest,
	}));
	const bindingBase = {
		schemaVersion: 1 as const,
		resolution,
		...(requestedAgent === undefined ? {} : { requestedAgent }),
		resolvedAgent,
		capabilityIds,
		...(resolution === "temporary-agent" ? { unmatchedCapabilityIds: capabilityIds, ...(catalog ? { catalogDigest: catalog.digest } : {}) } : {}),
		...(resolution === "capability-catalog" ? { catalogDigest: catalog!.digest, capabilityEntries } : {}),
		agentDefinitionDigest: preflight.agentDefinitionDigest,
		// This proves the source-Agent authoring preflight only. The runtime
		// contract includes the frozen Graph Guard profile and dependency capsule,
		// and is observed independently from pi-subagents lifecycle evidence.
		admissionLaunchContractDigest: preflight.launchContractDigest,
		authoringNodeDigest: canonicalDigest(rawNode),
	};
	baseNode.binding = { ...bindingBase, bindingDigest: canonicalDigest(bindingBase) };
	if (launch) baseNode.launch = launch;
	return baseNode as unknown as GraphNodeSpecV3;
}

/** Bind append input before candidate compilation, Agent freeze, and mutation CAS publication. */
export async function bindGraphNodesV3(
	nodesValue: readonly GraphNodeAuthoringSpecV3[] | unknown,
	options: V3BindGraphNodesOptions = {},
): Promise<{ nodes: GraphNodeSpecV3[]; catalog?: V3BoundGraphSpec["catalog"] }> {
	if (!Array.isArray(nodesValue) || nodesValue.length === 0) bindingError("nodes must be a non-empty array.", { field: "nodes" });
	const nodes = canonicalClone(nodesValue, "Graph nodes") as unknown[];
	const policy = options.contractPolicy ?? "standard";
	if (policy !== "standard" && policy !== "strict") bindingError("contractPolicy must be 'standard' or 'strict'.", { field: "contractPolicy" });
	const needsCatalog = nodes.some((node) => isRecord(node) && (node.capabilityId !== undefined || node.requires !== undefined || node.fallbackAgents !== undefined));
	const catalog = await catalogFor(options, needsCatalog);
	return {
		nodes: await Promise.all(nodes.map((node) => bindNode(node, policy, catalog, options))),
		...(catalogSummary(catalog) ? { catalog: catalogSummary(catalog) } : {}),
	};
}

/**
 * Public Binding/Admission entry point. It removes authoring-only selection
 * fields, freezes exact Agents/catalog evidence/Pi hints, then invokes the pure
 * GraphSpec compiler. Recovery recompiles `compiled.sourceGraphSpec` and never
 * reads the ambient capability catalog.
 */
export async function bindGraphSpecV3(input: GraphSpecAuthoringV3 | unknown, options: V3BindingOptions = {}): Promise<V3BoundGraphSpec> {
	if (!isRecord(input)) bindingError("GraphSpec V3 authoring input must be an object.");
	if (input.parentToolAllowlist !== undefined) bindingError("parentToolAllowlist is reserved for trusted admission.");
	if (input.bindingPolicy !== undefined) bindingError("bindingPolicy is reserved for post-admission GraphSpecs.", { field: "bindingPolicy" });
	const policy = input.contractPolicy ?? "standard";
	if (policy !== "standard" && policy !== "strict") bindingError("contractPolicy must be 'standard' or 'strict'.", { field: "contractPolicy" });
	if (!Array.isArray(input.nodes)) bindingError("GraphSpec V3 authoring nodes must be an array.", { field: "nodes" });
	const authoring = canonicalClone(input, "GraphSpec V3 authoring input") as Record<string, unknown>;
	const boundNodes = authoring.nodes as unknown[];
	const needsCatalog = boundNodes.some((node) => isRecord(node) && (node.capabilityId !== undefined || node.requires !== undefined || node.fallbackAgents !== undefined));
	const catalog = await catalogFor(options, needsCatalog);
	const resolved = Object.fromEntries(Object.entries(authoring).filter(([field]) => field !== "contractPolicy"));
	if (options.parentToolAllowlist !== undefined) {
		resolved.permissionPolicy = authoring.permissionPolicy ?? "inherited";
		resolved.parentToolAllowlist = [...options.parentToolAllowlist];
	}
	const toolFilter = Array.isArray(authoring.toolFilter) && authoring.toolFilter.every((tool) => typeof tool === "string")
		? authoring.toolFilter as string[] : undefined;
	const toolEvidence: Array<{ agent: string; explicit: boolean; allowlist: string[] | undefined }> = [];
	resolved.nodes = await Promise.all(boundNodes.map((node) => bindNode(node, policy, catalog, { ...options, graphToolFilter: toolFilter }, toolEvidence)));
	if (resolved.permissionPolicy !== "inherited" && toolFilter?.includes("bash")) bindingError(
		"Graph toolFilter contains 'bash', but Graph Guard disables bash for every child node. Put permitted test/build commands in local_write node.validationCommands for Supervisor execution.",
		{ field: "toolFilter", details: { unavailableTools: ["bash"] } },
	);
	if (toolFilter?.length && toolEvidence.length === boundNodes.length && toolEvidence.every((entry) => entry.explicit && entry.allowlist)) {
		const available = new Set(toolEvidence.flatMap((entry) => entry.allowlist!));
		const unavailable = toolFilter.filter((tool) => !available.has(tool));
		if (unavailable.length) bindingError(
			`Graph toolFilter contains names unavailable to every selected Agent: [${unavailable.join(", ")}]. `
			+ `Union of Pi preflight tool allowlists: [${[...available].sort().join(", ")}]. `
			+ "Use registered tool names actually available to the selected Agents.",
			{ field: "toolFilter", details: { unavailableTools: unavailable, effectiveUnion: [...available].sort() } },
		);
	}
	if (policy === "strict") resolved.bindingPolicy = "strict";
	const compiled = compileGraphSpecV3(resolved);
	return {
		spec: structuredClone(compiled.sourceGraphSpec),
		compiled,
		...(catalogSummary(catalog) ? { catalog: catalogSummary(catalog) } : {}),
	};
}
