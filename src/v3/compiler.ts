import {validateLatestModelPolicy} from '../runtime/model-capabilities.ts';
import {validateCustomGraphModel} from "../runtime/custom-models.ts";
import { validateRuntimeFallbackPlan } from "./runtime-fallback.ts";
import { posix } from "node:path";
import { canonicalDigest, canonicalJson } from "./digests.ts";
import { GraphV3Error, graphV3Error } from "./errors.ts";
import type {
	CompiledGraphNodeV3,
	CompiledGraphProjectionV3,
	CompiledGraphV3,
	GraphSpecV3,
	GraphTopologyModeV3,
	GraphWhenV3,
	RetryPolicyV3,
	RetryReasonV3,
	ScopeEntryV3,
	SideEffectV3,
	V3CapabilityEntryBinding,
	V3NodeBinding,
	V3NodeLaunchHints,
	WorkspaceModeV3,
} from "./types.ts";
import { validateValidationCommandV3 } from "./validation-command.ts";

const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "graphId", "goal", "nodes", "maxConcurrency", "failFast", "workspace", "mode", "readOnly", "toolFilter", "bindingPolicy", "permissionPolicy", "parentToolAllowlist", "contextPolicy"]);
const NODE_FIELDS = new Set([
	"dependencyInputs", "resultContract", "evidenceFiles", "requiredMaterials", "taskId", "agent", "task", "dependsOn", "when", "inputArtifacts", "outputArtifact", "readScope", "writeScope", "sideEffect",
	"timeoutMs", "retryPolicy", "acceptance", "validationCommands", "binding", "launch", "readOnly",
]);
const RETRY_FIELDS = new Set(["maxAttempts", "retryOn", "backoffMs"]);
const SCOPE_FIELDS = new Set(["kind", "path"]);
const WHEN_FIELDS = new Set(["node", "status"]);
const BINDING_FIELDS = new Set([
	"fallbackAdmission", "schemaVersion", "resolution", "requestedAgent", "resolvedAgent", "capabilityIds", "unmatchedCapabilityIds", "catalogDigest",
	"capabilityEntries", "agentDefinitionDigest", "admissionLaunchContractDigest", "authoringNodeDigest", "bindingDigest",
]);
const CAPABILITY_ENTRY_FIELDS = new Set(["capabilityId", "agent", "entryDigest"]);
const GOVERNANCE_FIELDS = new Set([
	"model", "thinking", "routing", "planning", "routingProfile", "taskRisk", "producerRefs", "maxAuthorization", "resolvedModel",
	"contractPolicy", "context", "cwd", "toolBudget", "priority", "resourceClass", "allowDelete", "allowBash", "planningReceipt",
	"planningAdmissionId", "routingDecision", "modelCandidates", "maxProviderRetries", "providerBackoffMs", "modelDegradations",
]);
const SIDE_EFFECTS = new Set<SideEffectV3>(["none", "local_read", "local_write", "external_read", "external_write"]);
const RETRY_REASONS = new Set<RetryReasonV3>(["task_failed", "validation", "timeout", "workspace_conflict"]);
const WORKSPACES = new Set<WorkspaceModeV3>(["shadow"]);
const TOPOLOGY_MODES = new Set<GraphTopologyModeV3>(["sealed", "open"]);
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const MAX_CONCURRENCY_V3 = 6;
export const MAX_GRAPH_NODES_V3 = 512;
// taskId is embedded in several durable filenames. 200 leaves room for the
// longest recovery/quarantine suffix below the common POSIX NAME_MAX of 255.
export const MAX_TASK_ID_LENGTH_V3 = 200;
const PROTECTED_CONTROL_SEGMENTS = new Set([".git", ".pi-graph", ".pi-subagents"]);
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portablePathKey(value: string): string {
	return value.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");
}

function taskIdFromRecord(value: Record<string, unknown>): string | undefined {
	return typeof value.taskId === "string" ? value.taskId : undefined;
}

function rejectGovernanceFields(value: unknown, path = "$", inheritedTaskId?: string, seen = new Set<object>()): void {
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value)) graphV3Error("INVALID_GRAPH_SPEC", `GraphSpec contains a cyclic value at ${path}.`);
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			value.forEach((entry, index) => rejectGovernanceFields(entry, `${path}[${index}]`, inheritedTaskId, seen));
			return;
		}
		const record = value as Record<string, unknown>;
		const taskId = taskIdFromRecord(record) ?? inheritedTaskId;
		for (const [key, entry] of Object.entries(record)) {
			// Binding and launch are reserved post-admission records. Their exact
			// schemas and self-digests are validated below; public authoring fields
			// with the same routing names remain forbidden everywhere else.
			if (key === "binding" || key === "launch") continue;
			if (GOVERNANCE_FIELDS.has(key)) {
				graphV3Error("GOVERNANCE_FIELD_FORBIDDEN", `Governance field '${key}' has exited the V3 core.`, { taskId, field: key, details: { path } });
			}
			rejectGovernanceFields(entry, `${path}.${key}`, taskId, seen);
		}
	} finally {
		seen.delete(value);
	}
}

function assertAllowedFields(record: Record<string, unknown>, allowed: ReadonlySet<string>, location: string, taskId?: string): void {
	for (const field of Object.keys(record)) {
		if (!allowed.has(field)) graphV3Error("INVALID_FIELD", `Field '${field}' is not allowed in ${location}.`, { taskId, field });
	}
}

function requiredString(record: Record<string, unknown>, field: string, location: string, taskId?: string, maxLength?: number): string {
	const value = record[field];
	if (typeof value !== "string" || value.trim().length === 0) graphV3Error("INVALID_GRAPH_SPEC", `${location}.${field} must be a non-empty string.`, { taskId, field });
	if (maxLength !== undefined && value.length > maxLength) graphV3Error("INVALID_GRAPH_SPEC", `${location}.${field} must be at most ${maxLength} characters.`, { taskId, field });
	return value;
}

