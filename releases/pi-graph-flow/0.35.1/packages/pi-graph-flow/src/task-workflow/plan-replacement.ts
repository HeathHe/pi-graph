import { fingerprint as digest } from "../persistence-recovery/native-recovery/contracts.ts";
import { validateNativeBefore, type NativeBeforePin } from "../persistence-recovery/native-recovery/plan-replacement.ts";
import type { DeliveryGroup } from "./delivery-group.ts";
import type { TodoTask } from "./types.ts";

export interface ReplacePlanInput { expectedGroupId: string; expectedGroupDigest: string; expectedPlanHandoffKey: string; reason: string; }
export interface ReplacementPlanPin { handoffKey: string; revision: number; checksum: string; }
export interface PlanReplacementReceipt {
  version: 1; id: string; phase: "reserved" | "tasks-published" | "complete" | "aborted";
  source: { workspace: string; sessionId: string; predecessorAnchor: string; prefixIdentityHashes: string[] };
  predecessor: { groupId: string; groupDigest: string; plan: ReplacementPlanPin };
  successor: { groupId: string; plan: ReplacementPlanPin };
  parentGoal?: { id: string; oldPlanHandoffKey: string | null; contractEpoch: number; contractDigest: string };
  reason: string; createdAt: number; requestDigest: string; reservedIds: string[]; allocatorHighWater: number;
  nativeBefore: NativeBeforePin[];
  request: { newTasks: TodoTask[]; newGroup: DeliveryGroup; oldTaskPins: { id: string; instanceId: string; version: number; digest: string; bodyDigest: string }[] };
  taskPublication?: { witnessId: string; stateDigest: string; newGroupDigest: string };
  goalPublication?: { goalId: string; contractEpoch: number; goalContractDigest: string; entryId: string; dataDigest: string };
  abort?: { reason: string; nativeBeforeDigest: string };
}
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function record(v: unknown, fields: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(key => !fields.includes(key))) throw new Error("Invalid plan replacement fields");
}
function counter(v: unknown): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid plan replacement counter");
}
export function validateReplacePlanInput(v: unknown): asserts v is ReplacePlanInput {
  record(v, ["expectedGroupId", "expectedGroupDigest", "expectedPlanHandoffKey", "reason"]);
  if (!text(v.expectedGroupId) || !hash(v.expectedGroupDigest) || !text(v.expectedPlanHandoffKey) || !text(v.reason)) throw new Error("Explicit plan replacement requires exact current group pins and a reason");
}
export function replacementRequestDigest(r: PlanReplacementReceipt): string {
  return digest([1, r.id, r.source, r.predecessor, r.successor, r.parentGoal, r.reason, r.createdAt,
    r.reservedIds, r.allocatorHighWater, r.nativeBefore, r.request]);
}
export function validateReplacementReceipt(v: unknown): asserts v is PlanReplacementReceipt {
  record(v, ["version", "id", "phase", "source", "predecessor", "successor", "parentGoal", "reason", "createdAt", "requestDigest", "reservedIds", "allocatorHighWater", "nativeBefore", "request", "taskPublication", "goalPublication", "abort"]);
  const r = v as unknown as PlanReplacementReceipt;
  if (r.version !== 1 || !text(r.id) || !["reserved", "tasks-published", "complete", "aborted"].includes(r.phase) || !text(r.reason) || !hash(r.requestDigest)) throw new Error("Invalid plan replacement receipt");
  counter(r.createdAt); counter(r.allocatorHighWater);
  record(r.source, ["workspace", "sessionId", "predecessorAnchor", "prefixIdentityHashes"]);
  if (![r.source.workspace, r.source.sessionId, r.source.predecessorAnchor].every(text)) throw new Error("Invalid plan replacement source");
  if (!Array.isArray(r.source.prefixIdentityHashes) || !r.source.prefixIdentityHashes.length || !r.source.prefixIdentityHashes.every(hash)) throw new Error("Invalid replacement original prefix pins");
  record(r.predecessor, ["groupId", "groupDigest", "plan"]); record(r.successor, ["groupId", "plan"]);
  if (!text(r.predecessor.groupId) || !hash(r.predecessor.groupDigest) || !text(r.successor.groupId) || r.predecessor.groupId === r.successor.groupId) throw new Error("Invalid plan replacement group pins");
  for (const pin of [r.predecessor.plan, r.successor.plan]) { record(pin, ["handoffKey", "revision", "checksum"]); counter(pin.revision); if (!text(pin.handoffKey) || !hash(pin.checksum)) throw new Error("Invalid plan replacement approval pin"); }
  if (r.successor.plan.revision <= r.predecessor.plan.revision || r.successor.plan.handoffKey === r.predecessor.plan.handoffKey) throw new Error("Plan replacement approval did not advance");
  if (r.parentGoal) { record(r.parentGoal, ["id", "oldPlanHandoffKey", "contractEpoch", "contractDigest"]); counter(r.parentGoal.contractEpoch); if (!text(r.parentGoal.id) || !(r.parentGoal.oldPlanHandoffKey === null || text(r.parentGoal.oldPlanHandoffKey)) || !hash(r.parentGoal.contractDigest)) throw new Error("Invalid replacement parent Goal"); }
  if (!Array.isArray(r.reservedIds) || !r.reservedIds.length || new Set(r.reservedIds).size !== r.reservedIds.length || r.reservedIds.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) > r.allocatorHighWater)) throw new Error("Invalid replacement burned IDs");
  record(r.request, ["newTasks", "newGroup", "oldTaskPins"]);
  if (!Array.isArray(r.request.newTasks) || !Array.isArray(r.request.oldTaskPins) || !r.request.oldTaskPins.length || r.request.newTasks.length !== r.reservedIds.length
    || r.request.newTasks.some((task, i) => task.id !== r.reservedIds[i] || !text(task.taskInstanceId) || task.origin || task.acceptanceReport || task.skipResolution || task.dispatchSubmissionId || !["pending", "blocked"].includes(task.status))) throw new Error("Invalid replacement reserved Tasks");
  record(r.request.newGroup, ["id", "deliveryGoalId", "createdAt", "source", "sourceKind", "approvedPlan", "members"]);
  record(r.request.newGroup.source, ["cwd", "sessionId", "branchAnchor"]);
  if (![r.request.newGroup.source.cwd, r.request.newGroup.source.sessionId, r.request.newGroup.source.branchAnchor].every(text) || r.request.newGroup.sourceKind !== "approved-plan") throw new Error("Invalid replacement successor source");
  counter(r.request.newGroup.createdAt);
  if (r.request.newGroup.id !== r.successor.groupId || digest(r.request.newGroup.approvedPlan) !== digest(r.successor.plan) || r.request.newGroup.members.length !== r.reservedIds.length
    || r.request.newGroup.members.some((member, i) => member.taskId !== r.reservedIds[i] || member.taskInstanceId !== r.request.newTasks[i]!.taskInstanceId)) throw new Error("Invalid replacement successor group");
  for (const pin of r.request.oldTaskPins) { record(pin, ["id", "instanceId", "version", "digest", "bodyDigest"]); counter(pin.version); if (!text(pin.id) || !text(pin.instanceId) || !hash(pin.digest) || !hash(pin.bodyDigest)) throw new Error("Invalid replacement predecessor Task pin"); }
  validateNativeBefore(r.nativeBefore, [...r.request.oldTaskPins.map(pin => pin.id), ...r.reservedIds]);
  if (r.nativeBefore.slice(r.request.oldTaskPins.length).some(pin => pin.headPresent)) throw new Error("Replacement new slots must never have existed");
  if (replacementRequestDigest(r) !== r.requestDigest) throw new Error("Plan replacement request digest differs");
  if (r.taskPublication) { record(r.taskPublication, ["witnessId", "stateDigest", "newGroupDigest"]); if (!text(r.taskPublication.witnessId) || !hash(r.taskPublication.stateDigest) || !hash(r.taskPublication.newGroupDigest)) throw new Error("Invalid replacement Task publication"); }
  if (r.goalPublication) { record(r.goalPublication, ["goalId", "contractEpoch", "goalContractDigest", "entryId", "dataDigest"]); counter(r.goalPublication.contractEpoch); if (r.goalPublication.goalId !== r.parentGoal?.id || r.goalPublication.contractEpoch !== r.parentGoal.contractEpoch + 1 || !hash(r.goalPublication.goalContractDigest) || !text(r.goalPublication.entryId) || !hash(r.goalPublication.dataDigest)) throw new Error("Invalid replacement Goal publication"); }
  if (r.abort) { record(r.abort, ["reason", "nativeBeforeDigest"]); if (!text(r.abort.reason) || r.abort.nativeBeforeDigest !== digest(r.nativeBefore)) throw new Error("Invalid replacement abort evidence"); }
  if (r.phase === "reserved" && (r.taskPublication || r.goalPublication || r.abort)
    || r.phase === "aborted" && (!r.abort || r.taskPublication || r.goalPublication)
    || ["tasks-published", "complete"].includes(r.phase) && (!r.taskPublication || r.abort)
    || r.phase === "complete" && r.parentGoal && !r.goalPublication) throw new Error("Invalid replacement phase evidence");
}
export function pendingPlanReplacement(groups: readonly DeliveryGroup[]): PlanReplacementReceipt | undefined {
  const pending = groups.flatMap(group => group.replacementHistory ?? []).filter(receipt => receipt.phase === "reserved" || receipt.phase === "tasks-published");
  if (pending.length > 1) throw new Error("Multiple pending plan replacements require reconciliation");
  return pending[0];
}
export function assertTaskReplacementEligible(task: TodoTask): void {
  if (task.replacementPendingId) throw new Error("plan-replacement-pending: Task execution is held");
  if (task.supersessionId || task.supersededByGroupId) throw new Error("plan-superseded: Task is retained as history only");
}
/** Full graph validation is mandatory on load; malformed owner data is never filtered away. */
export function validateReplacementGroups(groups: readonly DeliveryGroup[], tasks?: ReadonlyMap<string, TodoTask>): void {
  const byId = new Map(groups.map(group => [group.id, group]));
  if (byId.size !== groups.length) throw new Error("Duplicate delivery group identity");
  const seen = new Set<string>();
  const burnedIds = new Set<string>(), reservedInstances = new Map<string,string>();
  for (const group of groups) {
    let highWater = 0;
    const history = group.replacementHistory ?? [];
    for (let historyIndex = 0; historyIndex < history.length; historyIndex++) {
      const r = history[historyIndex]!;
      validateReplacementReceipt(r);
      const predecessorAtReservation = structuredClone(group);
      delete predecessorAtReservation.currentPendingReplacementId; delete predecessorAtReservation.supersededBy;
      if (historyIndex) predecessorAtReservation.replacementHistory = structuredClone(history.slice(0, historyIndex));
      else delete predecessorAtReservation.replacementHistory;
      if (digest(predecessorAtReservation) !== r.predecessor.groupDigest) throw new Error("Replacement predecessor group snapshot changed");
      if (seen.has(r.id) || r.predecessor.groupId !== group.id || r.allocatorHighWater < highWater) throw new Error("Replacement history identity/high-water changed");
      seen.add(r.id); highWater = r.allocatorHighWater;
      for (const reserved of r.request.newTasks) {
        if (burnedIds.has(reserved.id) || reservedInstances.has(reserved.taskInstanceId!)) throw new Error("Replacement reserved ID/instance was reused across receipts");
        burnedIds.add(reserved.id); reservedInstances.set(reserved.taskInstanceId!,reserved.id);
        if (tasks) {
          const actual=tasks.get(reserved.id);
          if ((r.phase==="aborted" || r.phase==="reserved") ? actual!==undefined : !actual || actual.taskInstanceId!==reserved.taskInstanceId) throw new Error("Replacement permanent reservation identity was reused or lost");
          if ([...tasks.values()].some(task=>task.taskInstanceId===reserved.taskInstanceId && task.id!==reserved.id)) throw new Error("Replacement burned instance was reused by another Task");
        }
      }
      if (r.request.oldTaskPins.length !== group.members.length || group.members.some((m, i) => m.taskId !== r.request.oldTaskPins[i]!.id || m.taskInstanceId !== r.request.oldTaskPins[i]!.instanceId)) throw new Error("Replacement predecessor membership changed");
      if (tasks && r.phase === "reserved" && r.reservedIds.some(id=>tasks.has(id))) throw new Error("Reserved successor Task was prematurely published");
      if (tasks && r.phase !== "aborted") {
        for (const pin of r.request.oldTaskPins) {
          const task = tasks.get(pin.id);
          if (!task || task.taskInstanceId !== pin.instanceId || (r.phase === "complete" ? task.replacementPendingId !== undefined : task.replacementPendingId !== r.id)) throw new Error("Replacement predecessor Task marker missing or changed");
          const original = structuredClone(task); delete original.replacementPendingId;
          if (r.phase !== "reserved") {
            if (task.supersessionId !== r.id || task.supersededByGroupId !== r.successor.groupId || task.contractVersion !== pin.version + 1) throw new Error("Replacement predecessor revocation changed");
            delete original.supersessionId; delete original.supersededByGroupId; original.contractVersion = pin.version; original.contractDigest = pin.digest;
          }
          if (replacementTaskBodyDigest(original) !== pin.bodyDigest) throw new Error("Replacement predecessor history changed");
        }
        if (r.phase === "tasks-published") for (const reserved of r.request.newTasks) {
          const actual = tasks.get(reserved.id);
          if (!actual || actual.replacementPendingId !== r.id) throw new Error("Replacement successor pending marker missing");
          const clean = structuredClone(actual); delete clean.replacementPendingId;
          if (replacementTaskBodyDigest(clean) !== replacementTaskBodyDigest(reserved)) throw new Error("Replacement successor body changed");
        }
      }
      if (["reserved", "tasks-published"].includes(r.phase) && group.currentPendingReplacementId !== r.id) throw new Error("Replacement pending marker missing");
      if (["tasks-published", "complete"].includes(r.phase)) {
        const next = byId.get(r.successor.groupId);
        if (!next || next.supersedes?.replacementId !== r.id || next.supersedes.groupId !== group.id || group.supersededBy?.replacementId !== r.id || group.supersededBy.groupId !== next.id
          || next.source.cwd !== group.source.cwd || next.source.sessionId !== group.source.sessionId || next.deliveryGoalId !== group.deliveryGoalId) throw new Error("Replacement chain is not bidirectionally complete");
        const successorAtPublication = structuredClone(next);
        delete successorAtPublication.replacementHistory; delete successorAtPublication.currentPendingReplacementId; delete successorAtPublication.supersededBy;
        const expectedSuccessor = { ...structuredClone(r.request.newGroup), supersedes: {replacementId:r.id,groupId:group.id} };
        if (digest(successorAtPublication) !== r.taskPublication!.newGroupDigest || digest(successorAtPublication) !== digest(expectedSuccessor)) throw new Error("Replacement successor R2 group snapshot changed");
      } else if (byId.has(r.successor.groupId)) throw new Error("Unpublished replacement successor exists");
    }
    if (group.currentPendingReplacementId && !group.replacementHistory?.some(r => r.id === group.currentPendingReplacementId && ["reserved", "tasks-published"].includes(r.phase))) throw new Error("Orphan replacement pending marker");
    if (group.supersededBy && !group.replacementHistory?.some(r => r.id === group.supersededBy!.replacementId && ["tasks-published", "complete"].includes(r.phase))) throw new Error("Orphan superseded group marker");
    if (group.supersedes && !byId.get(group.supersedes.groupId)?.replacementHistory?.some(r => r.id === group.supersedes!.replacementId && r.successor.groupId === group.id && ["tasks-published", "complete"].includes(r.phase))) throw new Error("Orphan successor group marker");
    const visited = new Set<string>(); let cursor: DeliveryGroup | undefined = group;
    while (cursor?.supersededBy) { if (visited.has(cursor.id)) throw new Error("Replacement chain cycle"); visited.add(cursor.id); cursor = byId.get(cursor.supersededBy.groupId); }
  }
  const pending = pendingPlanReplacement(groups);
  if (tasks) for (const task of tasks.values()) {
    if (task.replacementPendingId && (!pending || task.replacementPendingId !== pending.id || !pending.request.oldTaskPins.some(pin=>pin.id===task.id) && !(pending.phase==="tasks-published" && pending.reservedIds.includes(task.id)))) throw new Error("Orphan Task replacement marker");
    if (task.supersessionId || task.supersededByGroupId) {
      const r = groups.flatMap(group => group.replacementHistory ?? []).find(r => r.id === task.supersessionId);
      if (!r || !["tasks-published", "complete"].includes(r.phase) || r.successor.groupId !== task.supersededByGroupId || !r.request.oldTaskPins.some(pin => pin.id === task.id && pin.instanceId === task.taskInstanceId)) throw new Error("Invalid Task supersession chain");
    }
  }
}

