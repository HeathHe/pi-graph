import type { TodoSourceScope } from "./todo-source-context.ts";
import type { ChildTodoParentContext } from "./child-parent-context.ts";
import type { NativeCurrentReadCapability } from "../run-executor/native-current-view.ts";
import type { TaskDispatchHost, PreparedTaskDispatch, TaskDispatchObservation } from "../public/v1/task-dispatch-binding.ts";
import type { NativeExecutionSnapshot } from "../run-executor/native-observation.ts";
import type { SelectionDecision } from "pi-graph-model-role";
/**
 * Core teammate execution engine.
 *
 * Spawns a pi subprocess for agent execution, parses JSON lines from
 * stdout, tracks usage and progress, handles abort signals, and returns
 * a SingleResult.
 *
 * Supports single, parallel (tasks[]), and chain (chain[]) execution modes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { describeStructuredOutputValueValidationFailure as describeDeclaredValueFailure, parseDeclaredJsonResult } from "pi-graph-verification";
import crossSpawn from "cross-spawn";
import { listAgentSummaries, resolveAgent, type AgentConfig } from "../agents/agents.ts";
import { resolvePiAgentDirectory } from "../shared/agent-directory.ts";
import { resolveReplyTo, type ReplyTarget } from "../shared/routing.ts";
import type {
  SingleResult,
  Usage,
  AgentProgress,
  AgentTerminalStatus,
  AgentTurnEvent,
  AgentTurnTriggerContextV1,
  MessageProvenanceV1,
  TeammateResultPublicationResult,
} from "../shared/types.ts";
import type { RuntimeActorHostClient } from "../runtime-broker/actor-host.ts";
import { wrapLeasedMessage, type LeaseToken } from "./session-handoff.ts";
import {
  applyModelRouting,
  type ResolvedModelRegistrationRouting,
  type TeammateTaskType,
} from "../models/model-routing.ts";
import type { DispatchAuthorityProjection } from "../models/model-registry.ts";
import type { ModelHealthCoordinator } from "../models/model-circuit-breaker.ts";
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";
import { assertValidTeammatePlacement } from "pi-maestro-fabric-core/v1/validation";
import type {
  BackendRegistry,
  ResolvedBackend,
} from "pi-maestro-backend-core/v1/registry";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import {
  sharedModelCircuitBreaker,
  type ModelCircuitBreaker,
} from "../models/model-circuit-breaker.ts";
import { MANAGED_WINDOW_ENV, getTeammateChildExtensions } from "./child-extensions.ts";
import {
  parseTeammateThinkingLevel,
  type TeammateThinkingInput,
  type TeammateThinkingLevel,
} from "../shared/thinking.ts";
import {
  isFallbackProviderError,
  type ModelHealthFailureScopeClassifier,
} from "./retry.ts";

// ---------------------------------------------------------------------------
// Public param / option interfaces
// ---------------------------------------------------------------------------

export interface TeammateTaskSpec {
  /** Host-issued M07 decision; not an authoring permission. */
  modelSelection?: SelectionDecision;
  prompt: string;
  /** Short human-readable purpose; display label when the task has no name. */
  description?: string;
  agent?: string;
  taskType?: TeammateTaskType;
  name?: string;
  /**
   * Registered backend serving this task; the registry's default when absent.
   *
   * Deliberately absent from the model-facing tool schema. Which backends exist
   * is per-workspace registration, and a static schema cannot enumerate them,
   * so a model setting this field would be guessing at names it has never been
   * shown. Deployment-authored task specs — expert-mode rules and programmatic
   * callers — know the registration document and may set it.
   */
  backend?: string;
  dependsOn?: string[];
  context?: "fresh" | "fork";
  model?: string;
  fallbackModels?: string[];
  thinking?: TeammateThinkingInput;
  /** Codex priority tier for Pi requests only; omitted inherits routing/project defaults. */
  fast?: boolean;
  cwd?: string;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  /**
   * Nesting budget override for the agent spawned by this task; overrides the
   * top-level maxNestingDepth. Omit to inherit the top-level value, which
   * itself defaults to the global ceiling (MAX_DEFAULT_DEPTH).
   */
  maxNestingDepth?: number;
  /**
   * Not supported per task — background is dispatch-level. Accepted by the
   * schema for compatibility; normalizeTeammateParams emits a warning and
   * ignores the value.
   */
  background?: boolean;
  /**
   * Optional Todo task id(s) bound to this agent, in priority order (first =
   * highest). On start the host re-assigns each task's assignee to the agent,
   * auto-activates the first runnable one, and injects the ordered list as a
   * managed fragment. `"12"`, `"#12"`, or an ordered array like
   * `["#1", "#2"]` are accepted.
   */
  todo?: string | string[];
  /**
   * Lazy background references appended to the task prompt without expansion
   * (`agent://<id>`, `file:<path>`, or literal text). The child decides whether
   * to load each one; see runs/briefing.ts.
   */
  briefing?: string[];
  /** Admitted Fabric route constraining this task to one Agent Endpoint. */
  placement?: TeammatePlacementV1;
}

export type TeammateMode = "default" | "expert";

export interface RunTeammateParams {
  tasks: TeammateTaskSpec[];
  /**
   * Dispatch strategy. Expert mode turns one objective into a workflow Leader
   * that may build and run a nested teammate DAG.
   */
  mode?: TeammateMode;
  agent?: string;
  taskType?: TeammateTaskType;
  /** Default registered backend for tasks that name none; see TeammateTaskSpec.backend. */
  backend?: string;
  reply_to?: "caller" | "main";
  background?: boolean;
  context?: "fresh" | "fork";
  model?: string;
  fallbackModels?: string[];
  thinking?: TeammateThinkingInput;
  /** Codex priority tier for Pi requests only; omitted inherits routing/project defaults. */
  fast?: boolean;
  cwd?: string;
  /** Default Fabric route placement for tasks that name none. */
  placement?: TeammatePlacementV1;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  concurrency?: number;
  /**
   * Dedicated foreground detach window for parallel/DAG dispatches. This does
   * not cancel queued or running tasks; it only bounds how long the caller
   * stays attached before background completion delivery takes over.
   */
  concurrencyWaitMs?: number;
  maxAgents?: number;
  /**
   * How many levels of nested teammate dispatch the agents spawned by this
   * call may perform below themselves. 0 forbids nested calls entirely;
   * defaults to the global ceiling (MAX_DEFAULT_DEPTH).
   */
  maxNestingDepth?: number;
  /**
   * Overrides the child Pi subprocess steer-queue drain mode for this
   * dispatch. "all" co-injects all queued steers in one assistant turn;
   * "one-at-a-time" consumes one steer per turn. Omit to inherit the child's
   * Pi settings (default "one-at-a-time").
   */
  steeringMode?: "all" | "one-at-a-time";
}

/** Parameters for the internal single-agent execution primitive. */
export interface RunSingleTeammateParams {
  /** Host-issued M07 decision; not an authoring permission. */
  modelSelection?: SelectionDecision;
  agent: string;
  task?: string;
  taskType?: TeammateTaskType;
  name?: string;
  /** Registered backend serving this task; the registry's default when absent. */
  backend?: string;
  reply_to?: "caller" | "main";
  protocol_version?: number;
  background?: boolean;
  context?: "fresh" | "fork";
  model?: string;
  fallbackModels?: string[];
  thinking?: TeammateThinkingInput;
  /** Codex priority tier for Pi requests only; omitted inherits routing/project defaults. */
  fast?: boolean;
  cwd?: string;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  /** Todo task ids bound to this agent; injected into the child system prompt. */
  todos?: string[];
  /** Lazy background references appended to the task prompt (see runs/briefing.ts). */
  briefing?: string[];
  /** Admitted Fabric route constraining this task to one Agent Endpoint. */
  placement?: TeammatePlacementV1;
}

export interface ModelRegistryDispatchContext {
  readonly authority: DispatchAuthorityProjection;
  readonly registry: BackendRegistry;
  /** Projection-pinned target maps backed by the process-wide breaker stores. */
  readonly modelHealthCoordinator: ModelHealthCoordinator;
  readonly plansByCorrelationId: ReadonlyMap<string, ResolvedModelRegistrationRouting>;
  readonly resolutionsByCorrelationId: ReadonlyMap<string, ReadonlyMap<string, ResolvedBackend>>;
}

/**
 * A canonical publication listener explicitly reported that its immutable
 * agent:// resource was not durably acknowledged. This is distinct from an
 * unrelated observer error, which remains advisory.
 */
export class TeammatePublicationCaptureError extends Error {
  readonly code = "TEAMMATE_PUBLICATION_CAPTURE" as const;
  readonly captureError: unknown;

  constructor(correlationId: string, captureError?: unknown) {
    const detail = captureError instanceof Error ? captureError.message : captureError === undefined ? "unknown capture failure" : String(captureError);
    super(`Canonical teammate result publication was not durably acknowledged for ${correlationId}: ${detail}`);
    this.name = "TeammatePublicationCaptureError";
    this.captureError = captureError;
  }
}

