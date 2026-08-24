import { link, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { V3_MAX_ATTEMPTS_PER_NODE, isV3TerminalPhase, readLatestV3Attempt } from "./attempt.ts";
import { canonicalDigest, canonicalJson } from "./digests.ts";
import { syncDirectory } from "./durable.ts";
import { graphV3Error } from "./errors.ts";
import type { V3MutationCapability } from "./mutations.ts";
import { v3SyntheticNodeStatuses } from "./scheduler.ts";
import type { CompiledGraphV3, V3NodePhase } from "./types.ts";

export const V3_RETRY_JOURNAL_SCHEMA_VERSION = 1 as const;

const REVISION_FILE = /^revision-([0-9]{16})\.json$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export interface V3RetryIntentRecord {
	schemaVersion: typeof V3_RETRY_JOURNAL_SCHEMA_VERSION;
	runInstanceId: string;
	graphId: string;
	revision: number;
	previousIntentDigest: string | null;
	taskId: string;
	taskIds: string[];
	/** Latest immutable Attempt number observed when this retry was admitted. */
	baselines: Record<string, number>;
	createdAt: string;
	intentDigest: string;
}

export interface V3RetryJournalState {
	revision: number;
	records: V3RetryIntentRecord[];
}

export interface V3CommitRetryIntentInput {
	runDir: string;
	graph: CompiledGraphV3;
	runInstanceId: string;
	taskId: string;
	cancelledTaskIds?: readonly string[];
	capability: V3MutationCapability;
	now?: () => string;
}

function journalDir(runDir: string): string {
	return join(resolve(runDir), "retry-journal");
}

function revisionPath(runDir: string, revision: number): string {
	return join(journalDir(runDir), `revision-${String(revision).padStart(16, "0")}.json`);
}

function within(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function ensureJournalDirectory(runDir: string): Promise<string> {
	const root = resolve(runDir);
	const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") graphV3Error("RUN_NEEDS_ATTENTION", "V3 retry runDir does not exist.");
		throw error;
	});
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) graphV3Error("RUN_NEEDS_ATTENTION", "V3 retry runDir must be a real directory.");
	const path = journalDir(root);
	await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) graphV3Error("RUN_NEEDS_ATTENTION", "V3 retry-journal must be a real directory.");
	const [canonicalRoot, canonicalJournal] = await Promise.all([realpath(root), realpath(path)]);
	if (!within(canonicalRoot, canonicalJournal) || canonicalRoot === canonicalJournal) graphV3Error("RUN_NEEDS_ATTENTION", "V3 retry-journal escapes runDir.");
	return path;
}

function payload(record: V3RetryIntentRecord): Omit<V3RetryIntentRecord, "intentDigest"> {
	const { intentDigest: _digest, ...rest } = record;
	return rest;
}

function validateRecord(
	value: unknown,
	revision: number,
	runInstanceId: string,
	graphId: string,
	previousIntentDigest: string | null,
): V3RetryIntentRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} must be an object.`);
	const record = value as Record<string, unknown>;
	const fields = new Set(["schemaVersion", "runInstanceId", "graphId", "revision", "previousIntentDigest", "taskId", "taskIds", "baselines", "createdAt", "intentDigest"]);
	for (const field of Object.keys(record)) if (!fields.has(field)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} contains unknown field '${field}'.`);
	for (const field of fields) if (!(field in record)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} is missing field '${field}'.`);
	if (record.schemaVersion !== V3_RETRY_JOURNAL_SCHEMA_VERSION || record.revision !== revision) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} has an invalid schema or revision.`);
	if (record.runInstanceId !== runInstanceId || record.graphId !== graphId) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} belongs to a different run.`);
	if (record.previousIntentDigest !== previousIntentDigest) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} breaks the intent digest chain.`);
	if (typeof record.taskId !== "string" || !record.taskId) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} has an invalid taskId.`);
	if (!Array.isArray(record.taskIds) || record.taskIds.length === 0 || record.taskIds.some((entry) => typeof entry !== "string" || !entry) || new Set(record.taskIds).size !== record.taskIds.length) {
		graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} has invalid taskIds.`);
	}
	if (typeof record.baselines !== "object" || record.baselines === null || Array.isArray(record.baselines)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} has invalid baselines.`);
	const baselines = record.baselines as Record<string, unknown>;
	if (canonicalJson(Object.keys(baselines)) !== canonicalJson(record.taskIds)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} baselines do not match taskIds.`);
	for (const [taskId, baseline] of Object.entries(baselines)) {
		if (!Number.isInteger(baseline) || (baseline as number) < 0 || (baseline as number) >= V3_MAX_ATTEMPTS_PER_NODE) {
			graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} baseline for '${taskId}' is outside the executable Attempt range.`);
		}
	}
	if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} has an invalid createdAt timestamp.`);
	if (typeof record.intentDigest !== "string" || !DIGEST_PATTERN.test(record.intentDigest)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} has an invalid digest.`);
	const typed = record as unknown as V3RetryIntentRecord;
	if (canonicalDigest(payload(typed)) !== typed.intentDigest) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry revision ${revision} digest does not match its payload.`);
	return JSON.parse(canonicalJson(typed)) as V3RetryIntentRecord;
}

