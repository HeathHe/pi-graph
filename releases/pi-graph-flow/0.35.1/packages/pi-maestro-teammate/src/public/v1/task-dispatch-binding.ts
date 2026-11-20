import { assertTodoSourceScope, readTodoSourceHost, subscribeTodoSourceInvalidation, type TodoSourceScope } from "../../runs/todo-source-context.ts";
import { readCurrentNativeObservation, readLatestNativeObservation } from "../../run-executor/native-observation.ts";
import { randomUUID } from "node:crypto";
import { readChildJournalFact, childReceiptDigests } from "../../run-executor/budget-journal.ts";
/** Process-local inversion port. A model supplies IDs, never a binding token. */
import { readNativeExecutionSnapshot, type NativeExecutionSnapshot } from "./observation.ts";
export const CHILD_MODEL_BUDGET_BROKER = "pi-graph:model-budget/1";
export const TASK_DISPATCH_ENTRY = "pi-graph-next:task-dispatch-prepared/1";
/** Pure projection only; it issues no budget authority or usage fact. */
export function childModelReceiptDigests(message: unknown): Readonly<{ messageDigest: string; usageDigest: string }> {
  return childReceiptDigests(message);
}
export interface TaskDispatchManager { getSessionId(): string; getBranch(): readonly {id?: string; type?: string; customType?: string; data?: unknown}[]; }
export interface TaskDispatchHost { readonly cwd: string; readonly sessionId: string; readonly manager: TaskDispatchManager; }
export interface TaskDispatchRequest { readonly correlationId: string; readonly runtimeGeneration: number | null; readonly agent: string; readonly name?: string; readonly cwd: string; readonly todoIds: readonly string[]; }
export interface TaskDispatchContractRef { readonly taskId:string; readonly version:number; readonly taskDigest:string; readonly declaredDependencies?:readonly {readonly taskId:string; readonly version:number}[]; readonly planHandoffKey?:string; readonly qualityGoalId?:string; }
export interface PreparedTaskDispatch { readonly contracts:readonly TaskDispatchContractRef[]; readonly sessionId:string; readonly branchAnchor:string; readonly id: string; readonly agent: string; readonly cwd: string; readonly correlationId: string; readonly runtimeGeneration: number | null; readonly todoIds: readonly string[]; }
export interface TaskDispatchItemState { readonly taskId:string; readonly state:"active"|"ready"|"blocked"|"completed"|"historical"|"invalid_dependency"; readonly stateRevision:number; readonly completionObserved?:boolean; }
export interface TaskDispatchProvider {
  nativeRecovery?: TaskNativeRecoveryProvider;
  prepare(host: TaskDispatchHost, requests: readonly TaskDispatchRequest[], signal?: AbortSignal, cancellations?: readonly TaskDispatchCancellationScope[]): Promise<readonly PreparedTaskDispatch[]>;
  assertCurrent(token: PreparedTaskDispatch): void;
  inspect(token: PreparedTaskDispatch): readonly TaskDispatchItemState[];
  /** Read-only physical fact retention after cancellation. Never runnable authority. */
  inspectRecoveryFacts?(token:PreparedTaskDispatch):readonly TaskDispatchItemState[];
  waitReadiness(token: PreparedTaskDispatch, signal?:AbortSignal): Promise<void>;
}
/** Host mechanism port. None of these opaque values are model/tool DTOs. */
export interface TaskNativeRecoveryInput {
  readonly command:string; readonly payloadDigest:string; readonly wireRequestId?:string;
  readonly turn?:NativeExecutionSnapshot["currentTurn"];
}
export interface NativeTaskBudgetRequest { readonly requestId: string; readonly reservedUnits: number; }
export interface BudgetAcquireControl {
  readonly signal?: AbortSignal;
  /** Tightens the original owner guard; cannot substitute for it. */
  readonly assertCurrent?: () => void;
}
/** Trusted host operations. Request/fact objects stay process-local and never enter model tools. */
export interface TaskNativeBudgetProvider {
  /** Same capture as prepare, without yielding or touching a budget database. */
  capture?(attempt: object): object | undefined;
  captureNone?(attempt: object): object;
  assertNone?(attempt: object, origin: object): void;
  prepare(attempt: object): Promise<object | undefined>;
  reserve(context: object, request: NativeTaskBudgetRequest): object;
  reserveRemaining?(context: object, requestId: string): object;
  acquireRemaining?(context: object, requestId: string, control: BudgetAcquireControl): Promise<object>;
  abandonBeforeMark?(request: object): void;
  markAttempted?(request: object): void;
  beginReceiptDrain?(request: object): object;
  endReceiptDrain?(producer: object): void;
  retireSender?(request: object): { recorded: boolean };
  markMayHaveSent(request: object): void;
  recordUnknown(request: object): void;
  settle(request: object, originalFact: object): void;
  release(request: object, notSentProof: object): void;
}
/** Original loaded owner projection; opaque values never become model DTOs. */
export interface ParentModelBudgetSourcePort {
  capture(host: TaskDispatchHost): object;
  assertNone(origin: object): void;
  fromDispatch?(origin: object): object;
  kind?(origin: object): "none" | "declared";
  prepare?(origin: object): Promise<object>;
  reserve?(context: object): object;
  acquire?(context: object, control: BudgetAcquireControl): Promise<object>;
  abandonBeforeMark?(request: object): void;
  markAttempted?(request: object): void;
  beginReceiptDrain?(request: object): object;
  endReceiptDrain?(producer: object): void;
  retireSender?(request: object): { recorded: boolean };
  mark?(request: object): void;
  unknown?(request: object): void;
  settleChild?(request: object, fact: object): void;
}
export interface TaskNativeRecoveryProvider {
  readonly backendBudgetSource?: { capture(host: TaskDispatchHost, todoIds: readonly string[]): object; assertNone(origin: object): void };
  readonly modelSource?: ParentModelBudgetSourcePort;
  preflightBudget?(todoIds: readonly string[]): void;
  readonly budget?: TaskNativeBudgetProvider;
  ready():Promise<void>;
  begin(token:PreparedTaskDispatch,candidateId:string,guard:()=>void,factGuard:()=>void):object;
  beforeWrite(attempt:object,input:TaskNativeRecoveryInput):object;
  consume(attempt:object,permit:object,payloadDigest:string):void;
  unknown(attempt:object):void;
  observe(attempt:object,snapshot:NativeExecutionSnapshot,cleanupRequested:boolean):void;
}
const KEY=Symbol.for("pi-graph-next.task-dispatch-provider/1");
const globals=globalThis as typeof globalThis & Record<symbol,unknown>;
/** Issued in this module; no token is captured by a registration/signal listener. */
export interface TaskDispatchCancellationScope {
  readonly cancelled: boolean;
  /** Active wait only. Its disposer removes every original-signal listener. */
  subscribe(onCancel: () => void): () => void;
}
interface TaskDispatchIssuance {
  readonly scopes: WeakSet<object>;
  readonly owners: WeakMap<object, TokenOwner>;
  readonly lifetimes: WeakMap<TaskDispatchProvider, AbortController>;
}
const issuanceKey = Symbol.for("pi-graph:task-dispatch-issuance:v1");
// Independent real extension graphs share issuance identity, never Task state.
const issuance = (globals[issuanceKey] ??= Object.freeze({
  scopes: new WeakSet<object>(), owners: new WeakMap<object, TokenOwner>(),
  lifetimes: new WeakMap<TaskDispatchProvider, AbortController>(),
})) as TaskDispatchIssuance;
const scopes = issuance.scopes;
export function isTaskDispatchCancellationScope(value: unknown): value is TaskDispatchCancellationScope {
  return typeof value === "object" && value !== null && scopes.has(value);
}
interface CancellationState {
  readonly scope: TaskDispatchCancellationScope;
  add(signal: AbortSignal | undefined): void;
}
interface TokenOwner {
  readonly provider: TaskDispatchProvider;
  readonly registration: AbortController;
  readonly cancellation: CancellationState;
}
const owners = issuance.owners;
const lifetimes = issuance.lifetimes;
function cancellationState(provider: TaskDispatchProvider, registration: AbortController): CancellationState {
  const signals = new Set<AbortSignal>([registration.signal]);
  // Contains only currently waiting subscriptions, not tokens or settled waits.
  const subscriptions = new Set<(signal: AbortSignal) => void>();
  const scope: TaskDispatchCancellationScope = Object.freeze({
    get cancelled() {
      return globals[KEY] !== provider || lifetimes.get(provider) !== registration
        || [...signals].some(signal => signal.aborted);
    },
    subscribe(onCancel: () => void) {
      const attached = new Set<AbortSignal>();
      let closed = false;
      const notify = () => { if (!closed) onCancel(); };
      const attach = (signal: AbortSignal) => {
        if (closed || attached.has(signal)) return;
        attached.add(signal);
        signal.addEventListener("abort", notify, { once: true });
        if (signal.aborted) notify();
      };
      subscriptions.add(attach);
      for (const signal of signals) attach(signal);
      if (scope.cancelled) notify();
      return () => {
        if (closed) return;
        closed = true;
        subscriptions.delete(attach);
        for (const signal of attached) signal.removeEventListener("abort", notify);
        attached.clear();
      };
    },
  });
  scopes.add(scope);
  return { scope, add(signal) {
    if (!signal || signals.has(signal)) return;
    signals.add(signal);
    for (const attach of [...subscriptions]) attach(signal);
  } };
}
export function watchTaskDispatchCancellation(token: PreparedTaskDispatch | undefined, signal: AbortSignal | undefined): void {
  if (token) owners.get(token)?.cancellation.add(signal);
}
export function registerTaskDispatchProvider(provider: TaskDispatchProvider):()=>void {
  const previous=globals[KEY] as TaskDispatchProvider|undefined;
  if(previous)lifetimes.get(previous)?.abort(new Error("Task dispatch provider replaced"));
  const lifetime=new AbortController();lifetimes.set(provider,lifetime);
  globals[KEY]=provider;return ()=>{lifetime.abort(new Error("Task dispatch provider disposed"));if(globals[KEY]===provider&&lifetimes.get(provider)===lifetime)delete globals[KEY];};
}
export async function prepareTaskDispatch(host:TaskDispatchHost|undefined,requests:readonly TaskDispatchRequest[],signal?:AbortSignal):Promise<readonly PreparedTaskDispatch[]> {
  const bound=requests.filter(r=>r.todoIds.length);
  if(!bound.length)return [];
  if(!host)throw new Error("Todo dispatch requires a captured canonical root host; nested/standalone caller has no Todo authority");
  const provider=globals[KEY] as TaskDispatchProvider|undefined;
  if(!provider)throw new Error("Todo dispatch provider unavailable");
  signal?.throwIfAborted();
  const registration=lifetimes.get(provider);
  if(!registration||registration.signal.aborted)throw new Error("Todo dispatch provider registration unavailable");
  const cancellations = bound.map(() => { const state=cancellationState(provider,registration);state.add(signal);return state; });
  const tokens=await provider.prepare(Object.freeze({cwd:host.cwd,sessionId:host.sessionId,manager:host.manager}),structuredClone(bound),signal,cancellations.map(state=>state.scope));
  if(globals[KEY]!==provider||lifetimes.get(provider)!==registration||registration.signal.aborted)throw new Error("Todo dispatch provider changed");
  if(tokens.length!==cancellations.length)throw new Error("Todo dispatch provider returned mismatched binding count");
  tokens.forEach((token,index)=>owners.set(token,{provider,registration,cancellation:cancellations[index]}));
  return tokens;
}
function bindingProvider(token:PreparedTaskDispatch|undefined,request:TaskDispatchRequest):TaskDispatchProvider|undefined {
  if(!request.todoIds.length)return undefined;
  const owner=token&&owners.get(token);
  const provider=owner?.provider;
  if(!token||!provider||owner?.cancellation.scope.cancelled||globals[KEY]!==provider||token.agent!==request.agent||token.cwd!==request.cwd||token.correlationId!==request.correlationId||token.runtimeGeneration!==request.runtimeGeneration||JSON.stringify(token.todoIds)!==JSON.stringify(request.todoIds))throw new Error("Untrusted or mismatched Todo dispatch binding");
  return provider;
}
const backendOrigins = new WeakMap<object, { provider: TaskDispatchProvider; registration: AbortController; sourceScope: TodoSourceScope; ids: readonly string[]; request: TaskDispatchRequest; origin: object }>();
const backendCaptureFailures = new WeakMap<object, Error>();
export function assertTaskDispatch(token: PreparedTaskDispatch | undefined, request: TaskDispatchRequest): void;
export function assertTaskDispatch(token: PreparedTaskDispatch | undefined, request: TaskDispatchRequest, budget: { readonly unmetered: "capture"; readonly sourceScope?: TodoSourceScope }): object | undefined;
export function assertTaskDispatch(token: PreparedTaskDispatch | undefined, request: TaskDispatchRequest, budget: { readonly unmetered: "assert"; readonly origin?: object }): void;
export function assertTaskDispatch(token:PreparedTaskDispatch|undefined,request:TaskDispatchRequest, budget?:
  { readonly unmetered: "capture"; readonly sourceScope?: TodoSourceScope } | { readonly unmetered: "assert"; readonly origin?: object }): object | undefined {
  if (budget?.unmetered === "capture") {
    try {
    const provider = globals[KEY] as TaskDispatchProvider | undefined;
    if (!budget.sourceScope) {
      if (provider?.nativeRecovery?.backendBudgetSource || provider?.nativeRecovery?.modelSource) throw new Error("Unmetered backend requires its original parent model source");
      return undefined; // Direct legacy host fixture with no budget-capable owner.
    }
    assertTodoSourceScope(budget.sourceScope);
    const host = readTodoSourceHost(budget.sourceScope), registration = provider && lifetimes.get(provider);
    const port = provider?.nativeRecovery?.backendBudgetSource;
    if (!provider || !registration || registration.signal.aborted || !port) throw new Error("Backend parent budget source capability unavailable");
    if (typeof Reflect.get(host.manager, "getSessionId") !== "function" || typeof Reflect.get(host.manager, "getBranch") !== "function") throw new Error("Backend original session journal capability unavailable");
    const origin = port.capture({ cwd: host.cwd, sessionId: host.sessionId, manager: host.manager as TaskDispatchManager }, request.todoIds), handle = Object.freeze({});
    assertTodoSourceScope(budget.sourceScope);
      backendOrigins.set(handle, { provider, registration, sourceScope: budget.sourceScope, ids: [...request.todoIds], request: structuredClone(request), origin }); return handle;
    } catch (error) {
      // Pi/native paths do not consume this additional backend capability.
      // A legacy host may keep those paths, while a later unmetered start fails
      // with the original capture diagnosis instead of silently recapturing.
      const handle = Object.freeze({}); backendCaptureFailures.set(handle, error instanceof Error ? error : new Error(String(error))); return handle;
    }
  }
  bindingProvider(token,request)?.assertCurrent(token!);
  if (budget?.unmetered === "assert") {
    const failed = budget.origin && backendCaptureFailures.get(budget.origin); if (failed) throw failed;
    const record = budget.origin && backendOrigins.get(budget.origin);
    if (!record) {
      const provider = globals[KEY] as TaskDispatchProvider | undefined;
      if (budget.origin || provider?.nativeRecovery?.backendBudgetSource || provider?.nativeRecovery?.modelSource) throw new Error("Unmetered backend origin is unissued or unavailable");
      return undefined;
    }
    if (globals[KEY] !== record.provider || lifetimes.get(record.provider) !== record.registration || record.registration.signal.aborted
      || JSON.stringify(record.ids) !== JSON.stringify(request.todoIds) || (token && owners.get(token)?.provider !== record.provider)) throw new Error("Backend budget provider, Task parent or lifetime changed");
    assertTodoSourceScope(record.sourceScope); record.provider.nativeRecovery!.backendBudgetSource!.assertNone(record.origin);
    assertTodoSourceScope(record.sourceScope);
  }
  return undefined;
}
export async function waitTaskDispatchReadiness(token:PreparedTaskDispatch|undefined,signal?:AbortSignal,request?:TaskDispatchRequest):Promise<void> {
  if(request)bindingProvider(token,request);
  if(!token)return;
  const owner = owners.get(token);
  if (!owner || owner.cancellation.scope.cancelled) throw new Error("Untrusted or cancelled Todo dispatch binding");
  owner.cancellation.add(signal);
  await owner.provider.waitReadiness(token);
  if (owner.cancellation.scope.cancelled) throw new Error("Todo dispatch cancelled or provider changed");
}
export interface TaskDispatchObservation { readonly bindingId:string; readonly contracts:readonly TaskDispatchContractRef[]; readonly sessionId:string; readonly branchAnchor:string; readonly todoIds:readonly string[]; readonly bindingState:"current"|"historical"; readonly items:readonly TaskDispatchItemState[]; readonly native:NativeExecutionSnapshot; }
type RereadTaskDispatchObservation = () => TaskDispatchObservation | undefined;
const observationIssuanceKey = Symbol.for("pi-graph:task-dispatch-observation-issuance:v1");
// Rereads must use the original module's native issuer and freshness maps.
const observationIssuance = globals[observationIssuanceKey] ??= new WeakMap<object, RereadTaskDispatchObservation>();
if (!(observationIssuance instanceof WeakMap)) throw new Error("Incompatible Task dispatch observation issuance");
const joined: WeakMap<object, RereadTaskDispatchObservation> = observationIssuance;
export function joinTaskDispatchObservation(token:PreparedTaskDispatch,observed:NativeExecutionSnapshot):TaskDispatchObservation|undefined {
  const owner=owners.get(token);if(!owner)return undefined;const provider=owner.provider;
  const identity={correlationId:token.correlationId,runtimeGeneration:token.runtimeGeneration};
  const current=readCurrentNativeObservation(observed,identity);
  const native=current??readNativeExecutionSnapshot(observed,identity);
  if(!native||JSON.stringify(native.requestedTodoIds)!==JSON.stringify(token.todoIds))return undefined;
  let bindingState:"current"|"historical"=current?"current":"historical";
  let items:readonly TaskDispatchItemState[]=[];
  try{if(owner.cancellation.scope.cancelled||globals[KEY]!==provider)throw new Error("cancelled/replaced");items=provider.inspect(token);if(!items.length||items.some(item=>item.state==="historical"||item.state==="invalid_dependency"))bindingState="historical";}catch{bindingState="historical";}
  const result=Object.freeze({bindingId:token.id,contracts:token.contracts,sessionId:token.sessionId,branchAnchor:token.branchAnchor,todoIds:Object.freeze([...token.todoIds]),bindingState,items:Object.freeze(items.map(item=>Object.freeze({...item}))),native});joined.set(result, () => joinTaskDispatchObservation(token, observed));return result;
}
export function readTaskDispatchObservation(value:unknown):TaskDispatchObservation|undefined {
  if(typeof value!=="object"||value===null)return undefined;
  return joined.get(value)?.();
}
interface NativeGate {token:PreparedTaskDispatch;request:TaskDispatchRequest;provider:TaskNativeRecoveryProvider;attempt:object;cleanupRequested:boolean;turn?:NativeExecutionSnapshot["currentTurn"];settled?:{invocationId:string;epoch:number;requestId:string|undefined;loopSeq:number|undefined};}
const nativeGates=new WeakMap<object,NativeGate>();
export function beginNativeTaskRecovery(token:PreparedTaskDispatch|undefined,request:TaskDispatchRequest):object|undefined {
  if(!request.todoIds.length)return undefined; // Explicit legacy/unbound live-only: never restorable as a Task.
  const provider=bindingProvider(token,request);provider!.assertCurrent(token!);
  const recovery=provider?.nativeRecovery;if(!recovery)throw new Error("Native recovery unavailable: Task-bound execution requires a durable host gate");
  const guard=()=>{const current=bindingProvider(token,request);if(current!==provider)throw new Error("Native recovery provider replaced");
    const items=current.inspect(token!);if(items.some(item=>item.state==="historical"||item.state==="invalid_dependency"))throw new Error("Native recovery Task binding changed");};
  const original=owners.get(token!)!;
  const factGuard=()=>{if(owners.get(token!)!==original||globals[KEY]!==provider||lifetimes.get(provider!)!==original.registration||original.registration.signal.aborted)throw new Error("Native recovery fact provider changed");
    const items=(provider!.inspectRecoveryFacts??provider!.inspect).call(provider,token!);if(items.some(item=>item.state==="historical"||item.state==="invalid_dependency"))throw new Error("Native recovery historical fact binding");};
  const attempt=recovery.begin(token!,randomUUID(),guard,factGuard);guard();
  const handle=Object.freeze({});nativeGates.set(handle,{token:token!,request:structuredClone(request),provider:recovery,attempt,cleanupRequested:false});return handle;
}
export function beforeNativeTaskWrite(handle:object|undefined,input:Omit<TaskNativeRecoveryInput,"turn">):object|undefined {
  if(!handle)return undefined;const gate=nativeGates.get(handle);if(!gate)throw new Error("Unissued native recovery gate");
  const provider=bindingProvider(gate.token,gate.request);provider!.assertCurrent(gate.token);
  gate.cleanupRequested=false;gate.settled=undefined;
  return gate.provider.beforeWrite(gate.attempt,structuredClone({...input,...(gate.turn?{turn:gate.turn}:{})}));
}
export function consumeNativeTaskWrite(handle:object|undefined,permit:object|undefined,payloadDigest:string):void {
  if(!handle)return;const gate=nativeGates.get(handle);if(!gate||!permit)throw new Error("Native recovery permit missing");
  bindingProvider(gate.token,gate.request)!.assertCurrent(gate.token);gate.provider.consume(gate.attempt,permit,payloadDigest);
}
export function markNativeTaskWriteUnknown(handle:object|undefined):void {const gate=handle&&nativeGates.get(handle);if(gate)gate.provider.unknown(gate.attempt);}
export function markNativeTaskCleanup(handle:object|undefined):void {const gate=handle&&nativeGates.get(handle);if(gate)gate.cleanupRequested=true;}
export function observeNativeTaskRecovery(handle:object|undefined,value:unknown):void {
  const gate=handle&&nativeGates.get(handle);if(!gate)return;
  const identity={correlationId:gate.request.correlationId,runtimeGeneration:gate.request.runtimeGeneration};
  const current=readCurrentNativeObservation(value,identity);
  // A real cleanup can retire the runtime registry before physical close. Retain only
  // this original producer's close matching an already recorded settled boundary;
  // this never makes its M04 binding current or permits another input.
  const late=!current&&gate.cleanupRequested&&gate.settled?readLatestNativeObservation(value,identity):undefined;
  const snapshot=current??(late?.process.close&&late.nativeInvocationId===gate.settled?.invocationId&&late.currentTurn.epoch===gate.settled.epoch
    &&late.currentTurn.requestId===gate.settled.requestId&&late.currentTurn.loopSeq===gate.settled.loopSeq?late:undefined);
  if(!snapshot)return;if(current)gate.turn=structuredClone(current.currentTurn);gate.provider.observe(gate.attempt,snapshot,gate.cleanupRequested);
  if(current){const turn=current.currentTurn;gate.settled=turn.state==="settled"?{invocationId:current.nativeInvocationId,epoch:turn.epoch,requestId:turn.requestId,loopSeq:turn.loopSeq}:undefined;}
}