export interface RunTeammateOptions {
  /** Explicit host-authorized configuration source for programmatic admission. */
  modelRoutingFilePath?: string;
  baseCwd: string;
  /**
   * Registry resolving each task's backend.
   *
   * Omitted keeps the legacy path: the orchestrator calls the Pi attempt
   * directly. Supplying one routes every task through the backend contract,
   * which is what the `backend-registry` execution mode does — including Pi,
   * which registers under its ordinary name. Both paths settle into the same
   * outcome, so nothing downstream branches on which ran.
   */
  backendRegistry?: BackendRegistry;
  /** Captured model-registry dispatch authority; omitted outside model-registry mode. */
  modelRegistryAuthority?: DispatchAuthorityProjection;
  /** Scoped model/deployment health authority used only in model-registry mode. */
  modelHealthCoordinator?: ModelHealthCoordinator;
  /** Optional structured backend-aware failure attribution for scoped health. */
  modelHealthFailureScopeClassifier?: ModelHealthFailureScopeClassifier;
  /**
   * Rechecks the exact root Monitor authority generation captured for this
   * dispatch. Remote model registrations are denied when this is absent or
   * returns false.
   */
  authorizeRemoteModelDispatch?: () => boolean;
  /** @internal Pinned graph/single preflight shared across candidate attempts. */
  modelRegistryDispatch?: ModelRegistryDispatchContext;
  /**
   * The host's remote Monitor wiring.
   *
   * Omitted by a dispatch that owns no Monitor term, which makes a remote
   * registration fail to load and the dispatch refuse the task by name rather
   * than run it on this machine.
   */
  remoteManagerOf?: () => import("pi-maestro-backends/remote").RemoteWorkerManagerLike;
  /** Trusted Host composition only; never accepted from a task/model DTO. */
  captureDeploymentDefault?: (targetId: string) => {
    readonly target: import("../remote/types.ts").ResolvedRemoteTarget;
    readonly manager: import("pi-maestro-backends/remote").RemoteWorkerManagerLike;
    readonly monitorOwnerNonce: string;
    assertCurrent(): void;
    readTarget(): import("../remote/types.ts").ResolvedRemoteTarget;
  };
  /**
   * The host's Fabric route resolver.
   *
   * Omitted by a dispatch that owns no Fabric wiring, which makes the Fabric
   * backend fail to load and the dispatch refuse a placed task by name rather
   * than run it on this machine.
   */
  fabricRouteResolverOf?: import("../backends/registry-host.ts").FabricRouteResolverDispatchWiring;
  modelCapabilities?: readonly TeammateModelCapability[];
  modelCircuitBreaker?: ModelCircuitBreaker;
  /**
   * When false, the model-candidate sweep switches candidates without any
   * inter-attempt backoff. Defaults to true: transient network/provider
   * failures wait a bounded exponential delay before the next candidate,
   * while quota/auth/permanent failures switch immediately.
   */
  enableRetryBackoff?: boolean;
  /**
   * Main-session model id (e.g. `provider/model`) to inherit when a dispatch
   * sets no explicit task- or top-level model. Configured task-type mappings
   * still win; this is the default fallback below them.
   */
  inheritModel?: string;
  correlationId?: string;
  taskCorrelationIds?: string[];
  /** Task-local cancellation signals for graph members; `signal` remains graph-wide. */
  taskSignals?: AbortSignal[];
  /**
   * Nesting depth of the dispatch being run. Callers that own the agent tree
   * (the teammate extension) always pass this; direct callers may omit it and
   * fall back to the process environment.
   */
  depth?: number;
  /**
   * Absolute maximum depth the agents spawned by this dispatch may dispatch
   * at (their children's record-depth ceiling). Computed by the caller from
   * maxNestingDepth and the parent agent's own budget; carried into the child
   * process via PI_TEAMMATE_MAX_DISPATCH_DEPTH.
   */
  maxDispatchDepth?: number;
  signal?: AbortSignal;
  /** Optional shared Runtime Broker actor host; omitted creates a run-scoped host from PI_RUNTIME_BROKER. */
  runtimeActorHost?: RuntimeActorHostClient;
  onProgress?: (data: AgentProgress) => void;
  /** Host observation only, emitted after default admission, never an authorization ticket. */
  onDeploymentDefault?: (event: {readonly correlationId: string; readonly runtimeGeneration: number | null;
    readonly source: "deployment-default"; readonly actualModel: "undeclared"}) => void;
  onRetry?: (retry: {
    correlationId: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    nextRetryAt: number;
    error: string;
  }) => void;
  onChildRequest?: (event: Record<string, unknown>, reply: (msg: unknown) => void, parentContext?: ChildTodoParentContext) => void;
  /** M03 owner-issued source, captured by the real host before awaits; never taken from child JSON. */
  todoSourceScope?: TodoSourceScope;
  /** Private execution/root control fence, not a UI observation capability. */
  isNativeInvocationCurrent?: (correlationId: string, runtimeGeneration: number | null) => boolean;
  onChildEvent?: (event: Record<string, unknown>) => void;
  parentSessionFile?: string;
  /** Explicit private session directory for independent long-lived children. */
  sessionDir?: string;
  /** Additional child-only environment values (never applied to the host). */
  childEnvironment?: Record<string, string | undefined>;
  /** Attribution for the original task prompt; malformed input is downgraded to strict unknown. */
  initialMessageProvenance?: MessageProvenanceV1;
  /** Per-task attribution for graph runs; takes precedence over the shared initial value. */
  initialMessageProvenanceOf?: (correlationId: string) => MessageProvenanceV1 | undefined;
  /** Stable logical identity reused by every physical model candidate in this run. */
  initialTurnContext?: AgentTurnTriggerContextV1;
  /** Low-level loop offset owned by this physical model-candidate process. */
  turnLoopSeqOffset?: number;
  /** Internal canonical-event clock floor carried across physical candidates in one run. */
  turnEventTimestampFloor?: number;
  /** Whether this attempt owns publication of the initial trigger-enqueued edge. */
  emitInitialTurnTrigger?: boolean;
  /** Transport-sidecar sink for canonical logical-turn lifecycle events. */
  recordTurnEvent?: (event: AgentTurnEvent) => void;
  initialLeaseToken?: LeaseToken | ((correlationId: string) => LeaseToken | undefined);
  /** Detached observed facts, including late old-generation physical events; consumer must match identity. */
  taskDispatchHost?: TaskDispatchHost;
  preparedTaskDispatch?: PreparedTaskDispatch;
  onTaskDispatchObservation?: (snapshot:TaskDispatchObservation)=>void;
  onNativeExecutionObservation?: (snapshot: NativeExecutionSnapshot) => void;
  /** Same-process current reader; distinct from historical native audit snapshots. */
  onNativeCurrentView?: (view: {correlationId: string; runtimeGeneration: number | null; capability: NativeCurrentReadCapability}) => void;
  onChildSpawned?: (
    stdin: import("node:stream").Writable,
    sendControl: (message: Record<string, unknown>) => boolean,
    sessionDir?: string,
    correlationId?: string,
    /** Runtime generation of the spawning run, mirroring onChildClosed. */
    generation?: number,
  ) => void;
  /** Existing persisted Pi session to load for a cold logical-agent restart. */
  resumeSessionFile?: string;
  /**
   * Initial prompt issued to a resumed child instead of the original task
   * text. The task prompt already lives inside the loaded session history, so
   * re-sending it would make the model re-read (and possibly re-execute) the
   * original request; a resume prompt directs the model to continue from the
   * recorded state instead.
   */
  resumePrompt?: string;
  /**
   * In-process model failover: called when the child settles a turn with a
   * retryable provider error while its runtime is still alive. Return the
   * next model id (`provider/model`) to hot-swap via the child's `set_model`
   * RPC and continue the same session, or `undefined` to settle the failure.
   * `setModel` is the physical switch used by the pi subprocess; this is the
   * teammate-side decision hook that drives it.
   *
   * `previousModel` is the model the child is currently running under after
   * an earlier in-process switch (undefined on the first failure). A hook
   * that accepts it should settle that model's trial outcome (it just failed
   * again); the default teammate hook does this and never re-selects a model
   * already tried in this run.
   */
  onModelFailover?: (
    error: string,
    previousModel?: string,
    failureSource?: "provider" | "transport",
  ) => string | undefined | Promise<string | undefined>;
  /** Runtime generation used to fence callbacks from a replaced child process. */
  runtimeGeneration?: number;
  onChildClosed?: (
    correlationId: string,
    generation: number | undefined,
    details: { code: number | null; signal: NodeJS.Signals | null; settled: boolean },
  ) => void;
  /**
   * Runs once when the final consumable result is published, before the caller
   * or a DAG dependent can observe it. Observer failures are non-fatal; a
   * returned publication result can explicitly reject canonical capture.
   */
  onResultPublished?: (
    result: SingleResult,
    originCwd: string,
  ) => TeammateResultPublicationResult | void | Promise<TeammateResultPublicationResult | void>;
  onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
  /** Physical child-process reclamation, independent of logical turn settlement. */
  onReclamationOutcome?: (
    correlationId: string,
    outcome: ChildReclamationOutcome,
  ) => void;
  /** @internal Test seam for child lifecycle regression coverage. */
  spawnChildProcess?: typeof crossSpawn;
  /** @internal Version of the fixture child, never inherited from the parent. */
  childPiVersion?: string;
  /** Native host selections requiring a child-inheritable router extension. */
  virtualModelIds?: readonly string[];
  /** @internal Test seam for retry scheduling. */
  waitForRetry?: (delayMs: number, signal?: AbortSignal) => Promise<boolean>;
  /** @internal Test seam for the first child activity deadline. */
  firstActivityTimeoutMs?: number;
  /** @internal Test seam for the result-ready grace period. */
  resultReadyGraceMs?: number;
  /** @internal Test seam for child output-limit compaction/continuation recovery. */
  outputLimitRecoveryTimeoutMs?: number;
  /** @internal Test seam for the corrective structured-output continuation deadline. */
  /** @deprecated Ignored. Automatic structured-output resubmission is disabled. */
  structuredOutputRecoveryTimeoutMs?: number;
  /** @internal Test seam for the in-flight tool heartbeat interval. */
  toolExecutionHeartbeatMs?: number;
  /** @internal Test seam for the interrupting-steer acknowledgement deadline. */
  interruptingSteerTimeoutMs?: number;
  /** @internal Test seam for model selection, set_model and resume acknowledgement deadlines. */
  modelSwitchAckTimeoutMs?: number;
  /**
   * Pi subprocess steer-queue drain mode. "all" injects every queued steer
   * message in a single assistant turn (co-injection); "one-at-a-time" (the
   * Pi default, left implicit) consumes one steer per turn. Only "all" is
   * sent to the child via `set_steering_mode`; omitting this field keeps the
   * child's inherited Pi settings.
   */
  steeringMode?: "all" | "one-at-a-time";
  /** @internal Foreground wait window before the extension detaches a still-running task. */
  foregroundMaxRunMs?: number;
}

// ---------------------------------------------------------------------------
// Normalized task specification (unified across single/parallel/chain/graph)
// ---------------------------------------------------------------------------

export interface NormalizedTask {
  /** Host-issued M07 decision; not an authoring permission. */
  modelSelection?: SelectionDecision;
  agent: string;
  prompt: string;
  /** Short human-readable purpose; display label when the task has no name. */
  description?: string;
  taskType?: TeammateTaskType;
  name?: string;
  /** Registered backend serving this task; the registry's default when absent. */
  backend?: string;
  dependsOn?: string[];
  context?: "fresh" | "fork";
  model?: string;
  fallbackModels?: string[];
  thinking?: TeammateThinkingLevel;
  fast?: boolean;
  cwd?: string;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  /** Effective nesting budget: task value ?? top-level value (undefined = ceiling). */
  maxNestingDepth?: number;
  /** Optional Todo task ids bound to this agent (see TeammateTaskSpec.todo). */
  todos?: string[];
  /** Lazy background references (see TeammateTaskSpec.briefing). */
  briefing?: string[];
  /**
   * Admitted Fabric route constraining this task to one Agent Endpoint.
   *
   * Present only for a placed dispatch: the origin host still owns model
   * fallback, recovery, reclamation, and completion publication, and the route
   * may never fall back to another Endpoint.
   */
  placement?: TeammatePlacementV1;
}

