import { safeBytes } from "./evidence-files.ts";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { atomicWriteFile, atomicWriteJson, syncDirectory } from "./durable.ts";
import { canonicalDigest, canonicalJson } from "./digests.ts";
import { graphV3Error } from "./errors.ts";
import { readV3WorkspaceEvidence, writeV3WorkspaceEvidence, v3NodeAttemptDir } from "./attempt.ts";
import type {
	CompiledGraphNodeV3,
	CompiledGraphV3,
	ScopeEntryV3,
	V3FileDigest,
	V3WorkspaceEvidence,
} from "./types.ts";

export interface V3WorkspaceInput {
	runInstanceId: string;
	graphId: string;
	node: CompiledGraphNodeV3;
	attempt: number;
	runDir: string;
	sourceCwd: string;
	workspace?: "shadow";
	protectedSourceRoots?: string[];
	artifacts?: Array<{ name: string; source: string; expectedDigest?: string }>;
}

export interface V3PreparedWorkspace {
	workspaceCwd: string;
	kind: "shadow";
	evidence: V3WorkspaceEvidence;
	inspectWrites(): Promise<V3FileDigest[]>;
	apply(signal?: AbortSignal): Promise<V3FileDigest[]>;
	cleanup(): Promise<void>;
}

/** Runtime contract consumed by pi-graph-guard inside the isolated child. */
export interface V3NodeContract {
	schemaVersion: 1;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptDir: string;
	sourceCwd: string;
	workspaceCwd: string;
	readScope: Array<{ kind: "file" | "tree"; path: string }>;
	writeScope: Array<{ kind: "file" | "tree"; path: string }>;
	sideEffect: CompiledGraphNodeV3["sideEffect"];
	allowBash: boolean;
	permissionPolicy?: "inherited" | "strict";
	contextPolicy?: "v1" | "disabled";
	contextTools?: string[];
	parentToolAllowlist?: string[];
	readOnly: boolean;
	toolFilter: string[];
	/** Per-provider-request output-token ceiling enforced inside the child. */
	maxTokens?: number;
	writeBaseline: Record<string, string | null>;
	readBaseline: Record<string, string | null>;
	protectedSourceRoots: string[];
	protectedWorkspaceRoots: string[];
	inputBaseline: Record<string, { sourcePath: string; digest: string | null }>;
}

export class V3WorkspaceConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "V3WorkspaceConflictError";
	}
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveScope(scope: ScopeEntryV3, sourceCwd: string): { kind: "file" | "tree"; path: string } {
	const path = isAbsolute(scope.path) ? scope.path : resolve(sourceCwd, scope.path);
	return { kind: scope.kind, path };
}

export async function digestFile(path: string): Promise<string | undefined> {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function copyIfPresent(source: string, target: string): Promise<void> {
	if (!existsSync(source)) return;
	const info = await lstat(source);
	if (info.isSymbolicLink()) throw new V3WorkspaceConflictError(`Graph scope is a symbolic link: ${source}`);
	await mkdir(dirname(target), { recursive: true });
	if (info.isDirectory()) {
		await cp(source, target, { recursive: true, force: false, dereference: false });
	} else if (info.isFile()) {
		await cp(source, target, { recursive: false, force: false });
	}
}

const PROTECTED_CONTROL_NAMES = new Set([".git", ".pi-graph", ".pi-subagents"]);

function protectedControlDirectory(path: string): boolean {
	const name = basename(path);
	return PROTECTED_CONTROL_NAMES.has(name) || (name === "agents" && basename(dirname(path)) === ".pi");
}

async function rejectSymlinks(path: string): Promise<void> {
	const info = await lstat(path).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!info) return;
	if (info.isSymbolicLink()) throw new V3WorkspaceConflictError(`Graph scope traverses a symbolic link: ${path}`);
	if (!info.isDirectory()) return;
	const entries = await readdir(path, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isSymbolicLink()) throw new V3WorkspaceConflictError(`Graph scope contains a symbolic link: ${join(path, entry.name)}`);
	}
}

interface Baseline {
	path: string;
	digest: string | undefined;
}

async function scopeBaseline(scope: { kind: "file" | "tree"; path: string }): Promise<Baseline[]> {
	const entries: Baseline[] = [];
	if (scope.kind === "file") {
		const digest = await digestFile(scope.path);
		entries.push({ path: scope.path, digest });
		return entries;
	}
	const info = await lstat(scope.path).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!info || !info.isDirectory()) {
		entries.push({ path: scope.path, digest: undefined });
		return entries;
	}
	const files = await filesUnder(scope.path);
	for (const file of files) {
		if (file.includes(`.pi-graph${sep}`)) continue;
		entries.push({ path: file, digest: await digestFile(file) });
	}
	return entries;
}

async function filesUnder(directory: string): Promise<string[]> {
	const output: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new V3WorkspaceConflictError(`Graph scope contains a symbolic link: ${full}`);
			if (entry.isDirectory()) {
				if (protectedControlDirectory(full)) continue;
				await walk(full);
			} else if (entry.isFile()) {
				output.push(full);
			}
		}
	};
	await walk(directory);
	return output.sort();
}

const GRAPH_GUARD_PATH = fileURLToPath(new URL("../../extensions/pi-graph-guard.ts", import.meta.url));
interface MaterializedAgent {
	name: string;
	filePath?: string;
	runner?: { type?: unknown; [key: string]: unknown };
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	[key: string]: unknown;
}

interface FrozenAgentSnapshot {
	schemaVersion: 2;
	taskId: string;
	agent: string;
	/** Durable proof that dispatch stays inside the guarded native Pi child. */
	runnerType: "pi";
	source?: string;
	definitionDigest: string;
	serializedDigest: string;
	guardDigest: string;
	configuredExtensions: Array<{ path: string; digest: string }>;
	serialized: string;
	synthetic?: true;
}

export interface V3FrozenAgentPublication {
	taskId: string;
	agent: string;
	dev: number;
	ino: number;
	serializedDigest: string;
}

interface ResolvedFrozenAgent {
	snapshot: FrozenAgentSnapshot;
	/** Present only when this call won the no-replace publication. */
	publication?: V3FrozenAgentPublication;
}

const AGENT_PROFILE_QUEUES = new Map<string, Promise<void>>();

let agentInternals: Promise<{
	discoverAgents(cwd: string, scope: "both"): { agents: MaterializedAgent[] };
	serializeAgent(agent: MaterializedAgent): string;
	agentDefinitionDigest(agent: MaterializedAgent): string;
}> | undefined;

async function loadAgentInternals() {
 const agents = await import('../runtime/agents.ts');
 return agents as unknown as {discoverAgents(cwd:string,scope:"both"):{agents:MaterializedAgent[]};serializeAgent(agent:MaterializedAgent):string;agentDefinitionDigest(agent:MaterializedAgent):string};
}

function frozenAgentPath(runDir: string, taskId: string): string {
	return join(runDir, "agent-profiles", `${taskId}.json`);
}

