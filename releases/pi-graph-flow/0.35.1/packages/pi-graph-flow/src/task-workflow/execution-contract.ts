import { createHash } from "node:crypto";
import type { TodoTask } from "./types.ts";
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Stable execution input, separate from newly attached output and resumption material.
 * Those material fields still version/revoke business acceptance below. */
export function taskExecutionInput(task: TodoTask): unknown {
  const input: unknown[] = [task.subject,task.description,task.context,task.skills.map(skill=>[skill.name,skill.role,skill.args]),
    [task.assignee.kind,task.assignee.id,task.assignee.label,task.assignee.agentType],
    task.origin?[task.origin.sessionId,task.origin.step,task.origin.sessionGeneration,task.origin.runId,task.origin.runSeq]:undefined,
    task.planHandoffKey,task.goalId??task.verifiedQualityGateId,task.deliveryGroupId,task.deliveryGoalId,task.acceptanceCriteria,task.contractDependencies??task.blockedBy];
  if (task.supersessionId || task.supersededByGroupId) input.push(["plan-supersession-v1", task.supersessionId, task.supersededByGroupId]);
  return input;
}
export const taskExecutionInputDigest = (task: TodoTask): string => hash(taskExecutionInput(task));
export function handoffValues(task: TodoTask): unknown {
  return [task.handoff?.nextSteps??[],(task.handoff?.files??[]).map(file=>[file.path,file.value,file.reason,file.when])];
}
export function taskOutputValues(task:TodoTask):unknown{return [task.resourceUris,handoffValues(task)];}
export const taskBusinessContractDigest = (task: TodoTask): string => hash([taskExecutionInput(task),task.resourceUris,handoffValues(task)]);
export interface OwnedExecutionContract {
  taskId: string; taskInstanceId: string; submissionId: string; executedContractVersion: number; executedContractDigest: string;
  executionInputDigest: string; runtimeVersion: number; tokenDigest: string;
}
export function ownedExecutionContract(task: TodoTask, runtimeVersion: number): OwnedExecutionContract | undefined {
  if (!task.taskInstanceId || !task.contractVersion) return undefined;
  const value = {taskId:task.id,taskInstanceId:task.taskInstanceId,submissionId:task.dispatchSubmissionId??"",executedContractVersion:task.contractVersion,
    executedContractDigest:taskBusinessContractDigest(task),executionInputDigest:taskExecutionInputDigest(task),runtimeVersion};
  return Object.freeze({...value,tokenDigest:hash(value)});
}
