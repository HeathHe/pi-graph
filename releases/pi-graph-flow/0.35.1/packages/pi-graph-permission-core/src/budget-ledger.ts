/** Pure reservation decisions. M16 supplies trusted facts and commits the returned snapshot. */

export interface BudgetPoolScope {
  readonly workspace: string;
  readonly sessionId: string;
  readonly goalId: string;
}

export interface BudgetFactReference {
  readonly factRef: string;
  readonly digest: string;
}

export interface BudgetHistoricalDebit extends BudgetFactReference {
  readonly units: number;
}

export interface BudgetHistory {
  readonly kind: "known" | "unknown";
  readonly debits: readonly BudgetHistoricalDebit[];
}

export interface BudgetRequestIdentity {
  readonly reservationId: string;
  readonly requestKey: string;
  readonly sourceHash: string;
  readonly attemptKey: string;
}

export interface BudgetReservationInput extends BudgetRequestIdentity {
  readonly reservedUnits: number;
}

export type BudgetReservation = BudgetReservationInput & { readonly revision: number } & (
  | { readonly phase: "reserved" | "may-have-sent" | "unknown" | "settled" }
  | { readonly phase: "released"; readonly notSentProofRef: string }
);

export type BudgetUsageReceipt = BudgetFactReference & { readonly receiptId: string } & (
  | { readonly kind: "known"; readonly units: number }
  | { readonly kind: "unknown" }
);

export type BudgetReceiptReference = BudgetUsageReceipt & { readonly reservationId: string };

/** All persisted fields are JSON values. The unit counts input plus output tokens. */
export interface BudgetPoolState {
  readonly scope: BudgetPoolScope;
  readonly unit: "tokens";
  readonly revision: number;
  readonly limit: number;
  readonly history: BudgetHistory;
  readonly reservations: readonly BudgetReservation[];
  readonly receipts: readonly BudgetReceiptReference[];
}

export type BudgetCommand =
  | { readonly kind: "reserve"; readonly request: BudgetReservationInput }
  | { readonly kind: "mark-may-have-sent"; readonly request: BudgetRequestIdentity }
  | { readonly kind: "record-receipt"; readonly request: BudgetRequestIdentity; readonly receipt: BudgetUsageReceipt }
  | { readonly kind: "release"; readonly request: BudgetRequestIdentity; readonly notSentProofRef: string }
  | { readonly kind: "set-limit"; readonly limit: number };

export interface BudgetUpdate {
  readonly changed: boolean;
  readonly state: BudgetPoolState;
}

export interface BudgetPoolBalance {
  readonly limit: number;
  readonly held: bigint;
  readonly consumed: bigint;
  /** Capacity for new reservations. Existing reservations may already own all capacity. */
  readonly available: number;
  readonly blockedBy?: "historical-usage-unknown" | "usage-unknown" | "reservation-overrun" | "exhausted";
}

type BudgetLedgerErrorCode = "invalid" | "stale-revision" | "conflict" | "missing-request" | "invalid-transition" |
  "exhausted" | "unknown-usage" | "overrun";

export class BudgetLedgerError extends Error {
  constructor(readonly code: BudgetLedgerErrorCode, message: string) {
    super(message);
    this.name = "BudgetLedgerError";
  }
}

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BudgetLedgerError("invalid", `${label} must be a nonempty string`);
  }
}

function requireInteger(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new BudgetLedgerError("invalid", `${label} must be a safe integer of at least ${minimum}`);
  }
}

export function budgetPoolKey(scope: BudgetPoolScope): string {
  requireText(scope.workspace, "Canonical workspace");
  requireText(scope.sessionId, "Durable session id");
  requireText(scope.goalId, "Goal id");
  return JSON.stringify([scope.workspace, scope.sessionId, scope.goalId]);
}

function validateRequest(request: BudgetRequestIdentity): void {
  requireText(request.reservationId, "Reservation id");
  requireText(request.requestKey, "Request key");
  requireText(request.sourceHash, "Source hash");
  requireText(request.attemptKey, "Attempt key");
}

function copyRequest(request: BudgetRequestIdentity): BudgetRequestIdentity {
  return {
    reservationId: request.reservationId,
    requestKey: request.requestKey,
    sourceHash: request.sourceHash,
    attemptKey: request.attemptKey,
  };
}

function sameRequest(left: BudgetRequestIdentity, right: BudgetRequestIdentity): boolean {
  return left.reservationId === right.reservationId && left.requestKey === right.requestKey &&
    left.sourceHash === right.sourceHash && left.attemptKey === right.attemptKey;
}

function validateFact(fact: BudgetFactReference): void {
  requireText(fact.factRef, "Usage fact reference");
  requireText(fact.digest, "Usage fact digest");
}

function validateReceipt(receipt: BudgetUsageReceipt): void {
  validateFact(receipt);
  requireText(receipt.receiptId, "Receipt id");
  if (receipt.kind === "known") {
    requireInteger(receipt.units, "Measured usage");
  } else if (receipt.kind !== "unknown" || "units" in receipt) {
    throw new BudgetLedgerError("invalid", "Unknown usage must have no measured units");
  }
}

