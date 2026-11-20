export interface RunCliResult {
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunCliCapabilityMode = "structured" | "legacy" | "fail-closed";

export interface MaestroCapabilitiesV10 {
  schema_version: "maestro-capabilities/1.0";
  cli_version: string;
  session_schema_writes: string[];
  execution_schema_writes: string[];
  run_response_writes: string[];
  features: {
    execution_generation: boolean;
    core_execution_lease: boolean;
    execution_handoff: boolean;
    session_statusless: boolean;
    legacy_session_aliases: boolean;
    [feature: string]: boolean;
  };
  [field: string]: unknown;
}

export interface RunCliNegotiatedSupport {
  execution_generation: boolean;
  core_execution_lease: boolean;
  "run-response/1.1": boolean;
  "run-response/1.2": boolean;
  artifact_compatibility_v1: boolean;
  atomic_run_complete_seal: boolean;
  generation_scoped_seal_receipts: boolean;
}

/**
 * Session/Run minimal-state (plan B v3) capability flags, negotiated as a unit
 * (docs/session-run-minimal-state-architecture-20260812.md section 15).
 * All values are false unless structured negotiation succeeds.
 */
export interface RunCliV3Support {
  session_run_minimal_v3: boolean;
  entity_revision_cas: boolean;
  participant_identity: boolean;
  request_receipts_v2: boolean;
  /** True only when the core explicitly advertises `execution_lease: false`. */
  execution_lease_retired: boolean;
  /** True only when the core explicitly advertises `operation_registry: false`. */
  operation_registry_retired: boolean;
  /** Audit #2: the writer-scoped session_schema_writes declares session/3.0. */
  session_3_writer: boolean;
  /** Audit #2: execution_schema_writes is empty (v3 writes no Execution). */
  no_execution_writes: boolean;
  /** Audit #2: run_response_writes declares run-response/1.2. */
  response_12: boolean;
  /** Audit #2: every v2 feature (generation/lease/handoff/statusless/aliases) is explicitly false. */
  v2_features_retired: boolean;
}

/**
 * Mutation protocol selected from the negotiated capabilities:
 * - `session-run-v3`: Session/Run entity-revision CAS (plan B; adapter pending).
 * - `execution-v2`: current execution-generation + core-lease protocol.
 * - `fail-closed`: neither protocol is complete; mutations must be refused.
 */
export type RunCliProtocol = "session-run-v3" | "execution-v2" | "fail-closed";

export interface RunCliCatalogOption {
  names: string[];
  required: boolean;
  value_arity: 0 | 1 | -1;
  repeatable: boolean;
  choices: string[];
  value_constraint?: "portable-path-segment" | null;
}

export interface RunCliCatalogCommand {
  command: string;
  option_specs: RunCliCatalogOption[];
  positionals: Array<{ name: string; required: boolean; variadic: boolean; choices: string[] }>;
}

export interface RunCliCatalogError {
  code: "UNKNOWN_OPTION" | "MISSING_VALUE" | "INVALID_VALUE" | "EXCESS_POSITIONAL" | "MISSING_REQUIRED" | "UNKNOWN_COMMAND";
  argument: string;
  commandPath: string;
  suggestion?: string;
}

export interface RunCliCapabilities {
  commands: ReadonlySet<string>;
  /** Commands parsed from `session --help`; empty when the CLI has no session subcommand. */
  sessionCommands: ReadonlySet<string>;
  /** Commands parsed from `plan --help`; used for approved Plan publication capability detection. */
  planCommands: ReadonlySet<string>;
  /** Source and safety posture of the structured capability negotiation. */
  mode: RunCliCapabilityMode;
  /** Validated structured response; absent for legacy and fail-closed CLIs. */
  structured: MaestroCapabilitiesV10 | null;
  /** Explicit new-protocol support. All values are false unless structured negotiation succeeds. */
  support: Readonly<RunCliNegotiatedSupport>;
  /** Session/Run minimal-state (v3) capability flags. */
  v3: Readonly<RunCliV3Support>;
  /** Mutation protocol derived from support/v3; the v3 branch takes precedence. */
  protocol: RunCliProtocol;
  /** Diagnostic for legacy/fail-closed negotiation without exposing raw command output. */
  diagnostic: string | null;
  /** Additive command metadata from `help --json`; absent on older CLIs. */
  commandCatalog?: ReadonlyMap<string, RunCliCatalogCommand>;
}

export interface RunPlanPublishOptions {
  sourcePath: string;
  sourceRoot: string;
  sessionId?: string;
  intent?: string;
  topic?: string;
  handoffKey: string;
  sourcePiSession: string;
  planRevision: number;
  approvedAt: string;
  expectedIdentityRevision?: number;
  expectedActivityRevision?: number;
  requestId?: string;
  executionId?: string;
  generation?: number;
  expectedExecutionRevision?: number;
  executionOwner?: string;
  ownerKind?: "pi" | "claude" | "codex" | "agy" | "manual";
  ownerEpoch?: number;
  leaseId?: string;
  actor?: string;
  reason?: string;
  evidence?: readonly string[];
}

export type RunCompletionVerdict = "done" | "done-with-concerns" | "needs-retry" | "blocked";

export interface RunDoneOptions {
  verdict?: RunCompletionVerdict;
  summary?: string;
  reason?: string;
  notes?: readonly string[];
  decisions?: readonly string[];
  evidence?: readonly string[];
  artifacts?: readonly string[];
}

export interface RunEditOptions {
  sessionId: string;
  after?: string;
  replace?: string;
  remove?: string;
  args?: string;
  stage?: string;
  goalRef?: string;
  insertedBy?: string;
}

export interface RunCliRunnerOptions {
  /** Cancels the owned CLI process tree. Existing two-argument runners remain compatible. */
  signal?: AbortSignal;
}

export type RunCliRunner = (
  args: readonly string[],
  cwd: string,
  options?: RunCliRunnerOptions,
) => Promise<RunCliResult>;

