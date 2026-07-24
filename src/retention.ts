import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { validateGraphId } from "./compile.ts";
import { atomicWriteJson, syncDirectory } from "./durable.ts";
import { liveClaims, withExclusiveClaim } from "./claims.ts";
import { GraphStore } from "./store.ts";
import { isTerminalGraphStatus } from "./snapshot.ts";
import { loadValidatedRun } from "./reconciler.ts";
import { readAsyncRunState } from "./lifecycle.ts";
import { subagentAsyncRoot } from "./rpc.ts";
import { garbageCollectSourceReservations } from "./reservations.ts";
import type { GraphConfig, GraphHistoryConfig, GraphSnapshot } from "./types.ts";

export interface HistoryRecord {
	schemaVersion: 1;
	runInstanceId: string;
	graphId: string;
	revision: number;
	terminalAt?: string;
	archivedAt?: string;
	pinnedAt?: string;
	compactedAt?: string;
	restoredAt?: string;
	attentionAcknowledgedAt?: string;
	attentionAcknowledgedFor?: string;
	updatedAt: string;
}

interface HistoryTransaction {
	schemaVersion: 1;
	transactionId: string;
	graphId: string;
	runInstanceId: string;
	fromRevision: number;
	toRevision: number;
	historyDigest: string;
	preparedAt: string;
}

export interface PrunePlan {
	schemaVersion: 1;
	planId: string;
	createdAt: string;
	expiresAt: string;
	planDigest: string;
	entries: Array<{
		graphId: string;
		runInstanceId: string;
		snapshotUpdatedAt: string;
		historyRevision: number;
	}>;
}

export interface TrashRecord {
	schemaVersion: 1;
	trashId: string;
	graphId: string;
	runInstanceId: string;
	trashedAt: string;
	purgeAfter: string;
	sourceRoot: string;
}

export interface TrashInventory {
	valid: TrashRecord[];
	protected: Array<{ trashId: string; reason: string }>;
}

interface RestoreTransaction {
	schemaVersion: 1;
	transactionId: string;
	trashId: string;
	graphId: string;
	runInstanceId: string;
	record: TrashRecord;
	recordDigest: string;
	source: string;
	target: string;
	preparedAt: string;
}

interface PurgeAuthorization {
	schemaVersion: 2;
	kind: "valid-trash" | "protected-trash";
	trashId: string;
	record?: TrashRecord;
	recordDigest?: string;
	source: string;
	staging: string;
	authorizedAt: string;
}

export interface RetentionReport {
	runs: number;
	compacted: string[];
	trashed: string[];
	purged: string[];
	protected: Array<{ graphId: string; reason: string }>;
	graphBytes: number;
	trashBytes: number;
	controlBytes: number;
	subagentBytes: number;
	overSoftLimit: boolean;
}

const DAY = 86_400_000;
const TERMINAL = new Set(["complete", "failed", "blocked", "stopped", "needs_attention"]);
const INITIALIZATION_STAGING = /^\.initialize-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const RESTORE_QUARANTINE_REASON = "invalid restore transaction metadata is isolated; inspect before explicit control discard";

export const DEFAULT_HISTORY_CONFIG: GraphHistoryConfig = {
	autoCompact: true,
	compactAfterDays: 7,
	autoPrune: false,
	emergencyPurge: false,
	pruneAfterDays: 180,
	trashGraceDays: 7,
	maxStorageBytes: 5 * 1024 ** 3,
	targetStorageBytes: 4 * 1024 ** 3,
	keepRecentTerminal: 50,
};

function historyConfig(config: GraphConfig): GraphHistoryConfig {
	return config.history ?? DEFAULT_HISTORY_CONFIG;
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
	if (!validIsoTimestamp(value)) throw new Error(`Invalid ${label} timestamp.`);
}

function validTrashEntryName(value: unknown): value is string {
	return typeof value === "string" && value !== "." && value !== ".." && value.length <= 201 && /^[A-Za-z0-9._-]+$/.test(value);
}

function validTrashId(value: unknown): value is string {
	return validTrashEntryName(value) && value.includes("--");
}

function digestValue(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function prunePlanBody(plan: Omit<PrunePlan, "planDigest"> | PrunePlan): Omit<PrunePlan, "planDigest"> {
	return {
		schemaVersion: plan.schemaVersion,
		planId: plan.planId,
		createdAt: plan.createdAt,
		expiresAt: plan.expiresAt,
		entries: plan.entries,
	};
}

function validatePrunePlan(value: unknown, expectedPlanId?: string): PrunePlan {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid prune plan.");
	const plan = value as Partial<PrunePlan>;
	if (
		plan.schemaVersion !== 1
		|| typeof plan.planId !== "string"
		|| !/^[a-f0-9-]{36}$/i.test(plan.planId)
		|| (expectedPlanId !== undefined && plan.planId !== expectedPlanId)
		|| !Array.isArray(plan.entries)
		|| plan.entries.length !== 1
		|| typeof plan.planDigest !== "string"
	) throw new Error("Invalid prune plan.");
	assertTimestamp(plan.createdAt, "prune plan createdAt");
	assertTimestamp(plan.expiresAt, "prune plan expiresAt");
	if (Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)) throw new Error("Invalid prune plan expiry.");
	for (const entry of plan.entries) {
		if (
			!entry
			|| typeof entry !== "object"
			|| typeof entry.graphId !== "string"
			|| typeof entry.runInstanceId !== "string"
			|| typeof entry.snapshotUpdatedAt !== "string"
			|| !Number.isInteger(entry.historyRevision)
			|| entry.historyRevision < 0
		) throw new Error("Invalid prune plan entry.");
		assertTimestamp(entry.snapshotUpdatedAt, "prune plan snapshotUpdatedAt");
	}
	if (digestValue(prunePlanBody(plan as PrunePlan)) !== plan.planDigest) throw new Error("Prune plan digest mismatch.");
	return plan as PrunePlan;
}

function validateTrashRecord(value: unknown, runsRoot: string, expectedTrashId?: string): TrashRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Trash record.");
	const record = value as Partial<TrashRecord>;
	if (
		record.schemaVersion !== 1
		|| !validTrashId(record.trashId)
		|| (expectedTrashId !== undefined && record.trashId !== expectedTrashId)
		|| typeof record.graphId !== "string"
		|| typeof record.runInstanceId !== "string"
		|| typeof record.sourceRoot !== "string"
	) throw new Error("Invalid Trash record.");
	assertTimestamp(record.trashedAt, "Trash trashedAt");
	assertTimestamp(record.purgeAfter, "Trash purgeAfter");
	if (Date.parse(record.purgeAfter) < Date.parse(record.trashedAt)) throw new Error("Invalid Trash purge window.");
	const expectedSource = new GraphStore(runsRoot, record.graphId).root;
	if (record.sourceRoot !== expectedSource || basename(record.sourceRoot) !== record.graphId) throw new Error("Invalid Trash source root.");
	return record as TrashRecord;
}

async function withRetentionLock<T>(runsRoot: string, purpose: string, action: () => Promise<T>): Promise<T> {
	const directory = join(runsRoot, ".control", "retention-lock", "claims");
	await ensureManagedDirectory(runsRoot, directory, "Retention lock");
	return withExclusiveClaim(directory, { purpose }, action, {
		busyMessage: "Graph retention maintenance is busy.",
	});
}

async function assertCanonicalDirectory(root: string, target: string, label: string): Promise<void> {
	const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
	if (!within(canonicalRoot, canonicalTarget)) throw new Error(`${label} escapes the graph run through a symbolic link.`);
	const info = await lstat(target);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory.`);
}

async function ensureManagedDirectory(root: string, target: string, label: string): Promise<void> {
	await mkdir(root, { recursive: true });
	const rootInfo = await lstat(root);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`${label} root must be a real directory.`);
	const token = relative(root, target);
	if (!within(root, target) || isAbsolute(token)) throw new Error(`${label} escapes its managed root.`);
	let cursor = root;
	for (const part of token.split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} contains a symbolic link or non-directory.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				await mkdir(cursor);
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				const info = await lstat(cursor);
				if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} contains a symbolic link or non-directory.`);
			}
		}
	}
	await assertCanonicalDirectory(root, target, label);
}

