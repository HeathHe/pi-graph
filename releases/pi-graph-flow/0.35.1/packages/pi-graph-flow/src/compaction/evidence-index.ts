import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { boundedUtf8 } from "./new-context.ts";

/**
 * Categorized recovery receipts for tool-call results dropped by compaction.
 *
 * The checkpoint summary and deterministic capsules preserve state, but the
 * pre-compaction transcript segment stays on the active session chain and is
 * reachable through `session_history`/`resource`. Without an index agents
 * recover by blindly re-reading files and re-running commands (measured at
 * ~30% of post-compaction reads). A receipt turns that rediscovery into a
 * precise lookup: the dropped toolResult entry id plus its exact
 * `session://<sessionId>/entry/<entryId>` URI.
 */

export type EvidenceKind = "read" | "inspect" | "edit" | "command" | "resource";

export interface EvidenceReceipt {
  /** Session entry id of the dropped toolResult row — the recovery target. */
  entryId: string;
  /** Exact recovery URI resolvable by `resource` and `session_history`. */
  uri: string;
  kind: EvidenceKind;
  tool: string;
  /** File path, command head, or resource target (bounded). */
  target: string;
  /** Qualifier such as `offset=120 limit=81`, `edits=2`, or `write 12.4K chars`. */
  detail?: string;
  /** First non-empty result line when the call failed. */
  error?: string;
  /** First non-empty result line for a successful call — often answers the lookup with zero recovery. */
  preview?: string;
}

export const MAX_EVIDENCE_RECEIPTS = 64;
/** Receipt lines rendered into summaries/capsules; the remainder is counted. */
export const MAX_RENDERED_EVIDENCE_RECEIPTS = 24;
const MAX_TARGET_BYTES = 256;
const MAX_ERROR_BYTES = 160;

