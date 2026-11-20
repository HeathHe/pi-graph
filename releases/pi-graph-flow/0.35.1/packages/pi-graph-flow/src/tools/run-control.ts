import { Type } from "typebox";
import {
  projectPublicRunCliResult,
  publicWorkflowErrorMessage,
  type WorkflowCoordinator,
  type WorkflowCoordinatorMode,
  type WorkflowLeaseOwnership,
} from "../session/coordinator.ts";
import type { RunCliResult } from "../session/cli-adapter.ts";

import { classifyRunControlArgv, type RunControlClassification } from "pi-graph-provider-backend/engine/classification";
export * from "pi-graph-provider-backend/engine/classification";

export const RunControlParams = Type.Object({
  argv: Type.Array(Type.String(), {
    description:
      "Maestro CLI arguments without the leading executable. v3 examples: "
      + "[\"session\",\"status\",\"--session\",\"session-123\",\"--json\"], "
      + "[\"run\",\"brief\",\"run-123\",\"--session\",\"session-123\",\"--json\"], "
      + "[\"run\",\"check\",\"run-123\",\"--session\",\"session-123\",\"--json\"], "
      + "[\"run\",\"next\",\"--session\",\"session-123\",\"--json\"], "
      + "[\"run\",\"complete\",\"run-123\",\"--session\",\"session-123\",\"--verdict\",\"done\",\"--advance\",\"--json\"], "
      + "[\"session\",\"chain\",\"insert\",\"--session\",\"session-123\",\"--step-id\",\"review-1\",\"--command\",\"review\",\"--arg\",\"src\",\"--json\"], "
      + "or [\"session\",\"chain\",\"update\",\"--session\",\"session-123\",\"--step-id\",\"review-1\",\"--stage\",\"verification\",\"--json\"].",
  }),
}, { additionalProperties: false });

export interface RunControlInput {
  argv: string[];
}

export interface RunControlError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
  next_actions?: string[];
  candidates?: unknown;
}

export interface RunControlAuthority {
  protocol: "legacy-lease" | "session-cas" | "core-execution" | "fail-closed";
  state: string;
}

export interface RunControlResult {
  ok: boolean;
  action: "exec";
  message: string;
  error?: RunControlError;
  authority?: RunControlAuthority;
  notices?: string[];
  details?: unknown;
}

export interface RunControlExecutionContext {
  hostSessionId: string;
  requestId?: string;
}

export async function executeRunControl(
  input: RunControlInput,
  coordinator: WorkflowCoordinator,
  context?: RunControlExecutionContext,
): Promise<RunControlResult> {
  try {
    const argv = sanitizeArgv(input.argv);
    if (argv.length === 0) {
      return failure('argv is required, e.g. ["session","status"]');
    }
    const classification = classifyRunControlArgv(argv);
    const hostSessionId = context?.hostSessionId?.trim();
    if (classification.write && !classification.sessionless) {
      required(hostSessionId, "hostSessionId");
    }
    const result = await coordinator.exec(argv, classification, hostSessionId, context?.requestId);
    const command = projectPublicRunCliResult(result.command);
    const publicArgv = projectPublicRunCliResult({
      argv,
      stdout: "",
      stderr: "",
      exitCode: 0,
    }).argv;
    const ownership = hostSessionId && !classification.write
      ? await coordinator.ownership(hostSessionId)
      : undefined;
    const authority = coordinatorAuthority(coordinator);
    const visibleOwnership = authority?.protocol === "session-cas" ? undefined : ownership;
    const commandMessage = command.stderr.trim()
      ? [command.stdout.trimEnd(), command.stderr.trimEnd()].filter(Boolean).join("\n")
      : command.stdout;
    const details = {
      argv: publicArgv,
      classification,
      command,
      snapshot: result.snapshot,
      ...(ownership ? { ownership } : {}),
    };
    const message = readMessage(commandMessage, visibleOwnership);
    const structuredError = command.exitCode === 0 ? undefined : extractRunControlError(command);
    const notice = visibleOwnership ? readOwnershipNotice(visibleOwnership) : undefined;
    return command.exitCode === 0
      ? success(message, details, undefined, authority, notice ? [notice] : undefined)
      : failure(message, details, structuredError, authority, notice ? [notice] : undefined);
  } catch (error) {
    return failure(publicWorkflowErrorMessage(error), undefined, errorToRunControlError(error), coordinatorAuthority(coordinator));
  }
}

