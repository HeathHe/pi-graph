import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteJson, syncDirectory } from "./durable.ts";
import { isProcessAlive, processIdentityForPid } from "./claims.ts";
import { graphV3Error } from "./errors.ts";
import type { V3RunLease } from "./types.ts";
import { V3_LEASE_SCHEMA_VERSION } from "./types.ts";

const LEASE_FIELDS = new Set([
	"schemaVersion", "runInstanceId", "pid", "processIdentity", "processStartedAt", "token", "acquiredAt", "heartbeatAt",
]);

export interface V3LeaseHandle {
	lease: V3RunLease;
	/** Durable, monotonically increasing Supervisor fencing generation. */
	generation: number;
	/** Fail closed unless this exact capability is still the published Supervisor. */
	assertCurrent(): Promise<void>;
	/** Serialize an authoritative mutation with lease acquisition/takeover. */
	withFence<T>(mutation: () => Promise<T>): Promise<T>;
	refresh(): Promise<void>;
	release(): Promise<void>;
}

export interface AcquireV3RunLeaseOptions {
	token?: string;
}

export const V3_LEASE_GENERATION_LEDGER_SCHEMA_VERSION = 1 as const;
export type V3LeaseGenerationState = "reserved" | "active" | "released";

/**
 * Persistent fencing authority kept after lease.json is released. A generation
 * is never reused, including when publication was interrupted while reserved.
 */
export interface V3LeaseGenerationLedger {
	schemaVersion: typeof V3_LEASE_GENERATION_LEDGER_SCHEMA_VERSION;
	runInstanceId: string;
	generation: number;
	state: V3LeaseGenerationState;
	tokenDigest: string;
	previousTokenDigest: string | null;
	pid: number;
	processIdentity: string;
	updatedAt: string;
}