function optionalString(record: Record<string, unknown>, field: string, location: string, taskId?: string): string | undefined {
	if (!(field in record)) return undefined;
	return requiredString(record, field, location, taskId);
}

function stringArray(value: unknown, field: string, taskId?: string, allowEmpty = true): string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) graphV3Error("INVALID_GRAPH_SPEC", `${field} must be ${allowEmpty ? "an array" : "a non-empty array"}.`, { taskId, field });
	const output = value.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim().length === 0) graphV3Error("INVALID_GRAPH_SPEC", `${field}[${index}] must be a non-empty string.`, { taskId, field });
		return entry;
	});
	if (new Set(output).size !== output.length) graphV3Error("INVALID_GRAPH_SPEC", `${field} must not contain duplicate entries.`, { taskId, field });
	return output;
}

function requiredDigest(record: Record<string, unknown>, field: string, location: string, taskId: string): string {
	const value = requiredString(record, field, location, taskId, 64);
	if (!DIGEST_PATTERN.test(value)) graphV3Error("INVALID_BINDING", `${location}.${field} must be a lowercase SHA-256 digest.`, { taskId, field });
	return value;
}

function positiveSafeInteger(value: unknown, field: string, taskId: string, allowZero = false): number {
	if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
		graphV3Error("INVALID_BINDING", `${field} must be ${allowZero ? "a non-negative" : "a positive"} safe integer.`, { taskId, field });
	}
	return value as number;
}

function normalizeNodeLaunch(value: unknown, taskId: string): V3NodeLaunchHints | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) graphV3Error("INVALID_BINDING", "launch must be an object.", { taskId, field: "launch" });
	if (value.schemaVersion !== 1) graphV3Error("INVALID_BINDING", "launch requires schemaVersion: 1.", { taskId, field: "launch.schemaVersion" });
	if (value.customModelDefinitions !== undefined) {if(!Array.isArray(value.customModelDefinitions)||value.customModelDefinitions.length>64)graphV3Error("INVALID_BINDING","Invalid frozen custom models.");for(const m of value.customModelDefinitions)validateCustomGraphModel(m);}
 if(value.latestModelSelection!==undefined){const selection=value.latestModelSelection as any;if(!selection||selection.latestPolicy!=='latest-per-tier'||!selection.candidate)throw Error('Invalid latest model selection');validateLatestModelPolicy(selection,[selection.candidate]);}
 if (value.runtimeFallback !== undefined) validateRuntimeFallbackPlan(value.runtimeFallback);
	const hintDigest = requiredDigest(value, "hintDigest", "launch", taskId);
	const { hintDigest: _, ...rest } = value;
	const normalizedBase = { schemaVersion: 1 as const, ...rest };
	if (Object.keys(rest).length === 0) graphV3Error("INVALID_BINDING", "launch must contain at least one execution hint.", { taskId, field: "launch" });
	if (canonicalDigest(normalizedBase) !== hintDigest) graphV3Error("INVALID_BINDING", "launch.hintDigest does not match its normalized execution hints.", { taskId, field: "hintDigest" });
	return { ...normalizedBase, hintDigest } as V3NodeLaunchHints;
}

function normalizeCapabilityEntries(value: unknown, capabilityIds: readonly string[], resolvedAgent: string, taskId: string): V3CapabilityEntryBinding[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) graphV3Error("INVALID_BINDING", "binding.capabilityEntries must be a non-empty array.", { taskId, field: "capabilityEntries" });
	const entries = value.map((entry, index) => {
		if (!isRecord(entry)) graphV3Error("INVALID_BINDING", `binding.capabilityEntries[${index}] must be an object.`, { taskId, field: "capabilityEntries" });
		assertAllowedFields(entry, CAPABILITY_ENTRY_FIELDS, `binding.capabilityEntries[${index}]`, taskId);
		const capabilityId = requiredString(entry, "capabilityId", `binding.capabilityEntries[${index}]`, taskId, 200);
		if (!CAPABILITY_ID_PATTERN.test(capabilityId) || !capabilityIds.includes(capabilityId)) graphV3Error("INVALID_BINDING", `binding capability entry '${capabilityId}' is not a requested capability.`, { taskId, field: "capabilityEntries" });
		const agent = requiredString(entry, "agent", `binding.capabilityEntries[${index}]`, taskId, 500);
		if (agent !== resolvedAgent) graphV3Error("INVALID_BINDING", `binding capability entry '${capabilityId}' does not resolve to binding.resolvedAgent.`, { taskId, field: "capabilityEntries", details: { capabilityId, agent, resolvedAgent } });
		return {
			capabilityId,
			agent,
			entryDigest: requiredDigest(entry, "entryDigest", `binding.capabilityEntries[${index}]`, taskId),
		};
	});
	entries.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
	if (new Set(entries.map((entry) => entry.capabilityId)).size !== entries.length) graphV3Error("INVALID_BINDING", "binding.capabilityEntries must not contain duplicate capability IDs.", { taskId, field: "capabilityEntries" });
	return entries;
}

