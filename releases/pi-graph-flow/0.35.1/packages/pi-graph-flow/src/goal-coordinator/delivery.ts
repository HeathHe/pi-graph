import { getGoalClearGeneration, isDeliveryGroupCleared, isGoalTaskClearPending } from "../task-workflow/commands.ts";
import { validateReplacementGroups, pendingPlanReplacement } from "../task-workflow/plan-replacement.ts";
import { digest, recheckMaterialReview, type MaterialReviewReport } from "../verification/material-review.ts";
import { recheckTaskAcceptance, taskContractDigest } from "../task-workflow/acceptance.ts";
import { readApprovedTaskPlan, type DeliveryGroup } from "../task-workflow/delivery-group.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoTask } from "../task-workflow/types.ts";
import type { ActiveGoal, GoalContext } from "../tools/goal.ts";
export interface GoalDeliveryState {
  phase: "awaiting-reply" | "delivered";
  contractDigest: string; groupDigest: string; ownerEpoch: number; ownerInstanceId: string;
  source: { cwd: string; sessionId: string; branchAnchor: string };
  readyEntryId?: string;
  workflowAuthority?: { canonical: boolean; sessionId?: string };
  materialReview?: MaterialReviewReport;
  verdictDigest: string;
  receipt?: { entryId: string; textDigest: string; contractDigest: string; groupDigest: string; ownerEpoch: number; ownerInstanceId: string; source: GoalDeliveryState["source"] };
}
export function goalContractDigest(goal: ActiveGoal): string {
  const contract: unknown[] = [goal.id, goal.text, goal.acceptance, goal.planHandoffKey, goal.workflowSessionId, goal.workflowSessionGeneration, goal.verificationMode];
  if (goal.planContractEpoch !== undefined) contract.push(["plan-contract-epoch-v1", goal.planContractEpoch]);
  return digest(contract);
}
export function selectDeliveryGroup(goal: ActiveGoal, groups: readonly DeliveryGroup[]): DeliveryGroup | undefined {
  validateReplacementGroups(groups);
  if(isGoalTaskClearPending(goal.id))throw new Error("task-clear-pending: Goal delivery held");
  if (pendingPlanReplacement(groups)?.parentGoal?.id === goal.id) throw new Error("plan-replacement-pending: Goal delivery held");
  const matches = groups.filter(group => group.deliveryGoalId === goal.id && !group.supersededBy);
  if (matches.length > 1) throw new Error("Multiple complete delivery groups have no validated supersession; delivery is blocked.");
  if(matches[0] && isDeliveryGroupCleared(matches[0].id))throw new Error("coverage-cleared: explicit new approved revision replacement is required");
  return matches[0];
}
export function taskGroupDigest(goal: ActiveGoal, groups: readonly DeliveryGroup[], tasks: readonly TodoTask[]): string {
  const group = selectDeliveryGroup(goal, groups);
  const generation=getGoalClearGeneration(goal.id);
  const currentDigest=(base:string)=>generation ? digest(["task-clear-qualification",1,generation,base]) : base;
  if (!group) {
    if (tasks.some(task => task.deliveryGoalId === goal.id)) throw new Error("The complete delivery group is missing.");
    return currentDigest(digest(null));
  }
  return currentDigest(digest([group, group.members.map(member => {
    const task = tasks.find(candidate => candidate.id === member.taskId);
    return task ? [task.id, task.taskInstanceId, task.contractVersion, taskContractDigest(task), task.status, task.acceptanceReport, task.skipResolution] : null;
  })]));
}
export async function verifyGoalTaskGroup(goal: ActiveGoal, groups: readonly DeliveryGroup[], tasks: readonly TodoTask[], ctx: GoalContext, assertCurrent: () => void): Promise<string> {
  const group = selectDeliveryGroup(goal, groups);
  const pin = taskGroupDigest(goal, groups, tasks);
  if (!group) return pin; // Standalone Goals need their own material/declared checks, not invented Tasks.
  const manager = ctx.sessionManager as {getSessionId?: () => string; getBranch?: () => {id?:string}[]} | undefined;
  if (group.source.cwd !== ctx.cwd || group.source.sessionId !== manager?.getSessionId?.() || !manager?.getBranch?.().some(entry => entry.id === group.source.branchAnchor)) throw new Error("Delivery group belongs to another source.");
  if (goal.planHandoffKey && group.approvedPlan?.handoffKey !== goal.planHandoffKey) throw new Error("Goal is not covered by the current approved Plan group.");
  if (group.approvedPlan) {
    const current = await readApprovedTaskPlan(ctx as ExtensionContext); assertCurrent();
    if (current.manifest.handoffKey !== group.approvedPlan.handoffKey || current.manifest.revision !== group.approvedPlan.revision || current.manifest.approvedChecksum !== group.approvedPlan.checksum) throw new Error("Approved Plan revision/checksum changed; current delivery group no longer covers the contract.");
  }
  for (const member of group.members) {
    const task = tasks.find(candidate => candidate.id === member.taskId);
    if (!task || task.status === "deleted" || task.taskInstanceId !== member.taskInstanceId || task.deliveryGroupId !== group.id || task.deliveryGoalId !== goal.id) throw new Error(`Required delivery membership is missing or changed: #${member.taskId}.`);
    if (task.goalId === goal.id || task.verifiedQualityGateId === goal.id) throw new Error("A delivery Goal cannot also be its member's quality gate.");
    if (task.status === "completed" && !task.skipResolution) await recheckTaskAcceptance(task, ctx, assertCurrent);
    else if (!member.required && member.skipPolicy && task.skipResolution?.policy === member.skipPolicy) await recheckTaskAcceptance(task, ctx, assertCurrent, "skipped");
    else throw new Error(`Delivery task #${member.taskId} has not been accepted${member.required ? " (required)" : " or validly skipped"}.`);
    assertCurrent();
  }
  return pin;
}
interface Entry { id?: string; type?: string; message?: {role?:string;stopReason?:string;content?:unknown}; }
/** Reads the actual current canonical branch. event.messages is intentionally not an authority. */
export function readFinalMainReply(goal: ActiveGoal, ctx: GoalContext, ownerEpoch: number, ownerInstanceId: string): GoalDeliveryState["receipt"] | undefined {
  const delivery = goal.delivery;
  if (!delivery || delivery.phase !== "awaiting-reply" || delivery.ownerEpoch !== ownerEpoch || delivery.ownerInstanceId !== ownerInstanceId || delivery.contractDigest !== goalContractDigest(goal) || !delivery.readyEntryId) return undefined;
  const manager = ctx.sessionManager as {getSessionId?: () => string; getBranch?: () => Entry[]} | undefined;
  if (ctx.cwd !== delivery.source.cwd || manager?.getSessionId?.() !== delivery.source.sessionId) return undefined;
  const branch = manager?.getBranch?.(); if (!Array.isArray(branch)) return undefined;
  const ready = branch.findIndex(entry => entry.id === delivery.readyEntryId);
  if (ready < 0 || !branch.some(entry => entry.id === delivery.source.branchAnchor)) return undefined;
  // Lifecycle callback can arrive after non-message housekeeping entries. Select the final
  // message in the branch, but never skip over a tool result or another user turn.
  const lastMessage = [...branch].reverse().find(item => item.type === "message");
  if (!lastMessage?.id || branch.indexOf(lastMessage) <= ready || lastMessage.message?.role !== "assistant" || lastMessage.message.stopReason !== "stop") return undefined;
  const finalIndex = branch.indexOf(lastMessage);
  if (branch.slice(ready + 1, finalIndex).some(item => item.type === "message" && item.message?.role === "user")) return undefined;
  const content = lastMessage.message.content;
  if (!Array.isArray(content) || content.some(item => !item || typeof item !== "object" || !["text", "thinking"].includes(String((item as {type?:unknown}).type)))) return undefined;
  const text = content.map(item => (item as {text?:unknown}).text).filter((item): item is string => typeof item === "string").join("\n").trim();
  if (!text) return undefined;
  return { entryId: lastMessage.id, textDigest: digest(text), contractDigest: delivery.contractDigest, groupDigest: delivery.groupDigest, ownerEpoch, ownerInstanceId, source: structuredClone(delivery.source) };
}
export async function recheckGoalMaterials(goal: ActiveGoal, ctx: GoalContext, assertCurrent: () => void): Promise<void> {
  if (goal.delivery?.materialReview) await recheckMaterialReview(goal.delivery.materialReview, ctx, assertCurrent);
  assertCurrent();
}

/** Discard only current cached qualification; journal history and budgets stay intact. */
export function withoutStaleClearQualification(goal:ActiveGoal,groups:readonly DeliveryGroup[],tasks:readonly TodoTask[]):ActiveGoal {
  if(goal.status==="done" || !getGoalClearGeneration(goal.id))return goal;
  const current=taskGroupDigest(goal,groups,tasks);
  if((!goal.delivery || goal.delivery.groupDigest===current) && (!goal.verifiedGroupDigest || goal.verifiedGroupDigest===current))return goal;
  const next={...goal};delete next.delivery;delete next.verifiedGroupDigest;delete next.verdictDigest;delete next.businessReview;return next;
}