function validateFrozenAgent(value: unknown, taskId: string, agent: string): FrozenAgentSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Frozen Agent profile for '${taskId}' is malformed.`);
	const record = value as Partial<FrozenAgentSnapshot>;
	const configuredExtensions = record.configuredExtensions;
	if (record.schemaVersion !== 2 || record.taskId !== taskId || record.agent !== agent
		|| record.runnerType !== "pi"
		|| typeof record.definitionDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.definitionDigest)
		|| typeof record.serializedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.serializedDigest)
		|| typeof record.guardDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.guardDigest)
		|| !Array.isArray(configuredExtensions)
		|| configuredExtensions.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
			|| Object.keys(entry).length !== 2 || !("path" in entry) || !("digest" in entry)
			|| typeof entry.path !== "string" || entry.path.length > 4_096 || !isAbsolute(entry.path)
			|| resolve(entry.path) !== entry.path || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/u.test(entry.digest))
		|| configuredExtensions.some((entry, index) => index > 0 && configuredExtensions[index - 1]!.path.localeCompare(entry.path) >= 0)
		|| typeof record.serialized !== "string" || record.serialized.length === 0
		|| createHash("sha256").update(record.serialized).digest("hex") !== record.serializedDigest) {
		throw new Error(`Frozen Agent profile for '${taskId}' failed identity validation.`);
	}
	return record as FrozenAgentSnapshot;
}

/** Existing frozen-profile validation plus exact Graph Guard bytes; arbitrary
 * configured extensions may execute during startup and cannot authorize replay. */
export async function controlledV3FrozenAgent(runDir: string, node: CompiledGraphNodeV3): Promise<boolean> {
 const snapshot = await readFrozenAgent(runDir, node.taskId, node.agent);
 if (!snapshot || snapshot.runnerType !== "pi" || snapshot.definitionDigest !== node.binding?.agentDefinitionDigest) return false;
 const guardDigest = createHash("sha256").update(await readFile(GRAPH_GUARD_PATH)).digest("hex");
 return snapshot.guardDigest === guardDigest && snapshot.configuredExtensions.every(e => basename(e.path) === "pi-graph-guard.ts" && e.digest === guardDigest);
}

async function readFrozenAgent(runDir: string, taskId: string, agent: string): Promise<FrozenAgentSnapshot | undefined> {
	try {
		return validateFrozenAgent(JSON.parse(await readFile(frozenAgentPath(runDir, taskId), "utf8")), taskId, agent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function frozenContextTools(runDir:string,node:CompiledGraphNodeV3,workspaceCwd:string):Promise<string[]> {
 if(node.contextPolicy!=="v1")return [];
 const snapshot=await readFrozenAgent(runDir,node.taskId,node.agent);
 if(!snapshot || snapshot.synthetic || snapshot.configuredExtensions.length)return [];
 assertFrozenAgentMatchesBinding(snapshot,node);
 const internals=await loadAgentInternals();
 const agent=internals.discoverAgents(workspaceCwd,"both").agents.find(a=>a.name===node.agent);
 if(!agent || internals.serializeAgent(agent)!==snapshot.serialized)return [];
 const module=await import('../runtime/launch-contract.ts');
 const plan=module.resolvePiLaunchToolPlan({tools:agent.tools,cwd:workspaceCwd,agentName:agent.name});
 return ["read","grep","find","ls"].filter(name=>plan.effectiveToolAllowlist.includes(name)
  && (node.parentToolAllowlist===undefined||node.parentToolAllowlist.includes(name))
  && (!node.toolFilter?.length||node.toolFilter.includes(name)));
}

function assertFrozenAgentMatchesBinding(snapshot: FrozenAgentSnapshot, node: CompiledGraphNodeV3): void {
	const expected = node.binding?.agentDefinitionDigest;
	if (expected !== undefined && snapshot.definitionDigest !== expected) {
		throw new Error(
			`Agent '${node.agent}' definition changed after capability binding for V3 node '${node.taskId}' `
			+ `(expected ${expected}, frozen ${snapshot.definitionDigest}).`,
		);
	}
}

function assertNativePiRunner(agent: MaterializedAgent, taskId: string): void {
	if (agent.runner === undefined || agent.runner?.type === "pi") return;
	const runnerType = typeof agent.runner?.type === "string" ? agent.runner.type : "invalid";
	throw new Error(
		`Agent '${agent.name}' uses runner.type='${runnerType}' for V3 node '${taskId}'; `
		+ "pi-graph requires the native Pi runner so Graph Guard can enforce the node contract.",
	);
}

function toolExtensionPath(value: string): boolean {
	return value.includes("/") || value.endsWith(".ts") || value.endsWith(".js");
}

async function freezeExtensionEntry(input: string, sourceCwd: string, taskId: string): Promise<{ path: string; digest: string }> {
	const requestedPath = isAbsolute(input) ? resolve(input) : resolve(sourceCwd, input);
	const requestedInfo = await lstat(requestedPath).catch((error) => {
		throw new Error(`Agent extension '${input}' cannot be frozen for V3 node '${taskId}': ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	});
	if (requestedInfo.isSymbolicLink()) throw new Error(`Agent extension cannot be a symbolic link for V3 node '${taskId}': ${requestedPath}`);
	const path = await realpath(requestedPath);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
		throw new Error(`Agent extension must be one regular, non-linked entry-point file for V3 node '${taskId}': ${path}`);
	}
	const digest = await digestFile(path);
	if (!digest) throw new Error(`Agent extension disappeared while it was frozen for V3 node '${taskId}': ${path}`);
	return { path, digest };
}

async function freezeConfiguredAgentExtensions(
	agent: MaterializedAgent,
	sourceCwd: string,
	taskId: string,
): Promise<{ guarded: MaterializedAgent; evidence: Array<{ path: string; digest: string }> }> {
	const byInput = new Map<string, { path: string; digest: string }>();
	const freeze = async (input: string): Promise<string> => {
		const existing = byInput.get(input);
		if (existing) return existing.path;
		const frozen = await freezeExtensionEntry(input, sourceCwd, taskId);
		byInput.set(input, frozen);
		return frozen.path;
	};
	const tools = await Promise.all((agent.tools ?? []).map(async (tool) => toolExtensionPath(tool) ? freeze(tool) : tool));
	const extensions = await Promise.all((agent.extensions ?? []).map(freeze));
	const subagentOnlyExtensions = await Promise.all((agent.subagentOnlyExtensions ?? []).map(freeze));
	const evidence = [...new Map([...byInput.values()].map((entry) => [entry.path, entry])).values()]
		.sort((left, right) => left.path.localeCompare(right.path));
	return {
		guarded: {
			...agent,
			...(agent.tools === undefined ? {} : {tools: [...new Set([...tools.filter(tool => tool !== "contact_supervisor" && tool !== "subagent_supervisor" && !tool.startsWith("intercom")), "graph_mailbox"]) ]}),
			// Explicit empty disables ambient extensions inside every Graph child.
			extensions,
			subagentOnlyExtensions: [...new Set([...subagentOnlyExtensions, GRAPH_GUARD_PATH])],
		},
		evidence,
	};
}