/** Tools whose outputs are fully reproduced by live state or the recovery surface itself. */
const STATE_TOOLS = new Set([
  "todo",
  "goal",
  "session_history",
  "new_context",
]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const COMMAND_TOOLS = new Set(["bash", "powershell", "bash_bg", "bash-bg-complete"]);
const RESOURCE_TOOLS = new Set([
  "resource",
  "browser",
  "computer_use",
  "endpoint",
  "route",
  "workspace",
  "device",
  "conflict",
]);

function classifyTool(tool: string): EvidenceKind | undefined {
  if (!tool || STATE_TOOLS.has(tool) || tool.startsWith("plan")) return undefined;
  if (tool === "read") return "read";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (COMMAND_TOOLS.has(tool)) return "command";
  if (RESOURCE_TOOLS.has(tool)) return "resource";
  return "inspect";
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

function targetFor(kind: EvidenceKind, args: Record<string, unknown>): string | undefined {
  switch (kind) {
    case "read":
    case "edit":
      return stringArg(args, "path") ?? stringArg(args, "file");
    case "command":
      return stringArg(args, "command");
    case "resource":
      return stringArg(args, "uri") ?? stringArg(args, "url") ?? stringArg(args, "path");
    case "inspect":
      return stringArg(args, "path")
        ?? stringArg(args, "pattern")
        ?? stringArg(args, "query")
        ?? stringArg(args, "command")
        ?? stringArg(args, "uri")
        ?? stringArg(args, "url")
        ?? stringArg(args, "name")
        ?? stringArg(args, "task");
  }
}

/** `read` args replay verbatim — `offset` is the 1-indexed start line, `limit` the line count. */
function readReplayArgs(args: Record<string, unknown>): string | undefined {
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset > 0
    ? Math.floor(args.offset)
    : undefined;
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
    ? Math.floor(args.limit)
    : undefined;
  if (offset !== undefined && limit !== undefined) return `offset=${offset} limit=${limit}`;
  if (offset !== undefined) return `offset=${offset}`;
  if (limit !== undefined) return `limit=${limit}`;
  return undefined;
}

function detailFor(kind: EvidenceKind, tool: string, args: Record<string, unknown>): string | undefined {
  if (kind === "read") return readReplayArgs(args);
  if (tool === "edit" && Array.isArray(args.edits)) return `edits=${args.edits.length}`;
  if (tool === "write" && typeof args.content === "string") {
    return `write ${args.content.length} chars`;
  }
  return undefined;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

function firstResultLine(content: unknown): string | undefined {
  const line = resultText(content)
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ? boundedUtf8(line, MAX_ERROR_BYTES) : undefined;
}

function receiptKey(receipt: EvidenceReceipt): string {
  return `${receipt.tool}|${receipt.target}|${receipt.detail ?? ""}`;
}

/**
 * Scan the dropped prefix of `branchEntries` and pair each toolCall block with
 * its toolResult row. `firstKeptEntryId` is the effective retention boundary;
 * when it is absent from the branch (deterministic resets keep nothing) every
 * entry counts as dropped.
 */
export function collectEvidenceReceipts(input: {
  sessionId: string;
  branchEntries: readonly SessionEntry[];
  firstKeptEntryId?: string;
  limit?: number;
}): EvidenceReceipt[] {
  const limit = Math.max(0, Math.floor(input.limit ?? MAX_EVIDENCE_RECEIPTS));
  if (!input.sessionId || limit === 0) return [];
  const entries = input.branchEntries;
  const keptIndex = input.firstKeptEntryId === undefined
    ? -1
    : entries.findIndex((entry) => entry?.id === input.firstKeptEntryId);
  const end = keptIndex >= 0 ? keptIndex : entries.length;
  const pending = new Map<string, { name: string; args: Record<string, unknown> }>();
  const receipts = new Map<string, EvidenceReceipt>();
  for (let index = 0; index < end; index++) {
    const entry = entries[index];
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type !== "toolCall" || !block.id) continue;
        const args = block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
          ? block.arguments as Record<string, unknown>
          : {};
        pending.set(block.id, { name: block.name, args });
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const call = typeof message.toolCallId === "string" ? pending.get(message.toolCallId) : undefined;
    const tool = call?.name ?? (typeof message.toolName === "string" ? message.toolName : "");
    const kind = classifyTool(tool);
    if (!kind) continue;
    const args = call?.args ?? {};
    const rawTarget = targetFor(kind, args) ?? tool;
    const detail = detailFor(kind, tool, args);
    const firstLine = firstResultLine(message.content);
    const error = message.isError === true ? firstLine : undefined;
    const preview = message.isError === true ? undefined : firstLine;
    const receipt: EvidenceReceipt = {
      entryId: entry.id,
      uri: `session://${input.sessionId}/entry/${entry.id}`,
      kind,
      tool,
      target: boundedUtf8(rawTarget.replace(/\s+/g, " ").trim(), MAX_TARGET_BYTES),
      ...(detail ? { detail } : {}),
      ...(error ? { error } : {}),
      ...(preview ? { preview } : {}),
    };
    const key = receiptKey(receipt);
    receipts.delete(key);
    receipts.set(key, receipt);
  }
  return [...receipts.values()].slice(-limit);
}

/**
 * Merge the previous checkpoint's receipts with the freshly dropped ones.
 * A later identical call (same tool/target/range) supersedes the earlier
 * receipt; older URIs remain resolvable, so non-overlapping receipts persist.
 */
export function mergeEvidenceReceipts(
  inherited: readonly EvidenceReceipt[],
  current: readonly EvidenceReceipt[],
  limit: number = MAX_EVIDENCE_RECEIPTS,
): EvidenceReceipt[] {
  const merged = new Map<string, EvidenceReceipt>();
  for (const receipt of [...inherited, ...current]) {
    const key = receiptKey(receipt);
    merged.delete(key);
    merged.set(key, receipt);
  }
  return [...merged.values()].slice(-Math.max(0, Math.floor(limit)));
}

/** Bounded, human-scanable section appended to summaries and capsules. */
export function renderEvidenceIndexLines(
  receipts: readonly EvidenceReceipt[],
  maxReceipts: number = MAX_RENDERED_EVIDENCE_RECEIPTS,
): string[] {
  if (!receipts.length) return [];
  const shown = receipts.slice(-Math.max(0, Math.floor(maxReceipts)));
  const lines = [
    "## Evidence Index",
    `- ${receipts.length} dropped tool result(s) remain recoverable: pass the exact session:// URI to the resource tool; re-read a listed path only for its recorded range; never re-run a listed command just to recover its output.`,
  ];
  for (const receipt of shown) {
    const detail = receipt.detail ? ` ${receipt.detail}` : "";
    const error = receipt.error ? ` [error: ${receipt.error}]` : "";
    const preview = receipt.preview ? ` → ${receipt.preview}` : "";
    lines.push(`- ${receipt.tool} ${receipt.target}${detail}${preview}${error} — ${receipt.uri}`);
  }
  const omitted = receipts.length - shown.length;
  if (omitted > 0) {
    lines.push(`- ${omitted} earlier receipt(s) omitted; recover with session_history search on the target.`);
  }
  return lines;
}

/** Drop malformed receipts when normalizing persisted checkpoint details. */
export function normalizeEvidenceReceipts(value: unknown): EvidenceReceipt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kinds = new Set<EvidenceKind>(["read", "inspect", "edit", "command", "resource"]);
  const receipts: EvidenceReceipt[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Partial<EvidenceReceipt>;
    if (typeof candidate.entryId !== "string" || !candidate.entryId
      || typeof candidate.uri !== "string" || !candidate.uri
      || typeof candidate.tool !== "string" || !candidate.tool
      || typeof candidate.target !== "string" || !candidate.target
      || !kinds.has(candidate.kind as EvidenceKind)) continue;
    receipts.push({
      entryId: candidate.entryId,
      uri: candidate.uri,
      kind: candidate.kind as EvidenceKind,
      tool: candidate.tool,
      target: candidate.target,
      ...(typeof candidate.detail === "string" && candidate.detail ? { detail: candidate.detail } : {}),
      ...(typeof candidate.error === "string" && candidate.error ? { error: candidate.error } : {}),
      ...(typeof candidate.preview === "string" && candidate.preview ? { preview: candidate.preview } : {}),
    });
  }
  return receipts.length ? receipts : undefined;
}
