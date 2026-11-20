import { unavailableBudgetView, type GoalBudgetView, type GoalBudgetViewPort, type GoalBudgetConfigurationPort } from "./budget-view.ts";
import { createGoalBudgetSource, validateGoalBudget } from "./budget-source.ts";
import { isGoalPlanReplacementPending, isGoalTaskClearPending } from "../task-workflow/commands.ts";
import { goalContractDigest } from "./delivery.ts";
/** Goal state owner. */
import { type ActiveGoal, type GoalOwnerState, type GoalContext, type PauseReason } from "./types.ts";
import { randomUUID } from "node:crypto";
import { appendGoalPublication, invalidateGoalSource, captureGoalSource, captureGoalSourceContinuity, assertGoalSource, subscribeGoalSource, GOAL_STATE_ENTRY_TYPE } from "./source.ts";
import { appendGoalEntry, detachTasksFromGoal, getVisibleTasks, persistLoadedTodoStateForGoalDetachRecovery, goalClock, currentTokenTotal } from "./host.ts";
import { TODO_STATE_ENTRY_TYPE } from "../tools/todo-serialization.ts";
import { type WorkflowSession } from "../session/types.ts";

class GoalState {
  private readonly stageOrigins = new WeakMap<ActiveGoal, ActiveGoal>();
  private readonly activeOrigins = new WeakMap<ActiveGoal, ActiveGoal>();
  stageUpdatedVerificationView(goal: ActiveGoal): void {
    if (this.isStagedGoal(goal) || this._activeGoal !== undefined && this.activeOrigins.get(goal) === this._activeGoal) this.setStagedActiveGoal(goal);
  }
  private snapshot<T>(value: T): T { return structuredClone(value); }
  isStagedGoal(goal: ActiveGoal): boolean { return this._stagedActiveGoal !== undefined && (this._stagedActiveGoal === goal || this.stageOrigins.get(goal) === this._stagedActiveGoal); }
  advanceElapsed(goalId: string, seconds: number): void {
    if (this._activeGoal?.id !== goalId) return;
    this._activeGoal.timeUsedSeconds = seconds;
    const registered = this._goalRegistry.find(goal => goal.id === goalId);
    if (registered) registered.timeUsedSeconds = seconds;
  }
  private _activeGoal: GoalOwnerState["activeGoal"];
  get activeGoal(): GoalOwnerState["activeGoal"] { const copy = this.snapshot(this._activeGoal); if (copy && this._activeGoal) this.activeOrigins.set(copy, this._activeGoal); return copy; }
  private _budgetSelectionRevision = 0;
  get budgetSelectionRevision(): number { return this._budgetSelectionRevision; }
  setActiveGoal(value: GoalOwnerState["activeGoal"]): void {
    // Only a concurrency restriction for a paused configuration command. This
    // revision is never a birth proof, ledger history, or model sending permit.
    if (this._activeGoal?.id !== value?.id || this._activeGoal?.status !== value?.status
      || this._activeGoal?.tokenBudget !== value?.tokenBudget) this._budgetSelectionRevision++;
    this._activeGoal = this.snapshot(value);
  }
  private _stagedActiveGoal: GoalOwnerState["stagedActiveGoal"];
  get stagedActiveGoal(): GoalOwnerState["stagedActiveGoal"] { const copy = this.snapshot(this._stagedActiveGoal); if (copy && this._stagedActiveGoal) this.stageOrigins.set(copy, this._stagedActiveGoal); return copy; }
  setStagedActiveGoal(value: GoalOwnerState["stagedActiveGoal"]): void { this._stagedActiveGoal = this.snapshot(value); if (value && this._stagedActiveGoal) this.stageOrigins.set(value, this._stagedActiveGoal); }
  private _goalRegistry: GoalOwnerState["goalRegistry"] = [];
  get goalRegistry(): GoalOwnerState["goalRegistry"] { return this.snapshot(this._goalRegistry); }
  setGoalRegistry(value: GoalOwnerState["goalRegistry"]): void { this._goalRegistry = this.snapshot(value); }
  private _pendingTodoDetachGoalIds: GoalOwnerState["pendingTodoDetachGoalIds"] = [];
  get pendingTodoDetachGoalIds(): GoalOwnerState["pendingTodoDetachGoalIds"] { return this.snapshot(this._pendingTodoDetachGoalIds); }
  setPendingTodoDetachGoalIds(value: GoalOwnerState["pendingTodoDetachGoalIds"]): void { this._pendingTodoDetachGoalIds = this.snapshot(value); }
  private _extensionApi: GoalOwnerState["extensionApi"];
  get extensionApi(): GoalOwnerState["extensionApi"] { return this._extensionApi; }
  setExtensionApi(value: GoalOwnerState["extensionApi"]): void { this._extensionApi = value; }
  private _onGoalStateChanged: GoalOwnerState["onGoalStateChanged"];
  get onGoalStateChanged(): GoalOwnerState["onGoalStateChanged"] { return this._onGoalStateChanged; }
  setOnGoalStateChanged(value: GoalOwnerState["onGoalStateChanged"]): void { this._onGoalStateChanged = value; }
  private _goalPanelOwnedExternally: GoalOwnerState["goalPanelOwnedExternally"] = false;
  get goalPanelOwnedExternally(): GoalOwnerState["goalPanelOwnedExternally"] { return this._goalPanelOwnedExternally; }
  setGoalPanelOwnedExternally(value: GoalOwnerState["goalPanelOwnedExternally"]): void { this._goalPanelOwnedExternally = value; }
  private _goalDisplayContext: GoalOwnerState["goalDisplayContext"];
  get goalDisplayContext(): GoalOwnerState["goalDisplayContext"] { return this._goalDisplayContext; }
  setGoalDisplayContext(value: GoalOwnerState["goalDisplayContext"]): void { this._goalDisplayContext = value; }
  private _baseCwd: GoalOwnerState["baseCwd"] = "";
  get baseCwd(): GoalOwnerState["baseCwd"] { return this._baseCwd; }
  setBaseCwd(value: GoalOwnerState["baseCwd"]): void { this._baseCwd = value; }
  private _continuationPending: GoalOwnerState["continuationPending"];
  get continuationPending(): GoalOwnerState["continuationPending"] { return this.snapshot(this._continuationPending); }
  setContinuationPending(value: GoalOwnerState["continuationPending"]): void { this._continuationPending = this.snapshot(value); }
  private _suspendedContinuation: GoalOwnerState["suspendedContinuation"];
  get suspendedContinuation(): GoalOwnerState["suspendedContinuation"] { return this.snapshot(this._suspendedContinuation); }
  setSuspendedContinuation(value: GoalOwnerState["suspendedContinuation"]): void { this._suspendedContinuation = this.snapshot(value); }
  private _compactionInFlight: GoalOwnerState["compactionInFlight"] = false;
  get compactionInFlight(): GoalOwnerState["compactionInFlight"] { return this._compactionInFlight; }
  setCompactionInFlight(value: GoalOwnerState["compactionInFlight"]): void { this._compactionInFlight = value; }
  private _goalRecovery: GoalOwnerState["goalRecovery"];
  get goalRecovery(): GoalOwnerState["goalRecovery"] { return this.snapshot(this._goalRecovery); }
  setGoalRecovery(value: GoalOwnerState["goalRecovery"]): void { this._goalRecovery = this.snapshot(value); }
  private _latestGoalAttempt: GoalOwnerState["latestGoalAttempt"];
  get latestGoalAttempt(): GoalOwnerState["latestGoalAttempt"] { return this.snapshot(this._latestGoalAttempt); }
  setLatestGoalAttempt(value: GoalOwnerState["latestGoalAttempt"]): void { this._latestGoalAttempt = this.snapshot(value); }
  private _completionTimer: GoalOwnerState["completionTimer"];
  get completionTimer(): GoalOwnerState["completionTimer"] { return this._completionTimer; }
  setCompletionTimer(value: GoalOwnerState["completionTimer"]): void { this._completionTimer = value; }
  private _verificationInFlight: GoalOwnerState["verificationInFlight"];
  get verificationInFlight(): Readonly<GoalOwnerState["verificationInFlight"]> { return this._verificationInFlight; }
  setVerificationInFlight(value: GoalOwnerState["verificationInFlight"]): void { this._verificationInFlight = value ? Object.freeze(value) : undefined; }
  private _goalLifecycleEpoch: GoalOwnerState["goalLifecycleEpoch"] = 0;
  get goalLifecycleEpoch(): GoalOwnerState["goalLifecycleEpoch"] { return this._goalLifecycleEpoch; }
  setGoalLifecycleEpoch(value: GoalOwnerState["goalLifecycleEpoch"]): void { this._goalLifecycleEpoch = value; }
  private _goalOwnerInstanceId: GoalOwnerState["goalOwnerInstanceId"] = randomUUID();
  get goalOwnerInstanceId(): GoalOwnerState["goalOwnerInstanceId"] { return this._goalOwnerInstanceId; }
  private _goalSessionId: GoalOwnerState["goalSessionId"];
  get goalSessionId(): GoalOwnerState["goalSessionId"] { return this._goalSessionId; }
  setGoalSessionId(value: GoalOwnerState["goalSessionId"]): void { this._goalSessionId = value; }
  private _goalLoopOwner: GoalOwnerState["goalLoopOwner"];
  get goalLoopOwner(): GoalOwnerState["goalLoopOwner"] { return this.snapshot(this._goalLoopOwner); }
  setGoalLoopOwner(value: GoalOwnerState["goalLoopOwner"]): void { this._goalLoopOwner = this.snapshot(value); }
  private _workflowCoordinator: GoalOwnerState["workflowCoordinator"];
  get workflowCoordinator(): GoalOwnerState["workflowCoordinator"] { return this._workflowCoordinator; }
  setWorkflowCoordinator(value: GoalOwnerState["workflowCoordinator"]): void { this._workflowCoordinator = value; }
  private _elapsedTimer: GoalOwnerState["elapsedTimer"];
  get elapsedTimer(): GoalOwnerState["elapsedTimer"] { return this._elapsedTimer; }
  setElapsedTimer(value: GoalOwnerState["elapsedTimer"]): void { this._elapsedTimer = value; }
  private _goalStaticMode: GoalOwnerState["goalStaticMode"] = false;
  get goalStaticMode(): GoalOwnerState["goalStaticMode"] { return this._goalStaticMode; }
  setGoalStaticMode(value: GoalOwnerState["goalStaticMode"]): void { this._goalStaticMode = value; }
  private _disposeFailoverTerminal: GoalOwnerState["disposeFailoverTerminal"];
  get disposeFailoverTerminal(): GoalOwnerState["disposeFailoverTerminal"] { return this._disposeFailoverTerminal; }
  setDisposeFailoverTerminal(value: GoalOwnerState["disposeFailoverTerminal"]): void { this._disposeFailoverTerminal = value; }
  private _issuedGoalMarkers: GoalOwnerState["issuedGoalMarkers"] = new Set<string>();
  issueMarker(marker: string): void { this._issuedGoalMarkers.add(marker); }
  consumeMarker(marker: string): boolean { return this._issuedGoalMarkers.delete(marker); }
  clearMarkers(): void { this._issuedGoalMarkers.clear(); }
}

