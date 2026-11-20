/** Goal presentation owner. */
import { goalState, clearCompletionTimer, clearElapsedTimer, GOAL_STATE_VERSION, getGoalList, isSupersededWorkflowProjection, goalBudgetView, refreshGoalBudgetView } from "./state.ts";
import { CONTINUATION_MARKER_PREFIX, type GoalContext, type ActiveGoal, type GoalCompactionSnapshot } from "./types.ts";
import { type WorkflowSnapshot, activeWorkflowRun } from "../session/types.ts";
import { hasMatchingWorkflowBinding, redactAcceptanceCommandForDisplay } from "../tools/goal-verification.ts";
import { type GoalWidgetPhase, renderGoalPanel, type GoalDetailEntry } from "../tui/goal-widget.ts";
import { goalClock, currentSessionId, getVisibleTasks, getDeliveryGroups } from "./host.ts";
import { captureGoalSourceContinuity, captureGoalSource, subscribeGoalSource } from "./source.ts";
import { goalContractDigest, taskGroupDigest } from "./delivery.ts";
import { digest, assertIssuedMaterialReview, subscribeMaterialReviewInvalidation } from "../verification/material-review.ts";
import { captureTodoSourceScope, assertTodoSourceScope, subscribeTodoSourceInvalidation } from "pi-maestro-teammate/v1/todo-context";
function displayTodoScope(ctx: GoalContext) {
 const sessionId = currentSessionId(ctx), manager = ctx.sessionManager;
 if (!sessionId || !manager || typeof manager !== "object") return undefined;
 return captureTodoSourceScope({cwd:ctx.cwd,sessionId,manager});
}
import { canonicalCompletionBlockers } from "../tools/goal-verification.ts";
import type { MaestroCurrentDisplayV1, MaestroDeliveredDisplayV1 } from "pi-cockpit/v1/events";

