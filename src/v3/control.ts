import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { processIdentityForPid } from "./claims.ts";
import { atomicWriteJson, createDurableJson, syncDirectory } from "./durable.ts";
import { readAtomicRegularFile } from "./safe-read.ts";

export const V3_CONTROL_SCHEMA_VERSION = 1 as const;
export type V3DesiredState = "running" | "paused" | "stopped";

/**
 * Durable operator intent for one V3 run. This is deliberately separate from
 * snapshot.json: the snapshot records observed execution, while control.json
 * records what the caller wants the current/future Supervisor to do.
 */
export interface V3RunControl {
	schemaVersion: typeof V3_CONTROL_SCHEMA_VERSION;
	runInstanceId: string;
	graphId: string;
	desiredState: V3DesiredState;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface V3ControlMutationOptions {
	/** Compare-and-set precondition. Omit only for an unconditional command. */
	expectedRevision?: number;
	/** Immutable run identity checks performed inside the CAS critical section. */
	runInstanceId?: string;
	graphId?: string;
}

export class V3ControlRevisionConflictError extends Error {
	readonly expectedRevision: number;
	readonly actualRevision: number;

	constructor(expectedRevision: number, actualRevision: number) {
		super(`V3 control revision conflict: expected ${expectedRevision}, found ${actualRevision}.`);
		this.name = "V3ControlRevisionConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export class V3InvalidControlError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "V3InvalidControlError";
	}
}

const CONTROL_FIELDS = new Set([
	"schemaVersion", "runInstanceId", "graphId", "desiredState", "revision", "createdAt", "updatedAt",
]);
const DESIRED_STATES = new Set<V3DesiredState>(["running", "paused", "stopped"]);
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const INCOMPLETE_LOCK_STALE_MS = 30_000;

interface ControlLockOwner {
	token: string;
	pid: number;
	processIdentity: string;
	createdAt: string;
}

export function v3ControlPath(runDir: string): string {
	return join(resolve(runDir), "control.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, field: string): string {
	const candidate = value[field];
	if (typeof candidate !== "string" || candidate.length === 0) {
		throw new V3InvalidControlError(`V3 control field '${field}' must be a non-empty string.`);
	}
	return candidate;
}

function requiredTimestamp(value: Record<string, unknown>, field: string): string {
	const candidate = requiredString(value, field);
	if (Number.isNaN(Date.parse(candidate))) throw new V3InvalidControlError(`V3 control field '${field}' must be an ISO-8601 timestamp.`);
	return candidate;
}

export function validateV3RunControl(value: unknown): V3RunControl {
	if (!isRecord(value)) throw new V3InvalidControlError("V3 control must be an object.");
	for (const field of Object.keys(value)) {
		if (!CONTROL_FIELDS.has(field)) throw new V3InvalidControlError(`V3 control contains unknown field '${field}'.`);
	}
	if (value.schemaVersion !== V3_CONTROL_SCHEMA_VERSION) throw new V3InvalidControlError("V3 control requires schemaVersion 1.");
	const desiredState = value.desiredState;
	if (typeof desiredState !== "string" || !DESIRED_STATES.has(desiredState as V3DesiredState)) {
		throw new V3InvalidControlError("V3 control desiredState must be running, paused, or stopped.");
	}
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) {
		throw new V3InvalidControlError("V3 control revision must be a non-negative safe integer.");
	}
	const createdAt = requiredTimestamp(value, "createdAt");
	const updatedAt = requiredTimestamp(value, "updatedAt");
	if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new V3InvalidControlError("V3 control updatedAt cannot precede createdAt.");
	return {
		schemaVersion: V3_CONTROL_SCHEMA_VERSION,
		runInstanceId: requiredString(value, "runInstanceId"),
		graphId: requiredString(value, "graphId"),
		desiredState: desiredState as V3DesiredState,
		revision: value.revision,
		createdAt,
		updatedAt,
	};
}

async function readRegularJson(path: string): Promise<unknown> {
	let contents: string;
	try {
		contents = await readAtomicRegularFile(path, { maxBytes: 1024 * 1024, invalidMessage: "Unsafe V3 control file." });
	} catch (error) {
		// Initialization needs the original missing-file signal; unsafe files remain fatal.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
		throw new V3InvalidControlError("V3 control could not be read safely.", { cause: error });
	}
	try {
		return JSON.parse(contents) as unknown;
	} catch (error) {
		throw new V3InvalidControlError("V3 control contains invalid JSON.", { cause: error });
	}
}

export async function readV3RunControl(runDir: string): Promise<V3RunControl> {
	return validateV3RunControl(await readRegularJson(v3ControlPath(runDir)));
}

function assertControlIdentity(control: V3RunControl, runInstanceId: string, graphId: string): void {
	if (control.runInstanceId !== runInstanceId || control.graphId !== graphId) {
		throw new V3InvalidControlError("V3 control identity does not match the admitted run.");
	}
}

function parseLockOwner(value: unknown): ControlLockOwner | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.token !== "string" || value.token.length === 0) return undefined;
	if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined;
	if (typeof value.processIdentity !== "string" || value.processIdentity.length === 0) return undefined;
	if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return undefined;
	return value as unknown as ControlLockOwner;
}

