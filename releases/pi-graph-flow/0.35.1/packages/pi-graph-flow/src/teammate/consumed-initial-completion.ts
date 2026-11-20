import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompletionIntent, InitialCompletionWitness } from "pi-maestro-teammate/v1";
import { goalContractDigest, taskGroupDigest } from "../goal-coordinator/delivery.ts";
import { getGoalById, goalState } from "../goal-coordinator/state.ts";
import { currentTaskExecution, hasCurrentTaskReport } from "../task-workflow/acceptance.ts";
import { GOAL_STATE_ENTRY_TYPE } from "../goal-coordinator/source.ts";
import { captureTodoSourceExecution, getDeliveryGroups, getVisibleTasks, runTodoSourceExecution } from "../task-workflow/commands.ts";

export function journalConsumedInitialCompletion(
  ctx: ExtensionContext, intent: CompletionIntent, witness: InitialCompletionWitness,
): boolean {
  const session = ctx.sessionManager;
  const [resource] = intent.resources;
  if (intent.resources.length !== 1 || !resource || resource.outcome !== "completed"
    || ctx.cwd !== resource.originCwd || session.getSessionId() !== intent.target.sessionId
    || resource.correlationId !== witness.correlationId) return false;
  return runTodoSourceExecution(captureTodoSourceExecution(ctx), () => {
    const tasks = getVisibleTasks();
    const matches = tasks.filter(task => {
      const execution = task.acceptanceReport?.execution;
      return !task.origin && task.status === "completed" && execution?.kind === "native"
        && execution.correlationId === witness.correlationId && execution.nativeInvocationId === witness.nativeInvocationId
        && execution.runtimeGeneration === witness.runtimeGeneration && execution.inputGeneration === witness.inputGeneration
        && execution.turnEpoch === witness.turnEpoch && execution.requestId === witness.requestId && execution.loopSeq === witness.loopSeq
        && hasCurrentTaskReport(task);
    });
    if (matches.length !== 1) return false;
    const task = matches[0]!;
    const groups = getDeliveryGroups();
    const group = groups.find(candidate => candidate.id === task.deliveryGroupId);
    if (!group?.deliveryGoalId || group.deliveryGoalId !== task.deliveryGoalId
      || group.currentPendingReplacementId || group.supersededBy
      || group.source.cwd !== ctx.cwd || group.source.sessionId !== intent.target.sessionId
      || !group.members.some(member => member.taskId === task.id && member.taskInstanceId === task.taskInstanceId)) return false;
    const goal = getGoalById(group.deliveryGoalId);
    const delivery = goal?.delivery;
    if (!goal || !delivery || (delivery.phase !== "awaiting-reply" && delivery.phase !== "delivered")
      || (delivery.phase === "awaiting-reply" ? goal.status !== "active" : goal.status !== "done")
      || delivery.source.cwd !== ctx.cwd || delivery.source.sessionId !== intent.target.sessionId
      || delivery.ownerEpoch !== goalState.goalLifecycleEpoch || delivery.ownerInstanceId !== goalState.goalOwnerInstanceId
      || delivery.contractDigest !== goalContractDigest(goal) || delivery.groupDigest !== taskGroupDigest(goal, groups, tasks)) return false;
    const branch = session.getBranch();
    const indexOf = (id: string | undefined) => id ? branch.findIndex(entry => entry.id === id) : -1;
    const ready = indexOf(delivery.readyEntryId);
    const source = indexOf(delivery.source.branchAnchor);
    const groupAnchor = indexOf(group.source.branchAnchor);
    const taskAnchor = indexOf(currentTaskExecution(task)?.branchAnchor);
    const readyEntry = branch[ready];
    if (readyEntry?.type !== "custom" || readyEntry.customType !== GOAL_STATE_ENTRY_TYPE
      || source < 0 || source > ready || groupAnchor < 0 || groupAnchor > ready || taskAnchor < 0 || taskAnchor > ready) return false;
    if (branch.slice(ready + 1).some(entry => entry.type === "message" && entry.message.role === "user")) return false;
    return delivery.phase === "awaiting-reply" ? delivery.receipt === undefined : indexOf(delivery.receipt?.entryId) > ready;
  });
}