interface NativeBudgetContext { readonly gate: NativeGate; readonly value: object; }
const budgetContexts = new WeakMap<object, NativeBudgetContext>();
interface GoalBudgetContext { readonly kind: "goal"; readonly source: GoalChildIssuer; readonly value: object; }
const budgetRequests = new WeakMap<object, NativeBudgetContext | GoalBudgetContext>();
interface ChildUsageFact { request: object; units: number; entryId: string; digest: string; }
const childFactsKey = Symbol.for("pi-graph:child-budget-usage-facts:v1");
const childFactsRegistry = globalThis as typeof globalThis & { [childFactsKey]?: WeakMap<object, ChildUsageFact> };
// Only exact issued objects cross independent plugin graphs; never a balance.
const childUsageFacts = childFactsRegistry[childFactsKey] ??= new WeakMap<object, ChildUsageFact>();
export function readChildModelUsageFact(fact: object, request: object): Readonly<{ units: number; entryId: string; digest: string }> {
  const value = childUsageFacts.get(fact);
  if (!value || value.request !== request) throw new Error("Unissued child usage fact or foreign Task request");
  return value;
}
function currentBudgetGate(gate: NativeGate): void {
  bindingProvider(gate.token, gate.request)!.assertCurrent(gate.token);
}
function budgetProvider(gate: NativeGate): TaskNativeBudgetProvider {
  const budget = gate.provider.budget;
  if (!budget) throw new Error("Declared Task budget host capability unavailable");
  return budget;
}
export async function prepareNativeTaskBudget(handle: object | undefined): Promise<object | undefined> {
  if (!handle) return undefined;
  const gate = nativeGates.get(handle);
  if (!gate) throw new Error("Unissued native recovery gate");
  currentBudgetGate(gate);
  const value = await budgetProvider(gate).prepare(gate.attempt);
  currentBudgetGate(gate);
  if (!value) return undefined;
  const context = Object.freeze({});
  budgetContexts.set(context, { gate, value });
  return context;
}
export function reserveNativeTaskBudgetRequest(context: object | undefined, request: NativeTaskBudgetRequest): object | undefined {
  if (!context) return undefined;
  const issued = budgetContexts.get(context);
  if (!issued) throw new Error("Unissued Task budget context");
  currentBudgetGate(issued.gate);
  const value = budgetProvider(issued.gate).reserve(issued.value, structuredClone(request));
  currentBudgetGate(issued.gate);
  const handle = Object.freeze({});
  budgetRequests.set(handle, { gate: issued.gate, value });
  return handle;
}
export function reserveNativeTaskBudgetRemaining(context: object, requestId: string): object {
  const issued = budgetContexts.get(context);
  if (!issued) throw new Error("Unissued Task budget context");
  currentBudgetGate(issued.gate);
  const budget = budgetProvider(issued.gate);
  if (!budget.reserveRemaining) throw new Error("Parent-decided Task reservation capability unavailable");
  const value = budget.reserveRemaining(issued.value, requestId);
  currentBudgetGate(issued.gate);
  const handle = Object.freeze({}); budgetRequests.set(handle, { gate: issued.gate, value }); return handle;
}
export function markNativeTaskBudgetMayHaveSent(request: object | undefined): void {
  if (!request) return;
  markNativeTaskBudgetAttempted(request);
  const issued = budgetRequests.get(request);
  if (!issued) throw new Error("Unissued Task budget request");
  if ("kind" in issued) {
    issued.source.current(); issued.source.port.mark!(issued.value); issued.source.current(); return;
  }
  currentBudgetGate(issued.gate);
  budgetProvider(issued.gate).markMayHaveSent(issued.value);
  currentBudgetGate(issued.gate);
}
export function recordNativeTaskBudgetUnknown(request: object): void {
  const issued = budgetRequests.get(request);
  if (!issued) throw new Error("Unissued Task budget request");
  if ("kind" in issued) { issued.source.port.unknown!(issued.value); return; }
  budgetProvider(issued.gate).recordUnknown(issued.value);
}
export function settleNativeTaskBudgetRequest(request: object, originalFact: object): void {
  const issued = budgetRequests.get(request);
  if (!issued) throw new Error("Unissued Task budget request");
  const evidence = readChildJournalFact(originalFact, request), fact = Object.freeze({});
  childUsageFacts.set(fact, Object.freeze({ ...evidence, request: issued.value }));
  if ("kind" in issued) { issued.source.port.settleChild!(issued.value, fact); return; }
  budgetProvider(issued.gate).settle(issued.value, fact);
}
export function releaseNativeTaskBudgetRequest(request: object, notSentProof: object): void {
  const issued = budgetRequests.get(request);
  if (!issued) throw new Error("Unissued Task budget request");
  if ("kind" in issued) throw new Error("Trusted bare Goal not-sent proof capability unavailable; budget remains held");
  budgetProvider(issued.gate).release(issued.value, notSentProof);
}