async function verifyFrozenAgentExtensions(snapshot: FrozenAgentSnapshot, taskId: string): Promise<void> {
	for (const extension of snapshot.configuredExtensions) {
		const current = await freezeExtensionEntry(extension.path, dirname(extension.path), taskId);
		if (current.path !== extension.path || current.digest !== extension.digest) {
			throw new Error(`Frozen Agent extension changed for V3 node '${taskId}': ${extension.path}`);
		}
	}
}

async function resolveFrozenAgent(
	runDir: string,
	sourceCwd: string,
	node: CompiledGraphNodeV3,
	allowSynthetic: boolean,
): Promise<ResolvedFrozenAgent> {
	const existing = await readFrozenAgent(runDir, node.taskId, node.agent);
	if (existing) {
		if (existing.synthetic && !allowSynthetic) throw new Error(`Agent '${node.agent}' has no production-resolved frozen profile.`);
		assertFrozenAgentMatchesBinding(existing, node);
		await verifyFrozenAgentExtensions(existing, node.taskId);
		return { snapshot: existing };
	}
	const internals = await loadAgentInternals();
	// The real Runner performs public pi-subagents preflight before dispatch.
	// A deterministic fallback keeps the workspace primitive independently
	// testable without turning this private compatibility import into authority.
	// Match Pi's normal Agent universe. Binding admission used the same scope;
	// comparing its digest below closes the catalog/preflight/freeze TOCTOU gap.
	const resolved = internals.discoverAgents(sourceCwd, "both").agents.find((candidate) => candidate.name === node.agent);
	if (!resolved && !allowSynthetic) throw new Error(`Agent '${node.agent}' is not available for V3 node '${node.taskId}'.`);
	const discovered = resolved ?? {
		name: node.agent,
		description: `Graph-isolated execution role for ${node.agent}.`,
		systemPrompt: "Complete only the assigned graph node inside its declared contract.",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
	};
	if (discovered.filePath) {
		const info = await lstat(discovered.filePath);
		if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error(`Agent definition must be a single regular file: ${discovered.filePath}`);
	}
	assertNativePiRunner(discovered, node.taskId);
	const guardDigest = createHash("sha256").update(await readFile(GRAPH_GUARD_PATH)).digest("hex");
	const frozenExtensions = await freezeConfiguredAgentExtensions(discovered, sourceCwd, node.taskId);
	const guarded = frozenExtensions.guarded;
	const serialized = internals.serializeAgent(guarded);
	const snapshot: FrozenAgentSnapshot = {
		schemaVersion: 2,
		taskId: node.taskId,
		agent: node.agent,
		runnerType: "pi",
		...(typeof discovered.source === "string" ? { source: discovered.source } : {}),
		definitionDigest: internals.agentDefinitionDigest(discovered),
		serializedDigest: createHash("sha256").update(serialized).digest("hex"),
		guardDigest,
		configuredExtensions: frozenExtensions.evidence,
		serialized,
		...(!resolved ? { synthetic: true as const } : {}),
	};
	assertFrozenAgentMatchesBinding(snapshot, node);
	try {
		const { createDurableJson } = await import("./durable.ts");
		const path = frozenAgentPath(runDir, node.taskId);
		await mkdir(dirname(path), { recursive: true });
		await createDurableJson(path, snapshot);
		const published = await lstat(path);
		if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1) {
			throw new Error(`Frozen Agent profile publication for '${node.taskId}' did not produce a single regular file.`);
		}
		return {
			snapshot,
			publication: {
				taskId: node.taskId,
				agent: node.agent,
				dev: published.dev,
				ino: published.ino,
				serializedDigest: snapshot.serializedDigest,
			},
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const raced = await readFrozenAgent(runDir, node.taskId, node.agent);
		if (!raced) throw new Error(`Frozen Agent profile race for '${node.taskId}' could not be resolved.`);
		assertFrozenAgentMatchesBinding(raced, node);
		await verifyFrozenAgentExtensions(raced, node.taskId);
		return { snapshot: raced };
	}
}

async function materializeFrozenAgent(runDir: string, sourceCwd: string, workspaceCwd: string, node: CompiledGraphNodeV3): Promise<void> {
	const { snapshot } = await resolveFrozenAgent(runDir, sourceCwd, node, true);
	// Also cover the first materialization that created the snapshot in this call;
	// the existing-snapshot branch in resolveFrozenAgent already performs this
	// check, but a newly frozen extension can drift before dispatch as well.
	await verifyFrozenAgentExtensions(snapshot, node.taskId);
	const currentGuardDigest = createHash("sha256").update(await readFile(GRAPH_GUARD_PATH)).digest("hex");
	if (snapshot.guardDigest !== currentGuardDigest) throw new Error(`Graph Guard changed after Agent '${node.agent}' was frozen; refusing to dispatch.`);
	const directory = join(workspaceCwd, ".pi", "agents");
	await mkdir(directory, { recursive: true });
	await atomicWriteFile(join(directory, `${node.agent.replace(/[^A-Za-z0-9._-]/gu, "_")}.md`), snapshot.serialized);
}

function mapScopes(scopes: readonly ScopeEntryV3[], sourceCwd: string, workspaceCwd: string): Array<{ kind: "file" | "tree"; path: string }> {
	return scopes.map((scope) => ({
		kind: scope.kind,
		path: resolve(workspaceCwd, relative(sourceCwd, resolveScope(scope, sourceCwd).path)),
	}));
}

function protectedSourceRoots(sourceCwd: string, additional: readonly string[]): string[] {
	return [...new Set([
		join(sourceCwd, ".git"),
		join(sourceCwd, ".pi-graph"),
		join(sourceCwd, ".pi-subagents"),
		join(sourceCwd, ".pi", "agents"),
		...additional.map((path) => resolve(path)),
	])];
}

/** Freeze every selected Agent before execution begins so later file drift cannot change a pending node. */
export async function freezeV3GraphAgents(
	runDir: string,
	sourceCwd: string,
	nodes: readonly CompiledGraphNodeV3[],
): Promise<V3FrozenAgentPublication[]> {
	const publications: V3FrozenAgentPublication[] = [];
	try {
		for (const node of nodes) {
			const frozen = await resolveFrozenAgent(runDir, sourceCwd, node, false);
			if (frozen.publication) publications.push(frozen.publication);
		}
	} catch (error) {
		await removeV3UncommittedAgentProfiles(runDir, publications);
		throw error;
	}
	return publications;
}

/**
 * Serialize the pre-freeze/publish portion of append within one process. The
 * durable run lease supplies the cross-process fence; this queue prevents two
 * callers sharing that lease from treating each other's staged profiles as
 * abandoned.
 */
export async function withV3AgentProfileTransaction<T>(runDirInput: string, operation: () => Promise<T>): Promise<T> {
	const runDir = resolve(runDirInput);
	const prior = AGENT_PROFILE_QUEUES.get(runDir) ?? Promise.resolve();
	let release!: () => void;
	const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
	const tail = prior.then(() => held);
	AGENT_PROFILE_QUEUES.set(runDir, tail);
	await prior;
	try {
		return await operation();
	} finally {
		release();
		if (AGENT_PROFILE_QUEUES.get(runDir) === tail) AGENT_PROFILE_QUEUES.delete(runDir);
	}
}

