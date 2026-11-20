import { validateTaskClearRef, validateTaskClearWitness, type TaskClearWitnessRef, type TaskClearWitness } from "./task-clear.ts";
import { validatePlanReplacementRef, validatePlanReplacementWitness, type PlanReplacementWitness, type PlanReplacementWitnessRef } from "./plan-replacement.ts";
import { createHash } from "node:crypto";

export const RECOVERY_SCHEMA = 1;
/** Budget tables are added only by the first successful budget mutation. */
export const BUDGET_RECOVERY_SCHEMA = 2;
/** Coverage metadata shares the original budget store and transaction. */
export const COVERAGE_RECOVERY_SCHEMA = 3;
export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
export const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export interface RecoverySource { workspace: string; sessionId: string; branchAnchor: string; }
/** M03 supplies projections; this mechanism never owns a Task status/map. */
export interface RecoveryContract {
  taskId: string; instanceId: string; submissionId: string; version: number; digest: string;
  input: unknown; inputDigest: string; output: unknown; source: RecoverySource; planPin?: string;
}
export interface RecoveryCandidate { id: string; bindingId: string; correlationId: string; runtimeGeneration: number | null; invocationId?: string; }
export interface RecoveryWork {
  epoch: number; inputGeneration: number; requestId: string; loopSeq: number;
  exitCode: number; terminalStatus: string; resultDigest: string;
}
export interface RecoveryClose { code: number | null; signal: string | null; processInstanceId: string; cleanupRequested: boolean; }
export interface RecoveryInput {
  command: string; payloadDigest: string; wireRequestId?: string;
  turn?: {epoch:number;state:string;queuedInputs:number;inputGeneration?:number;requestId?:string;loopSeq?:number;settledEpoch?:number};
}
export type RecoveryState = "admitted" | "pending" | "settled" | "closed-settled" | "failed" | "unknown" | "invalidated";
export interface RecoveryHead {
  taskClearWitness?: TaskClearWitnessRef;
  taskClearRecord?: TaskClearWitness;
  planReplacementWitness?: PlanReplacementWitnessRef;
  planReplacementRecord?: PlanReplacementWitness;
  journalWitness?: GoalDetachJournalWitness;
  slot: string; revision: number; admission: number; ownerGeneration: number; ownerId: string;
  /** Only a trusted M03 delete/clear creates this durable reuse fact. */
  tombstone?: true;
  state: RecoveryState; contract: RecoveryContract; executed?: RecoveryContract;
  candidate?: RecoveryCandidate; inputSequence: number; work?: RecoveryWork; close?: RecoveryClose;
  pendingInput?: RecoveryInput;
  /** Work-producing input is distinct from later same-turn UI/configuration wires. */
  modelInput?: RecoveryInput;
  associationId?:string;
  claim?: { id: string; source: RecoverySource; associationId?: string };
}
export interface OutputAssociation {
  id: string; kind: "original-M03-output-only" | "current-root-rechecked-output-only";
  executed: RecoveryContract; reviewed: RecoveryContract; transitionDigest: string;
}
export interface RestoredClosedExecution {
  kind: "restored-closed"; slot: string; revision: number; ownerGeneration: number; claimId: string;
  taskInstanceId: string; executedContractVersion: number; executedContractDigest: string;
  reviewedContractVersion: number; reviewedContractDigest: string; inputDigest: string;
  nativeInvocationId: string; work: RecoveryWork; close: RecoveryClose; associationId?: string;
}
export function assertCounter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new Error("Native recovery counter invalid/exhausted");
}
export function sameInput(a: RecoveryContract, b: RecoveryContract): boolean {
  return a.taskId === b.taskId && a.instanceId === b.instanceId && a.submissionId === b.submissionId
    && a.inputDigest === b.inputDigest && fingerprint(a.input) === fingerprint(b.input) && a.planPin === b.planPin
    && a.source.workspace === b.source.workspace && a.source.sessionId === b.source.sessionId;
}
export function validateHead(value: unknown): asserts value is RecoveryHead {
  if (!value || typeof value !== "object") throw new Error("Invalid native recovery head");
  const h = value as RecoveryHead;
  if (h.taskClearWitness !== undefined) validateTaskClearRef(h.taskClearWitness);
  if (h.taskClearRecord !== undefined) {
    validateTaskClearWitness(h.taskClearRecord);
    if (!h.taskClearWitness || h.taskClearWitness.id !== h.taskClearRecord.id || h.taskClearWitness.digest !== fingerprint(h.taskClearRecord) || h.taskClearWitness.coordinatorSlot !== h.slot) throw new Error("Invalid Task clear coordinator witness");
  }
  if (h.planReplacementWitness !== undefined) validatePlanReplacementRef(h.planReplacementWitness);
  if (h.planReplacementRecord !== undefined) {
    validatePlanReplacementWitness(h.planReplacementRecord);
    if (!h.planReplacementWitness || h.planReplacementWitness.id !== h.planReplacementRecord.id || h.planReplacementWitness.digest !== fingerprint(h.planReplacementRecord) || h.planReplacementWitness.coordinatorSlot !== h.slot) throw new Error("Invalid replacement witness coordinator");
  }
  if (h.journalWitness !== undefined) validateGoalDetachWitness(h.journalWitness);
  if (h.tombstone !== undefined && (h.tombstone !== true || h.state !== "invalidated")) throw new Error("Invalid native recovery tombstone");
  for (const n of [h.revision, h.admission, h.ownerGeneration, h.inputSequence, h.contract?.version]) assertCounter(n);
  if (!h.slot || h.contract?.taskId!==h.slot || !h.ownerId || !h.contract?.instanceId || !h.contract.source?.workspace || !h.contract.source.sessionId
    || !["admitted","pending","settled","closed-settled","failed","unknown","invalidated"].includes(h.state)
    || h.contract.inputDigest !== fingerprint(h.contract.input)) throw new Error("Invalid native recovery contract/head");
}