function sanitizeArgv(argv: readonly string[] | undefined): string[] {
  const cleaned = (argv ?? []).map((argument) => String(argument).trim()).filter(Boolean);
  if (cleaned[0] === "maestro" || cleaned[0] === "maestro.cmd") cleaned.shift();
  return cleaned;
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required for this action`);
  return normalized;
}

function readMessage(message: string, ownership: WorkflowLeaseOwnership | undefined): string {
  const notice = ownership ? readOwnershipNotice(ownership) : undefined;
  const base = notice ? `${notice}\n${message}` : message;
  return ownership ? `${base}\n[lease: ${ownershipSummary(ownership)}]` : base;
}

function ownershipSummary(ownership: WorkflowLeaseOwnership): string {
  if (ownership.state === "unowned") return "workflow mutation lease is unowned";
  const owner = ownership.ownerHostSessionId ?? "unknown";
  const freshness = ownership.state === "stale" ? "stale" : "active";
  const relation = ownership.isOwner
    ? ownership.isAttached ? "this Pi session owns" : "this Pi session is recorded as owner of"
    : `Pi session ${owner} owns`;
  return `${relation} the ${freshness} mutation lease `
    + `(epoch ${ownership.epoch}, heartbeat ${ownership.heartbeatAt})`;
}

function readOwnershipNotice(ownership: WorkflowLeaseOwnership): string | undefined {
  if (ownership.state === "owned" && ownership.isOwner && ownership.isAttached) return undefined;
  if (ownership.state === "unowned") {
    return `Read-only view: Workflow Session ${ownership.sessionId} has no mutation lease owner.`;
  }
  if (ownership.isOwner) {
    return `Read-only view: Pi session ${ownership.currentHostSessionId} is recorded as the `
      + `${ownership.state} lease owner, but this coordinator is not attached.`;
  }
  const freshness = ownership.state === "stale" ? "stale" : "active";
  const article = freshness === "active" ? "an" : "a";
  return `Read-only view: Workflow Session ${ownership.sessionId} has ${article} ${freshness} mutation lease `
    + `owned by Pi session ${ownership.ownerHostSessionId}.`;
}

function success(
  message: string,
  details?: unknown,
  error?: RunControlError,
  authority?: RunControlAuthority,
  notices?: string[],
): RunControlResult {
  return {
    ok: true,
    action: "exec",
    message,
    ...(error ? { error } : {}),
    ...(authority ? { authority } : {}),
    ...(notices?.length ? { notices } : {}),
    ...(details === undefined ? {} : { details }),
  };
}

function failure(
  message: string,
  details?: unknown,
  error?: RunControlError,
  authority?: RunControlAuthority,
  notices?: string[],
): RunControlResult {
  return {
    ok: false,
    action: "exec",
    message,
    ...(error ? { error } : {}),
    ...(authority ? { authority } : {}),
    ...(notices?.length ? { notices } : {}),
    ...(details === undefined ? {} : { details }),
  };
}

function coordinatorAuthority(coordinator: WorkflowCoordinator): RunControlAuthority | undefined {
  const candidate = coordinator as unknown as { mode?: () => WorkflowCoordinatorMode };
  if (typeof candidate.mode !== "function") return undefined;
  const mode = candidate.mode();
  const protocol: RunControlAuthority["protocol"] = mode === "legacy-host"
    ? "legacy-lease"
    : mode === "session-v3" ? "session-cas" : mode;
  return { protocol, state: mode };
}

function extractRunControlError(command: RunCliResult): RunControlError | undefined {
  const parse = (text: string): RunControlError | undefined => {
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object") return undefined;
      const envelope = value as { error?: unknown };
      if (!envelope.error || typeof envelope.error !== "object") return undefined;
      const error = envelope.error as Record<string, unknown>;
      if (typeof error.code !== "string" || typeof error.message !== "string") return undefined;
      return {
        code: error.code,
        message: error.message,
        ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
        ...(Array.isArray(error.next_actions) ? { next_actions: error.next_actions.filter((item): item is string => typeof item === "string") } : {}),
        ...(error.details && typeof error.details === "object" && Array.isArray((error.details as Record<string, unknown>).candidates)
          ? { candidates: (error.details as Record<string, unknown>).candidates }
          : {}),
      };
    } catch {
      return undefined;
    }
  };
  const parsed = parse(command.stdout) ?? parse(command.stderr);
  if (parsed) return parsed;
  const match = `${command.stderr}\n${command.stdout}`.match(/(?:^|\\n)([A-Z][A-Z0-9_]+): ([^\\n]+)/);
  return match ? { code: match[1], message: match[2] } : undefined;
}

function errorToRunControlError(error: unknown): RunControlError | undefined {
  if (error && typeof error === "object") {
    const value = error as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
      details?: unknown;
      next_actions?: unknown;
    };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return {
        code: value.code,
        message: value.message,
        ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
        ...(value.details !== undefined ? { details: value.details } : {}),
        ...(Array.isArray(value.next_actions)
          ? { next_actions: value.next_actions.filter((item): item is string => typeof item === "string") }
          : {}),
      };
    }
  }
  const message = publicWorkflowErrorMessage(error);
  const match = message.match(/^([A-Z][A-Z0-9_]+): (.+)$/s);
  return match ? { code: match[1], message: match[2] } : undefined;
}
