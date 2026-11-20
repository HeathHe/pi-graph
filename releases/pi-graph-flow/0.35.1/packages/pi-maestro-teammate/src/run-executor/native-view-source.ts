import { createHash, randomUUID } from "node:crypto";
import { readNativeCurrent, readNativeCurrentLifetime, subscribeNativeCurrent, type NativeCurrentReadCapability, type NativeCurrentView } from "./native-current-view.ts";
import type { NativeExecutionSnapshot } from "./native-observation.ts";

export const NATIVE_VIEW_INVALIDATED = "pi-graph-next:native-view-invalidated/1";
export interface NativeViewDescriptor {
  readonly mode: "legacy" | "v2";
  readonly correlationId: string;
  readonly projectionKey: string;
  readonly entityKey?: string;
  readonly streamKey?: string;
  readonly cursor?: number;
}
export interface NativeViewRow {
  readonly ownerId: string;
  readonly correlationId: string;
  readonly agent: string;
  readonly view: NativeCurrentView;
}
export interface NativePendingView {
  /** Observer registration time, not CPU runtime or business start evidence. */
  readonly observedSince: number;
  readonly ownerId: string;
  readonly agent: string;
  readonly snapshot: NativeExecutionSnapshot;
  readonly detached: boolean;
  readonly retained: boolean;
}
export interface NativeSourceSnapshot {
  readonly revision: number;
  readonly pending: readonly NativePendingView[];
}
export interface NativeViewSource { readonly namespace: "pi-graph-next:native-source/1" }
interface Manager {
  getSessionId(): string;
  getLeafId(): string | null;
  getBranch(): readonly {id: string}[];
}
interface Scope { readonly manager: Manager; readonly sessionId: string; readonly cwd: string }
interface SourceReader {
  read(descriptor: NativeViewDescriptor): NativeViewRow | undefined;
  snapshot(): NativeSourceSnapshot;
  valid(scope: Scope): boolean;
}
const readers = new WeakMap<object, SourceReader>();
const registry = new WeakMap<object, NativeViewSource>();
const disposers = new WeakMap<object, () => void>();
function stable(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value).filter(([,v])=>v !== undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}
/** Query descriptor only: hashes confer no authority, and are computed at parse/publication boundaries. */
export function nativeViewDescriptorOfEntity(entity: {correlationId: string; projection?: unknown}, source: {streamId: string; generation: number}, cursor = 0): NativeViewDescriptor {
  return Object.freeze({mode:"v2",correlationId:entity.correlationId, projectionKey:stable(entity.projection),
    streamKey:stable([source.streamId,source.generation]), cursor, entityKey:createHash("sha256").update(stable(entity)).digest("hex")});
}
export function nativeLegacyViewDescriptor(correlationId: string, projection: unknown): NativeViewDescriptor {
  return Object.freeze({mode:"legacy",correlationId,projectionKey:stable(projection)});
}
export function lookupNativeViewSource(scope: Scope): NativeViewSource | undefined {
  const source = registry.get(scope.manager);
  return source && readers.get(source)?.valid(scope) ? source : undefined;
}
export function readNativeView(source: unknown, descriptor: NativeViewDescriptor): NativeViewRow | undefined {
  return typeof source === "object" && source !== null ? readers.get(source)?.read(descriptor) : undefined;
}
export function readNativeSource(source: unknown): NativeSourceSnapshot | undefined {
  return typeof source === "object" && source !== null ? readers.get(source)?.snapshot() : undefined;
}
interface Owner {
  readonly observedSince: number;
  readonly id: string;
  readonly object: object;
  readonly correlationId: string;
  readonly agent: string;
  readonly generation: number | null;
  readonly capability: NativeCurrentReadCapability;
  readonly anchor: string | null;
  readonly epoch: number;
  readonly current: () => boolean;
  readonly retained?: () => boolean;
  revoked: boolean;
  dispose(): void;
}
/** Root-only composition; not exported by the public facade. */
export function createNativeViewSource(scope: Scope, validHost: () => boolean, invalidate: () => void) {
  const source: NativeViewSource = Object.freeze({namespace:"pi-graph-next:native-source/1"});
  let alive = true;
  let revision = 0;
  let epoch = 0;
  let cachedLeaf: string | null | undefined;
  let cachedEpoch = -1;
  let ancestors = new Set<string>();
  const hostTickets = new WeakMap<object, number>();
  const owners = new Map<string, Owner>();
  const currentOwners = new WeakMap<object, Owner>();
  const ownerReceipts = new WeakSet<object>();
  const associations = new Map<string, {owner: Owner; descriptor: NativeViewDescriptor; ordinal: number}>();
  const valid = (other = scope): boolean => {
    try { return alive && registry.get(scope.manager) === source && validHost()
      && other.manager === scope.manager && other.cwd === scope.cwd && other.sessionId === scope.sessionId
      && scope.manager.getSessionId() === scope.sessionId; } catch { return false; }
  };
  const notify = () => { revision++; try { invalidate(); } catch { /* UI only */ } };
  const ancestry = (owner: Owner): boolean => {
    if (!valid() || owner.epoch !== epoch) return false;
    try {
      const leaf = scope.manager.getLeafId();
      if (cachedEpoch !== epoch || cachedLeaf !== leaf) {
        ancestors = new Set(scope.manager.getBranch().map(entry=>entry.id));
        cachedLeaf = leaf; cachedEpoch = epoch;
      }
      return owner.anchor === null ? ancestors.size === 0 : ancestors.has(owner.anchor);
    } catch { return false; }
  };
  const current = (owner: Owner) => {
    if (owner.revoked) return false;
    if (currentOwners.get(owner.object) !== owner || !ancestry(owner) || !owner.current()) { owner.revoked=true; return false; }
    return true;
  };
  const prune = (owner: Owner) => {
    const view = readNativeCurrent(owner.capability);
    const lifetime = readNativeCurrentLifetime(owner.capability);
    // Physical close ends one candidate, not necessarily its runtime. Keep the
    // current owner's single subscription for a later fallback/clear; detached
    // owners release it as soon as their last physical pending instance closes.
    const observationFinished=lifetime?.executionCallSettled===true && lifetime.openObservations===0 && !view?.pending.length;
    if(observationFinished) owner.dispose();
    if (!current(owner) && observationFinished) {
      owner.dispose(); owners.delete(owner.id);
      for (const [key, entry] of associations) if(entry.owner === owner) associations.delete(key);
    }
  };
  readers.set(source, {
    valid,
    read: descriptor => {
      if (!valid()) return undefined;
      const entry = associations.get(`${descriptor.mode}:${descriptor.correlationId}`);
      if (!entry || stable(entry.descriptor) !== stable(descriptor) || !current(entry.owner)) return undefined;
      const view = readNativeCurrent(entry.owner.capability);
      return view && Object.freeze({ownerId:entry.owner.id,correlationId:entry.owner.correlationId,agent:entry.owner.agent,view});
    },
    snapshot: () => {
      const pending: NativePendingView[] = [];
      if (valid()) for (const owner of owners.values()) {
        const view = readNativeCurrent(owner.capability);
        for (const snapshot of view?.pending ?? []) {
          const detached=!current(owner) || view?.current?.nativeInvocationId !== snapshot.nativeInvocationId;
          pending.push(Object.freeze({observedSince:owner.observedSince,ownerId:owner.id,agent:owner.agent,snapshot,detached,
            retained:!detached && (snapshot.currentTurn === undefined || snapshot.currentTurn.state === "settled")
              && (owner.retained?.() === true || snapshot.lastResult?.wakeable === true || snapshot.lastResult?.lifecyclePending === true)}));
        }
        prune(owner);
      }
      return Object.freeze({revision,pending:Object.freeze(pending)});
    },
  });
  const previousSource = registry.get(scope.manager);
  if (previousSource) disposers.get(previousSource)?.();
  registry.set(scope.manager,source);
  const dispose = () => { alive=false; for(const owner of owners.values()) owner.dispose(); owners.clear();associations.clear(); if(registry.get(scope.manager)===source) registry.delete(scope.manager); notify(); };
  disposers.set(source, dispose);
  return {
    source,
    captureHost(): object { const ticket=Object.freeze({}); hostTickets.set(ticket,epoch); return ticket; },
    register(input: {object: object; correlationId: string; agent: string; generation: number | null; capability: NativeCurrentReadCapability; current: () => boolean; retained?: () => boolean; anchor: string | null; hostTicket: object}): object | undefined {
      const capturedEpoch=hostTickets.get(input.hostTicket);
      if (!valid() || capturedEpoch === undefined || !input.anchor) return;
      const capabilityView=readNativeCurrent(input.capability);
      if(!capabilityView || capabilityView.correlationId!==input.correlationId || capabilityView.runtimeGeneration!==input.generation) return;
      const previous = currentOwners.get(input.object);
      if (previous?.capability === input.capability) return previous;
      const historical=capturedEpoch!==epoch;
      const owner: Owner = {...input,id:randomUUID(),observedSince:Date.now(),epoch:capturedEpoch,revoked:historical,dispose:()=>{}};
      owners.set(owner.id,owner); ownerReceipts.add(owner);
      if(!historical)currentOwners.set(input.object,owner);
      owner.dispose = subscribeNativeCurrent(input.capability,()=>{notify();prune(owner);});
      if(previous) prune(previous);
      notify();
      prune(owner);
      return owner;
    },
    capture(object: object): object | undefined { return currentOwners.get(object); },
    confirm(receipt: object | undefined, descriptor: NativeViewDescriptor, ordinal = 0): void {
      if (!receipt) return;
      if (!ownerReceipts.has(receipt)) return;
      const owner = receipt as Owner;
      if (owners.get(owner.id) !== owner || !current(owner) || owner.correlationId !== descriptor.correlationId) return;
      const key = `${descriptor.mode}:${descriptor.correlationId}`;
      const prior = associations.get(key);
      if(prior && (prior.ordinal > ordinal || (prior.descriptor.cursor ?? 0) > (descriptor.cursor ?? 0))) return;
      associations.set(key,{owner,descriptor,ordinal});
    },
    reusePublished(descriptor: NativeViewDescriptor): void {
      const key = `${descriptor.mode}:${descriptor.correlationId}`;
      const prior=associations.get(key);
      if (!prior || !current(prior.owner) || prior.descriptor.mode !== "v2"
        || prior.descriptor.entityKey !== descriptor.entityKey || prior.descriptor.streamKey !== descriptor.streamKey
        || prior.descriptor.projectionKey !== descriptor.projectionKey || (descriptor.cursor ?? -1) < (prior.descriptor.cursor ?? 0)) return;
      associations.set(key,{...prior,descriptor});
    },
    reconcile(): void {
      const before=owners.size;
      for(const owner of owners.values()) prune(owner);
      if(owners.size!==before) notify();
    },
    navigate(): void { epoch++; cachedEpoch = -1; associations.clear(); notify(); for(const owner of owners.values()) prune(owner); },
    dispose,
  };
}
