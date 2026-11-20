import { readLatestNativeObservation, nativeObservationIsOpen, type NativeExecutionIdentity, type NativeExecutionSnapshot } from "./native-observation.ts";

/** Opaque same-process read capability. Deserializing this shape grants nothing. */
export interface NativeCurrentReadCapability { readonly namespace: "pi-graph-next:native-current/1" }
export interface NativeCurrentView extends NativeExecutionIdentity {
  readonly revision: number;
  readonly candidateRevision: number;
  readonly current?: NativeExecutionSnapshot;
  /** Positive spawn without a corresponding close, including superseded candidates. */
  readonly pending: readonly NativeExecutionSnapshot[];
}
interface Reader {
  read(): NativeCurrentView;
  subscribe(listener: () => void): () => void;
}
const readers = new WeakMap<object, Reader>();
const lifetimes = new WeakMap<object, () => {readonly executionCallSettled:boolean;readonly openObservations:number}>();
/** Internal subscription lifetime only; neither physical closure nor business acceptance. */
export function readNativeCurrentLifetime(capability: object) { return lifetimes.get(capability)?.(); }

export function readNativeCurrent(capability: unknown): NativeCurrentView | undefined {
  return typeof capability === "object" && capability !== null ? readers.get(capability)?.read() : undefined;
}
export function subscribeNativeCurrent(capability: unknown, listener: () => void): () => void {
  return typeof capability === "object" && capability !== null
    ? readers.get(capability)?.subscribe(listener) ?? (() => {}) : () => {};
}

/** Internal execution owner, never exported from the public observation facade. */
export function createNativeCurrentView(identity: NativeExecutionIdentity) {
  const capability: NativeCurrentReadCapability = Object.freeze({ namespace: "pi-graph-next:native-current/1" });
  let revision = 0;
  let candidateRevision = 0;
  let current: NativeExecutionSnapshot | undefined;
  let executionCallSettled=false;
  const openObservations=new Set<string>();
  const pending = new Map<string, NativeExecutionSnapshot>();
  const listeners = new Set<() => void>();
  const notify = () => {
    revision++;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* A view cannot affect execution. */ }
    }
  };
  readers.set(capability, {
    read: () => Object.freeze({ correlationId:identity.correlationId,runtimeGeneration:identity.runtimeGeneration, revision, candidateRevision, ...(current ? { current } : {}), pending: Object.freeze([...pending.values()]) }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  lifetimes.set(capability,()=>Object.freeze({executionCallSettled,openObservations:openObservations.size}));
  return {
    capability,
    settleExecutionCall():void { if(!executionCallSettled){executionCallSettled=true;notify();} },
    beginCandidate(): number {
      candidateRevision++;
      current = undefined;
      notify();
      return candidateRevision;
    },
    observe(candidate: number, value: unknown): void {
      const snapshot = readLatestNativeObservation(value, identity);
      if (!snapshot) return;
      const previous = pending.get(snapshot.nativeInvocationId);
      const wasOpen=openObservations.has(snapshot.nativeInvocationId);
      if(nativeObservationIsOpen(value,identity))openObservations.add(snapshot.nativeInvocationId);
      else openObservations.delete(snapshot.nativeInvocationId);
      let changed = wasOpen!==openObservations.has(snapshot.nativeInvocationId);
      // Late physical facts remain visible under their ORIGINAL invocation.
      if (snapshot.process.startObserved && (!previous || snapshot.sequence > previous.sequence)) {
        if (snapshot.process.close) pending.delete(snapshot.nativeInvocationId);
        else pending.set(snapshot.nativeInvocationId, snapshot);
        changed ||= previous !== undefined || !snapshot.process.close;
      }
      if (candidate === candidateRevision && (!current || (
        current.nativeInvocationId === snapshot.nativeInvocationId && snapshot.sequence > current.sequence
      ))) {
        current = snapshot;
        changed = true;
      }
      if (changed) notify();
    },
  };
}
