import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type {
	CompiledGraph,
	CompiledNode,
	FailureDetails,
	GraphConfig,
	NodeAttemptState,
	NodeExecutionResult,
	NodeRuntimeState,
	ResultManifest,
} from "./types.ts";
import { GRAPH_RESULT_VERSION } from "./types.ts";
import { GraphStore } from "./store.ts";
import { LeaseRegistry } from "./leases.ts";
import { digestFile, prepareWorkspace, reopenWorkspace, WorkspaceConflictError, type PreparedWorkspace } from "./workspace.ts";
import { recoverRunBySessionDir, RpcRejectedError, RpcTimeoutError, SubagentRpcClient, type EventBus } from "./rpc.ts";
import { AsyncRunDeadlineError, readAsyncRunState, requestAsyncStop, waitForAsyncRun, waitForConfirmedStop } from "./lifecycle.ts";
import { runValidations } from "./validation.ts";
import { canonicalDigest, type AttemptRecord, type ValidatedResultRecord } from "./authority.ts";
import { SourceReservationBusyError, SourceReservationRegistry } from "./reservations.ts";
import { ChildRuntime, type ChildLineage } from "./child-runtime.ts";
import { classifyChildFailure } from "./failure.ts";

export interface TransitionOptions {
	statePatch?: Partial<Pick<NodeRuntimeState, "nextRetryAt" | "resourceWaitStartedAt" | "failure">>;
	appendAttempt?: NodeAttemptState;
}

export type Transition = (
	taskId: string,
	status: NodeRuntimeState["status"],
	patch?: Partial<NodeAttemptState>,
	error?: string,
	options?: TransitionOptions,
) => Promise<void>;

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function modelOverride(node: CompiledNode): string | undefined {
	if (!node.model) return undefined;
	return node.thinking ? `${node.model}:${node.thinking}` : node.model;
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertRegularAttemptOutput(path: string, attemptDir: string): Promise<void> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error("Subagent output artifact must be a regular file, not a symlink or directory.");
	const [resolvedOutput, resolvedAttempt] = await Promise.all([realpath(path), realpath(attemptDir)]);
	if (!within(resolvedAttempt, resolvedOutput)) throw new Error("Subagent output artifact escapes its attempt directory through a symlink.");
}

async function assertSafeAttemptOutputTarget(path: string, attemptDir: string, artifact: string): Promise<void> {
	const expected = join(attemptDir, "output", artifact);
	if (path !== expected || !within(attemptDir, path)) throw new Error("Subagent output artifact does not match its declared attempt path.");
	let cursor = attemptDir;
	for (const part of relative(attemptDir, dirname(path)).split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		const info = await lstat(cursor);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Subagent output parent must not contain symlinks or non-directories.");
	}
	const [resolvedParent, resolvedAttempt] = await Promise.all([realpath(dirname(path)), realpath(attemptDir)]);
	if (!within(resolvedAttempt, resolvedParent)) throw new Error("Subagent output parent escapes its attempt directory through a symlink.");
	if (!existsSync(path)) return;
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error("Subagent output artifact must be a regular file, not a symlink or directory.");
}

function taskPrompt(graph: CompiledGraph, node: CompiledNode, workspace: PreparedWorkspace, lineage?: ChildLineage): string {
	const inputs = Object.entries(workspace.artifactPaths).map(([name, path]) => `- ${name}: ${path}`);
	return [
		`[pi-graph node ${graph.graphId}/${node.taskId}]`,
		...(lineage ? [`[pi-graph lineage ${lineage.runInstanceId}/${lineage.taskId}/${lineage.attempt}/${lineage.attemptNonce}]`] : []),
		`Graph goal: ${graph.goal}`,
		"Work only inside the isolated workspace and obey .pi-graph/node-contract.json.",
		"If .pi-graph/recovery-handoff.md exists, read it before working. It contains bounded evidence from the prior attempt; this workspace is still a fresh isolated copy.",
		`Declared side effect: ${node.sideEffect}`,
		inputs.length ? `Input artifacts:\n${inputs.join("\n")}` : "Input artifacts: none",
		"Complete only this node. Report evidence, changed files, validation performed, and unresolved blockers.",
		"",
		node.task,
	].join("\n");
}

