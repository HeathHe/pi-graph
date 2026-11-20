import { clearRequestDigest, pendingTaskClear, taskIsCleared, groupIsCleared, goalClearGeneration, validateClearHistory, type TaskClearRecord, type LoadedTaskClearEvidence } from "./task-clear.ts";
import { realpathSync } from "node:fs";
import { pendingPlanReplacement, replacementTaskBodyDigest, validateReplacementGroups, validateReplacementReceipt, validateReplacePlanInput, replacementRequestDigest, replacementEmbeddedStateDigest, assertTaskReplacementEligible, type PlanReplacementReceipt } from "./plan-replacement.ts";
import { configureTaskRestoration, observeTaskExecution as recordTaskExecution, taskReviewRequired, taskDependencySatisfied, initializeTaskContract, reconcileTaskContracts, configureTaskExecutionContracts, taskCriteria, taskContractDigest, assertTaskAcceptance, recheckTaskAcceptance, executionFingerprint, executionWitnessDigest, resetTaskExecutionObservations } from "./acceptance.ts";
import { TaskNativeRecovery } from "./native-recovery.ts";
import { newDeliveryGroup, readTaskHost, readApprovedTaskPlan, deliveryGroupDigest, type DeliveryGroup } from "./delivery-group.ts";
import { subscribeMaterialReviewInvalidation, issueMaterialReview, digest, invalidateMaterialReviews } from "../verification/material-review.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { captureTodoSourceScope, assertTodoSourceScope, readTodoSourceHost, readTodoSourceServices, registerTodoSourceProvider, subscribeTodoSourceInvalidation, withTodoSourceScope, type TodoSourceScope } from "pi-maestro-teammate/v1/todo-context";
import type { CanonicalTodoServices } from "./canonical-host.ts";
import { createTodoSourceOwner, TodoPublicationUnconfirmedError } from "./source-owner.ts";
import type { TaskProgressCommit } from "./dispatch-binding-versions.ts";
import { createTaskDispatchBinding } from "./dispatch-binding.ts";
import type { TaskWorkflowPorts } from "./ports.ts";
import { cloneTodoTask, cloneTaskMap, isValidTransition, applyTaskStatusTiming } from "./state.ts";
import { resolveBlockedByInState, deriveDependencyStatus, autoUnblock, hasCycle } from "./dependencies.ts";
import { autoCompletionPendingReason } from "./completion.ts";
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FlowToolResult } from "../tools/tool-result.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TodoSkillLoader } from "../skills/skill-loader.ts";
import type { TodoSkillBinding } from "../skills/skill-composer.ts";
import {
  type SkillRuntime,
  type AnySkillActivation,
  type SkillActivation,
  type SkillActivationMetadata,
} from "../skills/skill-runtime.ts";
import {
  todoOriginKey,
  type TodoMirrorTaskSpec,
  type TodoTaskOrigin,
} from "../session/types.ts";
import {
  appendTodoResourceUris,
  cloneTodoHandoff,
  normalizeTodoHandoff,
  normalizeTodoResourceUris,
  TODO_GET_FIELDS,
  TODO_GET_DEFAULT_LIMIT,
  TODO_GET_MAX_LIMIT,
  TODO_LIST_DEFAULT_LIMIT,
  TODO_LIST_MAX_LIMIT,
  type TodoGetField,
  type TodoAdvanceTransition,
  type TodoHandoff,
  type TodoHandoffInput,
  type TodoHandoffFileInput,
  type TodoUpdateField,
} from "../tools/todo-contract.ts";
import type { RunSkillInjection, TodoParamsInput } from "../tools/todo-skill-engine.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export * from "./types.ts";
import { ROOT_TODO_ACTOR, type TaskStatus, type TodoActorRef, type TodoTask, type TodoBatchSpec, type TodoUpdateSpec, type TodoParams, type TodoTaskSnapshot, type TodoResultDetails, type TodoCompactionSnapshot, type TodoMirrorReconcileResult, type TodoContext } from "./types.ts";
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tasks: Map<string, TodoTask> = new Map();
let deliveryGroups: DeliveryGroup[] = [];
let taskClearHistory: TaskClearRecord[] = [];
let taskClearEvidence: LoadedTaskClearEvidence = {pins:[]};
function pendingClearRecord():TaskClearRecord|undefined { return taskClearEvidence.pending?.intent.record ?? pendingTaskClear(taskClearHistory); }
function refreshClearEvidence():void { taskClearEvidence=ports.storage.refreshTaskClearEvidence(); }
let clearPublicationInFlight: import("../tools/todo-serialization.ts").TodoPublication | undefined;
export function hasPendingTaskClearRecovery(): boolean { return !!taskClearEvidence.pending || !!pendingTaskClear(taskClearHistory); }
export function isGoalTaskClearPending(id: string): boolean { return !!pendingClearRecord()?.goals.some(goal => goal.id === id); }
export function getGoalClearGeneration(id: string): string | undefined { if(!taskClearHistory.length)return undefined; assertTodoSourceExecution(); return goalClearGeneration(taskClearHistory, id); }
export function isDeliveryGroupCleared(id: string): boolean { return groupIsCleared(taskClearHistory, id); }
function currentTasks(state: ReadonlyMap<string, TodoTask> = tasks): Map<string, TodoTask> { return new Map([...state].filter(([id]) => !taskIsCleared(taskClearHistory, id))); }
function assertCurrentTask(task: TodoTask): void {
  assertNoPlanReplacement();
  if (taskIsCleared(taskClearHistory, task.id)) throw new Error("task-cleared: historical Task is read-only");
}
function autoUnblockCurrent(state: Map<string, TodoTask>, id: string): void {
  const current = currentTasks(state); autoUnblock(current, id); for (const [key, task] of current) state.set(key, task);
}
export function getDeliveryGroups(): DeliveryGroup[] { return structuredClone(deliveryGroups); }
export function hasPendingPlanReplacementRecovery(): boolean { return !!pendingPlanReplacement(deliveryGroups); }
export function isGoalPlanReplacementPending(id: string): boolean { return pendingPlanReplacement(deliveryGroups)?.parentGoal?.id === id; }
export function isGoalPlanExecutionHeld(id: string): boolean {
  if (isGoalPlanReplacementPending(id) || isGoalTaskClearPending(id)) return true;
  const group = deliveryGroups.find(group=>group.deliveryGoalId===id && !group.supersededBy);
  if (group && groupIsCleared(taskClearHistory, group.id)) return true;
  if (!group?.approvedPlan || !group.supersedes && !group.replacementHistory?.length) return false;
  try { nativeRecovery.assertApprovedPlan(group.approvedPlan); return false; } catch { return true; }
}
function assertNoPlanReplacement(): void { if (hasPendingTaskClearRecovery()) throw new Error("task-clear-pending: canonical reservation holds all Task mutations"); if (hasPendingPlanReplacementRecovery()) throw new Error("plan-replacement-pending: canonical reservation holds all Task mutations"); }
export function observeTaskExecution(value:unknown):void {recordTaskExecution(value);queueAcceptanceProjection();}
// Task ids are user-facing sequence numbers, so they start at 1 ("#1" is the first task).
let nextTaskId = 1;
let knownActors: Map<string, TodoActorRef> = new Map([[ROOT_TODO_ACTOR.id, ROOT_TODO_ACTOR]]);
let unavailableTodoActorIds = new Set<string>();
let extensionApi: ExtensionAPI | undefined;
let onTodoStateChanged: (() => void) | undefined;
const todoStateChangeSubscribers = new Set<() => void>();
let skillLoader: TodoSkillLoader | undefined;
let skillRuntime: SkillRuntime | undefined;
let activeSkillSnapshots: Map<string, SkillActivation> = new Map();
let runSkillInjection: RunSkillInjection | undefined;
let todoRevision = 0;
let todoGeneration = 0;
let todoSessionLoaded = false;
let todoMutationQueue: Promise<void> = Promise.resolve();
let loadedSourceExecution: TodoSourceExecution | undefined;
let todoHostContext: { cwd: string; sessionManager: unknown; sessionId?: string } | undefined;
const sourceOwner = createTodoSourceOwner();
const sourceExecution = new AsyncLocalStorage<TodoSourceExecution>();
let disposeTodoSourceRegistration: (() => void) | undefined;
function assertCanonicalServiceAccess(scope: TodoSourceScope, ctx: ExtensionContext): void {
  assertTodoSourceScope(scope);
  if (readTodoSourceServices(scope) !== canonicalTodoServices) throw new Error("Todo canonical service registration changed.");
  const host = readTodoSourceHost(scope);
  if (ctx.sessionManager !== host.manager || ctx.cwd !== host.cwd || ctx.sessionManager?.getSessionId?.() !== host.sessionId) {
    throw new Error("Todo canonical service caller does not own this source.");
  }
  assertCanonicalRootHost(ctx);
}
const canonicalTodoServices: CanonicalTodoServices = {
  version: 1,
  readTasks(scope, ctx) { assertCanonicalServiceAccess(scope, ctx); return getVisibleTasks(); },
  subscribe(scope, ctx, listener) {
    assertCanonicalServiceAccess(scope, ctx);
    return subscribeTodoStateChanges(() => { assertCanonicalServiceAccess(scope, ctx); listener(); });
  },
  listHandoff(scope, ctx) { assertCanonicalServiceAccess(scope, ctx); return listTodoHandoffAdviceTasks(ctx); },
  captureHandoff(scope, ctx, taskId) { assertCanonicalServiceAccess(scope, ctx); return captureTodoHandoffAdvice(ctx, taskId); },
  assertHandoff(scope, ctx, snapshot) { assertCanonicalServiceAccess(scope, ctx); assertTodoHandoffAdviceCurrent(ctx, snapshot); },
  applyHandoff(scope, ctx, snapshot, files, assertAuthorizedCurrent) {
    assertCanonicalServiceAccess(scope, ctx);
    return withTodoSourceScope(scope, () => applyTodoHandoffAdviceCAS(ctx, snapshot, files, () => {
      assertCanonicalServiceAccess(scope, ctx);
      assertAuthorizedCurrent();
    }));
  },
};
const todoSourceProvider = {
  ...sourceOwner.provider,
  services: canonicalTodoServices,
  run<T>(lease: object, operation: () => T, scope: TodoSourceScope): T {
    sourceOwner.provider.assert(lease);
    const inherited = sourceExecution.getStore();
    if (inherited && inherited.sourceScope !== scope) throw new Error("Todo source context cannot be replaced during an operation.");
    return runTodoSourceExecution(inherited ?? Object.freeze({ sourceScope: scope }), operation);
  },
};

function releaseTodoSourceRegistration(): void {
  const dispose = disposeTodoSourceRegistration;
  disposeTodoSourceRegistration = undefined;
  dispose?.();
}
export interface TodoSourceExecution {
  readonly sourceScope: TodoSourceScope | undefined;
  readonly sourceUnavailableReason?: "missing-host" | "unavailable-source";
  readonly signal?: AbortSignal;
  readonly assertParentCurrent?: () => void;
}
/** Capture once at original admission, never again at a delayed queue body. */
export function captureTodoSourceExecution(ctx?: Pick<ExtensionContext, "cwd" | "sessionManager">, signal?: AbortSignal): TodoSourceExecution {
  const inherited = sourceExecution.getStore();
  if (inherited) return inherited;
  const manager = ctx === undefined ? todoHostContext?.sessionManager : ctx.sessionManager;
  const cwd = ctx === undefined ? todoHostContext?.cwd : ctx.cwd;
  let sessionId:string|undefined;
  try{sessionId=(manager as { getSessionId?: () => string } | undefined)?.getSessionId?.();}catch{/* canonical source unavailable only */}
  const sourceScope=manager && cwd && sessionId ? captureTodoSourceScope({manager:manager as object,cwd,sessionId}) : undefined;
  return Object.freeze({ sourceScope,
    ...(!sourceScope ? {sourceUnavailableReason:manager && cwd && sessionId ? "unavailable-source" as const : "missing-host" as const} : {}),
    ...(signal ? { signal } : {}) });
}
export function assertTodoSourceExecution(execution: TodoSourceExecution | undefined = sourceExecution.getStore()): void {
  if (!execution) execution = captureTodoSourceExecution(); // synchronous owner-only internal API
  if (execution.signal?.aborted) throw new Error("Todo request was cancelled.");
  execution.assertParentCurrent?.();
  if(!execution.sourceScope)throw new Error(`Canonical Todo source unavailable at admission: ${execution.sourceUnavailableReason??"unavailable-source"}.`);
  assertTodoSourceScope(execution.sourceScope);
  try { ports.storage.assertTaskClearEvidenceCurrent(); } catch(error) { invalidateTodoSource(); throw error; }
}
export function withTodoSourceExecution<T>(execution: TodoSourceExecution, work: () => T): T {
  return sourceExecution.run(execution, work);
}
export function runTodoSourceExecution<T>(execution: TodoSourceExecution, work: () => T): T {
  assertTodoSourceExecution(execution);
  return sourceExecution.run(execution, work);
}
function appendTodoEntry(type: string, data: unknown): void {
  const execution = sourceExecution.getStore() ?? captureTodoSourceExecution();
  sourceOwner.append(type, data, () => {
    if (!extensionApi?.appendEntry) throw new Error("Todo persistence unavailable.");
    extensionApi.appendEntry(type, data);
  }, () => assertTodoSourceExecution(execution));
  const own = handoffOwnCommits.get(execution);
  if (own?.publishing && type === ports.storage.TODO_STATE_ENTRY_TYPE) {
    const observed = digest(data);
    if (own.publishing.observedDigest !== undefined || observed !== own.publishing.expectedDigest) {
      throw new TodoPublicationUnconfirmedError("Handoff publication differs from its exact existing commit.");
    }
    const manager = todoHostContext?.sessionManager as { getBranch?: () => Array<{ id?: string; type?: string; customType?: string; data?: unknown }> } | undefined;
    const latest = manager?.getBranch?.().filter(entry => entry.type === "custom" && entry.customType === type).at(-1);
    if (!latest || typeof latest.id !== "string" || !latest.id || digest(latest.data) !== observed) {
      throw new TodoPublicationUnconfirmedError("Exact confirmed handoff entry is unavailable.");
    }
    // Reached only after original sourceOwner.append verified the real journal append.
    own.publishing.observedDigest = observed;
    own.publishing.observedEntryId = latest.id;
  }
}

const nativeRecovery=new TaskNativeRecovery({childModelUsageFacts: { read: (fact, request) => {
  if (!ports.childModelUsageFacts) throw new Error("Trusted child usage fact reader unavailable");
  return ports.childModelUsageFacts.read(fact, request);
} }, modelUsageFacts: { read: (fact, request, manager) => {
  if (!ports.modelUsageFacts) throw new Error("Trusted model usage fact reader unavailable");
  return ports.modelUsageFacts.read(fact, request, manager);
} },dataRoot:()=>{if(!ports.getAgentDataDir)throw new Error("Host agentDataDir resolver unavailable");return ports.getAgentDataDir();},
  assert:scope=>assertTodoSourceExecution(scope as TodoSourceExecution),tasks:()=>tasks,groups:()=>deliveryGroups,assertTask:assertCurrentTask,
  assertDispatch: token => dispatchBindings.provider.assertCurrent(token),
  subscribeTasks: listener => subscribeTodoStateChanges(listener),
  goalBudget: {
    available: () => ports.goals.budget !== undefined,
    view: id => ports.goals.getGoalById(id),
    capture: id => {
      if (!ports.goals.budget || !todoHostContext) throw new Error("Declared Goal budget source capability unavailable");
      return ports.goals.budget.capture(id, todoHostContext);
    },
    captureSelected: () => {
      if (!ports.goals.budget?.captureSelected || !todoHostContext) throw new Error("Parent Goal budget source unavailable");
      return ports.goals.budget.captureSelected(todoHostContext);
    },
    assertNone: source => {
      if (!ports.goals.budget?.assertNone) throw new Error("Parent Goal negative source unavailable");
      ports.goals.budget.assertNone(source);
    },
    read: (scope, phase) => {
      if (!ports.goals.budget) throw new Error("Declared Goal budget source capability unavailable");
      return ports.goals.budget.read(scope, phase);
    },
    assertCoverage: scope => ports.goals.budget?.assertCoverage?.(scope),
    subscribe: (scope, listener) => ports.goals.budget?.subscribe?.(scope, listener) ?? (() => {}),
    coverageInfo: scope => ports.goals.budget?.coverageInfo?.(scope) ?? { required: false },
    captureCoverageClose: () => {
      if (!todoHostContext) throw new Error("Coverage close has no loaded Task source");
      return ports.goals.budget?.captureCoverageClose?.(todoHostContext) ?? [];
    },
    restoredCoverage: () => {
      if (!todoHostContext) throw new Error("Coverage startup has no loaded Task source");
      return ports.goals.budget?.restoredCoverage?.(todoHostContext) ?? [];
    },
    adoptCoverage: verified => {
      if (!todoHostContext || !ports.goals.budget?.adoptCoverage) throw new Error("Original Goal coverage adoption port unavailable");
      ports.goals.budget.adoptCoverage(todoHostContext, verified);
    },
    initialHistory: scope => {
      if (!ports.goals.budget?.initialHistory) throw new Error("Goal history is unknown; continuous-birth coverage unavailable");
      return ports.goals.budget.initialHistory(scope);
    },
  },
  history:id=>ports.storage.readRecoveryTaskHistory({cwd:todoHostContext?.cwd??"",sessionManager:todoHostContext?.sessionManager,ui:{setStatus(){}}},id)});
export function getGoalBudgetConfigurationPort() { return nativeRecovery.budgetConfiguration; }
export function getGoalBudgetViewPort() { return nativeRecovery.budgetView; }
export function getGoalCoverageContinuityPort() { return nativeRecovery.coverageContinuity; }
export function getGoalModelBudgetPort(): import("../sdk-host/goal-budget-host.ts").GoalModelBudgetPort { return nativeRecovery.goalModelBudget; }
configureTaskRestoration(nativeRecovery);
const dispatchBindings=createTaskDispatchBinding({
  nativeRecovery:nativeRecovery.provider,
  assertBusinessTask: task => nativeRecovery.assertBusinessTask(task),
  source:{capture:()=>sourceExecution.getStore()??captureTodoSourceExecution(),
    assert:context=>{assertTodoSourceExecution(context as TodoSourceExecution);assertNoPlanReplacement();},
    assertFacts:context=>{const execution=context as TodoSourceExecution;if(!execution.sourceScope)throw new Error("Native recovery original source missing");assertTodoSourceScope(execution.sourceScope);assertNoPlanReplacement();},
    run:(context,work)=>runTodoSourceExecution(context as TodoSourceExecution,work),
    subscribe:(context,listener)=>subscribeTodoSourceInvalidation((context as TodoSourceExecution).sourceScope,listener)},
  recheckDependencies:(ids,current)=>{if(!todoHostContext)throw new Error("Task evidence host unavailable");return recheckDependencies(ids,todoHostContext,current);},
  state:()=>tasks,host:()=>todoHostContext,
  enqueue:work=>{const pending=todoMutationQueue.then(work,work);todoMutationQueue=pending.then(()=>undefined,()=>undefined);return pending;},
  commit:commitTodoState,
  subscribe:subscribeTodoStateChanges,
  persistedMatches:(data,state)=>ports.storage.matchesTodoStatePublication(data,state),
  append: appendTodoEntry,
});
configureTaskExecutionContracts((bindingId,taskId)=>dispatchBindings.readContract(bindingId,taskId),task=>dispatchBindings.noSubmissionWitness(task),id=>taskIsCleared(taskClearHistory,id)||hasPendingTaskClearRecovery()?undefined:tasks.get(id), task=>!taskIsCleared(taskClearHistory,task.id)&&!hasPendingTaskClearRecovery());
subscribeMaterialReviewInvalidation(queueAcceptanceProjection);
export function getTaskDispatchBindingProvider(){return dispatchBindings.provider;}


let ports: TaskWorkflowPorts;
/** Composition only: old facade and host bootstrap install existing owners, not new stores. */
export function configureTaskWorkflowPorts(value: TaskWorkflowPorts): void {
  if (ports && ports !== value) throw new Error("TaskWorkflow ports already configured");
  ports = value;
ports.storage.configureTodoSerialization({
  getExtensionApi: () => extensionApi,
  getTasks: () => tasks,
  getTodoGeneration: () => todoGeneration,
  appendEntry: appendTodoEntry,
  rootActor: ROOT_TODO_ACTOR,
  getDeliveryGroups: () => deliveryGroups,
  getTaskClearHistory: () => taskClearHistory,
  getCanonicalEntries: () => (todoHostContext?.sessionManager as {getBranch?: () => Array<{id?: string; type?: string; customType?: string; data?: unknown}>} | undefined)?.getBranch?.() ?? [],
});
ports.skills.configureTodoSkillEngine({
  getSkillRuntime: () => skillRuntime,
  getActiveSkillSnapshots: () => activeSkillSnapshots,
  getRunSkillInjection: () => runSkillInjection,
  setRunSkillInjection: (injection) => {
    runSkillInjection = injection;
  },
});

}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initTodo(pi: ExtensionAPI): void {
  extensionApi = pi;
}