const storage = new GoalState();

export const goalState: Omit<GoalState, "setActiveGoal" | "setGoalRegistry" | "setPendingTodoDetachGoalIds"> = storage;

export const GOAL_STATE_VERSION = 2;
const budgetSource = createGoalBudgetSource({
  goal: getGoalById,
  goals: getGoalList,
  selected: getActiveGoal,
  capture(ctx) {
    const loaded = goalState.goalDisplayContext;
    if (!loaded || loaded.cwd !== ctx.cwd || loaded.sessionManager !== ctx.sessionManager) throw new Error("Goal budget caller does not own the loaded source");
    return captureGoalSource(loaded);
  },
  assert: assertGoalSource,
  subscribe: subscribeGoalSource,
  captureContinuity: ctx => {
    const loaded = goalState.goalDisplayContext;
    if (!loaded || loaded.cwd !== ctx.cwd || loaded.sessionManager !== ctx.sessionManager) throw new Error("Goal continuity caller does not own the loaded owner");
    return captureGoalSourceContinuity(loaded);
  },
  coverage: ctx => ctx.sessionManager && typeof ctx.sessionManager === "object" ? budgetHostCapabilities.get(ctx.sessionManager)?.coverage : undefined,
  coverageRequired: ctx => Boolean(ctx.sessionManager && typeof ctx.sessionManager === "object" && budgetHostCapabilities.has(ctx.sessionManager)),
  readAdoption: (grant, ctx) => {
    const manager = ctx.sessionManager;
    const capability = manager && typeof manager === "object" ? budgetHostCapabilities.get(manager) : undefined;
    if (!capability || capability.retired || !capability.readAdoption || !manager) throw new Error("Coverage adoption issuer unavailable");
    return capability.readAdoption(grant, manager);
  },
});
export function captureGoalBudget(...args: Parameters<typeof budgetSource.capture>): ReturnType<typeof budgetSource.capture> {
  return budgetSource.capture(...args);
}
export function captureSelectedGoalBudget(ctx: import("./budget-source.ts").GoalBudgetContext): import("./budget-source.ts").GoalBudgetSource {
  return budgetSource.captureSelected!(ctx);
}
export function subscribeGoalBudget(scope: import("./budget-source.ts").GoalBudgetScope, changed: () => void): () => void { return budgetSource.subscribe!(scope, changed); }
export function assertNoGoalBudget(source: import("./budget-source.ts").GoalBudgetSource): void {
  budgetSource.assertNone!(source);
}
export function readGoalBudget(...args: Parameters<typeof budgetSource.read>): ReturnType<typeof budgetSource.read> {
  return budgetSource.read(...args);
}
export function goalBudgetCoverageInfo(scope: import("./budget-source.ts").GoalBudgetScope) { return budgetSource.coverageInfo!(scope); }
export function captureGoalCoverageClose(ctx: import("./budget-source.ts").GoalBudgetContext) { return budgetSource.captureCoverageClose!(ctx); }
export function restoredGoalCoverage(ctx: import("./budget-source.ts").GoalBudgetContext) { return budgetSource.restoredCoverage!(ctx); }
export function adoptGoalCoverage(ctx: import("./budget-source.ts").GoalBudgetContext, grant: object): void { budgetSource.adoptCoverage!(ctx, grant); }
export function assertGoalBudgetCoverage(scope: import("./budget-source.ts").GoalBudgetScope): void { budgetSource.assertCoverage!(scope); }
export function initialGoalBudgetHistory(scope: import("./budget-source.ts").GoalBudgetScope): import("pi-graph-permission-core").BudgetHistory { return budgetSource.initialHistory!(scope); }

