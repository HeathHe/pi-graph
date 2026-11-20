import type { TodoSourceScope } from "../runs/todo-source-context.ts";
import type { ChildTodoParentContext } from "../runs/child-parent-context.ts";
import type { NativeCurrentReadCapability } from "./native-current-view.ts";
import type { TaskDispatchHost, PreparedTaskDispatch, TaskDispatchObservation } from "../public/v1/task-dispatch-binding.ts";
import type { NativeExecutionSnapshot } from "./native-observation.ts";
import type { SelectionDecision } from "pi-graph-model-role";
import type { spawn, ChildProcess } from "node:child_process";
import type { createHash, randomUUID } from "node:crypto";
import type * as fs from "node:fs";
import type * as os from "node:os";
import type * as path from "node:path";
import type { Writable } from "node:stream";
import type { StringDecoder } from "node:string_decoder";
import type { fileURLToPath } from "node:url";
import type { describeStructuredOutputValueValidationFailure as describeDeclaredValueFailure, parseDeclaredJsonResult } from "pi-graph-verification";
import type crossSpawn from "cross-spawn";
import type { listAgentSummaries, resolveAgent, AgentConfig } from "../agents/agents.ts";
import type { resolvePiAgentDirectory } from "../shared/agent-directory.ts";
import type { resolveReplyTo, ReplyTarget } from "../shared/routing.ts";
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
import type { wrapLeasedMessage, LeaseToken } from "../runs/session-handoff.ts";
import type {
  applyModelRouting,
  ResolvedModelRegistrationRouting,
  TeammateTaskType,
} from "../models/model-routing.ts";
import type { DispatchAuthorityProjection } from "../models/model-registry.ts";
import type { ModelHealthCoordinator } from "../models/model-circuit-breaker.ts";
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";
import type { assertValidTeammatePlacement } from "pi-maestro-fabric-core/v1/validation";
import type {
  BackendRegistry,
  ResolvedBackend,
} from "pi-maestro-backend-core/v1/registry";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import type {
  sharedModelCircuitBreaker,
  ModelCircuitBreaker,
} from "../models/model-circuit-breaker.ts";
import type { MANAGED_WINDOW_ENV, getTeammateChildExtensions } from "../runs/child-extensions.ts";
import type {
  parseTeammateThinkingLevel,
  TeammateThinkingInput,
  TeammateThinkingLevel,
} from "../shared/thinking.ts";
import type {
  isFallbackProviderError,
  ModelHealthFailureScopeClassifier,
} from "../runs/retry.ts";
import type { JsonLineEvent } from "../runs/execution-infra.ts";
import type { InfraPorts } from "./lifecycle-contracts.ts";
export interface ResultReadyTurnContext {
  /** Tools that have started but not yet produced a result (in-flight). */
  inFlightToolCount?: number;
  /** Tools that have completed in this run so far. */
  completedToolCount?: number;
}
export interface StructuredOutputCandidate {
  value: unknown;
  toolCallId?: string;
}
export interface Utf8LineDecoder {
  write(chunk: Buffer): string[];
  end(): string[];
}
export type TranscriptEntry = { role: string; content: string };

