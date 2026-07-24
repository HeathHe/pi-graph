import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STALE_TEMPORARY_MS = 5 * 60_000;
const SCOPED_CLAIM = /^(k-[a-f0-9]{16})\./;
let currentProcessIdentity: Promise<string | undefined> | undefined;

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function psProcessIdentity(pid: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 1_000 }, (error, stdout) => {
			if (error) {
				resolve(undefined);
				return;
			}
			const value = stdout.trim().replace(/\s+/g, " ");
			resolve(value ? `ps:${value}` : undefined);
		});
	});
}

export async function processIdentityForPid(pid: number): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return undefined;
	if (pid === process.pid && currentProcessIdentity) return currentProcessIdentity;
	const resolveIdentity = async () => {
		if (process.platform === "linux") {
			try {
				const stat = await readFile(`/proc/${pid}/stat`, "utf8");
				const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
				const startedAtTick = fields[19];
				if (startedAtTick && /^[0-9]+$/.test(startedAtTick)) return `linux:${startedAtTick}`;
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

async function requireCurrentProcessIdentity(): Promise<string> {
	const identity = await processIdentityForPid(process.pid);
	if (!identity) throw new Error("The current process start identity is unavailable; refusing to create PID-only ownership metadata.");
	return identity;
}

export interface Claim<T> {
	pid: number;
	token: string;
	startedNs: string;
	ownerIdentity?: string;
	state: "pending" | "held";
	payload: T;
}

export interface CreatedClaim<T> {
	claim: Claim<T>;
	path: string;
}

export interface ClaimInspection {
	name: string;
	path: string;
	status: "live" | "stale" | "malformed";
	reason: string;
}

interface DetailedClaimInspection<T> extends ClaimInspection {
	claim?: Claim<T>;
}

function validateClaim<T>(value: unknown, path: string): Claim<T> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid claim file: ${path}`);
	const claim = value as Partial<Claim<T>>;
	if (!Number.isInteger(claim.pid) || (claim.pid ?? 0) <= 0 || typeof claim.token !== "string" || typeof claim.startedNs !== "string" || !/^[0-9]+$/.test(claim.startedNs) || !["pending", "held"].includes(claim.state ?? "")) {
		throw new Error(`Invalid claim file: ${path}`);
	}
	if (claim.ownerIdentity !== undefined && (typeof claim.ownerIdentity !== "string" || claim.ownerIdentity.length < 1 || claim.ownerIdentity.length > 256)) {
		throw new Error(`Invalid claim owner identity: ${path}`);
	}
	return claim as Claim<T>;
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function createClaim<T>(directory: string, payload: T, options: { scope?: string } = {}): Promise<CreatedClaim<T>> {
	await mkdir(directory, { recursive: true });
	const token = randomUUID();
	const ownerIdentity = await requireCurrentProcessIdentity();
	const claim: Claim<T> = {
		pid: process.pid,
		token,
		startedNs: process.hrtime.bigint().toString(),
		ownerIdentity,
		state: "pending",
		payload,
	};
	const prefix = options.scope ? `${options.scope}.` : "";
	const path = join(directory, `${prefix}${process.pid}-${token}.json`);
	await atomicWrite(path, claim);
	return { claim, path };
}

async function removeInvalidClaim(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.isDirectory() && !info.isSymbolicLink()) await rm(path, { recursive: true });
		else await rm(path, { force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function inspectClaimEntries<T>(directory: string, options: { scope?: string } = {}): Promise<Array<DetailedClaimInspection<T>>> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const output: Array<DetailedClaimInspection<T>> = [];
	const identities = new Map<number, Promise<string | undefined>>();
	for (const name of names) {
		const path = join(directory, name);
		if (name.endsWith(".tmp")) {
			const owner = /\.([1-9][0-9]*)\.[A-Za-z0-9-]+\.tmp$/.exec(name);
			const info = await lstat(path).catch(() => undefined);
			if (!info) continue;
			if (info.isSymbolicLink() || !info.isFile()) {
				output.push({ name, path, status: "malformed", reason: "temporary claim is not a regular file" });
			} else if (!owner) {
				output.push({ name, path, status: "malformed", reason: "temporary claim filename has no owner PID" });
			} else if (!isProcessAlive(Number(owner[1]))) {
				output.push({ name, path, status: "stale", reason: "temporary claim owner is no longer running" });
			} else if (Date.now() - info.mtimeMs >= STALE_TEMPORARY_MS) {
				output.push({ name, path, status: "stale", reason: "temporary claim exceeded its recovery window" });
			} else {
				output.push({ name, path, status: "live", reason: "claim publication is in progress" });
			}
			continue;
		}
		if (!name.endsWith(".json")) {
			output.push({ name, path, status: "malformed", reason: "claim directory contains an unknown entry" });
			continue;
		}
		if (options.scope) {
			const scoped = SCOPED_CLAIM.exec(name)?.[1];
			if (scoped && scoped !== options.scope) continue;
		}
		let claim: Claim<T>;
		try {
			claim = validateClaim<T>(JSON.parse(await readFile(path, "utf8")), path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			output.push({ name, path, status: "malformed", reason: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (!isProcessAlive(claim.pid)) {
			output.push({ name, path, status: "stale", reason: "claim owner is no longer running", claim });
			continue;
		}
		if (claim.ownerIdentity) {
			const identity = identities.get(claim.pid) ?? processIdentityForPid(claim.pid);
			identities.set(claim.pid, identity);
			const observed = await identity;
			if (observed && observed !== claim.ownerIdentity) {
				output.push({ name, path, status: "stale", reason: "claim PID belongs to a different process", claim });
				continue;
			}
		}
		output.push({ name, path, status: "live", reason: "claim owner is active", claim });
	}
	return output;
}

export async function inspectClaimsReadOnly(directory: string): Promise<ClaimInspection[]> {
	return (await inspectClaimEntries(directory)).map(({ name, path, status, reason }) => ({ name, path, status, reason }));
}

export async function liveClaims<T>(directory: string, options: { scope?: string } = {}): Promise<Array<CreatedClaim<T>>> {
	const output: Array<CreatedClaim<T>> = [];
	for (const entry of await inspectClaimEntries<T>(directory, options)) {
		if (entry.status !== "live") {
			await removeInvalidClaim(entry.path);
			continue;
		}
		if (entry.claim) output.push({ claim: entry.claim, path: entry.path });
	}
	return output;
}

export function compareClaims(left: Claim<unknown>, right: Claim<unknown>): number {
	const byTime = BigInt(left.startedNs) < BigInt(right.startedNs) ? -1 : BigInt(left.startedNs) > BigInt(right.startedNs) ? 1 : 0;
	return byTime || left.token.localeCompare(right.token);
}

export async function markClaimHeld<T>(created: CreatedClaim<T>): Promise<void> {
	created.claim.state = "held";
	await atomicWrite(created.path, created.claim);
}

export async function releaseClaim(created: CreatedClaim<unknown>): Promise<void> {
	await rm(created.path, { force: true });
}

export async function contentionWindow(): Promise<void> {
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
}

interface ExclusiveClaimOptions {
	timeoutMs?: number;
	busyMessage?: string;
}

function scopeForKey(key: string): string {
	return `k-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

async function withSelectedClaims<TPayload, TResult>(
	directory: string,
	payload: TPayload,
	selectClaims: (claims: Array<CreatedClaim<TPayload>>) => Array<CreatedClaim<TPayload>>,
	action: () => Promise<TResult>,
	options: ExclusiveClaimOptions,
	scope?: string,
): Promise<TResult> {
	const deadline = Date.now() + (options.timeoutMs ?? 5_000);
	while (true) {
		const created = await createClaim(directory, payload, { scope });
		try {
			await contentionWindow();
			const claims = selectClaims(await liveClaims<TPayload>(directory, { scope }));
			const held = claims.find((entry) => entry.claim.token !== created.claim.token && entry.claim.state === "held");
			const winner = claims
				.filter((entry) => entry.claim.state === "pending")
				.sort((left, right) => compareClaims(left.claim, right.claim))[0];
			if (!held && winner?.claim.token === created.claim.token) {
				await markClaimHeld(created);
				const competing = selectClaims(await liveClaims<TPayload>(directory, { scope }))
					.find((entry) => entry.claim.token !== created.claim.token && entry.claim.state === "held");
				if (!competing) return await action();
			}
		} finally {
			await releaseClaim(created);
		}
		if (Date.now() >= deadline) throw new Error(options.busyMessage ?? "Claim lock is busy.");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export async function withExclusiveClaim<TPayload, TResult>(
	directory: string,
	payload: TPayload,
	action: () => Promise<TResult>,
	options: ExclusiveClaimOptions = {},
): Promise<TResult> {
	return withSelectedClaims(directory, payload, (claims) => claims, action, options);
}

export async function withExclusiveKeyedClaim<TPayload, TResult>(
	directory: string,
	payload: TPayload,
	key: string,
	keyOf: (payload: TPayload) => string | undefined,
	action: () => Promise<TResult>,
	options: ExclusiveClaimOptions = {},
): Promise<TResult> {
	return withSelectedClaims(directory, payload, (claims) => claims.filter((entry) => {
		try {
			const candidateKey = keyOf(entry.claim.payload);
			return candidateKey === undefined || candidateKey === key;
		} catch {
			return true;
		}
	}), action, options, scopeForKey(key));
}