/**
 * Clear a profile left by a process that died before its append revision became
 * authority. Callers must hold the run's mutation lease and must have proved
 * these task IDs are absent from the effective graph.
 */
export async function removeV3OrphanAgentProfiles(
	runDirInput: string,
	nodes: readonly Pick<CompiledGraphNodeV3, "taskId">[],
): Promise<string[]> {
	const runDir = resolve(runDirInput);
	const directory = join(runDir, "agent-profiles");
	const removed: string[] = [];
	for (const node of nodes) {
		const path = frozenAgentPath(runDir, node.taskId);
		let before;
		try {
			before = await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
			throw new Error(`Orphan Agent profile for '${node.taskId}' is not a single regular file; refusing cleanup.`);
		}
		const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as { agent?: unknown }).agent !== "string") {
			throw new Error(`Orphan Agent profile for '${node.taskId}' is malformed; refusing cleanup.`);
		}
		validateFrozenAgent(raw, node.taskId, (raw as { agent: string }).agent);
		const quarantine = join(directory, `.orphan-${node.taskId}-${randomUUID()}.json`);
		await rename(path, quarantine);
		const moved = await lstat(quarantine);
		if (!moved.isFile() || moved.isSymbolicLink() || moved.dev !== before.dev || moved.ino !== before.ino) {
			throw new Error(`Orphan Agent profile for '${node.taskId}' changed while it was quarantined.`);
		}
		await syncDirectory(directory);
		await rm(quarantine);
		await syncDirectory(directory);
		removed.push(node.taskId);
	}
	return removed;
}

/**
 * Remove only profiles created for nodes that never became mutation-journal
 * authority. Renaming first gives recovery an all-or-nothing final pathname;
 * identity is checked again before the generated profile is discarded.
 */
export async function removeV3UncommittedAgentProfiles(
	runDirInput: string,
	publications: readonly V3FrozenAgentPublication[],
): Promise<string[]> {
	const runDir = resolve(runDirInput);
	const directory = join(runDir, "agent-profiles");
	const removed: string[] = [];
	for (const publication of publications) {
		const path = frozenAgentPath(runDir, publication.taskId);
		let before;
		try {
			before = await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
			|| before.dev !== publication.dev || before.ino !== publication.ino) {
			throw new Error(`Uncommitted Agent profile for '${publication.taskId}' changed identity; refusing cleanup.`);
		}
		const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
		const validated = validateFrozenAgent(raw, publication.taskId, publication.agent);
		if (validated.serializedDigest !== publication.serializedDigest) {
			throw new Error(`Uncommitted Agent profile for '${publication.taskId}' changed contents; refusing cleanup.`);
		}
		const quarantine = join(directory, `.uncommitted-${publication.taskId}-${randomUUID()}.json`);
		await rename(path, quarantine);
		const moved = await lstat(quarantine);
		if (!moved.isFile() || moved.isSymbolicLink() || moved.dev !== before.dev || moved.ino !== before.ino) {
			throw new Error(`Uncommitted Agent profile for '${publication.taskId}' changed while it was quarantined.`);
		}
		await syncDirectory(directory);
		await rm(quarantine);
		await syncDirectory(directory);
		removed.push(publication.taskId);
	}
	return removed;
}

/** Trusted host input only: declared files must exist inside source and readable scopes. */
async function validateRequiredMaterials(sourceCwd: string, node: Pick<CompiledGraphNodeV3, "taskId" | "readScope" | "writeScope" | "requiredMaterials">, future: ReadonlySet<string> = new Set()): Promise<void> {
 if (!node.requiredMaterials?.length) return;
 const root = await realpath(sourceCwd);
 const scopes = [...node.readScope, ...node.writeScope].map(scope => resolveScope(scope, root));
 for (const material of node.requiredMaterials ?? []) {
  const target = resolve(root, material);
  const fail = (reason: string): never => graphV3Error("INVALID_SCOPE", `Node '${node.taskId}' required material '${material}': ${reason}.`, {taskId: node.taskId, field: "requiredMaterials"});
  if (isAbsolute(material) || material.split(/[\\/]/u).includes("..") || !within(root, target)) fail("invalid source-relative path");
  if (!scopes.some(scope => scope.kind === "file" ? scope.path === target : within(scope.path, target))) fail("outside declared readable scope");
  // Inspect every existing component, including a dangling symlink above a
  // future file. Missing descendants never excuse an unsafe existing ancestor.
  let cursor = root;
  for (const component of relative(root, target).split(sep)) {
   cursor = join(cursor, component);
   const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
   });
   if (!info) break;
   if (info.isSymbolicLink()) fail("symbolic-link path");
   if (cursor !== target && !info.isDirectory()) fail("non-directory ancestor");
  }
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
   if (error.code === "ENOENT") return undefined;
   throw error;
  });
  if (!existing && future.has(material)) continue;
  try { await rejectSymlinks(target); } catch { fail("missing or symbolic-link path"); }
  let canonical: string;
  try { canonical = await realpath(target); } catch { fail("file does not exist"); }
  if (canonical! !== target || !within(root, canonical!)) fail("path escapes source");
  if (!(await lstat(target)).isFile()) fail("must be a regular file");
 }
}

/** At dispatch every input must exist, even if its producer was admitted earlier. */
export async function validateV3RequiredMaterials(sourceCwd: string, node: Pick<CompiledGraphNodeV3, "taskId" | "readScope" | "writeScope" | "requiredMaterials">): Promise<void> {
 await validateRequiredMaterials(sourceCwd, node);
}

/** Only a transitive dependency with a declared write scope can supply a future input. */
export async function validateV3InitialRequiredMaterials(sourceCwd: string, graph: CompiledGraphV3): Promise<void> {
 const byId = new Map(graph.nodes.map(node => [node.taskId, node]));
 const covers = (scope: ScopeEntryV3, material: string) => {
  const target = resolve(sourceCwd, material), allowed = resolveScope(scope, resolve(sourceCwd));
  return allowed.kind === "file" ? allowed.path === target : within(allowed.path, target);
 };
 for (const node of graph.nodes) {
  const ancestors = new Set<string>();
  const visit = (id: string) => {
   if (id === node.taskId || ancestors.has(id)) return;
   ancestors.add(id);
   for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
  };
  for (const dependency of node.dependsOn) visit(dependency);
  const future = new Set((node.requiredMaterials ?? []).filter(material =>
   node.readScope.some(scope => covers(scope, material)) &&
   [...ancestors].some(id => byId.get(id)?.writeScope.some(scope => covers(scope, material)))));
  await validateRequiredMaterials(sourceCwd, node, future);
 }
}

