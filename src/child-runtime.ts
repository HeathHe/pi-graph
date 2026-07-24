import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "./durable.ts";
import { recoverRunBySessionDir, RpcRejectedError, SubagentRpcClient } from "./rpc.ts";
import { requestAsyncStop } from "./lifecycle.ts";

export interface ChildLineage {
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	sessionDir: string;
	ownerSessionId?: string;
}

interface DispatchLedger {
	schemaVersion: 1;
	dispatchKey: string;
	requestId: string;
	requestDigest: string;
	lineage: ChildLineage;
	phase: "prepared" | "emitting" | "bound" | "abandoned";
	asyncId?: string;
	asyncDir?: string;
	createdAt: string;
	updatedAt: string;
}

interface DispatchTombstone {
	schemaVersion: 1;
	dispatchKey: string;
	requestDigest: string;
	lineage: ChildLineage;
	abandonedAt: string;
	reason: string;
}

interface DispatchResult {
	asyncId: string;
	asyncDir: string;
	dispatchKey: string;
	requestDigest: string;
}

export class ChildDispatchUnknownError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChildDispatchUnknownError";
	}
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function paths(lineage: ChildLineage) {
	const attemptDir = dirname(lineage.sessionDir);
	return {
		ledger: join(attemptDir, "child-dispatch.json"),
		tombstone: join(attemptDir, "child-tombstone.json"),
	};
}