// Optional only for direct legacy owner API fixtures. The real extension registers
// an explicit capability for every session before any Goal source is loaded.
const budgetHostCapabilities = new WeakMap<object, { error?: Error; coverage?: import("./budget-source.ts").GoalBudgetCoveragePort; readAdoption?: (grant: object, manager: object) => import("./budget-source.ts").GoalCoverageAdoption; retired: boolean; view?: GoalBudgetViewPort; configuration?: GoalBudgetConfigurationPort; snapshots: Map<string, { limit?: number; value: GoalBudgetView }> }>();
export function configureGoalBudgetHost(ctx: import("./budget-source.ts").GoalBudgetContext, error?: Error, coverage?: import("./budget-source.ts").GoalBudgetCoveragePort, readAdoption?: (grant: object, manager: object) => import("./budget-source.ts").GoalCoverageAdoption, view?: GoalBudgetViewPort, configuration?: GoalBudgetConfigurationPort): () => void {
  const manager = ctx.sessionManager;
  if (!manager || typeof manager !== "object") throw new Error("Goal budget host has no real session manager");
  const registration = { error, coverage, readAdoption, view, configuration, snapshots: new Map<string, { limit?: number; value: GoalBudgetView }>(), retired: false }; budgetHostCapabilities.set(manager, registration);
  // A retired production manager is not a never-registered legacy host. Keep
  // only weak lifecycle metadata, and never let an old disposer retire a new registration.
  return () => { if (budgetHostCapabilities.get(manager) === registration) registration.retired = true; };
}
/** Strict on-demand read; it never opens a store or creates a request. */
export function readGoalBudgetView(goalId: string, ctx = goalState.goalDisplayContext): GoalBudgetView {
  const goal = getGoalById(goalId);
  if (!goal || !ctx) return unavailableBudgetView("goal-source-unavailable", goal?.tokenBudget);
  const manager = ctx.sessionManager;
  const capability = manager && typeof manager === "object" ? budgetHostCapabilities.get(manager) : undefined;
  if (capability?.retired) return unavailableBudgetView("owner-retired", goal.tokenBudget);
  const source = captureGoalBudget(goalId, ctx);
  if (source.kind === "none") { assertNoGoalBudget(source); return { version: 1, kind: "none", admission: "none", text: "无预算（父会话局部遥测）" }; }
  if (capability?.error) throw capability.error;
  if (!capability?.view) return unavailableBudgetView("budget-view-not-supported", goal.tokenBudget);
  return capability.view.read(source.scope);
}
export function refreshGoalBudgetView(goalId: string, ctx = goalState.goalDisplayContext): GoalBudgetView {
  const goal = getGoalById(goalId), manager = ctx?.sessionManager;
  let value: GoalBudgetView;
  try { value = readGoalBudgetView(goalId, ctx); }
  catch (error) { value = unavailableBudgetView("source-read-failed", goal?.tokenBudget); if (manager && typeof manager === "object") budgetViewReadErrors.set(manager, error); }
  const capability = manager && typeof manager === "object" ? budgetHostCapabilities.get(manager) : undefined;
  if (capability && !capability.retired && goal) capability.snapshots.set(goalId, { limit: goal.tokenBudget, value: Object.freeze({ ...value }) });
  return value;
}
const budgetViewReadErrors = new WeakMap<object, unknown>();
export function goalBudgetViewReadError(ctx = goalState.goalDisplayContext): unknown { const manager = ctx?.sessionManager; return manager && typeof manager === "object" ? budgetViewReadErrors.get(manager) : undefined; }
/** Render-only snapshot. A command always calls the strict fresh read above. */
export function goalBudgetView(goal: ActiveGoal): GoalBudgetView {
  const ctx = goalState.goalDisplayContext, manager = ctx?.sessionManager;
  if (goal.tokenBudget === undefined) return { version: 1, kind: "none", admission: "none", text: "无预算（父会话局部遥测）" };
  const capability = manager && typeof manager === "object" ? budgetHostCapabilities.get(manager) : undefined;
  if (capability?.retired) return unavailableBudgetView("owner-retired", goal.tokenBudget);
  const cached = capability?.snapshots.get(goal.id);
  return cached && cached.limit === goal.tokenBudget ? cached.value : refreshGoalBudgetView(goal.id, ctx);
}
export async function syncGoalBudgetDeclaration(goalId: string, ctx: GoalContext): Promise<void> {
  const source = captureGoalBudget(goalId, ctx); if (source.kind === "none") { assertNoGoalBudget(source); return; }
  const manager = ctx.sessionManager;
  const capability = manager && typeof manager === "object" ? budgetHostCapabilities.get(manager) : undefined;
  if (!capability || capability.retired || !capability.configuration) throw new Error("Current Goal budget configuration capability unavailable");
  const revision = storage.budgetSelectionRevision;
  const contract = storage.activeGoal && goalContractDigest(storage.activeGoal);
  const assertOperationCurrent = () => {
    if (budgetHostCapabilities.get(manager as object) !== capability || capability.retired) throw new Error("Goal budget configuration host changed");
    if (storage.budgetSelectionRevision !== revision || storage.activeGoal?.id !== goalId || storage.activeGoal.status !== "paused")
      throw new Error("Goal budget configuration selection or paused command changed");
    if (goalContractDigest(storage.activeGoal) !== contract) throw new Error("Goal budget configuration business contract changed");
  };
  assertOperationCurrent();
  await capability.configuration.syncDeclaredLimit(source.scope, assertOperationCurrent);
  assertOperationCurrent();
  refreshGoalBudgetView(goalId, ctx);
}
export function assertLegacyModelCompletion(ctx: import("./budget-source.ts").GoalBudgetContext): void {
  const manager = ctx.sessionManager;
  if (!manager || typeof manager !== "object") return;
  const capability = budgetHostCapabilities.get(manager);
  if (!capability) return;
  if (capability.retired) throw new Error("Model budget host was retired; no request was sent");
  const source = captureSelectedGoalBudget(ctx);
  if (source.kind !== "none") throw new Error("Declared Goal budget requires a covered model request host");
  assertNoGoalBudget(source);
}
export function assertGoalBudgetHost(limit: number | undefined, ctx = goalState.goalDisplayContext): void {
  if (limit === undefined) return;
  const manager = ctx?.sessionManager;
  const capability = manager && typeof manager === "object" ? budgetHostCapabilities.get(manager) : undefined;
  if (capability?.retired) throw new Error("Model budget host was retired; no request was sent");
  if (capability?.error) throw capability.error;
}

