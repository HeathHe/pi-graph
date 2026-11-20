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
import crossSpawn from "cross-spawn";
import { type AgentConfig } from "../agents/agents.ts";
import type { SingleResult, Usage, AgentProgress, AgentTerminalStatus, AgentTurnEvent, AgentTurnTriggerContextV1, MessageProvenanceV1, TeammateResultPublicationResult } from "../shared/types.ts";
import type { RuntimeActorHostClient } from "../runtime-broker/actor-host.ts";
import { type LeaseToken } from "./session-handoff.ts";
import { type ResolvedModelRegistrationRouting, type TeammateTaskType } from "../models/model-routing.ts";
import type { DispatchAuthorityProjection } from "../models/model-registry.ts";
import type { ModelHealthCoordinator } from "../models/model-circuit-breaker.ts";
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";
import type { BackendRegistry, ResolvedBackend } from "pi-maestro-backend-core/v1/registry";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { type ModelCircuitBreaker } from "../models/model-circuit-breaker.ts";
import { type TeammateThinkingInput, type TeammateThinkingLevel } from "../shared/thinking.ts";
import { type ModelHealthFailureScopeClassifier } from "./retry.ts";
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
export declare class TeammatePublicationCaptureError extends Error {
    readonly code: "TEAMMATE_PUBLICATION_CAPTURE";
    readonly captureError: unknown;
    constructor(correlationId: string, captureError?: unknown);
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
    onDeploymentDefault?: (event: {
        readonly correlationId: string;
        readonly runtimeGeneration: number | null;
        readonly source: "deployment-default";
        readonly actualModel: "undeclared";
    }) => void;
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
    onTaskDispatchObservation?: (snapshot: TaskDispatchObservation) => void;
    onNativeExecutionObservation?: (snapshot: NativeExecutionSnapshot) => void;
    /** Same-process current reader; distinct from historical native audit snapshots. */
    onNativeCurrentView?: (view: {
        correlationId: string;
        runtimeGeneration: number | null;
        capability: NativeCurrentReadCapability;
    }) => void;
    onChildSpawned?: (stdin: import("node:stream").Writable, sendControl: (message: Record<string, unknown>) => boolean, sessionDir?: string, correlationId?: string, 
    /** Runtime generation of the spawning run, mirroring onChildClosed. */
    generation?: number) => void;
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
    onModelFailover?: (error: string, previousModel?: string, failureSource?: "provider" | "transport") => string | undefined | Promise<string | undefined>;
    /** Runtime generation used to fence callbacks from a replaced child process. */
    runtimeGeneration?: number;
    onChildClosed?: (correlationId: string, generation: number | undefined, details: {
        code: number | null;
        signal: NodeJS.Signals | null;
        settled: boolean;
    }) => void;
    /**
     * Runs once when the final consumable result is published, before the caller
     * or a DAG dependent can observe it. Observer failures are non-fatal; a
     * returned publication result can explicitly reject canonical capture.
     */
    onResultPublished?: (result: SingleResult, originCwd: string) => TeammateResultPublicationResult | void | Promise<TeammateResultPublicationResult | void>;
    onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
    /** Physical child-process reclamation, independent of logical turn settlement. */
    onReclamationOutcome?: (correlationId: string, outcome: ChildReclamationOutcome) => void;
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
export declare function singleRunParamsOf(source: NormalizedTask, overrides: {
    task: string;
    reply_to?: "caller" | "main";
    context?: "fresh" | "fork";
    timeoutMs?: number;
}): RunSingleTeammateParams;
export interface JsonLineEvent {
    type: string;
    content?: string;
    usage?: Partial<Usage>;
    model?: string;
    error?: string;
    name?: string;
    [key: string]: unknown;
}
import type { ResultReadyTurnContext, StructuredOutputCandidate, Utf8LineDecoder, TranscriptEntry } from "../run-executor/result-owner.ts";
export type { ResultReadyTurnContext, StructuredOutputCandidate, Utf8LineDecoder, TranscriptEntry } from "../run-executor/result-owner.ts";
import type { TaskOutput, NormalizeTeammateResult } from "../run-executor/admission-owner.ts";
export type { TaskOutput, NormalizeTeammateResult } from "../run-executor/admission-owner.ts";
export type PiLaunchSource = "override" | "path-native" | "windows-shim" | "host-entry" | "host-native" | "path-fallback";
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
export declare let resolvedPiEntryPoint: string | null | undefined;
/**
 * Resolve process.argv[1] only when its owning package manifest proves it is
 * Pi's declared CLI. A generic .js/.mjs suffix is never evidence of identity.
 */
export declare function resolvePiEntryPoint(): string | null;
export declare function resolvePiLaunchSpec(options?: PiSpawnCommandOptions): PiLaunchSpec;
export declare function getPiSpawnCommand(args: string[], options?: PiSpawnCommandOptions): PiLaunchSpec & {
    args: string[];
    shell: false;
};
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
export declare function piLaunchDiagnostic(launch: Pick<PiLaunchSpec, "source">, phase: PiLaunchDiagnostic["phase"], exitCode: number | null, signal: NodeJS.Signals | null, stderr: string): PiLaunchDiagnostic;
export declare function formatPiLaunchDiagnostic(diagnostic: PiLaunchDiagnostic): string;
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
/** Build a shell-free terminal launcher where the platform supports argv forwarding. */
export declare function getInteractiveTerminalLaunchSpec(piCommand: {
    command: string;
    args: readonly string[];
}, cwd: string, options?: InteractiveTerminalLaunchOptions): InteractiveTerminalLaunchSpec;
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
/** Terminate an explicitly owned process tree; callers must revalidate PID ownership first. */
export declare function terminateProcessTreeByPid(pid: number, options?: ProcessTreeByPidOptions): Promise<"stopped" | "already-exited">;
/** Maximum number of teammate-agent levels below the main agent. */
export declare const MAX_DEFAULT_DEPTH = 2;
export declare const DEFAULT_MAX_AGENTS = 15;
/**
 * Ceiling on concurrently live agents across the whole dispatch tree. The
 * per-call `maxAgents` limit only bounds a single dispatch, so without this a
 * depth-2 tree of 15-task graphs could reach 15^2 child processes.
 */
export declare const DEFAULT_MAX_ACTIVE_AGENTS = 32;
export declare function resolveMaxAgents(explicit?: number): number;
export declare function resolveMaxActiveAgents(): number;
/**
 * Fallback depth for dispatches that do not carry an explicit one — i.e. direct
 * `runTeammate` callers outside the extension (delegate/explore/moa). Nested
 * teammate calls never reach this: their child process only proxies the request
 * back to the root process, so the root's own environment would always read 0.
 * Those paths pass `RunTeammateOptions.depth` instead.
 */
export declare function getTeammateDepth(): number;
/**
 * Child-scoped nesting budget (absolute max dispatch depth). Only meaningful
 * inside a spawned child process; callers MUST gate the read on `isChild`.
 */
export declare function getTeammateMaxDispatchDepth(): number;
export declare function checkDepthGuard(depth: number): {
    allowed: boolean;
    current: number;
    max: number;
};
/**
 * Absolute max dispatch depth for agents spawned by a root (depth-0) dispatch.
 * `maxNestingDepth: 0` forbids nested calls entirely; the global ceiling caps
 * any larger value, so under the current MAX only 0 vs 1+ are distinguishable.
 */
export declare function rootChildMaxDispatchDepth(maxNestingDepth?: number): number;
/**
 * Absolute max dispatch depth for agents spawned by a proxied dispatch from a
 * parent with `parentBudget`, at `childDepth`. The parent's budget is the hard
 * cap; the call's own `maxNestingDepth` may only tighten it further.
 */
export declare function nestedChildMaxDispatchDepth(parentBudget: number, childDepth: number, maxNestingDepth?: number): number;
/** Whether a dispatch creating agents at `dispatchDepth` is allowed under `parentBudget`. */
export declare function dispatchAllowed(parentBudget: number, dispatchDepth: number): boolean;
/** Budget of an agent record that predates per-dispatch budgets: global ceiling. */
export declare function agentDispatchBudget(agent: {
    maxDispatchDepth?: number;
}): number;
export declare function getTeammateSessionRoot(parentSessionFile: string | null): string | undefined;
export declare function buildModelCandidates(primary?: string, fallbacks?: string[]): string[];
export declare function isFallbackModelError(messages: Array<{
    role: string;
    content: string;
}>): boolean;
export declare function resultFailureMessage(messages: Array<{
    role: string;
    content: string;
}>): string;
export declare function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<boolean>;
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
export declare const retryPersistenceGuards: Map<string, RetryPersistenceGuard>;
/**
 * Pi's RPC set_auto_retry command persists to settings.json even though the
 * child only needs a session-local override. Restore the original value after
 * every concurrently starting child has acknowledged that command.
 */
export declare function acquireRetryPersistenceGuard(settingsPath: string): () => void;
export declare function readRetrySettingSnapshot(settingsPath: string): RetrySettingSnapshot | undefined;
export declare function restoreRetrySettingSnapshot(settingsPath: string, snapshot: RetrySettingSnapshot): void;
export declare function childSettingsPath(env: NodeJS.ProcessEnv): string;
export declare const MODEL_SPECIFIER_PATTERN: RegExp;
export declare const MAX_MODEL_SPECIFIER_BYTES = 256;
export declare function validateModelSpecifier(model: string): string;
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
export declare function validateBackendModelSpecifier(model: string): string;
export declare function resolveModelSpecifier(model: string, modelCapabilities?: readonly TeammateModelCapability[]): string;
export declare function buildInheritedExtensionArgs(primaryExtensionPath: string): string[];
export declare function managedWindowSpawnEnv(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export interface ManagedWindowArgsOptions {
    sessionName: string;
    presentation: "headless" | "interactive";
    forkSessionFile?: string;
}
export declare function buildManagedWindowPiArgs(options: ManagedWindowArgsOptions): string[];
export declare function buildPiArgs(agentConfig: AgentConfig, params: RunSingleTeammateParams, systemPromptFile: string, modelOverride?: string, sessionDir?: string, forkSessionFile?: string, schemaFile?: string, modelCapabilities?: readonly TeammateModelCapability[], resumeSessionFile?: string): string[];
export declare const PRIVATE_DIRECTORY_MODE = 448;
export declare const PRIVATE_FILE_MODE = 384;
export declare function shouldEnforcePosixMode(): boolean;
/**
 * Root for prompt/schema/result scratch files, whose contents include the full
 * agent system prompt.
 *
 * POSIX gets its privacy from chmod(0o700). Windows ignores mkdir modes and has
 * no fchmod, so the only lever left is location: %LOCALAPPDATA% is already a
 * per-user tree, unlike the shared %TEMP% fallback.
 */
export declare function teammateTempRoot(): string;
export declare function ensurePrivateDirectory(directoryPath: string): void;
export declare function writePrivateTextFile(filePath: string, content: string): void;
export declare function openPrivateRegularFile(filePath: string): number;
export declare function errorCode(error: unknown): string | undefined;
export declare function readRegularTextFile(filePath: string): string;
export declare function writeSystemPromptFile(agentConfig: AgentConfig, correlationId: string, outputSchema?: Record<string, unknown>, todos?: string[]): string;
export declare function writeSchemaFile(schema: Record<string, unknown>, correlationId: string): {
    schemaFile: string;
    outputFile: string;
};
export declare function cleanupFile(filePath: string): void;
export declare function createProgress(agent: string, startTime: number): AgentProgress;
export declare const CHILD_TERMINATION_GRACE_MS = 5000;
export declare const RESULT_READY_GRACE_MS = 60000;
export declare const RESULT_READY_GRACE_EXTENDED_MS = 120000;
/** Select one consistent lifecycle grace for text and structured-output lanes. */
export declare function resultReadyGraceMsFor(completedToolCount: number, overrideMs?: number): number;
export declare const OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS: number;
export declare const FIRST_ACTIVITY_TIMEOUT_MS = 120000;
/**
 * Resolve `params.cwd` relative to the session directory while permitting an
 * explicit path outside the current project. Existing paths are canonicalized;
 * non-existent paths keep their lexical form so spawn reports the normal error.
 */
export declare function canonicalDirectoryPath(candidate: string): string;
export declare function resolveContainedCwd(requested: string | undefined, baseCwd: string): {
    cwd: string;
} | {
    error: string;
};
/** Prefix marking a working location as a configured remote target. */
export declare const REMOTE_LOCATION_PREFIX = "remote:";
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
export declare function remoteLocationRouting(cwd: string | undefined): RemoteLocationRouting | undefined;
export declare const STRUCTURED_OUTPUT_SCHEMA_LIMITS: Readonly<{
    maxBytes: number;
    maxDepth: 20;
    maxPatternLength: 200;
}>;
export declare const NESTED_QUANTIFIER: RegExp;
export declare function isRiskyRegexSource(source: string): boolean;
/**
 * The model may submit any JSON Schema, and TypeBox compiles its `pattern`
 * keywords into RegExp objects that then run on this process's main thread on
 * every assistant event. Reject the hazardous shapes up front instead of
 * silently dropping keywords, so a valid schema still validates exactly as before.
 */
export declare function findStructuredOutputSchemaHazard(schema: Record<string, unknown>): string | undefined;
export type ChildReclamationOutcome = {
    status: "reclaimed";
    forced: boolean;
    /** False when the direct child exited but Windows taskkill never confirmed its tree sweep. */
    treeCleanupConfirmed?: false;
} | {
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
export declare function createChildTerminationController(child: ChildProcess, options?: ChildTerminationOptions): ChildTerminationController;
/** @internal Exported for lifecycle regression tests. */
export declare function bindChildTerminationSignal(termination: ChildTerminationController, signal?: AbortSignal): () => void;
export declare const STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS: {
    readonly agentEnd: "The teammate completed without calling structured_output with a schema-valid value.";
    readonly close: "The teammate exited without schema-valid structured_output.";
    readonly resultReadyGrace: "The teammate published a result but did not settle with schema-valid structured_output in time.";
}, STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTIC_SET: Set<string>, isStructuredOutputSettlementDiagnostic: (content: string) => boolean, MODEL_FALLBACK_RESUME_PROMPT: string, correlationSessionDirectoryName: (correlationId: string) => string, extractTextContent: (event: JsonLineEvent) => string | undefined, isPiResultReadyTurn: (event: Record<string, unknown>, context?: ResultReadyTurnContext) => boolean, extractStructuredOutputCandidate: (event: Record<string, unknown>, schema: Record<string, unknown>) => StructuredOutputCandidate | undefined, extractValidatedStructuredOutput: (event: Record<string, unknown>, schema: Record<string, unknown>) => unknown | undefined, describeStructuredOutputValueValidationFailure: (value: unknown, schema: Record<string, unknown>) => string | undefined, describeStructuredOutputValidationFailure: (event: Record<string, unknown>, schema: Record<string, unknown>) => string | undefined, extractPiEventError: (event: Record<string, unknown>) => string | undefined, validateStructuredOutputValue: (value: unknown, schema: Record<string, unknown>) => boolean, EXECUTION_BUFFER_LIMITS: Readonly<{
    lineBytes: number;
    streamBytes: number;
    stderrBytes: number;
    toolItems: 10;
    toolNameBytes: 1024;
    transcriptMessages: 128;
    transcriptMessageBytes: number;
    transcriptBytes: number;
}>, truncateUtf8Tail: (value: string, maxBytes: number) => string, truncateUtf8Head: (value: string, maxBytes: number) => string, appendUtf8Tail: (current: string, addition: string, maxBytes: number) => string, transcriptEntryBytes: WeakMap<TranscriptEntry, number>, transcriptTotals: WeakMap<object, {
    length: number;
    bytes: number;
}>, entryBytes: (entry: TranscriptEntry) => number, transcriptTotalBytes: (messages: TranscriptEntry[]) => number, appendBoundedTranscriptMessage: (messages: Array<{
    role: string;
    content: string;
}>, message: {
    role: string;
    content: string;
}) => void, createUtf8LineDecoder: (maxBufferedBytes?: number, onOverflow?: (info: {
    receivedBytes: number;
    maxBytes: number;
    prefix: string;
}) => void, onLine?: (line: string) => void) => Utf8LineDecoder, appendDistinctAssistantMessage: (messages: Array<{
    role: string;
    content: string;
}>, content: string) => boolean, emptyUsage: () => Usage, usageNumber: (value: unknown) => number, setUsageSnapshot: (total: Usage, partial: Record<string, unknown>) => void, addUsageSnapshot: (total: Usage, partial: Record<string, unknown>) => void, resetUsage: (usage: Usage) => void, releasePublishedTurnHistory: (messages: Array<{
    role: string;
    content: string;
}>, progress: AgentProgress, usage: Usage) => void;
export declare const VAR_PATTERN_SOURCE: string, extractDependencies: (template: string | undefined, taskNames: Set<string>) => string[], collectUnknownRefs: (template: string | undefined, taskNames: Set<string>) => string[], editDistance: (a: string, b: string) => number, taskDependencyNames: (task: Pick<NormalizedTask, "prompt" | "dependsOn">, taskNames: Set<string>) => string[], validateTaskReferences: (tasks: NormalizedTask[]) => {
    errors: string[];
    warnings: string[];
}, resolvePath: (obj: unknown, pathStr: string) => unknown, resolveVariables: (template: string, outputs: Map<string, TaskOutput>, taskNames: Set<string>) => string, hasCycle: (adjList: number[][]) => boolean, inferGraphMode: (tasks: NormalizedTask[]) => "parallel" | "chain" | "graph", normalizeTodoBindings: (todo: string | string[] | undefined) => string[] | undefined, normalizeBriefingEntries: (briefing: string[] | undefined) => string[] | undefined, MAX_TASK_PROMPT_BYTES: number, taskPromptBoundaryError: (prompt: unknown) => string | undefined, EXPERT_MODE_LEADER_AGENT: string, EXPERT_MODE_LEADER_TASK_TYPE: string, EXPERT_MODE_LEADER_NAME: string, EXPERT_MODE_PROMPT_START: string, EXPERT_MODE_PROMPT_END: string, buildExpertLeaderPrompt: (objective: string) => string, prepareTeammateMode: (params: RunTeammateParams) => RunTeammateParams, normalizeTeammateParams: (params: RunTeammateParams) => NormalizeTeammateResult;