function validLedger(value: unknown, lineage: ChildLineage, requestDigest: string): DispatchLedger {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ChildRuntime dispatch ledger.");
	const ledger = value as Partial<DispatchLedger>;
	const expectedKey = digest({ lineage, requestDigest });
	if (
		ledger.schemaVersion !== 1
		|| ledger.dispatchKey !== expectedKey
		|| ledger.requestId !== `pi-graph-v2-${expectedKey.slice(0, 40)}`
		|| !/^[a-f0-9]{64}$/i.test(requestDigest)
		|| ledger.requestDigest !== requestDigest
		|| JSON.stringify(ledger.lineage) !== JSON.stringify(lineage)
		|| !["prepared", "emitting", "bound", "abandoned"].includes(ledger.phase ?? "")
		|| !validIsoTimestamp(ledger.createdAt)
		|| !validIsoTimestamp(ledger.updatedAt)
		|| Date.parse(ledger.updatedAt) < Date.parse(ledger.createdAt)
		|| (ledger.phase === "bound" && (typeof ledger.asyncId !== "string" || typeof ledger.asyncDir !== "string"))
	) {
		throw new Error("ChildRuntime dispatch ledger does not match the authorized request.");
	}
	return ledger as DispatchLedger;
}

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export class ChildRuntime {
	private static readonly inFlight = new Map<string, Promise<DispatchResult>>();
	private static readonly reapers = new Map<string, NodeJS.Timeout>();
	private readonly rpc: SubagentRpcClient;
	private readonly reaperDelayMs: number;
	private readonly reaperMaxAgeMs: number;
	private readonly abandonPolls: number;
	private readonly abandonPollMs: number;

	constructor(rpc: SubagentRpcClient, reaperDelayMs = 2_000, reaperMaxAgeMs = 24 * 60 * 60_000, abandonPolls = 20, abandonPollMs = 250) {
		this.rpc = rpc;
		this.reaperDelayMs = reaperDelayMs;
		this.reaperMaxAgeMs = reaperMaxAgeMs;
		this.abandonPolls = abandonPolls;
		this.abandonPollMs = abandonPollMs;
	}

	private identity(lineage: ChildLineage, requestDigest: string) {
		const dispatchKey = digest({ lineage, requestDigest });
		return { dispatchKey, requestId: `pi-graph-v2-${dispatchKey.slice(0, 40)}` };
	}

	async lookup(lineage: ChildLineage): Promise<{ asyncId: string; asyncDir: string } | null> {
		return recoverRunBySessionDir(lineage.sessionDir, undefined, lineage.ownerSessionId);
	}

	async dispatch(
		lineage: ChildLineage,
		params: Record<string, unknown>,
	): Promise<DispatchResult> {
		const requestDigest = digest(params);
		const { dispatchKey, requestId } = this.identity(lineage, requestDigest);
		const target = paths(lineage);
		const pending = ChildRuntime.inFlight.get(target.ledger);
		if (pending) return pending.then((result) => {
			if (result.dispatchKey !== dispatchKey || result.requestDigest !== requestDigest) throw new Error("Concurrent ChildRuntime dispatch does not match the authorized request.");
			return result;
		});
		const operation = this.dispatchOnce(lineage, params, requestDigest, dispatchKey, requestId, target);
		ChildRuntime.inFlight.set(target.ledger, operation);
		try {
			return await operation;
		} finally {
			if (ChildRuntime.inFlight.get(target.ledger) === operation) ChildRuntime.inFlight.delete(target.ledger);
		}
	}

	private async dispatchOnce(
		lineage: ChildLineage,
		params: Record<string, unknown>,
		requestDigest: string,
		dispatchKey: string,
		requestId: string,
		target: ReturnType<typeof paths>,
	): Promise<DispatchResult> {
		if (await readJson(target.tombstone)) throw new Error("Child dispatch was abandoned and cannot be emitted.");
		const raw = await readJson(target.ledger);
		let ledger = raw ? validLedger(raw, lineage, requestDigest) : undefined;
		if (ledger?.phase === "bound") {
			const found = await this.lookup(lineage);
			if (!found || found.asyncId !== ledger.asyncId || found.asyncDir !== ledger.asyncDir) throw new ChildDispatchUnknownError("Bound ChildRuntime identity no longer matches pi-subagents status.");
			return { ...found, dispatchKey, requestDigest };
		}
		const recovered = await this.lookup(lineage);
		if (recovered) {
			const now = new Date().toISOString();
			ledger = ledger ?? { schemaVersion: 1, dispatchKey, requestId, requestDigest, lineage, phase: "prepared", createdAt: now, updatedAt: now };
			Object.assign(ledger, recovered, { phase: "bound", updatedAt: now });
			await atomicWriteJson(target.ledger, ledger);
			return { ...recovered, dispatchKey, requestDigest };
		}
		if (ledger?.phase === "emitting" || ledger?.phase === "abandoned") {
			throw new ChildDispatchUnknownError("Durable ChildRuntime request has already crossed its emit boundary; lookup found no unique Child and the request will not be re-emitted.");
		}
		const now = new Date().toISOString();
		ledger = ledger ?? { schemaVersion: 1, dispatchKey, requestId, requestDigest, lineage, phase: "prepared", createdAt: now, updatedAt: now };
		await atomicWriteJson(target.ledger, ledger);
		ledger.phase = "emitting";
		ledger.updatedAt = new Date().toISOString();
		await atomicWriteJson(target.ledger, ledger);
		let child;
		try {
			child = await this.rpc.spawn(params, requestId);
		} catch (error) {
			const late = await this.lookup(lineage);
			if (!late && error instanceof RpcRejectedError) throw error;
			if (!late) throw new ChildDispatchUnknownError(`Child dispatch outcome is unknown after its durable emit boundary: ${error instanceof Error ? error.message : String(error)}`);
			child = late;
		}
		if (await readJson(target.tombstone)) {
			await requestAsyncStop(child.asyncDir);
			throw new Error("Child appeared after dispatch abandonment and was stopped.");
		}
		Object.assign(ledger, child, { phase: "bound", updatedAt: new Date().toISOString() });
		await atomicWriteJson(target.ledger, ledger);
		return { ...child, dispatchKey, requestDigest };
	}

	async abandon(lineage: ChildLineage, params: Record<string, unknown>, reason: string): Promise<{ stopped: boolean; identity?: { asyncId: string; asyncDir: string } }> {
		const requestDigest = digest(params);
		return this.abandonWithDigest(lineage, requestDigest, reason);
	}

	async abandonKnown(lineage: ChildLineage, reason: string): Promise<{ stopped: boolean; identity?: { asyncId: string; asyncDir: string } } | null> {
		const target = paths(lineage);
		const raw = await readJson(target.ledger);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const requestDigest = (raw as { requestDigest?: unknown }).requestDigest;
		if (typeof requestDigest !== "string") throw new Error("ChildRuntime dispatch ledger is missing its request digest.");
		validLedger(raw, lineage, requestDigest);
		return this.abandonWithDigest(lineage, requestDigest, reason);
	}

	private async abandonWithDigest(lineage: ChildLineage, requestDigest: string, reason: string): Promise<{ stopped: boolean; identity?: { asyncId: string; asyncDir: string } }> {
		if (!reason.trim()) throw new Error("ChildRuntime abandonment reason is required.");
		const { dispatchKey, requestId } = this.identity(lineage, requestDigest);
		const target = paths(lineage);
		const tombstone: DispatchTombstone = { schemaVersion: 1, dispatchKey, requestDigest, lineage, abandonedAt: new Date().toISOString(), reason };
		await atomicWriteJson(target.tombstone, tombstone);
		const raw = await readJson(target.ledger);
		const ledger = raw ? validLedger(raw, lineage, requestDigest) : {
			schemaVersion: 1 as const,
			dispatchKey,
			requestId,
			requestDigest,
			lineage,
			phase: "prepared" as const,
			createdAt: tombstone.abandonedAt,
			updatedAt: tombstone.abandonedAt,
		};
		ledger.phase = "abandoned";
		ledger.updatedAt = new Date().toISOString();
		await atomicWriteJson(target.ledger, ledger);
		for (let attempt = 0; attempt < this.abandonPolls; attempt += 1) {
			const identity = await this.lookup(lineage);
			if (identity) {
				await requestAsyncStop(identity.asyncDir);
				return { stopped: true, identity };
			}
			if (attempt < this.abandonPolls - 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, this.abandonPollMs));
		}
		this.scheduleTombstoneReaper(lineage);
		return { stopped: false };
	}

	async enforceTombstone(lineage: ChildLineage): Promise<{ stopped: boolean; identity?: { asyncId: string; asyncDir: string } } | null> {
		const target = paths(lineage);
		const raw = await readJson(target.tombstone);
		if (!raw) return null;
		const tombstone = raw as Partial<DispatchTombstone>;
		if (
			tombstone.schemaVersion !== 1
			|| JSON.stringify(tombstone.lineage) !== JSON.stringify(lineage)
			|| typeof tombstone.requestDigest !== "string"
			|| !/^[a-f0-9]{64}$/i.test(tombstone.requestDigest)
			|| tombstone.dispatchKey !== digest({ lineage, requestDigest: tombstone.requestDigest })
			|| !validIsoTimestamp(tombstone.abandonedAt)
			|| typeof tombstone.reason !== "string"
			|| !tombstone.reason.trim()
		) throw new Error("ChildRuntime tombstone does not match the authorized lineage.");
		const ledger = await readJson(target.ledger);
		if (ledger) validLedger(ledger, lineage, tombstone.requestDigest);
		const identity = await this.lookup(lineage);
		if (!identity) {
			this.scheduleTombstoneReaper(lineage);
			return { stopped: false };
		}
		await requestAsyncStop(identity.asyncDir);
		return { stopped: true, identity };
	}

	private scheduleTombstoneReaper(lineage: ChildLineage): void {
		const key = paths(lineage).tombstone;
		if (ChildRuntime.reapers.has(key)) return;
		const deadline = Date.now() + this.reaperMaxAgeMs;
		const poll = async () => {
			try {
				const identity = await this.lookup(lineage);
				if (identity) {
					await requestAsyncStop(identity.asyncDir);
					ChildRuntime.reapers.delete(key);
					return;
				}
			} catch {
				// A transient status read must not cancel the durable tombstone reaper.
			}
			if (Date.now() >= deadline) {
				ChildRuntime.reapers.delete(key);
				return;
			}
			const timer = setTimeout(() => void poll(), this.reaperDelayMs);
			timer.unref();
			ChildRuntime.reapers.set(key, timer);
		};
		const timer = setTimeout(() => void poll(), this.reaperDelayMs);
		timer.unref();
		ChildRuntime.reapers.set(key, timer);
	}
}