/** Immutable evidence for one native transition followed by one Task journal publication.
 * This is not a dispatch/input permit and is never accepted from a caller DTO. */
export interface GoalDetachJournalIntent {
  reason: "goal-detach";
  goalId: string;
  source: { workspace: string; sessionId: string; prefix: string[]; anchor: string | null; beforeEntryId: string | null; beforeEntryDigest: string };
  normalizedBeforeDigest: string;
  afterDigest: string;
  afterSemanticDigest: string;
  updatedAt: Record<string, number>;
}
export interface GoalDetachJournalWitness extends GoalDetachJournalIntent {
  version: 1;
  id: string;
  members: Array<{
    slot: string;
    kind: "ordinary" | "reopen" | "delete" | "create" | "admit";
    before: RecoveryContract | null;
    after: RecoveryContract | null;
    beforeRevision: number;
    beforeHeadHash: string | null;
    afterRevision: number;
    admission: number;
    ownerGeneration: number;
    afterCoreHash: string;
  }>;
}
export function recoveryHeadCoreHash(head: RecoveryHead): string {
  const { journalWitness: _witness, ...core } = head;
  return fingerprint(core);
}
export function validateGoalDetachWitness(value: unknown): asserts value is GoalDetachJournalWitness {
  if (!value || typeof value !== "object") throw new Error("Invalid native journal witness");
  const w = value as GoalDetachJournalWitness;
  const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const keys = (value: object, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
  if (!keys(w, ["version", "id", "reason", "goalId", "source", "normalizedBeforeDigest", "afterDigest", "afterSemanticDigest", "updatedAt", "members"])) throw new Error("Unknown native journal witness field");
  if (w.version !== 1 || !text(w.id) || w.reason !== "goal-detach" || !text(w.goalId)
    || !text(w.source?.workspace) || !text(w.source.sessionId) || !keys(w.source, ["workspace", "sessionId", "prefix", "anchor", "beforeEntryId", "beforeEntryDigest"]) || !Array.isArray(w.source.prefix) || !w.source.prefix.every(hash)
    || !(w.source.anchor === null || text(w.source.anchor)) || !(w.source.beforeEntryId === null || text(w.source.beforeEntryId))
    || !hash(w.source.beforeEntryDigest) || !hash(w.normalizedBeforeDigest) || !hash(w.afterDigest) || !hash(w.afterSemanticDigest)
    || !w.updatedAt || typeof w.updatedAt !== "object" || Array.isArray(w.updatedAt)
    || !Object.entries(w.updatedAt).every(([id, time]) => text(id) && Number.isFinite(time) && time >= 0)
    || !Array.isArray(w.members) || !w.members.length || new Set(w.members.map(member => member?.slot)).size !== w.members.length) {
    throw new Error("Invalid native journal witness envelope");
  }
  for (const member of w.members) {
    if (!member || !keys(member, ["slot", "kind", "before", "after", "beforeRevision", "beforeHeadHash", "afterRevision", "admission", "ownerGeneration", "afterCoreHash"]) || !text(member.slot) || member.kind !== "ordinary" || !member.before || !member.after
      || member.before.taskId !== member.slot || member.after.taskId !== member.slot
      || member.before.instanceId !== member.after.instanceId || member.before.submissionId !== member.after.submissionId
      || !hash(member.afterCoreHash)
      || !(member.beforeHeadHash === null || hash(member.beforeHeadHash))) throw new Error("Invalid native journal witness member");
    for (const contract of [member.before, member.after]) {
      assertCounter(contract.version);
      if (!text(contract.instanceId) || typeof contract.submissionId !== "string" || !hash(contract.digest) || !hash(contract.inputDigest)
        || contract.inputDigest !== fingerprint(contract.input) || contract.source?.workspace !== w.source.workspace
        || contract.source.sessionId !== w.source.sessionId || contract.source.branchAnchor !== (w.source.anchor ?? "")) throw new Error("Invalid native journal witness contract");
    }
    for (const value of [member.beforeRevision, member.afterRevision, member.admission, member.ownerGeneration]) assertCounter(value);
    if (member.afterRevision !== member.beforeRevision + 1 || (member.beforeRevision === 0) !== (member.beforeHeadHash === null)) throw new Error("Invalid native journal witness revision");
  }
}
