import type {LatestModelIdentity} from '../runtime/model-capabilities.ts';
export const GRAPH_SPEC_V3_SCHEMA_VERSION = 3 as const;
export const SNAPSHOT_V3_SCHEMA_VERSION = 3 as const;
export const AUTHORIZATION_V4_SCHEMA_VERSION = 4 as const;

export type SideEffectV3 = "none" | "local_read" | "local_write" | "external_read" | "external_write";
export type ScopeKindV3 = "file" | "tree";
export type RetryReasonV3 = "task_failed" | "validation" | "timeout" | "workspace_conflict";
export type WorkspaceModeV3 = "shadow";
export type GraphTopologyModeV3 = "sealed" | "open";
export type GraphWhenStatusV3 = "accepted" | "failed";
export type GraphContractPolicyV3 = "standard" | "strict";
export type V3NodeBindingResolution = "exact-agent" | "capability-catalog" | "temporary-agent";

export interface V3TurnBudgetHint {
	maxTurns: number;
	graceTurns?: number;
}

export interface V3ToolBudgetHint {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export interface V3UsageBudgetLimitHint {
	soft?: number;
	hard: number;
}

export interface V3UsageBudgetHint {
	tokens?: V3UsageBudgetLimitHint;
	costUsd?: V3UsageBudgetLimitHint;
}

/**
 * Static Pi execution hints admitted before the DAG enters the core. `resolvedModel`
 * is still only the model requested from pi-subagents; the actual child model is
 * runtime evidence and must never be inferred from this record.
 */
export interface V3RuntimeFallbackCandidate extends Partial<LatestModelIdentity> {
 requestedModel: string; resolvedModel: string; thinking?: string | false;
 agentDefinitionDigest: string; admissionLaunchContractDigest: string;
 level?:string; capabilities?:import('../runtime/model-capabilities.ts').ModelCapabilities;
}
export interface V3RuntimeFallbackPlan {
 latestPolicy?:'latest-per-tier';approvedLatestIds?:string[];
 sessionContinuationVersion?:1;
 transientRetryLimit?:0|1;
 version: 1; profile: string; modelDegradations: number;
 candidates: V3RuntimeFallbackCandidate[];
 requirements?:import('../runtime/model-capabilities.ts').ModelRequirements;
 excludedFamilies: string[]; requireCrossFamilyFromProducers: boolean;
 digest: string;
}
export interface V3LatestModelSelection { latestPolicy:'latest-per-tier';approvedLatestIds:string[];candidate:V3RuntimeFallbackCandidate; }
export interface V3NodeLaunchHints {
 latestModelSelection?:V3LatestModelSelection;
 customModelDefinitions?:import("../runtime/custom-models.ts").CustomGraphModel[];
 runtimeFallback?: V3RuntimeFallbackPlan;
	schemaVersion: 1;
	requestedModel?: string;
	resolvedModel?: string;
	thinking?: string | false;
	turnBudget?: V3TurnBudgetHint;
	toolBudget?: V3ToolBudgetHint;
	/** Maximum output tokens for each child provider request; Graph Guard enforces it in-process. */
	maxTokens?: number;
	/** Node-lifetime reported-usage budget shared by all Attempts; it does not interrupt an already-running child. */
	usageBudget?: V3UsageBudgetHint;
	hintDigest: string;
}

export interface V3CapabilityEntryBinding {
	capabilityId: string;
	agent: string;
	entryDigest: string;
}

/** Durable proof that public capability authoring was reduced to one exact Agent. */
export interface V3FallbackAdmission { catalogDigest:string; candidates:Array<{agent:string;model:string;state:"unprobed"|"provider-unavailable"|"selected";failureKind?:string}>; runtimeAutomaticFallback:false; }

export interface V3NodeBinding {
 fallbackAdmission?: V3FallbackAdmission;
	schemaVersion: 1;
	resolution: V3NodeBindingResolution;
	requestedAgent?: string;
	resolvedAgent: string;
	capabilityIds: string[];
	unmatchedCapabilityIds?: string[];
	catalogDigest?: string;
	capabilityEntries?: V3CapabilityEntryBinding[];
	agentDefinitionDigest: string;
	/**
	 * Public pi-subagents preflight evidence for the source Agent, authoring task,
	 * and admitted launch hints. Runtime adds the frozen Graph Guard profile and
	 * dependency capsule, so its lifecycle launchContractDigest is separate and
	 * is not assumed to equal this admission digest.
	 */
	admissionLaunchContractDigest: string;
	authoringNodeDigest: string;
	bindingDigest: string;
}

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

export interface GraphEvidenceFileV3 { path: string; nonSecret: true; }

export interface GraphDependencyInputV3 { from: string; field: "status" | "reason" | "evidenceFiles"; type: "string" | "artifact-list"; as: string; }

export interface GraphNodeSpecV3 {
 dependencyInputs?: GraphDependencyInputV3[];
	/** Final output must be exact JSON {status: "pass"|"blocked"|"fail", reason: string}. */
	resultContract?: "status-json";
	/** Explicit authorization to retain these non-secret workspace-relative files. */
	evidenceFiles?: GraphEvidenceFileV3[];
	readOnly?: boolean;
	taskId: string;
	agent: string;
	task: string;
	dependsOn?: string[];
	when?: GraphWhenV3;
	inputArtifacts?: string[];
	outputArtifact?: string;
	/** Explicit source-relative files required before launch; task prose is never parsed. */
	requiredMaterials?: string[];
	readScope?: ScopeEntryV3[];
	writeScope?: ScopeEntryV3[];
	sideEffect: SideEffectV3;
	timeoutMs?: number;
	retryPolicy?: Partial<RetryPolicyV3>;
	acceptance?: string;
	validationCommands?: string[];
	/** Admission evidence only. The core never reads a capability catalog. */
	binding?: V3NodeBinding;
	/** Pi-native execution hints only. pi-subagents remains the resolver/enforcer. */
	launch?: V3NodeLaunchHints;
}

/** Public authoring shape accepted by the Binding/Admission adapter. */
export interface GraphNodeAuthoringSpecV3 extends Omit<GraphNodeSpecV3, "agent" | "binding" | "launch"> {
 fallbackAgents?: string[];
	agent?: string;
	capabilityId?: string;
	requires?: string[];
	model?: string;
	thinking?: string | false;
	turnBudget?: V3TurnBudgetHint;
	toolBudget?: V3ToolBudgetHint;
	usageBudget?: V3UsageBudgetHint;
	/** Per-provider-request output-token ceiling. Minimum 16 for Pi provider compatibility. */
	maxTokens?: number;
}

export interface GraphSpecV3 {
	contextPolicy?: "v1" | "disabled";
	permissionPolicy?: "inherited" | "strict";
	/** Trusted admission evidence, never author supplied. */
	parentToolAllowlist?: string[];
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
	/** Internal durable admission constraint. Public authoring uses contractPolicy. */
	bindingPolicy?: "strict";
}

export interface GraphSpecAuthoringV3 extends Omit<GraphSpecV3, "nodes" | "bindingPolicy" | "parentToolAllowlist"> {
	contractPolicy?: GraphContractPolicyV3;
	nodes: GraphNodeAuthoringSpecV3[];
}

export interface CompiledGraphNodeV3 {
	contextPolicy?: "v1" | "disabled";
 dependencyInputs?: GraphDependencyInputV3[];
	/** Final output must be exact JSON {status: "pass"|"blocked"|"fail", reason: string}. */
	resultContract?: "status-json";
	/** Explicit authorization to retain these non-secret workspace-relative files. */
	evidenceFiles?: GraphEvidenceFileV3[];
	permissionPolicy?: "inherited" | "strict";
	parentToolAllowlist?: string[];
	taskId: string;
	agent: string;
	task: string;
	dependsOn: string[];
	when?: GraphWhenV3;
	inputArtifacts: string[];
	outputArtifact: string;
	requiredMaterials?: string[];
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
	binding?: V3NodeBinding;
	launch?: V3NodeLaunchHints;
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
	/** Present only for graphs admitted under the strict capability contract. */
	bindingPolicy?: "strict";
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
 modelFallback?: { from: string; to: string; reason: string };
	phase: V3NodeProjectionPhase;
	attempt: number;
	terminalStatus?: V3NodeProjectionTerminal;
	/** Static display context rebuilt from the compiled graph. */
	agent?: string;
	dependsOn?: string[];
	/** Bounded child lifecycle projection. Only verified exit/mutation evidence may gate safe recovery. */
	observation?: V3ChildObservation;
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
	| "usage_budget"
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
	/** Initial requested/resolved execution context plus the durable async identity. */
	observation?: V3ChildObservation;
}

export interface V3DispatchIntent {
	requestId: string;
	requestDigest: string;
	state: "prepared" | "emitting";
	preparedAt: string;
	emittedAt?: string;
}

export interface V3ChildOutcome {
 /** SHA-256 of the native final output before the bounded preview. */
 fullOutputDigest?: string;
	terminal: "complete" | "failed" | "stopped" | "paused";
	output: string;
	completedAt: string;
	/** Final bounded lifecycle observation; terminal/output remain authoritative. */
	observation?: V3ChildObservation;
}

export interface V3ChildTokenUsageObservation {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	turns?: number;
	costUsd?: number;
}

export interface V3ChildProgressObservation {
	state?: "queued" | "running" | "complete" | "completed" | "failed" | "paused" | "stopped" | "rejected";
	currentTool?: string;
	currentPath?: string;
	lastTool?: string;
	lastToolAt?: string;
	toolCount?: number;
	turnCount?: number;
	lastActivityAt?: string;
}

/**
 * Sanitized observability evidence from pi-subagents. Requested/resolved model
 * fields are execution intent; `actualModel` is the runtime-reported model.
 */
export interface V3ChildSupervision {
	version?: 2;
	phase?: string;
	phaseStartedAt?: string;
	runnerInstanceId?: string;
	seq?: number;
	health?: "responsive" | "unknown" | "suspected_unresponsive" | "exited";
	failedProbes?: number;
	observedMutation?: boolean;
	runtimeRetries?: number;
	repeatedErrors?: number;
	processExitConfirmed?: boolean;
	runtimeFailure?: boolean;
	attention?: "waiting_user" | "repeated_errors" | "storage_error" | "observation_unavailable" | "suspected_unresponsive" | "result_unavailable" | "runtime_exited";
	activity: "active" | "quiet" | "unknown" | "terminal";
	checkedAt: string;
	startedAt?: string;
	runtimeLimit: "unlimited" | "configured" | "unknown";
	deadlineAt?: string;
	probe: "available" | "unreachable" | "not_checked";
	error?: string;
}

export interface V3ChildObservation {
 usageSegments?:Array<{model:string;thinking?:string;usage:V3ChildTokenUsageObservation}>;
	supervision?: V3ChildSupervision;
	asyncId: string;
	runId?: string;
	requestedAgent?: string;
	resolvedAgent?: string;
	actualAgent?: string;
	requestedModel?: string;
	resolvedModel?: string;
	actualModel?: string;
	thinking?: string;
	attemptedModels?: string[];
	sessionFile?: string;
	launchContractDigest?: string;
	usage?: V3ChildTokenUsageObservation;
	durationMs?: number;
	progress?: V3ChildProgressObservation;
	observedAt: string;
}

export interface V3AttemptRouteSelection { candidateIndex: number; planDigest: string; }
export interface V3FallbackContinuation extends V3AttemptRouteSelection { fromAttempt: number; proofDigest: string; failureKind: string; }
export interface V3AttemptEvidence {
 routeSelection?: V3AttemptRouteSelection;
 fallbackContinuation?: V3FallbackContinuation;
	evidenceManifestDigest?: string;
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
	/** Historical evidence only. New attempts never create execution deadlines. */
	deadlineAt?: string;
	/** Durable spawn intent. `emitting` means the RPC emit boundary may have been crossed. */
	dispatchIntent?: V3DispatchIntent;
	dispatch?: V3DispatchBinding;
	/** Latest lifecycle projection. Only reported usage may fail-close a later Attempt's usage-budget gate. */
	observation?: V3ChildObservation;
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
