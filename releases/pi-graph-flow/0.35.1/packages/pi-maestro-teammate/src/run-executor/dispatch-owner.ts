import { isImplicitBuiltinModelSelection, bindRoleDeploymentDefault } from "../models/model-routing.ts";
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
import {createRetryOwner} from "./retry-owner.ts";
import {createGraphOwner} from "./graph-owner.ts";
export interface ModelRegistryRunBinding {
  hostOptions: RunTeammateOptions;
  cwd: string;
  replyTo: ReplyTarget;
}
export interface MutableModelRegistryDispatchContext extends ModelRegistryDispatchContext {
  readonly plansByCorrelationId: Map<string, ResolvedModelRegistrationRouting>;
  readonly resolutionsByCorrelationId: Map<string, Map<string, ResolvedBackend>>;
}
export interface PreparedBackendAttempt {
  readonly backendName: string;
  readonly config: Record<string, ConfigValue>;
  readonly capabilities: BackendCapabilities;
  start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun>;
}
export interface FabricSourceRuntimeOptions {
  readonly backendRegistry?: BackendRegistry;
}
function createDispatchContext(ports: ExecutionPorts) {
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
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate } = ports;
 const assertFabricIdentifier: ExecutionPorts["assertFabricIdentifier"] = ports.assertFabricIdentifier;
 const assertValidTeammatePlacement: ExecutionPorts["assertValidTeammatePlacement"] = ports.assertValidTeammatePlacement;

/** Provider identity of a `provider/model` selector, or undefined when unparsable. */
function providerOf(model: string): string | undefined {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}





const modelRegistryRunBindings = new WeakMap<
  ModelRegistryDispatchContext,
  Map<string, ModelRegistryRunBinding>
>();
const hostRegistryProvenanceResults = new WeakMap<SingleResult, TeammateExecutionProvenance>();

function hostRegistryResultProvenance(
  result: SingleResult,
): TeammateExecutionProvenance | undefined {
  const provenance = hostRegistryProvenanceResults.get(result);
  return provenance === undefined ? undefined : structuredClone(provenance);
}

function captureModelRegistryAuthority(
  options: RunTeammateOptions,
): ModelRegistryDispatchContext["authority"] | undefined {
  const captured = options.modelRegistryDispatch?.authority ?? options.modelRegistryAuthority;
  if (captured !== undefined) return captured;
  // Preserve the frozen 2.0 document/cache path exactly. The revision-aware
  // reader is consulted only after that path has already opted into
  // model-registry mode.
  if ((backendRegistryConfigSync(options.baseCwd).mode ?? "legacy") !== "model-registry") {
    return undefined;
  }
  return modelRegistryPairSync(options.baseCwd)?.dispatch;
}

function createModelRegistryDispatchContext(
  authority: ModelRegistryDispatchContext["authority"],
  options: RunTeammateOptions,
): MutableModelRegistryDispatchContext {
  const bindings = new Map<string, ModelRegistryRunBinding>();
  const registry = options.backendRegistry ?? dispatchRegistryForProjectionSync(
    authority,
    (_spec, backendOptions) => {
      const binding = bindings.get(backendOptions.correlationId);
      if (binding === undefined) {
        throw new Error(
          `Model-registry backend started without an admitted run binding for correlationId=${backendOptions.correlationId}.`,
        );
      }
      return binding;
    },
    options.remoteManagerOf,
    options.fabricRouteResolverOf,
  );
  const context: MutableModelRegistryDispatchContext = {
    authority,
    registry,
    modelHealthCoordinator: (
      options.modelHealthCoordinator ?? sharedModelHealthCoordinator
    ).createProjectionView(authority),
    plansByCorrelationId: new Map(),
    resolutionsByCorrelationId: new Map(),
  };
  modelRegistryRunBindings.set(context, bindings);
  return context;
}

function modelRegistrationPlan(
  authority: ModelRegistryDispatchContext["authority"],
  params: Pick<RunSingleTeammateParams, "model" | "fallbackModels" | "backend" | "cwd">,
  agentConfig?: AgentConfig,
): ResolvedModelRegistrationRouting {
  return resolveModelRegistrationRouting(authority, {
    model: params.model ?? agentConfig?.model,
    fallbackModels: params.fallbackModels ?? agentConfig?.fallbackModels,
    backend: params.backend,
    cwd: params.cwd,
  });
}

