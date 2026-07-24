export const GRAPH_SPEC_VERSION = 1 as const;
export const GRAPH_RESULT_VERSION = 1 as const;

export type SideEffect = "none" | "local_read" | "local_write" | "external_read" | "external_write";
export type ScopeKind = "file" | "tree";
export type NodeStatus =
	| "pending"
	| "ready"
	| "leased"
	| "dispatching"
	| "dispatch_unknown"
	| "running"
	| "collecting"
	| "verifying"
	| "accepted"
	| "retry_wait"
	| "resource_wait"
	| "waiting_input"
	| "stale"
	| "blocked"
	| "failed"
	| "stopped";
export type GraphStatus = "queued" | "running" | "complete" | "failed" | "blocked" | "stopped" | "needs_attention";

export interface ScopeEntry {
	kind: ScopeKind;
	path: string;
}

export interface ContextRef {
	packId: string;
	revision: string;
	digest: string;
	decisionRevision?: string;
}

export interface RetryPolicy {
	maxAttempts: number;
	maxProviderRetries?: number;
	backoffMs?: number;
	providerBackoffMs?: number;
	retryOn?: Array<"dispatch" | "timeout" | "failed" | "validation">;
}

export interface GraphNodeSpec {
	taskId: string;
	agent: string;
	task: string;
	capabilityId?: string;
	dependsOn?: string[];
	inputArtifacts?: string[];
	outputArtifact: string;
	readScope?: ScopeEntry[];
	writeScope?: ScopeEntry[];
	sideEffect: SideEffect;
	idempotent?: boolean;
	parallelizable?: boolean;
	atomic?: boolean;
	scopeJustification?: string;
	acceptance?: string | boolean | Record<string, unknown>;
	validationCommands?: string[];
	retryPolicy?: RetryPolicy;
	model?: string;
	thinking?: string;
	context?: ContextRef;
	cwd?: string;
	progress?: boolean;
	toolBudget?: { soft?: number; hard: number; block?: string[] | "*" };
	priority?: number;
	timeoutMs?: number;
	resourceClass?: string;
	allowDelete?: boolean;
	allowBash?: boolean;
}

export interface GraphSpec {
	schemaVersion: typeof GRAPH_SPEC_VERSION;
	graphId?: string;
	goal: string;
	contractPolicy?: "legacy" | "strict";
	context?: ContextRef;
	nodes: GraphNodeSpec[];
	maxConcurrency?: number;
	failFast?: boolean;
	workspace?: "auto" | "shadow" | "git";
}

export interface CompiledNode extends Omit<GraphNodeSpec, "dependsOn" | "readScope" | "writeScope" | "retryPolicy" | "cwd"> {
	dependsOn: string[];
	readScope: ScopeEntry[];
	writeScope: ScopeEntry[];
	retryPolicy: RetryPolicy;
	cwd: string;
}

export interface CompiledGraph extends Omit<GraphSpec, "graphId" | "nodes" | "maxConcurrency" | "failFast" | "workspace"> {
	projectionVersion: 1;
	graphId: string;
	nodes: CompiledNode[];
	maxConcurrency: number;
	failFast: boolean;
	workspace: "auto" | "shadow" | "git";
	topologicalOrder: string[];
	compiledAt: string;
}

export interface ValidationResult {
	command: string;
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut?: boolean;
	aborted?: boolean;
}

export interface FileDigest {
	path: string;
	before?: string;
	after?: string;
	deleted?: boolean;
}

export interface ResultManifest {
	schemaVersion: typeof GRAPH_RESULT_VERSION;
	graphId: string;
	taskId: string;
	attempt: number;
	status: "complete" | "partial" | "blocked" | "stale";
	context?: ContextRef;
	inputs: Array<{ path: string; digest?: string }>;
	reads: string[];
	writes: FileDigest[];
	validation: ValidationResult[];
	outputArtifact: string;
	outputDigest?: string;
	canonicalOutputArtifact?: string;
	failure?: FailureDetails;
	unresolvedQuestions: string[];
	createdAt: string;
}

export type FailureKind =
	| "dispatch_rejected"
	| "provider_rate_limit"
	| "provider_transient"
	| "hard_deadline"
	| "budget_checkpoint"
	| "task_failed"
	| "validation"
	| "workspace_conflict"
	| "monitoring"
	| "cancelled";

export type RetryKind = "dispatch" | "timeout" | "failed" | "validation" | "provider";

export interface FailureDetails {
	kind: FailureKind;
	retryKind?: RetryKind;
	retryAfterMs?: number;
}

export interface NodeAttemptState {
	attempt: number;
	attemptNonce?: string;
	status: NodeStatus;
	startedAt?: string;
	endedAt?: string;
	sessionDir: string;
	workspaceDir?: string;
	workspaceKind?: "shadow" | "git";
	gitRoot?: string;
	gitWorktreeRoot?: string;
	asyncId?: string;
	asyncDir?: string;
	outputPath?: string;
	manifestPath?: string;
	writesCommittedAt?: string;
	error?: string;
	failure?: FailureDetails;
}

export interface NodeRuntimeState {
	taskId: string;
	status: NodeStatus;
	attempt: number;
	nextRetryAt?: number;
	resourceWaitStartedAt?: number;
	error?: string;
	failure?: FailureDetails;
	attempts: NodeAttemptState[];
}

interface GraphSnapshotBase {
	graphId: string;
	status: GraphStatus;
	goal: string;
	sourceCwd: string;
	sessionId?: string;
	createdAt: string;
	updatedAt: string;
	supervisorEpoch: string;
	nodes: Record<string, NodeRuntimeState>;
	error?: string;
}

export interface GraphSnapshotV1 extends GraphSnapshotBase {
	schemaVersion: 1;
}

export interface GraphSnapshotV2 extends GraphSnapshotBase {
	schemaVersion: 2;
	runInstanceId: string;
	terminalAt?: string;
	attentionAt?: string;
	lifecycleRevision: number;
	fencingGeneration: number;
}

export type GraphSnapshot = GraphSnapshotV1 | GraphSnapshotV2;

export interface GraphEvent {
	seq: number;
	at: string;
	type: string;
	graphId: string;
	taskId?: string;
	data?: Record<string, unknown>;
}

export interface GraphConfig {
	enabled: boolean;
	runsDir: string;
	maxConcurrency: number;
	readOnlyBurst: number;
	maxSpawnBudget: number;
	rpcTimeoutMs: number;
	validationTimeoutMs: number;
	notifyOnComplete: boolean;
	runtimeV2Dispatch?: boolean;
	resourceLimits?: Record<string, number>;
	history?: GraphHistoryConfig;
}

export interface GraphHistoryConfig {
	autoCompact: boolean;
	compactAfterDays: number;
	autoPrune: boolean;
	emergencyPurge: boolean;
	pruneAfterDays: number;
	trashGraceDays: number;
	maxStorageBytes: number;
	targetStorageBytes: number;
	keepRecentTerminal: number;
}

export interface NodeExecutionResult {
	status: "accepted" | "failed" | "stale" | "waiting_input" | "stopped" | "suspended" | "resource_wait";
	error?: string;
	retryKind?: RetryKind;
	failure?: FailureDetails;
	manifestPath?: string;
}
