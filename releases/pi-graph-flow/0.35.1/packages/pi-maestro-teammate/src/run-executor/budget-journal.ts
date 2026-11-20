import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CHILD_BUDGET_INTENT = "pi-graph:child-model-request/1";
export const childBudgetDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Row = Record<string, unknown>;
/** Stable response/token semantics; original entry digests still cover ALL fields. */
export function childReceiptDigests(message: unknown): Readonly<{ messageDigest: string; usageDigest: string }> {
  const value = message && typeof message === "object" ? message as Row : {};
  const usage = value.usage && typeof value.usage === "object" ? value.usage as Row : {};
  const tokens = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens };
  const semantics = { role: value.role, api: value.api, provider: value.provider, model: value.model,
    responseModel: value.responseModel, responseId: value.responseId, content: value.content,
    stopReason: value.stopReason, rawStopReason: value.rawStopReason, endTurn: value.endTurn,
    deferred: value.deferred, errorMessage: value.errorMessage, usage: tokens };
  return Object.freeze({ messageDigest: childBudgetDigest(semantics), usageDigest: childBudgetDigest(tokens) });
}
interface Locator { file: string; sessionId: string; }
interface Cut { locator: Locator; dev: number; ino: number; prefixBytes: number; prefixRows: number; prefixDigest: string; leaf: unknown; claim: string; intent?: string; }
interface UsageFact { request: object; entryId: string; digest: string; units: number; }
const facts = new WeakMap<object, UsageFact>();
export function readChildJournalFact(fact: object, request: object): Readonly<UsageFact> {
  const value = facts.get(fact);
  if (!value || value.request !== request) throw new Error("Trusted post-append SDK usage fact capability unavailable for this unissued/foreign request: Unissued child journal fact or foreign request");
  return value;
}
/** Launch paths are parent-owned. The ready envelope is only a candidate identity. */
export class ChildBudgetJournal {
  #ready?: Locator;
  readonly #cuts = new WeakMap<object, Cut>();
  constructor(readonly launch: { cwd: string; sessionDir?: string; resumeSessionFile?: string; forkSessionFile?: string }) {}
  observeReady(message: Record<string, unknown>): void {
    if (message.type !== "teammate_session_ready") return;
    this.#ready = undefined;
    if (typeof message.sessionId !== "string" || !message.sessionId || typeof message.sessionFile !== "string") throw new Error("Child session identity is incomplete");
    const file = resolve(message.sessionFile);
    if (this.launch.resumeSessionFile) {
      if (file !== resolve(this.launch.resumeSessionFile)) throw new Error("Child session is outside the original resume launch");
    } else {
      if (!this.launch.sessionDir || realpathSync(dirname(file)) !== realpathSync(this.launch.sessionDir)
        || !file.endsWith(`_${message.sessionId}.jsonl`)) throw new Error("Child session is outside the original launch directory");
    }
    this.#ready = { file, sessionId: message.sessionId };
  }
  #read(locator: Locator): { rows: Row[]; bytes: Buffer; dev: number; ino: number } {
    const stat = lstatSync(locator.file);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(locator.file) !== resolve(locator.file)) throw new Error("Child journal is not the original regular file");
    const bytes = readFileSync(locator.file);
    const rows = bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Row);
    const header = rows[0];
    if (!header || header.type !== "session" || header.version !== 3 || header.id !== locator.sessionId || header.cwd !== this.launch.cwd) throw new Error("Child journal header does not match the actual launch");
    if (!this.launch.resumeSessionFile && (this.launch.forkSessionFile
      ? header.parentSession !== this.launch.forkSessionFile : header.parentSession !== undefined)) throw new Error("Child journal parent lineage changed");
    const after = lstatSync(locator.file);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.isSymbolicLink()) throw new Error("Child journal file changed while reading");
    return { rows, bytes, dev: stat.dev, ino: stat.ino };
  }
  begin(request: object, claim: string): void {
    if (!this.#ready) throw new Error("Original child session publisher is not ready");
    const locator = { ...this.#ready }, file = this.#read(locator);
    this.#cuts.set(request, { locator, dev: file.dev, ino: file.ino,
      prefixBytes: file.bytes.length, prefixRows: file.rows.length,
      prefixDigest: createHash("sha256").update(file.bytes).digest("hex"), leaf: file.rows.at(-1)?.id ?? null, claim });
  }
  bindRequest(cutHandle: object, request: object): void {
    const cut = this.#cuts.get(cutHandle);
    if (!cut || this.#cuts.has(request)) throw new Error("Child journal cut is unavailable or already bound");
    this.#cuts.delete(cutHandle); this.#cuts.set(request, cut);
  }
  release(request: object): void { this.#cuts.delete(request); }
  #current(request: object): { cut: Cut; rows: Row[] } {
    const cut = this.#cuts.get(request);
    if (!cut) throw new Error("Child request has no original journal cut");
    const file = this.#read(cut.locator);
    if (file.dev !== cut.dev || file.ino !== cut.ino || file.bytes.length < cut.prefixBytes
      || createHash("sha256").update(file.bytes.subarray(0, cut.prefixBytes)).digest("hex") !== cut.prefixDigest) throw new Error("Child journal original prefix or inode changed");
    return { cut, rows: file.rows };
  }
  mark(request: object, entryId: string, digest: string): void {
    const { cut, rows } = this.#current(request);
    const index = rows.findIndex(row => row.id === entryId), intent = rows[index];
    if (cut.intent || index < cut.prefixRows || !intent || childBudgetDigest(intent) !== digest
      || intent.type !== "custom" || intent.customType !== CHILD_BUDGET_INTENT || intent.parentId !== cut.leaf
      || childBudgetDigest(intent.data) !== childBudgetDigest({ claim: cut.claim })) throw new Error("Child request intent is foreign, old, or reused");
    cut.intent = entryId;
  }
  fact(request: object, entryId: string, digest: string, terminal: {
    messageDigest: string; usageDigest: string; provider: string; model: string; stopReason: string;
  }): object | undefined {
    const { cut, rows } = this.#current(request), index = rows.findIndex(row => row.id === entryId), entry = rows[index];
    if (!cut.intent || index < cut.prefixRows || !entry || childBudgetDigest(entry) !== digest) throw new Error("Child receipt is not a durable original entry");
    const byId = new Map(rows.map(row => [row.id, row]));
    let parent = entry.parentId; const seen = new Set<unknown>();
    while (parent !== cut.intent && parent !== null && parent !== undefined && !seen.has(parent)) {
      seen.add(parent); const ancestor = byId.get(parent);
      if (ancestor?.type === "custom" && ancestor.customType === CHILD_BUDGET_INTENT) throw new Error("Child receipt belongs to a different physical request intent");
      parent = ancestor?.parentId;
    }
    if (parent !== cut.intent) throw new Error("Child receipt is outside the original request branch");
    const message = entry.type === "message" && entry.message && typeof entry.message === "object" ? entry.message as Row : undefined;
    const usage = message ? message.usage : entry.type === "usage" ? entry.usage : undefined;
    if (message ? message.role !== "assistant" || message.stopReason !== terminal.stopReason || childReceiptDigests(message).messageDigest !== terminal.messageDigest
      : entry.type !== "usage" || entry.provider !== terminal.provider || entry.model !== terminal.model
        || childReceiptDigests({ usage }).usageDigest !== terminal.usageDigest) throw new Error("Child receipt does not match its original SDK terminal");
    if (!usage || typeof usage !== "object") return undefined;
    const u = usage as Row, pieces = [u.input, u.output, u.cacheRead, u.cacheWrite];
    if (!pieces.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) throw new Error("Child usage evidence is incomplete");
    const total = (pieces as number[]).reduce((a, n) => a + n, 0), units = (u.input as number) + (u.output as number);
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(units) || u.totalTokens !== total) throw new Error("Child usage total is invalid");
    if (!total) return undefined; // Default SDK zero is not usage-presence evidence.
    const fact = Object.freeze({}); facts.set(fact, Object.freeze({ request, entryId, digest, units })); return fact;
  }
}
