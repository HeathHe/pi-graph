import { assertTaskReplacementEligible, replacementTaskBodyDigest, validateReplacementReceipt, type PlanReplacementReceipt } from "./plan-replacement.ts";
import { taskBusinessContractDigest, taskExecutionInputDigest, type OwnedExecutionContract } from "./execution-contract.ts";
import { randomUUID } from "node:crypto";
import { readTaskDispatchObservation, type TaskDispatchObservation } from "pi-maestro-teammate/v1/task-dispatch-binding";
import { digest, assertIssuedMaterialReview, recheckMaterialReview, type MaterialReviewContext, type MaterialReviewReport } from "../verification/material-review.ts";
import type { TodoTask } from "./types.ts";
import type { RestoredClosedExecution } from "../persistence-recovery/native-recovery/contracts.ts";
export interface TaskNoSubmissionWitness {taskInstanceId:string;ownerInstanceId:string;generation:number;}
export interface TaskAcceptanceReport {
  taskInstanceId: string; contractVersion: number; contractDigest: string;
  review: MaterialReviewReport;
  execution?: RestoredClosedExecution | ({kind:"not-submitted"} & TaskNoSubmissionWitness) | { kind:"native"; bindingId: string; nativeInvocationId: string; correlationId: string; runtimeGeneration: number | null; sequence: number; turnEpoch: number; inputGeneration: number; requestId: string; loopSeq: number; executedContractVersion: number; executedContractDigest: string; taskInstanceId: string };
  resolution: "accepted" | "skipped";
}
export function taskCriteria(task: TodoTask): string[] { return task.acceptanceCriteria?.length ? [...task.acceptanceCriteria] : [task.subject]; }
export const taskContractDigest = taskBusinessContractDigest;