export async function prepareV3Workspace(input: V3WorkspaceInput): Promise<V3PreparedWorkspace> {
	const attemptDir = v3NodeAttemptDir(input.runDir, input.node.taskId, input.attempt);
	const sourceCwd = await realpath(input.sourceCwd);
	await validateV3RequiredMaterials(sourceCwd, input.node);
	const workspaceRoot = join(input.runDir, "shadow", `${input.node.taskId}-${input.attempt}`);
	const workspaceCwd = join(workspaceRoot, "workspace");
	await mkdir(workspaceCwd, { recursive: true });
	const readScopes = input.node.readScope.map((scope) => resolveScope(scope, sourceCwd));
	const writeScopes = input.node.writeScope.map((scope) => resolveScope(scope, sourceCwd));
	for (const scope of [...readScopes, ...writeScopes]) await rejectSymlinks(scope.path);
	const writeBaseline: Record<string, string | null> = {};
	const readBaseline: Record<string, string | null> = {};
	for (const scope of writeScopes) {
		if (scope.kind === "tree") await mkdir(resolve(workspaceCwd, relative(sourceCwd, scope.path)), { recursive: true });
		for (const entry of await scopeBaseline(scope)) {
			writeBaseline[entry.path] = entry.digest ?? null;
			await copyIfPresent(entry.path, resolve(workspaceCwd, relative(sourceCwd, entry.path)));
		}
	}
	for (const scope of readScopes) {
		if (scope.kind === "tree") await mkdir(resolve(workspaceCwd, relative(sourceCwd, scope.path)), { recursive: true });
		for (const entry of await scopeBaseline(scope)) {
			readBaseline[entry.path] = entry.digest ?? null;
			if (!(entry.path in writeBaseline)) await copyIfPresent(entry.path, resolve(workspaceCwd, relative(sourceCwd, entry.path)));
		}
	}
	const inputBaseline: Record<string, { sourcePath: string; digest: string | null }> = {};
	for (const artifact of input.artifacts ?? []) {
		const info = await lstat(artifact.source).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
			throw new V3WorkspaceConflictError(`Graph input artifact must be a single regular file: ${artifact.name}`);
		}
		const target = join(workspaceCwd, ".pi-graph", "inputs", artifact.name);
        const sourceDigest = createHash("sha256").update(await safeBytes(dirname(artifact.source), basename(artifact.source))).digest("hex");
        const expected = artifact.expectedDigest ?? sourceDigest;
        if (sourceDigest !== expected) throw new V3WorkspaceConflictError(`Input artifact does not match accepted digest: ${artifact.name}`);
		await copyIfPresent(artifact.source, target);
        const targetDigest = createHash("sha256").update(await safeBytes(dirname(target), basename(target))).digest("hex");
        const sourceAfter = createHash("sha256").update(await safeBytes(dirname(artifact.source), basename(artifact.source))).digest("hex");
        if (targetDigest !== expected || sourceAfter !== expected) throw new V3WorkspaceConflictError(`Input artifact changed during copy: ${artifact.name}`);
		inputBaseline[artifact.name] = { sourcePath: artifact.source, digest: targetDigest };
	}
	await materializeFrozenAgent(input.runDir, sourceCwd, workspaceCwd, input.node);
	const protectedSource = protectedSourceRoots(sourceCwd, input.protectedSourceRoots ?? []);
	const protectedWorkspace = [
		join(workspaceCwd, ".git"),
		join(workspaceCwd, ".pi-graph"),
		join(workspaceCwd, ".pi-subagents"),
		join(workspaceCwd, ".pi", "agents"),
	];
	const contract: V3NodeContract = {
		schemaVersion: 1,
		graphId: input.graphId,
		taskId: input.node.taskId,
		attempt: input.attempt,
		attemptDir,
		sourceCwd,
		workspaceCwd,
		readScope: [
			...mapScopes(input.node.readScope, sourceCwd, workspaceCwd),
			...(input.artifacts ?? []).map((artifact) => ({ kind: "file" as const, path: join(workspaceCwd, ".pi-graph", "inputs", artifact.name) })),
		],
		writeScope: mapScopes(input.node.writeScope, sourceCwd, workspaceCwd),
		sideEffect: input.node.sideEffect,
		allowBash: input.node.permissionPolicy === "inherited" && !input.node.readOnly,
		...(input.node.contextPolicy === undefined ? {} : { contextPolicy: input.node.contextPolicy, contextTools: await frozenContextTools(input.runDir,input.node,workspaceCwd) }),
		...(input.node.permissionPolicy === undefined ? {} : { permissionPolicy: input.node.permissionPolicy }),
		...(input.node.parentToolAllowlist === undefined ? {} : { parentToolAllowlist: [...input.node.parentToolAllowlist] }),
		readOnly: input.node.readOnly === true,
		toolFilter: [...(input.node.toolFilter ?? [])],
		...(input.node.launch?.maxTokens === undefined ? {} : { maxTokens: input.node.launch.maxTokens }),
		writeBaseline,
		readBaseline,
		protectedSourceRoots: protectedSource,
		protectedWorkspaceRoots: protectedWorkspace,
		inputBaseline,
	};
	await atomicWriteJson(join(workspaceCwd, ".pi-graph", "node-contract.json"), contract);
	const evidence: V3WorkspaceEvidence = {
		schemaVersion: 1,
		runInstanceId: input.runInstanceId,
		graphId: input.graphId,
		taskId: input.node.taskId,
		attempt: input.attempt,
		workspaceKind: "shadow",
		workspaceDir: workspaceCwd,
		sourceCwd,
		readBaseline,
		writeBaseline,
		inputBaseline,
		contractDigest: canonicalDigest(contract),
		createdAt: new Date().toISOString(),
	};
	await writeV3WorkspaceEvidence(input.runDir, input.node.taskId, input.attempt, evidence);
	return {
		workspaceCwd,
		kind: "shadow",
		evidence,
		inspectWrites: () => inspectWrites(input.node, workspaceCwd, evidence),
		apply: (signal) => applyWrites(input.node, attemptDir, workspaceCwd, evidence, signal),
		cleanup: async () => {
			await rm(workspaceRoot, { recursive: true, force: true });
		},
	};
}

