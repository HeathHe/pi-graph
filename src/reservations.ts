import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson, syncDirectory } from "./durable.ts";
import { isProcessAlive, processIdentityForPid, withExclusiveClaim } from "./claims.ts";
import { scopesOverlap } from "./leases.ts";
import type { ScopeEntry } from "./types.ts";

export interface SourceReservation {
	version: 1;
	reservationId: string;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	supervisorEpoch: string;
	fencingGeneration: number;
	pid: number;
	ownerIdentity?: string;
	scopes: ScopeEntry[];
	attemptDir: string;
	state: "held" | "released" | "abandoned";
	acquiredAt: string;
	updatedAt: string;
}

export interface SourceReservationIssue {
	path: string;
	reason: string;
}

function validReservation(value: unknown, path: string, managedRoot?: string): SourceReservation {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid source reservation: ${path}`);
	const record = value as Partial<SourceReservation>;
	if (record.version !== 1 || typeof record.reservationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.reservationId) || typeof record.runInstanceId !== "string" || record.runInstanceId.length < 1 || typeof record.graphId !== "string" || record.graphId.length < 1 || typeof record.taskId !== "string" || record.taskId.length < 1 || typeof record.supervisorEpoch !== "string" || record.supervisorEpoch.length < 1 || !Number.isInteger(record.attempt) || (record.attempt ?? 0) < 1 || !Number.isInteger(record.fencingGeneration) || (record.fencingGeneration ?? -1) < 0 || !Number.isInteger(record.pid) || (record.pid ?? 0) < 1 || !Array.isArray(record.scopes) || typeof record.attemptDir !== "string" || !isAbsolute(record.attemptDir) || !["held", "released", "abandoned"].includes(record.state ?? "")) {
		throw new Error(`Invalid source reservation: ${path}`);
	}
	if (!record.scopes.every((scope) => (
		Boolean(scope)
		&& typeof scope === "object"
		&& !Array.isArray(scope)
		&& ["file", "tree"].includes((scope as Partial<ScopeEntry>).kind ?? "")
		&& typeof (scope as Partial<ScopeEntry>).path === "string"
		&& isAbsolute((scope as Partial<ScopeEntry>).path!)
	))) throw new Error(`Invalid source reservation scope: ${path}`);
	if (managedRoot && !within(managedRoot, record.attemptDir!)) throw new Error(`Source reservation attempt path escapes its managed root: ${path}`);
	if (record.ownerIdentity !== undefined && (typeof record.ownerIdentity !== "string" || record.ownerIdentity.length < 1 || record.ownerIdentity.length > 256)) {
		throw new Error(`Invalid source reservation owner identity: ${path}`);
	}
	for (const timestamp of [record.acquiredAt, record.updatedAt]) {
		if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)) || new Date(Date.parse(timestamp)).toISOString() !== timestamp) throw new Error(`Invalid source reservation timestamp: ${path}`);
	}
	return record as SourceReservation;
}

async function filesUnder(root: string, options: { skipTopLevel?: Set<string>; depth?: number; strict?: boolean } = {}): Promise<string[]> {
	let entries;
	try {
		const info = await lstat(root);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Source reservation tree must be a real directory: ${root}`);
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const output: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if ((options.depth ?? 0) === 0 && options.skipTopLevel?.has(entry.name)) {
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Source reservation skipped tree is a symbolic link or non-directory: ${path}`);
			continue;
		}
		if (entry.isSymbolicLink()) {
			if (options.strict) throw new Error(`Source reservation entry is a symbolic link instead of a regular file: ${path}`);
			continue;
		}
		if (entry.isDirectory()) output.push(...await filesUnder(path, { ...options, depth: (options.depth ?? 0) + 1 }));
		else if (entry.isFile() && entry.name.endsWith(".json")) output.push(path);
		else if (options.strict) throw new Error(`Source reservation entry is not a JSON record: ${path}`);
	}
	return output;
}

async function applyPlanStatus(attemptDir: string): Promise<string | undefined> {
	try {
		const value = JSON.parse(await readFile(join(attemptDir, "apply-plan.json"), "utf8")) as { status?: unknown };
		return typeof value.status === "string" ? value.status : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function reservationOwnerAlive(record: Pick<SourceReservation, "pid" | "ownerIdentity">): Promise<boolean> {
	if (!isProcessAlive(record.pid)) return false;
	if (!record.ownerIdentity) return true;
	const observed = await processIdentityForPid(record.pid);
	return observed === undefined || observed === record.ownerIdentity;
}

async function withSourceReservationGate<T>(controlRoot: string, purpose: string, action: () => Promise<T>): Promise<T> {
	const resolvedControl = resolve(controlRoot);
	const managedRoot = dirname(resolvedControl);
	const claims = join(resolvedControl, "source-reservation-gate", "claims");
	await ensureManagedDirectory(managedRoot, claims, "Source reservation transaction gate");
	try {
		return await withExclusiveClaim(claims, { purpose }, action, {
			busyMessage: "Source reservation metadata is busy.",
		});
	} catch (error) {
		if (error instanceof Error && error.message === "Source reservation metadata is busy.") throw new SourceReservationBusyError();
		throw error;
	}
}

export class SourceReservationBusyError extends Error {
	constructor() {
		super("Source reservation metadata is busy.");
		this.name = "SourceReservationBusyError";
	}
}

function historyPath(root: string, path: string, record: SourceReservation): string {
	const token = relative(root, path);
	if (!within(root, path) || !token || isAbsolute(token) || token === ".." || token.startsWith(`..${sep}`)) {
		throw new Error("Source reservation history path escapes its managed root.");
	}
	const name = basename(token);
	const stem = name.endsWith(".json") ? name.slice(0, -5) : name;
	const target = join(root, ".history", dirname(token), `${stem}.${record.reservationId}.json`);
	if (!within(root, target)) throw new Error("Source reservation history target escapes its managed root.");
	return target;
}

async function archiveReservation(
	managedRoot: string,
	root: string,
	path: string,
	record: SourceReservation,
	options: { persist?: boolean } = {},
): Promise<void> {
	const target = historyPath(root, path, record);
	await ensureManagedDirectory(managedRoot, dirname(target), "Source reservation history directory");
	if (options.persist !== false) await atomicWriteJson(path, record);
	await rename(path, target);
	await Promise.all([...new Set([dirname(path), dirname(target)])].map((directory) => syncDirectory(directory)));
	let cursor = dirname(path);
	while (cursor !== root && within(root, cursor)) {
		try {
			await rmdir(cursor);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				cursor = dirname(cursor);
				continue;
			}
			if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) break;
			throw error;
		}
		await syncDirectory(dirname(cursor));
		cursor = dirname(cursor);
	}
}

export class SourceReservationRegistry {
	private readonly controlRoot: string;
	private readonly root: string;
	private readonly managedRoot: string;

	constructor(controlRoot: string) {
		const resolvedControl = resolve(controlRoot);
		this.controlRoot = resolvedControl;
		this.root = resolve(resolvedControl, "source-reservations");
		this.managedRoot = dirname(resolvedControl);
	}

	private recordPath(input: Pick<SourceReservation, "runInstanceId" | "taskId" | "attempt">): string {
		return join(this.root, input.runInstanceId, input.taskId, `attempt-${input.attempt}.json`);
	}

	async acquire(input: Omit<SourceReservation, "version" | "reservationId" | "pid" | "ownerIdentity" | "state" | "acquiredAt" | "updatedAt">): Promise<(() => Promise<void>) | null> {
		return withSourceReservationGate(this.controlRoot, `acquire:${input.graphId}/${input.taskId}/${input.attempt}`, async () => {
			await ensureManagedDirectory(this.managedRoot, this.root, "Source reservation directory");
			const target = this.recordPath(input);
			await ensureManagedDirectory(this.managedRoot, dirname(target), "Source reservation record directory");
			for (const path of await filesUnder(this.root, { skipTopLevel: new Set([".history"]), strict: true })) {
				let existing: SourceReservation;
				try {
					existing = validReservation(JSON.parse(await readFile(path, "utf8")), path, this.managedRoot);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				if (existing.state !== "held") {
					await archiveReservation(this.managedRoot, this.root, path, existing, { persist: false });
					continue;
				}
				const overlaps = scopesOverlap(existing.scopes, input.scopes);
				const sameAttempt = existing.runInstanceId === input.runInstanceId && existing.taskId === input.taskId && existing.attempt === input.attempt;
				const planStatus = await applyPlanStatus(existing.attemptDir);
				if (sameAttempt && input.fencingGeneration > existing.fencingGeneration) {
					existing.state = "abandoned";
					existing.updatedAt = new Date().toISOString();
					await archiveReservation(this.managedRoot, this.root, path, existing);
					continue;
				}
				if (planStatus && ["committed", "rolled_back"].includes(planStatus)) {
					existing.state = "abandoned";
					existing.updatedAt = new Date().toISOString();
					await archiveReservation(this.managedRoot, this.root, path, existing);
					continue;
				}
				if (await reservationOwnerAlive(existing)) {
					if (overlaps) return null;
					continue;
				}
				if (!planStatus || planStatus === "prepared") {
					existing.state = "abandoned";
					existing.updatedAt = new Date().toISOString();
					await archiveReservation(this.managedRoot, this.root, path, existing);
					continue;
				}
				if (overlaps) return null;
			}
			const now = new Date().toISOString();
			const ownerIdentity = await processIdentityForPid(process.pid);
			if (!ownerIdentity) throw new Error("The current process start identity is unavailable; refusing to create a PID-only source reservation.");
			const reservation: SourceReservation = {
				version: 1,
				reservationId: randomUUID(),
				...input,
				pid: process.pid,
				ownerIdentity,
				state: "held",
				acquiredAt: now,
				updatedAt: now,
			};
			try {
				const targetInfo = await lstat(target);
				if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw new Error(`Source reservation record must be a regular file: ${target}`);
				const previous = validReservation(JSON.parse(await readFile(target, "utf8")), target, this.managedRoot);
				if (previous.state === "held") {
					const planStatus = await applyPlanStatus(previous.attemptDir);
					const superseded = input.fencingGeneration > previous.fencingGeneration;
					if (!superseded && !["committed", "rolled_back"].includes(planStatus ?? "") && await reservationOwnerAlive(previous)) return null;
					if (!superseded && planStatus === "applying") return null;
				}
				if (previous.state === "held") {
					previous.state = "abandoned";
					previous.updatedAt = new Date().toISOString();
					await archiveReservation(this.managedRoot, this.root, target, previous);
				} else {
					await archiveReservation(this.managedRoot, this.root, target, previous, { persist: false });
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await atomicWriteJson(target, reservation);
			return async () => {
				await withSourceReservationGate(this.controlRoot, `release:${reservation.graphId}/${reservation.taskId}/${reservation.attempt}`, async () => {
					let latest: SourceReservation;
					try {
						latest = validReservation(JSON.parse(await readFile(target, "utf8")), target, this.managedRoot);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
						throw error;
					}
					if (latest.reservationId !== reservation.reservationId) return;
					latest.state = "released";
					latest.updatedAt = new Date().toISOString();
					await archiveReservation(this.managedRoot, this.root, target, latest);
				});
			};
		});
	}
}

export async function garbageCollectSourceReservations(controlRoot: string, maxAgeMs = 7 * 86_400_000): Promise<{ removed: number; protected: string[] }> {
	const resolvedControl = resolve(controlRoot);
	const protectedPaths = await withSourceReservationGate(resolvedControl, "garbage-collect-active", async () => {
		const root = resolve(resolvedControl, "source-reservations");
		const managedRoot = dirname(resolvedControl);
		await ensureManagedDirectory(managedRoot, root, "Source reservation directory");
		const activeProtected: string[] = [];
		for (const path of await filesUnder(root, { skipTopLevel: new Set([".history"]), strict: true })) {
			try {
				const record = validReservation(JSON.parse(await readFile(path, "utf8")), path, managedRoot);
				const wasHeld = record.state === "held";
				if (wasHeld) {
					const planStatus = await applyPlanStatus(record.attemptDir);
					if (!["committed", "rolled_back"].includes(planStatus ?? "") && await reservationOwnerAlive(record)) continue;
					if (planStatus === "applying") {
						activeProtected.push(`${path}: interrupted source apply remains authoritative`);
						continue;
					}
					record.state = "abandoned";
					record.updatedAt = new Date().toISOString();
				}
				await archiveReservation(managedRoot, root, path, record, { persist: wasHeld });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				activeProtected.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return activeProtected;
	});
	const root = resolve(resolvedControl, "source-reservations");
	const historyRoot = join(root, ".history");
	let removed = 0;
	for (const path of await filesUnder(historyRoot, { strict: true })) {
		try {
			const record = validReservation(JSON.parse(await readFile(path, "utf8")), path, dirname(resolvedControl));
			if (record.state === "held") {
				protectedPaths.push(`${path}: held source reservation is misplaced in history`);
				continue;
			}
			if (Date.now() - Date.parse(record.updatedAt) < maxAgeMs) continue;
			await rm(path, { force: true });
			await syncDirectory(dirname(path));
			removed += 1;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			protectedPaths.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { removed, protected: protectedPaths };
}

async function inspectReservationTree(root: string, current: string, managedRoot: string, issues: SourceReservationIssue[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(current, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		issues.push({ path: relative(root, current) || ".", reason: error instanceof Error ? error.message : String(error) });
		return;
	}
	for (const entry of entries) {
		const path = join(current, entry.name);
		const token = relative(root, path);
		if (current === root && entry.name === ".history") {
			try {
				const info = await lstat(path);
				if (info.isSymbolicLink() || !info.isDirectory()) issues.push({ path: token, reason: "source reservation history is a symbolic link or non-directory" });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ path: token, reason: error instanceof Error ? error.message : String(error) });
			}
			continue;
		}
		if (entry.isSymbolicLink()) {
			issues.push({ path: token, reason: "source reservation entry is a symbolic link" });
			continue;
		}
		if (entry.isDirectory()) {
			await inspectReservationTree(root, path, managedRoot, issues);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".json")) {
			issues.push({ path: token, reason: "source reservation entry is not a JSON record" });
			continue;
		}
		try {
			const record = validReservation(JSON.parse(await readFile(path, "utf8")), path, managedRoot);
			if (record.state !== "held") {
				issues.push({ path: token, reason: "completed source reservation awaits maintenance archival" });
				continue;
			}
			if (await reservationOwnerAlive(record)) continue;
			const planStatus = await applyPlanStatus(record.attemptDir);
			issues.push({
				path: token,
				reason: planStatus && !["prepared", "committed", "rolled_back"].includes(planStatus)
					? "interrupted source apply remains authoritative"
					: "stale source reservation awaits maintenance archival",
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			issues.push({ path: token, reason: `malformed source reservation: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
}