/**
 * Project one normalized task into the params `runSingleTeammate` takes.
 *
 * The single home for that projection. Four call sites across the two extension
 * modules built this object inline — root dispatch, nested dispatch, and their
 * two cold-restart paths — and a field left out of one of them does not fail:
 * the run simply proceeds without it. `todos` reached only the graph builder
 * for exactly that reason, so `spec.todos` was undefined on every single
 * dispatch, and both the capability gate and the dsh bridge assertion that key
 * off it could never fire. One builder is what gives that projection an owner.
 *
 * The prompt is an argument rather than `source.prompt` because a cold restart
 * replays the message that woke the agent, not the prompt it was dispatched
 * with; `context` and `timeoutMs` are arguments for the same reason.
 *
 * @param source - the normalized task carrying what the request declared.
 * @param overrides - what the call site owns: the prompt text, the reply
 *   target, and, on a restart, the fixed context and the task's timeout.
 * @returns the params object for one `runSingleTeammate` call.
 */
export function singleRunParamsOf(
  source: NormalizedTask,
  overrides: {
    task: string;
    reply_to?: "caller" | "main";
    context?: "fresh" | "fork";
    timeoutMs?: number;
  },
): RunSingleTeammateParams {
  return {
    agent: source.agent,
    task: overrides.task,
    taskType: source.taskType,
    name: source.name,
    backend: source.backend,
    reply_to: overrides.reply_to,
    context: overrides.context ?? source.context,
    model: source.model,
    modelSelection: source.modelSelection,
    fallbackModels: source.fallbackModels,
    thinking: source.thinking,
    fast: source.fast,
    cwd: source.cwd,
    outputSchema: source.outputSchema,
    // Copied rather than aliased: the roster record keeps its own array of the
    // same ids, and a run must not be able to reorder what the roster shows.
    ...(source.todos === undefined ? {} : { todos: [...source.todos] }),
    ...(source.briefing === undefined ? {} : { briefing: [...source.briefing] }),
    ...(source.placement === undefined ? {} : { placement: structuredClone(source.placement) }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface JsonLineEvent {
  type: string;
  content?: string;
  usage?: Partial<Usage>;
  model?: string;
  error?: string;
  name?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

import { createResultOwner } from "../run-executor/result-owner.ts";
import { createAdmissionOwner } from "../run-executor/admission-owner.ts";
import type { ResultReadyTurnContext, StructuredOutputCandidate, Utf8LineDecoder, TranscriptEntry } from "../run-executor/result-owner.ts";
export type { ResultReadyTurnContext, StructuredOutputCandidate, Utf8LineDecoder, TranscriptEntry } from "../run-executor/result-owner.ts";
import type { TaskOutput, NormalizeTeammateResult } from "../run-executor/admission-owner.ts";
export type { TaskOutput, NormalizeTeammateResult } from "../run-executor/admission-owner.ts";
// ---------------------------------------------------------------------------
// Variable reference resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC3: shell-free, provenance-bearing Pi launcher resolution
// ---------------------------------------------------------------------------

export type PiLaunchSource =
  | "override"
  | "path-native"
  | "windows-shim"
  | "host-entry"
  | "host-native"
  | "path-fallback";

export interface PiLaunchSpec {
  command: string;
  argsPrefix: string[];
  source: PiLaunchSource;
}

export interface PiSpawnCommandOptions {
  envBinary?: string | null;
  entryPoint?: string | null;
  platform?: NodeJS.Platform;
  pathValue?: string | null;
  argv?: readonly string[];
  execPath?: string;
  bunVersion?: string | null;
  appData?: string | null;
  /** @internal deterministic filesystem seam for focused launcher tests. */
  isFile?: (candidate: string) => boolean;
  /** @internal deterministic package-manifest seam for focused launcher tests. */
  readTextFile?: (candidate: string) => string;
}

function regularFileExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathPiCandidates(
  platform: NodeJS.Platform,
  pathValue: string | null | undefined,
  isFile: (candidate: string) => boolean,
): Pick<PiLaunchSpec, "command" | "source">[] {
  if (!pathValue) return [];
  const directories = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  if (platform !== "win32") {
    return directories
      .map((directory) => path.join(directory, "pi"))
      .filter(isFile)
      .map((command) => ({ command, source: "path-native" }));
  }

  // Ignore npm's extensionless POSIX shim: cross-spawn follows its shebang
  // through sh.exe, so the Pi Node process does not own the IPC channel.
  const candidates: Pick<PiLaunchSpec, "command" | "source">[] = [];
  for (const extension of [".cmd", ".bat", ".exe", ".com"] as const) {
    for (const directory of directories) {
      const command = path.join(directory, `pi${extension}`);
      if (isFile(command)) candidates.push({
        command,
        source: extension === ".cmd" || extension === ".bat" ? "windows-shim" : "path-native",
      });
    }
  }
  return candidates;
}

const WINDOWS_PI_SHIM_ENTRY_PATTERN = /"?%dp0%[\\/]([^"*%\r\n]+?\.(?:js|mjs|cjs))"?/i;

function resolvedWindowsPiShim(
  shim: string,
  isFile: (candidate: string) => boolean,
  readTextFile: (candidate: string) => string,
  execPath: string,
): PiLaunchSpec | undefined {
  try {
    const match = WINDOWS_PI_SHIM_ENTRY_PATTERN.exec(readTextFile(shim));
    if (!match) return undefined;
    const entry = path.resolve(path.dirname(shim), match[1]!.replace(/[\\/]/g, path.sep));
    const verified = verifiedHostPiEntry(entry, isFile, readTextFile);
    return verified
      ? { command: execPath, argsPrefix: [verified], source: "windows-shim" }
      : undefined;
  } catch {
    return undefined;
  }
}

function verifiedHostPiEntry(
  entryPoint: string | null | undefined,
  isFile: (candidate: string) => boolean,
  readTextFile: (candidate: string) => string,
): string | undefined {
  if (!entryPoint || !/\.(?:js|mjs|cjs)$/i.test(entryPoint) || !isFile(entryPoint)) return undefined;
  const absoluteEntry = path.resolve(entryPoint);
  let directory = path.dirname(absoluteEntry);
  for (let depth = 0; depth < 10; depth += 1) {
    const manifestPath = path.join(directory, "package.json");
    if (isFile(manifestPath)) {
      try {
        const manifest = JSON.parse(readTextFile(manifestPath)) as {
          name?: unknown;
          bin?: unknown;
        };
        const acceptedPackage = manifest.name === "@earendil-works/pi-coding-agent"
          || manifest.name === "@mariozechner/pi-coding-agent";
        const piBin = typeof manifest.bin === "object" && manifest.bin !== null
          ? (manifest.bin as Record<string, unknown>).pi
          : undefined;
        if (acceptedPackage && typeof piBin === "string"
          && path.resolve(directory, piBin) === absoluteEntry) return absoluteEntry;
      } catch {
        return undefined;
      }
      return undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export let resolvedPiEntryPoint: string | null | undefined;

/**
 * Resolve process.argv[1] only when its owning package manifest proves it is
 * Pi's declared CLI. A generic .js/.mjs suffix is never evidence of identity.
 */
export function resolvePiEntryPoint(): string | null {
  if (resolvedPiEntryPoint !== undefined) return resolvedPiEntryPoint;
  resolvedPiEntryPoint = verifiedHostPiEntry(
    process.argv[1],
    regularFileExists,
    (candidate) => fs.readFileSync(candidate, "utf-8"),
  ) ?? null;
  return resolvedPiEntryPoint;
}

export function resolvePiLaunchSpec(options: PiSpawnCommandOptions = {}): PiLaunchSpec {
  const envBinary = options.envBinary === undefined
    ? process.env.PI_TEAMMATE_PI_BINARY
    : options.envBinary;
  if (envBinary?.trim()) {
    return { command: envBinary, argsPrefix: [], source: "override" };
  }

  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? regularFileExists;
  const readTextFile = options.readTextFile ?? ((candidate: string) => fs.readFileSync(candidate, "utf-8"));
  const execPath = options.execPath ?? process.execPath;
  const bunVersion = options.bunVersion === undefined ? process.versions.bun : options.bunVersion;
  // A compiled Pi host is the CLI, not a JS interpreter. Reuse it directly so
  // PATH shims cannot insert a forwarding process that drops the child's IPC.
  if (bunVersion && /^pi(?:-bolt)?(?:\.exe)?$/i.test(path.basename(execPath)) && isFile(execPath)) {
    return { command: execPath, argsPrefix: [], source: "host-native" };
  }
  const pathCandidates = pathPiCandidates(
    platform,
    options.pathValue === undefined ? process.env.PATH : options.pathValue,
    isFile,
  );
  const hostEntry = (): string | undefined | null => {
    if (options.entryPoint !== undefined) return verifiedHostPiEntry(options.entryPoint, isFile, readTextFile);
    if (options.argv !== undefined) return verifiedHostPiEntry(options.argv[1], isFile, readTextFile);
    return resolvePiEntryPoint();
  };
  const hostLaunch = (entry: string): PiLaunchSpec => ({
    command: execPath,
    argsPrefix: [entry],
    source: "host-entry",
  });

  if (platform === "win32") {
    const entry = hostEntry();
    if (entry) return hostLaunch(entry);
    for (const candidate of pathCandidates) {
      if (candidate.source !== "windows-shim") continue;
      const resolved = resolvedWindowsPiShim(candidate.command, isFile, readTextFile, execPath);
      if (resolved) return resolved;
    }

    // APPDATA/npm is not guaranteed to be present in PATH for service/gateway
    // processes, so retain an explicit, verified Windows shim fallback.
    const appData = options.appData === undefined ? process.env.APPDATA : options.appData;
    if (appData) {
      const shim = path.join(appData, "npm", "pi.cmd");
      if (isFile(shim)) {
        const resolved = resolvedWindowsPiShim(shim, isFile, readTextFile, execPath);
        if (resolved) return resolved;
      }
    }
  }
  const native = pathCandidates.find((candidate) => candidate.source === "path-native");
  if (native) return { ...native, argsPrefix: [] };
  if (platform !== "win32") {
    const entry = hostEntry();
    if (entry) return hostLaunch(entry);
  }

  // Preserve the historical ENOENT failure mode when no resolver candidate is
  // installed, but make that unverified fallback explicit in diagnostics.
  return { command: "pi", argsPrefix: [], source: "path-fallback" };
}

export function getPiSpawnCommand(
  args: string[],
  options: PiSpawnCommandOptions = {},
): PiLaunchSpec & { args: string[]; shell: false } {
  const launch = resolvePiLaunchSpec(options);
  return {
    ...launch,
    args: [...launch.argsPrefix, ...args],
    shell: false,
  };
}

export interface PiLaunchDiagnostic {
  type: "teammate_pi_launch_diagnostic";
  source: PiLaunchSource;
  phase: "spawn" | "child-error" | "close";
  /** Measured from the selected child executable, not the parent SDK. */
  childVersion?: string;
  hostMode?: "native" | "legacy" | "unknown";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export function piLaunchDiagnostic(
  launch: Pick<PiLaunchSpec, "source">,
  phase: PiLaunchDiagnostic["phase"],
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): PiLaunchDiagnostic {
  return {
    type: "teammate_pi_launch_diagnostic",
    source: launch.source,
    phase,
    exitCode,
    signal,
    stderrTail: truncateUtf8Tail(stderr.trim(), EXECUTION_BUFFER_LIMITS.stderrBytes),
  };
}

export function formatPiLaunchDiagnostic(diagnostic: PiLaunchDiagnostic): string {
  return `source=${diagnostic.source}, phase=${diagnostic.phase}, exit=${diagnostic.exitCode ?? "null"}, `
    + `signal=${diagnostic.signal ?? "none"}`
    + (diagnostic.hostMode ? `, childVersion=${diagnostic.childVersion ?? "unverified"}, hostMode=${diagnostic.hostMode}` : "")
    + (diagnostic.stderrTail ? `\nstderr tail:\n${diagnostic.stderrTail}` : "");
}

export interface InteractiveTerminalLaunchOptions {
  platform?: NodeJS.Platform;
  terminalCommand?: string;
  title?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InteractiveTerminalLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const MANAGED_TERMINAL_ENV_KEYS = [
  MANAGED_WINDOW_ENV,
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  "MAESTRO_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "NODE_OPTIONS",
  "NODE_PATH",
] as const;

function managedTerminalEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { [MANAGED_WINDOW_ENV]: "1" };
  for (const name of MANAGED_TERMINAL_ENV_KEYS) {
    const value = environment[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

function posixEnvironmentArgs(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment).flatMap(([name, value]) => {
    if (value === undefined) return [];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`Cannot propagate environment variable ${JSON.stringify(name)} to Terminal.app.`);
    }
    if (value.includes("\0")) {
      throw new TypeError(`Cannot propagate environment variable ${JSON.stringify(name)} to Terminal.app: value contains NUL.`);
    }
    return [`${name}=${value}`];
  });
}

/** Build a shell-free terminal launcher where the platform supports argv forwarding. */
export function getInteractiveTerminalLaunchSpec(
  piCommand: { command: string; args: readonly string[] },
  cwd: string,
  options: InteractiveTerminalLaunchOptions = {},
): InteractiveTerminalLaunchSpec {
  const platform = options.platform ?? process.platform;
  const title = options.title ?? "Pi worker";

  if (platform === "win32") {
    return {
      command: options.terminalCommand ?? "wt.exe",
      args: [
        "--window",
        "new",
        "new-tab",
        "--title",
        title,
        "--startingDirectory",
        cwd,
        piCommand.command,
        ...piCommand.args,
      ],
      cwd,
    };
  }

  if (platform === "darwin") {
    const command = options.env
      ? [
          "/usr/bin/env",
          ...posixEnvironmentArgs(managedTerminalEnvironment(options.env)),
          piCommand.command,
          ...piCommand.args,
        ]
      : [piCommand.command, ...piCommand.args];
    const shellCommand = `cd ${quotePosixShellArg(cwd)} && exec ${command
      .map(quotePosixShellArg).join(" ")}`;
    return {
      command: options.terminalCommand ?? "/usr/bin/osascript",
      args: [
        "-e",
        `tell application "Terminal" to activate`,
        "-e",
        `tell application "Terminal" to do script ${quoteAppleScriptString(shellCommand)}`,
      ],
      cwd,
    };
  }

  return {
    command: options.terminalCommand ?? process.env.PI_TEAMMATE_TERMINAL ?? "x-terminal-emulator",
    args: ["-e", piCommand.command, ...piCommand.args],
    cwd,
  };
}

export interface ProcessTreeByPidOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof crossSpawn;
  killProcess?: typeof process.kill;
  isProcessAlive?: (pid: number) => boolean;
  taskkillTimeoutMs?: number;
  graceMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Terminate an explicitly owned process tree; callers must revalidate PID ownership first. */
export async function terminateProcessTreeByPid(
  pid: number,
  options: ProcessTreeByPidOptions = {},
): Promise<"stopped" | "already-exited"> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid owned process pid: ${pid}`);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const spawnProcess = options.spawnProcess ?? crossSpawn;
    const taskkillTimeoutMs = options.taskkillTimeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS;
    if (!Number.isSafeInteger(taskkillTimeoutMs) || taskkillTimeoutMs <= 0) {
      throw new Error(`Invalid taskkill timeout: ${taskkillTimeoutMs}`);
    }
    return new Promise<"stopped" | "already-exited">((resolve, reject) => {
      const killer = spawnProcess(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
          shell: false,
          timeout: taskkillTimeoutMs,
          killSignal: "SIGKILL",
        },
      );
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        killer.removeListener("error", onError);
        killer.removeListener("close", onClose);
        complete();
      };
      const onError = (error: Error): void => finish(() => reject(error));
      const onClose = (code: number | null): void => finish(() => {
        if (code === 0) resolve("stopped");
        else if (code === 128) resolve("already-exited");
        else reject(new Error(`taskkill exited with code ${code ?? "unknown"}`));
      });
      killer.once("error", onError);
      killer.once("close", onClose);
      timeout = setTimeout(() => {
        try {
          killer.kill?.("SIGKILL");
        } catch {
          // The taskkill subprocess may already be exiting.
        }
        finish(() => reject(new Error(`taskkill timed out after ${taskkillTimeoutMs}ms`)));
      }, taskkillTimeoutMs);
    });
  }

  const killProcess = options.killProcess ?? process.kill;
  const isAlive = options.isProcessAlive ?? processIsAlive;
  const graceMs = options.graceMs ?? 2_000;
  const pollMs = options.pollMs ?? 50;
  const sleepFor = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let signalTarget: "group" | "pid" | undefined;
  const signalTree = (signal: NodeJS.Signals): void => {
    if (signalTarget === "group") {
      try {
        killProcess(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      return;
    }
    if (signalTarget === "pid") {
      try {
        killProcess(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      return;
    }
    try {
      killProcess(-pid, signal);
      signalTarget = "group";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw error;
      try {
        killProcess(pid, signal);
        signalTarget = "pid";
      } catch (directError) {
        if ((directError as NodeJS.ErrnoException).code !== "ESRCH") throw directError;
      }
    }
  };
  const waitForExit = async (): Promise<boolean> => {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await sleepFor(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    return !isAlive(pid);
  };

  signalTree("SIGTERM");
  if (signalTarget === undefined) return "already-exited";
  if (await waitForExit()) return "stopped";
  signalTree("SIGKILL");
  if (await waitForExit()) return "stopped";
  throw new Error(`Owned process tree ${pid} did not exit after SIGKILL.`);
}

// ---------------------------------------------------------------------------
// AC4: Nesting depth guard
// ---------------------------------------------------------------------------

/** Maximum number of teammate-agent levels below the main agent. */
export const MAX_DEFAULT_DEPTH = 2;

export const DEFAULT_MAX_AGENTS = 15;

/**
 * Ceiling on concurrently live agents across the whole dispatch tree. The
 * per-call `maxAgents` limit only bounds a single dispatch, so without this a
 * depth-2 tree of 15-task graphs could reach 15^2 child processes.
 */
export const DEFAULT_MAX_ACTIVE_AGENTS = 32;

export function resolveMaxAgents(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit)) return Math.max(1, Math.floor(explicit));
  const env = parseInt(process.env.PI_TEAMMATE_MAX_AGENTS ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_MAX_AGENTS;
}

export function resolveMaxActiveAgents(): number {
  const env = parseInt(process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_MAX_ACTIVE_AGENTS;
}

/**
 * Fallback depth for dispatches that do not carry an explicit one — i.e. direct
 * `runTeammate` callers outside the extension (delegate/explore/moa). Nested
 * teammate calls never reach this: their child process only proxies the request
 * back to the root process, so the root's own environment would always read 0.
 * Those paths pass `RunTeammateOptions.depth` instead.
 */
export function getTeammateDepth(): number {
  const parsed = parseInt(process.env.PI_TEAMMATE_DEPTH ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Child-scoped nesting budget (absolute max dispatch depth). Only meaningful
 * inside a spawned child process; callers MUST gate the read on `isChild`.
 */
export function getTeammateMaxDispatchDepth(): number {
  const parsed = parseInt(process.env.PI_TEAMMATE_MAX_DISPATCH_DEPTH ?? "", 10);
  return Number.isFinite(parsed) ? parsed : MAX_DEFAULT_DEPTH - 1;
}

export function checkDepthGuard(depth: number): { allowed: boolean; current: number; max: number } {
  return { allowed: depth < MAX_DEFAULT_DEPTH, current: depth, max: MAX_DEFAULT_DEPTH };
}

/**
 * Absolute max dispatch depth for agents spawned by a root (depth-0) dispatch.
 * `maxNestingDepth: 0` forbids nested calls entirely; the global ceiling caps
 * any larger value, so under the current MAX only 0 vs 1+ are distinguishable.
 */
export function rootChildMaxDispatchDepth(maxNestingDepth?: number): number {
  return Math.max(0, Math.min(MAX_DEFAULT_DEPTH - 1, maxNestingDepth ?? MAX_DEFAULT_DEPTH));
}

/**
 * Absolute max dispatch depth for agents spawned by a proxied dispatch from a
 * parent with `parentBudget`, at `childDepth`. The parent's budget is the hard
 * cap; the call's own `maxNestingDepth` may only tighten it further.
 */
export function nestedChildMaxDispatchDepth(
  parentBudget: number,
  childDepth: number,
  maxNestingDepth?: number,
): number {
  const own = childDepth + (maxNestingDepth ?? MAX_DEFAULT_DEPTH);
  return Math.max(0, Math.min(MAX_DEFAULT_DEPTH - 1, parentBudget - 1, own));
}

/** Whether a dispatch creating agents at `dispatchDepth` is allowed under `parentBudget`. */
export function dispatchAllowed(parentBudget: number, dispatchDepth: number): boolean {
  return dispatchDepth <= Math.min(MAX_DEFAULT_DEPTH - 1, parentBudget);
}

/** Budget of an agent record that predates per-dispatch budgets: global ceiling. */
export function agentDispatchBudget(agent: { maxDispatchDepth?: number }): number {
  return agent.maxDispatchDepth ?? MAX_DEFAULT_DEPTH - 1;
}

// ---------------------------------------------------------------------------
// AC5: Session directory management
// ---------------------------------------------------------------------------

export function getTeammateSessionRoot(parentSessionFile: string | null): string | undefined {
  if (!parentSessionFile) return undefined;
  const baseName = path.basename(parentSessionFile, ".jsonl");
  const sessionsDir = path.dirname(parentSessionFile);
  return path.join(sessionsDir, baseName);
}

// ---------------------------------------------------------------------------
// AC7: Model fallback chain
// ---------------------------------------------------------------------------

export function buildModelCandidates(primary?: string, fallbacks?: string[]): string[] {
  return [...new Set([primary, ...(fallbacks ?? [])].filter((model): model is string => Boolean(model)))];
}

export function isFallbackModelError(messages: Array<{ role: string; content: string }>): boolean {
  return messages.some((message) =>
    message.role === "system" && isFallbackProviderError(message.content)
  );
}

export function resultFailureMessage(messages: Array<{ role: string; content: string }>): string {
  const newestSystemFirst = messages.filter((message) => message.role === "system").reverse();
  return newestSystemFirst.find((message) => isFallbackProviderError(message.content))?.content
    ?? newestSystemFirst[0]?.content
    ?? messages.at(-1)?.content
    ?? "Unknown teammate failure";
}

export function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(false);
    const finish = (ready: boolean) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(ready);
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(true), delayMs);
  });
}

export interface RetrySettingSnapshot {
  hadRetry: boolean;
  hadEnabled: boolean;
  enabled?: boolean;
}

export interface RetryPersistenceGuard {
  depth: number;
  snapshot?: RetrySettingSnapshot;
  restoreTimer?: ReturnType<typeof setTimeout>;
}

export const retryPersistenceGuards = new Map<string, RetryPersistenceGuard>();

/**
 * Pi's RPC set_auto_retry command persists to settings.json even though the
 * child only needs a session-local override. Restore the original value after
 * every concurrently starting child has acknowledged that command.
 */
export function acquireRetryPersistenceGuard(settingsPath: string): () => void {
  const existing = retryPersistenceGuards.get(settingsPath);
  if (!existing) {
    const snapshot = readRetrySettingSnapshot(settingsPath);
    if (snapshot?.hadEnabled && snapshot.enabled === false) return () => {};
  }
  if (existing?.restoreTimer) {
    clearTimeout(existing.restoreTimer);
    existing.restoreTimer = undefined;
  }
  const guard = existing ?? {
    depth: 0,
    snapshot: readRetrySettingSnapshot(settingsPath),
  };
  guard.depth += 1;
  retryPersistenceGuards.set(settingsPath, guard);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    guard.depth -= 1;
    if (guard.depth > 0) return;
    guard.restoreTimer = setTimeout(() => {
      guard.restoreTimer = undefined;
      if (guard.depth > 0) return;
      retryPersistenceGuards.delete(settingsPath);
      if (guard.snapshot) restoreRetrySettingSnapshot(settingsPath, guard.snapshot);
    }, 250);
  };
}

export function readRetrySettingSnapshot(settingsPath: string): RetrySettingSnapshot | undefined {
  try {
    const root = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
    const retry = (root as Record<string, unknown>).retry;
    const hadRetry = Boolean(retry && typeof retry === "object" && !Array.isArray(retry));
    const record = hadRetry ? retry as Record<string, unknown> : undefined;
    return {
      hadRetry,
      hadEnabled: typeof record?.enabled === "boolean",
      ...(typeof record?.enabled === "boolean" ? { enabled: record.enabled } : {}),
    };
  } catch {
    return undefined;
  }
}

export function restoreRetrySettingSnapshot(settingsPath: string, snapshot: RetrySettingSnapshot): void {
  try {
    const root = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (!root || typeof root !== "object" || Array.isArray(root)) return;
    const retry = root.retry && typeof root.retry === "object" && !Array.isArray(root.retry)
      ? { ...root.retry as Record<string, unknown> }
      : {};
    const currentHadEnabled = typeof retry.enabled === "boolean";
    if (
      currentHadEnabled === snapshot.hadEnabled
      && (!snapshot.hadEnabled || retry.enabled === snapshot.enabled)
    ) return;
    if (snapshot.hadEnabled) retry.enabled = snapshot.enabled;
    else delete retry.enabled;
    if (!snapshot.hadRetry && Object.keys(retry).length === 0) delete root.retry;
    else root.retry = retry;
    const temporary = `${settingsPath}.${process.pid}.${randomUUID()}.retry.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, settingsPath);
  } catch {
    // Best effort: a failed restore must not hide the child result.
  }
}

export function childSettingsPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolvePiAgentDirectory(env), "settings.json");
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

export const MODEL_SPECIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;
export const MAX_MODEL_SPECIFIER_BYTES = 256;

export function validateModelSpecifier(model: string): string {
  if (
    Buffer.byteLength(model, "utf8") > MAX_MODEL_SPECIFIER_BYTES
    || !MODEL_SPECIFIER_PATTERN.test(model)
  ) {
    throw new TypeError(`Invalid teammate model specifier: ${JSON.stringify(model)}`);
  }
  return model;
}

/** Control and formatting characters no specifier may carry, in any namespace. */
const MODEL_SPECIFIER_CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

/**
 * Check a specifier the host does not own the format of.
 *
 * A dispatch bound for a registered backend names a model in that backend's
 * catalogue — an ACP agent's bracketed variant, a dsh route, a remote target's
 * own identifier. The host neither defines those namespaces nor can resolve
 * them, so `MODEL_SPECIFIER_PATTERN`, which encodes the host's own
 * `provider/model` convention, is the wrong authority.
 *
 * What survives is not a format claim but protection for the host's own
 * machinery: these strings become circuit-breaker keys, log lines, and, for
 * some backends, process arguments. A bound and a control-character refusal
 * keep those safe without deciding what a foreign namespace may look like.
 *
 * @param model - the specifier a backend will resolve for itself.
 * @returns the specifier unchanged.
 * @throws when it is empty, oversized, or carries control characters.
 */
export function validateBackendModelSpecifier(model: string): string {
  if (model.trim().length === 0) {
    throw new TypeError("Teammate model specifier for a backend dispatch must not be empty");
  }
  if (Buffer.byteLength(model, "utf8") > MAX_MODEL_SPECIFIER_BYTES) {
    throw new TypeError(
      `Teammate model specifier exceeds ${MAX_MODEL_SPECIFIER_BYTES} bytes: ${JSON.stringify(model.slice(0, 64))}…`,
    );
  }
  if (MODEL_SPECIFIER_CONTROL_CHARACTERS.test(model)) {
    throw new TypeError(
      `Teammate model specifier must not carry control characters: ${JSON.stringify(model)}`,
    );
  }
  return model;
}

export function resolveModelSpecifier(
  model: string,
  modelCapabilities: readonly TeammateModelCapability[] = [],
): string {
  validateModelSpecifier(model);
  if (modelCapabilities.length === 0) return model;
  if (model.includes("/")) {
    if (modelCapabilities.some((candidate) => candidate.id === model)) return model;
    throw new TypeError(`Unknown teammate model specifier ${JSON.stringify(model)}. Use an available provider/model identifier.`);
  }

  const matches = modelCapabilities
    .map((candidate) => candidate.id)
    .filter((candidate) => candidate.startsWith(`${model}/`) || candidate.endsWith(`/${model}`));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new TypeError(`Ambiguous teammate model specifier ${JSON.stringify(model)}. Matches: ${matches.join(", ")}`);
  }
  throw new TypeError(`Unknown teammate model specifier ${JSON.stringify(model)}. Use an exact provider/model identifier.`);
}

function teammateExtensionPath(): string {
  return fileURLToPath(new URL("../extension/index.ts", import.meta.url));
}

export function buildInheritedExtensionArgs(primaryExtensionPath: string): string[] {
  const args = ["--extension", primaryExtensionPath];
  const loaded = new Set([process.platform === "win32" ? primaryExtensionPath.toLowerCase() : primaryExtensionPath]);
  for (const registration of getTeammateChildExtensions()) {
    const key = process.platform === "win32" ? registration.path.toLowerCase() : registration.path;
    if (loaded.has(key)) continue;
    loaded.add(key);
    args.push("--extension", registration.path);
  }
  return args;
}

export function managedWindowSpawnEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const spawnEnvironment = { ...environment, [MANAGED_WINDOW_ENV]: "1" };
  for (const [name, value] of Object.entries(spawnEnvironment)) {
    if (value?.includes("\0")) {
      throw new TypeError(`Cannot propagate environment variable ${JSON.stringify(name)} to a managed window: value contains NUL.`);
    }
  }
  return spawnEnvironment;
}