export async function reopenV3Workspace(input: {
	runInstanceId: string;
	graphId: string;
	node: CompiledGraphNodeV3;
	attempt: number;
	runDir: string;
	sourceCwd: string;
	workspaceCwd: string;
	kind: "shadow";
	protectedSourceRoots?: string[];
}): Promise<V3PreparedWorkspace> {
	const evidence = await readV3WorkspaceEvidence(input.runDir, input.node.taskId, input.attempt);
	if (!evidence) graphV3Error("INVALID_ATTEMPT", `V3 workspace evidence is missing for '${input.node.taskId}' attempt ${input.attempt}.`, { taskId: input.node.taskId });
	if (evidence.runInstanceId !== input.runInstanceId
		|| evidence.graphId !== input.graphId
		|| evidence.taskId !== input.node.taskId
		|| evidence.attempt !== input.attempt) {
		graphV3Error("RUN_NEEDS_ATTENTION", "V3 workspace evidence identity does not match the run and Attempt being recovered.", { taskId: input.node.taskId });
	}
	if (evidence.workspaceDir !== input.workspaceCwd) graphV3Error("INVALID_ATTEMPT", "V3 workspace evidence path does not match the requested workspace.", { taskId: input.node.taskId });
	if (!existsSync(evidence.workspaceDir)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 shadow workspace no longer exists: ${evidence.workspaceDir}`, { taskId: input.node.taskId });
	const attemptDir = v3NodeAttemptDir(input.runDir, input.node.taskId, input.attempt);
	const contract = await readV3NodeContract(evidence.workspaceDir);
	if (canonicalDigest(contract) !== evidence.contractDigest
		|| contract.graphId !== input.graphId
		|| contract.taskId !== input.node.taskId
		|| contract.attempt !== input.attempt
		|| contract.attemptDir !== attemptDir
		|| contract.sourceCwd !== evidence.sourceCwd
		|| contract.workspaceCwd !== evidence.workspaceDir
		|| canonicalJson(contract.readScope) !== canonicalJson([
			...mapScopes(input.node.readScope, evidence.sourceCwd, evidence.workspaceDir),
			...Object.keys(evidence.inputBaseline).map((name) => ({ kind: "file" as const, path: join(evidence.workspaceDir, ".pi-graph", "inputs", name) })),
		])
		|| canonicalJson(contract.writeScope) !== canonicalJson(mapScopes(input.node.writeScope, evidence.sourceCwd, evidence.workspaceDir))
		|| contract.sideEffect !== input.node.sideEffect
		|| contract.readOnly !== (input.node.readOnly === true)
		|| canonicalJson(contract.toolFilter) !== canonicalJson(input.node.toolFilter ?? [])
		|| contract.maxTokens !== input.node.launch?.maxTokens
		|| contract.allowBash !== (input.node.permissionPolicy === "inherited" && !input.node.readOnly)
		|| (input.node.contextPolicy !== undefined && canonicalJson(contract.contextTools) !== canonicalJson(await frozenContextTools(input.runDir,input.node,evidence.workspaceDir)))
		|| contract.contextPolicy !== input.node.contextPolicy
		|| contract.permissionPolicy !== input.node.permissionPolicy
		|| canonicalJson(contract.parentToolAllowlist ?? null) !== canonicalJson(input.node.parentToolAllowlist ?? null)
		|| canonicalJson(contract.inputBaseline) !== canonicalJson(evidence.inputBaseline)
		|| canonicalJson(contract.writeBaseline) !== canonicalJson(evidence.writeBaseline)
		|| canonicalJson(contract.readBaseline) !== canonicalJson(evidence.readBaseline)) {
		graphV3Error("INVALID_ATTEMPT", "V3 workspace contract no longer matches its immutable evidence.", { taskId: input.node.taskId });
	}
    for (const [name, baseline] of Object.entries(evidence.inputBaseline)) {
        const bytes = await safeBytes(evidence.workspaceDir, `.pi-graph/inputs/${name}`);
        if (createHash("sha256").update(bytes).digest("hex") !== baseline.digest) throw new V3WorkspaceConflictError(`Input artifact changed before recovery: ${name}`);
    }
	await verifyMaterializedAgent(input.runDir, evidence.workspaceDir, input.node);
	return {
		workspaceCwd: evidence.workspaceDir,
		kind: "shadow",
		evidence,
		inspectWrites: () => inspectWrites(input.node, evidence.workspaceDir, evidence),
		apply: (signal) => applyWrites(input.node, attemptDir, evidence.workspaceDir, evidence, signal),
		cleanup: async () => {
			await rm(dirname(evidence.workspaceDir), { recursive: true, force: true });
		},
	};
}

async function readV3NodeContract(workspaceCwd: string): Promise<V3NodeContract> {
	const raw = JSON.parse(await readFile(join(workspaceCwd, ".pi-graph", "node-contract.json"), "utf8")) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("V3 node contract is malformed.");
	const contract = raw as V3NodeContract;
	if (contract.schemaVersion !== 1 || !Array.isArray(contract.readScope) || !Array.isArray(contract.writeScope)
		|| typeof contract.workspaceCwd !== "string" || !contract.workspaceCwd
		|| typeof contract.allowBash !== "boolean" || typeof contract.readOnly !== "boolean"
		|| !Array.isArray(contract.toolFilter) || contract.toolFilter.some((name) => typeof name !== "string" || !name)
		|| (contract.maxTokens !== undefined && (!Number.isSafeInteger(contract.maxTokens) || contract.maxTokens < 16))
		|| "resourceScopes" in contract) throw new Error("V3 node contract is malformed.");
	return contract;
}

async function verifyMaterializedAgent(runDir: string, workspaceCwd: string, node: CompiledGraphNodeV3): Promise<void> {
	const snapshot = await readFrozenAgent(runDir, node.taskId, node.agent);
	if (!snapshot) throw new Error(`Frozen Agent profile disappeared for '${node.taskId}'.`);
	assertFrozenAgentMatchesBinding(snapshot, node);
	await verifyFrozenAgentExtensions(snapshot, node.taskId);
	const agentPath = join(workspaceCwd, ".pi", "agents", `${node.agent.replace(/[^A-Za-z0-9._-]/gu, "_")}.md`);
	const [agentInfo, guardBytes, agentBytes] = await Promise.all([
		lstat(agentPath),
		readFile(GRAPH_GUARD_PATH),
		readFile(agentPath),
	]);
	if (!agentInfo.isFile() || agentInfo.isSymbolicLink() || agentInfo.nlink !== 1
		|| createHash("sha256").update(agentBytes).digest("hex") !== snapshot.serializedDigest
		|| createHash("sha256").update(guardBytes).digest("hex") !== snapshot.guardDigest) {
		throw new Error(`Materialized Agent or Graph Guard changed for '${node.taskId}'.`);
	}
}

async function inspectWrites(node: CompiledGraphNodeV3, workspaceCwd: string, evidence: V3WorkspaceEvidence): Promise<V3FileDigest[]> {
	const sourceCwd = evidence.sourceCwd;
	const writes: V3FileDigest[] = [];
	for (const sourcePath of await writeCandidatePaths(node, workspaceCwd, evidence)) {
		const workspaceFile = resolve(workspaceCwd, relative(sourceCwd, sourcePath));
		const before = evidence.writeBaseline[sourcePath] ?? null;
		if (existsSync(workspaceFile)) {
			const after = await digestFile(workspaceFile);
			if (after !== before) writes.push({ path: sourcePath, ...(before ? { before } : {}), ...(after ? { after } : {}) });
		} else if (before !== null) {
			writes.push({ path: sourcePath, before, deleted: true });
		}
	}
	return writes;
}

async function writeCandidatePaths(
	node: CompiledGraphNodeV3,
	workspaceCwd: string,
	evidence: V3WorkspaceEvidence,
): Promise<string[]> {
	const candidates = new Set<string>();
	const sourceCwd = evidence.sourceCwd;
	for (const scope of node.writeScope) {
		const sourceScope = resolveScope(scope, sourceCwd).path;
		const workspaceScope = resolve(workspaceCwd, relative(sourceCwd, sourceScope));
		if (!within(sourceCwd, sourceScope) || !within(workspaceCwd, workspaceScope)) {
			throw new V3WorkspaceConflictError(`V3 write scope escapes its workspace: ${scope.path}`);
		}
		if (scope.kind === "file") {
			candidates.add(sourceScope);
			continue;
		}
		for (const baselinePath of Object.keys(evidence.writeBaseline)) {
			if (baselinePath !== sourceScope && within(sourceScope, baselinePath)) candidates.add(baselinePath);
		}
		const info = await lstat(workspaceScope).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (!info) continue;
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new V3WorkspaceConflictError(`V3 tree write scope is no longer a regular directory: ${workspaceScope}`);
		}
		for (const workspaceFile of await filesUnder(workspaceScope)) {
			const sourcePath = resolve(sourceCwd, relative(workspaceCwd, workspaceFile));
			if (!within(sourceScope, sourcePath)) throw new V3WorkspaceConflictError(`V3 workspace write escapes declared tree scope: ${workspaceFile}`);
			candidates.add(sourcePath);
		}
	}
	return [...candidates].sort();
}

interface ApplyPlanEntry {
	sourcePath: string;
	before?: string;
	after?: string;
	deleted?: boolean;
	backupPath?: string;
}

interface ApplyPlan {
	version: 2;
	status: "prepared" | "applying" | "committed";
	entries: ApplyPlanEntry[];
	attemptDir: string;
	workspaceCwd: string;
	contractDigest: string;
	/** Highest entry durably observed in its after-state. Never advances before the file operation. */
	lastCommittedIndex: number;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await (await import("node:fs/promises")).open(temporary, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path);
	await syncDirectory(dirname(path));
}

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function atomicCopyExpected(
	source: string,
	target: string,
	expectedSource: string,
	expectedTarget: string | undefined,
): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.pi-graph-${process.pid}-${randomUUID()}`;
	try {
		const sourceInfo = await lstat(source).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (!sourceInfo || sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
			throw new V3WorkspaceConflictError(`V3 apply source is not a regular file: ${source}`);
		}
		if (await digestFile(source) !== expectedSource) {
			throw new V3WorkspaceConflictError(`V3 apply source changed before copy: ${source}`);
		}
		await cp(source, temp, { recursive: false, force: true });
		if (await digestFile(temp) !== expectedSource) {
			throw new V3WorkspaceConflictError(`V3 apply source changed during copy: ${source}`);
		}
		const tempHandle = await (await import("node:fs/promises")).open(temp, "r");
		try {
			await tempHandle.sync();
		} finally {
			await tempHandle.close();
		}
		const targetInfo = await lstat(target).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) {
			throw new V3WorkspaceConflictError(`V3 apply target is no longer a regular file: ${target}`);
		}
		if (await digestFile(target) !== expectedTarget) {
			throw new V3WorkspaceConflictError(`V3 apply target changed immediately before replacement: ${target}`);
		}
		await rename(temp, target);
		await syncDirectory(dirname(target));
	} finally {
		await rm(temp, { force: true }).catch(() => undefined);
	}
}

