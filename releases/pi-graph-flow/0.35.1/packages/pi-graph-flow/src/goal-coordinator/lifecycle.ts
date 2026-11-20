import { refreshGoalBudgetView, getGoalList } from "./state.ts";
/** Goal lifecycle owner. */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { goalState, assertGoalBudgetHost, persistGoal, clearCompletionTimer, clearElapsedTimer, clearContinuation, clearRecovery, restoreGoalSelection, recoverPendingGoalTodoDetaches, releaseGoalSelection, cancelContinuation, commitDeliveredGoal, fenceGoalLifecycle, pauseGoal, updateUsage } from "./state.ts";
import { FAILOVER_TERMINAL_EVENT } from "../providers/model-failover.ts";
import { onFailoverTerminal, connectGoalContinuation } from "./continuation.ts";
import { type WorkflowCoordinator } from "../session/coordinator.ts";
import { type GoalContext, type ActiveGoal } from "./types.ts";
import { currentSessionId, getVisibleTasks, getDeliveryGroups, readTaskHost, goalClock } from "./host.ts";
import { loadGoalSource, withGoalSource, captureGoalSource, guardGoalAwait, invalidateGoalSource, assertGoalSource, GOAL_STATE_ENTRY_TYPE } from "./source.ts";
import { clearGoalDisplay, updateStatusLine, showCompletionStatus, STATUS_KEY, updateGoalWidget } from "./presentation.ts";
import { handleResume, connectGoalCommands } from "./commands.ts";
import { withTodoSourceExecution, captureTodoSourceExecution, assertTodoSourceExecution, isGoalPlanExecutionHeld, getGoalClearGeneration } from "../task-workflow/commands.ts";
import { goalContractDigest, taskGroupDigest, readFinalMainReply, verifyGoalTaskGroup, recheckGoalMaterials } from "./delivery.ts";
import { digest } from "../verification/material-review.ts";
import { completionWorkflowAuthority, canonicalWorkflowAdmissionIssue, shouldApplyCompletionBlockers, hasMatchingWorkflowBinding, canonicalCompletionBlockers, configureGoalVerification } from "../tools/goal-verification.ts";

export function initGoal(pi: ExtensionAPI) {
  goalState.setExtensionApi(pi);
  goalState.disposeFailoverTerminal?.();
  goalState.setDisposeFailoverTerminal(pi.events?.on?.(FAILOVER_TERMINAL_EVENT, onFailoverTerminal));
}

export function setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void {
  goalState.setWorkflowCoordinator(coordinator);
}

export async function onSessionStart(
  ctx: GoalContext,
  event: { reason?: "startup" | "reload" | "new" | "resume" | "fork"; deferResume?: boolean } = {},
) {
  goalState.setGoalLifecycleEpoch(goalState.goalLifecycleEpoch + 1);
  goalState.setVerificationInFlight(undefined);
  goalState.setGoalLoopOwner(undefined);
  goalState.setLatestGoalAttempt(undefined);
  clearCompletionTimer();
  clearElapsedTimer();
  clearContinuation();
  clearRecovery();
  goalState.setBaseCwd(ctx.cwd);
  goalState.setGoalDisplayContext(ctx);
  goalState.setGoalSessionId(currentSessionId(ctx));
  loadGoalSource(ctx);
  restoreGoalSelection(ctx, event.reason === "new" || event.reason === "fork");
  if (!goalState.activeGoal) {
    clearGoalDisplay(ctx);
    return;
  }

  try { assertGoalBudgetHost(goalState.activeGoal.tokenBudget, ctx); }
  catch (error) {
    if (goalState.activeGoal.status === "active") persistGoal(pauseGoal(goalState.activeGoal, "gate"));
    ctx.ui.notify(`Goal budget execution paused: ${error instanceof Error ? error.message : String(error)}`, "warning");
    updateStatusLine(ctx, goalState.activeGoal);
    return;
  }
  for (const goal of getGoalList()) refreshGoalBudgetView(goal.id, ctx);
  updateStatusLine(ctx, goalState.activeGoal);
  if (event.reason === "resume" && !event.deferResume) await withGoalSource(captureGoalSource(ctx), () => guardGoalAwait(handleResume(undefined, ctx)));
}