/** Parent-local source minted before child startup. Never serialized into IPC. */
declare const childModelOrigin: unique symbol;
export interface ChildModelBudgetOrigin { readonly [childModelOrigin]: true; }
interface GoalChildIssuer { readonly port: ParentModelBudgetSourcePort; readonly origin: object; current(): void; }
interface ChildModelOriginRecord { current(): void; assertNone(): void; subscribe(changed: () => void): () => void; context?: object; goal?: GoalChildIssuer; }
const childModelOrigins = new WeakMap<object, ChildModelOriginRecord>();
const childPreparedContexts = new WeakMap<object, { readonly source: ChildModelOriginRecord; readonly goal?: GoalBudgetContext; used: boolean }>();
export function captureChildModelBudgetOrigin(sourceScope: TodoSourceScope | undefined, nativeGate?: object): ChildModelBudgetOrigin {
  return captureChildOrigin(sourceScope, nativeGate, false);
}
/** Trusted actual-attempt capability; the negative-only API retains its contract. */
export function captureChildModelBudgetRequestOrigin(sourceScope: TodoSourceScope | undefined, nativeGate?: object,
  dispatch?: { readonly origin: object | undefined; readonly request: TaskDispatchRequest }): ChildModelBudgetOrigin {
  return captureChildOrigin(sourceScope, nativeGate, true, dispatch);
}
function captureChildOrigin(sourceScope: TodoSourceScope | undefined, nativeGate: object | undefined, allowDeclared: boolean,
  dispatch?: { readonly origin: object | undefined; readonly request: TaskDispatchRequest }): ChildModelBudgetOrigin {
  assertTodoSourceScope(sourceScope);
  const host = readTodoSourceHost(sourceScope);
  const provider = globals[KEY] as TaskDispatchProvider | undefined;
  const gate = nativeGate ? nativeGates.get(nativeGate) : undefined;
  if (nativeGate && !gate) throw new Error("Child budget origin has an unissued native gate");
  if (!provider?.nativeRecovery || (gate && gate.provider !== provider.nativeRecovery)) throw new Error("Child parent model source capability unavailable");
  if (gate) currentBudgetGate(gate);
  const recovery = provider.nativeRecovery;
  let assertOriginal: () => void;
  let context: object | undefined, goal: GoalChildIssuer | undefined;
  let originalRegistration: AbortController | undefined;
  if (gate) {
    const budget = budgetProvider(gate);
    const value = budget.capture?.(gate.attempt);
    if (value) {
      if (!allowDeclared) throw new Error("Declared Task parent requires positive child budget capability");
      context = Object.freeze({}); budgetContexts.set(context, { gate, value });
      assertOriginal = () => { throw new Error("Child Task parent has a declared budget"); };
    } else {
      if (!budget.captureNone || !budget.assertNone) throw new Error("Task parent negative source capability unavailable");
      const origin = budget.captureNone(gate.attempt);
      assertOriginal = () => budget.assertNone!(gate.attempt, origin);
    }
  } else {
    const source = recovery.modelSource;
    if (!source) throw new Error("Parent Goal negative source capability unavailable");
    let origin: object;
    if (dispatch) {
      if (dispatch.request.todoIds.length) throw new Error("Task-bound child cannot fall back to a bare Goal without its native gate");
      const failed = dispatch.origin && backendCaptureFailures.get(dispatch.origin); if (failed) throw failed;
      const original = dispatch.origin && backendOrigins.get(dispatch.origin);
      if (!original || original.provider !== provider || original.registration !== lifetimes.get(provider)
        || original.registration.signal.aborted || original.sourceScope !== sourceScope || original.ids.length
        || original.request.correlationId !== dispatch.request.correlationId
        || original.request.runtimeGeneration !== dispatch.request.runtimeGeneration
        || original.request.agent !== dispatch.request.agent || original.request.cwd !== dispatch.request.cwd
        || JSON.stringify(original.request.todoIds) !== JSON.stringify(dispatch.request.todoIds)) {
        throw new Error("Bare Goal child has no matching original dispatch source");
      }
      if (!source.fromDispatch || !source.kind || !source.prepare || !source.reserve || !source.mark || !source.unknown || !source.settleChild)
        throw new Error("Bare Goal child budget issuer capability unavailable");
      originalRegistration = original.registration;
      origin = source.fromDispatch(original.origin);
      if (source.kind(origin) === "declared") {
        if (!allowDeclared) throw new Error("Declared Goal requires positive child budget capability");
        goal = { port: source, origin, current: () => {
          current();
          if (recovery.modelSource !== source || source.kind!(origin) !== "declared") throw new Error("Original bare Goal budget source changed");
        } };
      }
    } else {
      // The old negative-only direct API retains its contract. It never mints
      // positive authority by selecting a Goal after an original dispatch yielded.
      origin = source.capture({ cwd: host.cwd, sessionId: host.sessionId, manager: host.manager as TaskDispatchManager });
    }
    assertOriginal = () => source.assertNone(origin);
  }
  const current = () => {
    assertTodoSourceScope(sourceScope);
    if (globals[KEY] !== provider || provider.nativeRecovery !== recovery) throw new Error("Child model source registration changed");
    if (originalRegistration && (lifetimes.get(provider) !== originalRegistration || originalRegistration.signal.aborted)) throw new Error("Child model source registration was replaced");
    if (gate) currentBudgetGate(gate);
  };
  const handle = Object.freeze({}) as ChildModelBudgetOrigin;
  const registration = originalRegistration ?? lifetimes.get(provider);
  const subscribe = (changed: () => void) => {
    const disposeSource = subscribeTodoSourceInvalidation(sourceScope, changed);
    const disposeCancellation = gate ? owners.get(gate.token)?.cancellation.scope.subscribe(changed) : undefined;
    registration?.signal.addEventListener("abort", changed, { once: true });
    return () => { disposeSource(); disposeCancellation?.(); registration?.signal.removeEventListener("abort", changed); };
  };
  childModelOrigins.set(handle, { current, subscribe, assertNone: () => { current(); assertOriginal(); }, context, goal });
  return handle;
}
export async function assertChildModelBudgetNone(origin: ChildModelBudgetOrigin): Promise<void> {
  const source = childModelOrigins.get(origin);
  if (!source) throw new Error("Unissued child model budget origin");
  source.assertNone();
}
export function readChildModelBudgetKind(origin: ChildModelBudgetOrigin): "none" | "declared" {
  const source = childModelOrigins.get(origin);
  if (!source) throw new Error("Unissued child model budget origin");
  source.current();
  if (source.goal) { source.goal.current(); return "declared"; }
  if (!source.context) source.assertNone();
  return source.context ? "declared" : "none";
}
export function reserveChildModelBudgetRequest(origin: ChildModelBudgetOrigin, requestId: string): object {
  const source = childModelOrigins.get(origin);
  if (!source?.context) throw new Error("Child has no declared Task budget context");
  source.current(); return reserveNativeTaskBudgetRemaining(source.context, requestId);
}

