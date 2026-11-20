import { projectBudgetView, uninitializedBudgetView, unavailableBudgetView, type GoalBudgetViewPort, type GoalBudgetConfigurationPort } from "../goal-coordinator/budget-view.ts";
import { budgetPoolKey, createBudgetPool, inspectBudgetPool, type BudgetHistory, type BudgetCommand, type BudgetReservationInput } from "pi-graph-permission-core";
import type { GoalModelBudgetPort } from "../sdk-host/goal-budget-host.ts";
import type { GoalBudgetDeclaration, GoalBudgetScope, GoalBudgetSource, GoalCoverageCloseFact, GoalCoverageAdoption } from "../goal-coordinator/budget-source.ts";
import type { GoalView } from "./ports.ts";
import type { BudgetAcquireControl, NativeTaskBudgetRequest } from "pi-maestro-teammate/v1/task-dispatch-binding";
import type { TaskClearRecord } from "./task-clear.ts";
import type { TaskClearIntent } from "../persistence-recovery/native-recovery/task-clear.ts";
import { assertTaskReplacementEligible, pendingPlanReplacement, type PlanReplacementReceipt } from "./plan-replacement.ts";
import type { NativeBeforePin, PlanReplacementIntent } from "../persistence-recovery/native-recovery/plan-replacement.ts";
import type { TodoPublication } from "../tools/todo-serialization.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, lstatSync, readFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { TaskNativeRecoveryProvider, PreparedTaskDispatch } from "pi-maestro-teammate/v1/task-dispatch-binding";
import type { NativeExecutionSnapshot } from "pi-maestro-teammate/v1/observation";
import { PlanStore } from "../tools/plan-store.ts";
import { taskExecutionInput, taskExecutionInputDigest, taskBusinessContractDigest, taskOutputValues } from "./execution-contract.ts";
import { fingerprint, jsonCopy, sameInput, type RecoveryContract, type RestoredClosedExecution, type RecoveryWork, type GoalDetachJournalIntent } from "../persistence-recovery/native-recovery/contracts.ts";
import { openNativeRecoveryStore, type NativeRecoveryStore } from "../persistence-recovery/native-recovery/sqlite-store.ts";
import { NativeRecoveryOwner, type RecoveryTransition } from "../persistence-recovery/native-recovery/owner-fence.ts";
import { ClosedSettlementRecovery } from "../persistence-recovery/native-recovery/recovery.ts";
import type { CoverageOpen, CoverageEpoch, CoverageJournalCut } from "../persistence-recovery/native-recovery/coverage-store.ts";
import type { TodoTask } from "./types.ts";
import type { DeliveryGroup } from "./delivery-group.ts";