export const MAX_RETAINED_GOALS = 64;

export const MAX_RETAINED_GOAL_PAYLOAD_BYTES = 64 * 1024;

export function getActiveGoal(): ActiveGoal | undefined {
  return goalState.activeGoal ? structuredClone(goalState.activeGoal) : undefined;
}

export function getCurrentGoal(): ActiveGoal | undefined {
  return goalState.activeGoal ? structuredClone(goalState.activeGoal) : undefined;
}

export function getGoalList(): ActiveGoal[] {
  return [...goalState.goalRegistry]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((goal) => structuredClone(goal));
}

export function getGoalById(goalId: string): ActiveGoal | undefined {
  if (goalState.activeGoal?.id === goalId) return structuredClone(goalState.activeGoal);
  const found = goalState.goalRegistry.find((goal) => goal.id === goalId);
  return found ? structuredClone(found) : undefined;
}

export function registryWithGoal(goal: ActiveGoal): ActiveGoal[] {
  const next = [...goalState.goalRegistry];
  const index = next.findIndex((entry) => entry.id === goal.id);
  if (index >= 0) next[index] = goal;
  else next.push(goal);
  return next;
}

function assertPendingReplacementGoal(goal: ActiveGoal): void {
  if(isGoalTaskClearPending(goal.id)) {
    const previous=getGoalById(goal.id);
    if(!previous || goal.status==="done" || goalContractDigest(previous)!==goalContractDigest(goal) || JSON.stringify(previous.delivery)!==JSON.stringify(goal.delivery) || JSON.stringify(previous.businessReview)!==JSON.stringify(goal.businessReview) || previous.verifiedGroupDigest!==goal.verifiedGroupDigest)throw new Error("task-clear-pending: conflicting Goal publication");
  }
  if (!isGoalPlanReplacementPending(goal.id)) return;
  const previous = getGoalById(goal.id);
  if (!previous || goal.status === "done" || goalContractDigest(previous) !== goalContractDigest(goal)
    || JSON.stringify(previous.planReplacement) !== JSON.stringify(goal.planReplacement)) throw new Error("plan-replacement-pending: conflicting target Goal publication");
}
export function persistGoal(goal: ActiveGoal): void {
  assertPendingReplacementGoal(goal);
  const nextRegistry = retainGoalRegistry(
    registryWithGoal(goal),
    goal.id,
    visibleTodoGoalIds(),
    new Set(goalState.pendingTodoDetachGoalIds),
  );
  try {
    appendGoalState(goal, nextRegistry, goalState.pendingTodoDetachGoalIds);
  } catch (error) {
    if (goalState.isStagedGoal(goal)) goalState.setStagedActiveGoal(undefined);
    throw error;
  }
  storage.setGoalRegistry(nextRegistry);
  storage.setActiveGoal(goal);
  goalState.setStagedActiveGoal(undefined);
  goalState.onGoalStateChanged?.();
}