/** Prepare the existing recovery owner before the Host applies pending Goal detaches.
 * This is a source-fenced readiness query, not a Task mutation or a dispatch. */
export async function readyTodoStateForGoalDetachRecovery(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): Promise<void> {
  const execution = captureTodoSourceExecution(ctx);
  assertTodoSourceExecution(execution);
  await withTodoSourceExecution(execution, async () => {
    try { await nativeRecovery.ready(); }
    finally { assertTodoSourceExecution(execution); }
  });
}

export function onSessionStart(ctx: TodoContext): void {
  releaseTodoSourceRegistration();
  const manager = ctx.sessionManager as { getSessionId?: () => string } | undefined;
  // Extension contexts have live getters. Capture immutable host scope, not ctx.
  todoHostContext = { cwd: ctx.cwd, sessionManager: manager, sessionId: manager?.getSessionId?.() };
  todoGeneration++;
  todoSessionLoaded = false;
  todoMutationQueue = Promise.resolve();
  skillLoader = ctx.skillLoader ?? ports.createSkillLoader(ctx.cwd);
  skillRuntime = ports.createSkillRuntime(skillLoader);
  activeSkillSnapshots = new Map();
  runSkillInjection = undefined;
  tasks = ports.storage.loadTasksFromSession(ctx);
  taskClearHistory = ports.storage.getLoadedTaskClearHistory();
  taskClearEvidence = ports.storage.getLoadedTaskClearEvidence();
  if(taskClearEvidence.pending)ports.goals.fenceTaskClear?.(taskClearEvidence.pending.intent.record.goals.map(goal=>goal.id));
  ports.storage.restoreTaskSubmissionMarkers(ctx,tasks);
  deliveryGroups = ports.storage.loadDeliveryGroupsFromSession(ctx);
  validateReplacementGroups(deliveryGroups, tasks);
  for (const group of deliveryGroups) for (const receipt of group.replacementHistory ?? []) {
    if (receipt.phase === "complete" && receipt.parentGoal) {
      if (!ports.goals.assertPlanReplacementHistory) throw new Error("Replacement historical Goal verification capability is required");
      ports.goals.assertPlanReplacementHistory(receipt, ctx);
    }
  }
  resetTaskExecutionObservations();
  invalidateMaterialReviews();
  const loadedManager = manager;
  const loadedCwd = ctx.cwd;
  const loadedSessionId = manager?.getSessionId?.() ?? "";
  const sourceAvailable=Boolean(manager && loadedCwd && loadedSessionId) && sourceOwner.load({ manager: manager as object, cwd: loadedCwd, sessionId: loadedSessionId },
    () => ctx.sessionManager === loadedManager && ctx.cwd === loadedCwd);
  if (!sourceAvailable) sourceOwner.invalidate();
  syncTodoRevision();
  syncTaskIdCounter();
  knownActors = new Map([[ROOT_TODO_ACTOR.id, cloneActor(ROOT_TODO_ACTOR)]]);
  unavailableTodoActorIds = new Set<string>();
  for (const task of tasks.values()) {
    rememberActor(task.createdBy);
    rememberActor(task.assignee);
  }
  todoSessionLoaded = sourceAvailable;
  dispatchBindings.reset();
  try {
    if (sourceAvailable) disposeTodoSourceRegistration = registerTodoSourceProvider(todoSourceProvider);
    loadedSourceExecution = sourceAvailable ? captureTodoSourceExecution() : undefined;
    if(loadedSourceExecution)nativeRecovery.load({cwd:loadedCwd,manager:manager as Parameters<TaskNativeRecovery["load"]>[0]["manager"],scope:loadedSourceExecution});
    queueAcceptanceProjection();
    markTodoChanged();
    ctx.ui.setStatus("todo", undefined);
  } catch (error) {
    releaseTodoSourceRegistration();
    sourceOwner.invalidate();
    loadedSourceExecution = undefined;
    todoSessionLoaded = false;
    throw error;
  }
}

export function invalidateTodoSource(): void { releaseTodoSourceRegistration(); sourceOwner.invalidate(); todoGeneration++; }
/** A normal compact may append to the same branch; it is not a navigation grant. */
export function refreshTodoSourceAfterCompact(ctx:TodoContext):void {
  const manager=ctx.sessionManager as {getSessionId?:()=>string}|undefined;
  const sessionId=manager?.getSessionId?.();
  if(manager && sessionId && sourceOwner.matchesLoaded({manager,cwd:ctx.cwd,sessionId}))return;
  onSessionStart(ctx);
}

export function onSessionShutdown(ctx: TodoContext): void {
  releaseTodoSourceRegistration();
  nativeRecovery.shutdown();
  sourceOwner.invalidate();
  loadedSourceExecution = undefined;
  todoHostContext = undefined;
  todoGeneration++;
  todoSessionLoaded = false;
  todoMutationQueue = Promise.resolve();
  tasks.clear();
  deliveryGroups = [];
  taskClearHistory = [];
  taskClearEvidence = {pins:[]};
  resetTaskExecutionObservations();
  invalidateMaterialReviews();
  dispatchBindings.reset();
  nextTaskId = 1;
  knownActors = new Map([[ROOT_TODO_ACTOR.id, cloneActor(ROOT_TODO_ACTOR)]]);
  unavailableTodoActorIds = new Set<string>();
  skillLoader = undefined;
  skillRuntime = undefined;
  activeSkillSnapshots.clear();
  runSkillInjection = undefined;
  markTodoChanged();
  ctx.ui.setStatus("todo", undefined);
}

export function isolateTodoForTeammateAttach(): void {
  assertTodoSourceExecution();
  let changed = false;
  const next = new Map(tasks);
  for (const [id, task] of next) {
    if (taskIsCleared(taskClearHistory,task.id) || task.status !== "in_progress" || task.assignee.id !== ROOT_TODO_ACTOR.id || task.skills.length === 0) continue;
    next.set(id, {
      ...task,
      status: "pending",
      skillActivation: undefined,
      updatedAt: Date.now(),
    });
    changed = true;
  }
  if (!changed) return;
  commitTodoState(next);
  activeSkillSnapshots.clear();
  runSkillInjection = undefined;
}

export function getVisibleTasks(): TodoTask[] {
  const visible = [...currentTasks().values()].filter((t) => t.status !== "deleted");
  visible.sort((a, b) => a.createdAt - b.createdAt);
  return visible.map(task=>({...cloneTodoTask(task),...(taskReviewRequired(task)?{reviewRequired:true}:{reviewRequired:undefined})}));
}

export function getTodoActors(): TodoActorRef[] {
  return [...knownActors.values()].map(cloneActor).sort((left, right) =>
    left.kind === right.kind ? left.label.localeCompare(right.label) : left.kind === "root" ? -1 : 1
  );
}

export function registerTodoActor(actor: TodoActorRef): void {
  rememberActor(actor);
  unavailableTodoActorIds.delete(actor.id);
}

export function recordTodoActorCompletion(actor: TodoActorRef, wakeable: boolean): void {
  rememberActor(actor);
  if (wakeable) unavailableTodoActorIds.delete(actor.id);
  else unavailableTodoActorIds.add(actor.id);
}

export function formatTodoActorSelector(
  actor: { id: string; label: string },
  actors: readonly { id: string; label: string }[],
): string {
  const collidingIds = new Set(actors
    .filter((candidate) => candidate.label === actor.label)
    .map((candidate) => candidate.id));
  if (collidingIds.size < 2) return actor.label;
  for (let length = Math.min(4, actor.id.length); length < actor.id.length; length++) {
    const prefix = actor.id.slice(0, length);
    if ([...collidingIds].every((candidate) => candidate === actor.id || !candidate.startsWith(prefix))) {
      return `${actor.label}#${prefix}`;
    }
  }
  return `${actor.label}#${actor.id}`;
}

/**
 * Internal projection boundary. Canonical Session/Run state is authoritative;
 * this function never writes canonical files and is intentionally not exposed
 * as a public Todo tool action.
 */
export function reconcileMirrorTasks(
  specs: readonly TodoMirrorTaskSpec[],
  ctx: ExtensionContext,
  sessionGeneration?: string,
): TodoMirrorReconcileResult {
  assertTodoSourceExecution();
  assertNoPlanReplacement();
  const activeSpecs = specs.filter((spec) => spec.status === "in_progress");
  if (activeSpecs.length > 1) {
    throw new Error(`Canonical projection has ${activeSpecs.length} active Todo tasks; expected at most one`);
  }

  const result: TodoMirrorReconcileResult = { created: [], updated: [], tombstoned: [], unchanged: [] };
  const nextTasks = cloneTaskMap(tasks);
  const skillSnapshotsToClear = new Set<string>();
  const existingByOrigin = new Map<string, TodoTask>();
  for (const task of nextTasks.values()) {
    if (task.origin) existingByOrigin.set(todoOriginKey(task.origin), task);
  }

  const projectedSpecs = specs.map((spec) => {
    const origin = sessionGeneration === undefined
      ? { ...spec.origin }
      : { ...spec.origin, sessionGeneration };
    return { spec, origin, sourceOriginKey: todoOriginKey(spec.origin) };
  });
  const idsByOrigin = new Map<string, string>();
  const idsByOriginReference = new Map<string, string>();
  for (const projected of projectedSpecs) {
    const key = todoOriginKey(projected.origin);
    const id = existingByOrigin.get(key)?.id ?? mirrorTaskId(key);
    idsByOrigin.set(key, id);
    idsByOriginReference.set(projected.sourceOriginKey, id);
    idsByOriginReference.set(key, id);
  }
  const desiredKeys = new Set(idsByOrigin.keys());
  const incomingSessions = new Set(projectedSpecs.map(({ origin }) => origin.sessionId));
  const authoritativeProjection = sessionGeneration !== undefined;

  for (const { spec, origin, sourceOriginKey } of projectedSpecs) {
    const key = todoOriginKey(origin);
    const existing = existingByOrigin.get(key);
    if (existing && (taskIsCleared(taskClearHistory,existing.id) || existing.status === "deleted")) {
      result.unchanged.push(existing.id);
      continue;
    }
    const id = uniqueMirrorId(idsByOrigin.get(key)!, key, nextTasks);
    idsByOrigin.set(key, id);
    idsByOriginReference.set(sourceOriginKey, id);
    idsByOriginReference.set(key, id);
    const blockedBy = spec.blockedByOriginKeys
      .map((originKey) => idsByOriginReference.get(originKey))
      .filter((value): value is string => Boolean(value));
    const now = Date.now();
    const next: TodoTask = {
      id,
      subject: spec.subject,
      ...(spec.description ? { description: spec.description } : {}),
      status: blockedBy.length > 0 && spec.status === "pending" ? "blocked" : spec.status,
      blockedBy,
      ...(spec.context ? { context: spec.context } : {}),
      // Workflow mirrors do not own completion resources or handoff annotations;
      // preserve local values already attached to an existing mirror task.
      resourceUris: existing?.resourceUris ? [...existing.resourceUris] : [],
      ...(existing?.handoff ? { handoff: cloneTodoHandoff(existing.handoff) } : {}),
      skills: spec.skills.map((skill) => ({ ...skill })),
      ...(spec.summary ? { summary: spec.summary } : {}),
      origin,
      createdBy: cloneActor(ROOT_TODO_ACTOR),
      assignee: cloneActor(ROOT_TODO_ACTOR),
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
      ...(existing?.activeStartedAt !== undefined && spec.status === "in_progress"
        ? { activeStartedAt: existing.activeStartedAt }
        : {}),
      ...(existing?.activeDurationMs !== undefined
        ? { activeDurationMs: existing.activeDurationMs }
        : {}),
      ...(existing?.completedAt !== undefined && spec.status === "completed"
        ? { completedAt: existing.completedAt }
        : {}),
    };
    if (existing?.skillActivation && mirrorActivationStillValid(existing, next)) {
      next.skillActivation = cloneSkillActivation(existing.skillActivation);
    }
    if (!existing) {
      nextTasks.set(id, next);
      result.created.push(id);
      continue;
    }
    if (taskChanged(existing, next)) {
      next.updatedAt = now;
      nextTasks.set(existing.id, { ...next, id: existing.id });
      skillSnapshotsToClear.add(existing.id);
      result.updated.push(existing.id);
    } else {
      result.unchanged.push(existing.id);
    }
  }

  for (const task of nextTasks.values()) {
    if (!task.origin || taskIsCleared(taskClearHistory,task.id)) continue;
    const key = todoOriginKey(task.origin);
    const belongsToUpdatedProjection = authoritativeProjection
      ? true
      : incomingSessions.has(task.origin.sessionId);
    if (!belongsToUpdatedProjection || desiredKeys.has(key) || task.status === "deleted") continue;
    task.status = "deleted";
    task.updatedAt = Date.now();
    skillSnapshotsToClear.add(task.id);
    result.tombstoned.push(task.id);
  }

  if (result.created.length || result.updated.length || result.tombstoned.length) {
    commitTodoState(nextTasks);
    ports.skills.clearCommittedSkillSnapshots(skillSnapshotsToClear);
  }
  return result;
}

/** Return a detached Todo snapshot suitable for compaction metadata and prompts. */
export function getTodoCompactionSnapshot(): TodoCompactionSnapshot {
  const visible = getVisibleTasks().map(cloneTodoTask);
  const activeTask = visible
    .filter((task) => task.status === "in_progress" && !task.supersessionId && !task.replacementPendingId)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  return {
    stateVersion: ports.storage.TODO_STATE_VERSION,
    revision: todoRevision,
    ...(activeTask ? { activeTaskId: activeTask.id } : {}),
    tasks: visible,
  };
}

/** Turn-start housekeeping: drop the skill injection record when no task needs it. */
export function onBeforeAgentStartTodo(): void {
  const active = findActiveTask(ROOT_TODO_ACTOR.id);
  if (!active || active.skills.length === 0) {
    runSkillInjection = undefined;
  }
}

export async function onContextTodo(
  messages: AgentMessage[],
  execution: TodoSourceExecution = captureTodoSourceExecution(),
): Promise<{ messages: AgentMessage[] } | undefined> {
  return withTodoSourceExecution(execution, async () => {
  try {
  assertTodoSourceExecution();
  const active = findActiveTask(ROOT_TODO_ACTOR.id);
  if (!active || active.skills.length === 0) return undefined;
  const activation = await guardTodoAwait(ensureSkillActivation(active));
  if (runSkillInjection?.taskId !== active.id
    || runSkillInjection.stackRevision !== activation.stackRevision) {
    runSkillInjection = {
      taskId: active.id,
      stackRevision: activation.stackRevision,
      anchor: ports.skills.createContextInjectionAnchor(messages),
    };
  }
  const anchor = ports.skills.resolveContextInjectionAnchor(messages, runSkillInjection.anchor);
  runSkillInjection.anchor = anchor;
  const injected = ports.skills.createActiveSkillMessage(active, activation);
  return {
    messages: [
      ...messages.slice(0, anchor.index),
      injected,
      ...messages.slice(anchor.index),
    ],
  };

  } catch (error) { return undefined; }
  });
}

export function onAgentEndTodo(): void {
  runSkillInjection = undefined;
}

export async function executeTodo(
  input: TodoParamsInput,
  ctx: ExtensionContext,
  actor: TodoActorRef = ROOT_TODO_ACTOR,
  execution: TodoSourceExecution = sourceExecution.getStore() ?? captureTodoSourceExecution(ctx),
): Promise<FlowToolResult> {
  if(Object.keys(input).some(key=>["taskClearHistory","taskClearWitness","taskClearRecord","nativeWitnessId","clearReceipt","witness","receipt","archived","archivedTaskIds","clearGeneration","clearId"].includes(key)))return err("Caller clear authority is forbidden",input.action);
  if(input.includeHistory!==undefined && (input.action!=="list" || typeof input.includeHistory!=="boolean") || input.atClear!==undefined && (input.action!=="get" || typeof input.atClear!=="string" || !input.atClear))return err("Invalid history query",input.action);
  return enqueueTodo(structuredClone(input), ctx, cloneActor(actor), false, execution);
}

