export interface Scope { readonly sessionId: string; readonly runtimeGeneration: number; readonly ownerId: string; readonly incarnation: string }
export interface Header { readonly version: 1; readonly scope: Scope; readonly eventId: string; readonly source: string; readonly sequence: number; readonly observedAt: number }
export type Availability = 'known' | 'unknown' | 'unsupported' | 'unconfigured' | 'error' | 'stale';
export interface Subscription { dispose(): void }
export interface Clock { now(): number; schedule(ms: number, callback: () => void): { cancel(): void }; scheduleBackground?(ms:number, callback:()=>void):{cancel():void} }
export interface ScopeLease { readonly scope: Scope; current(): boolean }
export interface ReadView<T> { readonly revision: number; readonly value: Readonly<T> }
/** Snapshots never expose owner Maps or mutable internal facts. */
export function copy<T>(value: T): T { return structuredClone(value); }
export function frozen<T>(value: T): T {
  const cloned = copy(value);
  const freeze = (v: unknown): void => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const item of Object.values(v)) freeze(item); } };
  freeze(cloned); return cloned;
}