export function clearPersistedGoal(): void {
  persistGoalSelection(undefined, goalState.goalRegistry, goalState.pendingTodoDetachGoalIds);
}

export function persistGoalSelection(
  currentGoal: ActiveGoal | undefined,
  nextRegistry: ActiveGoal[],
  nextPendingTodoDetachGoalIds: string[],
  replacementGuard?: () => void,
): void {
  if (!replacementGuard) {
    for (const goal of nextRegistry) assertPendingReplacementGoal(goal);
    for (const old of goalState.goalRegistry) if ((isGoalPlanReplacementPending(old.id) || isGoalTaskClearPending(old.id)) && !nextRegistry.some(goal => goal.id === old.id)) throw new Error("plan-replacement-pending: cannot detach target Goal");
  }
  const retainedRegistry = retainGoalRegistry(
    nextRegistry,
    currentGoal?.id,
    visibleTodoGoalIds(),
    new Set(nextPendingTodoDetachGoalIds),
  );
  appendGoalState(currentGoal, retainedRegistry, nextPendingTodoDetachGoalIds, replacementGuard);
  storage.setGoalRegistry(retainedRegistry);
  storage.setActiveGoal(currentGoal);
  goalState.setStagedActiveGoal(undefined);
  storage.setPendingTodoDetachGoalIds(nextPendingTodoDetachGoalIds);
  goalState.onGoalStateChanged?.();
}

export function appendGoalState(
  currentGoal: ActiveGoal | undefined,
  goals: ActiveGoal[],
  pendingDetaches: string[],
  replacementGuard?: () => void,
): void {
  const data = {
    version: GOAL_STATE_VERSION,
    sessionId: goalState.goalSessionId,
    goal: currentGoal ?? null,
    goals,
    currentGoalId: currentGoal?.id,
    ...(pendingDetaches.length > 0 ? { pendingTodoDetachGoalIds: pendingDetaches } : {}),
  };
  appendGoalPublication(GOAL_STATE_ENTRY_TYPE, data, () => {
    replacementGuard?.();
    appendGoalEntry(goalState.extensionApi, GOAL_STATE_ENTRY_TYPE, data);
  });
  try { replacementGuard?.(); } catch (error) { invalidateGoalSource(); throw error; }
  budgetSource.published(goals, goalState.goalDisplayContext);
}

export function commitDeliveredGoal(goal: ActiveGoal, ctx: GoalContext): void {
  const referencedGoalIds = visibleTodoGoalIds();
  const needsTodoDetach = referencedGoalIds.has(goal.id);
  const pendingWithCompletion = needsTodoDetach
    ? [...new Set([...goalState.pendingTodoDetachGoalIds, goal.id])]
    : [...goalState.pendingTodoDetachGoalIds];
  const verifiedRegistry = retainGoalRegistry(
    registryWithGoal(goal),
    goal.id,
    referencedGoalIds,
    new Set(pendingWithCompletion),
  );

  appendGoalState(goal, verifiedRegistry, pendingWithCompletion);
  storage.setGoalRegistry(verifiedRegistry);
  storage.setActiveGoal(goal);
  goalState.setStagedActiveGoal(undefined);
  storage.setPendingTodoDetachGoalIds(pendingWithCompletion);
  cancelContinuation();
  clearRecovery();
  goalState.setGoalLoopOwner(undefined);
  goalState.setLatestGoalAttempt(undefined);
  clearElapsedTimer();

  if (needsTodoDetach) detachTasksFromGoal(goal.id);

  const settledPending = pendingWithCompletion.filter((goalId) => goalId !== goal.id);
  const settledRegistry = retainGoalRegistry(
    goalState.goalRegistry,
    undefined,
    visibleTodoGoalIds(),
    new Set(settledPending),
  );
  appendGoalState(undefined, settledRegistry, settledPending);
  storage.setGoalRegistry(settledRegistry);
  storage.setActiveGoal(undefined);
  goalState.setStagedActiveGoal(undefined);
  storage.setPendingTodoDetachGoalIds(settledPending);
  goalState.onGoalStateChanged?.();
}

export function visibleTodoGoalIds(): Set<string> {
  return new Set(getVisibleTasks().flatMap((task) => task.goalId ? [task.goalId] : []));
}

export function persistedTodoGoalIds(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): Set<string> {
  const entry = entries
    .filter((candidate) => candidate.type === "custom" && candidate.customType === TODO_STATE_ENTRY_TYPE)
    .pop();
  const data = entry?.data;
  if (!data || typeof data !== "object") return new Set();
  const rawTasks = (data as { tasks?: unknown }).tasks;
  if (!rawTasks || typeof rawTasks !== "object" || Array.isArray(rawTasks)) return new Set();
  const goalIds = new Set<string>();
  for (const rawTask of Object.values(rawTasks)) {
    if (!rawTask || typeof rawTask !== "object") continue;
    const task = rawTask as { goalId?: unknown; status?: unknown };
    if (task.status !== "deleted" && typeof task.goalId === "string" && task.goalId) {
      goalIds.add(task.goalId);
    }
  }
  return goalIds;
}