export function createResultOwner(ports: InfraPorts) {
 const { spawn,
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
  clearImmediate } = ports;
const STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS = {
  agentEnd: "The teammate completed without calling structured_output with a schema-valid value.",
  close: "The teammate exited without schema-valid structured_output.",
  resultReadyGrace: "The teammate published a result but did not settle with schema-valid structured_output in time.",
} as const;

const STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTIC_SET = new Set<string>(
  Object.values(STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS),
);

function isStructuredOutputSettlementDiagnostic(content: string): boolean {
  return STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTIC_SET.has(content);
}

/**
 * Initial prompt for a resume-based model fallback (cold restart with a
 * session checkpoint, or an in-process `set_model` switch). The original task
 * text already lives inside the loaded session history, so this directive
 * replaces it: the new model continues from the recorded state instead of
 * re-reading (and possibly re-executing) the original request.
 */
const MODEL_FALLBACK_RESUME_PROMPT =
  "The previous model attempt failed with a transient provider error. "
  + "The session history above records the work completed so far. "
  + "Continue from that recorded state and finish the original task. "
  + "Do not repeat tool calls whose results are already in the history.";

/**
 * Correlation ids are protocol identities, not filesystem-safe names.
 * Keep the original id for IPC while deriving a deterministic portable
 * component for --session-dir (notably ':' is invalid on Windows).
 */
function correlationSessionDirectoryName(correlationId: string): string {
  const raw = correlationId.trim() || "teammate";
  let safe = raw
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/-+/g, "-");
  if (!safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe || "teammate"}`;
  const changed = safe !== raw || safe.length > 96;
  if (!changed) return safe;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${safe.slice(0, 87).replace(/[. ]+$/g, "")}-${hash}`;
}

function extractTextContent(event: JsonLineEvent): string | undefined {
  if (typeof event.content === "string") return event.content;
  // AgentMessage format: { message: { content: [{type:"text", text:"..."}] } }
  const msg = event.message as Record<string, unknown> | undefined;
  if (msg?.content) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return (msg.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n") || undefined;
    }
  }
  return undefined;
}

/**
 * Optional context for distinguishing a final assistant turn from an interim
 * text-only turn emitted while tool calls are still in flight. Without this,
 * an LLM that narrates progress mid-task ("starting the read-only scan...") can
 * trip result-ready and publish a consumable result before its tool work is
 * done, leaving the lifecycle waiting for an `agent_settled` that never comes.
 */


/**
 * Pi's `agent_end` remains the authoritative terminal event. This stricter
 * `turn_end` shape means the model has supplied a usable final answer while
 * the child may still be waiting to publish its lifecycle confirmation.
 *
 * When `context` is supplied, a text-only turn is treated as interim (not
 * result-ready) if tools are still in flight: the narration likely precedes
 * the tool results rather than being the final answer. Without `context` the
 * original strict shape check is preserved (backward compatible).
 */
function isPiResultReadyTurn(
  event: Record<string, unknown>,
  context?: ResultReadyTurnContext,
): boolean {
  if (event.type !== "turn_end") return false;
  const message = event.message as Record<string, unknown> | undefined;
  if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
  if (typeof message.errorMessage === "string" && message.errorMessage.trim()) return false;
  if (!Array.isArray(message.content) || !Array.isArray(event.toolResults) || event.toolResults.length !== 0) {
    return false;
  }
  if (message.content.some((item) => (
    item !== null
    && typeof item === "object"
    && (item as Record<string, unknown>).type === "toolCall"
  ))) {
    return false;
  }
  // C1 guard: a text-only turn while tools are still in flight is interim
  // narration, not a final answer. Suppress result-ready so the agent can
  // continue its turn and converge naturally on agent_settled.
  if (context && context.inFlightToolCount && context.inFlightToolCount > 0) {
    return false;
  }
  return true;
}



function extractStructuredOutputCandidate(
  event: Record<string, unknown>,
  schema: Record<string, unknown>,
): StructuredOutputCandidate | undefined {
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if ((block.name ?? block.toolName) !== "structured_output") continue;
    const raw = block.arguments ?? block.input;
    let value = raw;
    if (typeof raw === "string") {
      try { value = JSON.parse(raw); } catch { return undefined; }
    }
    if (!validateStructuredOutputValue(value, schema)) return undefined;
    const toolCallId = typeof block.toolCallId === "string"
      ? block.toolCallId
      : typeof block.id === "string"
        ? block.id
        : undefined;
    return { value, ...(toolCallId ? { toolCallId } : {}) };
  }
  return undefined;
}

/**
 * Extracts a schema-valid structured_output payload from a Pi assistant event.
 * Execution code treats this as pending until the tool execution succeeds.
 */