export async function inspectSourceReservations(controlRoot: string): Promise<SourceReservationIssue[]> {
	const root = resolve(controlRoot, "source-reservations");
	try {
		const info = await lstat(root);
		if (info.isSymbolicLink() || !info.isDirectory()) return [{ path: ".", reason: "source reservation root is a symbolic link or non-directory" }];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [{ path: ".", reason: error instanceof Error ? error.message : String(error) }];
	}
	const issues: SourceReservationIssue[] = [];
	await inspectReservationTree(root, root, dirname(resolve(controlRoot)), issues);
	return issues;
}

function within(root: string, target: string): boolean {
	const token = relative(root, target);
	return token === "" || (!isAbsolute(token) && token !== ".." && !token.startsWith(`..${sep}`));
}

async function ensureManagedDirectory(root: string, target: string, label: string): Promise<void> {
	await mkdir(root, { recursive: true });
	const rootInfo = await lstat(root);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`${label} root must be a real directory.`);
	const token = relative(root, target);
	if (!token || isAbsolute(token) || token === ".." || token.startsWith(`..${sep}`)) throw new Error(`${label} escapes its managed root.`);
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
	const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
	if (!within(canonicalRoot, canonicalTarget) || canonicalRoot === canonicalTarget) throw new Error(`${label} escapes its managed root.`);
}
