import { AsyncLocalStorage } from "node:async_hooks";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import * as modelApi from "@earendil-works/pi-ai";
import { readModelRuntimeBridge, type RuntimeMethod } from "pi-graph-host-compat/model-runtime";
import { createModelRequestCoverage } from "./model-request-coverage.ts";
export type PhysicalModelOperation = "stream" | "classify" | "image" | "deferred";
/** A failed response needs positive, complete measured token evidence, not SDK defaults. */
export function hasMeasuredModelUsage(value: unknown): boolean {
  try {
    if (!value || typeof value !== "object") return false;
    const pieces = ["input", "output", "cacheRead", "cacheWrite"].map(key => Reflect.get(value, key));
    if (!pieces.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return false;
    const total = pieces.reduce((sum: number, n: number) => sum + n, 0);
    return Number.isSafeInteger(total) && total > 0 && Reflect.get(value, "totalTokens") === total;
  } catch { return false; } // Unreadable evidence must not replace an original error.

}

export interface ModelRequestBudgetHost {
  capture(): object;
  beforePhysical(origin: object, operation?: PhysicalModelOperation, signal?: AbortSignal): Promise<object | undefined>;
  abandonBeforeMark?(ticket: object): void | Promise<void>;
  onAppendFailure?(name: string, args: readonly unknown[]): void;
  drainMessages?(messages: readonly unknown[]): void | Promise<void>;
  beforeDelegate(ticket: object): void | Promise<void>;
  onResult(ticket: object, message: AssistantMessage): void | Promise<void>;
  onUsageResult?(ticket: object, result: unknown, model: unknown): void | Promise<void>;
}
interface Owner { active: boolean; phase: "active" | "closing" | "finalized"; pending?: number; finalPoint?: object; lineage?: object; sessionId?: string; receiptReader?(instruction: object): unknown; receiptWriter?(envelope: object): void; releaseCleanup?: () => void; continuity?: (point: object) => void; handoff?: (manager: object, runtime: object) => void; manager?: object; capture?(): object; assertCurrent?(): void; assertFactCurrent?(): void; }
interface Frame { owner: Owner; origin: Promise<object>; }
/** Observation only: this is not an admission, budget ticket, or send permit. */
export interface AdmittedModelOperation {
  readonly runtime: object;
  readonly manager: object;
  readonly operation: PhysicalModelOperation;
  readonly model: unknown;
  readonly options: unknown;
  assertCurrent(): void;
}
export interface ObservedModelOperationTerminal { readonly kind: "complete" | "incomplete"; }
type OperationTerminalObserver = (outcome: ObservedModelOperationTerminal) => void | Promise<void>;
interface OperationTerminalSubscription { active: boolean; readonly observer: OperationTerminalObserver; }
interface OperationTerminalRecord { readonly metadata: AdmittedModelOperation; phase: "open" | "notifying" | "closed"; readonly listeners: Set<OperationTerminalSubscription>; }
interface RuntimeState { current?: Owner; contextFrames?: WeakMap<object, Frame>; pending: number; restorations: Map<object, Map<string, () => void>>; }
interface RuntimeOwnership { routing: AsyncLocalStorage<Frame>; states: WeakMap<object, RuntimeState>; operations?: AsyncLocalStorage<AdmittedModelOperation>; operationTerminals?: WeakMap<object, OperationTerminalRecord>; finalPoints?: WeakMap<object, { owner: Owner; manager: object; pending: number }>; receipts?: WeakMap<object, { issuer: Owner; instruction: object }>; }
// Shared only across independent plugin module copies wrapping the same original
// SDK object. This is decorator/lifetime bookkeeping, never budget authority.
const registryKey = Symbol.for("pi-graph:model-request-gate-ownership:v1");
const gateRegistry = globalThis as typeof globalThis & { [registryKey]?: RuntimeOwnership };
const ownership = gateRegistry[registryKey] ??= { routing: new AsyncLocalStorage<Frame>(), states: new WeakMap<object, RuntimeState>() };
const routing = ownership.routing;
const operations = ownership.operations ??= new AsyncLocalStorage<AdmittedModelOperation>();
const operationTerminals = ownership.operationTerminals ??= new WeakMap<object, OperationTerminalRecord>();
/** Read-only completion observation for this gate's already-issued operation. */
export function subscribeAdmittedModelOperationTerminal(metadata: AdmittedModelOperation, observer: OperationTerminalObserver): (() => void) | undefined {
  const record = operationTerminals.get(metadata);
  if (!record || record.metadata !== metadata || record.phase !== "open" || operations.getStore() !== metadata) return undefined;
  try { metadata.assertCurrent(); } catch { return undefined; }
  const subscription: OperationTerminalSubscription = { active: true, observer };
  record.listeners.add(subscription);
  return () => { subscription.active = false; record.listeners.delete(subscription); };
}
async function finishObservedOperation(metadata: AdmittedModelOperation | undefined, outcome: ObservedModelOperationTerminal): Promise<void> {
  if (!metadata) return;
  const record = operationTerminals.get(metadata);
  if (!record || record.phase !== "open") return;
  record.phase = "notifying";
  const listeners = [...record.listeners];
  const notification: ObservedModelOperationTerminal = Object.freeze({ kind: outcome.kind });
  try {
    for (const subscription of listeners) {
      if (!subscription.active) continue;
      subscription.active = false; record.listeners.delete(subscription);
      try { await subscription.observer(notification); } catch { /* Observation cannot replace the original SDK result/error. */ }
    }
  } finally {
    for (const subscription of record.listeners) subscription.active = false;
    record.listeners.clear(); record.phase = "closed"; operationTerminals.delete(metadata);
  }
}
export function readAdmittedModelOperation(runtime: object, manager: object, model: unknown, options: unknown): AdmittedModelOperation | undefined {
  const metadata = operations.getStore();
  if (!metadata || metadata.runtime !== runtime || metadata.manager !== manager || metadata.model !== model || metadata.options !== options) return undefined;
  try { metadata.assertCurrent(); return metadata; } catch { return undefined; }
}
const finalPoints = ownership.finalPoints ??= new WeakMap<object, { owner: Owner; manager: object; pending: number }>();
const receipts = ownership.receipts ??= new WeakMap<object, { issuer: Owner; instruction: object }>();
export interface ModelReceiptEnvelope {
  readonly manager: object;
  readonly value: unknown;
  readonly continuousClosed: boolean;
}
function contextOwner(ctx: { readonly modelRegistry: unknown; readonly sessionManager: unknown }): Owner | undefined {
  const registry = ctx.modelRegistry;
  if (!registry || typeof registry !== "object") return undefined;
  const runtime: unknown = Reflect.get(registry, "runtime");
  if (!runtime || typeof runtime !== "object") return undefined;
  const owner = ownership.states.get(runtime)?.current;
  if (!owner?.active || owner.manager !== ctx.sessionManager) return undefined;
  owner.assertCurrent?.(); return owner;
}
export function hasModelRequestGate(ctx: { readonly modelRegistry: unknown; readonly sessionManager: unknown }): boolean { return contextOwner(ctx) !== undefined; }
export function withModelRequestOrigin<T>(ctx: { readonly modelRegistry: unknown; readonly sessionManager: unknown }, operation: () => T): T {
  const inherited = routing.getStore();
  if (inherited && !inherited.owner.active) throw new Error("Model operation belongs to a previous SDK session");
  const owner = contextOwner(ctx);
  if (!owner) {
    if (inherited) throw new Error("Model operation cannot replace its covered SDK host");
    return operation();
  }
  if (inherited && inherited.owner !== owner) throw new Error("Model operation belongs to a previous SDK session");
  const frame = inherited ?? { owner, origin: Promise.resolve(owner.capture!()) };
  return routing.run(frame, operation);
}
function signalFrom(options: unknown): AbortSignal | undefined {
  return options && typeof options === "object" ? Reflect.get(options, "signal") as AbortSignal | undefined : undefined;
}
function failed(model: unknown, error: unknown, signal?: AbortSignal): AssistantMessage {
  const value = model && typeof model === "object" ? model : {};
  return { role: "assistant", content: [], api: Reflect.get(value, "api") ?? "unknown",
    provider: Reflect.get(value, "provider") ?? "unknown", model: Reflect.get(value, "id") ?? "unknown",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
}
/** Synchronous original SDK stream facade; async admission completes before delegate entry. */
export function installModelRequestGate(version: string, ctx: { readonly modelRegistry: unknown; readonly sessionManager: unknown }, resolveHost: () => Promise<ModelRequestBudgetHost & {
  observeAppend(name: string, args: readonly unknown[], result: unknown): void;
}>): { closeAdmission(): void; dispose(): void; assertCurrent(): void; assertFactCurrent(): void; bindReceipts(service: { read(instruction: object): unknown; accept(envelope: object): void }): void; routeReceipt(instruction: object): void; readReceiptEnvelope(envelope: object): ModelReceiptEnvelope; bindContinuity(finalize: (point: object) => void): void; readFinalPoint(point: object): { readonly manager: object; readonly pending: number }; continuityError(): Error | undefined; bindHost(host: Awaited<ReturnType<typeof resolveHost>>): void; coverage: ReturnType<typeof createModelRequestCoverage> } {
  const bridge = readModelRuntimeBridge(version, ctx);
  // Read the public capability through a namespace: older SDKs must remain
  // importable even when they do not export this 1.4 lifecycle operation.
  const registerCleanup: unknown = Reflect.get(modelApi, "registerSessionResourceCleanup");
  if (typeof registerCleanup !== "function") throw new Error("Goal budget SDK final cleanup capability unavailable");
  const sessionId: unknown = Reflect.apply(Reflect.get(bridge.manager, "getSessionId"), bridge.manager, []);
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Goal budget SDK session identity unavailable");
  // Check the entire decoration set before replacing a closed generation.
  // A rejected installation must leave that generation's refusal wrappers live.
  for (const [target, names] of [[bridge.runtime, ["stream", "streamSimple", "classify", "generateImages", "streamDeferred"]],
    [bridge.manager, ["appendMessage", "appendUsage"]]] as const) {
    for (const name of names) {
      bridge.original(target, name);
      if (!Object.getOwnPropertyDescriptor(target, name) && !Object.isExtensible(target)) {
        throw new Error(`Pi ${name} cannot be decorated`);
      }
    }
  }
  const state = ownership.states.get(bridge.runtime) ?? { pending: 0, restorations: new Map<object, Map<string, () => void>>() };
  ownership.states.set(bridge.runtime, state);
  const contextFrames = state.contextFrames ??= new WeakMap<object, Frame>();
  const previousOwner = state.current;
  if (previousOwner) previousOwner.active = false;
  let boundHost: Awaited<ReturnType<typeof resolveHost>> | undefined;
  const owner: Owner = { active: true, phase: "active", pending: 0, lineage: Object.freeze({}), sessionId };
  state.current = owner;
  const restoreIfDrained = () => {
    // A pending request finishing during shutdown is not a final SDK lifetime
    // event. Keep closed wrappers until the current owner is truly finalized.
    if (state.pending || state.current?.phase !== "finalized") return;
    for (const methods of state.restorations.values()) for (const restore of methods.values()) restore();
    state.restorations.clear();
  };
  const replace = (target: object, name: string, method: RuntimeMethod) => {
    const restore = bridge.replace(target, name, method);
    const methods = state.restorations.get(target) ?? new Map<string, () => void>();
    methods.set(name, restore); state.restorations.set(target, methods);
  };
  const assertCurrent = () => { if (!owner.active) throw new Error("Model request belongs to a previous SDK session"); bridge.assertCurrent(); };
  const assertFactCurrent = () => {
    if (state.current !== owner || (owner.phase !== "active" && owner.phase !== "closing")) throw new Error("Model receipt belongs to a previous SDK owner");
    bridge.assertCurrent();
  };
  owner.manager = bridge.manager; owner.assertCurrent = assertCurrent; owner.assertFactCurrent = assertFactCurrent;
  owner.capture = () => { assertCurrent(); if (!boundHost) throw new Error("Model request source is not ready"); return boundHost.capture(); };
  const coverage = createModelRequestCoverage(assertCurrent);
  const host = async () => { assertCurrent(); if (boundHost) return boundHost; const value = await resolveHost(); assertCurrent(); boundHost = value; return value; };
  const bindHost = (value: Awaited<ReturnType<typeof resolveHost>>) => { assertCurrent(); boundHost = value; coverage.bind(); };
  const releaseCleanup = () => { const release = owner.releaseCleanup; owner.releaseCleanup = undefined; release?.(); };
  let continuityFailure: Error | undefined;
  const contextIsStale = () => {
    try { bridge.assertCurrent(); return false; }
    catch (error) { return error instanceof Error && error.message.startsWith("This extension ctx is stale after session replacement or reload."); }
  };
  const readFinalPoint = (point: object) => {
    const value = finalPoints.get(point);
    if (!value || value.owner !== owner || value.manager !== bridge.manager || owner.phase === "active" || !contextIsStale()) throw new Error("Unissued SDK final coverage point");
    return { manager: value.manager, pending: value.owner.pending ?? value.pending };
  };
  const issueFinalPoint = () => {
    if (!contextIsStale()) throw new Error("SDK coverage final point precedes invalidation");
    const point = Object.freeze({}); finalPoints.set(point, { owner, manager: bridge.manager, pending: state.pending }); owner.finalPoint=point; return point;
  };
  const bindContinuity = (finalize: (point: object) => void) => { assertCurrent(); if (owner.continuity) throw new Error("SDK coverage finalizer already bound"); owner.continuity = finalize; };
  const bindReceipts = (service: { read(instruction: object): unknown; accept(envelope: object): void }) => {
    assertCurrent();
    if (owner.receiptReader || owner.receiptWriter) throw new Error("Original SDK receipt service is already bound");
    owner.receiptReader = service.read; owner.receiptWriter = service.accept;
  };
  const routeReceipt = (instruction: object) => {
    const current = state.current;
    if (!owner.receiptReader || !current || !["active","closing"].includes(current.phase) || !current.receiptWriter
      || typeof current.assertFactCurrent !== "function" || current.manager !== bridge.manager || current.sessionId !== sessionId) throw new Error("Current same-session receipt host is not ready");
    current.assertFactCurrent();
    const envelope = Object.freeze({}); receipts.set(envelope, { issuer: owner, instruction });
    try { current.receiptWriter(envelope); } finally { receipts.delete(envelope); }
  };
  const readReceiptEnvelope = (envelope: object): ModelReceiptEnvelope => {
    assertFactCurrent();
    const entry = receipts.get(envelope);
    if (state.current !== owner || !entry?.issuer.receiptReader || entry.issuer.manager !== bridge.manager
      || entry.issuer.sessionId !== sessionId) throw new Error("Unissued or foreign SDK receipt envelope");
    const value = entry.issuer.receiptReader(entry.instruction);
    const closed = value && typeof value === "object" ? Reflect.get(value, "closed") : undefined;
    const point = closed && typeof closed === "object" ? Reflect.get(closed, "point") : undefined;
    const final = point && typeof point === "object" ? finalPoints.get(point) : undefined;
    return { manager: bridge.manager, value, continuousClosed: Boolean(final?.owner === entry.issuer
      && final.manager === bridge.manager && (final.owner.pending ?? final.pending) === 0
      && entry.issuer.phase !== "active" && entry.issuer.lineage === owner.lineage) };
  };
  const dispose = () => { owner.active = false; owner.phase = "finalized"; owner.receiptWriter = undefined; owner.continuity = undefined; owner.handoff = undefined; releaseCleanup(); restoreIfDrained(); };
  const closeAdmission = () => {
    if (owner.phase !== "active") return;
    owner.active = false; owner.phase = "closing";
    if (state.current !== owner) return;
    const cleanup = (cleanedSessionId?: string) => {
      if (state.current !== owner) { releaseCleanup(); return; }
      if (owner.phase !== "closing" || cleanedSessionId !== sessionId) return;
      // cleanupSessionResources is public and can be called early. Its argument
      // alone is not a finalization signal: the genuine SDK ctx must be stale.
      try { bridge.assertCurrent(); return; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("This extension ctx is stale after session replacement or reload.")) return;
      }
      try { owner.continuity?.(issueFinalPoint()); }
      finally { dispose(); }
    };
    const unregister: unknown = Reflect.apply(registerCleanup, undefined, [cleanup]);
    if (typeof unregister !== "function") throw new Error("Goal budget SDK cleanup registration unavailable");
    owner.releaseCleanup = () => { Reflect.apply(unregister, undefined, []); };
  };
  owner.handoff = (manager, runtime) => {
    if (owner.phase !== "closing" || manager !== bridge.manager || runtime !== bridge.runtime || state.current === owner || !state.current?.active || !contextIsStale()) return;
    state.current.assertCurrent?.();
    state.current.lineage = owner.lineage;
    try { owner.continuity?.(issueFinalPoint()); }
    finally { dispose(); }
  };
  try {
    for (const name of ["stream", "streamSimple"]) {
      const original = bridge.original(bridge.runtime, name);
      replace(bridge.runtime, name, function (...args) {
        const inherited = routing.getStore();
        const context = args[1] && typeof args[1] === "object" ? args[1] as object : undefined;
        const firstFrame = context && contextFrames.get(context);
        const result = createAssistantMessageEventStream();
        let frame: Frame;
        try {
          assertCurrent();
          signalFrom(args[2])?.throwIfAborted();
          if (!boundHost) throw new Error("Model request Goal source is not ready for this SDK session");
          // Capture now, before yielding: same-tick pause/switch must not turn an
          // already-issued budget request into a new ordinary no-budget request.
          // SDK cache warming reuses this exact context after the original turn.
          // An explicit new logical call wins without rewriting that first origin.
          frame = inherited ?? firstFrame ?? { owner, origin: Promise.resolve(boundHost.capture()) };
          if (context && !firstFrame) contextFrames.set(context, frame);
        } catch (error) {
          if (context && !firstFrame) {
            const origin = Promise.reject(error); void origin.catch(() => {});
            contextFrames.set(context, { owner, origin });
          }
          const message = failed(args[0], error, signalFrom(args[2]));
          result.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message }); result.end(message); return result;
        }
        state.pending++; owner.pending = (owner.pending ?? 0) + 1;
        void routing.run(frame, async () => {
          let held: { host: ModelRequestBudgetHost; ticket: object } | undefined;
          let marked = false, markAttempted = false, terminal = false;
          let observedOperation: AdmittedModelOperation | undefined;
          try {
            assertCurrent();
            if (frame.owner !== owner || !frame.owner.active) throw new Error("Virtual request source belongs to a previous SDK session");
            const source = await frame.origin, bound = await host();
            const model = args[0];
            const virtual = model && typeof model === "object" && Reflect.get(model, "api") === "pi-virtual";
            signalFrom(args[2])?.throwIfAborted();
            const ticket = virtual ? undefined : await bound.beforePhysical(source, "stream", signalFrom(args[2]));
            if (ticket) held = { host: bound, ticket };
            assertCurrent();
            const options = args[2];
            if (options && typeof options === "object") (Reflect.get(options, "signal") as AbortSignal | undefined)?.throwIfAborted();
            if (ticket) {
              markAttempted = true;
              const acknowledgement = bound.beforeDelegate(ticket);
              if (acknowledgement) await acknowledgement;
              marked = true;
              assertCurrent(); signalFrom(args[2])?.throwIfAborted();
            }
            const metadata: AdmittedModelOperation = Object.freeze({ runtime: bridge.runtime, manager: bridge.manager, operation: "stream", model: args[0], options: args[2], assertCurrent });
            observedOperation = metadata;
            operationTerminals.set(metadata, { metadata, phase: "open", listeners: new Set() });
            const stream = operations.run(metadata, () => Reflect.apply(original, bridge.runtime, args)) as AssistantMessageEventStream;
            for await (const event of stream) {
              if ((event.type === "done" || event.type === "error") && ticket) {
                terminal = true;
                try { const acknowledgement = bound.onResult(ticket, event.type === "done" ? event.message : event.error); if (acknowledgement) await acknowledgement; }
                catch (error) {
                  // A receipt ACK error cannot replace the provider's original error.
                  if (event.type === "error") { await finishObservedOperation(observedOperation, { kind: "incomplete" }); result.push(event); result.end(event.error); return; }
                  throw error;
                }
              }
              // The SDK resolves .result() on terminal push, so observers must
              // finish before this original event becomes visible to either consumer.
              if (event.type === "done" || event.type === "error") await finishObservedOperation(observedOperation, { kind: "complete" });
              result.push(event);
            }
            const message = await stream.result();
            if (ticket && !terminal) { terminal = true; const acknowledgement = bound.onResult(ticket, message); if (acknowledgement) await acknowledgement; }
            await finishObservedOperation(observedOperation, { kind: "complete" });
            result.end(message);
          } catch (error) {
            if (held && !markAttempted) { try { await held.host.abandonBeforeMark?.(held.ticket); } catch {} }
            if (held && marked && !terminal) {
              try { await held.host.onResult(held.ticket, failed(args[0], error, signalFrom(args[2]))); }
              catch { /* Original error remains visible; old-source holds are not released. */ }
            }
            const message = failed(args[0], error, signalFrom(args[2]));
            await finishObservedOperation(observedOperation, { kind: "incomplete" });
            result.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message }); result.end(message);
          } finally { await finishObservedOperation(observedOperation, { kind: "incomplete" }); state.pending--; owner.pending = (owner.pending ?? 0) - 1; restoreIfDrained(); }
        });
        return result;
      });
    }
    for (const name of ["classify", "generateImages", "streamDeferred"]) {
      const original = bridge.original(bridge.runtime, name);
      replace(bridge.runtime, name, function (...args) {
        // The original native methods are async. Capture the logical origin now,
        // before any await can observe a later Goal/selection.
        let frame: Frame;
        try { assertCurrent(); frame = routing.getStore() ?? { owner, origin: Promise.resolve(owner.capture!()) }; }
        catch (error) {
          if (name !== "classify") return Promise.reject(error);
          const model = args[0] as { api?: string; provider?: string; id?: string };
          return Promise.resolve({ api: model?.api, provider: model?.provider, model: model?.id, answers: {},
            stopReason: signalFrom(args[2])?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() });
        }
        state.pending++; owner.pending = (owner.pending ?? 0) + 1;
        return routing.run(frame, async () => {
          let ticket: object | undefined, bound: Awaited<ReturnType<typeof resolveHost>> | undefined, marked = false, markAttempted = false;
          try {
            assertCurrent(); if (frame.owner !== owner || !frame.owner.active) throw new Error("Native operation belongs to a previous SDK session");
            const source = await frame.origin; bound = await host(); signalFrom(args[2])?.throwIfAborted();
            ticket = await bound.beforePhysical(source, name === "classify" ? "classify" : name === "generateImages" ? "image" : "deferred", signalFrom(args[2]));
            if (ticket && name === "classify" && !bound.onUsageResult) throw new Error("Native classifier usage receipt capability unavailable");
            if (ticket) { markAttempted = true; await bound.beforeDelegate(ticket); marked = true; }
            assertCurrent(); signalFrom(args[2])?.throwIfAborted();
            const operation: PhysicalModelOperation = name === "classify" ? "classify" : name === "generateImages" ? "image" : "deferred";
            const metadata: AdmittedModelOperation = Object.freeze({ runtime: bridge.runtime, manager: bridge.manager, operation, model: args[0], options: args[2], assertCurrent });
            const value: unknown = await operations.run(metadata, () => Reflect.apply(original, bridge.runtime, args));
            if (ticket && name === "classify") {
              const reason = value && typeof value === "object" ? Reflect.get(value, "stopReason") : undefined;
              const failedResponse = reason === "error" || reason === "aborted";
              try {
                await bound.onUsageResult!(ticket, value, args[0]);
                const usage = value && typeof value === "object" ? Reflect.get(value, "usage") : undefined;
                if (usage && typeof usage === "object" && (!failedResponse || hasMeasuredModelUsage(usage))) {
                  const model = args[0] as { provider: string; id: string };
                  Reflect.apply(Reflect.get(bridge.manager, "appendUsage"), bridge.manager, ["classifier", model.provider, model.id, usage]);
                }
              } catch (error) {
                // A usage/receipt failure cannot replace an original classifier error or abort.
                if (!failedResponse) throw error;
              }
            }
            return value;
          } catch (error) {
            if (ticket && !markAttempted) { try { await bound?.abandonBeforeMark?.(ticket); } catch {} }
            if (ticket && marked && bound?.onUsageResult) {
              try { await bound.onUsageResult(ticket, { stopReason: "error" }, args[0]); } catch { /* Preserve the original failure. */ }
            }
            if (name !== "classify") throw error;
            const model = args[0] as { api?: string; provider?: string; id?: string };
            return { api: model?.api, provider: model?.provider, model: model?.id, answers: {}, stopReason: signalFrom(args[2])?.aborted ? "aborted" : "error",
              errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
          } finally { state.pending--; owner.pending = (owner.pending ?? 0) - 1; restoreIfDrained(); }
        });
      });
    }
    for (const name of ["appendMessage", "appendUsage"]) {
      const original = bridge.original(bridge.manager, name);
      replace(bridge.manager, name, function (...args) {
        // Original append error remains the primary error; observe only after success.
        try {
        const result = Reflect.apply(original, bridge.manager, args);
        // ResolveHost is already bound before any model request may run. This observer
        // is synchronous so the caller sees a settlement failure instead of losing it.
        if (boundHost) { assertFactCurrent(); boundHost.observeAppend(name, args, result); }
        return result;
        } catch (error) { try { boundHost?.onAppendFailure?.(name, args); } catch {} throw error; }
      });
    }
  } catch (error) {
    owner.active = false; owner.phase = "finalized";
    if (previousOwner?.phase === "closing") {
      // Any already-installed replacements also reject through the inactive new
      // owner. The previous real cleanup remains responsible for the same map.
      state.current = previousOwner;
    } else restoreIfDrained();
    throw error;
  }
  // A genuine finalized SDK close can precede the next factory. Its exact
  // private final point joins only the same runtime/manager/session lineage.
  const priorFinal=previousOwner?.finalPoint&&finalPoints.get(previousOwner.finalPoint);
  if(previousOwner?.phase==="finalized"&&priorFinal?.owner===previousOwner
    &&priorFinal.manager===bridge.manager&&previousOwner.sessionId===sessionId
    &&(previousOwner.pending??priorFinal.pending)===0)owner.lineage=previousOwner.lineage;
  try { previousOwner?.handoff?.(bridge.manager, bridge.runtime); }
  catch (error) { continuityFailure = error instanceof Error ? error : new Error(String(error)); }
  // Only a successful exact-owned handoff drops the previous SDK callback.
  const releasePreviousCleanup = previousOwner?.releaseCleanup;
  if (previousOwner) previousOwner.releaseCleanup = undefined;
  releasePreviousCleanup?.();
  void Promise.resolve().then(host).catch(() => { /* Requests expose the source error through their original stream. */ });
  return { closeAdmission, dispose, assertCurrent, assertFactCurrent, bindReceipts, routeReceipt, readReceiptEnvelope, bindContinuity, readFinalPoint, continuityError: () => continuityFailure, bindHost, coverage };
}