export function retainedGoalPayloadBytes(goals: ActiveGoal[], currentGoalId: string | undefined): number {
  const currentGoal = currentGoalId ? goals.find((goal) => goal.id === currentGoalId) : undefined;
  return Buffer.byteLength(JSON.stringify({
    goal: currentGoal ?? null,
    goals,
    currentGoalId: currentGoal?.id,
  }), "utf8");
}

export function retainGoalRegistry(
  goals: ActiveGoal[],
  currentGoalId: string | undefined,
  referencedGoalIds: ReadonlySet<string>,
  pendingDetachGoalIds: ReadonlySet<string>,
): ActiveGoal[] {
  const removable = goals
    .filter((goal) => goal.status === "done"
      && goal.id !== currentGoalId
      && (!referencedGoalIds.has(goal.id) || pendingDetachGoalIds.has(goal.id)))
    .sort((left, right) => (
      left.startedAt - right.startedAt
      || left.updatedAt - right.updatedAt
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    ));
  let retained = [...goals];
  for (const goal of removable) {
    if (retained.length <= MAX_RETAINED_GOALS
      && retainedGoalPayloadBytes(retained, currentGoalId) <= MAX_RETAINED_GOAL_PAYLOAD_BYTES) break;
    const index = retained.indexOf(goal);
    if (index >= 0) retained.splice(index, 1);
  }
  const payloadBytes = retainedGoalPayloadBytes(retained, currentGoalId);
  if (retained.length > MAX_RETAINED_GOALS || payloadBytes > MAX_RETAINED_GOAL_PAYLOAD_BYTES) {
    throw new Error(
      `Goal registry exceeds its retained-history bound (${retained.length}/${MAX_RETAINED_GOALS} goals, ${payloadBytes}/${MAX_RETAINED_GOAL_PAYLOAD_BYTES} bytes) and cannot be pruned without dropping an active contract.`,
    );
  }
  return retained;
}

export function recoverPendingGoalTodoDetaches(ctx: GoalContext, todoStateJustLoaded = false): number {
  if (goalState.pendingTodoDetachGoalIds.length === 0) return 0;
  let detached = 0;
  for (const goalId of goalState.pendingTodoDetachGoalIds) detached += detachTasksFromGoal(goalId);
  if (detached === 0 && todoStateJustLoaded) persistLoadedTodoStateForGoalDetachRecovery();
  persistGoalSelection(goalState.activeGoal, goalState.goalRegistry, []);
  return detached;
}

export function isSupersededWorkflowProjection(goal: ActiveGoal): boolean {
  return typeof goal.supersededByGoalId === "string" && goal.supersededByGoalId.length > 0;
}

export function isLegacyWorkflowRollover(goal: ActiveGoal, current: ActiveGoal | undefined): current is ActiveGoal {
  return Boolean(
    current?.workflowSessionId
    && current.workflowSessionGeneration
    && goal.id !== current.id
    && goal.status === "paused"
    && goal.pauseReason === "gate"
    && goal.workflowSessionId === current.workflowSessionId
    && goal.workflowSessionGeneration
    && goal.workflowSessionGeneration !== current.workflowSessionGeneration
    && goal.startedAt < current.startedAt
  );
}

export function repairLegacyWorkflowGoalRollovers(
  goals: ActiveGoal[],
  current: ActiveGoal | undefined,
  referencedGoalIds: ReadonlySet<string>,
): ActiveGoal[] {
  const repaired: ActiveGoal[] = [];
  for (const goal of goals) {
    if (isSupersededWorkflowProjection(goal) || !isLegacyWorkflowRollover(goal, current)) {
      repaired.push(goal);
      continue;
    }
    if (!referencedGoalIds.has(goal.id) && goal.updatedAt <= current.startedAt) continue;
    repaired.push({ ...goal, supersededByGoalId: current.id });
  }
  return repaired;
}

export function setGoalStateChangeListener(listener: (() => void) | undefined): void {
  goalState.setOnGoalStateChanged(listener);
}

export function loadGoalFromSession(ctx: GoalContext, sessionId: string | undefined): ActiveGoal | undefined {
  const sm = ctx.sessionManager as {
    getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
    getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
  } | undefined;
  const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
  const entry = entries.filter((e) => e.type === "custom" && e.customType === GOAL_STATE_ENTRY_TYPE).pop();
  const data = entry?.data as {
    sessionId?: string;
    goal?: ActiveGoal | null;
    goals?: unknown;
    currentGoalId?: string;
    pendingTodoDetachGoalIds?: unknown;
  } | undefined;
  if (data?.sessionId && sessionId && data.sessionId !== sessionId) {
    storage.setGoalRegistry([]);
    storage.setPendingTodoDetachGoalIds([]);
    return undefined;
  }
  const loadedPendingDetaches = Array.isArray(data?.pendingTodoDetachGoalIds)
    ? data.pendingTodoDetachGoalIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const referencedGoalIds = persistedTodoGoalIds(entries);
  for (const goalId of visibleTodoGoalIds()) referencedGoalIds.add(goalId);

  if (Array.isArray(data?.goals)) {
    const loadedGoals = data.goals.filter(isGoal).map(normalizeLoadedGoal);
    const loadedCurrent = loadedGoals.find((goal) => goal.id === data.currentGoalId);
    const current = loadedCurrent?.status === "done" ? undefined : loadedCurrent;
    const repairedGoals = repairLegacyWorkflowGoalRollovers(loadedGoals, current, referencedGoalIds);
    const completedReferencedGoalIds = repairedGoals
      .filter((goal) => goal.status === "done" && referencedGoalIds.has(goal.id))
      .map((goal) => goal.id);
    const nextPendingDetaches = [...new Set([...loadedPendingDetaches, ...completedReferencedGoalIds])];
    const retainedRegistry = retainGoalRegistry(
      repairedGoals,
      current?.id,
      referencedGoalIds,
      new Set(nextPendingDetaches),
    );
    const rolloverRepairChanged = repairedGoals.length !== loadedGoals.length
      || repairedGoals.some((goal, index) => goal !== loadedGoals[index]);
    const needsRepair = nextPendingDetaches.length !== loadedPendingDetaches.length
      || current?.id !== data.currentGoalId
      || rolloverRepairChanged
      || retainedRegistry.length !== repairedGoals.length;
    if (needsRepair) appendGoalState(current, retainedRegistry, nextPendingDetaches);
    storage.setGoalRegistry(retainedRegistry);
    storage.setPendingTodoDetachGoalIds(nextPendingDetaches);
    return current;
  }

  const legacy = isGoal(data?.goal) ? normalizeLoadedGoal(data.goal) : undefined;
  const completedReferencedGoalIds = legacy?.status === "done" && referencedGoalIds.has(legacy.id)
    ? [legacy.id]
    : [];
  const nextPendingDetaches = [...new Set([...loadedPendingDetaches, ...completedReferencedGoalIds])];
  const current = legacy?.status === "done" ? undefined : legacy;
  const retainedRegistry = legacy
    ? retainGoalRegistry([legacy], current?.id, referencedGoalIds, new Set(nextPendingDetaches))
    : [];
  if (legacy && (nextPendingDetaches.length !== loadedPendingDetaches.length || current !== legacy)) {
    appendGoalState(current, retainedRegistry, nextPendingDetaches);
  }
  storage.setGoalRegistry(retainedRegistry);
  storage.setPendingTodoDetachGoalIds(nextPendingDetaches);
  return current;
}

