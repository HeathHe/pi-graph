import { budgetCanContinue } from "./budget-view.ts";
/** Goal commands owner. */
import { AggregateSourceReadUnavailableError } from "../persistence-recovery/aggregate-source-owner.ts";
import { type GoalParams, type GoalContext, type GoalCommandParams, type ActiveGoal, type GoalCompletionPort } from "./types.ts";
import { type GoalVerificationClassification, MAX_COMPLETION_SUMMARY_CHARS, verifyGoalCompletion, isTerminalCanonicalWorkflow, normalizeAcceptance, acceptanceValidationError, MAX_OBJECTIVE_LENGTH } from "../tools/goal-verification.ts";
import { captureGoalSource, withGoalSource, assertGoalSource, guardGoalAwait } from "./source.ts";
import { captureTodoSourceExecution, withTodoSourceExecution, assertTodoSourceExecution, isGoalPlanReplacementPending, isGoalTaskClearPending, isGoalPlanExecutionHeld, readPlanReplacementForGoal } from "../task-workflow/commands.ts";
import { evidenceRefsValidationError, normalizeEvidenceRefs } from "../tools/goal-evidence.ts";
import { materialReviewValidationError, digest, type MaterialReviewInput } from "../verification/material-review.ts";
import { goalState, assertGoalBudgetHost, fenceGoalLifecycle, pauseGoal, persistGoal, createWorkflowGoal, activateResumedGoal, cancelContinuation, isSupersededWorkflowProjection, createGoal, clearRecovery, updateUsage, recoverPendingGoalTodoDetaches, clearPersistedGoal, persistGoalSelection, clearElapsedTimer, getGoalById, registryWithGoal, readGoalBudgetView, syncGoalBudgetDeclaration } from "./state.ts";
import { getDeliveryGroups, getVisibleTasks, goalClock, currentTokenTotal, abortTurn } from "./host.ts";
import { withoutStaleClearQualification, goalContractDigest, taskGroupDigest, verifyGoalTaskGroup, recheckGoalMaterials } from "./delivery.ts";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type WorkflowSnapshot } from "../session/types.ts";
import { STATUS_KEY, updateStatusLine, clearGoalDisplay, fmtBudget, goalSummary } from "./presentation.ts";
import { armGoalLoop, sendGoalPrompt, fenceWorkflowContinuation, sendResumePrompt } from "./continuation.ts";

