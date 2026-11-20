import type { isUtf8 } from "node:buffer";
import type { preserveStructuredOutputFailure } from "./structured-output-failure-evidence.ts";
import type { parseDeclaredJsonResult } from "pi-graph-verification";
import type { createChildTodoParentContext, readChildTodoParentContext, ChildTodoParentContext } from "../runs/child-parent-context.ts";
import type { assertTaskDispatch } from "../public/v1/task-dispatch-binding.ts";
import type { createNativeObservation } from "./native-observation.ts";
import type {

  spawn,
  ChildProcess,
} from "node:child_process";
import type { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";
import type { nextTeammateHostSequence, publishTeammateHostBoundary } from "../runs/host-observers.ts";
import type {
  randomUUID,
  createHash,
} from "node:crypto";
import type * as fs from "node:fs";
import type * as path from "node:path";
import type {
  Writable,
} from "node:stream";
import type {
  StringDecoder,
} from "node:string_decoder";
import type crossSpawn from "cross-spawn";
import type { beginNativeTaskRecovery, beforeNativeTaskWrite, consumeNativeTaskWrite, markNativeTaskWriteUnknown, markNativeTaskCleanup, observeNativeTaskRecovery } from "../public/v1/task-dispatch-binding.ts";
import type { getPiHostMode } from "pi-maestro-settings-core/v1";
import type { assertVirtualChildRouter, nativeChildBuiltinArgs, probePiChildVersion } from "../runs/native-child.ts";
import type {
  AgentConfig,
} from "../agents/agents.ts";
import type {
  ReplyTarget,
} from "../shared/routing.ts";
import type {
  previewToolCallArgs,
} from "../runs/shared/tool-preview.ts";
import type {
  SingleResult,
  AgentTerminalStatus,
  AgentTurnEvent,
  AgentTurnMessageMetadataV1,
  AgentTurnTriggerContextV1,
  MessageProvenanceV1,
} from "../shared/types.ts";
import type {
  AGENT_TURN_VERSION,
  normalizeMessageProvenanceV1,
} from "../shared/types.ts";
import type {
  wrapLeasedMessage,
  LeaseToken,
} from "../runs/session-handoff.ts";
import type { classifyRetryError, classifyRetryErrorDetailed } from "../runs/retry.ts";
import type {
  RECOVERY_WAKE_RECEIPT_VERSION,
  ReplayEvidenceCollector,
  hasExternalReplayRisk,
  RecoveryFailureChainV1,
  RecoveryFailureRecordV1,
  RecoveryWakeReceiptV1,
} from "../runs/recovery-protocol.ts";
import type {
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
} from "../runs/execution-infra.ts";
import type {
  JsonLineEvent,
  RunSingleTeammateParams,
  RunTeammateOptions,
  StructuredOutputCandidate,
} from "../runs/execution-infra.ts";
import type {AttemptPorts} from "./lifecycle-contracts.ts";
export interface TransportSidecarLease {
  commit(): void;
  cancel(): void;
}
export interface TransportSidecar {
  enqueue(
    transportMessage: string,
    acceptedMessage: string,
    mode: "prompt" | "steer" | "follow_up",
    provenance?: MessageProvenanceV1,
    requestId?: string,
  ): TransportSidecarLease;
}
export type RpcMessageMode = "prompt" | "steer" | "follow_up" | "abort" | "interrupt";
export type RpcInputDisposition = "handled" | "queued" | "started" | "legacy-accepted" | "transport-written" | "interrupt-requested";
export type RpcReceipt = { accepted: boolean; disposition?: RpcInputDisposition; error?: string };
export type InterruptHandler = (
  message: string,
  token?: LeaseToken,
  provenance?: MessageProvenanceV1,
) => boolean;
export function createControlOwner(ports:AttemptPorts) {
 const { isUtf8,
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
  clearImmediate } = ports;


// `interrupt` is the soft-interrupt transaction (abort + prompt). `steer` is
// the native Pi steer queue (no interruption, injected at the turn boundary).
// The handler below owns the interrupt path only.






const guardedChildStdinStreams = new WeakSet<Writable>();
const nativeWriteGates = new WeakMap<Writable,{handle:object|undefined;control:()=>void;failed?:(error:unknown)=>void}>();
const nativeWriteFailures = new WeakMap<Writable,Error>();
const interruptHandlers = new WeakMap<Writable, InterruptHandler>();
const transportSidecars = new WeakMap<Writable, TransportSidecar>();
const nativeRpcStreams = new WeakSet<Writable>();


const rpcResponses = new WeakMap<Writable, Map<string, { command: string; finish: (receipt: RpcReceipt) => void }>>();

function acceptRpcResponse(stdin: Writable, event: JsonLineEvent): void {
  if (typeof event.id !== "string") return;
  const pending = rpcResponses.get(stdin)?.get(event.id);
  if (!pending || pending.command !== event.command) return;
  const disposition = (event.data as Record<string, unknown> | undefined)?.disposition;
  if (event.success !== true) pending.finish({ accepted: false, error: String(event.error ?? "Pi rejected input") });
  else if (disposition === undefined) pending.finish({ accepted: true, disposition: "legacy-accepted" });
  else if (disposition === "handled" || disposition === "queued" || disposition === "started") pending.finish({ accepted: true, disposition });
  else pending.finish({ accepted: false, error: "Invalid Pi input disposition" });
}

function rejectRpcResponses(stdin: Writable): void {
  for (const pending of rpcResponses.get(stdin)?.values() ?? []) pending.finish({ accepted: false, error: "Pi transport closed before input acceptance" });
  rpcResponses.delete(stdin);
  nativeRpcStreams.delete(stdin);
}

/** Model-input acceptance is independent of its eventual AgentSession settlement. */
async function sendRpcMessageWithReceipt(stdin: Writable, message: string, mode: RpcMessageMode = "follow_up", token?: LeaseToken, provenance?: MessageProvenanceV1): Promise<RpcReceipt> {
  if (!nativeRpcStreams.has(stdin) || mode === "interrupt" || mode === "abort") {
    return { accepted: sendRpcMessage(stdin, message, mode, token, provenance), disposition: mode === "interrupt" ? "interrupt-requested" : "transport-written" };
  }
  const pending = rpcResponses.get(stdin) ?? new Map();
  rpcResponses.set(stdin, pending);
  if (pending.size >= 64) return { accepted: false, error: "Pi pending input response limit reached" };
  const id = `teammate-input-${randomUUID()}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ accepted: false, error: "Pi input acceptance timed out" }), 10_000);
    timer.unref?.();
    const finish = (receipt: RpcReceipt): void => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      resolve(receipt);
    };
    pending.set(id, { command: mode, finish });
    if (!sendRpcMessage(stdin, message, mode, token, provenance, id)) finish({ accepted: false, error: "Pi input write failed" });
  });
}

function guardChildStdin(stdin: Writable): void {
  if (guardedChildStdinStreams.has(stdin)) return;
  guardedChildStdinStreams.add(stdin);
  // Child termination is reported by the process lifecycle. Stdin delivery is
  // best-effort, so a concurrent pipe close must not crash the parent process.
  stdin.on("error", () => {});
}

function writeChildStdinLine(stdin: Writable, line: string): boolean {
  guardChildStdin(stdin);
  if (!stdin.writable || stdin.writableEnded || stdin.destroyed) return false;
  let attempted=false;
  const recovery=nativeWriteGates.get(stdin);
  try {
    const command=JSON.parse(line) as {type?:unknown;id?:unknown};
    // Only read-only metadata commands avoid the execution fence. Unknown commands fail conservatively.
    const metadata=typeof command.type==="string" && ["get_state","get_messages","get_models","get_commands","get_session_stats"].includes(command.type);
    if(recovery&&!metadata){
      if(!["prompt","steer","follow_up"].includes(String(command.type)))recovery.control();
      const input={command:String(command.type),payloadDigest:createHash("sha256").update(line).digest("hex"),...(typeof command.id==="string"?{wireRequestId:command.id}:{})};
      const permit=beforeNativeTaskWrite(recovery.handle,input);consumeNativeTaskWrite(recovery.handle,permit,input.payloadDigest);
    }
    attempted=true;
    stdin.write(`${line}\n`);
    return true;
  } catch (error) {
    if(attempted)markNativeTaskWriteUnknown(recovery?.handle);
    if(recovery?.handle){const failure=error instanceof Error?error:new Error(String(error));nativeWriteFailures.set(stdin,failure);try{recovery.failed?.(failure);}catch{/* public sender retains boolean; the attempt owns shutdown */}}
    return false;
  }
}

function writeTransportModelInput(
  stdin: Writable,
  envelope: Record<string, unknown>,
  transportMessage: string,
  acceptedMessage: string,
  mode: "prompt" | "steer" | "follow_up",
  provenance?: MessageProvenanceV1,
): boolean {
  const requestId = typeof envelope.id === "string" ? envelope.id : randomUUID();
  if (nativeRpcStreams.has(stdin) || typeof envelope.id === "string") envelope = { ...envelope, id: requestId };
  const lease = transportSidecars.get(stdin)?.enqueue(
    transportMessage,
    acceptedMessage,
    mode,
    provenance,
    requestId,
  );
  const sent = writeChildStdinLine(stdin, JSON.stringify(envelope));
  if (sent) lease?.commit();
  else lease?.cancel();
  return sent;
}

function hasRpcTurnSidecar(stdin: Writable): boolean {
  return transportSidecars.has(stdin);
}

function sendRpcMessage(
  stdin: Writable,
  message: string,
  mode: RpcMessageMode = "follow_up",
  token?: LeaseToken,
  provenance?: MessageProvenanceV1,
  requestId?: string,
): boolean {
  if (mode === "abort") {
    return writeChildStdinLine(stdin, JSON.stringify({ type: "abort" }));
  }
  const leasedMessage = wrapLeasedMessage(message, token);
  if (mode === "prompt") {
    return writeTransportModelInput(
      stdin,
      { id: requestId, type: "prompt", message: leasedMessage },
      leasedMessage,
      message,
      "prompt",
      provenance,
    );
  }
  // `steer` is the native Pi steer queue: it is never an interruption. It is
  // pushed onto Pi's steerQueue and injected at the turn boundary, so multiple
  // steers can be queued (and, with steeringMode "all", co-injected in one
  // assistant turn). It does not touch the interrupt transaction state.
  if (mode === "steer") {
    return writeTransportModelInput(
      stdin,
      { id: requestId, type: "steer", message: leasedMessage },
      leasedMessage,
      message,
      "steer",
      provenance,
    );
  }
  // `interrupt` is the soft-interrupt transaction: abort the active turn, then
  // inject the message as the replacement prompt. It is a single in-flight
  // transaction per subprocess; a second interrupt while one is pending is
  // rejected (returns false) so the caller can fall back to steer/follow_up.
  if (mode === "interrupt") {
    const interrupt = interruptHandlers.get(stdin);
    if (interrupt) return interrupt(message, token, provenance);
    // No registered handler (e.g. child stdin not wired): degrade to a native
    // steer so the message is still queued rather than dropped.
    return writeTransportModelInput(
      stdin,
      { type: "steer", message: leasedMessage },
      leasedMessage,
      message,
      "steer",
      provenance,
    );
  }
  return writeTransportModelInput(
    stdin,
    { id: requestId, type: mode, message: leasedMessage },
    leasedMessage,
    message,
    mode,
    provenance,
  );
}

function sendChildIpcMessage(
  child: ChildProcess,
  message: Record<string, unknown>,
): boolean {
  if (!child.connected) return false;
  try {
    child.send(message as never, (error) => {
      if (!error) return;
      logDiagnosticError(
        `[pi-maestro-teammate] child IPC send failed asynchronously (type=${(message as { type?: string }).type ?? "unknown"})`,
        error,
      );
      try {
        if (child.connected) child.disconnect();
      } catch {
        // Process lifecycle remains the final settlement signal.
      }
    });
    // false means backpressure, not rejection; callback confirms delivery.
    return true;
  } catch {
    try {
      if (child.connected) child.disconnect();
    } catch {
      // Best effort.
    }
    return false;
  }
}

function dispatchChildIpcMessage(
  message: Record<string, unknown>,
  onRequest: RunTeammateOptions["onChildRequest"],
  onEvent: RunTeammateOptions["onChildEvent"],
  reply: (message: unknown) => void,
): "request" | "event" {
  const requestType = message.type === "teammate_proxy_request"
    || message.type === "teammate_interaction_request"
    || message.type === "teammate_rpc_ui_request";
  if (requestType || message.type === "teammate_proxy_cancel") {
    let replyAttempted = false;
    const respond = (response: unknown): void => {
      replyAttempted = true;
      reply(response);
    };
    try {
      if (onRequest) {
        onRequest(message, respond);
      } else {
        onEvent?.(message);
        if (requestType) replyFailedChildRequest(message, respond);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      let replyError: string | undefined;
      // A callback can fail before entering its own request handler. Settle
      // that request, but never synthesize a second reply or answer a cancel.
      if (requestType && !replyAttempted) {
        try {
          replyFailedChildRequest(message, respond, `Parent child-request dispatch failed: ${reason}`);
        } catch (failure) {
          replyError = failure instanceof Error ? failure.message : String(failure);
        }
      }
      try {
        onEvent?.({
          type: "teammate_reply_delivery_failed",
          requestId: message.requestId ?? message.id,
          error: reason,
          ...(replyError === undefined ? {} : { replyError }),
        });
      } catch (observerError) {
        logDiagnosticError("[pi-maestro-teammate] child request failure observer failed", observerError);
      }
    }
    return "request";
  }
  onEvent?.(message);
  return "event";
}

function replyFailedChildRequest(
  message: Record<string, unknown>,
  reply: (message: unknown) => void,
  reason = "No parent child-request handler is available.",
): void {
  if (message.type === "teammate_rpc_ui_request") {
    reply({
      type: "extension_ui_response",
      id: typeof message.id === "string" ? message.id : randomUUID(),
      cancelled: true,
    });
    return;
  }
  const requestId = typeof message.requestId === "string" ? message.requestId : randomUUID();
  if (message.type === "teammate_interaction_request") {
    const permission = message.interaction === "permission";
    reply({
      type: "teammate_interaction_response",
      requestId,
      result: permission
        ? { action: "deny", reason }
        : { action: "cancel", reason },
    });
    return;
  }
  reply({
    type: "teammate_proxy_result",
    requestId,
    result: {
      content: [{ type: "text", text: reason }],
      isError: true,
      details: {},
    },
  });
}

 return { guardedChildStdinStreams,
  nativeWriteGates,
  nativeWriteFailures,
  interruptHandlers,
  transportSidecars,
  nativeRpcStreams,
  rpcResponses,
  acceptRpcResponse,
  rejectRpcResponses,
  sendRpcMessageWithReceipt,
  guardChildStdin,
  writeChildStdinLine,
  writeTransportModelInput,
  hasRpcTurnSidecar,
  sendRpcMessage,
  sendChildIpcMessage,
  dispatchChildIpcMessage,
  replyFailedChildRequest };
}