export function recoverPendingGoalTodoDetachesAfterTodoStart(ctx: GoalContext): number {
  return withTodoSourceExecution(captureTodoSourceExecution(ctx as never), () => recoverPendingGoalTodoDetaches(ctx, true));
}

export function onSessionShutdown(ctx: GoalContext, options: { afterSuccessfulPersist?: () => void } = {}) {
  goalState.setGoalLifecycleEpoch(goalState.goalLifecycleEpoch + 1);
  goalState.setVerificationInFlight(undefined);
  let persistenceFailed = false;
  let persistenceError: unknown;
  try {
    if (goalState.activeGoal) persistGoal(goalState.activeGoal);
    options.afterSuccessfulPersist?.();
  } catch (error) {
    persistenceFailed = true;
    persistenceError = error;
  } finally {
    invalidateGoalSource();
    releaseGoalSelection();
    goalState.setGoalLoopOwner(undefined);
    goalState.setLatestGoalAttempt(undefined);
    goalState.setGoalSessionId(undefined);
    clearContinuation();
    clearRecovery();
    try {
      clearGoalDisplay(ctx);
    } catch (error) {
      if (!persistenceFailed) throw error;
    } finally {
      goalState.setGoalDisplayContext(undefined);
      clearCompletionTimer();
      clearElapsedTimer();
      goalState.setCompactionInFlight(false);
    }
  }
  if (persistenceFailed) throw persistenceError;
}

export function commitVerifiedCompletion(goal: ActiveGoal, ctx: GoalContext, authority = completionWorkflowAuthority(goal, goalState.workflowCoordinator?.status())): "done" | "awaiting-reply" {
  assertGoalSource();
  const qualityGate = getVisibleTasks().some(task => !task.supersessionId && !task.replacementPendingId && task.goalId === goal.id);
  if(isGoalPlanExecutionHeld(goal.id))throw new Error("Task coverage is held");
  const currentGroupDigest=taskGroupDigest(goal,getDeliveryGroups(),getVisibleTasks());
  if(getGoalClearGeneration(goal.id) && goal.verifiedGroupDigest!==currentGroupDigest)throw new Error("Fresh complete verification required for current Task generation");
  const group = getDeliveryGroups().some(candidate => candidate.deliveryGoalId === goal.id);
  if (qualityGate && group) throw new Error("A Goal cannot be both the parent delivery and its quality gate.");
  if (!qualityGate) {
    const workflowAuthority = goal.delivery?.workflowAuthority?.canonical ? goal.delivery.workflowAuthority : authority;
    const ready: ActiveGoal = { ...goal, status: "active", delivery: {phase:"awaiting-reply",workflowAuthority,contractDigest:goalContractDigest(goal),groupDigest:goal.verifiedGroupDigest ?? taskGroupDigest(goal,getDeliveryGroups(),getVisibleTasks()),ownerEpoch:goalState.goalLifecycleEpoch,ownerInstanceId:goalState.goalOwnerInstanceId,source:readTaskHost(ctx as never),verdictDigest:goal.verdictDigest ?? digest(null),...(goal.businessReview ? {materialReview:goal.businessReview} : {})} };
    persistGoal(ready);
    const branch = (ctx.sessionManager as {getBranch?: () => {id?:string;customType?:string}[]} | undefined)?.getBranch?.();
    const entryId = branch?.filter(entry => entry.customType === GOAL_STATE_ENTRY_TYPE).at(-1)?.id;
    if (!entryId) throw new Error("Business-ready publication ID unavailable; reconcile the Goal write before retrying.");
    persistGoal({...ready, delivery:{...ready.delivery!,readyEntryId:entryId}});
    cancelContinuation(); clearRecovery(); goalState.setLatestGoalAttempt(undefined); clearElapsedTimer();
    updateStatusLine(ctx,goalState.activeGoal!);
    return "awaiting-reply";
  }
  commitDeliveredGoal(goal,ctx);
  return "done";
}