export interface ManagedWindowArgsOptions {
  sessionName: string;
  presentation: "headless" | "interactive";
  forkSessionFile?: string;
}

export function buildManagedWindowPiArgs(options: ManagedWindowArgsOptions): string[] {
  const args = [
    ...(options.presentation === "headless" ? ["--mode", "rpc"] : []),
    "--no-extensions",
    ...buildInheritedExtensionArgs(teammateExtensionPath()),
  ];
  if (options.forkSessionFile) args.push("--fork", options.forkSessionFile);
  args.push("--name", options.sessionName);
  return args;
}

export function buildPiArgs(
  agentConfig: AgentConfig,
  params: RunSingleTeammateParams,
  systemPromptFile: string,
  modelOverride?: string,
  sessionDir?: string,
  forkSessionFile?: string,
  schemaFile?: string,
  modelCapabilities: readonly TeammateModelCapability[] = [],
  resumeSessionFile?: string,
): string[] {
  // RPC mode: stdin stays open for bidirectional messaging (steer/follow_up/abort).
  // Child extensions are passed explicitly below; disable settings discovery so an
  // older duplicate package registration cannot load the same tools a second time.
  const args: string[] = ["--mode", "rpc", "--no-extensions"];

  // Child mode owns session identity publication, lease fencing, and proxy tools.
  // Load it explicitly because the child cwd may not discover this package.
  args.push(...buildInheritedExtensionArgs(teammateExtensionPath()));

  if (resumeSessionFile) {
    args.push("--session", resumeSessionFile);
  } else if (forkSessionFile) {
    args.push("--fork", forkSessionFile);
  }

  const model = modelOverride ?? params.model ?? agentConfig.model;
  if (model) {
    args.push("--model", resolveModelSpecifier(model, modelCapabilities));
  }

  const requestedThinking = parseTeammateThinkingLevel(params.thinking) ?? agentConfig.thinking;
  if (requestedThinking) {
    // Thinking depth passes through unchanged: the teammate layer never
    // restricts levels; the child Pi host clamps to its own capability
    // boundary when a provider cannot honor the requested level.
    args.push("--thinking", requestedThinking);
  }

  if (agentConfig.tools && agentConfig.tools.length > 0) {
    const hiddenLegacyObservationTools = ["teammate-watch", "teammate-wait", "teammate-monitor"];
    const exposeLegacyObservationTools = process.env.PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS === "1";
    const configuredTools = exposeLegacyObservationTools
      ? agentConfig.tools
      : agentConfig.tools.filter((tool) => !hiddenLegacyObservationTools.includes(tool));
    const legacyObservationTools = exposeLegacyObservationTools ? hiddenLegacyObservationTools : [];
    const proxyTools = ["teammate", "teammate-send", "teammate-list", "observe", ...legacyObservationTools];
    const inheritedTools = getTeammateChildExtensions().flatMap((registration) => registration.tools);
    const toolSet = new Set([...configuredTools, ...proxyTools, ...inheritedTools]);
    if (schemaFile) toolSet.add("structured_output");
    args.push("--tools", [...toolSet].join(","));
  }

  if (schemaFile) {
    const structuredOutputExtension = fileURLToPath(
      new URL("../extension/structured-output.ts", import.meta.url),
    );
    args.push("--extension", structuredOutputExtension);
  }

  args.push(
    agentConfig.systemPromptMode === "replace"
      ? "--system-prompt"
      : "--append-system-prompt",
    systemPromptFile,
  );

  if (!agentConfig.inheritProjectContext) {
    args.push("--no-context-files");
  }

  if (!agentConfig.inheritSkills) {
    args.push("--no-skills");
  }

  if (sessionDir) {
    args.push("--session-dir", sessionDir);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Write temporary files
// ---------------------------------------------------------------------------

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function shouldEnforcePosixMode(): boolean {
  return process.platform !== "win32";
}

/**
 * Root for prompt/schema/result scratch files, whose contents include the full
 * agent system prompt.
 *
 * POSIX gets its privacy from chmod(0o700). Windows ignores mkdir modes and has
 * no fchmod, so the only lever left is location: %LOCALAPPDATA% is already a
 * per-user tree, unlike the shared %TEMP% fallback.
 */
export function teammateTempRoot(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return path.join(localAppData, "pi-teammate", "tmp");
  }
  return path.join(os.tmpdir(), "pi-teammate");
}

export function ensurePrivateDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error(`Private teammate path is not a directory: ${directoryPath}`);
  }
  // mkdir mode is creation-only. Tighten an existing directory explicitly.
  if (shouldEnforcePosixMode()) fs.chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function writePrivateTextFile(filePath: string, content: string): void {
  const fd = openPrivateRegularFile(filePath);
  try {
    // Secure the opened inode before truncating or writing sensitive content.
    // Windows relies on its ACL semantics.
    if (shouldEnforcePosixMode()) fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, { encoding: "utf8" });
  } finally {
    fs.closeSync(fd);
  }
}

