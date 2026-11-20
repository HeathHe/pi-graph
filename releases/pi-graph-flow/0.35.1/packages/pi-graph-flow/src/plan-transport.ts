import type {
  PlanConfirmationAction,
  PlanConfirmationDecision,
  PlanConfirmationModelTransition,
  PlanWorkflowConfirmationOptions,
} from "./tools/plan-confirm.ts";
import type { PlanExecutionChoice } from "./tools/plan-store.ts";

export type PlanTransportKind = "confirm" | "review";

export type PlanTransportCancelReason =
  | "remote_answered"
  | "tui_answered"
  | "cancelled"
  | "aborted"
  | "transport_error";

export interface PlanTransportDraft {
  readonly revision: number;
  readonly archivedAt: string;
  readonly checksum: string;
}

export interface PlanTransportRequest {
  readonly kind: PlanTransportKind;
  readonly sessionId: string;
  readonly operationId: number;
  readonly cwd: string;
  readonly mode: string;
  readonly sessionFile?: string;
  readonly markdown: string;
  readonly revision: number;
  readonly pathLabel: string;
  readonly availableActions: readonly PlanConfirmationAction[];
  readonly defaultExecution?: PlanExecutionChoice;
  readonly workflow?: PlanWorkflowConfirmationOptions;
  readonly modelTransition?: PlanConfirmationModelTransition;
  readonly decisionDocuments: readonly string[];
  readonly drafts: readonly PlanTransportDraft[];
  readonly signal: AbortSignal;
}

export type PlanTransportResult =
  | { status: "decision"; decision: PlanConfirmationDecision }
  | { status: "edited"; markdown: string; expectedRevision: number }
  | { status: "cancelled" };

export interface PlanTransportHandle {
  readonly promise: Promise<PlanTransportResult>;
  cancel(reason: PlanTransportCancelReason): void | Promise<void>;
}

/**
 * Optional transport that races a remote Plan surface against the local TUI.
 * Returning undefined declines the request and leaves the native Plan UI in control.
 */
export interface PlanTransport {
  open(request: PlanTransportRequest): PlanTransportHandle | undefined;
}

const registryKey = Symbol.for("pi-maestro-flow.plan-transports");

interface PlanTransportRegistry {
  transports: PlanTransport[];
}

function registry(): PlanTransportRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[registryKey] as PlanTransportRegistry | undefined;
  if (existing) return existing;
  const created: PlanTransportRegistry = { transports: [] };
  globals[registryKey] = created;
  return created;
}

/** Register an optional external Plan transport and return its disposer. */
export function registerPlanTransport(transport: PlanTransport): () => void {
  const state = registry();
  if (!state.transports.includes(transport)) state.transports.push(transport);
  return () => {
    const index = state.transports.indexOf(transport);
    if (index >= 0) state.transports.splice(index, 1);
  };
}

export function getPlanTransports(): readonly PlanTransport[] {
  return [...registry().transports];
}