async function stableJson(path: string): Promise<unknown> {
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1 && before.nlink !== 2)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry journal entry '${path}' must be a regular file with at most one crash-staging link.`);
	const bytes = await readFile(path);
	const after = await lstat(path);
	const benignUnlink = before.nlink === 2 && after.nlink === 1
		&& before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
	if (!after.isFile() || after.isSymbolicLink() || (after.nlink !== 1 && after.nlink !== 2) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || (!benignUnlink && before.ctimeMs !== after.ctimeMs)) {
		graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry journal entry '${path}' changed while it was read.`);
	}
	try {
		return JSON.parse(bytes.toString("utf8")) as unknown;
	} catch (error) {
		graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry journal entry '${path}' is not valid JSON.`, { cause: error });
	}
}

export async function readV3RetryJournal(runDir: string, runInstanceId: string, graphId: string): Promise<V3RetryJournalState> {
	const directory = journalDir(runDir);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, records: [] };
		throw error;
	}
	const revisions = names.flatMap((name) => {
		const match = REVISION_FILE.exec(name);
		return match ? [{ revision: Number(match[1]), path: join(directory, name) }] : [];
	}).sort((left, right) => left.revision - right.revision);
	const records: V3RetryIntentRecord[] = [];
	let previous: string | null = null;
	for (let index = 0; index < revisions.length; index += 1) {
		const expected = index + 1;
		if (revisions[index]!.revision !== expected) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry journal is missing contiguous revision ${expected}.`);
		const record = validateRecord(await stableJson(revisions[index]!.path), expected, runInstanceId, graphId, previous);
		records.push(record);
		previous = record.intentDigest;
	}
	return { revision: records.length, records };
}

async function publishRecord(runDir: string, record: V3RetryIntentRecord): Promise<void> {
	const directory = await ensureJournalDirectory(runDir);
	const staging = join(directory, `.retry-${process.pid}-${record.revision}-${record.intentDigest}.tmp`);
	const handle = await open(staging, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(staging, { force: true }).catch(() => undefined);
		throw error;
	}
	await handle.close();
	try {
		await link(staging, revisionPath(runDir, record.revision));
		await rm(staging, { force: true });
		await syncDirectory(directory);
	} catch (error) {
		await rm(staging, { force: true }).catch(() => undefined);
		throw error;
	}
}

function descendantsOf(graph: CompiledGraphV3, root: string): Set<string> {
	const descendants = new Set([root]);
	for (const taskId of graph.topologicalOrder) {
		const node = graph.nodes.find((candidate) => candidate.taskId === taskId)!;
		if (node.dependsOn.some((dependency) => descendants.has(dependency))) descendants.add(taskId);
	}
	return descendants;
}

function cancelledClosure(graph: CompiledGraphV3, cancelled: ReadonlySet<string>): Set<string> {
	const closure = new Set(cancelled);
	for (const taskId of graph.topologicalOrder) {
		const node = graph.nodes.find((candidate) => candidate.taskId === taskId)!;
		if (node.dependsOn.some((dependency) => closure.has(dependency))) closure.add(taskId);
	}
	return closure;
}

/** Latest retry baselines still requiring at least one new terminal Attempt. */
export async function pendingV3RetryBaselines(
	runDir: string,
	runInstanceId: string,
	graphId: string,
	graph?: CompiledGraphV3,
	cancelledTaskIds: readonly string[] = [],
): Promise<Record<string, number> | undefined> {
	const journal = await readV3RetryJournal(runDir, runInstanceId, graphId);
	const record = journal.records.at(-1);
	if (!record) return undefined;
	const latestByTask = new Map<string, Awaited<ReturnType<typeof readLatestV3Attempt>>>();
	if (graph) {
		for (const node of graph.nodes) latestByTask.set(node.taskId, await readLatestV3Attempt(runDir, node.taskId));
	}
	const synthetic = graph ? v3SyntheticNodeStatuses(graph, {
		phaseOf: (taskId) => {
			const latest = latestByTask.get(taskId);
			const baseline = record.baselines[taskId];
			// A node still at its admitted retry baseline is logically reset even
			// though its immutable historical Attempt remains on disk.
			return baseline !== undefined && (latest?.attempt ?? 0) === baseline
				? undefined
				: latest?.evidence.phase;
		},
	}, new Set(cancelledTaskIds)) : undefined;
	let pending = false;
	for (const taskId of record.taskIds) {
		const latest = graph ? latestByTask.get(taskId) : await readLatestV3Attempt(runDir, taskId);
		const baseline = record.baselines[taskId]!;
		if ((latest?.attempt ?? 0) < baseline) graphV3Error("RUN_NEEDS_ATTENTION", `V3 retry target '${taskId}' Attempt history moved behind its admitted baseline.`);
		if ((latest?.attempt ?? 0) === baseline && !synthetic?.has(taskId)) pending = true;
		if ((latest?.attempt ?? 0) > baseline && latest !== undefined && !isV3TerminalPhase(latest.evidence.phase)) pending = true;
	}
	return pending ? { ...record.baselines } : undefined;
}

