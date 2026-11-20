import type { DatabaseSync } from "node:sqlite";
import { budgetPoolKey, inspectBudgetPool, type BudgetPoolScope, type BudgetPoolState } from "pi-graph-permission-core";
import { assertCounter, fingerprint } from "./contracts.ts";

export const COVERAGE_SCHEMA_SQL = "CREATE TABLE budget_coverage_epochs(epoch_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, generation INTEGER NOT NULL, owner_id TEXT NOT NULL, phase TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL)";
export interface CoveragePin { entryId: string; digest: string; }
export interface CoverageJournalCut {
  path: string; device: string; inode: string; bytes: number; digest: string; leafId: string; branchDigest: string;
}
export interface CoverageOpen {
  scope: BudgetPoolScope; ownerId: string; hostEpoch: string; birth: CoveragePin; coverageVersion: 1;
}
export interface CoverageEpoch extends CoverageOpen {
  revision: number; generation: number; phase: "open" | "sealed";
  parentSeal?: { id: string; digest: string };
  seal?: { id: string; cut: CoverageJournalCut; pool: { revision: number; digest: string } | null };
}
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const hash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const keys = (x: object, allowed: readonly string[]) => Object.keys(x).every(key => allowed.includes(key));
export function validateCoverageEpoch(value: unknown): asserts value is CoverageEpoch {
  if (!value || typeof value !== "object") throw new Error("Invalid budget coverage epoch");
  const x = value as CoverageEpoch;
  if (!keys(x, ["scope", "ownerId", "hostEpoch", "birth", "coverageVersion", "revision", "generation", "phase", "parentSeal", "seal"])
    || !x.scope || !keys(x.scope, ["workspace", "sessionId", "goalId"]) || ![x.scope.workspace, x.scope.sessionId, x.scope.goalId, x.ownerId, x.hostEpoch].every(text)
    || !x.birth || !keys(x.birth, ["entryId", "digest"]) || !text(x.birth.entryId) || !hash(x.birth.digest)
    || x.coverageVersion !== 1 || !["open", "sealed"].includes(x.phase)) throw new Error("Invalid budget coverage epoch fields");
  assertCounter(x.revision); assertCounter(x.generation);
  if (!x.revision || !x.generation) throw new Error("Invalid budget coverage epoch counters");
  if (x.parentSeal && (!keys(x.parentSeal, ["id", "digest"]) || !text(x.parentSeal.id) || !hash(x.parentSeal.digest))) throw new Error("Invalid coverage parent seal");
  if ((x.phase === "sealed") !== Boolean(x.seal)) throw new Error("Coverage seal phase mismatch");
  if (x.seal) {
    const c = x.seal.cut;
    if (!keys(x.seal, ["id", "cut", "pool"]) || !text(x.seal.id) || !c || !keys(c, ["path", "device", "inode", "bytes", "digest", "leafId", "branchDigest"])
      || ![c.path, c.device, c.inode, c.leafId].every(text) || !hash(c.digest) || !hash(c.branchDigest)) throw new Error("Invalid coverage journal cut");
    assertCounter(c.bytes);
    if (x.seal.pool !== null) {
      if (!x.seal.pool || !keys(x.seal.pool, ["revision", "digest"]) || !hash(x.seal.pool.digest)) throw new Error("Invalid coverage pool head");
      assertCounter(x.seal.pool.revision);
    }
  }
}
export function readCoverageEpoch(db: DatabaseSync, scope: BudgetPoolScope): CoverageEpoch | undefined {
  if (Number(db.prepare("PRAGMA user_version").get()?.user_version) < 3) return undefined;
  const row = db.prepare("SELECT * FROM budget_coverage_epochs WHERE epoch_key=?").get(budgetPoolKey(scope));
  if (!row) return undefined;
  const value: unknown = JSON.parse(String(row.body)); validateCoverageEpoch(value);
  if (budgetPoolKey(value.scope) !== row.epoch_key || value.revision !== row.revision || value.generation !== row.generation
    || value.ownerId !== row.owner_id || value.phase !== row.phase || fingerprint(value) !== row.hash) throw new Error("Budget coverage epoch integrity mismatch");
  return value;
}
/** Called only inside the original NativeRecoveryStore transaction. */
export function writeCoverageEpoch(db: DatabaseSync, before: CoverageEpoch | undefined, next: CoverageEpoch): void {
  validateCoverageEpoch(next);
  if (before && (budgetPoolKey(before.scope) !== budgetPoolKey(next.scope) || next.revision !== before.revision + 1)) throw new Error("Budget coverage revision changed");
  const body = JSON.stringify(next), hash = fingerprint(next), key = budgetPoolKey(next.scope);
  if (before) {
    if (Number(db.prepare("UPDATE budget_coverage_epochs SET revision=?,generation=?,owner_id=?,phase=?,body=?,hash=? WHERE epoch_key=? AND revision=?")
      .run(next.revision, next.generation, next.ownerId, next.phase, body, hash, key, before.revision).changes) !== 1) throw new Error("Budget coverage CAS conflict");
  } else db.prepare("INSERT INTO budget_coverage_epochs VALUES(?,?,?,?,?,?,?)").run(key, next.revision, next.generation, next.ownerId, next.phase, body, hash);
}
export function assertCleanCoveragePool(pool: BudgetPoolState | undefined): void {
  if (!pool) return; // Only the original owner may authorize an uninitialized birth.
  const balance = inspectBudgetPool(pool);
  if (pool.history.kind !== "known" || balance.held !== 0n || pool.reservations.some(r => r.phase !== "settled" && r.phase !== "released")
    || balance.blockedBy === "usage-unknown" || balance.blockedBy === "historical-usage-unknown") throw new Error("Goal coverage cannot close with unmeasured or active requests");
}
