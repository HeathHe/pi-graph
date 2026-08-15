import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { authorizationV4For } from "./authorization.ts";
import { canonicalJson } from "./digests.ts";
import { GraphV3Error } from "./errors.ts";
import { graphSnapshotV3For } from "./snapshot.ts";
import { resolveSourceIdentityV3 } from "./source-identity.ts";
import type { AuthorizationV4, CompiledGraphV3, GraphSnapshotV3 } from "./types.ts";

const INITIALIZATION_LOCK_SCHEMA_VERSION = 1;
const LOCK_OWNER_FILE = "owner.json";
let currentProcessIdentity: Promise<string | undefined> | undefined;

interface DirectoryIdentity {
	dev: number;
	ino: number;
}

interface InitializationLockOwner {
	schemaVersion: typeof INITIALIZATION_LOCK_SCHEMA_VERSION;
	pid: number;
	processIdentity: string;
	token: string;
	createdAt: string;
}

interface HeldInitializationLock {
	lockDir: string;
	owner: InitializationLockOwner;
}

interface ReadInitializationLock {
	owner: InitializationLockOwner;
	identity: DirectoryIdentity;
}

export interface InitializeV3RunOptions {
	runDir: string;
	graph: CompiledGraphV3;
	sessionId: string;
	supervisorEpoch: string;
	sourceCwd?: string;
	runInstanceId?: string;
	createdAt?: string;
}

export interface InitializeV3RunResult {
	runDir: string;
	authorization: AuthorizationV4;
	snapshot: GraphSnapshotV3;
}

export interface V3InitializationDependencies {
	atomicRename?: (source: string, destination: string) => Promise<void>;
	processIdentityForPid?: (pid: number) => Promise<string | undefined>;
	syncDirectory?: (path: string) => Promise<void>;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function psProcessIdentity(pid: number): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 1_000 }, (error, stdout) => {
			if (error) resolvePromise(undefined);
			else {
				const value = stdout.trim().replace(/\s+/gu, " ");
				resolvePromise(value ? `ps:${value}` : undefined);
			}
		});
	});
}