function extractValidatedStructuredOutput(
  event: Record<string, unknown>,
  schema: Record<string, unknown>,
): unknown | undefined {
  return extractStructuredOutputCandidate(event, schema)?.value;
}

function describeStructuredOutputValueValidationFailure(
  value: unknown,
  schema: Record<string, unknown>,
): string | undefined {
  return describeDeclaredValueFailure(value, schema);
}

function describeStructuredOutputValidationFailure(
  event: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | undefined {
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if ((block.name ?? block.toolName) !== "structured_output") continue;
    const raw = block.arguments ?? block.input;
    if (typeof raw === "string") {
      const report = parseDeclaredJsonResult(raw, schema);
      return report.status === "format_failed" ? report.failure : undefined;
    }
    return describeStructuredOutputValueValidationFailure(raw, schema);
  }
  return undefined;
}

function extractPiEventError(event: Record<string, unknown>): string | undefined {
  const message = event.message as Record<string, unknown> | undefined;
  const candidates = [
    message?.errorMessage,
    message?.error,
    event.errorMessage,
    event.error,
  ];
  return candidates.find((candidate): candidate is string => (
    typeof candidate === "string" && candidate.trim().length > 0
  ))?.trim();
}

function validateStructuredOutputValue(
  value: unknown,
  schema: Record<string, unknown>,
): boolean {
  return describeStructuredOutputValueValidationFailure(value, schema) === undefined;
}



const EXECUTION_BUFFER_LIMITS = Object.freeze({
  lineBytes: 256 * 1024,
  streamBytes: 256 * 1024,
  stderrBytes: 64 * 1024,
  toolItems: 10,
  toolNameBytes: 1024,
  transcriptMessages: 128,
  transcriptMessageBytes: 64 * 1024,
  transcriptBytes: 1024 * 1024,
});

function truncateUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // Streaming appenders call this once per token, so the common "still well
  // under the cap" case must not re-encode the whole accumulated string.
  // A UTF-16 code unit never expands past 3 UTF-8 bytes (a surrogate pair is
  // 2 units -> 4 bytes), so this bound is safe and O(1).
  if (value.length * 3 <= maxBytes) return value;
  // Still cheaper than Buffer.from: measures without allocating a copy.
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

function truncateUtf8Head(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // A UTF-16 code unit never expands past 3 UTF-8 bytes, so this bound is safe
  // and O(1) for the common "still well under the cap" case.
  if (value.length * 3 <= maxBytes) return value;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  let end = maxBytes;
  // Back up over any trailing continuation bytes so we never split a
  // multi-byte character (or a surrogate pair) at the cut point.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function appendUtf8Tail(current: string, addition: string, maxBytes: number): string {
  return truncateUtf8Tail(current + addition, maxBytes);
}



// Byte accounting is memoized per entry and per transcript so appending a tool
// result does not rescan up to 1MB of retained history on every call. Both maps
// are keyed by object identity, so nothing leaks into the returned messages.
const transcriptEntryBytes = new WeakMap<TranscriptEntry, number>();
const transcriptTotals = new WeakMap<object, { length: number; bytes: number }>();

function entryBytes(entry: TranscriptEntry): number {
  let bytes = transcriptEntryBytes.get(entry);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(entry.content, "utf8");
    transcriptEntryBytes.set(entry, bytes);
  }
  return bytes;
}

function transcriptTotalBytes(messages: TranscriptEntry[]): number {
  const cached = transcriptTotals.get(messages);
  // A stale length means the array was reset or mutated elsewhere; recompute
  // from the memoized per-entry sizes rather than trusting the running total.
  if (cached && cached.length === messages.length) return cached.bytes;
  let bytes = 0;
  for (const entry of messages) bytes += entryBytes(entry);
  return bytes;
}

