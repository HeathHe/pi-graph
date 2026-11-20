import { fingerprint, assertCounter, type RecoveryContract, type RecoveryHead } from "./contracts.ts";
import { validateNativeBefore, type NativeBeforePin } from "./plan-replacement.ts";
export interface TaskClearIntent {
  clearId: string; requestDigest: string; source: { workspace: string; sessionId: string; prefixIdentityHashes: string[]; beforeEntryId: string; beforeEntryDigest: string };
  nativeBefore: NativeBeforePin[]; publication: { state: unknown; contents: Record<string, Record<string, unknown>>; stateDigest: string };
}
export interface TaskClearWitness extends TaskClearIntent {
  version: 1; reason: "task-clear"; id: string;
  members: { slot: string; before: RecoveryContract; afterRevision: number; admission: number; ownerGeneration: number; afterCoreHash: string }[];
}
export interface TaskClearWitnessRef { version: 1; id: string; coordinatorSlot: string; coordinatorRevision: number; digest: string; }
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && !!v;
function keys(v: unknown, allowed: string[]): void { if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k))) throw new Error("Invalid native Task clear fields"); }
export function taskClearHeadCoreHash(head: RecoveryHead): string { const { taskClearWitness: _ref, taskClearRecord: _record, ...core } = head; return fingerprint(core); }
export function validateTaskClearRef(value: unknown): asserts value is TaskClearWitnessRef {
  keys(value, ["version", "id", "coordinatorSlot", "coordinatorRevision", "digest"]); const r = value as TaskClearWitnessRef;
  assertCounter(r.coordinatorRevision); if (r.version !== 1 || !text(r.id) || !text(r.coordinatorSlot) || r.coordinatorRevision < 1 || !hash(r.digest)) throw new Error("Invalid native Task clear reference");
}
export function validateTaskClearWitness(value: unknown): asserts value is TaskClearWitness {
  keys(value, ["version", "reason", "id", "clearId", "requestDigest", "source", "nativeBefore", "publication", "members"]); const w = value as TaskClearWitness;
  if (w.version !== 1 || w.reason !== "task-clear" || !text(w.id) || !text(w.clearId) || !hash(w.requestDigest)) throw new Error("Invalid native Task clear identity");
  keys(w.source, ["workspace", "sessionId", "prefixIdentityHashes", "beforeEntryId", "beforeEntryDigest"]);
  if (![w.source.workspace,w.source.sessionId,w.source.beforeEntryId].every(text) || !hash(w.source.beforeEntryDigest) || !Array.isArray(w.source.prefixIdentityHashes) || !w.source.prefixIdentityHashes.length || !w.source.prefixIdentityHashes.every(hash)) throw new Error("Invalid native Task clear source");
  keys(w.publication, ["state", "contents", "stateDigest"]);
  if (!hash(w.publication.stateDigest) || fingerprint(w.publication.state) !== w.publication.stateDigest || !w.publication.contents || typeof w.publication.contents !== "object" || Array.isArray(w.publication.contents)) throw new Error("Invalid native Task clear state");
  for (const [ref, content] of Object.entries(w.publication.contents)) if (!hash(ref) || fingerprint(content) !== ref) throw new Error("Invalid native Task clear content");
  if (!Array.isArray(w.members) || !w.members.length) throw new Error("Missing native Task clear members");
  validateNativeBefore(w.nativeBefore, w.members.map(m => m.slot));
  for (const [i,m] of w.members.entries()) {
    keys(m, ["slot", "before", "afterRevision", "admission", "ownerGeneration", "afterCoreHash"]); const pin=w.nativeBefore[i]!;
    for (const n of [m.afterRevision,m.admission,m.ownerGeneration,m.before?.version]) assertCounter(n);
    if (!m.before || m.before.taskId !== m.slot || !text(m.before.instanceId) || !hash(m.before.digest) || fingerprint(m.before.input) !== m.before.inputDigest
      || m.before.source.workspace !== w.source.workspace || m.before.source.sessionId !== w.source.sessionId || m.afterRevision !== pin.revision+1 || m.admission !== pin.admission+1 || m.ownerGeneration !== pin.ownerGeneration+1 || !hash(m.afterCoreHash)) throw new Error("Invalid native Task clear member");
  }
}