async function applyWrites(
	node: CompiledGraphNodeV3,
	attemptDir: string,
	workspaceCwd: string,
	evidence: V3WorkspaceEvidence,
	signal?: AbortSignal,
): Promise<V3FileDigest[]> {
	const planPath = join(attemptDir, "apply-plan.json");
	const sourceCwd = evidence.sourceCwd;
	const prior = await readApplyPlan(planPath, { attemptDir, workspaceCwd, contractDigest: evidence.contractDigest });
	if (prior) {
		return recoverApplyPlan(planPath, prior, sourceCwd, signal);
	}
	if (signal?.aborted) throw new Error("V3 source apply aborted before commit.");
	const entries: ApplyPlanEntry[] = [];
	for (const sourcePath of await writeCandidatePaths(node, workspaceCwd, evidence)) {
		const workspaceFile = resolve(workspaceCwd, relative(sourceCwd, sourcePath));
		const before = evidence.writeBaseline[sourcePath] ?? undefined;
		if (existsSync(workspaceFile)) {
			const after = await digestFile(workspaceFile);
			if (after === before) continue;
			const current = await digestFile(sourcePath);
			if (current !== before) throw new V3WorkspaceConflictError(`V3 source changed before apply (concurrent edit): ${sourcePath}`);
			entries.push({ sourcePath, ...(before ? { before } : {}), ...(after ? { after } : {}) });
		} else if (before !== undefined) {
			const current = await digestFile(sourcePath);
			if (current !== before) throw new V3WorkspaceConflictError(`V3 source changed before apply (concurrent delete): ${sourcePath}`);
			entries.push({ sourcePath, before, deleted: true });
		}
	}
	if (entries.length === 0) {
		await atomicJson(planPath, {
			version: 2,
			status: "committed",
			entries: [],
			attemptDir,
			workspaceCwd,
			contractDigest: evidence.contractDigest,
			lastCommittedIndex: -1,
		});
		return [];
	}
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (entry.before !== undefined) {
			entry.backupPath = join(attemptDir, "backups", `${index}-${createHash("sha256").update(entry.sourcePath).digest("hex").slice(0, 12)}.bak`);
		}
	}
	const plan: ApplyPlan = {
		version: 2,
		status: "prepared",
		entries,
		attemptDir,
		workspaceCwd,
		contractDigest: evidence.contractDigest,
		lastCommittedIndex: -1,
	};
	await atomicJson(planPath, plan);
	return recoverApplyPlan(planPath, plan, sourceCwd, signal);
}

type ApplyObservation = "before" | "after" | "conflict";