function isRemoteModelRegistration(candidate: ResolvedModelRegistrationCandidate): boolean {
  return candidate.deployment.runtime.transport.kind === "remote-worker";
}

function ownsResumablePiCheckpoint(candidate: ResolvedModelRegistrationCandidate): boolean {
  const transport = candidate.deployment.runtime.transport;
  return candidate.deployment.registration.module === PI_SUBPROCESS
    && candidate.deployment.runtime.harness === "pi"
    && transport.kind === "local-process"
    && transport.protocol === "pi-rpc";
}

function canResumePiCheckpoint(
  from: ResolvedModelRegistrationCandidate,
  to: ResolvedModelRegistrationCandidate,
): boolean {
  return from.route.deploymentId === to.route.deploymentId
    && ownsResumablePiCheckpoint(from)
    && ownsResumablePiCheckpoint(to);
}

function hasRemoteModelDispatchAuthority(options: RunTeammateOptions): boolean {
  try {
    return options.authorizeRemoteModelDispatch?.() === true;
  } catch {
    return false;
  }
}

async function captureBuiltinDeploymentDefault(
  params: RunSingleTeammateParams, options: RunTeammateOptions, cwd: string,
  role: AgentConfig, catalog: readonly TeammateModelCapability[] | undefined, remote?: RemoteLocationRouting,
) {
  if (!params.modelSelection || !isImplicitBuiltinModelSelection(params.modelSelection)
    || options.captureDeploymentDefault === undefined || params.placement !== undefined) return undefined;
  const registry = options.backendRegistry ?? dispatchRegistrySync(options.baseCwd,
    () => { throw new Error("Deployment default is not a Pi process binding"); }, options.remoteManagerOf);
  if (!registry) return undefined;
  const probe = backendSpecOf(params, cwd, undefined, remote);
  const resolved = await registry.resolve(probe, probe.backend);
  if (resolved.backend.name !== REMOTE_WORKERS || resolved.capabilities.modelSelection !== "unsupported") return undefined;
  const targetId = resolved.config.targetId, driver = resolved.config.driver;
  if (typeof targetId !== "string" || (driver !== "pi-rpc" && driver !== "acp")) throw new Error("Invalid trusted remote deployment default");
  const host = options.captureDeploymentDefault(targetId);
  const readDeployment = (): string => {
    verifyRoleModelSelection(params.modelSelection!, params, catalog,
      {cwd, role, globalFilePath: options.modelRoutingFilePath});
    host.assertCurrent();
    if (options.remoteManagerOf?.() !== host.manager || host.monitorOwnerNonce !== host.manager.monitorOwnerNonce) {
      throw new Error("Trusted deployment default manager changed");
    }
    const target = host.readTarget();
    if (target.id !== targetId || target.driver !== driver || JSON.stringify(target) !== JSON.stringify(host.target)) {
      throw new Error("Trusted deployment default target changed");
    }
    return JSON.stringify({cwd, target, registry: backendRegistryConfigSync(options.baseCwd),
      backend: resolved.backend.name, config: resolved.config, capabilities: resolved.capabilities,
      monitorOwnerNonce: host.monitorOwnerNonce});
  };
  const assertCurrent = bindRoleDeploymentDefault(params.modelSelection, catalog,
    {cwd, role, globalFilePath: options.modelRoutingFilePath}, readDeployment);
  return {registry, resolved, assertCurrent};
}

function modelRegistrationBackendSpecOf(
  params: RunSingleTeammateParams,
  cwd: string,
  candidate: ResolvedModelRegistrationCandidate,
): TeammateRunSpec {
  const selector = candidate.route.selector;
  return {
    agent: params.agent,
    task: params.task ?? "",
    ...(params.name === undefined ? {} : { name: params.name }),
    // Placement selects the Fabric route, while the captured model registry
    // still translates canonical registration ids into adapter selectors.
    // Without placement, the canonical candidate's deployment remains the
    // backend selector exactly as before.
    backend: params.placement === undefined ? candidate.route.deploymentId : FABRIC_BACKEND,
    ...(params.context === undefined ? {} : { context: params.context }),
    // Fabric's wire namespace is always the canonical model registration id.
    // Only a source Device may translate it to an adapter-owned selector.
    ...(params.placement !== undefined
      ? { model: candidate.modelRegistrationId }
      : selector.kind === "adapter-model"
        ? { model: selector.value }
        : {}),
    ...(params.thinking === undefined ? {} : { thinking: params.thinking as TeammateRunSpec["thinking"] }),
    ...(params.fast === undefined ? {} : { fast: params.fast }),
    ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
    ...(params.todos === undefined ? {} : { todos: params.todos }),
    ...(params.placement === undefined ? {} : { placement: params.placement }),
    ...(isRemoteModelRegistration(candidate) ? {} : { cwd }),
  };
}

