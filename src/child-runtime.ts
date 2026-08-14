import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson } from "./durable.ts";
import { assertAsyncRunIdentity, recoverRunBySessionDir, RpcPreEmitError, RpcRejectedError, subagentAsyncRoot, SubagentRpcClient, type EventBus } from "./rpc.ts";
import { requestAsyncStop, waitForAsyncRun, waitForConfirmedStop, type AsyncTerminal } from "./lifecycle.ts";

export interface ChildLineage {
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	sessionDir: string;
	providerDispatch?: number;
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
	outerAsyncId?: string;
	outerAsyncDir?: string;
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

export class ChildPreparePreEmitError extends Error {
	readonly cause: unknown;
	constructor(cause: unknown) {
		super(`Child dispatch preparation failed before emit: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "ChildPreparePreEmitError";
		this.cause = cause;
	}
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateOuterSpawnParams(lineage: ChildLineage, params: Record<string, unknown>): void {
	if (Object.hasOwn(params, "agent") || Object.hasOwn(params, "task")) throw new Error("ChildRuntime public workflow spawn params must not contain top-level agent/task.");
	if (typeof params.workflowScript !== "string" || !params.workflowScript.trim()) throw new Error("ChildRuntime public workflow spawn params require workflowScript.");
	if (typeof params.sessionDir !== "string" || !params.sessionDir.trim()) throw new Error("ChildRuntime public workflow spawn params require an outer sessionDir.");
	if (within(resolve(lineage.sessionDir), resolve(params.sessionDir))) throw new Error("ChildRuntime outer workflow sessionDir must be outside the authorized inner child sessionDir.");
}

function innerIdentityFromOuter(terminal: AsyncTerminal, asyncRoot = subagentAsyncRoot()): { asyncId: string; asyncDir: string } {
	if (terminal.state !== "complete") throw new Error(`Child workflow launcher ended as '${terminal.state}'.`);
	const workflow = record(terminal.status.workflow);
	if (Array.isArray(workflow?.value)) throw new Error("Child workflow launcher returned multiple child identities.");
	const child = record(workflow?.value);
	const asyncId = typeof child?.runId === "string" && child.runId.trim() ? child.runId.trim() : undefined;
	if (!asyncId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(asyncId)) throw new Error("Child workflow launcher did not return a valid inner child identity.");
	const expected = resolve(asyncRoot, asyncId);
	const artifactPaths = Array.isArray(child?.artifactPaths) ? child.artifactPaths.filter((value): value is string => typeof value === "string") : [];
	const exactDirectories = [...new Set(artifactPaths.map((path) => resolve(path)).filter((path) => path === expected))];
	if (exactDirectories.length !== 1 || !within(resolve(asyncRoot), exactDirectories[0]!)) throw new Error("Child workflow launcher did not return the exact public inner async run directory.");
	assertAsyncRunIdentity(asyncId, exactDirectories[0]!, asyncRoot);
	return { asyncId, asyncDir: exactDirectories[0]! };
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
		|| ((ledger.outerAsyncId === undefined) !== (ledger.outerAsyncDir === undefined))
		|| (ledger.outerAsyncId !== undefined && (typeof ledger.outerAsyncId !== "string" || typeof ledger.outerAsyncDir !== "string"))
		|| (ledger.phase === "prepared" && (ledger.asyncId !== undefined || ledger.asyncDir !== undefined || ledger.outerAsyncId !== undefined || ledger.outerAsyncDir !== undefined))
		|| (ledger.phase === "bound" && (typeof ledger.asyncId !== "string" || typeof ledger.asyncDir !== "string" || ledger.outerAsyncId !== undefined || ledger.outerAsyncDir !== undefined))
	) {
		throw new Error("ChildRuntime dispatch ledger does not match the authorized request.");
	}
	try {
		if (typeof ledger.asyncId === "string" && typeof ledger.asyncDir === "string") assertAsyncRunIdentity(ledger.asyncId, ledger.asyncDir);
		if (typeof ledger.outerAsyncId === "string" && typeof ledger.outerAsyncDir === "string") assertAsyncRunIdentity(ledger.outerAsyncId, ledger.outerAsyncDir);
	} catch {
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
	private static readonly reapers = new Map<string, { timer: NodeJS.Timeout; owner: symbol; generation: number }>();
	private static nextReaperGeneration = 0;
	private readonly rpc: SubagentRpcClient;
	private readonly events: EventBus;
	private readonly reaperOwner = Symbol("child-runtime-reaper-owner");
	private readonly reaperGeneration = ++ChildRuntime.nextReaperGeneration;
	private disposed = false;
	private readonly reaperDelayMs: number;
	private readonly reaperMaxAgeMs: number;
	private readonly abandonPolls: number;
	private readonly abandonPollMs: number;
	private readonly stopConfirmationMs: number;
	private readonly ownerSessionFile?: string;

	constructor(rpc: SubagentRpcClient, reaperDelayMs = 2_000, reaperMaxAgeMs = 24 * 60 * 60_000, abandonPolls = 20, abandonPollMs = 250, stopConfirmationMs = 30_000, ownerSessionFile?: string) {
		this.rpc = rpc;
		this.events = rpc.events;
		this.reaperDelayMs = reaperDelayMs;
		this.reaperMaxAgeMs = reaperMaxAgeMs;
		this.abandonPolls = abandonPolls;
		this.abandonPollMs = abandonPollMs;
		this.stopConfirmationMs = stopConfirmationMs;
		this.ownerSessionFile = ownerSessionFile;
	}

	private identity(lineage: ChildLineage, requestDigest: string) {
		const dispatchKey = digest({ lineage, requestDigest });
		return { dispatchKey, requestId: `pi-graph-v2-${dispatchKey.slice(0, 40)}` };
	}

	async lookup(lineage: ChildLineage): Promise<{ asyncId: string; asyncDir: string } | null> {
		if (!lineage.ownerSessionId) return null;
		return recoverRunBySessionDir(lineage.sessionDir, undefined, lineage.ownerSessionId, this.ownerSessionFile);
	}

	private async waitForInnerIdentity(
		lineage: ChildLineage,
		expected: { asyncId: string; asyncDir: string },
	): Promise<{ asyncId: string; asyncDir: string } | null> {
		const polls = Math.max(1, this.abandonPolls);
		let recovered: { asyncId: string; asyncDir: string } | null = null;
		for (let attempt = 0; attempt < polls; attempt += 1) {
			recovered = await this.lookup(lineage);
			if (recovered?.asyncId === expected.asyncId && recovered.asyncDir === expected.asyncDir) return recovered;
			if (attempt + 1 < polls) await new Promise((resolveDelay) => setTimeout(resolveDelay, this.abandonPollMs));
		}
		return recovered;
	}

	async hasReplayablePreparedDispatch(lineage: ChildLineage, params: Record<string, unknown>): Promise<boolean> {
		const requestDigest = digest(params);
		const target = paths(lineage);
		if (await readJson(target.tombstone)) return false;
		const raw = await readJson(target.ledger);
		return raw ? validLedger(raw, lineage, requestDigest).phase === "prepared" : false;
	}

	async dispatch(
		lineage: ChildLineage,
		authorizedParams: Record<string, unknown>,
		outerParams: Record<string, unknown>,
		onPrepared?: () => Promise<void>,
		beforeEmit?: () => void,
	): Promise<DispatchResult> {
		validateOuterSpawnParams(lineage, outerParams);
		const requestDigest = digest(authorizedParams);
		const { dispatchKey, requestId } = this.identity(lineage, requestDigest);
		const target = paths(lineage);
		const pending = ChildRuntime.inFlight.get(target.ledger);
		if (pending) return pending.then((result) => {
			if (result.dispatchKey !== dispatchKey || result.requestDigest !== requestDigest) throw new Error("Concurrent ChildRuntime dispatch does not match the authorized request.");
			return result;
		});
		const operation = this.dispatchOnce(lineage, outerParams, requestDigest, dispatchKey, requestId, target, onPrepared, beforeEmit);
		ChildRuntime.inFlight.set(target.ledger, operation);
		try {
			return await operation;
		} finally {
			if (ChildRuntime.inFlight.get(target.ledger) === operation) ChildRuntime.inFlight.delete(target.ledger);
		}
	}

	private async dispatchOnce(
		lineage: ChildLineage,
		outerParams: Record<string, unknown>,
		requestDigest: string,
		dispatchKey: string,
		requestId: string,
		target: ReturnType<typeof paths>,
		onPrepared?: () => Promise<void>,
		beforeEmit?: () => void,
	): Promise<DispatchResult> {
		if (await readJson(target.tombstone)) throw new Error("Child dispatch was abandoned and cannot be emitted.");
		const raw = await readJson(target.ledger);
		let ledger = raw ? validLedger(raw, lineage, requestDigest) : undefined;
		if (ledger?.phase === "bound") {
			const found = await this.lookup(lineage);
			if (!found || found.asyncId !== ledger.asyncId || found.asyncDir !== ledger.asyncDir) throw new ChildDispatchUnknownError("Bound ChildRuntime identity no longer matches pi-subagents status.");
			return { ...found, dispatchKey, requestDigest };
		}
		if (ledger?.outerAsyncId && ledger.outerAsyncDir) {
			return this.bindOuterLauncher(lineage, ledger, target, dispatchKey, requestDigest);
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
		try {
			await onPrepared?.();
		} catch (error) {
			throw new ChildPreparePreEmitError(error);
		}
		ledger.phase = "emitting";
		ledger.updatedAt = new Date().toISOString();
		await atomicWriteJson(target.ledger, ledger);
		let outer;
		try {
			outer = await this.rpc.spawn(outerParams, requestId, beforeEmit);
		} catch (error) {
			if (error instanceof RpcPreEmitError) {
				ledger.phase = "prepared";
				ledger.updatedAt = new Date().toISOString();
				await atomicWriteJson(target.ledger, ledger);
				throw error;
			}
			if (error instanceof RpcRejectedError) throw error;
			throw new ChildDispatchUnknownError(`Child workflow dispatch outcome is unknown after its durable emit boundary: ${error instanceof Error ? error.message : String(error)}`);
		}
		Object.assign(ledger, { outerAsyncId: outer.asyncId, outerAsyncDir: outer.asyncDir, updatedAt: new Date().toISOString() });
		await atomicWriteJson(target.ledger, ledger);
		return this.bindOuterLauncher(lineage, ledger, target, dispatchKey, requestDigest);
	}

	private async bindOuterLauncher(
		lineage: ChildLineage,
		ledger: DispatchLedger,
		target: ReturnType<typeof paths>,
		dispatchKey: string,
		requestDigest: string,
	): Promise<DispatchResult> {
		if (!ledger.outerAsyncId || !ledger.outerAsyncDir) throw new ChildDispatchUnknownError("Child workflow launcher identity is missing from the durable emitting ledger.");
		let child: { asyncId: string; asyncDir: string };
		try {
			const terminal = await waitForAsyncRun({ events: this.events, asyncId: ledger.outerAsyncId, asyncDir: ledger.outerAsyncDir });
			child = innerIdentityFromOuter(terminal);
		} catch (error) {
			throw new ChildDispatchUnknownError(`Child workflow launcher did not yield one exact authorized inner child: ${error instanceof Error ? error.message : String(error)}`);
		}
		const recovered = await this.waitForInnerIdentity(lineage, child);
		if (!recovered || recovered.asyncId !== child.asyncId || recovered.asyncDir !== child.asyncDir) {
			throw new ChildDispatchUnknownError("Child workflow launcher inner identity does not match the authorized lineage sessionDir after bounded registration polling.");
		}
		if (await readJson(target.tombstone)) {
			await requestAsyncStop(child.asyncDir);
			throw new Error("Child appeared after dispatch abandonment and was stopped.");
		}
		delete ledger.outerAsyncId;
		delete ledger.outerAsyncDir;
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

	async abandonAuthorized(lineage: ChildLineage, requestDigest: string, reason: string): Promise<{ stopped: boolean; identity?: { asyncId: string; asyncDir: string } }> {
		if (!/^[a-f0-9]{64}$/i.test(requestDigest)) throw new Error("Authorized ChildRuntime abandonment requires a valid request digest.");
		return this.abandonWithDigest(lineage, requestDigest, reason);
	}

	async abandonRecovered(lineage: ChildLineage, reason: string): Promise<{ stopped: boolean; identity?: { asyncId: string; asyncDir: string } }> {
		return this.abandonWithDigest(lineage, digest({ lineage, recovery: "authorized-stop" }), reason, true);
	}

	private async abandonWithDigest(lineage: ChildLineage, requestDigest: string, reason: string, replaceInvalidLedger = false): Promise<{ stopped: boolean; identity?: { asyncId: string; asyncDir: string } }> {
		if (!reason.trim()) throw new Error("ChildRuntime abandonment reason is required.");
		const { dispatchKey, requestId } = this.identity(lineage, requestDigest);
		const target = paths(lineage);
		const tombstone: DispatchTombstone = { schemaVersion: 1, dispatchKey, requestDigest, lineage, abandonedAt: new Date().toISOString(), reason };
		await atomicWriteJson(target.tombstone, tombstone);
		let raw: unknown | undefined;
		if (!replaceInvalidLedger) raw = await readJson(target.ledger);
		const ledger = raw && !replaceInvalidLedger ? validLedger(raw, lineage, requestDigest) : {
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
		if (ledger.outerAsyncDir) await requestAsyncStop(ledger.outerAsyncDir);
		for (let attempt = 0; attempt < this.abandonPolls; attempt += 1) {
			const identity = await this.lookup(lineage);
			if (identity) {
				await requestAsyncStop(identity.asyncDir);
				if (await waitForConfirmedStop(identity.asyncDir, this.stopConfirmationMs)) return { stopped: true, identity };
				this.scheduleTombstoneReaper(lineage);
				return { stopped: false, identity };
			}
			if (attempt < this.abandonPolls - 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, this.abandonPollMs));
		}
		this.scheduleTombstoneReaper(lineage);
		return { stopped: false };
	}

	async enforceTombstone(lineage: ChildLineage, signal?: AbortSignal): Promise<{ stopped: boolean; identity?: { asyncId: string; asyncDir: string } } | null> {
		if (this.disposed || signal?.aborted) return null;
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
		const rawLedger = await readJson(target.ledger);
		const ledger = rawLedger ? validLedger(rawLedger, lineage, tombstone.requestDigest) : undefined;
		if (ledger?.outerAsyncDir) await requestAsyncStop(ledger.outerAsyncDir);
		const identity = await this.lookup(lineage);
		if (this.disposed || signal?.aborted) return { stopped: false };
		if (!identity) {
			this.scheduleTombstoneReaper(lineage);
			return { stopped: false };
		}
		await requestAsyncStop(identity.asyncDir);
		if (await waitForConfirmedStop(identity.asyncDir, this.stopConfirmationMs)) return { stopped: true, identity };
		this.scheduleTombstoneReaper(lineage);
		return { stopped: false, identity };
	}

	private scheduleTombstoneReaper(lineage: ChildLineage): void {
		if (this.disposed) return;
		const key = paths(lineage).tombstone;
		const previous = ChildRuntime.reapers.get(key);
		if (previous?.owner === this.reaperOwner) return;
		if (previous && previous.generation > this.reaperGeneration) return;
		if (previous) clearTimeout(previous.timer);
		const deadline = Date.now() + this.reaperMaxAgeMs;
		const ownsReaper = () => !this.disposed && ChildRuntime.reapers.get(key)?.owner === this.reaperOwner;
		const install = () => {
			if (!ownsReaper()) return;
			const timer = setTimeout(() => void poll(), this.reaperDelayMs);
			timer.unref();
			ChildRuntime.reapers.set(key, { timer, owner: this.reaperOwner, generation: this.reaperGeneration });
		};
		const poll = async () => {
			if (!ownsReaper()) return;
			try {
				const identity = await this.lookup(lineage);
				if (identity && ownsReaper()) {
					await requestAsyncStop(identity.asyncDir);
					if (await waitForConfirmedStop(identity.asyncDir, Math.min(this.stopConfirmationMs, this.reaperDelayMs))) {
						if (ownsReaper()) ChildRuntime.reapers.delete(key);
						return;
					}
				}
			} catch {
				// A transient status read must not cancel the durable tombstone reaper.
			}
			if (!ownsReaper()) return;
			if (Date.now() >= deadline) {
				ChildRuntime.reapers.delete(key);
				return;
			}
			install();
		};
		const timer = setTimeout(() => void poll(), this.reaperDelayMs);
		timer.unref();
		ChildRuntime.reapers.set(key, { timer, owner: this.reaperOwner, generation: this.reaperGeneration });
	}

	dispose(options: { preserveReapers?: boolean } = {}): boolean {
		if (this.disposed) return false;
		if (options.preserveReapers && [...ChildRuntime.reapers.values()].some((reaper) => reaper.owner === this.reaperOwner)) return true;
		this.disposed = true;
		for (const [key, reaper] of ChildRuntime.reapers) {
			if (reaper.owner !== this.reaperOwner) continue;
			clearTimeout(reaper.timer);
			ChildRuntime.reapers.delete(key);
		}
		return false;
	}
}
