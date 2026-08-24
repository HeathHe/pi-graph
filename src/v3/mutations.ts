import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_GRAPH_NODES_V3, compileGraphSpecV3 } from "./compiler.ts";
import { canonicalDigest, canonicalJson } from "./digests.ts";
import { syncDirectory } from "./durable.ts";
import { GraphV3Error, graphV3Error } from "./errors.ts";
import type { CompiledGraphV3, GraphNodeSpecV3, V3NodePhase } from "./types.ts";

export const V3_MUTATION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const MAX_V3_NODES_PER_APPEND = 64 as const;

const REVISION_FILE = /^revision-([0-9]{16})\.json$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const PROCESS_QUEUES = new Map<string, Promise<void>>();

interface V3MutationRecordBase {
	schemaVersion: typeof V3_MUTATION_JOURNAL_SCHEMA_VERSION;
	graphId: string;
	baseGraphDigest: string;
	baseSourceGraphSpecDigest: string;
	revision: number;
	previousMutationDigest: string | null;
	at: string;
	mutationDigest: string;
}

export interface V3AppendMutationRecord extends V3MutationRecordBase {
	type: "append";
	nodes: GraphNodeSpecV3[];
}

export interface V3CancelMutationRecord extends V3MutationRecordBase {
	type: "cancel";
	requestedTaskIds: string[];
	taskIds: string[];
	cascade: boolean;
}

export interface V3SealMutationRecord extends V3MutationRecordBase {
	type: "seal";
}

export type V3GraphMutationRecord = V3AppendMutationRecord | V3CancelMutationRecord | V3SealMutationRecord;

export interface V3GraphMutationState {
	revision: number;
	sealed: boolean;
	graph: CompiledGraphV3;
	cancelledTaskIds: string[];
	mutations: V3GraphMutationRecord[];
}

export interface V3MutationCapability {
	/** Host/lease integration hook. It is checked both before validation and at the commit boundary. */
	assertCurrent(): void | Promise<void>;
	/** Optional fence gate that keeps the whole read/validate/publish transaction under one live capability. */
	withFence?<T>(operation: () => Promise<T>): Promise<T>;
}

export type V3MutationNodeStatus = V3NodePhase | "skipped" | "blocked" | "cancelled" | "stopped" | "interrupted";

export interface V3MutationNodeStateView {
	phaseOf(taskId: string): V3MutationNodeStatus | undefined | Promise<V3MutationNodeStatus | undefined>;
}

interface V3MutationInputBase {
	runDir: string;
	baseGraph: CompiledGraphV3;
	expectedRevision: number;
	capability?: V3MutationCapability;
	now?: () => string;
}

export interface V3AppendGraphInput extends V3MutationInputBase {
	nodes: readonly GraphNodeSpecV3[];
}

export interface V3CancelGraphInput extends V3MutationInputBase {
	taskIds: readonly string[];
	cascade?: boolean;
	view: V3MutationNodeStateView;
}

export interface V3SealGraphInput extends V3MutationInputBase {}

export class V3RevisionConflictError extends GraphV3Error {
	readonly expectedRevision: number;
	readonly currentRevision: number;

	constructor(expectedRevision: number, currentRevision: number) {
		super("REVISION_CONFLICT", `V3 graph revision conflict: expected ${expectedRevision}, current ${currentRevision}; reload the mutation journal and retry.`, {
			details: { expectedRevision, currentRevision },
		});
		this.name = "V3RevisionConflictError";
		this.expectedRevision = expectedRevision;
		this.currentRevision = currentRevision;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(record: Record<string, unknown>, fields: readonly string[], label: string): void {
	const expected = new Set(fields);
	for (const field of Object.keys(record)) if (!expected.has(field)) graphV3Error("INVALID_MUTATION", `${label} contains unknown field '${field}'.`, { field });
	for (const field of fields) if (!Object.prototype.hasOwnProperty.call(record, field)) graphV3Error("INVALID_MUTATION", `${label} is missing field '${field}'.`, { field });
}

function safeRevision(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) graphV3Error("INVALID_MUTATION", `${label} must be a non-negative safe integer.`);
	return value as number;
}

function isoTime(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value))) graphV3Error("INVALID_MUTATION", `${label} must be an ISO-8601 timestamp.`);
	return value;
}