function sameReceipt(previous: BudgetReceiptReference, next: BudgetUsageReceipt, reservationId: string): boolean {
  return previous.reservationId === reservationId && previous.kind === next.kind &&
    previous.factRef === next.factRef && previous.digest === next.digest &&
    (next.kind === "unknown" || (previous.kind === "known" && previous.units === next.units));
}

/** Check a loaded snapshot and derive its balances from the original fact references. */
function inspectPool(state: BudgetPoolState) {
  budgetPoolKey(state.scope);
  requireInteger(state.limit, "Budget limit");
  requireInteger(state.revision, "Pool revision");
  if (state.unit !== "tokens" || !["known", "unknown"].includes(state.history.kind)) {
    throw new BudgetLedgerError("invalid", "Invalid budget unit or history");
  }
  const requests = new Map<string, BudgetReservation>();
  const reservations = new Map<string, BudgetReservation>();
  const receipts = new Map<string, BudgetReceiptReference>();
  const facts = new Set<string>();
  const known = new Set<string>();
  const unknown = new Set<string>();
  let consumed = 0n;
  let held = 0n;
  let overrun = false;

  function recordFact(fact: BudgetFactReference): void {
    if (facts.has(fact.factRef)) throw new BudgetLedgerError("conflict", "Usage fact reference already recorded");
    facts.add(fact.factRef);
  }

  for (const debit of state.history.debits) {
    validateFact(debit);
    requireInteger(debit.units, "Historical usage");
    recordFact(debit);
    consumed += BigInt(debit.units);
  }
  for (const reservation of state.reservations) {
    validateRequest(reservation);
    requireInteger(reservation.reservedUnits, "Reserved usage", 1);
    requireInteger(reservation.revision, "Reservation revision", 1);
    if (reservation.revision > state.revision || requests.has(reservation.requestKey) || reservations.has(reservation.reservationId)) {
      throw new BudgetLedgerError("conflict", "Invalid reservation revision or duplicate request identity");
    }
    requests.set(reservation.requestKey, reservation);
    reservations.set(reservation.reservationId, reservation);
  }
  for (const receipt of state.receipts) {
    validateReceipt(receipt);
    const reservation = reservations.get(receipt.reservationId);
    if (!reservation || receipts.has(receipt.receiptId)) {
      throw new BudgetLedgerError("conflict", "Receipt has no reservation or duplicates an existing receipt id");
    }
    recordFact(receipt);
    const group = receipt.kind === "known" ? known : unknown;
    if (group.has(receipt.reservationId)) throw new BudgetLedgerError("conflict", "Duplicate settlement observation");
    group.add(receipt.reservationId);
    receipts.set(receipt.receiptId, receipt);
    if (receipt.kind === "known") {
      consumed += BigInt(receipt.units);
      overrun ||= receipt.units > reservation.reservedUnits;
    }
  }
  for (const reservation of state.reservations) {
    const id = reservation.reservationId;
    if ((reservation.phase === "settled") !== known.has(id) ||
        (reservation.phase === "unknown" && !unknown.has(id)) ||
        (unknown.has(id) && reservation.phase !== "settled" && reservation.phase !== "unknown")) {
      throw new BudgetLedgerError("invalid", "Reservation phase disagrees with its receipt references");
    }
    switch (reservation.phase) {
      case "released": requireText(reservation.notSentProofRef, "Not-sent proof reference"); break;
      case "settled": break;
      case "reserved":
      case "may-have-sent":
      case "unknown": held += BigInt(reservation.reservedUnits); break;
      default: throw new BudgetLedgerError("invalid", "Invalid reservation phase");
    }
  }

  const remaining = BigInt(state.limit) - held - consumed;
  let blockedBy: BudgetPoolBalance["blockedBy"];
  if (state.history.kind === "unknown") blockedBy = "historical-usage-unknown";
  else if ([...unknown].some(id => !known.has(id))) blockedBy = "usage-unknown";
  else if (overrun) blockedBy = "reservation-overrun";
  else if (remaining <= 0n) blockedBy = "exhausted";
  const balance: BudgetPoolBalance = { limit: state.limit, held, consumed, available: blockedBy ? 0 : Number(remaining), blockedBy };
  return { balance, requests, reservations, receipts, facts };
}

export function createBudgetPool(scope: BudgetPoolScope, limit: number, history: BudgetHistory): BudgetPoolState {
  const state: BudgetPoolState = {
    scope: { workspace: scope.workspace, sessionId: scope.sessionId, goalId: scope.goalId },
    unit: "tokens",
    revision: 0,
    limit,
    history: { kind: history.kind, debits: history.debits.map(({ factRef, digest, units }) => ({ factRef, digest, units })) },
    reservations: [],
    receipts: [],
  };
  inspectPool(state);
  return state;
}

export function inspectBudgetPool(state: BudgetPoolState): BudgetPoolBalance {
  return inspectPool(state).balance;
}