export function openPrivateRegularFile(filePath: string): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const existingFlags = fs.constants.O_WRONLY | noFollow;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(filePath, existingFlags, PRIVATE_FILE_MODE);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ELOOP" || code === "EISDIR") {
        throw new Error(`Private teammate path is not a regular file: ${filePath}`);
      }
      if (code !== "ENOENT") throw error;
      try {
        fd = fs.openSync(
          filePath,
          existingFlags | fs.constants.O_CREAT | fs.constants.O_EXCL,
          PRIVATE_FILE_MODE,
        );
      } catch (createError) {
        if (errorCode(createError) === "EEXIST" && attempt === 0) continue;
        throw createError;
      }
    }
    const stat = fs.fstatSync(fd);
    if (stat.isFile()) return fd;
    fs.closeSync(fd);
    throw new Error(`Private teammate path is not a regular file: ${filePath}`);
  }
  throw new Error(`Private teammate path changed while opening: ${filePath}`);
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

export function readRegularTextFile(filePath: string): string {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP" || code === "EISDIR") {
      throw new Error(`Private teammate path is not a regular file: ${filePath}`);
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`Private teammate path is not a regular file: ${filePath}`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function inlineLegacySearchTemplateReferences(systemPrompt: string): string {
  return systemPrompt.replace(
    /@?~\/\.maestro\/templates\/search-tools\.md/g,
    "the built-in search discipline below",
  );
}

export function writeSystemPromptFile(
  agentConfig: AgentConfig,
  correlationId: string,
  outputSchema?: Record<string, unknown>,
  todos?: string[],
): string {
  const tmpDir = teammateTempRoot();
  ensurePrivateDirectory(tmpDir);
  const promptFile = path.join(tmpDir, `prompt-${correlationSessionDirectoryName(correlationId)}.md`);
  const systemPrompt = inlineLegacySearchTemplateReferences(agentConfig.systemPrompt);
  const structuredOutputInstruction = outputSchema
    ? "\n\n## Required structured output\nYou must finish by calling the structured_output tool exactly once with a value that satisfies its JSON Schema. A prose-only final answer is invalid. Do not emit any answer after that tool call."
    : "";
  const todoInstruction = todos && todos.length > 0
    ? `\n\n## Assigned Todo tasks\nYour assigned Todo tasks, in priority order (you manage them yourself): ${todos.map((id) => `#${id.replace(/^#/, "")}`).join(", ")}.\nCheck \`todo list\` for their current states: the first runnable task (pending, not blocked, and no other active task for you) is already active (status=in_progress); if it is not active yet, activate it with \`todo update <id> status=in_progress\`.\nFinish each task with \`todo update <id> status=completed summary=<one-line result>\`, then activate the next one with \`todo update <id> status=in_progress\` and continue in order. Drive your queue with \`todo update\` only — \`todo next\` is root's self-drive channel.\nIf a task is blocked by a dependency or you cannot complete it, leave it pending and explain why in your final answer.`
    : "";
  // B1: result publication discipline. A text-only turn emitted while tool
  // calls are still in flight can be misread as the final answer and publish
  // a consumable result before the work is done. Keep narration inside the
  // active turn; emit the final text answer only after tool work is complete.
  const resultPublicationDiscipline =
    "\n\n## Result publication discipline\n" +
    "Do not emit a stop-terminated text-only turn while tool calls are still in flight. " +
    "If you need to narrate progress mid-task, continue the turn (do not stop) or use a tool call. " +
    "Emit your final text answer only after all tool calls have completed.";
  // B1: coordination reporting discipline. teammate-send steer interrupts
  // the parent's active turn; streaming each intermediate finding as a separate
  // steer fragments the parent's final synthesis and is not a coordination
  // use. Accumulate intermediate findings into the single final result; send
  // teammate-send only for a hard blocker the parent must resolve, a safety/
  // lifecycle constraint, or the one consolidated result when an explicit
  // reply target requires it.
  const coordinationReportingDiscipline =
    "\n\n## Coordination reporting discipline\n" +
    "Do not send teammate-send for routine intermediate findings. A steer message interrupts the parent's active turn; streaming each discovery as a separate steer fragments the parent's final answer and is not a coordination use.\n" +
    "Accumulate intermediate findings into your single final result and return them there. Use teammate-send only for: a hard blocker the parent must resolve before you can continue, a safety or lifecycle constraint, or the one consolidated result when the dispatch prompt names an explicit reply target. Batch all findings into that single message instead of sending them one at a time.\n" +
    "Never send routine acknowledgements, status pings, or incremental progress reports. Do not resend a queued or accepted message.";
  const toolPathAndSearchDiscipline =
    "\n\n## Tool path and search discipline\n" +
    "This section is self-contained and supersedes any role instruction to load a user-home search template. Do not load external user-home search templates or guess a user home to locate one.\n" +
    "Search only within the task working directory, paths explicitly named in the task, or another path whose existence you verified directly. Never search a filesystem root or drive root; forbidden examples include `find /`, `rg <pattern> /`, `Get-ChildItem C:\\\\ -Recurse`, and recursive scans of `C:/`.\n" +
    "If an expected file is absent, report the exact missing path and continue with bounded known roots when possible; do not broaden to a root-wide search. Use the narrowest available search or read tool, and give shell searches an explicit timeout.";
  const compactionRecoveryDiscipline =
    "\n\n## Compaction recovery discipline\n" +
    "After compact or new_context, resume the same dispatched task, not a new exploration or the parent's whole objective. Recover the original target, scope, acceptance condition, output contract, caller identity, and exact next action before more tool calls; this applies even without an assigned Todo.\n" +
    "When preparing a handoff, preserve confirmed findings with exact evidence references, searched paths and negative results, unresolved targets, consumed search rounds/tool-call limits, remaining budget, and the stop condition. Compaction does not reset the task's cumulative budget; neither do replacement workers, task names, or approaches for the same shared interface/state machine and delivery blocker. If auxiliary infrastructure blocks the requested outcome, report its necessity and any simpler equivalent option to the caller rather than expanding the assignment or bypassing gates. Reuse still-valid findings instead of repeating discovery solely to reconstruct context or refine citations.\n" +
    "Preserve any dispatched child correlation IDs and known result/publication URIs with their last observed state. A missing completion notification is not proof a child is still running; recover that exact child/result through available observation or resource tools instead of redispatching or polling. Do not invent IDs or infer completion from an old snapshot.\n" +
    "If the acceptance condition is met or the search budget is exhausted, return the consolidated result with explicit unresolved items using the required output contract. If essential task state cannot be recovered with available bounded history/resource tools, report the blocker to the caller instead of guessing or broadening the task.";
  writePrivateTextFile(promptFile, `${systemPrompt}${structuredOutputInstruction}${todoInstruction}${resultPublicationDiscipline}${coordinationReportingDiscipline}${toolPathAndSearchDiscipline}${compactionRecoveryDiscipline}`);
  return promptFile;
}

export function writeSchemaFile(schema: Record<string, unknown>, correlationId: string): { schemaFile: string; outputFile: string } {
  const tmpDir = teammateTempRoot();
  ensurePrivateDirectory(tmpDir);
  const fileId = correlationSessionDirectoryName(correlationId);
  const schemaFile = path.join(tmpDir, `schema-${fileId}.json`);
  const outputFile = path.join(tmpDir, `output-${fileId}.json`);
  writePrivateTextFile(schemaFile, JSON.stringify(schema));
  // Reserve the result path with private permissions before the child starts,
  // closing the predictable-name creation race in the shared temp directory.
  writePrivateTextFile(outputFile, "");
  return { schemaFile, outputFile };
}

export function cleanupFile(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// AC8: Progress helper
// ---------------------------------------------------------------------------

export function createProgress(agent: string, startTime: number): AgentProgress {
  return {
    agent,
    status: "running",
    phase: "starting",
    recentTools: [],
    toolCount: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    lastActivityAt: startTime,
    startedAt: startTime,
  };
}

export const CHILD_TERMINATION_GRACE_MS = 5_000;

// A result-ready lane settles with its published result if the authoritative
// lifecycle confirmation (agent_settled/close) is this late, so aggregation never
// blocks indefinitely on a missing terminal event.
export const RESULT_READY_GRACE_MS = 60_000;

// C2: when an agent performed tool work before publishing its result-ready turn,
// the agent_settled confirmation may trail behind the last tool result by more
// than the default grace (tool I/O latency, retry, compaction). Give those runs
// a wider window so legitimate post-tool convergence is not misterminated.
// Pure Q&A runs (no tool work) keep the default 60s.
export const RESULT_READY_GRACE_EXTENDED_MS = 120_000;

/** Select one consistent lifecycle grace for text and structured-output lanes. */
export function resultReadyGraceMsFor(
  completedToolCount: number,
  overrideMs?: number,
): number {
  return overrideMs
    ?? (completedToolCount > 0 ? RESULT_READY_GRACE_EXTENDED_MS : RESULT_READY_GRACE_MS);
}

// A corrective structured-output continuation is one model round-trip, but
// still bounded so a child that never responds settles as a failure instead of
// holding the run open indefinitely.

// Output-limit recovery includes a summary provider round-trip and may outlive
// the short result-publication grace window. It is still bounded so a child
// that cannot compact reports the partial result as a failure instead of hanging.
export const OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS = 5 * 60_000;

// Child startup is an infrastructure boundary, independent of the caller's
// foreground wait window. A process that never emits any event is not useful
// background work and must still settle as failed.
export const FIRST_ACTIVITY_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Working-directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `params.cwd` relative to the session directory while permitting an
 * explicit path outside the current project. Existing paths are canonicalized;
 * non-existent paths keep their lexical form so spawn reports the normal error.
 */
export function canonicalDirectoryPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveContainedCwd(
  requested: string | undefined,
  baseCwd: string,
): { cwd: string } | { error: string } {
  if (requested === undefined) return { cwd: baseCwd };
  return { cwd: canonicalDirectoryPath(path.resolve(baseCwd, requested)) };
}

/** Prefix marking a working location as a configured remote target. */
export const REMOTE_LOCATION_PREFIX = "remote:";

/** A remote working location, read as a backend selection. */
export interface RemoteLocationRouting {
  readonly backend: string;
  readonly targetId: string;
}

/**
 * Read a working location as a backend selector.
 *
 * The whole string, prefix included, is the registration name, so a bare
 * `remote:` with no target still names one — and the registry rejects it as
 * unregistered, which is the failure this should have.
 *
 * This is the single projection point for the rule. Every dispatch path resolves
 * its location through it, so a nested or proxied dispatch is routed by the same
 * rule rather than falling through to `resolveContainedCwd`, which would read
 * `remote:beta` as a directory named `remote:beta` under the base.
 *
 * @param cwd - the task's requested working location.
 * @returns the routing, or undefined when the location is an ordinary directory.
 */
export function remoteLocationRouting(cwd: string | undefined): RemoteLocationRouting | undefined {
  if (cwd === undefined || !cwd.startsWith(REMOTE_LOCATION_PREFIX)) return undefined;
  return { backend: cwd, targetId: cwd.slice(REMOTE_LOCATION_PREFIX.length) };
}

// ---------------------------------------------------------------------------
// Structured-output schema safety
// ---------------------------------------------------------------------------

export const STRUCTURED_OUTPUT_SCHEMA_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 20,
  maxPatternLength: 200,
});