export async function executeGoal(
  params: GoalParams,
  ctx: GoalContext,
  signal?: AbortSignal,
): Promise<{ text: string; isError: boolean; terminate?: boolean; details?: { classification: GoalVerificationClassification } }> {
  try {
  const goalScope = captureGoalSource(ctx, signal);
  const sourceExecution = captureTodoSourceExecution(ctx as never);
  return await withGoalSource(goalScope, () => withTodoSourceExecution(sourceExecution, async () => {
  if (goalState.activeGoal && (isGoalPlanReplacementPending(goalState.activeGoal.id) || isGoalTaskClearPending(goalState.activeGoal.id)) && !["get", "status", "stop"].includes(params.action)) return { text: "plan-replacement-pending: conflicting Goal mutation held", isError: true };
  switch (params.action) {
    case "get":
      return showStatus(ctx);
    case "create": {
      if (typeof params.objective !== "string" || params.objective.trim().length === 0) {
        return { text: "Goal create requires a non-empty objective.", isError: true };
      }
      return handleCreate(params.objective, params.tokenBudget, ctx, params.planHandoffKey, params.acceptance, params.verificationMode);
    }
    case "update": {
      if (typeof params.objective !== "string" || params.objective.trim().length === 0) {
        return { text: "Goal update requires a non-empty objective.", isError: true };
      }
      return handleUpdate(params.objective, ctx, params.acceptance, params.verificationMode);
    }
    case "complete": {
      if (typeof params.summary !== "string" || params.summary.trim().length === 0) {
        return { text: "Goal complete requires a non-empty summary.", isError: true, details: { classification: "input-error" } };
      }
      const completionSummary = params.summary.trim();
      if (completionSummary.length > MAX_COMPLETION_SUMMARY_CHARS) {
        return {
          text: `Goal completion summary too long (${completionSummary.length}/${MAX_COMPLETION_SUMMARY_CHARS}). Keep summary <= 4000 characters; put raw evidence in optional evidenceRefs instead.`,
          isError: true,
          details: { classification: "input-error" },
        };
      }
      const refsError = evidenceRefsValidationError(params.evidenceRefs);
      if (refsError) return { text: refsError, isError: true, details: { classification: "input-error" } };
      if (params.review && materialReviewValidationError(params.review)) return {text:materialReviewValidationError(params.review)!,isError:true,details:{classification:"input-error" as const}};
      const originalQualification=goalState.activeGoal;
      if(originalQualification && !isGoalPlanExecutionHeld(originalQualification.id)){const fresh=withoutStaleClearQualification(originalQualification,getDeliveryGroups(),getVisibleTasks());if(fresh!==originalQualification){fenceGoalLifecycle();persistGoal(fresh);}}
      if (!params.review && goalState.activeGoal?.delivery?.phase === "awaiting-reply" && goalState.activeGoal.delivery.ownerEpoch === goalState.goalLifecycleEpoch && goalState.activeGoal.delivery.ownerInstanceId === goalState.goalOwnerInstanceId) {
        const original = goalState.activeGoal;
        const delivery = goalState.activeGoal.delivery;
        const before = digest(original);
        const assertCurrent = () => {
          assertGoalSource(goalScope);
          if (getDeliveryGroups().some(group => group.deliveryGoalId === original.id)) assertTodoSourceExecution(sourceExecution);
          if (!goalState.activeGoal || digest(goalState.activeGoal) !== before || goalContractDigest(original) !== delivery.contractDigest
            || taskGroupDigest(original,getDeliveryGroups(),getVisibleTasks()) !== delivery.groupDigest) throw new Error("Current business acceptance changed before delivery expectation could refresh.");
        };
        try {
          assertCurrent();
          await verifyGoalTaskGroup(original,getDeliveryGroups(),getVisibleTasks(),ctx,assertCurrent);
          await recheckGoalMaterials(original,ctx,assertCurrent);
          assertCurrent();
          completionPort.commitVerifiedCompletion({...original,status:"done",businessReview:delivery.materialReview,verifiedGroupDigest:delivery.groupDigest,verdictDigest:delivery.verdictDigest},ctx);
          return {text:"Current business evidence rechecked; awaiting the actual final main reply in this delivery turn.",isError:false,details:{classification:"success" as const}};
        } catch(error) { if (error instanceof AggregateSourceReadUnavailableError) throw error; return {text:`Delivery expectation was not refreshed: ${String(error)}`,isError:true,details:{classification:"acceptance-failed" as const}}; }
      }
      const outcome = await guardGoalAwait(verifyGoalCompletion(completionSummary, ctx, normalizeEvidenceRefs(params.evidenceRefs), params.review));
      const text = outcome.status === "done"
        ? "Goal done (verified)."
        : outcome.status === "awaiting-reply" ? "Goal business acceptance is ready; awaiting the actual final main reply. Send the user-facing final answer in this current branch; no extra confirmation is required."
        : outcome.status === "paused"
          ? `Goal completion was not verified; the Goal is paused. Reason: ${outcome.reason}`
          : outcome.status === "hold"
            ? `Goal completion was not started. Reason: ${outcome.reason}`
            : `Goal completion was not verified; continue the active Goal. Reason: ${outcome.reason}`;
      return { text, isError: false, details: { classification: outcome.classification } };
    }
    default:
      return { text: "Unknown action. Valid: get, create, update, complete", isError: true };
  }

  }));
  } catch (error) { if (error instanceof AggregateSourceReadUnavailableError) return sourceUnavailable(ctx); throw error; }
}