async function preflightModelRegistrationPlan(
  context: MutableModelRegistryDispatchContext,
  correlationId: string,
  params: RunSingleTeammateParams,
  cwd: string,
  plan: ResolvedModelRegistrationRouting,
  options: RunTeammateOptions,
  graphTaskCount = 1,
  registry: BackendRegistry = context.registry,
): Promise<string[]> {
  const resolutions = new Map<string, ResolvedBackend>();
  const warnings = (await Promise.all(plan.candidates.map(async (candidate) => {
    if (isRemoteModelRegistration(candidate)) {
      if (graphTaskCount > 1) {
        throw new Error(
          `Remote model registration ${JSON.stringify(candidate.modelRegistrationId)} supports only single-task dispatches; graph remote execution is not enabled.`,
        );
      }
      if (!hasRemoteModelDispatchAuthority(options)) {
        throw new Error(
          `Remote model registration ${JSON.stringify(candidate.modelRegistrationId)} requires current root Monitor authority.`,
        );
      }
    }
    const spec = modelRegistrationBackendSpecOf(params, cwd, candidate);
    const resolved = await registry.resolve(spec, spec.backend);
    const verdict = validateBackendCapabilities(
      [{ spec, ...(spec.name === undefined ? {} : { name: spec.name }) }],
      () => ({ name: resolved.backend.name, capabilities: resolved.capabilities }),
    );
    if (verdict.errors.length > 0) throw new Error(verdict.errors.join("\n"));
    resolutions.set(candidate.modelRegistrationId, resolved);
    return verdict.warnings;
  }))).flat();
  context.plansByCorrelationId.set(correlationId, plan);
  context.resolutionsByCorrelationId.set(correlationId, resolutions);
  return warnings;
}

function candidateForRuntimeModel(
  plan: ResolvedModelRegistrationRouting,
  deploymentId: string,
  runtimeModel: string | undefined,
): ResolvedModelRegistrationCandidate | undefined {
  if (runtimeModel === undefined) return undefined;
  return plan.candidates.find((candidate) =>
    candidate.route.deploymentId === deploymentId
    && (candidate.modelRegistrationId === runtimeModel
      || (candidate.route.selector.kind === "adapter-model"
        && candidate.route.selector.value === runtimeModel)));
}

function registryResultCandidate(
  result: SingleResult,
  plan: ResolvedModelRegistrationRouting,
  initialCandidate: ResolvedModelRegistrationCandidate,
): ResolvedModelRegistrationCandidate {
  const candidate = candidateForRuntimeModel(
    plan,
    initialCandidate.route.deploymentId,
    result.model,
  ) ?? initialCandidate;
  result.model = candidate.modelRegistrationId;
  return candidate;
}

function executionTransportProvenance(
  candidate: ResolvedModelRegistrationCandidate,
): TeammateExecutionProvenance["transport"] {
  const transport = candidate.deployment.runtime.transport;
  switch (transport.kind) {
    case "local-process":
      return { kind: transport.kind, protocol: transport.protocol };
    case "acp-direct-ssh":
      return { kind: transport.kind, protocol: transport.protocol };
    case "dsh-direct-ssh":
      return { kind: transport.kind, protocol: transport.protocol };
    case "remote-worker":
      return {
        kind: transport.kind,
        gateway: transport.gateway,
        protocol: transport.protocol,
        driver: transport.driver,
      };
    case "adapter-owned":
      return { kind: transport.kind };
  }
}

function attachRegistryResultProvenance(
  result: SingleResult,
  context: ModelRegistryDispatchContext,
  plan: ResolvedModelRegistrationRouting,
  initialCandidate: ResolvedModelRegistrationCandidate,
): void {
  const candidate = registryResultCandidate(result, plan, initialCandidate);
  const provenance: TeammateExecutionProvenance = {
    registryVersion: context.authority.registryVersion,
    registryRevision: context.authority.revision,
    registryHash: context.authority.hash,
    modelRegistrationId: candidate.modelRegistrationId,
    modelId: candidate.route.modelId,
    deploymentId: candidate.route.deploymentId,
    harness: candidate.deployment.runtime.harness,
    transport: executionTransportProvenance(candidate),
  };
  result.provenance = provenance;
  hostRegistryProvenanceResults.set(result, structuredClone(provenance));
}

