import type { createNativeCurrentView } from "./native-current-view.ts";
import type { captureTodoSourceScope, withTodoSourceScope } from "../runs/todo-source-context.ts";
import type { prepareTaskDispatch, waitTaskDispatchReadiness, assertTaskDispatch, watchTaskDispatchCancellation, joinTaskDispatchObservation, PreparedTaskDispatch, TaskDispatchRequest } from "../public/v1/task-dispatch-binding.ts";
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

export function createRetryOwner(ports: ExecutionPorts & DispatchContext) {
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
  captureBuiltinDeploymentDefault,
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
  startFabricSourceBackendAttempt } = ports;
async function runSingleTeammate(
  params: RunSingleTeammateParams,
  options: RunTeammateOptions,
): Promise<SingleResult> {
  return runSingleTeammateWithOrigin(params, options);
}
async function runSingleTeammateWithOrigin(
  params: RunSingleTeammateParams,
  options: RunTeammateOptions,
  capturedBackendSource?: { readonly origin: object | undefined },
): Promise<SingleResult> {
  // Capture the caller's source before actor/model preparation can yield. An
  // existing (possibly revoked) scope must never be silently recaptured.
  if (!("todoSourceScope" in options) && options.taskDispatchHost) {
    options = {...options,todoSourceScope:captureTodoSourceScope(options.taskDispatchHost)};
  }
  params = {...params,...(params.todos ? {todos:[...params.todos]} : {})};
  const correlationId = options.correlationId ?? randomUUID();
  // Read-only origin before actor/model preparation yields. Pi paths use their
  // own native gate; only an unmetered backend consumes this negative assertion.
  const backendBudgetOrigin = capturedBackendSource ? capturedBackendSource.origin : assertTaskDispatch(undefined, { cwd: params.cwd ?? options.baseCwd ?? process.cwd(), correlationId,
    runtimeGeneration: options.runtimeGeneration ?? null, agent: params.agent, name: params.name, todoIds: params.todos ?? [] },
    { unmetered: "capture", sourceScope: options.todoSourceScope });
  const admittedOptions = { ...options, correlationId };
  const nativeCurrent=createNativeCurrentView({correlationId,runtimeGeneration:options.runtimeGeneration??null});
  try { options.onNativeCurrentView?.({correlationId,runtimeGeneration:options.runtimeGeneration??null,capability:nativeCurrent.capability}); } catch { /* Read-only observer. */ }
  try {
    const actorMode = options.runtimeActorHost?.mode ?? runtimeBrokerModeFromEnv();
    if (actorMode === "off") return await runSingleTeammateV1(params, admittedOptions,nativeCurrent,backendBudgetOrigin);
    const runtimeActor = await AgentRunRuntimeActor.start(correlationId, params, admittedOptions);
    try {
      const result = await runSingleTeammateV1(params, runtimeActor.wrap(admittedOptions),nativeCurrent,backendBudgetOrigin);
      await runtimeActor.finish();
      return result;
    } catch (error) {
      await runtimeActor.abort();
      throw error;
    }
  } finally { nativeCurrent.settleExecutionCall(); }
}

