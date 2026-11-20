import { createHash } from "node:crypto";
import type { ObservationDetail, ObservationPage, ObservationSnapshot, ObservationTarget, SessionProgressInput, SessionProgressEvent, TodoProgress } from "./contracts.ts";
import {encodeCursor,decodeCursor} from "./cursors.ts";
const SUMMARY_TEXT_CHARS=120;
export interface WorkspaceSessionObservationItem {
  cursor: number;
  kind: SessionProgressEvent["kind"];
  at: number;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  status?: "running" | "completed" | "failed";
  phase?: "agent_start" | "turn_start" | "turn_end" | "agent_end" | "agent_settled";
  /** Raw agent_settled is a lifecycle fact, not business-work completion. */
  provisional?: boolean;
}

const SESSION_CAPABILITIES = {
  inspect: true,
  wait: false,
  cancel: false,
  message: true,
  supervise: true,
} as const;

export function workspaceSessionObservationSnapshot(
  owner: SessionProgressInput,
  target: ObservationTarget,
  detail: ObservationDetail,
  lines: number,
  cursor?: string,
): ObservationSnapshot<never> {
  const lifecycle = owner.lifecycle;
  const progress = owner.mainProgress;
  const incarnation = sessionIncarnation(owner);
  const sequence = progress?.sequence ?? 0;
  const progressRevision = progress?.revision ?? progress?.updatedAt ?? 0;
  const revision = `workspace-session:${incarnation}:${sequence}:${progressRevision}`;
  const nextCursor = encodeCursor({
    version: 1 as const,
    incarnation,
    sequence,
    revision: progressRevision,
  });
  const requested = cursor === undefined ? undefined : decodeCursor(cursor);

  if (cursor !== undefined && (!requested || requested.incarnation !== incarnation)) {
    return cursorError(owner, target, revision, "Session cursor belongs to another workspace window incarnation.");
  }
  if (requested && (requested.sequence > sequence
    || (requested.sequence === sequence && requested.revision > progressRevision))) {
    return cursorError(owner, target, revision, "Session cursor is ahead of the published session progress.");
  }

  const baseCursor = progress?.baseCursor ?? 0;
  const requestedSequence = requested?.sequence ?? baseCursor;
  const gap = requestedSequence < baseCursor;
  const items = progress
    ? progress.events.flatMap((event, index) => {
        const absoluteCursor = progress.baseCursor + index + 1;
        const revisedAssistantTail = requested !== undefined
          && absoluteCursor === requestedSequence
          && index === progress.events.length - 1
          && event.kind === "assistant"
          && requested.revision < progressRevision;
        return absoluteCursor > requestedSequence || revisedAssistantTail
          ? [projectEvent(event, absoluteCursor)]
          : [];
      })
    : [];
  const page: ObservationPage = {
    kind: "workspace-session",
    nextCursor,
    ...(gap ? { gap: true } : {}),
    items: detail === "summary" ? [] : items,
  };
  const windowName = owner.sessionName ?? `window:${owner.ownerId.slice(0, 8)}`;
  const latest = items.at(-1) ?? (progress?.events.length
    ? projectEvent(progress.events.at(-1)!, progress.sequence)
    : undefined);
  const summary = latest
    ? `${windowName} session · ${describeEvent(latest, true)} · sequence ${sequence}${gap ? " · gap" : ""}`
    : `${windowName} session · no published activity · sequence ${sequence}${gap ? " · gap" : ""}`;
  const detailLines = detail === "summary"
    ? undefined
    : [
        ...(gap ? [`Session progress gap: requested ${requestedSequence}, retained from ${baseCursor}.`] : []),
        ...(items.length === 0 ? ["No new root-session activity published."] : items.slice(-Math.max(1, lines)).map((item) => describeEvent(item, false))),
        `next-cursor=${nextCursor}`,
      ];

  return {
    target,
    found: true,
    nativeStatus: lifecycle.status,
    phase: lifecycle.settled ? "settled" : "active",
    summary,
    ...(detailLines ? { detail: detailLines } : {}),
    revision,
    page,
    updatedAt: progress?.updatedAt ?? owner.publishedAt,
    capabilities: SESSION_CAPABILITIES,
  };
}

export interface WorkspaceTodoObservationItem {
  id: string;
  subject: string;
  status: TodoProgress["status"];
  assigneeLabel?: string;
  dispatchId?: string;
  scheduleId?: string;
  stepId?: string;
  bindingActive?: boolean;
  updatedAt: number;
}

/** Strip CR/LF/ESC and C0 control chars for safe terminal rendering (defense-in-depth over the projection layer). */
function sanitizeTodoText(value: string, maximum: number): string {
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[\r\n]/g, " ").trim();
  return cleaned.length > maximum ? `${cleaned.slice(0, maximum - 3)}...` : cleaned;
}

/**
 * Render the worker root-session Todo projection (owner.todos) for observe view="todos".
 * Each todo is projected as a structured item (already-validated by validateSessionProgressInput)
 * and re-sanitized at this render boundary as defense-in-depth against CR/LF/ESC terminal injection (P1-7).
 */