function removeUntrustedResultProvenance(result: SingleResult): void {
  delete result.provenance;
  hostRegistryProvenanceResults.delete(result);
}

// ---------------------------------------------------------------------------
// Core: run a single teammate agent
// ---------------------------------------------------------------------------

/**
 * Decide which registration serves this attempt.
 *
 * A remote location already selected its backend and a task that named one
 * meant it, so the model-derived mapping is the last word rather than the first.
 *
 * @param params - the teammate request.
 * @param model - the single model this attempt runs.
 * @param remote - the remote target this task was located at, when it named one.
 * @returns the registered backend name, or undefined to take the registry default.
 */
function backendNameOf(
  params: RunSingleTeammateParams,
  model: string | undefined,
  remote?: RemoteLocationRouting,
): string | undefined {
  if (remote !== undefined) return remote.backend;
  // A placed task is served by the Fabric adapter, never by the default
  // backend: falling through would run on this machine a task that was placed
  // on another Endpoint, which is the one outcome a placement must not have.
  if (params.placement !== undefined) return FABRIC_BACKEND;
  if (params.backend !== undefined) return params.backend;
  // A `cli/<tool>` model names its own registration: the tool is the registered
  // backend, so a deployment adds a CLI by registering one and changes no host
  // source. An unregistered tool is refused by name by the registry, which is
  // the same outcome the inline dispatch produced for an unconfigured tool.
  if (model !== undefined && isCliToolModel(model)) return cliToolNameFromModel(model);
  return undefined;
}

/**
 * Project the orchestrator request into the backend contract.
 *
 * Host-resolved fields stay behind: `taskType` has already become a model,
 * `fallbackModels` is sequenced across attempts by the sweep below, and
 * `background` is host scheduling.
 *
 * @param params - the teammate request.
 * @param cwd - resolved task cwd.
 * @param model - the single model this attempt runs.
 * @param remote - the remote target this task was located at, when it named one.
 * @returns the contract-shaped run spec.
 */
function backendSpecOf(
  params: RunSingleTeammateParams,
  cwd: string,
  model: string | undefined,
  remote?: RemoteLocationRouting,
): TeammateRunSpec {
  const backend = backendNameOf(params, model, remote);
  return {
    agent: params.agent,
    task: params.task ?? "",
    ...(params.name === undefined ? {} : { name: params.name }),
    ...(backend === undefined ? {} : { backend }),
    ...(params.context === undefined ? {} : { context: params.context }),
    ...(model === undefined ? {} : { model }),
    ...(params.thinking === undefined ? {} : { thinking: params.thinking as TeammateRunSpec["thinking"] }),
    ...(params.fast === undefined ? {} : { fast: params.fast }),
    ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
    ...(params.todos === undefined ? {} : { todos: params.todos }),
    ...(params.placement === undefined ? {} : { placement: params.placement }),
    // A remote location is a target, not a directory: the working directory a
    // remote run uses comes from that target's own configuration, and passing
    // the literal `remote:beta` down as a path is what made the old bypass
    // resolve it against the local base.
    ...(remote === undefined ? { cwd } : {}),
  };
}

/**
 * Build the run options a backend receives.
 *
 * @param correlationId - identity of this attempt.
 * @param baseCwd - the host's base cwd; the task's own cwd travels on the spec.
 * @param options - host run options supplying the observer callbacks.
 * @param agent - the agent this attempt runs, for progress projection.
 * @param startedAt - attempt start, for progress projection.
 * @returns the contract-shaped run options.
 */
const PROGRESS_STATUSES: readonly AgentProgressStatus[] = [
  "pending", "running", "retrying", "completed", "failed", "terminated",
];

const PROGRESS_PHASES: readonly AgentRunPhase[] = [
  "waiting-dependency", "waiting-capacity", "starting", "restoring", "prompting",
  "tool-execution", "result-ready", "retrying", "compacting", "continuing", "settling",
];

/**
 * Read one number out of an untyped backend payload.
 *
 * @param value - the raw field.
 * @param fallback - used when the backend reported nothing usable.
 * @returns a finite non-negative number.
 */
function progressNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Read the recent-tool list out of an untyped backend payload.
 *
 * @param value - the raw field.
 * @returns the entries that carry both a name and a status.
 */
