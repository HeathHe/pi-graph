import type { DatabaseSync } from "node:sqlite";
import {
  budgetPoolKey, inspectBudgetPool,
  type BudgetPoolScope, type BudgetPoolState, type BudgetReservation, type BudgetReceiptReference,
} from "pi-graph-permission-core";
import { COVERAGE_SCHEMA_SQL } from "./coverage-store.ts";
import { COVERAGE_RECOVERY_SCHEMA, BUDGET_RECOVERY_SCHEMA, RECOVERY_SCHEMA, fingerprint } from "./contracts.ts";

const originalTables = {
  slot_heads: "CREATE TABLE slot_heads(slot TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL)",
  native_events: "CREATE TABLE native_events(id TEXT PRIMARY KEY, slot TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL)",
  output_associations: "CREATE TABLE output_associations(id TEXT PRIMARY KEY, slot TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL)",
};
const budgetTables = {
  budget_pool_heads: "CREATE TABLE budget_pool_heads(pool_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, unit TEXT NOT NULL, budget_limit INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL)",
  budget_reservations: "CREATE TABLE budget_reservations(reservation_id TEXT PRIMARY KEY, pool_key TEXT NOT NULL REFERENCES budget_pool_heads(pool_key), request_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, state TEXT NOT NULL, reserved_units INTEGER NOT NULL, source_hash TEXT NOT NULL, attempt_key TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL)",
  budget_receipt_refs: "CREATE TABLE budget_receipt_refs(receipt_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES budget_reservations(reservation_id), digest TEXT NOT NULL, usage_kind TEXT NOT NULL, units INTEGER, fact_ref TEXT NOT NULL UNIQUE)",
};

/** Runs on the original M16 connection. This module never opens or commits a DB. */
export function validateBudgetSchema(db: DatabaseSync): number {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (version !== RECOVERY_SCHEMA && version !== BUDGET_RECOVERY_SCHEMA && version !== COVERAGE_RECOVERY_SCHEMA) throw new Error("Native recovery schema unavailable/incompatible");
  const expected: Record<string, string> = version === RECOVERY_SCHEMA ? originalTables : { ...originalTables, ...budgetTables,
    ...(version === COVERAGE_RECOVERY_SCHEMA ? { budget_coverage_epochs: COVERAGE_SCHEMA_SQL } : {}) };
  const rows = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  const normalize = (sql: string) => sql.replace(/\s+/g, "").toLowerCase();
  if (rows.length !== Object.keys(expected).length || rows.some(row => row.type !== "table" ||
      typeof row.name !== "string" || !expected[row.name] || normalize(String(row.sql)) !== normalize(expected[row.name]!))) {
    throw new Error("Native recovery exact schema shape mismatch");
  }
  return version;
}

export function upgradeBudgetSchema(db: DatabaseSync): void {
  if (validateBudgetSchema(db) >= BUDGET_RECOVERY_SCHEMA) return;
  for (const sql of Object.values(budgetTables)) db.exec(sql);
  db.exec(`PRAGMA user_version=${BUDGET_RECOVERY_SCHEMA}`);
}

export function upgradeCoverageSchema(db: DatabaseSync): void {
  if (validateBudgetSchema(db) === COVERAGE_RECOVERY_SCHEMA) return;
  upgradeBudgetSchema(db); db.exec(COVERAGE_SCHEMA_SQL); db.exec(`PRAGMA user_version=${COVERAGE_RECOVERY_SCHEMA}`);
}

