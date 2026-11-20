import { AsyncLocalStorage } from "node:async_hooks";
import { createAggregateSourceOwner } from "../persistence-recovery/aggregate-source-owner.ts";
import type { GoalContext } from "./types.ts";
export const GOAL_STATE_ENTRY_TYPE = "pi-graph-next:goal-state";
const owner = createAggregateSourceOwner(GOAL_STATE_ENTRY_TYPE, "Goal");
let host: { manager: object; cwd: string; sessionId: string } | undefined;
const execution = new AsyncLocalStorage<object>();
const cancellations = new WeakMap<object, Set<AbortSignal>>();
const cancellationObservers = new WeakMap<object, Set<(signal: AbortSignal) => void>>();
function addCancellation(scope: object, signal: AbortSignal): void {
  const signals = cancellations.get(scope) ?? new Set<AbortSignal>(); signals.add(signal); cancellations.set(scope, signals);
  for (const attach of cancellationObservers.get(scope) ?? []) attach(signal);
}
export function loadGoalSource(ctx: GoalContext): void {
  const manager = ctx.sessionManager as { getSessionId?: () => string } | undefined;
  const sessionId = manager?.getSessionId?.();
  host = manager && sessionId ? { manager, cwd: ctx.cwd, sessionId } : undefined;
  if (!host) { owner.invalidate(); return; }
  const loaded = host;
  owner.load(loaded, () => ctx.sessionManager === loaded.manager && ctx.cwd === loaded.cwd);
}
export function invalidateGoalSource(): void { host = undefined; owner.invalidate(); }
/** Read continuity only. Its wrapper is NOT a scope accepted by withGoalSource. */
export function captureGoalSourceContinuity(ctx: GoalContext): { assertCurrent(): void } {
  const inherited = execution.getStore(); if (inherited) assertGoalSource(inherited);
  const manager = ctx.sessionManager as { getSessionId(): string } | undefined;
  if (!host || !manager || typeof manager.getSessionId !== "function" || ctx.cwd !== host.cwd || ctx.sessionManager !== host.manager || manager.getSessionId() !== host.sessionId) throw new Error("Goal continuity caller does not own the loaded source");
  const loaded = host, scope = owner.provider.capture(loaded); owner.provider.assert(scope);
  return Object.freeze({ assertCurrent() {
    if (host !== loaded || manager.getSessionId() !== loaded.sessionId) throw new Error("Goal continuity source was replaced");
    owner.provider.assert(scope);
  } });
}
export function captureGoalSource(ctx?: GoalContext, signal?: AbortSignal): object {
  const inherited = execution.getStore();
  if (inherited) {
    assertGoalSource(inherited);
    if (ctx && (!host || ctx.cwd !== host.cwd || ctx.sessionManager !== host.manager)) throw new Error("Goal source context cannot be replaced during an operation.");
    if (signal) { addCancellation(inherited, signal); signal.throwIfAborted(); }
    return inherited;
  }
  if (!host || (ctx && (ctx.cwd !== host.cwd || ctx.sessionManager !== host.manager))) throw new Error("Goal caller does not own the loaded source.");
  const scope = owner.provider.capture(host);
  if (signal) addCancellation(scope, signal);
  signal?.throwIfAborted(); return scope;
}
export function assertGoalSource(scope: object = execution.getStore() ?? captureGoalSource()): void { for (const signal of cancellations.get(scope)??[]) signal.throwIfAborted(); owner.provider.assert(scope); }
export function withGoalSource<T>(scope: object, work: () => T): T {
  assertGoalSource(scope); return execution.run(scope, work);
}
export function appendGoalPublication(type: string, data: unknown, write: () => void): void {
  const scope = execution.getStore() ?? captureGoalSource();
  owner.append(type, data, write, () => assertGoalSource(scope));
}

export async function guardGoalAwait<T>(value: T | PromiseLike<T>): Promise<T> {
  const scope = execution.getStore();
  if (!scope) throw new Error("Goal async operation has no admitted source.");
  assertGoalSource(scope);
  try { const result=await value; assertGoalSource(scope); return result; }
  catch(error) { assertGoalSource(scope); throw error; }
}


/** Notification only; listeners must reassert their original lease. */
export function subscribeGoalSource(scope: object, changed: () => void): () => void {
  assertGoalSource(scope);
  const dispose = owner.provider.subscribe(scope, changed), signals = new Set<AbortSignal>();
  const attach = (signal: AbortSignal) => { if (signals.has(signal)) return; signals.add(signal); signal.addEventListener("abort", changed, { once: true }); if (signal.aborted) changed(); };
  const observers = cancellationObservers.get(scope) ?? new Set(); cancellationObservers.set(scope, observers); observers.add(attach);
  for (const signal of cancellations.get(scope) ?? []) attach(signal);
  return () => { dispose(); observers.delete(attach); for (const signal of signals) signal.removeEventListener("abort", changed); };
}
