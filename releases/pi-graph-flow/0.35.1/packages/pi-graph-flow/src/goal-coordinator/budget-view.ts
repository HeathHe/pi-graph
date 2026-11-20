import { inspectBudgetPool, type BudgetPoolState } from "pi-graph-permission-core";
import type { GoalBudgetScope } from "./budget-source.ts";

/** A disposable read model. None of these fields are a reservation or permit. */
export interface GoalBudgetView {
  readonly version: 1;
  readonly kind: "none" | "uninitialized" | "ledger" | "unknown" | "unavailable";
  readonly admission: "none" | "first-reservation" | "ready" | "waiting" | "exhausted" | "unknown" | "unavailable";
  readonly declaredLimit?: number;
  readonly poolLimit?: number;
  readonly revision?: number;
  readonly knownConsumed?: string;
  readonly held?: string;
  readonly available?: number;
  readonly unknownRequests?: number;
  readonly reason?: string;
  readonly progress?: number;
  readonly text: string;
}
export interface GoalBudgetViewPort {
  read(scope: GoalBudgetScope): GoalBudgetView;
  subscribe(changed: (goalId: string) => void): () => void;
}
/** Separate configuration capability, never passed to a renderer/subscriber. */
export interface GoalBudgetConfigurationPort {
  syncDeclaredLimit(scope: GoalBudgetScope, assertOperationCurrent?: () => void): Promise<void>;
}
export function unavailableBudgetView(reason = "owner-not-ready", limit?: number): GoalBudgetView {
  return { version: 1, kind: "unavailable", admission: "unavailable", ...(limit === undefined ? {} : { declaredLimit: limit }), reason, text: "预算状态暂不可用" };
}
export function uninitializedBudgetView(limit: number): GoalBudgetView {
  return { version: 1, kind: "uninitialized", admission: limit === 0 ? "exhausted" : "first-reservation", declaredLimit: limit,
    text: limit === 0 ? "预算上限 0，尚未登记用量" : `上限 ${limit}，待首次请求登记` };
}
export function projectBudgetView(pool: BudgetPoolState, limit: number, coverage: boolean, closing: boolean): GoalBudgetView {
  const balance = inspectBudgetPool(pool), consumed = balance.consumed, held = balance.held;
  const known = new Set(pool.receipts.filter(row => row.kind === "known").map(row => row.reservationId));
  const unknownRequests = pool.receipts.filter(row => row.kind === "unknown" && !known.has(row.reservationId)).length;
  const unknown = pool.history.kind === "unknown" || unknownRequests > 0 || !coverage;
  const reason = !coverage ? "coverage-unavailable" : pool.history.kind === "unknown" ? "historical-usage-unknown"
    : unknownRequests ? "usage-unknown" : closing ? "owner-closing" : pool.limit !== limit ? "limit-sync-pending" : balance.blockedBy === "reservation-overrun" ? "reservation-overrun" : undefined;
  const admission: GoalBudgetView["admission"] = unknown ? "unknown" : closing || pool.limit !== limit || reason === "reservation-overrun" ? "unavailable"
    : consumed >= BigInt(limit) ? "exhausted" : held > 0n && balance.available === 0 ? "waiting" : "ready";
  const detail = unknown ? "用量待核" : admission === "waiting" ? "等待在途请求结算" : admission === "exhausted" ? "预算已耗尽"
    : reason === "limit-sync-pending" ? "新上限尚未确认" : admission === "unavailable" ? "暂不可发送" : `可用 ${balance.available}`;
  return { version: 1, kind: unknown ? "unknown" : "ledger", admission, declaredLimit: limit, poolLimit: pool.limit,
    revision: pool.revision, knownConsumed: String(consumed), held: String(held), available: balance.available, unknownRequests,
    ...(reason ? { reason } : {}), ...(!unknown ? { progress: limit === 0 ? 0 : consumed >= BigInt(limit) ? 1 : Number(consumed) / limit } : {}),
    text: `已记 ${consumed}/${limit} · 在途 ${held} · ${detail}` };
}
export function budgetCanContinue(view: GoalBudgetView): boolean { return view.admission === "none" || view.admission === "ready" || view.admission === "first-reservation"; }
export function legacyGoalBudgetText(limit?: number): string { return limit === undefined ? "无预算（父会话局部遥测）" : "预算状态未提供"; }