function progressTools(value: unknown): RecentToolInfo[] {
  if (!Array.isArray(value)) return [];
  const tools: RecentToolInfo[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, status, argsPreview, toolCallId, parentToolCallId } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof status !== "string") continue;
    tools.push({ name, status, ...(typeof argsPreview === "string" ? { argsPreview } : {}),
      ...(typeof toolCallId === "string" ? { toolCallId } : {}),
      ...(typeof parentToolCallId === "string" ? { parentToolCallId } : {}),
    });
  }
  return tools;
}

/**
 * Convert a backend's progress payload into the host's progress record.
 *
 * A backend reports whatever its runtime knows, so this is a real conversion
 * rather than a cast: the host supplies the identity and timing it owns, the
 * payload supplies what the runtime observed, and anything the backend cannot
 * report falls back to a value that reads as "not observed" instead of as a
 * measurement. Validation belongs here because the payload crosses a module
 * boundary untyped.
 *
 * @param data - the backend's payload.
 * @param agent - the agent this attempt runs, known to the host.
 * @param startedAt - attempt start, known to the host.
 * @returns the host-shaped progress record.
 *
 * @internal Exported for backend-seam regression tests.
 */
function projectBackendProgress(
  data: Record<string, unknown>,
  agent: string,
  startedAt: number,
): AgentProgress {
  const now = Date.now();
  const status = PROGRESS_STATUSES.find((candidate) => candidate === data.status) ?? "running";
  const phase = PROGRESS_PHASES.find((candidate) => candidate === data.phase);
  return {
    agent,
    status,
    recentTools: progressTools(data.recentTools),
    toolCount: progressNumber(data.toolCount, 0),
    tokens: progressNumber(data.tokens, 0),
    startedAt: progressNumber(data.startedAt, startedAt),
    durationMs: progressNumber(data.durationMs, now - startedAt),
    lastActivityAt: progressNumber(data.lastActivityAt, now),
    ...(typeof data.name === "string" ? { name: data.name } : {}),
    ...(typeof data.correlationId === "string" ? { correlationId: data.correlationId } : {}),
    ...(phase === undefined ? {} : { phase }),
    ...(typeof data.lastMessage === "string" ? { lastMessage: data.lastMessage } : {}),
    ...(typeof data.resolvedModel === "string" ? { resolvedModel: data.resolvedModel } : {}),
    ...(typeof data.requestedModel === "string" ? { requestedModel: data.requestedModel } : {}),
  };
}

function backendOptionsOf(
  correlationId: string,
  baseCwd: string,
  options: RunTeammateOptions,
  agent: string,
  startedAt: number,
  config: Record<string, ConfigValue>,
): BackendRunOptions {
  return {
    correlationId,
    baseCwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : {
      onProgress: (data: Record<string, unknown>): void => {
        options.onProgress?.(projectBackendProgress(data, agent, startedAt));
      },
    }),
    ...(options.onChildEvent === undefined ? {} : { onChildEvent: options.onChildEvent }),
    ...(options.onTurnComplete === undefined ? {} : { onTurnComplete: options.onTurnComplete }),
    // The broker registry is in-process and Promise-shaped: it lives on a
    // globalThis symbol the child cannot see, and a backend is only ever
    // dispatched from the root session, so this closure resolves against the
    // same registry `dispatchRegisteredChildTool` already awaits directly. The
    // callback-shaped relay this used to warn about is
    // `onChildRequest(event, reply)`, a different mechanism that no backend
    // reaches. An absent broker is a configuration failure, not a hang, so it
    // is reported by name rather than waited on.
    host: {
      resolveSshHost: resolveSshHostRef,
      async proxyToolCall(request: {
        toolName: string;
        args: unknown;
        correlationId: string;
      }): Promise<unknown> {
        const broker = getTeammateChildToolBroker(request.toolName);
        if (broker === undefined) {
          throw new Error(
            `no host tool broker is registered for "${request.toolName}"; the backend `
            + "declares a host-tool binding this root session cannot serve",
          );
        }
        return broker({
          toolName: request.toolName,
          input: request.args as Record<string, unknown>,
          // This attempt's own identity, taken from the parameters rather than
          // from anything the call carried: together with the endpoint's
          // per-run token binding, it is what makes a backend unable to act as
          // a teammate other than itself.
          actor: { correlationId, agent },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      },
    },
    config,
  };
}

class BackendCapabilityAdmissionError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(errors.join("\n"));
    this.name = "BackendCapabilityAdmissionError";
  }
}