// A quantifier applied to a group that already contains one — the classic
// catastrophic-backtracking shape, e.g. /^(a+)+$/ or /(\w*\s?)*$/.
export const NESTED_QUANTIFIER = /\([^()]*[*+}][^()]*\)\s*[*+{]/;

export function isRiskyRegexSource(source: string): boolean {
  return source.length > STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxPatternLength
    || NESTED_QUANTIFIER.test(source);
}

// Common misspellings of JSON-Schema keywords that TypeBox would silently
// ignore, producing schemas that validate less strictly than the caller
// believes (or, with additionalProperties:false, can never validate at all).
const REQUIRED_TYPO_KEYS = ["require", "requried"] as const;
const PROPERTIES_TYPO_KEYS = ["propterties", "additionalproperty"] as const;

const SCHEMA_KEYWORD_KEYS = new Set([
  "type", "properties", "required", "items", "enum", "const", "allOf",
  "anyOf", "oneOf", "not", "patternProperties", "additionalProperties",
  "additionalItems", "if", "then", "else", "format", "pattern",
  "minLength", "maxLength", "minimum", "maximum", "uniqueItems",
  "description", "title", "$ref", "$schema",
]);

const VALID_SCHEMA_TYPES = new Set([
  "object", "array", "string", "number", "integer", "boolean", "null",
]);

/**
 * Nodes that carry any recognized schema keyword are treated as schema
 * objects; keyword-typo detection is skipped for plain data nodes (e.g. a
 * "default" value) so legitimate values never false-positive.
 */
function isSchemaShapedNode(node: Record<string, unknown>): boolean {
  return Object.keys(node).some((key) => SCHEMA_KEYWORD_KEYS.has(key));
}

/**
 * The model may submit any JSON Schema, and TypeBox compiles its `pattern`
 * keywords into RegExp objects that then run on this process's main thread on
 * every assistant event. Reject the hazardous shapes up front instead of
 * silently dropping keywords, so a valid schema still validates exactly as before.
 */
export function findStructuredOutputSchemaHazard(
  schema: Record<string, unknown>,
): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema) ?? "";
  } catch {
    return "outputSchema is not serializable JSON.";
  }
  if (Buffer.byteLength(serialized, "utf8") > STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxBytes) {
    return `outputSchema exceeds ${STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxBytes} bytes.`;
  }

  const visit = (node: unknown, depth: number, path: string): string | undefined => {
    if (depth > STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxDepth) {
      return `outputSchema nests deeper than ${STRUCTURED_OUTPUT_SCHEMA_LIMITS.maxDepth} levels.`;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const hazard = visit(node[index], depth + 1, `${path}/${index}`);
        if (hazard) return hazard;
      }
      return undefined;
    }
    if (!node || typeof node !== "object") return undefined;
    const record = node as Record<string, unknown>;
    if (isSchemaShapedNode(record)) {
      for (const typo of REQUIRED_TYPO_KEYS) {
        if (typo in record) {
          return `outputSchema at ${path} contains misspelled keyword "${typo}" (did you mean "required"?).`;
        }
      }
      for (const typo of PROPERTIES_TYPO_KEYS) {
        if (typo in record) {
          return `outputSchema at ${path} contains misspelled keyword "${typo}" (did you mean "properties"?).`;
        }
      }
      if (
        record.properties !== undefined
        && (
          !record.properties
          || typeof record.properties !== "object"
          || Array.isArray(record.properties)
        )
      ) {
        return `outputSchema at ${path} has a "properties" value that is not an object.`;
      }
      if (record.required !== undefined) {
        if (!Array.isArray(record.required) || record.required.some((item) => typeof item !== "string")) {
          return `outputSchema at ${path} has a "required" value that is not an array of strings.`;
        }
        if (record.additionalProperties === false) {
          const props = record.properties as Record<string, unknown> | undefined;
          for (const item of record.required) {
            if (!props || !(item in props)) {
              return `outputSchema at ${path}: required property ${JSON.stringify(item)} is not declared in "properties" while "additionalProperties" is false — the value can never validate.`;
            }
          }
        }
      }
      if (record.type !== undefined) {
        const types = Array.isArray(record.type) ? record.type : [record.type];
        if (
          types.length === 0
          || types.some((t) => typeof t !== "string" || !VALID_SCHEMA_TYPES.has(t))
        ) {
          return `outputSchema at ${path} has an invalid "type" (${JSON.stringify(record.type)}) — expected one of object|array|string|number|integer|boolean|null.`;
        }
      }
      if (record.items !== undefined) {
        const validItems = typeof record.items === "boolean"
          || (typeof record.items === "object" && record.items !== null);
        if (!validItems) {
          return `outputSchema at ${path} has an "items" value that is not a schema, boolean schema, or tuple schema array.`;
        }
      }
      if (record.enum !== undefined) {
        if (!Array.isArray(record.enum) || record.enum.length === 0) {
          return `outputSchema at ${path} has an "enum" value that is not a non-empty array.`;
        }
      }
      if (path === "/" && typeof record.prompt === "string") {
        return `outputSchema at ${path} has a task-text "prompt" key, which is not a JSON Schema keyword — move it to the task level (tasks[].prompt).`;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === "pattern" && typeof value === "string" && isRiskyRegexSource(value)) {
        return `outputSchema contains a pattern that risks catastrophic backtracking: ${value}`;
      }
      if (key === "patternProperties" && value && typeof value === "object") {
        for (const source of Object.keys(value as Record<string, unknown>)) {
          if (isRiskyRegexSource(source)) {
            return `outputSchema contains a patternProperties key that risks catastrophic backtracking: ${source}`;
          }
        }
      }
      const hazard = visit(value, depth + 1, `${path}/${key}`);
      if (hazard) return hazard;
    }
    return undefined;
  };

  const nested = visit(schema, 0, "/");
  if (nested) return nested;

  // Root contract (docs/tool-schema-reference): structured output must be a
  // single type:"object" schema; a root-level anyOf/oneOf is rejected by
  // providers when the child registers the structured_output tool.
  if (schema.anyOf !== undefined || schema.oneOf !== undefined) {
    return `outputSchema root must not use "anyOf"/"oneOf" — use a single type:"object" schema.`;
  }
  if (schema.type === undefined) {
    return `outputSchema root must declare type "object".`;
  }
  const rootTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (rootTypes.length !== 1 || rootTypes[0] !== "object") {
    const typeLabel = JSON.stringify(schema.type);
    if (schema.enum !== undefined) {
      // type+enum at the root is the common analyst-style mistake: a
      // fixed-value answer written as a bare primitive. Structured output is
      // contractually an object, so point at the wrapping shape instead of a
      // bare "must be object" rejection.
      return `outputSchema root must be a single type:"object" schema (got ${typeLabel} with "enum") — structured output must be an object; move the value choice into a property, e.g. { "type": "object", "properties": { "value": { "type": ${typeLabel}, "enum": [...] } }, "required": ["value"] }.`;
    }
    return `outputSchema root must be a single type:"object" schema (got ${typeLabel}).`;
  }
  return undefined;
}

