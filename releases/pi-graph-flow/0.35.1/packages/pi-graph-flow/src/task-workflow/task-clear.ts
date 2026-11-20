import { fingerprint as digest } from "../persistence-recovery/native-recovery/contracts.ts";
import { validateNativeBefore, type NativeBeforePin } from "../persistence-recovery/native-recovery/plan-replacement.ts";
import { replacementTaskBodyDigest, validateReplacementGroups } from "./plan-replacement.ts";
import { taskBusinessContractDigest } from "./execution-contract.ts";
import type { TodoTask } from "./types.ts";
import type { DeliveryGroup } from "./delivery-group.ts";

export interface TaskClearRecord {
  version: 1; id: string; phase: "reserved" | "complete"; kind: "local" | "mirror-only"; createdAt: number;
  source: { workspace: string; sessionId: string; anchor: string; prefixIdentityHashes: string[] };
  snapshot: { entryId: string; stateDigest: string; contents: { ref: string; entryId: string }[] };
  members: { id: string; instanceId: string; body: TodoTask; bodyDigest: string }[];
  groups: { id: string; digest: string; body: DeliveryGroup }[];
  goals: { id: string; delivery: boolean; quality: boolean }[];
  allocatorHighWater: number; nativeBefore: NativeBeforePin[]; requestDigest: string; nativeWitnessId?: string;
}
export const TASK_CLEAR_EVIDENCE_TYPE = "pi-graph-next:todo-clear-evidence";
export interface TaskClearEvidencePin { entryId: string; digest: string; }
export interface TaskClearIntent {
  version: 1; phase: "intent"; record: TaskClearRecord;
  previous?: TaskClearEvidencePin; reservationDigest: string;
}
export interface TaskClearTerminal {
  version: 1; phase: "terminal"; record: TaskClearRecord;
  intent: TaskClearEvidencePin; reservation: TaskClearEvidencePin; publicationDigest: string;
}
export type TaskClearEvidence = TaskClearIntent | TaskClearTerminal;
export interface LoadedTaskClearEvidence {
  pins: TaskClearEvidencePin[];
  lastTerminal?: TaskClearEvidencePin;
  pending?: { intent: TaskClearIntent; pin: TaskClearEvidencePin; reservation?: TaskClearEvidencePin; terminal?: TaskClearTerminal };
}
export function validateTaskClearEvidence(value: unknown): asserts value is TaskClearEvidence {
  const phase = (value as {phase?:unknown} | null)?.phase;
  keys(value, phase === "intent" ? ["version","phase","record","previous","reservationDigest"] : ["version","phase","record","intent","reservation","publicationDigest"]);
  const evidence=value as unknown as TaskClearEvidence;
  if(evidence.version!==1 || !["intent","terminal"].includes(evidence.phase))throw new Error("Invalid Task clear evidence phase");
  validateClearRecord(evidence.record);
  const pin=(v:TaskClearEvidencePin)=>{keys(v,["entryId","digest"]);if(!text(v.entryId)||!hash(v.digest))throw new Error("Invalid Task clear evidence pin");};
  if(evidence.phase==="intent") {
    if(evidence.record.phase!=="reserved"||!hash(evidence.reservationDigest))throw new Error("Invalid Task clear intent");
    if(evidence.previous!==undefined)pin(evidence.previous);
  } else {
    if(evidence.record.phase!=="complete"||!hash(evidence.publicationDigest))throw new Error("Invalid Task clear terminal");
    pin(evidence.intent);pin(evidence.reservation);
  }
}
export interface ClearEntry { id?: string; parentId?: string | null; type?: string; customType?: string; data?: unknown; }
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function keys(v: unknown, names: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(key => !names.includes(key))) throw new Error("Invalid Task clear fields");
}
function counter(v: unknown): void { if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid Task clear counter"); }
export function clearRequestDigest(r: TaskClearRecord): string {
  return digest(["task-clear-request", 1, r.id, r.kind, r.createdAt, r.source, r.snapshot, r.members, r.groups, r.goals, r.allocatorHighWater, r.nativeBefore]);
}
export function pendingTaskClear(records: readonly TaskClearRecord[]): TaskClearRecord | undefined {
  const pending = records.filter(r => r.phase === "reserved");
  if (pending.length > 1) throw new Error("Multiple pending Task clears require reconciliation");
  return pending[0];
}
export function taskIsCleared(records: readonly TaskClearRecord[], id: string): boolean {
  return records.some(r => r.phase === "complete" && r.members.some(member => member.id === id));
}
export function groupIsCleared(records: readonly TaskClearRecord[], id: string): boolean {
  return records.some(r => r.phase === "complete" && r.groups.some(group => group.id === id));
}
export function goalClearGeneration(records: readonly TaskClearRecord[], id: string): string | undefined {
  const relevant = records.filter(r => r.goals.some(goal => goal.id === id));
  return relevant.length ? digest(["task-clear-goal-generation", 1, relevant.map(r => [r.id, r.requestDigest, r.goals.find(goal => goal.id === id)])]) : undefined;
}
export function validateClearRecord(value: unknown): asserts value is TaskClearRecord {
  keys(value, ["version", "id", "phase", "kind", "createdAt", "source", "snapshot", "members", "groups", "goals", "allocatorHighWater", "nativeBefore", "requestDigest", "nativeWitnessId"]);
  const r = value as unknown as TaskClearRecord;
  if (r.version !== 1 || !text(r.id) || !["reserved", "complete"].includes(r.phase) || !["local", "mirror-only"].includes(r.kind)) throw new Error("Invalid Task clear identity");
  counter(r.createdAt); counter(r.allocatorHighWater);
  keys(r.source, ["workspace", "sessionId", "anchor", "prefixIdentityHashes"]);
  if (![r.source.workspace, r.source.sessionId, r.source.anchor].every(text) || !Array.isArray(r.source.prefixIdentityHashes) || !r.source.prefixIdentityHashes.length || !r.source.prefixIdentityHashes.every(hash)) throw new Error("Invalid Task clear source");
  keys(r.snapshot, ["entryId", "stateDigest", "contents"]);
  if (!text(r.snapshot.entryId) || !hash(r.snapshot.stateDigest) || !Array.isArray(r.snapshot.contents)) throw new Error("Invalid Task clear snapshot");
  for (const pin of r.snapshot.contents) { keys(pin, ["ref", "entryId"]); if (!hash(pin.ref) || !text(pin.entryId)) throw new Error("Invalid Task clear content pin"); }
  if (new Set(r.snapshot.contents.map(pin => pin.ref)).size !== r.snapshot.contents.length || !Array.isArray(r.members) || !r.members.length || new Set(r.members.map(m => m.id)).size !== r.members.length) throw new Error("Invalid Task clear members");
  for (const m of r.members) {
    keys(m, ["id", "instanceId", "body", "bodyDigest"]);
    if (!text(m.id) || !text(m.instanceId) || m.body?.id !== m.id || m.body.taskInstanceId !== m.instanceId || !hash(m.bodyDigest) || replacementTaskBodyDigest(m.body) !== m.bodyDigest) throw new Error("Invalid Task clear original body");
    if (/^\d+$/.test(m.id) && Number(m.id) > r.allocatorHighWater) throw new Error("Task clear allocator regressed");
  }
  if (!Array.isArray(r.groups) || new Set(r.groups.map(g => g.id)).size !== r.groups.length) throw new Error("Invalid Task clear groups");
  for (const g of r.groups) { keys(g, ["id", "digest", "body"]); if (!text(g.id) || g.body?.id !== g.id || digest(g.body) !== g.digest || !g.body.members.every(m => r.members.some(member => member.id === m.taskId && member.instanceId === m.taskInstanceId))) throw new Error("Task clear group snapshot differs"); }
  if (!Array.isArray(r.goals) || new Set(r.goals.map(g => g.id)).size !== r.goals.length) throw new Error("Invalid Task clear Goal relations");
  for (const g of r.goals) { keys(g, ["id", "delivery", "quality"]); if (!text(g.id) || typeof g.delivery !== "boolean" || typeof g.quality !== "boolean" || !g.delivery && !g.quality
    || g.delivery !== r.groups.some(group => group.body.deliveryGoalId === g.id && !group.body.supersededBy)
    || g.quality !== r.members.some(m => m.body.goalId === g.id && m.body.status !== "deleted" && !m.body.supersessionId)) throw new Error("Task clear Goal relation differs"); }
  const expectedGoals = new Set([...r.groups.filter(g => !g.body.supersededBy).flatMap(g => g.body.deliveryGoalId ? [g.body.deliveryGoalId] : []), ...r.members.filter(m => m.body.status !== "deleted" && !m.body.supersessionId).flatMap(m => m.body.goalId ? [m.body.goalId] : [])]);
  if (expectedGoals.size !== r.goals.length || r.goals.some(g => !expectedGoals.has(g.id))) throw new Error("Task clear Goal relation missing");
  const local = r.members.filter(m => !m.body.origin).map(m => m.id);
  if (r.kind === "local") { if (!local.length) throw new Error("Task clear local class differs"); validateNativeBefore(r.nativeBefore, local); }
  else if (local.length || !Array.isArray(r.nativeBefore) || r.nativeBefore.length) throw new Error("Task clear mirror class differs");
  if (!hash(r.requestDigest) || clearRequestDigest(r) !== r.requestDigest || (r.phase === "complete" && r.kind === "local" ? !text(r.nativeWitnessId) : r.nativeWitnessId !== undefined)) throw new Error("Task clear request/publication differs");
}
export function assertClearSnapshot(r: TaskClearRecord, branch: readonly ClearEntry[], workspace: string, sessionId: string): void {
  if (r.source.workspace !== workspace || r.source.sessionId !== sessionId || branch.length < r.source.prefixIdentityHashes.length
    || branch[r.source.prefixIdentityHashes.length - 1]?.id !== r.source.anchor
    || branch.slice(0, r.source.prefixIdentityHashes.length).some((e, i) => digest({ id: e.id, parentId: e.parentId, type: e.type, customType: e.customType }) !== r.source.prefixIdentityHashes[i])) throw new Error("Task clear original source/prefix changed");
  const matches = branch.filter(e => e.id === r.snapshot.entryId && e.type === "custom" && e.customType === "pi-graph-next:todo-state");
  if (matches.length !== 1 || digest(matches[0]!.data) !== r.snapshot.stateDigest) throw new Error("Task clear original snapshot changed");
  for (const pin of r.snapshot.contents) {
    const entries = branch.filter(e => e.id === pin.entryId && e.type === "custom" && e.customType === "pi-graph-next:todo-content");
    const data = entries[0]?.data as { contents?: Record<string, unknown> } | undefined;
    if (entries.length !== 1 || digest(data?.contents?.[pin.ref]) !== pin.ref) throw new Error("Task clear original material changed");
  }
}
export function validateClearHistory(records: readonly TaskClearRecord[], tasks: ReadonlyMap<string, TodoTask>, groups: readonly DeliveryGroup[]): void {
  if (!Array.isArray(records)) throw new Error("Invalid Task clear history");
  validateReplacementGroups(groups, tasks);
  const ids = new Set<string>(), members = new Set<string>(); let hwm = 0;
  for (const r of records) {
    validateClearRecord(r);
    if (ids.has(r.id) || r.allocatorHighWater < hwm) throw new Error("Task clear history identity/HWM differs"); ids.add(r.id); hwm = r.allocatorHighWater;
    for(const snapshot of r.groups) {
      const current=groups.find(group=>group.id===snapshot.id);
      if(!current)throw new Error("Task clear historical group missing");
      const original=snapshot.body, prior=original.replacementHistory??[], receipts=current.replacementHistory??[];
      if(receipts.length<prior.length || prior.some((receipt,index)=>digest(receipt)!==digest(receipts[index])))throw new Error("Task clear historical group receipt prefix changed");
      const appended=receipts.slice(prior.length);
      if(appended.length && (r.phase!=="complete" || original.supersededBy || original.currentPendingReplacementId || appended.some(receipt=>receipt.predecessor.groupId!==original.id)))throw new Error("Task clear historical group evolution is not canonical D2");
      const expected=structuredClone(original);
      if(appended.length) {
        expected.replacementHistory=structuredClone(receipts);
        const pending=appended.find(receipt=>receipt.phase==="reserved"||receipt.phase==="tasks-published");
        const published=appended.find(receipt=>receipt.phase==="tasks-published"||receipt.phase==="complete");
        if(pending)expected.currentPendingReplacementId=pending.id;else delete expected.currentPendingReplacementId;
        if(published)expected.supersededBy={replacementId:published.id,groupId:published.successor.groupId};
      }
      if(digest(expected)!==digest(current))throw new Error("Task clear historical group body changed");
    }
    for (const m of r.members) {
      if (members.has(m.id)) throw new Error("Task cleared more than once"); members.add(m.id);
      const current = tasks.get(m.id); if (!current || current.taskInstanceId !== m.instanceId) throw new Error("Task clear historical member lost/reused");
      const expected = structuredClone(m.body);
      // Only canonical D2 phase metadata may evolve after this immutable clear snapshot.
      if (current.replacementPendingId !== expected.replacementPendingId || current.supersessionId !== expected.supersessionId) {
        const replacement = groups.flatMap(g => g.replacementHistory ?? []).find(p => p.id === (current.supersessionId ?? current.replacementPendingId));
        if (r.phase !== "complete" || !replacement || !replacement.request.oldTaskPins.some(p => p.id === m.id && p.instanceId === m.instanceId) || expected.supersessionId) throw new Error("Unproved archived Task metadata change");
        if (current.replacementPendingId) expected.replacementPendingId = replacement.id; else delete expected.replacementPendingId;
        if (current.supersessionId) { expected.supersessionId = replacement.id; expected.supersededByGroupId = replacement.successor.groupId; expected.contractVersion = m.body.contractVersion! + 1; expected.contractDigest = taskBusinessContractDigest(expected); }
      }
      if (replacementTaskBodyDigest(expected) !== replacementTaskBodyDigest(current)) throw new Error("Task clear historical body changed");
    }
  }
  const pending = pendingTaskClear(records);
  if (pending && groups.some(g => g.currentPendingReplacementId)) throw new Error("Task clear and Plan replacement cannot both be pending");
}