export function initializeTaskContract(task: TodoTask): void {
  task.taskInstanceId ??= randomUUID(); task.contractVersion ??= 1;
  task.contractDependencies ??= [...task.blockedBy]; task.contractDigest = taskContractDigest(task);
}
/** Sole writer calls this before persistence. Historical acceptance remains in the existing journal. */
export function reconcileTaskContracts(before: ReadonlyMap<string, TodoTask>, after: Map<string, TodoTask>, replacement?: { receipt: PlanReplacementReceipt; assertCurrent(): void }): void {
  if (replacement) { replacement.assertCurrent(); validateReplacementReceipt(replacement.receipt); if (replacement.receipt.phase !== "reserved") throw new Error("Replacement history capability requires canonical reservation"); }
  for (const [id, task] of after) {
    const old = before.get(id);
    if(old && !currentMembership(old) && !replacement){if(replacementTaskBodyDigest(old)!==replacementTaskBodyDigest(task))throw new Error("Historical Task body changed");continue;}
    task.taskInstanceId ??= old?.taskInstanceId; task.contractVersion ??= old?.contractVersion;
    task.contractDependencies ??= old?.contractDependencies ? [...old.contractDependencies] : undefined;
    initializeTaskContract(task);
    const changed = old && (taskContractDigest(old) !== taskContractDigest(task)
      || (old.status === "completed" && task.status !== "completed")
      || (old.skipResolution && task.status !== old.status));
    if (changed) {
      task.contractVersion = (old.contractVersion ?? 1) + 1;
      if (replacement && old && replacement.receipt.request.oldTaskPins.some(pin => pin.id === id)) {
        const pin = replacement.receipt.request.oldTaskPins.find(pin => pin.id === id)!;
        const original = structuredClone(old); delete original.replacementPendingId;
        const expected = { ...original, replacementPendingId: replacement.receipt.id, supersessionId: replacement.receipt.id,
          supersededByGroupId: replacement.receipt.successor.groupId, contractVersion: task.contractVersion, contractDigest: taskContractDigest(task) };
        if (replacementTaskBodyDigest(original) !== pin.bodyDigest || replacementTaskBodyDigest(task) !== replacementTaskBodyDigest(expected)) throw new Error("Replacement cannot rewrite predecessor history");
        task.contractDigest = taskContractDigest(task); continue;
      }
      let freshlyReviewed = false;
      const report = task.acceptanceReport;
      if (report && report.taskInstanceId === task.taskInstanceId && report.contractVersion === task.contractVersion && report.contractDigest === taskContractDigest(task) && report.review.contractDigest === report.contractDigest) {
        try { assertIssuedMaterialReview(report.review); freshlyReviewed = true; } catch { /* serialized/model reports never retain authority */ }
      }
      if (!freshlyReviewed) {
        delete task.acceptanceReport;
        if (task.status === "completed" && !task.origin) task.status = task.blockedBy.length ? "blocked" : "pending";
        if (!task.origin) { delete task.summary; delete task.completedAt; }
        delete task.skipResolution;
      }
    }
    task.contractDigest = taskContractDigest(task);
  }
}
const observations = new Map<string, TaskDispatchObservation>();
let readExecutionContract: ((bindingId: string, taskId: string) => OwnedExecutionContract | undefined) | undefined;
let noSubmissionWitness: ((task:TodoTask)=>TaskNoSubmissionWitness|undefined)|undefined;
let readObservedTask: ((id:string)=>TodoTask|undefined)|undefined;
const observedWitnesses=new Map<string,TaskAcceptanceReport["execution"]>();
let restoration: {execution(task:TodoTask):RestoredClosedExecution|undefined;cached(value:RestoredClosedExecution,task:TodoTask):boolean}|undefined;
export function configureTaskRestoration(value:NonNullable<typeof restoration>):void {restoration=value;}
let currentMembership: (task:TodoTask)=>boolean = () => true;
function assertCurrentMembership(task:TodoTask):void { if(!currentMembership(task))throw new Error("task-cleared/pending: historical execution is ineligible"); }
export function configureTaskExecutionContracts(reader: NonNullable<typeof readExecutionContract>, notSubmitted: NonNullable<typeof noSubmissionWitness>, readTask: NonNullable<typeof readObservedTask>, current?: (task:TodoTask)=>boolean): void {
  if(current)currentMembership=current;
  if (readExecutionContract) throw new Error("Task execution contract reader already configured"); readExecutionContract = reader; noSubmissionWitness=notSubmitted;readObservedTask=readTask;
}
export function resetTaskExecutionObservations(): void { observations.clear();observedWitnesses.clear(); }
/** Native public reader rejects copied/model JSON. Called only by the host event adapter. */
export function observeTaskExecution(value: unknown): void {
  const observation = readTaskDispatchObservation(value); if (!observation || !observation.items.some(item=>item.state!=="historical"&&item.state!=="invalid_dependency")) return;
  for (const id of observation.todoIds) {
    const previous = observations.get(id);
    if (previous?.bindingId === observation.bindingId && previous.native.nativeInvocationId === observation.native.nativeInvocationId
      && previous.native.sequence > observation.native.sequence) continue;
    observations.set(id, value as TaskDispatchObservation);
    const task=readObservedTask?.(id);
    try { if(!task)throw new Error("Task no longer exists"); validateExecutionObservation(task,observation); observedWitnesses.set(id,nativeWitness(task,observation)); }
    catch { observedWitnesses.set(id,undefined); }
  }
}
export function currentTaskExecution(task: TodoTask): TaskDispatchObservation | undefined {
  assertCurrentMembership(task); assertTaskReplacementEligible(task);
  const value = observations.get(task.id);
  const observation = value && readTaskDispatchObservation(value);
  if (!observation) {
    if (task.dispatchSubmissionId || task.assignee.kind === "teammate") throw new Error("pending-review/settlement-unknown: delegated task execution settlement is not currently observable; reconcile existing run evidence.");
    return undefined;
  }
  validateExecutionObservation(task,observation);
  return observation;
}
function validateExecutionObservation(task:TodoTask,observation:TaskDispatchObservation):void {
  assertCurrentMembership(task); assertTaskReplacementEligible(task);
  const contract = observation.contracts.find(item => item.taskId === task.id);
  const owned = readExecutionContract?.(observation.bindingId, task.id);
  if (observation.bindingState!=="current" || !contract || !owned || owned.taskInstanceId !== task.taskInstanceId || contract.version !== owned.runtimeVersion
    || contract.taskDigest !== owned.tokenDigest || task.dispatchSubmissionId !== owned.submissionId || owned.executionInputDigest !== taskExecutionInputDigest(task)
    || (task.contractVersion ?? 0) < owned.executedContractVersion
    || ((task.contractVersion ?? 0) === owned.executedContractVersion && taskContractDigest(task) !== owned.executedContractDigest)
    || !observation.items.some(item => item.taskId === task.id && item.state !== "historical" && item.state !== "invalid_dependency")) throw new Error("pending-review: execution binding is stale.");
  const {currentTurn:turn,lastResult:result}=observation.native;
  if (!turn || turn.state!=="settled" || turn.queuedInputs!==0 || turn.settledEpoch!==turn.epoch
    || !Number.isSafeInteger(turn.epoch) || turn.epoch<1 || !Number.isSafeInteger(turn.inputGeneration) || (turn.inputGeneration??0)<1
    || typeof turn.requestId!=="string" || !turn.requestId || !Number.isSafeInteger(turn.loopSeq) || (turn.loopSeq??-1)<0
    || !result || result.lifecyclePending || result.exitCode!==0
    || result.turnReference?.requestId!==turn.requestId || result.turnReference.loopSeq!==turn.loopSeq)
    throw new Error("pending-review: current execution turn is not proven settled; queued/running/unknown work cannot use an older result.");
}
function nativeWitness(task:TodoTask,observation:TaskDispatchObservation):NonNullable<TaskAcceptanceReport["execution"]> {
  const native=observation.native,turn=native.currentTurn;
  const owned=readExecutionContract!(observation.bindingId,task.id)!;
  return {kind:"native",taskInstanceId:owned.taskInstanceId,executedContractVersion:owned.executedContractVersion,executedContractDigest:owned.executedContractDigest,
    bindingId:observation.bindingId,nativeInvocationId:native.nativeInvocationId,correlationId:native.correlationId,runtimeGeneration:native.runtimeGeneration,sequence:native.sequence,
    turnEpoch:turn.epoch,inputGeneration:turn.inputGeneration!,requestId:turn.requestId!,loopSeq:turn.loopSeq!};
}
/** Physical exit/close only advances the audit sequence, not the logical settlement witness. */
export function executionWitnessDigest(value:TaskAcceptanceReport["execution"]):string {
  if(value?.kind!=="native")return digest(value);
  const {sequence:_auditOnly,...business}=value;return digest(business);
}
/** Pure observed-cache projection for UI/readiness. Never calls provider.inspect or reads material. */
export function hasCurrentTaskReport(task:TodoTask,resolution:"accepted"|"skipped"="accepted"):boolean {
  if (!currentMembership(task) || task.replacementPendingId || task.supersessionId || task.supersededByGroupId) return false;
  if(task.origin)return task.status==="completed";
  const report=task.acceptanceReport;
  if(!report || report.resolution!==resolution || !report.review.accepted || report.taskInstanceId!==task.taskInstanceId
    || report.contractVersion!==task.contractVersion || report.contractDigest!==taskContractDigest(task) || report.review.contractDigest!==report.contractDigest)return false;
  try{assertIssuedMaterialReview(report.review);}catch{return false;}
  if(report.execution?.kind==="restored-closed")return restoration?.cached(report.execution,task)===true;
  if(report.execution?.kind==="native") {
    const core=readExecutionContract?.(report.execution.bindingId,task.id);
    return !!core && core.taskInstanceId===task.taskInstanceId && core.submissionId===task.dispatchSubmissionId
      && core.executionInputDigest===taskExecutionInputDigest(task)
      && executionWitnessDigest(report.execution)===executionWitnessDigest(observedWitnesses.get(task.id));
  }
  if(report.execution?.kind==="not-submitted")return resolution==="skipped"&&executionWitnessDigest(report.execution)===executionWitnessDigest(noSubmissionWitness?.(task)?{kind:"not-submitted",...noSubmissionWitness!(task)!}:undefined);
  return resolution==="accepted" && !task.dispatchSubmissionId && task.assignee.kind==="root";
}

