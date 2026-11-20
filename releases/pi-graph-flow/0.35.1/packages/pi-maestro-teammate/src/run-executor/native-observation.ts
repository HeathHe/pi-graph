import { randomUUID } from "node:crypto";
import { ChildProcess } from "node:child_process";

export interface NativeResultObservation {
  readonly exitCode: number;
  readonly lifecyclePending: boolean;
  readonly wakeable: boolean;
  readonly terminalStatus?: string;
  /** Logical transport reference, NOT an HTTP request-attempt identity. */
  readonly turnReference?: Readonly<{ requestId: string; loopSeq: number }>;
}
export interface NativeCurrentTurnObservation {
  /** Invalidated by new input/loop activity, independently of published result history. */
  readonly epoch: number;
  readonly state: "unknown" | "queued" | "running" | "settled";
  /** Includes prepared inputs before the write has returned. */
  readonly queuedInputs: number;
  /** Host-local input generation, not a provider/model request-attempt identity. */
  readonly inputGeneration?: number;
  readonly requestId?: string;
  readonly loopSeq?: number;
  /** Matching real idle + non-pending result, not Task/Goal acceptance or success. */
  readonly settledEpoch?: number;
}
export interface NativeInputReference {
  readonly inputGeneration: number;
  readonly requestId: string;
  readonly loopSeq: number;
}
export interface NativeExecutionSnapshot {
  readonly namespace: "pi-graph-next:native-execution/1";
  readonly nativeInvocationId: string;
  readonly correlationId: string;
  readonly runtimeGeneration: number | null;
  readonly requestedTodoIds: readonly string[];
  readonly taskBinding: "unverified";
  readonly wholeAgentAttempt: "unknown";
  readonly actualModel: "unknown";
  readonly sequence: number;
  readonly process: Readonly<{
    processInstanceId?: string;
    pid?: number;
    startObserved: boolean;
    exit?: Readonly<{ code: number | null; signal: string | null }>;
    close?: Readonly<{ code: number | null; signal: string | null }>;
    errorObserved: boolean;
    reclamation: "unknown";
  }>;
  readonly currentTurn: NativeCurrentTurnObservation;
  readonly resultCount: number;
  /** Audit history; use currentTurn to determine whether this still describes current work. */
  readonly lastResult?: NativeResultObservation;
}
export interface NativeExecutionIdentity {
  readonly correlationId: string;
  readonly runtimeGeneration: number | null;
}
const issued = new WeakSet<object>();
const liveOwners = new WeakMap<object, () => NativeExecutionSnapshot>();
const observationOpen = new WeakMap<object, () => boolean>();
const results = new WeakMap<object, () => NativeExecutionSnapshot>();
const currentFences = new WeakMap<object, () => boolean>();
function frozen(value: NativeExecutionSnapshot): NativeExecutionSnapshot {
  Object.freeze(value.requestedTodoIds);
  if (value.process.exit) Object.freeze(value.process.exit);
  if (value.process.close) Object.freeze(value.process.close);
  Object.freeze(value.process);
  Object.freeze(value.currentTurn);
  if (value.lastResult?.turnReference) Object.freeze(value.lastResult.turnReference);
  if (value.lastResult) Object.freeze(value.lastResult);
  Object.freeze(value); issued.add(value); return value;
}
/** Same-process observation only. JSON copies are descriptive, never verified evidence.
 * A stale generation can still be read with its ORIGINAL identity for audit; it cannot
 * satisfy a newer view. This does not grant execution or business acceptance. */
export function readNativeExecutionSnapshot(value: unknown, expected: NativeExecutionIdentity): NativeExecutionSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const snapshot = results.get(value)?.() ?? (issued.has(value) ? value as NativeExecutionSnapshot : undefined);
  if (!snapshot || snapshot.correlationId !== expected.correlationId || snapshot.runtimeGeneration !== expected.runtimeGeneration) return undefined;
  return frozen(structuredClone(snapshot));
}
/** Internal current read: only the original issuer/result owner can follow live facts.
 * Audit snapshots and JSON copies intentionally have no current fence/owner. */
