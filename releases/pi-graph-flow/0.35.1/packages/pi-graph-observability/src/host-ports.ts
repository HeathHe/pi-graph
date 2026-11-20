import type {ScopeLease} from './contracts.ts';
import {captureLease,sameScope} from './scope.ts';
import type {JournalPartition,JournalPort} from './supervision/contracts.ts';
export interface JournalFactoryBinding extends JournalPartition {readonly lease:ScopeLease}
export type JournalFactory=(binding:JournalFactoryBinding)=>JournalPort|undefined;
interface Registration {token:object;binding:JournalFactoryBinding;factory:JournalFactory}
const key=Symbol.for('pi-graph-observability.journal-factory.v1');
const shared=globalThis as typeof globalThis & Record<symbol,unknown>;
function registrations():Map<string,Registration>{const value=shared[key];if(value instanceof Map)return value;const map=new Map<string,Registration>();shared[key]=map;return map;}
const partitionKey=(b:JournalPartition)=>JSON.stringify([b.workspaceDigest,b.sessionDigest]);
/** Exact owner token required for disposal; stale registrations are never stolen. */
export function registerJournalFactory(binding:JournalFactoryBinding,factory:JournalFactory):{token:object;dispose(token:object):boolean}{
 if(!binding.lease.current())throw new Error('Stale journal factory lease');
 const map=registrations(),id=partitionKey(binding);if(map.has(id))throw new Error('Journal factory owner already registered');
 const token=Object.freeze({}),registration={token,binding:{...binding,lease:captureLease(binding.lease)},factory};map.set(id,registration);announceRoot();
 return {token,dispose(candidate){if(candidate!==token||map.get(id)!==registration)return false;map.delete(id);announceRoot();return true;}};
}
export function resolveJournalPort(binding:JournalFactoryBinding):JournalPort|undefined {
 const registration=registrations().get(partitionKey(binding));
 if(!registration||!binding.lease.current()||!registration.binding.lease.current()||!sameScope(binding.lease.scope,registration.binding.lease.scope))return undefined;
 const port=registration.factory({...binding,lease:captureLease(binding.lease)});
 if(!port||!binding.lease.current()||!registration.binding.lease.current())return undefined;
 const assertCurrent=()=>{if(registrations().get(partitionKey(binding))!==registration||!binding.lease.current()||!registration.binding.lease.current())throw new Error('Stale journal factory');};
 return {async transact(scope,fn){assertCurrent();return port.transact(scope,async tx=>{
  assertCurrent();const guarded={
   async readBounded(max:number){assertCurrent();const value=await tx.readBounded(max);assertCurrent();return value;},
   async assertOwned(){assertCurrent();await tx.assertOwned();assertCurrent();},
   async replaceAtomically(bytes:string){assertCurrent();await tx.assertOwned();assertCurrent();await tx.replaceAtomically(bytes);assertCurrent();}
  };return fn(guarded);
 });}};
}

export interface RootLeaseCapability {capture():JournalFactoryBinding|undefined}
interface RootRegistration {token:object;capability:RootLeaseCapability}
const rootsKey=Symbol.for('pi-graph-observability.root-lease-capabilities.v1');
const rootListenersKey=Symbol.for('pi-graph-observability.root-lease-listeners.v1');
function roots():Map<string,RootRegistration>{const v=shared[rootsKey];if(v instanceof Map)return v;const map=new Map<string,RootRegistration>();shared[rootsKey]=map;return map;}
function rootListeners():Set<()=>void>{const v=shared[rootListenersKey];if(v instanceof Set)return v;const set=new Set<()=>void>();shared[rootListenersKey]=set;return set;}
function announceRoot():void{for(const fn of rootListeners()){try{fn();}catch{/* observations cannot break host lifecycle */}}}
/** Installed by the host owning the real Root fence, not reconstructed by Flow/Cockpit. */
export function registerRootLeaseCapability(partition:JournalPartition,capability:RootLeaseCapability):{token:object;notify(token:object):boolean;dispose(token:object):boolean}{
 const id=partitionKey(partition),map=roots();if(map.has(id))throw new Error('Root lease capability already owned');
 const token=Object.freeze({}),entry={token,capability};map.set(id,entry);announceRoot();
 return {token,notify(candidate){if(candidate!==token||map.get(id)!==entry)return false;announceRoot();return true;},dispose(candidate){if(candidate!==token||map.get(id)!==entry)return false;map.delete(id);announceRoot();return true;}};
}
export function captureRootLease(partition:JournalPartition):JournalFactoryBinding|undefined {
 const entry=roots().get(partitionKey(partition));if(!entry)return undefined;
 const binding=entry.capability.capture();if(!binding||partitionKey(binding)!==partitionKey(partition)||!binding.lease.current())return undefined;
 return {...binding,lease:captureLease(binding.lease)};
}
export function subscribeRootLease(listener:()=>void):{dispose():void}{rootListeners().add(listener);return {dispose:()=>{rootListeners().delete(listener);}};}