export function normalizeLoadedGoal(goal: ActiveGoal): ActiveGoal {
  // Goals persisted before "error" was dropped from the union still carry it;
  // Omit is required because intersecting keeps the narrower declared type.
  const rawGoal = goal as Omit<ActiveGoal, "pauseReason"> & { pauseReason?: unknown };
  if (rawGoal.pauseReason !== "error") return goal;
  const { pauseReason: _pauseReason, ...normalized } = rawGoal;
  return normalized;
}

export function isGoal(v: unknown): v is ActiveGoal {
  if (!v || typeof v !== "object") return false;
  const g = v as Partial<ActiveGoal>;
  if (g.planContractEpoch !== undefined && (!Number.isSafeInteger(g.planContractEpoch) || g.planContractEpoch < 1 || g.planContractEpoch >= Number.MAX_SAFE_INTEGER)) throw new Error("Invalid persisted Goal plan contract epoch");
  if (g.planReplacement !== undefined) {
    const r = g.planReplacement;
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some(key => !["version", "id", "fromGroupId", "toGroupId", "fromPlanHandoffKey", "toPlanHandoffKey", "taskStateDigest", "contractEpoch"].includes(key))
      || r.version !== 1 || !Number.isSafeInteger(r.contractEpoch) || r.contractEpoch < 1 || r.contractEpoch >= Number.MAX_SAFE_INTEGER || g.planContractEpoch === undefined || ![r.id, r.fromGroupId, r.toGroupId, r.fromPlanHandoffKey, r.toPlanHandoffKey].every(value => typeof value === "string" && value.length > 0)
      || r.fromGroupId === r.toGroupId || r.fromPlanHandoffKey === r.toPlanHandoffKey || r.toPlanHandoffKey !== g.planHandoffKey || r.contractEpoch !== g.planContractEpoch || !/^[a-f0-9]{64}$/.test(r.taskStateDigest)) throw new Error("Invalid persisted Goal replacement receipt");
  }
  return (
    typeof g.id === "string" && typeof g.text === "string" &&
    ["active", "paused", "done"].includes(String(g.status)) &&
    typeof g.startedAt === "number" && typeof g.updatedAt === "number" &&
    typeof g.iteration === "number" &&
    typeof g.tokensUsed === "number" && typeof g.baselineTokens === "number" &&
    (g.pauseReason === undefined || ["user", "budget", "gate", "verification", "error", "stalled"].includes(String(g.pauseReason))) &&
    (g.planContractEpoch === undefined || Number.isSafeInteger(g.planContractEpoch) && g.planContractEpoch >= 1) &&
    (g.planReplacement === undefined || g.planReplacement.version === 1 && g.planReplacement.contractEpoch === g.planContractEpoch && g.planReplacement.toPlanHandoffKey === g.planHandoffKey && /^[a-f0-9]{64}$/.test(g.planReplacement.taskStateDigest)) &&
    (g.planHandoffKey === undefined || typeof g.planHandoffKey === "string") &&
    (g.workflowSessionId === undefined || typeof g.workflowSessionId === "string") &&
    (g.workflowSessionGeneration === undefined || typeof g.workflowSessionGeneration === "string") &&
    (g.supersededByGoalId === undefined || typeof g.supersededByGoalId === "string")
    && (g.verificationFailures === undefined || (typeof g.verificationFailures === "number" && g.verificationFailures >= 0))
    && (g.infraErrorStreak === undefined || (typeof g.infraErrorStreak === "number" && g.infraErrorStreak >= 0))
    && (g.failStreak === undefined || (typeof g.failStreak === "number" && g.failStreak >= 0))
    && (g.acceptance === undefined || (Array.isArray(g.acceptance) && g.acceptance.every((item) => typeof item === "string")))
    && (g.lastVerificationClassification === undefined || ["input-error", "infrastructure-error", "missing-evidence", "acceptance-failed", "success"].includes(g.lastVerificationClassification))
    && (g.lastMissingEvidenceFingerprint === undefined || /^[a-f0-9]{64}$/.test(g.lastMissingEvidenceFingerprint))
    && (g.lastVerificationFailure === undefined || typeof g.lastVerificationFailure === "string")
    && (g.prevTokensUsed === undefined || typeof g.prevTokensUsed === "number")
    && (g.lowProgressCount === undefined || (typeof g.lowProgressCount === "number" && g.lowProgressCount >= 0))
  );
}

