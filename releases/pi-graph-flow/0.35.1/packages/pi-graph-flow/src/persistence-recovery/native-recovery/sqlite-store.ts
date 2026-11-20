import type { DatabaseSync } from "node:sqlite";
import { constants, openSync, closeSync, fsyncSync, mkdirSync, lstatSync, realpathSync, chmodSync, existsSync, type Stats } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { applyBudgetCommand, createBudgetPool, type BudgetPoolScope, type BudgetPoolState, type BudgetHistory, type BudgetCommand, type BudgetUpdate } from "pi-graph-permission-core";
import { readStoredBudget, writeStoredBudget, validateBudgetSchema, upgradeCoverageSchema } from "./budget-store.ts";
import { assertCleanCoveragePool, readCoverageEpoch, writeCoverageEpoch, type CoverageEpoch, type CoverageOpen, type CoverageJournalCut } from "./coverage-store.ts";
import { COVERAGE_RECOVERY_SCHEMA, BUDGET_RECOVERY_SCHEMA, RECOVERY_SCHEMA, fingerprint, jsonCopy, validateHead, type RecoveryHead, type OutputAssociation } from "./contracts.ts";

export interface RecoveryStoreOptions { dataRoot: string; workspace: string; sessionId: string; boundary?: (name: string) => void; }
export interface RecoveryHeadMutation {
  slots: readonly string[];
  change: (heads: readonly (RecoveryHead | undefined)[]) => { heads: RecoveryHead[]; associations?: OutputAssociation[] };
}
export interface RecoveryBudgetWrite {
  scope: BudgetPoolScope;
  expectedRevision: number;
  command: BudgetCommand;
  /** Trusted original Goal history. Used only when this pool has no committed state. */
  initial?: { limit: number; history: BudgetHistory };
  /** Original issuer identity; absent only in the existing unregistered owner fixtures. */
  coverage?: CoverageOpen;
}
export type RecoveryCoverageWrite =
  | { kind: "open"; expectedRevision: 0; open: CoverageOpen }
  | { kind: "seal"; scope: BudgetPoolScope; expectedRevision: number; ownerId: string; hostEpoch: string; sealId: string; cut: CoverageJournalCut }
  | { kind: "claim"; scope: BudgetPoolScope; expectedRevision: number; sealId: string; ownerId: string; hostEpoch: string };
export type RecoveryStoreResult = { available: true; store: NativeRecoveryStore } | { available: false; kind: "capability-unavailable" | "storage-unavailable"; reason: string };
let sqliteModule: Promise<typeof import("node:sqlite")> | undefined;
/** No top-level node:sqlite value import: older hosts remain loadable. */
export async function openNativeRecoveryStore(options: RecoveryStoreOptions): Promise<RecoveryStoreResult> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqliteModule ??= import("node:sqlite");
    sqlite = await sqliteModule;
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ERR_UNKNOWN_BUILTIN_MODULE";
    return { available: false, kind: missing ? "capability-unavailable" : "storage-unavailable", reason: `Native recovery unavailable: ${String(error)}` };
  }
  if (typeof sqlite.DatabaseSync !== "function") return { available: false, kind: "capability-unavailable", reason: "Native recovery unavailable: DatabaseSync unavailable" };
  try { return { available: true, store: new NativeRecoveryStore(sqlite.DatabaseSync, options) }; }
  catch (error) { return { available: false, kind: "storage-unavailable", reason: `Native recovery unavailable: ${String(error)}` }; }
}

function syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function privateDirectory(path: string): void {
  if (!existsSync(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error(`Native recovery requires private real directory: ${path}`);
}
/** Independent M16 fact DB. It neither opens the runtime broker DB nor owns business state. */
export class NativeRecoveryStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #identity: { dev: number; ino: number };
  readonly #workspace: string;
  readonly #sessionId: string;
  readonly #Database: typeof DatabaseSync;
  readonly #canonicalOptions: RecoveryStoreOptions;
  readonly #boundary?: (name: string) => void;
  #busy = false;
  #closed = false;
  #connectionClosed = false;
  #uncertain = false;
  constructor(Database: typeof DatabaseSync, options: RecoveryStoreOptions) {
    if (!options.dataRoot || !options.workspace || !options.sessionId) throw new Error("Trusted native recovery dataRoot/workspace/session required");
    const root = realpathSync(options.dataRoot), workspace = realpathSync(options.workspace);
    this.#Database = Database;
    this.#canonicalOptions = Object.freeze({ ...options, dataRoot: root, workspace, sessionId: options.sessionId });
    this.#workspace = workspace; this.#sessionId = options.sessionId;
    let directory = root;
    const hashText=(text:string)=>createHash("sha256").update(text).digest("hex");
    for (const part of ["pi-graph-next", "native-recovery", "v1", hashText(workspace), hashText(options.sessionId)]) { directory = join(directory, part); privateDirectory(directory); }
    this.path = join(directory, "facts.sqlite"); this.#boundary = options.boundary;
    const fresh = !existsSync(this.path);
    if (fresh) { const fd = openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600); closeSync(fd); syncDirectory(directory); }
    const info = lstatSync(this.path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("Native recovery DB identity/permissions invalid");
    // Check before native SQLite is allowed to open any existing sidecar.
    for(const suffix of ["-wal","-shm","-journal"]){
      const sidecar=`${this.path}${suffix}`;
      let stat:Stats|undefined;
      try{stat=lstatSync(sidecar);}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
      if(stat&&(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)))throw new Error("Native recovery sidecar identity/permissions invalid before SQLite open");
    }
    this.#identity = { dev: info.dev, ino: info.ino };
    this.#db = new Database(this.path);
    try {
      this.#db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;");
      if (String(this.#db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode).toLowerCase() !== "wal") throw new Error("Native recovery WAL unavailable");
      this.#db.exec("PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;");
      if (this.#db.prepare("PRAGMA synchronous").get()?.synchronous !== 2) throw new Error("Native recovery FULL unavailable");
      const version = this.#db.prepare("PRAGMA user_version").get()?.user_version;
      if (fresh) {
        this.#db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE slot_heads(slot TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL);
          CREATE TABLE native_events(id TEXT PRIMARY KEY, slot TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL);
          CREATE TABLE output_associations(id TEXT PRIMARY KEY, slot TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL);
          PRAGMA user_version=${RECOVERY_SCHEMA}; COMMIT;`);
      } else if (version !== RECOVERY_SCHEMA && version !== BUDGET_RECOVERY_SCHEMA && version !== COVERAGE_RECOVERY_SCHEMA) throw new Error("Native recovery schema unavailable/incompatible");
      validateBudgetSchema(this.#db);
      if (this.#db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("Native recovery integrity check failed");
      this.#durable();
    } catch (error) { this.#db.close(); throw error; }
  }
  #assert(): void {
    if (this.#closed || this.#uncertain) throw new Error("Native recovery store unavailable/commit outcome unknown; reconcile without replay");
    this.#assertFileIdentity();
  }
  #assertFileIdentity(): void {
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077) || stat.dev !== this.#identity.dev || stat.ino !== this.#identity.ino) throw new Error("Native recovery DB identity changed");
  }
  /** Fixed original domain only. A fact owner must still validate the original
   * request and read the durable head; reopening never authorizes a new send. */
  reopenClosed(): NativeRecoveryStore {
    if (!this.#closed) throw new Error("Original native recovery store is still open");
    if (!this.#connectionClosed) throw new Error("Original native recovery store did not close successfully");
    this.#assertFileIdentity();
    const fresh = new NativeRecoveryStore(this.#Database, this.#canonicalOptions);
    try {
      this.#assertFileIdentity();
      if (fresh.path !== this.path) throw new Error("Original native recovery store domain changed");
      return fresh;
    } catch (error) { fresh.close(); throw error; }
  }
  #durable(): void {
    this.#assert();
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) if (existsSync(path)) {
      const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Native recovery sidecar identity invalid");
      chmodSync(path, 0o600);
    }
    syncDirectory(dirname(this.path)); this.#boundary?.("after-directory-sync"); this.#assert();
  }
  read(slot: string): RecoveryHead | undefined {
    this.#assert(); const row = this.#db.prepare("SELECT revision,body,hash FROM slot_heads WHERE slot=?").get(slot);
    if (!row) return undefined;
    const head: unknown = JSON.parse(String(row.body)); validateHead(head);
    if (head.slot !== slot || head.revision !== row.revision || fingerprint(head) !== row.hash) throw new Error("Native recovery head integrity mismatch");
    return head;
  }
  /** Exact historical row evidence; no recovery permission is inferred from a DTO. */
  readEvent(slot: string, revision: number): RecoveryHead | undefined {
    this.#assert();
    const rows = this.#db.prepare("SELECT slot,revision,body,hash FROM native_events WHERE slot=? AND revision=?").all(slot, revision);
    if (!rows.length) return undefined;
    if (rows.length !== 1) throw new Error("Native recovery event evidence is not unique");
    const row = rows[0]!;
    const head: unknown = JSON.parse(String(row.body)); validateHead(head);
    if (head.slot !== slot || head.revision !== revision || row.slot !== slot || row.revision !== revision || fingerprint(head) !== row.hash) throw new Error("Native recovery event evidence integrity mismatch");
    return head;
  }
  #budgetScope(scope: BudgetPoolScope): void {
    if (scope.workspace !== this.#workspace || scope.sessionId !== this.#sessionId) throw new Error("Native recovery budget scope outside trusted database domain");
  }
  readBudgetPool(scope: BudgetPoolScope): BudgetPoolState | undefined {
    this.#assert(); this.#budgetScope(scope);
    return readStoredBudget(this.#db, scope);
  }
  readCoverage(scope: BudgetPoolScope): CoverageEpoch | undefined {
    this.#assert(); this.#budgetScope(scope); validateBudgetSchema(this.#db);
    return readCoverageEpoch(this.#db, scope);
  }
  transactCoverage(write: RecoveryCoverageWrite, guard: () => void): CoverageEpoch {
    const scope = write.kind === "open" ? write.open.scope : write.scope;
    this.#budgetScope(scope);
    return this.#transaction(() => {
      validateBudgetSchema(this.#db);
      const before = readCoverageEpoch(this.#db, scope), pool = readStoredBudget(this.#db, scope);
      if ((before?.revision ?? 0) !== write.expectedRevision) throw new Error("Budget coverage revision changed");
      let next: CoverageEpoch;
      if (write.kind === "open") {
        if (before || pool) throw new Error("Existing Goal history has no continuous coverage epoch");
        next = { ...jsonCopy(write.open), revision: 1, generation: 1, phase: "open" };
      } else {
        if (!before) throw new Error("Original coverage epoch unavailable");
        assertCleanCoveragePool(pool);
        if (write.kind === "seal") {
          if (before.phase !== "open" || before.ownerId !== write.ownerId || before.hostEpoch !== write.hostEpoch) throw new Error("Coverage sealing owner changed");
          next = { ...before, revision: before.revision + 1, phase: "sealed", seal: { id: write.sealId, cut: jsonCopy(write.cut),
            pool: pool ? { revision: pool.revision, digest: fingerprint(pool) } : null } };
        } else {
          if (before.phase !== "sealed" || before.seal?.id !== write.sealId
            || (before.seal.pool ? !pool || before.seal.pool.revision !== pool.revision || before.seal.pool.digest !== fingerprint(pool) : Boolean(pool))) {
            throw new Error("Original coverage seal or pool head changed");
          }
          const { seal, ...original } = before;
          next = { ...original, revision: before.revision + 1, generation: before.generation + 1,
            ownerId: write.ownerId, hostEpoch: write.hostEpoch, phase: "open", parentSeal: { id: seal!.id, digest: fingerprint(before) } };
        }
      }
      upgradeCoverageSchema(this.#db); writeCoverageEpoch(this.#db, before, next); return next;
    }, guard);
  }
  /** Budget and optional original native intent share this connection and one COMMIT. */
  transactBudget(write: RecoveryBudgetWrite, guard: () => void, native?: RecoveryHeadMutation): { budget: BudgetUpdate; heads: RecoveryHead[] } {
    this.#budgetScope(write.scope);
    return this.#transaction(() => {
      const before = readStoredBudget(this.#db, write.scope);
      const epoch = readCoverageEpoch(this.#db, write.scope);
      if (epoch && !write.coverage) throw new Error("Existing budget coverage epoch requires its original issuer identity");
      if (write.coverage && (write.coverage.coverageVersion !== 1 || fingerprint(write.coverage.scope) !== fingerprint(write.scope)
        || (epoch ? epoch.phase !== "open" || epoch.ownerId !== write.coverage.ownerId || epoch.hostEpoch !== write.coverage.hostEpoch
          || fingerprint(epoch.birth) !== fingerprint(write.coverage.birth) : Boolean(before)))) {
        throw new Error("Budget request coverage epoch is missing, closed, or owned by another host");
      }
      if (!before && (!write.initial || write.expectedRevision !== 0)) throw new Error("Native recovery budget requires explicit trusted initial history and revision zero");
      const state = before ?? createBudgetPool(write.scope, write.initial!.limit, write.initial!.history);
      const budget = applyBudgetCommand(state, write.expectedRevision, write.command);
      if (!budget.changed) return { budget, heads: [] };
      writeStoredBudget(this.#db, before, budget.state);
      if (write.coverage && !epoch) {
        upgradeCoverageSchema(this.#db);
        writeCoverageEpoch(this.#db, undefined, { ...jsonCopy(write.coverage), revision: 1, generation: 1, phase: "open" });
      }
      const heads = native ? this.#writeHeads(native.slots, native.change) : [];
      return { budget, heads };
    }, guard);
  }
  /** One atomic head mutation for all participating visible slots. Unknown commits are never replayed. */
  transact(slots: readonly string[], change: RecoveryHeadMutation["change"], guard: () => void): RecoveryHead[] {
    return this.#transaction(() => this.#writeHeads(slots, change), guard);
  }
  #writeHeads(slots: readonly string[], change: RecoveryHeadMutation["change"]): RecoveryHead[] {
    const before = slots.map(slot => this.read(slot)), next = change(jsonCopy(before));
    if (next.heads.length !== slots.length || new Set(slots).size !== slots.length) throw new Error("Native recovery slot set mismatch");
    for (const [i, head] of next.heads.entries()) {
      validateHead(head); if (head.slot !== slots[i] || head.revision !== (before[i]?.revision ?? 0) + 1) throw new Error("Native recovery revision mismatch");
      const body = JSON.stringify(head), hash = fingerprint(head);
      if (before[i]) {
        if (Number(this.#db.prepare("UPDATE slot_heads SET revision=?,body=?,hash=? WHERE slot=? AND revision=?").run(head.revision,body,hash,head.slot,before[i]!.revision).changes) !== 1) throw new Error("Native recovery CAS conflict");
      } else this.#db.prepare("INSERT INTO slot_heads VALUES(?,?,?,?)").run(head.slot,head.revision,body,hash);
      this.#db.prepare("INSERT INTO native_events VALUES(?,?,?,?,?)").run(randomUUID(),head.slot,head.revision,body,hash);
    }
    for (const association of next.associations ?? []) this.#db.prepare("INSERT INTO output_associations VALUES(?,?,?,?)").run(association.id,next.heads.find(head=>head.contract.taskId===association.reviewed.taskId)!.slot,JSON.stringify(association),fingerprint(association));
    return next.heads;
  }
  #transaction<T>(change: () => T, guard: () => void): T {
    this.#assert(); if (this.#busy) throw new Error("Native recovery reentrant transaction refused");
    this.#busy = true; let begun = false, commitAttempted = false;
    try {
      guard(); this.#db.exec("BEGIN IMMEDIATE"); begun = true;
      const next = change();
      guard(); this.#boundary?.("before-commit"); commitAttempted = true; this.#db.exec("COMMIT");
      this.#boundary?.("after-commit"); this.#durable(); guard(); return jsonCopy(next);
    } catch (error) {
      if (begun && !commitAttempted) try { this.#db.exec("ROLLBACK"); } catch { this.#uncertain = true; }
      if (commitAttempted) this.#uncertain = true;
      throw new Error(`Native recovery ${commitAttempted ? "commit outcome requires reconciliation; no input retry" : "transaction refused"}: ${String(error)}`);
    } finally { this.#busy = false; }
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); this.#connectionClosed = true; } }
}