async function enqueueTodo(input: TodoParamsInput, ctx: ExtensionContext, actor: TodoActorRef, automaticCompletion: boolean, execution: TodoSourceExecution = sourceExecution.getStore() ?? captureTodoSourceExecution(ctx)): Promise<FlowToolResult> {
  try { assertTodoSourceExecution(execution); if (ports.storage.isTodoMutation(input.action)) assertNoPlanReplacement(); } catch (error) { return err(String(error), input.action); }
  // Gate the explicit transition before entering the serialized mutation
  // queue. A disabled request must not mutate Todo state or schedule any
  // future context reset.
  if ((input.action === "advance" || input.action === "update")
    && input.transition === "new_context"
    && !ports.compaction.isNewContextCompactionEnabled(ctx.cwd)) {
    return err(ports.compaction.NEW_CONTEXT_DISABLED_MESSAGE, input.action);
  }
  const generation = todoGeneration;
  const execute = async () => {
    try { return await guardTodoAwait(runTodoSourceExecution(execution, async () => {
    if(ports.storage.isTodoMutation(input.action)){assertNoPlanReplacement();if(input.action!=="clear")await nativeRecovery.ready();assertTodoSourceExecution(execution);}
    if (automaticCompletion) {
      try { ports.storage.assertTodoGeneration(generation); }
      catch (error) { return err(error instanceof Error ? error.message : String(error), "update"); }
      const current = input.id ? tasks.get(input.id) : undefined;
      if (!current || taskIsCleared(taskClearHistory,current.id) || current.status !== "in_progress" || current.assignee.id !== actor.id) return err("pending-review: task ownership/status changed before automatic completion", "update");
      const reason = autoCompletionPendingReason(current, current.goalId ? ports.goals.getGoalById(current.goalId) : undefined);
      if (reason) return err(reason, "update", [current.id]);
    }
    return executeTodoAction(input, ctx, automaticCompletion ? ROOT_TODO_ACTOR : actor, generation);
    })); } catch (error) { return err(String(error), input.action); }
  };
  if (!ports.storage.isTodoMutation(input.action)) return execute();

  const result = todoMutationQueue.then(execute, execute);
  todoMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Opaque, process-local host snapshot; not a model tool parameter. */
export interface TodoHandoffAdviceSnapshot {
  readonly task: TodoTask;
  readonly revision: number;
}

interface HandoffAdviceFence {
  generation: number;
  revision: number;
  cwd: string;
  sessionId: string;
  sessionManager: ExtensionContext["sessionManager"];
  fingerprint: string;
  taskId: string;
}
const handoffAdviceFences = new WeakMap<TodoHandoffAdviceSnapshot, HandoffAdviceFence>();

interface HandoffOwnCommit {
  readonly snapshot: TodoHandoffAdviceSnapshot;
  readonly sourceScope: TodoSourceScope | undefined;
  readonly taskId: string;
  readonly generation: number;
  readonly patchDigest: string;
  publishing?: { readonly expectedDigest: string; observedDigest?: string; observedEntryId?: string };
  confirmed?: {
    readonly revision: number;
    readonly publicationDigest: string;
    readonly publicationEntryId: string;
    readonly taskFingerprint: string;
    readonly stateFingerprint: string;
    readonly groupsFingerprint: string;
  };
}
// Bookkeeping for one existing CAS invocation, never a source/approval issuer.
const handoffOwnCommits = new WeakMap<TodoSourceExecution, HandoffOwnCommit>();


function assertCanonicalRootHost(ctx: ExtensionContext): string {
  const sessionId = ctx.sessionManager?.getSessionId();
  if (!todoSessionLoaded || !todoHostContext || !sessionId
    || ctx.cwd !== todoHostContext.cwd || sessionId !== todoHostContext.sessionId
    || ctx.sessionManager !== todoHostContext.sessionManager
    || process.env.PI_TEAMMATE_CHILD === "1") {
    throw new Error("Handoff advice requires the current canonical root Todo host/session/workspace.");
  }
  return sessionId;
}

function assertHandoffAdviceHost(ctx: ExtensionContext): string {
  const sessionId = assertCanonicalRootHost(ctx);
  if (process.env.PI_TEAMMATE_MANAGED_WINDOW === "1") {
    throw new Error("Handoff advice requires the current canonical root Todo host/session/workspace.");
  }
  return sessionId;
}

/** List only locally canonical root-owned tasks, detached from live state. */
export function listTodoHandoffAdviceTasks(ctx: ExtensionContext): TodoTask[] {
  assertHandoffAdviceHost(ctx);
  return getVisibleTasks().filter((task) => task.assignee.kind === "root"
    && task.assignee.id === ROOT_TODO_ACTOR.id && !task.origin).map(cloneTodoTask);
}

export function captureTodoHandoffAdvice(ctx: ExtensionContext, taskId: string): TodoHandoffAdviceSnapshot {
  const sessionId = assertHandoffAdviceHost(ctx);
  const task = listTodoHandoffAdviceTasks(ctx).find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task #${taskId} is not a canonical root-owned Todo.`);
  const snapshot = { task, revision: todoRevision };
  handoffAdviceFences.set(snapshot, {
    generation: todoGeneration, revision: todoRevision, cwd: ctx.cwd, sessionId,
    sessionManager: ctx.sessionManager, fingerprint: JSON.stringify(task), taskId,
  });
  return snapshot;
}

export function assertTodoHandoffAdviceCurrent(ctx: ExtensionContext, snapshot: TodoHandoffAdviceSnapshot): void {
  const fence = handoffAdviceFences.get(snapshot);
  const sessionId = assertHandoffAdviceHost(ctx);
  const task = fence && tasks.get(fence.taskId);
  const execution = sourceExecution.getStore();
  const own = execution && handoffOwnCommits.get(execution);
  if (own?.snapshot === snapshot && own.confirmed) {
    const manager = todoHostContext?.sessionManager as { getBranch?: () => Array<{ id?: string; type?: string; customType?: string; data?: unknown }> } | undefined;
    const latest = manager?.getBranch?.().filter(entry => entry.type === "custom" && entry.customType === ports.storage.TODO_STATE_ENTRY_TYPE).at(-1);
    if (!latest || latest.id !== own.confirmed.publicationEntryId || digest(latest.data) !== own.confirmed.publicationDigest) {
      throw new Error("Confirmed handoff publication changed; reconcile before continuing.");
    }
    if (!fence || !task || !execution?.sourceScope || execution.sourceScope !== own.sourceScope
      || own.taskId !== fence.taskId || own.generation !== fence.generation || todoGeneration !== fence.generation
      || fence.cwd !== ctx.cwd || fence.sessionId !== sessionId || fence.sessionManager !== ctx.sessionManager
      || task.origin || task.assignee.kind !== "root" || task.assignee.id !== ROOT_TODO_ACTOR.id
      || todoRevision !== own.confirmed.revision || JSON.stringify(task) !== own.confirmed.taskFingerprint
      || digest([...tasks]) !== own.confirmed.stateFingerprint || digest(deliveryGroups) !== own.confirmed.groupsFingerprint) {
      throw new Error("Todo changed after the confirmed handoff publication; reconcile before continuing.");
    }
    return;
  }
  if (!fence || fence.generation !== todoGeneration || fence.revision !== todoRevision
    || fence.cwd !== ctx.cwd || fence.sessionId !== sessionId || fence.sessionManager !== ctx.sessionManager
    || !task || task.origin || task.assignee.kind !== "root" || task.assignee.id !== ROOT_TODO_ACTOR.id
    || JSON.stringify(task) !== fence.fingerprint) {
    throw new Error("Todo changed; preview and confirm handoff advice again.");
  }
}

/** Trusted host-only CAS: the check and owner update share the real mutation queue. */
export function applyTodoHandoffAdviceCAS(
  ctx: ExtensionContext,
  snapshot: TodoHandoffAdviceSnapshot,
  files: readonly TodoHandoffFileInput[],
  assertAuthorizedCurrent: () => void,
): Promise<FlowToolResult> {
  // Detach at enqueue, so a caller cannot change a previously confirmed patch.
  const patch = files.map((file) => ({ ...file }));
  const inherited = captureTodoSourceExecution(ctx);
  const execution = Object.freeze({ ...inherited, assertParentCurrent: () => {
    inherited.assertParentCurrent?.();
    assertAuthorizedCurrent();
  } });
  const originalFence = handoffAdviceFences.get(snapshot);
  const own: HandoffOwnCommit = { snapshot, sourceScope: inherited.sourceScope,
    taskId: originalFence?.taskId ?? "", generation: originalFence?.generation ?? -1, patchDigest: digest(patch) };
  handoffOwnCommits.set(execution, own);
  const execute = async (): Promise<FlowToolResult> => {
    try {
      assertAuthorizedCurrent();
      assertTodoHandoffAdviceCurrent(ctx, snapshot);
      const fence = handoffAdviceFences.get(snapshot)!;
      const task = tasks.get(fence.taskId)!;
      if (!patch.length || new Set(patch.map((file) => file.path)).size !== patch.length
        || patch.some((file) => !task.handoff?.files.some((old) => old.path === file.path && old.value === "unknown")
          || !["required", "conditional", "skip"].includes(file.value)
          || (file.value === "conditional" && !file.when?.trim()))) {
        throw new Error("Advice may update only selected existing unknown annotations with concrete conditions.");
      }
      // No nested executeTodo enqueue: no interleaving after the CAS check.
      // Metadata-only owner update must not load skills or mutate activation.
      return await guardTodoAwait(executeTodoAction({ action: "update", id: fence.taskId,
        updateFields: ["handoff"], handoff: { files: patch } }, ctx, ROOT_TODO_ACTOR, fence.generation, true));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error), "update");
    } finally {
      handoffAdviceFences.delete(snapshot);
      handoffOwnCommits.delete(execution);
    }
  };
  const guarded = () => withTodoSourceExecution(execution, execute);
  const result = todoMutationQueue.then(guarded, guarded);
  todoMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Auto-delegation hook for `teammate:started` events that carry `todo`
 * bindings (tasks[].todo at dispatch time, single id or ordered array). Each
 * bound task's assignee moves from root to the agent, and the first runnable
 * one (priority order, pending and not blocked) is auto-activated so the
 * agent can drive it immediately without calling `todo next`.
 */
export interface TodoDelegationResult {
  /** Task ids whose assignee now is the agent. */
  delegated: string[];
  /** Task ids whose assignee was actually changed by this delegation. */
  reassigned: string[];
  /** Task ids auto-activated (at most one unless one was already active). */
  activated: string[];
  /** Human-readable errors for bindings that could not be delegated. */
  errors: string[];
}

/**
 * Delegate an ordered list of Todo tasks to an agent and auto-activate the
 * first runnable one. Blocked tasks keep their state (they auto-unblock when
 * the dependency completes); already-active tasks are preserved; if the agent
 * already holds an in_progress task, nothing new is activated (one
 * in_progress per actor).
 */
