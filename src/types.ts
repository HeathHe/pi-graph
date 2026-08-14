import type { MaxAuthorization, ModelExecution, RoutingDecision, TaskRisk } from "./model-routing/types.ts";

export const GRAPH_SPEC_VERSION = 1 as const;
export const GRAPH_RESULT_VERSION = 1 as const;

export type SideEffect = "none" | "local_read" | "local_write" | "external_read" | "external_write";
export type ScopeKind = "file" | "tree";
export type NodeOutputType = "file" | "text" | "json" | "table" | "citation-set" | "url" | "screenshot" | "document" | "email-draft" | "connector-record" | "decision";
export type ResourceScopeKind = "url" | "domain" | "service" | "account" | "database" | "table" | "record" | "mailbox" | "calendar" | "document" | "browser-session" | "connector" | "action";
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

export interface NodeOutput {
	type: NodeOutputType;
	path?: string;
	mediaType?: string;
	schema?: string;
}

export interface ResourceScope {
	kind: ResourceScopeKind;
	resource: string;
	access: "read" | "write";
	toolNames?: string[];
	/** Exact, canonical tool input authorized for the listed read-only tools. */
	toolInput?: Record<string, unknown>;
}

export interface ExternalAction {
	service: string;
	account?: string;
	action: string;
	target: string;
	idempotencyKey?: string;
	requiresApproval: boolean;
	approvalRef?: string;
	reversible: boolean;
	compensation?: string;
	expectedState?: string;
	verifyByReadback: boolean;
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

export interface GraphAcceptanceGate {
	id?: string;
	must: string;
}

export interface GraphAcceptanceCriteria {
	criteria: Array<string | GraphAcceptanceGate>;
}

export type SubagentAcceptanceLevel = "auto" | "none" | "attested" | "checked" | "verified";
export type SubagentAcceptanceEvidenceKind =
	| "changed-files"
	| "tests-added"
	| "commands-run"
	| "validation-output"
	| "residual-risks"
	| "no-staged-files"
	| "diff-summary"
	| "review-findings"
	| "manual-notes";

export interface SubagentAcceptanceGate {
	id: string;
	must: string;
	evidence?: SubagentAcceptanceEvidenceKind[];
	severity?: "required" | "recommended";
}

export interface SubagentAcceptanceVerifyCommand {
	id: string;
	command: string;
	timeoutMs?: number;
	cwd?: string;
	env?: Record<string, string>;
	allowFailure?: boolean;
}

export interface SubagentAcceptanceReviewGate {
	agent?: string;
	focus?: string;
	required?: boolean;
}

export interface SubagentAcceptanceConfig {
	level?: SubagentAcceptanceLevel;
	criteria?: Array<string | SubagentAcceptanceGate>;
	evidence?: SubagentAcceptanceEvidenceKind[];
	verify?: SubagentAcceptanceVerifyCommand[];
	review?: SubagentAcceptanceReviewGate | false;
	stopRules?: string[];
	reason?: string;
}

/** Mirrors the public pi-subagents AcceptanceInput contract without importing package internals. */
export type SubagentAcceptanceInput = Exclude<SubagentAcceptanceLevel, "none"> | false | SubagentAcceptanceConfig;

export interface GraphNodeSpec {
	taskId: string;
	agent: string;
	task: string;
	capabilityId?: string;
	dependsOn?: string[];
	inputArtifacts?: string[];
	outputArtifact?: string;
	output?: NodeOutput;
	readScope?: ScopeEntry[];
	writeScope?: ScopeEntry[];
	resourceScopes?: ResourceScope[];
	externalAction?: ExternalAction;
	sideEffect: SideEffect;
	idempotent?: boolean;
	parallelizable?: boolean;
	atomic?: boolean;
	scopeJustification?: string;
	acceptance?: string | boolean | GraphAcceptanceCriteria;
	childAcceptance?: SubagentAcceptanceInput;
	validationCommands?: string[];
	retryPolicy?: RetryPolicy;
	taskRisk?: TaskRisk;
	routingProfile?: string;
	producerRefs?: string[];
	maxAuthorization?: MaxAuthorization;
	model?: string;
	thinking?: string;
	/** Runtime provenance only; never accepted as GraphSpec input. */
	resolvedModel?: never;
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

export interface CompiledNode extends Omit<GraphNodeSpec, "dependsOn" | "outputArtifact" | "readScope" | "writeScope" | "retryPolicy" | "cwd"> {
	dependsOn: string[];
	outputArtifact: string;
	readScope: ScopeEntry[];
	writeScope: ScopeEntry[];
	retryPolicy: RetryPolicy;
	cwd: string;
}

export interface CompiledGraph extends Omit<GraphSpec, "graphId" | "nodes" | "maxConcurrency" | "failFast" | "workspace"> {
	projectionVersion: 1;
	/** Spawn ceiling sealed when this run was admitted. */
	spawnBudget?: number;
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
	acceptance?: GraphNodeSpec["acceptance"];
	inputs: Array<{ path: string; digest?: string }>;
	reads: string[];
	writes: FileDigest[];
	validation: ValidationResult[];
	output?: NodeOutput;
	resourceScopes?: ResourceScope[];
	outputArtifact: string;
	outputDigest?: string;
	canonicalOutputArtifact?: string;
	modelExecution?: ModelExecution;
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
	| "routing_preflight_drift"
	| "task_failed"
	| "validation"
	| "workspace_conflict"
	| "monitoring"
	| "cancelled";

export type RetryKind = "dispatch" | "timeout" | "failed" | "validation" | "provider" | "model_degrade";

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
	routingDecision?: RoutingDecision;
	modelExecution?: ModelExecution;
	error?: string;
	failure?: FailureDetails;
	providerDispatches?: ProviderDispatchState[];
}

export interface ProviderDispatchState {
	dispatch: number;
	status: "prepared" | "dispatching" | "dispatch_unknown" | "running" | "complete" | "failed" | "stopped" | "paused";
	sessionDir: string;
	startedAt: string;
	endedAt?: string;
	requestDigest?: string;
	launchContractDigest?: string;
	extensionContentDigest?: string;
	runtimeLaunchContractDigest?: string;
	asyncId?: string;
	asyncDir?: string;
	modelExecution?: ModelExecution;
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
	planningAdmissionId?: string;
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
