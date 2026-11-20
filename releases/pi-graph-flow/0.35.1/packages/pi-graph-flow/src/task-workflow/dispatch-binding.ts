import { assertTaskReplacementEligible } from "./plan-replacement.ts";
import { taskDependencySatisfied, reconcileTaskContracts } from "./acceptance.ts";
import { ownedExecutionContract, type OwnedExecutionContract } from "./execution-contract.ts";
import { randomUUID } from "node:crypto";
import { isTaskDispatchCancellationScope, type TaskNativeRecoveryProvider, type TaskDispatchCancellationScope, TASK_DISPATCH_ENTRY, type TaskDispatchHost, type TaskDispatchManager, type TaskDispatchProvider, type TaskDispatchRequest, type PreparedTaskDispatch, type TaskDispatchItemState } from "pi-maestro-teammate/v1/task-dispatch-binding";
import { ROOT_TODO_ACTOR, type TodoTask } from "./types.ts";
import { createTaskVersions, taskDigest as digest, type TaskProgressCommit } from "./dispatch-binding-versions.ts";
const STATE = "pi-graph-next:todo-state";
interface Ports {
  nativeRecovery?:TaskNativeRecoveryProvider;
  source?: {capture():object;assert(context:object):void;assertFacts?(context:object):void;run<T>(context:object,work:()=>T):T;subscribe(context:object,listener:()=>void):()=>void};
  recheckDependencies?(ids:readonly string[],assertCurrent:()=>void):Promise<void>;
  state(): Map<string, TodoTask>;
  host(): { cwd: string; sessionId?: string; sessionManager: unknown } | undefined;
  assertBusinessTask?(task: TodoTask): void;
  enqueue<T>(work: () => T | Promise<T>): Promise<T>;
  commit(next: Map<string, TodoTask>, validatePersisted?: () => void, source?: TaskProgressCommit): void;
  subscribe(listener: () => void): () => void;
  persistedMatches(data: unknown, next: Map<string, TodoTask>): boolean;
  append(type: string, data: unknown): void;
}
interface Fence {
  sourceContext?:object;
  cancellation?: TaskDispatchCancellationScope; signals: Set<AbortSignal>; host: TaskDispatchHost; generation: number; anchor: string; intentId: string; intentDigest: string;
}
/** A component of the sole Task writer: no second Task map, queue or authority store. */
export function createTaskDispatchBinding(ports: Ports) {
  let generation = 0;
  let ownerStateAnchor: string | undefined;
  let ownerStateDigest: string | undefined;
  const versions = createTaskVersions();
  const tokens = new WeakMap<object, Fence>();
  const reserved = new Map<string, PreparedTaskDispatch>();
  const ownedContracts = new Map<string, Map<string, OwnedExecutionContract>>();
  const neverSubmitted = new Set<string>();
  const witnessOwner = randomUUID();

  function manager(): TaskDispatchManager | undefined {
    const m = ports.host()?.sessionManager as Partial<TaskDispatchManager> | undefined;
    return typeof m?.getBranch === "function" && typeof m.getSessionId === "function" ? m as TaskDispatchManager : undefined;
  }
  function latestState(m: TaskDispatchManager) { return m.getBranch().filter(e => e.type === "custom" && e.customType === STATE).at(-1); }
  function captureState() {
    const m = manager(); const entry = m && latestState(m);
    ownerStateAnchor = entry?.id; ownerStateDigest = entry && digest(entry.data);
  }
  function assertHost(host: TaskDispatchHost): void {
    const h = ports.host();
    if (!h || host.manager !== h.sessionManager || host.cwd !== h.cwd || host.sessionId !== h.sessionId || host.manager.getSessionId() !== host.sessionId || process.env.PI_TEAMMATE_CHILD === "1" || process.env.PI_TEAMMATE_MANAGED_WINDOW === "1") throw new Error("Task dispatch requires current canonical root host");
    const entry = latestState(host.manager);
    if (!ownerStateAnchor || entry?.id !== ownerStateAnchor || digest(entry?.data) !== ownerStateDigest) throw new Error("Todo owner is not loaded from the current branch state");
  }
  function assertScope(token: PreparedTaskDispatch, facts=false): void {
    const f = tokens.get(token);
    if (!facts && (f?.cancellation?.cancelled || [...(f?.signals ?? [])].some(signal=>signal.aborted))) throw new Error("Task binding cancelled");
    if (!f || f.generation !== generation) throw new Error("Task binding generation changed");
    if(f.sourceContext){if(facts&&ports.source?.assertFacts)ports.source.assertFacts(f.sourceContext);else ports.source?.assert(f.sourceContext);}
    assertHost(f.host);
    const branch = f.host.manager.getBranch();
    if (!branch.some(e => e.id === f.anchor) || !branch.some(e => e.id === f.intentId && digest(e.data) === f.intentDigest)) throw new Error("Task binding branch changed");
  }
  function itemStates(token: PreparedTaskDispatch, facts=false): readonly TaskDispatchItemState[] {
    assertScope(token,facts);
    return token.contracts.map(ref => {
      const task = ports.state().get(ref.taskId);
      if (task) { assertTaskReplacementEligible(task); ports.assertBusinessTask?.(task); }
      const stateRevision = versions.state(ref.taskId);
      const owned = ownedContracts.get(token.id)?.get(ref.taskId);
      if (!task || (owned && owned.taskInstanceId !== task.taskInstanceId) || versions.contract(ref.taskId) !== ref.version || task.status === "deleted") return { taskId: ref.taskId, state: "historical", stateRevision, completionObserved: versions.wasCompleted(ref.taskId,ref.version) };
      if (task.status === "completed") return { taskId: ref.taskId, state: "completed", stateRevision };
      for (const dep of ref.declaredDependencies ?? []) {
        const current = ports.state().get(dep.taskId);
        if (!current || current.status === "deleted" || versions.contract(dep.taskId) !== dep.version) return { taskId: ref.taskId, state: "invalid_dependency", stateRevision };
      }
      const blocked = (ref.declaredDependencies ?? []).some(dep => !taskDependencySatisfied(ports.state(),dep.taskId)) || task.blockedBy.length > 0;
      return { taskId: ref.taskId, state: blocked ? "blocked" : task.status === "in_progress" ? "active" : "ready", stateRevision };
    });
  }
  function runnable(token: PreparedTaskDispatch): string | undefined {
    const items = itemStates(token);
    const active = items.find(item => item.state === "active");
    if (active) return active.taskId;
    // A completed item is history; it cannot revoke an unchanged sibling contract.
    const invalid = items.find(item => (item.state === "historical" && !item.completionObserved) || item.state === "invalid_dependency");
    if (invalid) throw new Error(`Task binding contract/state changed for #${invalid.taskId}`);
    const ready = items.find(item => item.state === "ready");
    if (ready) return ready.taskId;
    if (items.every(item => item.state === "completed" || item.completionObserved)) throw new Error("Task binding has no unfinished Task");
    return undefined;
  }
  function assertActivation(taskId: string): void {
    const current = ports.state().get(taskId); if (current) { assertTaskReplacementEligible(current); ports.assertBusinessTask?.(current); }
    const token = reserved.get(taskId);
    if (!token || ports.state().get(taskId)?.assignee.id !== token.correlationId) return;
    const item = itemStates(token).find(item => item.taskId === taskId);
    if (!item || (item.state !== "ready" && item.state !== "active")) throw new Error(`Task binding contract/state changed or dependency unresolved for #${taskId}`);
  }
  async function activate(token: PreparedTaskDispatch, signal?: AbortSignal): Promise<void> {
    const context=tokens.get(token)?.sourceContext;
    const enqueue=()=>ports.enqueue(async () => {
      signal?.throwIfAborted();
      const id = runnable(token);
      if (!id) throw new Error("Task readiness changed before activation");
      const task = ports.state().get(id)!;
      const current=()=>{signal?.throwIfAborted();assertScope(token);if(runnable(token)!==id)throw new Error("Task readiness changed during dependency review");};
      await ports.recheckDependencies?.(token.contracts.find(ref=>ref.taskId===id)?.declaredDependencies?.map(dep=>dep.taskId)??[],current);current();
      if (task.status === "in_progress") return;
      assertActivation(id);
      const next = structuredClone(ports.state());
      next.get(id)!.status = "in_progress"; next.get(id)!.updatedAt = Date.now();
      ports.commit(next, undefined, { activated: [id] });
    });
    await (context && ports.source ? ports.source.run(context,enqueue) : enqueue());
  }
  async function waitReady(token: PreparedTaskDispatch, signal?: AbortSignal): Promise<void> {
    const fence=tokens.get(token);
    if(!fence)throw new Error("Task binding generation changed");
    if(signal)fence.signals.add(signal);
    const disposers:Array<()=>void>=[];
    try {
      await new Promise<void>((resolve,reject)=>{
        let settled=false;
        const finish=(error?:unknown)=>{if(settled)return;settled=true;error?reject(error):resolve();};
        const check=()=>{try{if(runnable(token))finish();}catch(error){finish(error);}};
        disposers.push(ports.subscribe(check));
        if(fence.sourceContext && ports.source)disposers.push(ports.source.subscribe(fence.sourceContext,check));
        if(fence.cancellation)disposers.push(fence.cancellation.subscribe(check));
        for(const original of fence.signals){
          original.addEventListener("abort",check,{once:true});
          disposers.push(()=>original.removeEventListener("abort",check));
        }
        check();
      });
    } finally {
      for(const dispose of disposers)dispose();
    }
  }
  function validateRequests(host: TaskDispatchHost, requests: readonly TaskDispatchRequest[]): void {
    const ids = new Set<string>();
    for (const request of requests) {
      if (request.cwd !== host.cwd || !request.correlationId || !request.agent) throw new Error("Task dispatch scope mismatch");
      for (const id of request.todoIds) {
        if (ids.has(id)) throw new Error(`Duplicate Todo dispatch #${id}`); ids.add(id);
        const task = ports.state().get(id);
        if (!task || task.origin || task.assignee.kind !== "root" || task.assignee.id !== ROOT_TODO_ACTOR.id || !["pending", "in_progress", "blocked"].includes(task.status)) throw new Error(`Todo #${id} is unknown, not root-owned or not dispatchable`);
        assertTaskReplacementEligible(task); ports.assertBusinessTask?.(task);
        if(task.dispatchSubmissionId)throw new Error(`settlement-unknown: Todo #${id} has a prior positive admission; restore existing closed work rather than replaying it`);
        for (const dep of task.blockedBy) if (!ports.state().has(dep) || ports.state().get(dep)?.status === "deleted") throw new Error(`Todo #${id} has invalid dependency #${dep}`);
      }
    }
  }
  const provider: TaskDispatchProvider = {
    ...(ports.nativeRecovery?{nativeRecovery:ports.nativeRecovery}:{}),
    async prepare(host, requests, signal, cancellations) {
      const sourceContext=ports.source?.capture();
      if (ports.nativeRecovery?.preflightBudget) {
        if (sourceContext) ports.source?.assert(sourceContext);
        assertHost(host); validateRequests(host, requests);
        for (const request of requests) ports.nativeRecovery.preflightBudget(request.todoIds);
      }
      await ports.nativeRecovery?.ready();if(sourceContext)ports.source?.assert(sourceContext);
      const enqueue=()=>ports.enqueue(() => {
      if(sourceContext)ports.source?.assert(sourceContext);
      if(cancellations && (cancellations.length!==requests.length || cancellations.some(scope=>!isTaskDispatchCancellationScope(scope))))throw new Error("Untrusted Task cancellation scope");
      signal?.throwIfAborted();
      if(cancellations?.some(scope=>scope.cancelled))throw new Error("Task binding registration cancelled before preparation");
      assertHost(host); validateRequests(host, requests);
      for (const request of requests) ports.nativeRecovery?.preflightBudget?.(request.todoIds);
      const anchor = host.manager.getBranch().at(-1)?.id;
      if (!anchor) throw new Error("Task dispatch requires an observable branch anchor");
      const current = ports.state(); const next = structuredClone(current);
      const assigned = new Set(requests.flatMap(request => [...request.todoIds]));
      const intentId = randomUUID();
      for (const request of requests) {
        let activated = false;
        for (const id of request.todoIds) {
          const task = next.get(id)!;
          task.dispatchSubmissionId = intentId;
          task.assignee = { kind: "teammate", id: request.correlationId, label: request.name ?? request.agent, agentType: request.agent };
          task.status = task.blockedBy.length ? "blocked" : activated ? "pending" : "in_progress";
          if (task.status === "in_progress") activated = true;
          task.updatedAt = Date.now();
        }
      }
      reconcileTaskContracts(current,next);
      const predictedVersion = (id: string) => versions.contract(id) + (assigned.has(id) ? 1 : 0);
      const prepared = requests.map(request => ({ id: randomUUID(), agent: request.agent, cwd: request.cwd, sessionId: host.sessionId, branchAnchor: anchor,
        correlationId: request.correlationId, runtimeGeneration: request.runtimeGeneration, todoIds: [...request.todoIds],
        contracts: request.todoIds.map(id => { const task = next.get(id)!; return { taskId: id, version: predictedVersion(id), taskDigest: ownedExecutionContract(task,predictedVersion(id))?.tokenDigest ?? digest(task),
          declaredDependencies: (current.get(id)!.contractDependencies??current.get(id)!.blockedBy).map(dep => ({ taskId: dep, version: predictedVersion(dep) })),
          ...(task.planHandoffKey ? { planHandoffKey: task.planHandoffKey } : {}), ...(task.goalId ? { qualityGoalId: task.goalId } : {}) }; }) }));
      for(const id of assigned){const task=current.get(id);if(task?.taskInstanceId)neverSubmitted.delete(task.taskInstanceId);}
      const cores = prepared.flatMap(item=>item.contracts.flatMap(ref=>{const core=ownedExecutionContract(next.get(ref.taskId)!,ref.version);return core?[core]:[];}));
      const payload = { version: 1, intentId, ownerGeneration: generation, sessionId: host.sessionId, cwd: host.cwd, anchor, bindings: prepared, ...(cores.length?{ownedContracts:cores}:{}) };
      // Positive admission is durable before the prepared-intent append can fail or become unknown.
      // It changes no execution input/version and never authorizes execution by itself.
      if(cores.length){const admission=structuredClone(current);for(const core of cores)admission.get(core.taskId)!.dispatchSubmissionId=intentId;ports.commit(admission);assertHost(host);}
      ports.append(TASK_DISPATCH_ENTRY, payload);
      const persisted = host.manager.getBranch().find(e => e.customType === TASK_DISPATCH_ENTRY && digest(e.data) === digest(payload));
      if (!persisted?.id) throw new Error("Prepared intent append was not observable; no dispatch permitted");
      signal?.throwIfAborted();
      if(cancellations?.some(scope=>scope.cancelled))throw new Error("Task binding registration cancelled before commit");
      assertHost(host);
      const priorStateId = ownerStateAnchor;
      ports.commit(next, () => {
        const stored = latestState(host.manager);
        if (!stored?.id || stored.id === priorStateId || !ports.persistedMatches(stored.data, next)) throw new Error("Todo assignment append was not observed; no dispatch permitted");
      }); assertHost(host);
      return prepared.map((item,index) => {
        const token = Object.freeze({ ...item, todoIds: Object.freeze(item.todoIds), contracts: Object.freeze(item.contracts.map(c => Object.freeze({ ...c, declaredDependencies: Object.freeze(c.declaredDependencies.map(d => Object.freeze(d))) }))) });
        for (const ref of token.contracts) if (versions.contract(ref.taskId) !== ref.version) throw new Error("Prepared Task version changed during commit");
        const actualCores = new Map<string, OwnedExecutionContract>();
        for (const ref of token.contracts) { const core=ownedExecutionContract(next.get(ref.taskId)!,ref.version); if(core){if(core.tokenDigest!==ref.taskDigest)throw new Error("Owned Task execution contract changed during commit");actualCores.set(ref.taskId,core);} }
        ownedContracts.set(token.id,actualCores);
        tokens.set(token, { sourceContext,cancellation:cancellations?.[index], signals:new Set(signal?[signal]:[]), host, generation, anchor, intentId: persisted.id!, intentDigest: digest(payload) });
        for (const id of token.todoIds) reserved.set(id, token);
        return token;
      });
    }); return sourceContext && ports.source ? ports.source.run(sourceContext,enqueue) : enqueue(); },
    assertCurrent(token) { if (!runnable(token)) throw new Error("Task readiness blocked by unresolved dependency"); },
    inspect: itemStates,
    inspectRecoveryFacts:token=>itemStates(token,true),
    async waitReadiness(token, signal) {
      await waitReady(token, signal); await activate(token, signal);
    },
  };
  return { provider, assertActivation,
    markSubmission(ids:readonly string[]):void { for(const id of ids){const task=ports.state().get(id);if(task?.taskInstanceId)neverSubmitted.delete(task.taskInstanceId);} },
    noSubmissionWitness(task:TodoTask):{taskInstanceId:string;ownerInstanceId:string;generation:number}|undefined {
      return task.taskInstanceId && !task.dispatchSubmissionId && neverSubmitted.has(task.taskInstanceId)
        ? Object.freeze({taskInstanceId:task.taskInstanceId,ownerInstanceId:witnessOwner,generation}) : undefined;
    },
    readContract(bindingId:string,taskId:string):OwnedExecutionContract|undefined { const value=ownedContracts.get(bindingId)?.get(taskId);return value?Object.freeze({...value}):undefined; },
    validatePublication(before:Map<string,TodoTask>,after:Map<string,TodoTask>) {
      if(![...reserved.keys()].some(id=>digest(before.get(id))!==digest(after.get(id))))return;
      const m=manager();const stored=m&&latestState(m);
      if(!stored?.id||stored.id===ownerStateAnchor||!ports.persistedMatches(stored.data,after))throw new Error("Bound Task state append was not observable");
    },
    reset() { generation++; versions.reset(ports.state()); reserved.clear(); ownedContracts.clear(); neverSubmitted.clear(); captureState(); },
    committed(before: Map<string, TodoTask>, after: Map<string, TodoTask>, source?: TaskProgressCommit) {
      versions.committed(before, after, source);
      for(const task of after.values())if(task.taskInstanceId && !task.origin && before.get(task.id)?.taskInstanceId!==task.taskInstanceId && !task.dispatchSubmissionId)neverSubmitted.add(task.taskInstanceId);
      const remainingInstances=new Set([...after.values()].map(task=>task.taskInstanceId));
      for(const task of before.values())if(task.taskInstanceId && !remainingInstances.has(task.taskInstanceId))neverSubmitted.delete(task.taskInstanceId);
      captureState();
    },
  };
}