/** Resolve and adjudicate once, then expose a one-shot start closure. */
async function prepareBackendAttemptOnce(
  registry: BackendRegistry,
  spec: TeammateRunSpec,
  requestedBackend?: string,
  preflight?: ResolvedBackend,
): Promise<PreparedBackendAttempt> {
  const { backend, config, capabilities } = preflight ?? await registry.resolve(spec, requestedBackend);
  const exactCapabilities = exactBackendCapabilities(capabilities);
  if (exactCapabilities === undefined) {
    throw new BackendCapabilityAdmissionError([
      `Teammate backend ${JSON.stringify(backend.name)} must expose exactly the nine valid BackendCapabilities entries`,
    ]);
  }
  const errors = validateBackendCapabilities(
    [{ spec, ...(spec.name === undefined ? {} : { name: spec.name }) }],
    () => ({ name: backend.name, capabilities: exactCapabilities }),
  ).errors;
  if (errors.length > 0) throw new BackendCapabilityAdmissionError(errors);
  let started = false;
  return {
    backendName: backend.name,
    config,
    capabilities: exactCapabilities,
    async start(startSpec, options) {
      if (started) throw new Error(`teammate backend ${JSON.stringify(backend.name)} attempt was already started`);
      started = true;
      return backend.start(startSpec, options);
    },
  };
}



function sourceModelRegistrationPlan(
  projection: ModelRegistryDispatchContext["authority"],
  requestedModel: string | undefined,
): ResolvedModelRegistrationRouting {
  if (requestedModel === undefined
    || projection.routesByRegistrationId.has(requestedModel)
    || projection.modelAliases.has(requestedModel)) {
    return resolveModelRegistrationRouting(projection, { model: requestedModel });
  }
  const selectorMatches: string[] = [];
  for (const [registrationId, route] of projection.routesByRegistrationId) {
    if (route.selector.kind === "adapter-model" && route.selector.value === requestedModel) {
      selectorMatches.push(registrationId);
    }
  }
  if (selectorMatches.length > 1) {
    throw new TypeError(
      `Fabric source model selector ${JSON.stringify(requestedModel)} is ambiguous across canonical registrations: `
      + selectorMatches.map((id) => JSON.stringify(id)).join(", "),
    );
  }
  return resolveModelRegistrationRouting(projection, {
    model: selectorMatches[0] ?? requestedModel,
  });
}

function assertFabricSourceLocalDeployment(
  deploymentId: string,
  runtime: ModelRuntimeDescriptor,
): void {
  if (!isFabricSourceLocalTransport(runtime)) {
    throw new Error(
      `Fabric source runtime refuses non-local deployment ${JSON.stringify(deploymentId)} `
      + `with transport ${JSON.stringify(runtime.transport.kind)}`,
    );
  }
}

const SOURCE_SPEC_KEYS = new Set([
  "agent", "task", "name", "context", "model", "thinking", "cwd", "outputSchema",
]);

function assertSourceAttemptInput(input: {
  placement: unknown;
  spec: TeammateRunSpec;
  correlationId: string;
  baseCwd: string;
  signal: AbortSignal;
}): string {
  // The source runtime must defend its public seam when invoked directly, not
  // rely only on the Flow bridge that normally constructs this request.
  if (!input.spec || typeof input.spec !== "object" || Array.isArray(input.spec)) {
    throw new TypeError("Fabric source attempt spec must be an object");
  }
  for (const key of Object.keys(input.spec)) {
    if (!SOURCE_SPEC_KEYS.has(key)) {
      throw new TypeError(`Fabric source attempt spec contains forbidden field ${JSON.stringify(key)}`);
    }
  }
  if (typeof input.spec.agent !== "string" || input.spec.agent.trim() === "") {
    throw new TypeError("Fabric source attempt spec.agent must be a non-empty string");
  }
  if (typeof input.spec.task !== "string" || input.spec.task.trim() === "") {
    throw new TypeError("Fabric source attempt spec.task must be a non-empty string");
  }
  assertFabricIdentifier(input.correlationId, "correlationId");
  if (typeof input.baseCwd !== "string" || !path.isAbsolute(input.baseCwd)) {
    throw new TypeError("Fabric source attempt baseCwd must be an absolute source-local path");
  }
  let trustedCwd: string;
  try {
    const stat = fs.statSync(input.baseCwd);
    if (!stat.isDirectory()) throw new Error("not a directory");
    trustedCwd = fs.realpathSync(input.baseCwd);
  } catch (cause) {
    throw new TypeError(`Fabric source attempt baseCwd is not an accessible directory: ${input.baseCwd}`, { cause });
  }
  if (typeof input.spec.cwd !== "string" || !path.isAbsolute(input.spec.cwd)) {
    throw new TypeError("Fabric source attempt spec.cwd must be the absolute source-local workspace path");
  }
  let requestedCwd: string;
  try {
    requestedCwd = fs.realpathSync(input.spec.cwd);
  } catch (cause) {
    throw new TypeError(`Fabric source attempt spec.cwd is not accessible: ${input.spec.cwd}`, { cause });
  }
  if (requestedCwd !== trustedCwd) {
    throw new TypeError("Fabric source attempt spec.cwd must equal the trusted source-local baseCwd");
  }
  if (!input.signal || typeof input.signal.aborted !== "boolean"
    || typeof input.signal.addEventListener !== "function") {
    throw new TypeError("Fabric source attempt signal must be an AbortSignal");
  }
  return trustedCwd;
}

