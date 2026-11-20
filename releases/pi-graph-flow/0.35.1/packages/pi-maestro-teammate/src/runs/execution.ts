import { createNativeCurrentView } from "../run-executor/native-current-view.ts";
import { captureTodoSourceScope, withTodoSourceScope } from "./todo-source-context.ts";
import { prepareTaskDispatch, waitTaskDispatchReadiness, assertTaskDispatch, watchTaskDispatchCancellation, joinTaskDispatchObservation, type PreparedTaskDispatch } from "../public/v1/task-dispatch-binding.ts";
import { bindNativeResult, type NativeExecutionSnapshot } from "../run-executor/native-observation.ts";
import { providerFallbackAllowed } from "pi-graph-model-role";
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
import { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { Check, Errors } from "typebox/value";
import crossSpawn from "cross-spawn";
import {
  discoverAgents,
  formatAgentShadowWarning,
  listAgentSummaries,
  resolveAgent,
  type AgentConfig,
} from "../agents/agents.ts";
import { resolveReplyTo, type ReplyTarget } from "../shared/routing.ts";
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
import {
  AGENT_TURN_VERSION,
  normalizeMessageProvenanceV1,
} from "../shared/types.ts";
import { wrapLeasedMessage, type LeaseToken } from "./session-handoff.ts";
import {
  applyModelRouting,
  getGlobalModelRoutingPath,
  freezeRoleModelSelection,
  verifyRoleModelSelection,
  canHotSwitchModelRegistration,
  resolveModelRegistrationRouting,
  syncModelCircuitPolicies,
  type ResolvedModelRegistrationCandidate,
  type ResolvedModelRegistrationRouting,
  type TeammateTaskType,
} from "../models/model-routing.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import {
  deriveModelRuntimeDescriptor,
  exactBackendCapabilities,
  isFabricSourceLocalTransport,
  type ModelRuntimeDescriptor,
} from "../models/model-registry.ts";
import {
  sharedModelCircuitBreaker,
  sharedModelHealthCoordinator,
  type AcquiredModelCandidate,
  type AcquiredModelHealthCandidate,
  type ModelCircuitBreaker,
  type ModelHealthCoordinator,
} from "../models/model-circuit-breaker.ts";
import { getTeammateChildExtensions, getTeammateChildToolBroker } from "./child-extensions.ts";
import {
  parseTeammateThinkingLevel,
  type TeammateThinkingInput,
  type TeammateThinkingLevel,
} from "../shared/thinking.ts";
import {
  classifyModelHealthFailure,
  classifyRetryError,
  classifyRetryInput,
  extractRetryAfterMs,
  isFallbackProviderError,
  ModelHealthAttemptState,
  retryDelayMs,
} from "./retry.ts";
import {
  MODEL_FALLBACK_RESUME_PROMPT,
  TeammatePublicationCaptureError,
} from "./execution-infra.ts";
import {
  buildReplayFence,
  hasExternalReplayRisk,
  type RecoveryFailureChainV1,
  type RecoveryFailureRecordV1,
} from "./recovery-protocol.ts";
import { cliToolNameFromModel, isCliToolModel } from "../cli-tools/local-acp.ts";
import { resolveSshHostRef } from "../public/v1/ssh-hosts.ts";

export * from "./execution-infra.ts";
import {
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
} from "./execution-infra.ts";
import { runtimeBrokerModeFromEnv } from "../runtime-broker/rollout.ts";
import { AgentRunRuntimeActor } from "./runtime-actor.ts";
import { assembleTaskPrompt } from "./briefing.ts";
import {
  appendTodoPromptContext,
  resolveTodoPromptContext,
  type ResolvedTodoPromptContext,
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
} from "./execution-infra.ts";


// The Pi subprocess backend implementation. Orchestration here decides *which*
// model runs; the module below decides how a Pi child runs it. Its previously
// public surface is re-exported unchanged so no consumer import path moves.
import { adjudicateTask, validateBackendCapabilities } from "pi-maestro-backends";
import { outcomeOf } from "../backends/pi-subprocess.ts";
import { closeBackendControlStdin, createBackendControlStdin } from "../backends/control-shim.ts";
import {
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
import { isNativeDurabilityFailure, runSingleAttempt } from "./pi-subprocess-attempt.ts";
import { assertVirtualChildExtensionRegistered } from "./native-child.ts";
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
import { assertFabricIdentifier } from "pi-maestro-fabric-core/v1/common";
import { assertValidTeammatePlacement } from "pi-maestro-fabric-core/v1/validation";

export {
  TOOL_EXECUTION_HEARTBEAT_MS,
  resolveAgentCacheRetention,
  hasRpcTurnSidecar,
  sendRpcMessage,
  sendRpcMessageWithReceipt,
  sendChildIpcMessage,
  dispatchChildIpcMessage,
} from "./pi-subprocess-attempt.ts";
export type { RpcMessageMode, RpcInputDisposition, RpcReceipt } from "./pi-subprocess-attempt.ts";

import {createDispatchOwner} from "../run-executor/dispatch-owner.ts";
// One owner per original module instance; imported effects retain their original authorities.
const owner=createDispatchOwner({createNativeCurrentView,
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
  clearImmediate});
export const {runSingleTeammate,runGraph,runTeammate,normalizeGraphConcurrency,hostRegistryResultProvenance,projectBackendProgress,startFabricSourceBackendAttempt}=owner;