export function workspaceTodosObservationSnapshot(
  owner: SessionProgressInput,
  target: ObservationTarget,
  detail: ObservationDetail,
  lines: number,
): ObservationSnapshot<never> {
  const todos = owner.todos ?? [];
  const lifecycle = owner.lifecycle;
  const windowName = owner.sessionName ?? `window:${owner.ownerId.slice(0, 8)}`;
  const items: WorkspaceTodoObservationItem[] = todos.map((todo) => ({
    id: sanitizeTodoText(todo.id, 256),
    subject: sanitizeTodoText(todo.subject, 4096),
    status: todo.status,
    ...(todo.assigneeLabel !== undefined ? { assigneeLabel: sanitizeTodoText(todo.assigneeLabel, 256) } : {}),
    ...(todo.dispatchId !== undefined ? { dispatchId: sanitizeTodoText(todo.dispatchId, 64) } : {}),
    ...(todo.scheduleId !== undefined ? { scheduleId: sanitizeTodoText(todo.scheduleId, 64) } : {}),
    ...(todo.stepId !== undefined ? { stepId: sanitizeTodoText(todo.stepId, 64) } : {}),
    ...(todo.bindingActive === undefined ? {} : { bindingActive: todo.bindingActive }),
    updatedAt: todo.updatedAt,
  }));
  const page: ObservationPage = {
    kind: "workspace-todos",
    items: detail === "summary" ? [] : items,
  };
  const active = items.filter((item) => item.status === "in_progress" || item.status === "pending").length;
  const bound = items.filter((item) => item.dispatchId !== undefined).length;
  const summary = `${windowName} todos · ${items.length} total · ${active} active · ${bound} bound · ${lifecycle.status}`;
  const detailLines = detail === "summary"
    ? undefined
    : items.length === 0
      ? [`${windowName} has no published todos.`]
      : items.slice(-Math.max(1, lines)).map((item) => describeTodo(item));
  const revisionHash = createHash("sha256")
    .update(JSON.stringify(items))
    .digest("hex")
    .slice(0, 16);
  return {
    target,
    found: true,
    nativeStatus: lifecycle.status,
    phase: lifecycle.settled ? "settled" : "active",
    summary,
    ...(detailLines ? { detail: detailLines } : {}),
    revision: `workspace-todos:${owner.publishedAt}:${revisionHash}`,
    page,
    updatedAt: owner.publishedAt,
    capabilities: SESSION_CAPABILITIES,
  };
}

function describeTodo(item: WorkspaceTodoObservationItem): string {
  const binding = item.dispatchId !== undefined
    ? ` · bound ${item.dispatchId}${item.scheduleId !== undefined ? `@${item.scheduleId}` : ""}${item.stepId !== undefined ? `#${item.stepId}` : ""}`
    : "";
  const assignee = item.assigneeLabel !== undefined ? ` @${item.assigneeLabel}` : "";
  return `[${item.id}] ${item.status}${assignee} · ${item.subject}${binding}`;
}

function cursorError(
  owner: SessionProgressInput,
  target: ObservationTarget,
  revision: string,
  message: string,
): ObservationSnapshot<never> {
  return {
    target,
    found: true,
    nativeStatus: "stale-cursor",
    phase: "unknown",
    outcome: "failure",
    summary: message,
    revision,
    updatedAt: owner.mainProgress?.updatedAt ?? owner.publishedAt,
    capabilities: SESSION_CAPABILITIES,
    error: "stale-session-cursor",
  };
}

function sessionIncarnation(owner: SessionProgressInput): string {
  return createHash("sha256")
    .update(owner.workspaceId)
    .update("\0")
    .update(owner.ownerId)
    .update("\0")
    .update(owner.ownerNonce)
    .update("\0")
    .update(owner.sessionId ?? "")
    .digest("hex")
    .slice(0, 32);
}

function projectEvent(
  event: SessionProgressEvent,
  cursor: number,
): WorkspaceSessionObservationItem {
  switch (event.kind) {
    case "assistant":
      return { cursor, kind: event.kind, at: event.at, text: event.text };
    case "tool":
      return {
        cursor,
        kind: event.kind,
        at: event.at,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: event.status,
      };
    case "lifecycle":
      return {
        cursor,
        kind: event.kind,
        at: event.at,
        phase: event.phase,
        ...(event.phase === "agent_settled" ? { provisional: true } : {}),
      };
  }
}

function describeEvent(item: WorkspaceSessionObservationItem, summary: boolean): string {
  switch (item.kind) {
    case "assistant": {
      const text = (item.text ?? "").replace(/\s+/g, " ").trim();
      const bounded = summary && text.length > SUMMARY_TEXT_CHARS
        ? `${text.slice(0, SUMMARY_TEXT_CHARS - 3)}...`
        : text;
      return `[${item.cursor}] assistant${bounded ? `: ${bounded}` : ""}`;
    }
    case "tool":
      return `[${item.cursor}] tool ${item.toolName ?? "unknown"} ${item.status ?? "unknown"}`;
    case "lifecycle":
      return `[${item.cursor}] lifecycle ${item.phase ?? "unknown"}${item.provisional ? " (provisional)" : ""}`;
  }
}