interface Manager {getSessionFile?():string|undefined;getEntry?(id:string):unknown;getSessionId():string;getBranch():readonly {id?:string;parentId?:string|null;type?:string;customType?:string;data?:unknown}[];getLeafId?():string|null;}
interface Host {cwd:string;manager:Manager;scope:object;}
interface Ports {
  childModelUsageFacts?: { read(fact: object, request: object): { readonly units: number; readonly entryId: string; readonly digest: string } };
  modelUsageFacts?: { read(fact: object, request: object, manager: object): { readonly units: number; readonly entryId: string; readonly digest: string } };
  dataRoot():string; assert(scope:object):void; tasks():ReadonlyMap<string,TodoTask>; groups():readonly DeliveryGroup[];
  history(id:string):readonly {entryId:string;task?:TodoTask}[];
  assertTask?(task:TodoTask):void;
  assertDispatch?(token: PreparedTaskDispatch): void;
  subscribeTasks?(changed: () => void): () => void;
  goalBudget?: {
    available?(): boolean;
    view(goalId: string): GoalView | undefined;
    capture(goalId: string): GoalBudgetSource;
    captureSelected?(): GoalBudgetSource;
    assertNone?(source: GoalBudgetSource): void;
    read(scope: GoalBudgetScope, phase: "send" | "fact" | "configuration"): GoalBudgetDeclaration;
    assertCoverage?(scope: GoalBudgetScope): void;
    subscribe?(scope: GoalBudgetScope, changed: () => void): () => void;
    initialHistory?(scope: GoalBudgetScope): BudgetHistory;
    coverageInfo?(scope: GoalBudgetScope): { required: boolean; birth?: {entryId:string;digest:string}; hostEpoch?: string; initialized?: boolean };
    captureCoverageClose?(): readonly GoalCoverageCloseFact[];
    restoredCoverage?(): readonly { scope: GoalBudgetScope; poolScope: import("pi-graph-permission-core").BudgetPoolScope; hostEpoch: string }[];
    adoptCoverage?(verified: object): void;
  };
}
interface BudgetAttempt {
  readonly id: string;
  readonly host: Host;
  readonly owner: NativeRecoveryOwner;
  readonly store: NativeRecoveryStore;
  readonly token: PreparedTaskDispatch;
  readonly contracts: readonly RecoveryContract[];
  readonly guard: () => void;
  readonly factGuard: () => void;
  readonly requests: Map<string, object>;
}
interface BudgetContext {
  readonly attempt: object;
  readonly source: GoalBudgetScope;
  readonly declaration: GoalBudgetDeclaration;
  readonly coverage?: CoverageOpen;
}
interface GoalRequestContext {
  readonly host: Host; readonly store: NativeRecoveryStore; readonly scope: GoalBudgetScope;
  readonly declaration: GoalBudgetDeclaration;
  readonly coverage?: CoverageOpen;
}
interface GoalRequest { readonly context: GoalRequestContext; readonly identity: BudgetReservationInput; }
interface BudgetRequest {
  readonly context: BudgetContext;
  readonly identity: BudgetReservationInput;
}
export interface GoalDetachPublication {
  goalId: string;
  normalizedBeforeDigest: string;
  afterDigest: string;
  afterSemanticDigest: string;
  updatedAt: Record<string, number>;
  hasNewContents: boolean;
}
export interface GoalDetachJournalOnly {
  updatedAt: Record<string, number>;
  afterDigest: string;
  assertCurrent(): void;
}
interface CoverageClosing {
  readonly host: Host; readonly sourceEpoch: number; readonly ownerId: string;
  readonly facts: readonly GoalCoverageCloseFact[];
  readonly publish: (committed: object) => void;
  readonly readPoint: (point: object) => { readonly manager: object; readonly pending: number };
  point?: object; readonly peers: CoverageEpoch[];
  store?: NativeRecoveryStore; prepared: boolean; publication?: CoverageJournalCut; retired: boolean; finished: boolean;
}
type ReceiptCommand = Extract<BudgetCommand, { kind: "record-receipt" }>;
export interface NativeBudgetReceiptRoute {
  route(instruction: object): void;
  read(envelope: object): { readonly manager: object; readonly value: unknown; readonly continuousClosed: boolean };
  publish(committed: object): void;
}
interface ReceiptProducer { pending: boolean; readonly changed: Set<() => void>; }
interface Acquisition {
  attempted: boolean; retired: boolean; released: boolean; readonly proof: string;
  readonly finish: () => void; readonly release: () => void;
}
interface ReceiptBinding {
  readonly host: Host; readonly store: NativeRecoveryStore; readonly dataRoot: string;
  readonly coverage?: CoverageOpen; readonly identity: BudgetReservationInput;
  readonly scope: GoalBudgetDeclaration["poolScope"]; readonly journal: CoverageJournalCut;
  readonly device: string; readonly inode: string; readonly route: NativeBudgetReceiptRoute;
  readonly status: { recorded: boolean; coverage: "pending" | "adopted" | "unchanged"; reason?: string; producer?: ReceiptProducer };
}
interface ReceiptInstruction {
  readonly binding: ReceiptBinding; readonly command: ReceiptCommand;
  readonly closed?: { readonly point: object; readonly publication: CoverageJournalCut; readonly peers: readonly CoverageEpoch[] };
}
const COVERAGE_CONFIRM = "pi-graph-next:coverage-seal-v1";
/** M03 adapter: projections and trusted Root recovery; no independent Task writer. */
export class TaskNativeRecovery {
  #host?:Host;#epoch=0;#service?:{store:NativeRecoveryStore;owner:NativeRecoveryOwner;recovery:ClosedSettlementRecovery};
  #opening?:Promise<void>;#unavailable?:string;#unfencedOrdinary=false;
  readonly #restored=new Map<string,RestoredClosedExecution>();
  readonly #taskNegatives = new WeakMap<object, { attempt: object; parents: ReadonlyMap<string, GoalBudgetSource> }>();
  readonly #parentSources = new WeakMap<object, { host: Host; epoch: number; source: GoalBudgetSource }>();
  readonly #initialHistories = new WeakMap<object, { history: BudgetHistory; used: boolean }>();
  readonly #backendSources = new WeakMap<object, { host: Host; epoch: number; contracts: readonly RecoveryContract[]; parents: ReadonlyMap<string, GoalBudgetSource>; selected?: object }>();
  readonly #goalContexts = new WeakMap<object, GoalRequestContext>();
  readonly #goalRequests = new WeakMap<object, GoalRequest>();
  readonly #budgetAttempts = new WeakMap<object, BudgetAttempt>();
  readonly #budgetContexts = new WeakMap<object, BudgetContext>();
  readonly #budgetRequests = new WeakMap<object, BudgetRequest>();
  #receiptRoute?: NativeBudgetReceiptRoute;
  readonly #receiptBindings = new WeakMap<object, ReceiptBinding>();
  readonly #receiptInstructions = new WeakMap<object, { binding: ReceiptBinding; command: ReceiptCommand }>();
  readonly #closingByHost = new WeakMap<Host, CoverageClosing>();
  #coverageOwner = randomUUID();
  #sendFrozen = false;
  #closing?: CoverageClosing;
  readonly #closingHandles = new WeakMap<object, CoverageClosing>();
  readonly #committedCoverage = new WeakMap<object, { closing: CoverageClosing; epoch: CoverageEpoch }>();
  readonly #coverageAdoptions = new WeakMap<object, { host: Host; epoch: number; value: GoalCoverageAdoption }>();
  readonly #waiters = new Map<string, Set<{ check(): void; stop(error: unknown): void }>>();
  readonly #poolRuns = new Map<string, { running: boolean; scheduled: boolean }>();
  readonly #acquisitions = new WeakMap<object, Acquisition>();
  readonly #unmarked = new Set<object>();
  readonly #acquisitionCleanupFailures: unknown[] = [];
  readonly #producerHandles = new WeakMap<object, ReceiptProducer>();
  readonly #requestProducers = new WeakMap<object, ReceiptProducer>();
  readonly #poolProducers = new Map<string, Map<string, { producer: ReceiptProducer; dispose(): void }>>();
  readonly #retiredSenders = new WeakSet<object>();
  readonly #unavailableReceipts = new Map<string, Set<string>>();
  #retireSender(request: object): { recorded: boolean } {
    const info = this.#requestInfo(request);
    if (this.#host !== info.host || this.#service?.store !== info.store) throw Error("Original receipt sender owner unavailable");
    this.ports.assert(info.host.scope);
    const pool = info.store.readBudgetPool(info.scope), reservation = pool?.reservations.find(row => row.reservationId === info.identity.reservationId);
    if (!pool || !reservation || ["requestKey", "sourceHash", "attemptKey", "reservedUnits"].some(key => Reflect.get(reservation, key) !== Reflect.get(info.identity, key))) throw Error("Original receipt sender identity changed");
    if (!this.#retiredSenders.has(request) && reservation.phase !== "settled" && reservation.phase !== "released") this.#markAttempted(request);
    const firstRetirement = !this.#retiredSenders.has(request); this.#retiredSenders.add(request);
    const key = budgetPoolKey(info.scope);
    if (reservation.phase !== "settled" && reservation.phase !== "released") {
      const unavailable = this.#unavailableReceipts.get(key) ?? new Set<string>(); unavailable.add(reservation.reservationId); this.#unavailableReceipts.set(key, unavailable);
    }
    const producer = this.#requestProducers.get(request);
    if (producer?.pending) { producer.pending = false; for (const changed of [...producer.changed]) changed(); }
    this.#wakePool(info.scope); // Rechecks authority; never grants capacity.
    // Deny-only receipt availability changed, not amount/revision or a COMMIT.
    // Renderers must invalidate their cached read even when marking was uncertain.
    if (firstRetirement) this.#notifyBudget(info.scope.goalId);
    if (reservation.phase === "settled" || reservation.phase === "released") return { recorded: true };
    if (reservation.phase === "reserved") return { recorded: false }; // Mark/ACK uncertainty keeps the original hold.
    if (this.#goalRequests.has(request)) this.goalModelBudget.unknown(request); else this.#recordBudgetUnknown(request);
    return { recorded: true };
  }
  #runPool(key: string): void {
    const run = this.#poolRuns.get(key) ?? { running: false, scheduled: false }; this.#poolRuns.set(key, run);
    if (run.running) { this.#schedulePool(key); return; }
    run.running = true;
    try { for (const waiter of [...(this.#waiters.get(key) ?? [])]) waiter.check(); }
    finally { run.running = false; if (!run.scheduled && !this.#waiters.has(key)) this.#poolRuns.delete(key); }
  }
  #schedulePool(key: string): void {
    if (!this.#waiters.has(key)) return;
    const run = this.#poolRuns.get(key) ?? { running: false, scheduled: false }; this.#poolRuns.set(key, run);
    if (run.scheduled) return; run.scheduled = true;
    queueMicrotask(() => { run.scheduled = false; this.#runPool(key); });
  }
  #wakePool(scope: GoalBudgetDeclaration["poolScope"]): void { this.#schedulePool(budgetPoolKey(scope)); }
  #rememberProducer(scope: GoalBudgetDeclaration["poolScope"], reservationId: string, producer: ReceiptProducer): void {
    if (!producer.pending) return; // An ended producer is never reopened by a duplicate terminal.
    const key = budgetPoolKey(scope), entries = this.#poolProducers.get(key) ?? new Map();
    this.#poolProducers.set(key, entries);
    const previous = entries.get(reservationId); if (previous?.producer === producer) return;
    previous?.dispose(); const changed = () => {
      if (!producer.pending) {
        producer.changed.delete(changed); entries.delete(reservationId); if (!entries.size) this.#poolProducers.delete(key);
      }
      this.#wakePool(scope);
    };
    producer.changed.add(changed); entries.set(reservationId, { producer, dispose: () => producer.changed.delete(changed) });
  }
  #producerOpen(scope: GoalBudgetDeclaration["poolScope"], reservationId: string): boolean {
    return this.#poolProducers.get(budgetPoolKey(scope))?.get(reservationId)?.producer.pending === true;
  }
  #requestInfo(request: object) {
    const goal = this.#goalRequests.get(request);
    if (goal) return { host: goal.context.host, store: goal.context.store, scope: goal.context.declaration.poolScope, identity: goal.identity, coverage: goal.context.coverage };
    const task = this.#budgetRequests.get(request), attempt = task && this.#budgetAttempts.get(task.context.attempt);
    if (!task || !attempt) throw Error("Unissued original budget request");
    return { host: attempt.host, store: attempt.store, scope: task.context.declaration.poolScope, identity: task.identity, coverage: task.context.coverage };
  }
  #beginReceiptDrain(request: object): object {
    const info = this.#requestInfo(request); let producer = this.#requestProducers.get(request);
    if (!producer) {
      producer = { pending: !this.#retiredSenders.has(request), changed: new Set() }; this.#requestProducers.set(request, producer);
      const binding = this.#receiptBindings.get(request); if (binding) binding.status.producer = producer;
    }
    this.#rememberProducer(info.scope, info.identity.reservationId, producer);
    const handle = Object.freeze({}); this.#producerHandles.set(handle, producer); return handle;
  }
  #endReceiptDrain(handle: object): void {
    const producer = this.#producerHandles.get(handle); if (!producer) throw Error("Unissued original receipt producer");
    if (!producer.pending) return; producer.pending = false;
    for (const changed of [...producer.changed]) changed();
  }
  #markAttempted(request: object): void {
    if (this.#retiredSenders.has(request)) throw Error("Original receipt sender retired; its old ticket cannot mark");
    const lease = this.#acquisitions.get(request); if (!lease) return; // Original synchronous API stays compatible.
    if (lease.retired) throw Error("Budget acquisition was revoked before its first mark");
    lease.attempted = true; lease.finish(); this.#unmarked.delete(request);
  }
  #abandonBeforeMark(request: object): void {
    const lease = this.#acquisitions.get(request); if (!lease || lease.attempted) throw Error("No trusted unmarked acquisition can be abandoned");
    if (lease.released) return;
    lease.retired = true; lease.finish(); this.#unmarked.delete(request);
    lease.release(); lease.released = true;
  }
  #acquire(scope: GoalBudgetScope, control: BudgetAcquireControl, pool: () => ReturnType<NativeRecoveryStore["readBudgetPool"]>, reserve: () => object, assertCurrent: () => void): Promise<object> {
    return new Promise((resolve, reject) => {
      const declaration = this.ports.goalBudget!.read(scope, "send"), key = budgetPoolKey(declaration.poolScope);
      let settled = false, running = false; const disposers: (() => void)[] = [];
      const current = () => { control.signal?.throwIfAborted(); assertCurrent(); control.assertCurrent?.(); };
      const disposeAll = (disposers: (() => void)[]) => {
        for (const dispose of disposers.splice(0)) { try { dispose(); } catch (error) { this.#acquisitionCleanupFailures.push(error); } }
      };
      const subscribe = (changed: () => void) => {
        const resources: (() => void)[] = [];
        try {
          const goal = this.ports.goalBudget?.subscribe?.(scope, changed); if (goal) resources.push(goal);
          const tasks = this.ports.subscribeTasks?.(changed); if (tasks) resources.push(tasks);
          if (control.signal) {
            resources.push(() => control.signal!.removeEventListener("abort", changed));
            control.signal.addEventListener("abort", changed, { once: true });
          }
          return () => disposeAll(resources);
        } catch (error) { disposeAll(resources); throw error; }
      };
      const finish = (error: unknown, request?: object) => {
        if (settled) return; settled = true;
        const queue = this.#waiters.get(key); queue?.delete(waiter); if (!queue?.size) this.#waiters.delete(key);
        // Cleanup cannot prevent this exact waiter from settling. Original
        // cancellation/source errors win; cleanup remains visible at retirement.
        disposeAll(disposers);
        if (request) resolve(request); else reject(error);
      };
      const waiter = {
        stop: (error: unknown) => finish(error),
        check: () => {
          if (settled || running) return; running = true;
          try {
            current(); const state = pool(); if (!state) throw Error("Original budget pool preparation unavailable");
            const balance = inspectBudgetPool(state), known = new Set(state.receipts.filter(r => r.kind === "known").map(r => r.reservationId));
            const unavailable = this.#unavailableReceipts.get(key);
            if (unavailable) {
              for (const id of [...unavailable]) if (known.has(id) || state.reservations.some(row => row.reservationId === id && row.phase === "released")) unavailable.delete(id);
              if (!unavailable.size) this.#unavailableReceipts.delete(key);
              else throw Error("Original receipt sender retired; usage is unknown or unavailable");
            }
            const unknown = state.reservations.filter(r => r.phase === "unknown" && !known.has(r.reservationId));
            if (state.history.kind === "unknown") throw Error("Budget history is unknown");
            if (unknown.length) {
              if (unknown.every(r => this.#producerOpen(state.scope, r.reservationId))) return;
              throw Error("Budget usage is unknown after its original receipt producer drained");
            }
            if (balance.blockedBy === "reservation-overrun") throw Error("Budget reservation overrun");
            if (balance.consumed >= BigInt(state.limit)) throw Error("Goal token budget is exhausted");
            if (balance.available <= 0 && balance.held > 0n) return;
            current(); const cut = this.#journalCut(this.#current()), request = reserve(), info = this.#requestInfo(request);
            let disposeLease = () => {}; const proof = `unmarked-acquisition:${randomUUID()}`;
            const guard = () => {
              if (this.#host !== info.host || this.#service?.store !== info.store || info.host.manager.getSessionId() !== info.scope.sessionId) throw Error("Unmarked acquisition durable owner changed");
              this.ports.assert(info.host.scope);
              const actual = this.#journalCut(info.host), bytes = readFileSync(cut.path);
              if (actual.path !== cut.path || actual.device !== cut.device || actual.inode !== cut.inode || bytes.length < cut.bytes
                || createHash("sha256").update(bytes.subarray(0, cut.bytes)).digest("hex") !== cut.digest) throw Error("Unmarked acquisition journal changed");
            };
            const lease: Acquisition = { attempted: false, retired: false, released: false, proof, finish: () => disposeLease(), release: () => {
              guard(); const before = info.store.readBudgetPool(info.scope); if (!before) throw Error("Original unmarked reservation disappeared");
              this.#writeBudget(info.store, { scope: info.scope, expectedRevision: before.revision,
                command: { kind: "release", request: info.identity, notSentProofRef: proof }, ...(info.coverage ? { coverage: info.coverage } : {}) }, guard);
            } };
            this.#acquisitions.set(request, lease); this.#unmarked.add(request);
            const revoked = () => { try { current(); } catch { try { this.#abandonBeforeMark(request); } catch (error) { this.#acquisitionCleanupFailures.push(error); } } };
            try {
              disposeLease = subscribe(revoked); if (lease.retired) disposeLease();
              current(); finish(undefined, request);
            } catch (error) {
              try { this.#abandonBeforeMark(request); } catch (cleanup) { this.#acquisitionCleanupFailures.push(cleanup); }
              throw error;
            }
          } catch (error) { finish(error); } finally { running = false; }
        },
      };
      try {
        const queue = this.#waiters.get(key) ?? new Set(); this.#waiters.set(key, queue); queue.add(waiter);
        const dispose = subscribe(() => {
          try { current(); } catch (error) { finish(error); return; } // Source invalidation leaves the queue synchronously.
          this.#schedulePool(key);
        });
        if (settled) dispose(); else disposers.push(dispose);
        this.#runPool(key);
      } catch (error) { finish(error); }
    });
  }
  #stopAcquisitions(error: unknown): void {
    this.#unavailableReceipts.clear();
    for (const queue of [...this.#waiters.values()]) for (const waiter of [...queue]) waiter.stop(error);
    const failures = this.#acquisitionCleanupFailures.splice(0);
    for (const request of [...this.#unmarked]) { try { this.#abandonBeforeMark(request); } catch (error) { failures.push(error); } }
    for (const entries of this.#poolProducers.values()) for (const value of entries.values()) { try { value.dispose(); } catch (error) { failures.push(error); } }
    this.#poolProducers.clear(); failures.push(...this.#acquisitionCleanupFailures.splice(0));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Original budget acquisition cleanup failed");
  }
  readonly #budgetViewListeners = new Set<{ changed: (goalId: string) => void }>();
  #notifyBudget(goalId: string): void {
    for (const entry of [...this.#budgetViewListeners]) { try { entry.changed(goalId); } catch { /* A display observer cannot change committed accounting or its ACK. */ } }
  }
  #writeBudget(store: NativeRecoveryStore, write: Parameters<NativeRecoveryStore["transactBudget"]>[0], guard: () => void) {
    const result = store.transactBudget(write, guard);
    if (result.budget.changed) {
      if (write.command.kind === "release" || (write.command.kind === "record-receipt" && write.command.receipt.kind === "known")) {
        const key = budgetPoolKey(write.scope), unavailable = this.#unavailableReceipts.get(key);
        unavailable?.delete(write.command.request.reservationId); if (!unavailable?.size) this.#unavailableReceipts.delete(key);
      }
      this.#notifyBudget(write.scope.goalId); this.#wakePool(write.scope);
    }
    return result;
  }
  readonly budgetView: GoalBudgetViewPort = {
    read: scope => {
      const host = this.#current(), port = this.ports.goalBudget;
      if (!port) throw new Error("Goal budget view source unavailable");
      const declaration = port.read(scope, "configuration");
      if (declaration.poolScope.workspace !== realpathSync(host.cwd) || declaration.poolScope.sessionId !== host.manager.getSessionId()) throw new Error("Budget view belongs to another durable source");
      let info: ReturnType<NonNullable<typeof port.coverageInfo>> | undefined;
      try { info = port.coverageInfo?.(scope); } catch { /* Existing measured data remains visible, without new sending authority. */ }
      const service = this.#service;
      if (!service) {
        if (this.#sendFrozen) return unavailableBudgetView("owner-closing", declaration.limit);
        if (!info?.required || !info.birth || !info.hostEpoch) return { version: 1, kind: "unknown", admission: "unknown",
          declaredLimit: declaration.limit, reason: "coverage-unavailable", text: "历史预算用量无法确认" };
        return info.initialized === false && !this.#opening && !this.#databaseExists()
          ? uninitializedBudgetView(declaration.limit) : unavailableBudgetView("owner-not-ready", declaration.limit);
      }
      const pool = service.store.readBudgetPool(declaration.poolScope);
      if (this.#current() !== host || this.#service !== service) throw new Error("Budget view source changed");
      port.read(scope, "configuration");
      if (!pool) return info?.required && info.initialized === false && !this.#sendFrozen ? uninitializedBudgetView(declaration.limit)
        : { version: 1, kind: "unknown", admission: "unknown", declaredLimit: declaration.limit, reason: "pool-history-unavailable", text: "历史预算用量无法确认" };
      const epoch = service.store.readCoverage(declaration.poolScope);
      const covered = Boolean(info?.required && info.birth && info.hostEpoch && epoch?.phase === "open" && epoch.ownerId === this.#coverageOwner
        && epoch.hostEpoch === info.hostEpoch && fingerprint(epoch.birth) === fingerprint(info.birth));
      const projected = projectBudgetView(pool, declaration.limit, covered, this.#sendFrozen);
      const retired = this.#unavailableReceipts.get(budgetPoolKey(declaration.poolScope));
      const unavailable = retired && pool.reservations.filter(row => retired.has(row.reservationId) && row.phase !== "settled" && row.phase !== "released");
      if (unavailable?.length) {
        const { progress: _progress, ...view } = projected;
        return { ...view, kind: "unknown", admission: "unknown", reason: "receipt-sender-retired", unknownRequests: Math.max(view.unknownRequests ?? 0, unavailable.length),
          text: `已记 ${view.knownConsumed}/${declaration.limit} · 在途 ${view.held} · 原发送通道已关闭，用量待核` };
      }
      return projected;
    },
    subscribe: changed => { const entry = { changed }; this.#budgetViewListeners.add(entry); return () => { this.#budgetViewListeners.delete(entry); }; },
  };
  readonly budgetConfiguration: GoalBudgetConfigurationPort = {
    syncDeclaredLimit: async (scope, assertOperationCurrent) => {
      const host = this.#current(), port = this.ports.goalBudget;
      if (!port) throw new Error("Goal budget configuration source unavailable");
      const declaration = port.read(scope, "configuration");
      if (declaration.poolScope.workspace !== realpathSync(host.cwd) || declaration.poolScope.sessionId !== host.manager.getSessionId()) throw new Error("Budget configuration belongs to another durable source");
      const guard = () => {
        if (this.#sendFrozen || this.#current() !== host) throw new Error("Goal budget configuration owner is closing or replaced");
        // Configuration is a paused command, not a read view or sending permit.
        if (port.view(declaration.poolScope.goalId)?.status !== "paused") throw new Error("Goal budget configuration requires a paused Goal");
        assertOperationCurrent?.();
        const current = port.read(scope, "configuration");
        if (fingerprint(current) !== fingerprint(declaration)) throw new Error("Goal budget configuration changed");
        port.assertCoverage?.(scope);
      };
      guard(); await this.ready(true); guard();
      const service = this.#required(), pool = service.store.readBudgetPool(declaration.poolScope);
      if (!pool) {
        const info = port.coverageInfo?.(scope);
        if (!info?.required || info.initialized !== false) throw new Error("Goal history is unknown; configuration cannot initialize usage");
        guard(); return;
      }
      const coverage = this.#coverageIdentity(scope, declaration);
      if (pool.limit !== declaration.limit) this.#writeBudget(service.store, { scope: declaration.poolScope, expectedRevision: pool.revision,
        command: { kind: "set-limit", limit: declaration.limit }, ...(coverage ? { coverage } : {}) }, () => { guard(); if (this.#service !== service) throw new Error("Goal configuration store changed"); });
      guard();
      if (service.store.readBudgetPool(declaration.poolScope)?.limit !== declaration.limit) throw new Error("Goal budget limit confirmation unavailable");
    },
  };
  constructor(readonly ports:Ports){}
  load(host:Host):void {
    let failure: unknown;
    try { this.#stopAcquisitions(Error("Budget source was replaced")); } catch (error) { failure = error; }
    try { this.#service?.store.close(); } catch (error) { failure ??= error; }
    finally {
      this.#receiptRoute=undefined;this.#coverageOwner=randomUUID();this.#sendFrozen=true;this.#closing=undefined;this.#epoch++;
      this.#service=undefined;this.#host=undefined;this.#opening=undefined;this.#unavailable=undefined;this.#unfencedOrdinary=false;this.#restored.clear();
    }
    if (failure) throw failure;
    this.#host=host;this.#sendFrozen=false;
  }
  shutdown():void {
    let failure: unknown;
    try { this.#stopAcquisitions(Error("Budget source shut down")); } catch (error) { failure = error; }
    try {
      const closing=this.#closing;
      if(closing&&closing.host===this.#host&&!closing.finished){
        closing.retired=true;if(failure)closing.prepared=false;
        if(failure||!closing.facts.length||closing.store!==this.#service?.store)this.#service?.store.close();
      } else this.#service?.store.close();
    } catch(error) { failure ??= error; }
    finally {this.#sendFrozen=true;this.#epoch++;this.#service=undefined;this.#host=undefined;this.#restored.clear();}
    if(failure)throw failure;
  }

  #current():Host {const host=this.#host;if(!host)throw new Error("Native recovery host unavailable");this.ports.assert(host.scope);return host;}
  #databaseExists():boolean {
    const host=this.#current(),hash=(s:string)=>createHash("sha256").update(s).digest("hex");
    return existsSync(join(this.ports.dataRoot(),"pi-graph-next","native-recovery","v1",hash(realpathSync(host.cwd)),hash(host.manager.getSessionId()),"facts.sqlite"));
  }
  async ready(required=false):Promise<void> {
    const host=this.#host,epoch=this.#epoch;
    const releaseOwned=(service:{store:NativeRecoveryStore}|undefined)=>{
      if(!service||this.#host!==host||this.#epoch!==epoch||this.#service!==service)return;
      this.#service=undefined;
      try { service.store.close(); } catch { /* Preserve the original source failure. */ }
    };
    if(this.#service){
      const service=this.#service;
      try { this.#current(); } catch(error) { releaseOwned(service);throw error; }
      return;
    }
    this.#current();
    if(!host)throw new Error("Native recovery host unavailable");
    this.#opening??=(async()=>{const result=await openNativeRecoveryStore({dataRoot:this.ports.dataRoot(),workspace:host.cwd,sessionId:host.manager.getSessionId()});
      let transferred=false;
      try {
        this.ports.assert(host.scope);if(epoch!==this.#epoch)throw new Error("Native recovery source changed while loading");
        if(!result.available){this.#unavailable=result.reason;if(result.kind==="capability-unavailable"&&!this.#databaseExists()){this.#unfencedOrdinary=true;return;}throw new Error(result.reason);}
        this.#service={store:result.store,owner:new NativeRecoveryOwner(result.store),recovery:new ClosedSettlementRecovery(result.store)};
        transferred=true;
      } finally {
        if(result.available&&!transferred)result.store.close();
      }
    })();await this.#opening;
    const service=this.#service;
    try {
      if(this.#host!==host||this.#epoch!==epoch)throw new Error("Native recovery source changed while loading");
      this.#current();
    } catch(error) { releaseOwned(service);throw error; }
    if(!this.#service&&(required||this.#databaseExists()))throw new Error(this.#unavailable??"Native recovery unavailable");
  }
  /** Read-only fresh-slot selection. The existing transition transaction remains the only commit authority. */
  selectFreshTaskIdStart(minimum: number, count: number): number {
    if (!Number.isSafeInteger(minimum) || minimum < 1 || !Number.isSafeInteger(count) || count < 1) {
      throw new Error("Fresh Task allocation requires positive safe integer bounds");
    }
    const host = this.#current(), epoch = this.#epoch, service = this.#service;
    const assertCurrent = () => {
      if (this.#current() !== host || this.#epoch !== epoch || this.#service !== service) {
        throw new Error("Fresh Task allocation source changed");
      }
    };
    const assertRange = (start: number) => {
      // Also reserve a representable next cursor; failed selection never advances it.
      if (!Number.isSafeInteger(start + count)) throw new Error("Fresh Task allocation exceeds safe integer range");
    };
    assertRange(minimum);
    if (!service) {
      // Preserve only the original confirmed missing-SQLite/no-DB compatibility case.
      if (!this.#unfencedOrdinary || this.#databaseExists()) {
        throw new Error(this.#unavailable ?? "Native recovery not initialized; await ready before Task allocation");
      }
      assertCurrent(); return minimum;
    }
    let start = minimum;
    for (;;) {
      assertCurrent(); assertRange(start);
      let occupied = false;
      for (let offset = 0; offset < count; offset++) {
        assertCurrent();
        const head = service.store.read(String(start + offset));
        assertCurrent();
        // A hidden tombstone is not permission for ordinary fresh-ID reuse.
        if (head) { start += offset + 1; occupied = true; break; }
      }
      if (!occupied) { assertCurrent(); return start; }
    }
  }
  #required(){if(!this.#service)throw new Error(this.#unavailable??"Native recovery unavailable: durable storage has not initialized");return this.#service;}
  holdPlanReplacement() {
    const host = this.#current(), owner = this.#required().owner;
    const held = owner.holdPlanReplacement();
    const current = () => { if (host !== this.#current() || owner !== this.#required().owner) throw new Error("Replacement native scope changed"); };
    return {
      witnessId: held.witnessId,
      sample: (slots: readonly string[]) => { current(); return owner.samplePlanReplacementBefore(slots, held.token); },
      assertBefore: (pins: readonly NativeBeforePin[]) => { current(); owner.assertPlanReplacementBefore(pins, held.token); },
      readAfter: (receipt: PlanReplacementReceipt) => { current(); return owner.readPlanReplacementAfter(receipt.nativeBefore, receipt.id, receipt.requestDigest, held.token); },
      transition: (receipt: PlanReplacementReceipt, after: ReadonlyMap<string, TodoTask>, publication: TodoPublication, semanticDigest: string, assertCurrent: () => void) => {
        current();
        const branch = host.manager.getBranch(), anchor = host.manager.getLeafId?.() ?? branch.at(-1)?.id;
        const latest = branch.filter(entry => entry.type === "custom" && entry.customType === "pi-graph-next:todo-state").at(-1);
        if (!anchor || !latest?.id || anchor !== branch.at(-1)?.id) throw new Error("Replacement native canonical reservation unavailable");
        const source: PlanReplacementIntent["source"] = { workspace: realpathSync(host.cwd), sessionId: host.manager.getSessionId(), anchor,
          prefixIdentityHashes: branch.map(entry => fingerprint({id: entry.id, parentId: entry.parentId, type: entry.type, customType: entry.customType})),
          beforeEntryId: latest.id, beforeEntryDigest: fingerprint({id: latest.id, data: latest.data}), normalizedBeforeDigest: fingerprint(latest.data) };
        const changes = [...receipt.request.oldTaskPins.map(pin => ({ before: this.contract(this.ports.tasks().get(pin.id)!), after: this.contract(after.get(pin.id)!), kind: "supersede" as const })),
          ...receipt.reservedIds.map(id => ({ after: { ...this.contract(after.get(id)!), planPin: fingerprint(receipt.successor.plan) }, kind: "create" as const }))];
        const intent: PlanReplacementIntent = { replacementId: receipt.id, requestDigest: receipt.requestDigest, source,
          predecessor: receipt.predecessor, successor: receipt.successor, nativeBefore: receipt.nativeBefore,
          publication: { ...structuredClone(publication), stateDigest: fingerprint(publication.state), semanticDigest } };
        return owner.planReplacementTransition(changes, intent, held.token, () => { current(); assertCurrent(); this.assertReplacementSource(intent); });
      },
      release: held.release,
    };
  }
  holdTaskClear() {
    const host=this.#current(),owner=this.#required().owner,held=owner.holdTaskClear();
    const current=()=>{if(this.#current()!==host)throw new Error("Task clear native source changed");};
    return {witnessId:held.witnessId,
      sample:(slots:readonly string[])=>{current();return owner.sampleTaskClearBefore(slots,held.token);},
      assertBefore:(pins:readonly NativeBeforePin[])=>{current();owner.assertTaskClearBefore(pins,held.token);},
      readAfter:(r:TaskClearRecord)=>{current();const witness=owner.readTaskClearAfter(r.nativeBefore,r.id,r.requestDigest,held.token);if(witness)this.assertClearWitnessSource(witness);return witness;},
      transition:(r:TaskClearRecord,publication:TodoPublication,guard:()=>void)=>{
        current();const branch=host.manager.getBranch(),entry=branch.filter(e=>e.type==="custom"&&e.customType==="pi-graph-next:todo-state").at(-1);
        if(!entry?.id)throw new Error("Task clear canonical reservation unavailable");
        const intent:TaskClearIntent={clearId:r.id,requestDigest:r.requestDigest,nativeBefore:r.nativeBefore,
          source:{workspace:realpathSync(host.cwd),sessionId:host.manager.getSessionId(),prefixIdentityHashes:branch.map(e=>fingerprint({id:e.id,parentId:e.parentId,type:e.type,customType:e.customType})),beforeEntryId:entry.id,beforeEntryDigest:fingerprint({id:entry.id,data:entry.data})},
          publication:{...structuredClone(publication),stateDigest:fingerprint(publication.state)}};
        const contracts=r.members.filter(m=>!m.body.origin).map(m=>this.contract(this.ports.tasks().get(m.id)!));
        return owner.taskClearTransition(contracts,intent,held.token,()=>{current();guard();this.assertClearWitnessSource(intent);});
      },release:held.release};
  }
  assertClearWitnessSource(intent:TaskClearIntent):void {
    const host=this.#current(),branch=host.manager.getBranch(),source=intent.source;
    if(realpathSync(host.cwd)!==source.workspace || host.manager.getSessionId()!==source.sessionId || branch.length<source.prefixIdentityHashes.length
      || branch.slice(0,source.prefixIdentityHashes.length).some((e,i)=>fingerprint({id:e.id,parentId:e.parentId,type:e.type,customType:e.customType})!==source.prefixIdentityHashes[i]))throw new Error("Task clear native original prefix changed");
    const entries=branch.filter(e=>e.id===source.beforeEntryId);
    if(entries.length!==1 || fingerprint({id:entries[0]!.id,data:entries[0]!.data})!==source.beforeEntryDigest)throw new Error("Task clear native reservation changed");
  }
  assertReplacementSource(witness: PlanReplacementIntent): void {
    const host = this.#current(), branch = host.manager.getBranch(), source = witness.source;
    if (realpathSync(host.cwd) !== source.workspace || host.manager.getSessionId() !== source.sessionId || branch.length < source.prefixIdentityHashes.length
      || branch.slice(0, source.prefixIdentityHashes.length).some((entry, i) => fingerprint({id: entry.id, parentId: entry.parentId, type: entry.type, customType: entry.customType}) !== source.prefixIdentityHashes[i])) throw new Error("Replacement native source prefix changed");
    const before = branch.find(entry => entry.id === source.beforeEntryId);
    if (!before || fingerprint({id: before.id, data: before.data}) !== source.beforeEntryDigest) throw new Error("Replacement canonical reservation body changed");
  }
  contract(task:TodoTask):RecoveryContract { return this.#contract(task, false); }
  #contract(task:TodoTask, initialEmptyRoot:boolean):RecoveryContract {
    const host=this.#current(),branch=host.manager.getBranch();
    const leaf=host.manager.getLeafId ? host.manager.getLeafId() : branch.at(-1)?.id;
    const empty=initialEmptyRoot && branch.length===0 && leaf===null;
    if ((!empty && (!leaf || leaf!==branch.at(-1)?.id)) || !task.taskInstanceId || !task.contractVersion) throw new Error("Native recovery requires canonical Task/source identity");
    const source={workspace:realpathSync(host.cwd),sessionId:host.manager.getSessionId(),branchAnchor:leaf??""};
    const group=this.ports.groups().find(group=>group.id===task.deliveryGroupId);
    return jsonCopy({taskId:task.id,instanceId:task.taskInstanceId,submissionId:task.dispatchSubmissionId??"",version:task.contractVersion,digest:taskBusinessContractDigest(task),
      input:taskExecutionInput(task),inputDigest:taskExecutionInputDigest(task),output:taskOutputValues(task),source,...(group?.approvedPlan?{planPin:fingerprint(group.approvedPlan)}:{})});
  }
  assertBusinessTask(task: TodoTask): void {
    this.ports.assertTask?.(task);
    assertTaskReplacementEligible(task);
    const group=this.ports.groups().find(group=>group.id===task.deliveryGroupId);
    if (group?.supersedes || group?.currentPendingReplacementId || group?.replacementHistory?.length) this.#plan(task);
  }
  #plan(task:TodoTask):void {
    this.ports.assertTask?.(task);
    if (pendingPlanReplacement(this.ports.groups())) throw new Error("plan-replacement-pending: all native business operations held");
    assertTaskReplacementEligible(task);
    const group=this.ports.groups().find(group=>group.id===task.deliveryGroupId);if(!group?.approvedPlan)return;
    this.assertApprovedPlan(group.approvedPlan);
  }
  assertApprovedPlan(pin: {handoffKey:string;revision:number;checksum:string}): void {
    const host=this.#current();
    const store=new PlanStore(host.cwd,{session:{id:host.manager.getSessionId()}}),stat=lstatSync(store.manifestPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1_000_000)throw new Error("Native recovery approved Plan manifest unavailable");
    const raw:unknown=JSON.parse(readFileSync(store.manifestPath,"utf8"));
    if(!raw||typeof raw!=="object")throw new Error("Native recovery Plan manifest malformed");
    const m=raw as Record<string,unknown>;
    if(m.status!=="approved"||m.revision!==pin.revision||m.handoffKey!==pin.handoffKey||m.approvedChecksum!==pin.checksum||typeof m.approvedPath!=="string")throw new Error("Native recovery approved Plan changed");
    const archive=join(store.plansDir,m.approvedPath),rel=relative(store.plansDir,archive);
    if(rel.startsWith("..")||isAbsolute(rel))throw new Error("Native recovery approved Plan archive path invalid");
    const actual=realpathSync(archive),actualRel=relative(realpathSync(store.plansDir),actual),info=lstatSync(archive);
    if(actualRel.startsWith("..")||isAbsolute(actualRel)||!info.isFile()||info.isSymbolicLink()||info.size>5_000_000||createHash("sha256").update(readFileSync(archive)).digest("hex")!==pin.checksum)throw new Error("Native recovery approved Plan archive changed");
  }
  /** Called by M03 before its own journal write; metadata-only projections do not change the native head. */
  beforeCommit(before:ReadonlyMap<string,TodoTask>,after:ReadonlyMap<string,TodoTask>,publication?:GoalDetachPublication):GoalDetachJournalOnly|undefined {

    const host=this.#current();
    const initialEmptyRoot=before.size===0 && after.size>0 && !!this.#service
      && host.manager.getBranch().length===0 && host.manager.getLeafId?.()===null
      && [...after.values()].every(task=>!task.origin && !task.dispatchSubmissionId && !this.#service!.store.read(task.id));
    const assertInitialRoot=()=>{this.#current();if(initialEmptyRoot && (host!==this.#host || host.manager.getBranch().length!==0 || host.manager.getLeafId?.()!==null)) throw new Error("Native recovery initial empty root changed before publication");};
    const changes:RecoveryTransition[]=[];
    for(const id of new Set([...before.keys(),...after.keys()])){
      const old=before.get(id),next=after.get(id);if(old?.origin||next?.origin)continue;
      const a=old&&this.contract(old),b=next&&this.#contract(next,initialEmptyRoot);
      if(a&&b&&a.instanceId===b.instanceId&&a.submissionId===b.submissionId&&a.version===b.version&&a.digest===b.digest&&(old?.status==="deleted")===(next?.status==="deleted")&&!(old?.status==="completed"&&next?.status!=="completed"))continue;
      const kind=!next||next.status==="deleted"?"delete":next.dispatchSubmissionId&&next.dispatchSubmissionId!==old?.dispatchSubmissionId?"admit":old?.taskInstanceId!==next.taskInstanceId?"create":old?.status==="completed"&&next.status!=="completed"?"reopen":"ordinary";
      const restored=next?.acceptanceReport?.execution;
      // A retained acceptance DTO cannot exempt delete/reopen from the durable fence.
      if(kind==="ordinary"&&next?.status==="completed"&&restored?.kind==="restored-closed"&&b){this.assert(restored,next);continue;}
      changes.push({before:a,after:b,kind,...(kind === "create" && !a ? {requireAbsent:true as const} : {})});
    }
    if(!changes.length)return;
    if(!this.#service){
      if(!this.#unfencedOrdinary||this.#databaseExists()||changes.some(change=>change.kind==="admit"))throw new Error(this.#unavailable??"Native recovery not initialized; await ready before semantic Task mutation");
      // Genuine missing-SQLite compatibility only; never evidence of a durable fence.
      return;
    }
    let intent: GoalDetachJournalIntent | undefined;
    if (publication && !publication.hasNewContents) {
      const host = this.#current(), branch = host.manager.getBranch();
      if (!Array.isArray(branch) || branch.some(entry => typeof entry.id !== "string" || !entry.id)) throw new Error("Native journal witness requires a canonical branch");
      const anchor = host.manager.getLeafId?.() ?? branch.at(-1)?.id ?? null;
      if (anchor !== (branch.at(-1)?.id ?? null)) throw new Error("Native journal witness branch leaf differs");
      const latest = branch.filter(entry => entry.type === "custom" && entry.customType === "pi-graph-next:todo-state").at(-1);
      intent = {reason: "goal-detach", goalId: publication.goalId,
        source: {workspace: realpathSync(host.cwd), sessionId: host.manager.getSessionId(), anchor,
          prefix: branch.map(entry => fingerprint({id: entry.id, parentId: entry.parentId, type: entry.type, customType: entry.customType})),
          beforeEntryId: latest?.id ?? null, beforeEntryDigest: fingerprint(latest ? {id: latest.id, data: latest.data} : null)},
        normalizedBeforeDigest: publication.normalizedBeforeDigest, afterDigest: publication.afterDigest,
        afterSemanticDigest: publication.afterSemanticDigest, updatedAt: {...publication.updatedAt},
      };
      const replay = this.#service.owner.goalDetachJournalOnly(changes, intent);
      if (replay) {
        const originalHost = host;
        return {updatedAt: {...replay.witness.updatedAt}, afterDigest: replay.witness.afterDigest,
          assertCurrent: () => {if (this.#current() !== originalHost) throw new Error("Native journal witness source changed"); const current = originalHost.manager.getBranch();
            if (current.length < intent!.source.prefix.length || current.slice(0, intent!.source.prefix.length).some((entry, index) => fingerprint({id: entry.id, parentId: entry.parentId, type: entry.type, customType: entry.customType}) !== intent!.source.prefix[index])) throw new Error("Native journal witness prefix changed");
            const beforeEntry = current.find(entry => entry.id === intent!.source.beforeEntryId);
            if (fingerprint(beforeEntry ? {id: beforeEntry.id, data: beforeEntry.data} : null) !== intent!.source.beforeEntryDigest) throw new Error("Native journal witness canonical before changed");
            replay.assertCurrent();}};
      }
    }
    this.#service.owner.transitions(changes,assertInitialRoot,intent);
    for(const {before,after} of changes)this.#restored.delete((after??before)!.taskId);
  }
  #coverageIdentity(scope: GoalBudgetScope, declaration: GoalBudgetDeclaration): CoverageOpen | undefined {
    const info = this.ports.goalBudget?.coverageInfo?.(scope);
    if (!info?.required) return undefined;
    if (!info.birth || !info.hostEpoch) throw new Error("Original budget coverage epoch unavailable");
    return { scope: declaration.poolScope, ownerId: this.#coverageOwner, hostEpoch: info.hostEpoch, birth: info.birth, coverageVersion: 1 };
  }
  #journalCut(host: Host): CoverageJournalCut {
    const file = host.manager.getSessionFile?.();
    if (!file || !isAbsolute(file)) throw new Error("Coverage journal is not durably available");
    const stat = lstatSync(file), canonical = realpathSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || canonical !== file) throw new Error("Coverage journal identity changed");
    const bytes = readFileSync(file), rows = bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const header = rows[0], branch = host.manager.getBranch(), leaf = host.manager.getLeafId?.() ?? branch.at(-1)?.id;
    if (header?.type !== "session" || header.id !== host.manager.getSessionId() || typeof header.cwd !== "string"
      || realpathSync(header.cwd) !== realpathSync(host.cwd) || !leaf || branch.at(-1)?.id !== leaf) throw new Error("Coverage journal session/branch changed");
    // Physical JSONL includes other branches. Reconstruct only this original
    // leaf's parent chain, then compare its full durable entries with the SDK
    // cache. An unchanged inode/header does not attest unchanged history.
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows.slice(1)) {
      if (typeof row.id !== "string" || byId.has(row.id)
        || (row.parentId !== null && typeof row.parentId !== "string")) throw new Error("Coverage durable journal entry identity changed");
      byId.set(row.id, row);
    }
    const durableBranch: Record<string, unknown>[] = [], visited = new Set<string>();
    let cursor: string | null = leaf;
    while (cursor !== null) {
      if (visited.has(cursor)) throw new Error("Coverage durable journal branch is cyclic");
      visited.add(cursor);
      const entry = byId.get(cursor);
      if (!entry) throw new Error("Coverage durable journal branch is incomplete");
      durableBranch.unshift(entry); cursor = entry.parentId as string | null;
    }
    if (fingerprint(durableBranch) !== fingerprint(branch)) throw new Error("Coverage durable journal differs from the original SDK branch");
    return { path: canonical, device: String(stat.dev), inode: String(stat.ino), bytes: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex"), leafId: leaf,
      branchDigest: fingerprint(branch.map(e => ({ id:e.id,parentId:e.parentId,type:e.type,customType:e.customType }))) };
  }
  #confirmBody(epoch: CoverageEpoch) {
    return { version: 1, coverageVersion: 1, epochKey: budgetPoolKey(epoch.scope), generation: epoch.generation, sealId: epoch.seal!.id, sealDigest: fingerprint(epoch) };
  }
  #validateConfirmed(host: Host, epoch: CoverageEpoch, peers: readonly CoverageEpoch[] = []): void {
    if (epoch.phase !== "sealed" || !epoch.seal) throw new Error("Coverage epoch was not cleanly sealed");
    const cut = epoch.seal.cut, now = this.#journalCut(host), bytes = readFileSync(now.path);
    if (now.path !== cut.path || now.device !== cut.device || now.inode !== cut.inode || bytes.length < cut.bytes
      || createHash("sha256").update(bytes.subarray(0,cut.bytes)).digest("hex") !== cut.digest) throw new Error("Original coverage journal cutoff changed");
    const suffix = bytes.subarray(cut.bytes).toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const confirm = suffix[0], expected = this.#confirmBody(epoch), branch = host.manager.getBranch();
    const leafIndex = branch.findIndex(e => e.id === cut.leafId);
    if (!confirm || confirm.type !== "custom" || confirm.customType !== COVERAGE_CONFIRM || confirm.parentId !== cut.leafId
      || fingerprint(confirm.data) !== fingerprint(expected) || leafIndex < 0 || branch[leafIndex+1]?.id !== confirm.id
      || fingerprint(branch.slice(0,leafIndex+1).map(e => ({id:e.id,parentId:e.parentId,type:e.type,customType:e.customType}))) !== cut.branchDigest) {
      throw new Error("Coverage seal has no exact original journal confirmation");
    }
    let offset = cut.bytes + Buffer.byteLength(JSON.stringify(confirm)) + 1;
    // SDK JSONL formatting is canonical for these original entries. Use the
    // actual line lengths for offsets, never a caller-supplied journal locator.
    const suffixLines=bytes.subarray(cut.bytes).toString("utf8").split("\n").filter(Boolean);
    offset=cut.bytes+Buffer.byteLength(suffixLines[0]!)+1;
    for (let index=1;index<suffix.length;index++) {
      const entry=suffix[index]!;
      if(entry.type==="custom"&&entry.customType===COVERAGE_CONFIRM){
        const peer=peers.find(value=>value.phase==="sealed"&&value.seal?.cut.bytes===offset&&value.scope.workspace===epoch.scope.workspace
          &&value.scope.sessionId===epoch.scope.sessionId&&value.hostEpoch===epoch.hostEpoch&&fingerprint(entry.data)===fingerprint(this.#confirmBody(value)));
        const peerLeaf=peer&&branch.findIndex(value=>value.id===peer.seal!.cut.leafId);
        if(!peer||peerLeaf===undefined||peerLeaf<0||entry.parentId!==peer.seal!.cut.leafId
          ||createHash("sha256").update(bytes.subarray(0,offset)).digest("hex")!==peer.seal!.cut.digest
          ||fingerprint(branch.slice(0,peerLeaf+1).map(e=>({id:e.id,parentId:e.parentId,type:e.type,customType:e.customType})))!==peer.seal!.cut.branchDigest)throw new Error("Coverage tail contains an unissued peer Goal confirmation");
      }else{
        const common=["id","parentId","timestamp","type"];
        const allowed=entry.type==="model_change"?[...common,"provider","modelId"]:entry.type==="thinking_level_change"?[...common,"thinkingLevel"]:undefined;
        if (!allowed || Object.keys(entry).some(key=>!allowed.includes(key))) throw new Error("Coverage journal contains an unverified post-seal tail");
      }
      offset+=Buffer.byteLength(suffixLines[index]!)+1;
    }
    const birth = branch.find(e=>e.id===epoch.birth.entryId);
    if (!birth || fingerprint(birth)!==epoch.birth.digest) throw new Error("Coverage seal belongs to another Goal birth");
  }
  #validateTail(host:Host, cut:CoverageJournalCut, peers:readonly CoverageEpoch[]):string | undefined {
    const current=this.#journalCut(host),bytes=readFileSync(current.path),branch=host.manager.getBranch();
    if(current.path!==cut.path||current.device!==cut.device||current.inode!==cut.inode||bytes.length<cut.bytes
      ||createHash("sha256").update(bytes.subarray(0,cut.bytes)).digest("hex")!==cut.digest)throw new Error("Original late coverage cutoff changed");
    const leaf=branch.findIndex(e=>e.id===cut.leafId);
    if(leaf<0||fingerprint(branch.slice(0,leaf+1).map(e=>({id:e.id,parentId:e.parentId,type:e.type,customType:e.customType})))!==cut.branchDigest)
      return "Current branch does not contain the original coverage cutoff";
    let offset=cut.bytes,previous=cut.leafId;
    for(const line of bytes.subarray(cut.bytes).toString("utf8").split("\n").filter(Boolean)){
      const entry=JSON.parse(line) as Record<string,unknown>;
      if(entry.parentId!==previous||!branch.some(row=>row.id===entry.id&&fingerprint(row)===fingerprint(entry)))throw new Error("Late coverage tail left the original branch");
      if(entry.type==="custom"&&entry.customType===COVERAGE_CONFIRM){
        const peer=peers.find(e=>e.phase==="sealed"&&e.seal?.cut.bytes===offset&&e.seal.cut.leafId===previous&&fingerprint(this.#confirmBody(e))===fingerprint(entry.data));
        if(!peer||peer.scope.workspace!==realpathSync(host.cwd)||peer.scope.sessionId!==host.manager.getSessionId()
          ||createHash("sha256").update(bytes.subarray(0,offset)).digest("hex")!==peer.seal!.cut.digest)
          throw new Error("Late coverage tail has no issued peer confirmation");
        const actual=this.#required().store.readCoverage(peer.scope);
        if(!actual||!(fingerprint(actual)===fingerprint(peer)||(actual.parentSeal?.id===peer.seal!.id&&actual.parentSeal.digest===fingerprint(peer))))
          throw new Error("Late coverage peer confirmation was replaced");
      }else{
        const common=["id","parentId","timestamp","type"],allowed=entry.type==="model_change"?[...common,"provider","modelId"]:entry.type==="thinking_level_change"?[...common,"thinkingLevel"]:undefined;
        if(!allowed||Object.keys(entry).some(k=>!allowed.includes(k)))return "Coverage is pending: the journal has an unverified post-publication tail";
      }
      previous=String(entry.id);offset+=Buffer.byteLength(line)+1;
    }
  }
  readonly coverageContinuity = {
    bindReceiptRoute: (route:NativeBudgetReceiptRoute):void => {this.#current();if(this.#receiptRoute)throw new Error("Budget receipt route already bound");this.#receiptRoute=route;},
    readReceiptInstruction: (instruction:object):unknown => this.#receiptValue(instruction),
    acceptReceipt: (envelope:object):void => this.#acceptReceipt(envelope),
    receiptStatus: (handle:object):Readonly<{recorded:boolean;coverage:"pending"|"adopted"|"unchanged";reason?:string}> => {
      const binding=this.#receiptBindings.get(handle);if(!binding)throw new Error("Unissued original receipt status");
      return Object.freeze({...binding.status});
    },
    capture: (publish: (committed: object) => void, readPoint: (point: object) => { readonly manager: object; readonly pending: number }): object => {
      const host=this.#current();this.#sendFrozen=true;
      try { this.#stopAcquisitions(Error("Budget admission is closing")); }
      catch(error) { try { this.shutdown(); } catch {} throw error; }
      const facts=this.ports.goalBudget?.captureCoverageClose?.()??[];
      const record:CoverageClosing={host,sourceEpoch:this.#epoch,ownerId:this.#coverageOwner,facts,publish,readPoint,prepared:false,retired:false,finished:false,peers:[]};
      const token=Object.freeze({});this.#closingHandles.set(token,record);this.#closingByHost.set(host,record);this.#closing=record;this.#sendFrozen=true;return token;
    },
    prepare: async (token:object):Promise<void> => {
      const r=this.#closingHandles.get(token);if(!r||r.finished||r.retired||this.#current()!==r.host||this.#epoch!==r.sourceEpoch)throw new Error("Unissued coverage close preparation");
      if(!r.facts.length){r.prepared=true;return;}
      await this.ready(true);if(this.#current()!==r.host||this.#epoch!==r.sourceEpoch)throw new Error("Coverage source changed during close preparation");
      r.store=this.#required().store;
      for(const fact of r.facts){
        const declaration=this.ports.goalBudget!.read(fact.scope,"fact");
        if(fingerprint(declaration.poolScope)!==fingerprint(fact.poolScope))throw new Error("Coverage closing pool changed");
        const prior=r.store.readCoverage(fact.poolScope),pool=r.store.readBudgetPool(fact.poolScope);
        if(!prior&&!pool&&!fact.initialized)r.store.transactCoverage({kind:"open",expectedRevision:0,open:{scope:fact.poolScope,ownerId:r.ownerId,hostEpoch:fact.hostEpoch,birth:fact.birth,coverageVersion:1}},()=>{this.#current();this.ports.goalBudget!.read(fact.scope,"fact");});
      }
      r.prepared=true;
    },
    publication: (token:object):void => {
      const r=this.#closingHandles.get(token);if(!r||r.finished||r.retired||!r.prepared||this.#current()!==r.host)throw new Error("Coverage final publication is not owned");
      for(const fact of r.facts)this.ports.goalBudget!.read(fact.scope,"fact");
      if(r.facts.length)r.publication=this.#journalCut(r.host);
    },
    committed: (handle:object,manager:object) => {
      const value=this.#committedCoverage.get(handle);
      if(!value||value.closing.finished||value.closing.host.manager!==manager||!value.epoch.seal)throw new Error("Unissued committed coverage seal");
      return this.#confirmBody(value.epoch);
    },
    finalize: (token:object,point:object):void => {
      const r=this.#closingHandles.get(token);if(!r||r.finished)throw new Error("Unissued coverage finalization");
      try{
        const final=r.readPoint(point);r.point=point;
        if(final.manager!==r.host.manager||final.pending!==0||!r.retired||!r.prepared) return;
        if(!r.facts.length)return;
        if(!r.store||!r.publication)throw new Error("Coverage closing publication is incomplete");
        const current=this.#journalCut(r.host);
        if(current.path!==r.publication.path||current.device!==r.publication.device||current.inode!==r.publication.inode||current.bytes<r.publication.bytes)throw new Error("Coverage final journal changed");
        if(createHash("sha256").update(readFileSync(current.path).subarray(0,r.publication.bytes)).digest("hex")!==r.publication.digest)throw new Error("Coverage final journal publication prefix changed");
        for(const fact of r.facts){
          const pool=r.store.readBudgetPool(fact.poolScope), balance=pool&&inspectBudgetPool(pool);
          if(pool&&(pool.history.kind!=="known"||balance!.held!==0n||pool.reservations.some(x=>x.phase!=="settled"&&x.phase!=="released")||balance!.blockedBy==="usage-unknown"||balance!.blockedBy==="historical-usage-unknown"))continue;
          const epoch=r.store.readCoverage(fact.poolScope);
          if(!epoch||epoch.phase!=="open"||epoch.ownerId!==r.ownerId||epoch.hostEpoch!==fact.hostEpoch||fingerprint(epoch.birth)!==fingerprint(fact.birth))continue;
          const cut=this.#journalCut(r.host);
          const sealed=r.store.transactCoverage({kind:"seal",scope:fact.poolScope,expectedRevision:epoch.revision,ownerId:r.ownerId,hostEpoch:fact.hostEpoch,sealId:randomUUID(),cut},()=>{if(r.finished||!r.retired||r.readPoint(point).pending!==0)throw new Error("Coverage final owner changed");});
          const handle=Object.freeze({});this.#committedCoverage.set(handle,{closing:r,epoch:sealed});
          try{r.publish(handle);this.#validateConfirmed(r.host,sealed);r.peers.push(sealed);}finally{this.#committedCoverage.delete(handle);}
        }
      }finally{r.finished=true;r.store?.close();r.store=undefined;}
    },
    resume: async ():Promise<void> => {
      const host=this.#current(), generation=this.#epoch, candidates=this.ports.goalBudget?.restoredCoverage?.()??[];
      if(!candidates.length||!this.#databaseExists())return;
      await this.ready(true);
      this.#resumeCoverage(host,generation,candidates);
    },
    readAdoption: (handle:object,manager:object):GoalCoverageAdoption => {
      const value=this.#coverageAdoptions.get(handle);
      if(!value||value.host!==this.#current()||value.epoch!==this.#epoch||value.host.manager!==manager)throw new Error("Unissued native coverage adoption");
      return jsonCopy(value.value);
    },
  };
  #resumeCoverage(host: Host, generation: number, candidates = this.ports.goalBudget?.restoredCoverage?.() ?? []): void {
      const peers=candidates.map(candidate=>this.#required().store.readCoverage(candidate.poolScope)).filter((value):value is CoverageEpoch=>Boolean(value?.phase==="sealed"));
      for(const candidate of candidates){
        this.#current();if(this.#epoch!==generation)throw new Error("New coverage source was replaced");
        const store=this.#required().store,epoch=store.readCoverage(candidate.poolScope);if(!epoch||epoch.phase!=="sealed"||!epoch.seal)continue;
        this.#validateConfirmed(host,epoch,peers);
        store.transactCoverage({kind:"claim",scope:candidate.poolScope,expectedRevision:epoch.revision,sealId:epoch.seal.id,ownerId:this.#coverageOwner,hostEpoch:candidate.hostEpoch},()=>{this.#current();if(this.#epoch!==generation)throw new Error("Coverage claim source changed");this.#validateConfirmed(host,epoch,peers);});
        const handle=Object.freeze({});this.#coverageAdoptions.set(handle,{host,epoch:generation,value:{poolScope:epoch.scope,birth:epoch.birth,initialized:Boolean(epoch.seal.pool)}});
        this.ports.goalBudget!.adoptCoverage!(handle);
        this.#notifyBudget(candidate.poolScope.goalId);
      }
  }
  #bindMarkedReceipt(handle: object, host: Host, store: NativeRecoveryStore, scope: GoalBudgetDeclaration["poolScope"], identity: BudgetReservationInput, coverage?: CoverageOpen): void {
    const route=this.#receiptRoute;
    if(!route)return; // Original non-SDK fixtures keep their existing guarded fact path.
    const journal=this.#journalCut(host), stat=lstatSync(store.path);
    this.#receiptBindings.set(handle,{host,store,scope,identity,coverage,route,journal,
      dataRoot:realpathSync(this.ports.dataRoot()),device:String(stat.dev),inode:String(stat.ino),status:{recorded:false,coverage:"pending"}});
  }
  #routeReceipt(handle: object, command: ReceiptCommand): boolean {
    const binding=this.#receiptBindings.get(handle);
    if(!binding)return false;
    const instruction=Object.freeze({});this.#receiptInstructions.set(instruction,{binding,command});
    try{binding.route.route(instruction);}finally{this.#receiptInstructions.delete(instruction);}
    return true;
  }
  #receiptValue(instruction: object): ReceiptInstruction {
    const issued=this.#receiptInstructions.get(instruction);
    if(!issued)throw new Error("Unissued original budget receipt instruction");
    const closing=this.#closingByHost.get(issued.binding.host);
    return {...issued,...(closing?.finished&&closing.retired&&closing.prepared&&closing.point&&closing.publication
      ?{closed:{point:closing.point,publication:closing.publication,peers:closing.peers}}:{})};
  }
  #acceptReceipt(envelope: object): void {
    const route=this.#receiptRoute,host=this.#current();
    if(!route)throw new Error("Current budget receipt host is not ready");
    const envelopeValue=route.read(envelope), value=envelopeValue.value as ReceiptInstruction | undefined;
    if(!value?.binding||!value.command||value.command.kind!=="record-receipt")throw new Error("Invalid original budget receipt instruction");
    const b=value.binding;
    const domain=()=>{
      if(this.#current()!==host||this.#receiptRoute!==route
        ||envelopeValue.manager!==host.manager||b.host.manager!==host.manager
        ||b.scope.sessionId!==host.manager.getSessionId()||b.scope.workspace!==realpathSync(host.cwd)
        ||b.dataRoot!==realpathSync(this.ports.dataRoot()))throw new Error("Original budget receipt belongs to another current durable domain");
      const db=lstatSync(b.store.path),journal=lstatSync(b.journal.path),bytes=readFileSync(b.journal.path);
      if(!db.isFile()||db.isSymbolicLink()||realpathSync(b.store.path)!==b.store.path||String(db.dev)!==b.device||String(db.ino)!==b.inode
        ||host.manager.getSessionFile?.()!==b.journal.path||!journal.isFile()||journal.isSymbolicLink()
        ||realpathSync(b.journal.path)!==b.journal.path||String(journal.dev)!==b.journal.device||String(journal.ino)!==b.journal.inode||bytes.length<b.journal.bytes
        ||createHash("sha256").update(bytes.subarray(0,b.journal.bytes)).digest("hex")!==b.journal.digest)
        throw new Error("Original budget receipt database or journal identity changed");
    };
    domain();
    if(!this.#service){
      if(this.#sendFrozen)throw new Error("Closing budget receipt requires its already-open store");
      if(this.#opening)throw new Error("Current budget receipt store is not ready");
      const fresh=b.store.reopenClosed();
      try{domain();this.#service={store:fresh,owner:new NativeRecoveryOwner(fresh),recovery:new ClosedSettlementRecovery(fresh)};}
      catch(error){fresh.close();throw error;}
    }
    const service=this.#required(),store=service.store;
    const guard=()=>{domain();if(this.#service!==service||store.path!==b.store.path)throw new Error("Current receipt store was replaced");};
    guard();
    const pool=store.readBudgetPool(b.scope), reservation=pool?.reservations.find(r=>r.reservationId===b.identity.reservationId);
    if(!pool||!reservation||["requestKey","sourceHash","attemptKey","reservedUnits"].some(k=>Reflect.get(reservation,k)!==Reflect.get(b.identity,k)))
      throw new Error("Original marked budget request is unavailable");
    if (b.status.producer) this.#rememberProducer(b.scope, b.identity.reservationId, b.status.producer);
    const receipt=value.command.receipt,existing=pool.receipts.find(r=>r.receiptId===receipt.receiptId);
    if(existing){
      if(existing.reservationId!==b.identity.reservationId||existing.kind!==receipt.kind||existing.factRef!==receipt.factRef
        ||existing.digest!==receipt.digest||(existing.kind==="known"&&(receipt.kind!=="known"||existing.units!==receipt.units)))throw new Error("Original usage receipt identity changed");
      // The cost stays idempotent. A once-missing exact close proof may now be
      // available, so only the separate seal/adopt continuation is reconsidered.
      this.#continueReceiptCoverage(host,value,envelopeValue.continuousClosed,guard);return;
    }
    if(reservation.phase!=="may-have-sent"&&!(reservation.phase==="unknown"&&receipt.kind==="known"))throw new Error("Original request was not marked for this receipt");
    const epoch=store.readCoverage(b.scope);
    if(!epoch||!b.coverage||epoch.phase!=="open"||epoch.ownerId!==b.coverage.ownerId||epoch.hostEpoch!==b.coverage.hostEpoch
      ||fingerprint(epoch.birth)!==fingerprint(b.coverage.birth))throw new Error("Original receipt coverage epoch is sealed or replaced");
    this.#writeBudget(store,{scope:b.scope,expectedRevision:pool.revision,command:value.command,...(b.coverage?{coverage:b.coverage}:{})},guard);
    this.#continueReceiptCoverage(host,value,envelopeValue.continuousClosed,guard);
  }
  #continueReceiptCoverage(host:Host,value:ReceiptInstruction,continuousClosed:boolean,guard:()=>void):void {
    const status=value.binding.status;status.recorded=true;
    if(status.coverage==="adopted")return;
    if(this.#sendFrozen){status.reason="Cost recorded while admission is closing; no new coverage scope is issued";return;}
    if(value.binding.host===host&&this.#service?.store===value.binding.store){
      status.coverage="unchanged";delete status.reason;return; // Current epoch only; no Task or sending permit is created.
    }
    if(value.command.receipt.kind!=="known"){status.reason="Original request usage is still unknown";return;}
    if(!value.closed||!continuousClosed){status.reason="Original SDK close continuity proof is not ready";return;}
    // Only an expected capability/branch boundary becomes a pending reason.
    // Integrity, COMMIT uncertainty, publisher and claim failures still throw.
    const reason=this.#completeLateCoverage(host,value,guard);
    if(reason){status.reason=reason;return;}
    status.coverage="adopted";delete status.reason;
  }
  #completeLateCoverage(host: Host, value: ReceiptInstruction, guard:()=>void): string | undefined {
    const {binding:b,closed}=value;if(!closed||!b.coverage)return "Original coverage proof unavailable";
    const store=this.#required().store,epoch=store.readCoverage(b.scope),pool=store.readBudgetPool(b.scope);
    if(!epoch||!pool)throw new Error("Original late coverage pool or epoch disappeared");
    if(epoch.phase!=="open"||epoch.ownerId!==b.coverage.ownerId||epoch.hostEpoch!==b.coverage.hostEpoch
      ||fingerprint(epoch.birth)!==fingerprint(b.coverage.birth))return "Original epoch has already been sealed or replaced";
    const balance=inspectBudgetPool(pool);
    if(balance.held!==0n||balance.blockedBy||pool.history.kind!=="known"||pool.reservations.some(r=>r.phase!=="settled"&&r.phase!=="released"))return "Other original requests still need measured receipts";
    // Accounting is independent of branch adoption. A different branch or an
    // unverified suffix leaves the measured cost recorded but cannot mint proof.
    const candidates=this.ports.goalBudget?.restoredCoverage?.()??[];
    if(!candidates.some(c=>budgetPoolKey(c.poolScope)===budgetPoolKey(b.scope)))return "The current Goal source has no matching original birth to adopt";
    const cut=this.#journalCut(host),bytes=readFileSync(cut.path),original=closed.publication;
    if(cut.path!==original.path||cut.device!==original.device||cut.inode!==original.inode||bytes.length<original.bytes
      ||createHash("sha256").update(bytes.subarray(0,original.bytes)).digest("hex")!==original.digest)throw new Error("Original late coverage publication changed");
    const pending=this.#validateTail(host,original,closed.peers);if(pending)return pending;
    guard();
    const sealed=store.transactCoverage({kind:"seal",scope:b.scope,expectedRevision:epoch.revision,ownerId:epoch.ownerId,hostEpoch:epoch.hostEpoch,sealId:randomUUID(),cut},guard);
    const closing:CoverageClosing={host,sourceEpoch:this.#epoch,ownerId:epoch.ownerId,facts:[],publish:this.#receiptRoute!.publish,readPoint:()=>{throw new Error("No new final point");},prepared:true,retired:true,finished:false,peers:[]};
    const token=Object.freeze({});this.#committedCoverage.set(token,{closing,epoch:sealed});
    try{closing.publish(token);this.#validateConfirmed(host,sealed);}
    finally{closing.finished=true;this.#committedCoverage.delete(token);}
    this.#resumeCoverage(host,this.#epoch,candidates);
  }
  #goalCurrent(context: GoalRequestContext, facts = false): void {
    if (!facts && this.#sendFrozen) throw new Error("Goal budget issuer is closing; no new request can be sent");
    if (this.#current() !== context.host || this.#required().store !== context.store) throw new Error("Goal request store or source changed");
    const declaration = this.ports.goalBudget?.read(context.scope, facts ? "fact" : "send");
    if (!declaration || fingerprint(declaration.poolScope) !== fingerprint(context.declaration.poolScope)
      || (!facts && (declaration.limit !== context.declaration.limit || fingerprint(declaration.goalEntry) !== fingerprint(context.declaration.goalEntry)))) {
      throw new Error("Goal request declaration changed");
    }
    if (!facts) this.ports.goalBudget?.assertCoverage?.(context.scope);
  }
  #initialHistory(context: object, scope: GoalBudgetScope): { history: BudgetHistory; used: boolean } {
    let record = this.#initialHistories.get(context);
    if (!record) {
      if (!this.ports.goalBudget?.initialHistory) throw new Error("Goal request history is unknown; trusted request coverage is required");
      record = { history: this.ports.goalBudget.initialHistory(scope), used: false };
      this.#initialHistories.set(context, record);
    }
    if (record.used) throw new Error("Original Goal history initialization was already attempted; pool cannot be reset");
    return record;
  }
  #goalPool(context: GoalRequestContext, facts = false) {
    this.#goalCurrent(context, facts);
    const guard = () => this.#goalCurrent(context, facts);
    let pool = context.store.readBudgetPool(context.declaration.poolScope);
    if (!pool) {
      if (facts) throw new Error("Original Goal request pool is unavailable");
      // This is the original core's ephemeral initial state, not another store.
      // The first real reservation below creates it in the sole SQLite CAS.
      pool = createBudgetPool(context.declaration.poolScope, context.declaration.limit, this.#initialHistory(context, context.scope).history);
    }
    if (!facts && pool.limit !== context.declaration.limit) {
      pool = this.#writeBudget(context.store,{ scope: context.declaration.poolScope, expectedRevision: pool.revision,
        command: { kind: "set-limit", limit: context.declaration.limit }, ...(context.coverage ? { coverage: context.coverage } : {}) }, guard).budget.state;
    }
    this.#goalCurrent(context, facts);
    return pool;
  }
  #goalWrite(context: GoalRequestContext, command: BudgetCommand, facts = false) {
    const pool = this.#goalPool(context, facts);
    const exists = context.store.readBudgetPool(context.declaration.poolScope);
    let initial: { limit: number; history: BudgetHistory } | undefined;
    if (!exists) { const record = this.#initialHistory(context, context.scope); record.used = true; initial = { limit: context.declaration.limit, history: record.history }; }
    return this.#writeBudget(context.store,{ scope: context.declaration.poolScope, expectedRevision: pool.revision, command, ...(initial ? { initial } : {}), ...(context.coverage ? { coverage: context.coverage } : {}) },
      () => this.#goalCurrent(context, facts)).budget;
  }
  /** Same M16 store and writer. This is a Goal request issuer, never a synthetic Task attempt. */
  readonly goalModelBudget: GoalModelBudgetPort = {
    prepare: async scope => {
      const host = this.#current(), port = this.ports.goalBudget;
      if (!port) throw new Error("Goal model budget source unavailable");
      const declaration = port.read(scope, "send");
      if (declaration.limit === 0) throw new Error("Goal token budget is exhausted");
      if (declaration.poolScope.workspace !== realpathSync(host.cwd) || declaration.poolScope.sessionId !== host.manager.getSessionId()) {
        throw new Error("Goal request belongs to another durable source");
      }
      await this.ready(true);
      const context: GoalRequestContext = { host, store: this.#required().store, scope, declaration, coverage: this.#coverageIdentity(scope, declaration) };
      this.#goalCurrent(context);
      const handle = Object.freeze({}); this.#goalContexts.set(handle, context); return handle;
    },
    acquire: (handle, control) => {
      const context = this.#goalContexts.get(handle); if (!context) return Promise.reject(Error("Unissued Goal request context"));
      return this.#acquire(context.scope, control, () => this.#goalPool(context), () => this.goalModelBudget.reserve(handle), () => this.#goalCurrent(context));
    },
    abandonBeforeMark: request => this.#abandonBeforeMark(request),
    markAttempted: request => this.#markAttempted(request),
    beginReceiptDrain: request => this.#beginReceiptDrain(request),
    endReceiptDrain: producer => this.#endReceiptDrain(producer),
      retireSender: request => this.#retireSender(request),
    reserve: handle => {
      const context = this.#goalContexts.get(handle);
      if (!context) throw new Error("Unissued Goal request context");
      this.#goalCurrent(context);
      const pool = this.#goalPool(context);
      // Conservative first slice: one request holds all currently available tokens.
      // This is not an upper bound on provider usage and never changes maxTokens.
      const balance = inspectBudgetPool(pool), available = balance.available;
      if (available <= 0) throw new Error(`Goal request budget unavailable: ${balance.blockedBy ?? "reservation-in-flight"}`);
      const identity: BudgetReservationInput = { reservationId: randomUUID(), requestKey: randomUUID(),
        sourceHash: fingerprint(context.declaration.goalEntry), attemptKey: randomUUID(), reservedUnits: available };
      this.#goalWrite(context, { kind: "reserve", request: identity });
      const request = Object.freeze({}); this.#goalRequests.set(request, { context, identity }); return request;
    },
    mark: handle => {
      this.#markAttempted(handle);
      const request = this.#goalRequests.get(handle);
      if (!request) throw new Error("Unissued Goal model request");
      if (!this.#goalWrite(request.context, { kind: "mark-may-have-sent", request: request.identity }).changed) {
        throw new Error("Goal model request may already have been sent");
      }
      this.#bindMarkedReceipt(handle,request.context.host,request.context.store,request.context.declaration.poolScope,request.identity,request.context.coverage);
    },
    unknown: handle => {
      const request = this.#goalRequests.get(handle);
      if (!request) throw new Error("Unissued Goal model request");
      const command:ReceiptCommand={ kind: "record-receipt", request: request.identity,
        receipt: { kind: "unknown", receiptId: `sdk-terminal-unknown:${request.identity.reservationId}`,
          factRef: `sdk-terminal-unknown:${request.identity.requestKey}`, digest: fingerprint(request.identity) } };
      if(!this.#routeReceipt(handle,command))this.#goalWrite(request.context,command,true);
    },
    settle: (handle, fact) => {
      const request = this.#goalRequests.get(handle);
      if (!request) throw new Error("Unissued Goal model request");
      if (!this.ports.modelUsageFacts) throw new Error("Trusted model usage fact reader unavailable");
      const value = this.ports.modelUsageFacts.read(fact, handle, request.context.host.manager);
      const command:ReceiptCommand={ kind: "record-receipt", request: request.identity,
        receipt: { kind: "known", units: value.units, receiptId: `sdk-journal:${value.entryId}`,
          factRef: `sdk-journal:${value.entryId}`, digest: value.digest } };
      if(!this.#routeReceipt(handle,command))this.#goalWrite(request.context,command,true);
    },
  };
  #budgetParents(contracts: readonly RecoveryContract[], host: Host): Set<string> {
    const parents = new Set<string>();
    for (const contract of contracts) {
      const task = this.ports.tasks().get(contract.taskId);
      if (!task || task.taskInstanceId !== contract.instanceId) throw new Error("Budget Task instance changed");
      if (!task.deliveryGroupId) continue;
      const groups = this.ports.groups().filter(group => group.id === task.deliveryGroupId);
      const group = groups[0];
      if (groups.length !== 1 || !group || group.supersededBy || group.source.cwd !== host.cwd
        || group.source.sessionId !== host.manager.getSessionId()
        || !host.manager.getBranch().some(entry => entry.id === group.source.branchAnchor)
        || !group.members.some(member => member.taskId === task.id && member.taskInstanceId === contract.instanceId)) {
        throw new Error("Budget delivery parent source or member changed");
      }
      if (group.deliveryGoalId) parents.add(group.deliveryGoalId);
    }
    return parents;
  }
  #selectBudget(contracts: readonly RecoveryContract[], host: Host, allowLegacy = false): { source: GoalBudgetScope; declaration: GoalBudgetDeclaration } | undefined {
    const parents = this.#budgetParents(contracts, host);
    if (!parents.size) return undefined;
    const port = this.ports.goalBudget;
    if (!port) throw new Error("Declared Goal budget source capability unavailable");
    if (port.available?.() === false) {
      if (allowLegacy && [...parents].every(parent => port.view(parent)?.tokenBudget === undefined)) return undefined;
      throw new Error("Declared Goal budget source capability unavailable");
    }
    const declared = new Map<string, { source: GoalBudgetScope; declaration: GoalBudgetDeclaration }>();
    for (const parent of parents) {
      const view = port.view(parent);
      if (!view) throw new Error("Budget delivery parent Goal unavailable");
      const captured = port.capture(parent);
      if (captured.kind === "none") continue;
      const declaration = port.read(captured.scope, "send");
      if (declaration.poolScope.goalId !== parent || declaration.poolScope.sessionId !== host.manager.getSessionId()
        || declaration.poolScope.workspace !== realpathSync(host.cwd)) throw new Error("Budget parent outside the original Task source");
      declared.set(parent, { source: captured.scope, declaration });
    }
    if (declared.size > 1) throw new Error("Multiple declared parent budgets require an atomic multi-pool host capability");
    const selected = declared.values().next().value;
    if (selected?.declaration.limit === 0) throw new Error("Goal token budget is exhausted");
    return selected;
  }
  #budgetAttempt(handle: object, facts: boolean): BudgetAttempt {
    if (!facts && this.#sendFrozen) throw new Error("Task budget issuer is closing; no new request can be sent");
    const attempt = this.#budgetAttempts.get(handle);
    const service = this.#service;
    if (!attempt || !service || this.#host !== attempt.host || service.owner !== attempt.owner || service.store !== attempt.store) {
      throw new Error("Task budget attempt or store source changed");
    }
    this.#current();
    if (!facts) this.ports.assertDispatch?.(attempt.token);
    (facts ? attempt.factGuard : attempt.guard)();
    attempt.owner.assertAttempt(handle, facts);
    return attempt;
  }
  #budgetCurrent(context: BudgetContext, facts: boolean): BudgetAttempt {
    if (!facts && this.#sendFrozen) throw new Error("Task budget issuer is closing; no new request can be sent");
    const attempt = this.#budgetAttempt(context.attempt, facts);
    const port = this.ports.goalBudget;
    if (!port) throw new Error("Declared Goal budget source capability unavailable");
    const declaration = port.read(context.source, facts ? "fact" : "send");
    if (fingerprint(declaration.poolScope) !== fingerprint(context.declaration.poolScope)) throw new Error("Task budget pool source changed");
    if (!facts) {
      port.assertCoverage?.(context.source);
      const current = this.#selectBudget(attempt.contracts, attempt.host);
      if (!current || fingerprint(current.declaration.poolScope) !== fingerprint(context.declaration.poolScope)
        || current.declaration.limit !== context.declaration.limit
        || fingerprint(current.declaration.goalEntry) !== fingerprint(context.declaration.goalEntry)) {
        throw new Error("Task budget parent declaration changed");
      }
    }
    return attempt;
  }
  #budgetWrite(context: BudgetContext, command: BudgetCommand, facts: boolean) {
    const attempt = this.#budgetCurrent(context, facts);
    const guard = () => { this.#budgetCurrent(context, facts); };
    let pool = attempt.store.readBudgetPool(context.declaration.poolScope);
    if (!facts && pool && pool.limit !== context.declaration.limit) {
      pool = this.#writeBudget(attempt.store,{ scope: context.declaration.poolScope, expectedRevision: pool.revision,
        command: { kind: "set-limit", limit: context.declaration.limit }, ...(context.coverage ? { coverage: context.coverage } : {}) }, guard).budget.state;
    }
    let initial: { limit: number; history: BudgetHistory } | undefined;
    if (!pool) {
      if (facts) throw new Error("Original Task budget pool unavailable");
      const record = this.#initialHistory(context, context.source); record.used = true;
      initial = { limit: context.declaration.limit, history: record.history };
    }
    return this.#writeBudget(attempt.store,{ scope: context.declaration.poolScope, expectedRevision: pool?.revision ?? 0,
      command, ...(initial ? { initial } : {}), ...(context.coverage ? { coverage: context.coverage } : {}) }, guard).budget;
  }
  #captureBudget(attemptHandle: object): object | undefined {
    const attempt = this.#budgetAttempts.get(attemptHandle);
    if (!attempt || this.#current() !== attempt.host || this.#service?.store !== attempt.store) {
      throw new Error("Task budget attempt or store source changed");
    }
    const selected = this.#selectBudget(attempt.contracts, attempt.host);
    if (!selected) return undefined;
    this.#budgetAttempt(attemptHandle, false);
    const context = Object.freeze({});
    this.#budgetContexts.set(context, { attempt: attemptHandle, source: selected.source, declaration: selected.declaration, coverage: this.#coverageIdentity(selected.source, selected.declaration) });
    return context;
  }
  async #prepareBudget(attemptHandle: object): Promise<object | undefined> { return this.#captureBudget(attemptHandle); }
  #reserveRemaining(contextHandle: object, requestId: string): object {
    const context = this.#budgetContexts.get(contextHandle);
    if (!context) throw new Error("Unissued Task budget context");
    const attempt = this.#budgetCurrent(context, false);
    let pool = attempt.store.readBudgetPool(context.declaration.poolScope);
    if (!pool) pool = createBudgetPool(context.declaration.poolScope, context.declaration.limit, this.#initialHistory(context, context.source).history);
    if (pool.limit !== context.declaration.limit) {
      pool = this.#budgetWrite(context, { kind: "set-limit", limit: context.declaration.limit }, false).state;
    }
    const balance = inspectBudgetPool(pool);
    if (balance.available <= 0) throw new Error(`Task request budget unavailable: ${balance.blockedBy ?? "reservation-in-flight"}`);
    return this.#reserveBudget(contextHandle, { requestId, reservedUnits: balance.available });
  }
  #reserveBudget(contextHandle: object, input: NativeTaskBudgetRequest): object {
    const context = this.#budgetContexts.get(contextHandle);
    if (!context) throw new Error("Unissued Task budget context");
    const attempt = this.#budgetCurrent(context, false);
    if (typeof input.requestId !== "string" || !input.requestId.trim()) throw new Error("Trusted model request identity unavailable");
    const previous = attempt.requests.get(input.requestId);
    if (previous) {
      const request = this.#budgetRequests.get(previous)!;
      if (request.identity.reservedUnits !== input.reservedUnits) throw new Error("Budget request reservation amount changed");
      this.#budgetWrite(request.context, { kind: "reserve", request: request.identity }, false);
      return previous;
    }
    const identity: BudgetReservationInput = { reservationId: randomUUID(), requestKey: fingerprint([attempt.id, input.requestId]),
      sourceHash: fingerprint(context.declaration.goalEntry), attemptKey: attempt.id, reservedUnits: input.reservedUnits };
    this.#budgetWrite(context, { kind: "reserve", request: identity }, false);
    const request = Object.freeze({});
    this.#budgetRequests.set(request, { context, identity });
    attempt.requests.set(input.requestId, request);
    return request;
  }
  #budgetRequest(handle: object): BudgetRequest {
    const request = this.#budgetRequests.get(handle);
    if (!request) throw new Error("Unissued Task budget request");
    return request;
  }
  #markBudgetSent(handle: object): void {
    this.#markAttempted(handle);
    const request = this.#budgetRequest(handle);
    const changed = this.#budgetWrite(request.context, { kind: "mark-may-have-sent", request: request.identity }, false).changed;
    if (!changed) throw new Error("Budget request may already have been sent; reconcile without replay");
    const attempt=this.#budgetAttempts.get(request.context.attempt)!;
    this.#bindMarkedReceipt(handle,attempt.host,attempt.store,request.context.declaration.poolScope,request.identity,request.context.coverage);
  }
  #recordBudgetUnknown(handle: object): void {
    const request = this.#budgetRequest(handle);
    const command:ReceiptCommand={kind:"record-receipt",request:request.identity,
      receipt: { receiptId: `unknown:${request.identity.reservationId}`, kind: "unknown",
        factRef: `native-budget-request:${request.identity.requestKey}:unattributed-usage`, digest: fingerprint(request.identity) }};
    if(!this.#routeReceipt(handle,command))this.#budgetWrite(request.context,command,true);
  }
  #settleBudget(handle: object, originalFact: object): void {
    const request = this.#budgetRequest(handle);
    if (!this.ports.childModelUsageFacts) throw new Error("Trusted post-append SDK usage fact capability unavailable; budget remains held");
    const fact = this.ports.childModelUsageFacts.read(originalFact, handle);
    const command:ReceiptCommand={kind:"record-receipt",request:request.identity,
      receipt: { kind: "known", units: fact.units, receiptId: `child-journal:${request.identity.requestKey}:${fact.entryId}`,
        factRef: `child-journal:${request.identity.requestKey}:${fact.entryId}`, digest: fact.digest }};
    if(!this.#routeReceipt(handle,command))this.#budgetWrite(request.context,command,true);
  }
  #releaseBudget(handle: object, _notSentProof: object): never {
    const request = this.#budgetRequest(handle);
    this.#budgetCurrent(request.context, true);
    throw new Error("Trusted SDK not-sent proof capability unavailable; budget remains held");
  }
  readonly provider:TaskNativeRecoveryProvider={
    backendBudgetSource: {
      capture: (host, ids) => {
        const current = this.#current();
        if (host.manager !== current.manager || host.cwd !== current.cwd || host.sessionId !== current.manager.getSessionId()) throw new Error("Backend budget source host changed");
        const contracts = ids.map(id => { const task = this.ports.tasks().get(id); if (!task) throw new Error("Backend Task source unavailable"); return this.contract(task); });
        const parents = new Map<string, GoalBudgetSource>(), port = this.ports.goalBudget;
        if (port) for (const id of this.#budgetParents(contracts, current)) parents.set(id, port.capture(id));
        const selected = ids.length || !port ? undefined : this.provider.modelSource?.capture(host);
        const handle = Object.freeze({}); this.#backendSources.set(handle, { host: current, epoch: this.#epoch, contracts, parents, selected }); return handle;
      },
      assertNone: handle => {
        if (this.#sendFrozen) throw new Error("Parent model issuer is closing");
        const origin = this.#backendSources.get(handle), port = this.ports.goalBudget;
        if (!origin || origin.epoch !== this.#epoch || this.#current() !== origin.host) throw new Error("Backend request source was replaced");
        if (!port) { this.ports.assert(origin.host.scope); return; }
        if (origin.selected) { this.provider.modelSource!.assertNone(origin.selected); return; }
        const currentContracts = origin.contracts.map(contract => {
          const task = this.ports.tasks().get(contract.taskId);
          if (!task) throw new Error("Backend Task disappeared");
          // Original Prepared binding owns business/admission rechecks. Own
          // admission may change a submission; budget ownership must not move.
          return this.contract(task);
        });
        const parents = this.#budgetParents(currentContracts, origin.host);
        if (parents.size !== origin.parents.size || [...parents].some(id => !origin.parents.has(id))) throw new Error("Backend delivery parent set changed");
        for (const source of origin.parents.values()) {
          if (source.kind !== "none" || !port?.assertNone) throw new Error("Declared parent budget requires a metered backend adapter before start");
          port.assertNone(source);
        }
      },
    },
    modelSource: {
      fromDispatch: handle => {
        const origin = this.#backendSources.get(handle);
        if (!origin || this.#current() !== origin.host || origin.epoch !== this.#epoch
          || origin.contracts.length || origin.parents.size || !origin.selected) throw new Error("Unissued bare Goal dispatch source");
        const selected = this.#parentSources.get(origin.selected);
        if (!selected || selected.host !== origin.host || selected.epoch !== origin.epoch) throw new Error("Bare Goal dispatch source belongs to another owner");
        return origin.selected;
      },
      kind: handle => {
        if (this.#sendFrozen) throw new Error("Parent model issuer is closing");
        const origin = this.#parentSources.get(handle), port = this.ports.goalBudget;
        if (!origin || origin.epoch !== this.#epoch || this.#current() !== origin.host || !port) throw new Error("Parent Goal source was replaced");
        if (origin.source.kind === "none") {
          if (!port.assertNone) throw new Error("Parent negative source unavailable"); port.assertNone(origin.source); return "none";
        }
        port.read(origin.source.scope, "send"); port.assertCoverage?.(origin.source.scope); return "declared";
      },
      prepare: async handle => {
        const origin = this.#parentSources.get(handle);
        if (!origin || origin.source.kind !== "declared" || this.provider.modelSource!.kind!(handle) !== "declared") throw new Error("Original bare Goal source is not declared");
        const prepared = await this.goalModelBudget.prepare(origin.source.scope);
        this.provider.modelSource!.kind!(handle); return prepared;
      },
      reserve: context => this.goalModelBudget.reserve(context),
      acquire: (context, control) => this.goalModelBudget.acquire!(context, control),
      abandonBeforeMark: request => this.#abandonBeforeMark(request),
      markAttempted: request => this.#markAttempted(request),
      beginReceiptDrain: request => this.#beginReceiptDrain(request),
      endReceiptDrain: producer => this.#endReceiptDrain(producer),
      retireSender: request => this.#retireSender(request),
      mark: request => this.goalModelBudget.mark(request),
      unknown: request => this.goalModelBudget.unknown(request),
      settleChild: (handle, originalFact) => {
        const request = this.#goalRequests.get(handle);
        if (!request || !this.ports.childModelUsageFacts) throw new Error("Original bare Goal child fact issuer unavailable");
        const fact = this.ports.childModelUsageFacts.read(originalFact, handle);
        const command:ReceiptCommand={kind:"record-receipt",request:request.identity,
          receipt: { kind: "known", units: fact.units, receiptId: `child-journal:${request.identity.requestKey}:${fact.entryId}`,
            factRef: `child-journal:${request.identity.requestKey}:${fact.entryId}`, digest: fact.digest }};
        if(!this.#routeReceipt(handle,command))this.#goalWrite(request.context,command,true);
      },
      capture: host => {
        if (this.#sendFrozen) throw new Error("Parent model issuer is closing");
        const original = this.#current(), port = this.ports.goalBudget;
        if (host.cwd !== original.cwd || host.manager !== original.manager || host.sessionId !== original.manager.getSessionId()) throw new Error("Child budget parent host differs from the original loaded owner");
        if (!port?.captureSelected || !port.assertNone) throw new Error("Authoritative parent Goal budget source capability unavailable");
        const source = port.captureSelected(), handle = Object.freeze({});
        this.#parentSources.set(handle, { host: original, epoch: this.#epoch, source }); return handle;
      },
      assertNone: handle => {
        if (this.#sendFrozen) throw new Error("Parent model issuer is closing");
        const origin = this.#parentSources.get(handle), port = this.ports.goalBudget;
        if (!origin || origin.epoch !== this.#epoch || this.#current() !== origin.host || !port?.assertNone) throw new Error("Child parent budget source was replaced");
        if (origin.source.kind === "declared") throw new Error("Declared parent budget requires a bound Task/model request sending capability");
        port.assertNone(origin.source);
      },
    },
    preflightBudget: ids => {
      if (!this.ports.goalBudget) return;
      const host = this.#current();
      const contracts = ids.map(id => {
        const task = this.ports.tasks().get(id);
        if (!task) throw new Error("Budget Task unavailable");
        return this.contract(task);
      });
      this.#selectBudget(contracts, host, true);
      this.ports.assert(host.scope);
    },
    budget: {
      capture: attempt => this.#captureBudget(attempt),
      captureNone: handle => {
        const attempt = this.#budgetAttempt(handle, false), parents = new Map<string, GoalBudgetSource>();
        for (const id of this.#budgetParents(attempt.contracts, attempt.host)) {
          const port = this.ports.goalBudget;
          if (!port?.assertNone) throw new Error("Task parent negative source capability unavailable");
          const source = port.capture(id);
          if (source.kind !== "none") throw new Error("Declared Task parent requires a budget sending capability");
          port.assertNone(source); parents.set(id, source);
        }
        this.#budgetAttempt(handle, false);
        const origin = Object.freeze({}); this.#taskNegatives.set(origin, { attempt: handle, parents }); return origin;
      },
      assertNone: (handle, origin) => {
        const grant = this.#taskNegatives.get(origin), attempt = this.#budgetAttempt(handle, false);
        if (!grant || grant.attempt !== handle) throw new Error("Unissued Task parent negative source");
        const parents = this.#budgetParents(attempt.contracts, attempt.host);
        if (parents.size !== grant.parents.size || [...parents].some(id => !grant.parents.has(id))) throw new Error("Task delivery parent set changed");
        for (const source of grant.parents.values()) {
          if (!this.ports.goalBudget?.assertNone) throw new Error("Task parent negative source capability unavailable");
          this.ports.goalBudget.assertNone(source);
        }
        this.#budgetAttempt(handle, false);
      },
      prepare: attempt => this.#prepareBudget(attempt),
      reserve: (context, request) => this.#reserveBudget(context, request),
      reserveRemaining: (context, requestId) => this.#reserveRemaining(context, requestId),
      acquireRemaining: (handle, requestId, control) => {
        const context = this.#budgetContexts.get(handle); if (!context) return Promise.reject(Error("Unissued Task budget context"));
        return this.#acquire(context.source, control, () => {
          const attempt = this.#budgetCurrent(context, false);
          let pool = attempt.store.readBudgetPool(context.declaration.poolScope);
          if (pool && pool.limit !== context.declaration.limit) pool = this.#budgetWrite(context, { kind: "set-limit", limit: context.declaration.limit }, false).state;
          return pool ?? createBudgetPool(context.declaration.poolScope, context.declaration.limit, this.#initialHistory(context, context.source).history);
        }, () => this.#reserveRemaining(handle, requestId), () => { this.#budgetCurrent(context, false); });
      },
      abandonBeforeMark: request => this.#abandonBeforeMark(request),
      markAttempted: request => this.#markAttempted(request),
      beginReceiptDrain: request => this.#beginReceiptDrain(request),
      endReceiptDrain: producer => this.#endReceiptDrain(producer),
      retireSender: request => this.#retireSender(request),
      markMayHaveSent: request => this.#markBudgetSent(request),
      recordUnknown: request => this.#recordBudgetUnknown(request),
      settle: (request, fact) => this.#settleBudget(request, fact),
      release: (request, proof) => this.#releaseBudget(request, proof),
    },
    ready:()=>this.ready(true),
    begin:(token,candidateId,guard,factGuard)=>{
      const contracts=token.todoIds.map(id=>{const task=this.ports.tasks().get(id);if(!task)throw new Error("Native recovery Task missing");this.#plan(task);return this.contract(task);});
      const host=this.#current(),current=(facts=false)=>{this.ports.assert(host.scope);(facts?factGuard:guard)();for(const original of contracts){const task=this.ports.tasks().get(original.taskId);if(!task)throw new Error("Native recovery Task missing");this.#plan(task);const now=this.contract(task),head=this.#required().store.read(original.taskId);
        if(!sameInput(original,now)||!head||head.contract.instanceId!==now.instanceId||head.contract.submissionId!==now.submissionId||head.contract.version!==now.version||head.contract.digest!==now.digest||!host.manager.getBranch().some(entry=>entry.id===head.contract.source.branchAnchor))throw new Error("Native recovery Task execution/source is behind the durable head");}};
      // Resolve every declared parent before the original native begin transaction.
      if (this.ports.goalBudget) this.#selectBudget(contracts, host, true);
      const service = this.#required();
      const attempt = service.owner.begin(contracts,{id:candidateId,bindingId:token.id,correlationId:token.correlationId,runtimeGeneration:token.runtimeGeneration},()=>current(),()=>current(true));
      this.#budgetAttempts.set(attempt, { id: candidateId, host, owner: service.owner, store: service.store,
        token, contracts, guard: () => current(), factGuard: () => current(true), requests: new Map() });
      return attempt;
    },
    beforeWrite:(attempt,input)=>this.#required().owner.beforeWrite(attempt,input),consume:(attempt,permit,payloadDigest)=>this.#required().owner.consume(attempt,permit,payloadDigest),unknown:attempt=>this.#service?.owner.unknown(attempt),
    observe:(attempt,snapshot,cleanup)=>this.#observe(attempt,snapshot,cleanup),
  };
  #observe(attempt:object,snapshot:NativeExecutionSnapshot,cleanupRequested:boolean):void {
    const turn=snapshot.currentTurn,result=snapshot.lastResult,reference=result?.turnReference;
    const settled=result!==undefined&&reference!==undefined&&turn.state==="settled"&&turn.queuedInputs===0&&turn.settledEpoch===turn.epoch&&reference.requestId===turn.requestId&&reference.loopSeq===turn.loopSeq&&!result.lifecyclePending;
    const work:RecoveryWork|undefined=settled&&result?{epoch:turn.epoch,inputGeneration:turn.inputGeneration!,requestId:turn.requestId!,loopSeq:turn.loopSeq!,exitCode:result.exitCode,terminalStatus:result.terminalStatus??"unknown",resultDigest:fingerprint(result)}:undefined;
    const close=snapshot.process.close&&snapshot.process.processInstanceId?{...snapshot.process.close,processInstanceId:snapshot.process.processInstanceId,cleanupRequested}:undefined;
    this.#required().owner.record(attempt,snapshot.nativeInvocationId,work,close,!settled);
  }
  claim(before:TodoTask,draft:TodoTask):RestoredClosedExecution {
    const service=this.#required(),host=this.#current(),current=this.contract(before),target=this.contract(draft),head=service.store.read(before.id);
    if(!head||head.contract.version>current.version||head.contract.instanceId!==current.instanceId||head.contract.submissionId!==current.submissionId)throw new Error("settlement-unknown: Task journal is behind/different from latest native admission");
    const branch=host.manager.getBranch();
    if(![head.contract.source.branchAnchor,head.executed?.source.branchAnchor].every(anchor=>!!anchor&&branch.some(entry=>entry.id===anchor)))throw new Error("Native recovery original execution belongs to another branch");
    this.#plan(draft);const chain:RecoveryContract[]=[];let previous=head.contract,previousStatus:string|undefined;
    if(head.contract.version!==target.version||head.contract.digest!==target.digest){
      let found=false;
      for(const item of this.ports.history(before.id)){
        if(!item.task){if(found)throw new Error("Native recovery Task history deleted/cleared");continue;}
        const c=this.contract(item.task);
        if(!found){if(c.instanceId===previous.instanceId&&c.version===previous.version&&c.digest===previous.digest&&c.submissionId===previous.submissionId){found=true;previousStatus=item.task.status;}continue;}
        if(previousStatus==="completed"&&item.task.status!=="completed")throw new Error("Native recovery Task was reopened");previousStatus=item.task.status;
        if(c.version===previous.version&&c.digest===previous.digest)continue;
        if(!sameInput(previous,c)||c.version!==previous.version+1||c.digest===previous.digest)throw new Error("Native recovery input/revision transition is not output-only");chain.push(c);previous=c;
      }
      if(!found)throw new Error("Native recovery original Task contract history missing");
      if(previous.version!==current.version||previous.digest!==current.digest)throw new Error("Native recovery Task contract history incomplete");
      if(target.version!==current.version||target.digest!==current.digest){if(!sameInput(current,target)||target.version!==current.version+1||target.digest===current.digest)throw new Error("Root restoration draft is not output-only");chain.push(target);}
    }
    const scope=host.scope,baseline=fingerprint(before),guard=()=>{this.ports.assert(scope);this.#plan(draft);if(fingerprint(this.ports.tasks().get(before.id))!==baseline)throw new Error("Task changed during Root recovery review");};
    const descriptor=service.recovery.claim(target,guard,chain,()=>{this.ports.assert(scope);this.#plan(draft);});this.#restored.set(before.id,descriptor);return descriptor;
  }
  execution(task:TodoTask):RestoredClosedExecution|undefined {const value=this.#restored.get(task.id);if(value){this.assert(value,task);return value;}return undefined;}
  assert(value:RestoredClosedExecution,task:TodoTask):void {this.#plan(task);this.#required().recovery.assert(value,this.contract(task));}
  cached(value:RestoredClosedExecution,task:TodoTask):boolean {const current=this.#restored.get(task.id);return !!current&&fingerprint(current)===fingerprint(value)&&value.taskInstanceId===task.taskInstanceId&&value.reviewedContractVersion===task.contractVersion&&value.reviewedContractDigest===taskBusinessContractDigest(task);}
}
