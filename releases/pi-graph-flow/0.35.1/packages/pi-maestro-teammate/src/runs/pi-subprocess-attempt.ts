import { isUtf8 } from "node:buffer";
import { preserveStructuredOutputFailure } from "../run-executor/structured-output-failure-evidence.ts";
import { parseDeclaredJsonResult } from "pi-graph-verification";
import { createChildTodoParentContext, readChildTodoParentContext, type ChildTodoParentContext } from "./child-parent-context.ts";
import { assertTaskDispatch } from "../public/v1/task-dispatch-binding.ts";
import { createNativeObservation } from "../run-executor/native-observation.ts";
/**
 * The Pi subprocess attempt: everything needed to run one teammate turn in a
 * child Pi runtime, from spawn through settlement and child-process reclamation.
 *
 * Split out of `execution.ts` so orchestration and backend implementation stop
 * sharing a file. `execution.ts` keeps the model-candidate sweep, circuit
 * breaker, replay fence, and completion publication — decisions about *which*
 * model runs. This module owns what one specific runtime does with an
 * already-chosen model.
 *
 * The recovery WeakMaps are written here and read only by this package's Pi
 * backend adapter, which turns them into the contract's `AttemptOutcome`. They
 * are deliberately absent from the package's public surface: outside this pair
 * of modules, recovery facts travel as a value on the outcome rather than as a
 * side channel a caller can forget to consult.
 */