/** Baselines from the latest durable retry intent, including a settled retry. */
export async function latestV3RetryBaselines(
	runDir: string,
	runInstanceId: string,
	graphId: string,
): Promise<Record<string, number> | undefined> {
	const record = (await readV3RetryJournal(runDir, runInstanceId, graphId)).records.at(-1);
	return record ? { ...record.baselines } : undefined;
}

/** Commit an append-only retry intent while holding the run's live lease fence. */
export async function commitV3RetryIntent(input: V3CommitRetryIntentInput): Promise<V3RetryIntentRecord> {
	const transaction = async () => {
		await input.capability.assertCurrent();
		const graph = input.graph;
		const target = graph.nodes.find((node) => node.taskId === input.taskId);
		if (!target) graphV3Error("INVALID_MUTATION", `V3 graph '${graph.graphId}' has no node '${input.taskId}'.`, { taskId: input.taskId });
		const priorPending = await pendingV3RetryBaselines(input.runDir, input.runInstanceId, graph.graphId, graph, input.cancelledTaskIds);
		if (priorPending) graphV3Error("INVALID_MUTATION", "The previous V3 retry intent has not reached a terminal result.");
		const cancelled = new Set(input.cancelledTaskIds ?? []);
		const poisoned = cancelledClosure(graph, cancelled);
		if (poisoned.has(input.taskId)) graphV3Error("INVALID_MUTATION", `Node '${input.taskId}' belongs to a cancelled branch and cannot be retried.`, { taskId: input.taskId });

		const latestByTask = new Map<string, Awaited<ReturnType<typeof readLatestV3Attempt>>>();
		for (const node of graph.nodes) latestByTask.set(node.taskId, await readLatestV3Attempt(input.runDir, node.taskId));
		const attemptView = { phaseOf: (taskId: string) => latestByTask.get(taskId)?.evidence.phase as V3NodePhase | undefined };
		const synthetic = v3SyntheticNodeStatuses(graph, attemptView, cancelled);
		for (const node of graph.nodes) {
			const phase = latestByTask.get(node.taskId)?.evidence.phase ?? synthetic.get(node.taskId);
			if (phase === undefined || !["accepted", "failed", "aborted", "needs_attention", "skipped", "blocked", "cancelled"].includes(phase)) {
				graphV3Error("INVALID_MUTATION", `V3 graph '${graph.graphId}' is still executing; retry is allowed only after the run is terminal.`, { taskId: node.taskId, details: { phase } });
			}
		}
		const targetAttempt = latestByTask.get(input.taskId);
		if (!targetAttempt || !isV3TerminalPhase(targetAttempt.evidence.phase)) {
			graphV3Error("INVALID_MUTATION", `Node '${input.taskId}' has no terminal Attempt to retry.`, { taskId: input.taskId });
		}

		const descendants = descendantsOf(graph, input.taskId);
		const taskIds = graph.topologicalOrder.filter((taskId) => descendants.has(taskId) && !poisoned.has(taskId));
		const baselines: Record<string, number> = {};
		for (const taskId of taskIds) {
			const attempt = latestByTask.get(taskId)?.attempt ?? 0;
			if (attempt >= V3_MAX_ATTEMPTS_PER_NODE) graphV3Error("INVALID_MUTATION", `Node '${taskId}' reached the ${V3_MAX_ATTEMPTS_PER_NODE}-Attempt lifetime limit.`, { taskId });
			baselines[taskId] = attempt;
		}
		const journal = await readV3RetryJournal(input.runDir, input.runInstanceId, graph.graphId);
		const revision = journal.revision + 1;
		if (!Number.isSafeInteger(revision)) graphV3Error("RUN_NEEDS_ATTENTION", "V3 retry journal revision is exhausted.");
		const createdAt = input.now?.() ?? new Date().toISOString();
		if (Number.isNaN(Date.parse(createdAt))) graphV3Error("INVALID_MUTATION", "V3 retry timestamp must be ISO-8601.");
		const recordPayload: Omit<V3RetryIntentRecord, "intentDigest"> = {
			schemaVersion: V3_RETRY_JOURNAL_SCHEMA_VERSION,
			runInstanceId: input.runInstanceId,
			graphId: graph.graphId,
			revision,
			previousIntentDigest: journal.records.at(-1)?.intentDigest ?? null,
			taskId: input.taskId,
			taskIds,
			baselines,
			createdAt,
		};
		const record: V3RetryIntentRecord = { ...recordPayload, intentDigest: canonicalDigest(recordPayload) };
		await input.capability.assertCurrent();
		await publishRecord(input.runDir, record);
		return validateRecord(record, revision, input.runInstanceId, graph.graphId, record.previousIntentDigest);
	};
	return input.capability.withFence === undefined ? transaction() : input.capability.withFence(transaction);
}
