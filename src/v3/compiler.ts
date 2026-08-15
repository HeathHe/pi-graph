import { posix } from "node:path";
import { canonicalDigest, canonicalJson } from "./digests.ts";
import { GraphV3Error, graphV3Error } from "./errors.ts";
import type {
	ChildAcceptanceV3,
	CompiledGraphNodeV3,
	CompiledGraphProjectionV3,
	CompiledGraphV3,
	GraphSpecV3,
	RetryPolicyV3,
	RetryReasonV3,
	ScopeEntryV3,
	SideEffectV3,
	WorkspaceModeV3,
} from "./types.ts";
import { validateValidationCommandV3 } from "./validation-command.ts";

const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "graphId", "goal", "nodes", "maxConcurrency", "failFast", "workspace"]);
const NODE_FIELDS = new Set([
	"taskId", "agent", "task", "dependsOn", "inputArtifacts", "outputArtifact", "readScope", "writeScope", "sideEffect",
	"timeoutMs", "retryPolicy", "acceptance", "validationCommands", "childAcceptance",
]);
const RETRY_FIELDS = new Set(["maxAttempts", "retryOn", "backoffMs"]);
const CHILD_ACCEPTANCE_FIELDS = new Set(["criteria"]);
const SCOPE_FIELDS = new Set(["kind", "path"]);
const GOVERNANCE_FIELDS = new Set([
	"model", "thinking", "routing", "planning", "routingProfile", "taskRisk", "producerRefs", "maxAuthorization", "resolvedModel",
	"contractPolicy", "context", "cwd", "toolBudget", "priority", "resourceClass", "allowDelete", "allowBash", "planningReceipt",
	"planningAdmissionId", "routingDecision", "modelCandidates", "maxProviderRetries", "providerBackoffMs", "modelDegradations",
]);
const SIDE_EFFECTS = new Set<SideEffectV3>(["none", "local_read", "local_write"]);
const RETRY_REASONS = new Set<RetryReasonV3>(["task_failed", "validation", "timeout", "workspace_conflict"]);
const WORKSPACES = new Set<WorkspaceModeV3>(["auto", "shadow", "git"]);
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const MAX_CONCURRENCY_V3 = 64;
const PROTECTED_CONTROL_SEGMENTS = new Set([".git", ".pi-graph", ".pi", ".pi-agents", ".pi-subagents"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	const protectedSegment = normalized.split("/").find((segment) => PROTECTED_CONTROL_SEGMENTS.has(segment));
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
	scopes.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
	return scopes;
}

function scopeContains(scope: ScopeEntryV3, path: string): boolean {
	if (scope.kind === "file") return scope.path === path;
	return scope.path === "." || scope.path === path || path.startsWith(`${scope.path}/`);
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

function normalizeChildAcceptance(value: unknown, taskId: string): ChildAcceptanceV3 | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) graphV3Error("INVALID_GRAPH_SPEC", "childAcceptance must be an object.", { taskId, field: "childAcceptance" });
	assertAllowedFields(value, CHILD_ACCEPTANCE_FIELDS, "childAcceptance", taskId);
	return { criteria: stringArray(value.criteria, "childAcceptance.criteria", taskId) };
}