let displayContext: GoalContext | undefined;
let displayTimer: ReturnType<typeof goalClock.setTimeout> | undefined;
let displayToken: object = {};
let disposeDisplaySource: (() => void) | undefined;
let disposeDisplayTodo: (() => void) | undefined;
let disposeDisplayMaterial: (() => void) | undefined;
let displaySnapshot: MaestroCurrentDisplayV1 | undefined;
const displayListeners = new Set<() => void>();
// A live delivery can pin the observed original workflow revision. It is not persisted or reconstructed from counts.
const revokedDisplayReceipts = new Set<string>();
const seenWorkflowReceipts = new Set<string>();
const displayWorkflowPins = new Map<string, {fingerprint:string; generation:string; epoch:number}>();
export function subscribeGoalCurrentDisplay(listener: () => void): () => void {
  displayListeners.add(listener); return () => { displayListeners.delete(listener); };
}
export function resetGoalCurrentDisplay(): void {
  displayToken = {}; if (displayTimer) goalClock.clearTimeout(displayTimer);
  displayTimer = undefined; disposeDisplaySource?.(); disposeDisplaySource = undefined;
  disposeDisplayTodo?.(); disposeDisplayTodo = undefined; disposeDisplayMaterial?.(); disposeDisplayMaterial = undefined;
  displayContext = undefined; displaySnapshot = undefined; displayWorkflowPins.clear(); revokedDisplayReceipts.clear(); seenWorkflowReceipts.clear();
}
export function bindGoalCurrentDisplay(ctx: GoalContext): void {
  resetGoalCurrentDisplay(); displayContext = ctx;
  try {
    disposeDisplaySource = subscribeGoalSource(captureGoalSource(ctx), refreshGoalCurrentDisplay);
    const todoScope = displayTodoScope(ctx);
    if (todoScope) disposeDisplayTodo = subscribeTodoSourceInvalidation(todoScope, refreshGoalCurrentDisplay);
  }
  catch { /* Unknown source retains all rows. */ }
  disposeDisplayMaterial = subscribeMaterialReviewInvalidation(refreshGoalCurrentDisplay);
  refreshGoalCurrentDisplay();
  const verified = displaySnapshot?.deliveries.find(d => d.phase === "verified");
  const goal = verified && getGoalList().find(g => g.id === verified.goalId);
  if (goal && !goalState.activeGoal) { ctx.ui.setStatus(STATUS_KEY,"done"); updateGoalWidget(ctx,goal,"verified"); }
}
/** Synchronous facts only; material validity remains the original verification owner. */
function observeDeliveredDisplay(ctx: GoalContext): MaestroCurrentDisplayV1 | undefined {
  try {
    const continuity = captureGoalSourceContinuity(ctx), todoScope = displayTodoScope(ctx);
    if (!todoScope) return undefined;
    assertTodoSourceScope(todoScope);
    const manager = ctx.sessionManager as { getSessionId?: () => string; getLeafId?: () => string | null; getBranch?: () => Array<{id?:string;type?:string;message?:{role?:string;stopReason?:string;content?:unknown}}> } | undefined;
    const sessionId = manager?.getSessionId?.(), branch = manager?.getBranch?.();
    const anchor = manager?.getLeafId?.() ?? branch?.at(-1)?.id;
    if (!sessionId || !anchor || !branch?.some(entry => entry.id === anchor)) return undefined;
    const tasks = getVisibleTasks(), groups = getDeliveryGroups(), deliveries: MaestroDeliveredDisplayV1[] = [];
    for (const goal of getGoalList()) {
      const d = goal.delivery, r = d?.receipt;
      if (goal.status !== "done" || d?.phase !== "delivered" || !r || revokedDisplayReceipts.has(r.entryId)
        || d.contractDigest !== goalContractDigest(goal) || d.groupDigest !== taskGroupDigest(goal, groups, tasks)
        || r.contractDigest !== d.contractDigest || r.groupDigest !== d.groupDigest
        || r.ownerEpoch !== d.ownerEpoch || r.ownerInstanceId !== d.ownerInstanceId
        || digest(r.source) !== digest(d.source) || d.source.cwd !== ctx.cwd || d.source.sessionId !== sessionId
        || !branch.some(entry => entry.id === d.source.branchAnchor)
        || !Number.isFinite(goal.updatedAt) || goal.updatedAt < 0
        || (goal.verdictDigest !== undefined && goal.verdictDigest !== d.verdictDigest)
        || digest(goal.businessReview) !== digest(d.materialReview)) continue;
      // Existing owner's in-memory issuance check only: never issue/recheck material or read files here.
      if (goal.businessReview) { try { assertIssuedMaterialReview(goal.businessReview); } catch { continue; } }
      const message = branch.find(entry => entry.id === r.entryId)?.message;
      if (message?.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)
        || message.content.some(item => !item || typeof item !== "object" || !["text","thinking"].includes(String(item.type)))) continue;
      const text = message.content.map(item => item.text).filter((item): item is string => typeof item === "string").join("\n").trim();
      if (!text || digest(text) !== r.textDigest) continue;
      const members = tasks.filter(task => task.deliveryGoalId === goal.id && !task.supersessionId);
      if (members.some(task => task.status !== "completed" || task.reviewRequired || task.replacementPendingId
        || !task.taskInstanceId || !Number.isInteger(task.contractVersion) || !task.contractDigest || !task.deliveryGroupId)) continue;
      const visibleUntil = goal.updatedAt + 8_000;
      const entry: MaestroDeliveredDisplayV1 = {
        goalId: goal.id, receiptEntryId: r.entryId, contractDigest: d.contractDigest, groupDigest: d.groupDigest,
        deliveredAt: goal.updatedAt, visibleUntil, phase: goalClock.now() < visibleUntil ? "verified" : "settled",
        tasks: members.map(task => ({id:task.id,taskInstanceId:task.taskInstanceId!,contractVersion:task.contractVersion!,contractDigest:task.contractDigest!,qualificationDigest:digest([task.acceptanceReport,task.skipResolution]),goalId:goal.id,groupId:task.deliveryGroupId!})),
      };
      const workflow = goalState.workflowCoordinator?.status();
      const workflowPin = displayWorkflowPins.get(r.entryId);
      if (goal.workflowSessionId && workflowPin && workflowPin.epoch === goalState.goalLifecycleEpoch
        && workflowPin.fingerprint === workflow?.revision.fingerprint && workflowPin.generation === workflow?.sessionGeneration
        && hasMatchingWorkflowBinding(goal, workflow) && canonicalCompletionBlockers(workflow).length === 0) entry.workflowSessionId = goal.workflowSessionId;
      deliveries.push(entry);
    }
    assertTodoSourceScope(todoScope); continuity.assertCurrent();
    if (manager?.getSessionId?.() !== sessionId || (manager?.getLeafId?.() ?? manager?.getBranch?.().at(-1)?.id) !== anchor) return undefined;
    return {version:1,source:{cwd:ctx.cwd,sessionId,branchAnchor:anchor},deliveries};
  } catch { return undefined; }
}
export function readGoalCurrentDisplay(): MaestroCurrentDisplayV1 | undefined {
  return displayContext ? observeDeliveredDisplay(displayContext) : undefined;
}
/** Original Flow widget consumes the same exact task pins; history and GUI data stay whole. */
export function currentGoalTasks<T extends {id:string;status:string;taskInstanceId?:string;contractVersion?:number;contractDigest?:string;deliveryGoalId?:string;deliveryGroupId?:string;acceptanceReport?:unknown;skipResolution?:unknown;reviewRequired?:boolean;replacementPendingId?:string;supersessionId?:string}>(tasks: readonly T[], ctx: GoalContext): T[] {
  if (!displayContext || ctx.sessionManager !== displayContext.sessionManager || ctx.cwd !== displayContext.cwd) return [...tasks];
  const display = readGoalCurrentDisplay();
  return tasks.filter(task => task.status !== "completed" || task.reviewRequired || task.replacementPendingId || task.supersessionId
    || !display?.deliveries.some(d => d.phase === "settled" && d.tasks.some(pin => pin.id === task.id
      && pin.taskInstanceId === task.taskInstanceId && pin.contractVersion === task.contractVersion && pin.contractDigest === task.contractDigest
      && pin.goalId === task.deliveryGoalId && pin.groupId === task.deliveryGroupId && pin.qualificationDigest === digest([task.acceptanceReport,task.skipResolution]))));
}
export function refreshGoalCurrentDisplay(): void {
  let next = readGoalCurrentDisplay();
  for (const old of displaySnapshot?.deliveries ?? []) {
    if (!next?.deliveries.some(d => d.receiptEntryId === old.receiptEntryId && d.contractDigest === old.contractDigest && d.groupDigest === old.groupDigest && d.deliveredAt === old.deliveredAt)) revokedDisplayReceipts.add(old.receiptEntryId);
  }
  if (next) next = {...next,deliveries:next.deliveries.filter(d => !revokedDisplayReceipts.has(d.receiptEntryId))};
  const workflow = goalState.workflowCoordinator?.status();
  for (const [id,pin] of displayWorkflowPins) if (pin.epoch !== goalState.goalLifecycleEpoch || pin.fingerprint !== workflow?.revision.fingerprint || pin.generation !== workflow?.sessionGeneration) displayWorkflowPins.delete(id);
  const changed = JSON.stringify(next) !== JSON.stringify(displaySnapshot);
  displaySnapshot = next; displayToken = {}; const token = displayToken;
  if (displayTimer) goalClock.clearTimeout(displayTimer); displayTimer = undefined;
  const deadlines = next?.deliveries.filter(d => d.phase === "verified").map(d => d.visibleUntil) ?? [];
  if (deadlines.length) displayTimer = goalClock.setTimeout(() => {
    if (token !== displayToken) return;
    displayTimer = undefined; refreshGoalCurrentDisplay();
    // Never erase a newer Goal or an unknown source. No notifications or model continuation.
    const ctx = displayContext, current = goalState.activeGoal;
    if (ctx && displaySnapshot && !current && !displaySnapshot.deliveries.some(d => d.phase === "verified")) {
      const unsettled = getGoalPanelEntries().some(g => !displaySnapshot!.deliveries.some(d => d.goalId === g.id && d.phase === "settled"));
      if (!unsettled) clearGoalDisplay(ctx);
    }
  }, Math.max(0, Math.min(...deadlines) - goalClock.now()));
  if (changed) for (const listener of [...displayListeners]) listener();
}

