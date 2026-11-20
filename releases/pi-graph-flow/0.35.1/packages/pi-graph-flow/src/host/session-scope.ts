import type { RetireReason } from "./host-types.js";

export interface SessionIdentity<Runner extends object> {
  readonly extensionRunner: Runner;
}
export class HostGeneration {
  // Object identity is the grant; no user-readable id can recreate one.
  readonly #identity = Symbol("M18 Host generation");
  same(other: HostGeneration): boolean { return this === other && this.#identity === other.#identity; }
}
export interface HostOperation<Session> {
  readonly session: Session;
  readonly generation: HostGeneration;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  finish(): void;
  cancel(): void;
}
interface OperationRecord {
  readonly controller: AbortController;
  live: boolean;
  detach(): void;
}

/** A scope belongs to exactly one actual session; reload only changes its runner generation. */
export class HostSessionScope<Runner extends object, Session extends SessionIdentity<Runner>> {
  #session: Session | undefined;
  #runner: Runner | undefined;
  #generation: HostGeneration | undefined;
  #seenRunners = new WeakSet<Runner>();
  #state: "pending" | "active" | "reloading" | "retired" = "pending";
  #operations = new Set<OperationRecord>();
  #cleanupErrors: unknown[] = [];

  get state(): "pending" | "active" | "reloading" | "retired" { return this.#state; }
  get cleanupErrors(): readonly unknown[] { return this.#cleanupErrors.slice(); }
  capture(session: Session): void {
    if (this.#state === "retired") throw new Error("M18 scope is retired");
    if (this.#session === session) return;
    if (this.#session !== undefined) this.#reject("M18 capture cannot change actual session");
    this.#session = session;
  }
  publish(session: Session, runner: Runner): void {
    if (this.#state === "retired") throw new Error("M18 disposed scope cannot publish");
    if (this.#session !== session || session.extensionRunner !== runner) {
      this.#reject("M18 publication is not the captured actual session/runner");
    }
    if (this.#state === "active") {
      if (this.#runner === runner) return; // Reentrant bind is not a new generation.
      this.#reject("M18 runner replacement requires a prior fence");
    }
    if (this.#seenRunners.has(runner)) this.#reject("M18 retired runner cannot be republished");
    this.#seenRunners.add(runner);
    this.#runner = runner;
    this.#generation = new HostGeneration();
    this.#state = "active";
  }
  fence(session: Session, reason: RetireReason): void {
    // No third-party callbacks before revocation; wrong-owner requests fail closed, never throw.
    if (this.#session !== session) {
      this.#cleanupErrors.push(new Error("M18 fence actual session mismatch"));
      this.#retire("retired");
      return;
    }
    this.#retire(reason === "reload" && this.#state !== "retired" ? "reloading" : "retired");
  }
  failStartup(_error: unknown): void { this.#retire("retired"); }
  close(): void { this.#retire("retired"); }
  begin(externalSignal?: AbortSignal): HostOperation<Session> {
    const session = this.#session;
    const runner = this.#runner;
    const generation = this.#generation;
    if (this.#state !== "active" || session === undefined || runner === undefined || generation === undefined || session.extensionRunner !== runner) {
      throw new Error("M18 session is not published/current");
    }
    externalSignal?.throwIfAborted();
    const controller = new AbortController();
    const record: OperationRecord = { controller, live: true, detach: () => {} };
    const finish = () => {
      if (!record.live) return;
      record.live = false;
      this.#operations.delete(record);
      record.detach();
    };
    const cancel = () => {
      finish();
      try { controller.abort(); } catch (error) { this.#cleanupErrors.push(error); }
    };
    if (externalSignal !== undefined) {
      externalSignal.addEventListener("abort", cancel, { once: true });
      record.detach = () => externalSignal.removeEventListener("abort", cancel);
    }
    this.#operations.add(record);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (!record.live || this.#state !== "active" || this.#generation !== generation || this.#session !== session || this.#runner !== runner || session.extensionRunner !== runner) {
        throw new Error("M18 stale operation");
      }
    };
    if (externalSignal?.aborted) cancel();
    assertCurrent();
    return Object.freeze({ session, generation, signal: controller.signal, assertCurrent, finish, cancel });
  }
  #reject(message: string): never {
    const error = new Error(message);
    this.#retire("retired");
    throw error;
  }
  #retire(next: "reloading" | "retired"): void {
    if (this.#state === "retired") return;
    this.#state = next;
    this.#generation = undefined;
    this.#runner = undefined;
    const operations = [...this.#operations];
    this.#operations.clear();
    // Every operation is inadmissible before the first abort listener may re-enter.
    for (const operation of operations) operation.live = false;
    for (const operation of operations) {
      try { operation.detach(); } catch (error) { this.#cleanupErrors.push(error); }
      try { operation.controller.abort(); } catch (error) { this.#cleanupErrors.push(error); }
    }
  }
}