async function observeApplyEntry(entry: ApplyPlanEntry, sourceCwd: string): Promise<ApplyObservation> {
	if (!within(sourceCwd, entry.sourcePath)) return "conflict";
	const info = await lstat(entry.sourcePath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (info && (info.isSymbolicLink() || !info.isFile())) return "conflict";
	const current = info ? await digestFile(entry.sourcePath) : undefined;
	if (entry.deleted) {
		if (current === undefined) return "after";
		return current === entry.before ? "before" : "conflict";
	}
	if (current === entry.before) return "before";
	if (current === entry.after) return "after";
	return "conflict";
}

function observationConflict(entry: ApplyPlanEntry, context: string): V3WorkspaceConflictError {
	return new V3WorkspaceConflictError(`${context}: ${entry.sourcePath}`);
}

async function ensureApplyBackup(plan: ApplyPlan, entry: ApplyPlanEntry): Promise<void> {
	if (entry.before === undefined) return;
	if (!entry.backupPath || !within(plan.attemptDir, entry.backupPath)) {
		throw observationConflict(entry, "V3 apply backup path escapes its Attempt");
	}
	const backupInfo = await lstat(entry.backupPath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (backupInfo) {
		if (backupInfo.isSymbolicLink() || !backupInfo.isFile() || await digestFile(entry.backupPath) !== entry.before) {
			throw observationConflict(entry, "V3 apply backup no longer matches the source baseline");
		}
		return;
	}
	await atomicCopyExpected(entry.sourcePath, entry.backupPath, entry.before, undefined);
}

async function applyPlanEntry(plan: ApplyPlan, entry: ApplyPlanEntry, sourceCwd: string): Promise<void> {
	const observed = await observeApplyEntry(entry, sourceCwd);
	if (observed === "conflict") throw observationConflict(entry, "V3 source changed immediately before recovery commit");
	if (observed === "after") return;
	await ensureApplyBackup(plan, entry);
	if (entry.deleted) {
		// The digest check above is the source CAS. Persist the containing directory
		// before the journal is allowed to advance.
		if (await observeApplyEntry(entry, sourceCwd) !== "before") {
			throw observationConflict(entry, "V3 source changed immediately before deletion");
		}
		await rm(entry.sourcePath, { force: true });
		await syncDirectory(dirname(entry.sourcePath));
	} else {
		const workspaceFile = resolve(plan.workspaceCwd, relative(sourceCwd, entry.sourcePath));
		if (!within(plan.workspaceCwd, workspaceFile) || entry.after === undefined) {
			throw observationConflict(entry, "V3 apply source escapes the shadow workspace");
		}
		await atomicCopyExpected(workspaceFile, entry.sourcePath, entry.after, entry.before);
	}
	if (await observeApplyEntry(entry, sourceCwd) !== "after") {
		throw observationConflict(entry, "V3 source did not reach the journaled after-state");
	}
}

async function recoverApplyPlan(
	path: string,
	plan: ApplyPlan,
	sourceCwd: string,
	signal?: AbortSignal,
): Promise<V3FileDigest[]> {
	// First inspect the whole transaction. This avoids extending a partial commit
	// when any current or future entry is already known to have a third digest.
	const observed = await Promise.all(plan.entries.map((entry) => observeApplyEntry(entry, sourceCwd)));
	for (let index = 0; index < observed.length; index += 1) {
		const state = observed[index]!;
		const entry = plan.entries[index]!;
		if (state === "conflict") throw observationConflict(entry, "Cannot recover V3 write because the source has a third digest");
		if (index <= plan.lastCommittedIndex && state !== "after") {
			throw observationConflict(entry, "Cannot recover V3 write because a durably committed entry regressed");
		}
	}
	if (plan.status === "committed") {
		if (plan.lastCommittedIndex !== plan.entries.length - 1 || observed.some((state) => state !== "after")) {
			throw new V3WorkspaceConflictError("Committed V3 apply plan is not fully present on disk.");
		}
		return planDigests(plan);
	}
	if (plan.status === "prepared") {
		plan.status = "applying";
		await atomicJson(path, plan);
	}
	for (let index = plan.lastCommittedIndex + 1; index < plan.entries.length; index += 1) {
		if (signal?.aborted) throw new Error("V3 source apply aborted during commit.");
		const entry = plan.entries[index]!;
		// Re-observe every entry at its operation boundary. The full scan above is
		// intentionally not authority: a concurrent edit may happen after it.
		const current = await observeApplyEntry(entry, sourceCwd);
		if (current === "conflict") throw observationConflict(entry, "V3 source changed after recovery preflight");
		if (current === "before") await applyPlanEntry(plan, entry, sourceCwd);
		if (await observeApplyEntry(entry, sourceCwd) !== "after") {
			throw observationConflict(entry, "V3 source changed before recovery checkpoint");
		}
		// This is the only progress checkpoint: it happens after copy/rm and after
		// the source is durably confirmed in its after-state.
		plan.lastCommittedIndex = index;
		await atomicJson(path, plan);
	}
	for (const entry of plan.entries) {
		if (await observeApplyEntry(entry, sourceCwd) !== "after") {
			throw observationConflict(entry, "V3 source changed before transaction commit");
		}
	}
	plan.status = "committed";
	await atomicJson(path, plan);
	return planDigests(plan);
}

function planDigests(plan: ApplyPlan): V3FileDigest[] {
	return plan.entries.map((entry) => ({
		path: entry.sourcePath,
		...(entry.before ? { before: entry.before } : {}),
		...(entry.after ? { after: entry.after } : {}),
		...(entry.deleted ? { deleted: true } : {}),
	}));
}

async function readApplyPlan(
	path: string,
	expected: { attemptDir: string; workspaceCwd: string; contractDigest: string },
): Promise<ApplyPlan | null> {
	const raw = await readJson(path);
	if (raw === undefined) return null;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new V3WorkspaceConflictError("Existing V3 apply plan is malformed.");
	}
	const record = raw as Record<string, unknown>;
	if ((record.version !== 1 && record.version !== 2)
		|| typeof record.status !== "string"
		|| !["prepared", "applying", "committed"].includes(record.status)
		|| !Array.isArray(record.entries)
		|| record.attemptDir !== expected.attemptDir
		|| record.workspaceCwd !== expected.workspaceCwd
		|| record.contractDigest !== expected.contractDigest) {
		throw new V3WorkspaceConflictError("Existing V3 apply plan failed identity validation.");
	}
	const entries: ApplyPlanEntry[] = [];
	const paths = new Set<string>();
	for (let index = 0; index < record.entries.length; index += 1) {
		const value = record.entries[index];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new V3WorkspaceConflictError("Existing V3 apply plan contains a malformed entry.");
		}
		const entry = value as Record<string, unknown>;
		const before = entry.before;
		const after = entry.after;
		const deleted = entry.deleted;
		if (typeof entry.sourcePath !== "string" || !entry.sourcePath
			|| (before !== undefined && (typeof before !== "string" || !/^[a-f0-9]{64}$/u.test(before)))
			|| (after !== undefined && (typeof after !== "string" || !/^[a-f0-9]{64}$/u.test(after)))
			|| (deleted !== undefined && deleted !== true)
			|| (entry.backupPath !== undefined && typeof entry.backupPath !== "string")
			|| (deleted === true ? before === undefined || after !== undefined : after === undefined)
			|| (!deleted && before !== undefined && before === after)
			|| paths.has(entry.sourcePath)) {
			throw new V3WorkspaceConflictError("Existing V3 apply plan contains an invalid entry.");
		}
		paths.add(entry.sourcePath);
		const backupPath = typeof entry.backupPath === "string"
			? entry.backupPath
			: typeof before === "string"
				? join(expected.attemptDir, "backups", `${index}-${createHash("sha256").update(entry.sourcePath).digest("hex").slice(0, 12)}.bak`)
				: undefined;
		entries.push({
			sourcePath: entry.sourcePath,
			...(typeof before === "string" ? { before } : {}),
			...(typeof after === "string" ? { after } : {}),
			...(deleted === true ? { deleted: true } : {}),
			...(backupPath ? { backupPath } : {}),
		});
	}
	let lastCommittedIndex: number;
	if (record.version === 1) {
		// V1 wrote applyingIndex before the source operation, so it is never safe
		// to trust. Re-observation below recovers both sides of that old window.
		lastCommittedIndex = record.status === "committed" ? entries.length - 1 : -1;
	} else {
		if (typeof record.lastCommittedIndex !== "number"
			|| !Number.isInteger(record.lastCommittedIndex)
			|| record.lastCommittedIndex < -1
			|| record.lastCommittedIndex >= entries.length) {
			throw new V3WorkspaceConflictError("Existing V3 apply plan has an invalid completion cursor.");
		}
		lastCommittedIndex = record.lastCommittedIndex;
	}
	return {
		version: 2,
		status: record.status as ApplyPlan["status"],
		entries,
		attemptDir: expected.attemptDir,
		workspaceCwd: expected.workspaceCwd,
		contractDigest: expected.contractDigest,
		lastCommittedIndex,
	};
}