async function runSingleTeammateV1(
  params: RunSingleTeammateParams,
  options: RunTeammateOptions,
  nativeCurrent: ReturnType<typeof createNativeCurrentView>,
  backendBudgetOrigin: object | undefined,
): Promise<SingleResult> {
  // Briefing assembly before any use of params.task so every downstream path
  // (spawn stdin, resume prompt, rejection echo) sees the same final text.
  if (params.briefing && params.briefing.length > 0) {
    params = { ...params, task: assembleTaskPrompt(params.task ?? "", params.briefing) };
  }
  const startTime = Date.now();
  const correlationId = options.correlationId ?? randomUUID();
  const originalDispatchRequest: TaskDispatchRequest = { cwd: params.cwd ?? options.baseCwd ?? process.cwd(), correlationId,
    runtimeGeneration: options.runtimeGeneration ?? null, agent: params.agent, name: params.name, todoIds: params.todos ?? [] };
  const publicTaskPrompt = params.task ?? "";
  let latestTurnEvent: AgentTurnEvent | undefined;
  let turnEventTimestampFloor = 0;
  let cancellationTurnRecorded = false;
  let rejectionModel = params.model;
  let resolvedRunCwd: string | undefined;
  let publicationAwaitingCompletion: { publicationId: string; originCwd: string } | undefined;
  let agentDiscoveryWarning: string | undefined;
  let todoPromptContext: ResolvedTodoPromptContext | undefined;
  let todoPromptContextApplied = false;
  let todoPromptContextWarnings: readonly string[] = [];
  let preparedTaskDispatch=options.preparedTaskDispatch;
  const ensureTaskDispatch=async (cwd:string,attemptOptions:RunTeammateOptions):Promise<void>=>{
    const request={correlationId,runtimeGeneration:options.runtimeGeneration??null,agent:params.agent,name:params.name,cwd,todoIds:params.todos??[]};
    if(request.todoIds.length&&!preparedTaskDispatch){
      [preparedTaskDispatch]=await withTodoSourceScope(options.todoSourceScope,()=>prepareTaskDispatch(options.taskDispatchHost,[request],options.signal));
    }
    watchTaskDispatchCancellation(preparedTaskDispatch,options.signal);
    await waitTaskDispatchReadiness(preparedTaskDispatch,options.signal,request);
    assertTaskDispatch(preparedTaskDispatch,request);
    attemptOptions.preparedTaskDispatch=preparedTaskDispatch;
  };


  const applyTodoPromptContext = async (): Promise<void> => {
    if (todoPromptContextApplied || !params.todos || params.todos.length === 0) return;
    todoPromptContext ??= await resolveTodoPromptContext({
      correlationId,
      cwd: resolvedRunCwd ?? options.baseCwd,
      todoIds: params.todos,
      signal: options.signal,
    });
    todoPromptContextWarnings = todoPromptContext.warnings;
    params = {
      ...params,
      task: appendTodoPromptContext(publicTaskPrompt, todoPromptContext),
    };
    todoPromptContextApplied = true;
  };

  const initialTurnContext: AgentTurnTriggerContextV1 = options.initialTurnContext ?? {
    version: AGENT_TURN_VERSION,
    turnId: randomUUID(),
    correlationId,
    runtimeGeneration: options.runtimeGeneration ?? 0,
    promptSeq: 1,
    trigger: normalizeMessageProvenanceV1(
      options.initialMessageProvenanceOf?.(correlationId) ?? options.initialMessageProvenance,
    ),
  };

  let latestNativeObservation: NativeExecutionSnapshot | undefined;
  const attachPublicResultContext = (result: SingleResult): SingleResult => {
    if (latestNativeObservation) bindNativeResult(result, latestNativeObservation, options.runtimeGeneration ?? null);
    result.task = publicTaskPrompt;
    const warnings = [
      ...(agentDiscoveryWarning ? [agentDiscoveryWarning] : []),
      ...todoPromptContextWarnings,
    ];
    for (const warning of warnings) {
      if (!result.warnings?.includes(warning)) {
        result.warnings = [...(result.warnings ?? []), warning];
      }
    }
    return result;
  };

  const rejectWith = (content: string): SingleResult => ({
    agent: params.agent,
    name: params.name,
    task: publicTaskPrompt,
    exitCode: 1,
    messages: [{ role: "system", content }],
    usage: emptyUsage(),
    model: rejectionModel ?? "unknown",
    correlationId,
    durationMs: Date.now() - startTime,
  });

  const publishTurnComplete = (
    result: SingleResult,
    terminalStatus?: AgentTerminalStatus,
  ): void => {
    attachPublicResultContext(result);
    if (resolvedRunCwd) result.originCwd ??= resolvedRunCwd;
    if (publicationAwaitingCompletion) {
      result.publicationId ??= publicationAwaitingCompletion.publicationId;
      result.originCwd ??= publicationAwaitingCompletion.originCwd;
      publicationAwaitingCompletion = undefined;
    } else {
      // Compatibility for completion callbacks from third-party backends that
      // do not expose a result-publication boundary.
      result.publicationId ??= randomUUID();
    }
    const canonicalStatus = terminalStatus
      ?? result.terminalStatus
      ?? (result.exitCode === 0 ? "completed" : "failed");
    result.terminalStatus = canonicalStatus;
    try {
      options.onTurnComplete?.(result, canonicalStatus);
    } catch {
      // Completion observers must not change the model fallback outcome.
    }
  };

  const publishResult = async (result: SingleResult, originCwd: string): Promise<void> => {
    attachPublicResultContext(result);
    result.publicationId ??= randomUUID();
    result.originCwd ??= originCwd;
    publicationAwaitingCompletion = {
      publicationId: result.publicationId,
      originCwd: result.originCwd,
    };
    try {
      const publication = await options.onResultPublished?.(result, originCwd);
      if (publication && !publication.resourceAcknowledged) {
        throw new TeammatePublicationCaptureError(result.correlationId, publication.captureError);
      }
    } catch (error) {
      if (error instanceof TeammatePublicationCaptureError) throw error;
      logDiagnosticWarn(
        `[pi-maestro-teammate] result publication observer failed for ${result.correlationId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      // Unrelated publication observers are advisory; the in-memory result remains authoritative.
    }
  };

  const publishTerminalResult = async (
    result: SingleResult,
    terminalStatus?: AgentTerminalStatus,
  ): Promise<SingleResult> => {
    if (!publicationAwaitingCompletion) {
      await publishResult(result, resolvedRunCwd ?? options.baseCwd);
    }
    publishTurnComplete(result, terminalStatus);
    return result;
  };

  const rejectAndPublish = (
    content: string,
    terminalStatus?: AgentTerminalStatus,
  ): Promise<SingleResult> => publishTerminalResult(rejectWith(content), terminalStatus);

  if (options.signal?.aborted) {
    return rejectAndPublish("Teammate run aborted before launch.", "terminated");
  }

  // Placement changes the backend route, not the model identity namespace.
  // Keep the captured model-registry authority so canonical ids are translated
  // to their adapter selectors before the Fabric backend sends the wire spec.
  let modelRegistryContext = options.modelRegistryDispatch as MutableModelRegistryDispatchContext | undefined;
  try {
    const authority = captureModelRegistryAuthority(options);
    if (authority !== undefined && modelRegistryContext === undefined) {
      modelRegistryContext = createModelRegistryDispatchContext(authority, options);
    }
  } catch (error) {
    return rejectAndPublish(
      `Teammate model registry could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const remoteRouting = remoteLocationRouting(params.cwd);
  if (remoteRouting !== undefined && modelRegistryContext === undefined) {
    if (params.backend !== undefined && params.backend !== remoteRouting.backend) {
      return rejectAndPublish(
        `Teammate task names backend "${params.backend}" and remote location "${params.cwd}"; `
        + "a remote location already selects its backend, so these two cannot both be set",
      );
    }
    // Legacy mode resolves no registry at all, so there is no registration to
    // route this to. Falling through would run on this machine a task that
    // named another one, so it is refused by name instead. `rejectAndPublish`
    // rather than a throw: the dispatch below has no catch, and the caller must
    // receive a settled result rather than an exception.
    if (options.backendRegistry === undefined
      && (backendRegistryConfigSync(options.baseCwd).mode ?? "legacy") === "legacy") {
      return rejectAndPublish(
        `Teammate task requests remote location "${params.cwd}", but .pi/teammate-backends.json is in `
        + `legacy execution mode; set mode "backend-registry" and register "${remoteRouting.backend}" — `
        + "refusing to run a remote task on this machine",
      );
    }
  }

  if (params.placement !== undefined) {
    // A route is a target, not a directory: a task that names an absolute cwd
    // alongside a placement is confusing a Device with a path, and honouring
    // either one silently would run the task somewhere the caller did not
    // select.
    if (params.cwd !== undefined && path.isAbsolute(params.cwd)) {
      return rejectAndPublish(
        `Teammate task carries a Fabric placement and an absolute "cwd" (${params.cwd}); a placed `
        + "Agent Endpoint runs in its own workspace directory, so an origin path here selects nothing. "
        + 'Drop "cwd" and dispatch the placed task without it.',
      );
    }
    if (remoteRouting !== undefined) {
      return rejectAndPublish(
        `Teammate task carries both a Fabric placement and remote location "${params.cwd}"; `
        + "a placement already selects its Agent Endpoint, so these two cannot both be set",
      );
    }
    if (params.backend !== undefined && params.backend !== FABRIC_BACKEND) {
      return rejectAndPublish(
        `Teammate task carries a Fabric placement and names backend "${params.backend}"; a placed task is `
        + `served by "${FABRIC_BACKEND}" because the selected route is the target. Remove the backend selector `
        + "or drop the placement.",
      );
    }
    if (params.todos !== undefined && params.todos.length > 0) {
      return rejectAndPublish(
        "Teammate task carries a Fabric placement and binds Todo ids; a placed Agent Endpoint runs in its own "
        + "workspace and cannot serve this host's Todo queue. Drop the todo binding and dispatch without it.",
      );
    }
    // Placement is opt-in only while the host has a live route resolver. The
    // reserved registry entry is overlaid later for this dispatch alone; no
    // provider means there is no transport authority and must fail closed.
    if (options.fabricRouteResolverOf === undefined) {
      return rejectAndPublish(
        "Teammate task carries a Fabric placement, but this dispatch has no live Fabric route resolver provider; "
        + "refusing to run a placed task on this machine",
      );
    }
  }

  const legacyPiResumeDeploymentKey = (model: string | undefined): string | undefined => {
    if (modelRegistryContext !== undefined || options.backendRegistry !== undefined) return undefined;
    const config = backendRegistryConfigSync(options.baseCwd);
    const requestedBackend = backendNameOf(params, model, remoteRouting);
    if ((config.mode ?? "legacy") === "legacy") {
      return requestedBackend === undefined ? `legacy:${PI_SUBPROCESS}` : undefined;
    }
    const deploymentId = requestedBackend ?? config.default;
    return config.backends[deploymentId]?.module === PI_SUBPROCESS
      ? `backend-registry:${deploymentId}`
      : undefined;
  };

  // A remote task still needs a real local directory: agent discovery and
  // result publication both read one. The remote location itself is a target
  // name, so it never reaches the path resolver.
  const containedCwd = resolveContainedCwd(
    remoteRouting === undefined ? params.cwd : undefined,
    options.baseCwd,
  );
  if ("error" in containedCwd) return rejectAndPublish(containedCwd.error);
  const cwd = containedCwd.cwd;
  resolvedRunCwd = cwd;

  if (params.outputSchema) {
    const schemaHazard = findStructuredOutputSchemaHazard(params.outputSchema);
    if (schemaHazard) return rejectAndPublish(schemaHazard);
  }

  // AC4: Depth guard
  const depthCheck = checkDepthGuard(options.depth ?? getTeammateDepth());
  if (!depthCheck.allowed) {
    return rejectAndPublish(
      `Teammate nesting depth exceeded: current=${depthCheck.current}, max=${depthCheck.max}. Prevent recursive fork-bomb.`,
    );
  }

  // Resolve an exact discovered role. Silent generic fallback made misspelled
  // or out-of-project role names look successful while ignoring their prompt.
  const discovery = discoverAgents(cwd, { includeDiagnostics: true });
  const agentConfig: AgentConfig | undefined = resolveAgent(discovery, params.agent);
  if (!agentConfig) {
    const available = listAgentSummaries(discovery).map((agent) => agent.name).join(", ");
    return rejectAndPublish(
      `Unknown teammate agent "${params.agent}". Available agents: ${available || "(none)"}.`,
    );
  }
  agentDiscoveryWarning = formatAgentShadowWarning(discovery, params.agent);

  // Resolve routing
  const replyTo: ReplyTarget = resolveReplyTo({
    reply_to: params.reply_to,
    protocol_version: params.protocol_version,
    name: params.name,
  });

  // AC7: Model fallback. Registry mode resolves canonical registrations from
  // one authority projection and preflights the complete explicit chain before
  // any backend starts. Legacy/backend-registry retain their existing model
  // namespace and implicit fallback heuristics below.
  // A direct caller selects once here; routed/batch callers carry the original decision.
  // Exact agent resolution has completed; this is an admission check, not a second choice.
  const selectionCatalog = options.modelCapabilities ?? (modelRegistryContext?.authority
    ? [...modelRegistryContext.authority.routesByRegistrationId.values()].map(route => ({ id: route.modelRegistrationId, ...route.capabilities }))
    : undefined);
  try {
    if (!params.modelSelection) {
      const decision = freezeRoleModelSelection(params, cwd, selectionCatalog, options.modelRoutingFilePath, undefined, modelRegistryContext?.authority, options.inheritModel);
      params = { ...params, model: decision.selected, fallbackModels: [...decision.candidates.slice(1)], modelSelection: decision };
    }
    verifyRoleModelSelection(params.modelSelection!, params, selectionCatalog, {cwd, role: agentConfig, globalFilePath: options.modelRoutingFilePath, authority: modelRegistryContext?.authority});
  } catch (error) {
    return rejectAndPublish(error instanceof Error ? error.message : String(error));
  }

  let registrationPlan: ResolvedModelRegistrationRouting | undefined;
  const breaker = options.modelCircuitBreaker ?? sharedModelCircuitBreaker;
  const modelHealth: ModelHealthCoordinator | undefined = modelRegistryContext?.modelHealthCoordinator;
  const modelHealthAttempt = modelRegistryContext === undefined
    ? undefined
    : new ModelHealthAttemptState(modelRegistryContext.authority.hash);
  let candidates: string[];

  if (modelRegistryContext !== undefined) {
    try {
      registrationPlan = modelRegistryContext.plansByCorrelationId.get(correlationId)
        ?? modelRegistrationPlan(modelRegistryContext.authority, params, agentConfig);
      rejectionModel = registrationPlan.candidates[0]?.modelRegistrationId ?? rejectionModel;
      if (!modelRegistryContext.resolutionsByCorrelationId.has(correlationId)) {
        const registry = params.placement === undefined
          ? modelRegistryContext.registry
          : options.backendRegistry ?? dispatchFabricPlacementRegistrySync(
              options.baseCwd,
              () => {
                throw new Error("model-registration preflight never starts a run");
              },
              options.fabricRouteResolverOf!,
              options.remoteManagerOf,
            );
        await preflightModelRegistrationPlan(
          modelRegistryContext,
          correlationId,
          params,
          cwd,
          registrationPlan,
          options,
          1,
          registry,
        );
      }
      candidates = registrationPlan.candidates.map((candidate) => candidate.modelRegistrationId);
    } catch (error) {
      return rejectAndPublish(
        `Teammate model registration preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    candidates = buildModelCandidates(
      params.model ?? agentConfig.model,
      params.fallbackModels ?? agentConfig.fallbackModels,
    );
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        // Whoever executes the task owns the model namespace. A candidate routed
        // to a registered backend names a model in that backend's catalogue, so
        // the host neither validates its format nor resolves its bare names.
        if (backendNameOf(params, candidate, remoteRouting) !== undefined) {
          validateBackendModelSpecifier(candidate);
          continue;
        }
        // Native virtual selections require explicit router inheritance, not a
        // physical-model catalog fallback. Actual child-version proof follows
        // at the subprocess launch boundary.
        if (assertVirtualChildExtensionRegistered(candidate, options.virtualModelIds)) continue;
        candidates[index] = resolveModelSpecifier(candidate, options.modelCapabilities);
      }
      candidates.splice(0, candidates.length, ...new Set(candidates));
    } catch (error) {
      return rejectAndPublish(error instanceof Error ? error.message : String(error));
    }
  }

  if (JSON.stringify(candidates) !== JSON.stringify(params.modelSelection!.candidates)) {
    return rejectAndPublish("ModelRole: resolved candidates differ from frozen exact identities");
  }
  // Preserve the frozen order; health may reject a candidate but never silently reselect it.
  let deploymentDefault: Awaited<ReturnType<typeof captureBuiltinDeploymentDefault>>;
  try {
    deploymentDefault = modelRegistryContext === undefined
      ? await captureBuiltinDeploymentDefault(params, options, cwd, agentConfig, options.modelCapabilities, remoteRouting) : undefined;
  } catch (error) { return rejectAndPublish(error instanceof Error ? error.message : String(error)); }
  const modelCandidates: Array<string | undefined> = deploymentDefault ? [undefined] : [...candidates];
  if (deploymentDefault) rejectionModel = undefined;
  const attemptedModels: string[] = [];
  const attemptedModelSet = new Set<string>();
  const recordAttemptedModel = (model: string): void => {
    if (attemptedModelSet.has(model)) return;
    attemptedModelSet.add(model);
    attemptedModels.push(model);
  };
  let resolvedDefaultModel: string | undefined;
  let lastResult: SingleResult | undefined;

  const formatCancellationReason = (): string => {
    try {
      const rawReason = options.signal?.reason;
      const text = rawReason instanceof Error
        ? `${rawReason.name}: ${rawReason.message}`
        : typeof rawReason === "string"
          ? rawReason
          : rawReason === undefined
            ? "unspecified"
            : String(rawReason);
      return text.replace(/\s+/g, " ").trim().slice(0, 500) || "unspecified";
    } catch {
      return "unprintable cancellation reason";
    }
  };

  const cancelAtBoundary = async (phase: string, backendMessage?: string): Promise<SingleResult> => {
    const cancellationMessage = backendMessage
      ?? `Teammate run cancelled by its caller ${phase} (reason: ${formatCancellationReason()}).`;
    const previousMessages = lastResult?.messages ?? [];
    const result: SingleResult = {
      ...(lastResult ?? rejectWith(cancellationMessage)),
      exitCode: 1,
      messages: [
        { role: "system", content: cancellationMessage },
        ...previousMessages,
      ],
      attemptedModels: attemptedModels.length > 1 ? attemptedModels : undefined,
      terminalStatus: "terminated",
    };
    const trustedProvenance = lastResult === undefined
      ? undefined
      : hostRegistryResultProvenance(lastResult);
    if (trustedProvenance !== undefined) {
      result.provenance = trustedProvenance;
      hostRegistryProvenanceResults.set(result, structuredClone(trustedProvenance));
    }
    if (resolvedRunCwd) result.originCwd ??= resolvedRunCwd;
    if (!cancellationTurnRecorded && latestTurnEvent && options.recordTurnEvent) {
      cancellationTurnRecorded = true;
      const timestamp = Math.max(Date.now(), latestTurnEvent.timestamp + 1);
      options.recordTurnEvent({
        version: latestTurnEvent.version,
        turnId: latestTurnEvent.turnId,
        correlationId: latestTurnEvent.correlationId,
        runtimeGeneration: latestTurnEvent.runtimeGeneration,
        promptSeq: latestTurnEvent.promptSeq,
        loopSeq: latestTurnEvent.loopSeq,
        trigger: latestTurnEvent.trigger,
        timestamp,
        type: "terminated",
        outcome: "terminated",
        reason: cancellationMessage,
        ...("lastMessage" in latestTurnEvent && latestTurnEvent.lastMessage
          ? { lastMessage: latestTurnEvent.lastMessage }
          : {}),
      });
    }
    return publishTerminalResult(result, "terminated");
  };

  const waitForRetry = options.waitForRetry ?? waitForRetryDelay;
  let candidateIndex = 0;
  let processCandidateCount = 0;
  let nextCandidateLoopSeqOffset = 0;
  let failedCandidateCount = 0;
  // The provider heuristic remains legacy-only. Registry mode suppresses auth
  // by canonical deployment/route scope through ModelHealthAttemptState.
  const authSkippedProviders = new Set<string>();
  type CandidatePermit =
    | { kind: "legacy"; acquisition: AcquiredModelCandidate }
    | { kind: "registry"; acquisition: AcquiredModelHealthCandidate };

  const acquireCandidatePermit = (model: string | undefined): CandidatePermit | null | undefined => {
    if (model === undefined) return undefined;
    if (modelRegistryContext === undefined) {
      const acquisition = breaker.acquireCandidate(model);
      return acquisition.allowed ? { kind: "legacy", acquisition } : null;
    }
    const target = modelHealth!.resolveTarget(model);
    if (target === undefined) throw new TypeError(`Unknown canonical model health target ${JSON.stringify(model)}.`);
    if (modelHealthAttempt!.shouldSkip(target)) return null;
    const acquisition = modelHealth!.acquireCandidate(model);
    return acquisition.allowed ? { kind: "registry", acquisition } : null;
  };
  const recordPermitSuccess = (permit: CandidatePermit): void => {
    if (permit.kind === "legacy") breaker.recordSuccess(permit.acquisition);
    else modelHealth!.recordSuccess(permit.acquisition);
  };
  const recordPermitFailure = (permit: CandidatePermit, error: string): ReturnType<typeof classifyModelHealthFailure> | undefined => {
    if (permit.kind === "legacy") {
      breaker.recordRetryableFailure(permit.acquisition);
      return undefined;
    }
    const classification = classifyModelHealthFailure(
      { message: error },
      options.modelHealthFailureScopeClassifier,
    );
    if (classification.affectsCircuit && classification.scope !== "none") {
      modelHealth!.recordFailure(permit.acquisition, classification.scope);
      modelHealthAttempt!.noteFailure(permit.acquisition.target, classification);
    } else {
      modelHealth!.cancelCandidate(permit.acquisition);
    }
    return classification;
  };
  const releasePermit = (permit: CandidatePermit): void => {
    if (permit.kind === "legacy") breaker.releaseCandidate(permit.acquisition);
    else modelHealth!.releaseCandidate(permit.acquisition);
  };
  const cancelPermit = (permit: CandidatePermit): void => {
    if (permit.kind === "legacy") breaker.cancelCandidate(permit.acquisition);
    else modelHealth!.cancelCandidate(permit.acquisition);
  };

  // Acquisitions taken by in-process model switches. Registry keys are always
  // canonical registration ids even though Pi receives adapter selector values.
  const pendingModelAcquisitions = new Map<string, CandidatePermit>();
  let switchedAwayFromOriginal = false;
  const switchedModels = new Set<string>();
  const settlePendingModelAcquisitions = (success: boolean, error?: string): void => {
    for (const [, permit] of pendingModelAcquisitions) {
      if (success) recordPermitSuccess(permit);
      else if (permit.kind === "legacy") breaker.recordRetryableFailure(permit.acquisition);
      else recordPermitFailure(permit, error ?? "provider failure");
    }
    pendingModelAcquisitions.clear();
  };
  // Session checkpoint of the most recent Pi candidate that published one.
  // Registry mode also pins the deployment that owns it: only another route on
  // that exact local Pi deployment can consume the session safely.
  let lastSessionFile: string | undefined;
  let lastSessionCandidate: ResolvedModelRegistrationCandidate | undefined;
  let lastSessionDeploymentKey: string | undefined;
  interface ReplayFenceTotals {
    completedToolCount: number;
    inFlightToolCount: number;
    externalReplayRisk: boolean;
  }
  interface PendingResumeHandoff extends ReplayFenceTotals {
    sessionFile: string;
    sourceCandidate?: ResolvedModelRegistrationCandidate;
    sourceDeploymentKey?: string;
    freshReplayClear: boolean;
  }
  const replayTotals: ReplayFenceTotals = {
    completedToolCount: 0,
    inFlightToolCount: 0,
    externalReplayRisk: false,
  };
  let resumeHandoff: PendingResumeHandoff | undefined;
  let failureSequence = 0;
  let failureChain: RecoveryFailureChainV1 = { version: 1, decisions: Object.freeze([]) };
  const failureRecord = (
    message: string,
    layer: RecoveryFailureRecordV1["layer"],
    phase: string,
    model?: string,
  ): RecoveryFailureRecordV1 => Object.freeze({
    code: layer === "recovery" ? phase : classifyRetryError(message),
    layer,
    phase,
    sequence: ++failureSequence,
    sanitizedMessage: message,
    ...(model === undefined ? {} : { model }),
  });
  const addFailureDecision = (code: string, decision: string, evidenceRef?: string): void => {
    failureChain = Object.freeze({
      ...failureChain,
      decisions: Object.freeze([...failureChain.decisions, Object.freeze({
        code,
        sequence: ++failureSequence,
        decision,
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      })]),
    });
  };
  const appendReplayFenceDiagnostic = (
    result: SingleResult,
    facts: ReplayFenceTotals,
    checkpointReason?: string,
  ): void => {
    result.capabilityDeliveries = [
      ...(result.capabilityDeliveries ?? []),
      {
        capability: "modelSelection",
        support: "withheld",
        note:
          `the side-effect replay fence stopped failover after completedTools=${facts.completedToolCount}, `
          + `inFlightTools=${facts.inFlightToolCount}, externalReplayRisk=${facts.externalReplayRisk}`,
      },
    ];
    result.messages.push({
      role: "system",
      content:
        `Model fallback blocked by the side-effect replay fence `
        + `(completedTools=${facts.completedToolCount}, inFlightTools=${facts.inFlightToolCount}, `
        + `externalReplayRisk=${facts.externalReplayRisk}). `
        + (checkpointReason === undefined ? "" : `${checkpointReason} `)
        + `A fresh model process could repeat a completed tool, a tool whose effect is unknown, `
        + `or external work observed through child IPC/runtime diagnostics.`,
    });
  };

  for (const modelToUse of modelCandidates) {
    try { deploymentDefault?.assertCurrent(); } catch (error) { return rejectAndPublish(error instanceof Error ? error.message : String(error)); }
    if (options.signal?.aborted) return cancelAtBoundary("before a model candidate launched");
    if (modelToUse && modelToUse === resolvedDefaultModel) continue;
    const candidateProvider = modelRegistryContext === undefined && modelToUse
      ? providerOf(modelToUse)
      : undefined;
    if (candidateProvider !== undefined && authSkippedProviders.has(candidateProvider)) continue;
    candidateIndex += 1;
    const permit = acquireCandidatePermit(modelToUse);
    if (permit === null) return rejectAndPublish("ModelRole: frozen candidate is currently unavailable; no new selection was authorized");
    const registrationCandidate = modelToUse === undefined
      ? undefined
      : registrationPlan?.candidates.find((candidate) => candidate.modelRegistrationId === modelToUse);
    if (modelRegistryContext !== undefined && registrationCandidate === undefined) {
      return rejectAndPublish(`Unknown canonical model registration ${JSON.stringify(modelToUse)} in pinned dispatch plan.`);
    }

    const pendingHandoff = resumeHandoff;
    let handoff: string | undefined;
    if (pendingHandoff !== undefined) {
      const canResume = fs.existsSync(pendingHandoff.sessionFile)
        && (modelRegistryContext === undefined
          ? pendingHandoff.sourceDeploymentKey !== undefined
            && pendingHandoff.sourceDeploymentKey === legacyPiResumeDeploymentKey(modelToUse)
          : pendingHandoff.sourceCandidate !== undefined
            && registrationCandidate !== undefined
            && canResumePiCheckpoint(pendingHandoff.sourceCandidate, registrationCandidate));
      resumeHandoff = undefined;
      if (canResume) {
        handoff = pendingHandoff.sessionFile;
      } else {
        // This candidate starts from spec.task. The old Pi checkpoint no longer
        // represents its history and must not leak into a later fallback.
        lastSessionFile = undefined;
        lastSessionCandidate = undefined;
        lastSessionDeploymentKey = undefined;
        if (!pendingHandoff.freshReplayClear) {
          const sourceDeployment = pendingHandoff.sourceCandidate?.route.deploymentId
            ?? pendingHandoff.sourceDeploymentKey;
          const targetDeployment = registrationCandidate?.route.deploymentId;
          if (lastResult !== undefined) {
            appendReplayFenceDiagnostic(
              lastResult,
              pendingHandoff,
              `The Pi checkpoint from deployment ${JSON.stringify(sourceDeployment ?? "legacy-pi")} `
              + `cannot resume candidate ${JSON.stringify(modelToUse ?? "default")} on deployment `
              + `${JSON.stringify(targetDeployment ?? "non-pi")}; that candidate would replay the original task.`,
            );
          }
          if (permit !== undefined) cancelPermit(permit);
          break;
        }
      }
    }
    if (modelToUse) recordAttemptedModel(modelToUse);
    processCandidateCount += 1;
    const nativeCurrentCandidate = nativeCurrent.beginCandidate();
    latestNativeObservation = undefined;
    const candidateLoopSeqOffset = nextCandidateLoopSeqOffset;
    let candidateMaxLoopSeq = candidateLoopSeqOffset;

    let settled = false;
    let completionState: "buffering" | "forwarding" | "discarded" = "buffering";
    const pendingCompletions: Array<{
      result: SingleResult;
      terminalStatus?: AgentTerminalStatus;
    }> = [];
    const pendingTerminalTurnEvents: AgentTurnEvent[] = [];
    // Capture the child's published session file so a mid-run failure under
    // this candidate can resume that checkpoint only on a compatible Pi route.
    const hostOnChildEvent = options.onChildEvent;
    // In-process model failover: when the child settles a retryable provider
    // failure while still alive, pick the next healthy candidate from the
    // remaining chain and hand it to the child's `set_model` RPC. The same
    // session continues in place, so nothing is replayed. Models already
    // switched to within this run are excluded, and a model that actually ran
    // (acknowledged switch) but failed again is settled immediately instead
    // of waiting for the run's terminal result.
    const nextCandidateModel = (error: string, previousModel?: string, failureSource?: "provider" | "transport"): string | undefined => {
      if (!providerFallbackAllowed(failureSource === "provider" || failureSource === "transport" ? "provider-unavailable" : "unknown")) return undefined;
      verifyRoleModelSelection(params.modelSelection!, params, selectionCatalog,
        {cwd, role: agentConfig, globalFilePath: options.modelRoutingFilePath, authority: modelRegistryContext?.authority});
      const previousCandidateId = modelRegistryContext !== undefined
        && registrationCandidate !== undefined
        && registrationPlan !== undefined
        ? candidateForRuntimeModel(
            registrationPlan,
            registrationCandidate.route.deploymentId,
            previousModel,
          )?.modelRegistrationId
        : previousModel;
      if (previousCandidateId !== undefined) {
        const previousPermit = pendingModelAcquisitions.get(previousCandidateId);
        if (previousPermit !== undefined) {
          recordPermitFailure(previousPermit, error);
          pendingModelAcquisitions.delete(previousCandidateId);
        }
      } else if (modelRegistryContext !== undefined && permit !== undefined && !settled) {
        // Settle the failed original route before acquiring another route on
        // the same deployment. This releases the paired deployment permit and
        // lets a route-scoped Pi failure hot-switch without violating the
        // single half-open deployment trial invariant.
        recordPermitFailure(permit, error);
        settled = true;
      }

      const tail = modelCandidates.slice(candidateIndex).filter((candidate) => (
        candidate !== undefined
        && candidate !== modelToUse
        && candidate !== resolvedDefaultModel
        && !switchedModels.has(candidate)
      )) as string[];
      // Health may deny a candidate, never reorder a frozen role chain.
      for (const candidate of tail) {
        const hotCandidate = registrationPlan?.candidates.find((entry) => entry.modelRegistrationId === candidate);
        if (modelRegistryContext !== undefined) {
          if (
            registrationCandidate === undefined
            || hotCandidate === undefined
            || !canHotSwitchModelRegistration(registrationCandidate, hotCandidate)
          ) continue;
        } else {
          const candidateProvider = providerOf(candidate);
          if (candidateProvider !== undefined && authSkippedProviders.has(candidateProvider)) continue;
        }
        const nextPermit = acquireCandidatePermit(candidate);
        if (nextPermit === null || nextPermit === undefined) continue;
        pendingModelAcquisitions.set(candidate, nextPermit);
        switchedModels.add(candidate);
        recordAttemptedModel(candidate);
        if (previousModel === undefined) switchedAwayFromOriginal = true;
        return hotCandidate?.route.selector.kind === "adapter-model"
          ? hotCandidate.route.selector.value
          : candidate;
      }
      return undefined;
    };
    const hasHotSwitchCandidate = modelCandidates.slice(candidateIndex).some((candidate) => {
      if (candidate === undefined) return false;
      if (modelRegistryContext === undefined) return true;
      const target = registrationPlan?.candidates.find((entry) => entry.modelRegistrationId === candidate);
      return registrationCandidate !== undefined
        && target !== undefined
        && canHotSwitchModelRegistration(registrationCandidate, target);
    });
    // Selection authority uses canonical registration IDs. Native Pi receives
    // a separate physical selector view from this SAME frozen route plan.
    let nativePhysicalCatalog: TeammateModelCapability[] | undefined;
    if (registrationCandidate !== undefined && ownsResumablePiCheckpoint(registrationCandidate)
      && registrationCandidate.route.selector.kind === "adapter-model") {
      nativePhysicalCatalog = registrationPlan!.candidates.flatMap(candidate =>
        candidate.route.deploymentId === registrationCandidate.route.deploymentId
          && candidate.route.selector.kind === "adapter-model"
          ? [{...candidate.route.capabilities, id: candidate.route.selector.value}] : []);
      if (!nativePhysicalCatalog.length || !nativePhysicalCatalog.some(entry =>
        registrationCandidate.route.selector.kind === "adapter-model" && entry.id === registrationCandidate.route.selector.value)) {
        return rejectAndPublish("ModelRole: frozen native selector is absent from the approved route plan");
      }
    }
    const nativeObservationCandidate = processCandidateCount;
    const baseAttemptOptions: RunTeammateOptions = {
      ...options,
      isNativeInvocationCurrent: (id, generation) => nativeObservationCandidate === processCandidateCount
        && id === correlationId && generation === (options.runtimeGeneration ?? null)
        && options.isNativeInvocationCurrent?.(id,generation) !== false,
      onNativeExecutionObservation: (snapshot) => {
        nativeCurrent.observe(nativeCurrentCandidate, snapshot);
        // Retain late facts for their original identity, never promote a stale generation.
        if (nativeObservationCandidate === processCandidateCount && snapshot.correlationId === correlationId && snapshot.runtimeGeneration === (options.runtimeGeneration ?? null)) latestNativeObservation = snapshot;
        const joined=preparedTaskDispatch&&joinTaskDispatchObservation(preparedTaskDispatch,snapshot);
        if(joined){try{options.onTaskDispatchObservation?.(joined);}catch{/* Audit observers do not alter execution. */}}
        options.onNativeExecutionObservation?.(snapshot);
      },
      ...(nativePhysicalCatalog === undefined ? {} : {modelCapabilities: nativePhysicalCatalog}),
      initialTurnContext,
      turnLoopSeqOffset: candidateLoopSeqOffset,
      turnEventTimestampFloor,
      emitInitialTurnTrigger: processCandidateCount === 1,
      ...(handoff === undefined ? {} : {
        resumeSessionFile: handoff,
        resumePrompt: MODEL_FALLBACK_RESUME_PROMPT,
      }),
      ...(registrationCandidate !== undefined && options.onProgress !== undefined ? {
        onProgress: (data: AgentProgress): void => {
          const requested = candidateForRuntimeModel(
            registrationPlan!,
            registrationCandidate.route.deploymentId,
            data.requestedModel,
          )?.modelRegistrationId ?? registrationCandidate.modelRegistrationId;
          const resolved = candidateForRuntimeModel(
            registrationPlan!,
            registrationCandidate.route.deploymentId,
            data.resolvedModel,
          )?.modelRegistrationId ?? requested;
          options.onProgress?.({
            ...data,
            requestedModel: requested,
            resolvedModel: resolved,
            attemptedModels: [...attemptedModels],
          });
        },
      } : {}),
      ...(options.onResultPublished !== undefined ? {
        onResultPublished: async (result: SingleResult, originCwd: string) => {
          if (registrationCandidate === undefined) {
            removeUntrustedResultProvenance(result);
          } else {
            attachRegistryResultProvenance(
              result,
              modelRegistryContext!,
              registrationPlan!,
              registrationCandidate,
            );
            result.attemptedModels = attemptedModels.length > 1 ? [...attemptedModels] : undefined;
          }
          return options.onResultPublished?.(result, originCwd);
        },
      } : {}),
      // Only arm an in-process switch when Pi can select the successor through
      // another adapter-model registration on this exact deployment.
      ...(hasHotSwitchCandidate
        ? { onModelFailover: (error: string, previousModel?: string, source?: "provider" | "transport") => nextCandidateModel(error, previousModel, source) }
        : {}),
      onChildEvent: (event) => {
        if (event.type === "teammate_session_ready" && typeof event.sessionFile === "string") {
          lastSessionFile = event.sessionFile;
          lastSessionCandidate = registrationCandidate;
          lastSessionDeploymentKey = registrationCandidate === undefined
            ? legacyPiResumeDeploymentKey(modelToUse)
            : undefined;
        } else if (event.type === "teammate_model_switch_abandoned" && typeof event.model === "string") {
          // The switch never reached Pi's ack, so the target model never ran.
          // Release its trial acquisition instead of charging a phantom
          // failure at the terminal settlement.
          const abandonedId = registrationCandidate !== undefined
            ? candidateForRuntimeModel(
                registrationPlan!,
                registrationCandidate.route.deploymentId,
                event.model,
              )?.modelRegistrationId
            : event.model;
          const abandoned = abandonedId === undefined
            ? undefined
            : pendingModelAcquisitions.get(abandonedId);
          if (abandoned !== undefined) {
            releasePermit(abandoned);
            pendingModelAcquisitions.delete(abandonedId!);
          }
        }
        hostOnChildEvent?.(event);
      },
      ...(options.recordTurnEvent === undefined ? {} : {
        recordTurnEvent: (event: AgentTurnEvent): void => {
          if (completionState !== "discarded") {
            turnEventTimestampFloor = Math.max(turnEventTimestampFloor, event.timestamp);
          }
          latestTurnEvent = event;
          candidateMaxLoopSeq = Math.max(candidateMaxLoopSeq, event.loopSeq);
          const terminal = event.type === "turn-settled"
            || event.type === "failed"
            || event.type === "terminated";
          if (!terminal) {
            if (completionState !== "discarded") options.recordTurnEvent?.(event);
            return;
          }
          if (completionState === "forwarding") options.recordTurnEvent?.(event);
          else if (completionState === "buffering") pendingTerminalTurnEvents.push(event);
        },
      }),
    };
    const attemptOptions: RunTeammateOptions = options.onTurnComplete || options.onResultPublished
      ? {
          ...baseAttemptOptions,
          onTurnComplete(result, terminalStatus) {
            if (registrationCandidate === undefined) {
              removeUntrustedResultProvenance(result);
            } else {
              attachRegistryResultProvenance(
                result,
                modelRegistryContext!,
                registrationPlan!,
                registrationCandidate,
              );
              result.attemptedModels = attemptedModels.length > 1 ? [...attemptedModels] : undefined;
            }
            const effectiveStatus = terminalStatus
              ?? (options.signal?.aborted ? "terminated" : undefined);
            if (completionState === "forwarding") {
              if (publicationAwaitingCompletion) {
                // The first forwarded completion confirms the already-published initial turn.
                publishTurnComplete(result, effectiveStatus);
              } else {
                // Warm follow-up turns establish the same durable boundary before completion delivery.
                void publishResult(result, cwd).then(() => {
                  publishTurnComplete(result, effectiveStatus);
                }).catch((error) => {
                  logDiagnosticWarn(
                    `[pi-maestro-teammate] warm-turn result publication failed for ${result.correlationId}; `
                    + `terminal delivery was withheld: ${error instanceof Error ? error.message : String(error)}`,
                  );
                });
              }
            } else if (completionState === "buffering") {
              pendingCompletions.push({ result, terminalStatus: effectiveStatus });
            }
          },
        }
      : baseAttemptOptions;
    const commitCompletion = (): void => {
      completionState = "forwarding";
      for (const event of pendingTerminalTurnEvents.splice(0)) {
        options.recordTurnEvent?.(event);
      }
      for (const completion of pendingCompletions.splice(0)) {
        publishTurnComplete(completion.result, completion.terminalStatus);
      }
    };
    const discardCompletion = (): void => {
      completionState = "discarded";
      pendingCompletions.length = 0;
      pendingTerminalTurnEvents.length = 0;
    };

    try {
      let attempt: AttemptOutcome;
      // Hoisted out of the registry branch below because the failover decision
      // at the end of this iteration reads it, and the branch's own binding
      // dies with the `try` that resolves it. Left `undefined` by the legacy
      // path and by a resolution that throws before reaching the assignment,
      // which is what keeps both of those decisions exactly as they were.
      let resolvedCapabilities: BackendCapabilities | undefined;
      try {
        // An injected registry wins (tests and embedders supply one); otherwise
        // the workspace document decides, which is what makes `mode:
        // "backend-registry"` in `.pi/teammate-backends.json` actually switch
        // the dispatch path rather than only describe an intent.
        const registry = params.placement !== undefined
          ? options.backendRegistry ?? dispatchFabricPlacementRegistrySync(
              options.baseCwd,
              () => ({ hostOptions: attemptOptions, cwd, replyTo }),
              options.fabricRouteResolverOf!,
              options.remoteManagerOf,
            )
          : deploymentDefault?.registry
            ?? modelRegistryContext?.registry
            ?? options.backendRegistry
            ?? dispatchRegistrySync(
                options.baseCwd,
                () => ({ hostOptions: attemptOptions, cwd, replyTo }),
                options.remoteManagerOf,
                undefined,
                options.fabricRouteResolverOf,
              );
        if (registry === undefined) {
          // A `cli/<tool>` model is served by a registered backend and by
          // nothing else. Legacy mode resolves no registry, so falling through
          // would hand the model id to a pi subprocess, which would ask a
          // provider for a model literally named `cli/<tool>` and fail with a
          // message about an unknown model rather than about the mode.
          if (modelToUse !== undefined && isCliToolModel(modelToUse)) {
            return rejectAndPublish(
              `Teammate task requests model "${modelToUse}", but .pi/teammate-backends.json is in legacy `
              + `execution mode; set mode "backend-registry" and register "${cliToolNameFromModel(modelToUse)}" `
              + "— refusing to run a CLI tool model on the pi subprocess path",
            );
          }
          // An explicit backend selector is the same kind of routing decision,
          // and legacy mode can serve neither. Falling through would run the pi
          // subprocess under a name the task did not ask for, which is the one
          // outcome a routing decision must not have; it would also hand pi a
          // model specifier written in the named backend's namespace, since the
          // host stopped validating those the moment a backend claimed them.
          if (params.backend !== undefined) {
            return rejectAndPublish(
              `Teammate task selects backend "${params.backend}", but .pi/teammate-backends.json is in `
              + `legacy execution mode; set mode "backend-registry" and register "${params.backend}" `
              + "— refusing to run a backend-selected task on the pi subprocess path",
            );
          }
          await applyTodoPromptContext();
          if (options.signal?.aborted) return cancelAtBoundary("while Todo prompt context resolved");
          try { verifyRoleModelSelection(params.modelSelection!, params, options.modelCapabilities, {cwd, role: agentConfig, globalFilePath: options.modelRoutingFilePath, authority: modelRegistryContext?.authority}); }
          catch (error) { return rejectAndPublish(error instanceof Error ? error.message : String(error)); }
          await ensureTaskDispatch(cwd,attemptOptions);
          attempt = outcomeOf(await runSingleAttempt(
            params, agentConfig, cwd, correlationId, replyTo, startTime, modelToUse, attemptOptions,
            { origin: backendBudgetOrigin, request: originalDispatchRequest },
          ));
        } else {
          let spec = registrationCandidate === undefined
            ? backendSpecOf(params, cwd, modelToUse, remoteRouting)
            : modelRegistrationBackendSpecOf(params, cwd, registrationCandidate);
          if (registrationCandidate !== undefined
            && isRemoteModelRegistration(registrationCandidate)
            && !hasRemoteModelDispatchAuthority(options)) {
            return rejectAndPublish(
              `Remote model registration ${JSON.stringify(registrationCandidate.modelRegistrationId)} lost root Monitor authority before launch.`,
            );
          }
          const preflightResolution = registrationCandidate === undefined
            ? deploymentDefault?.resolved
            : modelRegistryContext?.resolutionsByCorrelationId
              .get(correlationId)
              ?.get(registrationCandidate.modelRegistrationId);
          let prepared: PreparedBackendAttempt;
          try {
            deploymentDefault?.assertCurrent();
            prepared = await prepareBackendAttemptOnce(
              registry,
              spec,
              spec.backend,
              preflightResolution,
            );
          } catch (error) {
            if (error instanceof BackendCapabilityAdmissionError) {
              // The resolved backend does not vary with the model candidate, so
              // no later candidate can serve this task either. Settling the
              // trial permit is left to the `finally` below.
              return rejectAndPublish(error.message);
            }
            throw error;
          }
          deploymentDefault?.assertCurrent();
          const { config, capabilities } = prepared;
          resolvedCapabilities = capabilities;
          await applyTodoPromptContext();
          if (options.signal?.aborted) return cancelAtBoundary("while Todo prompt context resolved");
          deploymentDefault?.assertCurrent();
          spec = registrationCandidate === undefined
            ? backendSpecOf(params, cwd, modelToUse, remoteRouting)
            : modelRegistrationBackendSpecOf(params, cwd, registrationCandidate);
          // Do not advertise or transport Pi-only Fast to CLI/remote adapters.
          if (prepared.backendName !== PI_SUBPROCESS) delete spec.fast;
          // Whether the backend published a channel of its own. Tracked rather
          // than decided by backend name: a backend that spawns a child hands
          // the host a real pipe carrying lease control and a session dir, and
          // replacing that with a translation would lose both.
          let publishedOwnChannel = false;
          const hostOnChildSpawned = attemptOptions.onChildSpawned;
          const backendOptions = backendOptionsOf(
            correlationId,
            // The host base, not `cwd`: the resolved task directory is on the
            // spec, and sending it twice leaves a backend unable to tell which
            // channel a task-level cwd actually arrived on.
            options.baseCwd,
            {
              ...attemptOptions,
              onChildSpawned: (stdin, sendControl, sessionDir, childId, generation) => {
                publishedOwnChannel = true;
                hostOnChildSpawned?.(stdin, sendControl, sessionDir, childId, generation);
              },
            },
            params.agent,
            startTime,
            config,
          );
          try {
            verifyRoleModelSelection(params.modelSelection!, params, options.modelCapabilities ?? (modelRegistryContext?.authority
              ? [...modelRegistryContext.authority.routesByRegistrationId.values()].map(route => ({ id: route.modelRegistrationId, ...route.capabilities })) : undefined), {cwd, role: agentConfig, globalFilePath: options.modelRoutingFilePath, authority: modelRegistryContext?.authority});
          } catch (error) {
            return rejectAndPublish(error instanceof Error ? error.message : String(error));
          }
          const bindings = modelRegistryContext === undefined
            ? undefined
            : modelRegistryRunBindings.get(modelRegistryContext);
          if (bindings !== undefined) {
            bindings.set(correlationId, { hostOptions: attemptOptions, cwd, replyTo });
          }
          let run: BackendRun;
          try {
            await ensureTaskDispatch(cwd,attemptOptions);
            assertTaskDispatch(preparedTaskDispatch,{correlationId,runtimeGeneration:options.runtimeGeneration??null,
              agent:params.agent,name:params.name,cwd,todoIds:params.todos??[]}, { unmetered: "assert", origin: backendBudgetOrigin });
            if (deploymentDefault) {
              deploymentDefault.assertCurrent();
              // An observer failure must stop this send. The callback is a
              // projection event, never proof that can authorize a replacement.
              options.onDeploymentDefault?.({correlationId, runtimeGeneration: options.runtimeGeneration ?? null,
                source: "deployment-default", actualModel: "undeclared"});
            }
            run = await (deploymentDefault?.assertCurrent(), prepared.start(spec, backendOptions));
          } catch (error) {
            bindings?.delete(correlationId);
            throw error;
          }
          // Cancellation reaches the seam only through the control channel; a
          // host that merely stops awaiting leaves the runtime alive.
          const abortRun = (): void => { run.abort(); };
          options.signal?.addEventListener("abort", abortRun, { once: true });
          // Give the host a pipe it can address when the backend has none, so
          // teammate-send reaches a live runtime instead of reporting that it
          // cannot be restored. A backend that publishes its own later simply
          // replaces this one.
          const shim = publishedOwnChannel ? undefined : createBackendControlStdin(run);
          if (shim !== undefined) {
            hostOnChildSpawned?.(
              shim,
              // No IPC control channel exists for a backend addressed this way;
              // reporting that honestly beats accepting a lease update nothing
              // will ever deliver.
              () => false,
              undefined,
              correlationId,
              attemptOptions.runtimeGeneration,
            );
          }
          try {
            attempt = await run.outcome;
            if (prepared.backendName !== PI_SUBPROCESS) {
              void attempt.reclamation.then((outcome) => {
                try {
                  options.onReclamationOutcome?.(
                    correlationId,
                    outcome.status === "reclaimed"
                      ? { status: "reclaimed", forced: false }
                      : { status: "unreaped", forced: false, reason: "exit-unconfirmed" },
                  );
                } catch {
                  // Reclamation observers are advisory after the backend has released its process.
                }
              });
            }
          } finally {
            options.signal?.removeEventListener("abort", abortRun);
            bindings?.delete(correlationId);
            // A settled run can no longer deliver, and the host checks
            // `writable` before writing.
            if (shim !== undefined) closeBackendControlStdin(shim);
          }
          // Recorded by the dispatch rather than by the backend: a backend that
          // forgot to name itself would otherwise be indistinguishable from the
          // legacy path, which names nothing because no backend served it.
          attempt.result.backend = prepared.backendName;
          if (params.fast === true && prepared.backendName !== PI_SUBPROCESS) {
            attempt.result.warnings = [...(attempt.result.warnings ?? []),
              `Codex Fast is not applied by backend "${prepared.backendName}"; only the local Pi Codex driver supports it.`];
          }
          // Emulation is recorded per run, so a consumer reading a structured
          // value can tell whether it came from a native contract or from
          // host-side extraction. Derived from the same adjudication the graph
          // ran, against the backend that actually served this attempt.
          const emulated = adjudicateTask(
            { spec, ...(spec.name === undefined ? {} : { name: spec.name }) },
            0,
            prepared.backendName,
            capabilities,
          ).emulated;
          if (emulated.length > 0) {
            // Appended, not assigned: a backend records its own emulations on
            // the result it returns, and overwriting the list here would erase
            // them without a trace. The withheld branch below already appends.
            attempt.result.capabilityDeliveries = [
              ...(attempt.result.capabilityDeliveries ?? []),
              ...emulated.map((capability) => ({
                capability,
                support: "emulated" as const,
                note: `served by host-side compensation in backend "${prepared.backendName}"`,
              })),
            ];
          }
        }
      } catch (error) {
        discardCompletion();
        throw error;
      }
      const candidateResult = attachPublicResultContext(attempt.result);
      nextCandidateLoopSeqOffset = Math.max(
        nextCandidateLoopSeqOffset + 1,
        candidateMaxLoopSeq + 1,
      );
      if (registrationCandidate === undefined) {
        removeUntrustedResultProvenance(candidateResult);
      } else {
        attachRegistryResultProvenance(
          candidateResult,
          modelRegistryContext!,
          registrationPlan!,
          registrationCandidate,
        );
      }
      if (deploymentDefault) {
        // The transport did not declare a physical model identity. A captured
        // optional Host default is selection context, never execution evidence.
        candidateResult.model = "";
        candidateResult.capabilityDeliveries = [...(candidateResult.capabilityDeliveries ?? []),
          {capability: "modelSelection", support: "withheld", note: "Authorized deployment default; actual model identity was not declared by the remote transport."}];
      }
      lastResult = candidateResult;
      candidateResult.originCwd ??= cwd;
      if (modelToUse === undefined) {
        try {
          resolvedDefaultModel = resolveModelSpecifier(candidateResult.model, options.modelCapabilities);
          recordAttemptedModel(resolvedDefaultModel);
        } catch {
          // Runtime-reported models outside the authenticated catalog cannot match an implicit candidate.
        }
      }
      if (candidateResult.lifecyclePending !== true) {
        candidateResult.terminalStatus ??= candidateResult.exitCode === 0 ? "completed" : "failed";
      }
      if(isNativeDurabilityFailure(attempt.result)){
        // Host storage refusal is not a provider/model failure and cannot select
        // another candidate or resend an input whose write outcome is unknown.
        if(permit!==undefined&&!settled){releasePermit(permit);settled=true;}
        for(const pending of pendingModelAcquisitions.values())releasePermit(pending);
        pendingModelAcquisitions.clear();
        const reclamation=await attempt.reclamation;
        addFailureDecision("native-durability-failure","execution input refused; no fallback/replay");
        if(reclamation.status==="unreaped")candidateResult.messages.push({role:"system",content:"Native recovery durability failure: owned child reclamation remains unconfirmed; no replacement was started."});
        candidateResult.recoveryFailureChain={version:1,...(failureChain.initiating?{initiating:failureChain.initiating}:{}),decisions:failureChain.decisions,terminal:failureRecord(resultFailureMessage(candidateResult.messages),"recovery","native-durability-failure",modelToUse)};
        await publishResult(candidateResult,cwd);commitCompletion();return candidateResult;
      }

      // These are generic protocol facts, not backend-specific retry rules.
      // Cancellation/refusal wins before exit-code success and model charging.
      const backendTerminal = candidateResult.recoveryFailureChain?.terminal;
      const backendRefused = backendTerminal?.code === "backend-refused"
        && backendTerminal.layer === "recovery"
        && backendTerminal.phase === "backend-terminal";
      if (candidateResult.terminalStatus === "terminated" || backendRefused) {
        if (permit !== undefined && !settled) {
          releasePermit(permit);
          settled = true;
        }
        for (const pendingPermit of pendingModelAcquisitions.values()) releasePermit(pendingPermit);
        pendingModelAcquisitions.clear();
        // Stop-gate history is diagnostic, never fresh replay authorization.
        // Preserve local order, then incoming order; do not trust producer
        // sequence values (including NaN/Infinity/unsafe integers) as a clock.
        const incomingChain = candidateResult.recoveryFailureChain;
        const initiating = failureChain.initiating ?? incomingChain?.initiating;
        const history = [...failureChain.decisions, ...(incomingChain?.decisions ?? [])];
        failureSequence = 0;
        failureChain = Object.freeze({
          version: 1,
          ...(initiating === undefined ? {} : {
            initiating: Object.freeze({ ...initiating, sequence: ++failureSequence }),
          }),
          decisions: Object.freeze(history.map(decision => Object.freeze({
            code: decision.code,
            sequence: ++failureSequence,
            decision: decision.decision,
            ...(decision.evidenceRef === undefined ? {} : { evidenceRef: decision.evidenceRef }),
          }))),
        });
        // Cancellation never admits a successor, so it must not wait without
        // bound for physical close. Observe an already-settled result only;
        // the existing onReclamationOutcome continuation retains later real facts.
        const reclamation = await Promise.race([
          attempt.reclamation,
          Promise.resolve(undefined),
        ]).catch(() => undefined);
        const cancelled = candidateResult.terminalStatus === "terminated";
        addFailureDecision(cancelled ? "backend-terminated" : "backend-refused",
          cancelled ? "fallback denied: backend reported cancellation" : "fallback denied: backend refused the terminal turn");
        if (reclamation?.status !== "reclaimed") {
          candidateResult.messages.push({ role: "system", content: reclamation?.status === "unreaped"
            ? "Backend stopped the run, but owned resource reclamation remains unconfirmed; no replacement was started."
            : "Backend stopped the run; resource reclamation remains unconfirmed at publication and may still be pending; no replacement was started." });
          addFailureDecision("reclamation-unconfirmed", "stopped backend resource reclamation remains unconfirmed");
        }
        candidateResult.recoveryFailureChain = {
          ...failureChain,
          terminal: cancelled
            ? failureRecord("Backend reported cancellation.", "recovery", "backend-terminated", modelToUse)
            : { ...backendTerminal!, sequence: ++failureSequence },
        };
        discardCompletion();
        if (cancelled) {
          return cancelAtBoundary("after backend cancellation", "Teammate run cancelled by its backend; no replacement was started.");
        }
        // Keep the actual result/provenance object. The canonical publication
        // helper still enforces resource acknowledgement before completion.
        candidateResult.exitCode = 1;
        candidateResult.terminalStatus = "failed";
        candidateResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
        candidateResult.messages.push({ role: "system", content: "Backend refused the terminal turn; no replacement was started." });
        return publishTerminalResult(candidateResult, "failed");
      }

      if (candidateResult.exitCode === 0) {
        if (permit !== undefined && !settled) {
          // Preserve the legacy hot-switch charge while registry mode settles
          // the original failure inside the switch hook before acquiring the
          // successor's scoped permit.
          if (permit.kind === "legacy" && switchedAwayFromOriginal) {
            breaker.recordRetryableFailure(permit.acquisition);
          } else {
            recordPermitSuccess(permit);
          }
          settled = true;
        }
        settlePendingModelAcquisitions(true);
        candidateResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
        if (failureChain.initiating || failureChain.decisions.length > 0) {
          failureChain = Object.freeze({
            ...failureChain,
            terminal: failureRecord("Recovery completed successfully.", "recovery", "fallback-succeeded", modelToUse),
          });
          candidateResult.recoveryFailureChain = failureChain;
        }
        await publishResult(candidateResult, cwd);
        commitCompletion();
        return candidateResult;
      }

      if (options.signal?.aborted) {
        if (permit !== undefined && !settled) {
          releasePermit(permit);
          settled = true;
        }
        // A caller cancellation is not a model failure: release every
        // in-process switch trial instead of charging the models.
        for (const [, pendingPermit] of pendingModelAcquisitions) {
          releasePermit(pendingPermit);
        }
        pendingModelAcquisitions.clear();
        discardCompletion();
        return cancelAtBoundary("while a model candidate was running");
      }

      const error = resultFailureMessage(candidateResult.messages);
      if (failureChain.initiating === undefined && candidateResult.recoveryFailureChain?.initiating) {
        failureChain = Object.freeze({
          ...failureChain,
          initiating: candidateResult.recoveryFailureChain.initiating,
        });
      }
      const structuredInitiating = candidateResult.recoveryFailureChain?.initiating;
      const structuredRetryKind = structuredInitiating === undefined
        ? classifyRetryInput({ source: "recovery-diagnostic", message: error })
        : classifyRetryInput({
            source: structuredInitiating.layer === "transport" ? "transport" : "provider",
            message: structuredInitiating.sanitizedMessage,
          });
      const fallbackFailure = providerFallbackAllowed(
        (structuredInitiating?.layer === "provider" || structuredInitiating?.layer === "transport")
          && structuredRetryKind !== undefined && structuredRetryKind !== "non-retryable"
          ? "provider-unavailable" : "unknown",
      );
      // Reclamation is also the final evidence drain boundary for attempts that
      // could actually enter fallback. Non-provider terminal paths retain their
      // legacy settlement timing and never authorize replay.
      const finalReclamation = fallbackFailure
        ? await attempt.reclamation
        : { status: "reclaimed" as const };
      if (fallbackFailure && candidateResult.replayEvidence) {
        candidateResult.replayEvidence = Object.freeze({ ...candidateResult.replayEvidence, finalized: true });
      }
      let registryFailureClassification: ReturnType<typeof classifyModelHealthFailure> | undefined;
      if (modelRegistryContext !== undefined) {
        if (permit !== undefined && !settled) {
          registryFailureClassification = recordPermitFailure(permit, error);
          settled = true;
        }
        settlePendingModelAcquisitions(false, error);
      }
      const recoveryFacts = attempt.recovery;
      const authoritativeFailure = recoveryFacts.settlementAuthority === "authoritative";
      const preActivityInfrastructureExit = recoveryFacts.preActivityInfrastructureExit;
      // Fresh replay must account for every effect in a same-session fallback
      // chain, not only the final Pi process that happened to fail.
      replayTotals.completedToolCount += recoveryFacts.completedToolCount;
      replayTotals.inFlightToolCount += recoveryFacts.inFlightToolCount;
      replayTotals.externalReplayRisk ||= candidateResult.replayEvidence === undefined
        ? recoveryFacts.externalReplayRisk
        : hasExternalReplayRisk(candidateResult.replayEvidence);
      const replayFenceClear = !buildReplayFence({
        completedToolCount: replayTotals.completedToolCount,
        unknownEffect: replayTotals.inFlightToolCount > 0 || replayTotals.externalReplayRisk,
        blockedReason:
          `Fresh replay blocked after completedTools=${replayTotals.completedToolCount}, `
          + `inFlightTools=${replayTotals.inFlightToolCount}, externalReplayRisk=${replayTotals.externalReplayRisk}.`,
      }).blocked;
      // Failover here would cost the run its diagnosis and buy nothing. Every
      // candidate after the first carries an explicit model, so the capability
      // gate above refuses the task before any of them starts — no remote
      // process and no tokens are saved, because none would have been spent.
      // What is saved is the diagnosis: without this, a capability refusal
      // about a candidate that never ran replaces the failure this run actually
      // observed.
      //
      // Only reachable when the caller named no model. A caller-named model
      // puts `spec.model` on the first candidate, so the gate refuses the whole
      // task outright and this path is never entered — which leaves exactly the
      // runs that produced a real provider diagnosis worth keeping.
      const modelSelectionUnsupported = modelRegistryContext === undefined
        && resolvedCapabilities?.modelSelection === "unsupported";
      // A checkpoint bypasses the fresh-replay fence only provisionally. The
      // next actually admitted candidate must still prove that it is another
      // route on the exact local Pi deployment that owns this session.
      const checkpointOwnedByPi = modelRegistryContext === undefined
        ? lastSessionDeploymentKey !== undefined
        : lastSessionCandidate !== undefined && ownsResumablePiCheckpoint(lastSessionCandidate);
      const resumableCheckpoint = checkpointOwnedByPi
        && lastSessionFile !== undefined
        && fs.existsSync(lastSessionFile);
      const resumeUnknownEffect = replayTotals.inFlightToolCount > 0
        || replayTotals.externalReplayRisk;
      const failoverConditionsMet = resumableCheckpoint && !resumeUnknownEffect
        ? fallbackFailure
        : replayFenceClear
          && fallbackFailure && authoritativeFailure;
      let fallbackEligible = failoverConditionsMet && !modelSelectionUnsupported;

      // Resume-based failover publishes the checkpoint handoff itself and is
      // not a blocked decision; only the fresh-replay paths below append
      // diagnostics.
      if (!resumableCheckpoint && fallbackFailure && !authoritativeFailure && !preActivityInfrastructureExit) {
        addFailureDecision(
          "settlement-authority-insufficient",
          "fresh fallback denied: child settlement was not authoritative",
          "settlementAuthority",
        );
        candidateResult.messages.push({
          role: "system",
          content:
            `Model fallback blocked because the child did not provide an authoritative settlement `
            + `(settlementAuthority=${recoveryFacts.settlementAuthority}). `
            + `Legacy or interrupted child streams have degraded recovery capability and cannot be fresh-replayed safely.`,
        });
      } else if (resumableCheckpoint && resumeUnknownEffect && fallbackFailure) {
        addFailureDecision("checkpoint-resume-replay-risk", "checkpoint resume denied", "replayEvidence");
        // A checkpoint exists but the failed run left a tool in flight or
        // external replay risk: resuming the session could repeat side
        // effects the history does not record. Block the resume path and
        // say why, so the run is not indistinguishable from a no-candidate
        // failure.
        candidateResult.messages.push({
          role: "system",
          content:
            `Model fallback blocked by the side-effect replay fence `
            + `(checkpoint present but inFlightTools=${replayTotals.inFlightToolCount}, `
            + `externalReplayRisk=${replayTotals.externalReplayRisk}). `
            + `A resumed model could repeat a tool whose effect is unknown; `
            + `the run settles as failed instead.`,
        });
      } else if (!resumableCheckpoint && (fallbackFailure || preActivityInfrastructureExit) && !replayFenceClear) {
        addFailureDecision("fresh-replay-risk", "fresh fallback denied", "replayEvidence");
        appendReplayFenceDiagnostic(candidateResult, replayTotals);
      } else if (modelSelectionUnsupported && failoverConditionsMet) {
        // Every other condition for failover held, so without this record the
        // result is indistinguishable from one that had no candidate left.
        addFailureDecision(
          "model-selection-unsupported",
          "fallback denied: backend cannot select the remaining model candidates",
          "capabilityDeliveries",
        );
        candidateResult.capabilityDeliveries = [
          ...(candidateResult.capabilityDeliveries ?? []),
          {
            capability: "modelSelection",
            support: "withheld",
            note:
              `backend "${candidateResult.backend}" declares modelSelection is unsupported, `
              + `so capability adjudication would refuse every remaining model candidate before it started `
              + `and that refusal would replace this run's own failure`,
          },
        ];
        candidateResult.messages.push({
          role: "system",
          content:
            `Model fallback blocked because backend "${candidateResult.backend}" declares `
            + `modelSelection is unsupported. Each remaining candidate names a model this backend `
            + `cannot select, so capability adjudication would refuse it before it started and you `
            + `would be shown that refusal instead of the failure reported above.`,
        });
      }

      if (fallbackEligible) {
        // The failed runtime was reclaimed above before final replay evidence
        // was read; replacement admission still fails closed if it was unreaped.
        if (finalReclamation.status === "unreaped") {
          candidateResult.messages.push({
            role: "system",
            content:
              `Teammate did not confirm reclamation of the failed child; `
              + `model fallback was stopped to fence stale callbacks for correlationId=${correlationId}.`,
          });
          addFailureDecision("reclamation-unconfirmed", "fallback denied: failed child was not reclaimed");
          fallbackEligible = false;
        }
      }

      if (fallbackEligible) {
        addFailureDecision(
          resumableCheckpoint ? "checkpoint-resume" : "fresh-fallback",
          resumableCheckpoint ? "checkpoint resume admitted" : "fresh fallback admitted",
        );
        if (permit?.kind === "legacy" && !settled) {
          if (preActivityInfrastructureExit) breaker.releaseCandidate(permit.acquisition);
          else breaker.recordRetryableFailure(permit.acquisition);
          settled = true;
        }
        if (modelRegistryContext === undefined) settlePendingModelAcquisitions(false);
        discardCompletion();
        const kind = registryFailureClassification?.retryKind
          ?? (preActivityInfrastructureExit ? "non-retryable" : classifyRetryError(error));
        // Legacy credentials are provider-scoped. Registry mode already applied
        // canonical route/deployment auth suppression above.
        if (modelRegistryContext === undefined && kind === "auth" && modelToUse !== undefined) {
          const failedProvider = providerOf(modelToUse);
          if (failedProvider !== undefined) authSkippedProviders.add(failedProvider);
        }
        // Carry the checkpoint to the next admitted candidate. Compatibility is
        // checked there, after health/auth skips, before the candidate is
        // counted as attempted or allowed to start.
        if (resumableCheckpoint && lastSessionFile !== undefined) {
          resumeHandoff = {
            sessionFile: lastSessionFile,
            ...(lastSessionCandidate === undefined ? {} : { sourceCandidate: lastSessionCandidate }),
            ...(lastSessionDeploymentKey === undefined ? {} : { sourceDeploymentKey: lastSessionDeploymentKey }),
            freshReplayClear: replayFenceClear,
            completedToolCount: replayTotals.completedToolCount,
            inFlightToolCount: replayTotals.inFlightToolCount,
            externalReplayRisk: replayTotals.externalReplayRisk,
          };
        }
        // D2: bounded kind-aware backoff before the next candidate. Only
        // transient network/provider failures wait (a degraded provider gets
        // a beat instead of consecutive hammering); quota, auth, and
        // permanent failures switch immediately. The final candidate never
        // sleeps — the loop exits to the terminal failure path.
        failedCandidateCount += 1;
        const delayMs = retryDelayMs(failedCandidateCount, kind, extractRetryAfterMs(error));
        if (delayMs > 0 && options.enableRetryBackoff !== false && candidateIndex < modelCandidates.length) {
          await waitForRetry(delayMs, options.signal);
        }
        continue;
      }

      if (permit !== undefined && !settled) {
        releasePermit(permit);
        settled = true;
      }
      if (modelRegistryContext === undefined) settlePendingModelAcquisitions(false);
      candidateResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
      const terminalMessage = candidateResult.messages.at(-1)?.content ?? error;
      failureChain = Object.freeze({
        ...failureChain,
        terminal: failureRecord(terminalMessage, "recovery", "fallback-terminal", modelToUse),
      });
      candidateResult.recoveryFailureChain = failureChain;
      await publishResult(candidateResult, cwd);
      commitCompletion();
      return candidateResult;
    } finally {
      // Every half-open permit must settle exactly once. releasePermit is a
      // no-op for ordinary CLOSED acquisitions.
      if (!settled && permit !== undefined) releasePermit(permit);
    }
  }

  if (options.signal?.aborted) return cancelAtBoundary("after model candidate processing");
  if (lastResult) {
    lastResult.attemptedModels = attemptedModels.length > 1 ? attemptedModels : undefined;
    if (lastResult.exitCode !== 0) {
      const terminalMessage = lastResult.messages.at(-1)?.content ?? "Teammate recovery exhausted.";
      failureChain = Object.freeze({
        ...failureChain,
        terminal: failureRecord(terminalMessage, "recovery", "fallback-terminal", lastResult.model),
      });
      lastResult.recoveryFailureChain = failureChain;
    }
    await publishResult(lastResult, cwd);
    publishTurnComplete(lastResult);
    return lastResult;
  }
  return rejectAndPublish(
    `Teammate skipped every model candidate because their circuit breakers are open (agent=${params.agent}).`,
  );
}

// ---------------------------------------------------------------------------
// Graph execution (unified: parallel, chain, and DAG)
// ---------------------------------------------------------------------------


 return {runSingleTeammate,runSingleTeammateWithOrigin};
}
