import type { Header, Scope, ScopeLease } from './contracts.ts';
export function validScope(s: Scope): boolean { return !!s && [s.sessionId,s.ownerId,s.incarnation].every(x => typeof x === 'string' && x.length > 0 && x.length <= 512) && Number.isSafeInteger(s.runtimeGeneration) && s.runtimeGeneration >= 0; }
export function scopeKey(s: Scope): string { return JSON.stringify([s.sessionId,s.runtimeGeneration,s.ownerId,s.incarnation]); }
export function sameScope(a: Scope,b: Scope): boolean { return scopeKey(a) === scopeKey(b); }
export function validHeader(h: Header): boolean { return !!h && h.version === 1 && validScope(h.scope) && typeof h.eventId === 'string' && h.eventId.length > 0 && h.eventId.length <= 512 && typeof h.source === 'string' && h.source.length > 0 && h.source.length <= 128 && Number.isSafeInteger(h.sequence) && h.sequence >= 0 && Number.isFinite(h.observedAt) && h.observedAt >= 0; }
export function captureLease(lease: ScopeLease): ScopeLease { const scope = Object.freeze({...lease.scope}); return {scope,current: () => lease.current() && sameScope(scope,lease.scope)}; }
/** A passive lease gate, not an execution authority or a reconstructed host fence. */
export class ScopeGeneration {
  private epoch = 0;
  start(scope: Scope): ScopeLease { if (!validScope(scope)) throw new Error('Invalid scope'); const epoch = ++this.epoch; return {scope:Object.freeze({...scope}),current:()=>this.epoch===epoch}; }
  invalidate(): void { this.epoch++; }
}
