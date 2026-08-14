import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { CompiledGraph, GraphEvent, GraphSnapshot } from "./types.ts";
import { assertGraphScopesOutsideProtectedRoots, validateGraphId } from "./compile.ts";
import { compareClaims, contentionWindow, createClaim, liveClaims, markClaimHeld, releaseClaim, withExclusiveKeyedClaim, type CreatedClaim } from "./claims.ts";
import { appendDurable, atomicWriteJson, createDurableFile, createDurableJson, syncDirectory } from "./durable.ts";
import { encodeSnapshot, isTerminalGraphStatus, validateAndDecodeSnapshot } from "./snapshot.ts";
import { authorizationFor, canonicalDigest, validateAuthorizedPlanningReceipt, type AcceptanceRecord, type AttemptRecord, type AttemptRecoveryRecord, type AuthorizationRecord, type ValidatedResultRecord, type WorkspaceRecord } from "./authority.ts";
import type { PlanningReceipt } from "./subagent-router/planning-gate.ts";
import type { ChildLineage } from "./child-runtime.ts";
export { isProcessAlive } from "./claims.ts";

export class GraphAlreadySupervisedError extends Error {
	constructor(pid: number) {
		super(`Graph already supervised by PID ${pid}.`);
		this.name = "GraphAlreadySupervisedError";
	}
}

export class GraphStore {
	readonly root: string;
	readonly runsRoot: string;
	private sequence = 0;
	private fencingGeneration?: number;
	private supervisorClaim?: CreatedClaim<{ epoch: string }>;
	private writeBarrier: Promise<void> = Promise.resolve();
	private releaseRequested = false;

	constructor(runsRoot: string, graphId: string) {
		this.runsRoot = runsRoot;
		this.root = join(runsRoot, validateGraphId(graphId));
	}

	path(...parts: string[]): string {
		return join(this.root, ...parts);
	}

