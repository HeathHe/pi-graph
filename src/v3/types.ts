export const GRAPH_SPEC_V3_SCHEMA_VERSION = 3 as const;
export const SNAPSHOT_V3_SCHEMA_VERSION = 3 as const;
export const AUTHORIZATION_V4_SCHEMA_VERSION = 4 as const;

export type SideEffectV3 = "none" | "local_read" | "local_write";
export type ScopeKindV3 = "file" | "tree";
export type RetryReasonV3 = "task_failed" | "validation" | "timeout" | "workspace_conflict";
export type WorkspaceModeV3 = "auto" | "shadow" | "git";

export interface ScopeEntryV3 {
	kind: ScopeKindV3;
	path: string;
}

export interface RetryPolicyV3 {
	maxAttempts: number;
	retryOn: RetryReasonV3[];
	backoffMs: number;
}

export interface ChildAcceptanceV3 {
	criteria: string[];
}

export interface GraphNodeSpecV3 {
	taskId: string;
	agent: string;
	task: string;
	dependsOn?: string[];
	inputArtifacts?: string[];
	outputArtifact?: string;
	readScope?: ScopeEntryV3[];
	writeScope?: ScopeEntryV3[];
	sideEffect: SideEffectV3;
	timeoutMs?: number;
	retryPolicy?: Partial<RetryPolicyV3>;
	acceptance?: string;
	validationCommands?: string[];
	childAcceptance?: ChildAcceptanceV3;
}

export interface GraphSpecV3 {
	schemaVersion: typeof GRAPH_SPEC_V3_SCHEMA_VERSION;
	graphId?: string;
	goal: string;
	nodes: GraphNodeSpecV3[];
	maxConcurrency?: number;
	failFast?: boolean;
	workspace?: WorkspaceModeV3;
}

export interface CompiledGraphNodeV3 {
	taskId: string;
	agent: string;
	task: string;
	dependsOn: string[];
	inputArtifacts: string[];
	outputArtifact: string;
	readScope: ScopeEntryV3[];
	writeScope: ScopeEntryV3[];
	sideEffect: SideEffectV3;
	timeoutMs?: number;
	retryPolicy: RetryPolicyV3;
	acceptance?: string;
	validationCommands: string[];
	childAcceptance?: ChildAcceptanceV3;
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
	sourceGraphSpec: GraphSpecV3;
	sourceGraphSpecDigest: string;
	graphDigest: string;
}

export type GraphRuntimeStatusV3 = "queued" | "running" | "complete" | "failed" | "stopped" | "paused" | "waiting_input" | "needs_attention";

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

export type RunFormatKind = "legacy-readonly" | "legacy-v2" | "v3" | "invalid";

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
	status: "ok" | "legacy-readonly" | "legacy-v2" | "needs_attention";
	format: RunFormatDetection;
	runDir: string;
	graphId?: string;
	runInstanceId?: string;
	graphStatus?: string;
	reasons: string[];
	snapshot?: unknown;
	authorization?: unknown;
}