async function staleLock(path: string): Promise<boolean> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink()) throw new V3InvalidControlError("V3 control lock path is not a regular file.");
	let owner: ControlLockOwner | undefined;
	try {
		owner = parseLockOwner(JSON.parse(await readFile(path, "utf8")));
	} catch {
		// A creator can be between exclusive open and durable owner publication.
	}
	if (!owner) return Date.now() - info.mtimeMs >= INCOMPLETE_LOCK_STALE_MS;
	const liveIdentity = await processIdentityForPid(owner.pid);
	return liveIdentity === undefined || liveIdentity !== owner.processIdentity;
}

async function quarantineStaleLock(path: string): Promise<void> {
	const quarantine = `${path}.stale-${randomUUID()}`;
	try {
		await rename(path, quarantine);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await rm(quarantine, { force: true });
	await syncDirectory(dirname(path));
}

async function acquireControlLock(controlPath: string): Promise<() => Promise<void>> {
	const lockPath = `${controlPath}.lock`;
	const processIdentity = await processIdentityForPid(process.pid);
	if (!processIdentity) throw new V3InvalidControlError("V3 control CAS requires a resolvable process identity.");
	const owner: ControlLockOwner = { token: randomUUID(), pid: process.pid, processIdentity, createdAt: new Date().toISOString() };
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		let handle;
		let ownedIdentity: { dev: number; ino: number } | undefined;
		try {
			handle = await open(lockPath, "wx", 0o600);
			const opened = await handle.stat();
			ownedIdentity = { dev: opened.dev, ino: opened.ino };
			await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await syncDirectory(dirname(lockPath));
			return async () => {
				let recorded: ControlLockOwner | undefined;
				try {
					recorded = parseLockOwner(JSON.parse(await readFile(lockPath, "utf8")));
				} catch {
					return;
				}
				if (recorded?.token !== owner.token) return;
				await rm(lockPath, { force: true });
				await syncDirectory(dirname(lockPath));
			};
		} catch (error) {
			await handle?.close().catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				if (ownedIdentity) {
					const current = await lstat(lockPath).catch(() => undefined);
					if (current && current.dev === ownedIdentity.dev && current.ino === ownedIdentity.ino) {
						await rm(lockPath, { force: true }).catch(() => undefined);
					}
				}
				throw error;
			}
			if (await staleLock(lockPath)) {
				await quarantineStaleLock(lockPath);
				continue;
			}
			if (Date.now() >= deadline) throw new V3InvalidControlError("Timed out acquiring the V3 control CAS lock.");
			await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_WAIT_MS));
		}
	}
}

async function withControlLock<T>(controlPath: string, action: () => Promise<T>): Promise<T> {
	await mkdir(dirname(controlPath), { recursive: true });
	const release = await acquireControlLock(controlPath);
	try {
		return await action();
	} finally {
		await release();
	}
}

/** Create revision 0 exactly once, or verify an existing control belongs to this run. */
export async function initializeV3RunControl(runDir: string, runInstanceId: string, graphId: string): Promise<V3RunControl> {
	const path = v3ControlPath(runDir);
	return withControlLock(path, async () => {
		try {
			const existing = await readV3RunControl(runDir);
			assertControlIdentity(existing, runInstanceId, graphId);
			return existing;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const now = new Date().toISOString();
		const initial: V3RunControl = {
			schemaVersion: V3_CONTROL_SCHEMA_VERSION,
			runInstanceId,
			graphId,
			desiredState: "running",
			revision: 0,
			createdAt: now,
			updatedAt: now,
		};
		await createDurableJson(path, initial);
		return initial;
	});
}

/**
 * Atomically commit one desired-state revision. The short-lived lock turns the
 * read/check/rename sequence into a cross-process CAS for a single runDir.
 */
export async function updateV3RunControl(
	runDir: string,
	desiredState: V3DesiredState,
	options: V3ControlMutationOptions = {},
): Promise<V3RunControl> {
	if (!DESIRED_STATES.has(desiredState)) throw new V3InvalidControlError(`Unsupported V3 desired state '${String(desiredState)}'.`);
	if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) {
		throw new V3InvalidControlError("V3 expected control revision must be a non-negative safe integer.");
	}
	const path = v3ControlPath(runDir);
	return withControlLock(path, async () => {
		const current = await readV3RunControl(runDir);
		if (options.runInstanceId !== undefined || options.graphId !== undefined) {
			assertControlIdentity(current, options.runInstanceId ?? current.runInstanceId, options.graphId ?? current.graphId);
		}
		if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
			throw new V3ControlRevisionConflictError(options.expectedRevision, current.revision);
		}
		if (current.revision === Number.MAX_SAFE_INTEGER) throw new V3InvalidControlError("V3 control revision is exhausted.");
		const next: V3RunControl = {
			...current,
			desiredState,
			revision: current.revision + 1,
			updatedAt: new Date().toISOString(),
		};
		await atomicWriteJson(path, next);
		return next;
	});
}