export function preparePlanReplacement(id: string, ctx: GoalContext): NonNullable<import("../task-workflow/plan-replacement.ts").PlanReplacementReceipt["parentGoal"]> {
  return withGoalSource(captureGoalSource(ctx), () => {
    assertGoalSource(); const goal = getGoalById(id);
    if (!goal || goal.status === "done" || goalState.pendingTodoDetachGoalIds.includes(id)) throw new Error("Replacement parent Goal must exist, remain open and have no pending detach");
    return { id, oldPlanHandoffKey: goal.planHandoffKey ?? null, contractEpoch: goal.planContractEpoch ?? 0, contractDigest: goalContractDigest(goal) };
  });
}
export async function rebindPlanReplacement(id: string, ctx: GoalContext): Promise<NonNullable<import("../task-workflow/plan-replacement.ts").PlanReplacementReceipt["goalPublication"]>> {
  return withGoalSource(captureGoalSource(ctx), () => {
    const evidence = readPlanReplacementForGoal(id), receipt = evidence.receipt, pin = receipt.parentGoal;
    if (!pin) throw new Error("Replacement has no parent Goal");
    const current = getGoalById(pin.id);
    if (!current || current.status === "done" || goalState.pendingTodoDetachGoalIds.includes(pin.id)) throw new Error("Replacement Goal conflict requires reconciliation");
    const expected: NonNullable<ActiveGoal["planReplacement"]> = { version: 1, id, fromGroupId: receipt.predecessor.groupId, toGroupId: receipt.successor.groupId,
      fromPlanHandoffKey: receipt.predecessor.plan.handoffKey, toPlanHandoffKey: receipt.successor.plan.handoffKey,
      taskStateDigest: evidence.taskStateDigest, contractEpoch: pin.contractEpoch + 1 };
    if (current.planReplacement?.id === id) {
      if (digest(current.planReplacement) !== digest(expected) || current.planHandoffKey !== expected.toPlanHandoffKey || current.planContractEpoch !== expected.contractEpoch) throw new Error("Replacement Goal receipt differs");
    } else {
      if ((current.planHandoffKey ?? null) !== pin.oldPlanHandoffKey || (current.planContractEpoch ?? 0) !== pin.contractEpoch || goalContractDigest(current) !== pin.contractDigest) throw new Error("Replacement Goal contract changed");
      const next: ActiveGoal = { ...current, planHandoffKey: expected.toPlanHandoffKey, planContractEpoch: expected.contractEpoch, planReplacement: expected };
      delete next.delivery; delete next.verifiedGroupDigest; delete next.verdictDigest; delete next.businessReview;
      const selected = goalState.activeGoal;
      const guard = () => { assertGoalSource(); const authentic = readPlanReplacementForGoal(id); if (digest(authentic) !== digest(evidence) || digest(getGoalById(pin.id)) !== digest(current) || goalState.activeGoal?.id !== selected?.id) throw new Error("Replacement Goal/Task publication guard changed"); };
      persistGoalSelection(selected?.id === pin.id ? next : selected, registryWithGoal(next), goalState.pendingTodoDetachGoalIds, guard);
      // The current owner's handles are revoked only after its own durable publication.
      if (selected?.id === pin.id) fenceGoalLifecycle();
    }
    const goal = getGoalById(pin.id)!;
    const branch = (ctx.sessionManager as {getBranch(): {id?:string;type?:string;customType?:string;data?:unknown}[]}).getBranch();
    const entry = [...branch].reverse().find(entry => {
      if (entry.type !== "custom" || entry.customType !== "pi-graph-next:goal-state") return false;
      const data = entry.data as {goals?:ActiveGoal[]}; return data.goals?.some(item => item.id === pin.id && digest(item.planReplacement) === digest(expected));
    });
    if (!entry?.id) throw new Error("Replacement Goal journal receipt is not observable");
    return { goalId: pin.id, contractEpoch: expected.contractEpoch, goalContractDigest: goalContractDigest(goal), entryId: entry.id, dataDigest: digest(entry.data) };
  });
}

export function assertPlanReplacementHistory(receipt: import("../task-workflow/plan-replacement.ts").PlanReplacementReceipt, ctx: { sessionManager?: unknown }): void {
  const publication = receipt.goalPublication;
  if (!receipt.parentGoal || !publication) throw new Error("Replacement historical Goal publication is missing");
  const branch = (ctx.sessionManager as {getBranch():{id?:string;type?:string;customType?:string;data?:unknown}[]}).getBranch();
  const entries = branch.filter(entry => entry.id === publication.entryId && entry.type === "custom" && entry.customType === "pi-graph-next:goal-state");
  if (entries.length !== 1 || digest(entries[0]!.data) !== publication.dataDigest) throw new Error("Replacement original Goal R3 publication changed");
  const data = entries[0]!.data as {goals?:ActiveGoal[]};
  const originals = data.goals?.filter(goal => goal.id === publication.goalId) ?? [];
  const original = originals[0], r = original?.planReplacement;
  if (originals.length !== 1 || !original || !r || r.id !== receipt.id || r.version !== 1
    || r.fromGroupId !== receipt.predecessor.groupId || r.toGroupId !== receipt.successor.groupId
    || r.fromPlanHandoffKey !== receipt.predecessor.plan.handoffKey || r.toPlanHandoffKey !== receipt.successor.plan.handoffKey
    || original.planHandoffKey !== r.toPlanHandoffKey || original.planContractEpoch !== publication.contractEpoch
    || r.contractEpoch !== publication.contractEpoch || goalContractDigest(original) !== publication.goalContractDigest)
    throw new Error("Replacement historical Goal contract/receipt differs");
}

export function assertPlanReplacementPublication(id: string, publication: NonNullable<import("../task-workflow/plan-replacement.ts").PlanReplacementReceipt["goalPublication"]>, ctx: GoalContext): void {
  withGoalSource(captureGoalSource(ctx), () => {
    assertGoalSource();
    const evidence = readPlanReplacementForGoal(id), receipt = evidence.receipt, goal = getGoalById(publication.goalId);
    if (receipt.parentGoal?.id !== publication.goalId || !goal || goal.status === "done" || goal.planReplacement?.id !== id
      || goal.planContractEpoch !== publication.contractEpoch || goal.planHandoffKey !== receipt.successor.plan.handoffKey
      || goal.planReplacement.taskStateDigest !== evidence.taskStateDigest || goalContractDigest(goal) !== publication.goalContractDigest) throw new Error("Replacement Goal current contract/receipt differs before completion");
    const branch = (ctx.sessionManager as {getBranch():{id?:string;type?:string;customType?:string;data?:unknown}[]}).getBranch();
    const entries = branch.filter(entry=>entry.id===publication.entryId && entry.type==="custom" && entry.customType==="pi-graph-next:goal-state");
    if (entries.length!==1 || digest(entries[0]!.data)!==publication.dataDigest) throw new Error("Replacement original Goal R3 publication changed");
    const data=entries[0]!.data as {goals?:ActiveGoal[]};
    if (!data.goals?.some(item=>item.id===goal.id && digest(item.planReplacement)===digest(goal.planReplacement))) throw new Error("Replacement Goal receipt is not present in original R3 publication");
  });
}