export const STATUS_KEY = "goal";

export const GOAL_WIDGET_KEY = "goal-panel";

export function setGoalStaticMode(staticMode: boolean): void {
  if (goalState.goalStaticMode === staticMode) return;
  goalState.setGoalStaticMode(staticMode);
  const ctx = goalState.goalDisplayContext;
  const goal = goalState.activeGoal;
  if (!ctx || !goal || goal.status !== "active") return;
  // Repaint now so the panel hides (or restores) the elapsed immediately
  // instead of waiting for the next state change or per-second tick.
  updateStatusLine(ctx, goal);
}

export function setGoalPanelOwnership(ownedExternally: boolean, ctx?: GoalContext): void {
  if (ctx) goalState.setGoalDisplayContext(ctx);
  goalState.setGoalPanelOwnedExternally(ownedExternally);
  const displayCtx = ctx ?? goalState.goalDisplayContext;
  if (!displayCtx) return;
  if (ownedExternally || !goalState.activeGoal) {
    displayCtx.ui.setWidget?.(GOAL_WIDGET_KEY, undefined, { placement: "belowEditor" });
    return;
  }
  updateGoalWidget(displayCtx, goalState.activeGoal, currentGoalPhase());
}

export function buildGoalPrompt(goal: ActiveGoal): string {
  const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${fmtTokens(goal.tokenBudget)}.`;
  return `Goal mode is active. Complete this goal fully:\n\n${goalBlock(goal)}${budgetLine}\n\n${rules("this goal")}`;
}

export function buildResumePrompt(goal: ActiveGoal): string {
  const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${fmtBudget(goal)}.`;
  return `The goal was resumed. Continue:\n\n${goalBlock(goal)}${budgetLine}\n\n${rules("this goal")}`;
}