	async initialize(graph: CompiledGraph, snapshot: GraphSnapshot, planningReceipt?: PlanningReceipt, sourceGraphSpecDigest?: string): Promise<void> {
		assertGraphScopesOutsideProtectedRoots(graph, [this.runsRoot]);
		await mkdir(this.runsRoot, { recursive: true });
		const runsRootInfo = await lstat(this.runsRoot);
		if (runsRootInfo.isSymbolicLink() || !runsRootInfo.isDirectory()) throw new Error(`Graph runs root must be a real directory: ${this.runsRoot}`);
		const initializationLock = new GraphStore(this.runsRoot, basename(this.root));
		const release = await initializationLock.acquireSupervisor(`initialize-${randomUUID()}`);
		const staging = join(this.runsRoot, `.initialize-${basename(this.root)}-${randomUUID()}`);
		try {
			try {
				await lstat(this.root);
				throw new Error(`Graph '${basename(this.root)}' already exists.`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await this.ensureManagedDirectory(staging, "Graph initialization staging");
			const stagingIdentity = await lstat(staging);
			const stagingCanonical = await realpath(staging);
			const assertStagingIdentity = async () => {
				const current = await lstat(staging);
				if (
					current.isSymbolicLink()
					|| !current.isDirectory()
					|| current.dev !== stagingIdentity.dev
					|| current.ino !== stagingIdentity.ino
					|| await realpath(staging) !== stagingCanonical
				) throw new Error("Graph initialization staging identity changed during publication.");
			};
			if (snapshot.schemaVersion === 2) {
				snapshot.fencingGeneration = initializationLock.currentFencingGeneration();
				if (planningReceipt) snapshot.planningAdmissionId = planningReceipt.receiptId;
			}
			await assertStagingIdentity();
			await createDurableJson(join(staging, "graph.json"), graph);
			await assertStagingIdentity();
			await createDurableJson(join(staging, "snapshot.json"), encodeSnapshot(snapshot, this.root));
			await assertStagingIdentity();
			if (snapshot.schemaVersion === 2) {
				await createDurableJson(join(staging, "authorization.json"), authorizationFor(graph, snapshot, planningReceipt, sourceGraphSpecDigest));
				await assertStagingIdentity();
			}
			const created: GraphEvent = {
				seq: 1,
				at: new Date().toISOString(),
				type: "graph.created",
				graphId: basename(this.root),
				data: { status: snapshot.status },
			};
			await createDurableFile(join(staging, "events.jsonl"), `${JSON.stringify(created)}\n`);
			await assertStagingIdentity();
			await syncDirectory(staging);
			await rename(staging, this.root);
			await syncDirectory(this.runsRoot);
			await this.assertManagedGraphRoot();
			this.sequence = 1;
		} catch (error) {
			try {
				const info = await lstat(staging);
				if (info.isDirectory() && !info.isSymbolicLink()) await rm(staging, { recursive: true });
				else await rm(staging, { force: true });
				await syncDirectory(this.runsRoot);
			} catch (cleanupError) {
				if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
			}
			throw error;
		} finally {
			await release();
		}
	}

	async loadGraph(): Promise<CompiledGraph> {
		await this.assertManagedFilePath(this.path("graph.json"), "Graph projection");
		const projection = JSON.parse(await readFile(this.path("graph.json"), "utf8")) as CompiledGraph;
		try {
			await this.assertManagedFilePath(this.path("authorization.json"), "Graph authorization");
			const authorization = JSON.parse(await readFile(this.path("authorization.json"), "utf8")) as Parameters<typeof validateAuthorizedPlanningReceipt>[0] & { schemaVersion?: unknown; graph?: CompiledGraph };
			const persistedSnapshot = JSON.parse(await readFile(this.path("snapshot.json"), "utf8")) as { planningAdmissionId?: unknown };
			const comparableProjection = { ...projection } as Omit<CompiledGraph, "projectionVersion"> & { projectionVersion?: 1 };
			if (authorization.graph && !("projectionVersion" in authorization.graph)) delete comparableProjection.projectionVersion;
			if (authorization.graph && !("spawnBudget" in authorization.graph)) delete comparableProjection.spawnBudget;
			if (![2, 3].includes(authorization.schemaVersion as number) || !authorization.graph || authorization.graphDigest !== canonicalDigest(authorization.graph) || canonicalDigest(comparableProjection) !== authorization.graphDigest) throw new Error("Invalid graph authorization record.");
			validateAuthorizedPlanningReceipt(authorization as Parameters<typeof validateAuthorizedPlanningReceipt>[0]);
			if ((authorization.schemaVersion === 3 || persistedSnapshot.planningAdmissionId !== undefined)
				&& (authorization.schemaVersion !== 3 || typeof persistedSnapshot.planningAdmissionId !== "string" || authorization.planningAdmissionId !== persistedSnapshot.planningAdmissionId)) {
				throw new Error("Graph planning admission marker does not match its authorization schema and receipt.");
			}
			return authorization.graph;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return projection;
			throw error;
		}
	}

	async loadAuthorization(): Promise<AuthorizationRecord> {
		await this.assertManagedFilePath(this.path("authorization.json"), "Graph authorization");
		const authorization = JSON.parse(await readFile(this.path("authorization.json"), "utf8")) as AuthorizationRecord;
		if (![2, 3].includes(authorization.schemaVersion) || !authorization.graph || authorization.graphDigest !== canonicalDigest(authorization.graph)) throw new Error("Invalid graph authorization record.");
		validateAuthorizedPlanningReceipt(authorization);
		return authorization;
	}

	async loadSnapshot(): Promise<GraphSnapshot> {
		await this.assertManagedFilePath(this.path("snapshot.json"), "Graph snapshot");
		return validateAndDecodeSnapshot(JSON.parse(await readFile(this.path("snapshot.json"), "utf8")), basename(this.root), this.root);
	}

	async saveSnapshot(snapshot: GraphSnapshot): Promise<void> {
		await this.withFencedWrite(async () => {
			await this.prepareManagedFilePath(this.path("snapshot.json"), "Graph snapshot");
			snapshot.updatedAt = new Date().toISOString();
			if (snapshot.schemaVersion === 2 && this.fencingGeneration !== undefined) snapshot.fencingGeneration = this.fencingGeneration;
			if (snapshot.schemaVersion === 2) {
				let previous: GraphSnapshot | undefined;
				try {
					previous = await this.loadSnapshot();
					if (previous.schemaVersion === 2 && previous.runInstanceId !== snapshot.runInstanceId) throw new Error("Graph run instance identity cannot change.");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				// needs_attention is resumable. Older attention snapshots may contain a
				// terminalAt from before attentionAt was introduced; do not carry it into
				// the resumed run or its later true terminal state. Other statuses retain
				// the original immutable timestamp across authority/projection recovery.
				if (previous?.schemaVersion === 2 && previous.status === "needs_attention") {
					if (snapshot.status !== "needs_attention") {
						delete snapshot.terminalAt;
						if (isTerminalGraphStatus(snapshot.status)) snapshot.terminalAt = snapshot.updatedAt;
					}
				} else {
					if (isTerminalGraphStatus(snapshot.status) && snapshot.status !== "needs_attention") snapshot.terminalAt ??= snapshot.updatedAt;
					if (previous?.schemaVersion === 2 && previous.terminalAt && snapshot.terminalAt !== previous.terminalAt) throw new Error("Graph terminalAt is immutable.");
				}
				if (snapshot.status === "needs_attention" && !(previous?.schemaVersion === 2 && previous.status === "needs_attention")) delete snapshot.terminalAt;
				if (snapshot.status === "needs_attention") {
					snapshot.attentionAt = previous?.schemaVersion === 2 && previous.status === "needs_attention" && previous.attentionAt
						? previous.attentionAt
						: previous?.schemaVersion === 2 && previous.status === "needs_attention" && snapshot.attentionAt
							? snapshot.attentionAt
							: snapshot.updatedAt;
				} else {
					delete snapshot.attentionAt;
				}
			}
			await atomicWriteJson(this.path("snapshot.json"), encodeSnapshot(snapshot, this.root));
		});
	}

	async replaceSnapshotProjection(snapshot: GraphSnapshot): Promise<void> {
		await this.withFencedWrite(async () => {
			await this.prepareManagedFilePath(this.path("snapshot.json"), "Graph snapshot projection");
			snapshot.updatedAt = new Date().toISOString();
			await atomicWriteJson(this.path("snapshot.json"), encodeSnapshot(snapshot, this.root));
		});
	}

	async writeJson(relativePath: string, value: unknown): Promise<string> {
		const target = this.path(relativePath);
		await this.withFencedWrite(async () => {
			await this.prepareManagedFilePath(target, "Graph JSON target");
			await atomicWriteJson(target, value);
		});
		return target;
	}

	async requestControl(action: "stop"): Promise<void> {
		await this.recordDesiredState("stopped");
		const target = this.path("control", `${action}.json`);
		await this.prepareManagedFilePath(target, "Graph control request");
		await atomicWriteJson(target, { action, requestedAt: new Date().toISOString() });
	}

	async recordDesiredState(state: "stopped"): Promise<void> {
		const target = this.path("desired-state.json");
		await this.prepareManagedFilePath(target, "Graph desired state");
		await atomicWriteJson(target, { version: 1, state, requestedAt: new Date().toISOString() });
	}

	async readDesiredState(): Promise<"stopped" | undefined> {
		await this.assertManagedFilePath(this.path("desired-state.json"), "Graph desired state");
		try {
			const value = JSON.parse(await readFile(this.path("desired-state.json"), "utf8")) as { version?: unknown; state?: unknown };
			if (value.version !== 1 || value.state !== "stopped") throw new Error(`Invalid graph desired state: ${this.path("desired-state.json")}`);
			return "stopped";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async consumeControl(action: "stop"): Promise<boolean> {
		const path = this.path("control", `${action}.json`);
		try {
			await this.assertManagedFilePath(path, "Graph control request");
			const value = JSON.parse(await readFile(path, "utf8")) as { action?: unknown };
			if (value.action !== action) throw new Error(`Invalid graph control request: ${path}`);
			await this.recordDesiredState("stopped");
			await rm(path, { force: true });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	async readApplyPlanStatus(taskId: string, attempt: number): Promise<"prepared" | "applying" | "committed" | "rolled_back" | undefined> {
		if (!Number.isInteger(attempt) || attempt < 1) throw new Error("Invalid graph apply plan attempt number.");
		const path = this.path("nodes", validateGraphId(taskId), `attempt-${attempt}`, "apply-plan.json");
		try {
			await this.assertManagedFilePath(path, "Graph apply plan");
			const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; status?: unknown };
			if (![1, 2].includes(value.version as number) || !["prepared", "applying", "committed", "rolled_back"].includes(value.status as string)) throw new Error(`Invalid graph apply plan status: ${path}`);
			return value.status as "prepared" | "applying" | "committed" | "rolled_back";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async event(type: string, data?: Record<string, unknown>, taskId?: string): Promise<void> {
		await this.withFencedWrite(async () => {
			await this.prepareManagedFilePath(this.path("events.jsonl"), "Graph event journal");
			if (this.sequence === 0) {
				try {
					const lines = (await readFile(this.path("events.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
					const last = lines.at(-1);
					if (last) this.sequence = Number((JSON.parse(last) as { seq?: number }).seq) || 0;
				} catch {
					this.sequence = 0;
				}
			}
			const event: GraphEvent = {
				seq: ++this.sequence,
				at: new Date().toISOString(),
				type,
				graphId: this.root.split("/").at(-1)!,
				...(taskId ? { taskId } : {}),
				...(data ? { data } : {}),
			};
			await appendDurable(this.path("events.jsonl"), `${JSON.stringify(event)}\n`);
		});
	}

	async acquireSupervisor(epoch: string): Promise<() => Promise<void>> {
		if (this.supervisorClaim) throw new Error("GraphStore already holds a Supervisor claim.");
		const control = join(this.runsRoot, ".control", "graph-locks", basename(this.root));
		const directory = join(control, "claims");
		const graphId = basename(this.root);
		const created = await GraphStore.withGraphLockMutationGate(this.runsRoot, graphId, `acquire:${graphId}`, async () => {
			await this.ensureManagedDirectory(directory, "Graph Supervisor claims");
			return createClaim(directory, { epoch });
		});
		let acquired = false;
		try {
			await contentionWindow();
			const claims = await liveClaims<{ epoch: string }>(directory);
			const held = claims.find((entry) => entry.claim.token !== created.claim.token && entry.claim.state === "held");
			if (held) throw new GraphAlreadySupervisedError(held.claim.pid);
			const winner = claims.filter((entry) => entry.claim.state === "pending").sort((left, right) => compareClaims(left.claim, right.claim))[0];
			if (!winner || winner.claim.token !== created.claim.token) throw new GraphAlreadySupervisedError(winner?.claim.pid ?? process.pid);
			await markClaimHeld(created);
			const competing = (await liveClaims<{ epoch: string }>(directory)).find((entry) => entry.claim.token !== created.claim.token && entry.claim.state === "held");
			if (competing) throw new GraphAlreadySupervisedError(competing.claim.pid);
			const generation = await this.readOrRecoverFencingGeneration(control);
			this.fencingGeneration = generation + 1;
				await atomicWriteJson(join(control, "generation.json"), { version: 1, graphId: basename(this.root), generation: this.fencingGeneration, epoch, updatedAt: new Date().toISOString() });
				this.supervisorClaim = created;
				this.releaseRequested = false;
				acquired = true;
				return async () => {
					if (this.supervisorClaim?.claim.token !== created.claim.token) return;
					this.releaseRequested = true;
					await this.writeBarrier;
					if (this.supervisorClaim?.claim.token === created.claim.token) this.supervisorClaim = undefined;
					await releaseClaim(created);
				};
		} finally {
			if (!acquired) await releaseClaim(created);
		}
	}

	static async withGraphLockMutationGate<T>(runsRoot: string, graphId: string, purpose: string, action: () => Promise<T>): Promise<T> {
		validateGraphId(graphId);
		const coordinator = new GraphStore(runsRoot, "graph-lock-gate");
		const directory = join(runsRoot, ".control", "graph-lock-gate", "claims");
		await coordinator.ensureManagedDirectory(directory, "Graph lock mutation gate");
		return withExclusiveKeyedClaim(
			directory,
			{ purpose, graphId } as { purpose: string; graphId?: string },
			graphId,
			(payload) => {
				if (typeof payload.graphId !== "string") return undefined;
				try {
					return validateGraphId(payload.graphId);
				} catch {
					return undefined;
				}
			},
			action,
			{
			busyMessage: "Graph lock metadata is busy.",
			},
		);
	}

	private async readOrRecoverFencingGeneration(control: string): Promise<number> {
		const path = join(control, "generation.json");
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error("Invalid graph fencing generation file.");
			const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; graphId?: unknown; generation?: unknown };
			if (
				value.version !== 1
				|| (value.graphId !== undefined && value.graphId !== basename(this.root))
				|| !Number.isSafeInteger(value.generation)
				|| (value.generation as number) < 0
				|| (value.generation as number) >= Number.MAX_SAFE_INTEGER
			) throw new Error("Invalid graph fencing generation.");
			return value.generation as number;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			const quarantine = join(control, `generation.invalid-${Date.now()}-${randomUUID()}`);
			await rename(path, quarantine);
			await syncDirectory(control);
			return 0;
		}
	}

	currentFencingGeneration(): number {
		return this.fencingGeneration ?? 0;
	}

	private async assertCurrentFence(): Promise<void> {
		if (this.fencingGeneration === undefined) return;
		if (!this.supervisorClaim) throw new Error("GraphStore no longer holds its Supervisor claim.");
		const persistedClaim = JSON.parse(await readFile(this.supervisorClaim.path, "utf8")) as { token?: unknown; state?: unknown };
		if (persistedClaim.token !== this.supervisorClaim.claim.token || persistedClaim.state !== "held") throw new Error("GraphStore Supervisor claim is no longer held.");
		const path = join(this.runsRoot, ".control", "graph-locks", basename(this.root), "generation.json");
		const value = JSON.parse(await readFile(path, "utf8")) as { generation?: unknown };
		if (value.generation !== this.fencingGeneration) throw new Error(`Stale graph Supervisor fence: held ${this.fencingGeneration}, current ${String(value.generation)}.`);
	}

	private async assertManagedGraphRoot(): Promise<void> {
		const info = await lstat(this.root);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Graph root must be a real directory: ${this.root}`);
		const [managedRoot, graphRoot] = await Promise.all([realpath(this.runsRoot), realpath(this.root)]);
		const rel = relative(managedRoot, graphRoot);
		if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Graph root escapes the managed runs directory: ${this.root}`);
	}

	private assertGraphDescendant(target: string, label: string): string {
		const token = relative(this.root, target);
		if (!token || token === ".." || token.startsWith(`..${sep}`) || isAbsolute(token)) throw new Error(`${label} escapes the Graph root.`);
		return token;
	}

	async assertManagedDirectoryPath(target: string, label: string): Promise<void> {
		if (target === this.root) {
			await this.assertManagedGraphRoot();
			return;
		}
		const token = this.assertGraphDescendant(target, label);
		await this.assertManagedGraphRoot();
		let cursor = this.root;
		for (const part of token.split(sep).filter(Boolean)) {
			cursor = join(cursor, part);
			const info = await lstat(cursor);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} contains a symbolic link or non-directory: ${cursor}`);
		}
		const [graphRoot, canonicalTarget] = await Promise.all([realpath(this.root), realpath(target)]);
		const rel = relative(graphRoot, canonicalTarget);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes the Graph root through a symbolic link.`);
	}

	async assertManagedFilePath(target: string, label: string): Promise<void> {
		this.assertGraphDescendant(target, label);
		await this.assertManagedDirectoryPath(dirname(target), `${label} parent`);
		try {
			const info = await lstat(target);
			if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error(`${label} must be a single regular file.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	async ensureManagedSubdirectory(relativePath: string, label: string): Promise<string> {
		const target = this.path(relativePath);
		this.assertGraphDescendant(target, label);
		await this.ensureManagedDirectory(target, label);
		await this.assertManagedDirectoryPath(target, label);
		return target;
	}

	private async prepareManagedFilePath(target: string, label: string): Promise<void> {
		const parent = dirname(target);
		if (parent === this.root) await this.assertManagedGraphRoot();
		else await this.ensureManagedSubdirectory(this.assertGraphDescendant(parent, `${label} parent`), `${label} parent`);
		await this.assertManagedFilePath(target, label);
	}

	private async ensureManagedDirectory(target: string, label: string): Promise<void> {
		await mkdir(this.runsRoot, { recursive: true });
		const rootInfo = await lstat(this.runsRoot);
		if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`${label} root must be a real directory.`);
		const token = relative(this.runsRoot, target);
		if (!token || isAbsolute(token) || token === ".." || token.startsWith(`..${sep}`)) throw new Error(`${label} escapes the managed runs directory.`);
		let cursor = this.runsRoot;
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
		const [managedRoot, managedTarget] = await Promise.all([realpath(this.runsRoot), realpath(target)]);
		const rel = relative(managedRoot, managedTarget);
		if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes the managed runs directory.`);
	}

	private async withFencedWrite<T>(operation: () => Promise<T>): Promise<T> {
		if (this.fencingGeneration !== undefined && this.releaseRequested) throw new Error("GraphStore no longer holds its Supervisor claim; release has started.");
		const current = this.writeBarrier.then(async () => {
			let implicitClaim = false;
			if (this.fencingGeneration === undefined) {
				await this.acquireSupervisor(`implicit-write-${process.pid}-${Date.now()}`);
				implicitClaim = true;
			}
			try {
				await this.assertCurrentFence();
				await this.assertManagedGraphRoot();
				return await operation();
			} finally {
				if (implicitClaim) {
					const created = this.supervisorClaim;
					this.supervisorClaim = undefined;
					if (created) await releaseClaim(created);
					this.fencingGeneration = undefined;
					this.releaseRequested = false;
				}
			}
		});
		this.writeBarrier = current.then(() => undefined, () => undefined);
		return current;
	}

	async writeAttemptRecord(taskId: string, attempt: number, record: AttemptRecord): Promise<string> {
		const relativePath = join("nodes", validateGraphId(taskId), `attempt-${attempt}`, "attempt.json");
		const target = this.path(relativePath);
		await this.withFencedWrite(async () => {
			await this.prepareManagedFilePath(target, "Attempt authority");
			let previous: AttemptRecord | undefined;
			try {
				previous = JSON.parse(await readFile(target, "utf8")) as AttemptRecord;
				if (previous.schemaVersion !== 2 || previous.runInstanceId !== record.runInstanceId || previous.graphId !== record.graphId || previous.taskId !== record.taskId || previous.attempt !== record.attempt || previous.attemptNonce !== record.attemptNonce) {
					throw new Error("Attempt authority identity cannot change.");
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (previous) await this.assertAttemptPhaseTransition(previous, record, dirname(target));
			else if (record.phase !== "prepared") throw new Error(`Initial attempt authority must be prepared for ${taskId}/${attempt}.`);
			const next = {
				...previous,
				...record,
				...(record.routingDecision ?? previous?.routingDecision ? { routingDecision: record.routingDecision ?? previous?.routingDecision } : {}),
				...(record.requestDigest ?? previous?.requestDigest ? { requestDigest: record.requestDigest ?? previous?.requestDigest } : {}),
				...(record.launchContractDigest ?? previous?.launchContractDigest ? { launchContractDigest: record.launchContractDigest ?? previous?.launchContractDigest } : {}),
				...(record.extensionContentDigest ?? previous?.extensionContentDigest ? { extensionContentDigest: record.extensionContentDigest ?? previous?.extensionContentDigest } : {}),
				...(record.runtimeLaunchContractDigest ?? previous?.runtimeLaunchContractDigest ? { runtimeLaunchContractDigest: record.runtimeLaunchContractDigest ?? previous?.runtimeLaunchContractDigest } : {}),
				...(record.runtimeGuardAcknowledged ?? previous?.runtimeGuardAcknowledged ? { runtimeGuardAcknowledged: record.runtimeGuardAcknowledged ?? previous?.runtimeGuardAcknowledged } : {}),
				...(record.asyncId ?? previous?.asyncId ? { asyncId: record.asyncId ?? previous?.asyncId } : {}),
				...(record.sessionId ?? previous?.sessionId ? { sessionId: record.sessionId ?? previous?.sessionId } : {}),
				...(record.phase === "terminal" && (record.terminalStatus ?? previous?.terminalStatus) ? { terminalStatus: record.terminalStatus ?? previous?.terminalStatus } : {}),
				...(record.phase === "terminal" && (record.terminalError ?? previous?.terminalError) ? { terminalError: record.terminalError ?? previous?.terminalError } : {}),
				...(record.phase === "terminal" && (record.terminalRetryKind ?? previous?.terminalRetryKind) ? { terminalRetryKind: record.terminalRetryKind ?? previous?.terminalRetryKind } : {}),
			} as AttemptRecord;
			if (record.phase !== "terminal") {
				delete next.terminalStatus;
				delete next.terminalError;
				delete next.terminalRetryKind;
			}
			await atomicWriteJson(target, next);
		});
		return target;
	}

	async readAttemptRecord(taskId: string, attempt: number): Promise<AttemptRecord> {
		const path = this.path("nodes", validateGraphId(taskId), `attempt-${attempt}`, "attempt.json");
		await this.assertManagedFilePath(path, "Attempt authority");
		return JSON.parse(await readFile(path, "utf8")) as AttemptRecord;
	}

	async restorePreparedAttemptAfterPreEmitAbort(taskId: string, attempt: number, lineage: ChildLineage, requestDigest: string): Promise<void> {
		const normalizedTaskId = validateGraphId(taskId);
		const attemptRoot = this.path("nodes", normalizedTaskId, `attempt-${attempt}`);
		if (dirname(lineage.sessionDir) !== attemptRoot || lineage.providerDispatch !== undefined) throw new Error("Only the first provider dispatch can restore prepared attempt authority after a proven pre-emit abort.");
		const authorityPath = join(attemptRoot, "attempt.json");
		const ledgerPath = join(attemptRoot, "child-dispatch.json");
		const tombstonePath = join(attemptRoot, "child-tombstone.json");
		await this.withFencedWrite(async () => {
			await this.assertManagedFilePath(authorityPath, "Attempt authority pre-emit rollback");
			await this.assertManagedFilePath(ledgerPath, "Child dispatch ledger pre-emit rollback");
			await this.assertManagedFilePath(tombstonePath, "Child dispatch tombstone pre-emit rollback");
			const authority = JSON.parse(await readFile(authorityPath, "utf8")) as AttemptRecord;
			const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<string, unknown>;
			const authorityProvesPreEmit = (
				authority.schemaVersion !== 2
				|| authority.runInstanceId !== lineage.runInstanceId
				|| authority.graphId !== lineage.graphId
				|| authority.taskId !== normalizedTaskId
				|| authority.attempt !== attempt
				|| authority.attemptNonce !== lineage.attemptNonce
			) ? false : (
				(authority.phase === "dispatching" && authority.requestDigest === requestDigest && authority.asyncId === undefined)
				|| (authority.phase === "prepared" && authority.requestDigest === undefined && authority.asyncId === undefined)
			);
			if (
				!authorityProvesPreEmit
				|| ledger.schemaVersion !== 1
				|| ledger.phase !== "prepared"
				|| ledger.requestDigest !== requestDigest
				|| JSON.stringify(ledger.lineage) !== JSON.stringify(lineage)
				|| ledger.dispatchKey !== canonicalDigest({ lineage, requestDigest })
				|| ledger.requestId !== `pi-graph-v2-${String(ledger.dispatchKey).slice(0, 40)}`
				|| ledger.asyncId !== undefined
				|| ledger.asyncDir !== undefined
			) throw new Error("Pre-emit abort evidence does not prove that attempt authority can safely return to prepared.");
			try {
				await readFile(tombstonePath, "utf8");
				throw new Error("A tombstoned child dispatch cannot return to prepared attempt authority.");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const restored: AttemptRecord = { ...authority, phase: "prepared", updatedAt: new Date().toISOString() };
			delete restored.requestDigest;
			delete restored.asyncId;
			delete restored.sessionId;
			delete restored.terminalStatus;
			delete restored.terminalError;
			delete restored.terminalRetryKind;
			await atomicWriteJson(authorityPath, restored);
		});
	}

	async hasAttemptRecovery(taskId: string, attempt: number): Promise<boolean> {
		try {
			const path = this.path("nodes", validateGraphId(taskId), `attempt-${attempt}`, "attempt-recovery.json");
			await this.assertManagedFilePath(path, "Attempt recovery");
			await readFile(path, "utf8");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	async completeAttemptRecovery(taskId: string, attempt: number): Promise<void> {
		const path = this.path("nodes", validateGraphId(taskId), `attempt-${attempt}`, "attempt-recovery.json");
		await this.withFencedWrite(async () => {
			await this.assertManagedFilePath(path, "Attempt recovery");
			await rm(path, { force: true });
		});
	}

	async prepareAttemptRecovery(taskId: string, attempt: number, toStatus: AttemptRecoveryRecord["toStatus"]): Promise<string> {
		const root = this.path("nodes", validateGraphId(taskId), `attempt-${attempt}`);
		const authority = await this.readAttemptRecord(taskId, attempt);
		if (authority.schemaVersion !== 2 || authority.taskId !== taskId || authority.attempt !== attempt || authority.phase !== "terminal" || authority.terminalStatus !== "stale") {
			throw new Error(`Attempt recovery requires terminal/stale authority for ${taskId}/${attempt}.`);
		}
		const recovery: AttemptRecoveryRecord = {
			schemaVersion: 2,
			runInstanceId: authority.runInstanceId,
			graphId: authority.graphId,
			taskId,
			attempt,
			attemptNonce: authority.attemptNonce,
			fromStatus: "stale",
			toStatus,
			preparedAt: new Date().toISOString(),
		};
		return this.writeJson(join("nodes", taskId, `attempt-${attempt}`, "attempt-recovery.json"), recovery);
	}

	private async assertAttemptPhaseTransition(previous: AttemptRecord, next: AttemptRecord, attemptRoot: string): Promise<void> {
		const allowed: Record<AttemptRecord["phase"], AttemptRecord["phase"][]> = {
			prepared: ["prepared", "dispatching", "terminal"],
			dispatching: ["dispatching", "running", "terminal"],
			running: ["running", "collecting", "terminal"],
			collecting: ["collecting", "validated", "terminal"],
			validated: ["validated", "applying", "terminal"],
			applying: ["applying", "accepted", "terminal"],
			accepted: ["accepted"],
			terminal: ["terminal"],
		};
		const nextPhases = allowed[previous.phase];
		if (!nextPhases) throw new Error(`Invalid previous attempt authority phase: ${String(previous.phase)}.`);
		if (previous.routingDecision !== undefined && next.routingDecision !== undefined && canonicalDigest(previous.routingDecision) !== canonicalDigest(next.routingDecision)) {
			throw new Error("Attempt authority routingDecision cannot change.");
		}
		for (const field of ["requestDigest", "launchContractDigest", "extensionContentDigest", "runtimeLaunchContractDigest", "runtimeGuardAcknowledged", "asyncId", "sessionId"] as const) {
			if (previous[field] !== undefined && next[field] !== undefined && previous[field] !== next[field]) {
				throw new Error(`Attempt authority ${field} cannot change.`);
			}
		}
		if (nextPhases.includes(next.phase)) {
			if (previous.phase === "terminal" && next.phase === "terminal") {
				for (const field of ["terminalStatus", "terminalError", "terminalRetryKind"] as const) {
					if (previous[field] !== next[field]) throw new Error(`Terminal attempt authority ${field} cannot change.`);
				}
			}
			return;
		}
		if (previous.phase === "terminal" && previous.terminalStatus === "stale" && next.phase === "collecting") {
			const recovery = JSON.parse(await readFile(join(attemptRoot, "attempt-recovery.json"), "utf8")) as AttemptRecoveryRecord;
			if (
				recovery.schemaVersion === 2
				&& recovery.runInstanceId === previous.runInstanceId
				&& recovery.graphId === previous.graphId
				&& recovery.taskId === previous.taskId
				&& recovery.attempt === previous.attempt
				&& recovery.attemptNonce === previous.attemptNonce
				&& recovery.fromStatus === "stale"
				&& ["running", "verifying"].includes(recovery.toStatus)
				&& typeof recovery.preparedAt === "string"
				&& Number.isFinite(Date.parse(recovery.preparedAt))
				&& new Date(Date.parse(recovery.preparedAt)).toISOString() === recovery.preparedAt
			) return;
		}
		throw new Error(`Illegal attempt authority phase transition: ${previous.phase} -> ${next.phase}.`);
	}

	async writeWorkspaceRecord(taskId: string, attempt: number, record: WorkspaceRecord): Promise<string> {
		return this.writeJson(join("nodes", validateGraphId(taskId), `attempt-${attempt}`, "workspace.json"), record);
	}

	async readWorkspaceRecord(taskId: string, attempt: number): Promise<WorkspaceRecord> {
		const path = this.path("nodes", validateGraphId(taskId), `attempt-${attempt}`, "workspace.json");
		await this.assertManagedFilePath(path, "Workspace authority");
		return JSON.parse(await readFile(path, "utf8")) as WorkspaceRecord;
	}

	async writeValidatedResult(taskId: string, attempt: number, record: ValidatedResultRecord): Promise<string> {
		return this.writeJson(join("nodes", validateGraphId(taskId), `attempt-${attempt}`, "validated-result.json"), record);
	}

	async writeAcceptance(taskId: string, attempt: number, record: AcceptanceRecord): Promise<string> {
		return this.writeJson(join("nodes", validateGraphId(taskId), `attempt-${attempt}`, "acceptance.json"), record);
	}

	static async list(runsRoot: string): Promise<string[]> {
		const graphIds: string[] = [];
		for (const graphId of await GraphStore.discover(runsRoot)) {
			const root = join(runsRoot, graphId);
			const info = await lstat(root);
			if (info.isSymbolicLink() || !info.isDirectory()) continue;
			try {
				await access(join(root, "graph.json"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			graphIds.push(graphId);
		}
		return graphIds.sort();
	}

	static async discover(runsRoot: string): Promise<string[]> {
		try {
			const graphIds: string[] = [];
			for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				try {
					validateGraphId(entry.name);
				} catch {
					continue;
				}
				graphIds.push(entry.name);
			}
			return graphIds.sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
}