const LEDGER_FIELDS = new Set([
	"schemaVersion", "runInstanceId", "generation", "state", "tokenDigest", "previousTokenDigest", "pid", "processIdentity", "updatedAt",
]);
const LEDGER_STATES = new Set<V3LeaseGenerationState>(["reserved", "active", "released"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface LeaseGateOwner {
	schemaVersion: 1;
	pid: number;
	processIdentity: string;
	token: string;
	createdAt: string;
}

const GATE_OWNER_FILE = "owner.json";
const GATE_OWNERLESS_GRACE_MS = 5_000;
const GATE_WAIT_TIMEOUT_MS = 30_000;
const GATE_POLL_MS = 10;

export function v3LeaseGenerationLedgerPath(leasePath: string): string {
	return join(dirname(leasePath), "supervisor-fence.json");
}

function tokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function validateV3LeaseGenerationLedger(value: unknown): V3LeaseGenerationLedger {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger must be an object.");
	}
	const record = value as Record<string, unknown>;
	for (const field of Object.keys(record)) {
		if (!LEDGER_FIELDS.has(field)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 Supervisor generation ledger contains unknown field '${field}'.`, { field });
	}
	if (record.schemaVersion !== V3_LEASE_GENERATION_LEDGER_SCHEMA_VERSION) {
		graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger requires schemaVersion 1.", { field: "schemaVersion" });
	}
	if (typeof record.runInstanceId !== "string" || !record.runInstanceId) graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger requires runInstanceId.", { field: "runInstanceId" });
	if (typeof record.generation !== "number" || !Number.isSafeInteger(record.generation) || record.generation < 1) {
		graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger requires a positive safe generation.", { field: "generation" });
	}
	if (typeof record.state !== "string" || !LEDGER_STATES.has(record.state as V3LeaseGenerationState)) {
		graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger state is invalid.", { field: "state" });
	}
	if (typeof record.tokenDigest !== "string" || !SHA256_PATTERN.test(record.tokenDigest)) graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger tokenDigest is invalid.", { field: "tokenDigest" });
	if (record.previousTokenDigest !== null && (typeof record.previousTokenDigest !== "string" || !SHA256_PATTERN.test(record.previousTokenDigest))) {
		graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger previousTokenDigest is invalid.", { field: "previousTokenDigest" });
	}
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger requires a positive pid.", { field: "pid" });
	if (typeof record.processIdentity !== "string" || !record.processIdentity) graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger requires processIdentity.", { field: "processIdentity" });
	if (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger updatedAt must be an ISO timestamp.", { field: "updatedAt" });
	return record as unknown as V3LeaseGenerationLedger;
}

/** Read the durable fence ledger without following symlinks or accepting a racy replacement. */
export async function readV3LeaseGenerationLedger(leasePath: string): Promise<V3LeaseGenerationLedger | undefined> {
	const path = v3LeaseGenerationLedgerPath(leasePath);
	let before;
	try {
		before = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger must be a single regular file.");
	const bytes = await readFile(path);
	const after = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger disappeared while it was read.");
		throw error;
	});
	if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
		|| after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
		|| after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
		graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger changed while it was read.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8")) as unknown;
	} catch (error) {
		graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger is not valid JSON.", { cause: error });
	}
	return validateV3LeaseGenerationLedger(parsed);
}

async function writeV3LeaseGenerationLedger(leasePath: string, ledger: V3LeaseGenerationLedger): Promise<void> {
	validateV3LeaseGenerationLedger(ledger);
	await atomicWriteJson(v3LeaseGenerationLedgerPath(leasePath), ledger);
}

function assertLedgerRun(ledger: V3LeaseGenerationLedger, runInstanceId: string): void {
	if (ledger.runInstanceId !== runInstanceId) {
		graphV3Error("RUN_NEEDS_ATTENTION", `V3 Supervisor generation ledger belongs to run '${ledger.runInstanceId}', not '${runInstanceId}'.`);
	}
}

function nextGeneration(ledger: V3LeaseGenerationLedger | undefined): number {
	if (!ledger) return 1;
	if (ledger.generation === Number.MAX_SAFE_INTEGER) graphV3Error("RUN_NEEDS_ATTENTION", "V3 Supervisor generation ledger is exhausted.");
	return ledger.generation + 1;
}

/**
 * Acquire the run supervisor lease for `runInstanceId`.
 *
 * Takeover of an existing lease is allowed only after PID + process-identity
 * verification: the recorded process is dead, or the recorded pid now maps to a
 * different process identity (PID reuse). A live original holder is never taken
 * over and surfaces as needs_attention.
 */
export async function acquireV3RunLease(
	leasePath: string,
	runInstanceId: string,
	options: AcquireV3RunLeaseOptions = {},
): Promise<V3LeaseHandle> {
	const currentIdentity = await processIdentityForPid(process.pid);
	if (!currentIdentity) throw new Error("V3 run lease requires a resolvable current process identity.");
	const now = new Date().toISOString();
	const token = options.token ?? `${process.pid}-${runInstanceId}-${randomUUID()}`;
	const candidate: V3RunLease = {
		schemaVersion: V3_LEASE_SCHEMA_VERSION,
		runInstanceId,
		pid: process.pid,
		processIdentity: currentIdentity,
		processStartedAt: Date.now(),
		token,
		acquiredAt: now,
		heartbeatAt: now,
	};
	return withLeaseGate(leasePath, async () => {
		const existing = await readV3RunLease(leasePath);
		const ledger = await readV3LeaseGenerationLedger(leasePath);
		if (ledger) assertLedgerRun(ledger, runInstanceId);
		if (existing) {
			const existingDigest = tokenDigest(existing.token);
			if (!ledger) {
				if (existing.runInstanceId === runInstanceId && existing.token === token) {
					const initialized: V3LeaseGenerationLedger = {
						schemaVersion: V3_LEASE_GENERATION_LEDGER_SCHEMA_VERSION,
						runInstanceId,
						generation: 1,
						state: "active",
						tokenDigest: existingDigest,
						previousTokenDigest: null,
						pid: existing.pid,
						processIdentity: existing.processIdentity,
						updatedAt: now,
					};
					await writeV3LeaseGenerationLedger(leasePath, initialized);
					return handleFor(existing, leasePath, initialized.generation);
				}
				if (!await canTakeoverLease(existing)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${runInstanceId}' is already supervised by a live lease holder.`);
			} else if (ledger.state === "active") {
				if (existing.runInstanceId !== runInstanceId || ledger.tokenDigest !== existingDigest) {
					graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${runInstanceId}' lease and active Supervisor generation ledger disagree; refusing takeover.`);
				}
				if (existing.token === token) return handleFor(existing, leasePath, ledger.generation);
				if (!await canTakeoverLease(existing)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${runInstanceId}' is already supervised by a live lease holder.`);
			} else if (ledger.state === "reserved") {
				if (existing.runInstanceId !== runInstanceId || (existingDigest !== ledger.tokenDigest && existingDigest !== ledger.previousTokenDigest)) {
					graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${runInstanceId}' lease does not match the interrupted Supervisor generation reservation.`);
				}
				if (existing.token === token && existingDigest === ledger.tokenDigest) {
					const activated = { ...ledger, state: "active" as const, updatedAt: now };
					await writeV3LeaseGenerationLedger(leasePath, activated);
					return handleFor(existing, leasePath, activated.generation);
				}
				// The gate is ours, so a reservation's publisher is no longer in its
				// critical section. Burn that generation and replace either residual.
			} else {
				if (existing.runInstanceId !== runInstanceId || existingDigest !== ledger.tokenDigest) {
					graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${runInstanceId}' released lease residue does not match its Supervisor generation ledger.`);
				}
				// The released ledger has already fenced the old handle durably. Once
				// this gate is acquired, a leftover lease is only cleanup residue.
			}
		}
		if (!existing && ledger?.state === "active" && !await canTakeoverLedgerOwner(ledger)) {
			graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${runInstanceId}' lease is missing but its active Supervisor generation is still live.`);
		}
		const generation = nextGeneration(ledger);
		const reserved: V3LeaseGenerationLedger = {
			schemaVersion: V3_LEASE_GENERATION_LEDGER_SCHEMA_VERSION,
			runInstanceId,
			generation,
			state: "reserved",
			tokenDigest: tokenDigest(token),
			previousTokenDigest: ledger?.tokenDigest ?? null,
			pid: process.pid,
			processIdentity: currentIdentity,
			updatedAt: now,
		};
		// Reserve the generation first. If lease publication is interrupted, the
		// next acquirer must skip this generation rather than ever reusing it.
		await writeV3LeaseGenerationLedger(leasePath, reserved);
		await writeV3RunLease(leasePath, candidate);
		const activated: V3LeaseGenerationLedger = { ...reserved, state: "active", updatedAt: new Date().toISOString() };
		await writeV3LeaseGenerationLedger(leasePath, activated);
		const [confirmed, confirmedLedger] = await Promise.all([
			readV3RunLease(leasePath),
			readV3LeaseGenerationLedger(leasePath),
		]);
		if (confirmed && confirmed.token === candidate.token && confirmed.runInstanceId === runInstanceId
			&& confirmedLedger?.generation === generation && confirmedLedger.state === "active"
			&& confirmedLedger.tokenDigest === reserved.tokenDigest) {
			return handleFor(confirmed, leasePath, generation);
		}
		graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${runInstanceId}' could not confirm its Supervisor lease.`);
	});
}