function mutationPayload(record: V3GraphMutationRecord): Omit<V3GraphMutationRecord, "mutationDigest"> {
	const { mutationDigest: _digest, ...payload } = record;
	return payload;
}

function canonicalClone<T>(value: T): T {
	return JSON.parse(canonicalJson(value)) as T;
}

function normalizedRunDir(value: string): string {
	if (typeof value !== "string" || !value || value.includes("\0")) graphV3Error("INVALID_MUTATION", "runDir must be a non-empty path without NUL bytes.", { field: "runDir" });
	return resolve(value);
}

function journalDir(runDir: string): string {
	return join(runDir, "mutation-journal");
}

function revisionPath(runDir: string, revision: number): string {
	return join(journalDir(runDir), `revision-${String(revision).padStart(16, "0")}.json`);
}

function within(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function assertRunDirectory(runDir: string): Promise<void> {
	const info = await lstat(runDir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") graphV3Error("INVALID_MUTATION", "runDir does not exist.", { field: "runDir" });
		throw error;
	});
	if (!info.isDirectory() || info.isSymbolicLink()) graphV3Error("INVALID_MUTATION", "runDir must be a real directory.", { field: "runDir" });
}

async function ensureJournalDirectory(runDir: string): Promise<string> {
	await assertRunDirectory(runDir);
	const path = journalDir(runDir);
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) graphV3Error("INVALID_MUTATION", "mutation-journal must be a real directory.");
	const [canonicalRun, canonicalJournal] = await Promise.all([realpath(runDir), realpath(path)]);
	if (!within(canonicalRun, canonicalJournal) || canonicalRun === canonicalJournal) graphV3Error("INVALID_MUTATION", "mutation-journal escapes runDir.");
	return path;
}

async function stableJsonFile(path: string): Promise<unknown> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const before = await lstat(path);
		if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1 && before.nlink !== 2)) {
			graphV3Error("INVALID_MUTATION", `Mutation journal entry '${path}' must be a regular file with at most one crash-staging link.`);
		}
		const bytes = await readFile(path);
		const after = await lstat(path);
		const stable = after.isFile() && !after.isSymbolicLink()
			&& (after.nlink === 1 || after.nlink === 2)
			&& after.dev === before.dev && after.ino === before.ino && after.size === before.size
			&& after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs;
		if (!stable) {
			// Publishing removes the temporary hard link after the final name is
			// visible. That changes only nlink/ctime; retry across that benign edge.
			if (before.dev === after.dev && before.ino === after.ino && before.size === after.size
				&& before.mtimeMs === after.mtimeMs && before.nlink === 2 && after.nlink === 1) continue;
			graphV3Error("INVALID_MUTATION", `Mutation journal entry '${path}' changed while it was read.`);
		}
		try {
			return JSON.parse(bytes.toString("utf8")) as unknown;
		} catch (error) {
			throw new GraphV3Error("INVALID_MUTATION", `Mutation journal entry '${path}' is not valid JSON.`, { cause: error });
		}
	}
	graphV3Error("INVALID_MUTATION", `Mutation journal entry '${path}' did not stabilize while it was read.`);
}

/**
 * Publish complete revision bytes without ever exposing a partially-written
 * final pathname. `link` is the cross-process no-replace CAS boundary: after
 * a crash the final name is either absent or points at the fully fsynced inode.
 */
async function createAtomicRevisionJson(runDir: string, path: string, value: unknown): Promise<void> {
	const staging = join(runDir, `.mutation-staging-${process.pid}-${randomUUID()}.tmp`);
	const handle = await open(staging, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(staging, { force: true }).catch(() => undefined);
		throw error;
	}
	await handle.close();
	try {
		await link(staging, path);
		await syncDirectory(journalDir(runDir));
	} finally {
		// A SIGKILL may leave this second link behind. Readers accept that
		// bounded nlink=2 state because both names address already-fsynced bytes.
		await rm(staging, { force: true }).catch(() => undefined);
	}
}