function markLegacyTaskSubmission(ids: readonly string[], execution: TodoSourceExecution): Promise<void> {
  const normalized=[...new Set(ids.map(id=>String(id).trim().replace(/^#+/,"")))];
  const pending=todoMutationQueue.then(()=>runTodoSourceExecution(execution,()=>{
    assertTodoSourceExecution();const next=cloneTaskMap(tasks);let changed=false;const submission=randomUUID();
    dispatchBindings.markSubmission(normalized);
    for(const id of normalized){const task=next.get(id);if(task&&task.status!=="deleted"){task.dispatchSubmissionId=submission;changed=true;}}
    if(changed)commitTodoState(next);
  }));
  todoMutationQueue=pending.then(()=>undefined,()=>undefined);return pending;
}

export async function delegateTodoTasksToAgent(
  todos: readonly string[],
  actor: TodoActorRef,
  ctx: ExtensionContext,
  execution: TodoSourceExecution = captureTodoSourceExecution(ctx),
): Promise<TodoDelegationResult> {
  return withTodoSourceExecution(execution, async () => {
  try {
  assertTodoSourceExecution();
  const delegated: string[] = [];
  const reassigned: string[] = [];
  const activated: string[] = [];
  const errors: string[] = [];
  if (todos.length === 0) return { delegated, reassigned, activated, errors };
  // Mirror the started-event listener: the agent's identity must be known to
  // the assignee selector before the update resolves `actor.id`.
  rememberActor(actor);
  await guardTodoAwait(markLegacyTaskSubmission(todos, execution));
  let alreadyActive = findActiveTask(actor.id) !== undefined;
  for (const raw of todos) {
    const trimmed = String(raw).trim();
    const id = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    if (!id) {
      errors.push("Todo delegation: empty task id.");
      continue;
    }
    const task = tasks.get(id);
    if (!task || task.status === "deleted") {
      errors.push(`Todo delegation: unknown task "${raw}"; no assignment performed.`);
      continue;
    }
    if (task.assignee.id !== actor.id) {
      const result = await guardTodoAwait(executeTodo(
        { action: "update", id, assignee: actor.id },
        ctx,
        ROOT_TODO_ACTOR,
      ));
      if (result.isError) {
        errors.push(`Todo delegation: task #${id} failed to reassign: ${result.content[0] && "text" in result.content[0] ? result.content[0].text : "unknown"}`);
        continue;
      }
      reassigned.push(id);
    }
    delegated.push(id);
  }
  // Auto-activate the highest-priority runnable task (first pending,
  // non-blocked binding). A task already in_progress counts as activated.
  for (const id of delegated) {
    const task = tasks.get(id);
    if (!task || task.status === "completed" || task.status === "deleted") continue;
    if (task.status === "in_progress") {
      activated.push(id);
      break;
    }
    if (task.status !== "pending" || task.blockedBy.length > 0) continue;
    if (alreadyActive) break;
    const result = await guardTodoAwait(executeTodo(
      { action: "update", id, status: "in_progress" },
      ctx,
      ROOT_TODO_ACTOR,
    ));
    if (!result.isError) {
      activated.push(id);
      alreadyActive = true;
    }
    break;
  }
  return { delegated, reassigned, activated, errors };

  } catch (error) { return {delegated:[],reassigned:[],activated:[],errors:[String(error)]}; }
  });
}

/**
 * Single-binding convenience wrapper over {@link delegateTodoTasksToAgent};
 * returns a FlowToolResult for callers that need one (e.g. tests).
 */
export async function delegateTodoTaskToAgent(
  taskId: string,
  actor: TodoActorRef,
  ctx: ExtensionContext,
): Promise<FlowToolResult> {
  const result = await guardTodoAwait(delegateTodoTasksToAgent([taskId], actor, ctx));
  if (result.errors.length > 0) return err(result.errors[0], "update");
  const id = result.delegated[0] ?? "";
  const task = tasks.get(id);
  if (task && result.reassigned.length === 0) {
    return ok(`Todo task #${id} already assigned to @${actor.label}${result.activated.length > 0 ? ` (active #${result.activated[0]})` : ""}.`, "update");
  }
  const extra = result.activated.length > 0
    ? `; activated #${result.activated[0]}`
    : task && task.status === "blocked" && task.blockedBy.length > 0
      ? ` (blocked by ${task.blockedBy.map((depId) => `#${depId}`).join(", ")}; auto-unblocks when the dependency completes)`
      : "";
  return ok(
    id
      ? `Todo task #${id} delegated to @${actor.label}${extra}.`
      : "Todo delegation: no task delegated.",
    "update",
  );
}

export interface TodoSealResult {
  /** Task ids auto-sealed to `completed` on a successful agent completion. */
  sealed: string[];
  /**
   * Tasks that should have been sealed but were rejected by the update path
   * (e.g. an unverified Goal quality gate). Surfaced so callers can notify
   * instead of leaving the task silently dangling in_progress.
   */
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Auto-seal hook for `teammate:complete`. On a clean agent exit (exitCode 0
 * and not cancelled), only tasks with an already-done Goal gate may be sealed.
 * Exit alone does not prove business acceptance: other active tasks remain
 * pending review and are returned in failed. Pending/blocked
 * tasks are left untouched (the agent never activated them), and failed or
 * cancelled runs leave everything as-is.
 */
export async function sealTodoTasksOnAgentComplete(
  actor: TodoActorRef,
  exitCode: number,
  cancelled: boolean,
  ctx: ExtensionContext,
  execution: TodoSourceExecution = captureTodoSourceExecution(ctx),
): Promise<TodoSealResult> {
  return withTodoSourceExecution(execution, async () => {
  try {
  assertTodoSourceExecution();
  const sealed: string[] = [];
  const failed: TodoSealResult["failed"] = [];
  if (exitCode !== 0 || cancelled) return { sealed, failed };
  const candidates = getVisibleTasks().filter(
    (task) => task.assignee.id === actor.id && task.status === "in_progress",
  );
  for (const task of candidates) {
    const result = await guardTodoAwait(enqueueTodo(
      {
        action: "update",
        id: task.id,
        status: "completed",
        summary: `Agent @${actor.label} finished (auto-sealed by teammate:complete)`,
      },
      ctx,
      actor,
      true,
    ));
    if (!result.isError) {
      sealed.push(task.id);
    } else {
      const reason = result.content[0] && "text" in result.content[0]
        ? result.content[0].text
        : "unknown error";
      failed.push({ id: task.id, reason });
    }
  }
  return { sealed, failed };

  } catch (error) { return {sealed:[],failed:[{id:"unknown",reason:String(error)}]}; }
  });
}

async function executeTodoAction(input: TodoParamsInput, ctx: ExtensionContext, actor: TodoActorRef, generation: number, handoffOnly = false): Promise<FlowToolResult> {
  try {
    assertTodoSourceExecution();
    const result = await guardTodoAwait(executeTodoActionUnchecked(input, ctx, actor, generation, handoffOnly));
    assertTodoSourceExecution(); // Includes read/get/no-op and error paths.
    return result;
  } catch (error) { if(error instanceof TodoPublicationUnconfirmedError)throw error;return err(`Todo source request failed: ${String(error)}`, input.action); }
}

async function executeTodoActionUnchecked(
  input: TodoParamsInput,
  ctx: ExtensionContext,
  actor: TodoActorRef,
  generation: number,
  handoffOnly = false,
): Promise<FlowToolResult> {
  const { action } = input;
  try {
    ports.storage.assertTodoGeneration(generation);
    rememberActor(actor);
    if (["acceptanceReport", "report", "taskInstanceId", "contractVersion", "contractDigest", "skipResolution", "deliveryGroupId", "dispatchSubmissionId", "replacementPendingId", "supersededByGroupId", "supersessionId", "replacementHistory", "planReplacementWitness", "planReplacementRecord", "nativeBefore", "contractEpoch", "planContractEpoch", "taskPublication", "goalPublication", "reservedIds", "allocatorHighWater"].some(key => key in input)) return err("Only the host may issue acceptance reports and contract identity.", action);
    const params = ports.skills.normalizeTodoParams(input);
    if (params.replacePlan) { validateReplacePlanInput(params.replacePlan); if (action !== "create" || actor.kind !== "root" || params.completeGroup !== true || !params.planHandoffKey || !params.tasks?.length) return err("Explicit replacement requires root create, completeGroup and approved whole batch.", action); }
    if ((params.review || params.restoreExecution || params.skip || params.deliveryGoalId || params.completeGroup) && actor.kind !== "root") return err("Only the canonical root may review evidence or declare a complete delivery group.", action);
    if(params.restoreExecution&&(action!=="update"||!params.review))return err("Explicit Root execution restoration requires update+original-material review.",action);
    if (action !== "get" && params.field !== undefined) {
      return err("field is only valid for get", action);
    }
    if (action !== "get" && action !== "list" && (params.offset !== undefined || params.limit !== undefined)) {
      return err("offset and limit are only valid for get or list", action);
    }
    if (params.transition !== undefined && action !== "advance" && action !== "update") {
      return err("transition is only valid for active completion-form advance or an active single-task update", action);
    }
    if (params.transition !== undefined
      && params.transition !== "keep_context"
      && params.transition !== "new_context") {
      return err(`Invalid Todo transition: ${String(params.transition)}`, action);
    }
    switch (action) {
      case "create":
        return await guardTodoAwait(handleCreate(params, ctx, actor));
      case "update":
        return await guardTodoAwait(handleUpdate(params, ctx, actor, generation, handoffOnly));
      case "list":
        return handleList(params, actor);
      case "get":
        return handleGet(params);
      case "delete":
        return handleDelete(params, ctx, actor);
      case "clear":
        return handleClear(ctx, actor);
      case "next":
        return await guardTodoAwait(handleNext(ctx, actor, generation));
      case "advance":
        return await guardTodoAwait(handleAdvance(params, ctx, actor, generation));
      default:
        return err(`Unknown action "${action}". Valid: create, update, list, get, delete, clear, next, advance`);
    }
  } catch (e) {
    if(e instanceof TodoPublicationUnconfirmedError)throw e;
    return err(`Error in todo ${action}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

async function handleCreate(params: TodoParams, ctx: ExtensionContext, actor: TodoActorRef): Promise<FlowToolResult> {
  // `status`/`summary` are update-only concepts. Silently dropping them here
  // would make a create that passes JSON Schema validation behave differently
  // than the caller intended.
  const rejected: string[] = [];
  if (params.status !== undefined) rejected.push("status");
  if (params.summary !== undefined) rejected.push("summary");
  if (rejected.length > 0) {
    return err(`create does not support ${rejected.join(" and ")}; they are set via update`, "create");
  }
  if (params.tasks && params.tasks.length > 0) {
    const conflicting: string[] = [];
    if (params.subject !== undefined) conflicting.push("subject");
    if (params.description !== undefined) conflicting.push("description");
    if (params.blockedBy !== undefined) conflicting.push("blockedBy");
    if (params.assignee !== undefined) conflicting.push("assignee");
    if (params.context !== undefined) conflicting.push("context");
    if (params.skills !== undefined) conflicting.push("skills");
    if (params.resourceUris !== undefined) conflicting.push("resourceUris");
    if (params.handoff !== undefined) conflicting.push("handoff");
    if (params.goalId !== undefined) conflicting.push("goalId");
    if (conflicting.length > 0) {
      return err(`create accepts either a single task (subject) or a batch (tasks), not both; ${conflicting.join(", ")} cannot accompany tasks.`, "create");
    }
    return handleBatchCreate(params.tasks, actor, ctx, params);
  }
  if (params.planHandoffKey || params.deliveryGoalId || params.completeGroup) return err("A complete delivery declaration requires one whole tasks batch.", "create");
  const subject = params.subject?.trim();
  if (!subject) return err("subject is required for create", "create");

  const allocationStart = nativeRecovery.selectFreshTaskIdStart(nextTaskId, 1);
  const id = String(allocationStart);
  const now = Date.now();

  const blockerResolution = resolveBlockedBy(id, params.blockedBy ?? []);
  if (blockerResolution.error) return err(blockerResolution.error, "create");
  const blockedBy = blockerResolution.blockedBy;
  const assignee = resolveAssignee(params.assignee, actor);
  if ("error" in assignee) return err(assignee.error, "create");
  const handoff = params.handoff === undefined
    ? undefined
    : normalizeTodoHandoff(params.handoff, undefined, todoRevision + 1);

  const task: TodoTask = {
    id,
    subject,
    ...(params.acceptanceCriteria ? { acceptanceCriteria: validateCriteria(params.acceptanceCriteria) } : {}),
    description: params.description,
    status: blockedBy.length > 0 ? "blocked" : "pending",
    blockedBy,
    contractDependencies:[...new Set((params.blockedBy??[]).map(id=>id.replace(/^#+/,"")))],
    skills: params.skills ?? [],
    resourceUris: normalizeTodoResourceUris(params.resourceUris),
    ...(handoff ? { handoff } : {}),
    ...(params.context ? { context: params.context } : {}),
    ...(params.planHandoffKey ? { planHandoffKey: params.planHandoffKey } : {}),
    ...(params.goalId ? { goalId: params.goalId } : {}),
    createdBy: cloneActor(actor),
    assignee: assignee.actor,
    createdAt: now,
    updatedAt: now,
  };

  if (hasCycle(id, blockedBy, currentTasks())) return err("blockedBy would create a dependency cycle", "create");

  const nextTasks = new Map(tasks);
  nextTasks.set(id, task);
  commitTodoState(nextTasks);
  commitTaskIds(allocationStart, 1);

  return ok(`Created ${todoIndexEntry(task)}`, "create", [id]);
}

/**
 * Create an entire multi-step plan in one call. Array order is the execution
 * order (monotonic createdAt); each blockedBy integer is a zero-based index
 * into this same batch. The whole batch commits atomically — any invalid
 * spec aborts the create without touching existing state.
 */
async function handleBatchCreate(specs: TodoBatchSpec[], actor: TodoActorRef, ctx: ExtensionContext, params: TodoParams): Promise<FlowToolResult> {
  const planHandoffKey = params.planHandoffKey;
  const grouped = Boolean(planHandoffKey || params.deliveryGoalId || params.completeGroup);
  const admittedState = digest([...tasks]);
  if (grouped && actor.kind !== "root") return err("Only the root may declare a complete delivery group.", "create");
  if (params.deliveryGoalId && (!ports.goals.getGoalById(params.deliveryGoalId) || ports.goals.getGoalById(params.deliveryGoalId)?.status === "done")) return err("Parent delivery Goal must exist and remain open.", "create");
  if (params.deliveryGoalId && deliveryGroups.some(group => group.deliveryGoalId === params.deliveryGoalId) && !params.replacePlan) return err("This Goal already has a complete delivery group; implicit replacement/supersession is not supported.", "create");
  if (planHandoffKey && !params.replacePlan && deliveryGroups.some(group=>group.approvedPlan && !group.supersededBy && group.deliveryGoalId===params.deliveryGoalId)) return err("This delivery target already has an approved execution group; explicit replacePlan is required.", "create");
  let approved: import("../tools/plan-store.ts").LoadedApprovedPlan | undefined;
  if (planHandoffKey) {
    approved = await guardTodoAwait((ports.readApprovedPlan ?? readApprovedTaskPlan)(ctx));
    assertTodoSourceExecution();
    if (approved.manifest.handoffKey !== planHandoffKey || approved.manifest.status !== "approved") return err("Current approved Plan does not match planHandoffKey.", "create");
    if (deliveryGroups.some(group => group.approvedPlan?.handoffKey === planHandoffKey)) return err("This approved Plan already has a complete execution group; do not replay its decomposition.", "create");
  }
  const nextTasks = cloneTaskMap(tasks);

  const allocationStart = nativeRecovery.selectFreshTaskIdStart(nextTaskId, specs.length);
  const ids: string[] = [];
  for (let i = 0; i < specs.length; i++) {
    ids.push(String(allocationStart + i));
  }

  const resolvedDeps: string[][] = [];
  for (let i = 0; i < specs.length; i++) {
    const deps: string[] = [];
    for (const index of specs[i].blockedBy ?? []) {
      if (!Number.isInteger(index) || index < 0) {
        return err(`tasks[${i}].blockedBy contains invalid batch index ${index}; indexes must be non-negative integers.`, "create");
      }
      if (index >= i) {
        const validRange = i === 0
          ? "tasks[0] cannot have dependencies because it has no earlier batch items"
          : `valid indexes for tasks[${i}] are 0 through ${i - 1}`;
        return err(
          `tasks[${i}].blockedBy index ${index} must reference an earlier batch item; ${validRange}.`,
          "create",
        );
      }
      deps.push(ids[index]);
    }
    resolvedDeps.push(deps);
  }

  const created: TodoTask[] = [];
  let clock = Date.now();
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const subject = spec.subject?.trim();
    if (!subject) return err(`tasks[${i}].subject is required`, "create");

    const blockerResolution = resolveBlockedBy(ids[i], resolvedDeps[i], nextTasks);
    if (blockerResolution.error) return err(`tasks[${i}]: ${blockerResolution.error}`, "create");
    const blockedBy = blockerResolution.blockedBy;

    const assignee = resolveAssignee(spec.assignee, actor);
    if ("error" in assignee) return err(`tasks[${i}]: ${assignee.error}`, "create");

    let skills: TodoSkillBinding[];
    let handoff: TodoHandoff | undefined;
    try {
      skills = spec.skills ? ports.skills.normalizeSkillBindings(spec.skills) : [];
      handoff = spec.handoff === undefined
        ? undefined
        : normalizeTodoHandoff(spec.handoff, undefined, todoRevision + 1);
    } catch (e) {
      return err(`tasks[${i}]: ${e instanceof Error ? e.message : String(e)}`, "create");
    }

    clock += 1;
    const task: TodoTask = {
      id: ids[i],
      subject,
      ...(spec.acceptanceCriteria ? { acceptanceCriteria: validateCriteria(spec.acceptanceCriteria) } : {}),
      description: spec.description,
      status: blockedBy.length > 0 ? "blocked" : "pending",
      blockedBy,
      contractDependencies:[...resolvedDeps[i]],
      skills,
      resourceUris: normalizeTodoResourceUris(spec.resourceUris),
      ...(handoff ? { handoff } : {}),
      ...(spec.context ? { context: spec.context } : {}),
      ...(planHandoffKey ? { planHandoffKey } : {}),
      ...(spec.goalId ? { goalId: spec.goalId } : {}),
      createdBy: cloneActor(actor),
      assignee: assignee.actor,
      createdAt: clock,
      updatedAt: clock,
    };
    nextTasks.set(ids[i], task);
    created.push(task);
  }

  let nextGroups = deliveryGroups;
  if (grouped) {
    for (const task of created) initializeTaskContract(task);
    const group = newDeliveryGroup(created, specs, readTaskHost(ctx), params.deliveryGoalId, approved);
    for (const task of created) { task.deliveryGroupId = group.id; task.deliveryGoalId = group.deliveryGoalId; task.contractDigest = taskContractDigest(task); }
    if (approved) {
      const fresh = await guardTodoAwait((ports.readApprovedPlan ?? readApprovedTaskPlan)(ctx));
      assertTodoSourceExecution();
      if (digest(fresh.manifest) !== digest(approved.manifest)) return err("Approved Plan changed during decomposition.", "create");
    }
    nextGroups = [...deliveryGroups, group];
  }
  if (digest([...tasks]) !== admittedState) return err("Task aggregate changed during delivery decomposition; reload before retrying.", "create");
  if (params.replacePlan) {
    await startPlanReplacement(params, nextTasks, nextGroups.at(-1)!, ctx);
    return ok("Plan replacement transaction completed or strictly aborted; inspect canonical deliveryGroups receipts.", "create");
  }
  commitTodoState(nextTasks, undefined, undefined, nextGroups);
  commitTaskIds(allocationStart, specs.length);

  const shown = created.slice(0, TODO_LIST_DEFAULT_LIMIT);
  const lines = shown.map((task) => todoIndexEntry(task));
  if (shown.length < created.length) {
    lines.push(`More created tasks: IDs #${created[shown.length]!.id} through #${created.at(-1)!.id}. Browse with todo {"action":"list"}, or get a task by id.`);
  }
  return ok(`Created ${created.length} tasks:\n${lines.join("\n")}`, "create", created.map((task) => task.id));
}

interface PreparedTodoUpdate {
  before: TodoTask;
  draft: TodoTask;
  activationInputsChanged: boolean;
  shouldActivate: boolean;
}

let replacementPublicationInFlight: import("../tools/todo-serialization.ts").TodoPublication | undefined;
function replacementState(receipt: PlanReplacementReceipt): { state: Map<string, TodoTask>; groups: DeliveryGroup[] } {
  const state = cloneTaskMap(tasks), groups = structuredClone(deliveryGroups);
  const group = groups.find(group => group.id === receipt.predecessor.groupId);
  if (!group) throw new Error("Replacement predecessor missing");
  const index = group.replacementHistory?.findIndex(item => item.id === receipt.id) ?? -1;
  if (index < 0) throw new Error("Replacement canonical receipt missing");
  group.replacementHistory![index] = structuredClone(receipt);
  if (receipt.phase === "complete" || receipt.phase === "aborted") delete group.currentPendingReplacementId;
  else group.currentPendingReplacementId = receipt.id;
  return { state, groups };
}
function assertReplacementPublication(publication: import("../tools/todo-serialization.ts").TodoPublication): void {
  const branch = (todoHostContext?.sessionManager as { getBranch(): {id?:string;type?:string;customType?:string;data?:unknown}[] }).getBranch();
  const latest = branch.filter(entry => entry.type === "custom" && entry.customType === ports.storage.TODO_STATE_ENTRY_TYPE).at(-1);
  if (!latest?.id || digest(latest.data) !== digest(publication.state)) throw new Error("Replacement canonical Task publication differs");
  const refs = new Map<string, unknown>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== ports.storage.TODO_CONTENT_ENTRY_TYPE) continue;
    const data = entry.data as {contents?:Record<string,unknown>} | undefined;
    if (data?.contents) for (const [ref, content] of Object.entries(data.contents)) if (ref in publication.contents) refs.set(ref, content);
  }
  for (const [ref, content] of Object.entries(publication.contents)) if (digest(content) !== ref || digest(refs.get(ref)) !== ref) throw new Error("Replacement canonical Task content differs");
}
/** Private phase writer: no caller force flag, no normal reconciliation or native transition. */
function publishReplacement(state: Map<string, TodoTask>, groups: DeliveryGroup[], guard: () => void): void {
  assertTodoSourceExecution(); guard(); validateReplacementGroups(groups, state); validateClearHistory(taskClearHistory,state,groups);
  const prepared = ports.storage.persist.prepare!(state, groups), pin = digest(prepared.publication);
  const generation = todoGeneration;
  try {
    guard(); replacementPublicationInFlight = prepared.publication; ports.storage.persist(cloneTaskMap(state), structuredClone(groups));
    if (digest(ports.storage.persist.prepare!(state, groups).publication) !== pin) throw new Error("Replacement publication changed during append");
    assertReplacementPublication(prepared.publication); guard(); ports.storage.assertTodoGeneration(generation); assertTodoSourceExecution();
    // This phase already proved its exact prepared state/groups and contents above.
    // Preserve the original dispatch owner/version history while advancing its journal pin.
    dispatchBindings.committed(tasks, state);
    tasks = cloneTaskMap(state); deliveryGroups = structuredClone(groups); syncTaskIdCounter();
  } catch (error) { invalidateTodoSource(); throw new TodoPublicationUnconfirmedError(error); }
  finally { replacementPublicationInFlight = undefined; }
  markTodoChanged();
  try { onTodoStateChanged?.(); } catch { /* projection cannot undo a durable publication */ }
}
async function startPlanReplacement(params: TodoParams, proposed: Map<string, TodoTask>, successor: DeliveryGroup, ctx: ExtensionContext): Promise<void> {
  const input = params.replacePlan!; validateReplacePlanInput(input); assertNoPlanReplacement();
  const missingCapabilities = [!ports.storage.persist.prepare && "storage.persist.prepare",
    ...(params.deliveryGoalId ? [!ports.goals.preparePlanReplacement && "goals.preparePlanReplacement", !ports.goals.rebindPlanReplacement && "goals.rebindPlanReplacement",
      !ports.goals.assertPlanReplacementPublication && "goals.assertPlanReplacementPublication", !ports.goals.assertPlanReplacementHistory && "goals.assertPlanReplacementHistory"] : [])].filter(Boolean);
  if (missingCapabilities.length) throw new Error(`Replacement capabilities unavailable: ${missingCapabilities.join(", ")}`);
  validateReplacementGroups(deliveryGroups, tasks);
  const old = deliveryGroups.find(group => group.id === input.expectedGroupId);
  const currentGroups = deliveryGroups.filter(group=>group.approvedPlan && !group.supersededBy && group.deliveryGoalId===params.deliveryGoalId);
  if (currentGroups.length !== 1 || currentGroups[0]?.id !== input.expectedGroupId) throw new Error("Replacement requires the unique current approved group for this delivery target");
  if (!old?.approvedPlan || old.supersededBy || old.currentPendingReplacementId || deliveryGroupDigest(old) !== input.expectedGroupDigest
    || old.approvedPlan.handoffKey !== input.expectedPlanHandoffKey || old.deliveryGoalId !== params.deliveryGoalId || !successor.approvedPlan
    || successor.approvedPlan.handoffKey === old.approvedPlan.handoffKey || successor.approvedPlan.revision <= old.approvedPlan.revision
    || old.source.cwd !== successor.source.cwd || old.source.sessionId !== successor.source.sessionId) throw new Error("Replacement expected current group/approval/source differs");
  const branch = ctx.sessionManager.getBranch();
  if (!branch.some(entry => entry.id === old.source.branchAnchor)) throw new Error("Replacement predecessor is on another branch");
  const members = old.members.map(member => {
    const task = tasks.get(member.taskId);
    if (!task || task.origin || task.taskInstanceId !== member.taskInstanceId || task.deliveryGroupId !== old.id) throw new Error("unsupported-scope: replacement requires complete local predecessor membership");
    assertTaskReplacementEligible(task); return task;
  });
  await guardTodoAwait(nativeRecovery.ready(true));
  const held = nativeRecovery.holdPlanReplacement();
  let reserved = false;
  try {
    const beforePin = digest([[...tasks], deliveryGroups]);
    const newTasks = successor.members.map(member => proposed.get(member.taskId)!);
    const parentGoal = params.deliveryGoalId ? ports.goals.preparePlanReplacement!(params.deliveryGoalId, ctx) : undefined;
    const receipt: PlanReplacementReceipt = { version: 1, id: randomUUID(), phase: "reserved",
      source: { workspace: realpathSync(old.source.cwd), sessionId: old.source.sessionId, predecessorAnchor: readTaskHost(ctx).branchAnchor, prefixIdentityHashes: ctx.sessionManager.getBranch().map(entry=>digest({id:entry.id,parentId:entry.parentId,type:entry.type,customType:"customType" in entry ? entry.customType : undefined})) },
      predecessor: { groupId: old.id, groupDigest: deliveryGroupDigest(old), plan: structuredClone(old.approvedPlan) },
      successor: { groupId: successor.id, plan: structuredClone(successor.approvedPlan) }, ...(parentGoal ? {parentGoal} : {}),
      reason: input.reason.trim(), createdAt: Date.now(), requestDigest: "", reservedIds: newTasks.map(task => task.id),
      allocatorHighWater: Math.max(nextTaskId - 1, ...newTasks.map(task => Number(task.id))),
      nativeBefore: held.sample([...members.map(task => task.id), ...newTasks.map(task => task.id)]),
      request: { newTasks: structuredClone(newTasks), newGroup: structuredClone(successor), oldTaskPins: members.map(task => ({
        id: task.id, instanceId: task.taskInstanceId!, version: task.contractVersion!, digest: task.contractDigest!, bodyDigest: replacementTaskBodyDigest(task) })) } };
    receipt.requestDigest = replacementRequestDigest(receipt); validateReplacementReceipt(receipt);
    const approved = await guardTodoAwait((ports.readApprovedPlan ?? readApprovedTaskPlan)(ctx));
    if (approved.manifest.handoffKey !== receipt.successor.plan.handoffKey || approved.manifest.revision !== receipt.successor.plan.revision || approved.manifest.approvedChecksum !== receipt.successor.plan.checksum) throw new Error("Approved Plan changed before reservation");
    const state = cloneTaskMap(tasks), groups = structuredClone(deliveryGroups), predecessor = groups.find(group => group.id === old.id)!;
    predecessor.replacementHistory = [...predecessor.replacementHistory ?? [], receipt]; predecessor.currentPendingReplacementId = receipt.id;
    for (const task of members) state.get(task.id)!.replacementPendingId = receipt.id;
    const guard = () => { assertTodoSourceExecution(); assertReplacementOriginalPrefix(receipt); nativeRecovery.assertApprovedPlan(receipt.successor.plan); held.assertBefore(receipt.nativeBefore); if (digest([[...tasks], deliveryGroups]) !== beforePin) throw new Error("Replacement aggregate changed before reservation");
      if (parentGoal && digest(ports.goals.preparePlanReplacement!(parentGoal.id, ctx)) !== digest(parentGoal)) throw new Error("Replacement Goal changed before reservation"); };
    publishReplacement(state, groups, guard); reserved = true;
  } finally { held.release(); }
  if (reserved) await resumePlanReplacement(ctx);
}
function assertReplacementOriginalPrefix(receipt: PlanReplacementReceipt): void {
  const manager = todoHostContext?.sessionManager as {getBranch():{id?:string;parentId?:string|null;type?:string;customType?:string}[]};
  const branch = manager.getBranch(), prefix = receipt.source.prefixIdentityHashes;
  if (branch.length < prefix.length || branch[prefix.length-1]?.id !== receipt.source.predecessorAnchor
    || branch.slice(0,prefix.length).some((entry,i)=>digest({id:entry.id,parentId:entry.parentId,type:entry.type,customType:entry.customType})!==prefix[i])) throw new Error("Replacement original canonical prefix changed");
}
function exactPendingReceipt(receipt: PlanReplacementReceipt): void {
  assertReplacementOriginalPrefix(receipt);
  assertTodoSourceExecution(); const current = pendingPlanReplacement(deliveryGroups);
  const manager = todoHostContext?.sessionManager as {getSessionId():string;getBranch():{id?:string}[]};
  const branch = manager.getBranch(), predecessor = deliveryGroups.find(group=>group.id===receipt.predecessor.groupId);
  if (!todoHostContext || realpathSync(todoHostContext.cwd) !== receipt.source.workspace || manager.getSessionId() !== receipt.source.sessionId
    || !branch.some(entry=>entry.id===receipt.source.predecessorAnchor) || !predecessor
    || [predecessor, receipt.request.newGroup].some(group=>realpathSync(group.source.cwd)!==receipt.source.workspace || group.source.sessionId!==receipt.source.sessionId || !branch.some(entry=>entry.id===group.source.branchAnchor))) throw new Error("Replacement original workspace/session/branch source differs");
  if (!current || digest(current) !== digest(receipt)) throw new Error("Replacement canonical receipt changed");
  assertReplacementPublication(replacementPublicationInFlight ?? ports.storage.persist.prepare!(tasks, deliveryGroups).publication);
}
function buildReplacementTasks(receipt: PlanReplacementReceipt, witnessId: string) {
  const published = structuredClone(receipt); published.phase = "tasks-published";
  const { state, groups } = replacementState(published), old = groups.find(group => group.id === receipt.predecessor.groupId)!;
  old.supersededBy = { replacementId: receipt.id, groupId: receipt.successor.groupId };
  const successor = structuredClone(receipt.request.newGroup); successor.supersedes = { replacementId: receipt.id, groupId: old.id }; groups.push(successor);
  for (const pin of receipt.request.oldTaskPins) {
    const task = state.get(pin.id)!; task.supersessionId = receipt.id; task.supersededByGroupId = successor.id;
  }
  for (const task of receipt.request.newTasks) state.set(task.id, { ...structuredClone(task), replacementPendingId: receipt.id });
  reconcileTaskContracts(tasks, state, { receipt, assertCurrent: () => exactPendingReceipt(receipt) });
  const updated = old.replacementHistory!.find(item => item.id === receipt.id)!;
  updated.taskPublication = { witnessId, newGroupDigest: deliveryGroupDigest(successor), stateDigest: "" };
  updated.taskPublication.stateDigest = replacementEmbeddedStateDigest(ports.storage.persist.prepare!(state, groups).publication.state, receipt.id);
  return { state, groups };
}
async function resumePlanReplacement(ctx: ExtensionContext, deferResume = false): Promise<void> {
  let receipt = pendingPlanReplacement(deliveryGroups); if (!receipt) return;
  if (!ports.storage.persist.prepare) throw new Error("Replacement exact storage unavailable");
  exactPendingReceipt(receipt);
  await guardTodoAwait(nativeRecovery.ready(true));
  const held = nativeRecovery.holdPlanReplacement();
  try {
    exactPendingReceipt(receipt);
    const witness = held.readAfter(receipt);
    if (receipt.phase === "reserved") {
      if (!witness) {
        let approved = false;
        try { const plan = await guardTodoAwait((ports.readApprovedPlan ?? readApprovedTaskPlan)(ctx)); approved = plan.manifest.handoffKey === receipt.successor.plan.handoffKey && plan.manifest.revision === receipt.successor.plan.revision && plan.manifest.approvedChecksum === receipt.successor.plan.checksum; }
        catch { assertTodoSourceExecution(); }
        if (!approved) {
          const aborted = structuredClone(receipt); aborted.phase = "aborted"; aborted.abort = { reason: "current-approved-plan-mismatch", nativeBeforeDigest: digest(receipt.nativeBefore) };
          const { state, groups } = replacementState(aborted);
          for (const pin of receipt.request.oldTaskPins) delete state.get(pin.id)!.replacementPendingId;
          publishReplacement(state, groups, () => { exactPendingReceipt(receipt!); held.assertBefore(receipt!.nativeBefore); }); return;
        }
      }
      const next = buildReplacementTasks(receipt, witness?.id ?? held.witnessId);
      const prepared = ports.storage.persist.prepare(next.state, next.groups);
      const authority = witness ?? held.transition(receipt, next.state, prepared.publication, prepared.semanticDigest, () => { exactPendingReceipt(receipt!); nativeRecovery.assertApprovedPlan(receipt!.successor.plan); });
      if (digest(authority.publication.state) !== digest(prepared.publication.state) || digest(authority.publication.contents) !== digest(prepared.publication.contents)) throw new Error("Replacement witness does not authorize exact logical publication");
      nativeRecovery.assertReplacementSource(authority);
      publishReplacement(next.state, next.groups, () => { exactPendingReceipt(receipt!); nativeRecovery.assertReplacementSource(authority); if (digest(held.readAfter(receipt!)) !== digest(authority)) throw new Error("Replacement witness changed during Task publication"); });
      receipt = pendingPlanReplacement(deliveryGroups)!;
    } else {
      if (!witness || digest(ports.storage.persist.prepare(tasks, deliveryGroups).publication.state) !== witness.publication.stateDigest) throw new Error("Replacement Task state is not exact native R2 publication");
      nativeRecovery.assertReplacementSource(witness);
    }
  } finally { held.release(); }
  if (receipt.parentGoal) {
    if (!ports.goals.rebindPlanReplacement) throw new Error("Replacement Goal owner capability unavailable");
    const goalPublication = await guardTodoAwait(ports.goals.rebindPlanReplacement(receipt.id, ctx));
    exactPendingReceipt(receipt); receipt = { ...structuredClone(receipt), goalPublication };
  }
  const canonical = pendingPlanReplacement(deliveryGroups)!;
  const complete = { ...receipt, phase: "complete" as const }, next = replacementState(complete);
  for (const task of next.state.values()) if (task.replacementPendingId === receipt.id) delete task.replacementPendingId;
  publishReplacement(next.state, next.groups, () => {
    exactPendingReceipt(canonical); readPlanReplacementForGoal(canonical.id);
    if (receipt!.parentGoal) ports.goals.assertPlanReplacementPublication!(receipt!.id, receipt!.goalPublication!, ctx);
  });
  queueAcceptanceProjection();
  if (!deferResume && receipt.parentGoal && ports.goals.resumeAfterPlanReplacement) {
    const plan = await guardTodoAwait((ports.readApprovedPlan ?? readApprovedTaskPlan)(ctx));
    if (plan.manifest.handoffKey === receipt.successor.plan.handoffKey && plan.manifest.revision === receipt.successor.plan.revision && plan.manifest.approvedChecksum === receipt.successor.plan.checksum)
      await guardTodoAwait(ports.goals.resumeAfterPlanReplacement(receipt.parentGoal.id, ctx));
  }
}
export async function recoverPendingPlanReplacement(ctx: ExtensionContext, options: {deferResume?: boolean} = {}): Promise<void> {
  const source = captureTodoSourceExecution(ctx);
  const work = () => withTodoSourceExecution(source, () => resumePlanReplacement(ctx, options.deferResume));
  const result = todoMutationQueue.then(work, work); todoMutationQueue = result.then(() => undefined, () => undefined); await result;
}
/** Goal owner consumes native-authenticated R2 evidence, never a model receipt DTO. */
export function readPlanReplacementForGoal(replacementId: string): { receipt: PlanReplacementReceipt; taskStateDigest: string } {
  const receipt = pendingPlanReplacement(deliveryGroups);
  if (!receipt || receipt.id !== replacementId || receipt.phase !== "tasks-published") throw new Error("Goal replacement requires exact Task R2 receipt");
  exactPendingReceipt(receipt);
  const held = nativeRecovery.holdPlanReplacement();
  try { const witness = held.readAfter(receipt); if (!witness) throw new Error("Goal replacement native witness missing");
    nativeRecovery.assertReplacementSource(witness);
    if (digest(ports.storage.persist.prepare!(tasks, deliveryGroups).publication.state) !== witness.publication.stateDigest
      || replacementEmbeddedStateDigest(witness.publication.state, receipt.id) !== receipt.taskPublication?.stateDigest) throw new Error("Goal replacement exact R2 publication differs");
    return { receipt: structuredClone(receipt), taskStateDigest: witness.publication.stateDigest };
  } finally { held.release(); }
}

function prepareTodoUpdate(
  params: TodoParams,
  actor: TodoActorRef,
  state: Map<string, TodoTask>,
): PreparedTodoUpdate | { error: string } {
  if (!params.id) return { error: "id is required for update" };
  const task = state.get(params.id);
  if (!task) return { error: `Task not found: ${params.id}` };
  assertTaskReplacementEligible(task); nativeRecovery.assertBusinessTask(task);
  if (task.status === "deleted") return { error: `Cannot update deleted task: ${params.id}` };
  if (!canEditTask(actor, task)) return { error: `@${actor.label} cannot update task #${params.id}` };

  const before = cloneTodoTask(task);
  const draft = cloneTodoTask(task);
  const updateFields = params.updateFields ? new Set(params.updateFields) : undefined;
  const updates = (field: TodoUpdateField): boolean =>
    updateFields ? updateFields.has(field) : params[field] !== undefined;

  if (updateFields) {
    for (const field of updateFields) {
      if (params[field] === undefined) return { error: `${field} is required when listed in updateFields` };
    }
  }

  if (updates("acceptanceCriteria")) draft.acceptanceCriteria = validateCriteria(params.acceptanceCriteria!);
  if (updates("subject")) {
    const subject = params.subject!;
    if (!subject.trim()) return { error: "subject cannot be empty" };
    draft.subject = subject;
  }
  if (updates("description")) {
    if (params.description === "") delete draft.description;
    else draft.description = params.description;
  }
  if (updates("summary")) {
    if (params.summary === "") delete draft.summary;
    else draft.summary = params.summary;
  }
  if (updates("resourceUris")) {
    draft.resourceUris = normalizeTodoResourceUris(params.resourceUris);
  }
  if (updates("handoff")) {
    const handoff = normalizeTodoHandoff(params.handoff!, draft.handoff, todoRevision + 1);
    if (handoff) draft.handoff = handoff;
    else delete draft.handoff;
  }
  if (updates("goalId")) {
    delete draft.verifiedQualityGateId;
    if (params.goalId === "") delete draft.goalId;
    else draft.goalId = params.goalId;
  }

  if (updates("assignee")) {
    const assignee = resolveAssignee(params.assignee!, actor);
    if ("error" in assignee) return { error: assignee.error };
    draft.assignee = assignee.actor;
  }

  if (updates("context")) {
    if (params.context === "") delete draft.context;
    else draft.context = params.context;
    draft.skillActivation = undefined;
  }

  if (updates("skills")) {
    draft.skills = params.skills ?? [];
    draft.skillActivation = undefined;
  }

  if (updates("blockedBy")) {
    const blockerResolution = resolveBlockedBy(draft.id, params.blockedBy!, state);
    if (blockerResolution.error) return { error: blockerResolution.error };
    draft.blockedBy = blockerResolution.blockedBy;
    draft.contractDependencies = [...new Set(params.blockedBy!.map(id=>id.replace(/^#+/,"")))];
  }

  if (updates("status")) draft.status = params.status!;
  if (
    (updates("status") && (params.status === "pending" || params.status === "blocked"))
    || (!updates("status") && updates("blockedBy"))
  ) {
    draft.status = deriveDependencyStatus(draft.blockedBy);
  }
  applyTaskStatusTiming(before, draft);

  if (draft.status === "in_progress" && draft.blockedBy.length > 0) {
    return { error: `Task #${draft.id} is blocked by: ${draft.blockedBy.join(", ")}` };
  }
  if (
    draft.status === "in_progress"
    && draft.assignee.kind === "teammate"
    && unavailableTodoActorIds.has(draft.assignee.id)
  ) {
    return {
      error: `Teammate @${draft.assignee.label} is no longer running or restorable. Dispatch a new teammate bound to task #${draft.id} and pass the previous agent:// publication via tasks[].briefing.`,
    };
  }
  if (
    draft.status === "in_progress"
    && (before.status !== "in_progress" || before.assignee.id !== draft.assignee.id)
  ) {
    const active = findActiveTask(draft.assignee.id, draft.id, state);
    if (active) {
      return { error: `Task #${active.id} is already in progress for @${draft.assignee.label} (one in_progress per actor). For parallel work, dispatch teammates without changing todo status; update each task when its agent completes.` };
    }
  }

  if (draft.status !== before.status && !isValidTransition(before.status, draft.status)) {
    return { error: `Invalid status transition: ${before.status} → ${draft.status}` };
  }

  if (draft.status === "completed" && before.status !== "completed" && (before.goalId || draft.goalId)) {
    const gateId = before.goalId || draft.goalId!;
    const gate = ports.goals.getGoalById(gateId);
    if (!gate) {
      return { error: `Quality gate Goal ${draft.goalId} for task #${draft.id} was not found; cannot verify completion.` };
    }
    if (gate.status !== "done") {
      const how = gate.status === "paused"
        ? "Resume the Goal (/goal resume) and let it verify before completing this task."
        : "Complete the Goal (goal complete) to verify it before completing this task.";
      return { error: `Quality gate Goal not verified for task #${draft.id}: "${gate.text}" (${gate.status}). ${how}` };
    }
  }

  if (draft.status === "in_progress" && before.status !== "in_progress") {
    try { dispatchBindings.assertActivation(draft.id); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }
  const activationInputsChanged = before.context !== draft.context
    || JSON.stringify(before.skills) !== JSON.stringify(draft.skills);
  const assigneeChanged = before.assignee.id !== draft.assignee.id;
  const shouldActivate = draft.status === "in_progress"
    && draft.skills.length > 0
    && (before.status !== "in_progress" || activationInputsChanged || assigneeChanged || !draft.skillActivation);
  return { before, draft, activationInputsChanged, shouldActivate };
}

function validateCriteria(criteria: readonly string[]): string[] {
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 16 || criteria.some(item => typeof item !== "string" || !item.trim() || item.length > 2048) || new Set(criteria).size !== criteria.length) throw new Error("acceptanceCriteria must contain 1..16 distinct non-empty criteria.");
  return [...criteria];
}
async function recheckDependencies(ids:readonly string[],ctx:Pick<ExtensionContext,"cwd"> & {sessionManager:unknown},assertCurrent:()=>void):Promise<void> {
 const pending=[...ids],seen=new Set<string>(),snapshots:TodoTask[]=[];
 while(pending.length){const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);const task=tasks.get(id);if(!task || !taskDependencySatisfied(tasks,id))throw new Error(`Task dependency #${id} needs current acceptance review.`);if(task.origin)continue;snapshots.push(cloneTodoTask(task));pending.push(...(task.contractDependencies??task.blockedBy));}
 const current=()=>{assertCurrent();for(const task of snapshots)if(taskIsCleared(taskClearHistory,task.id)||digest(tasks.get(task.id))!==digest(task))throw new Error("Task dependency changed during material review.");};
 current();for(const task of snapshots){await recheckTaskAcceptance(task,ctx,current);current();}
}

async function reviewPreparedUpdate(prepared: PreparedTodoUpdate, params: TodoParams, actor: TodoActorRef, ctx: ExtensionContext): Promise<void> {
  const { before, draft } = prepared;
  const current = () => { assertTodoSourceExecution(); assertCurrentTask(before); if (digest(tasks.get(before.id)) !== digest(before)) throw new Error("Task changed during evidence review."); };
  if(draft.status==="in_progress" && before.status!=="in_progress")await recheckDependencies(draft.contractDependencies??draft.blockedBy,ctx,current);
  const staged = new Map([[draft.id, draft]]); reconcileTaskContracts(new Map([[before.id, before]]), staged);
  if (params.skip && before.status === "completed") throw new Error("Reopen an accepted Task before requesting a separate optional skip resolution.");
  if (params.skip && (!params.review || params.status === "completed")) throw new Error("Skip needs an original-material review and cannot claim completed acceptance.");
  if (params.review) {
    if (actor.kind !== "root" || actor.id !== ROOT_TODO_ACTOR.id) throw new Error("Only the trusted canonical root may assess business evidence.");
    const member = deliveryGroups.find(group => group.id === draft.deliveryGroupId)?.members.find(item => item.taskId === draft.id);
    if (params.skip && (!member || member.required || !member.skipPolicy)) throw new Error("Only an optional member with a predeclared skipPolicy may be skipped.");
    if(params.restoreExecution){await nativeRecovery.ready(true);current();nativeRecovery.claim(before,draft);current();}
    const execution = executionFingerprint(draft,params.skip?"skipped":"accepted");
    const criteria = params.skip ? [member!.skipPolicy!] : taskCriteria(draft);
    const report = await issueMaterialReview(params.review, criteria, taskContractDigest(draft), ctx, readTaskHost(ctx), current);
    current();
    if (executionWitnessDigest(execution) !== executionWitnessDigest(executionFingerprint(draft,params.skip?"skipped":"accepted"))) throw new Error("Execution changed during evidence review.");
    draft.acceptanceReport = { taskInstanceId: draft.taskInstanceId!, contractVersion: draft.contractVersion!, contractDigest: taskContractDigest(draft), review: report, resolution: params.skip ? "skipped" : "accepted", ...(execution ? { execution } : {}) };
    if (!params.skip && params.status === "completed" && !report.accepted) throw new Error("Business criteria were not satisfied by the root-review; completion was refused.");
    if (!params.skip && params.status === "completed" && report.accepted) {
      draft.status = "completed"; draft.completedAt = Date.now();
      if (params.summary !== undefined) draft.summary = params.summary;
    }
    if (params.skip) {
      if (!report.accepted) throw new Error("Skip policy was not satisfied by the reviewed evidence.");
      draft.skipResolution = { policy: member!.skipPolicy!, report: draft.acceptanceReport };
      draft.status = "blocked"; delete draft.completedAt; delete draft.summary;
    }
  }
}
async function validatePreparedAcceptance(prepared: PreparedTodoUpdate, ctx: ExtensionContext): Promise<void> {
  const { before, draft } = prepared;
  if (draft.origin) return; // Workflow mirrors retain their canonical owner and blockers.
  if (draft.status !== "completed" && !draft.skipResolution) return;
  const assertCurrent = () => { assertTodoSourceExecution(); if (digest(tasks.get(before.id)) !== digest(before)) throw new Error("Task changed before acceptance commit."); };
  await recheckTaskAcceptance(draft, ctx, assertCurrent, draft.skipResolution ? "skipped" : "accepted");
  assertCurrent();
}

async function handleBatchUpdate(
  updates: TodoUpdateSpec[],
  actor: TodoActorRef,
  generation: number,
  ctx: ExtensionContext,
): Promise<FlowToolResult> {
  if (updates.length === 0) return err("updates must be a non-empty array", "update");
  const ids = updates.map((update) => update.id);
  if (new Set(ids).size !== ids.length) return err("update ids must be unique", "update");

  const baseline = cloneTaskMap(tasks);
  const candidate = cloneTaskMap(tasks);
  const preparedUpdates: PreparedTodoUpdate[] = [];
  for (const [index, update] of updates.entries()) {
    const prepared = prepareTodoUpdate({ action: "update", ...update }, actor, candidate);
    if ("error" in prepared) return err(`updates[${index}]: ${prepared.error}`, "update", [update.id]);
    await reviewPreparedUpdate(prepared, { action: "update", ...update }, actor, ctx);
    candidate.set(prepared.draft.id, prepared.draft);
    if (prepared.draft.status === "completed" && (prepared.before.status !== "completed" || !!prepared.before.reviewRequired)) {
      autoUnblockCurrent(candidate, prepared.draft.id);
    }
    preparedUpdates.push(prepared);
  }

  const activations = new Map<string, SkillActivation>();
  for (const prepared of preparedUpdates) {
    prepared.draft = candidate.get(prepared.draft.id)!;
    const activation = prepared.shouldActivate ? await guardTodoAwait(ports.skills.activateTask(prepared.draft)) : undefined;
    if (activation) {
      prepared.draft.skillActivation = ports.skills.activationMetadata(activation);
      candidate.set(prepared.draft.id, prepared.draft);
      activations.set(prepared.draft.id, activation);
    }
    if (prepared.draft.status === "pending" || prepared.draft.skills.length === 0) {
      prepared.draft.skillActivation = undefined;
      candidate.set(prepared.draft.id, prepared.draft);
    }
  }

  if (activations.size > 0) {
    ports.storage.assertTodoGeneration(generation);
    if (JSON.stringify([...tasks]) !== JSON.stringify([...baseline])) {
      throw new Error("Todo state changed while batch skills were activating; retry the mutation.");
    }
  }

  const changed = preparedUpdates.filter((prepared) => taskChanged(prepared.before, prepared.draft)
    || JSON.stringify(prepared.before.skillActivation) !== JSON.stringify(prepared.draft.skillActivation));
  if (changed.length === 0) return ok(`No changes: ${updates.length} tasks`, "update", ids);
  const updatedAt = Date.now();
  for (const prepared of changed) {
    prepared.draft.updatedAt = updatedAt;
    candidate.set(prepared.draft.id, prepared.draft);
  }

  for (const prepared of preparedUpdates) await validatePreparedAcceptance(prepared, ctx);
  for(const prepared of preparedUpdates)if(prepared.draft.status==="in_progress"&&prepared.before.status!=="in_progress")dispatchBindings.assertActivation(prepared.draft.id);
  commitTodoState(candidate, undefined, {
    authoredDependencies: updates.filter(update=>update.blockedBy!==undefined).map(update=>update.id),
    completed: preparedUpdates.filter(p=>p.draft.status==="completed"&&(p.before.status!=="completed"||!!p.before.reviewRequired)).map(p=>p.draft.id),
    activated: preparedUpdates.filter(p=>p.draft.status==="in_progress"&&p.before.status==="pending").map(p=>p.draft.id),
  });
  for (const prepared of preparedUpdates) {
    const activation = activations.get(prepared.draft.id);
    if (activation) {
      activeSkillSnapshots.set(prepared.draft.id, activation);
      runSkillInjection = undefined;
    } else if (prepared.activationInputsChanged || prepared.draft.status !== "in_progress") {
      ports.skills.clearSkillSnapshot(prepared.draft.id);
    }
  }

  const lines = preparedUpdates.map(({ before, draft }) => {
    const statusNote = before.status !== draft.status ? ` (${before.status} → ${draft.status})` : "";
    return `#${draft.id} ${draft.subject}${statusNote}`;
  });
  return ok(`Updated ${preparedUpdates.length} tasks:\n${lines.join("\n")}`, "update", ids);
}

async function handleUpdate(
  params: TodoParams,
  ctx: ExtensionContext,
  actor: TodoActorRef,
  generation: number,
  handoffOnly = false,
): Promise<FlowToolResult> {
  if (params.updates !== undefined) {
    const conflicting = ["id", "subject", "description", "status", "blockedBy", "context", "skills", "summary", "resourceUris", "handoff", "transition", "updateFields", "assignee", "goalId"]
      .filter((field) => params[field as keyof TodoParams] !== undefined);
    if (conflicting.length > 0) {
      return err(`update accepts either id with top-level fields or updates, not both; ${conflicting.join(", ")} cannot accompany updates`, "update");
    }
    return handleBatchUpdate(params.updates, actor, generation, ctx);
  }

  if (params.transition !== undefined) {
    if (params.transition !== "new_context") {
      return err("transition=keep_context is only valid for completion-form advance; active update supports only new_context", "update", params.id ? [params.id] : undefined);
    }
    const active = findActiveTask(actor.id);
    if (!active) {
      return err(`@${actor.label} has no in_progress task to update before new_context`, "update", params.id ? [params.id] : undefined);
    }
    if (!params.id) {
      return err(`id is required to update active task #${active.id} before new_context`, "update");
    }
    if (params.id !== active.id) {
      return err(`Update id mismatch for @${actor.label}: active task is #${active.id}, not #${params.id}`, "update", [params.id]);
    }
  }

  const prepared = prepareTodoUpdate(params, actor, tasks);
  if ("error" in prepared) return err(prepared.error, "update", params.id ? [params.id] : undefined);
  await reviewPreparedUpdate(prepared, params, actor, ctx);
  const { before, draft, activationInputsChanged, shouldActivate } = prepared;
  if (params.transition === "new_context"
    && (draft.status !== "in_progress" || draft.assignee.id !== actor.id)) {
    return err("update with transition=new_context must leave the caller's active task in_progress", "update", [draft.id]);
  }
  const activation = shouldActivate && !handoffOnly ? await guardTodoAwait(ports.skills.activateTask(draft)) : undefined;
  if (shouldActivate && !handoffOnly) {
    revalidateAsyncTodoMutation({ generation, before, draft, actor });
  }
  if (activation) draft.skillActivation = ports.skills.activationMetadata(activation);
  if (!handoffOnly && (draft.status === "pending" || draft.skills.length === 0)) draft.skillActivation = undefined;

  const changed = taskChanged(before, draft)
    || JSON.stringify(before.skillActivation) !== JSON.stringify(draft.skillActivation);
  if (!changed) return ok(`No change: #${draft.id}`, "update", [draft.id], params.transition);

  await validatePreparedAcceptance(prepared, ctx);
  if(draft.status==="in_progress"&&before.status!=="in_progress")dispatchBindings.assertActivation(draft.id);
  draft.updatedAt = Date.now();
  const nextTasks = cloneTaskMap(tasks);
  nextTasks.set(draft.id, draft);
  if (draft.status === "completed" && (before.status !== "completed" || !!before.reviewRequired)) {
    autoUnblockCurrent(nextTasks, draft.id);
  }

  const execution = sourceExecution.getStore();
  const own = handoffOnly && execution ? handoffOwnCommits.get(execution) : undefined;
  if (own && (own.taskId !== draft.id || own.patchDigest !== digest(params.handoff?.files) || own.confirmed || own.publishing)) {
    throw new Error("Handoff commit no longer matches the original queued patch.");
  }
  commitTodoState(nextTasks, undefined, {
    authoredDependencies: params.blockedBy!==undefined ? [draft.id] : [],
    completed: draft.status==="completed"&&(before.status!=="completed"||!!before.reviewRequired) ? [draft.id] : [],
    activated: draft.status==="in_progress"&&before.status==="pending" ? [draft.id] : [],
  }, deliveryGroups, undefined, own);
  if (activation) {
    activeSkillSnapshots.set(draft.id, activation);
    runSkillInjection = undefined;
  } else if (activationInputsChanged || draft.status !== "in_progress") {
    ports.skills.clearSkillSnapshot(draft.id);
  }

  const statusNote = before.status !== draft.status ? ` (${before.status} → ${draft.status})` : "";
  return ok(`Updated #${draft.id}: ${draft.subject}${statusNote}`, "update", [draft.id], params.transition);
}

function handleList(params: TodoParams, actor: TodoActorRef): FlowToolResult {
  const finish = (result: FlowToolResult): FlowToolResult => {
    if (actor.kind !== "root") return result;
    const groups = deliveryGroups.map(group => ({
      expectedGroupId: group.id, expectedGroupDigest: deliveryGroupDigest(group),
      ...(group.approvedPlan ? { expectedPlanHandoffKey: group.approvedPlan.handoffKey } : {}),
      ...(group.deliveryGoalId ? { deliveryGoalId: group.deliveryGoalId } : {}),
      current: !group.supersededBy, currentForReplacement: !group.supersededBy, cleared: groupIsCleared(taskClearHistory,group.id), executable: !group.supersededBy && !groupIsCleared(taskClearHistory,group.id) && !hasPendingTaskClearRecovery() && !group.currentPendingReplacementId, pendingReplacementId: group.currentPendingReplacementId,
      receipts: (group.replacementHistory ?? []).map(receipt => ({ id: receipt.id, phase: receipt.phase, reason: receipt.reason,
        predecessorGroupId: receipt.predecessor.groupId, successorGroupId: receipt.successor.groupId,
        ...(receipt.abort ? { abortReason: receipt.abort.reason } : {}) })),
    }));
    return { ...result, content: [...result.content, { type: "text", text: `Canonical deliveryGroups: ${JSON.stringify(groups)}` }],
      details: { ...(result.details as Record<string, unknown>), deliveryGroups: groups, clearHistory: taskClearHistory.map(r=>({id:r.id,phase:r.phase,taskIds:r.members.map(m=>m.id)})) } };
  };
  const { offset, limit } = todoPageOptions(params, "list");
  const visible = params.includeHistory ? [...tasks.values()].map(cloneTodoTask) : getVisibleTasks();
  let filtered = visible;

  if (params.filter?.status) {
    filtered = filtered.filter((t) => t.status === params.filter!.status);
  }
  const memberSelector = params.filter?.memberId;
  if (memberSelector) {
    const member = resolveTodoActorSelector(memberSelector, actor);
    if ("error" in member) {
      // Ambiguous and unknown selectors are both caller errors: report them
      // instead of silently filtering down to an empty list.
      return err(member.error, "list");
    }
    filtered = filtered.filter((task) => task.createdBy.id === member.actor.id
      || task.assignee.id === member.actor.id);
  }

  if (filtered.length === 0) {
    return finish(ok("No tasks found.", "list", []));
  }

  // Pre-compute reverse dependency map: taskId -> list of task IDs it blocks
  const blocksMap = new Map<string, string[]>();
  for (const t of visible) {
    for (const dep of t.blockedBy) {
      const existing = blocksMap.get(dep);
      if (existing) existing.push(`#${t.id}`);
      else blocksMap.set(dep, [`#${t.id}`]);
    }
  }

  const page = filtered.slice(offset, offset + limit);
  const end = offset + page.length;
  const lines = page.map((task) => `${taskIsCleared(taskClearHistory,task.id) ? "[archived read-only] " : ""}${task.reviewRequired ? "[?] review required" : task.skipResolution ? "[~] skipped" : statusIcon(task.status)} ${todoIndexEntry(task, blocksMap.get(task.id))}`);
  const footer = end < filtered.length
    ? `Continue: todo ${JSON.stringify({ action: "list", ...(params.filter ? { filter: params.filter } : {}), offset: end, limit })}`
    : "End of list.";
  return finish(ok(
    `Tasks: offset=${offset}, returned=${page.length}, total=${filtered.length} (task entries, creation order).\n${lines.join("\n")}\n${footer}`,
    "list",
    page.map((task) => task.id),
  ));
}

/** Minimal shared create/list projection; full fields remain available via get. */
function todoIndexEntry(task: TodoTask, blocks?: readonly string[]): string {
  const tags: string[] = [];
  if (task.blockedBy.length > 0) tags.push(`blocked by: ${task.blockedBy.join(", ")}`);
  if (blocks?.length) tags.push(`blocks: ${blocks.join(", ")}`);
  const metadata = `(${task.status}) ${actorTag(task)}${tags.length ? ` [${tags.join("] [")}]` : ""}`;
  // Reserve space for both title and routing/dependencies, so a long label or
  // dependency list cannot consume the title's entire preview.
  return `#${task.id}: ${todoPreview(task, "all", metadata, 128, true)} ${todoPreview(task, "subject", task.subject, TODO_SUBJECT_BYTES)}`;
}

function todoPageOptions(params: TodoParams, action: "get" | "list"): { offset: number; limit: number } {
  const max = action === "get" ? TODO_GET_MAX_LIMIT : TODO_LIST_MAX_LIMIT;
  const offset = params.offset === undefined ? 0 : params.offset;
  const limit = params.limit === undefined
    ? action === "get" ? TODO_GET_DEFAULT_LIMIT : TODO_LIST_DEFAULT_LIMIT
    : params.limit;
  const unit = action === "get" ? "Unicode code points" : "task entries";
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`offset must be a non-negative safe integer (${unit})`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new Error(`limit must be an integer from 1 to ${max} (${unit})`);
  }
  return { offset, limit };
}

// Content budgets exclude the small framing and actionable read notices.
const TODO_SUBJECT_BYTES = 256;
const TODO_DESCRIPTION_BYTES = 2 * 1024;
const TODO_CONTEXT_BYTES = 4 * 1024;
const TODO_SUMMARY_BYTES = 1024;
const TODO_REFERENCE_BYTES = 1024;

function todoReadHint(id: string, field: TodoGetField, offset = 0, limit = TODO_GET_DEFAULT_LIMIT): string {
  return `todo ${JSON.stringify({ action: "get", id, field, offset, limit })}`;
}

/** Byte-bounded previews never split a code point; read offsets use code points. */
function boundedTodoText(text: string, maxBytes: number, readHint: (offset: number) => string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let offset = 0;
  let prefix = "";
  for (const point of text) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > maxBytes) break;
    prefix += point;
    bytes += size;
    offset++;
  }
  return `${prefix}\n[Truncated; continue with ${readHint(offset)}]`;
}

function todoPreview(task: TodoTask, field: TodoGetField, text: string, bytes: number, formatted = false): string {
  return boundedTodoText(text, bytes, (offset) => todoReadHint(task.id, field, formatted ? 0 : offset));
}

function todoFieldText(task: TodoTask, field: TodoGetField): string {
  if (field === "all" && taskIsCleared(taskClearHistory,task.id)) return JSON.stringify(task,null,2);
  if (field === "all") {
    return JSON.stringify({
      ...task,
      blocks: [...tasks.values()].filter((t) => t.status !== "deleted" && t.blockedBy.includes(task.id)).map((t) => t.id),
    }, null, 2);
  }
  const value = task[field];
  return typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
}

function formatTodoHandoff(task: TodoTask): string {
  if (!task.handoff) return "";
  const lines: string[] = [];
  if (task.handoff.nextSteps.length > 0) {
    lines.push("Handoff next steps:", ...task.handoff.nextSteps.map((step) => `- ${step}`));
  }
  if (task.handoff.files.length > 0) {
    lines.push("Handoff files:", ...task.handoff.files.map((file) =>
      `- ${file.path} [${file.value}]: ${file.reason}${file.when ? `; when=${file.when}` : ""}`));
  }
  return lines.join("\n");
}

function handleGet(params: TodoParams): FlowToolResult {
  if (!params.id) return err("id is required for get", "get");
  const clear = params.atClear ? taskClearHistory.find(r=>r.id===params.atClear) : undefined;
  if(params.atClear && !clear)return err("Unknown clear snapshot", "get");
  if(clear)ports.storage.assertTaskClearSnapshots([clear],todoHostContext!,taskClearHistory);
  const task = clear ? clear.members.find(m=>m.id===params.id)?.body : tasks.get(params.id);
  if (!task) return err(`Task not found: ${params.id}`, "get");
  if (params.field !== undefined && !(TODO_GET_FIELDS as readonly unknown[]).includes(params.field)) {
    return err(`field must be one of: ${TODO_GET_FIELDS.join(", ")}`, "get");
  }
  const { offset, limit } = todoPageOptions(params, "get");
  if (params.field !== undefined || params.offset !== undefined || params.limit !== undefined) {
    const field = params.field ?? "all";
    const points = Array.from(clear && field === "all" ? JSON.stringify(task,null,2) : todoFieldText(task, field));
    const end = Math.min(offset + limit, points.length);
    const header = `#${task.id} ${field}: offset=${offset}, returned=${Math.max(0, end - offset)}, total=${points.length} Unicode code points (0-based).`;
    const footer = end < points.length
      ? `Continue: ${todoReadHint(task.id, field, end, limit)}`
      : "End of field.";
    return ok(`${header}\n${points.slice(offset, end).join("")}\n${footer}`, "get", [task.id]);
  }

  const lines: string[] = [
    `# #${task.id}: ${todoPreview(task, "subject", task.subject, TODO_SUBJECT_BYTES)}`,
    `Status: ${task.status}${taskIsCleared(taskClearHistory,task.id) ? " (archived read-only)" : ""}`,
    todoPreview(task, "all", `Created by: @${task.createdBy.label}\nAssignee: @${task.assignee.label}`, 512, true),
  ];
  for (const [field, label] of [["description", "Description"], ["summary", "Summary"], ["context", "Context"]] as const) {
    if (task[field]) lines.push(`${label}: ${todoPreview(task, field, task[field]!, 512)}`);
  }
  if (task.blockedBy.length > 0) lines.push(todoPreview(task, "all", `Blocked by: ${task.blockedBy.join(", ")}`, 512, true));
  const blockers = [...tasks.values()].filter((t) => t.blockedBy.includes(task.id) && t.status !== "deleted");
  if (blockers.length > 0) lines.push(todoPreview(task, "all", `Blocks: ${blockers.map((b) => `#${b.id}`).join(", ")}`, 512, true));
  lines.push(`Resource URIs: ${todoPreview(task, "resourceUris", todoFieldText(task, "resourceUris"), TODO_REFERENCE_BYTES, true)}`);
  if (task.handoff) lines.push(todoPreview(task, "handoff", formatTodoHandoff(task), TODO_REFERENCE_BYTES, true));
  if (task.skills.length > 0) lines.push(`Skills: ${todoPreview(task, "skills", task.skills.map(ports.skills.formatSkillBinding).join(", "), 512, true)}`);
  if (task.skillActivation) {
    lines.push(todoPreview(task, "all", `Skill activation: ${task.skillActivation.activationId}\nStack revision: ${task.skillActivation.stackRevision}`, 512, true));
  }
  if (task.reviewRequired) lines.push("Current acceptance: review required (historical status retained). Review the original materials; do not rerun the work automatically.");
  if (task.skipResolution) lines.push(`Resolution: skipped under predeclared policy; not accepted/completed. Policy: ${task.skipResolution.policy}`);
  if (task.goalId) lines.push(todoPreview(task, "all", `Goal: ${task.goalId}; read the current Goal with goal {"action":"get"}`, 512, true));
  lines.push(`Full task/metadata: ${todoReadHint(task.id, "all")}. Text fields are raw text; structured fields are JSON. Follow Continue until End of field.`);
  return ok(lines.join("\n"), "get", [task.id]);
}

function handleDelete(params: TodoParams, ctx: ExtensionContext, actor: TodoActorRef): FlowToolResult {
  if (params.id && params.ids !== undefined) return err("delete accepts either id or ids, not both", "delete");
  const requestedIds = params.ids ?? (params.id ? [params.id] : []);
  if (requestedIds.length === 0) return err("id or ids is required for delete", "delete");
  if (new Set(requestedIds).size !== requestedIds.length) return err("delete ids must be unique", "delete");

  const selected: TodoTask[] = [];
  for (const id of requestedIds) {
    const task = tasks.get(id);
    if (task) { assertCurrentTask(task); assertTaskReplacementEligible(task); }
  if (!task) return err(`Task not found: ${id}`, "delete");
    if (!canDeleteTask(actor, task)) return err(`@${actor.label} cannot delete task #${id}`, "delete");
    selected.push(task);
  }

  const deletedIds = new Set(requestedIds);
  const nextTasks = cloneTaskMap(tasks);
  const updatedAt = Date.now();
  for (const id of requestedIds) {
    const deleted = nextTasks.get(id)!;
    const before = tasks.get(id)!;
    deleted.status = "deleted";
    deleted.updatedAt = updatedAt;
    applyTaskStatusTiming(before, deleted, updatedAt);
  }

  for (const task of nextTasks.values()) {
    if (taskIsCleared(taskClearHistory,task.id) || task.status === "deleted" || !task.blockedBy.some((id) => deletedIds.has(id))) continue;
    task.blockedBy = task.blockedBy.filter((id) => !deletedIds.has(id));
    if (task.status === "blocked" || task.status === "pending") {
      task.status = deriveDependencyStatus(task.blockedBy);
    }
    task.updatedAt = updatedAt;
  }

  commitTodoState(nextTasks);
  ports.skills.clearCommittedSkillSnapshots(deletedIds);
  if (selected.length === 1) {
    return ok(`Deleted #${selected[0].id}: ${selected[0].subject}`, "delete", requestedIds);
  }
  return ok(
    `Deleted ${selected.length} tasks:\n${selected.map((task) => `#${task.id} ${task.subject}`).join("\n")}`,
    "delete",
    requestedIds,
  );
}

function assertClearOriginal(record: TaskClearRecord): void {
  assertTodoSourceExecution();
  ports.storage.assertTaskClearSnapshots([record], todoHostContext!, taskClearHistory.some(r=>r.id===record.id)?taskClearHistory:[...taskClearHistory,record]);
  validateClearHistory(taskClearHistory, tasks, deliveryGroups);
}
function publishClear(records: TaskClearRecord[], guard: () => void): void {
  guard(); validateClearHistory(records,tasks,deliveryGroups);
  const prepared=ports.storage.persist.prepare!(tasks,deliveryGroups,records), pin=digest(prepared.publication), generation=todoGeneration;
  try {
    clearPublicationInFlight=prepared.publication;
    ports.storage.persist(cloneTaskMap(tasks),structuredClone(deliveryGroups),structuredClone(records));
    if(digest(ports.storage.persist.prepare!(tasks,deliveryGroups,records).publication)!==pin)throw new Error("Task clear publication changed during append");
    assertReplacementPublication(prepared.publication); prepared.assertExistingContents(); guard();
    ports.storage.assertTodoGeneration(generation); assertTodoSourceExecution();
    dispatchBindings.committed(tasks,tasks); taskClearHistory=structuredClone(records); refreshClearEvidence(); syncTaskIdCounter();
  } catch(error) { invalidateTodoSource(); throw new TodoPublicationUnconfirmedError(error); }
  finally { clearPublicationInFlight=undefined; }
  markTodoChanged();
}
function exactPendingClear(record: TaskClearRecord): void {
  assertClearOriginal(record);
  if(digest(pendingTaskClear(taskClearHistory))!==digest(record))throw new Error("Task clear reservation changed");
  assertReplacementPublication(clearPublicationInFlight ?? ports.storage.persist.prepare!(tasks,deliveryGroups).publication);
}
async function handleClear(ctx: ExtensionContext, actor: TodoActorRef): Promise<FlowToolResult> {
  if(actor.kind!=="root")return err("Only root can clear the shared Todo list.","clear");
  assertNoPlanReplacement();
  const members=[...currentTasks().values()];
  if(!members.length)return ok("Cleared 0 task(s).","clear");
  const before=digest([[...tasks],deliveryGroups,taskClearHistory]);
  const local=members.filter(t=>!t.origin);
  if(local.length)await guardTodoAwait(nativeRecovery.ready(true));
  assertNoPlanReplacement();
  if(digest([[...tasks],deliveryGroups,taskClearHistory])!==before)throw new Error("Task clear membership changed during admission");
  const held=local.length?nativeRecovery.holdTaskClear():undefined;
  try {
    const branch=ctx.sessionManager.getBranch(), anchor=branch.at(-1)?.id;
    if(!anchor)throw new Error("Task clear requires canonical journal anchor");
    const groups=deliveryGroups.filter(g=>g.members.every(m=>members.some(t=>t.id===m.taskId)));
    const ids=new Set([...groups.filter(g=>!g.supersededBy).flatMap(g=>g.deliveryGoalId?[g.deliveryGoalId]:[]),...members.filter(t=>t.status!=="deleted"&&!t.supersessionId).flatMap(t=>t.goalId?[t.goalId]:[])]);
    const record:TaskClearRecord={version:1,id:randomUUID(),phase:"reserved",kind:local.length?"local":"mirror-only",createdAt:Date.now(),
      source:{workspace:realpathSync(ctx.cwd),sessionId:ctx.sessionManager.getSessionId(),anchor,prefixIdentityHashes:branch.map(e=>digest({id:e.id,parentId:e.parentId,type:e.type,customType:"customType" in e?e.customType:undefined}))},
      snapshot:ports.storage.captureTaskClearSnapshot(),members:members.map(body=>({id:body.id,instanceId:body.taskInstanceId!,body:structuredClone(body),bodyDigest:replacementTaskBodyDigest(body)})),
      groups:groups.map(body=>({id:body.id,digest:digest(body),body:structuredClone(body)})),
      goals:[...ids].map(id=>({id,delivery:groups.some(g=>!g.supersededBy&&g.deliveryGoalId===id),quality:members.some(t=>t.goalId===id&&t.status!=="deleted"&&!t.supersessionId)})),
      allocatorHighWater:Math.max(nextTaskId-1,ports.storage.getReplacementAllocatorHighWater()),nativeBefore:held?.sample(local.map(t=>t.id))??[],requestDigest:""};
    record.requestDigest=clearRequestDigest(record);
    const reservation=ports.storage.persist.prepare!(tasks,deliveryGroups,[...taskClearHistory,record]);
    reservation.assertExistingContents();assertClearOriginal(record);held?.assertBefore(record.nativeBefore);
    try {
      ports.storage.appendTaskClearEvidence({version:1,phase:"intent",record:structuredClone(record),
        ...(taskClearEvidence.lastTerminal?{previous:taskClearEvidence.lastTerminal}:{}),reservationDigest:digest(reservation.publication)});
      refreshClearEvidence();
      ports.goals.fenceTaskClear?.(record.goals.map(g=>g.id));
    } catch(error){invalidateTodoSource();throw error;}
    publishClear([...taskClearHistory,record],()=>{assertClearOriginal(record);held?.assertBefore(record.nativeBefore);if(digest([[...tasks],deliveryGroups,taskClearHistory])!==before)throw new Error("Task clear admission changed");});
    ports.goals.fenceTaskClear?.(record.goals.map(g=>g.id));
  } finally { held?.release(); }
  await resumeTaskClear();
  ports.skills.clearSkillSnapshot();
  return ok(`Cleared ${members.length} task(s); immutable history retained.`,"clear");
}
async function resumeTaskClear(): Promise<void> {
  refreshClearEvidence();
  const pending=taskClearEvidence.pending,record=pending?.intent.record;if(!pending||!record)return;
  assertTodoSourceExecution();assertClearOriginal(record);
  ports.goals.fenceTaskClear?.(record.goals.map(g=>g.id));
  if(!pending.reservation) {
    const prepared=ports.storage.persist.prepare!(tasks,deliveryGroups,[...taskClearHistory,record]);
    if(digest(prepared.publication)!==pending.intent.reservationDigest)throw new Error("Task clear recovered reservation differs");
    publishClear([...taskClearHistory,record],()=>{assertClearOriginal(record);ports.storage.assertTaskClearEvidenceCurrent();});
  }
  exactPendingClear(record);
  if(record.kind==="local")await guardTodoAwait(nativeRecovery.ready(true));
  exactPendingClear(record);
  const held=record.kind==="local"?nativeRecovery.holdTaskClear():undefined;
  try {
    const existing=held?.readAfter(record),terminal=taskClearEvidence.pending?.terminal;
    if(terminal && held && !existing)throw new Error("Task clear terminal native witness missing");
    const complete:TaskClearRecord={...structuredClone(record),phase:"complete",...(held?{nativeWitnessId:existing?.id??held.witnessId}:{})};
    if(terminal && digest(terminal.record)!==digest(complete))throw new Error("Task clear terminal differs from native witness");
    const records=taskClearHistory.map(r=>r.id===record.id?complete:r);
    const prepared=ports.storage.persist.prepare!(tasks,deliveryGroups,records);prepared.assertExistingContents();
    const witness=existing??held?.transition(record,prepared.publication,()=>exactPendingClear(record));
    if(witness && digest(witness.publication)!==digest({...prepared.publication,stateDigest:digest(prepared.publication.state)}))throw new Error("Task clear witness differs from exact final publication");
    const assertWitness=()=>{exactPendingClear(record);if(witness&&digest(held!.readAfter(record))!==digest(witness))throw new Error("Task clear native witness changed");};
    assertWitness();
    if(!terminal) {
      const current=taskClearEvidence.pending;
      if(!current?.reservation)throw new Error("Task clear canonical reservation evidence missing");
      ports.storage.appendTaskClearEvidence({version:1,phase:"terminal",record:complete,intent:current.pin,reservation:current.reservation,publicationDigest:digest(prepared.publication)});
      refreshClearEvidence();assertWitness();
    } else if(terminal.publicationDigest!==digest(prepared.publication))throw new Error("Task clear final publication differs from terminal");
    publishClear(records,assertWitness);
    ports.goals.fenceTaskClear?.(record.goals.map(g=>g.id));
  } catch(error){invalidateTodoSource();throw error;} finally { held?.release(); }
}
export async function recoverPendingTaskClear(ctx:ExtensionContext):Promise<void> {
  const source=captureTodoSourceExecution(ctx), work=()=>withTodoSourceExecution(source,resumeTaskClear);
  const result=todoMutationQueue.then(work,work);todoMutationQueue=result.then(()=>undefined,()=>undefined);await result;
}

async function handleAdvance(
  params: TodoParams,
  ctx: ExtensionContext,
  actor: TodoActorRef,
  generation: number,
): Promise<FlowToolResult> {
  const active = findActiveTask(actor.id);
  const suppliedResources = params.resourceUris === undefined
    ? undefined
    : normalizeTodoResourceUris(params.resourceUris);
  if (!active) {
    if (params.id !== undefined || params.summary !== undefined || suppliedResources !== undefined || params.handoff !== undefined || params.transition !== undefined) {
      return err(`@${actor.label} has no in_progress task. Omit id, summary, resourceUris, handoff, and transition to activate the next runnable task.`, "advance");
    }
    const next = runnableTasksForActor(actor.id)[0];
    if (next?.origin) {
      return err(`Task #${next.id} is a canonical Workflow mirror. Advance it through the Workflow Run lifecycle; use todo next only when the mirror instructions explicitly require activation.`, "advance");
    }
    return relabelTodoResult(await guardTodoAwait(handleNext(ctx, actor, generation)), "advance");
  }

  if (active.origin) {
    return err(`Task #${active.id} is a canonical Workflow mirror. Advance it through the Workflow Run lifecycle, not todo advance.`, "advance");
  }
  if (active.assignee.id !== actor.id) {
    return err(`@${actor.label} cannot advance task #${active.id}; it is assigned to @${active.assignee.label}.`, "advance");
  }
  if (!params.id) {
    return err(`id is required to complete active task #${active.id} with advance.`, "advance");
  }
  if (params.id !== active.id) {
    return err(`Advance id mismatch for @${actor.label}: active task is #${active.id}, not #${params.id}.`, "advance");
  }
  const summary = params.summary?.trim();
  if (!summary) {
    return err(`summary is required to complete active task #${active.id} with advance.`, "advance");
  }

  const completionResourceUris = suppliedResources === undefined
    ? undefined
    : appendTodoResourceUris(active.resourceUris, suppliedResources);
  const completionFields: TodoUpdateField[] = ["status", "summary"];
  if (completionResourceUris !== undefined) completionFields.push("resourceUris");
  if (params.handoff !== undefined) completionFields.push("handoff");
  const completion = await guardTodoAwait(handleUpdate({
    action: "update",
    id: active.id,
    status: "completed",
    summary,
    ...(params.review ? { review: params.review } : {}),
    ...(completionResourceUris !== undefined ? { resourceUris: completionResourceUris } : {}),
    ...(params.handoff !== undefined ? { handoff: params.handoff } : {}),
    updateFields: completionFields,
  }, ctx, actor, generation));
  if (completion.isError) return relabelTodoResult(completion, "advance");

  const completedNote = `Completed #${active.id}: ${todoPreview(active, "subject", active.subject, TODO_SUBJECT_BYTES)}`;
  const nextCandidate = runnableTasksForActor(actor.id)[0];
  if (nextCandidate?.origin) {
    return ok(
      `${completedNote}. Next task #${nextCandidate.id} is a canonical Workflow mirror and remains ${nextCandidate.status}; advance it through the Workflow Run lifecycle.`,
      "advance",
      undefined,
      params.transition,
    );
  }

  let next: FlowToolResult;
  try {
    next = await guardTodoAwait(handleNext(ctx, actor, generation));
  } catch (error) {
    return err(`${completedNote}, but the next task was not activated: ${error instanceof Error ? error.message : String(error)}`, "advance");
  }
  const nextText = todoResultText(next);
  if (next.isError) {
    if (nextText.startsWith("Error: Dependency deadlock:")) {
      return ok(
        `${completedNote}. ${nextText.replace("Error: Dependency deadlock:", "Waiting:")}`,
        "advance",
        undefined,
        params.transition,
      );
    }
    if (nextText.includes("the task remains in_progress")) {
      return err(`${completedNote}. ${nextText.replace(/^Error: /, "")}`, "advance");
    }
    return err(`${completedNote}, but the next task was not activated: ${nextText}`, "advance");
  }
  return ok(`${completedNote}\n\n${nextText}`, "advance", undefined, params.transition);
}

function todoResultText(result: FlowToolResult): string {
  const block = result.content.find((item) => item.type === "text");
  return block && "text" in block ? block.text : "Todo request completed.";
}

function relabelTodoResult(result: FlowToolResult, action: string): FlowToolResult {
  const details = result.details as TodoResultDetails | undefined;
  return details ? { ...result, details: { ...details, action } } : result;
}

function runnableTasksForActor(actorId: string): TodoTask[] {
  return [...currentTasks().values()]
    .filter((task) => !task.supersessionId && !task.replacementPendingId && task.assignee.id === actorId && task.status === "pending" && task.blockedBy.length === 0)
    .sort((left, right) => left.createdAt - right.createdAt);
}

async function handleNext(
  ctx: ExtensionContext,
  actor: TodoActorRef,
  generation: number,
): Promise<FlowToolResult> {
  const active = findActiveTask(actor.id);
  if (active) {
    return err(`Task #${active.id} is already in progress for @${actor.label} (one in_progress per actor). Complete or pause it first, or dispatch parallel work via teammates without changing todo status.`, "next");
  }

  const pending = runnableTasksForActor(actor.id);

  if (pending.length === 0) {
    const inProgress = [...currentTasks().values()].filter((t) => t.assignee.id === actor.id && t.status === "in_progress");
    if (inProgress.length > 0) {
      return ok(`No pending tasks. ${inProgress.length} task(s) in progress.`, "next");
    }
    const blocked = getVisibleTasks().filter(
      (task) => task.assignee.id === actor.id
        && (task.status === "blocked" || (task.status === "pending" && task.blockedBy.length > 0)),
    );
    if (blocked.length > 0) {
      const blockerDetails = blocked.slice(0, PREV_CONTEXT_WINDOW).map((task) => {
        const dependencies = task.blockedBy.map((depId) => {
          const dependency = tasks.get(depId);
          return dependency
            ? `#${depId} (${dependency.status})`
            : `#${depId} (missing)`;
        });
        return `#${task.id} ${todoPreview(task, "subject", task.subject, TODO_SUBJECT_BYTES)} blocked by ${todoPreview(task, "all", dependencies.join(", ") || "an unresolved dependency", 512, true)}`;
      });
      if (blocked.length > PREV_CONTEXT_WINDOW) {
        blockerDetails.push(`${blocked.length - PREV_CONTEXT_WINDOW} more blocked tasks; use todo {"action":"list","filter":{"memberId":"self"}} for IDs, then get each task`);
      }
      return err(
        `Dependency deadlock: no runnable pending task. ${blockerDetails.join("; ")}`,
        "next",
      );
    }
    return ok("All tasks completed or no tasks exist.", "next");
  }

  const task = pending[0];
  nativeRecovery.assertBusinessTask(task);
  // Set when the task's quality gate is a Goal the user stopped by hand, so the notice
  // below can be appended after the header is built.
  let userStoppedGate: string | undefined;
  // The actual Goal switch is deferred until the task commit succeeds: skill
  // activation below can fail, and a failed `next` must not leave the active
  // Goal switched as a stray side effect.
  let pendingGoalSwitch = false;
  if (task.goalId) {
    const current = ports.goals.getActiveGoal();
    if (current?.id !== task.goalId || current?.status === "paused") {
      const gate = ports.goals.getGoalById(task.goalId);
      // `/goal stop` is the user speaking. Auto-resuming here would silently undo it,
      // and advancing a task is not consent to restart a Goal that was deliberately
      // halted. Every other pause reason is system-internal, so resuming is right there.
      if (gate?.status === "paused" && gate.pauseReason === "user") userStoppedGate = gate.text;
      pendingGoalSwitch = true;
    }
  }
  const draft = cloneTodoTask(task);
  const allTasks = getVisibleTasks();
  const taskIndex = allTasks.findIndex((t) => t.id === task.id);

  const parts: string[] = [
    `## Task #${task.id} [${taskIndex + 1}/${allTasks.length}]: ${todoPreview(task, "subject", task.subject, TODO_SUBJECT_BYTES)}`,
  ];
  if (task.description) parts.push(todoPreview(task, "description", task.description, TODO_DESCRIPTION_BYTES));

  const prevContext = buildPrevContext(task.id);
  if (prevContext) {
    parts.push(`\n<prev_steps>\n${prevContext}\n</prev_steps>`);
  }

  // Goal context reflects the gate that becomes active with this task (the
  // switch itself happens after the commit below).
  const contextGoal = (task.goalId ? ports.goals.getGoalById(task.goalId) : undefined) ?? ports.goals.getActiveGoal();
  const goalPreview = (text: string) => boundedTodoText(text, TODO_REFERENCE_BYTES,
    () => 'goal {"action":"get"}');
  if (contextGoal?.text) {
    parts.push(`\n<goal_context>\n${goalPreview(contextGoal.text)}\n</goal_context>`);
  }

  if (userStoppedGate) {
    parts.push(
      `\n<goal_stopped_by_user>\nThe quality-gate Goal "${goalPreview(userStoppedGate)}" was stopped by the user and has been left stopped.`
      + `\nYou can work on this task, but completing it is blocked until the user runs /goal resume. Do not resume the Goal yourself.`
      + `\n</goal_stopped_by_user>`,
    );
  }

  if (task.context) {
    parts.push(`\n<context>\n${todoPreview(task, "context", task.context, TODO_CONTEXT_BYTES)}\n</context>`);
  }
  if (task.resourceUris.length > 0) {
    parts.push(`\nResource URIs: ${todoPreview(task, "resourceUris", todoFieldText(task, "resourceUris"), TODO_REFERENCE_BYTES, true)}`);
  }
  if (task.handoff) parts.push(`\n${todoPreview(task, "handoff", formatTodoHandoff(task), TODO_REFERENCE_BYTES, true)}`);

  // Material review below is asynchronous even when no skills are requested.
  const before = cloneTodoTask(task);
  let activation: SkillActivation | undefined;
  if (draft.skills.length > 0) {
    activation = await guardTodoAwait(ports.skills.activateTask(draft));
    draft.status = "in_progress";
    revalidateAsyncTodoMutation({
      generation,
      before,
      draft,
      actor,
    });
  } else {
    draft.status = "in_progress";
  }
  // Skill prompts are NOT inlined here: the full text is injected once per turn
  // as <active_skill_stack> context while the task is active (onContextTodo).
  // Repeating them in this persistent tool result would double the token cost.
  if (activation && activation.skills.length > 0) {
    const bound = activation.skills
      .map((binding) => `- ${binding.skill.name} (${binding.role})`)
      .join("\n");
    parts.push(`\n<active_skills>\n${todoPreview(task, "skills", bound, 512, true)}\nFull skill instructions arrive as <active_skill_stack> context while this task is active.\n</active_skills>`);
  }

  const current = () => {
    assertTodoSourceExecution();assertCurrentTask(before);
    revalidateAsyncTodoMutation({generation,before,draft,actor});
  };
  await recheckDependencies(task.contractDependencies ?? task.blockedBy,ctx,current);
  current();
  draft.skillActivation = activation ? ports.skills.activationMetadata(activation) : undefined;
  draft.updatedAt = Date.now();
  applyTaskStatusTiming(task, draft, draft.updatedAt);
  const nextTasks = new Map(tasks);
  nextTasks.set(draft.id, draft);
  dispatchBindings.assertActivation(draft.id);
  commitTodoState(nextTasks, undefined, { activated: [draft.id] });
  if (activation) activeSkillSnapshots.set(draft.id, activation);
  runSkillInjection = undefined;
  if (pendingGoalSwitch && task.goalId) {
    try {
      const switched = ports.goals.switchCurrentGoal(task.goalId, ctx, { resume: !userStoppedGate });
      if (!switched) throw new Error(`Goal ${task.goalId} was not found.`);
    } catch (goalError) {
      const rollback = cloneTodoTask(task);
      rollback.updatedAt = Date.now();
      const rollbackTasks = new Map(tasks);
      rollbackTasks.set(rollback.id, rollback);
      try {
        commitTodoState(rollbackTasks);
        ports.skills.clearSkillSnapshot(task.id);
      } catch (rollbackError) {
        return err(
          `Task #${task.id} was activated, but Goal ${task.goalId} selection failed and Todo rollback also failed; the task remains in_progress. Goal error: ${goalError instanceof Error ? goalError.message : String(goalError)}. Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          "next",
        );
      }
      return err(
        `Goal ${task.goalId} selection failed for task #${task.id}; activation was rolled back to ${task.status}. ${goalError instanceof Error ? goalError.message : String(goalError)}`,
        "next",
      );
    }
  }

  return ok(parts.join("\n"), "next");
}

const PREV_CONTEXT_WINDOW = 5;

function buildPrevContext(currentId: string): string | null {
  const current = tasks.get(currentId);
  if (!current) return null;
  // Completed dependencies are removed by autoUnblock. Use existing ownership
  // and plan linkage rather than inventing a persisted dependency history.
  const completed = [...currentTasks().values()]
    .filter((t) => t.status === "completed" && t.id !== currentId && t.summary?.trim());
  const samePlan = current.planHandoffKey
    ? completed.filter((t) => t.planHandoffKey === current.planHandoffKey)
    : [];
  const related = (current.planHandoffKey ? samePlan : completed.filter((t) => t.assignee.id === current.assignee.id))
    .sort((a, b) => a.updatedAt - b.updatedAt);

  if (related.length === 0) return null;
  return related
    .slice(-PREV_CONTEXT_WINDOW)
    .map((t) => `[#${t.id}] ${todoPreview(t, "subject", t.subject, TODO_SUBJECT_BYTES)}: ${todoPreview(t, "summary", t.summary!, TODO_SUMMARY_BYTES)}`)
    .join("\n");
}

function markTodoChanged(): void {
  todoRevision++;
  for (const listener of todoStateChangeSubscribers) {
    try {
      listener();
    } catch {
      // Projection listeners are best-effort and must not break Todo mutations.
    }
  }
}

/**
 * Ids are peeked during validation and only committed (counter advanced) once
 * the create is known to succeed, so failed creates do not burn id numbers.
 */
function commitTaskIds(start: number, count: number): void {
  nextTaskId = Math.max(nextTaskId, start + count);
}

function syncTaskIdCounter(state: Map<string, TodoTask> = tasks): void {
  let max = ports.storage.getReplacementAllocatorHighWater?.() ?? 0;
  for (const id of state.keys()) {
    const n = Number(id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  for (const group of deliveryGroups) for (const receipt of group.replacementHistory ?? []) max = Math.max(max, receipt.allocatorHighWater, ...receipt.reservedIds.map(Number));
  nextTaskId = max + 1;
}

/** Keep new handoff annotations newer than every revision restored from disk. */
function syncTodoRevision(state: Map<string, TodoTask> = tasks): void {
  for (const task of state.values()) {
    if (!task.handoff) continue;
    todoRevision = Math.max(todoRevision, task.handoff.nextStepsRevision ?? 0, task.handoff.filesClearedRevision ?? 0);
    for (const file of task.handoff.files) {
      todoRevision = Math.max(todoRevision, file.annotationRevision);
    }
  }
}

function cloneSkillActivation(activation: SkillActivationMetadata): SkillActivationMetadata {
  return {
    ...activation,
    bindings: activation.bindings.map(ports.skills.cloneActivationBinding),
  };
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

function resolveBlockedBy(taskId: string, proposedDeps: readonly string[], state: Map<string, TodoTask> = tasks) {
  return resolveBlockedByInState(taskId, proposedDeps, currentTasks(state));
}
/**
 * Drop the quality-gate binding from every task pointing at `goalId`.
 *
 * Mirrors {@link autoUnblock}: when an entity is destroyed, the references to it must go with
 * it. Without this, clearing a Goal leaves its bound tasks stuck at the completion gate
 * (`ports.goals.getGoalById` returns undefined) with no path to completion short of a manual
 * `update goalId: ""`.
 *
 * Returns the number of tasks detached so callers can surface it instead of failing silently.
 */
export function detachTasksFromGoal(goalId: string): number {
  assertTodoSourceExecution();
  if (!goalId) return 0;
  const next = new Map(tasks);
  let detached = 0;
  for (const [id, task] of next) {
    if (taskIsCleared(taskClearHistory,task.id) || task.status === "deleted" || task.supersessionId || task.goalId !== goalId) continue;
    const draft = cloneTodoTask(task);
    if (ports.goals.getGoalById(goalId)?.status === "done") draft.verifiedQualityGateId = goalId;
    delete draft.goalId;
    draft.updatedAt = Date.now();
    next.set(id, draft);
    detached += 1;
  }
  if (detached === 0) return 0;
  commitTodoState(next, undefined, undefined, deliveryGroups, goalId);
  return detached;
}

/** Persist and publish the state restored by Todo startup before a Goal recovery marker clears. */
export function persistLoadedTodoStateForGoalDetachRecovery(): void {
  assertTodoSourceExecution();
  if (!todoSessionLoaded) throw new Error("Todo state must be loaded before Goal cleanup recovery.");
  commitTodoState(new Map(tasks));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Sole-owner metadata projection. No evidence IO and no native/provider lookup. */
function refreshAcceptanceProjection(state:Map<string,TodoTask>):void {
 for(const task of state.values()) {
  if (taskIsCleared(taskClearHistory,task.id) || task.supersessionId || task.replacementPendingId) continue;
  if(taskReviewRequired(task))task.reviewRequired=true;else delete task.reviewRequired;
  if(task.origin || !["pending","blocked","in_progress"].includes(task.status) || task.skipResolution)continue;
  task.blockedBy=(task.contractDependencies??task.blockedBy).filter(id=>!taskDependencySatisfied(state,id));
  if(task.status!=="in_progress")task.status=deriveDependencyStatus(task.blockedBy);
 }
}
function queueAcceptanceProjection():void {
 const source=loadedSourceExecution;if(!source||!todoSessionLoaded||hasPendingPlanReplacementRecovery()||hasPendingTaskClearRecovery())return;
 const work=()=>runTodoSourceExecution(source,()=>{if(hasPendingPlanReplacementRecovery()||hasPendingTaskClearRecovery())return;const next=cloneTaskMap(tasks);refreshAcceptanceProjection(next);if(digest([...next])!==digest([...tasks]))commitTodoState(next);});
 const queued=todoMutationQueue.then(work,work);todoMutationQueue=queued.then(()=>undefined,()=>undefined);
 void queued.catch(error=>{if(error instanceof TodoPublicationUnconfirmedError)console.warn(`[pi-graph-flow] Task review projection publication unconfirmed: ${error.message}`);});
}

function commitTodoState(
  nextTasks: Map<string, TodoTask>,
  validatePersisted?: () => void,
  progress?: TaskProgressCommit,
  nextGroups: readonly DeliveryGroup[] = deliveryGroups,
  goalDetachId?: string,
  handoffOwn?: HandoffOwnCommit,
): void {
  assertTodoSourceExecution();
  if (handoffOwn && (handoffOwnCommits.get(sourceExecution.getStore()!) !== handoffOwn
    || handoffOwn.generation !== todoGeneration || handoffOwn.confirmed || handoffOwn.publishing)) {
    throw new Error("Handoff commit context changed before publication.");
  }
  assertNoPlanReplacement();
  const generation = todoGeneration;
  validateClearHistory(taskClearHistory,nextTasks,nextGroups);
  const committed = cloneTaskMap(nextTasks);
  reconcileTaskContracts(tasks, committed);
  refreshAcceptanceProjection(committed);
  validateClearHistory(taskClearHistory,committed,nextGroups);
  let prepared = ports.storage.persist.prepare?.(committed, nextGroups);
  let publicationObserved=false;
  try {
  const journalOnly = nativeRecovery.beforeCommit(tasks, committed, goalDetachId && prepared ? {
    goalId: goalDetachId,
    normalizedBeforeDigest: digest(ports.storage.persist.prepare!(tasks, deliveryGroups).publication.state),
    afterDigest: digest(prepared!.publication.state),
    afterSemanticDigest: prepared.semanticDigest,
    updatedAt: Object.fromEntries([...committed].map(([id, task]) => [id, task.updatedAt])),
    hasNewContents: prepared!.hasNewContents,
  } : undefined);
  if (journalOnly) {
    if (Object.keys(journalOnly.updatedAt).length !== committed.size) throw new Error("Native journal witness timestamp slots differ");
    for (const [id, time] of Object.entries(journalOnly.updatedAt)) {
      const task = committed.get(id); if (!task) throw new Error("Native journal witness timestamp slot missing");
      task.updatedAt = time;
    }
    prepared = ports.storage.persist.prepare!(committed, nextGroups);
    if (prepared!.hasNewContents || digest(prepared!.publication.state) !== journalOnly.afterDigest) throw new Error("Native journal witness exact publication differs");
    prepared!.assertExistingContents();
    journalOnly.assertCurrent();
  }
  for (const [id, task] of committed) nextTasks.set(id, cloneTodoTask(task));
  if (handoffOwn) {
    if (!prepared) throw new Error("Exact original handoff publication preparation is unavailable.");
    handoffOwn.publishing = { expectedDigest: digest(prepared.publication.state) };
  }
  ports.storage.persist(cloneTaskMap(committed), nextGroups);
  publicationObserved=true;
  if (handoffOwn && (!handoffOwn.publishing?.observedDigest || !handoffOwn.publishing.observedEntryId
    || handoffOwn.publishing.observedDigest !== handoffOwn.publishing.expectedDigest)) {
    throw new TodoPublicationUnconfirmedError("Original handoff publication was not observed.");
  }
  if (journalOnly) prepared!.assertExistingContents();
  journalOnly?.assertCurrent();
  ports.storage.assertTodoGeneration(generation);
  validatePersisted?.();
  dispatchBindings.validatePublication(tasks,committed);
  dispatchBindings.committed(tasks,committed,progress);
  assertTodoSourceExecution();
  tasks = committed;
  deliveryGroups = structuredClone([...nextGroups]);
  if (handoffOwn) {
    const target = tasks.get(handoffOwn.taskId);
    if (!target || handoffOwn.generation !== todoGeneration) throw new Error("Confirmed handoff target changed.");
    handoffOwn.confirmed = Object.freeze({ revision: todoRevision + 1,
      publicationDigest: handoffOwn.publishing!.observedDigest!, publicationEntryId: handoffOwn.publishing!.observedEntryId!,
      taskFingerprint: JSON.stringify(target), stateFingerprint: digest([...tasks]), groupsFingerprint: digest(deliveryGroups) });
    handoffOwn.publishing = undefined;
  }
  } catch (error) { invalidateTodoSource(); throw publicationObserved && !(error instanceof TodoPublicationUnconfirmedError) ? new TodoPublicationUnconfirmedError(error) : error; }
  markTodoChanged();
  assertTodoSourceExecution();
  try {
    onTodoStateChanged?.();
  } catch (error) {
    console.warn(`[pi-graph-flow] Todo state projection failed after commit: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Subscribe to every Todo revision change without replacing the root UI listener. */
export function subscribeTodoStateChanges(listener: () => void): () => void {
  todoStateChangeSubscribers.add(listener);
  return () => todoStateChangeSubscribers.delete(listener);
}

/** Bind the root UI/UCL to durable Todo state changes. */
export function setTodoStateChangeListener(listener: (() => void) | undefined): void {
  onTodoStateChanged = listener;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface AsyncTodoMutationCheck {
  generation: number;
  before: TodoTask;
  draft: TodoTask;
  actor: TodoActorRef;
}

/**
 * Async skill loading must not publish a draft derived from stale Todo state.
 * Re-check every task-level authority and graph invariant at the await
 * boundary even though ordinary tool mutations are serialized: canonical
 * Workflow mirrors and session lifecycle hooks can still change module state
 * independently. The checks are deliberately scoped to the mutated task (deep
 * compare, permissions, dependency graph, in_progress uniqueness, transition
 * validity) rather than a global revision counter, so unrelated concurrent
 * changes — e.g. a teammate updating a different task — do not force a
 * spurious retry.
 */
function revalidateAsyncTodoMutation(check: AsyncTodoMutationCheck): TodoTask {
  assertTodoSourceExecution();
  ports.storage.assertTodoGeneration(check.generation);

  const current = tasks.get(check.before.id);
  if (!current || taskIsCleared(taskClearHistory,current.id) || current.status === "deleted") {
    throw new Error(`Task #${check.before.id} is no longer available after skill activation.`);
  }
  if (JSON.stringify(current) !== JSON.stringify(check.before)) {
    throw new Error(`Task #${check.before.id} changed while its skills were activating; retry the mutation.`);
  }
  if (!canEditTask(check.actor, current)) {
    throw new Error(`@${check.actor.label} can no longer update task #${check.before.id}.`);
  }

  const dependencyCheck = resolveBlockedBy(check.draft.id, check.draft.blockedBy);
  if (dependencyCheck.error) throw new Error(dependencyCheck.error);
  if (JSON.stringify(dependencyCheck.blockedBy) !== JSON.stringify(check.draft.blockedBy)) {
    throw new Error(`Dependencies changed while activating task #${check.draft.id}; retry the mutation.`);
  }
  if (check.draft.status === "in_progress") {
    if (dependencyCheck.blockedBy.length > 0) {
      throw new Error(`Task #${check.draft.id} is blocked by: ${dependencyCheck.blockedBy.join(", ")}`);
    }
    const active = findActiveTask(check.draft.assignee.id, check.draft.id);
    if (active) {
      throw new Error(
        `Task #${active.id} is already in progress for @${check.draft.assignee.label} (one in_progress per actor). For parallel work, dispatch teammates without changing todo status; update each task when its agent completes.`,
      );
    }
  }
  if (
    check.draft.status !== current.status
    && !isValidTransition(current.status, check.draft.status)
  ) {
    throw new Error(`Invalid status transition: ${current.status} → ${check.draft.status}`);
  }
  return current;
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "completed": return "[x]";
    case "in_progress": return "[>]";
    case "blocked": return "[!]";
    case "pending": return "[ ]";
    case "deleted": return "[-]";
  }
}

function taskChanged(before: TodoTask, after: TodoTask): boolean {
  if (digest(before.acceptanceReport) !== digest(after.acceptanceReport) || digest(before.acceptanceCriteria) !== digest(after.acceptanceCriteria) || digest(before.skipResolution) !== digest(after.skipResolution)) return true;
  return (
    before.subject !== after.subject ||
    before.description !== after.description ||
    before.status !== after.status ||
    before.summary !== after.summary ||
    JSON.stringify(before.blockedBy) !== JSON.stringify(after.blockedBy) ||
    before.context !== after.context ||
    before.goalId !== after.goalId ||
    JSON.stringify(before.skills) !== JSON.stringify(after.skills) ||
    JSON.stringify(before.resourceUris) !== JSON.stringify(after.resourceUris) ||
    JSON.stringify(before.handoff) !== JSON.stringify(after.handoff) ||
    JSON.stringify(before.origin) !== JSON.stringify(after.origin) ||
    JSON.stringify(before.createdBy) !== JSON.stringify(after.createdBy) ||
    JSON.stringify(before.assignee) !== JSON.stringify(after.assignee) ||
    before.activeStartedAt !== after.activeStartedAt ||
    before.activeDurationMs !== after.activeDurationMs ||
    before.completedAt !== after.completedAt
  );
}

function mirrorTaskId(originKey: string): string {
  return `wf-${createHash("sha256").update(originKey).digest("hex").slice(0, 8)}`;
}

function uniqueMirrorId(
  candidate: string,
  originKey: string,
  state: Map<string, TodoTask> = tasks,
): string {
  const occupied = state.get(candidate);
  if (!occupied || (occupied.origin && todoOriginKey(occupied.origin) === originKey)) return candidate;
  return `wf-${createHash("sha256").update(`${originKey}\u0000collision`).digest("hex").slice(0, 12)}`;
}

function mirrorActivationStillValid(before: TodoTask, after: TodoTask): boolean {
  return before.status === "in_progress"
    && after.status === "in_progress"
    && before.context === after.context
    && JSON.stringify(before.skills) === JSON.stringify(after.skills);
}

async function ensureSkillActivation(task: TodoTask): Promise<AnySkillActivation> {
  const cached = activeSkillSnapshots.get(task.id);
  // Without the `cached &&` guard, a task with no cached snapshot and no
  // skillActivation compares undefined === undefined and returns undefined
  // from a function declared to yield a SkillActivation.
  if (cached && cached.stackRevision === task.skillActivation?.stackRevision) {
    return cached;
  }
  const generation = todoGeneration;
  const before = cloneTodoTask(task);
  let activation: SkillActivation;
  try {
    activation = await guardTodoAwait(ports.skills.requireSkillRuntime().activate(
      task.skills,
      task.context ?? "",
      task.skillActivation,
    ));
  } catch (error) {
    // onContextTodo is wired to pi.on("context"), so a throw here escapes into the
    // host on *every* turn and wedges the session. Re-activation is guaranteed to be
    // attempted after a restart (snapshots live in memory, ports.storage.persist only writes tasks),
    // so a skill file that has gone missing or invalid since activation would do
    // exactly that.
    //
    // Degrade instead: prefer the last snapshot that did load, otherwise synthesize an
    // empty activation whose prompt is a warning block. Neither is cached and neither is
    // persisted, so the next turn retries the real load and recovers on its own.
    const stale = activeSkillSnapshots.get(task.id);
    if (stale) return stale;
    return ports.skills.degradedActivation(task, error);
  }
  // The revalidation shares the fail-open constraint above: a concurrent Todo
  // mutation during the activate await must not escape this context-hook path
  // as an exception. On conflict the fresh activation still serves this turn,
  // but nothing is cached or persisted — the next turn re-activates against
  // the settled state. This also keeps the ports.storage.persist below from racing queued
  // mutations: it only runs when the task provably did not change.
  let current: TodoTask;
  try {
    current = revalidateAsyncTodoMutation({
      generation,
      before,
      draft: before,
      actor: ROOT_TODO_ACTOR,
    });
  } catch {
    return activation;
  }
  const nextMetadata: SkillActivationMetadata = {
    activationId: activation.activationId,
    stackRevision: activation.stackRevision,
    activatedAt: activation.activatedAt,
    validatedAt: activation.validatedAt,
    state: activation.state,
    bindings: activation.bindings.map(ports.skills.cloneActivationBinding),
  };
  if (JSON.stringify(current.skillActivation) !== JSON.stringify(nextMetadata)) {
    const draft = cloneTodoTask(current);
    draft.skillActivation = nextMetadata;
    const nextTasks = new Map(tasks);
    nextTasks.set(draft.id, draft);
    commitTodoState(nextTasks);
  }
  activeSkillSnapshots.set(current.id, activation);
  return activation;
}

function cloneActor(actor: TodoActorRef): TodoActorRef {
  return { ...actor };
}

function rememberActor(actor: TodoActorRef): void {
  knownActors.set(actor.id, cloneActor(actor));
}

type TodoActorResolution =
  | { actor: TodoActorRef }
  | { error: string; reason: "unknown" | "ambiguous" };

function resolveTodoActorSelector(requested: string, actor: TodoActorRef): TodoActorResolution {
  const selector = requested.trim().replace(/^@/, "");
  if (selector === "self" || selector === actor.id || selector === actor.label) {
    return { actor: cloneActor(actor) };
  }
  if (selector === ROOT_TODO_ACTOR.id) return { actor: cloneActor(ROOT_TODO_ACTOR) };

  const exactId = knownActors.get(selector);
  if (exactId) return { actor: cloneActor(exactId) };

  const labelMatches = [...knownActors.values()].filter((candidate) => candidate.label === selector);
  if (labelMatches.length === 1) return { actor: cloneActor(labelMatches[0]) };
  if (labelMatches.length > 1) {
    return {
      error: `Ambiguous Todo member selector: ${requested}; use label#unique-id-prefix or the full member id`,
      reason: "ambiguous",
    };
  }

  const marker = selector.lastIndexOf("#");
  if (marker > 0 && marker < selector.length - 1) {
    const label = selector.slice(0, marker);
    const idPrefix = selector.slice(marker + 1);
    const decoratedMatches = [...knownActors.values()].filter((candidate) =>
      candidate.label === label && candidate.id.startsWith(idPrefix)
    );
    if (decoratedMatches.length === 1) return { actor: cloneActor(decoratedMatches[0]) };
    if (decoratedMatches.length > 1) {
      return {
        error: `Ambiguous Todo member selector: ${requested}; use a longer id prefix`,
        reason: "ambiguous",
      };
    }
  }

  if (!selector.includes("#")) {
    const idPrefixMatches = [...knownActors.values()].filter((candidate) => candidate.id.startsWith(selector));
    if (idPrefixMatches.length === 1) return { actor: cloneActor(idPrefixMatches[0]) };
    if (idPrefixMatches.length > 1) {
      return {
        error: `Ambiguous Todo member selector: ${requested}; use a longer id prefix or the full member id`,
        reason: "ambiguous",
      };
    }
  }

  return { error: `Unknown Todo member selector: ${requested}`, reason: "unknown" };
}

function resolveAssignee(
  requested: string | undefined,
  actor: TodoActorRef,
): { actor: TodoActorRef } | { error: string } {
  if (!requested) return { actor: cloneActor(actor) };
  const resolved = resolveTodoActorSelector(requested, actor);
  if ("error" in resolved) {
    if (actor.kind !== "root") {
      return { error: `@${actor.label} can only assign Todo tasks to self or root` };
    }
    return { error: resolved.reason === "ambiguous"
      ? resolved.error.replace("member selector", "assignee")
      : `Unknown Todo assignee: ${requested}` };
  }
  if (actor.kind !== "root" && resolved.actor.id !== actor.id && resolved.actor.id !== ROOT_TODO_ACTOR.id) {
    return { error: `@${actor.label} can only assign Todo tasks to self or root` };
  }
  return resolved;
}

function canEditTask(actor: TodoActorRef, task: TodoTask): boolean {
  return actor.kind === "root" || task.createdBy.id === actor.id || task.assignee.id === actor.id;
}

function canDeleteTask(actor: TodoActorRef, task: TodoTask): boolean {
  if (actor.kind === "root") return true;
  if (task.createdBy.id !== actor.id) return false;
  return task.assignee.id === actor.id || task.status !== "in_progress";
}

function actorTag(task: TodoTask): string {
  const actors = [...knownActors.values()];
  const createdBy = formatTodoActorSelector(task.createdBy, actors);
  const assignee = formatTodoActorSelector(task.assignee, actors);
  return task.createdBy.id === task.assignee.id
    ? `@${assignee}`
    : `@${createdBy}→@${assignee}`;
}

function findActiveTask(
  assigneeId: string,
  excludeId?: string,
  state: Map<string, TodoTask> = tasks,
): TodoTask | undefined {
  return [...state.values()].find(
    (task) => !taskIsCleared(taskClearHistory,task.id) && !task.supersessionId && !task.replacementPendingId && task.status === "in_progress"
      && task.assignee.id === assigneeId
      && task.id !== excludeId,
  );
}

function snapshotDetails(
  action: string,
  error?: string,
  displayTaskIds?: string[],
  transition?: TodoAdvanceTransition,
): TodoResultDetails {
  const capturedAt = Date.now();
  const visibleTasks = getVisibleTasks();
  const scopedTasks = error === undefined
    ? visibleTasks
    : displayTaskIds === undefined
      ? []
      : visibleTasks.filter((task) => displayTaskIds.includes(task.id));
  const tasks = scopedTasks.map((task): TodoTaskSnapshot => {
    const durationMs = (task.activeDurationMs ?? 0)
      + (task.status === "in_progress" && task.activeStartedAt !== undefined
        ? Math.max(0, capturedAt - task.activeStartedAt)
        : 0);
    return {
      id: task.id,
      ...(task.skipResolution ? { resolution: "skipped" as const } : {}),
      ...(task.reviewRequired ? { reviewRequired:true } : {}),
      subject: task.subject,
      status: task.status,
      assignee: cloneActor(task.assignee),
      ...(task.blockedBy.length > 0 ? { blockedBy: [...task.blockedBy] } : {}),
      ...(error === undefined && task.summary ? { summary: task.summary } : {}),
      ...(durationMs > 0 || task.status === "completed" ? { durationMs } : {}),
      ...(task.status === "completed" ? { completedAt: task.completedAt ?? task.updatedAt } : {}),
    };
  });
  return {
    action,
    tasks,
    ...(displayTaskIds !== undefined ? { displayTaskIds } : {}),
    ...(transition !== undefined ? { transition } : {}),
    ...(error ? { error } : {}),
  };
}

function ok(
  text: string,
  action = "unknown",
  displayTaskIds?: string[],
  transition?: TodoAdvanceTransition,
): FlowToolResult {
  return {
    content: [{ type: "text", text }],
    details: snapshotDetails(action, undefined, displayTaskIds, transition),
  };
}

function err(text: string, action = "unknown", affectedTaskIds?: string[]): FlowToolResult {
  return {
    content: [{ type: "text", text: `Error: ${text}` }],
    isError: true,
    details: snapshotDetails(action, text, affectedTaskIds),
  };
}

async function guardTodoAwait<T>(promise: T | PromiseLike<T>): Promise<T> {
  const execution = sourceExecution.getStore() ?? captureTodoSourceExecution();
  try { const result = await promise; assertTodoSourceExecution(execution); return result; }
  catch (error) {
    if (error instanceof TodoPublicationUnconfirmedError) throw error;
    try { assertTodoSourceExecution(execution); }
    catch (sourceError) {
      throw new Error(sourceError instanceof Error ? sourceError.message : String(sourceError), { cause: error });
    }
    throw error;
  }
}