/** A changed send mark is usable only after M16 confirms its commit and lease. */
export function applyBudgetCommand(state: BudgetPoolState, expectedRevision: number, command: BudgetCommand): BudgetUpdate {
  requireInteger(expectedRevision, "Expected pool revision");
  if (expectedRevision !== state.revision) throw new BudgetLedgerError("stale-revision", "Budget pool revision changed");
  const { balance, requests, reservations, receipts, facts } = inspectPool(state);
  const unchanged = (): BudgetUpdate => ({ changed: false, state });
  const update = (fields: Partial<Pick<BudgetPoolState, "limit" | "reservations" | "receipts">>): BudgetUpdate => {
    const revision = state.revision + 1;
    requireInteger(revision, "Next pool revision");
    return { changed: true, state: { ...state, ...fields, revision } };
  };
  const requireSendCapacity = (): void => {
    if (balance.blockedBy === "historical-usage-unknown" || balance.blockedBy === "usage-unknown") {
      throw new BudgetLedgerError("unknown-usage", "Budget usage is unknown");
    }
    if (balance.blockedBy === "reservation-overrun") throw new BudgetLedgerError("overrun", "Measured usage exceeded a reservation");
    if (state.limit === 0 || balance.consumed + balance.held > BigInt(state.limit)) {
      throw new BudgetLedgerError("exhausted", "Budget limit cannot cover held and consumed usage");
    }
  };

  if (command.kind === "set-limit") {
    requireInteger(command.limit, "Budget limit");
    return state.limit === command.limit ? unchanged() : update({ limit: command.limit });
  }

  validateRequest(command.request);
  const existing = requests.get(command.request.requestKey);
  const byId = reservations.get(command.request.reservationId);
  if (byId !== existing || (existing && !sameRequest(existing, command.request))) {
    throw new BudgetLedgerError("conflict", "Request identity conflicts with an existing reservation");
  }
  if (command.kind === "reserve") {
    requireInteger(command.request.reservedUnits, "Reserved usage", 1);
    if (existing) {
      if (existing.reservedUnits !== command.request.reservedUnits) {
        throw new BudgetLedgerError("conflict", "Request reservation amount changed");
      }
      return unchanged();
    }
    requireSendCapacity();
    if (command.request.reservedUnits > balance.available) throw new BudgetLedgerError("exhausted", "Insufficient budget for reservation");
    const reservation: BudgetReservation = {
      ...copyRequest(command.request), reservedUnits: command.request.reservedUnits,
      revision: state.revision + 1, phase: "reserved",
    };
    return update({ reservations: [...state.reservations, reservation] });
  }
  if (!existing) throw new BudgetLedgerError("missing-request", "Request has no budget reservation");
  const replace = (reservation: BudgetReservation) => state.reservations.map(row => row === existing ? reservation : row);
  const revision = state.revision + 1;

  if (command.kind === "mark-may-have-sent") {
    if (existing.phase === "may-have-sent") return unchanged();
    if (existing.phase !== "reserved") throw new BudgetLedgerError("invalid-transition", "Request is not awaiting its first send");
    requireSendCapacity();
    return update({ reservations: replace({ ...existing, revision, phase: "may-have-sent" }) });
  }
  if (command.kind === "release") {
    requireText(command.notSentProofRef, "Not-sent proof reference");
    if (existing.phase === "released") {
      if (existing.notSentProofRef !== command.notSentProofRef) throw new BudgetLedgerError("conflict", "Not-sent proof changed");
      return unchanged();
    }
    if (existing.phase !== "reserved") throw new BudgetLedgerError("invalid-transition", "Request may already have been sent");
    return update({ reservations: replace({ ...existing, revision, phase: "released", notSentProofRef: command.notSentProofRef }) });
  }
  if (command.kind !== "record-receipt") throw new BudgetLedgerError("invalid", "Unknown budget command");
  const receipt = command.receipt;
  validateReceipt(receipt);
  const previous = receipts.get(receipt.receiptId);
  if (previous) {
    if (!sameReceipt(previous, receipt, existing.reservationId)) throw new BudgetLedgerError("conflict", "Receipt identity or measured usage changed");
    return unchanged();
  }
  if (facts.has(receipt.factRef)) throw new BudgetLedgerError("conflict", "Usage fact reference already recorded");
  if (existing.phase !== "may-have-sent" && !(existing.phase === "unknown" && receipt.kind === "known")) {
    throw new BudgetLedgerError("invalid-transition", "Receipt cannot settle this reservation phase");
  }
  const identity = { reservationId: existing.reservationId, receiptId: receipt.receiptId, factRef: receipt.factRef, digest: receipt.digest };
  const reference: BudgetReceiptReference = receipt.kind === "known"
    ? { ...identity, kind: "known", units: receipt.units }
    : { ...identity, kind: "unknown" };
  return update({
    reservations: replace({ ...existing, revision, phase: receipt.kind === "known" ? "settled" : "unknown" }),
    receipts: [...state.receipts, reference],
  });
}
