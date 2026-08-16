import { readFile, rm } from "node:fs/promises";
import { atomicWriteJson } from "./durable.ts";
import { isProcessAlive, processIdentityForPid } from "./claims.ts";
import { graphV3Error } from "./errors.ts";
import type { V3RunLease } from "./types.ts";
import { V3_LEASE_SCHEMA_VERSION } from "./types.ts";

const LEASE_FIELDS = new Set([
	"schemaVersion", "runInstanceId", "pid", "processIdentity", "processStartedAt", "token", "acquiredAt", "heartbeatAt",
]);

export interface V3LeaseHandle {
	lease: V3RunLease;
	refresh(): Promise<void>;
	release(): Promise<void>;
}

export interface AcquireV3RunLeaseOptions {
	token?: string;
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
	const token = options.token ?? `${process.pid}-${runInstanceId}-${Date.now()}`;
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
	while (true) {
		const existing = await readV3RunLease(leasePath);
		if (existing) {
			if (existing.runInstanceId === runInstanceId && existing.token === token) {
				await writeV3RunLease(leasePath, existing);
				return handleFor(existing, leasePath);
			}
			const takeover = await canTakeoverLease(existing);
			if (!takeover) {
				graphV3Error("RUN_NEEDS_ATTENTION", `V3 run '${runInstanceId}' is already supervised by a live lease holder.`);
			}
		}
		try {
			await writeV3RunLease(leasePath, candidate);
		} catch {
			continue;
		}
		const confirmed = await readV3RunLease(leasePath);
		if (confirmed && confirmed.token === candidate.token && confirmed.runInstanceId === runInstanceId) {
			return handleFor(confirmed, leasePath);
		}
	}
}

async function canTakeoverLease(lease: V3RunLease): Promise<boolean> {
	if (lease.pid === process.pid) return lease.token === undefined ? false : true;
	if (!isProcessAlive(lease.pid)) return true;
	const identity = await processIdentityForPid(lease.pid);
	if (!identity) return false;
	// PID reuse or a different process holding the lease → takeover after verification.
	return identity !== lease.processIdentity;
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

function handleFor(lease: V3RunLease, leasePath: string): V3LeaseHandle {
	let current = lease;
	const refresh = async () => {
		const existing = await readV3RunLease(leasePath).catch(() => undefined);
		if (existing && existing.token !== current.token) return;
		current = { ...current, heartbeatAt: new Date().toISOString() };
		await writeV3RunLease(leasePath, current);
	};
	const release = async () => {
		const existing = await readV3RunLease(leasePath).catch(() => undefined);
		if (existing && existing.token === current.token) await rm(leasePath, { force: true });
	};
	return { lease: current, refresh, release };
}