import {

  spawn,
  type ChildProcess,
} from "node:child_process";
import { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";
import { nextTeammateHostSequence, publishTeammateHostBoundary } from "./host-observers.ts";
import {
  randomUUID,
  createHash,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Writable,
} from "node:stream";
import {
  StringDecoder,
} from "node:string_decoder";
import crossSpawn from "cross-spawn";
import { beginNativeTaskRecovery, beforeNativeTaskWrite, consumeNativeTaskWrite, markNativeTaskWriteUnknown, markNativeTaskCleanup, observeNativeTaskRecovery } from "../public/v1/task-dispatch-binding.ts";
import { getPiHostMode } from "pi-maestro-settings-core/v1";
import { assertVirtualChildRouter, nativeChildBuiltinArgs, probePiChildVersion } from "./native-child.ts";
import {
  type AgentConfig,
} from "../agents/agents.ts";
import {
  type ReplyTarget,
} from "../shared/routing.ts";
import {
  previewToolCallArgs,
} from "./shared/tool-preview.ts";
import type {
  SingleResult,
  AgentTerminalStatus,
  AgentTurnEvent,
  AgentTurnMessageMetadataV1,
  AgentTurnTriggerContextV1,
  MessageProvenanceV1,
} from "../shared/types.ts";
import {
  AGENT_TURN_VERSION,
  normalizeMessageProvenanceV1,
} from "../shared/types.ts";
import {
  wrapLeasedMessage,
  type LeaseToken,
} from "./session-handoff.ts";
import { classifyRetryError, classifyRetryErrorDetailed } from "./retry.ts";
import {
  RECOVERY_WAKE_RECEIPT_VERSION,
  ReplayEvidenceCollector,
  hasExternalReplayRisk,
  type RecoveryFailureChainV1,
  type RecoveryFailureRecordV1,
  type RecoveryWakeReceiptV1,
} from "./recovery-protocol.ts";
import {
  EXECUTION_BUFFER_LIMITS,
  FIRST_ACTIVITY_TIMEOUT_MS,
  MODEL_FALLBACK_RESUME_PROMPT,
  OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS,
  resultReadyGraceMsFor,
  STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
  addUsageSnapshot,
  appendBoundedTranscriptMessage,
  appendDistinctAssistantMessage,
  appendUtf8Tail,
  bindChildTerminationSignal,
  buildPiArgs,
  cleanupFile,
  correlationSessionDirectoryName,
  createChildTerminationController,
  createProgress,
  createUtf8LineDecoder,
  describeStructuredOutputValidationFailure,
  emptyUsage,
  ensurePrivateDirectory,
  extractPiEventError,
  extractStructuredOutputCandidate,
  extractTextContent,
  formatPiLaunchDiagnostic,
  getPiSpawnCommand,
  getTeammateDepth,
  getTeammateSessionRoot,
  isPiResultReadyTurn,
  piLaunchDiagnostic,
  releasePublishedTurnHistory,
  resetUsage,
  setUsageSnapshot,
  truncateUtf8Head,
  truncateUtf8Tail,
  writeSchemaFile,
  writeSystemPromptFile,
} from "./execution-infra.ts";
import type {
  JsonLineEvent,
  RunSingleTeammateParams,
  RunTeammateOptions,
  StructuredOutputCandidate,
} from "./execution-infra.ts";

import {createAttemptOwner} from "../run-executor/attempt-owner.ts";
export type {AttemptSettlementCapability} from "../run-executor/attempt-owner.ts";
export type {RpcMessageMode,RpcInputDisposition,RpcReceipt} from "../run-executor/control-owner.ts";
const owner=createAttemptOwner({isUtf8,
  preserveStructuredOutputFailure,
  parseDeclaredJsonResult,
  createChildTodoParentContext,
  readChildTodoParentContext,
  assertTaskDispatch,
  createNativeObservation,
  spawn,
  logDiagnosticError,
  logDiagnosticWarn,
  nextTeammateHostSequence,
  publishTeammateHostBoundary,
  randomUUID,
  createHash,
  fs,
  path,
  StringDecoder,
  crossSpawn,
  beginNativeTaskRecovery,
  beforeNativeTaskWrite,
  consumeNativeTaskWrite,
  markNativeTaskWriteUnknown,
  markNativeTaskCleanup,
  observeNativeTaskRecovery,
  getPiHostMode,
  assertVirtualChildRouter,
  nativeChildBuiltinArgs,
  probePiChildVersion,
  previewToolCallArgs,
  AGENT_TURN_VERSION,
  normalizeMessageProvenanceV1,
  wrapLeasedMessage,
  classifyRetryError,
  classifyRetryErrorDetailed,
  RECOVERY_WAKE_RECEIPT_VERSION,
  ReplayEvidenceCollector,
  hasExternalReplayRisk,
  EXECUTION_BUFFER_LIMITS,
  FIRST_ACTIVITY_TIMEOUT_MS,
  MODEL_FALLBACK_RESUME_PROMPT,
  OUTPUT_LIMIT_RECOVERY_TIMEOUT_MS,
  resultReadyGraceMsFor,
  STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
  addUsageSnapshot,
  appendBoundedTranscriptMessage,
  appendDistinctAssistantMessage,
  appendUtf8Tail,
  bindChildTerminationSignal,
  buildPiArgs,
  cleanupFile,
  correlationSessionDirectoryName,
  createChildTerminationController,
  createProgress,
  createUtf8LineDecoder,
  describeStructuredOutputValidationFailure,
  emptyUsage,
  ensurePrivateDirectory,
  extractPiEventError,
  extractStructuredOutputCandidate,
  extractTextContent,
  formatPiLaunchDiagnostic,
  getPiSpawnCommand,
  getTeammateDepth,
  getTeammateSessionRoot,
  isPiResultReadyTurn,
  piLaunchDiagnostic,
  releasePublishedTurnHistory,
  resetUsage,
  setUsageSnapshot,
  truncateUtf8Head,
  truncateUtf8Tail,
  writeSchemaFile,
  writeSystemPromptFile,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate}, {stdoutProjectionImport:`--import=${new URL("./rpc-stdout-projection.mjs", import.meta.url).href}`});
export const { attemptReclamations,
  attemptRecoveryFacts,
  TOOL_EXECUTION_HEARTBEAT_MS,
  resolveAgentCacheRetention,
  runSingleAttempt,
  isNativeDurabilityFailure,
  sendRpcMessageWithReceipt,
  hasRpcTurnSidecar,
  sendRpcMessage,
  sendChildIpcMessage,
  dispatchChildIpcMessage } = owner;