/**
 * Start one source-local backend attempt for the public Fabric runtime port.
 * This path deliberately omits orchestration, fallback, publication and any
 * remote/Fabric backend wiring.
 *
 * @internal Public consumers use createFabricTeammateRuntimePort().
 */
async function startFabricSourceBackendAttempt(
  input: {
    placement: import("pi-maestro-fabric-core/v1/placement").TeammatePlacementV1;
    spec: TeammateRunSpec;
    correlationId: string;
    baseCwd: string;
    signal: AbortSignal;
    onChildEvent?: (event: Record<string, unknown>) => void;
    onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
  },
  runtimeOptions: FabricSourceRuntimeOptions = {},
): Promise<{
  acceptedBackend: string;
  acceptedModel?: string;
  acceptedCapabilities: BackendCapabilities;
  outcome: Promise<AttemptOutcome>;
  send: BackendRun["send"];
  abort: BackendRun["abort"];
}> {
  const cwd = assertSourceAttemptInput(input);
  assertValidTeammatePlacement(input.placement);
  if (input.signal.aborted) throw new Error("Fabric source attempt was aborted before launch");

  let acceptedModel = input.spec.model;
  const canonicalResult = (result: SingleResult): SingleResult => acceptedModel === undefined
    ? result
    : { ...result, model: acceptedModel };
  const hostOptions: RunTeammateOptions = {
    baseCwd: cwd,
    signal: input.signal,
    ...(input.onChildEvent === undefined ? {} : { onChildEvent: input.onChildEvent }),
    ...(input.onTurnComplete === undefined ? {} : {
      onTurnComplete: (result, terminalStatus) => input.onTurnComplete!(canonicalResult(result), terminalStatus),
    }),
  };
  const extrasOf = () => ({ hostOptions, cwd, replyTo: "caller" as const });
  let registry = runtimeOptions.backendRegistry;
  let requestedBackend: string | undefined;
  let selectedModule: string | undefined;
  let localSpec: TeammateRunSpec = { ...input.spec, cwd };

  if (registry === undefined) {
    const config = backendRegistryConfigSync(cwd);
    if (config.mode === "model-registry") {
      const pair = modelRegistryPairSync(cwd);
      if (pair === undefined) throw new Error("Fabric source model registry has no live dispatch projection");
      const plan = sourceModelRegistrationPlan(pair.dispatch, input.spec.model);
      const candidate = plan.candidates[0];
      if (candidate === undefined || plan.candidates.length !== 1) {
        throw new Error("Fabric source runtime must resolve exactly one local model registration");
      }
      assertFabricSourceLocalDeployment(
        candidate.route.deploymentId,
        candidate.deployment.runtime,
      );
      requestedBackend = candidate.route.deploymentId;
      selectedModule = candidate.deployment.registration.module;
      acceptedModel = candidate.modelRegistrationId;
      const selector = candidate.route.selector;
      localSpec = {
        ...localSpec,
        backend: requestedBackend,
        ...(selector.kind === "adapter-model" ? { model: selector.value } : { model: undefined }),
      };
      registry = dispatchRegistryForProjectionSync(pair.dispatch, extrasOf);
    } else {
      requestedBackend = config.default;
      const selectedRegistration = config.backends[requestedBackend];
      selectedModule = selectedRegistration?.module;
      if (selectedRegistration !== undefined) {
        assertFabricSourceLocalDeployment(
          requestedBackend,
          deriveModelRuntimeDescriptor(requestedBackend, selectedRegistration),
        );
      }
      localSpec = { ...localSpec, backend: requestedBackend };
      registry = dispatchSourceAttemptRegistrySync(cwd, extrasOf);
    }
  }

  if (selectedModule === FABRIC_BACKEND || selectedModule === REMOTE_WORKERS) {
    throw new Error(`Fabric source runtime refuses recursive backend module ${JSON.stringify(selectedModule)}`);
  }
  const prepared = await prepareBackendAttemptOnce(registry, localSpec, requestedBackend);
  if (prepared.backendName === FABRIC_BACKEND || prepared.backendName === REMOTE_WORKERS) {
    throw new Error(`Fabric source runtime refuses recursive backend ${JSON.stringify(prepared.backendName)}`);
  }
  if (input.signal.aborted) {
    throw new Error("Fabric source attempt was aborted while preparing its local backend");
  }
  assertFabricIdentifier(prepared.backendName, "acceptedBackend");
  const backendOptions = backendOptionsOf(
    input.correlationId,
    cwd,
    hostOptions,
    input.spec.agent,
    Date.now(),
    prepared.config,
  );
  const run = await prepared.start(localSpec, backendOptions);
  const outcome = acceptedModel !== undefined && localSpec.model !== acceptedModel
    ? run.outcome.then((settled) => ({ ...settled, result: canonicalResult(settled.result) }))
    : run.outcome;
  const abortRun = (): void => { run.abort(); };
  input.signal.addEventListener("abort", abortRun, { once: true });
  if (input.signal.aborted) abortRun();
  void outcome.then(
    () => input.signal.removeEventListener("abort", abortRun),
    () => input.signal.removeEventListener("abort", abortRun),
  );
  return {
    acceptedBackend: prepared.backendName,
    ...(acceptedModel === undefined ? {} : { acceptedModel }),
    acceptedCapabilities: prepared.capabilities,
    outcome,
    send: run.send.bind(run),
    abort: run.abort.bind(run),
  };
}


 return { providerOf,
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
  startFabricSourceBackendAttempt };
}
export type DispatchContext = ReturnType<typeof createDispatchContext>;