export function buildContinuePrompt(
  goal: ActiveGoal,
  marker: string,
  workflowSnapshot: WorkflowSnapshot | undefined,
): string {
  const activeRun = workflowSnapshot && hasMatchingWorkflowBinding(goal, workflowSnapshot)
    ? activeWorkflowRun(workflowSnapshot)
    : undefined;
  const runAnchor = activeRun
    ? `\n\n<active_run id="${escapeXml(activeRun.runId)}">Run \`maestro run brief ${activeRun.runId}\` before the next execution action.</active_run>`
    : "";
  const failureContext = goal.lastVerificationFailure
    ? `\n\n<last_verification_failure>\n${escapeXml(goal.lastVerificationFailure)}\n</last_verification_failure>`
    : "";
  const progress = goal.tokenBudget !== undefined
    ? ` Progress: ${fmtBudget(goal)}, iteration #${goal.iteration}.`
    : ` Iteration #${goal.iteration}, ${fmtTokens(goal.tokensUsed)} parent-session tokens observed.`;
  return `Continue the active goal — keep working, do not summarize or re-plan:\n\n${goalBlock(goal)}${failureContext}${runAnchor}\n\n${progress} ${rules("this goal")}\n\n${markerComment(marker)}`;
}

export function goalBlock(goal: ActiveGoal): string {
  return `<goal_objective>\n${escapeXml(goal.text)}\n</goal_objective>`;
}

export function rules(label: string): string {
  return `Keep going until ${label} is completely resolved end-to-end. Do not redefine ${label} into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives. If the only remaining gaps require human approval, credentials, or actions outside your control, say so plainly in your next message and pause the gated parts instead of building substitutes around them. Before requesting completion, audit ${label} requirement by requirement, then call goal complete with a concise evidence summary. The host checks current business evidence and owns delivery: parent Goals wait for the actual final main reply; internal quality gates finish independently.`;
}