function normalizeNodeBinding(value: unknown, taskId: string, agent: string): V3NodeBinding | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) graphV3Error("INVALID_BINDING", "binding must be an object.", { taskId, field: "binding" });
	assertAllowedFields(value, BINDING_FIELDS, "node binding", taskId);
	if (value.schemaVersion !== 1) graphV3Error("INVALID_BINDING", "binding requires schemaVersion: 1.", { taskId, field: "binding.schemaVersion" });
	if (value.resolution !== "exact-agent" && value.resolution !== "capability-catalog" && value.resolution !== "temporary-agent") graphV3Error("INVALID_BINDING", "binding.resolution is invalid.", { taskId, field: "binding.resolution" });
	const requestedAgent = optionalString(value, "requestedAgent", "binding", taskId);
	const resolvedAgent = requiredString(value, "resolvedAgent", "binding", taskId, 500);
	if (resolvedAgent !== agent) graphV3Error("INVALID_BINDING", `Node '${taskId}' exact agent does not match binding.resolvedAgent.`, { taskId, field: "binding.resolvedAgent", details: { agent, resolvedAgent } });
	const capabilityIds = stringArray(value.capabilityIds, "binding.capabilityIds", taskId).sort();
	for (const capabilityId of capabilityIds) if (!CAPABILITY_ID_PATTERN.test(capabilityId)) graphV3Error("INVALID_BINDING", `Invalid binding capability ID '${capabilityId}'.`, { taskId, field: "capabilityIds" });
	const unmatchedCapabilityIds = value.unmatchedCapabilityIds === undefined ? undefined : stringArray(value.unmatchedCapabilityIds, "binding.unmatchedCapabilityIds", taskId, false).sort();
	if (unmatchedCapabilityIds?.some((capabilityId) => !capabilityIds.includes(capabilityId))) graphV3Error("INVALID_BINDING", "binding.unmatchedCapabilityIds must be a subset of capabilityIds.", { taskId, field: "unmatchedCapabilityIds" });
	const catalogDigest = value.catalogDigest === undefined ? undefined : requiredDigest(value, "catalogDigest", "binding", taskId);
	const capabilityEntries = normalizeCapabilityEntries(value.capabilityEntries, capabilityIds, resolvedAgent, taskId);
	if (value.resolution === "exact-agent" && (capabilityIds.length > 0 || catalogDigest || capabilityEntries || unmatchedCapabilityIds)) graphV3Error("INVALID_BINDING", "exact-agent binding must not claim capability-catalog evidence.", { taskId, field: "binding" });
	if (value.resolution === "capability-catalog" && (capabilityIds.length === 0 || !catalogDigest || !capabilityEntries || capabilityEntries.length !== capabilityIds.length || unmatchedCapabilityIds)) graphV3Error("INVALID_BINDING", "capability-catalog binding requires complete matched catalog evidence.", { taskId, field: "binding" });
	if (value.resolution === "temporary-agent" && (capabilityIds.length === 0 || !unmatchedCapabilityIds || unmatchedCapabilityIds.length !== capabilityIds.length)) graphV3Error("INVALID_BINDING", "temporary-agent binding must identify every unmatched capability.", { taskId, field: "binding" });
	const agentDefinitionDigest = requiredDigest(value, "agentDefinitionDigest", "binding", taskId);
	const admissionLaunchContractDigest = requiredDigest(value, "admissionLaunchContractDigest", "binding", taskId);
	const authoringNodeDigest = requiredDigest(value, "authoringNodeDigest", "binding", taskId);
	const bindingDigest = requiredDigest(value, "bindingDigest", "binding", taskId);
	const fallbackAdmission=value.fallbackAdmission;
 if(fallbackAdmission!==undefined) {
  if(!isRecord(fallbackAdmission)||fallbackAdmission.runtimeAutomaticFallback!==false||typeof fallbackAdmission.catalogDigest!=="string"||!DIGEST_PATTERN.test(fallbackAdmission.catalogDigest)||!Array.isArray(fallbackAdmission.candidates)||fallbackAdmission.candidates.length>9||fallbackAdmission.candidates.filter((c:any)=>c.state==="selected"&&c.agent===agent).length!==1)graphV3Error("INVALID_BINDING","Invalid fallback admission evidence",{taskId});
  for(const c of fallbackAdmission.candidates)if(!isRecord(c)||typeof c.agent!=="string"||typeof c.model!=="string"||!["unprobed","provider-unavailable","selected"].includes(String(c.state)))graphV3Error("INVALID_BINDING","Invalid fallback candidate",{taskId});
 }
 const normalizedBase = {
        ...(fallbackAdmission===undefined?{}:{fallbackAdmission}),
		schemaVersion: 1 as const,
		resolution: value.resolution,
		...(requestedAgent === undefined ? {} : { requestedAgent }),
		resolvedAgent,
		capabilityIds,
		...(unmatchedCapabilityIds === undefined ? {} : { unmatchedCapabilityIds }),
		...(catalogDigest === undefined ? {} : { catalogDigest }),
		...(capabilityEntries === undefined ? {} : { capabilityEntries }),
		agentDefinitionDigest,
		admissionLaunchContractDigest,
		authoringNodeDigest,
	};
	if (canonicalDigest(normalizedBase) !== bindingDigest) graphV3Error("INVALID_BINDING", "binding.bindingDigest does not match its normalized admission evidence.", { taskId, field: "bindingDigest" });
	return { ...normalizedBase, bindingDigest } as V3NodeBinding;
}