export function createDispatchOwner(ports:ExecutionPorts) {
 const context=createDispatchContext(ports);
 const retry=createRetryOwner({...ports,...context});
 const graph=createGraphOwner({...ports,...context,...retry});
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
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate } = ports;
 const assertFabricIdentifier: ExecutionPorts["assertFabricIdentifier"] = ports.assertFabricIdentifier;
 const assertValidTeammatePlacement: ExecutionPorts["assertValidTeammatePlacement"] = ports.assertValidTeammatePlacement;

 const {captureModelRegistryAuthority}=context;
 const {runGraph}=graph;
/** Programmatic tasks-only entry point matching the public teammate schema. */
async function runTeammate(
  params: RunTeammateParams,
  options: RunTeammateOptions,
): Promise<SingleResult[]> {
  const prepared = prepareTeammateMode(params);
  const routed = applyModelRouting(
    prepared,
    options.baseCwd,
    options.modelCapabilities,
    options.modelRoutingFilePath,
    options.inheritModel,
    undefined,
    options.modelRegistryDispatch?.authority ?? captureModelRegistryAuthority(options),
  );
  // Per-role circuit policies take effect at dispatch time: the breaker used
  // by the candidate sweep adopts the configured threshold/cooldown for each
  // role's mapped model before any acquisition happens.
  syncModelCircuitPolicies(options.modelCircuitBreaker ?? sharedModelCircuitBreaker, options.baseCwd,
    options.modelRoutingFilePath ?? getGlobalModelRoutingPath());
  const normalized = normalizeTeammateParams(routed);
  if (normalized.error) throw new Error(normalized.error);
  return runGraph(normalized.tasks, prepared.concurrency ?? 4, options);
}

// ---------------------------------------------------------------------------
// RPC: Send message to running agent via stdin
// ---------------------------------------------------------------------------





 return {runTeammate,...retry,...graph,hostRegistryResultProvenance:context.hostRegistryResultProvenance,projectBackendProgress:context.projectBackendProgress,startFabricSourceBackendAttempt:context.startFabricSourceBackendAttempt};
}