export function createGoal(
  text: string,
  tokenBudget: number | undefined,
  baseline: number,
  planHandoffKey?: string,
  acceptance?: string[],
): ActiveGoal {
  validateGoalBudget(tokenBudget);
  assertGoalBudgetHost(tokenBudget);
  const now = goalClock.now();
  const goal: ActiveGoal = {
    id: goalClock.newId(), text, status: "active",
    startedAt: now, updatedAt: now, iteration: 0,
    tokenBudget, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: baseline,
    ...(tokenBudget === undefined ? {} : { budgetProgressCursor: "0" }),
    ...(planHandoffKey ? { planHandoffKey } : {}),
    ...(acceptance && acceptance.length > 0 ? { acceptance } : {}),
  };
  budgetSource.created(goal);
  return goal;
}

export function pauseGoal(goal: ActiveGoal, reason?: PauseReason): ActiveGoal {
  const { pauseReason: _pauseReason, ...rest } = goal;
  return { ...rest, status: "paused", ...(reason ? { pauseReason: reason } : {}), updatedAt: goalClock.now() };
}

export function activateResumedGoal(goal: ActiveGoal): ActiveGoal {
  return {
    ...goal,
    status: "active" as const,
    pauseReason: undefined,
    verificationFailures: 0,
    infraErrorStreak: 0,
    failStreak: 0,
    lastMissingEvidenceFingerprint: undefined,
    lastVerificationClassification: undefined,
    lowProgressCount: 0,
    prevTokensUsed: goal.tokensUsed,
    updatedAt: goalClock.now(),
  };
}

export function createWorkflowGoal(
  session: WorkflowSession,
  ctx: GoalContext,
  sessionGeneration: string | undefined,
  failedGate?: boolean,
): ActiveGoal {
  const blocked = failedGate ?? session.runs.flatMap((run) => run.gates)
    .some((gate) => gate.blocking && ["failed", "blocked"].includes(gate.status));
  const definition = session.definitionOfDone.trim();
  const objective = definition ? `${session.intent}\n\nDefinition of done: ${definition}` : session.intent;
  return {
    ...createGoal(objective, undefined, currentTokenTotal(ctx) ?? 0),
    workflowSessionId: session.sessionId,
    ...(sessionGeneration ? { workflowSessionGeneration: sessionGeneration } : {}),
    ...(blocked ? { status: "paused" as const, pauseReason: "gate" as const } : {}),
  };
}

export function increment(goal: ActiveGoal): ActiveGoal {
  return { ...goal, iteration: goal.iteration + 1, updatedAt: goalClock.now() };
}

export function updateUsage(goal: ActiveGoal, ctx: GoalContext) {
  const currentTokens = goal.tokenBudget === undefined ? currentTokenTotal(ctx) : undefined;
  if (goal.tokenBudget !== undefined) refreshGoalBudgetView(goal.id, ctx);
  if (goal.tokenBudget === undefined && currentTokens !== undefined) {
    goal.tokensUsed = Math.max(goal.tokensUsed, Math.max(0, currentTokens - goal.baselineTokens));
  }
  goal.timeUsedSeconds = Math.max(0, Math.floor((goalClock.now() - goal.startedAt) / 1000));
  goal.updatedAt = goalClock.now();
}

export function cancelContinuation() {
  if (goalState.continuationPending) {
    const marker = goalState.continuationPending.marker;
    if (!isWorkflowContinuationMarker(marker)) {
      goalState.consumeMarker(marker);
    }
  }
  goalState.setContinuationPending(undefined);
  goalState.setSuspendedContinuation(undefined);
}

export function clearContinuation() {
  goalState.setContinuationPending(undefined);
  goalState.setSuspendedContinuation(undefined);
  goalState.clearMarkers();
}

export function clearRecovery() { goalState.setGoalRecovery(undefined); }

export function clearRecoveryFor(id: string) { if (goalState.goalRecovery?.goalId === id) goalState.setGoalRecovery(undefined); }

export function clearElapsedTimer() { if (goalState.elapsedTimer) { goalClock.clearInterval(goalState.elapsedTimer); goalState.setElapsedTimer(undefined); } }

export function clearCompletionTimer() { if (goalState.completionTimer) { goalClock.clearTimeout(goalState.completionTimer); goalState.setCompletionTimer(undefined); } }

export function fenceGoalLifecycle(): void {
  goalState.setGoalLifecycleEpoch(goalState.goalLifecycleEpoch + 1);
  goalState.setVerificationInFlight(undefined);
  goalState.setGoalLoopOwner(undefined);
  goalState.setLatestGoalAttempt(undefined);
  clearCompletionTimer();
  cancelContinuation();
  clearRecovery();
}

export function restoreGoalSelection(ctx: GoalContext, fresh: boolean): void {
  if (fresh) { storage.setGoalRegistry([]); storage.setPendingTodoDetachGoalIds([]); storage.setActiveGoal(undefined); }
  else storage.setActiveGoal(loadGoalFromSession(ctx, goalState.goalSessionId));
  goalState.setStagedActiveGoal(undefined);
}

export function releaseGoalSelection(): void { storage.setActiveGoal(undefined); goalState.setStagedActiveGoal(undefined); }

export function isWorkflowContinuationMarker(marker: string): boolean { return marker.includes("maestro-workflow-continuation:"); }

/** The Host must prepare Task recovery only when a durable detach is pending. */
export function hasPendingGoalTodoDetachRecovery(): boolean { return goalState.pendingTodoDetachGoalIds.length > 0; }

/** Target-only cancellation: completed and unrelated Goal owners retain their handles. */
export function fenceTaskClear(ids:readonly string[]):void {
  if(goalState.activeGoal && goalState.activeGoal.status!=="done" && ids.includes(goalState.activeGoal.id))fenceGoalLifecycle();
}
