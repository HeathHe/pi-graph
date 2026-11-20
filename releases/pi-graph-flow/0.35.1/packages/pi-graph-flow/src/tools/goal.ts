/** Compatibility facade: every public operation delegates to the same Goal owner. */
import * as commands from "../goal-coordinator/commands.ts";
import * as state from "../goal-coordinator/state.ts";
import * as continuation from "../goal-coordinator/continuation.ts";
import * as lifecycle from "../goal-coordinator/lifecycle.ts";
import * as host from "../goal-coordinator/host.ts";
import * as presentation from "../goal-coordinator/presentation.ts";
import { type BeforeAgentStartInput } from "../before-agent-start.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowCoordinator } from "../session/coordinator.ts";
import { type WorkflowSnapshot } from "../session/types.ts";
import { type GoalDetailEntry, type GoalWidgetPhase } from "../tui/goal-widget.ts";
import { type GoalVerificationClassification } from "../tools/goal-verification.ts";
import type { GoalStatus, PauseReason, GoalCompactionEntry, GoalCompactionSnapshot, ActiveGoal, ContinuationPending, GoalContext, GoalGetParams, GoalCreateParams, GoalUpdateParams, GoalCompleteParams, GoalParams, GoalCommandParams } from "../goal-coordinator/types.ts";
export type { PauseReason, GoalCompactionEntry, GoalCompactionSnapshot, ActiveGoal, GoalContext, GoalGetParams, GoalCreateParams, GoalUpdateParams, GoalCompleteParams, GoalParams, GoalCommandParams } from "../goal-coordinator/types.ts";
export {
  buildCanonicalEvidence,
  canonicalCompletionBlockers,
  collectVerifierEvidence,
  isRetryableGoalFailure,
  parseVerifierOutput,
  setAcceptanceRunnerForTest,
  setGoalVerifierRunnerForTest,
} from "./goal-verification.ts";
export type { AcceptanceResult, VerifierVerdict } from "./goal-verification.ts";

lifecycle.configureGoalOwnerVerification();

export async function executeGoal(
  params: GoalParams,
  ctx: GoalContext,
  signal?: AbortSignal,
): Promise<{ text: string; isError: boolean; terminate?: boolean; details?: { classification: GoalVerificationClassification } }> {
  return commands.executeGoal(params, ctx, signal);
}

export async function executeGoalCommand(
  params: GoalCommandParams,
  ctx: GoalContext,
): Promise<{ text: string; isError: boolean }> {
  return commands.executeGoalCommand(params, ctx);
}

export function registerGoalCommand(pi: ExtensionAPI) {
  return commands.registerGoalCommand(pi);
}

export function goalArgumentCompletions(prefix: string) {
  return commands.goalArgumentCompletions(prefix);
}

export function initGoal(pi: ExtensionAPI) {
  return lifecycle.initGoal(pi);
}

export function setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void {
  return lifecycle.setWorkflowCoordinator(coordinator);
}

export function setGoalStaticMode(staticMode: boolean): void {
  return presentation.setGoalStaticMode(staticMode);
}

export function setGoalPanelOwnership(ownedExternally: boolean, ctx?: GoalContext): void {
  return presentation.setGoalPanelOwnership(ownedExternally, ctx);
}

export function reconcileWorkflowGoal(snapshot: WorkflowSnapshot, ctx: GoalContext): ActiveGoal | undefined {
  return commands.reconcileWorkflowGoal(snapshot, ctx);
}

export async function onSessionStart(
  ctx: GoalContext,
  event: { reason?: "startup" | "reload" | "new" | "resume" | "fork"; deferResume?: boolean } = {},
) {
  return lifecycle.onSessionStart(ctx, event);
}

export function recoverPendingGoalTodoDetachesAfterTodoStart(ctx: GoalContext): number {
  return lifecycle.recoverPendingGoalTodoDetachesAfterTodoStart(ctx);
}

export function onSessionShutdown(ctx: GoalContext) {
  return lifecycle.onSessionShutdown(ctx);
}

export function onBeforeCompact(ctx: GoalContext) {
  return continuation.onBeforeCompact(ctx);
}

export function onCompactionCancelled(ctx?: GoalContext) {
  return continuation.onCompactionCancelled(ctx);
}