function normalizeValidationCommands(value: unknown, taskId: string): string[] {
	if (value === undefined) return [];
	const commands = stringArray(value, "validationCommands", taskId);
	for (const command of commands) {
		try {
			validateValidationCommandV3(command);
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
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
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

export function compileGraphSpecV3(input: unknown): CompiledGraphV3 {
	rejectGovernanceFields(input);
	if (!isRecord(input)) graphV3Error("INVALID_GRAPH_SPEC", "GraphSpec V3 must be an object.");
	assertAllowedFields(input, TOP_LEVEL_FIELDS, "GraphSpec V3");
	if (input.schemaVersion !== 3) graphV3Error("INVALID_SCHEMA_VERSION", "GraphSpec V3 requires schemaVersion: 3.", { field: "schemaVersion", details: { received: input.schemaVersion } });
	const goal = requiredString(input, "goal", "GraphSpec V3", undefined, 2_000);
	if (!Array.isArray(input.nodes) || input.nodes.length === 0) graphV3Error("INVALID_GRAPH_SPEC", "GraphSpec V3 nodes must be a non-empty array.", { field: "nodes" });
	const sourceGraphSpecDigest = canonicalDigest(input);
	const explicitGraphId = optionalString(input, "graphId", "GraphSpec V3");
	const graphId = explicitGraphId ?? `graph-${sourceGraphSpecDigest.slice(0, 16)}`;
	if (graphId.length > 200) graphV3Error("INVALID_GRAPH_SPEC", "GraphSpec V3 graphId must be at most 200 characters.", { field: "graphId" });
	const maxConcurrency = input.maxConcurrency ?? 2;
	if (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1 || (maxConcurrency as number) > MAX_CONCURRENCY_V3) graphV3Error("INVALID_GRAPH_SPEC", `maxConcurrency must be an integer from 1 through ${MAX_CONCURRENCY_V3}.`, { field: "maxConcurrency" });
	const failFast = input.failFast ?? false;
	if (typeof failFast !== "boolean") graphV3Error("INVALID_GRAPH_SPEC", "failFast must be a boolean.", { field: "failFast" });
	const workspace = input.workspace ?? "auto";
	if (typeof workspace !== "string" || !WORKSPACES.has(workspace as WorkspaceModeV3)) graphV3Error("INVALID_GRAPH_SPEC", "workspace must be 'auto', 'shadow', or 'git'.", { field: "workspace" });

	const seenTaskIds = new Set<string>();
	const nodes: CompiledGraphNodeV3[] = input.nodes.map((rawNode, index) => {
		if (!isRecord(rawNode)) graphV3Error("INVALID_GRAPH_SPEC", `nodes[${index}] must be an object.`, { field: "nodes" });
		const candidateTaskId = taskIdFromRecord(rawNode);
		assertAllowedFields(rawNode, NODE_FIELDS, `nodes[${index}]`, candidateTaskId);
		const taskId = requiredString(rawNode, "taskId", `nodes[${index}]`, candidateTaskId);
		if (!TASK_ID_PATTERN.test(taskId)) graphV3Error("INVALID_TASK_ID", `Invalid taskId '${taskId}'.`, { taskId, field: "taskId" });
		if (seenTaskIds.has(taskId)) graphV3Error("DUPLICATE_TASK_ID", `Duplicate taskId '${taskId}'.`, { taskId, field: "taskId" });
		seenTaskIds.add(taskId);
		const agent = requiredString(rawNode, "agent", `nodes[${index}]`, taskId);
		const task = requiredString(rawNode, "task", `nodes[${index}]`, taskId);
		const dependsOn = rawNode.dependsOn === undefined ? [] : stringArray(rawNode.dependsOn, "dependsOn", taskId).sort();
		const inputArtifacts = rawNode.inputArtifacts === undefined
			? []
			: stringArray(rawNode.inputArtifacts, "inputArtifacts", taskId).map((artifact) => normalizeArtifact(artifact, "inputArtifacts", taskId)).sort();
		const outputArtifact = rawNode.outputArtifact === undefined
			? normalizeArtifact(`${graphId}/${taskId}/out`, "outputArtifact", taskId)
			: normalizeArtifact(requiredString(rawNode, "outputArtifact", `nodes[${index}]`, taskId), "outputArtifact", taskId);
		const readScope = normalizeScopes(rawNode.readScope, "readScope", taskId);
		const writeScope = normalizeScopes(rawNode.writeScope, "writeScope", taskId);
		const sideEffectValue = rawNode.sideEffect;
		if (sideEffectValue === "external_read" || sideEffectValue === "external_write") {
			graphV3Error("UNSUPPORTED_SIDE_EFFECT", `Node '${taskId}' uses '${sideEffectValue}', but V3 MVP does not permit external side effects.`, { taskId, field: "sideEffect" });
		}
		if (typeof sideEffectValue !== "string" || !SIDE_EFFECTS.has(sideEffectValue as SideEffectV3)) graphV3Error("UNSUPPORTED_SIDE_EFFECT", `Node '${taskId}' has an unsupported sideEffect.`, { taskId, field: "sideEffect" });
		const timeoutMs = rawNode.timeoutMs;
		if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) graphV3Error("INVALID_GRAPH_SPEC", "timeoutMs must be a positive integer when provided.", { taskId, field: "timeoutMs" });
		const retryPolicy = normalizeRetryPolicy(rawNode.retryPolicy, taskId);
		const acceptance = optionalString(rawNode, "acceptance", `nodes[${index}]`, taskId);
		const validationCommands = normalizeValidationCommands(rawNode.validationCommands, taskId);
		const childAcceptance = normalizeChildAcceptance(rawNode.childAcceptance, taskId);
		if (sideEffectValue === "local_write" && (writeScope.length === 0 || validationCommands.length === 0)) {
			graphV3Error("LOCAL_WRITE_REQUIREMENTS", `local_write node '${taskId}' requires non-empty writeScope and validationCommands; childAcceptance cannot replace validationCommands.`, { taskId, details: { hasWriteScope: writeScope.length > 0, hasValidationCommands: validationCommands.length > 0 } });
		}
		if (sideEffectValue !== "local_write" && writeScope.length > 0) {
			graphV3Error("INVALID_SCOPE", `Node '${taskId}' may declare writeScope only with sideEffect 'local_write'.`, { taskId, field: "writeScope", details: { sideEffect: sideEffectValue } });
		}
		const node: CompiledGraphNodeV3 = {
			taskId,
			agent,
			task,
			dependsOn,
			inputArtifacts,
			outputArtifact,
			readScope,
			writeScope,
			sideEffect: sideEffectValue as SideEffectV3,
			...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
			retryPolicy,
			...(acceptance === undefined ? {} : { acceptance }),
			validationCommands,
			...(childAcceptance === undefined ? {} : { childAcceptance }),
		};
		validateOwnWriteScopes(node);
		return node;
	});

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
	};
	const sourceGraphSpec = JSON.parse(canonicalJson(input)) as GraphSpecV3;
	return { ...projection, sourceGraphSpec, sourceGraphSpecDigest, graphDigest: canonicalDigest(projection) };
}
