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
	ProviderDispatchState,
	ResultManifest,
	SubagentAcceptanceInput,
} from "./types.ts";
import { GRAPH_RESULT_VERSION } from "./types.ts";
import { GraphStore } from "./store.ts";
import { LeaseRegistry } from "./leases.ts";
import { digestFile, prepareWorkspace, reopenWorkspace, WorkspaceConflictError, type PreparedWorkspace } from "./workspace.ts";
import { recoverRunBySessionDir, RpcPreEmitError, RpcRejectedError, RpcTimeoutError, SubagentRpcClient, type EventBus } from "./rpc.ts";
import { AsyncRunDeadlineError, readAsyncRunState, requestAsyncStop, waitForAsyncRun, waitForConfirmedStop, waitForObservedProcessTerminal, type AsyncTerminal } from "./lifecycle.ts";
import { runValidations } from "./validation.ts";
import { canonicalDigest, type AttemptRecord, type ValidatedResultRecord } from "./authority.ts";
import { SourceReservationBusyError, SourceReservationRegistry } from "./reservations.ts";
import { ChildPreparePreEmitError, ChildRuntime, type ChildLineage } from "./child-runtime.ts";
import { classifyChildFailure } from "./failure.ts";
import { authorizeLegacyMax, blockGraphRoutingDecision, resolveGraphRoutingDecision } from "./model-routing-adapter.ts";
import { availableModelsDigest } from "./model-routing/evaluate-routing-policy.ts";
import { createModelExecution } from "./model-routing/model-execution.ts";
import { defaultMaxAuthorizationStore } from "./model-routing/runtime-state.ts";
import type { MaxAuthorizationStore, ModelRoutingConfig } from "./model-routing/types.ts";
import { auditManagedLaunchContracts, type AvailableModelSnapshot } from "./pi-subagents-preflight.ts";
import { Check } from "typebox/value";

export interface TransitionOptions {
	statePatch?: Partial<Pick<NodeRuntimeState, "nextRetryAt" | "resourceWaitStartedAt" | "failure">>;
	appendAttempt?: NodeAttemptState;
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function validateTypedOutput(node: Pick<CompiledNode, "output">, path: string): Promise<void> {
	if (!node.output) return;
	const bytes = await readFile(path);
	const type = node.output.type;
	let text = "";
	if (type !== "screenshot" && type !== "file") {
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(`Typed output '${type}' must contain valid UTF-8.`); }
	} else {
		text = bytes.toString("utf8");
	}
	let decoded: unknown;
	if (["json", "table", "citation-set", "connector-record", "decision"].includes(type)) {
		try { decoded = JSON.parse(text); } catch { throw new Error(`Typed output '${type}' must contain valid JSON.`); }
	}
	if (["text", "document", "email-draft", "url"].includes(type) && bytes.includes(0)) throw new Error(`Typed output '${type}' must be UTF-8 text without NUL bytes.`);
	if (type === "url") {
		try {
			const url = new URL(text.trim());
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
		} catch { throw new Error("Typed output 'url' must contain one absolute HTTP(S) URL."); }
	}
	if (type === "table") {
		const valid = Array.isArray(decoded) || (record(decoded) && Array.isArray(decoded.columns) && Array.isArray(decoded.rows));
		if (!valid) throw new Error("Typed output 'table' must be a JSON row array or {columns,rows} object.");
	}
	if (type === "citation-set") {
		if (!Array.isArray(decoded) || decoded.some((entry) => {
			if (!record(entry) || typeof entry.url !== "string") return true;
			try { return !["http:", "https:"].includes(new URL(entry.url).protocol); } catch { return true; }
		})) throw new Error("Typed output 'citation-set' must be a JSON array whose entries contain absolute HTTP(S) url fields.");
	}
	if (type === "connector-record" && (!record(decoded) || typeof decoded.service !== "string" || !(typeof decoded.recordId === "string" || typeof decoded.id === "string"))) throw new Error("Typed output 'connector-record' must contain service and recordId or id.");
	if (type === "decision" && (!record(decoded) || typeof decoded.decision !== "string" || !decoded.decision.trim() || !Array.isArray(decoded.reasons))) throw new Error("Typed output 'decision' must contain a non-empty decision and reasons array.");
	if (type === "screenshot") {
		const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
		if (!png && !jpeg) throw new Error("Typed output 'screenshot' must be a PNG or JPEG file.");
	}
	if (node.output.mediaType) {
		const media = node.output.mediaType.toLowerCase();
		if (["json", "table", "citation-set", "connector-record", "decision"].includes(type) && !/(?:\/|\+)json$/u.test(media)) throw new Error(`Typed output '${type}' requires a JSON mediaType.`);
		if (type === "screenshot" && !["image/png", "image/jpeg"].includes(media)) throw new Error("Typed output 'screenshot' mediaType must be image/png or image/jpeg.");
	}
	if (node.output.schema) {
		let schema: unknown;
		try { schema = JSON.parse(node.output.schema); } catch { throw new Error("Typed output schema must be an inline JSON Schema string."); }
		if (!record(schema) || !Check(schema as never, decoded ?? text)) throw new Error(`Typed output '${type}' does not satisfy its declared JSON Schema.`);
	}
}