async function processIdentityForPidV3(pid: number): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return undefined;
	if (pid === process.pid && currentProcessIdentity) return currentProcessIdentity;
	const resolveIdentity = async () => {
		if (process.platform === "linux") {
			try {
				const stat = await readFile(`/proc/${pid}/stat`, "utf8");
				const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
				const startedAtTick = fields[19];
				if (startedAtTick && /^[0-9]+$/u.test(startedAtTick)) return `linux:${startedAtTick}`;
			} catch {
				// Fall through to ps on systems without a readable procfs.
			}
		}
		return psProcessIdentity(pid);
	};
	if (pid !== process.pid) return resolveIdentity();
	const pending = resolveIdentity();
	currentProcessIdentity = pending;
	const identity = await pending;
	if (!identity && currentProcessIdentity === pending) currentProcessIdentity = undefined;
	return identity;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
		return { dev: stat.dev, ino: stat.ino };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function sameDirectoryIdentity(left: DirectoryIdentity | undefined, right: DirectoryIdentity | undefined): boolean {
	return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

async function durableWrite(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx" });
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function cleanupOwnedDirectory(path: string, expected: DirectoryIdentity | undefined): Promise<boolean> {
	if (!expected || !sameDirectoryIdentity(await directoryIdentity(path), expected)) return false;
	const quarantine = `${path}.cleanup-${randomUUID()}`;
	try {
		await rename(path, quarantine);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	if (!sameDirectoryIdentity(await directoryIdentity(quarantine), expected)) {
		await rename(quarantine, path).catch(() => undefined);
		return false;
	}
	await rm(quarantine, { recursive: true, force: true });
	return true;
}

function validateLockOwner(value: unknown): InitializationLockOwner {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock owner must be an object.");
	const record = value as Record<string, unknown>;
	for (const field of Object.keys(record)) {
		if (!["schemaVersion", "pid", "processIdentity", "token", "createdAt"].includes(field)) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", `V3 initialization lock contains unknown field '${field}'.`, { field });
	}
	if (record.schemaVersion !== INITIALIZATION_LOCK_SCHEMA_VERSION) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock has an unsupported schemaVersion.", { field: "schemaVersion" });
	if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock pid is invalid.", { field: "pid" });
	if (typeof record.processIdentity !== "string" || record.processIdentity.length === 0) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock processIdentity is missing or invalid.", { field: "processIdentity" });
	if (typeof record.token !== "string" || record.token.length === 0) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock token is missing or invalid.", { field: "token" });
	if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock createdAt is invalid.", { field: "createdAt" });
	return { schemaVersion: 1, pid: record.pid as number, processIdentity: record.processIdentity, token: record.token, createdAt: record.createdAt };
}

async function readLockOwner(lockDir: string): Promise<ReadInitializationLock> {
	const lockStat = await lstat(lockDir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!lockStat) throw Object.assign(new Error("Initialization lock disappeared."), { code: "ENOENT" });
	if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock path is not a regular directory.");
	const identity = { dev: lockStat.dev, ino: lockStat.ino };
	const ownerPath = join(lockDir, LOCK_OWNER_FILE);
	const ownerStat = await lstat(ownerPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!ownerStat || !ownerStat.isFile() || ownerStat.isSymbolicLink()) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock owner.json is missing or is not a regular file.");
	let value: unknown;
	try {
		value = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
	} catch (error) {
		throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", `V3 initialization lock owner.json is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	return { owner: validateLockOwner(value), identity };
}

async function acquireInitializationLock(lockDir: string, runDir: string, dependencies: V3InitializationDependencies): Promise<HeldInitializationLock> {
	const identityResolver = dependencies.processIdentityForPid ?? processIdentityForPidV3;
	const processIdentity = await identityResolver(process.pid);
	if (!processIdentity) throw new GraphV3Error("INITIALIZATION_FAILED", "The current process start identity is unavailable; refusing PID-only V3 initialization ownership.");
	for (let attempt = 0; attempt < 8; attempt += 1) {
		try {
			await mkdir(lockDir);
			const ownedIdentity = await directoryIdentity(lockDir);
			const owner: InitializationLockOwner = { schemaVersion: 1, pid: process.pid, processIdentity, token: randomUUID(), createdAt: new Date().toISOString() };
			try {
				await durableWrite(join(lockDir, LOCK_OWNER_FILE), owner);
				await (dependencies.syncDirectory ?? syncDirectory)(lockDir);
				return { lockDir, owner };
			} catch (error) {
				await cleanupOwnedDirectory(lockDir, ownedIdentity).catch(() => undefined);
				throw error;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let observedLock: ReadInitializationLock;
		try {
			observedLock = await readLockOwner(lockDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const { owner } = observedLock;
		const observedIdentity = await identityResolver(owner.pid);
		if (observedIdentity === owner.processIdentity) throw new GraphV3Error("RUN_ALREADY_EXISTS", `V3 run initialization is already in progress: ${runDir}`, { details: { runDir, pid: owner.pid } });
		const staleDir = `${lockDir}.stale-${randomUUID()}`;
		try {
			await rename(lockDir, staleDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!sameDirectoryIdentity(await directoryIdentity(staleDir), observedLock.identity)) {
			try {
				await rename(staleDir, lockDir);
			} catch (error) {
				throw new GraphV3Error("INITIALIZATION_FAILED", "A live V3 initialization lock changed during stale takeover and could not be restored.", { cause: error });
			}
			continue;
		}
		await rm(staleDir, { recursive: true, force: true });
	}
	throw new GraphV3Error("INITIALIZATION_FAILED", `Could not acquire V3 initialization lock after repeated stale-lock races: ${runDir}`, { details: { runDir } });
}

async function releaseInitializationLock(lock: HeldInitializationLock): Promise<void> {
	let observedLock: ReadInitializationLock;
	try {
		observedLock = await readLockOwner(lock.lockDir);
	} catch {
		return;
	}
	const { owner } = observedLock;
	if (owner.token !== lock.owner.token || owner.pid !== lock.owner.pid || owner.processIdentity !== lock.owner.processIdentity) return;
	const releaseDir = `${lock.lockDir}.release-${lock.owner.token}`;
	try {
		await rename(lock.lockDir, releaseDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!sameDirectoryIdentity(await directoryIdentity(releaseDir), observedLock.identity)) {
		await rename(releaseDir, lock.lockDir).catch(() => undefined);
		return;
	}
	await rm(releaseDir, { recursive: true, force: true });
}

export async function initializeV3Run(options: InitializeV3RunOptions, dependencies: V3InitializationDependencies = {}): Promise<InitializeV3RunResult> {
	const runDir = resolve(options.runDir);
	const parentDir = dirname(runDir);
	const runName = basename(runDir);
	if (!runName || runDir === parentDir) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 runDir must identify a child directory.", { field: "runDir" });
	const createdAt = options.createdAt ?? new Date().toISOString();
	const runInstanceId = options.runInstanceId ?? randomUUID();
	let sourceIdentity;
	try {
		sourceIdentity = await resolveSourceIdentityV3(options.sourceCwd ?? process.cwd());
	} catch (error) {
		throw new GraphV3Error("INITIALIZATION_FAILED", `Could not resolve V3 source repository identity: ${error instanceof Error ? error.message : String(error)}`, { field: "sourceCwd", cause: error });
	}
	const metadata = { runInstanceId, sessionId: options.sessionId, supervisorEpoch: options.supervisorEpoch, createdAt, ...sourceIdentity };
	const authorization = authorizationV4For(options.graph, metadata);
	const snapshot = graphSnapshotV3For(options.graph, metadata);
	const lockDir = join(parentDir, `.${runName}.initialize-lock`);
	let tempDir: string | undefined;
	let stagingIdentity: DirectoryIdentity | undefined;
	let heldLock: HeldInitializationLock | undefined;
	try {
		await mkdir(parentDir, { recursive: true });
		if (await pathExists(runDir)) throw new GraphV3Error("RUN_ALREADY_EXISTS", `V3 run directory already exists: ${runDir}`, { details: { runDir } });
		heldLock = await acquireInitializationLock(lockDir, runDir, dependencies);
		if (await pathExists(runDir)) throw new GraphV3Error("RUN_ALREADY_EXISTS", `V3 run directory already exists: ${runDir}`, { details: { runDir } });
		tempDir = await mkdtemp(join(parentDir, `.${runName}.tmp-`));
		stagingIdentity = await directoryIdentity(tempDir);
		if (!stagingIdentity) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 initialization staging directory identity is unavailable.");
		await durableWrite(join(tempDir, "authorization.json"), authorization);
		await durableWrite(join(tempDir, "snapshot.json"), snapshot);
		await (dependencies.syncDirectory ?? syncDirectory)(tempDir);
		await (dependencies.atomicRename ?? rename)(tempDir, runDir);
		await (dependencies.syncDirectory ?? syncDirectory)(runDir);
		await (dependencies.syncDirectory ?? syncDirectory)(parentDir);
		tempDir = undefined;
		stagingIdentity = undefined;
		return { runDir, authorization, snapshot };
	} catch (error) {
		const targetIdentity = await directoryIdentity(runDir).catch(() => undefined);
		const targetIsOwned = sameDirectoryIdentity(targetIdentity, stagingIdentity);
		if (tempDir) await cleanupOwnedDirectory(tempDir, stagingIdentity).catch(() => undefined);
		if (targetIsOwned) await cleanupOwnedDirectory(runDir, stagingIdentity).catch(() => undefined);
		if (!(error instanceof GraphV3Error) && targetIdentity && !targetIsOwned) {
			throw new GraphV3Error("RUN_ALREADY_EXISTS", `A competing V3 run directory appeared during initialization: ${runDir}`, { details: { runDir }, cause: error });
		}
		if (error instanceof GraphV3Error) throw error;
		throw new GraphV3Error("INITIALIZATION_FAILED", `Failed to initialize V3 run at ${runDir}: ${error instanceof Error ? error.message : String(error)}`, { details: { runDir }, cause: error });
	} finally {
		if (heldLock) await releaseInitializationLock(heldLock).catch(() => undefined);
	}
}