export class NodeExecutor {
	private readonly graph: CompiledGraph;
	private readonly store: GraphStore;
	private readonly rpc: SubagentRpcClient;
	private readonly events: EventBus;
	private readonly leases: LeaseRegistry;
	private readonly config: GraphConfig;
	private epoch: string;
	private ownerSessionId?: string;
	private runInstanceId?: string;
	private fencingGeneration: number;
	private readonly transition: Transition;
	private readonly childRuntime: ChildRuntime;
	constructor(
		graph: CompiledGraph,
		store: GraphStore,
		rpc: SubagentRpcClient,
		events: EventBus,
		leases: LeaseRegistry,
		config: GraphConfig,
		epoch: string,
		ownerSessionId: string | undefined,
		runtimeIdentity: { runInstanceId?: string; fencingGeneration?: number },
		transition: Transition,
	) {
		this.graph = graph;
		this.store = store;
		this.rpc = rpc;
		this.events = events;
		this.leases = leases;
		this.config = config;
		this.epoch = epoch;
		this.ownerSessionId = ownerSessionId;
		this.runInstanceId = runtimeIdentity.runInstanceId;
		this.fencingGeneration = runtimeIdentity.fencingGeneration ?? 0;
		this.transition = transition;
		this.childRuntime = new ChildRuntime(rpc);
	}

	setSupervisorIdentity(epoch: string, ownerSessionId?: string, fencingGeneration?: number): void {
		this.epoch = epoch;
		this.ownerSessionId = ownerSessionId;
		if (fencingGeneration !== undefined) this.fencingGeneration = fencingGeneration;
	}

	private artifactPath(name: string): string {
		return this.store.path("artifacts", name);
	}

	private lineage(node: CompiledNode, attempt: NodeAttemptState): ChildLineage | undefined {
		if (!this.runInstanceId || !attempt.attemptNonce) return undefined;
		return {
			runInstanceId: this.runInstanceId,
			graphId: this.graph.graphId,
			taskId: node.taskId,
			attempt: attempt.attempt,
			attemptNonce: attempt.attemptNonce,
			sessionDir: attempt.sessionDir,
			...(this.ownerSessionId ? { ownerSessionId: this.ownerSessionId } : {}),
		};
	}

	private childParams(node: CompiledNode, workspace: PreparedWorkspace, attempt: NodeAttemptState): Record<string, unknown> {
		const lineage = this.lineage(node, attempt);
		return {
			agent: node.agent,
			task: taskPrompt(this.graph, node, workspace, lineage),
			cwd: workspace.cwd,
			context: "fresh",
			async: true,
			clarify: false,
			...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
			sessionDir: attempt.sessionDir,
			agentScope: "both",
			artifacts: true,
			output: attempt.outputPath,
			outputMode: "file-only",
			...(modelOverride(node) ? { model: modelOverride(node) } : {}),
			...(node.progress !== undefined ? { progress: node.progress } : {}),
			...(node.toolBudget ? { toolBudget: node.toolBudget } : {}),
			...(node.acceptance !== undefined ? { acceptance: node.acceptance } : {}),
		};
	}

