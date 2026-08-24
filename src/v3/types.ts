export const GRAPH_SPEC_V3_SCHEMA_VERSION = 3 as const;
export const SNAPSHOT_V3_SCHEMA_VERSION = 3 as const;
export const AUTHORIZATION_V4_SCHEMA_VERSION = 4 as const;

export type SideEffectV3 = "none" | "local_read" | "local_write";
export type ScopeKindV3 = "file" | "tree";
export type RetryReasonV3 = "task_failed" | "validation" | "timeout" | "workspace_conflict";
export type WorkspaceModeV3 = "shadow";
export type GraphTopologyModeV3 = "sealed" | "open";
export type GraphWhenStatusV3 = "accepted" | "failed";

export interface ScopeEntryV3 {
	kind: ScopeKindV3;
	path: string;
}

export interface RetryPolicyV3 {
	maxAttempts: number;
	retryOn: RetryReasonV3[];
	backoffMs: number;
}

export interface GraphWhenV3 {
	node: string;
	status: GraphWhenStatusV3;
}

export interface GraphNodeSpecV3 {
	taskId: string;
	agent: string;
	task: string;
	dependsOn?: string[];
	when?: GraphWhenV3;
	inputArtifacts?: string[];
	outputArtifact?: string;
	readScope?: ScopeEntryV3[];
	writeScope?: ScopeEntryV3[];
	sideEffect: SideEffectV3;
	timeoutMs?: number;
	retryPolicy?: Partial<RetryPolicyV3>;
	acceptance?: string;
	validationCommands?: string[];
}

export interface GraphSpecV3 {
	schemaVersion: typeof GRAPH_SPEC_V3_SCHEMA_VERSION;
	graphId?: string;
	goal: string;
	nodes: GraphNodeSpecV3[];
	maxConcurrency?: number;
	failFast?: boolean;
	workspace?: WorkspaceModeV3;
	/** Graph-wide execution ceiling. It constrains tools; it never selects a model or Agent. */
	readOnly?: boolean;
	/** Optional exact allow-list enforced by the child Guard for every node. */
	toolFilter?: string[];
	/** Static/sealed remains the default when omitted. Open graphs may start empty and accept revision-CAS mutations. */
	mode?: GraphTopologyModeV3;
}

export interface CompiledGraphNodeV3 {
	taskId: string;
	agent: string;
	task: string;
	dependsOn: string[];
	when?: GraphWhenV3;
	inputArtifacts: string[];
	outputArtifact: string;
	readScope: ScopeEntryV3[];
	writeScope: ScopeEntryV3[];
	sideEffect: SideEffectV3;
	timeoutMs?: number;
	retryPolicy: RetryPolicyV3;
	acceptance?: string;
	validationCommands: string[];
	/** Mechanically enforced graph-wide execution constraints. */
	readOnly?: true;
	toolFilter?: string[];
}

export interface CompiledGraphProjectionV3 {
	schemaVersion: typeof GRAPH_SPEC_V3_SCHEMA_VERSION;
	graphId: string;
	goal: string;
	nodes: CompiledGraphNodeV3[];
	topologicalOrder: string[];
	maxConcurrency: number;
	failFast: boolean;
	workspace: WorkspaceModeV3;
}

export interface CompiledGraphV3 extends CompiledGraphProjectionV3 {
	/** Omitted for the historical sealed/static projection so existing graph digests remain stable. */
	mode?: GraphTopologyModeV3;
	sourceGraphSpec: GraphSpecV3;
	sourceGraphSpecDigest: string;
	graphDigest: string;
}

export type GraphRuntimeStatusV3 = "queued" | "running" | "idle" | "stopping" | "complete" | "failed" | "stopped" | "paused" | "waiting_input" | "needs_attention";

export interface GraphSnapshotV3 {
	schemaVersion: typeof SNAPSHOT_V3_SCHEMA_VERSION;
	runInstanceId: string;
	graphId: string;
	graphDigest: string;
	sourceGraphSpecDigest: string;
	status: GraphRuntimeStatusV3;
	sessionId: string;
	supervisorEpoch: string;
	createdAt: string;
	updatedAt: string;
	/** Present for dynamic/open topology projections; authorization digests remain bound to the immutable base graph. */
	topology?: GraphTopologyModeV3;
	revision?: number;
	sealed?: boolean;
	/** Rebuildable projection of per-node runtime state derived from attempt evidence. */
	nodes?: Record<string, V3NodeProjection>;
}

export interface V3NodeProjection {
	phase: V3NodeProjectionPhase;
	attempt: number;
	terminalStatus?: V3NodeProjectionTerminal;
}

/**
 * Projection-only states are rebuilt from immutable topology, the mutation
 * journal, and Attempt evidence. They deliberately are not Attempt phases:
 * skipping, blocking, and cancellation must never invent child execution.
 */
export type V3NodeSyntheticPhase = "skipped" | "blocked" | "cancelled";
export type V3NodeProjectionPhase = V3NodePhase | V3NodeSyntheticPhase;
export type V3NodeProjectionTerminal = V3NodeTerminal | V3NodeSyntheticPhase;

export type V3NodePhase =
	| "queued"
	| "prepared"
	| "dispatched"
	| "running"
	| "verifying"
	| "applying"
	| "accepted"
	| "failed"
	| "aborted"
	| "needs_attention";

export type V3NodeTerminal = "accepted" | "failed" | "aborted" | "needs_attention";