function validatedBaseGraph(input: CompiledGraphV3): CompiledGraphV3 {
	let graph: CompiledGraphV3;
	try {
		graph = compileGraphSpecV3(input.sourceGraphSpec);
	} catch (error) {
		throw new GraphV3Error("INVALID_MUTATION", `Mutation base graph cannot be recompiled: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	if (graph.graphDigest !== input.graphDigest || graph.sourceGraphSpecDigest !== input.sourceGraphSpecDigest || graph.graphId !== input.graphId) {
		graphV3Error("INVALID_MUTATION", "Mutation base graph identity does not match its source GraphSpec.");
	}
	return graph;
}

function validateStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) graphV3Error("INVALID_MUTATION", `${label} must be a non-empty string array.`);
	if (value.length === 0 || new Set(value).size !== value.length) graphV3Error("INVALID_MUTATION", `${label} must be non-empty and contain no duplicates.`);
	return [...value] as string[];
}

function validateRecord(value: unknown, revision: number, base: CompiledGraphV3, previousDigest: string | null): V3GraphMutationRecord {
	if (!isRecord(value)) graphV3Error("INVALID_MUTATION", `Mutation revision ${revision} must be an object.`);
	const common = ["schemaVersion", "graphId", "baseGraphDigest", "baseSourceGraphSpecDigest", "revision", "previousMutationDigest", "type", "at", "mutationDigest"];
	if (value.type === "append") exactFields(value, [...common, "nodes"], `Mutation revision ${revision}`);
	else if (value.type === "cancel") exactFields(value, [...common, "requestedTaskIds", "taskIds", "cascade"], `Mutation revision ${revision}`);
	else if (value.type === "seal") exactFields(value, common, `Mutation revision ${revision}`);
	else graphV3Error("INVALID_MUTATION", `Mutation revision ${revision} has unsupported type.`);
	if (value.schemaVersion !== V3_MUTATION_JOURNAL_SCHEMA_VERSION || safeRevision(value.revision, "mutation.revision") !== revision) graphV3Error("INVALID_MUTATION", `Mutation revision ${revision} has an invalid schema or revision.`);
	if (value.graphId !== base.graphId || value.baseGraphDigest !== base.graphDigest || value.baseSourceGraphSpecDigest !== base.sourceGraphSpecDigest) graphV3Error("INVALID_MUTATION", `Mutation revision ${revision} is not bound to the base graph.`);
	if (value.previousMutationDigest !== previousDigest) graphV3Error("INVALID_MUTATION", `Mutation revision ${revision} breaks the journal digest chain.`);
	isoTime(value.at, "mutation.at");
	if (typeof value.mutationDigest !== "string" || !DIGEST_PATTERN.test(value.mutationDigest)) graphV3Error("INVALID_MUTATION", `Mutation revision ${revision} has an invalid digest.`);
	const record = value as unknown as V3GraphMutationRecord;
	if (canonicalDigest(mutationPayload(record)) !== record.mutationDigest) graphV3Error("INVALID_MUTATION", `Mutation revision ${revision} digest does not match its record.`);
	if (record.type === "append") {
		if (!Array.isArray(record.nodes) || record.nodes.length === 0 || record.nodes.length > MAX_V3_NODES_PER_APPEND) graphV3Error("INVALID_MUTATION", `Append revision ${revision} must contain 1..${MAX_V3_NODES_PER_APPEND} nodes.`);
	}
	if (record.type === "cancel") {
		validateStringArray(record.requestedTaskIds, "cancel.requestedTaskIds");
		validateStringArray(record.taskIds, "cancel.taskIds");
		if (typeof record.cascade !== "boolean") graphV3Error("INVALID_MUTATION", `Cancel revision ${revision} cascade must be boolean.`);
	}
	return canonicalClone(record);
}

function appendCandidate(graph: CompiledGraphV3, nodes: readonly GraphNodeSpecV3[]): CompiledGraphV3 {
	const source = graph.sourceGraphSpec;
	return compileGraphSpecV3({
		...source,
		graphId: graph.graphId,
		mode: "open",
		nodes: [...source.nodes, ...canonicalClone(nodes)],
	});
}

function descendantsOf(graph: CompiledGraphV3, roots: ReadonlySet<string>): Set<string> {
	const output = new Set(roots);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of graph.nodes) {
			if (output.has(node.taskId) || !node.dependsOn.some((dependency) => output.has(dependency))) continue;
			output.add(node.taskId);
			changed = true;
		}
	}
	return output;
}

function assertNoCancelledAncestor(graph: CompiledGraphV3, appendedTaskIds: ReadonlySet<string>, cancelled: ReadonlySet<string>): void {
	const poisoned = descendantsOf(graph, cancelled);
	const taskId = [...appendedTaskIds].find((candidate) => poisoned.has(candidate));
	if (taskId) graphV3Error("INVALID_MUTATION", `Appended node '${taskId}' depends on a cancelled branch; append a replacement chain that does not depend on cancelled nodes.`, { taskId });
}

function applyRecord(state: V3GraphMutationState, record: V3GraphMutationRecord): V3GraphMutationState {
	if (state.sealed) graphV3Error("INVALID_MUTATION", `Mutation revision ${record.revision} follows a seal record.`);
	let graph = state.graph;
	const cancelled = new Set(state.cancelledTaskIds);
	if (record.type === "append") {
		const priorIds = new Set(graph.nodes.map((node) => node.taskId));
		graph = appendCandidate(graph, record.nodes);
		const appendedIds = new Set(graph.nodes.map((node) => node.taskId).filter((taskId) => !priorIds.has(taskId)));
		if (appendedIds.size !== record.nodes.length) graphV3Error("INVALID_MUTATION", `Append revision ${record.revision} rewrites an existing node definition.`);
		assertNoCancelledAncestor(graph, appendedIds, cancelled);
	} else if (record.type === "cancel") {
		const nodeIds = new Set(graph.nodes.map((node) => node.taskId));
		for (const taskId of record.taskIds) {
			if (!nodeIds.has(taskId)) graphV3Error("INVALID_MUTATION", `Cancel revision ${record.revision} references unknown node '${taskId}'.`, { taskId });
			cancelled.add(taskId);
		}
		if (!record.requestedTaskIds.every((taskId) => record.taskIds.includes(taskId))) graphV3Error("INVALID_MUTATION", `Cancel revision ${record.revision} omits a requested tombstone.`);
		if (record.cascade) {
			const expected = [...descendantsOf(graph, new Set(record.requestedTaskIds))].sort();
			if (canonicalJson(expected) !== canonicalJson([...record.taskIds].sort())) graphV3Error("INVALID_MUTATION", `Cancel revision ${record.revision} has an incomplete cascade closure.`);
		} else if (canonicalJson([...record.requestedTaskIds].sort()) !== canonicalJson([...record.taskIds].sort())) {
			graphV3Error("INVALID_MUTATION", `Non-cascade cancel revision ${record.revision} contains undeclared tombstones.`);
		}
	}
	return {
		revision: record.revision,
		sealed: record.type === "seal",
		graph,
		cancelledTaskIds: [...cancelled].sort(),
		mutations: [...state.mutations, record],
	};
}

async function journalRecords(runDir: string): Promise<Array<{ revision: number; path: string }>> {
	const path = journalDir(runDir);
	let names: string[];
	try {
		names = await readdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) graphV3Error("INVALID_MUTATION", "mutation-journal must be a real directory.");
	const records = names.map((name) => {
		const match = REVISION_FILE.exec(name);
		if (!match) graphV3Error("INVALID_MUTATION", `mutation-journal contains unknown entry '${name}'.`);
		return { revision: Number(match[1]), path: join(path, name) };
	}).sort((left, right) => left.revision - right.revision);
	for (let index = 0; index < records.length; index += 1) {
		if (records[index]!.revision !== index + 1) graphV3Error("INVALID_MUTATION", `mutation-journal is not contiguous at revision ${index + 1}.`);
	}
	return records;
}

export async function readV3MutationJournal(runDirInput: string, baseGraphInput: CompiledGraphV3): Promise<V3GraphMutationState> {
	const runDir = normalizedRunDir(runDirInput);
	await assertRunDirectory(runDir);
	const baseGraph = validatedBaseGraph(baseGraphInput);
	let state: V3GraphMutationState = {
		revision: 0,
		sealed: baseGraph.mode !== "open",
		graph: baseGraph,
		cancelledTaskIds: [],
		mutations: [],
	};
	let previousDigest: string | null = null;
	for (const entry of await journalRecords(runDir)) {
		const record = validateRecord(await stableJsonFile(entry.path), entry.revision, baseGraph, previousDigest);
		state = applyRecord(state, record);
		previousDigest = record.mutationDigest;
	}
	return canonicalClone(state);
}

async function queued<T>(runDir: string, operation: () => Promise<T>): Promise<T> {
	const prior = PROCESS_QUEUES.get(runDir) ?? Promise.resolve();
	let release!: () => void;
	const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
	const tail = prior.then(() => held);
	PROCESS_QUEUES.set(runDir, tail);
	await prior;
	try {
		return await operation();
	} finally {
		release();
		if (PROCESS_QUEUES.get(runDir) === tail) PROCESS_QUEUES.delete(runDir);
	}
}

async function assertCapability(capability: V3MutationCapability | undefined): Promise<void> {
	await capability?.assertCurrent();
}

function timestamp(now: (() => string) | undefined): string {
	return isoTime(now?.() ?? new Date().toISOString(), "mutation timestamp");
}

function withDigest<T extends Omit<V3GraphMutationRecord, "mutationDigest">>(payload: T): T & { mutationDigest: string } {
	return { ...payload, mutationDigest: canonicalDigest(payload) };
}

async function commitMutation(
	input: V3MutationInputBase,
	build: (state: V3GraphMutationState, baseGraph: CompiledGraphV3, nextRevision: number) => Omit<V3GraphMutationRecord, "mutationDigest"> | Promise<Omit<V3GraphMutationRecord, "mutationDigest">>,
): Promise<V3GraphMutationState> {
	const runDir = normalizedRunDir(input.runDir);
	const expectedRevision = safeRevision(input.expectedRevision, "expectedRevision");
	return queued(runDir, async () => {
		const transaction = async () => {
		await assertCapability(input.capability);
		const baseGraph = validatedBaseGraph(input.baseGraph);
		const state = await readV3MutationJournal(runDir, baseGraph);
		if (state.revision !== expectedRevision) throw new V3RevisionConflictError(expectedRevision, state.revision);
		const nextRevision = expectedRevision + 1;
		if (!Number.isSafeInteger(nextRevision)) graphV3Error("INVALID_MUTATION", "Mutation revision limit has been reached.");
		const record = withDigest(await build(state, baseGraph, nextRevision));
		// Validate the candidate and its journal semantics before publishing any authority bytes.
		applyRecord(state, validateRecord(record, nextRevision, baseGraph, state.mutations.at(-1)?.mutationDigest ?? null));
		await assertCapability(input.capability);
		await ensureJournalDirectory(runDir);
		try {
			await createAtomicRevisionJson(runDir, revisionPath(runDir, nextRevision), record);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const current = await readV3MutationJournal(runDir, baseGraph);
			throw new V3RevisionConflictError(expectedRevision, current.revision);
		}
		const committed = await readV3MutationJournal(runDir, baseGraph);
		if (committed.revision !== nextRevision || committed.mutations.at(-1)?.mutationDigest !== record.mutationDigest) {
			graphV3Error("INVALID_MUTATION", `Mutation revision ${nextRevision} was not the committed journal authority.`);
		}
		return committed;
		};
		return input.capability?.withFence === undefined ? transaction() : input.capability.withFence(transaction);
	});
}

export async function appendV3GraphNodes(input: V3AppendGraphInput): Promise<V3GraphMutationState> {
	if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > MAX_V3_NODES_PER_APPEND) {
		graphV3Error("INVALID_MUTATION", `append requires 1..${MAX_V3_NODES_PER_APPEND} nodes.`);
	}
	const nodes = canonicalClone(input.nodes);
	return commitMutation(input, (state, baseGraph, revision) => {
		if (state.sealed) graphV3Error("INVALID_MUTATION", `V3 graph '${baseGraph.graphId}' is sealed and cannot be appended.`);
		if (state.graph.nodes.length + nodes.length > MAX_GRAPH_NODES_V3) graphV3Error("INVALID_MUTATION", `append exceeds the ${MAX_GRAPH_NODES_V3}-node graph limit.`);
		const existing = new Set(state.graph.nodes.map((node) => node.taskId));
		for (const node of nodes) if (existing.has(node.taskId)) graphV3Error("INVALID_MUTATION", `Node '${node.taskId}' is immutable and already exists.`, { taskId: node.taskId });
		const candidate = appendCandidate(state.graph, nodes);
		const appendedIds = new Set(candidate.nodes.map((node) => node.taskId).filter((taskId) => !existing.has(taskId)));
		if (appendedIds.size !== nodes.length) graphV3Error("INVALID_MUTATION", "append must add only new immutable node definitions.");
		assertNoCancelledAncestor(candidate, appendedIds, new Set(state.cancelledTaskIds));
		return {
			schemaVersion: V3_MUTATION_JOURNAL_SCHEMA_VERSION,
			graphId: baseGraph.graphId,
			baseGraphDigest: baseGraph.graphDigest,
			baseSourceGraphSpecDigest: baseGraph.sourceGraphSpecDigest,
			revision,
			previousMutationDigest: state.mutations.at(-1)?.mutationDigest ?? null,
			type: "append",
			nodes,
			at: timestamp(input.now),
		};
	});
}

const CANCELLABLE_PHASES = new Set<V3MutationNodeStatus | undefined>([undefined, "queued", "failed", "aborted", "skipped", "blocked", "cancelled", "stopped", "interrupted"]);

export async function cancelV3GraphNodes(input: V3CancelGraphInput): Promise<V3GraphMutationState> {
	const requestedTaskIds = validateStringArray(input.taskIds, "cancel.taskIds").sort();
	return commitMutation(input, async (state, baseGraph, revision) => {
		if (state.sealed) graphV3Error("INVALID_MUTATION", `V3 graph '${baseGraph.graphId}' is sealed and cannot be cancelled.`);
		const known = new Set(state.graph.nodes.map((node) => node.taskId));
		for (const taskId of requestedTaskIds) if (!known.has(taskId)) graphV3Error("INVALID_MUTATION", `V3 graph '${baseGraph.graphId}' has no node '${taskId}'.`, { taskId });
		const targets = input.cascade ? descendantsOf(state.graph, new Set(requestedTaskIds)) : new Set(requestedTaskIds);
		const alreadyCancelled = new Set(state.cancelledTaskIds);
		for (const taskId of targets) {
			if (alreadyCancelled.has(taskId)) continue;
			// This read runs inside the same live Supervisor fence as journal
			// publication. A prepared Attempt and a cancellation can therefore
			// never both win based on a stale pre-fence snapshot.
			const phase = await input.view.phaseOf(taskId);
			if (!CANCELLABLE_PHASES.has(phase)) graphV3Error("INVALID_MUTATION", `Node '${taskId}' cannot be cancelled while phase is '${phase}'.`, { taskId, details: { phase } });
		}
		return {
			schemaVersion: V3_MUTATION_JOURNAL_SCHEMA_VERSION,
			graphId: baseGraph.graphId,
			baseGraphDigest: baseGraph.graphDigest,
			baseSourceGraphSpecDigest: baseGraph.sourceGraphSpecDigest,
			revision,
			previousMutationDigest: state.mutations.at(-1)?.mutationDigest ?? null,
			type: "cancel",
			requestedTaskIds,
			taskIds: [...targets].sort(),
			cascade: input.cascade === true,
			at: timestamp(input.now),
		};
	});
}

export async function sealV3Graph(input: V3SealGraphInput): Promise<V3GraphMutationState> {
	return commitMutation(input, (state, baseGraph, revision) => {
		if (state.sealed) graphV3Error("INVALID_MUTATION", `V3 graph '${baseGraph.graphId}' is already sealed.`);
		return {
			schemaVersion: V3_MUTATION_JOURNAL_SCHEMA_VERSION,
			graphId: baseGraph.graphId,
			baseGraphDigest: baseGraph.graphDigest,
			baseSourceGraphSpecDigest: baseGraph.sourceGraphSpecDigest,
			revision,
			previousMutationDigest: state.mutations.at(-1)?.mutationDigest ?? null,
			type: "seal",
			at: timestamp(input.now),
		};
	});
}