export async function executeGoalCommand(
  params: GoalCommandParams,
  ctx: GoalContext,
): Promise<{ text: string; isError: boolean }> {
  try {
  const goalScope = captureGoalSource(ctx);
  const sourceExecution = captureTodoSourceExecution(ctx as never);
  return await withGoalSource(goalScope, () => withTodoSourceExecution(sourceExecution, async () => {
  if (goalState.activeGoal && (isGoalPlanReplacementPending(goalState.activeGoal.id) || isGoalTaskClearPending(goalState.activeGoal.id)) && !["get", "status", "stop"].includes(params.action)) return { text: "plan-replacement-pending: conflicting Goal mutation held", isError: true };
  switch (params.action) {
    case "status": return showStatus(ctx);
    case "create": return handleCreate(params.objective, params.tokenBudget, ctx);
    case "stop": return handleStop(ctx);
    case "resume": return handleResume(params.tokenBudget, ctx);
    case "clear": return handleClear(ctx);
  }

  }));
  } catch (error) { if (error instanceof AggregateSourceReadUnavailableError) return sourceUnavailable(ctx); throw error; }
}

export function registerGoalCommand(pi: ExtensionAPI) {
  pi.registerCommand("goal", {
    description: "Manage goals (no budget by default): /goal status | /goal create [--tokens 100k] <objective> | /goal stop | /goal resume [--tokens 100k] | /goal clear",
    getArgumentCompletions: goalArgumentCompletions,
    async handler(args: string, ctx: GoalContext) {
      const result = parseGoalCommand(args);
      if (typeof result === "string") {
        ctx.ui.notify(result, "warning");
        return;
      }
      const response = await executeGoalCommand(result, ctx);
      if (response.isError) ctx.ui.notify(response.text, "warning");
    },
  });
}

