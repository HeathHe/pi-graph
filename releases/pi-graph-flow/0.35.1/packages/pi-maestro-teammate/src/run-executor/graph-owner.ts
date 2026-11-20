import type { createNativeCurrentView } from "./native-current-view.ts";
import type { captureTodoSourceScope, withTodoSourceScope } from "../runs/todo-source-context.ts";
import type { prepareTaskDispatch, waitTaskDispatchReadiness, assertTaskDispatch, watchTaskDispatchCancellation, joinTaskDispatchObservation, PreparedTaskDispatch } from "../public/v1/task-dispatch-binding.ts";
import type { bindNativeResult, NativeExecutionSnapshot } from "./native-observation.ts";
import type { providerFallbackAllowed } from "pi-graph-model-role";
import type { spawn, ChildProcess } from "node:child_process";
import type { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";
import type { createHash, randomUUID } from "node:crypto";
import type * as fs from "node:fs";
import type * as os from "node:os";
import type * as path from "node:path";
import type { Writable } from "node:stream";
import type { StringDecoder } from "node:string_decoder";
import type { fileURLToPath } from "node:url";
import type { Check, Errors } from "typebox/value";
import type crossSpawn from "cross-spawn";
import type {
  discoverAgents,
  formatAgentShadowWarning,
  listAgentSummaries,
  resolveAgent,
  AgentConfig,
} from "../agents/agents.ts";
import type { resolveReplyTo, ReplyTarget } from "../shared/routing.ts";
import type {
  SingleResult,
  Usage,
  AgentProgress,
  AgentProgressStatus,
  AgentTerminalStatus,
  AgentRunPhase,
  RecentToolInfo,
  TeammateExecutionProvenance,
  AgentTurnEvent,
  AgentTurnTriggerContextV1,
} from "../shared/types.ts";
import type {
  AGENT_TURN_VERSION,
  normalizeMessageProvenanceV1,
} from "../shared/types.ts";
import type { wrapLeasedMessage, LeaseToken } from "../runs/session-handoff.ts";
import type {
  applyModelRouting,
  getGlobalModelRoutingPath,
  freezeRoleModelSelection,
  verifyRoleModelSelection,
  canHotSwitchModelRegistration,
  resolveModelRegistrationRouting,
  syncModelCircuitPolicies,
  ResolvedModelRegistrationCandidate,
  ResolvedModelRegistrationRouting,
  TeammateTaskType,
} from "../models/model-routing.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import type {
  deriveModelRuntimeDescriptor,
  exactBackendCapabilities,
  isFabricSourceLocalTransport,
  ModelRuntimeDescriptor,
} from "../models/model-registry.ts";
import type {
  sharedModelCircuitBreaker,
  sharedModelHealthCoordinator,
  AcquiredModelCandidate,
  AcquiredModelHealthCandidate,
  ModelCircuitBreaker,
  ModelHealthCoordinator,
} from "../models/model-circuit-breaker.ts";
import type { getTeammateChildExtensions, getTeammateChildToolBroker } from "../runs/child-extensions.ts";
import type {
  parseTeammateThinkingLevel,
  TeammateThinkingInput,
  TeammateThinkingLevel,
} from "../shared/thinking.ts";
import type {
  classifyModelHealthFailure,
  classifyRetryError,
  classifyRetryInput,
  extractRetryAfterMs,
  isFallbackProviderError,
  ModelHealthAttemptState,
  retryDelayMs,
} from "../runs/retry.ts";
import type {
  MODEL_FALLBACK_RESUME_PROMPT,
  TeammatePublicationCaptureError,
} from "../runs/execution-infra.ts";
import type {
  buildReplayFence,
  hasExternalReplayRisk,
  RecoveryFailureChainV1,
  RecoveryFailureRecordV1,
} from "../runs/recovery-protocol.ts";
import type { cliToolNameFromModel, isCliToolModel } from "../cli-tools/local-acp.ts";
import type { resolveSshHostRef } from "../public/v1/ssh-hosts.ts";
import type {
  EXECUTION_BUFFER_LIMITS,
  FIRST_ACTIVITY_TIMEOUT_MS,
  OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS,
  RESULT_READY_GRACE_MS,
  STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
  addUsageSnapshot,
  appendBoundedTranscriptMessage,
  appendDistinctAssistantMessage,
  appendUtf8Tail,
  bindChildTerminationSignal,
  buildModelCandidates,
  buildPiArgs,
  checkDepthGuard,
  cleanupFile,
  correlationSessionDirectoryName,
  createChildTerminationController,
  createProgress,
  createUtf8LineDecoder,
  describeStructuredOutputValidationFailure,
  describeStructuredOutputValueValidationFailure,
  emptyUsage,
  ensurePrivateDirectory,
  extractPiEventError,
  extractStructuredOutputCandidate,
  extractTextContent,
  findStructuredOutputSchemaHazard,
  getTeammateDepth,
  getTeammateSessionRoot,
  hasCycle,
  isPiResultReadyTurn,
  prepareTeammateMode,
  normalizeTeammateParams,
  readRegularTextFile,
  releasePublishedTurnHistory,
  resetUsage,
  remoteLocationRouting,
  resolveContainedCwd,
  resolveModelSpecifier,
  validateBackendModelSpecifier,
  resolveVariables,
  resultFailureMessage,
  setUsageSnapshot,
  taskDependencyNames,
  taskPromptBoundaryError,
  truncateUtf8Tail,
  validateTaskReferences,
  waitForRetryDelay,
  writeSchemaFile,
  writeSystemPromptFile,
} from "../runs/execution-infra.ts";
import type { runtimeBrokerModeFromEnv } from "../runtime-broker/rollout.ts";
import type { AgentRunRuntimeActor } from "../runs/runtime-actor.ts";
import type { assembleTaskPrompt } from "../runs/briefing.ts";
import type {
  appendTodoPromptContext,
  resolveTodoPromptContext,
  ResolvedTodoPromptContext,
} from "../public/v1/todo-context.ts";
import type {
  JsonLineEvent,
  ModelRegistryDispatchContext,
  NormalizedTask,
  RemoteLocationRouting,
  RunSingleTeammateParams,
  RunTeammateOptions,
  RunTeammateParams,
  StructuredOutputCandidate,
  TaskOutput,
} from "../runs/execution-infra.ts";
import type { adjudicateTask, validateBackendCapabilities } from "pi-maestro-backends";
import type { outcomeOf } from "../backends/pi-subprocess.ts";
import type { closeBackendControlStdin, createBackendControlStdin } from "../backends/control-shim.ts";
import type {
  backendRegistryConfigSync,
  dispatchFabricPlacementRegistrySync,
  dispatchRegistryForProjectionSync,
  dispatchRegistrySync,
  dispatchSourceAttemptRegistrySync,
  FABRIC_BACKEND,
  modelRegistryPairSync,
  PI_SUBPROCESS,
  REMOTE_WORKERS,
} from "../backends/registry-host.ts";
import type { isNativeDurabilityFailure, runSingleAttempt } from "../runs/pi-subprocess-attempt.ts";
import type { assertVirtualChildExtensionRegistered } from "../runs/native-child.ts";
import type {
  AttemptOutcome,
  BackendCapabilities,
  BackendRun,
  BackendRunOptions,
  ConfigValue,
} from "pi-maestro-backend-core/v1/backend";
import type {
  BackendRegistry,
  ResolvedBackend,
} from "pi-maestro-backend-core/v1/registry";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import type { assertFabricIdentifier } from "pi-maestro-fabric-core/v1/common";
import type { assertValidTeammatePlacement } from "pi-maestro-fabric-core/v1/validation";
import type { ExecutionPorts } from "./lifecycle-contracts.ts";
import type { ModelRegistryRunBinding, MutableModelRegistryDispatchContext, PreparedBackendAttempt, FabricSourceRuntimeOptions, DispatchContext } from "./dispatch-owner.ts";
import type { createRetryOwner } from "./retry-owner.ts";