/** Prepare only: readiness may yield here, but no request or reservation exists. */
export async function prepareChildModelBudgetContext(origin: ChildModelBudgetOrigin): Promise<object> {
  const source = childModelOrigins.get(origin);
  if (!source || (!source.context && !source.goal)) throw new Error("Child has no declared parent budget context");
  source.current();
  let goal: GoalBudgetContext | undefined;
  if (source.goal) {
    source.goal.current(); const value = await source.goal.port.prepare!(source.goal.origin); source.goal.current();
    goal = { kind: "goal", source: source.goal, value };
  }
  source.current();
  const prepared = Object.freeze({}); childPreparedContexts.set(prepared, { source, goal, used: false }); return prepared;
}
/** Synchronous reservation after the actual IPC owner rechecks its session. */
export function reservePreparedChildModelBudgetRequest(prepared: object, parentRequestId: string): object {
  const issued = childPreparedContexts.get(prepared);
  if (!issued || issued.used) throw new Error("Unissued or consumed child preparation");
  issued.source.current(); issued.used = true;
  if (!issued.goal) return reserveNativeTaskBudgetRemaining(issued.source.context!, parentRequestId);
  issued.goal.source.current();
  const value = issued.goal.source.port.reserve!(issued.goal.value), request = Object.freeze({});
  budgetRequests.set(request, { ...issued.goal, value }); return request;
}