export function currentGoalPhase(): GoalWidgetPhase {
  const goal = goalState.activeGoal;
  if (!goal) return "normal";
  if (goal.status === "active" && goalState.verificationInFlight?.goalId === goal.id) return "verifying";
  if (goalState.goalRecovery?.goalId === goal.id) {
    return goalState.goalRecovery.attempt !== undefined && goalState.goalRecovery.maxRetries !== undefined
      ? "retrying"
      : "waiting";
  }
  if (goal.status === "active"
    && (goalState.goalLoopOwner?.goalId !== goal.id || goalState.goalLoopOwner.epoch !== goalState.goalLifecycleEpoch)) return "waiting";
  if (goal.status === "active" && goal.tokenBudget !== undefined && goalBudgetView(goal).admission === "waiting") return "waiting";
  return "normal";
}

export function updateStatusLine(ctx: GoalContext, goal: ActiveGoal, refreshOnly = false) {
  if (!refreshOnly && goal.tokenBudget !== undefined) refreshGoalBudgetView(goal.id, ctx);
  clearCompletionTimer();
  if (goal.status === "active" && goal.delivery?.phase !== "awaiting-reply") ensureElapsedTimer(ctx, goal.id);
  else clearElapsedTimer();
  const phase = currentGoalPhase();
  const retry = goalState.goalRecovery?.goalId === goal.id ? goalState.goalRecovery : undefined;
  ctx.ui.setStatus(
    STATUS_KEY,
    goal.delivery?.phase === "awaiting-reply" ? "awaiting final reply" : phase === "verifying"
      ? "verifying"
      : retry
        ? retry.attempt !== undefined && retry.maxRetries !== undefined
          ? `retrying ${retry.attempt}/${retry.maxRetries}`
          : "retrying (Pi-owned)"
        : phase === "waiting"
          ? goal.tokenBudget === undefined ? "waiting" : `waiting ${fmtBudget(goal)}`
          : fmtStatusLine(goal),
  );
  if (refreshOnly) return;
  updateGoalWidget(ctx, goal, phase);
}

export function showCompletionStatus(ctx: GoalContext, goal: ActiveGoal) {
  clearCompletionTimer();
  if (displayContext !== ctx) bindGoalCurrentDisplay(ctx);
  const workflow = goalState.workflowCoordinator?.status();
  if (goal.delivery?.phase === "delivered" && goal.delivery.receipt && goal.workflowSessionId
    && !seenWorkflowReceipts.has(goal.delivery.receipt.entryId)
    && workflow?.sessionGeneration && workflow.revision.fingerprint && hasMatchingWorkflowBinding(goal,workflow)
    && canonicalCompletionBlockers(workflow).length === 0) {
    seenWorkflowReceipts.add(goal.delivery.receipt.entryId);
    displayWorkflowPins.set(goal.delivery.receipt.entryId,{fingerprint:workflow.revision.fingerprint,generation:workflow.sessionGeneration,epoch:goalState.goalLifecycleEpoch});
  }
  refreshGoalCurrentDisplay();
  const observed = readGoalCurrentDisplay()?.deliveries.find(entry => entry.goalId === goal.id);
  if (observed?.phase === "settled") return;
  ctx.ui.setStatus(STATUS_KEY, "done");
  updateGoalWidget(ctx, goal, observed?.phase === "verified" ? "verified" : "normal");
}