async function inspectManagedDirectory(root: string, target: string, label: string): Promise<boolean> {
	const token = relative(root, target);
	if (!within(root, target) || isAbsolute(token)) throw new Error(`${label} escapes its managed root.`);
	try {
		const rootInfo = await lstat(root);
		if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`${label} root must be a real directory.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	let cursor = root;
	for (const part of token.split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} contains a symbolic link or non-directory.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
	await assertCanonicalDirectory(root, target, label);
	return true;
}

async function removeManagedEntry(root: string, target: string, label: string): Promise<void> {
	if (!within(root, target) || target === root) throw new Error(`${label} escapes its managed root.`);
	if (!await inspectManagedDirectory(root, dirname(target), `${label} parent`)) return;
	try {
		const info = await lstat(target);
		if (info.isDirectory() && !info.isSymbolicLink()) {
			await assertCanonicalDirectory(root, target, label);
			await rm(target, { recursive: true });
		} else {
			await rm(target, { force: true });
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function opaqueHandle(prefix: string, name: string): string {
	return `${prefix}-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

function trashEntryHandle(name: string): string {
	return validTrashEntryName(name) ? name : opaqueHandle("invalid-trash", name);
}

function legacyRunInstance(snapshot: GraphSnapshot): string {
	return `legacy-${createHash("sha256").update(`${snapshot.graphId}\0${snapshot.createdAt}`).digest("hex").slice(0, 32)}`;
}

function runInstance(snapshot: GraphSnapshot): string {
	return snapshot.schemaVersion === 2 ? snapshot.runInstanceId : legacyRunInstance(snapshot);
}

function retentionTimestamp(snapshot: GraphSnapshot, history: HistoryRecord): string {
	const candidates = [history.terminalAt, snapshot.updatedAt].filter((value): value is string => Boolean(value));
	return candidates.sort().at(-1) ?? snapshot.updatedAt;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function entryExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function directoryBytes(path: string): Promise<number> {
	const pending = [path];
	let total = 0;
	while (pending.length) {
		const batch = pending.splice(0, 64);
		const entries = await Promise.all(batch.map(async (current) => {
			try {
				const info = await lstat(current);
				const children = info.isDirectory() && !info.isSymbolicLink() ? await readdir(current) : [];
				return { current, info, children };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		}));
		for (const entry of entries) {
			if (!entry) continue;
			total += entry.info.size;
			for (const child of entry.children) pending.push(join(entry.current, child));
		}
	}
	return total;
}

export async function listInitializationStaging(runsRoot: string): Promise<Array<{ name: string; graphId?: string; bytes: number }>> {
	let entries;
	try {
		const info = await lstat(runsRoot);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Graph runs root must be a real directory.");
		entries = await readdir(runsRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const output: Array<{ name: string; graphId?: string; bytes: number }> = [];
	for (const entry of entries) {
		if (!entry.name.startsWith(".initialize-")) continue;
		const match = INITIALIZATION_STAGING.exec(entry.name);
		let graphId: string | undefined;
		if (match) {
			try {
				graphId = basename(new GraphStore(runsRoot, match[1]!).root);
			} catch {
				graphId = undefined;
			}
		}
		output.push({ name: entry.name, ...(graphId ? { graphId } : {}), bytes: await directoryBytes(join(runsRoot, entry.name)) });
	}
	return output;
}

async function garbageCollectInitializationStaging(runsRoot: string): Promise<Array<{ graphId: string; reason: string }>> {
	const protectedEntries: Array<{ graphId: string; reason: string }> = [];
	for (const entry of await listInitializationStaging(runsRoot)) {
		if (entry.graphId) {
			try {
				const claims = await liveClaims<{ epoch: string }>(join(runsRoot, ".control", "graph-locks", entry.graphId, "claims"));
				if (claims.length) {
					protectedEntries.push({ graphId: entry.name, reason: "initialization staging is owned by a live Graph Supervisor" });
					continue;
				}
			} catch (error) {
				protectedEntries.push({ graphId: entry.name, reason: `initialization staging ownership could not be verified: ${error instanceof Error ? error.message : String(error)}` });
				continue;
			}
		}
		await removeManagedEntry(runsRoot, join(runsRoot, entry.name), "Abandoned graph initialization staging");
	}
	await syncDirectory(runsRoot);
	return protectedEntries;
}

async function garbageCollectGraphLockQuarantine(runsRoot: string): Promise<void> {
	const root = join(runsRoot, ".control", "graph-lock-quarantine");
	if (!await inspectManagedDirectory(runsRoot, root, "Graph lock quarantine")) return;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		await removeManagedEntry(root, join(root, entry.name), "Detached Graph lock quarantine");
	}
	await syncDirectory(root);
}

async function garbageCollectInvalidGraphLockEntry(runsRoot: string, root: string, name: string): Promise<void> {
	let graphId: string | undefined;
	try {
		graphId = validateGraphId(name);
	} catch {
		// Invalid Graph ids can never be claimed by GraphStore.
	}
	const removeIfStillInvalid = async () => {
		const path = join(root, name);
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isDirectory()) {
				await rm(path, { force: true });
				await syncDirectory(root);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	if (graphId) {
		await GraphStore.withGraphLockMutationGate(runsRoot, graphId, `collect-invalid:${graphId}`, removeIfStillInvalid);
	} else {
		await removeIfStillInvalid();
	}
}

async function quarantineOrphanGraphLock(runsRoot: string, graphId: string): Promise<void> {
	let quarantine: string | undefined;
	await GraphStore.withGraphLockMutationGate(runsRoot, graphId, `collect:${graphId}`, async () => {
		if (await entryExists(join(runsRoot, graphId))) return;
		if ((await listInitializationStaging(runsRoot)).some((entry) => entry.graphId === graphId)) return;
		const lockRoot = join(runsRoot, ".control", "graph-locks");
		const graphRoot = join(lockRoot, graphId);
		if (!await inspectManagedDirectory(lockRoot, graphRoot, "Orphan Graph lock entry")) return;
		if ((await liveClaims<{ epoch: string }>(join(graphRoot, "claims"))).length) return;
		if (await entryExists(join(runsRoot, graphId))) return;
		if ((await listInitializationStaging(runsRoot)).some((entry) => entry.graphId === graphId)) return;
		const quarantineRoot = join(runsRoot, ".control", "graph-lock-quarantine");
		await ensureManagedDirectory(runsRoot, quarantineRoot, "Graph lock quarantine");
		quarantine = join(quarantineRoot, `${graphId}-${Date.now()}-${randomUUID()}`);
		await rename(graphRoot, quarantine);
		await Promise.all([syncDirectory(lockRoot), syncDirectory(quarantineRoot)]);
	});
	if (quarantine) await removeManagedEntry(dirname(quarantine), quarantine, "Detached orphan Graph lock metadata");
}

async function garbageCollectGenerationQuarantines(runsRoot: string): Promise<void> {
	await garbageCollectGraphLockQuarantine(runsRoot);
	const gateRoot = join(runsRoot, ".control", "graph-lock-gate");
	if (await inspectManagedDirectory(runsRoot, gateRoot, "Graph lock mutation gate")) {
		const gateClaims = join(gateRoot, "claims");
		if (await inspectManagedDirectory(gateRoot, gateClaims, "Graph lock mutation claims")) await liveClaims(gateClaims);
	}
	const root = join(runsRoot, ".control", "graph-locks");
	if (!await inspectManagedDirectory(runsRoot, root, "Graph lock directory")) return;
	const publishedGraphs = new Set(await GraphStore.discover(runsRoot));
	const initializationOwners = new Set((await listInitializationStaging(runsRoot)).flatMap((entry) => entry.graphId ? [entry.graphId] : []));
	const entries = await readdir(root, { withFileTypes: true });
	for (let offset = 0; offset < entries.length; offset += 32) {
		await Promise.all(entries.slice(offset, offset + 32).map(async (graphEntry) => {
			const graphRoot = join(root, graphEntry.name);
			if (!graphEntry.isDirectory() || graphEntry.isSymbolicLink()) {
				await garbageCollectInvalidGraphLockEntry(runsRoot, root, graphEntry.name);
				return;
			}
			if (!publishedGraphs.has(graphEntry.name) && !initializationOwners.has(graphEntry.name)) {
				await quarantineOrphanGraphLock(runsRoot, graphEntry.name);
				return;
			}
			const names = await readdir(graphRoot);
			const quarantines = names.filter((name) => name.startsWith("generation.invalid-"));
			if (!quarantines.length) return;
			if (!await inspectManagedDirectory(root, graphRoot, "Graph lock entry")) return;
			let currentValid = false;
			try {
				const current = JSON.parse(await readFile(join(graphRoot, "generation.json"), "utf8")) as { version?: unknown; graphId?: unknown; generation?: unknown };
				currentValid = current.version === 1
					&& (current.graphId === undefined || current.graphId === graphEntry.name)
					&& Number.isSafeInteger(current.generation)
					&& (current.generation as number) >= 0;
			} catch {
				currentValid = false;
			}
			if (!currentValid) return;
			for (const name of quarantines) {
				await removeManagedEntry(graphRoot, join(graphRoot, name), "Recovered fencing generation quarantine");
			}
		}));
	}
	await syncDirectory(root);
}

export async function readHistory(store: GraphStore, snapshot?: GraphSnapshot, options: { allowPendingLifecycle?: boolean } = {}): Promise<HistoryRecord> {
	const state = snapshot ?? await store.loadSnapshot();
	try {
		const record = JSON.parse(await readFile(store.path("history.json"), "utf8")) as HistoryRecord;
		if (record.schemaVersion !== 1 || record.graphId !== state.graphId || record.runInstanceId !== runInstance(state) || !Number.isInteger(record.revision) || record.revision < 0) throw new Error("Invalid graph history record.");
		assertTimestamp(record.updatedAt, "history updatedAt");
		for (const [label, value] of Object.entries({
			terminalAt: record.terminalAt,
			archivedAt: record.archivedAt,
			pinnedAt: record.pinnedAt,
			compactedAt: record.compactedAt,
			restoredAt: record.restoredAt,
			attentionAcknowledgedAt: record.attentionAcknowledgedAt,
			attentionAcknowledgedFor: record.attentionAcknowledgedFor,
		})) {
			if (value !== undefined) assertTimestamp(value, `history ${label}`);
		}
		if (record.terminalAt && record.compactedAt && Date.parse(record.compactedAt) < Date.parse(record.terminalAt)) throw new Error("Graph history compaction predates terminal completion.");
		if (state.schemaVersion === 2) {
			if (record.terminalAt !== undefined && record.terminalAt !== state.terminalAt) throw new Error("Graph history terminalAt does not match the v2 snapshot.");
			const pending = options.allowPendingLifecycle === true && record.revision === state.lifecycleRevision + 1;
			if (record.revision !== state.lifecycleRevision && !pending) throw new Error("Graph history revision does not match the v2 snapshot.");
		}
		return record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (state.schemaVersion === 2 && state.lifecycleRevision !== 0) throw new Error("Graph history is missing for a nonzero v2 lifecycle revision.");
		const terminalAt = state.schemaVersion === 2 ? state.terminalAt : TERMINAL.has(state.status) ? state.updatedAt : undefined;
		return {
			schemaVersion: 1,
			runInstanceId: runInstance(state),
			graphId: state.graphId,
			revision: 0,
			...(terminalAt ? { terminalAt } : {}),
			updatedAt: state.updatedAt,
		};
	}
}

async function writeHistory(store: GraphStore, snapshot: GraphSnapshot, history: HistoryRecord): Promise<void> {
	const next: HistoryRecord = { ...history, revision: history.revision + 1, updatedAt: new Date().toISOString() };
	if (snapshot.schemaVersion !== 2) {
		await store.writeJson("history.json", next);
		Object.assign(history, next);
		return;
	}
	if (snapshot.lifecycleRevision !== history.revision) throw new Error("Cannot update history from a mismatched lifecycle revision.");
	const transaction: HistoryTransaction = {
		schemaVersion: 1,
		transactionId: randomUUID(),
		graphId: snapshot.graphId,
		runInstanceId: snapshot.runInstanceId,
		fromRevision: history.revision,
		toRevision: next.revision,
		historyDigest: digestValue(next),
		preparedAt: new Date().toISOString(),
	};
	await store.writeJson("history-transaction.json", transaction);
	await store.writeJson("history.json", next);
	Object.assign(history, next);
	snapshot.lifecycleRevision = next.revision;
	await store.saveSnapshot(snapshot);
	await rm(store.path("history-transaction.json"), { force: true });
}

async function openTransaction(store: GraphStore, snapshot: GraphSnapshot): Promise<boolean> {
	for (const state of Object.values(snapshot.nodes)) {
		for (const attempt of state.attempts) {
			const status = await store.readApplyPlanStatus(state.taskId, attempt.attempt);
			if (status === "prepared" || status === "applying") return true;
		}
	}
	return false;
}

async function activeChild(snapshot: GraphSnapshot): Promise<boolean> {
	for (const state of Object.values(snapshot.nodes)) {
		const attempt = state.attempts.at(-1);
		if (!attempt || ["accepted", "failed", "blocked", "stopped"].includes(attempt.status)) continue;
		if (!attempt.asyncId || !attempt.asyncDir) return true;
		try {
			const child = await readAsyncRunState(attempt.asyncId, attempt.asyncDir);
			if (child === "running" || child === "queued" || child === "paused") return true;
			if (child === undefined) return true;
		} catch {
			return true;
		}
	}
	return false;
}

async function protectionReason(store: GraphStore, snapshot: GraphSnapshot, history: HistoryRecord): Promise<string | undefined> {
	if (!isTerminalGraphStatus(snapshot.status)) return "run is active";
	const attentionToken = snapshot.schemaVersion === 2 ? snapshot.attentionAt ?? snapshot.updatedAt : snapshot.updatedAt;
	const acknowledged = history.attentionAcknowledgedAt !== undefined && history.attentionAcknowledgedFor === attentionToken;
	if (snapshot.status === "needs_attention" && !acknowledged) return "run needs attention and its current incident has not been acknowledged";
	if (history.pinnedAt) return "run is pinned";
	if (history.archivedAt) return "run is archived";
	if (await openTransaction(store, snapshot)) return "source transaction is open";
	if (await activeChild(snapshot)) return "child is still active or cannot be verified";
	if (await exists(store.path("incidents")) && !acknowledged) return "run has an unacknowledged protected incident";
	return undefined;
}

async function allowedCompactionTokens(store: GraphStore, snapshot: GraphSnapshot): Promise<string[]> {
	const candidates = new Set<string>();
	for (const state of Object.values(snapshot.nodes)) {
			for (const attempt of state.attempts) {
				const attemptRoot = store.path("nodes", state.taskId, `attempt-${attempt.attempt}`);
				const session = join(attemptRoot, "session");
				candidates.add(relative(store.root, session));
				if (attempt.workspaceKind === "shadow" && attempt.workspaceDir && within(attemptRoot, attempt.workspaceDir)) {
					candidates.add(relative(store.root, attempt.workspaceDir));
				}
				const planStatus = await store.readApplyPlanStatus(state.taskId, attempt.attempt);
				const backups = join(attemptRoot, "backups");
				if (planStatus === "committed" || planStatus === "rolled_back") candidates.add(relative(store.root, backups));
		}
	}
	return [...candidates].sort();
}

async function compactCandidates(store: GraphStore, snapshot: GraphSnapshot): Promise<string[]> {
	const candidates: string[] = [];
	for (const token of await allowedCompactionTokens(store, snapshot)) {
		const candidate = store.path(token);
		if (!await exists(candidate)) continue;
		await assertCanonicalDirectory(store.root, candidate, "Compaction candidate");
		candidates.push(candidate);
	}
	return candidates;
}

interface CompactionRecord {
	schemaVersion: 1;
	planId: string;
	status: "prepared" | "committed" | "rolled_back";
	candidates: string[];
	preparedAt: string;
	committedAt?: string;
	rolledBackAt?: string;
	error?: string;
}

function validateCompactionRecord(value: unknown, allowed: Set<string>): CompactionRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid compaction record.");
	const record = value as Partial<CompactionRecord>;
	if (
		record.schemaVersion !== 1
		|| typeof record.planId !== "string"
		|| !/^[a-f0-9-]{36}$/i.test(record.planId)
		|| !["prepared", "committed", "rolled_back"].includes(record.status ?? "")
		|| (record.candidates !== undefined && !Array.isArray(record.candidates))
		|| (record.candidates ?? []).some((candidate) => typeof candidate !== "string" || !allowed.has(candidate))
	) throw new Error("Invalid compaction record or candidate set.");
	const compatiblePreparedAt = record.preparedAt ?? record.committedAt ?? record.rolledBackAt;
	assertTimestamp(compatiblePreparedAt, "compaction preparedAt");
	if (record.committedAt !== undefined) assertTimestamp(record.committedAt, "compaction committedAt");
	if (record.rolledBackAt !== undefined) assertTimestamp(record.rolledBackAt, "compaction rolledBackAt");
	return { ...record, candidates: record.candidates ?? [], preparedAt: compatiblePreparedAt } as CompactionRecord;
}

async function removeStaging(store: GraphStore, staging: string): Promise<void> {
	if (!await exists(staging)) return;
	await assertCanonicalDirectory(store.root, staging, "Compaction staging directory");
	await rm(staging, { recursive: true });
}

async function reconcileLifecycleRevision(store: GraphStore, snapshot: GraphSnapshot, history: HistoryRecord): Promise<void> {
	if (snapshot.schemaVersion !== 2) return;
	let transaction: HistoryTransaction | undefined;
	try {
		transaction = JSON.parse(await readFile(store.path("history-transaction.json"), "utf8")) as HistoryTransaction;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (transaction) {
		if (
			transaction.schemaVersion !== 1
			|| !/^[a-f0-9-]{36}$/i.test(transaction.transactionId)
			|| transaction.graphId !== snapshot.graphId
			|| transaction.runInstanceId !== snapshot.runInstanceId
			|| !Number.isInteger(transaction.fromRevision)
			|| transaction.toRevision !== transaction.fromRevision + 1
			|| typeof transaction.historyDigest !== "string"
		) throw new Error("Invalid graph history transaction.");
		assertTimestamp(transaction.preparedAt, "history transaction preparedAt");
		if (history.revision === transaction.fromRevision && snapshot.lifecycleRevision === transaction.fromRevision) {
			await rm(store.path("history-transaction.json"), { force: true });
		} else if (history.revision === transaction.toRevision && digestValue(history) === transaction.historyDigest) {
			if (snapshot.lifecycleRevision === transaction.fromRevision) {
				snapshot.lifecycleRevision = transaction.toRevision;
				await store.saveSnapshot(snapshot);
			} else if (snapshot.lifecycleRevision !== transaction.toRevision) {
				throw new Error("Graph history transaction conflicts with the snapshot lifecycle revision.");
			}
			await rm(store.path("history-transaction.json"), { force: true });
		} else {
			throw new Error("Graph history transaction does not match durable history.");
		}
	}
	if (snapshot.lifecycleRevision !== history.revision) throw new Error("Graph lifecycle revision is not authorized by a durable history transaction.");
	if (snapshot.terminalAt && history.terminalAt === undefined) {
		history.terminalAt = snapshot.terminalAt;
		await writeHistory(store, snapshot, history);
	}
}

async function recoverCompaction(store: GraphStore, history: HistoryRecord, allowedCandidates: string[]): Promise<void> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(store.path("compaction.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const allowed = new Set(allowedCandidates);
	const record = validateCompactionRecord(raw, allowed);
	const staging = store.path(".compact-staging", record.planId);
	if (record.status === "committed") {
		if (!history.compactedAt) throw new Error("Committed compaction is missing its history commit.");
		await removeStaging(store, staging);
		return;
	}
	if (record.status === "rolled_back" && history.compactedAt) throw new Error("Rolled-back compaction conflicts with committed history.");
	if (record.status === "prepared" && history.compactedAt) {
		for (const candidate of record.candidates) {
			if (await exists(store.path(candidate))) throw new Error(`Committed compaction candidate unexpectedly reappeared: ${candidate}`);
		}
		await removeStaging(store, staging);
		await store.writeJson("compaction.json", { ...record, status: "committed", committedAt: history.compactedAt });
		return;
	}
	for (const candidate of [...record.candidates].reverse()) {
		const source = store.path(candidate);
		const target = join(staging, candidate);
		const sourceExists = await exists(source);
		const targetExists = await exists(target);
		if (sourceExists && targetExists) throw new Error(`Compaction recovery found duplicate source and staging data: ${candidate}`);
		if (!sourceExists && !targetExists) throw new Error(`Compaction recovery cannot locate candidate data: ${candidate}`);
		if (targetExists) {
			await assertCanonicalDirectory(store.root, target, "Compaction recovery candidate");
			await mkdir(dirname(source), { recursive: true });
			await rename(target, source);
		}
	}
	await removeStaging(store, staging);
	await store.writeJson("compaction.json", {
		...record,
		status: "rolled_back",
		rolledBackAt: new Date().toISOString(),
		error: record.error ?? "Recovered an interrupted compaction.",
	});
}

export async function compactRun(runsRoot: string, graphId: string, options: { force?: boolean; compactAfterDays?: number } = {}): Promise<{ compacted: boolean; bytesReclaimed: number; reason?: string }> {
	const store = new GraphStore(runsRoot, graphId);
	const release = await store.acquireSupervisor(`retention-compact-${randomUUID()}`);
	try {
		const snapshot = await store.loadSnapshot();
		const history = await readHistory(store, snapshot, { allowPendingLifecycle: true });
		const allowedCandidates = await allowedCompactionTokens(store, snapshot);
		await recoverCompaction(store, history, allowedCandidates);
		const candidates = await compactCandidates(store, snapshot);
		await reconcileLifecycleRevision(store, snapshot, history);
		if (snapshot.schemaVersion === 2) await loadValidatedRun(store, Number.MAX_SAFE_INTEGER);
		const protectedReason = await protectionReason(store, snapshot, history);
		if (protectedReason) return { compacted: false, bytesReclaimed: 0, reason: protectedReason };
		if (!["complete", "stopped"].includes(snapshot.status)) return { compacted: false, bytesReclaimed: 0, reason: "only complete or stopped runs compact automatically" };
		if (history.compactedAt) return { compacted: false, bytesReclaimed: 0, reason: "already compacted" };
		const terminalAt = Date.parse(retentionTimestamp(snapshot, history));
		const age = Date.now() - terminalAt;
		if (!options.force && age < (options.compactAfterDays ?? 7) * DAY) return { compacted: false, bytesReclaimed: 0, reason: "retention age not reached" };
		const before = (await Promise.all(candidates.map(directoryBytes))).reduce((sum, bytes) => sum + bytes, 0);
		const planId = randomUUID();
		const staging = store.path(".compact-staging", planId);
		const moved: Array<{ source: string; target: string }> = [];
		const candidateTokens = candidates.map((path) => relative(store.root, path));
		const preparedAt = new Date().toISOString();
		await store.writeJson("compaction.json", { schemaVersion: 1, planId, status: "prepared", candidates: candidateTokens, preparedAt });
		let commitBoundaryCrossed = false;
		try {
			const stagingRoot = store.path(".compact-staging");
			await mkdir(stagingRoot, { recursive: true });
			await assertCanonicalDirectory(store.root, stagingRoot, "Compaction staging root");
			for (const source of candidates) {
				await assertCanonicalDirectory(store.root, source, "Compaction candidate");
				const target = join(staging, relative(store.root, source));
				await mkdir(dirname(target), { recursive: true });
				await rename(source, target);
				moved.push({ source, target });
			}
			await store.loadSnapshot();
			await store.loadGraph();
			if (snapshot.schemaVersion === 2) await loadValidatedRun(store, Number.MAX_SAFE_INTEGER);
			history.compactedAt = new Date().toISOString();
			history.terminalAt ??= snapshot.schemaVersion === 2 ? snapshot.terminalAt : snapshot.updatedAt;
			commitBoundaryCrossed = true;
			await writeHistory(store, snapshot, history);
			await store.writeJson("compaction.json", { schemaVersion: 1, planId, status: "committed", candidates: candidateTokens, preparedAt, committedAt: history.compactedAt });
			await removeStaging(store, staging);
			await store.event("graph.compacted", { bytesReclaimed: before }).catch(() => undefined);
			return { compacted: true, bytesReclaimed: before };
		} catch (error) {
			if (commitBoundaryCrossed) throw error;
			for (const entry of moved.reverse()) {
				if (!await exists(entry.target)) continue;
				await assertCanonicalDirectory(store.root, entry.target, "Compaction rollback candidate");
				await mkdir(dirname(entry.source), { recursive: true });
				await rename(entry.target, entry.source);
				}
				await removeStaging(store, staging);
				await store.writeJson("compaction.json", { schemaVersion: 1, planId, status: "rolled_back", candidates: candidateTokens, preparedAt, error: error instanceof Error ? error.message : String(error), rolledBackAt: new Date().toISOString() });
				throw error;
			}
	} finally {
		await release();
	}
}

async function recoverRunRetentionState(runsRoot: string, graphId: string): Promise<void> {
	const store = new GraphStore(runsRoot, graphId);
	const release = await store.acquireSupervisor(`retention-recover-${randomUUID()}`);
	try {
		const snapshot = await store.loadSnapshot();
		const history = await readHistory(store, snapshot, { allowPendingLifecycle: true });
		await recoverCompaction(store, history, await allowedCompactionTokens(store, snapshot));
		await reconcileLifecycleRevision(store, snapshot, history);
		if (snapshot.schemaVersion === 2) await loadValidatedRun(store, Number.MAX_SAFE_INTEGER);
	} finally {
		await release();
	}
}

async function needsRunRetentionRecovery(store: GraphStore, snapshot: GraphSnapshot, history: HistoryRecord): Promise<boolean> {
	if (snapshot.schemaVersion === 2 && snapshot.lifecycleRevision !== history.revision) return true;
	if (snapshot.schemaVersion === 2 && snapshot.terminalAt && history.terminalAt === undefined) return true;
	if (await entryExists(store.path("history-transaction.json"))) return true;
	try {
		const record = JSON.parse(await readFile(store.path("compaction.json"), "utf8")) as Partial<CompactionRecord>;
		if (record.schemaVersion !== 1 || !["prepared", "committed", "rolled_back"].includes(record.status ?? "") || typeof record.planId !== "string") return true;
		if (record.status === "prepared") return true;
		if (record.status === "committed" && await entryExists(store.path(".compact-staging", record.planId))) return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
	}
	return false;
}

function automaticCompactionPreflight(snapshot: GraphSnapshot, history: HistoryRecord, compactAfterDays: number): { candidate: boolean; protectedReason?: string } {
	if (!isTerminalGraphStatus(snapshot.status)) return { candidate: false, protectedReason: "run is active" };
	const attentionToken = snapshot.schemaVersion === 2 ? snapshot.attentionAt ?? snapshot.updatedAt : snapshot.updatedAt;
	const acknowledged = history.attentionAcknowledgedAt !== undefined && history.attentionAcknowledgedFor === attentionToken;
	if (snapshot.status === "needs_attention" && !acknowledged) return { candidate: false, protectedReason: "run needs attention and its current incident has not been acknowledged" };
	if (history.pinnedAt) return { candidate: false, protectedReason: "run is pinned" };
	if (history.archivedAt) return { candidate: false, protectedReason: "run is archived" };
	if (!["complete", "stopped"].includes(snapshot.status) || history.compactedAt) return { candidate: false };
	if (Date.now() - Date.parse(retentionTimestamp(snapshot, history)) < compactAfterDays * DAY) return { candidate: false };
	return { candidate: true };
}

export async function updateHistoryFlag(runsRoot: string, graphId: string, action: "pin" | "unpin" | "archive" | "unarchive" | "acknowledge"): Promise<HistoryRecord> {
	const store = new GraphStore(runsRoot, graphId);
	const release = await store.acquireSupervisor(`history-${action}-${randomUUID()}`);
	try {
		const snapshot = await store.loadSnapshot();
		const history = await readHistory(store, snapshot);
		const now = new Date().toISOString();
		if (action === "acknowledge") {
			if (!isTerminalGraphStatus(snapshot.status)) throw new Error("Only terminal graph runs can be acknowledged.");
			if (await openTransaction(store, snapshot)) throw new Error("Cannot acknowledge a graph with an open source transaction.");
			if (await activeChild(snapshot)) throw new Error("Cannot acknowledge a graph while a child is active or unverifiable.");
			if (snapshot.schemaVersion === 2 && snapshot.status === "needs_attention" && !snapshot.attentionAt) snapshot.attentionAt = now;
			history.attentionAcknowledgedAt = now;
			history.attentionAcknowledgedFor = snapshot.schemaVersion === 2 ? snapshot.attentionAt ?? snapshot.updatedAt : snapshot.updatedAt;
		}
		if (action === "pin") history.pinnedAt = now;
		if (action === "unpin") delete history.pinnedAt;
		if (action === "archive") history.archivedAt = now;
		if (action === "unarchive") delete history.archivedAt;
		await writeHistory(store, snapshot, history);
		await store.event(`graph.${action}`);
		return history;
	} finally {
		await release();
	}
}

async function eligibleForTrash(store: GraphStore, snapshot: GraphSnapshot, history: HistoryRecord, automatic = false): Promise<string | undefined> {
	const protectedReason = await protectionReason(store, snapshot, history);
	if (protectedReason) return protectedReason;
	if (automatic && !["complete", "stopped"].includes(snapshot.status)) return "automatic pruning only applies to complete or stopped runs";
	if (!automatic && !["complete", "failed", "blocked", "stopped", "needs_attention"].includes(snapshot.status)) return "only terminal runs can enter Trash";
	return undefined;
}

export async function createPrunePlan(runsRoot: string, graphIds: string[]): Promise<PrunePlan> {
	if (graphIds.length !== 1) throw new Error("A prune plan must authorize exactly one graph.");
	return withRetentionLock(runsRoot, "create-prune-plan", async () => {
		const entries: PrunePlan["entries"] = [];
		for (const graphId of graphIds) {
			const store = new GraphStore(runsRoot, graphId);
			const snapshot = await store.loadSnapshot();
			if (snapshot.schemaVersion === 2) await loadValidatedRun(store, Number.MAX_SAFE_INTEGER);
			const history = await readHistory(store, snapshot);
			const reason = await eligibleForTrash(store, snapshot, history);
			if (reason) throw new Error(`Graph '${graphId}' is protected: ${reason}.`);
			entries.push({ graphId, runInstanceId: runInstance(snapshot), snapshotUpdatedAt: snapshot.updatedAt, historyRevision: history.revision });
		}
		const now = Date.now();
		const body: Omit<PrunePlan, "planDigest"> = { schemaVersion: 1, planId: randomUUID(), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(), entries };
		const plan: PrunePlan = { ...body, planDigest: digestValue(body) };
		const root = join(runsRoot, ".control", "prune-plans");
		await ensureManagedDirectory(runsRoot, root, "Prune plan directory");
		await atomicWriteJson(join(root, `${plan.planId}.json`), plan);
		return plan;
	});
}

export async function cancelPrunePlan(runsRoot: string, planId: string): Promise<void> {
	if (!/^[a-f0-9-]{36}$/i.test(planId)) throw new Error("Invalid prune plan id.");
		await withRetentionLock(runsRoot, `cancel-prune:${planId}`, async () => {
			const root = join(runsRoot, ".control", "prune-plans");
			await ensureManagedDirectory(runsRoot, root, "Prune plan directory");
			await removeManagedEntry(root, join(root, `${planId}.json`), "Prune plan cancellation target");
		});
}

async function ensureTrashRoot(runsRoot: string): Promise<string> {
	const root = join(runsRoot, ".trash");
	await mkdir(root, { recursive: true });
	await assertCanonicalDirectory(runsRoot, root, "Trash root");
	return root;
}

export async function executePrunePlan(runsRoot: string, planId: string, trashGraceDays: number, expectedDigest: string): Promise<string[]> {
	if (!/^[a-f0-9-]{36}$/i.test(planId)) throw new Error("Invalid prune plan id.");
	if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/i.test(expectedDigest)) throw new Error("Expected prune plan digest is required.");
	return withRetentionLock(runsRoot, `trash:${planId}`, async () => {
		const planRoot = join(runsRoot, ".control", "prune-plans");
		await ensureManagedDirectory(runsRoot, planRoot, "Prune plan directory");
		const path = join(planRoot, `${planId}.json`);
		const plan = validatePrunePlan(JSON.parse(await readFile(path, "utf8")), planId);
		if (plan.planDigest !== expectedDigest) throw new Error("Prune plan confirmation digest mismatch.");
		if (Date.parse(plan.expiresAt) < Date.now()) throw new Error("Prune plan is expired.");
		const entry = plan.entries[0]!;
		const store = new GraphStore(runsRoot, entry.graphId);
		const release = await store.acquireSupervisor(`retention-trash-${randomUUID()}`);
		try {
			const snapshot = await store.loadSnapshot();
			if (snapshot.schemaVersion === 2) await loadValidatedRun(store, Number.MAX_SAFE_INTEGER);
			const history = await readHistory(store, snapshot);
			if (runInstance(snapshot) !== entry.runInstanceId || snapshot.updatedAt !== entry.snapshotUpdatedAt || history.revision !== entry.historyRevision) throw new Error(`Prune plan became stale for '${entry.graphId}'.`);
			const reason = await eligibleForTrash(store, snapshot, history);
			if (reason) throw new Error(`Graph '${entry.graphId}' became protected: ${reason}.`);
			const trashId = `${entry.graphId}--${entry.runInstanceId}`;
			const trashRoot = await ensureTrashRoot(runsRoot);
			const target = join(trashRoot, trashId);
			if (await exists(target)) throw new Error(`Trash target already exists: ${trashId}`);
			const trashedAt = new Date();
			const record: TrashRecord = {
				schemaVersion: 1,
				trashId,
				graphId: entry.graphId,
				runInstanceId: entry.runInstanceId,
				trashedAt: trashedAt.toISOString(),
				purgeAfter: new Date(trashedAt.getTime() + Math.max(0, trashGraceDays) * DAY).toISOString(),
				sourceRoot: store.root,
			};
			await store.writeJson("trash.json", record);
			await store.event("graph.trashed", { trashId });
			await rm(path, { force: true });
			try {
				await rename(store.root, target);
			} catch (error) {
				await rm(store.path("trash.json"), { force: true });
				throw error;
			}
			return [trashId];
		} finally {
			await release();
		}
	});
}

export async function listTrashInventory(runsRoot: string): Promise<TrashInventory> {
	const root = join(runsRoot, ".trash");
	let entries;
	try {
		const rootInfo = await lstat(root);
		if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return { valid: [], protected: [{ trashId: ".", reason: "Trash root is not a real directory." }] };
		await assertCanonicalDirectory(runsRoot, root, "Trash root");
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { valid: [], protected: [] };
		throw error;
	}
	const output: TrashInventory = { valid: [], protected: [] };
	for (const entry of entries) {
		const trashId = trashEntryHandle(entry.name);
		const opaqueReason = trashId === entry.name ? "" : " Use the displayed opaque handle for explicit discard.";
		if (!entry.isDirectory()) {
			output.protected.push({ trashId, reason: `${entry.isSymbolicLink() ? "Trash entry is a symbolic link." : "Trash entry is not a directory."}${opaqueReason}` });
			continue;
		}
		try {
			const target = join(root, entry.name);
			await assertCanonicalDirectory(root, target, "Trash entry");
			if (await exists(join(target, "restore-protection.json"))) {
				const protection = JSON.parse(await readFile(join(target, "restore-protection.json"), "utf8")) as { reason?: unknown };
				throw new Error(`Restore protection: ${typeof protection.reason === "string" ? protection.reason : "evidence validation failed"}`);
			}
			const record = validateTrashRecord(JSON.parse(await readFile(join(target, "trash.json"), "utf8")), runsRoot, entry.name);
			output.valid.push(record);
			} catch (error) {
				output.protected.push({ trashId, reason: `${error instanceof Error ? error.message : String(error)}${opaqueReason}` });
			}
	}
	output.valid.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
	output.protected.sort((a, b) => a.trashId.localeCompare(b.trashId));
	return output;
}

export async function listTrash(runsRoot: string): Promise<TrashRecord[]> {
	return (await listTrashInventory(runsRoot)).valid;
}

function validateRestoreTransaction(value: unknown, runsRoot: string, expectedName?: string): RestoreTransaction {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid restore transaction.");
	const transaction = value as Partial<RestoreTransaction>;
	if (
		transaction.schemaVersion !== 1
		|| !/^[a-f0-9-]{36}$/i.test(transaction.transactionId ?? "")
		|| !validTrashId(transaction.trashId)
		|| (expectedName !== undefined && expectedName !== `${transaction.trashId}.json`)
		|| typeof transaction.graphId !== "string"
		|| typeof transaction.runInstanceId !== "string"
		|| typeof transaction.recordDigest !== "string"
		|| !transaction.record
	) throw new Error("Invalid restore transaction.");
	assertTimestamp(transaction.preparedAt, "restore transaction preparedAt");
	const record = validateTrashRecord(transaction.record, runsRoot, transaction.trashId);
	const source = join(runsRoot, ".trash", transaction.trashId);
	const target = new GraphStore(runsRoot, transaction.graphId).root;
	if (
		record.graphId !== transaction.graphId
		|| record.runInstanceId !== transaction.runInstanceId
		|| digestValue(record) !== transaction.recordDigest
		|| transaction.source !== source
		|| transaction.target !== target
	) throw new Error("Restore transaction identity or paths do not match.");
	return transaction as RestoreTransaction;
}

async function restoreTransactionRoot(runsRoot: string): Promise<string> {
	const root = join(runsRoot, ".control", "restore-transactions");
	await ensureManagedDirectory(runsRoot, root, "Restore transaction directory");
	return root;
}

async function restoreQuarantineRoot(runsRoot: string): Promise<string> {
	const root = join(runsRoot, ".control", "restore-quarantine");
	await ensureManagedDirectory(runsRoot, root, "Restore quarantine directory");
	return root;
}

async function quarantineRestoreTransaction(runsRoot: string, source: string, name: string): Promise<string> {
	const root = await restoreQuarantineRoot(runsRoot);
	const target = join(root, `${opaqueHandle("restore", name)}.invalid`);
	if (await entryExists(target)) await removeManagedEntry(dirname(source), source, "Duplicate invalid restore transaction");
	else await rename(source, target);
	return basename(target);
}

async function protectRestoreFailure(runsRoot: string, source: string, transaction: RestoreTransaction, error: unknown): Promise<void> {
	await assertCanonicalDirectory(join(runsRoot, ".trash"), source, "Restore rollback source");
	const reason = error instanceof Error ? error.message : String(error);
	await atomicWriteJson(join(source, "restore-protection.json"), {
		schemaVersion: 1,
		transactionId: transaction.transactionId,
		trashId: transaction.trashId,
		reason,
		protectedAt: new Date().toISOString(),
	});
}

async function commitRestoreTransaction(runsRoot: string, transaction: RestoreTransaction): Promise<void> {
	const store = new GraphStore(runsRoot, transaction.graphId);
	const release = await store.acquireSupervisor(`retention-restore-${randomUUID()}`);
	try {
		let snapshot = await store.loadSnapshot();
		if (runInstance(snapshot) !== transaction.runInstanceId) throw new Error("Restored run instance does not match its restore transaction.");
		if (snapshot.schemaVersion === 2) await loadValidatedRun(store, Number.MAX_SAFE_INTEGER);
		let history = await readHistory(store, snapshot, { allowPendingLifecycle: true });
		await reconcileLifecycleRevision(store, snapshot, history);
		snapshot = await store.loadSnapshot();
		history = await readHistory(store, snapshot);
		if (!history.restoredAt || !history.pinnedAt) {
			const now = new Date().toISOString();
			history.restoredAt ??= now;
			history.pinnedAt ??= now;
			await writeHistory(store, snapshot, history);
		}
		await store.event("graph.restored", { trashId: transaction.trashId, pinned: true }).catch(() => undefined);
		await rm(store.path("trash.json"), { force: true });
	} finally {
		await release();
	}
}

async function rollbackRestoreTransaction(runsRoot: string, transaction: RestoreTransaction, error: unknown): Promise<void> {
	if (await entryExists(transaction.target) && !await entryExists(transaction.source)) {
		await assertCanonicalDirectory(runsRoot, transaction.target, "Restore rollback target");
		await rename(transaction.target, transaction.source);
		await assertCanonicalDirectory(join(runsRoot, ".trash"), transaction.source, "Restore rollback source");
		await protectRestoreFailure(runsRoot, transaction.source, transaction, error);
	}
}

async function recoverRestoreTransactions(runsRoot: string): Promise<Array<{ graphId: string; reason: string }>> {
	const root = await restoreTransactionRoot(runsRoot);
	const protectedEntries: Array<{ graphId: string; reason: string }> = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		let transaction: RestoreTransaction;
		try {
			if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) throw new Error(`Invalid restore transaction entry: ${entry.name}`);
			transaction = validateRestoreTransaction(JSON.parse(await readFile(path, "utf8")), runsRoot, entry.name);
		} catch (error) {
			const handle = await quarantineRestoreTransaction(runsRoot, path, entry.name);
			protectedEntries.push({ graphId: `.control/restore-quarantine/${handle}`, reason: RESTORE_QUARANTINE_REASON });
			continue;
		}
		const sourceExists = await entryExists(transaction.source);
		const targetExists = await entryExists(transaction.target);
		if (sourceExists && targetExists) {
			protectedEntries.push({ graphId: `.control/restore-transactions/${entry.name}`, reason: `Restore transaction '${transaction.trashId}' has both source and target.` });
			continue;
		}
		if (!sourceExists && !targetExists) {
			await rm(path, { force: true });
			continue;
		}
		if (sourceExists) {
			await assertCanonicalDirectory(join(runsRoot, ".trash"), transaction.source, "Restore transaction source");
			await rm(path, { force: true });
			continue;
		}
		try {
			await commitRestoreTransaction(runsRoot, transaction);
			await rm(path, { force: true });
		} catch (error) {
			try {
				await rollbackRestoreTransaction(runsRoot, transaction, error);
				await rm(path, { force: true });
			} catch (rollbackError) {
				protectedEntries.push({
					graphId: `.control/restore-transactions/${entry.name}`,
					reason: `Restore recovery and rollback both require attention: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				});
			}
		}
	}
	return protectedEntries;
}

export async function restoreTrash(runsRoot: string, trashId: string): Promise<string> {
	if (!validTrashId(trashId)) throw new Error("Invalid Trash id.");
	return withRetentionLock(runsRoot, `restore:${trashId}`, async () => {
		await recoverRestoreTransactions(runsRoot);
		const trashRoot = await ensureTrashRoot(runsRoot);
		const source = join(trashRoot, trashId);
		await assertCanonicalDirectory(trashRoot, source, "Trash restore source");
		if (await exists(join(source, "restore-protection.json"))) throw new Error(`Trash '${trashId}' is protected after a failed restore; inspect or discard it explicitly.`);
		const record = validateTrashRecord(JSON.parse(await readFile(join(source, "trash.json"), "utf8")), runsRoot, trashId);
		const target = new GraphStore(runsRoot, record.graphId).root;
		if (await exists(target)) throw new Error(`Graph '${record.graphId}' already exists.`);
		const transaction: RestoreTransaction = {
			schemaVersion: 1,
			transactionId: randomUUID(),
			trashId,
			graphId: record.graphId,
			runInstanceId: record.runInstanceId,
			record,
			recordDigest: digestValue(record),
			source,
			target,
			preparedAt: new Date().toISOString(),
		};
		const transactionPath = join(await restoreTransactionRoot(runsRoot), `${trashId}.json`);
		await atomicWriteJson(transactionPath, transaction);
		try {
			await rename(source, target);
			await commitRestoreTransaction(runsRoot, transaction);
			await rm(transactionPath, { force: true });
			return record.graphId;
		} catch (error) {
			await rollbackRestoreTransaction(runsRoot, transaction, error);
			await rm(transactionPath, { force: true });
			throw error;
		}
	});
}

async function purgeControlRoots(runsRoot: string): Promise<{ authorizations: string; staging: string; quarantine: string }> {
	const authorizations = join(runsRoot, ".control", "purge-authorizations");
	const staging = join(runsRoot, ".control", "purge-staging");
	const quarantine = join(runsRoot, ".control", "purge-quarantine");
	await ensureManagedDirectory(runsRoot, authorizations, "Purge authorization directory");
	await ensureManagedDirectory(runsRoot, staging, "Purge staging directory");
	await ensureManagedDirectory(runsRoot, quarantine, "Purge quarantine directory");
	return { authorizations, staging, quarantine };
}

function validatePurgeAuthorization(value: unknown, runsRoot: string, expectedName?: string): PurgeAuthorization {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid purge authorization.");
	const authorization = value as Partial<PurgeAuthorization>;
	if (
		authorization.schemaVersion !== 2
		|| !["valid-trash", "protected-trash"].includes(authorization.kind ?? "")
		|| !validTrashEntryName(authorization.trashId)
		|| (expectedName !== undefined && expectedName !== `${authorization.trashId}.json`)
	) throw new Error("Invalid purge authorization.");
	assertTimestamp(authorization.authorizedAt, "purge authorization authorizedAt");
	const source = join(runsRoot, ".trash", authorization.trashId);
	const staging = join(runsRoot, ".control", "purge-staging", authorization.trashId);
	if (authorization.source !== source || authorization.staging !== staging) throw new Error("Purge authorization paths do not match.");
	if (authorization.kind === "valid-trash") {
		if (!authorization.record || typeof authorization.recordDigest !== "string") throw new Error("Valid Trash purge authorization is missing its durable record.");
		const record = validateTrashRecord(authorization.record, runsRoot, authorization.trashId);
		if (digestValue(record) !== authorization.recordDigest) throw new Error("Purge authorization record digest mismatch.");
	}
	return authorization as PurgeAuthorization;
}

async function completePurgeAuthorization(runsRoot: string, authorization: PurgeAuthorization, authorizationPath: string): Promise<void> {
	const { staging: stagingRoot } = await purgeControlRoots(runsRoot);
	await ensureTrashRoot(runsRoot);
	const sourceExists = await entryExists(authorization.source);
	const stagingExists = await entryExists(authorization.staging);
	if (sourceExists && stagingExists) throw new Error(`Purge authorization '${authorization.trashId}' has both source and staging data.`);
	if (sourceExists) {
		if (authorization.kind === "valid-trash") {
			await assertCanonicalDirectory(join(runsRoot, ".trash"), authorization.source, "Authorized Trash purge source");
			const record = validateTrashRecord(JSON.parse(await readFile(join(authorization.source, "trash.json"), "utf8")), runsRoot, authorization.trashId);
			if (digestValue(record) !== authorization.recordDigest) throw new Error(`Purge authorization no longer matches Trash '${authorization.trashId}'.`);
		}
		await rename(authorization.source, authorization.staging);
	}
	if (await entryExists(authorization.staging)) {
		const info = await lstat(authorization.staging);
		if (info.isDirectory() && !info.isSymbolicLink()) {
			await assertCanonicalDirectory(stagingRoot, authorization.staging, "Authorized purge staging entry");
			await rm(authorization.staging, { recursive: true });
		} else {
			await rm(authorization.staging, { force: true });
		}
	}
	await rm(authorizationPath, { force: true });
}

async function purgeRecord(runsRoot: string, record: TrashRecord): Promise<void> {
	const roots = await purgeControlRoots(runsRoot);
	const authorization: PurgeAuthorization = {
		schemaVersion: 2,
		kind: "valid-trash",
		trashId: record.trashId,
		record,
		recordDigest: digestValue(record),
		source: join(runsRoot, ".trash", record.trashId),
		staging: join(roots.staging, record.trashId),
		authorizedAt: new Date().toISOString(),
	};
	const path = join(roots.authorizations, `${record.trashId}.json`);
	await atomicWriteJson(path, authorization);
	await completePurgeAuthorization(runsRoot, authorization, path);
}

async function isolateInvalidPurgeAuthorization(
	roots: Awaited<ReturnType<typeof purgeControlRoots>>,
	entryName: string,
	path: string,
	error: unknown,
): Promise<Array<{ graphId: string; reason: string }>> {
	const base = entryName.endsWith(".json") ? entryName.slice(0, -5) : entryName;
	const safeId = purgeStagingHandle(base);
	const quarantinePath = join(roots.quarantine, `${safeId}.invalid`);
	if (await entryExists(quarantinePath)) await removeManagedEntry(roots.authorizations, path, "Duplicate invalid purge authorization");
	else await rename(path, quarantinePath);
	const staging = join(roots.staging, safeId);
	if (!await entryExists(staging)) {
		await removeManagedEntry(roots.quarantine, quarantinePath, "Orphan purge authorization quarantine");
		return [];
	}
	return [{
		graphId: `.control/purge-quarantine/${basename(quarantinePath)}`,
		reason: `Invalid purge authorization was isolated; inspect and use discard-staging '${safeId}': ${error instanceof Error ? error.message : String(error)}`,
	}];
}

async function recoverPurgeAuthorizations(runsRoot: string): Promise<Array<{ graphId: string; reason: string }>> {
	const roots = await purgeControlRoots(runsRoot);
	const protectedEntries: Array<{ graphId: string; reason: string }> = [];
	const { authorizations } = roots;
	for (const entry of await readdir(authorizations, { withFileTypes: true })) {
		const path = join(authorizations, entry.name);
		let authorization: PurgeAuthorization;
		try {
			if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) throw new Error(`Invalid purge authorization entry: ${entry.name}`);
			authorization = validatePurgeAuthorization(JSON.parse(await readFile(path, "utf8")), runsRoot, entry.name);
		} catch (error) {
			protectedEntries.push(...await isolateInvalidPurgeAuthorization(roots, entry.name, path, error));
			continue;
		}
		try {
			await completePurgeAuthorization(runsRoot, authorization, path);
		} catch (error) {
			protectedEntries.push({
				graphId: `.control/purge-authorizations/${entry.name}`,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return protectedEntries;
}

function purgeStagingHandle(name: string): string {
	return validTrashEntryName(name) ? name : opaqueHandle("orphan", name);
}

function controlQuarantineHandle(name: string): string {
	return validTrashEntryName(name) ? name : opaqueHandle("control", name);
}

async function recoverPurgeQuarantine(runsRoot: string): Promise<Array<{ graphId: string; reason: string }>> {
	const roots = await purgeControlRoots(runsRoot);
	const protectedEntries: Array<{ graphId: string; reason: string }> = [];
	for (const entry of await readdir(roots.quarantine, { withFileTypes: true })) {
		const safeId = entry.name.endsWith(".invalid") ? entry.name.slice(0, -".invalid".length) : "";
		const path = join(roots.quarantine, entry.name);
		if (validTrashEntryName(safeId) && !await entryExists(join(roots.staging, safeId))) {
			await removeManagedEntry(roots.quarantine, path, "Completed purge quarantine");
			continue;
		}
		const handle = controlQuarantineHandle(entry.name);
		protectedEntries.push({
			graphId: `.control/purge-quarantine/${handle}`,
			reason: validTrashEntryName(safeId)
				? `Invalid purge authorization remains paired with staging '${safeId}'; use discard-staging '${safeId}'.`
				: "Unrecognized purge quarantine metadata; inspect before explicit control discard.",
		});
	}
	return protectedEntries;
}

async function inspectOrphanPurgeStaging(runsRoot: string): Promise<Array<{ stagingId: string; originalName: string; bytes: number; reason: string }>> {
	const stagingRoot = join(runsRoot, ".control", "purge-staging");
	const authorizationRoot = join(runsRoot, ".control", "purge-authorizations");
	if (!await inspectManagedDirectory(runsRoot, stagingRoot, "Purge staging inspection")) return [];
	const authorizationAvailable = await inspectManagedDirectory(runsRoot, authorizationRoot, "Purge authorization inspection");
	const orphaned: Array<{ stagingId: string; originalName: string; bytes: number; reason: string }> = [];
	for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
		const staging = join(stagingRoot, entry.name);
		let reason = "no matching durable purge authorization";
		let authorized = false;
			if (validTrashEntryName(entry.name)) {
				const authorizationPath = join(authorizationRoot, `${entry.name}.json`);
				try {
					if (!authorizationAvailable) throw Object.assign(new Error("matching purge authorization is missing"), { code: "ENOENT" });
					const info = await lstat(authorizationPath);
				if (info.isSymbolicLink() || !info.isFile()) throw new Error("matching purge authorization is not a regular file");
				const authorization = validatePurgeAuthorization(JSON.parse(await readFile(authorizationPath, "utf8")), runsRoot, `${entry.name}.json`);
				authorized = authorization.staging === staging;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") reason = `matching purge authorization is invalid: ${error instanceof Error ? error.message : String(error)}`;
			}
		} else {
			reason = "invalid purge staging entry name";
		}
		if (!authorized) orphaned.push({ stagingId: purgeStagingHandle(entry.name), originalName: entry.name, bytes: await directoryBytes(staging), reason });
	}
	return orphaned;
}

export async function purgeTrash(runsRoot: string, options: { force?: boolean; trashIds?: string[] } = {}): Promise<string[]> {
	return withRetentionLock(runsRoot, "purge", async () => {
		await recoverPurgeAuthorizations(runsRoot);
		const purged: string[] = [];
		const selected = options.trashIds ? new Set(options.trashIds) : undefined;
		for (const record of await listTrash(runsRoot)) {
			if (selected && !selected.has(record.trashId)) continue;
			if (!options.force && Date.parse(record.purgeAfter) > Date.now()) continue;
			await purgeRecord(runsRoot, record);
			purged.push(record.trashId);
		}
		return purged;
	});
}

export async function discardProtectedTrash(runsRoot: string, trashId: string): Promise<void> {
	if (!validTrashEntryName(trashId)) throw new Error("Invalid protected Trash id.");
	await withRetentionLock(runsRoot, `discard-protected:${trashId}`, async () => {
		await recoverPurgeAuthorizations(runsRoot);
		const inventory = await listTrashInventory(runsRoot);
		if (inventory.valid.some((record) => record.trashId === trashId)) throw new Error("Valid Trash must use the normal purge workflow.");
		if (!inventory.protected.some((entry) => entry.trashId === trashId)) throw new Error(`Protected Trash '${trashId}' was not found.`);
		const trashRoot = await ensureTrashRoot(runsRoot);
		const matches = (await readdir(trashRoot)).filter((name) => name === trashId || trashEntryHandle(name) === trashId);
		if (matches.length !== 1) throw new Error(`Protected Trash handle '${trashId}' is missing or ambiguous.`);
		const originalName = matches[0]!;
		let target = join(trashRoot, originalName);
		const info = await lstat(target);
		if (info.isDirectory() && !info.isSymbolicLink()) await assertCanonicalDirectory(join(runsRoot, ".trash"), target, "Protected Trash discard target");
		if (originalName !== trashId) {
			const normalized = join(trashRoot, trashId);
			if (await entryExists(normalized)) throw new Error(`Protected Trash handle collision for '${trashId}'.`);
			await rename(target, normalized);
			target = normalized;
		}
		const roots = await purgeControlRoots(runsRoot);
		const authorization: PurgeAuthorization = {
			schemaVersion: 2,
			kind: "protected-trash",
			trashId,
			source: target,
			staging: join(roots.staging, trashId),
			authorizedAt: new Date().toISOString(),
		};
		const authorizationPath = join(roots.authorizations, `${trashId}.json`);
		await atomicWriteJson(authorizationPath, authorization);
		await completePurgeAuthorization(runsRoot, authorization, authorizationPath);
	});
}

export async function discardOrphanPurgeStaging(runsRoot: string, stagingId: string): Promise<void> {
	if (!validTrashEntryName(stagingId)) throw new Error("Invalid purge staging id or handle.");
	await withRetentionLock(runsRoot, `discard-staging:${stagingId}`, async () => {
		const roots = await purgeControlRoots(runsRoot);
		const entries = await readdir(roots.staging);
		const originalName = entries.find((name) => name === stagingId) ?? entries.find((name) => purgeStagingHandle(name) === stagingId);
		if (!originalName) throw new Error(`Orphan purge staging '${stagingId}' was not found.`);
		const safeId = purgeStagingHandle(originalName);
		let target = join(roots.staging, originalName);
		const originalAuthorizationPath = join(roots.authorizations, `${originalName}.json`);
		const quarantinePath = join(roots.quarantine, `${safeId}.invalid`);
		if (await entryExists(originalAuthorizationPath)) {
			try {
				const info = await lstat(originalAuthorizationPath);
				if (info.isSymbolicLink() || !info.isFile()) throw new Error("Matching purge authorization is not a regular file.");
				const authorization = validatePurgeAuthorization(JSON.parse(await readFile(originalAuthorizationPath, "utf8")), runsRoot, `${originalName}.json`);
				await completePurgeAuthorization(runsRoot, authorization, originalAuthorizationPath);
				if (await entryExists(quarantinePath)) await rm(quarantinePath, { recursive: true, force: true });
				return;
			} catch {
				if (await entryExists(quarantinePath)) throw new Error(`Purge staging '${safeId}' has multiple invalid authorization records and remains protected.`);
				await rename(originalAuthorizationPath, quarantinePath);
			}
		}
		if (originalName !== safeId) {
			const normalizedTarget = join(roots.staging, safeId);
			if (await entryExists(normalizedTarget)) throw new Error(`Purge staging handle collision for '${safeId}'.`);
			await rename(target, normalizedTarget);
			target = normalizedTarget;
		}
		const authorizationPath = join(roots.authorizations, `${safeId}.json`);
		if (await entryExists(authorizationPath)) {
			try {
				const info = await lstat(authorizationPath);
				if (info.isSymbolicLink() || !info.isFile()) throw new Error("Matching purge authorization is not a regular file.");
				const authorization = validatePurgeAuthorization(JSON.parse(await readFile(authorizationPath, "utf8")), runsRoot, `${safeId}.json`);
				await completePurgeAuthorization(runsRoot, authorization, authorizationPath);
				if (await entryExists(quarantinePath)) await rm(quarantinePath, { recursive: true, force: true });
				return;
			} catch {
				if (await entryExists(quarantinePath)) throw new Error(`Purge staging '${safeId}' has multiple invalid authorization records and remains protected.`);
				await rename(authorizationPath, quarantinePath);
			}
		}
		const source = join(await ensureTrashRoot(runsRoot), safeId);
		if (await entryExists(source)) throw new Error(`Purge staging '${safeId}' is ambiguous because a same-named Trash source also exists.`);
		const authorization: PurgeAuthorization = {
			schemaVersion: 2,
			kind: "protected-trash",
			trashId: safeId,
			source,
			staging: target,
			authorizedAt: new Date().toISOString(),
		};
		await atomicWriteJson(authorizationPath, authorization);
		await completePurgeAuthorization(runsRoot, authorization, authorizationPath);
		if (await entryExists(quarantinePath)) await rm(quarantinePath, { recursive: true, force: true });
	});
}

export async function discardControlQuarantine(runsRoot: string, quarantineId: string): Promise<string> {
	if (!validTrashEntryName(quarantineId)) throw new Error("Invalid control quarantine id or handle.");
	return withRetentionLock(runsRoot, `discard-control:${quarantineId}`, async () => {
		const roots = [
			{ name: "purge-quarantine", path: (await purgeControlRoots(runsRoot)).quarantine },
			{ name: "restore-quarantine", path: await restoreQuarantineRoot(runsRoot) },
		];
		const matches: Array<{ root: string; name: string; path: string }> = [];
		for (const root of roots) {
			for (const name of await readdir(root.path)) {
				if (name === quarantineId || controlQuarantineHandle(name) === quarantineId) matches.push({ root: root.name, name, path: root.path });
			}
		}
		if (matches.length !== 1) throw new Error(`Control quarantine handle '${quarantineId}' is missing or ambiguous.`);
		const match = matches[0]!;
		if (match.root === "purge-quarantine" && match.name.endsWith(".invalid")) {
			const safeId = match.name.slice(0, -".invalid".length);
			const staging = join(runsRoot, ".control", "purge-staging", safeId);
			if (validTrashEntryName(safeId) && await entryExists(staging)) {
				throw new Error(`Purge quarantine '${quarantineId}' still protects staging data; use discard-staging '${safeId}'.`);
			}
		}
		await removeManagedEntry(match.path, join(match.path, match.name), "Control quarantine discard target");
		return `.control/${match.root}/${quarantineId}`;
	});
}

async function collectStorageReport(config: GraphConfig): Promise<RetentionReport> {
	const report: RetentionReport = { runs: 0, compacted: [], trashed: [], purged: [], protected: [], graphBytes: 0, trashBytes: 0, controlBytes: 0, subagentBytes: 0, overSoftLimit: false };
	report.runs = (await GraphStore.discover(config.runsDir)).length;
	const inventory = await listTrashInventory(config.runsDir);
	report.protected.push(...inventory.protected.map((entry) => ({ graphId: `Trash/${entry.trashId}`, reason: entry.reason })));
	report.graphBytes = Math.max(0, await directoryBytes(config.runsDir) - await directoryBytes(join(config.runsDir, ".trash")) - await directoryBytes(join(config.runsDir, ".control")));
	report.trashBytes = await directoryBytes(join(config.runsDir, ".trash"));
	report.controlBytes = await directoryBytes(join(config.runsDir, ".control"));
	for (const entry of await inspectOrphanPurgeStaging(config.runsDir)) {
		report.protected.push({
			graphId: `.control/purge-staging/${entry.stagingId}`,
			reason: `${entry.reason}${entry.originalName !== entry.stagingId ? `; opaque handle for an invalid entry name` : ""}; ${(entry.bytes / 1024 ** 2).toFixed(1)} MiB protected until explicit discard`,
		});
	}
	for (const name of ["purge-quarantine", "restore-quarantine"] as const) {
		const quarantineRoot = join(config.runsDir, ".control", name);
		if (!await inspectManagedDirectory(config.runsDir, quarantineRoot, `${name} inspection`)) continue;
		for (const entry of await readdir(quarantineRoot)) {
			const handle = controlQuarantineHandle(entry);
			report.protected.push({
				graphId: `.control/${name}/${handle}`,
				reason: name === "purge-quarantine"
					? "invalid purge authorization is quarantined until its matching staging discard completes"
						: RESTORE_QUARANTINE_REASON,
				});
			}
		}
	for (const entry of await listInitializationStaging(config.runsDir)) {
		report.protected.push({
			graphId: entry.name,
			reason: `${entry.graphId ? `incomplete initialization for '${entry.graphId}'` : "invalid initialization staging"}; ${(entry.bytes / 1024 ** 2).toFixed(1)} MiB awaiting safe maintenance cleanup`,
		});
	}
	report.subagentBytes = await directoryBytes(subagentAsyncRoot());
	report.overSoftLimit = report.graphBytes + report.trashBytes + report.controlBytes > historyConfig(config).maxStorageBytes;
	return report;
}

export async function storageReport(config: GraphConfig): Promise<RetentionReport> {
	return collectStorageReport(config);
}

function mergeProtectedEntry(
	protectedEntries: RetentionReport["protected"],
	entry: RetentionReport["protected"][number],
	preferNewControlRecovery = false,
): void {
	const exact = protectedEntries.some((current) => current.graphId === entry.graphId && current.reason === entry.reason);
	if (exact) return;
	if (/^\.control\/(?:purge|restore)-quarantine\//.test(entry.graphId)) {
		const existing = protectedEntries.findIndex((current) => current.graphId === entry.graphId);
		if (existing >= 0) {
			if (preferNewControlRecovery) protectedEntries[existing] = entry;
			return;
		}
	}
	protectedEntries.push(entry);
}

async function garbageCollectPrunePlans(runsRoot: string): Promise<void> {
	const root = join(runsRoot, ".control", "prune-plans");
	await ensureManagedDirectory(runsRoot, root, "Prune plan directory");
	const names = (await readdir(root)).filter((name) => name.endsWith(".json"));
	for (const name of names) {
		const path = join(root, name);
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isFile()) {
				await removeManagedEntry(root, path, "Invalid prune plan");
				continue;
			}
			const plan = validatePrunePlan(JSON.parse(await readFile(path, "utf8")));
			if (name !== `${plan.planId}.json`) throw new Error("Prune plan filename does not match its identity.");
			if (Date.parse(plan.expiresAt) <= Date.now()) await rm(path, { force: true });
		} catch {
			await removeManagedEntry(root, path, "Invalid prune plan");
		}
	}
}

export async function runRetentionMaintenance(config: GraphConfig): Promise<RetentionReport> {
	const policy = historyConfig(config);
	const recovery = await withRetentionLock(config.runsDir, "maintenance-recovery", async () => {
		const initialization = await garbageCollectInitializationStaging(config.runsDir);
		await garbageCollectGenerationQuarantines(config.runsDir);
		const restore = await recoverRestoreTransactions(config.runsDir);
		const purge = await recoverPurgeAuthorizations(config.runsDir);
		const quarantine = await recoverPurgeQuarantine(config.runsDir);
		await garbageCollectPrunePlans(config.runsDir);
		return { initialization, restore, purge, quarantine };
	});
	const report = await collectStorageReport(config);
	report.protected.push(...recovery.initialization);
	for (const entry of [...recovery.restore, ...recovery.purge, ...recovery.quarantine]) {
		mergeProtectedEntry(report.protected, entry, true);
	}
	report.runs = 0;
	await ensureManagedDirectory(config.runsDir, join(config.runsDir, ".control", "source-reservations"), "Source reservation directory");
	const reservations = await garbageCollectSourceReservations(join(config.runsDir, ".control"));
	report.protected.push(...reservations.protected.map((reason) => ({ graphId: "SourceReservation", reason })));
	const snapshots: Array<{ snapshot: GraphSnapshot; history: HistoryRecord }> = [];
	for (const graphId of await GraphStore.discover(config.runsDir)) {
		report.runs += 1;
		const store = new GraphStore(config.runsDir, graphId);
		try {
			let snapshot = await store.loadSnapshot();
			let history = await readHistory(store, snapshot, { allowPendingLifecycle: true });
			if (await needsRunRetentionRecovery(store, snapshot, history)) {
				await recoverRunRetentionState(config.runsDir, graphId);
				snapshot = await store.loadSnapshot();
				history = await readHistory(store, snapshot);
			} else if (snapshot.schemaVersion === 2) {
				await loadValidatedRun(store, Number.MAX_SAFE_INTEGER);
			}
			if (policy.autoCompact) {
				const preflight = automaticCompactionPreflight(snapshot, history, policy.compactAfterDays);
				if (preflight.protectedReason) report.protected.push({ graphId, reason: preflight.protectedReason });
				if (preflight.candidate) {
					const result = await compactRun(config.runsDir, graphId, { compactAfterDays: policy.compactAfterDays });
					if (result.compacted) {
						report.compacted.push(graphId);
					} else if (result.reason && !["already compacted", "retention age not reached", "only complete or stopped runs compact automatically"].includes(result.reason)) {
						report.protected.push({ graphId, reason: result.reason });
					}
				}
			}
			snapshots.push({ snapshot, history });
		} catch (error) {
			report.protected.push({ graphId, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	if (policy.autoPrune) {
		const terminal = snapshots
			.filter(({ snapshot }) => ["complete", "stopped"].includes(snapshot.status))
			.sort((a, b) => retentionTimestamp(b.snapshot, b.history).localeCompare(retentionTimestamp(a.snapshot, a.history)));
		const recent = new Set(terminal.slice(0, policy.keepRecentTerminal).map(({ snapshot }) => snapshot.graphId));
		for (const { snapshot, history } of [...terminal].reverse()) {
			if (recent.has(snapshot.graphId) || history.pinnedAt || !history.compactedAt) continue;
			const age = Date.now() - Date.parse(retentionTimestamp(snapshot, history));
			if (age < policy.pruneAfterDays * DAY) continue;
			try {
				const plan = await createPrunePlan(config.runsDir, [snapshot.graphId]);
				report.trashed.push(...await executePrunePlan(config.runsDir, plan.planId, policy.trashGraceDays, plan.planDigest));
			} catch (error) {
				report.protected.push({ graphId: snapshot.graphId, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		report.purged = await purgeTrash(config.runsDir);
		let graphBytes = Math.max(0, await directoryBytes(config.runsDir) - await directoryBytes(join(config.runsDir, ".trash")) - await directoryBytes(join(config.runsDir, ".control")));
		let trashBytes = await directoryBytes(join(config.runsDir, ".trash"));
		let controlBytes = await directoryBytes(join(config.runsDir, ".control"));
		if (policy.emergencyPurge && graphBytes + trashBytes + controlBytes > policy.maxStorageBytes) {
			const trash = (await listTrash(config.runsDir)).sort((a, b) => a.trashedAt.localeCompare(b.trashedAt));
			const selected: string[] = [];
			let projectedBytes = graphBytes + trashBytes + controlBytes;
			for (const record of trash) {
				selected.push(record.trashId);
				projectedBytes -= await directoryBytes(join(config.runsDir, ".trash", record.trashId));
				if (projectedBytes <= policy.targetStorageBytes) break;
			}
			if (selected.length) report.purged.push(...await purgeTrash(config.runsDir, { force: true, trashIds: selected }));
			graphBytes = Math.max(0, await directoryBytes(config.runsDir) - await directoryBytes(join(config.runsDir, ".trash")) - await directoryBytes(join(config.runsDir, ".control")));
			trashBytes = await directoryBytes(join(config.runsDir, ".trash"));
			controlBytes = await directoryBytes(join(config.runsDir, ".control"));
		}
	}
	const refreshed = await collectStorageReport(config);
	report.graphBytes = refreshed.graphBytes;
	report.trashBytes = refreshed.trashBytes;
	report.controlBytes = refreshed.controlBytes;
	report.subagentBytes = refreshed.subagentBytes;
	for (const entry of refreshed.protected) {
		mergeProtectedEntry(report.protected, entry);
	}
	report.overSoftLimit = report.graphBytes + report.trashBytes + report.controlBytes > policy.maxStorageBytes;
	return report;
}

export function formatRetentionReport(report: RetentionReport): string {
	const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	return [
		`Graph storage: ${mib(report.graphBytes)} across ${report.runs} runs${report.overSoftLimit ? " (over soft limit)" : ""}`,
		`Trash: ${mib(report.trashBytes)}`,
		`Control and recovery data: ${mib(report.controlBytes)}`,
		`pi-subagents (owned externally): ${mib(report.subagentBytes)}`,
		`Maintenance: compacted=${report.compacted.length}, trashed=${report.trashed.length}, purged=${report.purged.length}, protected=${report.protected.length}`,
		...report.protected.map((entry) => `- ${entry.graphId}: ${entry.reason}`),
	].join("\n");
}