export async function onCompact(
  event: unknown,
  ctx: GoalContext,
  options: { deferContinuation?: boolean } = {},
) {
  return continuation.onCompact(event, ctx, options);
}

export function onInput(event: { source?: string; text?: string }) {
  return continuation.onInput(event);
}

export function onBeforeAgentStart(event: BeforeAgentStartInput) {
  return continuation.onBeforeAgentStart(event);
}

export async function onAgentEnd(event: { messages: unknown[] }, ctx: GoalContext) {
  return continuation.onAgentEnd(event, ctx);
}

export function onProviderPressureSettled(ctx: GoalContext) {
  return continuation.onProviderPressureSettled(ctx);
}

export async function onAgentSettled(
  ctx: GoalContext,
  options: { suppressContinuation?: boolean } = {},
) {
  return continuation.onAgentSettled(ctx, options);
}

export function getActiveGoal(): ActiveGoal | undefined {
  return state.getActiveGoal();
}

export function getCurrentGoal(): ActiveGoal | undefined {
  return state.getCurrentGoal();
}

export function getGoalList(): ActiveGoal[] {
  return state.getGoalList();
}

export function getGoalById(goalId: string): ActiveGoal | undefined {
  return state.getGoalById(goalId);
}

export function switchCurrentGoal(
  goalId: string,
  ctx?: GoalContext,
  opts: { resume?: boolean } = {},
): ActiveGoal | undefined {
  return commands.switchCurrentGoal(goalId, ctx, opts);
}

export function addGoal(
  objective: string,
  ctx: GoalContext,
  opts: { tokenBudget?: number; planHandoffKey?: string; acceptance?: string[] } = {},
): ActiveGoal {
  return commands.addGoal(objective, ctx, opts);
}

export function parseGoalCommand(args: string): GoalCommandParams | string {
  return commands.parseGoalCommand(args);
}

export function setGoalStateChangeListener(listener: (() => void) | undefined): void {
  return state.setGoalStateChangeListener(listener);
}

export function currentGoalPhase(): GoalWidgetPhase {
  return presentation.currentGoalPhase();
}

export function getGoalCompactionSnapshot(): GoalCompactionSnapshot {
  return presentation.getGoalCompactionSnapshot();
}

export function getGoalPanelEntries(): GoalDetailEntry[] {
  return presentation.getGoalPanelEntries();
}

export function tickGoalElapsed(ctx: GoalContext, goalId: string, now = Date.now()): boolean {
  return presentation.tickGoalElapsed(ctx, goalId, now);
}

export function fmtStatusLine(goal: ActiveGoal | undefined): string | undefined {
  return presentation.fmtStatusLine(goal);
}

export function parseGoalActionParams(params: Record<string, unknown>): GoalParams | undefined {
  return commands.parseGoalActionParams(params);
}


/** Read-only readiness signal for the registered session-start Host. */
export function hasPendingGoalTodoDetachRecovery(): boolean { return state.hasPendingGoalTodoDetachRecovery(); }

export function preparePlanReplacement(...args: Parameters<typeof commands.preparePlanReplacement>): ReturnType<typeof commands.preparePlanReplacement> { return commands.preparePlanReplacement(...args); }
export function rebindPlanReplacement(...args: Parameters<typeof commands.rebindPlanReplacement>): ReturnType<typeof commands.rebindPlanReplacement> { return commands.rebindPlanReplacement(...args); }
export function resumeAfterPlanReplacementRecovery(...args: Parameters<typeof lifecycle.resumeAfterPlanReplacementRecovery>): ReturnType<typeof lifecycle.resumeAfterPlanReplacementRecovery> { return lifecycle.resumeAfterPlanReplacementRecovery(...args); }

export function assertPlanReplacementPublication(...args: Parameters<typeof commands.assertPlanReplacementPublication>): ReturnType<typeof commands.assertPlanReplacementPublication> { return commands.assertPlanReplacementPublication(...args); }

export function assertPlanReplacementHistory(...args: Parameters<typeof commands.assertPlanReplacementHistory>): ReturnType<typeof commands.assertPlanReplacementHistory> { return commands.assertPlanReplacementHistory(...args); }

export function fenceTaskClear(...args: Parameters<typeof state.fenceTaskClear>): ReturnType<typeof state.fenceTaskClear> { return state.fenceTaskClear(...args); }