function normalizeRelativePath(value: string, field: string, taskId: string, allowDot: boolean): string {
	const errorCode = field.includes("Artifact") ? "INVALID_ARTIFACT" : "INVALID_SCOPE";
	const slashed = value.replaceAll("\\", "/");
	if (slashed.includes("\0") || slashed.startsWith("/") || /^[a-zA-Z]:\//u.test(slashed) || slashed.split("/").includes("..")) {
		graphV3Error(errorCode, `${field} must be a relative path that does not escape its root.`, { taskId, field, details: { path: value } });
	}
	const normalized = posix.normalize(slashed).replace(/^\.\//u, "").replace(/\/$/u, "");
	if (!normalized || (!allowDot && normalized === ".")) {
		graphV3Error(errorCode, `${field} must identify a non-empty relative path.`, { taskId, field, details: { path: value } });
	}
	const segments = normalized.split("/");
	const protectedSegment = segments.find((segment, index) => {
		const folded = portablePathKey(segment);
		return PROTECTED_CONTROL_SEGMENTS.has(folded)
			|| (folded === ".pi" && segments[index + 1] !== undefined && portablePathKey(segments[index + 1]!) === "agents");
	});
	if (protectedSegment) {
		graphV3Error(errorCode, `${field} may not target protected control path '${protectedSegment}'.`, { taskId, field, details: { path: value, protectedSegment } });
	}
	return normalized;
}

function normalizeArtifact(value: string, field: string, taskId: string): string {
	return normalizeRelativePath(value, field, taskId, false);
}

function normalizeScopes(value: unknown, field: "readScope" | "writeScope", taskId: string): ScopeEntryV3[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) graphV3Error("INVALID_SCOPE", `${field} must be an array.`, { taskId, field });
	const scopes = value.map((entry, index) => {
		if (!isRecord(entry)) graphV3Error("INVALID_SCOPE", `${field}[${index}] must be an object.`, { taskId, field });
		assertAllowedFields(entry, SCOPE_FIELDS, `${field}[${index}]`, taskId);
		if (entry.kind !== "file" && entry.kind !== "tree") graphV3Error("INVALID_SCOPE", `${field}[${index}].kind must be 'file' or 'tree'.`, { taskId, field });
		const path = requiredString(entry, "path", `${field}[${index}]`, taskId);
		return { kind: entry.kind, path: normalizeRelativePath(path, field, taskId, entry.kind === "tree") } satisfies ScopeEntryV3;
	});
	scopes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
	return scopes;
}

function scopeContains(scope: ScopeEntryV3, path: string): boolean {
	const scopePath = portablePathKey(scope.path);
	const candidatePath = portablePathKey(path);
	if (scope.kind === "file") return scopePath === candidatePath;
	return scopePath === "." || scopePath === candidatePath || candidatePath.startsWith(`${scopePath}/`);
}

function scopesOverlap(left: ScopeEntryV3, right: ScopeEntryV3): boolean {
	return scopeContains(left, right.path) || scopeContains(right, left.path);
}

function validateOwnWriteScopes(node: CompiledGraphNodeV3): void {
	for (let left = 0; left < node.writeScope.length; left += 1) {
		for (let right = left + 1; right < node.writeScope.length; right += 1) {
			if (scopesOverlap(node.writeScope[left]!, node.writeScope[right]!)) {
				graphV3Error("SCOPE_CONFLICT", `Node '${node.taskId}' has overlapping writeScope entries.`, {
					taskId: node.taskId,
					field: "writeScope",
					details: { left: node.writeScope[left], right: node.writeScope[right] },
				});
			}
		}
	}
}

function normalizeRetryPolicy(value: unknown, taskId: string): RetryPolicyV3 {
	if (value === undefined) return { maxAttempts: 1, retryOn: [], backoffMs: 5_000 };
	if (!isRecord(value)) graphV3Error("INVALID_RETRY_POLICY", "retryPolicy must be an object.", { taskId, field: "retryPolicy" });
	for (const field of Object.keys(value)) {
		if (!RETRY_FIELDS.has(field)) graphV3Error("INVALID_RETRY_POLICY", `retryPolicy field '${field}' is not allowed in V3.`, { taskId, field });
	}
	const maxAttempts = value.maxAttempts ?? 1;
	if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 5) {
		graphV3Error("INVALID_RETRY_POLICY", "retryPolicy.maxAttempts must be an integer from 1 through 5.", { taskId, field: "maxAttempts" });
	}
	const backoffMs = value.backoffMs ?? 5_000;
	if (!Number.isInteger(backoffMs) || (backoffMs as number) < 0) graphV3Error("INVALID_RETRY_POLICY", "retryPolicy.backoffMs must be a non-negative integer.", { taskId, field: "backoffMs" });
	const retryOn = value.retryOn === undefined ? [] : stringArray(value.retryOn, "retryPolicy.retryOn", taskId);
	for (const reason of retryOn) {
		if (!RETRY_REASONS.has(reason as RetryReasonV3)) graphV3Error("INVALID_RETRY_POLICY", `retryPolicy.retryOn contains unsupported reason '${reason}'.`, { taskId, field: "retryOn" });
	}
	return { maxAttempts: maxAttempts as number, retryOn: retryOn as RetryReasonV3[], backoffMs: backoffMs as number };
}

function normalizeWhen(value: unknown, taskId: string): GraphWhenV3 | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) graphV3Error("INVALID_GRAPH_SPEC", `Node '${taskId}' when must be { node, status }.`, { taskId, field: "when" });
	assertAllowedFields(value, WHEN_FIELDS, `node '${taskId}' when`, taskId);
	if (Object.keys(value).length !== WHEN_FIELDS.size) {
		graphV3Error("INVALID_GRAPH_SPEC", `Node '${taskId}' when must contain exactly 'node' and 'status'.`, { taskId, field: "when" });
	}
	const node = requiredString(value, "node", `node '${taskId}' when`, taskId);
	if (node === taskId) graphV3Error("INVALID_GRAPH_SPEC", `Node '${taskId}' when.node cannot reference itself.`, { taskId, field: "when" });
	if (value.status !== "accepted" && value.status !== "failed") {
		graphV3Error("INVALID_GRAPH_SPEC", `Node '${taskId}' when.status must be 'accepted' or 'failed'.`, { taskId, field: "when" });
	}
	return { node, status: value.status };
}

