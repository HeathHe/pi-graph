import { validateV3InitialRequiredMaterials } from "./workspace.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { authorizationV4For } from "./authorization.ts";
import { canonicalJson } from "./digests.ts";
import { atomicWriteJson, syncDirectory } from "./durable.ts";
import { GraphV3Error } from "./errors.ts";
import { captureTrustedDirectoryAnchor, unsafeDirectoryComponent } from "./path-safety.ts";
import type { TrustedDirectoryAnchor } from "./path-safety.ts";
import { graphSnapshotV3For } from "./snapshot.ts";
import { resolveSourceIdentityV3 } from "./source-identity.ts";
import type { AuthorizationV4, CompiledGraphV3, GraphSnapshotV3, SourceIdentityV3 } from "./types.ts";

const INITIALIZATION_LOCK_SCHEMA_VERSION = 1;
const LOCK_OWNER_FILE = "owner.json";
const INCOMPLETE_LOCK_RECOVERY_MS = 5 * 60_000;
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
	identity: DirectoryIdentity;
}

interface ReadInitializationLock {
	owner: InitializationLockOwner;
	identity: DirectoryIdentity;
}

export interface InitializeV3RunOptions {
	trustedRoot: string;
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
	beforePublish?: () => Promise<void>;
	beforeOwnerlessLockCleanup?: (lockDir: string) => Promise<void>;
	processIdentityForPid?: (pid: number) => Promise<string | undefined>;
	sourceIdentityFor?: (sourceCwd: string) => Promise<SourceIdentityV3>;
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

async function regularFileIdentity(path: string): Promise<DirectoryIdentity | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		return { dev: stat.dev, ino: stat.ino };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function sameDirectoryIdentity(left: DirectoryIdentity | undefined, right: DirectoryIdentity | undefined): boolean {
	return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

async function durableWrite(path: string, value: unknown): Promise<string> {
	const contents = `${canonicalJson(value)}\n`;
	await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	return contents;
}

async function regularFileMatches(path: string, expectedIdentity: DirectoryIdentity, expectedContents: string): Promise<boolean> {
	let handle;
	try {
		const pathBefore = await lstat(path);
		if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || !sameDirectoryIdentity(pathBefore, expectedIdentity)) return false;
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (!opened.isFile() || !sameDirectoryIdentity(opened, expectedIdentity)) return false;
		const contents = await handle.readFile("utf8");
		const [finished, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
		return contents === expectedContents
			&& finished.isFile()
			&& !pathAfter.isSymbolicLink()
			&& pathAfter.isFile()
			&& sameDirectoryIdentity(finished, expectedIdentity)
			&& sameDirectoryIdentity(pathAfter, expectedIdentity)
			&& finished.size === opened.size
			&& finished.mtimeMs === opened.mtimeMs
			&& pathAfter.size === finished.size
			&& pathAfter.mtimeMs === finished.mtimeMs;
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function syncOwnedDirectory(path: string, expected: DirectoryIdentity, override?: (path: string) => Promise<void>): Promise<void> {
	if (!sameDirectoryIdentity(await directoryIdentity(path), expected)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 claimed run directory changed before it was synced.", { field: "runDir" });
	if (override) {
		await override(path);
	} else {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = await handle.stat();
			if (!opened.isDirectory() || !sameDirectoryIdentity({ dev: opened.dev, ino: opened.ino }, expected)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 claimed run directory changed while it was opened for sync.", { field: "runDir" });
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	if (!sameDirectoryIdentity(await directoryIdentity(path), expected)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 claimed run directory changed while it was synced.", { field: "runDir" });
}

async function ensureDurableDirectory(path: string, anchor: TrustedDirectoryAnchor, sync: (path: string) => Promise<void>): Promise<void> {
	const missing: string[] = [];
	let cursor = path;
	while (true) {
		try {
			const stat = await lstat(cursor);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GraphV3Error("INITIALIZATION_FAILED", `V3 run parent contains a symbolic link or non-directory: ${cursor}`, { field: "runDir" });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (cursor === anchor.root) throw new GraphV3Error("INITIALIZATION_FAILED", `V3 trusted root disappeared during parent creation: ${anchor.root}`, { field: "trustedRoot" });
			missing.push(cursor);
			const parent = dirname(cursor);
			if (parent === cursor) throw new GraphV3Error("INITIALIZATION_FAILED", `Could not find an existing parent for V3 run directory: ${path}`, { field: "runDir" });
			cursor = parent;
		}
	}
	for (const directory of missing.reverse()) {
		if (await unsafeDirectoryComponent(dirname(directory), anchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed before creating a missing directory.", { field: "runDir" });
		try {
			await mkdir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GraphV3Error("INITIALIZATION_FAILED", `V3 run parent contains a symbolic link or non-directory: ${directory}`, { field: "runDir" });
		if (await unsafeDirectoryComponent(directory, anchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed while creating a missing directory.", { field: "runDir" });
		await sync(directory);
		if (await unsafeDirectoryComponent(directory, anchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed while syncing a new directory.", { field: "runDir" });
		await sync(dirname(directory));
		if (await unsafeDirectoryComponent(directory, anchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed while syncing a new directory parent.", { field: "runDir" });
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
		// Preserve the raced directory in quarantine. Restoring with POSIX rename
		// could overwrite a newer empty target that appeared at the original path.
		return false;
	}
	await rm(quarantine, { recursive: true, force: true });
	return true;
}

async function cleanupExpiredInvalidLock(lockDir: string, trustedAnchor: TrustedDirectoryAnchor, beforeCleanup?: (lockDir: string) => Promise<void>): Promise<boolean> {
	const lockStat = await lstat(lockDir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!lockStat || !lockStat.isDirectory() || lockStat.isSymbolicLink()) return false;
	const ownerStat = await lstat(join(lockDir, LOCK_OWNER_FILE)).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	// Only a lock abandoned before owner publication is safe to recover by age.
	// Once owner.json exists, malformed ownership evidence must remain fail-closed.
	if (ownerStat) return false;
	if (Date.now() - lockStat.mtimeMs < INCOMPLETE_LOCK_RECOVERY_MS) return false;
	await beforeCleanup?.(lockDir);
	await assertTrustedLockParent(lockDir, trustedAnchor, "V3 trusted root or run parent changed while an ownerless initialization lock was inspected.");
	const confirmedLockStat = await lstat(lockDir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!confirmedLockStat
		|| confirmedLockStat.isSymbolicLink()
		|| !confirmedLockStat.isDirectory()
		|| !sameDirectoryIdentity(confirmedLockStat, lockStat)
		|| confirmedLockStat.mtimeMs !== lockStat.mtimeMs) return false;
	const confirmedOwner = await lstat(join(lockDir, LOCK_OWNER_FILE)).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (confirmedOwner) return false;
	const quarantine = `${lockDir}.ownerless-${randomUUID()}`;
	try {
		await rename(lockDir, quarantine);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	const quarantinedStat = await lstat(quarantine).catch(() => undefined);
	if (!quarantinedStat || quarantinedStat.isSymbolicLink() || !quarantinedStat.isDirectory() || !sameDirectoryIdentity(quarantinedStat, lockStat)) return false;
	const publishedOwner = await lstat(join(quarantine, LOCK_OWNER_FILE)).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (publishedOwner || quarantinedStat.mtimeMs !== lockStat.mtimeMs) return false;
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
	let handle;
	try {
		handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const openedOwner = await handle.stat();
		if (!openedOwner.isFile() || !sameDirectoryIdentity(ownerStat, openedOwner)) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock owner.json changed while being opened.");
		const contents = await handle.readFile("utf8");
		const [finishedOwner, currentOwner, currentLock] = await Promise.all([handle.stat(), lstat(ownerPath), lstat(lockDir)]);
		if (!finishedOwner.isFile()
			|| currentOwner.isSymbolicLink()
			|| !currentOwner.isFile()
			|| currentLock.isSymbolicLink()
			|| !currentLock.isDirectory()
			|| !sameDirectoryIdentity(ownerStat, finishedOwner)
			|| !sameDirectoryIdentity(ownerStat, currentOwner)
			|| !sameDirectoryIdentity(identity, currentLock)
			|| finishedOwner.size !== openedOwner.size
			|| finishedOwner.mtimeMs !== openedOwner.mtimeMs
			|| currentOwner.size !== finishedOwner.size
			|| currentOwner.mtimeMs !== finishedOwner.mtimeMs) {
			throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "V3 initialization lock or owner.json changed while being read.");
		}
		return { owner: validateLockOwner(JSON.parse(contents) as unknown), identity };
	} catch (error) {
		if (error instanceof GraphV3Error) throw error;
		throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", `V3 initialization lock owner.json is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function sameLockOwner(left: InitializationLockOwner, right: InitializationLockOwner): boolean {
	return left.schemaVersion === right.schemaVersion
		&& left.pid === right.pid
		&& left.processIdentity === right.processIdentity
		&& left.token === right.token
		&& left.createdAt === right.createdAt;
}

async function initializationLockIsHeld(lock: HeldInitializationLock): Promise<boolean> {
	try {
		const observed = await readLockOwner(lock.lockDir);
		return sameDirectoryIdentity(observed.identity, lock.identity) && sameLockOwner(observed.owner, lock.owner);
	} catch {
		return false;
	}
}

async function assertTrustedLockParent(lockDir: string, anchor: TrustedDirectoryAnchor, message: string): Promise<void> {
	const unsafe = await unsafeDirectoryComponent(dirname(lockDir), anchor);
	if (unsafe) throw new GraphV3Error("INITIALIZATION_FAILED", message, { field: "trustedRoot", details: { unsafe } });
}

async function acquireInitializationLock(lockDir: string, runDir: string, trustedAnchor: TrustedDirectoryAnchor, dependencies: V3InitializationDependencies): Promise<HeldInitializationLock> {
	const identityResolver = dependencies.processIdentityForPid ?? processIdentityForPidV3;
	const processIdentity = await identityResolver(process.pid);
	if (!processIdentity) throw new GraphV3Error("INITIALIZATION_FAILED", "The current process start identity is unavailable; refusing PID-only V3 initialization ownership.");
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await assertTrustedLockParent(lockDir, trustedAnchor, "V3 trusted root or run parent changed before initialization lock creation.");
		try {
			await mkdir(lockDir);
			const ownedIdentity = await directoryIdentity(lockDir);
			if (!ownedIdentity) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 initialization lock identity is unavailable after creation.");
			const owner: InitializationLockOwner = { schemaVersion: 1, pid: process.pid, processIdentity, token: randomUUID(), createdAt: new Date().toISOString() };
			try {
				await durableWrite(join(lockDir, LOCK_OWNER_FILE), owner);
				await (dependencies.syncDirectory ?? syncDirectory)(lockDir);
				await assertTrustedLockParent(lockDir, trustedAnchor, "V3 trusted root or run parent changed while the initialization lock was synced.");
				const publishedLock = await readLockOwner(lockDir);
				if (!sameDirectoryIdentity(publishedLock.identity, ownedIdentity) || !sameLockOwner(publishedLock.owner, owner)) {
					throw new GraphV3Error("INITIALIZATION_FAILED", "V3 initialization lock changed while its owner was published.");
				}
				return { lockDir, owner, identity: ownedIdentity };
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
			if (error instanceof GraphV3Error && error.code === "INVALID_INITIALIZATION_LOCK" && await cleanupExpiredInvalidLock(lockDir, trustedAnchor, dependencies.beforeOwnerlessLockCleanup)) continue;
			throw error;
		}
		const { owner } = observedLock;
		if (isProcessAlive(owner.pid)) {
			let observedIdentity: string | undefined;
			try {
				observedIdentity = await identityResolver(owner.pid);
			} catch (error) {
				throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "The live V3 initialization lock owner identity could not be inspected safely.", { cause: error, details: { runDir, pid: owner.pid } });
			}
			await assertTrustedLockParent(lockDir, trustedAnchor, "V3 trusted root or run parent changed while the initialization lock owner identity was inspected.");
			if (!observedIdentity) throw new GraphV3Error("INVALID_INITIALIZATION_LOCK", "The V3 initialization lock owner is alive, but its process identity is unavailable; refusing stale takeover.", { details: { runDir, pid: owner.pid } });
			if (observedIdentity === owner.processIdentity) throw new GraphV3Error("RUN_ALREADY_EXISTS", `V3 run initialization is already in progress: ${runDir}`, { details: { runDir, pid: owner.pid } });
		}
		await assertTrustedLockParent(lockDir, trustedAnchor, "V3 trusted root or run parent changed before stale initialization lock takeover.");
		let confirmedLock: ReadInitializationLock;
		try {
			confirmedLock = await readLockOwner(lockDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!sameDirectoryIdentity(confirmedLock.identity, observedLock.identity) || !sameLockOwner(confirmedLock.owner, observedLock.owner)) continue;
		const staleDir = `${lockDir}.stale-${randomUUID()}`;
		try {
			await rename(lockDir, staleDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!sameDirectoryIdentity(await directoryIdentity(staleDir), observedLock.identity)) {
			throw new GraphV3Error("INITIALIZATION_FAILED", "A V3 initialization lock changed during stale takeover and was preserved in quarantine to avoid overwriting a newer lock.", { details: { quarantine: staleDir } });
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
	if (!sameDirectoryIdentity(observedLock.identity, lock.identity) || !sameLockOwner(owner, lock.owner)) return;
	const releaseDir = `${lock.lockDir}.release-${lock.owner.token}`;
	try {
		await rename(lock.lockDir, releaseDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!sameDirectoryIdentity(await directoryIdentity(releaseDir), observedLock.identity)) {
		// Preserve the raced directory rather than risking replacement of a newer lock.
		return;
	}
	await rm(releaseDir, { recursive: true, force: true });
}

export async function initializeV3Run(options: InitializeV3RunOptions, dependencies: V3InitializationDependencies = {}): Promise<InitializeV3RunResult> {
	const trustedRoot = resolve(options.trustedRoot);
	const runDir = resolve(options.runDir);
	const sourceCwd = options.sourceCwd ?? process.cwd();
	const sessionId = options.sessionId;
	const supervisorEpoch = options.supervisorEpoch;
	const admittedGraph = JSON.parse(canonicalJson(options.graph)) as CompiledGraphV3;
	await validateV3InitialRequiredMaterials(sourceCwd, admittedGraph);
	const parentDir = dirname(runDir);
	const runName = basename(runDir);
	if (!runName || runDir === parentDir) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 runDir must identify a child directory.", { field: "runDir" });
	const createdAt = options.createdAt ?? new Date().toISOString();
	const runInstanceId = options.runInstanceId ?? randomUUID();
	const trustedAnchor = await captureTrustedDirectoryAnchor(trustedRoot).catch((error) => {
		throw new GraphV3Error("INITIALIZATION_FAILED", `Could not capture V3 trusted root identity: ${error instanceof Error ? error.message : String(error)}`, { field: "trustedRoot", cause: error });
	});
	let sourceIdentity;
	try {
		sourceIdentity = await (dependencies.sourceIdentityFor ?? resolveSourceIdentityV3)(sourceCwd);
	} catch (error) {
		throw new GraphV3Error("INITIALIZATION_FAILED", `Could not resolve V3 source repository identity: ${error instanceof Error ? error.message : String(error)}`, { field: "sourceCwd", cause: error });
	}
	const metadata = { runInstanceId, sessionId, supervisorEpoch, createdAt, ...sourceIdentity };
	const authorization = authorizationV4For(admittedGraph, metadata);
	const snapshot = graphSnapshotV3For(admittedGraph, metadata);
	const lockDir = join(parentDir, `.${runName}.initialize-lock`);
	let tempDir: string | undefined;
	let stagingIdentity: DirectoryIdentity | undefined;
	let ownedRunIdentity: DirectoryIdentity | undefined;
	let heldLock: HeldInitializationLock | undefined;
	try {
		const unsafeParent = await unsafeDirectoryComponent(parentDir, trustedAnchor);
		if (unsafeParent) throw new GraphV3Error("INITIALIZATION_FAILED", `V3 run parent is outside its canonical trusted root or contains a symbolic link/non-directory: ${unsafeParent}`, { field: "runDir" });
		await ensureDurableDirectory(parentDir, trustedAnchor, dependencies.syncDirectory ?? syncDirectory);
		const unsafeCreatedParent = await unsafeDirectoryComponent(parentDir, trustedAnchor);
		if (unsafeCreatedParent) throw new GraphV3Error("INITIALIZATION_FAILED", `V3 run parent became unsafe or escaped its trusted root during creation: ${unsafeCreatedParent}`, { field: "runDir" });
		if (await pathExists(runDir)) throw new GraphV3Error("RUN_ALREADY_EXISTS", `V3 run directory already exists: ${runDir}`, { details: { runDir } });
		heldLock = await acquireInitializationLock(lockDir, runDir, trustedAnchor, dependencies);
		if (!await initializationLockIsHeld(heldLock)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 initialization lock ownership was lost immediately after acquisition.");
		if (await unsafeDirectoryComponent(parentDir, trustedAnchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed while the initialization lock was acquired.", { field: "runDir" });
		if (await pathExists(runDir)) throw new GraphV3Error("RUN_ALREADY_EXISTS", `V3 run directory already exists: ${runDir}`, { details: { runDir } });
		tempDir = await mkdtemp(join(parentDir, `.${runName}.tmp-`));
		stagingIdentity = await directoryIdentity(tempDir);
		if (!stagingIdentity) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 initialization staging directory identity is unavailable.");
		const expectedAuthorization = await durableWrite(join(tempDir, "authorization.json"), authorization);
		const expectedSnapshot = await durableWrite(join(tempDir, "snapshot.json"), snapshot);
		const stagingAuthorizationIdentity = await regularFileIdentity(join(tempDir, "authorization.json"));
		const stagingSnapshotIdentity = await regularFileIdentity(join(tempDir, "snapshot.json"));
		if (!stagingAuthorizationIdentity || !stagingSnapshotIdentity) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 staging authority file identity is unavailable.");
		await (dependencies.syncDirectory ?? syncDirectory)(tempDir);
		if (await unsafeDirectoryComponent(parentDir, trustedAnchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed while the staging directory was synced.", { field: "runDir" });
		await dependencies.beforePublish?.();
		if (await unsafeDirectoryComponent(parentDir, trustedAnchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed at the publication boundary.", { field: "runDir" });
		if (!await initializationLockIsHeld(heldLock)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 initialization lock ownership was lost before run publication.");
		if (!sameDirectoryIdentity(await directoryIdentity(tempDir), stagingIdentity)
			|| !await regularFileMatches(join(tempDir, "authorization.json"), stagingAuthorizationIdentity, expectedAuthorization)
			|| !await regularFileMatches(join(tempDir, "snapshot.json"), stagingSnapshotIdentity, expectedSnapshot)) {
			throw new GraphV3Error("INITIALIZATION_FAILED", "V3 staging directory or authority files changed before run publication.");
		}
		if (await unsafeDirectoryComponent(parentDir, trustedAnchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed before run publication.", { field: "runDir" });
		await mkdir(runDir);
		ownedRunIdentity = await directoryIdentity(runDir);
		if (!ownedRunIdentity) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 claimed run directory identity is unavailable.");
		if (!sameDirectoryIdentity(await directoryIdentity(runDir), ownedRunIdentity)
			|| !sameDirectoryIdentity(await directoryIdentity(tempDir), stagingIdentity)
			|| !await regularFileMatches(join(tempDir, "authorization.json"), stagingAuthorizationIdentity, expectedAuthorization)) {
			throw new GraphV3Error("INITIALIZATION_FAILED", "V3 staging authorization changed before publication.");
		}
		await rename(join(tempDir, "authorization.json"), join(runDir, "authorization.json"));
		if (!sameDirectoryIdentity(await directoryIdentity(runDir), ownedRunIdentity)
			|| !await regularFileMatches(join(runDir, "authorization.json"), stagingAuthorizationIdentity, expectedAuthorization)
			|| !sameDirectoryIdentity(await directoryIdentity(tempDir), stagingIdentity)
			|| !await regularFileMatches(join(tempDir, "snapshot.json"), stagingSnapshotIdentity, expectedSnapshot)) {
			throw new GraphV3Error("INITIALIZATION_FAILED", "V3 staging snapshot or published authorization changed during publication.");
		}
		await rename(join(tempDir, "snapshot.json"), join(runDir, "snapshot.json"));
		if (!sameDirectoryIdentity(await directoryIdentity(runDir), ownedRunIdentity)
			|| !await regularFileMatches(join(runDir, "authorization.json"), stagingAuthorizationIdentity, expectedAuthorization)
			|| !await regularFileMatches(join(runDir, "snapshot.json"), stagingSnapshotIdentity, expectedSnapshot)) {
			throw new GraphV3Error("INITIALIZATION_FAILED", "V3 claimed run directory or authority files changed while they were published.", { field: "runDir" });
		}
		if (!await cleanupOwnedDirectory(tempDir, stagingIdentity)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 staging directory changed before cleanup.");
		tempDir = undefined;
		stagingIdentity = undefined;
		if (await unsafeDirectoryComponent(parentDir, trustedAnchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed during run publication.", { field: "runDir" });
		await syncOwnedDirectory(runDir, ownedRunIdentity, dependencies.syncDirectory);
		if (await unsafeDirectoryComponent(parentDir, trustedAnchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed while the published run was synced.", { field: "runDir" });
		await (dependencies.syncDirectory ?? syncDirectory)(parentDir);
		if (await unsafeDirectoryComponent(parentDir, trustedAnchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed while the published run parent was synced.", { field: "runDir" });
		if (!sameDirectoryIdentity(await directoryIdentity(runDir), ownedRunIdentity)
			|| !await regularFileMatches(join(runDir, "authorization.json"), stagingAuthorizationIdentity, expectedAuthorization)
			|| !await regularFileMatches(join(runDir, "snapshot.json"), stagingSnapshotIdentity, expectedSnapshot)) {
			throw new GraphV3Error("INITIALIZATION_FAILED", "V3 claimed run directory or authority bytes changed before initialization completed.", { field: "runDir" });
		}
		if (!await initializationLockIsHeld(heldLock)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 initialization lock ownership was lost before initialization completed.");
		if (await unsafeDirectoryComponent(parentDir, trustedAnchor)) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 trusted root or run parent changed before initialization completed.", { field: "runDir" });
		await atomicWriteJson(join(runDir,"communication.json"),{protocol:"graph-mailbox-v1",runtimeKind:"pi-graph-sdk/1",runInstanceId:authorization.runInstanceId});
		return { runDir, authorization, snapshot };
	} catch (error) {
		const targetExists = await pathExists(runDir).catch(() => false);
		const targetIdentity = await directoryIdentity(runDir).catch(() => undefined);
		const targetIsOwned = sameDirectoryIdentity(targetIdentity, ownedRunIdentity);
		if (tempDir) await cleanupOwnedDirectory(tempDir, stagingIdentity).catch(() => undefined);
		if (targetIsOwned) await cleanupOwnedDirectory(runDir, ownedRunIdentity).catch(() => undefined);
		if (!(error instanceof GraphV3Error) && targetExists && !targetIsOwned) {
			throw new GraphV3Error("RUN_ALREADY_EXISTS", `A competing V3 run directory appeared during initialization: ${runDir}`, { details: { runDir }, cause: error });
		}
		if (error instanceof GraphV3Error) throw error;
		throw new GraphV3Error("INITIALIZATION_FAILED", `Failed to initialize V3 run at ${runDir}: ${error instanceof Error ? error.message : String(error)}`, { details: { runDir }, cause: error });
	} finally {
		if (heldLock) await releaseInitializationLock(heldLock).catch(() => undefined);
	}
}