interface ProviderWorkspaceResetRecord {
	schemaVersion: 1;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	nextDispatch: number;
	phase: "prepared" | "complete";
	contractDigest: string;
	preparedAt: string;
	completedAt?: string;
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

function graphChildWorkflowKey(lineage: ChildLineage): string {
	return [lineage.taskId, `attempt-${lineage.attempt}`, `dispatch-${lineage.providerDispatch ?? 1}`]
		.join("-")
		.replace(/[^A-Za-z0-9._-]/gu, "-")
		.slice(0, 128);
}

function graphOuterWorkflowParams(lineage: ChildLineage, innerParams: Record<string, unknown>): Record<string, unknown> {
	return {
		workflowScript: `return await runs.run(${JSON.stringify(graphChildWorkflowKey(lineage))}, ${JSON.stringify(innerParams)});`,
		async: true,
		cwd: innerParams.cwd,
		artifacts: true,
		mission: false,
		sessionDir: join(dirname(lineage.sessionDir), `outer-session-${canonicalDigest({ lineage }).slice(0, 16)}`),
	};
}

const DEFAULT_CHILD_ACCEPTANCE = {
	level: "none",
	reason: "Acceptance is enforced by the pi-graph supervisor.",
} as const satisfies SubagentAcceptanceInput;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertValidChildAcceptance(value: unknown): asserts value is SubagentAcceptanceInput {
	if (value === false) return;
	if (typeof value === "string") {
		if (["auto", "attested", "checked", "verified"].includes(value)) return;
		throw new Error("childAcceptance must be false, a supported bare level, or an acceptance config object.");
	}
	if (!isRecord(value)) throw new Error("childAcceptance must be false, a supported bare level, or an acceptance config object.");
	if (value.level !== undefined && (typeof value.level !== "string" || !["auto", "none", "attested", "checked", "verified"].includes(value.level))) {
		throw new Error("childAcceptance.level is unsupported.");
	}
	if (value.criteria === undefined) return;
	if (!Array.isArray(value.criteria)) throw new Error("childAcceptance.criteria must be an array.");
	for (const [index, criterion] of value.criteria.entries()) {
		if (typeof criterion === "string") {
			if (criterion.trim()) continue;
			throw new Error(`childAcceptance.criteria[${index}] must be a non-empty string or criterion object.`);
		}
		if (!isRecord(criterion)) throw new Error(`childAcceptance.criteria[${index}] must be a non-empty string or criterion object.`);
		if (typeof criterion.id !== "string" || !criterion.id.trim()) throw new Error(`childAcceptance.criteria[${index}].id must be a non-empty string.`);
		if (typeof criterion.must !== "string" || !criterion.must.trim()) throw new Error(`childAcceptance.criteria[${index}].must must be a non-empty string.`);
	}
}

/** Select child-layer acceptance without consulting Graph supervisor acceptance. */
export function childAcceptanceFor(node: { acceptance?: unknown; childAcceptance?: unknown }): SubagentAcceptanceInput {
	if (node.childAcceptance === undefined) return { ...DEFAULT_CHILD_ACCEPTANCE };
	assertValidChildAcceptance(node.childAcceptance);
	return node.childAcceptance;
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

function graphAcceptancePrompt(node: CompiledNode): string[] {
	const acceptance = node.acceptance;
	if (acceptance === undefined || acceptance === false) return [];
	const heading = "Graph acceptance criteria (declared to this child and persisted for Supervisor/parent inspection):";
	if (typeof acceptance === "string") return [heading, acceptance];
	if (acceptance === true) {
		const commands = node.validationCommands ?? [];
		return [
			heading,
			"Acceptance is determined by the node's validationCommands.",
			...(commands.length > 0 ? commands.map((command) => `- ${command}`) : ["- No validationCommands are configured."]),
		];
	}
	if (!isRecord(acceptance) || !Array.isArray(acceptance.criteria)) return [];
	const criteria = acceptance.criteria.flatMap((criterion) => {
		if (typeof criterion === "string" && criterion.trim()) return [`- ${criterion}`];
		if (!isRecord(criterion) || typeof criterion.must !== "string" || !criterion.must.trim()) return [];
		return [`- ${typeof criterion.id === "string" && criterion.id ? `[${criterion.id}] ` : ""}${criterion.must}`];
	});
	return criteria.length > 0 ? [heading, ...criteria] : [];
}

export function taskPrompt(graph: CompiledGraph, node: CompiledNode, workspace: PreparedWorkspace, lineage?: ChildLineage): string {
	const inputs = Object.entries(workspace.artifactPaths).map(([name, path]) => `- ${name}: ${path}`);
	return [
		`[pi-graph node ${graph.graphId}/${node.taskId}]`,
		...(lineage ? [`[pi-graph lineage ${lineage.runInstanceId}/${lineage.taskId}/${lineage.attempt}/${lineage.attemptNonce}]`] : []),
		`Graph goal: ${graph.goal}`,
		"Work only inside the isolated workspace and obey .pi-graph/node-contract.json.",
		"If .pi-graph/recovery-handoff.md exists, read it before working. It contains bounded evidence from the prior attempt; this workspace is still a fresh isolated copy.",
		...(workspace.sourceGitEvidencePath ? [`Read ${workspace.sourceGitEvidencePath} before claiming anything about Git status, HEAD, or uncommitted differences. It contains the Supervisor-captured Git evidence limited to the declared read scope.`] : []),
		`Declared side effect: ${node.sideEffect}`,
		...(node.resourceScopes?.length ? [`Declared remote resource scopes: ${JSON.stringify(node.resourceScopes)}`] : []),
		...(node.externalAction ? [`Declared external action contract: ${JSON.stringify(node.externalAction)}`] : []),
		inputs.length ? `Input artifacts:\n${inputs.join("\n")}` : "Input artifacts: none",
		...graphAcceptancePrompt(node),
		"Complete only this node. Report evidence, changed files, validation performed, and unresolved blockers.",
		"",
		node.task,
	].join("\n");
}

export function runtimeLaunchContractDigest(terminal: AsyncTerminal): string | undefined {
	const statusSteps = Array.isArray(terminal.status.steps) ? terminal.status.steps : [];
	const completionResults = Array.isArray(terminal.completion?.results) ? terminal.completion.results : [];
	const digests: string[] = [];
	let invalid = false;
	for (const candidate of [...statusSteps, ...completionResults, terminal.status, terminal.completion]) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		if (!Object.hasOwn(candidate, "launchContractDigest")) continue;
		const digest = (candidate as Record<string, unknown>).launchContractDigest;
		if (typeof digest === "string" && /^[a-f0-9]{64}$/i.test(digest)) digests.push(digest);
		else invalid = true;
	}
	const unique = new Set(digests);
	return !invalid && unique.size === 1 ? digests[0] : undefined;
}

export function runtimeAcknowledgesExtension(terminal: AsyncTerminal, expectedId: string): boolean {
	const statusSteps = Array.isArray(terminal.status.steps) ? terminal.status.steps : [];
	const completionResults = Array.isArray(terminal.completion?.results) ? terminal.completion.results : [];
	const acknowledgements: unknown[] = [];
	for (const candidate of [...statusSteps, ...completionResults, terminal.status, terminal.completion]) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		if (Object.hasOwn(candidate, "runtimeAcknowledgedExtensions")) {
			acknowledgements.push((candidate as Record<string, unknown>).runtimeAcknowledgedExtensions);
		}
	}
	if (acknowledgements.length === 0) return false;
	return acknowledgements.every((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const projection = value as Record<string, unknown>;
		return projection.version === 1
			&& projection.source === "child-runtime"
			&& projection.omitted === 0
			&& Array.isArray(projection.ids)
			&& projection.ids.every((id) => typeof id === "string")
			&& projection.ids.includes(expectedId);
	});
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

	dispose(options: { preserveReapers?: boolean } = {}): boolean {
		return this.childRuntime.dispose(options);
	}
	private readonly routingConfig?: ModelRoutingConfig;
	private readonly maxAuthorizationStore: MaxAuthorizationStore;
	private readonly availableModels?: ReadonlyArray<AvailableModelSnapshot> | (() => ReadonlyArray<AvailableModelSnapshot> | undefined);
	private readonly orchestratorIntercomTarget?: string;
	constructor(
		graph: CompiledGraph,
		store: GraphStore,
		rpc: SubagentRpcClient,
		events: EventBus,
		leases: LeaseRegistry,
		config: GraphConfig,
		epoch: string,
		ownerSessionId: string | undefined,
		runtimeIdentity: { runInstanceId?: string; fencingGeneration?: number; ownerSessionFile?: string; orchestratorIntercomTarget?: string },
		transition: Transition,
		routingConfig?: ModelRoutingConfig,
		maxAuthorizationStore: MaxAuthorizationStore = defaultMaxAuthorizationStore,
		availableModels?: ReadonlyArray<AvailableModelSnapshot> | (() => ReadonlyArray<AvailableModelSnapshot> | undefined),
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
		this.childRuntime = new ChildRuntime(rpc, 2_000, 24 * 60 * 60_000, 20, 250, 30_000, runtimeIdentity.ownerSessionFile);
		this.routingConfig = routingConfig;
		this.maxAuthorizationStore = maxAuthorizationStore;
		this.availableModels = availableModels;
		this.orchestratorIntercomTarget = runtimeIdentity.orchestratorIntercomTarget;
	}

	private managedLaunchAuditInput(workspaceKind: "shadow" | "git"): { graphWorkspaceKind: "shadow" | "git"; orchestratorIntercomTarget?: string } {
		return {
			graphWorkspaceKind: workspaceKind,
			...(this.orchestratorIntercomTarget ? { orchestratorIntercomTarget: this.orchestratorIntercomTarget } : {}),
		};
	}

	private currentAvailableModels(): ReadonlyArray<AvailableModelSnapshot> | undefined {
		return typeof this.availableModels === "function" ? this.availableModels() : this.availableModels;
	}

	setSupervisorIdentity(epoch: string, ownerSessionId?: string, fencingGeneration?: number): void {
		this.epoch = epoch;
		this.ownerSessionId = ownerSessionId;
		if (fencingGeneration !== undefined) this.fencingGeneration = fencingGeneration;
	}

	private artifactPath(name: string): string {
		return this.store.path("artifacts", name);
	}

	private lineage(node: CompiledNode, attempt: NodeAttemptState, providerDispatch?: ProviderDispatchState): ChildLineage | undefined {
		if (!this.runInstanceId || !attempt.attemptNonce) return undefined;
		return {
			runInstanceId: this.runInstanceId,
			graphId: this.graph.graphId,
			taskId: node.taskId,
			attempt: attempt.attempt,
			attemptNonce: attempt.attemptNonce,
			sessionDir: providerDispatch?.sessionDir ?? attempt.sessionDir,
			...(providerDispatch && providerDispatch.dispatch > 1 ? { providerDispatch: providerDispatch.dispatch } : {}),
			...(this.ownerSessionId ? { ownerSessionId: this.ownerSessionId } : {}),
		};
	}