export function createGraphOwner(ports: ExecutionPorts & DispatchContext & ReturnType<typeof createRetryOwner>) {
 const { createNativeCurrentView,
  captureTodoSourceScope,
  withTodoSourceScope,
  prepareTaskDispatch,
  waitTaskDispatchReadiness,
  assertTaskDispatch,
  watchTaskDispatchCancellation,
  joinTaskDispatchObservation,
  bindNativeResult,
  providerFallbackAllowed,
  spawn,
  logDiagnosticError,
  logDiagnosticWarn,
  createHash,
  randomUUID,
  fs,
  os,
  path,
  StringDecoder,
  fileURLToPath,
  Check,
  Errors,
  crossSpawn,
  discoverAgents,
  formatAgentShadowWarning,
  listAgentSummaries,
  resolveAgent,
  resolveReplyTo,
  AGENT_TURN_VERSION,
  normalizeMessageProvenanceV1,
  wrapLeasedMessage,
  applyModelRouting,
  getGlobalModelRoutingPath,
  freezeRoleModelSelection,
  verifyRoleModelSelection,
  canHotSwitchModelRegistration,
  resolveModelRegistrationRouting,
  syncModelCircuitPolicies,
  deriveModelRuntimeDescriptor,
  exactBackendCapabilities,
  isFabricSourceLocalTransport,
  sharedModelCircuitBreaker,
  sharedModelHealthCoordinator,
  getTeammateChildExtensions,
  getTeammateChildToolBroker,
  parseTeammateThinkingLevel,
  classifyModelHealthFailure,
  classifyRetryError,
  classifyRetryInput,
  extractRetryAfterMs,
  isFallbackProviderError,
  ModelHealthAttemptState,
  retryDelayMs,
  MODEL_FALLBACK_RESUME_PROMPT,
  TeammatePublicationCaptureError,
  buildReplayFence,
  hasExternalReplayRisk,
  cliToolNameFromModel,
  isCliToolModel,
  resolveSshHostRef,
  EXECUTION_BUFFER_LIMITS,
  FIRST_ACTIVITY_TIMEOUT_MS,
  OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS,
  RESULT_READY_GRACE_MS,
  STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
  addUsageSnapshot,
  appendBoundedTranscriptMessage,
  appendDistinctAssistantMessage,
  appendUtf8Tail,
  bindChildTerminationSignal,
  buildModelCandidates,
  buildPiArgs,
  checkDepthGuard,
  cleanupFile,
  correlationSessionDirectoryName,
  createChildTerminationController,
  createProgress,
  createUtf8LineDecoder,
  describeStructuredOutputValidationFailure,
  describeStructuredOutputValueValidationFailure,
  emptyUsage,
  ensurePrivateDirectory,
  extractPiEventError,
  extractStructuredOutputCandidate,
  extractTextContent,
  findStructuredOutputSchemaHazard,
  getTeammateDepth,
  getTeammateSessionRoot,
  hasCycle,
  isPiResultReadyTurn,
  prepareTeammateMode,
  normalizeTeammateParams,
  readRegularTextFile,
  releasePublishedTurnHistory,
  resetUsage,
  remoteLocationRouting,
  resolveContainedCwd,
  resolveModelSpecifier,
  validateBackendModelSpecifier,
  resolveVariables,
  resultFailureMessage,
  setUsageSnapshot,
  taskDependencyNames,
  taskPromptBoundaryError,
  truncateUtf8Tail,
  validateTaskReferences,
  waitForRetryDelay,
  writeSchemaFile,
  writeSystemPromptFile,
  runtimeBrokerModeFromEnv,
  AgentRunRuntimeActor,
  assembleTaskPrompt,
  appendTodoPromptContext,
  resolveTodoPromptContext,
  adjudicateTask,
  validateBackendCapabilities,
  outcomeOf,
  closeBackendControlStdin,
  createBackendControlStdin,
  backendRegistryConfigSync,
  dispatchFabricPlacementRegistrySync,
  dispatchRegistryForProjectionSync,
  dispatchRegistrySync,
  dispatchSourceAttemptRegistrySync,
  FABRIC_BACKEND,
  modelRegistryPairSync,
  PI_SUBPROCESS,
  REMOTE_WORKERS,
  isNativeDurabilityFailure,
  runSingleAttempt,
  assertVirtualChildExtensionRegistered,
  assertFabricIdentifier,
  assertValidTeammatePlacement,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  providerOf,
  modelRegistryRunBindings,
  hostRegistryProvenanceResults,
  hostRegistryResultProvenance,
  captureModelRegistryAuthority,
  createModelRegistryDispatchContext,
  modelRegistrationPlan,
  isRemoteModelRegistration,
  ownsResumablePiCheckpoint,
  canResumePiCheckpoint,
  hasRemoteModelDispatchAuthority,
  modelRegistrationBackendSpecOf,
  preflightModelRegistrationPlan,
  candidateForRuntimeModel,
  registryResultCandidate,
  executionTransportProvenance,
  attachRegistryResultProvenance,
  removeUntrustedResultProvenance,
  backendNameOf,
  backendSpecOf,
  PROGRESS_STATUSES,
  PROGRESS_PHASES,
  progressNumber,
  progressTools,
  projectBackendProgress,
  backendOptionsOf,
  BackendCapabilityAdmissionError,
  prepareBackendAttemptOnce,
  sourceModelRegistrationPlan,
  assertFabricSourceLocalDeployment,
  SOURCE_SPEC_KEYS,
  assertSourceAttemptInput,
  startFabricSourceBackendAttempt,
  runSingleTeammateWithOrigin: runSingleTeammate } = ports;
function normalizeGraphConcurrency(concurrency: number, taskCount: number): number {
  return Math.max(
    1,
    Math.min(taskCount || 1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 1),
  );
}

async function runGraph(
  tasks: NormalizedTask[],
  concurrency: number,
  options: RunTeammateOptions,
): Promise<SingleResult[]> {
  if (!("todoSourceScope" in options) && options.taskDispatchHost) {
    options = {...options,todoSourceScope:captureTodoSourceScope(options.taskDispatchHost)};
  }
  tasks = tasks.map(task=>({...task,...(task.todos ? {todos:[...task.todos]} : {})}));
  const maxConcurrency = normalizeGraphConcurrency(concurrency, tasks.length);
  const taskCorrelationIds = tasks.map(
    (_, index) => options.taskCorrelationIds?.[index] ?? randomUUID(),
  );
  // Public Graph admission itself may await discovery/registry/readiness before
  // the retry owner starts. Retain each original parent now, never recapture a
  // later UI selection as an ordinary no-budget request.
  const backendSources = tasks.map((task, index) => Object.freeze({ origin: assertTaskDispatch(undefined, {
    cwd: task.cwd ?? options.baseCwd ?? process.cwd(), agent: task.agent, name: task.name,
    correlationId: taskCorrelationIds[index], runtimeGeneration: options.runtimeGeneration ?? null, todoIds: task.todos ?? [],
  }, { unmetered: "capture", sourceScope: options.todoSourceScope }) }));
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  const indexByName = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].name) indexByName.set(tasks[i].name!, i);
  }

  const publishSyntheticResult = async (
    result: SingleResult,
    callbacks: RunTeammateOptions,
  ): Promise<void> => {
    const originCwd = callbacks.baseCwd;
    result.originCwd ??= originCwd;
    try {
      const publication = await callbacks.onResultPublished?.(result, originCwd);
      if (publication && !publication.resourceAcknowledged) {
        throw new TeammatePublicationCaptureError(result.correlationId, publication.captureError);
      }
    } catch (error) {
      if (error instanceof TeammatePublicationCaptureError) throw error;
      logDiagnosticWarn(
        `[pi-maestro-teammate] result publication observer failed for ${result.correlationId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      callbacks.onTurnComplete?.(result, result.terminalStatus);
    } catch {
      // Completion observers cannot prevent the remaining graph tasks from settling.
    }
  };

  const publishGraphRejection = async (
    message: string,
    dependencies: number[][] = tasks.map(() => []),
  ): Promise<SingleResult[]> => Promise.all(tasks.map(async (task, index) => {
    const result: SingleResult = {
      agent: task.agent,
      name: task.name,
      task: task.prompt,
      exitCode: 1,
      messages: [{ role: "system", content: message }],
      usage: emptyUsage(),
      model: task.model ?? "unknown",
      correlationId: taskCorrelationIds[index],
      durationMs: 0,
      terminalStatus: "failed",
      publicationId: randomUUID(),
    };
    const now = Date.now();
    try {
      options.onProgress?.({
        agent: task.agent,
        name: task.name,
        correlationId: taskCorrelationIds[index],
        taskIndex: index,
        dependencies: dependencies[index] ?? [],
        status: "failed",
        recentTools: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
        lastActivityAt: now,
        startedAt: now,
        lastMessage: message,
      });
    } catch {
      // Progress observers are advisory and cannot interrupt graph settlement.
    }
    await publishSyntheticResult(result, options);
    return result;
  }));

  // Defensive validation for direct runGraph callers — the teammate tool
  // path already rejects these in normalizeTeammateParams.
  const refCheck = validateTaskReferences(tasks);
  if (refCheck.errors.length > 0) {
    return publishGraphRejection(refCheck.errors.join("\n"));
  }

  // Build dependency adjacency list — implicit {name} refs ∪ explicit dependsOn.
  // Names are pre-filtered against taskNames, so lookups cannot miss.
  const deps: number[][] = tasks.map((t) =>
    taskDependencyNames(t, taskNames).map((name) => indexByName.get(name)!),
  );

  if (hasCycle(deps)) {
    return publishGraphRejection("Circular dependency detected in task graph", deps);
  }

  const hasFabricPlacement = tasks.some((task) => task.placement !== undefined);
  if (hasFabricPlacement && options.fabricRouteResolverOf === undefined) {
    return publishGraphRejection(
      "Teammate graph carries a Fabric placement, but this dispatch has no live Fabric route resolver provider; "
      + "refusing to run a placed task on this machine",
      deps,
    );
  }

  try {
    const authority = options.modelRegistryDispatch?.authority ?? captureModelRegistryAuthority(options);
    const ids = options.modelCapabilities ?? (authority ? [...authority.routesByRegistrationId.values()]
      .map(route => ({ id: route.modelRegistrationId, ...route.capabilities })) : undefined);
    tasks = tasks.map(task => {
      const remote = remoteLocationRouting(task.cwd);
      const contained = resolveContainedCwd(remote === undefined ? task.cwd : undefined, options.baseCwd);
      if ("error" in contained) throw new Error(contained.error);
      const decision = task.modelSelection ?? freezeRoleModelSelection(task, contained.cwd, ids, options.modelRoutingFilePath, undefined, authority);
      const frozen = task.modelSelection ? task : { ...task, model: decision.selected,
        fallbackModels: [...decision.candidates.slice(1)], modelSelection: decision };
      const actualRole = resolveAgent(contained.cwd, task.agent);
      if (!actualRole) throw new Error(`Unknown teammate agent "${task.agent}"`);
      verifyRoleModelSelection(decision, frozen, ids, {cwd: contained.cwd, role: actualRole, globalFilePath: options.modelRoutingFilePath, authority});
      return frozen;
    });
  } catch (error) {
    return publishGraphRejection(error instanceof Error ? error.message : String(error), deps);
  }

  let graphModelRegistryContext = options.modelRegistryDispatch as MutableModelRegistryDispatchContext | undefined;
  try {
    const authority = captureModelRegistryAuthority(options);
    if (authority !== undefined && graphModelRegistryContext === undefined) {
      graphModelRegistryContext = createModelRegistryDispatchContext(authority, options);
    }
    if (graphModelRegistryContext !== undefined) {
      const warningGroups = await Promise.all(tasks.map(async (task, index) => {
        const remote = remoteLocationRouting(task.cwd);
        const contained = resolveContainedCwd(
          remote === undefined ? task.cwd : undefined,
          options.baseCwd,
        );
        if ("error" in contained) throw new Error(contained.error);
        const discovery = discoverAgents(contained.cwd, { includeDiagnostics: true });
        const agentConfig = resolveAgent(discovery, task.agent);
        if (agentConfig === undefined) {
          const available = listAgentSummaries(discovery).map((agent) => agent.name).join(", ");
          throw new Error(`Unknown teammate agent "${task.agent}". Available agents: ${available || "(none)"}.`);
        }
        const params: RunSingleTeammateParams = {
          agent: task.agent,
          task: task.prompt,
          name: task.name,
          backend: task.backend,
          context: task.context,
          model: task.model,
          modelSelection: task.modelSelection,
          fallbackModels: task.fallbackModels,
          thinking: task.thinking,
          fast: task.fast,
          cwd: task.cwd,
          outputSchema: task.outputSchema,
          todos: task.todos,
          briefing: task.briefing,
          placement: task.placement,
        };
        const taskCorrelationId = taskCorrelationIds[index]!;
        const plan = graphModelRegistryContext!.plansByCorrelationId.get(taskCorrelationId)
          ?? modelRegistrationPlan(graphModelRegistryContext!.authority, params, agentConfig);
        if (graphModelRegistryContext!.resolutionsByCorrelationId.has(taskCorrelationId)) return [];
        const registry = task.placement === undefined
          ? graphModelRegistryContext!.registry
          : options.backendRegistry ?? dispatchFabricPlacementRegistrySync(
              options.baseCwd,
              () => {
                throw new Error("model-registration graph preflight never starts a run");
              },
              options.fabricRouteResolverOf!,
              options.remoteManagerOf,
            );
        return preflightModelRegistrationPlan(
          graphModelRegistryContext!,
          taskCorrelationId,
          params,
          contained.cwd,
          plan,
          options,
          tasks.length,
          registry,
        );
      }));
      for (const warning of warningGroups.flat()) {
        options.onProgress?.({
          agent: "teammate",
          status: "running",
          recentTools: [],
          toolCount: 0,
          tokens: 0,
          durationMs: 0,
          lastActivityAt: Date.now(),
          startedAt: Date.now(),
          lastMessage: warning,
        });
      }
    }
  } catch (cause) {
    return publishGraphRejection(
      `Teammate model registration preflight failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      deps,
    );
  }
  const graphRunOptions: RunTeammateOptions = graphModelRegistryContext === undefined
    ? options
    : { ...options, modelRegistryDispatch: graphModelRegistryContext };

  // Capability adjudication sits beside the structural checks, not at dispatch.
  // Registry-mode candidates were all adjudicated above; the frozen
  // legacy/backend-registry path keeps its existing primary-only check.
  if (graphModelRegistryContext === undefined) {
    let placementlessRegistry: BackendRegistry | undefined;
    let placedRegistry: BackendRegistry | undefined;
    try {
      placementlessRegistry = options.backendRegistry ?? dispatchRegistrySync(
        options.baseCwd,
        () => {
          throw new Error("capability adjudication never starts a run");
        },
        options.remoteManagerOf,
        undefined,
        options.fabricRouteResolverOf,
      );
      placedRegistry = hasFabricPlacement
        ? options.backendRegistry ?? dispatchFabricPlacementRegistrySync(
            options.baseCwd,
            () => {
              throw new Error("capability adjudication never starts a run");
            },
            options.fabricRouteResolverOf!,
            options.remoteManagerOf,
          )
        : undefined;
    } catch (cause) {
      // A malformed or unloadable registration is a graph-level rejection, not a
      // throw out of runGraph: every other validation failure settles each task
      // so the caller and the UI see a result rather than a pending row.
      return publishGraphRejection(
        `Teammate backend registry could not be loaded: ${String(cause)}`,
        deps,
      );
    }

    const adjudicated: Array<{
      spec: TeammateRunSpec;
      name?: string;
      registry: BackendRegistry;
    }> = [];
    for (const task of tasks) {
      const registry = task.placement === undefined ? placementlessRegistry : placedRegistry;
      if (registry === undefined) continue;
      // NormalizedTask holds the prompt in `prompt`; without this the
      // adjudicated spec would carry an empty task while dispatch sends the
      // real one, and any routing rule reading it would disagree with dispatch.
      const spec = backendSpecOf(
        { ...task, task: task.prompt },
        task.cwd ?? options.baseCwd,
        task.model,
        remoteLocationRouting(task.cwd),
      );
      adjudicated.push({
        spec,
        ...(task.name === undefined ? {} : { name: task.name }),
        registry,
      });
    }
    if (adjudicated.length > 0) {
      let backends;
      try {
        backends = await Promise.all(adjudicated.map(async ({ spec, registry }) => {
          // Each task is resolved against the same registry its execution path
          // uses: placementless legacy tasks do not inherit a graph peer's
          // Fabric overlay.
          const { backend, capabilities } = await registry.resolve(spec, spec.backend);
          return { name: backend.name, capabilities };
        }));
      } catch (cause) {
        return publishGraphRejection(
          `Teammate backend could not be resolved for this graph: ${String(cause)}`,
          deps,
        );
      }
      const verdict = validateBackendCapabilities(adjudicated, (_task, index) => backends[index]!);
      if (verdict.errors.length > 0) {
        return publishGraphRejection(verdict.errors.join("\n"), deps);
      }
      for (const warning of verdict.warnings) {
        options.onProgress?.({
          agent: "teammate",
          status: "running",
          recentTools: [],
          toolCount: 0,
          tokens: 0,
          durationMs: 0,
          lastActivityAt: Date.now(),
          startedAt: Date.now(),
          lastMessage: warning,
        });
      }
    }
  }

  // Validate unique names
  const nameCount = new Map<string, number>();
  for (const t of tasks) {
    if (t.name) nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1);
  }
  for (const [name, count] of nameCount) {
    if (count > 1) {
      return publishGraphRejection(`Duplicate task name "${name}"`, deps);
    }
  }

  let taskDispatchTokens:readonly PreparedTaskDispatch[]=[];
  try {
    const prepare=()=>prepareTaskDispatch(options.taskDispatchHost,tasks.map((task,index)=>({
      correlationId:taskCorrelationIds[index]!,runtimeGeneration:options.runtimeGeneration??null,agent:task.agent,name:task.name,
      cwd:task.cwd??options.baseCwd,todoIds:task.todos??[],
    })),options.signal);
    taskDispatchTokens=await (tasks.some(task=>task.todos?.length) ? withTodoSourceScope(options.todoSourceScope,prepare) : prepare());
  } catch(error){return publishGraphRejection(error instanceof Error?error.message:String(error),deps);}

  const results: SingleResult[] = new Array(tasks.length);
  const outputs = new Map<string, TaskOutput>();
  const completed = new Set<number>();
  const failed = new Set<number>();

  // Concurrency semaphore
  let running = 0;
  const waiters: Array<() => void> = [];

  function acquire(signal?:AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (running < maxConcurrency) { running++; return Promise.resolve(); }
    return new Promise((resolve,reject) => {
      const grant=()=>{signal?.removeEventListener("abort",abort);running++;resolve();};
      const abort=()=>{const index=waiters.indexOf(grant);if(index>=0)waiters.splice(index,1);reject(signal?.reason??new Error("Cancelled while waiting capacity"));};
      waiters.push(grant);signal?.addEventListener("abort",abort,{once:true});
    });
  }

  function release(): void {
    running--;
    const next = waiters.shift();
    if (next) next();
  }

  // Dependency completion tracking
  const completionListeners = new Map<number, Array<() => void>>();

  function waitForDeps(taskIdx: number, signal?:AbortSignal): Promise<boolean> {
    if(signal?.aborted)return Promise.resolve(false);
    const taskDeps=deps[taskIdx];
    return new Promise(resolve=>{
      let done=false;
      const cleanup=()=>{signal?.removeEventListener("abort",abort);for(const dep of taskDeps){const callbacks=completionListeners.get(dep);const i=callbacks?.indexOf(check)??-1;if(i>=0)callbacks!.splice(i,1);}};
      const finish=(value:boolean)=>{if(done)return;done=true;cleanup();resolve(value);};
      const abort=()=>finish(false);
      const check=()=>{if(taskDeps.every(d=>completed.has(d)||failed.has(d)))finish(!taskDeps.some(d=>failed.has(d)));};
      for(const dep of taskDeps){const callbacks=completionListeners.get(dep)??[];callbacks.push(check);completionListeners.set(dep,callbacks);}
      signal?.addEventListener("abort",abort,{once:true});check();
    });
  }

  function notifyComplete(taskIdx: number): void {
    const cbs = completionListeners.get(taskIdx);
    if (cbs) {
      for (const cb of [...cbs]) cb();
      completionListeners.delete(taskIdx);
    }
  }

  function reportTaskQueue(
    task: NormalizedTask,
    taskIndex: number,
    phase: Extract<AgentRunPhase, "waiting-dependency" | "waiting-capacity">,
    queuedAt: number,
  ): void {
    const now = Date.now();
    try {
      options.onProgress?.({
        agent: task.agent,
        name: task.name,
        correlationId: taskCorrelationIds[taskIndex],
        taskIndex,
        dependencies: deps[taskIndex],
        status: "pending",
        phase,
        recentTools: [],
        toolCount: 0,
        tokens: 0,
        durationMs: Math.max(0, now - queuedAt),
        lastActivityAt: now,
        startedAt: queuedAt,
      });
    } catch {
      // Queue progress is advisory and cannot interrupt graph scheduling.
    }
  }

  function reportTaskFailure(
    task: NormalizedTask,
    taskIndex: number,
    message: string,
    terminalStatus?: AgentTerminalStatus,
  ): void {
    const now = Date.now();
    try {
      options.onProgress?.({
        agent: task.agent,
        name: task.name,
        correlationId: taskCorrelationIds[taskIndex],
        taskIndex,
        dependencies: deps[taskIndex],
        status: terminalStatus === "terminated" ? "terminated" : "failed",
        recentTools: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
        lastActivityAt: now,
        startedAt: now,
        lastMessage: message,
      });
    } catch {
      // Progress observers are advisory and cannot interrupt graph settlement.
    }
  }

  async function publishSyntheticFailure(
    task: NormalizedTask,
    taskIndex: number,
    message: string,
    terminalStatus?: AgentTerminalStatus,
  ): Promise<void> {
    failed.add(taskIndex);
    const result: SingleResult = {
      agent: task.agent,
      name: task.name,
      task: task.prompt,
      exitCode: 1,
      messages: [{ role: "system", content: message }],
      usage: emptyUsage(),
      model: task.model ?? "unknown",
      correlationId: taskCorrelationIds[taskIndex],
      durationMs: 0,
      terminalStatus: terminalStatus ?? "failed",
      publicationId: randomUUID(),
    };
    results[taskIndex] = result;
    reportTaskFailure(task, taskIndex, message, terminalStatus);
    await publishSyntheticResult(result, graphRunOptions);
  }

  async function publishQueuedSyntheticFailure(
    task: NormalizedTask,
    taskIndex: number,
    message: string,
  ): Promise<void> {
    try {
      await publishSyntheticFailure(task, taskIndex, message);
    } finally {
      // Publication rejection is terminal for this run, but dependency waiters
      // must still observe the failed task and release their own graph slots.
      notifyComplete(taskIndex);
    }
  }

  const promises = tasks.map(async (task, idx) => {
    const queuedAt = Date.now();
    reportTaskQueue(
      task,
      idx,
      deps[idx].length > 0 ? "waiting-dependency" : "waiting-capacity",
      queuedAt,
    );
    const signal = graphRunOptions.taskSignals?.[idx] && graphRunOptions.signal
      ? AbortSignal.any([graphRunOptions.taskSignals[idx]!,graphRunOptions.signal])
      : graphRunOptions.taskSignals?.[idx] ?? graphRunOptions.signal;
    const token=taskDispatchTokens.find(token=>token.correlationId===taskCorrelationIds[idx]);
    const depsOk = await waitForDeps(idx,signal);

    if (!depsOk) {
      await publishQueuedSyntheticFailure(task, idx, "Skipped: upstream dependency failed");
      return;
    }

    let resolvedTask = task.prompt;
    try {
      resolvedTask = resolveVariables(task.prompt, outputs, taskNames);
    } catch (err) {
      await publishQueuedSyntheticFailure(
        task,
        idx,
        `Variable resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const resolvedTaskBoundaryError = taskPromptBoundaryError(resolvedTask);
    if (resolvedTaskBoundaryError) {
      await publishQueuedSyntheticFailure(task, idx, `Resolved task prompt ${resolvedTaskBoundaryError}.`);
      return;
    }

    if (deps[idx].length > 0) {
      reportTaskQueue(task, idx, "waiting-capacity", queuedAt);
    }
    try {
      // Task dependencies wait outside capacity; only the sole Task owner may activate.
      await waitTaskDispatchReadiness(token,signal);
      await acquire(signal);
    } catch(error) {
      await publishQueuedSyntheticFailure(task,idx,`Task readiness/capacity rejected: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    try {
      if (signal?.aborted) {
        await publishSyntheticFailure(task, idx, "Cancelled before child process launch.", "terminated");
        return;
      }

      if(token)assertTaskDispatch(token,{correlationId:taskCorrelationIds[idx],runtimeGeneration:graphRunOptions.runtimeGeneration??null,agent:task.agent,cwd:token.cwd,todoIds:task.todos??[]});
      // options.onTurnComplete flows through the spread unchanged: lifecycle
      // confirmation still settles the agent record after publication, but it
      // must not block this slot.
      const result = await runSingleTeammate(
        {
          agent: task.agent,
          name: task.name,
          backend: task.backend,
          task: resolvedTask,
          context: task.context,
          model: task.model,
          modelSelection: task.modelSelection,
          fallbackModels: task.fallbackModels,
          thinking: task.thinking,
          fast: task.fast,
          cwd: task.cwd,
          outputSchema: task.outputSchema,
          todos: task.todos,
          briefing: task.briefing,
          placement: task.placement,
        },
        {
          ...graphRunOptions,
          correlationId: taskCorrelationIds[idx],
          preparedTaskDispatch: taskDispatchTokens.find(token=>token.correlationId===taskCorrelationIds[idx]),
          signal,
          onProgress: graphRunOptions.onProgress
            ? (data) => {
                try {
                  graphRunOptions.onProgress?.({
                    ...data,
                    name: task.name,
                    correlationId: taskCorrelationIds[idx],
                    taskIndex: idx,
                    dependencies: deps[idx],
                  });
                } catch {
                  // Progress observers are advisory and cannot interrupt graph settlement.
                }
              }
            : undefined,
        },
        backendSources[idx],
      );
      // Result publication — not lifecycle confirmation — is the release
      // boundary for parallel slots and DAG dependents (debug-notes-002).
      // A lifecyclePending result is consumable; agent_settled/close/grace keeps
      // converging the child via options.onTurnComplete after this returns.
      results[idx] = result;

      if (result.exitCode === 0) {
        completed.add(idx);
        if (task.name) {
          const lastMsg =
            result.messages[result.messages.length - 1]?.content ?? "";
          outputs.set(task.name, {
            text: lastMsg,
            structured: result.structuredOutput,
          });
        }
      } else {
        failed.add(idx);
      }
    } catch (err) {
      await publishSyntheticFailure(
        task,
        idx,
        `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      release();
      notifyComplete(idx);
    }
  });

  await Promise.all(promises);
  return results;
}


 return {runGraph,normalizeGraphConcurrency};
}
