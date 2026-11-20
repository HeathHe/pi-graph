import { readGoalBudgetView } from "./state.ts";
import { budgetCanContinue } from "./budget-view.ts";
import { isWorkflowContinuationMarker } from "./state.ts";
/** Goal continuation owner. */
import { updateStatusLine, fmtBudget, buildGoalPrompt, buildResumePrompt, buildContinuePrompt } from "./presentation.ts";
import { CONTINUATION_MARKER_PREFIX, type GoalContext, type ActiveGoal, type GoalFinalReplyPort } from "./types.ts";
import { goalState, updateUsage, persistGoal, clearRecovery, activateResumedGoal, loadGoalFromSession, clearRecoveryFor, pauseGoal, increment, cancelContinuation } from "./state.ts";
import { captureGoalSource, withGoalSource, guardGoalAwait } from "./source.ts";
import { captureTodoSourceExecution, withTodoSourceExecution, isGoalPlanExecutionHeld } from "../task-workflow/commands.ts";
import { hasMatchingWorkflowBinding, isOverflow, type AssistantMessageLike, isRetryableGoalFailure, type AgentStopReason } from "../tools/goal-verification.ts";
import { hasPending, goalClock, postGoalMessage, abortTurn } from "./host.ts";
import { type BeforeAgentStartInput, normalizeBeforeAgentStartInput } from "../before-agent-start.ts";
import { snapshotModelFailoverSettlement, consumeModelFailoverSettlement, type ModelFailoverSettlementSnapshot } from "../providers/model-failover.ts";

export const LOW_PROGRESS_TOKEN_DELTA = 500;

export const MAX_LOW_PROGRESS_CONTINUATIONS = 3;

export const MARKER_RE = new RegExp(
  `<!--\\s*${CONTINUATION_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\s>]+)\\s*-->`,
);

export function onBeforeCompact(ctx: GoalContext) {
  if (!goalState.activeGoal || goalState.activeGoal.status !== "active" || isGoalPlanExecutionHeld(goalState.activeGoal.id)) return;
  const compactingGoal = { ...goalState.activeGoal };
  updateUsage(compactingGoal, ctx);
  goalState.setSuspendedContinuation(goalState.continuationPending ? { ...goalState.continuationPending } : undefined);
  goalState.setCompactionInFlight(true);
  persistGoal(compactingGoal);
  updateStatusLine(ctx, compactingGoal);
}

export function onCompactionCancelled(ctx?: GoalContext) {
  goalState.setCompactionInFlight(false);
  const displayCtx = ctx ?? goalState.goalDisplayContext;
  const suspended = goalState.suspendedContinuation;
  goalState.setSuspendedContinuation(undefined);
  if (suspended && !goalState.continuationPending && goalState.activeGoal?.id === suspended.goalId) {
    goalState.setContinuationPending(suspended);
    if (!isWorkflowContinuationMarker(suspended.marker)) goalState.issueMarker(suspended.marker);
  }
  if (goalState.activeGoal?.status === "active" && displayCtx) {
    persistGoal(goalState.activeGoal);
    updateStatusLine(displayCtx, goalState.activeGoal);
  }
}