export type ChildReclamationOutcome =
  | {
      status: "reclaimed";
      forced: boolean;
      /** False when the direct child exited but Windows taskkill never confirmed its tree sweep. */
      treeCleanupConfirmed?: false;
    }
  | {
      status: "unreaped";
      forced: boolean;
      reason: "delivery-failed" | "exit-unconfirmed" | "cleanup-before-exit";
    };

export interface ChildTerminationController {
  /** Bounded physical-process outcome, separate from logical turn settlement. */
  readonly outcome: Promise<ChildReclamationOutcome>;
  terminate(): void;
  cleanup(): void;
}

export interface ChildTerminationOptions {
  graceMs?: number;
  /** Bound after the forced attempt for exit/tree-cleanup acknowledgement. */
  reclamationTimeoutMs?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
}

/** @internal Exported for lifecycle regression tests. */
export function createChildTerminationController(
  child: ChildProcess,
  options: ChildTerminationOptions = {},
): ChildTerminationController {
  const graceMs = options.graceMs ?? CHILD_TERMINATION_GRACE_MS;
  const reclamationTimeoutMs = options.reclamationTimeoutMs ?? graceMs;
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  let exitObserved = child.exitCode !== null || child.signalCode !== null;
  let terminationStarted = false;
  let forced = false;
  let windowsTreeCleanupConfirmed = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  let outcomeSettled = false;
  let resolveOutcome!: (outcome: ChildReclamationOutcome) => void;
  const outcome = new Promise<ChildReclamationOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const settleOutcome = (value: ChildReclamationOutcome): void => {
    if (outcomeSettled) return;
    outcomeSettled = true;
    resolveOutcome(value);
  };
  const clearForceTimer = (): void => {
    if (!forceTimer) return;
    clearTimeout(forceTimer);
    forceTimer = undefined;
  };
  const clearConfirmationTimer = (): void => {
    if (!confirmationTimer) return;
    clearTimeout(confirmationTimer);
    confirmationTimer = undefined;
  };
  const isAlive = (): boolean =>
    !exitObserved && child.exitCode === null && child.signalCode === null;
  const markReclaimed = (
    treeCleanupConfirmed = platform !== "win32" || !terminationStarted || windowsTreeCleanupConfirmed,
  ): void => {
    clearForceTimer();
    clearConfirmationTimer();
    settleOutcome({
      status: "reclaimed",
      forced,
      ...(treeCleanupConfirmed ? {} : { treeCleanupConfirmed: false as const }),
    });
  };
  const onExit = (): void => {
    exitObserved = true;
    if (platform !== "win32" || !terminationStarted || windowsTreeCleanupConfirmed) {
      markReclaimed();
    }
  };
  const armExitConfirmation = (): void => {
    clearConfirmationTimer();
    confirmationTimer = setTimeout(() => {
      confirmationTimer = undefined;
      if (platform === "win32" && terminationStarted && !windowsTreeCleanupConfirmed) {
        if (!isAlive()) markReclaimed(false);
        else settleOutcome({ status: "unreaped", forced: true, reason: "exit-unconfirmed" });
      } else if (!isAlive()) markReclaimed();
      else settleOutcome({ status: "unreaped", forced: true, reason: "exit-unconfirmed" });
    }, reclamationTimeoutMs);
    confirmationTimer.unref?.();
  };
  const killDirect = (signal: NodeJS.Signals): boolean => {
    if (!isAlive()) {
      markReclaimed();
      return true;
    }
    try {
      const delivered = child.kill(signal);
      if (!isAlive()) markReclaimed();
      else if (!delivered && signal === "SIGKILL") {
        settleOutcome({ status: "unreaped", forced: true, reason: "delivery-failed" });
      }
      return delivered;
    } catch {
      if (!isAlive()) {
        markReclaimed();
        return true;
      }
      if (signal === "SIGKILL") {
        settleOutcome({ status: "unreaped", forced: true, reason: "delivery-failed" });
      }
      return false;
    }
  };
  const killWindowsTree = (force: boolean): void => {
    if (windowsTreeCleanupConfirmed) return;
    forced ||= force;
    const fallbackDirect = (): void => {
      const delivered = killDirect(force ? "SIGKILL" : "SIGTERM");
      if (force && delivered && isAlive()) armExitConfirmation();
    };
    if (!child.pid) {
      fallbackDirect();
      return;
    }
    try {
      const killer = spawnProcess(
        "taskkill",
        ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
        {
          windowsHide: true,
          stdio: "ignore",
          shell: false,
          timeout: reclamationTimeoutMs,
        },
      );
      let fallbackStarted = false;
      const fallbackOnce = (): void => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        fallbackDirect();
      };
      killer.once("error", fallbackOnce);
      killer.once("close", (code) => {
        if (code !== 0) {
          fallbackOnce();
          return;
        }
        windowsTreeCleanupConfirmed = true;
        markReclaimed();
      });
      if (force) armExitConfirmation();
    } catch {
      fallbackDirect();
    }
  };

  child.once("exit", onExit);
  if (exitObserved) markReclaimed();
  return {
    outcome,
    terminate(): void {
      if (terminationStarted) return;
      if (!isAlive()) {
        markReclaimed();
        return;
      }
      terminationStarted = true;
      if (platform === "win32") killWindowsTree(false);
      else killDirect("SIGTERM");
      if (platform !== "win32" && !isAlive()) return;
      forceTimer = setTimeout(() => {
        forceTimer = undefined;
        if (platform === "win32") {
          if (!windowsTreeCleanupConfirmed) {
            // Once the root PID has exited, a second taskkill by that PID cannot
            // discover descendants that the in-flight graceful tree sweep did
            // not already capture. Avoid doubling a concurrent graph's taskkill
            // fan-out; retain a bounded confirmation window for that first sweep.
            if (!isAlive()) {
              if (!child.pid) markReclaimed(false);
              else armExitConfirmation();
            } else killWindowsTree(true);
          }
          return;
        }
        forced = true;
        if (!isAlive()) {
          markReclaimed();
          return;
        }
        const delivered = killDirect("SIGKILL");
        if (delivered && isAlive()) armExitConfirmation();
      }, graceMs);
      if (child.pid) forceTimer.unref?.();
    },
    cleanup(): void {
      child.removeListener("exit", onExit);
      if (!isAlive() && (platform !== "win32" || !terminationStarted || windowsTreeCleanupConfirmed)) {
        markReclaimed();
      }
      if (platform !== "win32" || !terminationStarted || windowsTreeCleanupConfirmed) {
        clearForceTimer();
      }
      if (terminationStarted && isAlive() && !forceTimer && !confirmationTimer) {
        settleOutcome({ status: "unreaped", forced, reason: "cleanup-before-exit" });
      }
    },
  };
}