function normalizeValidationCommands(value: unknown, taskId: string, inherited = false): string[] {
	if (value === undefined) return [];
	const commands = stringArray(value, "validationCommands", taskId);
	for (const command of commands) {
		try {
			if (!inherited) validateValidationCommandV3(command);
			else if (!command.trim() || command.includes("\0")) throw new Error("Invalid shell command.");
		} catch (error) {
			throw new GraphV3Error("INVALID_VALIDATION_COMMAND", `Invalid validation command for node '${taskId}': ${error instanceof Error ? error.message : String(error)}`, {
				taskId,
				field: "validationCommands",
				cause: error,
			});
		}
	}
	return commands;
}

function topologicalSort(nodes: ReadonlyArray<{ taskId: string; dependsOn: string[] }>): string[] {
	const byId = new Map(nodes.map((node) => [node.taskId, node]));
	const indegree = new Map(nodes.map((node) => [node.taskId, node.dependsOn.length]));
	const dependents = new Map<string, string[]>();
	for (const node of nodes) {
		for (const dependency of node.dependsOn) {
			if (!byId.has(dependency)) graphV3Error("UNKNOWN_DEPENDENCY", `Node '${node.taskId}' depends on unknown task '${dependency}'.`, { taskId: node.taskId, field: "dependsOn", details: { dependency } });
			const list = dependents.get(dependency) ?? [];
			list.push(node.taskId);
			dependents.set(dependency, list);
		}
	}
	const ready = nodes.filter((node) => indegree.get(node.taskId) === 0).map((node) => node.taskId).sort();
	const order: string[] = [];
	while (ready.length > 0) {
		const taskId = ready.shift()!;
		order.push(taskId);
		for (const dependent of (dependents.get(taskId) ?? []).sort()) {
			const next = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, next);
			if (next === 0) {
				ready.push(dependent);
				ready.sort();
			}
		}
	}
	if (order.length !== nodes.length) {
		const cyclicTaskIds = nodes.map((node) => node.taskId).filter((taskId) => !order.includes(taskId)).sort();
		graphV3Error("DEPENDENCY_CYCLE", `Graph contains a dependency cycle involving: ${cyclicTaskIds.join(", ")}.`, { details: { taskIds: cyclicTaskIds } });
	}
	return order;
}

function ancestorMap(nodes: ReadonlyArray<CompiledGraphNodeV3>, order: string[]): Map<string, Set<string>> {
	const byId = new Map(nodes.map((node) => [node.taskId, node]));
	const ancestors = new Map<string, Set<string>>();
	for (const taskId of order) {
		const node = byId.get(taskId)!;
		const set = new Set<string>();
		for (const dependency of node.dependsOn) {
			set.add(dependency);
			for (const ancestor of ancestors.get(dependency) ?? []) set.add(ancestor);
		}
		ancestors.set(taskId, set);
	}
	return ancestors;
}

function artifactPathsOverlap(left: string, right: string): boolean {
	const foldedLeft = portablePathKey(left);
	const foldedRight = portablePathKey(right);
	return foldedLeft === foldedRight || foldedLeft.startsWith(`${foldedRight}/`) || foldedRight.startsWith(`${foldedLeft}/`);
}

function validateArtifacts(nodes: CompiledGraphNodeV3[], ancestors: Map<string, Set<string>>): void {
	const producers = new Map<string, string>();
	for (const node of nodes) {
		for (const [artifact, producer] of producers) {
			if (artifactPathsOverlap(artifact, node.outputArtifact)) {
				graphV3Error("INVALID_ARTIFACT", `Nodes '${producer}' and '${node.taskId}' produce overlapping artifact paths '${artifact}' and '${node.outputArtifact}'.`, { taskId: node.taskId, field: "outputArtifact", details: { producer, artifacts: [artifact, node.outputArtifact] } });
			}
		}
		producers.set(node.outputArtifact, node.taskId);
	}
	for (const node of nodes) {
		for (const artifact of node.inputArtifacts) {
			const producer = producers.get(artifact);
			if (!producer || !ancestors.get(node.taskId)?.has(producer)) {
				graphV3Error("INVALID_ARTIFACT", `Node '${node.taskId}' input artifact '${artifact}' is not produced by an upstream node.`, { taskId: node.taskId, field: "inputArtifacts", details: { artifact, producer } });
			}
		}
	}
}

function firstOverlap(left: ScopeEntryV3[], right: ScopeEntryV3[]): { left: ScopeEntryV3; right: ScopeEntryV3 } | undefined {
	for (const leftScope of left) {
		for (const rightScope of right) {
			if (scopesOverlap(leftScope, rightScope)) return { left: leftScope, right: rightScope };
		}
	}
	return undefined;
}

function validateCrossNodeScopes(nodes: CompiledGraphNodeV3[], ancestors: Map<string, Set<string>>): void {
	for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
			const left = nodes[leftIndex]!;
			const right = nodes[rightIndex]!;
			if (ancestors.get(left.taskId)?.has(right.taskId) || ancestors.get(right.taskId)?.has(left.taskId)) continue;
			const conflict = firstOverlap(left.writeScope, right.writeScope)
				?? firstOverlap(left.readScope, right.writeScope)
				?? firstOverlap(left.writeScope, right.readScope);
			if (conflict) {
				graphV3Error("SCOPE_CONFLICT", `Unordered nodes '${left.taskId}' and '${right.taskId}' have overlapping read/write scopes.`, {
					details: { taskIds: [left.taskId, right.taskId], left: conflict.left, right: conflict.right },
				});
			}
		}
	}
}

