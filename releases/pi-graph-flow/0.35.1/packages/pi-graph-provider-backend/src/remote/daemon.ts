import type { RemoteManagerTarget, RemoteRunHandle, RemoteDriver, RemoteRunJournalPort } from "./ports.ts";
import { captureMatches, type RemoteRunStartParams, type RemoteRunAttachParams, type RemoteRunInputParams, type RemoteRunCancelParams, type RemoteResultByMethod, type RemoteRunCapture, type RemoteRunEvent, type RemoteDriverId } from "../protocol/remote-run.ts";
export interface RemoteDaemonClient { subscriptions: Map<string, number> }
export interface RemoteDaemonPorts<TTarget extends RemoteManagerTarget> {
  journal: RemoteRunJournalPort; targets: readonly TTarget[]; drivers: readonly RemoteDriver<TTarget>[]; concurrency: number;
  sendRunEvent(client: RemoteDaemonClient, event: RemoteRunEvent): void;
  appendEvent(capture: RemoteRunCapture, event: RemoteRunEvent): void;
  broadcast(event: RemoteRunEvent): void;
  randomUUID(): string; redact(error: unknown): string;
}
export class RemoteRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
export class RemoteDaemon<TTarget extends RemoteManagerTarget> {
  readonly journal: RemoteRunJournalPort;
  readonly #targets: Map<string, TTarget>;
  readonly #drivers: Map<RemoteDriverId, RemoteDriver<TTarget>>;
  readonly #handles = new Map<string, RemoteRunHandle>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #concurrency: number;
  readonly #ports: RemoteDaemonPorts<TTarget>;
  readonly #pendingStarts = new Set<{ controller: AbortController; done?: Promise<void> }>();
  readonly #pumps = new Set<Promise<void>>();
  #closed = false;
  #closePromise?: Promise<void>;
  #startingRuns = 0;
  constructor(ports: RemoteDaemonPorts<TTarget>) {
    this.#ports = ports; this.journal = ports.journal;
    this.#targets = new Map(ports.targets.map((target) => [target.id, target]));
    this.#drivers = new Map(ports.drivers.map((driver) => [driver.id, driver]));
    this.#concurrency = ports.concurrency;
  }
  get activeRuns(): number { return this.#handles.size; }
  get concurrency(): number { return this.#concurrency; }
  list(owner: string) { return { runs: this.journal.listRuns(owner).map((record) => record.snapshot) }; }
  closeDrivers(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.#closePromise = closing;
    for (const pending of this.#pendingStarts) pending.controller.abort();
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
    void Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#drivers.values()].map((driver) => driver.close()));
      await Promise.allSettled([...this.#pendingStarts].map((pending) => pending.done));
      await Promise.allSettled([...this.#pumps]);
    }).then(resolve, reject);
    return closing;
  }
  clearHandles(): void { this.#handles.clear(); }
  start(client: RemoteDaemonClient, params: RemoteRunStartParams): Promise<RemoteResultByMethod["run/start"]> {
    if (this.#closed) return Promise.reject(new RemoteRpcError(-32000, "Remote daemon is closed"));
    const pending: { controller: AbortController; done?: Promise<void> } = { controller: new AbortController() };
    this.#pendingStarts.add(pending);
    const started = this.#start(client, params, pending.controller);
    pending.done = started.then(() => { this.#pendingStarts.delete(pending); }, () => { this.#pendingStarts.delete(pending); });
    return started;
  }
  async #start(client: RemoteDaemonClient, params: RemoteRunStartParams, controller: AbortController): Promise<RemoteResultByMethod["run/start"]> {
    if (this.#handles.size + this.#startingRuns >= this.#concurrency) {
      throw new RemoteRpcError(-32005, "Remote daemon concurrency limit reached");
    }
    const target = this.#targets.get(params.targetId);
    if (!target) throw new RemoteRpcError(-32004, `Unknown configured remote target: ${params.targetId}`);
    if (params.cwd !== target.cwd || params.driver !== target.driver || !sameArgv(params.command, target.command)) {
      throw new RemoteRpcError(-32003, "Run request does not match the trusted configured target");
    }
    const driver = this.#drivers.get(target.driver);
    if (!driver) throw new RemoteRpcError(-32004, `Remote driver is not available: ${target.driver}`);
    this.#startingRuns += 1;
    let handle: RemoteRunHandle | undefined;
    try {
      handle = await driver.start(params, { ...this.journal.identity, target, signal: controller.signal });
      if (this.#closed || controller.signal.aborted) throw new RemoteRpcError(-32000, "Remote daemon closed during run startup");
    } catch (error) {
      controller.abort();
      if (handle) await handle.close();
      throw error;
    } finally {
      this.#startingRuns -= 1;
    }
    try {
      this.journal.createRun(handle.capture, params);
      if (this.#closed || controller.signal.aborted) throw new RemoteRpcError(-32000, "Remote daemon closed during run admission");
    } catch (error) {
      controller.abort();
      await handle.close();
      throw error;
    }
    this.#handles.set(handle.capture.runId, handle);
    this.#controllers.set(handle.capture.runId, controller);
    client.subscriptions.set(handle.capture.runId, 0);
    const pumping = this.#pump(handle, { ...handle.capture });
    this.#pumps.add(pumping);
    void pumping.then(() => { this.#pumps.delete(pumping); }, () => { this.#pumps.delete(pumping); });
    return {
      workerId: handle.capture.workerId,
      instanceNonce: handle.capture.instanceNonce,
      runId: handle.capture.runId,
      generation: handle.capture.generation,
      status: "running",
      firstSequence: 1,
    };
  }

  attach(client: RemoteDaemonClient, params: RemoteRunAttachParams): RemoteResultByMethod["run/attach"] {
    if (this.#closed) throw new RemoteRpcError(-32000, "Remote daemon is closed");
    const record = this.#ownedRun(params);
    if (params.lastSequence > record.snapshot.lastSequence) throw new RemoteRpcError(-32602, "Replay sequence is ahead of the run journal");
    client.subscriptions.set(params.runId, params.lastSequence);
    const events = this.journal.readEvents(params.runId, params.lastSequence);
    for (const event of events) this.#ports.sendRunEvent(client, event);
    return {
      workerId: record.capture.workerId,
      instanceNonce: record.capture.instanceNonce,
      runId: record.capture.runId,
      generation: record.capture.generation,
      status: record.snapshot.status,
      replayFromSequence: events[0]?.sequence ?? record.snapshot.lastSequence + 1,
      lastSequence: record.snapshot.lastSequence,
    };
  }

  async input(params: RemoteRunInputParams): Promise<RemoteResultByMethod["run/input"]> {
    if (this.#closed) throw new RemoteRpcError(-32000, "Remote daemon is closed");
    this.#ownedRun(params);
    const handle = this.#handles.get(params.runId);
    if (!handle) throw new RemoteRpcError(-32004, "Remote run is not active in this daemon instance");
    return handle.input(params);
  }

  async cancel(params: RemoteRunCancelParams): Promise<RemoteResultByMethod["run/cancel"]> {
    if (this.#closed) throw new RemoteRpcError(-32000, "Remote daemon is closed");
    const record = this.#ownedRun(params);
    const handle = this.#handles.get(params.runId);
    if (!handle) return { accepted: false, status: record.snapshot.status };
    return handle.cancel(params);
  }

  #ownedRun(params: { runId: string; generation: number; monitorOwnerNonce: string }) {
    const record = this.journal.getRun(params.runId);
    if (!record
      || record.capture.generation !== params.generation
      || record.capture.monitorOwnerNonce !== params.monitorOwnerNonce) {
      throw new RemoteRpcError(-32003, "Remote run ownership capture mismatch");
    }
    return record;
  }

  async #pump(handle: RemoteRunHandle, captured: RemoteRunCapture): Promise<void> {
    try {
      for await (const event of handle.events()) {
        if (this.#handles.get(captured.runId) !== handle || !captureMatches(captured, handle.capture)) break;
        // Already-admitted physical facts still belong to this exact run while
        // its driver closes. Persist before shadow/broadcast, never re-admit or
        // publish activity to the revoked owner.
        this.#ports.appendEvent(captured, event);
        if (!this.#closed && this.#handles.get(captured.runId) === handle && captureMatches(captured, handle.capture)) {
          this.#ports.broadcast(event);
        }
      }
    } catch (error) {
      if (!this.#closed && this.#handles.get(captured.runId) === handle) await Promise.allSettled([
        handle.cancel({
          commandId: `journal-failure-${this.#ports.randomUUID()}`,
          runId: captured.runId,
          generation: captured.generation,
          monitorOwnerNonce: captured.monitorOwnerNonce,
          reason: this.#ports.redact(error),
        }),
      ]);
    } finally {
      if (this.#handles.get(captured.runId) === handle) {
        this.#handles.delete(captured.runId);
        this.#controllers.delete(captured.runId);
      }
    }
  }

}