export async function onCompact(
  event: unknown,
  ctx: GoalContext,
  options: { deferContinuation?: boolean } = {},
) {
  const goalScope = captureGoalSource(ctx);
  const sourceExecution = captureTodoSourceExecution(ctx as never);
  return withGoalSource(goalScope, () => withTodoSourceExecution(sourceExecution, async () => {
  const compactionRan = goalState.compactionInFlight;
  goalState.setCompactionInFlight(false);
  goalState.setSuspendedContinuation(undefined);
  if (!goalState.activeGoal || goalState.activeGoal.status !== "active") {
    if (
      compactionRan
      && goalState.activeGoal?.status === "paused"
      && goalState.activeGoal.pauseReason === undefined
    ) {
      // Compaction preempted this Goal's in-flight continuation turn, so
      // pauseAfterEnd paused it with no pauseReason (interruption). The user
      // did not cancel (that path ends in onCompactionCancelled), so compaction
      // completion auto-resumes instead of stranding the Goal paused.
      clearRecovery();
      const resumedGoal = activateResumedGoal(goalState.activeGoal);
      persistGoal(resumedGoal);
      updateStatusLine(ctx, resumedGoal);
      ctx.ui.notify(`Goal auto-resumed after compaction: ${resumedGoal.text}`, "info");
      // Re-send the continuation now: the follow-up triggers a fresh turn
      // against the compacted context. deferContinuation only coordinates
      // provider-pressure failover, which never leaves a Goal in this state.
      const sent = await guardGoalAwait(sendContinuation(ctx, resumedGoal));
      if (!sent && ctx.isIdle?.() !== true) armGoalLoop(resumedGoal);
      return;
    }
    clearRecovery();
    return;
  }
  const restored = loadGoalFromSession(ctx, goalState.goalSessionId);
  const compactedGoal = restored?.id === goalState.activeGoal.id ? { ...restored } : { ...goalState.activeGoal };
  updateUsage(compactedGoal, ctx);
  persistGoal(compactedGoal);
  updateStatusLine(ctx, compactedGoal);

  const wasPiRetry = isPiRetry(event, goalState.activeGoal.id);
  const attemptAwaitingSettlement = hasUnsettledAttempt(goalState.activeGoal.id);
  if (!wasPiRetry && !attemptAwaitingSettlement) clearRecoveryFor(goalState.activeGoal.id);
  const coordinator = goalState.workflowCoordinator;
  const workflowSnapshot = coordinator?.status();
  if (
    coordinator
    &&
    hasMatchingWorkflowBinding(goalState.activeGoal, workflowSnapshot)
    && workflowSnapshot?.session?.activeRunId
  ) {
    try {
      await guardGoalAwait(coordinator.brief());
    } catch (error) {
      const paused = pauseGoal(goalState.activeGoal, "gate");
      persistGoal(paused);
      updateStatusLine(ctx, paused);
      ctx.ui.notify(`Goal paused because active Run brief recovery failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return;
    }
  }
  if (wasPiRetry || attemptAwaitingSettlement || hasPending(ctx) || options.deferContinuation) return;
  await guardGoalAwait(sendContinuation(ctx, goalState.activeGoal));

  }));
}

export function onInput(event: { source?: string; text?: string }) {
  if (event.source === "extension") {
    if (rejectContinuationReplay(event.text ?? "")) return { action: "handled" as const };
    return;
  }
  clearRecovery();
}

export function onBeforeAgentStart(event: BeforeAgentStartInput) {
  const input = normalizeBeforeAgentStartInput(event);
  if (input.messageType === "user") markDelivered(input.text);
}

export async function onAgentEnd(event: { messages: unknown[] }, ctx: GoalContext) {
  const goalScope = captureGoalSource(ctx);
  const sourceExecution = captureTodoSourceExecution(ctx as never);
  return withGoalSource(goalScope, () => withTodoSourceExecution(sourceExecution, async () => {
  if (!goalState.activeGoal || goalState.activeGoal.status !== "active" || isGoalPlanExecutionHeld(goalState.activeGoal.id)) return;
  if (goalState.activeGoal.delivery?.phase === "awaiting-reply") {
    await finalReplyPort.commitFinalMainReply(ctx, goalScope); return;
  }
  if (goalState.goalLoopOwner?.goalId !== goalState.activeGoal.id || goalState.goalLoopOwner.epoch !== goalState.goalLifecycleEpoch) return;

  const goalId = goalState.activeGoal.id;
  const finalMsg = findFinalAssistant(event.messages);
  goalState.setLatestGoalAttempt({
    goalId,
    epoch: goalState.goalLifecycleEpoch,
    ...(finalMsg ? { assistant: finalMsg } : {}),
  });

  if (finalMsg && (finalMsg.stopReason === "aborted" || finalMsg.stopReason === "error") && isRetryable(finalMsg)) {
    markGoalRecovery(goalId, isOverflow(finalMsg) ? "compaction_retry" : "provider_retry");
  } else {
    clearRecoveryFor(goalId);
  }
  updateStatusLine(ctx, goalState.activeGoal);

  }));
}

export function onProviderPressureSettled(ctx: GoalContext) {
  const arbitrationSnapshot = snapshotModelFailoverSettlement();
  if (arbitrationSnapshot) consumeModelFailoverSettlement(arbitrationSnapshot.recoveryId);
  goalState.setLatestGoalAttempt(undefined);
  if (!goalState.activeGoal || goalState.activeGoal.status !== "active" || isGoalPlanExecutionHeld(goalState.activeGoal.id)) return;
  clearRecoveryFor(goalState.activeGoal.id);
  updateStatusLine(ctx, goalState.activeGoal);
}

export async function onAgentSettled(
  ctx: GoalContext,
  options: { suppressContinuation?: boolean } = {},
) {
  const goalScope = captureGoalSource(ctx);
  const sourceExecution = captureTodoSourceExecution(ctx as never);
  return withGoalSource(goalScope, () => withTodoSourceExecution(sourceExecution, async () => {
  if (!goalState.activeGoal || goalState.activeGoal.status !== "active" || isGoalPlanExecutionHeld(goalState.activeGoal.id)) return;
  if (goalState.activeGoal.delivery?.phase === "awaiting-reply") return;
  if (goalState.goalLoopOwner?.goalId !== goalState.activeGoal.id || goalState.goalLoopOwner.epoch !== goalState.goalLifecycleEpoch) return;

  const goalId = goalState.activeGoal.id;
  const arbitrationSnapshot = snapshotModelFailoverSettlement();
  const capturedObservation = goalState.latestGoalAttempt;
  const observationMissing = !capturedObservation
    || capturedObservation.goalId !== goalId
    || capturedObservation.epoch !== goalState.goalLifecycleEpoch;
  const arbitration = arbitrationSnapshot
    ? consumeModelFailoverSettlement(arbitrationSnapshot.recoveryId)
    : undefined;
  if (arbitrationSnapshot && !arbitration) return;
  if (observationMissing) {
    // A stale arbitration snapshot (for example failover fired during a
    // non-Goal turn) was consumed above. It has no attempt correlation, so it
    // must never drive this Goal's outcome; ignore it and keep the Goal as-is.
    return;
  }
  goalState.setLatestGoalAttempt(undefined);

  if (arbitration?.outcome === "fallback-scheduled") {
    markGoalRecovery(goalId, "provider_retry");
    updateStatusLine(ctx, goalState.activeGoal);
    return;
  }

  const observation = observationMissing
    ? {
        goalId,
        epoch: goalState.goalLifecycleEpoch,
        assistant: {
          role: "assistant" as const,
          stopReason: arbitration?.outcome === "cancelled" ? "aborted" : "error",
          errorMessage: arbitration?.failure ?? "Agent settled without a Goal attempt observation",
        },
      }
    : capturedObservation;
  const observedFailure = observation.assistant?.stopReason === "aborted"
    || observation.assistant?.stopReason === "error";
  const outcome = observationMissing ? "failed" : arbitration?.outcome ?? (observedFailure ? "failed" : "success");
  if (outcome !== "success") {
    clearRecoveryFor(goalId);
    goalState.setGoalLoopOwner(undefined);
    const cancelled = outcome === "cancelled" || observation.assistant?.stopReason === "aborted";
    pauseAfterEnd(ctx, goalState.activeGoal, cancelled
      ? { role: "assistant", stopReason: "aborted" }
      : {
          role: "assistant",
          stopReason: "error",
          errorMessage: arbitration?.failure
            ?? (outcome === "replay-blocked" ? arbitration?.replayFence.blockedReason : undefined)
            ?? observation.assistant?.errorMessage,
        });
    return;
  }

  clearRecoveryFor(goalId);
  const hadPending = goalState.continuationPending?.goalId === goalId;
  const settledGoal = hadPending ? { ...goalState.activeGoal } : increment(goalState.activeGoal);
  updateUsage(settledGoal, ctx);

  if (settledGoal.tokenBudget !== undefined) {
    const view = readGoalBudgetView(settledGoal.id, ctx);
    if (!budgetCanContinue(view)) {
      goalState.setGoalLoopOwner(undefined); cancelContinuation();
      const next = view.admission === "waiting" ? settledGoal : pauseGoal(settledGoal, view.admission === "exhausted" ? "budget" : "gate");
      persistGoal(next); updateStatusLine(ctx, next); ctx.ui.notify(view.text, "warning"); return;
    }
  }

  persistGoal(settledGoal);
  updateStatusLine(ctx, settledGoal);

  if (hadPending) {
    if (hasPending(ctx)) return;
    if (goalState.continuationPending?.goalId === goalId) goalState.setContinuationPending(undefined);
  }

  if (!goalState.activeGoal || goalState.activeGoal.id !== goalId || goalState.activeGoal.status !== "active") return;
  if (options.suppressContinuation || hasPending(ctx)) return;

  const progressView = goalState.activeGoal.tokenBudget === undefined ? undefined : readGoalBudgetView(goalState.activeGoal.id, ctx);
  const measured = progressView?.kind === "ledger" && progressView.knownConsumed !== undefined ? BigInt(progressView.knownConsumed) : undefined;
  const cursor = goalState.activeGoal.budgetProgressCursor;
  const previous = typeof cursor === "string" && /^(0|[1-9][0-9]{0,31})$/.test(cursor) ? cursor : undefined;
  const low = progressView ? measured !== undefined && previous !== undefined && measured - BigInt(previous) < BigInt(LOW_PROGRESS_TOKEN_DELTA)
    : goalState.activeGoal.tokensUsed - (goalState.activeGoal.prevTokensUsed ?? 0) < LOW_PROGRESS_TOKEN_DELTA;
  const lowProgressCount = low ? (goalState.activeGoal.lowProgressCount ?? 0) + 1 : 0;
  if (lowProgressCount >= MAX_LOW_PROGRESS_CONTINUATIONS) {
    goalState.setGoalLoopOwner(undefined);
    cancelContinuation();
    const paused = pauseGoal(goalState.activeGoal, "stalled");
    persistGoal(paused);
    updateStatusLine(ctx, paused);
    ctx.ui.notify(`Goal paused: ${MAX_LOW_PROGRESS_CONTINUATIONS} consecutive continuations with minimal progress (<${LOW_PROGRESS_TOKEN_DELTA} tokens each). Use /goal resume to retry.`, "warning");
    return;
  }
  const continuationGoal = { ...goalState.activeGoal, prevTokensUsed: goalState.activeGoal.tokensUsed, ...(measured === undefined ? {} : { budgetProgressCursor: String(measured) }), lowProgressCount };
  persistGoal(continuationGoal);

  await guardGoalAwait(sendContinuation(ctx, continuationGoal));

  }));
}

export async function sendGoalPrompt(ctx: GoalContext, goal: ActiveGoal) {
  return sendHandoffPrompt(ctx, goal, buildGoalPrompt(goal));
}

export async function sendResumePrompt(ctx: GoalContext, goal: ActiveGoal) {
  return sendHandoffPrompt(ctx, goal, buildResumePrompt(goal));
}

export async function sendHandoffPrompt(ctx: GoalContext, goal: ActiveGoal, prompt: string): Promise<boolean> {
  if (isGoalPlanExecutionHeld(goal.id)) return false;
  // An LLM tool call already carries its result in the current turn. Queuing the
  // same handoff as a follow-up leaves a stale editable user message that can
  // surface much later (for example, while explicit completion verification runs).
  if (ctx.isIdle?.() !== true) return false;
  armGoalLoop(goal);
  const sent = await guardGoalAwait(sendPrompt(ctx, prompt));
  if (!sent) disarmGoalLoop(goal.id);
  return sent;
}

export async function sendContinuation(ctx: GoalContext, goal: ActiveGoal) {
  if (isGoalPlanExecutionHeld(goal.id)) return false;
  if (goalState.continuationPending?.goalId === goal.id) return false;
  if (hasPending(ctx)) return false;
  let marker = `${goal.id}:${goal.iteration}:${goalClock.newId()}`;
  let genericMarker = true;
  const coordinator = goalState.workflowCoordinator;
  const workflowSnapshot = coordinator?.status();
  if (coordinator && hasMatchingWorkflowBinding(goal, workflowSnapshot)) {
    try {
      marker = coordinator.continuationMarker(goal.iteration);
      genericMarker = false;
    } catch (error) {
      const paused = pauseGoal(goal, "gate");
      persistGoal(paused);
      updateStatusLine(ctx, paused);
      ctx.ui.notify(`Goal paused by Workflow Coordinator: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    }
  }
  if (genericMarker) goalState.issueMarker(marker);
  goalState.setContinuationPending({ goalId: goal.id, iteration: goal.iteration, marker });
  if (!genericMarker && (!goalState.workflowCoordinator || !goalState.workflowCoordinator.acceptsContinuation(marker))) {
    if (goalState.continuationPending?.marker === marker) goalState.setContinuationPending(undefined);
    const paused = pauseGoal(goal, "gate");
    persistGoal(paused);
    updateStatusLine(ctx, paused);
    ctx.ui.notify("Goal continuation was fenced by the Workflow Coordinator.", "warning");
    return false;
  }
  armGoalLoop(goal);
  const sent = await guardGoalAwait(sendPrompt(ctx, buildContinuePrompt(goal, marker, workflowSnapshot)));
  if (!sent) {
    disarmGoalLoop(goal.id);
    goalState.consumeMarker(marker);
    if (goalState.continuationPending?.marker === marker) goalState.setContinuationPending(undefined);
    const paused = pauseGoal(goal);
    persistGoal(paused);
    updateStatusLine(ctx, paused);
  }
  if (goalState.activeGoal?.id === goal.id && goalState.activeGoal.status === "active") updateStatusLine(ctx, goalState.activeGoal);
  return sent;
}

export function armGoalLoop(goal: ActiveGoal): void {
  if (isGoalPlanExecutionHeld(goal.id)) return;
  goalState.setGoalLoopOwner({ goalId: goal.id, epoch: goalState.goalLifecycleEpoch });
}

export function disarmGoalLoop(goalId: string): void {
  if (goalState.goalLoopOwner?.goalId === goalId) goalState.setGoalLoopOwner(undefined);
}

export async function sendPrompt(ctx: GoalContext, prompt: string): Promise<boolean> {
  if (goalState.activeGoal && isGoalPlanExecutionHeld(goalState.activeGoal.id)) return false;
  try {
    if (!postGoalMessage(goalState.extensionApi, prompt)) return false;
    markDelivered(prompt);
    return true;
  } catch (error) {
    ctx.ui.notify(`Goal prompt failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  }
}

export function rejectContinuationReplay(text: string): boolean {
  const marker = MARKER_RE.exec(text)?.[1];
  if (!marker) return false;
  if (isWorkflowContinuationMarker(marker)) {
    return !goalState.workflowCoordinator || !goalState.workflowCoordinator.acceptsContinuation(marker);
  }
  return !goalState.consumeMarker(marker);
}

export function markDelivered(prompt: string) {
  const marker = MARKER_RE.exec(prompt)?.[1];
  if (!marker) return;
  if (!isWorkflowContinuationMarker(marker)) goalState.consumeMarker(marker);
  if (goalState.continuationPending?.marker === marker) goalState.setContinuationPending(undefined);
  if (goalState.suspendedContinuation?.marker === marker) goalState.setSuspendedContinuation(undefined);
}



export function pauseAfterEnd(ctx: GoalContext, goal: ActiveGoal, assistant: AssistantMessageLike) {
  goalState.setGoalLoopOwner(undefined);
  goalState.setLatestGoalAttempt(undefined);
  cancelContinuation();
  abortTurn(ctx);
  const paused = pauseGoal(goal);
  persistGoal(paused);
  updateStatusLine(ctx, paused);
  const reason = assistant.stopReason === "aborted" ? "interruption" : "agent error";
  const details = assistant.errorMessage ? ` (${assistant.errorMessage.slice(0, 157)})` : "";
  ctx.ui.notify(`Goal paused after ${reason}${details}. Use /goal resume to continue.`, "warning");
}

export function isRetryable(a: AssistantMessageLike): boolean {
  return isRetryableGoalFailure(a);
}

export function isPiRetry(event: unknown, goalId: string): boolean {
  const e = event as { willRetry?: unknown; reason?: unknown };
  if (e.willRetry === true) return true;
  return goalState.goalRecovery?.goalId === goalId && goalState.goalRecovery.kind === "compaction_retry"
    && (e.reason === undefined || e.reason === "overflow");
}

export function markGoalRecovery(goalId: string, kind: "compaction_retry" | "provider_retry"): void {
  goalState.setGoalRecovery({ goalId, kind });
}

export function onFailoverTerminal(data: unknown): void {
  const ctx = goalState.goalDisplayContext;
  if (!goalState.activeGoal || goalState.activeGoal.status !== "active" || !ctx) return;
  const snapshot = data as ModelFailoverSettlementSnapshot | undefined;
  const failure = snapshot?.failure ?? "Model fallback could not start.";
  clearRecoveryFor(goalState.activeGoal.id);
  goalState.setGoalLoopOwner(undefined);
  goalState.setLatestGoalAttempt(undefined);
  cancelContinuation();
  const paused = pauseGoal(goalState.activeGoal);
  persistGoal(paused);
  updateStatusLine(ctx, paused);
  ctx.ui.notify(`Goal paused: ${failure}`, "warning");
}

export function hasUnsettledAttempt(goalId: string): boolean {
  return goalState.latestGoalAttempt?.goalId === goalId && goalState.latestGoalAttempt.epoch === goalState.goalLifecycleEpoch;
}

export async function fenceWorkflowContinuation(): Promise<void> {
  const coordinator = goalState.workflowCoordinator;
  const workflowSnapshot = coordinator?.status();
  if (!coordinator || !goalState.activeGoal || !hasMatchingWorkflowBinding(goalState.activeGoal, workflowSnapshot)) return;
  try { await guardGoalAwait(coordinator.fenceContinuation()); } catch { /* no owned lease means no live marker can be accepted */ }
}

export function findFinalAssistant(messages: unknown[]): AssistantMessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const entry = m as Record<string, unknown>;
    const c = entry.message && typeof entry.message === "object"
      ? entry.message as Record<string, unknown>
      : entry;
    if (c.role !== "assistant") continue;
    return {
      role: "assistant",
      stopReason: isStopReason(c.stopReason) ? c.stopReason : undefined,
      errorMessage: typeof c.errorMessage === "string" ? c.errorMessage : undefined,
      content: c.content,
      usage: c.usage as { input?: number; output?: number } | undefined,
    };
  }
  return undefined;
}

export function isStopReason(v: unknown): v is AgentStopReason {
  return ["stop", "length", "toolUse", "error", "aborted"].includes(String(v));
}

let finalReplyPort: GoalFinalReplyPort;

export function connectGoalContinuation(port: GoalFinalReplyPort): void { finalReplyPort = port; }