async function canTakeoverLease(lease: V3RunLease): Promise<boolean> {
	// A second Runner in the same live process is still a competing Supervisor.
	// It must never replace the first Runner's capability merely because the PID
	// happens to be equal.
	if (lease.pid === process.pid) return false;
	if (!isProcessAlive(lease.pid)) return true;
	const identity = await processIdentityForPid(lease.pid);
	if (!identity) return false;
	// PID reuse or a different process holding the lease → takeover after verification.
	return identity !== lease.processIdentity;
}

async function canTakeoverLedgerOwner(ledger: V3LeaseGenerationLedger): Promise<boolean> {
	if (ledger.pid === process.pid) return false;
	if (!isProcessAlive(ledger.pid)) return true;
	const identity = await processIdentityForPid(ledger.pid);
	return identity !== undefined && identity !== ledger.processIdentity;
}

export function validateV3RunLease(value: unknown): V3RunLease {
	if (typeof value !== "object" || value === null || Array.isArray(value)) graphV3Error("RUN_NEEDS_ATTENTION", "V3 run lease must be an object.");
	const record = value as Record<string, unknown>;
	for (const field of Object.keys(record)) {
		if (!LEASE_FIELDS.has(field)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 run lease contains unknown field '${field}'.`, { field });
	}
	if (record.schemaVersion !== V3_LEASE_SCHEMA_VERSION) graphV3Error("RUN_NEEDS_ATTENTION", "V3 run lease requires schemaVersion 1.", { field: "schemaVersion" });
	if (typeof record.runInstanceId !== "string" || !record.runInstanceId) graphV3Error("RUN_NEEDS_ATTENTION", "V3 run lease requires runInstanceId.", { field: "runInstanceId" });
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) graphV3Error("RUN_NEEDS_ATTENTION", "V3 run lease requires a positive pid.", { field: "pid" });
	if (typeof record.processIdentity !== "string" || !record.processIdentity) graphV3Error("RUN_NEEDS_ATTENTION", "V3 run lease requires processIdentity.", { field: "processIdentity" });
	if (typeof record.token !== "string" || !record.token) graphV3Error("RUN_NEEDS_ATTENTION", "V3 run lease requires a token.", { field: "token" });
	for (const field of ["acquiredAt", "heartbeatAt"]) {
		if (typeof record[field] !== "string" || Number.isNaN(Date.parse(record[field] as string))) graphV3Error("RUN_NEEDS_ATTENTION", `V3 run lease '${field}' must be an ISO timestamp.`, { field });
	}
	return record as unknown as V3RunLease;
}

export async function readV3RunLease(leasePath: string): Promise<V3RunLease | undefined> {
	try {
		return validateV3RunLease(JSON.parse(await readFile(leasePath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function writeV3RunLease(leasePath: string, lease: V3RunLease): Promise<void> {
	await atomicWriteJson(leasePath, lease);
}

function handleFor(lease: V3RunLease, leasePath: string, generation: number): V3LeaseHandle {
	let current = lease;
	const assertPublished = async () => {
		const [existing, ledger] = await Promise.all([
			readV3RunLease(leasePath),
			readV3LeaseGenerationLedger(leasePath),
		]);
		if (!existing || existing.runInstanceId !== current.runInstanceId || existing.token !== current.token
			|| !ledger || ledger.runInstanceId !== current.runInstanceId || ledger.generation !== generation
			|| ledger.state !== "active" || ledger.tokenDigest !== tokenDigest(current.token)) {
			graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${current.runInstanceId}' Supervisor fence is no longer current.`);
		}
	};
	const assertCurrent = () => withLeaseGate(leasePath, assertPublished);
	const withFence = <T>(mutation: () => Promise<T>) => withLeaseGate(leasePath, async () => {
		await assertPublished();
		return mutation();
	});
	const refresh = async () => {
		await withLeaseGate(leasePath, async () => {
			await assertPublished();
			current = { ...current, heartbeatAt: new Date().toISOString() };
			await writeV3RunLease(leasePath, current);
		});
	};
	const release = async () => {
		await withLeaseGate(leasePath, async () => {
			const ledger = await readV3LeaseGenerationLedger(leasePath);
			if (!ledger || ledger.runInstanceId !== current.runInstanceId || ledger.generation !== generation || ledger.tokenDigest !== tokenDigest(current.token)) return;
			if (ledger.state === "released") {
				const residue = await readV3RunLease(leasePath);
				if (!residue) return;
				if (residue.token !== current.token || residue.runInstanceId !== current.runInstanceId) {
					graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${current.runInstanceId}' released Supervisor found a different live lease.`);
				}
				await rm(leasePath, { force: true });
				await syncDirectory(dirname(leasePath));
				return;
			}
			if (ledger.state !== "active") graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${current.runInstanceId}' cannot release an incomplete Supervisor generation.`);
			const existing = await readV3RunLease(leasePath);
			if (existing && (existing.token !== current.token || existing.runInstanceId !== current.runInstanceId)) {
				graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${current.runInstanceId}' lease changed before its Supervisor generation could be released.`);
			}
			const released: V3LeaseGenerationLedger = {
				...ledger,
				state: "released",
				updatedAt: new Date().toISOString(),
			};
			// Fence the capability durably before removing the ephemeral lease.
			await writeV3LeaseGenerationLedger(leasePath, released);
			if (existing) {
				await rm(leasePath, { force: true });
				await syncDirectory(dirname(leasePath));
			}
		});
	};
	return { lease: current, generation, assertCurrent, withFence, refresh, release };
}