export function goalArgumentCompletions(prefix: string) {
  const options = [
    { value: "status", label: "status", description: "Show the current Goal" },
    { value: "create ", label: "create <objective>", description: "Create a Goal without a Token budget (default)" },
    { value: "create --tokens 100k ", label: "create --tokens 100k <objective>", description: "Create with an explicit budget; accepts plain, k, or m values" },
    { value: "stop", label: "stop", description: "Stop and persist the current Goal" },
    { value: "resume", label: "resume", description: "Resume without changing the budget" },
    { value: "resume --tokens 100k", label: "resume --tokens 100k", description: "Set or replace the Token budget, then resume" },
    { value: "clear", label: "clear", description: "Clear current selection and retain Goal history" },
  ];
  const normalized = prefix.trimStart().toLowerCase();
  const matches = options.filter((option) => option.value.toLowerCase().startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

export function reconcileWorkflowGoal(snapshot: WorkflowSnapshot, ctx: GoalContext): ActiveGoal | undefined {
  const session = snapshot.session;
  if (snapshot.canonicalClaim?.status === "invalid") {
    if (goalState.activeGoal?.workflowSessionId && goalState.activeGoal.status === "active") {
      fenceGoalLifecycle();
      const paused = pauseGoal(goalState.activeGoal, "gate");
      persistGoal(paused);
      updateStatusLine(ctx, paused);
    }
    return goalState.activeGoal;
  }
  if (!session) {
    if (goalState.activeGoal?.workflowSessionId && goalState.activeGoal.status === "active") {
      fenceGoalLifecycle();
      const paused = pauseGoal(goalState.activeGoal, "gate");
      persistGoal(paused);
      updateStatusLine(ctx, paused);
    }
    return goalState.activeGoal;
  }

  const terminalWorkflow = isTerminalCanonicalWorkflow(snapshot);
  const currentGoal = goalState.activeGoal;
  if (currentGoal?.workflowSessionId && currentGoal.workflowSessionId !== session.sessionId) {
    fenceGoalLifecycle();
    const paused = pauseGoal(currentGoal, "gate");
    if (terminalWorkflow) {
      persistGoal(paused);
      updateStatusLine(ctx, paused);
      return paused;
    }
    const replacement = createWorkflowGoal(session, ctx, snapshot.sessionGeneration);
    persistGoal({ ...paused, supersededByGoalId: replacement.id });
    persistGoal(replacement);
    updateStatusLine(ctx, replacement);
    return replacement;
  }

  const failedGate = session.runs.flatMap((run) => run.gates)
    .some((gate) => gate.blocking && ["failed", "blocked"].includes(gate.status));
  if (currentGoal?.workflowSessionId === session.sessionId
    && currentGoal.workflowSessionGeneration !== snapshot.sessionGeneration) {
    if (terminalWorkflow && currentGoal.status === "active") fenceGoalLifecycle();
    const rebound = terminalWorkflow
      ? currentGoal.status === "active"
        ? pauseGoal(currentGoal, "gate")
        : { ...currentGoal, updatedAt: goalClock.now() }
      : currentGoal.status === "paused" && currentGoal.pauseReason === "gate" && !failedGate
        ? activateResumedGoal(currentGoal)
        : { ...currentGoal, updatedAt: goalClock.now() };
    rebound.workflowSessionGeneration = snapshot.sessionGeneration;
    persistGoal(rebound);
    updateStatusLine(ctx, rebound);
  }

  if (terminalWorkflow) {
    if (goalState.activeGoal?.workflowSessionId === session.sessionId && goalState.activeGoal.status === "active") {
      fenceGoalLifecycle();
      const paused = pauseGoal(goalState.activeGoal, "gate");
      persistGoal(paused);
      updateStatusLine(ctx, paused);
    }
    return goalState.activeGoal;
  }
  if (!goalState.activeGoal) {
    const created = createWorkflowGoal(session, ctx, snapshot.sessionGeneration, failedGate);
    persistGoal(created);
    updateStatusLine(ctx, created);
    return created;
  }
  if (goalState.activeGoal.workflowSessionId === session.sessionId && failedGate && goalState.activeGoal.status === "active") {
    cancelContinuation();
    const paused = pauseGoal(goalState.activeGoal, "gate");
    persistGoal(paused);
    updateStatusLine(ctx, paused);
  }
  return goalState.activeGoal;
}

export function switchCurrentGoal(
  goalId: string,
  ctx?: GoalContext,
  opts: { resume?: boolean } = {},
): ActiveGoal | undefined {
  const target = goalState.goalRegistry.find((goal) => goal.id === goalId);
  if (!target || isSupersededWorkflowProjection(target)) return undefined;
  if (opts.resume) assertGoalBudgetHost(target.tokenBudget, ctx);
  if (opts.resume && isGoalPlanExecutionHeld(target.id)) throw new Error("plan-replacement-pending: target Goal resume held");
  if (opts.resume && target.status === "paused" && target.tokenBudget !== undefined) {
    const view = readGoalBudgetView(target.id, ctx);
    if (!budgetCanContinue(view)) throw new Error(view.text);
  }
  const nextGoal = opts.resume && target.status === "paused"
    ? { ...target, status: "active" as const, pauseReason: undefined, verificationFailures: 0, infraErrorStreak: 0, failStreak: 0, lastMissingEvidenceFingerprint: undefined, lastVerificationClassification: undefined, updatedAt: goalClock.now() }
    : target;
  persistGoal(opts.resume ? withoutStaleClearQualification(nextGoal,getDeliveryGroups(),getVisibleTasks()) : nextGoal);
  if (ctx) updateStatusLine(ctx, nextGoal);
  return { ...nextGoal };
}

export function addGoal(
  objective: string,
  ctx: GoalContext,
  opts: { tokenBudget?: number; planHandoffKey?: string; acceptance?: string[] } = {},
): ActiveGoal {
  const goal = createGoal(objective, opts.tokenBudget, currentTokenTotal(ctx) ?? 0, opts.planHandoffKey, normalizeAcceptance(opts.acceptance));
  persistGoal(goal);
  updateStatusLine(ctx, goal);
  return { ...goal };
}

export async function handleCreate(
  objective: string,
  budget: string | undefined,
  ctx: GoalContext,
  planHandoffKey?: string,
  acceptance?: unknown,
  verificationMode?: "root-review" | "role",
): Promise<{ text: string; isError: boolean }> {
  const err = validateObjective(objective);
  if (err) return { text: err, isError: true };

  const acceptanceError = acceptanceValidationError(acceptance);
  if (acceptanceError) return { text: acceptanceError, isError: true };

  const tokenBudget = budget !== undefined ? parseTokenBudget(budget) : undefined;
  if (budget !== undefined && tokenBudget === undefined) return { text: `Invalid token budget: ${budget}`, isError: true };

  if (goalState.activeGoal && goalState.activeGoal.status !== "done") {
    return {
      text: `A Goal already exists (${goalState.activeGoal.status}): ${goalState.activeGoal.text}. Use /goal stop, /goal resume, or /goal clear.`,
      isError: true,
    };
  }

  const goal = createGoal(objective, tokenBudget, currentTokenTotal(ctx) ?? 0, planHandoffKey, normalizeAcceptance(acceptance));
  goal.verificationMode = verificationMode ?? "root-review";
  persistGoal(goal);
  cancelContinuation();
  clearRecovery();
  if (ctx.isIdle?.() !== true) armGoalLoop(goal);
  updateStatusLine(ctx, goal);
  ctx.ui.notify(`Goal started: ${objective}`, "info");
  await guardGoalAwait(sendGoalPrompt(ctx, goal));
  updateStatusLine(ctx, goal);
  return { text: `Goal started (id: ${goal.id}): ${objective}`, isError: false };
}

export async function handleUpdate(
  objective: string,
  ctx: GoalContext,
  acceptance?: unknown,
  verificationMode?: "root-review" | "role",
): Promise<{ text: string; isError: boolean }> {
  if (!goalState.activeGoal) return { text: "No active goal to update.", isError: true };
  const err = validateObjective(objective);
  if (err) return { text: err, isError: true };
  const acceptanceError = acceptanceValidationError(acceptance);
  if (acceptanceError) return { text: acceptanceError, isError: true };

  const nextGoal = { ...goalState.activeGoal };
  delete nextGoal.delivery; delete nextGoal.businessReview; delete nextGoal.verifiedGroupDigest; delete nextGoal.verdictDigest;
  if (verificationMode) nextGoal.verificationMode = verificationMode;
  updateUsage(nextGoal, ctx);
  nextGoal.text = objective.trim();
  nextGoal.updatedAt = goalClock.now();
  if (acceptance !== undefined) nextGoal.acceptance = normalizeAcceptance(acceptance);
  persistGoal(nextGoal);
  updateStatusLine(ctx, nextGoal);

  const resumed = await guardGoalAwait(handleResume(undefined, ctx));
  if (resumed.isError) {
    return { text: `Goal updated but could not resume: ${resumed.text}`, isError: true };
  }
  return { text: `Goal updated and resumed (id: ${goalState.activeGoal?.id}): ${goalState.activeGoal?.text ?? objective.trim()}`, isError: false };
}

export async function handleStop(ctx: GoalContext): Promise<{ text: string; isError: boolean }> {
  if (!goalState.activeGoal) return { text: "No active goal.", isError: false };
  if (goalState.activeGoal.status === "paused") return { text: `Goal is already stopped: ${goalState.activeGoal.text}`, isError: false };
  if (goalState.activeGoal.status !== "active") return { text: `Goal is ${goalState.activeGoal.status}.`, isError: true };

  const stoppedGoal = { ...goalState.activeGoal };
  updateUsage(stoppedGoal, ctx);
  goalState.setGoalLoopOwner(undefined);
  goalState.setLatestGoalAttempt(undefined);
  cancelContinuation();
  await guardGoalAwait(fenceWorkflowContinuation());
  const paused = pauseGoal(stoppedGoal, "user");
  persistGoal(paused);
  updateStatusLine(ctx, paused);
  ctx.ui.notify(`Goal stopped by user: ${paused.text}`, "info");
  abortTurn(ctx);
  return { text: `Goal stopped: ${paused.text}`, isError: false };
}

export async function handleClear(ctx: GoalContext): Promise<{ text: string; isError: boolean }> {
  await guardGoalAwait(fenceWorkflowContinuation());
  if (!goalState.activeGoal) {
    cancelContinuation();
    clearRecovery();
    const hadPendingDetaches = goalState.pendingTodoDetachGoalIds.length > 0;
    recoverPendingGoalTodoDetaches(ctx);
    if (!hadPendingDetaches) clearPersistedGoal();
    clearGoalDisplay(ctx);
    return { text: "No active goal.", isError: false };
  }
  const text = goalState.activeGoal.text;
  clearActive(ctx);
  ctx.ui.notify(`Goal cleared: ${text}`, "warning");
  return { text: `Goal cleared: ${text}`, isError: false };
}

export async function handleResume(
  budget: string | undefined,
  ctx: GoalContext,
): Promise<{ text: string; isError: boolean }> {
  if (goalState.activeGoal && isGoalPlanExecutionHeld(goalState.activeGoal.id)) return { text: "Goal execution is held until its explicit replacement and current approval are reconciled.", isError: true };
  if (!goalState.activeGoal) return { text: "No active goal.", isError: true };
  const originalQualification=goalState.activeGoal;
  const fresh=withoutStaleClearQualification(originalQualification,getDeliveryGroups(),getVisibleTasks());
  if(fresh!==originalQualification){fenceGoalLifecycle();persistGoal(fresh);}
  if (goalState.activeGoal.status === "active") {
    assertGoalBudgetHost(goalState.activeGoal.tokenBudget, ctx);
    if (goalState.activeGoal.tokenBudget !== undefined) {
      const view = readGoalBudgetView(goalState.activeGoal.id, ctx);
      if (!budgetCanContinue(view)) return { text: view.text, isError: view.admission !== "waiting" };
    }
    const sent = await guardGoalAwait(sendResumePrompt(ctx, goalState.activeGoal));
    if (!sent && ctx.isIdle?.() !== true) armGoalLoop(goalState.activeGoal);
    updateStatusLine(ctx, goalState.activeGoal);
    return {
      text: sent ? `Goal continuation requested: ${goalState.activeGoal.text}` : `Goal is already active: ${goalState.activeGoal.text}`,
      isError: false,
    };
  }
  if (goalState.activeGoal.status !== "paused") return { text: `Goal is ${goalState.activeGoal.status}.`, isError: true };

  const resumedGoal = { ...goalState.activeGoal };
  updateUsage(resumedGoal, ctx);
  if (budget !== undefined) {
    const tokenBudget = parseTokenBudget(budget);
    if (tokenBudget === undefined) return { text: `Invalid token budget: ${budget}`, isError: true };
    resumedGoal.tokenBudget = tokenBudget;
    resumedGoal.updatedAt = goalClock.now();
  }

  assertGoalBudgetHost(resumedGoal.tokenBudget, ctx);
  if (resumedGoal.tokenBudget !== undefined) {
    // Publish the declaration while still paused, then confirm its original
    // pool CAS. Old prepared scopes remain frozen and are never reactivated.
    persistGoal(resumedGoal);
    try { await guardGoalAwait(syncGoalBudgetDeclaration(resumedGoal.id, ctx)); }
    catch (error) {
      const selected = goalState.activeGoal;
      if (selected) updateStatusLine(ctx, selected);
      return { text: `Goal was not resumed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
    const view = readGoalBudgetView(resumedGoal.id, ctx);
    if (view.kind === "ledger" && view.knownConsumed !== undefined) resumedGoal.budgetProgressCursor = view.knownConsumed;
    else if (view.kind === "uninitialized") resumedGoal.budgetProgressCursor = "0"; // Progress checkpoint, never an assertion of billed usage.
    if (!budgetCanContinue(view)) {
      updateStatusLine(ctx, resumedGoal); ctx.ui.notify(view.text, "warning");
      return { text: view.text, isError: view.admission !== "waiting" };
    }
  }

  // Recheck the original business hold after the asynchronous configuration.
  if (isGoalPlanExecutionHeld(resumedGoal.id)) return { text: "Goal execution is held until its explicit replacement and current approval are reconciled.", isError: true };
  clearRecovery();
  const activated = activateResumedGoal(resumedGoal);
  persistGoal(activated);
  updateStatusLine(ctx, activated);
  ctx.ui.notify(`Goal resumed: ${activated.text}`, "info");
  const sent = await guardGoalAwait(sendResumePrompt(ctx, activated));
  if (!sent && ctx.isIdle?.() !== true) armGoalLoop(activated);
  updateStatusLine(ctx, activated);
  return { text: `Goal resumed: ${activated.text}`, isError: false };
}

export function showStatus(ctx: GoalContext): { text: string; isError: boolean; details?: { classification: GoalVerificationClassification } } {
  if (!goalState.activeGoal) {
    clearGoalDisplay(ctx);
    return { text: "No goal set.", isError: false };
  }
  const refreshed = { ...goalState.activeGoal };
  updateUsage(refreshed, ctx);
  persistGoal(refreshed);
  updateStatusLine(ctx, refreshed);
  return { text: goalSummary(refreshed), isError: false, ...(refreshed.lastVerificationClassification ? { details: { classification: refreshed.lastVerificationClassification } } : {}) };
}

export function parseGoalCommand(args: string): GoalCommandParams | string {
  const tokens = tokenize(args.trim());
  if (tokens.length === 0) return { action: "status" };

  const [first, ...rest] = tokens;
  if (first === "status" || first === "get") {
    return rest.length === 0 ? { action: "status" } : "Usage: /goal status";
  }
  if (first === "stop") {
    return rest.length === 0 ? { action: "stop" } : "Usage: /goal stop";
  }
  if (first === "clear") return rest.length === 0 ? { action: "clear" } : "Usage: /goal clear";
  if (["pause", "set", "done", "complete"].includes(first ?? "")) {
    return "This legacy Goal command is no longer supported. Use /goal create, /goal stop, /goal resume, or /goal clear; request completion explicitly with the goal tool's complete action.";
  }

  if (first === "resume") {
    if (rest.length === 0) return { action: "resume" };
    if (rest.length === 2 && rest[0] === "--tokens") {
      return { action: "resume", tokenBudget: rest[1] };
    }
    return "Usage: /goal resume [--tokens 100k]";
  }

  // Explicit create or shorthand objective.
  let tokenBudget: string | undefined;
  const remaining = first === "create" ? [...rest] : [...tokens];
  if (remaining[0] === "--tokens") {
    if (!remaining[1]) return "Usage: /goal create --tokens 100k <objective>";
    tokenBudget = remaining[1];
    remaining.splice(0, 2);
    if (remaining.length === 0) return "Usage: /goal create --tokens 100k <objective>";
  }

  if (remaining.length === 0) return "Usage: /goal create [--tokens 100k] <objective>";
  return { action: "create", objective: remaining.join(" "), tokenBudget };
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of input) {
    if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (current) tokens.push(current); current = ""; continue; }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function clearActive(ctx: GoalContext, keepInRegistry = false) {
  cancelContinuation();
  clearRecovery();
  const clearedGoal = goalState.activeGoal;
  if (clearedGoal && !keepInRegistry) {
    const historical = clearedGoal.status === "active" ? pauseGoal(clearedGoal, "user") : clearedGoal;
    const nextRegistry = goalState.goalRegistry.map(entry => entry.id === historical.id ? historical : entry);
    const nextPending = [...new Set([...goalState.pendingTodoDetachGoalIds, clearedGoal.id])];
    persistGoalSelection(undefined, nextRegistry, nextPending);
    fenceGoalLifecycle();
    const detached = recoverPendingGoalTodoDetaches(ctx);
    if (detached > 0) {
      ctx.ui.notify(
        `Goal cleared; unbound ${detached} task${detached === 1 ? "" : "s"} from its quality gate.`,
        "info",
      );
    }
  } else {
    persistGoalSelection(undefined, goalState.goalRegistry, goalState.pendingTodoDetachGoalIds);
  }
  goalState.setGoalLoopOwner(undefined);
  goalState.setLatestGoalAttempt(undefined);
  clearElapsedTimer();
  clearGoalDisplay(ctx);
}

export function parseTokenBudget(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const units = Math.floor(n * (m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1_000 : 1));
  return Number.isSafeInteger(units) ? units : undefined;
}

export function validateObjective(objective: string): string | undefined {
  const t = objective.trim();
  if (!t) return "Objective is required.";
  if (t.length > MAX_OBJECTIVE_LENGTH) return `Objective too long (${t.length}/${MAX_OBJECTIVE_LENGTH}).`;
  return undefined;
}

export function parseGoalActionParams(params: Record<string, unknown>): GoalParams | undefined {
  const action = params.action;
  if (action === "get") return { action };
  if (action === "complete") {
    if (typeof params.summary !== "string" || evidenceRefsValidationError(params.evidenceRefs)) return undefined;
    if (params.review !== undefined && materialReviewValidationError(params.review)) return undefined;
    return { action, summary: params.summary, evidenceRefs: normalizeEvidenceRefs(params.evidenceRefs), ...(params.review ? {review: structuredClone(params.review) as MaterialReviewInput} : {}) };
  }
  if (action !== "create" && action !== "update") return undefined;
  if (typeof params.objective !== "string") return undefined;
  if (params.verificationMode !== undefined && params.verificationMode !== "root-review" && params.verificationMode !== "role") return undefined;
  const verificationMode = params.verificationMode as "root-review" | "role" | undefined;
  const acceptance = params.acceptance;
  if (acceptanceValidationError(acceptance)) return undefined;
  if (acceptance !== undefined
    && (!Array.isArray(acceptance) || !acceptance.every((command): command is string => typeof command === "string"))) {
    return undefined;
  }
  const validatedAcceptance = acceptance === undefined ? undefined : acceptance.slice();
  if (action === "update") {
    return {
      action,
      objective: params.objective,
      acceptance: validatedAcceptance,
      verificationMode,
    };
  }
  if (params.tokenBudget !== undefined && typeof params.tokenBudget !== "string") return undefined;
  if (params.planHandoffKey !== undefined && typeof params.planHandoffKey !== "string") return undefined;
  return {
    action,
    objective: params.objective,
    tokenBudget: params.tokenBudget,
    planHandoffKey: params.planHandoffKey,
    acceptance: validatedAcceptance,
    verificationMode,
  };
}

let completionPort: GoalCompletionPort;

export function connectGoalCommands(port: GoalCompletionPort): void { completionPort = port; }

function sourceUnavailable(ctx: GoalContext): {text: string; isError: true; details: {classification: "infrastructure-error"}} {
  const text = "Goal completion was not verified: source-unavailable. Session history could not be read; restore access before retrying.";
  ctx.ui.setStatus(STATUS_KEY, "source-unavailable");
  ctx.ui.notify(text, "warning");
  return {text, isError: true, details: {classification: "infrastructure-error"}};
}
