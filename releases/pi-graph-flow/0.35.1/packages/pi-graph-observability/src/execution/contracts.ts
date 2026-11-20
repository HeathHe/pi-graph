export type ObservationAction = "status" | "diagnose" | "wait" | "watch";
export type ObservationDetail = "summary" | "tail" | "full";
export type ObservationView = "live" | "turns" | "session" | "todos";
export type ObservationWaitMode = "all" | "any" | "count";
export type ObservationPhase = "pending" | "active" | "settled" | "unknown";
export type ObservationOutcome = "success" | "failure" | "stalled" | "aborted";
export type ObservationWaitStatus =
  | "completed"
  | "failed"
  | "terminated"
  | "result-ready"
  | "stalled"
  | "timeout"
  | "aborted"
  | "not-found";

export interface ObservationTarget {
  kind: string;
  id: string;
  /** Opaque provider cursor for incremental views such as workspace session activity. */
  cursor?: string;
}

export interface ObservationCapabilities {
  inspect: boolean;
  wait: boolean;
  cancel?: boolean;
  message?: boolean;
  supervise?: boolean;
}

export interface ObservationPage {
  /** Provider-specific page kind. */
  kind: string;
  /** Cursor to continue after this page. */
  nextCursor?: string;
  /** True when events before this page were evicted from a bounded source. */
  gap?: boolean;
  /** Provider-specific structured items; text rendering remains in detail. */
  items: unknown[];
}

export interface ObservationSnapshot<D = unknown> {
  target: ObservationTarget;
  found: boolean;
  nativeStatus: string;
  phase: ObservationPhase;
  outcome?: ObservationOutcome;
  waitStatus?: ObservationWaitStatus;
  summary: string;
  detail?: string[];
  updatedAt: number;
  capabilities?: ObservationCapabilities;
  error?: string;
  /** Canonical terminal outcome when the target has settled (completed|failed|terminated). */
  terminalStatus?: string;
  /** Last captured result text of the settled agent. */
  lastResult?: string;
  /** Schema-valid structured output of a settled schema task (detail=full). */
  structuredOutput?: unknown;
  /** Provider content revision used by watch to detect changes without a status transition. */
  revision?: string;
  /** Optional structured page for cursor-based observation views. */
  page?: ObservationPage;
  /** Canonical orthogonal teammate diagnosis; present for supported diagnose snapshots. */
  diagnosis?: D;
}

export interface ObservationReadOptions {
  detail: ObservationDetail;
  lines: number;
  /** Request a canonical runtime diagnosis in addition to the ordinary snapshot. */
  diagnose?: boolean;
  /** "turns" lists target history; "session" shows sanitized workspace root-session activity; "todos" shows worker root-session Todo projections. */
  view?: ObservationView;
  /** Opaque provider cursor copied from the selected target. */
  cursor?: string;
  /** 1-based turn index to expand when view="turns"; omitted lists all turns. */
  turn?: number;
}

export interface ObservationWaitOptions extends ObservationReadOptions {
  deadline: number;
  signal: AbortSignal;
  /** When the wait settles: "result-ready" (default) or "completed" (terminal lifecycle). */
  until?: "result-ready" | "completed";
}

export interface ObservationProvider<D = unknown> {
  kind: string;
  capabilities: ObservationCapabilities;
  snapshot(id: string, options: ObservationReadOptions): ObservationSnapshot<D> | Promise<ObservationSnapshot<D>>;
  wait(id: string, options: ObservationWaitOptions): Promise<ObservationSnapshot<D>>;
}

export interface ObserveParams {
  action: ObservationAction;
  targets: ObservationTarget[];
  detail?: ObservationDetail;
  lines?: number;
  waitMode?: ObservationWaitMode;
  waitCount?: number;
  timeoutMs?: number;
  /** Block until "result-ready" (default) or "completed" (terminal lifecycle). */
  until?: "result-ready" | "completed";
  /** "turns" lists history; "session" shows sanitized root-session activity; "todos" shows workspace Todo projections. */
  view?: ObservationView;
  /** 1-based turn index to expand when view="turns"; omitted lists all turns. */
  turn?: number;
}

export interface ObserveResult<D = unknown> {
  action: ObservationAction;
  reason: "snapshot" | "all" | "any" | "count" | "timeout" | "aborted" | "watch";
  observations: ObservationSnapshot<D>[];
  durationMs: number;
  /** Watch history can be evicted; these remain the latest canonical snapshots, in target order. */
  latestObservations?: ObservationSnapshot<D>[];
  evictedTransitions?: number;
}


export type SessionProgressEvent = {kind:'assistant';at:number;text:string} | {kind:'tool';at:number;toolCallId:string;toolName:string;status:'running'|'completed'|'failed'} | {kind:'lifecycle';at:number;phase:'agent_start'|'turn_start'|'turn_end'|'agent_end'|'agent_settled'};
export interface SessionProgress { sequence:number; baseCursor:number; revision?:number; updatedAt:number; events:SessionProgressEvent[] }
export interface TodoProgress { id:string;subject:string;status:'pending'|'in_progress'|'completed'|'blocked'|'deleted';assigneeLabel?:string;dispatchId?:string;scheduleId?:string;stepId?:string;bindingActive?:boolean;updatedAt:number }
export interface SessionProgressInput {workspaceId:string;ownerId:string;ownerNonce:string;sessionId?:string;sessionName?:string;publishedAt:number; lifecycle:{status:string;settled:boolean};mainProgress?:SessionProgress;todos?:TodoProgress[];agents:{name?:string;correlationId:string;status:string;summary?:string;outputTail?:readonly string[];startedAt:number}[];settled:{name?:string;correlationId:string;status:string;summary?:string;settledAt:number}[]}
export interface RemoteUsage { inputTokens?:number;outputTokens?:number;totalTokens?:number;costUsd?:number }
export interface RemoteToolEvent {toolCallId:string;toolName:string;phase:'start'|'end';isError?:boolean;summary?:string}
export type RemoteDriverEvent = {type:'text';text:string}|{type:'tool';tool:RemoteToolEvent}|{type:'usage';usage:RemoteUsage}|{type:'native';name:string;data?:unknown};
export interface RemoteRunSnapshot {runId:string;status:'connecting'|'ready'|'running'|'waiting'|'completed'|'failed'|'cancelled'|'disconnected'|'lost';updatedAt:number;nativeStatus?:string}