/** All-success uses current acceptance, including transitive authored dependencies, without native/provider recursion. */
export function taskDependencySatisfied(state:ReadonlyMap<string,TodoTask>,id:string):boolean {
 const pending=[id],seen=new Set<string>();
 while(pending.length){const current=pending.pop()!;if(seen.has(current))continue;seen.add(current);const task=state.get(current);
  if(!task || task.status!=="completed" || !hasCurrentTaskReport(task))return false;
  if(!task.origin)pending.push(...(task.contractDependencies??task.blockedBy));
 }
 return true;
}
export function taskReviewRequired(task:TodoTask):boolean {return !task.origin && (task.status==="completed" || !!task.skipResolution) && !hasCurrentTaskReport(task,task.skipResolution?"skipped":"accepted");}

export function executionFingerprint(task: TodoTask, resolution:"accepted"|"skipped"="accepted"): TaskAcceptanceReport["execution"] {
  assertCurrentMembership(task); assertTaskReplacementEligible(task);
  const restored=restoration?.execution(task);if(restored)return restored;
  const witness=resolution==="skipped"?noSubmissionWitness?.(task):undefined;
  if(witness && !observations.has(task.id))return {kind:"not-submitted",...witness};
  const observation = currentTaskExecution(task);
  if (!observation) {if(resolution==="skipped")throw new Error("pending-review/settlement-unknown: skip needs the current owner no-submission witness or authoritative current settlement.");return undefined;}
  return nativeWitness(task,observation);
}
export function assertTaskAcceptance(task: TodoTask, resolution: "accepted" | "skipped" = "accepted"): TaskAcceptanceReport {
  assertCurrentMembership(task); assertTaskReplacementEligible(task);
  const report = task.acceptanceReport;
  if (!report || report.resolution !== resolution || !report.review.accepted || report.taskInstanceId !== task.taskInstanceId
    || report.contractVersion !== task.contractVersion || report.contractDigest !== taskContractDigest(task)
    || report.review.contractDigest !== report.contractDigest) throw new Error("pending-review: completion requires a current host business acceptance report for this Task contract.");
  assertIssuedMaterialReview(report.review);
  if (executionWitnessDigest(report.execution) !== executionWitnessDigest(executionFingerprint(task,resolution))) throw new Error("pending-review: execution changed after business review.");
  return report;
}
export async function recheckTaskAcceptance(task: TodoTask, ctx: MaterialReviewContext, assertCurrent: () => void, resolution: "accepted" | "skipped" = "accepted"): Promise<void> {
  const report = assertTaskAcceptance(task, resolution);
  const manager = ctx.sessionManager as {getSessionId?: () => string; getBranch?: () => {id?:string}[]} | undefined;
  if (report.review.source.cwd !== ctx.cwd || report.review.source.sessionId !== manager?.getSessionId?.() || !manager?.getBranch?.().some(entry => entry.id === report.review.source.branchAnchor)) throw new Error("Task review belongs to another source branch.");
  await recheckMaterialReview(report.review, ctx, assertCurrent); assertCurrent(); assertTaskAcceptance(task, resolution);
}