	private async resolveDispatch(node: CompiledNode, attemptState: NodeAttemptState): Promise<{ asyncId: string; asyncDir: string } | null> {
		const lineage = this.lineage(node, attemptState);
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const recovered = lineage
				? await this.childRuntime.lookup(lineage)
				: await recoverRunBySessionDir(attemptState.sessionDir, undefined, this.ownerSessionId);
			if (recovered) return recovered;
			await delay(500);
		}
		return null;
	}

	private async createAttempt(node: CompiledNode, state: NodeRuntimeState): Promise<{ attempt: NodeAttemptState; workspace: PreparedWorkspace }> {
		const number = state.attempt + 1;
		const attemptDir = this.store.path("nodes", node.taskId, `attempt-${number}`);
		const sessionDir = join(attemptDir, "session");
		const artifacts = (node.inputArtifacts ?? []).map((name) => ({ name, source: this.artifactPath(name) }));
		for (const artifact of artifacts) {
			await this.store.assertManagedFilePath(artifact.source, `${node.taskId} input artifact`);
			if (!existsSync(artifact.source)) throw new Error(`${node.taskId}: required artifact is missing: ${artifact.name}`);
		}
		await this.store.ensureManagedSubdirectory(join("nodes", node.taskId, `attempt-${number}`), "Graph attempt directory");
		const workspace = await prepareWorkspace({
			graphId: this.graph.graphId,
			node,
			attempt: number,
			attemptDir,
			strategy: this.graph.workspace,
			contextDigest: node.context?.digest ?? this.graph.context?.digest,
			artifacts,
		});
		const previousAttempt = state.attempts.at(-1);
		if (previousAttempt) {
			const handoff: string[] = [
				"# Recovery handoff",
				"",
				`Prior attempt: ${previousAttempt.attempt}`,
				`Prior status: ${previousAttempt.status}`,
				...(previousAttempt.failure ? [`Failure kind: ${previousAttempt.failure.kind}`, `Retry kind: ${previousAttempt.failure.retryKind ?? "none"}`] : []),
				...(previousAttempt.error ? [`Error: ${previousAttempt.error}`] : []),
				"",
				"This attempt uses a fresh isolated workspace. Treat the evidence below as guidance only; inspect current files and re-run deterministic validation.",
			];
			for (const [label, path] of [["Prior manifest", previousAttempt.manifestPath], ["Prior output", previousAttempt.outputPath]] as const) {
				if (!path || !existsSync(path)) continue;
				try {
					await this.store.assertManagedFilePath(path, label);
					const content = (await readFile(path, "utf8")).slice(0, 65_536);
					handoff.push("", `## ${label}`, "", "```text", content, "```");
				} catch (error) {
					handoff.push("", `## ${label}`, "", `Evidence could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			await writeFile(join(workspace.cwd, ".pi-graph", "recovery-handoff.md"), `${handoff.join("\n")}\n`, "utf8");
		}
		const attempt: NodeAttemptState = {
			attempt: number,
			attemptNonce: randomUUID(),
			status: "leased",
			startedAt: new Date().toISOString(),
			sessionDir,
			workspaceDir: workspace.cwd,
			workspaceKind: workspace.kind,
			outputPath: join(attemptDir, "output", node.outputArtifact),
		};
		await this.store.ensureManagedSubdirectory(relative(this.store.root, dirname(attempt.outputPath!)), "Attempt output directory");
		await this.transition(node.taskId, "leased", attempt, undefined, { appendAttempt: attempt });
		if (this.runInstanceId) {
			await this.writeAttemptAuthority(node.taskId, attempt, "prepared");
			await this.store.writeWorkspaceRecord(node.taskId, attempt.attempt, {
				schemaVersion: 2,
				runInstanceId: this.runInstanceId,
				graphId: this.graph.graphId,
				taskId: node.taskId,
				attempt: attempt.attempt,
				workspaceKind: workspace.kind,
				contractDigest: canonicalDigest(workspace.contract),
				writeBaseline: workspace.contract.writeBaseline,
				readBaseline: workspace.contract.readBaseline,
				inputBaseline: workspace.contract.inputBaseline,
				createdAt: new Date().toISOString(),
			});
		}
		return { attempt, workspace };
	}

	private async writeAttemptAuthority(
		taskId: string,
		attempt: NodeAttemptState,
		phase: AttemptRecord["phase"],
		patch: Pick<AttemptRecord, "requestDigest" | "asyncId" | "sessionId" | "terminalStatus" | "terminalError" | "terminalRetryKind"> = {},
	): Promise<void> {
		if (!this.runInstanceId) return;
		if (!attempt.attemptNonce) throw new Error("Graph Runtime v2 attempt is missing its nonce.");
		await this.store.writeAttemptRecord(taskId, attempt.attempt, {
			schemaVersion: 2,
			runInstanceId: this.runInstanceId,
			graphId: this.graph.graphId,
			taskId,
			attempt: attempt.attempt,
			attemptNonce: attempt.attemptNonce,
			phase,
			supervisorEpoch: this.epoch,
			fencingGeneration: this.fencingGeneration,
			...patch,
			updatedAt: new Date().toISOString(),
		});
	}

	async recordTerminalResult(node: CompiledNode, state: NodeRuntimeState, result: NodeExecutionResult): Promise<void> {
		if (!this.runInstanceId || !["failed", "stale", "stopped"].includes(result.status)) return;
		const attempt = state.attempts.at(-1);
		if (!attempt) return;
		await this.writeAttemptAuthority(node.taskId, attempt, "terminal", {
			terminalStatus: result.status as "failed" | "stale" | "stopped",
			...(result.error ? { terminalError: result.error } : {}),
			...(result.status === "failed" ? { terminalRetryKind: result.retryKind ?? "failed" } : {}),
		});
	}

	async authoritativeTerminalResult(state: NodeRuntimeState): Promise<NodeExecutionResult | undefined> {
		if (!this.runInstanceId) return undefined;
		const attempt = state.attempts.at(-1);
		if (!attempt) return undefined;
		const authority = await this.store.readAttemptRecord(state.taskId, attempt.attempt);
		if (authority.phase !== "terminal" || !authority.terminalStatus) return undefined;
		return {
			status: authority.terminalStatus,
			...(authority.terminalError ? { error: authority.terminalError } : {}),
			...(authority.terminalRetryKind ? { retryKind: authority.terminalRetryKind } : {}),
			...(authority.terminalRetryKind ? {
				failure: {
					kind: authority.terminalRetryKind === "provider" ? "provider_transient"
						: authority.terminalRetryKind === "timeout" ? "hard_deadline"
							: authority.terminalRetryKind === "dispatch" ? "dispatch_rejected"
								: authority.terminalRetryKind === "validation" ? "validation"
									: "task_failed",
					retryKind: authority.terminalRetryKind,
				},
			} : {}),
		};
	}

	private async finalizeValidatedAttempt(
		node: CompiledNode,
		attempt: NodeAttemptState,
		workspace: PreparedWorkspace,
		validation: ResultManifest["validation"],
		validatedOutputDigest: string,
		signal: AbortSignal | undefined,
		onWritesCommitted: () => void,
	): Promise<string> {
		await this.writeAttemptAuthority(node.taskId, attempt, "applying");
		const writes = await workspace.apply(signal);
		if (writes.length > 0) {
			onWritesCommitted();
			await this.transition(node.taskId, "verifying", { writesCommittedAt: new Date().toISOString() });
		}
		const canonicalOutput = this.artifactPath(node.outputArtifact);
		const manifestPath = await this.writeManifest(node, attempt, workspace, validation, writes, "complete", [], canonicalOutput);
		await this.preflightOutputPublication(node.outputArtifact);
		await this.publishOutput(attempt.outputPath!, node.outputArtifact);
		if (this.runInstanceId) {
			const [manifestDigest, outputDigest] = await Promise.all([digestFile(manifestPath), digestFile(this.artifactPath(node.outputArtifact))]);
			if (!manifestDigest || !outputDigest) throw new Error("Acceptance evidence disappeared before the acceptance record was committed.");
			if (outputDigest !== validatedOutputDigest) throw new Error("Published output does not match the validated output digest.");
			await this.store.writeAcceptance(node.taskId, attempt.attempt, {
				schemaVersion: 2,
				runInstanceId: this.runInstanceId,
				graphId: this.graph.graphId,
				taskId: node.taskId,
				attempt: attempt.attempt,
				attemptNonce: attempt.attemptNonce!,
				manifestDigest,
				outputDigest,
				acceptedAt: new Date().toISOString(),
			});
			await this.writeAttemptAuthority(node.taskId, attempt, "accepted");
		}
		await this.transition(node.taskId, "accepted", { status: "accepted", endedAt: new Date().toISOString(), manifestPath });
		await workspace.cleanup().catch(() => undefined);
		return manifestPath;
	}

	private async collectPartial(
		node: CompiledNode,
		attempt: NodeAttemptState,
		workspace: PreparedWorkspace,
		result: NodeExecutionResult,
		terminalOutput = "",
	): Promise<NodeExecutionResult> {
		if (result.status === "accepted" || result.status === "suspended") return result;
		try {
			await assertSafeAttemptOutputTarget(attempt.outputPath!, dirname(attempt.sessionDir), node.outputArtifact);
			if (!existsSync(attempt.outputPath!) && terminalOutput) await writeFile(attempt.outputPath!, terminalOutput, "utf8");
			if (existsSync(attempt.outputPath!)) await assertRegularAttemptOutput(attempt.outputPath!, dirname(attempt.sessionDir));
			const writes = await workspace.inspectWrites();
			const failure = result.failure ?? (result.retryKind ? {
				kind: result.retryKind === "provider" ? "provider_transient"
					: result.retryKind === "timeout" ? "hard_deadline"
						: result.retryKind === "dispatch" ? "dispatch_rejected"
							: result.retryKind === "validation" ? "validation"
								: "task_failed",
				retryKind: result.retryKind,
			} satisfies FailureDetails : undefined);
			const manifestPath = await this.writeManifest(
				node,
				attempt,
				workspace,
				[],
				writes,
				result.status === "stale" ? "stale" : result.status === "waiting_input" ? "blocked" : "partial",
				[result.error ?? "Attempt did not reach ACCEPTED."],
				undefined,
				failure,
			);
			return { ...result, manifestPath, ...(failure ? { failure } : {}) };
		} catch (error) {
			await this.store.event("node.partial_collection_warning", {
				error: error instanceof Error ? error.message : String(error),
			}, node.taskId).catch(() => undefined);
			return result;
		}
	}

	private async publishOutput(source: string, artifact: string): Promise<string> {
		const target = this.artifactPath(artifact);
		await this.store.assertManagedFilePath(source, "Attempt output artifact");
		await this.store.assertManagedDirectoryPath(dirname(target), "Canonical output artifact parent");
		await this.store.assertManagedFilePath(target, "Canonical output artifact");
		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await cp(source, temporary, { force: true, recursive: false });
			await this.store.assertManagedDirectoryPath(dirname(target), "Canonical output artifact parent");
			await this.store.assertManagedFilePath(temporary, "Temporary output artifact");
			await rename(temporary, target);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
		return target;
	}

	private async preflightOutputPublication(artifact: string): Promise<void> {
		const artifactsRoot = await this.store.ensureManagedSubdirectory("artifacts", "Graph artifact directory");
		const target = this.artifactPath(artifact);
		await this.store.ensureManagedSubdirectory(relative(this.store.root, dirname(target)), "Graph artifact parent");
		const [resolvedRoot, resolvedParent] = await Promise.all([realpath(artifactsRoot), realpath(dirname(target))]);
		if (!within(resolvedRoot, resolvedParent)) throw new Error("Canonical output artifact escapes the graph artifact directory through a symlink.");
		if (!existsSync(target)) return;
		await this.store.assertManagedFilePath(target, "Canonical output artifact");
		const info = await lstat(target);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error("Canonical output artifact target must be a regular file.");
	}

	private async stopAndConfirm(identity: { asyncId: string; asyncDir: string }, acceptComplete = false): Promise<boolean> {
		try {
			await this.rpc.call("stop", { id: identity.asyncId });
		} catch {
			await requestAsyncStop(identity.asyncDir);
		}
		return waitForConfirmedStop(identity.asyncDir, 30_000, { acceptFailed: true, acceptComplete });
	}

	async stopRecoveredAttempt(node: CompiledNode, attempt: NodeAttemptState): Promise<{ stopped: boolean; error?: string }> {
		try {
			const identity = attempt.asyncId && attempt.asyncDir
				? { asyncId: attempt.asyncId, asyncDir: attempt.asyncDir }
				: await this.resolveDispatch(node, attempt);
			if (!identity) {
				const lineage = this.lineage(node, attempt);
				if (lineage && attempt.workspaceDir && attempt.workspaceKind) {
					const workspace = await reopenWorkspace(node, attempt.workspaceDir, attempt.workspaceKind);
					const abandoned = await this.childRuntime.abandon(lineage, this.childParams(node, workspace, attempt), "durable graph stop");
					if (abandoned.identity && await waitForConfirmedStop(abandoned.identity.asyncDir, 30_000)) return { stopped: true };
					return { stopped: false, error: "Unknown dispatch was tombstoned, but no Child identity was available for stop confirmation." };
				}
				return { stopped: false, error: "Stop could not locate a unique child identity." };
			}
			const childState = await readAsyncRunState(identity.asyncId, identity.asyncDir);
			if (["complete", "failed", "stopped"].includes(childState ?? "")) {
				if (childState === "complete" && (node.sideEffect === "external_write" || node.allowBash)) return { stopped: false, error: "Child completed with ambient or external write authority before durable stop; reconcile its side effects." };
				return { stopped: true };
			}
			if (!await this.stopAndConfirm(identity)) return { stopped: false, error: "Child stop could not be confirmed." };
			return { stopped: true };
		} catch (error) {
			return { stopped: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async existingAttempt(node: CompiledNode, state: NodeRuntimeState): Promise<{ attempt: NodeAttemptState; workspace: PreparedWorkspace } | null> {
		const attempt = state.attempts.at(-1);
		if (!attempt?.workspaceDir || !attempt.workspaceKind) return null;
		if (!["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(state.status)) return null;
		return { attempt, workspace: await reopenWorkspace(node, attempt.workspaceDir, attempt.workspaceKind) };
	}

	async execute(node: CompiledNode, state: NodeRuntimeState, signal?: AbortSignal): Promise<NodeExecutionResult> {
		let releaseLease: (() => Promise<void>) | undefined;
		let releaseReservation: (() => Promise<void>) | undefined;
		let workspace: PreparedWorkspace | undefined;
		let attemptForPartial: NodeAttemptState | undefined;
			let writesCommitted = false;
			let validatedOutputDigest: string | undefined;
		try {
			if (node.writeScope.length) {
				releaseLease = await this.leases.acquire({ graphId: this.graph.graphId, taskId: node.taskId, epoch: this.epoch, scopes: node.writeScope }) ?? undefined;
				if (!releaseLease) return { status: "resource_wait", error: "Write scope is leased by another graph node." };
				if (this.runInstanceId) {
					const latestAttempt = state.attempts.at(-1);
					const continuingAttempt = latestAttempt
						&& latestAttempt.attempt === state.attempt
						&& ["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(latestAttempt.status);
					const attemptNumber = continuingAttempt ? state.attempt : state.attempt + 1;
					try {
						releaseReservation = await new SourceReservationRegistry(join(this.store.runsRoot, ".control")).acquire({
							runInstanceId: this.runInstanceId,
							graphId: this.graph.graphId,
							taskId: node.taskId,
							attempt: attemptNumber,
							supervisorEpoch: this.epoch,
							fencingGeneration: this.fencingGeneration,
							scopes: node.writeScope,
							attemptDir: this.store.path("nodes", node.taskId, `attempt-${attemptNumber}`),
						}) ?? undefined;
					} catch (error) {
						if (error instanceof SourceReservationBusyError) return { status: "resource_wait", error: error.message };
						throw error;
					}
					if (!releaseReservation) return { status: "resource_wait", error: "Write scope has a persistent source transaction reservation." };
				}
			}
			let existing: { attempt: NodeAttemptState; workspace: PreparedWorkspace } | null;
			try {
				existing = await this.existingAttempt(node, state);
			} catch (error) {
				return { status: "stale", error: `Recovered attempt metadata is invalid; no replacement attempt will be created: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (state.attempt > 0 && ["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(state.status) && !existing) {
				return { status: "stale", error: "Recovered attempt has incomplete workspace metadata; no replacement attempt will be created." };
			}
			const prepared = existing ?? await this.createAttempt(node, state);
			const attempt = prepared.attempt;
			attemptForPartial = attempt;
			workspace = prepared.workspace;
			if (signal?.aborted) {
				const result: NodeExecutionResult = { status: signal.reason === "suspend" ? "suspended" : "stopped", failure: { kind: "cancelled" } };
				return this.collectPartial(node, attempt, workspace, result);
			}
			const recoveredAuthority = this.runInstanceId && existing ? await this.store.readAttemptRecord(node.taskId, attempt.attempt) : undefined;
			if (recoveredAuthority?.phase === "accepted") {
				const manifestPath = attempt.manifestPath ?? this.store.path("nodes", node.taskId, `attempt-${attempt.attempt}`, "result-manifest.json");
				await this.transition(node.taskId, "accepted", { status: "accepted", endedAt: new Date().toISOString(), manifestPath });
				await workspace.cleanup().catch(() => undefined);
				return { status: "accepted" };
			}
			if (recoveredAuthority && ["validated", "applying"].includes(recoveredAuthority.phase)) {
				const validated = JSON.parse(await readFile(this.store.path("nodes", node.taskId, `attempt-${attempt.attempt}`, "validated-result.json"), "utf8")) as ValidatedResultRecord;
				validatedOutputDigest = validated.outputDigest;
				await this.finalizeValidatedAttempt(node, attempt, workspace, validated.validation, validated.outputDigest, signal, () => { writesCommitted = true; });
				return { status: "accepted" };
			}
			const recoveredState = existing ? state.status : undefined;
			let recoveredCompletedOutput = false;
			let identity = attempt.asyncId && attempt.asyncDir ? { asyncId: attempt.asyncId, asyncDir: attempt.asyncDir } : null;
			if (!identity && ["dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(state.status)) {
				try {
					identity = await this.resolveDispatch(node, attempt);
				} catch (error) {
					return { status: "stale", error: error instanceof Error ? error.message : String(error) };
				}
			}
			if (!identity && existing && ["collecting", "verifying"].includes(recoveredState ?? "") && attempt.outputPath && existsSync(attempt.outputPath)) recoveredCompletedOutput = true;
			if (!identity && existing && !recoveredCompletedOutput && recoveredState !== "leased") {
				return { status: "stale", error: "Recovered dispatch has no unique child identity. pi-graph will not create a replacement attempt for an ambiguous dispatch." };
			}
			if (!identity && !recoveredCompletedOutput) {
				if (this.runInstanceId && this.config.runtimeV2Dispatch !== true) return { status: "stale", error: "Graph Runtime v2 dispatch is gated until the ChildRuntime protocol is available." };
				const params = this.childParams(node, workspace, attempt);
				await this.transition(node.taskId, "dispatching", { status: "dispatching" });
				await this.writeAttemptAuthority(node.taskId, attempt, "dispatching", this.runInstanceId ? { requestDigest: canonicalDigest(params) } : {});
					try {
						const lineage = this.lineage(node, attempt);
						const dispatched = lineage ? await this.childRuntime.dispatch(lineage, params) : await this.rpc.spawn(params);
						identity = { asyncId: dispatched.asyncId, asyncDir: dispatched.asyncDir };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (error instanceof RpcRejectedError) {
						return this.collectPartial(node, attempt, workspace, {
							status: "failed",
							error: `Child dispatch was rejected: ${message}`,
							retryKind: "dispatch",
							failure: { kind: "dispatch_rejected", retryKind: "dispatch" },
						});
					}
					await this.transition(node.taskId, "dispatch_unknown", { status: "dispatch_unknown", error: message }, message);
					try {
						identity = await this.resolveDispatch(node, attempt);
					} catch (recoveryError) {
						return { status: "stale", error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) };
						}
						if (!identity) {
							const lineage = this.lineage(node, attempt);
							if (lineage) await this.childRuntime.abandon(lineage, params, "dispatch outcome remained unknown after recovery scan");
							return { status: "stale", error: error instanceof RpcTimeoutError ? "Dispatch outcome remained unknown after recovery scan; no replacement attempt will be created." : `Dispatch failed without a recoverable identity; no replacement attempt will be created: ${message}` };
						}
				}
				await this.transition(node.taskId, "running", { status: "running", ...identity });
				await this.writeAttemptAuthority(node.taskId, attempt, "running", { asyncId: identity.asyncId, ...(this.ownerSessionId ? { sessionId: this.ownerSessionId } : {}) });
			}
			if (signal?.aborted) {
				if (signal.reason === "suspend") return { status: "suspended" };
				if (identity && !await this.stopAndConfirm(identity)) return { status: "stale", error: "Child stop could not be confirmed." };
				return this.collectPartial(node, attempt, workspace, { status: "stopped", failure: { kind: "cancelled" } });
			}
			let terminalOutput = "";
			if (identity) {
				let terminal;
				try {
					terminal = await waitForAsyncRun({
						events: this.events,
						...identity,
						...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
						signal,
					});
				} catch (error) {
					if (signal?.aborted && signal.reason === "suspend") return { status: "suspended" };
					if (signal?.aborted) {
						if (!await this.stopAndConfirm(identity)) return { status: "stale", error: "Child stop could not be confirmed." };
						return this.collectPartial(node, attempt, workspace, { status: "stopped", failure: { kind: "cancelled" } });
					}
					if (error instanceof AsyncRunDeadlineError) {
						const acceptComplete = node.sideEffect !== "external_write" && !node.allowBash;
						if (!await this.stopAndConfirm(identity, acceptComplete)) return { status: "stale", error: "Child hard-deadline stop could not be confirmed; retry is unsafe until inspected." };
						return this.collectPartial(node, attempt, workspace, { status: "failed", error: error.message, retryKind: "timeout", failure: { kind: "hard_deadline", retryKind: "timeout" } });
					}
					return {
						status: "stale",
						error: `Child monitoring failed without stopping the child: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				if (terminal.state !== "complete") {
					const error = typeof terminal.status.error === "string" ? terminal.status.error : `Subagent ended in state ${terminal.state}.`;
					if (terminal.state === "paused") return this.collectPartial(node, attempt, workspace, { status: "waiting_input", error }, terminal.output);
					if (terminal.state === "stopped") return this.collectPartial(node, attempt, workspace, { status: "stopped", error, failure: { kind: "cancelled" } }, terminal.output);
					const failure = classifyChildFailure(terminal.status, error);
					return this.collectPartial(node, attempt, workspace, { status: "failed", error, retryKind: failure.retryKind, failure }, terminal.output);
				}
				terminalOutput = terminal.output;
			}
			const recoveringAttempt = this.runInstanceId ? await this.store.hasAttemptRecovery(node.taskId, attempt.attempt) : false;
			if (recoveringAttempt) {
				await this.writeAttemptAuthority(node.taskId, attempt, "collecting", identity ? { asyncId: identity.asyncId, ...(this.ownerSessionId ? { sessionId: this.ownerSessionId } : {}) } : {});
				await this.transition(node.taskId, "collecting", { status: "collecting" });
				await this.store.completeAttemptRecovery(node.taskId, attempt.attempt);
			} else {
				await this.transition(node.taskId, "collecting", { status: "collecting" });
				await this.writeAttemptAuthority(node.taskId, attempt, "collecting", identity ? { asyncId: identity.asyncId, ...(this.ownerSessionId ? { sessionId: this.ownerSessionId } : {}) } : {});
			}
			await this.store.ensureManagedSubdirectory("artifacts", "Graph artifact directory");
			try {
				await assertSafeAttemptOutputTarget(attempt.outputPath!, dirname(attempt.sessionDir), node.outputArtifact);
			} catch (error) {
				return this.collectPartial(node, attempt, workspace, { status: "failed", error: error instanceof Error ? error.message : String(error), retryKind: "failed" }, terminalOutput);
			}
			if (!existsSync(attempt.outputPath!) && terminalOutput) await writeFile(attempt.outputPath!, terminalOutput, "utf8");
			if (!existsSync(attempt.outputPath!)) return this.collectPartial(node, attempt, workspace, { status: "failed", error: "Subagent completed without producing its declared output artifact.", retryKind: "failed" });
			try {
				await assertRegularAttemptOutput(attempt.outputPath!, dirname(attempt.sessionDir));
			} catch (error) {
				return this.collectPartial(node, attempt, workspace, { status: "failed", error: error instanceof Error ? error.message : String(error), retryKind: "failed" });
			}
			try {
				await this.preflightOutputPublication(node.outputArtifact);
			} catch (error) {
				return this.collectPartial(node, attempt, workspace, { status: "failed", error: error instanceof Error ? error.message : String(error), retryKind: "failed" });
			}
			await this.transition(node.taskId, "verifying", { status: "verifying" });
			const validation = await runValidations(node.validationCommands ?? [], workspace.cwd, this.config.validationTimeoutMs, signal);
			if (signal?.aborted) return { status: signal.reason === "suspend" ? "suspended" : "stopped" };
			if (validation.some((result) => !result.ok)) {
				const failure: FailureDetails = { kind: "validation", retryKind: "validation" };
				const manifest = await this.writeManifest(node, attempt, workspace, validation, await workspace.inspectWrites(), "partial", ["Deterministic validation failed."], undefined, failure);
				await this.transition(node.taskId, "verifying", { manifestPath: manifest });
				return { status: "failed", error: "Deterministic validation failed.", retryKind: "validation", failure, manifestPath: manifest };
			}
			if (signal?.aborted) return { status: signal.reason === "suspend" ? "suspended" : "stopped" };
			if (this.runInstanceId) {
					validatedOutputDigest = await digestFile(attempt.outputPath!);
					if (!validatedOutputDigest) throw new Error("Validated output disappeared before its evidence record was committed.");
					await this.store.writeValidatedResult(node.taskId, attempt.attempt, {
					schemaVersion: 2,
					runInstanceId: this.runInstanceId,
					graphId: this.graph.graphId,
					taskId: node.taskId,
					attempt: attempt.attempt,
					attemptNonce: attempt.attemptNonce!,
						outputDigest: validatedOutputDigest,
					validation,
					validatedAt: new Date().toISOString(),
				});
				await this.writeAttemptAuthority(node.taskId, attempt, "validated");
			}
			await this.finalizeValidatedAttempt(node, attempt, workspace, validation, validatedOutputDigest!, signal, () => { writesCommitted = true; });
			return { status: "accepted" };
		} catch (error) {
			let result: NodeExecutionResult;
			if (signal?.aborted) result = { status: signal.reason === "suspend" ? "suspended" : "stopped", failure: { kind: "cancelled" } };
			else if (error instanceof WorkspaceConflictError) result = { status: "stale", error: error.message, failure: { kind: "workspace_conflict" } };
			else if (writesCommitted) result = { status: "stale", error: `Source writes were committed, but attempt finalization failed: ${error instanceof Error ? error.message : String(error)}` };
			else result = { status: "failed", error: error instanceof Error ? error.message : String(error), retryKind: "failed", failure: { kind: "task_failed", retryKind: "failed" } };
			if (attemptForPartial && workspace) return this.collectPartial(node, attemptForPartial, workspace, result);
			return result;
		} finally {
			try {
				if (releaseReservation) {
					const attempt = state.attempts.at(-1);
					const planStatus = attempt ? await this.store.readApplyPlanStatus(node.taskId, attempt.attempt).catch(() => "applying" as const) : undefined;
					if (planStatus !== "applying") await releaseReservation();
				}
			} catch (error) {
				await this.store.event("node.cleanup_warning", {
					error: `Source reservation cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
				}, node.taskId).catch(() => undefined);
			} finally {
				await releaseLease?.();
			}
		}
	}

	private async writeManifest(
		node: CompiledNode,
		attempt: NodeAttemptState,
		workspace: PreparedWorkspace,
		validation: ResultManifest["validation"],
		writes: ResultManifest["writes"],
		status: ResultManifest["status"],
		unresolvedQuestions: string[],
		canonicalOutputArtifact?: string,
		failure?: FailureDetails,
	): Promise<string> {
		const manifest: ResultManifest = {
			schemaVersion: GRAPH_RESULT_VERSION,
			graphId: this.graph.graphId,
			taskId: node.taskId,
			attempt: attempt.attempt,
			status,
			context: node.context ?? this.graph.context,
			inputs: await Promise.all(Object.entries(workspace.artifactPaths).map(async ([path, source]) => ({ path, digest: await digestFile(source) }))),
			reads: workspace.contract.readScope.map((entry) => entry.path),
			writes,
			validation,
			outputArtifact: attempt.outputPath!,
			outputDigest: await digestFile(attempt.outputPath!),
			...(canonicalOutputArtifact ? { canonicalOutputArtifact } : {}),
			...(failure ? { failure } : {}),
			unresolvedQuestions,
			createdAt: new Date().toISOString(),
		};
		return this.store.writeJson(join("nodes", node.taskId, `attempt-${attempt.attempt}`, "result-manifest.json"), manifest);
	}
}