/** Exactly one self-reference leaf is omitted; all other receipts and fields remain bound. */
export function replacementEmbeddedStateDigest(state: unknown, replacementId: string): string {
  const copy = structuredClone(state);
  if (!copy || typeof copy !== "object" || !("deliveryGroups" in copy) || !Array.isArray(copy.deliveryGroups)) throw new Error("Replacement publication groups missing");
  const matches = copy.deliveryGroups.flatMap((group: DeliveryGroup) => group.replacementHistory ?? []).filter((receipt: PlanReplacementReceipt) => receipt.id === replacementId);
  if (matches.length !== 1 || !matches[0]!.taskPublication) throw new Error("Replacement embedded digest requires unique receipt");
  delete (matches[0]!.taskPublication as Partial<NonNullable<PlanReplacementReceipt["taskPublication"]>>).stateDigest;
  return digest(["pi-maestro-flow:plan-replacement-r2-state", 1, copy]);
}

/** D2 body-value pin only. Does not replace the exact serialized state/content hashes. */
export function replacementTaskBodyDigest(value: TodoTask): string {
  const json: unknown = JSON.parse(JSON.stringify(value));
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>[key,canonical(value)]));
    return item;
  };
  return digest(["pi-maestro-flow:replacement-task-body",1,canonical(json)]);
}