export async function commitFinalMainReply(ctx: GoalContext, scope: object): Promise<void> {
  const original = goalState.activeGoal;
  if (!original?.delivery || original.delivery.phase !== "awaiting-reply") return;
  const receipt = readFinalMainReply(original,ctx,goalState.goalLifecycleEpoch,goalState.goalOwnerInstanceId); if (!receipt) return;
  const pin = digest(original);
  const assertCurrent = () => {
    assertGoalSource(scope);
    if (getDeliveryGroups().some(group => group.deliveryGoalId === original.id)) assertTodoSourceExecution();
    if (!goalState.activeGoal || digest(goalState.activeGoal) !== pin || taskGroupDigest(original,getDeliveryGroups(),getVisibleTasks()) !== original.delivery!.groupDigest
      || digest(readFinalMainReply(original,ctx,goalState.goalLifecycleEpoch,goalState.goalOwnerInstanceId)) !== digest(receipt)) throw new Error("Goal, task group, branch, or final reply changed during delivery commit.");
  };
  try {
    assertCurrent();
    await verifyGoalTaskGroup(original,getDeliveryGroups(),getVisibleTasks(),ctx,assertCurrent);
    await recheckGoalMaterials(original,ctx,assertCurrent);
    if (original.workflowSessionId) {
      const snapshot = await (goalState.workflowCoordinator?.refreshSnapshot?.() ?? Promise.resolve(goalState.workflowCoordinator?.status())); assertCurrent();
      const authority = original.delivery.workflowAuthority ?? completionWorkflowAuthority(original, snapshot);
      if ((authority.canonical && (authority.sessionId !== original.workflowSessionId || !hasMatchingWorkflowBinding(original,snapshot)))
        || canonicalWorkflowAdmissionIssue(original,snapshot)
        || (shouldApplyCompletionBlockers(original,snapshot) && canonicalCompletionBlockers(snapshot).length)) throw new Error("Canonical Workflow no longer permits delivery.");
    }
    assertCurrent();
    const delivered:ActiveGoal={...original,status:"done",updatedAt:goalClock.now(),delivery:{...original.delivery,phase:"delivered",receipt}};
    commitDeliveredGoal(delivered,ctx);
    showCompletionStatus(ctx,delivered);
    ctx.ui.notify(`Goal delivered with main reply ${receipt.entryId}: ${original.text}`,"info");
  } catch(error) {
    // Late/stale reply and material drift leave the existing ready state; no blind retry or follow-up.
    ctx.ui.notify(`${(error as {code?:string})?.code?.endsWith("_WRITE_RECONCILE_REQUIRED") ? "Goal delivery write outcome requires reconciliation; do not retry automatically" : "Goal remains awaiting delivery"}: ${String(error)}`,"warning");
  }
}

export function configureGoalOwnerVerification(): void {
  connectGoalCommands({ commitVerifiedCompletion });
  connectGoalContinuation({ commitFinalMainReply });
configureGoalVerification({
  get statusKey() { return STATUS_KEY; },
  get baseCwd() { return goalState.baseCwd; },
  get extensionApi() { return goalState.extensionApi; },
  get goalLifecycleEpoch() { return goalState.goalLifecycleEpoch; },
  get activeGoal() { return goalState.stagedActiveGoal ?? goalState.activeGoal; },
  set activeGoal(value) { goalState.setStagedActiveGoal(value); },
  get verificationInFlight() { return goalState.verificationInFlight; },
  set verificationInFlight(value) { goalState.setVerificationInFlight(value); },
  getWorkflowSnapshot() { return goalState.workflowCoordinator?.status(); },
  refreshWorkflowSnapshot() {
    return goalState.workflowCoordinator?.refreshSnapshot?.() ?? Promise.resolve(goalState.workflowCoordinator?.status());
  },
  fenceGoalLifecycle,
  pauseGoal,
  updateUsage(goal, ctx) { updateUsage(goal, ctx); goalState.stageUpdatedVerificationView(goal); },
  persistGoal,
  commitVerifiedCompletion,
  updateStatusLine,
  updateGoalWidget,
  showCompletionStatus,
});
}

export async function resumeAfterPlanReplacementRecovery(ctx: GoalContext, targetGoalId?: string): Promise<void> {
  const goal = goalState.activeGoal;
  if (!goal || targetGoalId !== undefined && goal.id !== targetGoalId || goal.status !== "active" || isGoalPlanExecutionHeld(goal.id)) return;
  await withGoalSource(captureGoalSource(ctx), () => guardGoalAwait(handleResume(undefined, ctx)));
}