export type V3FailureKind =
	| "task_failed"
	| "validation"
	| "timeout"
	| "workspace_conflict"
	| "dispatch_unknown"
	| "child_paused"
	| "child_stopped"
	| "internal";

export type V3AcceptanceMethod = "declared" | "machine-verified";

export interface V3ValidationResult {
	command: string;
	ok: boolean;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	stdout: string;
	stdoutTruncated: boolean;
	stderr: string;
	stderrTruncated: boolean;
	durationMs: number;
}

export interface V3FileDigest {
	path: string;
	before?: string;
	after?: string;
	deleted?: boolean;
}

export interface V3DispatchBinding {
	asyncId: string;
	asyncDir: string;
	requestDigest: string;
	dispatchedAt: string;
}

export interface V3DispatchIntent {
	requestId: string;
	requestDigest: string;
	state: "prepared" | "emitting";
	preparedAt: string;
	emittedAt?: string;
}

export interface V3ChildOutcome {
	terminal: "complete" | "failed" | "stopped" | "paused";
	output: string;
	completedAt: string;
}

export interface V3AttemptEvidence {
	schemaVersion: typeof V3_ATTEMPT_SCHEMA_VERSION;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	phase: V3NodePhase;
	createdAt: string;
	updatedAt: string;
	supervisorEpoch: string;
	/** One immutable wall-clock deadline for the entire Attempt, including recovery. */
	deadlineAt?: string;
	/** Durable spawn intent. `emitting` means the RPC emit boundary may have been crossed. */
	dispatchIntent?: V3DispatchIntent;
	dispatch?: V3DispatchBinding;
	child?: V3ChildOutcome;
	verification?: { allPassed: boolean; validatedResultDigest: string; verifiedAt: string };
	applied?: { writes: V3FileDigest[]; appliedAt: string };
	failure?: { kind: V3FailureKind; message: string; at: string };
	terminalStatus?: V3NodeTerminal;
	workspaceDigest?: string;
	acceptanceDigest?: string;
}

export interface V3WorkspaceEvidence {
	schemaVersion: typeof V3_ATTEMPT_SCHEMA_VERSION;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	workspaceKind: "shadow";
	workspaceDir: string;
	sourceCwd: string;
	readBaseline: Record<string, string | null>;
	writeBaseline: Record<string, string | null>;
	inputBaseline: Record<string, { sourcePath: string; digest: string | null }>;
	contractDigest: string;
	createdAt: string;
}

export interface V3ValidatedResult {
	schemaVersion: typeof V3_ATTEMPT_SCHEMA_VERSION;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	validations: V3ValidationResult[];
	allPassed: boolean;
	writes: V3FileDigest[];
	recordedAt: string;
}

export interface V3AcceptanceEvidence {
	schemaVersion: typeof V3_ATTEMPT_SCHEMA_VERSION;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	acceptance?: string;
	method: V3AcceptanceMethod;
	verified: boolean;
	validatedResultDigest: string;
	attemptDigest: string;
	recordedAt: string;
	supervisorEpoch: string;
}

export interface V3RunLease {
	schemaVersion: typeof V3_LEASE_SCHEMA_VERSION;
	runInstanceId: string;
	pid: number;
	processIdentity: string;
	processStartedAt: number;
	token: string;
	acquiredAt: string;
	heartbeatAt: string;
}

export const V3_ATTEMPT_SCHEMA_VERSION = 1 as const;
export const V3_LEASE_SCHEMA_VERSION = 1 as const;

export interface V3ShadowEvent {
	schemaVersion: 1;
	unverified: true;
	seq: number;
	at: string;
	type: string;
	runInstanceId: string;
	graphId: string;
	graphDigest?: string;
	taskId?: string;
	attempt?: number;
	sessionId?: string;
	[extra: string]: unknown;
}

export type SourceRepositoryIdentityV3 =
	| { kind: "git"; root: string; gitDir: string; device: string; inode: string }
	| { kind: "directory"; root: string; device: string; inode: string };

export interface SourceIdentityV3 {
	sourceCwd: string;
	sourceRepository: SourceRepositoryIdentityV3;
}

export interface AuthorizationV4 extends SourceIdentityV3 {
	schemaVersion: typeof AUTHORIZATION_V4_SCHEMA_VERSION;
	runtimeSchemaVersion: typeof SNAPSHOT_V3_SCHEMA_VERSION;
	sourceGraphSpec: GraphSpecV3;
	sourceGraphSpecDigest: string;
	graphDigest: string;
	runInstanceId: string;
	sessionId: string;
	supervisorEpoch: string;
	createdAt: string;
	graph: CompiledGraphProjectionV3;
}

export type RunFormatKind = "v3" | "invalid";

export interface RunFormatDetection {
	kind: RunFormatKind;
	snapshotSchemaVersion?: number;
	authorizationSchemaVersion?: number;
	runtimeSchemaVersion?: number;
	reason?: string;
}

export interface V3RunVerification {
	ok: boolean;
	reasons: string[];
	snapshot?: GraphSnapshotV3;
	authorization?: AuthorizationV4;
}

export interface V3RunInspection {
  status: "ok" | "needs_attention";
	format: RunFormatDetection;
	runDir: string;
	graphId?: string;
	runInstanceId?: string;
	graphStatus?: string;
	reasons: string[];
	snapshot?: unknown;
	authorization?: unknown;
}