function appendBoundedTranscriptMessage(
  messages: Array<{ role: string; content: string }>,
  message: { role: string; content: string },
): void {
  const entry: TranscriptEntry = {
    ...message,
    content: truncateUtf8Tail(message.content, EXECUTION_BUFFER_LIMITS.transcriptMessageBytes),
  };
  let totalBytes = transcriptTotalBytes(messages) + entryBytes(entry);
  messages.push(entry);
  while (
    messages.length > EXECUTION_BUFFER_LIMITS.transcriptMessages
    || totalBytes > EXECUTION_BUFFER_LIMITS.transcriptBytes
  ) {
    const removed = messages.shift();
    if (!removed) break;
    totalBytes -= entryBytes(removed);
  }
  transcriptTotals.set(messages, { length: messages.length, bytes: totalBytes });
}

function createUtf8LineDecoder(
  maxBufferedBytes = EXECUTION_BUFFER_LIMITS.lineBytes,
  onOverflow?: (info: { receivedBytes: number; maxBytes: number; prefix: string }) => void,
  onLine?: (line: string) => void,
): Utf8LineDecoder {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let receivedBytes = 0;
  let prefix = "";
  let overflowReported = false;
  const append = (text: string): void => {
    receivedBytes += Buffer.byteLength(text);
    if (Buffer.byteLength(prefix) < 256) prefix = truncateUtf8Head(prefix + text.slice(0, 256), 256);
    buffered = appendUtf8Tail(buffered, text, maxBufferedBytes);
    if (!overflowReported && receivedBytes > maxBufferedBytes) {
      overflowReported = true;
      onOverflow?.({ receivedBytes, maxBytes: maxBufferedBytes, prefix });
    }
  };
  const emit = (lines: string[]): void => {
    const line = buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered;
    if (onLine) onLine(line);
    else lines.push(line);
    buffered = "";
    receivedBytes = 0;
    prefix = "";
    overflowReported = false;
  };
  return {
    write(chunk: Buffer): string[] {
      const text = decoder.write(chunk);
      const lines: string[] = [];
      let start = 0;
      for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
        append(text.slice(start, newline));
        emit(lines);
        start = newline + 1;
      }
      append(text.slice(start));
      return lines;
    },
    end(): string[] {
      append(decoder.end());
      const lines: string[] = [];
      if (buffered) emit(lines);
      return lines;
    },
  };
}

function appendDistinctAssistantMessage(
  messages: Array<{ role: string; content: string }>,
  content: string,
): boolean {
  const previous = messages[messages.length - 1];
  if (previous?.role === "assistant" && previous.content === content) return false;
  appendBoundedTranscriptMessage(messages, { role: "assistant", content });
  return true;
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    turns: 0,
  };
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function setUsageSnapshot(total: Usage, partial: Record<string, unknown>): void {
  total.inputTokens = usageNumber(partial.inputTokens ?? partial.input);
  total.outputTokens = usageNumber(partial.outputTokens ?? partial.output);
  total.cacheReadTokens = usageNumber(partial.cacheReadTokens ?? partial.cacheRead);
  total.cacheWriteTokens = usageNumber(partial.cacheWriteTokens ?? partial.cacheWrite);
  const cost = partial.cost;
  total.cost = usageNumber(
    typeof cost === "object" && cost !== null
      ? (cost as Record<string, unknown>).total
      : cost,
  );
}

function addUsageSnapshot(total: Usage, partial: Record<string, unknown>): void {
  const snapshot = emptyUsage();
  setUsageSnapshot(snapshot, partial);
  total.inputTokens += snapshot.inputTokens;
  total.outputTokens += snapshot.outputTokens;
  total.cacheReadTokens += snapshot.cacheReadTokens;
  total.cacheWriteTokens += snapshot.cacheWriteTokens;
  total.cost += snapshot.cost;
}

function resetUsage(usage: Usage): void {
  Object.assign(usage, emptyUsage());
}

function releasePublishedTurnHistory(
  messages: Array<{ role: string; content: string }>,
  progress: AgentProgress,
  usage: Usage,
): void {
  messages.length = 0;
  progress.recentTools = [];
  resetUsage(usage);
}


 return { STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS,
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
  releasePublishedTurnHistory };
}