export function updateGoalWidget(ctx: GoalContext, goal: ActiveGoal, phase: GoalWidgetPhase): void {
  goalState.setGoalDisplayContext(ctx);
  if (goalState.goalPanelOwnedExternally) return;
  const currentGoalId = goal.id;
  ctx.ui.setWidget?.(GOAL_WIDGET_KEY, (_tui, theme) => ({
    render(width: number): string[] {
      // Read the entries per frame, not once at set-widget time. A snapshot taken here
      // freezes the whole panel — the n/N counter and every other goal's status chip —
      // until some goal mutation happens to re-set the widget. The Goal overlay already
      // reads live (index.ts wires getEntries as a thunk); this makes the belowEditor
      // strip agree with it. `phase` stays captured on purpose: it is the caller's
      // explicit intent for this update (e.g. the transient "verified"), not something
      // derivable from current state.
      const display = readGoalCurrentDisplay();
      const entries = getGoalPanelEntries().filter(entry => !display?.deliveries.some(d => d.goalId === entry.id && d.phase === "settled"));
      if (!entries.some((entry) => entry.id === currentGoalId) && !display?.deliveries.some(d => d.goalId === currentGoalId && d.phase === "settled")) {
        entries.push(toDetailEntry(goal, undefined));
      }
      return renderGoalPanel(entries, currentGoalId, phase, width, theme, { hideLiveDuration: goalState.goalStaticMode });
    },
    invalidate() {},
  }), { placement: "belowEditor" });
}

export function getGoalCompactionSnapshot(): GoalCompactionSnapshot {
  return {
    stateVersion: GOAL_STATE_VERSION,
    ...(goalState.activeGoal ? { currentGoalId: goalState.activeGoal.id } : {}),
    goals: getGoalList().map((goal) => ({
      id: goal.id,
      objective: goal.text,
      status: goal.status,
      ...(goal.pauseReason ? { pauseReason: goal.pauseReason } : {}),
      iteration: goal.iteration,
      tokensUsed: goal.tokensUsed,
      ...(goal.tokenBudget === undefined ? {} : { budgetView: goalBudgetView(goal) }),
      ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
      ...(goal.verificationFailures ? { verificationFailures: goal.verificationFailures } : {}),
      ...(goal.infraErrorStreak ? { infraErrorStreak: goal.infraErrorStreak } : {}),
      ...(goal.failStreak ? { failStreak: goal.failStreak } : {}),
      ...(goal.lastVerificationFailure ? { lastVerificationFailure: goal.lastVerificationFailure } : {}),
      ...(goal.lastVerificationClassification ? { lastVerificationClassification: goal.lastVerificationClassification } : {}),
      ...(goal.lastMissingEvidenceFingerprint ? { lastMissingEvidenceFingerprint: goal.lastMissingEvidenceFingerprint } : {}),
      ...(goal.acceptance?.length ? { acceptance: [...goal.acceptance] } : {}),
      ...(goal.planHandoffKey ? { planHandoffKey: goal.planHandoffKey } : {}),
      ...(goal.workflowSessionId ? { workflowSessionId: goal.workflowSessionId } : {}),
    })),
  };
}

export function getGoalPanelEntries(): GoalDetailEntry[] {
  const todoByGoal = new Map<string, string>();
  for (const task of getVisibleTasks()) {
    if (task.goalId && !todoByGoal.has(task.goalId)) todoByGoal.set(task.goalId, task.subject);
  }
  return getGoalList()
    .filter((entry) => !isSupersededWorkflowProjection(entry))
    .map((entry) => toDetailEntry(entry, todoByGoal.get(entry.id)));
}

export function toDetailEntry(goal: ActiveGoal, todoSubject: string | undefined): GoalDetailEntry {
  return {
    id: goal.id,
    objective: goal.text,
    status: goal.status,
    ...(goal.delivery ? {delivery:{phase:goal.delivery.phase,...(goal.delivery.receipt ? {receiptEntryId:goal.delivery.receipt.entryId} : {}),...(goal.delivery.phase === "delivered" ? {deliveredAt:goal.updatedAt} : {})}} : {}),
    pauseReason: goal.pauseReason,
    iteration: goal.iteration,
    tokensUsed: goal.tokensUsed,
    ...(goal.tokenBudget === undefined ? {} : { budgetView: goalBudgetView(goal) }),
    tokenBudget: goal.tokenBudget,
    timeUsedSeconds: goal.timeUsedSeconds,
    startedAt: goal.startedAt,
    updatedAt: goal.updatedAt,
    verificationFailures: goal.verificationFailures,
    infraErrorStreak: goal.infraErrorStreak,
    lastVerificationFailure: goal.lastVerificationFailure,
    acceptance: goal.acceptance?.map(redactAcceptanceCommandForDisplay),
    workflowSessionId: goal.workflowSessionId,
    retryAttempt: goalState.goalRecovery?.goalId === goal.id
      ? goalState.goalRecovery.attempt
      : undefined,
    retryMaxRetries: goalState.goalRecovery?.goalId === goal.id
      ? goalState.goalRecovery.maxRetries
      : undefined,
    ...(todoSubject ? { todoSubject } : {}),
  };
}