/** @internal Exported for lifecycle regression tests. */
export function bindChildTerminationSignal(
  termination: ChildTerminationController,
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => undefined;
  const abortHandler = () => termination.terminate();
  signal.addEventListener("abort", abortHandler, { once: true });
  if (signal.aborted) abortHandler();
  return () => signal.removeEventListener("abort", abortHandler);
}


// Original adapter imports and asset anchors are retained; owners hold the algorithms.
const resultOwner = createResultOwner({spawn,
  createHash,
  randomUUID,
  fs,
  os,
  path,
  StringDecoder,
  fileURLToPath,
  describeDeclaredValueFailure,
  parseDeclaredJsonResult,
  crossSpawn,
  listAgentSummaries,
  resolveAgent,
  resolvePiAgentDirectory,
  resolveReplyTo,
  wrapLeasedMessage,
  applyModelRouting,
  assertValidTeammatePlacement,
  sharedModelCircuitBreaker,
  MANAGED_WINDOW_ENV,
  getTeammateChildExtensions,
  parseTeammateThinkingLevel,
  isFallbackProviderError,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate});
export const { STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
  STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTIC_SET,
  isStructuredOutputSettlementDiagnostic,
  MODEL_FALLBACK_RESUME_PROMPT,
  correlationSessionDirectoryName,
  extractTextContent,
  isPiResultReadyTurn,
  extractStructuredOutputCandidate,
  extractValidatedStructuredOutput,
  describeStructuredOutputValueValidationFailure,
  describeStructuredOutputValidationFailure,
  extractPiEventError,
  validateStructuredOutputValue,
  EXECUTION_BUFFER_LIMITS,
  truncateUtf8Tail,
  truncateUtf8Head,
  appendUtf8Tail,
  transcriptEntryBytes,
  transcriptTotals,
  entryBytes,
  transcriptTotalBytes,
  appendBoundedTranscriptMessage,
  createUtf8LineDecoder,
  appendDistinctAssistantMessage,
  emptyUsage,
  usageNumber,
  setUsageSnapshot,
  addUsageSnapshot,
  resetUsage,
  releasePublishedTurnHistory } = resultOwner;
const admissionOwner = createAdmissionOwner({spawn,
  createHash,
  randomUUID,
  fs,
  os,
  path,
  StringDecoder,
  fileURLToPath,
  describeDeclaredValueFailure,
  parseDeclaredJsonResult,
  crossSpawn,
  listAgentSummaries,
  resolveAgent,
  resolvePiAgentDirectory,
  resolveReplyTo,
  wrapLeasedMessage,
  applyModelRouting,
  assertValidTeammatePlacement,
  sharedModelCircuitBreaker,
  MANAGED_WINDOW_ENV,
  getTeammateChildExtensions,
  parseTeammateThinkingLevel,
  isFallbackProviderError,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  MAX_DEFAULT_DEPTH,
  resolveMaxAgents,
  findStructuredOutputSchemaHazard});
export const { VAR_PATTERN_SOURCE,
  extractDependencies,
  collectUnknownRefs,
  editDistance,
  taskDependencyNames,
  validateTaskReferences,
  resolvePath,
  resolveVariables,
  hasCycle,
  inferGraphMode,
  normalizeTodoBindings,
  normalizeBriefingEntries,
  MAX_TASK_PROMPT_BYTES,
  taskPromptBoundaryError,
  EXPERT_MODE_LEADER_AGENT,
  EXPERT_MODE_LEADER_TASK_TYPE,
  EXPERT_MODE_LEADER_NAME,
  EXPERT_MODE_PROMPT_START,
  EXPERT_MODE_PROMPT_END,
  buildExpertLeaderPrompt,
  prepareTeammateMode,
  normalizeTeammateParams } = admissionOwner;