async function withLeaseGate<T>(leasePath: string, action: () => Promise<T>): Promise<T> {
	const gateDir = `${leasePath}.gate`;
	const processIdentity = await processIdentityForPid(process.pid);
	if (!processIdentity) graphV3Error("RUN_NEEDS_ATTENTION", "V3 lease gate requires a resolvable current process identity.");
	const owner: LeaseGateOwner = {
		schemaVersion: 1,
		pid: process.pid,
		processIdentity,
		token: randomUUID(),
		createdAt: new Date().toISOString(),
	};
	const deadline = Date.now() + GATE_WAIT_TIMEOUT_MS;
	await mkdir(dirname(leasePath), { recursive: true });
	while (true) {
		try {
			await mkdir(gateDir, { mode: 0o700 });
			try {
				await atomicWriteJson(join(gateDir, GATE_OWNER_FILE), owner);
			} catch (error) {
				await rm(gateDir, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (await recoverStaleGate(gateDir)) continue;
			if (Date.now() >= deadline) graphV3Error("RUN_NEEDS_ATTENTION", `Timed out waiting for V3 lease mutation gate '${gateDir}'.`);
			await delay(GATE_POLL_MS);
		}
	}
	try {
		return await action();
	} finally {
		await releaseGate(gateDir, owner.token);
	}
}

async function recoverStaleGate(gateDir: string): Promise<boolean> {
	const info = await lstat(gateDir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!info) return true;
	if (info.isSymbolicLink() || !info.isDirectory()) {
		graphV3Error("RUN_NEEDS_ATTENTION", `V3 lease mutation gate '${gateDir}' is not a safe directory.`);
	}
	let owner: LeaseGateOwner | undefined;
	try {
		const raw = JSON.parse(await readFile(join(gateDir, GATE_OWNER_FILE), "utf8")) as Partial<LeaseGateOwner>;
		if (raw.schemaVersion === 1 && Number.isInteger(raw.pid) && typeof raw.processIdentity === "string" && typeof raw.token === "string") {
			owner = raw as LeaseGateOwner;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
	}
	if (owner) {
		const observedIdentity = await processIdentityForPid(owner.pid);
		if (observedIdentity === owner.processIdentity) return false;
	} else if (Date.now() - info.mtimeMs < GATE_OWNERLESS_GRACE_MS) {
		return false;
	}
	const quarantine = `${gateDir}.stale-${randomUUID()}`;
	try {
		await rename(gateDir, quarantine);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
	await rm(quarantine, { recursive: true, force: true });
	return true;
}

async function releaseGate(gateDir: string, token: string): Promise<void> {
	try {
		const owner = JSON.parse(await readFile(join(gateDir, GATE_OWNER_FILE), "utf8")) as Partial<LeaseGateOwner>;
		if (owner.token !== token) return;
	} catch {
		return;
	}
	const cleanup = `${gateDir}.release-${randomUUID()}`;
	try {
		await rename(gateDir, cleanup);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await rm(cleanup, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