	private childParams(node: CompiledNode, workspace: PreparedWorkspace, attempt: NodeAttemptState, providerDispatch?: ProviderDispatchState): Record<string, unknown> {
		const lineage = this.lineage(node, attempt, providerDispatch);
		const selectedModel = attempt.routingDecision?.enforcement === "require"
			? attempt.routingDecision.selectedModel
			: modelOverride(node);
		return {
			agent: node.agent,
			task: taskPrompt(this.graph, node, workspace, lineage),
			cwd: workspace.cwd,
			context: "fresh",
			async: true,
			...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
			sessionDir: providerDispatch?.sessionDir ?? attempt.sessionDir,
			agentScope: "both",
			artifacts: true,
			output: attempt.outputPath,
			outputMode: "file-only",
			...(selectedModel ? { model: selectedModel } : {}),
			...(node.progress !== undefined ? { progress: node.progress } : {}),
			...(node.toolBudget ? { toolBudget: node.toolBudget } : {}),
			acceptance: childAcceptanceFor(node),
		};
	}

	private async resolveDispatch(node: CompiledNode, attemptState: NodeAttemptState, providerDispatch?: ProviderDispatchState): Promise<{ asyncId: string; asyncDir: string } | null> {
		const lineage = this.lineage(node, attemptState, providerDispatch);
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const recovered = lineage
				? await this.childRuntime.lookup(lineage)
				: this.runInstanceId && !this.ownerSessionId
					? null
					: await recoverRunBySessionDir(providerDispatch?.sessionDir ?? attemptState.sessionDir, undefined, this.ownerSessionId);
			if (recovered) return recovered;
			await delay(500);
		}
		return null;
	}

	private async createAttempt(node: CompiledNode, state: NodeRuntimeState): Promise<{ attempt: NodeAttemptState; workspace: PreparedWorkspace }> {
		const number = state.attempt + 1;
		if (this.runInstanceId) {
			try {
				const orphaned = await this.store.readAttemptRecord(node.taskId, number);
				if (orphaned.phase !== "prepared" || orphaned.requestDigest !== undefined || orphaned.asyncId !== undefined) throw new Error("orphaned attempt authority crossed the child dispatch boundary");
				const workspaceRecord = await this.store.readWorkspaceRecord(node.taskId, number);
				const workspaceDir = workspaceRecord.workspaceDir ?? this.store.path("nodes", node.taskId, `attempt-${number}`, workspaceRecord.workspaceKind === "git" ? "worktree" : "workspace");
				const workspace = await reopenWorkspace(node, workspaceDir, workspaceRecord.workspaceKind, [this.store.runsRoot]);
				if (canonicalDigest(workspace.contract) !== workspaceRecord.contractDigest) throw new Error("orphaned workspace contract digest changed");
				const sessionDir = this.store.path("nodes", node.taskId, `attempt-${number}`, "session");
				const attempt: NodeAttemptState = {
					attempt: number,
					attemptNonce: orphaned.attemptNonce,
					status: "leased",
					startedAt: orphaned.updatedAt,
					sessionDir,
					workspaceDir: workspace.cwd,
					workspaceKind: workspace.kind,
					outputPath: this.store.path("nodes", node.taskId, `attempt-${number}`, "output", node.outputArtifact),
					...(orphaned.routingDecision ? { routingDecision: orphaned.routingDecision } : {}),
					...(orphaned.launchContractDigest && orphaned.extensionContentDigest ? { providerDispatches: [{
						dispatch: 1,
						status: "prepared",
						sessionDir,
						startedAt: orphaned.updatedAt,
						launchContractDigest: orphaned.launchContractDigest,
						extensionContentDigest: orphaned.extensionContentDigest,
					}] } : {}),
				};
				if (this.config.runtimeV2Dispatch === true && !attempt.providerDispatches?.length) {
					const providerDispatch: ProviderDispatchState = { dispatch: 1, status: "prepared", sessionDir, startedAt: orphaned.updatedAt };
					const audit = await auditManagedLaunchContracts({ tasks: [this.childParams(node, workspace, attempt, providerDispatch)], cwd: node.cwd, requireExtensionSeal: true, ...this.managedLaunchAuditInput(workspace.kind) });
					const launchContractDigest = audit.contracts[0]?.launchContractDigest;
					const extensionContentDigest = audit.contracts[0]?.extensionContentDigest;
					if (!audit.ok || !launchContractDigest || !extensionContentDigest) throw new Error(`orphaned attempt guard seal cannot be rebuilt: ${audit.issues.join(" ")}`);
					Object.assign(providerDispatch, { launchContractDigest, extensionContentDigest });
					attempt.providerDispatches = [providerDispatch];
					await this.store.writeAttemptRecord(node.taskId, number, { ...orphaned, launchContractDigest, extensionContentDigest, updatedAt: new Date().toISOString() });
				}
				await this.transition(node.taskId, "leased", attempt, undefined, { appendAttempt: attempt });
				return { attempt, workspace };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot recover authority prepared before its snapshot projection: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		let routingModels = this.currentAvailableModels();
		let routingDecision = await resolveGraphRoutingDecision({
			graph: this.graph,
			node,
			state,
			store: this.store,
			config: this.routingConfig,
			authorizationStore: this.maxAuthorizationStore,
			availableModels: routingModels,
			consumeMaxAuthorization: false,
		});
		if (!routingDecision) await authorizeLegacyMax(this.graph, node, this.routingConfig, this.maxAuthorizationStore);
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
			protectedSourceRoots: [this.store.runsRoot],
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
			...(routingDecision ? { routingDecision } : {}),
		};
		const preflightModels = this.currentAvailableModels();
		if (routingDecision?.enforcement === "require" && routingDecision.availableModelsDigest !== availableModelsDigest(preflightModels)) {
			routingModels = preflightModels;
			routingDecision = await resolveGraphRoutingDecision({
				graph: this.graph,
				node,
				state,
				store: this.store,
				config: this.routingConfig,
				authorizationStore: this.maxAuthorizationStore,
				availableModels: routingModels,
				consumeMaxAuthorization: false,
			});
			if (routingDecision) attempt.routingDecision = routingDecision;
			else delete attempt.routingDecision;
		}
		const controlledRouting = routingDecision?.enforcement === "require" && Boolean(routingDecision.selectedModel);
		const requiresRuntimeGuardSeal = Boolean(this.runInstanceId) && this.config.runtimeV2Dispatch === true && routingDecision?.fallbackLevel !== "L3";
		if (controlledRouting || requiresRuntimeGuardSeal) {
			const providerDispatch: ProviderDispatchState = { dispatch: 1, status: "prepared", sessionDir, startedAt: new Date().toISOString() };
			const params = this.childParams(node, workspace, attempt, providerDispatch);
			const audit = await auditManagedLaunchContracts({ tasks: [params], cwd: node.cwd, ...(controlledRouting ? { availableModels: routingModels } : {}), requireExtensionSeal: true, requireModelSeal: controlledRouting, ...this.managedLaunchAuditInput(workspace.kind) });
			const expectedLaunchContractDigest = audit.contracts[0]?.launchContractDigest;
			const expectedExtensionContentDigest = audit.contracts[0]?.extensionContentDigest;
			if (!audit.ok || !expectedLaunchContractDigest || !expectedExtensionContentDigest) {
				const reason = audit.issues.join(" ") || "the launch contract or Extension content digest is missing";
				if (controlledRouting) {
					routingDecision = blockGraphRoutingDecision(routingDecision!, `Controlled Graph routing preflight failed before authorization consumption: ${reason}`);
					attempt.routingDecision = routingDecision;
				} else {
					attempt.error = `Graph Runtime v2 guard preflight failed before dispatch: ${reason}`;
					attempt.failure = { kind: "routing_preflight_drift", retryKind: "failed" };
				}
			} else {
				providerDispatch.launchContractDigest = expectedLaunchContractDigest;
				providerDispatch.extensionContentDigest = expectedExtensionContentDigest;
				attempt.providerDispatches = [providerDispatch];
				if (controlledRouting && node.maxAuthorization && routingDecision!.selectedModel!.endsWith(":max")) {
					const authorizationModels = this.currentAvailableModels();
					if (availableModelsDigest(authorizationModels) !== routingDecision!.availableModelsDigest) {
						routingDecision = blockGraphRoutingDecision(routingDecision!, "The active Pi model registry changed before max authorization could be consumed.");
						attempt.routingDecision = routingDecision;
						delete attempt.providerDispatches;
					} else {
						const committedDecision = await resolveGraphRoutingDecision({
							graph: this.graph,
							node,
							state,
							store: this.store,
							config: this.routingConfig,
							authorizationStore: this.maxAuthorizationStore,
							availableModels: authorizationModels,
							consumeMaxAuthorization: true,
						});
						if (!committedDecision || committedDecision.fallbackLevel === "L3" || committedDecision.selectedModel !== routingDecision!.selectedModel) {
							routingDecision = blockGraphRoutingDecision(routingDecision!, "Controlled Graph routing changed while finalizing max authorization.");
							attempt.routingDecision = routingDecision;
							delete attempt.providerDispatches;
						} else {
							routingDecision = committedDecision;
							attempt.routingDecision = committedDecision;
						}
					}
				}
			}
		}
		await this.store.ensureManagedSubdirectory(relative(this.store.root, dirname(attempt.outputPath!)), "Attempt output directory");
		if (this.runInstanceId) {
			const sealedDispatch = attempt.providerDispatches?.[0];
			await this.writeAttemptAuthority(node.taskId, attempt, "prepared", sealedDispatch ? {
				...(sealedDispatch.launchContractDigest ? { launchContractDigest: sealedDispatch.launchContractDigest } : {}),
				...(sealedDispatch.extensionContentDigest ? { extensionContentDigest: sealedDispatch.extensionContentDigest } : {}),
			} : {});
			await this.store.writeWorkspaceRecord(node.taskId, attempt.attempt, {
				schemaVersion: 2,
				runInstanceId: this.runInstanceId,
				graphId: this.graph.graphId,
				taskId: node.taskId,
				attempt: attempt.attempt,
				workspaceKind: workspace.kind,
				workspaceDir: workspace.cwd,
				contractDigest: canonicalDigest(workspace.contract),
				writeBaseline: workspace.contract.writeBaseline,
				readBaseline: workspace.contract.readBaseline,
				inputBaseline: workspace.contract.inputBaseline,
				createdAt: new Date().toISOString(),
			});
		}
		await this.transition(node.taskId, "leased", attempt, undefined, { appendAttempt: attempt });
		return { attempt, workspace };
	}

	private providerWorkspaceResetPath(node: CompiledNode, attempt: NodeAttemptState): string {
		return this.store.path("nodes", node.taskId, `attempt-${attempt.attempt}`, "provider-workspace-reset.json");
	}

	private async readProviderWorkspaceReset(node: CompiledNode, attempt: NodeAttemptState): Promise<ProviderWorkspaceResetRecord | undefined> {
		const path = this.providerWorkspaceResetPath(node, attempt);
		try {
			await this.store.assertManagedFilePath(path, "Provider workspace reset journal");
			const value = JSON.parse(await readFile(path, "utf8")) as Partial<ProviderWorkspaceResetRecord>;
			if (value.schemaVersion !== 1 || value.graphId !== this.graph.graphId || value.taskId !== node.taskId || value.attempt !== attempt.attempt || value.attemptNonce !== attempt.attemptNonce || !Number.isInteger(value.nextDispatch) || value.nextDispatch! < 2 || !["prepared", "complete"].includes(value.phase ?? "") || typeof value.contractDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.contractDigest) || typeof value.preparedAt !== "string") throw new Error("Invalid provider workspace reset journal.");
			return value as ProviderWorkspaceResetRecord;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async removeManagedFileIfPresent(path: string, label: string): Promise<void> {
		try {
			await this.store.assertManagedFilePath(path, label);
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new WorkspaceConflictError(`${label} must be a single regular file.`);
			await rm(path, { force: false });
			await this.store.assertManagedDirectoryPath(dirname(path), `${label} parent`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}

	private async discardProviderWorkspace(attemptDir: string, workspaceDir: string): Promise<void> {
		await this.store.assertManagedDirectoryPath(attemptDir, "Provider retry attempt directory");
		try {
			await lstat(workspaceDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		await this.store.assertManagedDirectoryPath(workspaceDir, "Provider retry workspace");
		const quarantine = join(attemptDir, `.provider-workspace-reset-${randomUUID()}`);
		try {
			await lstat(quarantine);
			throw new WorkspaceConflictError("Provider retry workspace quarantine already exists.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await rename(workspaceDir, quarantine);
		await this.store.assertManagedDirectoryPath(attemptDir, "Provider retry attempt directory after quarantine");
		await this.store.assertManagedDirectoryPath(quarantine, "Provider retry workspace quarantine");
		await rm(quarantine, { recursive: true, force: false });
		await this.store.assertManagedDirectoryPath(attemptDir, "Provider retry attempt directory after cleanup");
	}

	private async completeProviderWorkspaceReset(node: CompiledNode, attempt: NodeAttemptState, record: ProviderWorkspaceResetRecord): Promise<PreparedWorkspace> {
		const attemptDir = this.store.path("nodes", node.taskId, `attempt-${attempt.attempt}`);
		const workspaceDir = join(attemptDir, "workspace");
		if (attempt.workspaceKind !== "shadow" || attempt.workspaceDir !== workspaceDir) throw new WorkspaceConflictError("Automatic provider retry workspace reset is supported only for the sealed shadow workspace.");
		if (record.phase === "complete") {
			try {
				await this.store.assertManagedDirectoryPath(workspaceDir, "Completed provider retry workspace");
				const reopened = await reopenWorkspace(node, workspaceDir, "shadow", [this.store.runsRoot]);
				if (canonicalDigest(reopened.contract) === record.contractDigest) return reopened;
			} catch {
				// A crash may leave a partial replacement; rebuild it from the journal.
			}
		}
		await this.discardProviderWorkspace(attemptDir, workspaceDir);
		await this.store.assertManagedDirectoryPath(attemptDir, "Provider retry attempt directory before rebuild");
		const artifacts = (node.inputArtifacts ?? []).map((name) => ({ name, source: this.artifactPath(name) }));
		const refreshed = await prepareWorkspace({
			graphId: this.graph.graphId,
			node,
			attempt: attempt.attempt,
			attemptDir,
			strategy: "shadow",
			protectedSourceRoots: [this.store.runsRoot],
			contextDigest: node.context?.digest ?? this.graph.context?.digest,
			artifacts,
		});
		await this.store.assertManagedDirectoryPath(workspaceDir, "Rebuilt provider retry workspace");
		if (refreshed.kind !== "shadow" || canonicalDigest(refreshed.contract) !== record.contractDigest) {
			await refreshed.cleanup().catch(() => undefined);
			throw new WorkspaceConflictError("Provider retry source, input, Git, or workspace contract changed while rebuilding a clean workspace.");
		}
		await this.store.writeJson(relative(this.store.root, this.providerWorkspaceResetPath(node, attempt)), { ...record, phase: "complete", completedAt: new Date().toISOString() });
		return refreshed;
	}

	private async resetProviderWorkspace(node: CompiledNode, attempt: NodeAttemptState, workspace: PreparedWorkspace, nextDispatch: number): Promise<PreparedWorkspace> {
		if (!attempt.attemptNonce) throw new WorkspaceConflictError("Provider retry workspace reset requires an attempt nonce.");
		let record = await this.readProviderWorkspaceReset(node, attempt);
		if (record && record.nextDispatch !== nextDispatch) throw new WorkspaceConflictError("Provider retry workspace reset journal belongs to a different dispatch generation.");
		if (!record) {
			record = {
				schemaVersion: 1,
				graphId: this.graph.graphId,
				taskId: node.taskId,
				attempt: attempt.attempt,
				attemptNonce: attempt.attemptNonce,
				nextDispatch,
				phase: "prepared",
				contractDigest: canonicalDigest(workspace.contract),
				preparedAt: new Date().toISOString(),
			};
			await this.store.writeJson(relative(this.store.root, this.providerWorkspaceResetPath(node, attempt)), record);
		}
		return this.completeProviderWorkspaceReset(node, attempt, record);
	}

	private async writeAttemptAuthority(
		taskId: string,
		attempt: NodeAttemptState,
		phase: AttemptRecord["phase"],
		patch: Pick<AttemptRecord, "requestDigest" | "launchContractDigest" | "extensionContentDigest" | "runtimeLaunchContractDigest" | "runtimeGuardAcknowledged" | "asyncId" | "sessionId" | "terminalStatus" | "terminalError" | "terminalRetryKind" | "routingDecision"> = {},
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
			...(attempt.routingDecision ? { routingDecision: attempt.routingDecision } : {}),
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

	private async stopAttemptAndConfirm(
		node: CompiledNode,
		attempt: NodeAttemptState,
		workspace: PreparedWorkspace | undefined,
		providerDispatch: ProviderDispatchState | undefined,
		identity: { asyncId: string; asyncDir: string },
		reason: string,
		acceptComplete = false,
	): Promise<boolean> {
		const lineage = this.lineage(node, attempt, providerDispatch);
		if (!lineage) return this.stopAndConfirm(identity, acceptComplete);
		const stopping = this.stopAndConfirm(identity, acceptComplete).catch(() => false);
		let abandoned: Awaited<ReturnType<ChildRuntime["abandon"]>> | undefined | null;
		try {
			abandoned = await this.childRuntime.abandonKnown(lineage, reason);
		} catch {
			abandoned = null;
		}
		if (!abandoned && workspace) abandoned = await this.childRuntime.abandon(lineage, this.childParams(node, workspace, attempt, providerDispatch), reason).catch(() => null);
		if (!abandoned && providerDispatch?.requestDigest) abandoned = await this.childRuntime.abandonAuthorized(lineage, providerDispatch.requestDigest, reason).catch(() => null);
		if (!abandoned) abandoned = await this.childRuntime.abandonRecovered(lineage, reason).catch(() => null);
		if (abandoned?.stopped) return true;
		return stopping;
	}

	async stopRecoveredAttempt(node: CompiledNode, attempt: NodeAttemptState): Promise<{ stopped: boolean; error?: string }> {
		try {
			const providerDispatch = attempt.providerDispatches?.at(-1);
			let workspace: PreparedWorkspace | undefined;
			if (attempt.workspaceDir && attempt.workspaceKind) {
				try { workspace = await reopenWorkspace(node, attempt.workspaceDir, attempt.workspaceKind, [this.store.runsRoot]); }
				catch { /* Durable dispatch abandonment does not require the workspace. */ }
			}
			const identity = providerDispatch?.asyncId && providerDispatch.asyncDir
				? { asyncId: providerDispatch.asyncId, asyncDir: providerDispatch.asyncDir }
				: attempt.asyncId && attempt.asyncDir
					? { asyncId: attempt.asyncId, asyncDir: attempt.asyncDir }
					: await this.resolveDispatch(node, attempt, providerDispatch);
			if (!identity) {
				const lineage = this.lineage(node, attempt, providerDispatch);
				if (lineage) {
					let abandoned = await this.childRuntime.abandonKnown(lineage, "durable graph stop").catch(() => null);
					if (!abandoned && workspace) abandoned = await this.childRuntime.abandon(lineage, this.childParams(node, workspace, attempt, providerDispatch), "durable graph stop").catch(() => null);
					if (!abandoned && providerDispatch?.requestDigest) abandoned = await this.childRuntime.abandonAuthorized(lineage, providerDispatch.requestDigest, "durable graph stop");
					if (!abandoned) abandoned = await this.childRuntime.abandonRecovered(lineage, "durable graph stop");
					if (!abandoned) return { stopped: false, error: "Stop could not find an authorized dispatch ledger or a unique child identity." };
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
			if (!await this.stopAttemptAndConfirm(node, attempt, workspace, providerDispatch, identity, "durable graph stop could not confirm child termination")) {
				return { stopped: false, error: "Child stop could not be confirmed; durable tombstone enforcement remains active." };
			}
			return { stopped: true };
		} catch (error) {
			return { stopped: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async existingAttempt(node: CompiledNode, state: NodeRuntimeState): Promise<{ attempt: NodeAttemptState; workspace: PreparedWorkspace } | null> {
		const attempt = state.attempts.at(-1);
		if (!attempt?.workspaceDir || !attempt.workspaceKind) return null;
		if (!["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(state.status)) return null;
		const reset = await this.readProviderWorkspaceReset(node, attempt);
		if (reset) {
			const workspace = await this.completeProviderWorkspaceReset(node, attempt, reset);
			if (attempt.providerDispatches?.at(-1)?.dispatch === reset.nextDispatch) {
				await this.removeManagedFileIfPresent(this.providerWorkspaceResetPath(node, attempt), "Completed provider workspace reset journal");
			}
			return { attempt, workspace };
		}
		return { attempt, workspace: await reopenWorkspace(node, attempt.workspaceDir, attempt.workspaceKind, [this.store.runsRoot]) };
	}

	async execute(node: CompiledNode, state: NodeRuntimeState, signal?: AbortSignal): Promise<NodeExecutionResult> {
		let releaseLease: (() => Promise<void>) | undefined;
		let releaseReservation: (() => Promise<void>) | undefined;
		let workspace: PreparedWorkspace | undefined;
		let attemptForPartial: NodeAttemptState | undefined;
			let writesCommitted = false;
			let validatedOutputDigest: string | undefined;
			let childTerminationConfirmed = false;
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
			if (attempt.routingDecision?.fallbackLevel === "L3") {
				const error = attempt.routingDecision.reason;
				await this.transition(node.taskId, "waiting_input", { status: "waiting_input", endedAt: new Date().toISOString(), error }, error);
				return { status: "waiting_input", error };
			}
			if (attempt.error?.startsWith("Graph Runtime v2 guard preflight failed before dispatch:")) {
				const error = attempt.error;
				const failure = attempt.failure ?? { kind: "routing_preflight_drift" as const, retryKind: "failed" as const };
				await this.transition(node.taskId, "waiting_input", { status: "waiting_input", endedAt: new Date().toISOString(), error, failure }, error, { statePatch: { failure } });
				return { status: "waiting_input", error, failure };
			}
			if (signal?.aborted) {
				const result: NodeExecutionResult = { status: signal.reason === "suspend" ? "suspended" : "stopped", failure: { kind: "cancelled" } };
				return this.collectPartial(node, attempt, workspace, result);
			}
			const recoveredAuthority = this.runInstanceId && existing ? await this.store.readAttemptRecord(node.taskId, attempt.attempt) : undefined;
			if (recoveredAuthority && ["accepted", "validated", "applying"].includes(recoveredAuthority.phase) && this.runInstanceId && (
				recoveredAuthority.runtimeGuardAcknowledged !== true
				|| !recoveredAuthority.launchContractDigest
				|| !recoveredAuthority.extensionContentDigest
				|| !recoveredAuthority.runtimeLaunchContractDigest
				|| recoveredAuthority.launchContractDigest !== recoveredAuthority.runtimeLaunchContractDigest
			)) {
				return { status: "stale", error: "Recovered post-execution authority has no durable pi-graph-guard acknowledgement or matching launch and Extension seals." };
			}
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
			let terminalOutput = "";
			let terminal: AsyncTerminal | undefined;
			const providerDispatches = attempt.providerDispatches ?? [];
			if (providerDispatches.length === 0 && attempt.asyncId && attempt.asyncDir) {
				providerDispatches.push({ dispatch: 1, status: "running", sessionDir: attempt.sessionDir, startedAt: attempt.startedAt ?? new Date().toISOString(), asyncId: attempt.asyncId, asyncDir: attempt.asyncDir });
				attempt.providerDispatches = providerDispatches;
			}
			let providerDispatch = providerDispatches.at(-1);
			let identity = providerDispatch?.asyncId && providerDispatch.asyncDir ? { asyncId: providerDispatch.asyncId, asyncDir: providerDispatch.asyncDir } : null;
			if (!identity && providerDispatch && ["dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(state.status)) {
				try { identity = await this.resolveDispatch(node, attempt, providerDispatch); }
				catch (error) { return { status: "stale", error: error instanceof Error ? error.message : String(error) }; }
			}
			if (!identity && existing && ["collecting", "verifying"].includes(recoveredState ?? "") && attempt.outputPath && existsSync(attempt.outputPath)) {
				recoveredCompletedOutput = true;
				childTerminationConfirmed = true;
			}
			if (recoveredCompletedOutput && this.runInstanceId && (
				recoveredAuthority?.runtimeGuardAcknowledged !== true
				|| !recoveredAuthority.launchContractDigest
				|| !recoveredAuthority.runtimeLaunchContractDigest
				|| recoveredAuthority.launchContractDigest !== recoveredAuthority.runtimeLaunchContractDigest
			)) {
				return { status: "stale", error: "Recovered completed output has no durable pi-graph-guard acknowledgement or matching runtime launch contract seal." };
			}
			if (!providerDispatch && !recoveredCompletedOutput) {
				if (existing && recoveredState !== "leased") {
					return { status: "stale", error: "Recovered dispatch has no persisted dispatch identity. pi-graph will not synthesize a replacement after dispatch may have started." };
				}
				providerDispatch = { dispatch: 1, status: "prepared", sessionDir: attempt.sessionDir, startedAt: new Date().toISOString() };
				providerDispatches.push(providerDispatch);
				attempt.providerDispatches = providerDispatches;
				await this.transition(node.taskId, state.status, { providerDispatches });
			}
			if (existing && (this.runInstanceId || attempt.routingDecision?.enforcement === "require")) {
				const authorityMatchesSeals = Boolean(
					recoveredAuthority?.launchContractDigest
					&& recoveredAuthority.extensionContentDigest
					&& providerDispatches.length > 0
					&& providerDispatches.every((dispatch) => dispatch.launchContractDigest === recoveredAuthority.launchContractDigest
						&& dispatch.extensionContentDigest === recoveredAuthority.extensionContentDigest),
				);
				if (!authorityMatchesSeals) {
					return { status: "stale", error: "Graph Runtime recovery cannot prove that the snapshot launch contract and Extension content seals match the attempt authority." };
				}
			}
			if (!identity && existing && !recoveredCompletedOutput && providerDispatch?.status !== "prepared") {
				const lineage = providerDispatch ? this.lineage(node, attempt, providerDispatch) : undefined;
				let replayablePrepared = false;
				try {
					if (lineage && providerDispatch) replayablePrepared = await this.childRuntime.hasReplayablePreparedDispatch(lineage, this.childParams(node, workspace, attempt, providerDispatch));
				} catch (error) {
					return { status: "stale", error: `Recovered dispatch ledger is invalid: ${error instanceof Error ? error.message : String(error)}` };
				}
				if (!replayablePrepared) return { status: "stale", error: "Recovered dispatch has no unique child identity. pi-graph will not emit a replacement for a dispatch that may already have started." };
			}
			while (!recoveredCompletedOutput) {
				if (!providerDispatch) throw new Error("Provider dispatch state is missing.");
				if (!identity) {
					const params = this.childParams(node, workspace, attempt, providerDispatch);
					if (this.runInstanceId && this.config.runtimeV2Dispatch !== true) return { status: "stale", error: "Graph Runtime v2 dispatch is gated until the ChildRuntime protocol is available." };
					const dispatchDecision = attempt.routingDecision;
					const controlledDispatch = dispatchDecision?.enforcement === "require" && Boolean(dispatchDecision.selectedModel);
					const dispatchModels = this.currentAvailableModels();
					if (controlledDispatch) {
						if (!dispatchDecision!.availableModelsDigest) {
							const error = "Controlled Graph routing preflight failed: the sealed decision is not bound to an active model registry snapshot.";
							await this.transition(node.taskId, "waiting_input", { status: "waiting_input", endedAt: new Date().toISOString(), error }, error);
							return { status: "waiting_input", error };
						}
						if (!dispatchModels) {
							const error = "Controlled Graph routing preflight failed: the active Pi model registry snapshot is unavailable.";
							await this.transition(node.taskId, "waiting_input", { status: "waiting_input", endedAt: new Date().toISOString(), error }, error);
							return { status: "waiting_input", error };
						}
						if (availableModelsDigest(dispatchModels) !== dispatchDecision!.availableModelsDigest) {
							const error = "Controlled Graph routing preflight failed: the active Pi model registry changed after the routing decision was sealed.";
							const failure: FailureDetails = { kind: "routing_preflight_drift", retryKind: "failed" };
							await this.transition(node.taskId, "waiting_input", { status: "waiting_input", endedAt: new Date().toISOString(), error, failure }, error, { statePatch: { failure } });
							return { status: "waiting_input", error, failure };
						}
					}
					if (this.runInstanceId || controlledDispatch) {
						const audit = await auditManagedLaunchContracts({
							tasks: [params],
							cwd: node.cwd,
							...(controlledDispatch ? { availableModels: dispatchModels } : {}),
							requireExtensionSeal: true,
							requireModelSeal: controlledDispatch,
							...this.managedLaunchAuditInput(workspace.kind),
						});
						const expectedLaunchContractDigest = audit.contracts[0]?.launchContractDigest;
						const expectedExtensionContentDigest = audit.contracts[0]?.extensionContentDigest;
						if (!audit.ok
							|| !expectedLaunchContractDigest
							|| !expectedExtensionContentDigest
							|| !providerDispatch.launchContractDigest
							|| providerDispatch.launchContractDigest !== expectedLaunchContractDigest
							|| !providerDispatch.extensionContentDigest
							|| providerDispatch.extensionContentDigest !== expectedExtensionContentDigest) {
							const error = `${controlledDispatch ? "Controlled Graph routing" : "Graph Runtime v2 guard"} preflight failed: ${audit.issues.join(" ") || "the launch contract or Extension contents changed after they were sealed"}`;
							const failure: FailureDetails = { kind: "routing_preflight_drift", retryKind: "failed" };
							await this.transition(node.taskId, "waiting_input", { status: "waiting_input", endedAt: new Date().toISOString(), error, failure }, error, { statePatch: { failure } });
							return { status: "waiting_input", error, failure };
						}
						providerDispatch.launchContractDigest = expectedLaunchContractDigest;
						providerDispatch.extensionContentDigest = expectedExtensionContentDigest;
					}
					providerDispatch.requestDigest = canonicalDigest(params);
					const commitPreparedDispatch = async () => {
						providerDispatch!.status = "dispatching";
						await this.transition(node.taskId, providerDispatch!.dispatch === 1 ? "dispatching" : "running", { status: providerDispatch!.dispatch === 1 ? "dispatching" : "running", providerDispatches: attempt.providerDispatches });
						if (providerDispatch!.dispatch === 1) await this.writeAttemptAuthority(node.taskId, attempt, "dispatching", this.runInstanceId ? {
							requestDigest: providerDispatch!.requestDigest,
							...(providerDispatch!.launchContractDigest ? { launchContractDigest: providerDispatch!.launchContractDigest } : {}),
							...(providerDispatch!.extensionContentDigest ? { extensionContentDigest: providerDispatch!.extensionContentDigest } : {}),
						} : {});
					};
					const verifyLiveRoutingSnapshot = () => {
						if (attempt.routingDecision?.enforcement !== "require") return;
						const finalModels = this.currentAvailableModels();
						if (!attempt.routingDecision.availableModelsDigest || availableModelsDigest(finalModels) !== attempt.routingDecision.availableModelsDigest) {
							throw new Error("The active Pi model registry changed at the final Graph dispatch boundary.");
						}
					};
					const lineage = this.lineage(node, attempt, providerDispatch);
					if (!lineage) await commitPreparedDispatch();
					try {
						const dispatched = lineage
							? await this.childRuntime.dispatch(lineage, params, graphOuterWorkflowParams(lineage, params), commitPreparedDispatch, verifyLiveRoutingSnapshot)
							: await this.rpc.spawn(params, undefined, verifyLiveRoutingSnapshot);
						identity = { asyncId: dispatched.asyncId, asyncDir: dispatched.asyncDir };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (error instanceof ChildPreparePreEmitError) {
							const failure: FailureDetails = { kind: "dispatch_rejected", retryKind: "dispatch" };
							if (providerDispatch.dispatch === 1 && lineage) {
								if (!providerDispatch.requestDigest) throw new Error("Runtime v2 dispatch preparation abort is missing its durable request digest.");
								await this.store.restorePreparedAttemptAfterPreEmitAbort(node.taskId, attempt.attempt, lineage, providerDispatch.requestDigest);
							}
							Object.assign(providerDispatch, { status: "failed", endedAt: new Date().toISOString(), error: message, failure });
							delete providerDispatch.requestDigest;
							return this.collectPartial(node, attempt, workspace, { status: "failed", error: message, retryKind: "dispatch", failure });
						}
						if (error instanceof RpcPreEmitError) {
							const failure: FailureDetails = { kind: "routing_preflight_drift", retryKind: "failed" };
							if (providerDispatch.dispatch === 1) {
								if (lineage) {
									if (!providerDispatch.requestDigest) throw new Error("Runtime v2 pre-emit abort is missing its durable request digest.");
									await this.store.restorePreparedAttemptAfterPreEmitAbort(node.taskId, attempt.attempt, lineage, providerDispatch.requestDigest);
								}
								providerDispatch.status = "prepared";
								delete providerDispatch.requestDigest;
								delete providerDispatch.endedAt;
								delete providerDispatch.error;
								delete providerDispatch.failure;
								return this.collectPartial(node, attempt, workspace, { status: "waiting_input", error: message, failure });
							}
							Object.assign(providerDispatch, { status: "failed", endedAt: new Date().toISOString(), error: message, failure });
							return this.collectPartial(node, attempt, workspace, { status: "stale", error: message, failure });
						}
						if (error instanceof RpcRejectedError) return this.collectPartial(node, attempt, workspace, { status: "failed", error: `Child dispatch was rejected: ${message}`, retryKind: "dispatch", failure: { kind: "dispatch_rejected", retryKind: "dispatch" } });
						providerDispatch.status = "dispatch_unknown";
						providerDispatch.error = message;
						await this.transition(node.taskId, "dispatch_unknown", { status: "dispatch_unknown", providerDispatches: attempt.providerDispatches, error: message }, message);
						try { identity = await this.resolveDispatch(node, attempt, providerDispatch); }
						catch (recoveryError) { return { status: "stale", error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }; }
						if (!identity) {
							const lineage = this.lineage(node, attempt, providerDispatch);
							if (lineage) await this.childRuntime.abandon(lineage, params, "dispatch outcome remained unknown after recovery scan");
							return { status: "stale", error: error instanceof RpcTimeoutError ? "Dispatch outcome remained unknown after recovery scan; no replacement attempt will be created." : `Dispatch failed without a recoverable identity; no replacement attempt will be created: ${message}` };
						}
					}
					Object.assign(providerDispatch, identity, { status: "running" });
					await this.transition(node.taskId, "running", {
						status: "running",
						...(providerDispatch.dispatch === 1 ? identity : {}),
						providerDispatches: attempt.providerDispatches,
					});
					if (providerDispatch.dispatch === 1) await this.writeAttemptAuthority(node.taskId, attempt, "running", { asyncId: identity.asyncId, ...(this.ownerSessionId ? { sessionId: this.ownerSessionId } : {}) });
				}
				if (signal?.aborted) {
					if (signal.reason === "suspend") return { status: "suspended" };
					if (identity && !await this.stopAttemptAndConfirm(node, attempt, workspace, providerDispatch, identity, "active graph stop could not confirm child termination")) return { status: "stale", error: "Child stop could not be confirmed; durable tombstone enforcement remains active." };
					return this.collectPartial(node, attempt, workspace, { status: "stopped", failure: { kind: "cancelled" } });
				}
				try {
					terminal = await waitForAsyncRun({ events: this.events, ...identity!, ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}), signal });
					childTerminationConfirmed = true;
				} catch (error) {
					if (signal?.aborted && signal.reason === "suspend") return { status: "suspended" };
					if (signal?.aborted) {
						if (!await this.stopAttemptAndConfirm(node, attempt, workspace, providerDispatch, identity!, "active graph stop could not confirm child termination")) return { status: "stale", error: "Child stop could not be confirmed; durable tombstone enforcement remains active." };
						return this.collectPartial(node, attempt, workspace, { status: "stopped", failure: { kind: "cancelled" } });
					}
					if (error instanceof AsyncRunDeadlineError) {
						const acceptComplete = node.sideEffect !== "external_write" && !node.allowBash;
						if (!await this.stopAttemptAndConfirm(node, attempt, workspace, providerDispatch, identity!, "hard deadline could not confirm child termination", acceptComplete)) return { status: "stale", error: "Child hard-deadline stop could not be confirmed; durable tombstone enforcement remains active and retry is unsafe until inspected." };
						return this.collectPartial(node, attempt, workspace, { status: "failed", error: error.message, retryKind: "timeout", failure: { kind: "hard_deadline", retryKind: "timeout" } });
					}
					if (!await this.stopAttemptAndConfirm(node, attempt, workspace, providerDispatch, identity!, "child monitoring failed before termination was confirmed")) return { status: "stale", error: `Child monitoring failed and stop could not be confirmed; durable tombstone enforcement remains active: ${error instanceof Error ? error.message : String(error)}` };
					return { status: "stale", error: `Child monitoring failed after the child was stopped: ${error instanceof Error ? error.message : String(error)}` };
				}
				const guardAttestationRequired = Boolean(this.runInstanceId) || attempt.routingDecision?.enforcement === "require";
				if (guardAttestationRequired) {
					const terminalAudit = await auditManagedLaunchContracts({
						tasks: [this.childParams(node, workspace, attempt, providerDispatch)],
						cwd: node.cwd,
						requireExtensionSeal: true,
						requireModelSeal: attempt.routingDecision?.enforcement === "require",
						...this.managedLaunchAuditInput(workspace.kind),
					});
					if (!terminalAudit.ok
						|| !providerDispatch.launchContractDigest
						|| !terminalAudit.contracts[0]?.launchContractDigest
						|| terminalAudit.contracts[0]?.launchContractDigest !== providerDispatch.launchContractDigest
						|| !providerDispatch.extensionContentDigest
						|| !terminalAudit.contracts[0]?.extensionContentDigest
						|| terminalAudit.contracts[0]?.extensionContentDigest !== providerDispatch.extensionContentDigest) {
						providerDispatch.status = "failed";
						providerDispatch.endedAt = new Date().toISOString();
						providerDispatch.error = `The effective launch contract or Extension contents changed after the Graph Runtime guard preflight seal.${terminalAudit.issues.length ? ` ${terminalAudit.issues.join(" ")}` : ""}`;
						await this.transition(node.taskId, "running", { providerDispatches: attempt.providerDispatches });
						return this.collectPartial(node, attempt, workspace, { status: "waiting_input", error: `Graph Runtime guard violation: ${providerDispatch.error}` }, terminal.output);
					}
					if (terminal.state === "complete" && !runtimeAcknowledgesExtension(terminal, "pi-graph-guard")) {
						providerDispatch.status = "failed";
						providerDispatch.endedAt = new Date().toISOString();
						providerDispatch.error = "The child runtime did not acknowledge loading pi-graph-guard without omitted Extension acknowledgements.";
						await this.transition(node.taskId, "running", { providerDispatches: attempt.providerDispatches });
						return this.collectPartial(node, attempt, workspace, { status: "waiting_input", error: `Graph Runtime guard violation: ${providerDispatch.error}` }, terminal.output);
					}
				}
				providerDispatch.runtimeLaunchContractDigest = runtimeLaunchContractDigest(terminal);
				if (guardAttestationRequired && (
					!providerDispatch.launchContractDigest
					|| !providerDispatch.runtimeLaunchContractDigest
					|| providerDispatch.launchContractDigest !== providerDispatch.runtimeLaunchContractDigest
				)) {
					providerDispatch.status = "failed";
					providerDispatch.endedAt = new Date().toISOString();
					providerDispatch.error = "The runtime launch contract digest is missing or differs from the preflight contract.";
					await this.transition(node.taskId, "running", { providerDispatches: attempt.providerDispatches });
					return this.collectPartial(node, attempt, workspace, { status: "waiting_input", error: `Graph Runtime guard violation: ${providerDispatch.error}` }, terminal.output);
				}
				const execution = createModelExecution({ terminal, decision: attempt.routingDecision, legacyRequestedModel: modelOverride(node), config: this.routingConfig });
				if (execution) {
					attempt.modelExecution = execution;
					providerDispatch.modelExecution = execution;
				}
				if (attempt.routingDecision?.enforcement === "require" && (!execution || execution.routingViolations?.length)) {
					providerDispatch.status = "failed";
					providerDispatch.endedAt = new Date().toISOString();
					providerDispatch.error = execution?.routingViolations?.join(" ") || "The runtime did not report verifiable model and thinking provenance.";
					await this.transition(node.taskId, "running", { ...(execution ? { modelExecution: execution } : {}), providerDispatches: attempt.providerDispatches });
					return this.collectPartial(node, attempt, workspace, { status: "waiting_input", error: `Controlled routing violation: ${providerDispatch.error}` }, terminal.output);
				}
				if (terminal.state !== "complete") {
					const error = typeof terminal.status.error === "string" ? terminal.status.error : `Subagent ended in state ${terminal.state}.`;
					if (terminal.state === "paused") { Object.assign(providerDispatch, { status: "paused", endedAt: new Date().toISOString(), error }); return this.collectPartial(node, attempt, workspace, { status: "waiting_input", error }, terminal.output); }
					if (terminal.state === "stopped") { Object.assign(providerDispatch, { status: "stopped", endedAt: new Date().toISOString(), error }); return this.collectPartial(node, attempt, workspace, { status: "stopped", error, failure: { kind: "cancelled" } }, terminal.output); }
					const failure = classifyChildFailure(terminal.status, error);
					Object.assign(providerDispatch, { status: "failed", endedAt: new Date().toISOString(), error, failure });
					await this.transition(node.taskId, "running", { modelExecution: execution, providerDispatches: attempt.providerDispatches });
					const providerFailures = providerDispatches.filter((entry) => entry.failure?.retryKind === "provider").length;
					const providerBudget = attempt.routingDecision?.budget.providerRetries ?? node.retryPolicy.maxProviderRetries ?? 0;
					if (failure.retryKind === "provider" && providerFailures <= providerBudget) {
						await delay(Math.max(node.retryPolicy.providerBackoffMs ?? 5_000, failure.retryAfterMs ?? 0));
						if (!identity || !await waitForObservedProcessTerminal(identity.asyncId, identity.asyncDir, 30_000)) {
							return this.collectPartial(node, attempt, workspace, { status: "stale", error: "Provider retry cannot reuse the attempt workspace without an observed process-terminal proof for the failed child." }, terminal.output);
						}
						const dispatchNumber = providerDispatch.dispatch + 1;
						workspace = await this.resetProviderWorkspace(node, attempt, workspace, dispatchNumber);
						if (attempt.outputPath) await this.removeManagedFileIfPresent(attempt.outputPath, "Provider retry output artifact");
						const nextDispatch: ProviderDispatchState = { dispatch: dispatchNumber, status: "prepared", sessionDir: join(dirname(attempt.sessionDir), `provider-dispatch-${dispatchNumber}`, "session"), startedAt: new Date().toISOString() };
						const controlledRetry = attempt.routingDecision?.enforcement === "require" && Boolean(attempt.routingDecision.selectedModel);
						const retryModels = this.currentAvailableModels();
						if (controlledRetry) {
							if (!retryModels || availableModelsDigest(retryModels) !== attempt.routingDecision!.availableModelsDigest) {
								const drift = "Controlled Graph provider retry preflight found that the active Pi model registry changed after the routing decision was sealed.";
								return this.collectPartial(node, attempt, workspace, { status: "stale", error: drift, failure: { kind: "routing_preflight_drift", retryKind: "failed" } }, terminal.output);
							}
						}
						if (this.runInstanceId || controlledRetry) {
							const audit = await auditManagedLaunchContracts({
								tasks: [this.childParams(node, workspace, attempt, nextDispatch)],
								cwd: node.cwd,
								...(controlledRetry ? { availableModels: retryModels } : {}),
								requireExtensionSeal: true,
								requireModelSeal: controlledRetry,
								...this.managedLaunchAuditInput(workspace.kind),
							});
							const launchContractDigest = audit.contracts[0]?.launchContractDigest;
							const extensionContentDigest = audit.contracts[0]?.extensionContentDigest;
							const authorityLaunchContractDigest = recoveredAuthority?.launchContractDigest ?? providerDispatches[0]?.launchContractDigest;
							const authorityExtensionContentDigest = recoveredAuthority?.extensionContentDigest ?? providerDispatches[0]?.extensionContentDigest;
							if (!audit.ok || !launchContractDigest || !extensionContentDigest || launchContractDigest !== authorityLaunchContractDigest || extensionContentDigest !== authorityExtensionContentDigest) {
								const drift = "Graph Runtime provider retry preflight no longer matches the attempt authority guard seals.";
								return this.collectPartial(node, attempt, workspace, { status: "stale", error: `${drift} ${audit.issues.join(" ")}`.trim(), failure: { kind: "routing_preflight_drift", retryKind: "failed" } }, terminal.output);
							}
							nextDispatch.launchContractDigest = launchContractDigest;
							nextDispatch.extensionContentDigest = extensionContentDigest;
						}
						providerDispatch = nextDispatch;
						providerDispatches.push(providerDispatch);
						identity = null;
						terminal = undefined;
						await this.transition(node.taskId, "running", { providerDispatches });
						await this.removeManagedFileIfPresent(this.providerWorkspaceResetPath(node, attempt), "Completed provider workspace reset journal");
						continue;
					}
					const decision = attempt.routingDecision;
					const canDegrade = failure.retryKind === "provider"
						&& decision?.candidateIndex !== undefined
						&& decision.candidateIndex + 1 < decision.eligibleCandidates.length
						&& decision.degradationIndex < decision.budget.modelDegradations;
					const terminalFailure = canDegrade ? { ...failure, retryKind: "model_degrade" as const } : failure;
					return this.collectPartial(node, attempt, workspace, { status: "failed", error, retryKind: terminalFailure.retryKind, failure: terminalFailure }, terminal.output);
				}
				Object.assign(providerDispatch, { status: "complete", endedAt: new Date().toISOString() });
				await this.transition(node.taskId, "running", { modelExecution: execution, providerDispatches: attempt.providerDispatches });
				terminalOutput = terminal.output;
				break;
			}
			const recoveringAttempt = this.runInstanceId ? await this.store.hasAttemptRecovery(node.taskId, attempt.attempt) : false;
			const authorityIdentity = identity ? {
				...(providerDispatch?.dispatch === 1 ? { asyncId: identity.asyncId } : {}),
				...(this.ownerSessionId ? { sessionId: this.ownerSessionId } : {}),
				...(this.runInstanceId && providerDispatch?.runtimeLaunchContractDigest ? { runtimeLaunchContractDigest: providerDispatch.runtimeLaunchContractDigest } : {}),
				...(this.runInstanceId ? { runtimeGuardAcknowledged: true as const } : {}),
			} : {};
			if (recoveringAttempt) {
				await this.writeAttemptAuthority(node.taskId, attempt, "collecting", authorityIdentity);
				await this.transition(node.taskId, "collecting", { status: "collecting" });
				await this.store.completeAttemptRecovery(node.taskId, attempt.attempt);
			} else {
				await this.transition(node.taskId, "collecting", { status: "collecting" });
				await this.writeAttemptAuthority(node.taskId, attempt, "collecting", authorityIdentity);
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
				await validateTypedOutput(node, attempt.outputPath!);
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
			if (signal?.aborted && signal.reason === "suspend") result = { status: "suspended", failure: { kind: "cancelled" } };
			else if (signal?.aborted && childTerminationConfirmed) result = { status: "stopped", failure: { kind: "cancelled" } };
			else if (signal?.aborted) result = { status: "stale", error: `Stop failed before child termination was confirmed: ${error instanceof Error ? error.message : String(error)}`, failure: { kind: "cancelled" } };
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
			...(node.acceptance !== undefined ? { acceptance: node.acceptance } : {}),
			inputs: await Promise.all(Object.entries(workspace.artifactPaths).map(async ([path, source]) => ({ path, digest: await digestFile(source) }))),
			reads: workspace.contract.readScope.map((entry) => entry.path),
			writes,
			validation,
			...(node.output ? { output: node.output } : {}),
			...(node.resourceScopes?.length ? { resourceScopes: node.resourceScopes } : {}),
			outputArtifact: attempt.outputPath!,
			outputDigest: await digestFile(attempt.outputPath!),
			...(canonicalOutputArtifact ? { canonicalOutputArtifact } : {}),
			...(attempt.modelExecution ? { modelExecution: attempt.modelExecution } : {}),
			...(failure ? { failure } : {}),
			unresolvedQuestions,
			createdAt: new Date().toISOString(),
		};
		return this.store.writeJson(join("nodes", node.taskId, `attempt-${attempt.attempt}`, "result-manifest.json"), manifest);
	}
}