/** One SQLite statement reads a consistent head, reservations and original usage references. */
export function readStoredBudget(db: DatabaseSync, scope: BudgetPoolScope): BudgetPoolState | undefined {
  const key = budgetPoolKey(scope);
  if (db.prepare("PRAGMA user_version").get()?.user_version === RECOVERY_SCHEMA) return undefined;
  const row = db.prepare(`SELECT h.*,
    (SELECT json_group_array(json_object('body',r.body,'hash',r.hash,'reservationId',r.reservation_id,
      'requestKey',r.request_key,'revision',r.revision,'phase',r.state,'reservedUnits',r.reserved_units,
      'sourceHash',r.source_hash,'attemptKey',r.attempt_key)) FROM
      (SELECT * FROM budget_reservations WHERE pool_key=h.pool_key ORDER BY rowid) r) AS reservations,
    (SELECT json_group_array(json_object('reservationId',c.reservation_id,'receiptId',c.receipt_id,
      'factRef',c.fact_ref,'digest',c.digest,'kind',c.usage_kind,'units',c.units)) FROM
      (SELECT c.* FROM budget_receipt_refs c JOIN budget_reservations r ON r.reservation_id=c.reservation_id
       WHERE r.pool_key=h.pool_key ORDER BY c.rowid) c) AS receipts
    FROM budget_pool_heads h WHERE pool_key=?`).get(key);
  if (!row) return undefined;
  const body = JSON.parse(String(row.body));
  const reservations: BudgetReservation[] = JSON.parse(String(row.reservations)).map((entry: Record<string, unknown>) => {
    const reservation: BudgetReservation = JSON.parse(String(entry.body));
    if (fingerprint(reservation) !== entry.hash || reservation.reservationId !== entry.reservationId ||
        reservation.requestKey !== entry.requestKey || reservation.revision !== entry.revision ||
        reservation.phase !== entry.phase || reservation.reservedUnits !== entry.reservedUnits ||
        reservation.sourceHash !== entry.sourceHash || reservation.attemptKey !== entry.attemptKey) {
      throw new Error("Native recovery budget reservation integrity mismatch");
    }
    return reservation;
  });
  const receipts: BudgetReceiptReference[] = JSON.parse(String(row.receipts)).map((receipt: BudgetReceiptReference & { units: number | null }) => {
    if (receipt.kind === "unknown") {
      if (receipt.units !== null) throw new Error("Unknown budget receipt contains measured usage");
      const { units: _units, ...reference } = receipt;
      return reference;
    }
    return receipt;
  });
  const state: BudgetPoolState = {
    scope: body.scope, unit: row.unit as "tokens", revision: Number(row.revision), limit: Number(row.budget_limit),
    history: body.history, reservations, receipts,
  };
  inspectBudgetPool(state);
  if (budgetPoolKey(state.scope) !== key || fingerprint(state) !== row.hash) throw new Error("Native recovery budget head integrity mismatch");
  return state;
}

export function writeStoredBudget(db: DatabaseSync, before: BudgetPoolState | undefined, next: BudgetPoolState): void {
  inspectBudgetPool(next);
  upgradeBudgetSchema(db);
  const key = budgetPoolKey(next.scope), body = JSON.stringify({ scope: next.scope, history: next.history }), hash = fingerprint(next);
  if (before) {
    if (Number(db.prepare("UPDATE budget_pool_heads SET revision=?,unit=?,budget_limit=?,body=?,hash=? WHERE pool_key=? AND revision=?")
      .run(next.revision, next.unit, next.limit, body, hash, key, before.revision).changes) !== 1) throw new Error("Native recovery budget CAS conflict");
  } else db.prepare("INSERT INTO budget_pool_heads VALUES(?,?,?,?,?,?)").run(key, next.revision, next.unit, next.limit, body, hash);
  for (const reservation of next.reservations) {
    const previous = before?.reservations.find(row => row.reservationId === reservation.reservationId);
    if (previous && fingerprint(previous) === fingerprint(reservation)) continue;
    const values = [reservation.requestKey, reservation.revision, reservation.phase, reservation.reservedUnits,
      reservation.sourceHash, reservation.attemptKey, JSON.stringify(reservation), fingerprint(reservation)];
    if (previous) {
      if (Number(db.prepare(`UPDATE budget_reservations SET request_key=?,revision=?,state=?,reserved_units=?,source_hash=?,attempt_key=?,body=?,hash=?
        WHERE reservation_id=? AND pool_key=? AND revision=?`).run(...values, reservation.reservationId, key, previous.revision).changes) !== 1) {
        throw new Error("Native recovery budget reservation CAS conflict");
      }
    } else db.prepare(`INSERT INTO budget_reservations(request_key,revision,state,reserved_units,source_hash,attempt_key,body,hash,reservation_id,pool_key)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(...values, reservation.reservationId, key);
  }
  for (const receipt of next.receipts) {
    if (before?.receipts.some(row => row.receiptId === receipt.receiptId)) continue;
    db.prepare("INSERT INTO budget_receipt_refs VALUES(?,?,?,?,?,?)").run(receipt.receiptId, receipt.reservationId,
      receipt.digest, receipt.kind, receipt.kind === "known" ? receipt.units : null, receipt.factRef);
  }
}