const acquisitionSubscriptions = new WeakMap<object, () => void>();
/** Internal async acquisition; the returned handle already owns its CAS reservation. */
export async function acquirePreparedChildModelBudgetRequest(prepared: object, parentRequestId: string, control: BudgetAcquireControl): Promise<object> {
  const issued = childPreparedContexts.get(prepared);
  if (!issued || issued.used) throw new Error("Unissued or consumed child preparation");
  issued.source.current(); issued.used = true;
  const invalidated = new AbortController();
  const signal = control.signal ? AbortSignal.any([control.signal, invalidated.signal]) : invalidated.signal;
  const current = () => { signal.throwIfAborted(); issued.source.current(); issued.goal?.source.current(); control.assertCurrent?.(); };
  const dispose = issued.source.subscribe(() => { try { current(); } catch (error) { invalidated.abort(error); } });
  let request: object | undefined;
  const native = issued.goal ? undefined : budgetContexts.get(issued.source.context!);
  const provider = native ? budgetProvider(native.gate) : undefined;
  const port = issued.goal?.source.port;
  try {
    current();
    const value = issued.goal
      ? await (port?.acquire ? port.acquire(issued.goal.value, { signal, assertCurrent: current }) : Promise.reject(Error("Parent asynchronous Goal admission unavailable")))
      : await (provider?.acquireRemaining && native ? provider.acquireRemaining(native.value, parentRequestId, { signal, assertCurrent: current }) : Promise.reject(Error("Parent asynchronous Task admission unavailable")));
    request = Object.freeze({});
    if (issued.goal) budgetRequests.set(request, { ...issued.goal, value });
    else budgetRequests.set(request, { gate: native!.gate, value });
    acquisitionSubscriptions.set(request, dispose); current(); return request;
  } catch (error) {
    dispose();
    if (request) { try { abandonNativeTaskBudgetBeforeMark(request); } catch { /* Original admission error wins; no unproved refund. */ } }
    throw error;
  }
}
export function abandonNativeTaskBudgetBeforeMark(request: object): void {
  acquisitionSubscriptions.get(request)?.(); acquisitionSubscriptions.delete(request);
  const issued = budgetRequests.get(request); if (!issued) throw Error("Unissued budget acquisition");
  if ("kind" in issued) {
    if (!issued.source.port.abandonBeforeMark) throw Error("Goal unmarked acquisition revocation unavailable");
    issued.source.port.abandonBeforeMark(issued.value);
  } else {
    const provider = budgetProvider(issued.gate); if (!provider.abandonBeforeMark) throw Error("Task unmarked acquisition revocation unavailable");
    provider.abandonBeforeMark(issued.value);
  }
}
export function markNativeTaskBudgetAttempted(request: object): void {
  acquisitionSubscriptions.get(request)?.(); acquisitionSubscriptions.delete(request);
  const issued = budgetRequests.get(request); if (!issued) throw Error("Unissued budget acquisition");
  if ("kind" in issued) issued.source.port.markAttempted?.(issued.value);
  else budgetProvider(issued.gate).markAttempted?.(issued.value);
}
const receiptDrains = new WeakMap<object, { finish(): void }>();
export function beginNativeTaskBudgetReceiptDrain(request: object): object {
  const issued = budgetRequests.get(request); if (!issued) throw Error("Unissued budget receipt producer");
  const provider = "kind" in issued ? issued.source.port : budgetProvider(issued.gate);
  if (!provider.beginReceiptDrain || !provider.endReceiptDrain) throw Error("Original receipt producer lifecycle unavailable");
  const producer = provider.beginReceiptDrain(issued.value), handle = Object.freeze({});
  receiptDrains.set(handle, { finish: () => provider.endReceiptDrain!(producer) }); return handle;
}
export function endNativeTaskBudgetReceiptDrain(producer: object): void {
  const value = receiptDrains.get(producer); if (!value) throw Error("Unissued receipt producer"); value.finish();
}

/** Deny-only lifecycle metadata, never proof that a physical call finished or was not sent. */
export function retireNativeTaskBudgetSender(request: object): { recorded: boolean } {
  const issued = budgetRequests.get(request); if (!issued) throw Error("Unissued original budget sender");
  const provider = "kind" in issued ? issued.source.port : budgetProvider(issued.gate);
  if (!provider.retireSender) throw Error("Original budget sender retirement unavailable");
  return provider.retireSender(issued.value);
}
