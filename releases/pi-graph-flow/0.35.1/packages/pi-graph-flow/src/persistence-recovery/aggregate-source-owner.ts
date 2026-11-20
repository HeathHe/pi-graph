import { createHash } from "node:crypto";
/** Structural host/lease port only. Business owners keep their own registries and authority composition. */
export interface AggregateSourceHost { readonly manager: object; readonly cwd: string; readonly sessionId: string; }
export interface AggregateSourceProvider {
  capture(host: AggregateSourceHost): object;
  assert(lease: object): void;
  host(lease: object): AggregateSourceHost;
  subscribe(lease: object, onInvalidated: () => void): () => void;
}

interface Entry { id?: string; parentId?: string | null; type?: string; customType?: string; data?: unknown; }
interface Manager { getSessionId?(): string; getBranch?(): Entry[]; getLeafId?(): string | null; }
interface Lease { epoch: number; host: AggregateSourceHost; anchor: string | null; }
export class AggregatePublicationUnconfirmedError extends Error {
  readonly code: string;
  constructor(cause:unknown,label="Todo"){super(`${label} write outcome requires reconciliation; do not retry automatically. ${cause instanceof Error?cause.message:String(cause)}`);this.name=`${label}PublicationUnconfirmedError`;this.code=`${label.toUpperCase()}_WRITE_RECONCILE_REQUIRED`;}
}
/** A failed host read carries no untrusted diagnostic or cause across public boundaries. */
export class AggregateSourceReadUnavailableError extends Error {
  readonly code = "AGGREGATE_SOURCE_READ_UNAVAILABLE";
  constructor() { super("Session source is temporarily unavailable; the operation remains unverified."); this.name = "AggregateSourceReadUnavailableError"; }
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
/** One source observer, not another aggregate store. Loaded pins advance only after observed writes. */
export function createAggregateSourceOwner(stateEntryType: string, label = "Aggregate") {
  let epoch = 0;
  let host: AggregateSourceHost | undefined;
  let pin: string | undefined;
  let currentHost: (() => boolean) | undefined;
  let loadedAnchor:string|null=null;
  const issued = new WeakMap<object, Lease>();
  const listeners=new Set<()=>void>();
  const changed=()=>{for(const listener of [...listeners]){try{listener();}catch{/* observers cannot alter source ownership */}}};
  function entries(): Entry[] {
    const manager = host?.manager as Manager | undefined;
    if (typeof manager?.getBranch!=="function") throw new Error(`${label} source branch cannot be observed.`);
    let branch: Entry[];
    try { branch = manager.getBranch(); } catch { throw new AggregateSourceReadUnavailableError(); }
    if(!Array.isArray(branch))throw new Error(`${label} source branch is unavailable.`);
    return branch;
  }
  function statePin(branch: Entry[]): string {
    const entry = branch.filter(e => e.type === "custom" && e.customType === stateEntryType).at(-1);
    return digest(entry === undefined ? null : { id: entry.id, data: entry.data });
  }
  function base(value: object): Lease {
    const lease = issued.get(value);
    if (!lease || !host || !currentHost?.() || lease.epoch !== epoch || lease.host.manager !== host.manager
      || lease.host.sessionId !== host.sessionId || lease.host.cwd !== host.cwd
      || (host.manager as Manager).getSessionId?.() !== host.sessionId) {
      throw new Error(`${label} source changed or is no longer loaded.`);
    }
    if (lease.anchor !== null && !entries().some(e => e.id === lease.anchor)) {
      throw new Error(`${label} source branch changed.`);
    }
    return lease;
  }
  function assert(value: object): void {
    base(value);
    if (statePin(entries()) !== pin) throw new Error(`${label} loaded source publication changed; reload is required.`);
  }
  const provider: AggregateSourceProvider = {
    capture(candidate) {
      if (!host || candidate.manager !== host.manager || candidate.sessionId !== host.sessionId || candidate.cwd !== host.cwd) {
        throw new Error(`${label} caller does not own the loaded source.`);
      }
      const branch = entries();
      const anchor = (host.manager as Manager).getLeafId?.() ?? branch.at(-1)?.id ?? null;
      const value = Object.freeze({});
      issued.set(value, { epoch, host, anchor });
      assert(value);
      return value;
    },
    assert,
    host(value) { return Object.freeze({ ...base(value).host }); },
    subscribe(value,listener) { assert(value);listeners.add(listener);return ()=>{listeners.delete(listener);}; },
  };
  return {
    provider,
    load(candidate: AggregateSourceHost, isCurrent: () => boolean): boolean {
      epoch++;host=Object.freeze({...candidate});currentHost=isCurrent;
      try {const branch=entries();pin=statePin(branch);loadedAnchor=branch.at(-1)?.id??null;changed();return true;}
      catch {host=undefined;currentHost=undefined;pin=undefined;loadedAnchor=null;changed();return false;}
    },
    matchesLoaded(candidate:AggregateSourceHost):boolean {
      try{return !!host && currentHost?.()===true && host.manager===candidate.manager && host.cwd===candidate.cwd && host.sessionId===candidate.sessionId
        && (host.manager as Manager).getSessionId?.()===host.sessionId && statePin(entries())===pin
        && (loadedAnchor===null || entries().some(entry=>entry.id===loadedAnchor));}catch{return false;}
    },
    invalidate(): void { epoch++; host = undefined; currentHost = undefined; pin = undefined;loadedAnchor=null;changed(); },
    /** Every content/state append is guarded separately. A throwing/no-op write never advances the pin. */
    append(type: string, data: unknown, write: () => void, guard: () => void): void {
      guard();
      const value = provider.capture(host!);
      assert(value);
      // Prefix identity only. The latest canonical payload is checked by statePin;
      // historical aggregate/chat bodies are not rehashed for every append.
      const identity=(entry:Entry)=>digest({id:entry.id,parentId:entry.parentId,type:entry.type,customType:entry.customType});
      const before = entries().map(identity);
      try {
      write();
      base(value);
      const after = entries();
      if (after.length <= before.length || before.some((fingerprint, i) => identity(after[i]) !== fingerprint)) {
        throw new Error(`${label} append target changed or append was not observed; write outcome requires reconciliation.`);
      }
      const appended = after.slice(before.length).find(e => e.type === "custom" && e.customType === type && digest(e.data) === digest(data));
      if (!appended) throw new Error(`${label} expected publication was not observed; write outcome requires reconciliation.`);
      if (type === stateEntryType) {
        const latest = after.filter(e => e.type === "custom" && e.customType === stateEntryType).at(-1);
        if (latest !== appended) throw new Error(`${label} publication was superseded during append.`);
        pin = statePin(after);
      } else if (statePin(after) !== pin) {
        throw new Error(`${label} canonical state changed during content append.`);
      }
      guard();
      } catch(error) {
        epoch++;host=undefined;currentHost=undefined;pin=undefined;changed();
        throw new AggregatePublicationUnconfirmedError(error,label);
      }
    },
  };
}
