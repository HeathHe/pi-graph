import type { RemoteDriverId, RemoteInputMode, RemoteRunCapture, RemoteRunEvent, RemoteRunSnapshot, RemoteStatus, RemoteWorkerIdentity,
  RemoteInitializeParams, RemoteInitializeResult, RemoteRequestMethod, RemoteRequestParamsByMethod, RemoteResultByMethod,
  RemoteRunStartParams, RemoteRunStartResult, RemoteRunAttachParams, RemoteRunAttachResult,
  RemoteRunInputParams, RemoteRunInputResult, RemoteRunCancelParams, RemoteRunCancelResult,
  RemoteRunListResult, RemoteProtocolNotification, RemoteJsonRpcNotification } from "../protocol/remote-run.ts";
export interface RemoteTimer { unref?(): unknown }
export interface RemoteTimers {
  setTimeout(callback: () => void, milliseconds: number): RemoteTimer;
  clearTimeout(timer: RemoteTimer): void;
}
/** Trusted resolver projection. Extra Host fields remain opaque to this owner. */
export interface RemoteManagerTarget {
  readonly id: string; readonly host: string; readonly cwd: string;
  readonly driver: RemoteDriverId; readonly command: readonly [string, ...string[]];
}
export interface RemoteConnection {
  readonly status: RemoteStatus; readonly identity?: RemoteWorkerIdentity;
  initialize(params: RemoteInitializeParams): Promise<RemoteInitializeResult>;
  request<Method extends RemoteRequestMethod>(method: Method, params: RemoteRequestParamsByMethod[Method]): Promise<RemoteResultByMethod[Method]>;
  start(params: RemoteRunStartParams): Promise<RemoteRunStartResult>;
  attach(params: RemoteRunAttachParams): Promise<RemoteRunAttachResult>;
  input(params: RemoteRunInputParams): Promise<RemoteRunInputResult>;
  cancel(params: RemoteRunCancelParams): Promise<RemoteRunCancelResult>;
  list(commandId: string, monitorOwnerNonce: string): Promise<RemoteRunListResult>;
  notifications(): AsyncIterable<RemoteJsonRpcNotification>;
  close(): Promise<void>;
}
export interface RemoteConnectionFactory<TTarget extends RemoteManagerTarget> {
  connect(target: TTarget, signal?: AbortSignal): Promise<RemoteConnection>;
}
export interface RemoteRunHandle {
  readonly capture: RemoteRunCapture; snapshot(): RemoteRunSnapshot; events(): AsyncIterable<RemoteRunEvent>;
  input(request: RemoteRunInputParams): Promise<RemoteRunInputResult>;
  cancel(request: RemoteRunCancelParams): Promise<RemoteRunCancelResult>; close(): Promise<void>;
}
export interface RemoteDriver<TTarget extends RemoteManagerTarget> {
  readonly id: RemoteDriverId;
  start(request: RemoteRunStartParams, context: RemoteWorkerIdentity & { target: TTarget; signal: AbortSignal }): Promise<RemoteRunHandle>;
  close(): Promise<void>;
}
export interface RemoteJournalRunRecord {
  capture: RemoteRunCapture; request: RemoteRunStartParams; snapshot: RemoteRunSnapshot;
}
export interface RemoteRunJournalPort {
  readonly identity: RemoteWorkerIdentity;
  createRun(capture: RemoteRunCapture, request: RemoteRunStartParams): unknown;
  getRun(runId: string): RemoteJournalRunRecord | undefined;
  readEvents(runId: string, lastSequence?: number): RemoteRunEvent[];
  listRuns(owner?: string): RemoteJournalRunRecord[];
}
export interface RemoteBackendWaitOptions { statuses?: readonly RemoteStatus[]; timeoutMs?: number; signal?: AbortSignal }

/** What a backend asks the manager to start; every member reaches the real manager verbatim. */
export interface RemoteWorkerStartRequest {
  targetId: string; name: string; objective: string;
  commandId?: string; outputSchema?: unknown; signal?: AbortSignal;
}

/** One started run: its ownership capture, plus the handle that detaches the listener started with it. */
export interface RemoteStartedRun {
  readonly capture: RemoteRunCapture;
  /** Stop delivering this run's events to the listener `start` attached. Idempotent. */
  unsubscribe(): void;
}

/**
 * Structural port over the host's `RemoteWorkerManager`.
 *
 * This package does not depend on teammate, so a backend cannot import the real
 * implementation; the host injects an adapter while assembling the registry.
 * The adapter's conformance to this port is asserted at compile time on the
 * teammate side, where the dependency already points this way and no cycle
 * forms.
 *
 * The member set is exactly what a backend calls. `start` and
 * `resolveTargetDriver` have no one-to-one method on the real manager and are
 * served by the host adapter, but neither can be dropped: the manager publishes
 * events only through its constructor's `onEvent` callback, so without the
 * adapter's per-capture routing a backend has no event stream and could only
 * report a constant `completedToolCount`; and `resolveRemoteTarget` lives in
 * teammate's config module, so without `resolveTargetDriver` a backend cannot
 * check a registration's declared driver against the target's real one.
 */
export interface RemoteWorkerManagerLike {
  /** This Monitor term's ownership nonce; the capture tuple's fifth member. */
  readonly monitorOwnerNonce: string;
  /** The driver the remote configuration really resolves for a target, so a registration's declaration can be checked against it. */
  resolveTargetDriver(targetId: string): RemoteDriverId;
  /**
   * Start one run with its event listener already attached.
   *
   * The listener is a parameter rather than a later `subscribe(capture, ...)`
   * call because there is no instant between the two at which a listener could
   * attach without loss. A worker's `run/*` notifications and its start reply
   * can arrive in the same transport chunk; the manager then buffers those
   * notifications as orphans and replays them while it admits the run, which
   * happens inside this call. A run short enough to fit entirely in that chunk
   * would lose its `run/result` as well, and the fold reads a result-less
   * stream as a completed run with no messages and exit code 0 — a failure
   * reported as a success.
   *
   * @param request - the run to start.
   * @param onEvent - receives every event of this run, replayed ones first, in wire order.
   * @returns the ownership capture and the handle that detaches `onEvent`.
   */
  start(request: RemoteWorkerStartRequest, onEvent: (event: RemoteRunEvent) => void): Promise<RemoteStartedRun>;
  send(capture: RemoteRunCapture, mode: RemoteInputMode, message: string, commandId?: string): Promise<RemoteRunInputResult>;
  cancel(capture: RemoteRunCapture, reason?: string, commandId?: string): Promise<RemoteRunCancelResult>;
  wait(capture: RemoteRunCapture, options?: RemoteBackendWaitOptions): Promise<RemoteRunSnapshot>;
  snapshot(capture: RemoteRunCapture): RemoteRunSnapshot;
}

export type { RemoteDriverId, RemoteInputMode, RemoteRunCapture, RemoteRunEvent, RemoteRunSnapshot, RemoteStatus } from "../protocol/remote-run.ts";