export function clearGoalDisplay(ctx: GoalContext): void {
  goalState.setGoalDisplayContext(ctx);
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget?.(GOAL_WIDGET_KEY, undefined, { placement: "belowEditor" });
}

export function tickGoalElapsed(ctx: GoalContext, goalId: string, now = goalClock.now()): boolean {
  const goal = goalState.activeGoal;
  if (!goal || goal.id !== goalId || goal.status !== "active") {
    clearElapsedTimer();
    return false;
  }
  if (goalState.goalStaticMode) return false;
  const elapsed = Math.max(0, Math.floor((now - goal.startedAt) / 1000));
  if (elapsed === goal.timeUsedSeconds) return false;
  goalState.advanceElapsed(goalId, elapsed);
  goal.timeUsedSeconds = elapsed;
  updateStatusLine(ctx, goal, true);
  return true;
}

export function ensureElapsedTimer(ctx: GoalContext, goalId: string): void {
  if (goalState.elapsedTimer) return;
  goalState.setElapsedTimer(goalClock.setInterval(() => {
    tickGoalElapsed(ctx, goalId);
  }, 1_000));
}

export function fmtStatusLine(goal: ActiveGoal | undefined): string | undefined {
  if (!goal) return undefined;
  if (goal.status === "done") return "done";
  if (goal.status === "paused") return goal.pauseReason === "budget" ? `budget ${fmtBudget(goal)}` : goal.pauseReason === "gate" ? "gate blocked" : goal.pauseReason === "verification" ? "verification blocked" : goal.pauseReason === "stalled" ? "stalled" : "paused";
  if (goal.tokenBudget !== undefined) return `active ${fmtBudget(goal)}`;
  return `active ${fmtDuration(goal.timeUsedSeconds)}`;
}

export function fmtBudget(goal: ActiveGoal): string { return goalBudgetView(goal).text; }

export function goalSummary(goal: ActiveGoal): string {
  const pauseInfo = goal.pauseReason ? ` (${goal.pauseReason})` : "";
  return [
    `Goal [${goal.id}]: ${goal.text}`,
    `Status: ${goal.status}${pauseInfo}`,
    ...(goal.delivery ? [`Delivery: ${goal.delivery.phase}`, ...(goal.delivery.receipt ? [`Final main reply: ${goal.delivery.receipt.entryId}`] : [])] : []),
    `Iteration: ${goal.iteration}`,
    `Elapsed: ${fmtDuration(goal.timeUsedSeconds)}`,
    ...(goal.tokenBudget === undefined ? [] : [`Token budget: ${fmtBudget(goal)}`]),
  ].join("\n");
}

export function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function fmtTokens(v: number): string {
  if (v < 1_000) return `${v}`;
  if (v < 1_000_000) return `${Number.isInteger(v / 1_000) ? v / 1_000 : (v / 1_000).toFixed(1)}k`;
  return `${Number.isInteger(v / 1_000_000) ? v / 1_000_000 : (v / 1_000_000).toFixed(1)}m`;
}

export function escapeXml(v: string): string { return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export function markerComment(marker: string): string { return `<!-- ${CONTINUATION_MARKER_PREFIX}${marker} -->`; }

export { CONTINUATION_MARKER_PREFIX } from "./types.ts";