export function compileGraphSpecV3(input: unknown, options: { historical?: boolean } = {}): CompiledGraphV3 {
	rejectGovernanceFields(input);
	if (!isRecord(input)) graphV3Error("INVALID_GRAPH_SPEC", "GraphSpec V3 must be an object.");
	assertAllowedFields(input, TOP_LEVEL_FIELDS, "GraphSpec V3");
	if (input.schemaVersion !== 3) graphV3Error("INVALID_SCHEMA_VERSION", "GraphSpec V3 requires schemaVersion: 3.", { field: "schemaVersion", details: { received: input.schemaVersion } });
	const goal = requiredString(input, "goal", "GraphSpec V3", undefined, 2_000);
	const mode = input.mode ?? "sealed";
	if (typeof mode !== "string" || !TOPOLOGY_MODES.has(mode as GraphTopologyModeV3)) graphV3Error("INVALID_GRAPH_SPEC", "mode must be 'sealed' or 'open'.", { field: "mode" });
	if (!Array.isArray(input.nodes) || (input.nodes.length === 0 && mode !== "open")) graphV3Error("INVALID_GRAPH_SPEC", "GraphSpec V3 nodes must be non-empty unless mode is 'open'.", { field: "nodes" });
	if (input.nodes.length > MAX_GRAPH_NODES_V3) graphV3Error("INVALID_GRAPH_SPEC", `GraphSpec V3 supports at most ${MAX_GRAPH_NODES_V3} nodes.`, { field: "nodes" });
	const sourceGraphSpecDigest = canonicalDigest(input);
	const explicitGraphId = optionalString(input, "graphId", "GraphSpec V3");
	const graphId = explicitGraphId ?? `graph-${sourceGraphSpecDigest.slice(0, 16)}`;
	if (!GRAPH_ID_PATTERN.test(graphId)) {
		graphV3Error("INVALID_GRAPH_SPEC", "GraphSpec V3 graphId must start with an ASCII letter or digit and contain only ASCII letters, digits, '.', '_', or '-' (maximum 200 characters).", { field: "graphId" });
	}
	const maxConcurrency = input.maxConcurrency ?? 2;
	if (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1 || (maxConcurrency as number) > MAX_CONCURRENCY_V3) graphV3Error("INVALID_GRAPH_SPEC", `maxConcurrency must be an integer from 1 through ${MAX_CONCURRENCY_V3}.`, { field: "maxConcurrency" });
	const failFast = input.failFast ?? false;
	if (typeof failFast !== "boolean") graphV3Error("INVALID_GRAPH_SPEC", "failFast must be a boolean.", { field: "failFast" });
	const workspace = input.workspace ?? "shadow";
	if (typeof workspace !== "string" || !WORKSPACES.has(workspace as WorkspaceModeV3)) graphV3Error("INVALID_GRAPH_SPEC", "workspace must be 'shadow'.", { field: "workspace" });
	const contextPolicy = input.contextPolicy;
	if (contextPolicy !== undefined && contextPolicy !== "v1" && contextPolicy !== "disabled") graphV3Error("INVALID_GRAPH_SPEC", "Invalid contextPolicy.");
	const permissionPolicy = input.permissionPolicy;
	if (permissionPolicy !== undefined && permissionPolicy !== "inherited" && permissionPolicy !== "strict") graphV3Error("INVALID_GRAPH_SPEC", "Invalid permissionPolicy.");
	const parentToolAllowlist = input.parentToolAllowlist === undefined ? undefined : stringArray(input.parentToolAllowlist, "parentToolAllowlist");
	if (permissionPolicy === "inherited" && parentToolAllowlist === undefined) graphV3Error("INVALID_GRAPH_SPEC", "Inherited policy requires trusted parent tools.");
	const readOnly = input.readOnly ?? false;
	if (typeof readOnly !== "boolean") graphV3Error("INVALID_GRAPH_SPEC", "readOnly must be a boolean.", { field: "readOnly" });
	const toolFilter = input.toolFilter === undefined ? [] : stringArray(input.toolFilter, "toolFilter");
	for (const toolName of toolFilter) {
		if (!TOOL_NAME_PATTERN.test(toolName)) graphV3Error("INVALID_GRAPH_SPEC", `toolFilter contains invalid tool name '${toolName}'.`, { field: "toolFilter" });
	}
	toolFilter.sort();
	const bindingPolicy = input.bindingPolicy;
	if (bindingPolicy !== undefined && bindingPolicy !== "strict") graphV3Error("INVALID_BINDING", "bindingPolicy must be 'strict' when provided.", { field: "bindingPolicy" });

	const seenTaskIds = new Set<string>();
	const nodes: CompiledGraphNodeV3[] = input.nodes.map((rawNode, index) => {
		if (!isRecord(rawNode)) graphV3Error("INVALID_GRAPH_SPEC", `nodes[${index}] must be an object.`, { field: "nodes" });
		const candidateTaskId = taskIdFromRecord(rawNode);
		assertAllowedFields(rawNode, NODE_FIELDS, `nodes[${index}]`, candidateTaskId);
		const taskId = requiredString(rawNode, "taskId", `nodes[${index}]`, candidateTaskId, MAX_TASK_ID_LENGTH_V3);
		if (!TASK_ID_PATTERN.test(taskId)) graphV3Error("INVALID_TASK_ID", `Invalid taskId '${taskId}'.`, { taskId, field: "taskId" });
		if (seenTaskIds.has(taskId)) graphV3Error("DUPLICATE_TASK_ID", `Duplicate taskId '${taskId}'.`, { taskId, field: "taskId" });
		seenTaskIds.add(taskId);
		const agent = requiredString(rawNode, "agent", `nodes[${index}]`, taskId);
		const binding = normalizeNodeBinding(rawNode.binding, taskId, agent);
		const launch = normalizeNodeLaunch(rawNode.launch, taskId);
        if(launch?.latestModelSelection){const c=launch.latestModelSelection.candidate;if(launch.runtimeFallback&&(canonicalDigest(launch.runtimeFallback.approvedLatestIds)!==canonicalDigest(launch.latestModelSelection.approvedLatestIds)||canonicalDigest(launch.runtimeFallback.candidates[0])!==canonicalDigest(c)))graphV3Error('INVALID_BINDING','Latest selection and fallback policy differ.',{taskId});if(!binding||c.requestedModel!==launch.requestedModel||c.resolvedModel!==launch.resolvedModel||c.thinking!==launch.thinking||c.agentDefinitionDigest!==binding.agentDefinitionDigest||c.admissionLaunchContractDigest!==binding.admissionLaunchContractDigest)graphV3Error('INVALID_BINDING','Latest model selection does not match frozen launch.',{taskId});}
        if (launch?.runtimeFallback) {
            const first = launch.runtimeFallback.candidates[0]!;
            if (!binding || first.requestedModel !== launch.requestedModel || first.resolvedModel !== launch.resolvedModel
                || first.thinking !== launch.thinking || launch.runtimeFallback.candidates.some(c => c.agentDefinitionDigest !== binding.agentDefinitionDigest))
                graphV3Error("INVALID_BINDING", "Runtime fallback candidates do not match the frozen Agent and initial launch.", {taskId});
        }
		if (bindingPolicy === "strict" && (binding?.resolution !== "capability-catalog" || binding.capabilityIds.length === 0)) {
			graphV3Error("INVALID_BINDING", `Strict graph node '${taskId}' requires a capability-catalog binding.`, { taskId, field: "binding" });
		}
		const task = requiredString(rawNode, "task", `nodes[${index}]`, taskId);
		const dependsOn = rawNode.dependsOn === undefined ? [] : stringArray(rawNode.dependsOn, "dependsOn", taskId).sort();
		const when = normalizeWhen(rawNode.when, taskId);
        let dependencyInputs: CompiledGraphNodeV3["dependencyInputs"];
        if(rawNode.dependencyInputs!==undefined) {
         if(!Array.isArray(rawNode.dependencyInputs)||rawNode.dependencyInputs.length>64)graphV3Error("INVALID_GRAPH_SPEC","dependencyInputs must be an array of at most 64 selectors.",{taskId});
         dependencyInputs=rawNode.dependencyInputs.map((entry:unknown)=>{
          if(!isRecord(entry)||Object.keys(entry).some(k=>!["from","field","type","as"].includes(k))||typeof entry.from!=="string"||!dependsOn.includes(entry.from)||typeof entry.as!=="string"||!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(entry.as)||!["status","reason","evidenceFiles"].includes(String(entry.field))||entry.type!==(entry.field==="evidenceFiles"?"artifact-list":"string"))graphV3Error("INVALID_GRAPH_SPEC","Invalid typed direct-dependency selector.",{taskId});
          return entry as unknown as NonNullable<CompiledGraphNodeV3["dependencyInputs"]>[number];
         });
         if(new Set(dependencyInputs.map(e=>e.as)).size!==dependencyInputs.length)graphV3Error("INVALID_GRAPH_SPEC","Duplicate dependency alias.",{taskId});
        }

		const inputArtifacts = rawNode.inputArtifacts === undefined
			? []
			: stringArray(rawNode.inputArtifacts, "inputArtifacts", taskId).map((artifact) => normalizeArtifact(artifact, "inputArtifacts", taskId)).sort();
		const outputArtifact = rawNode.outputArtifact === undefined
			? normalizeArtifact(`${graphId}/${taskId}/out`, "outputArtifact", taskId)
			: normalizeArtifact(requiredString(rawNode, "outputArtifact", `nodes[${index}]`, taskId), "outputArtifact", taskId);
		if (rawNode.resultContract !== undefined && rawNode.resultContract !== "status-json") graphV3Error("INVALID_GRAPH_SPEC", "resultContract must be 'status-json'.", {taskId});
        let evidenceFiles: CompiledGraphNodeV3["evidenceFiles"];
        if (rawNode.evidenceFiles !== undefined) {
            if (!Array.isArray(rawNode.evidenceFiles) || rawNode.evidenceFiles.length > 64) graphV3Error("INVALID_GRAPH_SPEC", "evidenceFiles must be an array of at most 64 explicitly non-secret files.", {taskId});
            evidenceFiles = rawNode.evidenceFiles.map((entry: unknown) => {
                if (!isRecord(entry) || Object.keys(entry).some(k => !["path", "nonSecret"].includes(k)) || entry.nonSecret !== true || typeof entry.path !== "string" || !/^[^\\\x00]+$/.test(entry.path) || entry.path.startsWith("/") || entry.path.split("/").some(p => !p || p === "." || p === "..")) graphV3Error("INVALID_GRAPH_SPEC", "evidenceFiles entries require safe workspace-relative path and nonSecret:true.", {taskId});
                return {path: entry.path as string, nonSecret: true as const};
            });
            if (new Set(evidenceFiles.map(e => e.path)).size !== evidenceFiles.length) graphV3Error("INVALID_GRAPH_SPEC", "evidenceFiles paths must be unique.", {taskId});
        }
        const requiredMaterials = rawNode.requiredMaterials === undefined ? undefined : stringArray(rawNode.requiredMaterials, "requiredMaterials", taskId);
        if (requiredMaterials?.some(path => path.startsWith("/") || path.split(/[\\/]/u).includes("..") || path.includes("\0"))) graphV3Error("INVALID_SCOPE", "requiredMaterials must contain source-relative paths without traversal.", {taskId, field: "requiredMaterials"});
        const readScope = normalizeScopes(rawNode.readScope, "readScope", taskId);
		const writeScope = normalizeScopes(rawNode.writeScope, "writeScope", taskId);
		if (rawNode.readOnly !== undefined && typeof rawNode.readOnly !== "boolean") graphV3Error("INVALID_GRAPH_SPEC", "Node readOnly must be boolean.", { taskId });
		const nodeReadOnly = readOnly || rawNode.readOnly === true;
		const sideEffectValue = rawNode.sideEffect;
		if (permissionPolicy !== "inherited" && (sideEffectValue === "external_read" || sideEffectValue === "external_write")) {
			graphV3Error("UNSUPPORTED_SIDE_EFFECT", `Node '${taskId}' uses '${sideEffectValue}', but V3 MVP does not permit external side effects.`, { taskId, field: "sideEffect" });
		}
		if (typeof sideEffectValue !== "string" || !SIDE_EFFECTS.has(sideEffectValue as SideEffectV3)) graphV3Error("UNSUPPORTED_SIDE_EFFECT", `Node '${taskId}' has an unsupported sideEffect.`, { taskId, field: "sideEffect" });
		const timeoutMs = rawNode.timeoutMs;
		if (timeoutMs !== undefined && !options.historical) graphV3Error("INVALID_GRAPH_SPEC", "Graph execution is unlimited; remove timeoutMs before starting a new run.", { taskId, field: "timeoutMs" });
		if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) graphV3Error("INVALID_GRAPH_SPEC", "timeoutMs must be a positive integer when provided.", { taskId, field: "timeoutMs" });
		const retryPolicy = normalizeRetryPolicy(rawNode.retryPolicy, taskId);
		const acceptance = optionalString(rawNode, "acceptance", `nodes[${index}]`, taskId);
		const validationCommands = normalizeValidationCommands(rawNode.validationCommands, taskId, permissionPolicy === "inherited");
		if (sideEffectValue !== "local_write" && validationCommands.length > 0) {
			graphV3Error("INVALID_VALIDATION_COMMAND", `Node '${taskId}' may declare validationCommands only with sideEffect 'local_write'.`, {
				taskId,
				field: "validationCommands",
				details: { sideEffect: sideEffectValue },
			});
		}
		if (sideEffectValue === "local_write" && (writeScope.length === 0 || validationCommands.length === 0)) {
			graphV3Error("LOCAL_WRITE_REQUIREMENTS", `local_write node '${taskId}' requires non-empty writeScope and validationCommands.`, { taskId, details: { hasWriteScope: writeScope.length > 0, hasValidationCommands: validationCommands.length > 0 } });
		}
		if (nodeReadOnly && (sideEffectValue === "local_write" || sideEffectValue === "external_write")) {
			graphV3Error("INVALID_GRAPH_SPEC", `readOnly graph cannot contain local_write node '${taskId}'.`, { taskId, field: "readOnly" });
		}
		if (sideEffectValue !== "local_write" && writeScope.length > 0) {
			graphV3Error("INVALID_SCOPE", `Node '${taskId}' may declare writeScope only with sideEffect 'local_write'.`, { taskId, field: "writeScope", details: { sideEffect: sideEffectValue } });
		}
		const node: CompiledGraphNodeV3 = {
			taskId,
			agent,
			task,
			dependsOn,
            ...(dependencyInputs===undefined?{}:{dependencyInputs}),
			...(when === undefined ? {} : { when }),
			inputArtifacts,
			...(rawNode.resultContract === undefined ? {} : {resultContract: "status-json" as const}),
			...(evidenceFiles === undefined ? {} : {evidenceFiles}),
			outputArtifact,
			...(requiredMaterials === undefined ? {} : {requiredMaterials}),
			readScope,
			writeScope,
			sideEffect: sideEffectValue as SideEffectV3,
			...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
			retryPolicy,
			...(acceptance === undefined ? {} : { acceptance }),
			validationCommands,
			...(nodeReadOnly ? { readOnly: true as const } : {}),
			...(contextPolicy === undefined ? {} : { contextPolicy }),
			...(permissionPolicy === undefined ? {} : { permissionPolicy }),
			...(parentToolAllowlist === undefined ? {} : { parentToolAllowlist: [...parentToolAllowlist] }),
			...(toolFilter.length === 0 ? {} : { toolFilter: [...toolFilter] }),
			...(binding === undefined ? {} : { binding }),
			...(launch === undefined ? {} : { launch }),
		};
		validateOwnWriteScopes(node);
		return node;
	});
	for (const node of nodes) {
		if (node.when === undefined) continue;
		if (!seenTaskIds.has(node.when.node)) {
			graphV3Error("UNKNOWN_DEPENDENCY", `Node '${node.taskId}' when.node references unknown task '${node.when.node}'.`, { taskId: node.taskId, field: "when", details: { dependency: node.when.node } });
		}
		if (!node.dependsOn.includes(node.when.node)) {
			graphV3Error("INVALID_GRAPH_SPEC", `Node '${node.taskId}' when.node '${node.when.node}' must be listed in dependsOn.`, { taskId: node.taskId, field: "when" });
		}
	}

	const topologicalOrder = topologicalSort(nodes);
	const ancestors = ancestorMap(nodes, topologicalOrder);
	validateArtifacts(nodes, ancestors);
	validateCrossNodeScopes(nodes, ancestors);
	const nodeById = new Map(nodes.map((node) => [node.taskId, node]));
	const normalizedNodes = topologicalOrder.map((taskId) => nodeById.get(taskId)!);
	const projection: CompiledGraphProjectionV3 = {
		schemaVersion: 3,
		graphId,
		goal,
		nodes: normalizedNodes,
		topologicalOrder,
		maxConcurrency: maxConcurrency as number,
		failFast,
		workspace: workspace as WorkspaceModeV3,
		...(bindingPolicy === "strict" ? { bindingPolicy: "strict" as const } : {}),
	};
	const sourceGraphSpec = JSON.parse(canonicalJson(input)) as GraphSpecV3;
	return { ...projection, ...(mode === "open" ? { mode: "open" as const } : {}), sourceGraphSpec, sourceGraphSpecDigest, graphDigest: canonicalDigest(projection) };
}
