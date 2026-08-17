import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type {
	CompiledGraph,
	CompiledNode,
	GraphAcceptanceCriteria,
	GraphNodeSpec,
	GraphSpec,
	ScopeEntry,
	SubagentAcceptanceConfig,
	SubagentAcceptanceInput,
} from "./types.ts";
import { isReadOnlyRemoteToolName } from "./remote-tools.ts";
import { validateValidationCommand } from "./validation.ts";

export class GraphCompileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphCompileError";
	}
}

function assertRuntimeV2ValidationCommand(command: string, label: string): void {
	try { validateValidationCommand(command); } catch (error) { assert(false, `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`); }
}

export function validateGraphId(value: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new GraphCompileError("graphId contains unsupported characters.");
	return value;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new GraphCompileError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeGraphCriteria(value: unknown, label: string): GraphAcceptanceCriteria {
	assert(isRecord(value), `${label} must be a string, true with validationCommands, or { criteria: ["observable outcome"] }.`);
	assert(Object.keys(value).every((key) => key === "criteria"), `${label} supports only the top-level field 'criteria'; use { criteria: ["observable outcome"] }.`);
	assert(Array.isArray(value.criteria) && value.criteria.length > 0, `${label}.criteria must be a non-empty array.`);
	const criteria = value.criteria.map((criterion, index) => {
		if (typeof criterion === "string") {
			assert(Boolean(criterion.trim()), `${label}.criteria[${index}] must be a non-empty string or criterion object.`);
			return criterion.trim();
		}
		assert(isRecord(criterion), `${label}.criteria[${index}] must be a non-empty string or criterion object.`);
		assert(Object.keys(criterion).every((key) => key === "id" || key === "must"), `${label}.criteria[${index}] supports only { id?: string, must: string }; use a plain string for the common case.`);
		assert(typeof criterion.must === "string" && Boolean(criterion.must.trim()), `${label}.criteria[${index}].must must be a non-empty string.`);
		assert(criterion.id === undefined || (typeof criterion.id === "string" && Boolean(criterion.id.trim())), `${label}.criteria[${index}].id must be a non-empty string.`);
		return {
			...(criterion.id !== undefined ? { id: criterion.id.trim() } : {}),
			must: criterion.must.trim(),
		};
	});
	return { criteria };
}

function normalizeGraphAcceptance(value: unknown, label: string): GraphNodeSpec["acceptance"] {
	if (value === undefined || typeof value === "boolean") return value;
	if (typeof value === "string") {
		assert(Boolean(value.trim()), `${label} must be a non-empty string.`);
		return value.trim();
	}
	return normalizeGraphCriteria(value, label);
}

const CHILD_ACCEPTANCE_LEVELS = ["auto", "none", "attested", "checked", "verified"] as const;
const CHILD_ACCEPTANCE_BARE_LEVELS = ["auto", "attested", "checked", "verified"] as const;

function normalizeChildAcceptance(value: unknown, label: string): SubagentAcceptanceInput | undefined {
	if (value === undefined || value === false) return value;
	if (typeof value === "string") {
		assert((CHILD_ACCEPTANCE_BARE_LEVELS as readonly string[]).includes(value), `${label} must be false, a supported bare level, or an acceptance config object.`);
		return value as Exclude<SubagentAcceptanceInput, false | SubagentAcceptanceConfig>;
	}
	assert(isRecord(value), `${label} must be false, a supported bare level, or an acceptance config object.`);
	assert(value.level === undefined || (typeof value.level === "string" && (CHILD_ACCEPTANCE_LEVELS as readonly string[]).includes(value.level)), `${label}.level is unsupported.`);
	if (value.criteria === undefined) return value as SubagentAcceptanceConfig;
	assert(Array.isArray(value.criteria), `${label}.criteria must be an array.`);
	const criteria = value.criteria.map((criterion, index) => {
		if (typeof criterion === "string") {
			assert(Boolean(criterion.trim()), `${label}.criteria[${index}] must be a non-empty string or criterion object.`);
			return criterion.trim();
		}
		assert(isRecord(criterion), `${label}.criteria[${index}] must be a non-empty string or criterion object.`);
		assert(typeof criterion.id === "string" && Boolean(criterion.id.trim()), `${label}.criteria[${index}].id must be a non-empty string.`);
		assert(typeof criterion.must === "string" && Boolean(criterion.must.trim()), `${label}.criteria[${index}].must must be a non-empty string.`);
		return { ...criterion, id: criterion.id.trim(), must: criterion.must.trim() };
	});
	return { ...value, criteria } as SubagentAcceptanceConfig;
}

function canonicalPath(input: string, cwd: string): string {
	let candidate = resolve(cwd, input);
	const suffix: string[] = [];
	while (!existsSync(candidate)) {
		const parent = dirname(candidate);
		if (parent === candidate) break;
		suffix.unshift(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		candidate = parent;
	}
	const root = existsSync(candidate) ? realpathSync.native(candidate) : candidate;
	return resolve(root, ...suffix);
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeScope(entries: ScopeEntry[] | undefined, cwd: string, label: string): ScopeEntry[] {
	assert(entries === undefined || Array.isArray(entries), `${label} must be an array.`);
	const seen = new Set<string>();
	return (entries ?? []).map((entry, index) => {
		assert(entry && (entry.kind === "file" || entry.kind === "tree"), `${label}[${index}] must be { kind: 'file' | 'tree', path: '...' }; use 'file' for one file and 'tree' for a directory.`);
		assert(typeof entry.path === "string" && entry.path.trim(), `${label}[${index}].path is required.`);
			const path = canonicalPath(entry.path, cwd);
			assert(within(cwd, path), `${label}[${index}] escapes node cwd: ${entry.path}`);
			if (existsSync(path)) {
				const info = statSync(path);
				assert(entry.kind !== "file" || info.isFile(), `${label}[${index}] declares an existing non-file as kind 'file': ${entry.path}`);
				assert(entry.kind !== "tree" || info.isDirectory(), `${label}[${index}] declares an existing non-directory as kind 'tree': ${entry.path}`);
			}
		const key = `${entry.kind}:${path}`;
		assert(!seen.has(key), `${label} contains duplicate scope: ${entry.path}`);
		seen.add(key);
		return { kind: entry.kind, path };
	});
}

function scopeOverlaps(a: ScopeEntry, b: ScopeEntry): boolean {
	if (a.path === b.path) return true;
	if (a.kind === "tree" && within(a.path, b.path)) return true;
	if (b.kind === "tree" && within(b.path, a.path)) return true;
	return false;
}

function entersProtectedControlPath(cwd: string, path: string): boolean {
	const parts = relative(cwd, path).split(sep).filter(Boolean);
	return parts.some((part, index) => part === ".git" || part === ".pi-graph" || part === ".pi-subagents" || (part === "agents" && parts[index - 1] === ".pi"));
}

export function assertGraphScopesOutsideProtectedRoots(graph: Pick<CompiledGraph, "nodes">, protectedRoots: readonly string[]): void {
	if (protectedRoots.length === 0) return;
	for (const node of graph.nodes) {
		const roots = [...new Set(protectedRoots.map((root) => canonicalPath(root, node.cwd)))];
		for (const [label, scopes] of [["readScope", node.readScope], ["writeScope", node.writeScope]] as const) {
			for (const scope of scopes) {
				const protectedRoot = roots.find((root) => scopeOverlaps(scope, { kind: "tree", path: root }));
				assert(!protectedRoot, `${node.taskId}: ${label} intersects protected Graph runs root: ${protectedRoot}`);
			}
		}
	}
}

function artifactPathsConflict(left: string, right: string): boolean {
	if (left === right) return true;
	const leftToRight = relative(left, right);
	const rightToLeft = relative(right, left);
	return (!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) || (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft));
}

function typedOutputArtifact(taskId: string, type: NonNullable<GraphNodeSpec["output"]>["type"]): string {
	const extension: Record<NonNullable<GraphNodeSpec["output"]>["type"], string> = {
		file: "bin", text: "txt", json: "json", table: "json", "citation-set": "json", url: "txt", screenshot: "png",
		document: "md", "email-draft": "md", "connector-record": "json", decision: "json",
	};
	return `_typed/${taskId}.${extension[type]}`;
}

function normalizeOutput(value: GraphNodeSpec["output"], label: string): GraphNodeSpec["output"] {
	if (value === undefined) return undefined;
	assert(isRecord(value), `${label} must be an object.`);
	const types = ["file", "text", "json", "table", "citation-set", "url", "screenshot", "document", "email-draft", "connector-record", "decision"];
	assert(typeof value.type === "string" && types.includes(value.type), `${label}.type is unsupported.`);
	for (const field of ["path", "mediaType", "schema"] as const) assert(value[field] === undefined || (typeof value[field] === "string" && Boolean(value[field]!.trim())), `${label}.${field} must be a non-empty string.`);
	return { type: value.type, ...(value.path ? { path: value.path.trim() } : {}), ...(value.mediaType ? { mediaType: value.mediaType.trim() } : {}), ...(value.schema ? { schema: value.schema.trim() } : {}) };
}

function normalizeResourceScopes(value: GraphNodeSpec["resourceScopes"], label: string): NonNullable<GraphNodeSpec["resourceScopes"]> {
	assert(value === undefined || Array.isArray(value), `${label} must be an array.`);
	const kinds = ["url", "domain", "service", "account", "database", "table", "record", "mailbox", "calendar", "document", "browser-session", "connector", "action"];
	const seen = new Set<string>();
	return (value ?? []).map((entry, index) => {
		assert(isRecord(entry) && typeof entry.kind === "string" && kinds.includes(entry.kind), `${label}[${index}].kind is unsupported.`);
		assert(typeof entry.resource === "string" && Boolean(entry.resource.trim()), `${label}[${index}].resource is required.`);
		assert(entry.access === "read" || entry.access === "write", `${label}[${index}].access must be read or write.`);
		assert(entry.toolNames === undefined || (Array.isArray(entry.toolNames) && entry.toolNames.length > 0 && entry.toolNames.every((tool) => typeof tool === "string" && Boolean(tool.trim()))), `${label}[${index}].toolNames must be a non-empty array of tool names.`);
		assert(entry.toolInput === undefined || (isRecord(entry.toolInput) && Object.keys(entry.toolInput).length > 0), `${label}[${index}].toolInput must be a non-empty JSON object.`);
		if (entry.toolInput !== undefined) {
			try { JSON.stringify(entry.toolInput); } catch { assert(false, `${label}[${index}].toolInput must be JSON serializable.`); }
		}
		const toolNames = entry.toolNames?.map((tool) => tool.trim());
		assert(!toolNames || new Set(toolNames).size === toolNames.length, `${label}[${index}].toolNames contains duplicates.`);
		const normalized = { kind: entry.kind, resource: entry.resource.trim(), access: entry.access, ...(toolNames ? { toolNames } : {}), ...(entry.toolInput ? { toolInput: structuredClone(entry.toolInput) } : {}) } as NonNullable<GraphNodeSpec["resourceScopes"]>[number];
		const key = `${normalized.kind}:${normalized.access}:${normalized.resource}`;
		assert(!seen.has(key), `${label} contains duplicate resource scope '${normalized.resource}'.`);
		seen.add(key);
		return normalized;
	});
}

function isReachable(from: string, to: string, dependencies: Map<string, string[]>): boolean {
	const stack = [...(dependencies.get(to) ?? [])];
	const seen = new Set<string>();
	while (stack.length) {
		const current = stack.pop()!;
		if (current === from) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		stack.push(...(dependencies.get(current) ?? []));
	}
	return false;
}

function createGraphId(spec: GraphSpec): string {
	if (spec.graphId) return validateGraphId(spec.graphId);
	const hash = createHash("sha256").update(spec.goal).digest("hex").slice(0, 8);
	return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${hash}-${randomUUID().slice(0, 6)}`;
}

export function compileGraph(spec: GraphSpec, sourceCwd: string, maxSpawnBudget = 20, runtimeVersion: 1 | 2 = 1, protectedRoots: readonly string[] = []): CompiledGraph {
	assert(spec && spec.schemaVersion === 1, "GraphSpec schemaVersion must be 1.");
	assert(typeof spec.goal === "string" && spec.goal.trim().length > 0, "GraphSpec goal is required.");
	assert(Array.isArray(spec.nodes) && spec.nodes.length > 0, "GraphSpec nodes must not be empty.");
	assert(spec.workspace === undefined || ["auto", "shadow", "git"].includes(spec.workspace), "workspace must be 'auto', 'shadow', or 'git'.");
	assert(spec.failFast === undefined || typeof spec.failFast === "boolean", "failFast must be boolean.");
	assert(spec.contractPolicy === undefined || ["legacy", "strict"].includes(spec.contractPolicy), "contractPolicy must be 'legacy' or 'strict'.");
	const graphId = createGraphId(spec);
	const rootCwd = canonicalPath(sourceCwd, sourceCwd);
	const ids = new Set<string>();
	const artifacts = new Set<string>();
	const nodes: CompiledNode[] = spec.nodes.map((node, index) => {
		assert(node && typeof node === "object", `nodes[${index}] must be an object.`);
		assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(node.taskId), `Invalid taskId: ${node.taskId}`);
		assert(!ids.has(node.taskId), `Duplicate taskId: ${node.taskId}`);
		ids.add(node.taskId);
		assert(typeof node.agent === "string" && node.agent.trim(), `${node.taskId}: agent is required.`);
		assert(typeof node.task === "string" && node.task.trim(), `${node.taskId}: task is required.`);
		const acceptance = normalizeGraphAcceptance(node.acceptance, `${node.taskId}: acceptance`);
		const childAcceptance = normalizeChildAcceptance(node.childAcceptance, `${node.taskId}: childAcceptance`);
		if (spec.contractPolicy === "strict") {
			assert(typeof node.capabilityId === "string" && Boolean(node.capabilityId.trim()), `${node.taskId}: strict contract policy requires capabilityId.`);
			const observableAcceptance = typeof acceptance === "string"
				|| (Boolean(acceptance) && typeof acceptance === "object")
				|| (acceptance === true && (node.validationCommands?.length ?? 0) > 0);
			assert(observableAcceptance, `${node.taskId}: strict contract policy requires observable acceptance; use a non-empty string, { criteria: ["observable outcome"] }, or true together with non-empty validationCommands.`);
		}
		assert((node as GraphNodeSpec & { resolvedModel?: unknown }).resolvedModel === undefined, `${node.taskId}: resolvedModel is runtime provenance and cannot be supplied in GraphSpec.`);
		assert(node.model === undefined || (typeof node.model === "string" && node.model.trim()), `${node.taskId}: model must be a non-empty string.`);
		assert(node.taskRisk === undefined || ["low", "medium", "high"].includes(node.taskRisk), `${node.taskId}: taskRisk must be 'low', 'medium', or 'high'.`);
		assert(node.routingProfile === undefined || (typeof node.routingProfile === "string" && Boolean(node.routingProfile.trim())), `${node.taskId}: routingProfile must be a non-empty string.`);
		assert(node.resourceClass === undefined || (typeof node.resourceClass === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(node.resourceClass)), `${node.taskId}: resourceClass contains unsupported characters.`);
		for (const [field, value] of Object.entries({ idempotent: node.idempotent, parallelizable: node.parallelizable, atomic: node.atomic, progress: node.progress, allowDelete: node.allowDelete, allowBash: node.allowBash })) {
			assert(value === undefined || typeof value === "boolean", `${node.taskId}: ${field} must be boolean.`);
		}
		if (node.thinking !== undefined) {
			assert(Boolean(node.model), `${node.taskId}: thinking override requires an explicit model because pi-subagents RPC carries it as a model suffix.`);
			assert(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(node.thinking), `${node.taskId}: invalid thinking level.`);
			assert(!/(?:^|:)(?:off|minimal|low|medium|high|xhigh|max)$/.test(node.model!), `${node.taskId}: set thinking either in model suffix or thinking, not both.`);
		}
		const explicitModel = node.model ? (node.thinking ? `${node.model}:${node.thinking}` : node.model) : undefined;
		if (explicitModel && /(?:^|:)max$/.test(explicitModel)) {
			assert(Boolean(spec.graphId), `${node.taskId}: max authorization requires an explicit graphId for stable task binding.`);
			// Frozen legacy: max-authorization admission was archived with the governance modules;
			// the compiled node simply carries maxAuthorization through for read-only legacy runs.
		}
		const output = normalizeOutput(node.output, `${node.taskId}.output`);
		assert(node.outputArtifact !== undefined || output !== undefined, `${node.taskId}: outputArtifact or typed output is required.`);
		if (node.outputArtifact?.trim() && output?.path?.trim()) {
			assert(normalize(node.outputArtifact.trim()) === normalize(output.path.trim()), `${node.taskId}: outputArtifact and output.path must resolve to the same artifact path when both are provided.`);
		}
		const outputArtifactInput = node.outputArtifact?.trim() || output?.path?.trim() || typedOutputArtifact(node.taskId, output!.type);
		const outputArtifact = normalize(outputArtifactInput);
			assert(outputArtifact !== "." && !isAbsolute(outputArtifact) && !relative(".", outputArtifact).startsWith(".."), `${node.taskId}: outputArtifact must be a relative file path inside the graph artifact directory.`);
			assert(![...artifacts].some((artifact) => artifactPathsConflict(artifact, outputArtifact)), `Conflicting outputArtifact path after normalization: ${outputArtifact}`);
		artifacts.add(outputArtifact);
		assert(node.dependsOn === undefined || Array.isArray(node.dependsOn), `${node.taskId}: dependsOn must be an array.`);
		const dependsOn = [...(node.dependsOn ?? [])];
		assert(node.producerRefs === undefined || Array.isArray(node.producerRefs), `${node.taskId}: producerRefs must be an array.`);
		const producerRefs = [...(node.producerRefs ?? [])];
		assert(producerRefs.every((value) => typeof value === "string" && Boolean(value.trim())), `${node.taskId}: producerRefs entries must be non-empty strings.`);
		assert(new Set(producerRefs).size === producerRefs.length, `${node.taskId}: duplicate producerRefs are not allowed.`);
		assert(dependsOn.every((value) => typeof value === "string" && value.trim()), `${node.taskId}: dependsOn entries must be non-empty strings.`);
		assert(new Set(dependsOn).size === dependsOn.length, `${node.taskId}: duplicate dependencies are not allowed.`);
		assert(node.inputArtifacts === undefined || Array.isArray(node.inputArtifacts), `${node.taskId}: inputArtifacts must be an array.`);
		for (const inputArtifact of node.inputArtifacts ?? []) {
			assert(typeof inputArtifact === "string" && inputArtifact.trim(), `${node.taskId}: inputArtifacts entries must be non-empty strings.`);
		}
		const inputArtifacts = (node.inputArtifacts ?? []).map((artifact) => normalize(artifact.trim()));
		for (const inputArtifact of inputArtifacts) assert(inputArtifact !== "." && !isAbsolute(inputArtifact) && !relative(".", inputArtifact).startsWith(".."), `${node.taskId}: inputArtifact must stay inside the graph artifact directory: ${inputArtifact}`);
		assert(new Set(inputArtifacts).size === inputArtifacts.length, `${node.taskId}: duplicate inputArtifacts are not allowed.`);
			assert(node.validationCommands === undefined || (Array.isArray(node.validationCommands) && node.validationCommands.every((command) => typeof command === "string" && command.trim())), `${node.taskId}: validationCommands must be an array of non-empty strings.`);
		if (runtimeVersion === 2) for (const [commandIndex, command] of (node.validationCommands ?? []).entries()) assertRuntimeV2ValidationCommand(command, `${node.taskId}.validationCommands[${commandIndex}]`);
		assert(["none", "local_read", "local_write", "external_read", "external_write"].includes(node.sideEffect), `${node.taskId}: invalid sideEffect.`);
		const cwd = canonicalPath(node.cwd ?? rootCwd, rootCwd);
		assert(within(rootCwd, cwd), `${node.taskId}: cwd must stay within graph source cwd.`);
		const readScope = normalizeScope(node.readScope, cwd, `${node.taskId}.readScope`);
		const writeScope = normalizeScope(node.writeScope, cwd, `${node.taskId}.writeScope`);
		assert([...readScope, ...writeScope].every((scope) => !entersProtectedControlPath(cwd, scope.path)), `${node.taskId}: scope may not directly target protected Graph runtime, Agent, or Git control paths.`);
		const resourceScopes = normalizeResourceScopes(node.resourceScopes, `${node.taskId}.resourceScopes`);
		if (resourceScopes.some((scope) => scope.access === "write")) assert(node.sideEffect === "external_write", `${node.taskId}: a write resourceScope requires sideEffect 'external_write'.`);
		if (resourceScopes.length > 0) assert(node.sideEffect === "external_read" || node.sideEffect === "external_write", `${node.taskId}: resourceScopes require an external sideEffect.`);
		if (node.sideEffect === "external_read") {
			assert(resourceScopes.every((scope) => scope.access === "read"), `${node.taskId}: external_read cannot declare write resourceScopes.`);
			if (spec.contractPolicy === "strict") assert(resourceScopes.some((scope) => (scope.toolNames?.length ?? 0) > 0), `${node.taskId}: strict external_read requires declared resourceScope.toolNames.`);
			if (runtimeVersion === 2) {
				for (const [scopeIndex, scope] of resourceScopes.entries()) {
					if (!scope.toolNames?.length) continue;
					assert(scope.toolInput && Object.keys(scope.toolInput).length > 0, `${node.taskId}: Runtime v2 external_read resourceScopes[${scopeIndex}] must bind the exact toolInput.`);
					assert(scope.toolNames.every(isReadOnlyRemoteToolName), `${node.taskId}: Runtime v2 external_read permits only conservatively named read-only tools.`);
				}
			}
		}
		for (let left = 0; left < writeScope.length; left += 1) {
			for (let right = left + 1; right < writeScope.length; right += 1) {
				assert(!scopeOverlaps(writeScope[left]!, writeScope[right]!), `${node.taskId}: writeScope entries must not overlap each other.`);
			}
		}
		if (node.sideEffect === "local_write") assert(writeScope.length > 0, `${node.taskId}: local_write requires writeScope.`);
		if (node.sideEffect !== "local_write") assert(writeScope.length === 0, `${node.taskId}: writeScope requires sideEffect 'local_write'.`);
		if (node.allowBash) assert(false, `${node.taskId}: child Bash is disabled because shell path and network authority cannot be durably confined; use supervisor validationCommands for trusted deterministic checks.`);
		if (node.allowBash && node.routingProfile) assert(false, `${node.taskId}: controlled model routing cannot be combined with child Bash; use supervisor validationCommands or remove routingProfile and run the trusted workflow explicitly.`);
		if (writeScope.length > 2 || writeScope.some((entry) => entry.kind === "tree")) {
			assert(node.atomic === true, `${node.taskId}: broad writeScope requires atomic: true.`);
			assert(Boolean(node.scopeJustification?.trim()), `${node.taskId}: broad writeScope requires scopeJustification.`);
		}
		if (node.sideEffect === "local_write") assert((node.validationCommands?.length ?? 0) > 0, `${node.taskId}: local_write requires at least one deterministic validationCommand.`);
			assert(node.retryPolicy === undefined || (Boolean(node.retryPolicy) && typeof node.retryPolicy === "object" && !Array.isArray(node.retryPolicy)), `${node.taskId}: retryPolicy must be an object.`);
			const retryPolicy = { maxAttempts: 1, maxProviderRetries: 0, backoffMs: 1_000, providerBackoffMs: 5_000, ...node.retryPolicy };
		assert(Number.isInteger(retryPolicy.maxAttempts) && retryPolicy.maxAttempts >= 1 && retryPolicy.maxAttempts <= 5, `${node.taskId}: retry maxAttempts must be 1..5.`);
		assert(Number.isInteger(retryPolicy.maxProviderRetries) && retryPolicy.maxProviderRetries >= 0 && retryPolicy.maxProviderRetries <= 5, `${node.taskId}: retry maxProviderRetries must be 0..5.`);
		assert(typeof retryPolicy.backoffMs === "number" && Number.isFinite(retryPolicy.backoffMs) && retryPolicy.backoffMs >= 0 && retryPolicy.backoffMs <= 300_000, `${node.taskId}: retry backoffMs must be 0..300000.`);
		assert(typeof retryPolicy.providerBackoffMs === "number" && Number.isFinite(retryPolicy.providerBackoffMs) && retryPolicy.providerBackoffMs >= 0 && retryPolicy.providerBackoffMs <= 300_000, `${node.taskId}: retry providerBackoffMs must be 0..300000.`);
		if (retryPolicy.retryOn) assert(Array.isArray(retryPolicy.retryOn) && retryPolicy.retryOn.every((value) => ["dispatch", "timeout", "failed", "validation"].includes(value)), `${node.taskId}: retryOn contains an unsupported value.`);
		if (node.timeoutMs !== undefined) assert(Number.isInteger(node.timeoutMs) && node.timeoutMs >= 1_000 && node.timeoutMs <= 7_200_000, `${node.taskId}: timeoutMs must be 1000..7200000.`);
		if (node.priority !== undefined) assert(Number.isFinite(node.priority), `${node.taskId}: priority must be a finite number.`);
		if (node.toolBudget !== undefined) {
			assert(node.toolBudget && typeof node.toolBudget === "object" && Number.isInteger(node.toolBudget.hard) && node.toolBudget.hard > 0, `${node.taskId}: toolBudget.hard must be a positive integer.`);
			assert(node.toolBudget.soft === undefined || (Number.isInteger(node.toolBudget.soft) && node.toolBudget.soft >= 0 && node.toolBudget.soft <= node.toolBudget.hard), `${node.taskId}: toolBudget.soft must be 0..hard.`);
			assert(node.toolBudget.block === undefined || node.toolBudget.block === "*" || (Array.isArray(node.toolBudget.block) && node.toolBudget.block.every((value) => typeof value === "string" && value.trim())), `${node.taskId}: toolBudget.block must be '*' or an array of tool names.`);
		}
		if (node.context !== undefined) validateContext(node.context, `${node.taskId}.context`);
		if (node.sideEffect === "external_read" && spec.contractPolicy === "strict") assert(resourceScopes.some((scope) => scope.access === "read"), `${node.taskId}: strict external_read requires a read resourceScope.`);
		if (node.sideEffect === "external_write") {
			assert(runtimeVersion === 1, `${node.taskId}: Graph Runtime v2 does not execute external_write until a trusted approval broker, idempotency gateway, and Supervisor readback journal are available.`);
			assert(spec.contractPolicy === "strict", `${node.taskId}: external_write requires contractPolicy 'strict'.`);
			assert(resourceScopes.some((scope) => scope.access === "write"), `${node.taskId}: external_write requires a write resourceScope.`);
			const action = node.externalAction;
			assert(isRecord(action), `${node.taskId}: external_write requires externalAction.`);
			for (const field of ["service", "action", "target", "approvalRef", "expectedState"] as const) assert(typeof action[field] === "string" && Boolean(action[field]!.trim()), `${node.taskId}: externalAction.${field} is required.`);
			assert(action.account === undefined || (typeof action.account === "string" && Boolean(action.account.trim())), `${node.taskId}: externalAction.account must be a non-empty string.`);
			assert(action.idempotencyKey === undefined || (typeof action.idempotencyKey === "string" && Boolean(action.idempotencyKey.trim())), `${node.taskId}: externalAction.idempotencyKey must be a non-empty string.`);
			assert(action.requiresApproval === true, `${node.taskId}: external_write requires explicit approval evidence.`);
			assert(typeof action.reversible === "boolean", `${node.taskId}: externalAction.reversible must be boolean.`);
			assert(action.verifyByReadback === true, `${node.taskId}: external_write requires verifyByReadback.`);
			if (action.reversible) assert(typeof action.compensation === "string" && Boolean(action.compensation.trim()), `${node.taskId}: a reversible external action requires compensation instructions.`);
			if (!action.reversible) {
				assert(retryPolicy.maxAttempts === 1, `${node.taskId}: irreversible external writes cannot retry automatically.`);
				assert(retryPolicy.maxProviderRetries === 0, `${node.taskId}: irreversible external writes cannot use provider retries.`);
			}
			if (retryPolicy.maxAttempts > 1 || retryPolicy.maxProviderRetries > 0 || node.idempotent === true) assert(Boolean(action.idempotencyKey?.trim()), `${node.taskId}: retried or idempotent external writes require externalAction.idempotencyKey.`);
		}
		if (node.sideEffect !== "external_write") assert(node.externalAction === undefined, `${node.taskId}: externalAction requires sideEffect 'external_write'.`);
		if (node.allowBash) {
			assert(retryPolicy.maxAttempts === 1, `${node.taskId}: bash-enabled local writes cannot retry automatically.`);
			assert(retryPolicy.maxProviderRetries === 0, `${node.taskId}: bash-enabled local writes cannot use provider retries automatically.`);
		}
		return {
			...node,
			...(output ? { output } : {}),
			...(acceptance !== undefined ? { acceptance } : {}),
			...(childAcceptance !== undefined ? { childAcceptance } : {}),
			outputArtifact,
			inputArtifacts,
			cwd,
			dependsOn,
			producerRefs,
			readScope,
			writeScope,
			resourceScopes,
			retryPolicy,
			idempotent: node.idempotent ?? node.sideEffect !== "external_write",
			parallelizable: node.parallelizable ?? true,
		};
	});
	const dependencies = new Map(nodes.map((node) => [node.taskId, node.dependsOn]));
	assertGraphScopesOutsideProtectedRoots({ nodes }, protectedRoots);
	const artifactProducer = new Map(nodes.map((node) => [node.outputArtifact, node.taskId]));
	for (const node of nodes) {
		for (const dependency of node.dependsOn) {
			assert(ids.has(dependency), `${node.taskId}: unknown dependency '${dependency}'.`);
			assert(dependency !== node.taskId, `${node.taskId}: self dependency is not allowed.`);
		}
		for (const artifact of node.inputArtifacts ?? []) {
			assert(artifacts.has(artifact), `${node.taskId}: unknown inputArtifact '${artifact}'.`);
			const producer = artifactProducer.get(artifact)!;
			assert(producer !== node.taskId && isReachable(producer, node.taskId, dependencies), `${node.taskId}: inputArtifact '${artifact}' requires a dependency path from producer '${producer}'.`);
		}
		for (const producer of node.producerRefs ?? []) {
			assert(ids.has(producer), `${node.taskId}: unknown producerRef '${producer}'.`);
			assert(producer !== node.taskId && isReachable(producer, node.taskId, dependencies), `${node.taskId}: producerRef '${producer}' must be an upstream dependency.`);
		}
	}
	const indegree = new Map(nodes.map((node) => [node.taskId, node.dependsOn.length]));
	const order: string[] = [];
	const queue = nodes.filter((node) => indegree.get(node.taskId) === 0).map((node) => node.taskId).sort();
	while (queue.length) {
		const id = queue.shift()!;
		order.push(id);
		for (const node of nodes) {
			if (!node.dependsOn.includes(id)) continue;
			const next = indegree.get(node.taskId)! - 1;
			indegree.set(node.taskId, next);
			if (next === 0) queue.push(node.taskId);
		}
		queue.sort();
	}
	assert(order.length === nodes.length, "GraphSpec contains a dependency cycle.");
	for (let left = 0; left < nodes.length; left += 1) {
		for (let right = left + 1; right < nodes.length; right += 1) {
			const a = nodes[left]!;
			const b = nodes[right]!;
			if (isReachable(a.taskId, b.taskId, dependencies) || isReachable(b.taskId, a.taskId, dependencies)) continue;
			assert(!a.writeScope.some((x) => b.writeScope.some((y) => scopeOverlaps(x, y))), `Unordered writers '${a.taskId}' and '${b.taskId}' have overlapping writeScope.`);
		}
	}
	const worstCaseSpawns = nodes.reduce((sum, node) => sum + node.retryPolicy.maxAttempts * (1 + (node.retryPolicy.maxProviderRetries ?? 0)), 0);
	assert(worstCaseSpawns <= maxSpawnBudget, `Worst-case ${worstCaseSpawns} child launches exceed spawn budget ${maxSpawnBudget}.`);
	const maxConcurrency = spec.maxConcurrency ?? 2;
	assert(Number.isInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 6, "maxConcurrency must be 1..6.");
	if (spec.context !== undefined) validateContext(spec.context, "context");
	if (spec.workspace === "git") {
		assert(nodes.filter((node) => node.sideEffect === "local_write").length <= 1, "Explicit git workspace supports at most one local_write node; use workspace 'auto' for sequential writers.");
		assert(nodes.every((node) => (node.retryPolicy.maxProviderRetries ?? 0) === 0), "Explicit git workspace cannot use provider retries; use workspace 'auto' or 'shadow' so each provider dispatch can start from a clean sealed workspace.");
		assert(nodes.every((node) => !node.routingProfile), "Explicit git workspace cannot use controlled model routing because its provider retry budget is resolved at runtime; use workspace 'auto' or 'shadow'.");
	}
	return {
		...spec,
		projectionVersion: 1,
		...("projectionVersion" in spec && !("spawnBudget" in spec) ? {} : { spawnBudget: maxSpawnBudget }),
		graphId,
		goal: spec.goal.trim(),
		nodes,
		maxConcurrency,
		failFast: spec.failFast ?? false,
		workspace: spec.workspace ?? "auto",
		topologicalOrder: order,
		compiledAt: new Date().toISOString(),
	};
}

function validateContext(value: unknown, label: string): void {
	assert(Boolean(value) && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
	const context = value as Record<string, unknown>;
	for (const key of ["packId", "revision", "digest"]) assert(typeof context[key] === "string" && Boolean((context[key] as string).trim()), `${label}.${key} is required.`);
	assert(context.decisionRevision === undefined || (typeof context.decisionRevision === "string" && Boolean(context.decisionRevision.trim())), `${label}.decisionRevision must be a non-empty string.`);
}