export function readCurrentNativeObservation(value: unknown, expected: NativeExecutionIdentity): NativeExecutionSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const owner = liveOwners.get(value) ?? results.get(value);
  const fence = currentFences.get(value);
  if (!owner || !fence) return undefined;
  try { if (!fence()) return undefined; } catch { return undefined; }
  const latest = owner();
  if (latest.correlationId !== expected.correlationId || latest.runtimeGeneration !== expected.runtimeGeneration) return undefined;
  return frozen(structuredClone(latest));
}
/** Internal freshness check for a live view; the public audit reader intentionally accepts history. */
export function readLatestNativeObservation(value: unknown, expected: NativeExecutionIdentity): NativeExecutionSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const owner = liveOwners.get(value);
  const observed = readNativeExecutionSnapshot(value, expected);
  if (!owner || !observed) return undefined;
  const latest = owner();
  return latest.nativeInvocationId === observed.nativeInvocationId && latest.sequence === observed.sequence ? observed : undefined;
}
/** Internal observer lifetime, not a claim that a process did or did not start. */
export function nativeObservationIsOpen(value: unknown, expected: NativeExecutionIdentity): boolean | undefined {
  if (!readLatestNativeObservation(value, expected)) return undefined;
  return observationOpen.get(value as object)?.();
}
/** Internal adapter for orchestration-created cancellation/terminal wrappers. */
export function bindNativeResult(result: {correlationId:string}, observed: NativeExecutionSnapshot, generation: number | null): void {
  const owner=liveOwners.get(observed);
  if (owner && observed.correlationId===result.correlationId && observed.runtimeGeneration===generation) {
    results.set(result,owner);
    const fence=currentFences.get(observed);if(fence)currentFences.set(result,fence);
  }
}
/** Internal producer: deliberately not exported by the public observation port. */
export function createNativeObservation(input: NativeExecutionIdentity & { requestedTodoIds?: readonly string[]; isCurrent?: () => boolean }, sink?: (snapshot: NativeExecutionSnapshot) => void) {
  const state: { sequence: number; process: {processInstanceId?: string; pid?: number; startObserved: boolean; exit?: {code:number|null;signal:string|null}; close?: {code:number|null;signal:string|null}; errorObserved:boolean; reclamation:"unknown"}; currentTurn:NativeCurrentTurnObservation; resultCount:number; lastResult?: NativeResultObservation } = {
    sequence: 0, process: {startObserved:false,errorObserved:false,reclamation:"unknown"}, currentTurn:{epoch:0,state:"unknown",queuedInputs:0}, resultCount:0,
  };
  const nativeInvocationId = randomUUID();
  let open = true;
  let inputGeneration = 0;
  let running = false;
  const queue = new Map<number, {requestId:string;committed:boolean}>();
  let active: {ref:NativeInputReference;epoch:number}|undefined;
  let idleProof: {ref:NativeInputReference;epoch:number}|undefined;
  const same = (a:NativeInputReference|undefined,b:NativeInputReference|undefined) => !!a && !!b
    && a.inputGeneration===b.inputGeneration && a.requestId===b.requestId && a.loopSeq===b.loopSeq;
  const transition = (kind:NativeCurrentTurnObservation["state"],ref?:NativeInputReference) => {
    state.currentTurn={epoch:state.currentTurn.epoch+1,state:kind,queuedInputs:queue.size,...ref};
    idleProof=undefined;
    return state.currentTurn.epoch;
  };
  const uncertain = () => { active=undefined;running=false;transition("unknown"); };
  const currentFence=()=>input.isCurrent?.()!==false;
  const requestedTodoIds = [...(input.requestedTodoIds ?? [])];
  const snapshot = (): NativeExecutionSnapshot => { const value = frozen({namespace:"pi-graph-next:native-execution/1", nativeInvocationId,
    correlationId:input.correlationId,runtimeGeneration:input.runtimeGeneration,requestedTodoIds:[...requestedTodoIds],
    taskBinding:"unverified",wholeAgentAttempt:"unknown",actualModel:"unknown",...structuredClone(state)}); liveOwners.set(value,snapshot); currentFences.set(value,currentFence); observationOpen.set(value,()=>open); return value; };
  const emit = () => {state.sequence++; try { sink?.(snapshot()); } catch { /* Observers cannot alter execution. */ }};
  emit();
  return {
    executionControl():void {if(state.currentTurn.state!=="running"&&state.currentTurn.state!=="queued"){uncertain();emit();}},
    enqueueInput(requestId:string,loopSeq:number):number {
      const generation=++inputGeneration;queue.set(generation,{requestId,committed:false});
      transition("queued",{inputGeneration:generation,requestId,loopSeq});emit();return generation;
    },
    commitInput(generation:number):void { const item=queue.get(generation);if(item)item.committed=true; },
    cancelInput(generation:number):void { if(queue.delete(generation)){uncertain();emit();} },
    acceptInput(ref:NativeInputReference):number|undefined {
      const queued=queue.get(ref.inputGeneration);
      if(!queued?.committed||queued.requestId!==ref.requestId)return undefined;
      queue.delete(ref.inputGeneration);
      const epoch=transition(running?"running":"queued",ref);active={ref:{...ref},epoch};emit();return epoch;
    },
    advanceLoop(ref?:NativeInputReference):number|undefined {
      const known=ref&&active?.ref.inputGeneration===ref.inputGeneration&&active.ref.requestId===ref.requestId?ref:undefined;
      const epoch=transition(running?"running":"queued",known);active=known?{ref:{...known},epoch}:undefined;emit();return known?epoch:undefined;
    },
    beginTurn(ref?:NativeInputReference):number|undefined {
      running=true;
      const known=ref&&active?.ref.inputGeneration===ref.inputGeneration&&active.ref.requestId===ref.requestId?ref:undefined;
      if(known&&same(active?.ref,known)&&active?.epoch===state.currentTurn.epoch&&state.currentTurn.state==="running")return active.epoch;
      const epoch=transition("running",known);active=known?{ref:{...known},epoch}:undefined;emit();return known?epoch:undefined;
    },
    agentSettled(ref:NativeInputReference|undefined,epoch:number|undefined):void {
      running=false;
      if(ref&&epoch!==undefined&&same(active?.ref,ref)&&active?.epoch===epoch&&state.currentTurn.epoch===epoch&&queue.size===0) {
        // Proof is published atomically with the matching non-pending result.
        idleProof={ref:{...ref},epoch};
      } else if(state.currentTurn.state!=="settled") { transition(queue.size?"queued":"unknown");emit(); }
    },
    observeChild(child: ChildProcess): void {
      if (!(child instanceof ChildProcess)) { open=false;emit();return; }
      // No PID inferred from stdin, shim, handle or merely returning from spawn().
      child.once("spawn", () => {
        if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) return;
        state.process.processInstanceId = randomUUID(); state.process.pid = child.pid;
        state.process.startObserved = true; emit();
      });
      child.once("exit", (code, signal) => {state.process.exit={code,signal};emit();});
      child.once("close", (code, signal) => {state.process.close={code,signal};open=false;if(state.currentTurn.state!=="settled")uncertain();emit();});
      child.once("error", () => {state.process.errorObserved=true;if(state.currentTurn.state!=="settled")uncertain();emit();});
    },
    spawnThrew(): void {state.process.errorObserved=true;open=false;uncertain();emit();},
    result(result: {exitCode:number;lifecyclePending?:boolean;wakeable?:boolean;terminalStatus?:string}, turnReference?: NativeInputReference, epoch?:number): void {
      state.resultCount++;state.lastResult={exitCode:result.exitCode,lifecyclePending:result.lifecyclePending===true,wakeable:result.wakeable===true,...(result.terminalStatus?{terminalStatus:result.terminalStatus}:{}),...(turnReference ? {turnReference:{requestId:turnReference.requestId,loopSeq:turnReference.loopSeq}} : {})};
      const matched=idleProof&&same(idleProof.ref,turnReference)&&idleProof.epoch===epoch&&active?.epoch===epoch
        &&state.currentTurn.epoch===epoch&&queue.size===0&&result.lifecyclePending!==true;
      if(matched)state.currentTurn={...state.currentTurn,state:"settled",settledEpoch:epoch};
      else if(state.currentTurn.state==="settled")uncertain();
      results.set(result,snapshot);currentFences.set(result,currentFence);emit();
    },
  };
}
