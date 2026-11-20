import {Buffer} from 'node:buffer';
import type {ScopeLease,Scope} from '../contracts.ts';
import {copy} from '../contracts.ts';
import {sameScope,scopeKey,validScope} from '../scope.ts';
import type {JournalPartition,JournalPort,SupervisionFact,HistoryRestoreResult} from './contracts.ts';
import {validFact,canonical} from './normalize.ts';
const MAX_BYTES=512*1024;
interface Envelope extends JournalPartition {schemaVersion:1;revision:number;segments:{scope:Scope;events:SupervisionFact[]}[]}
export class BoundedSupervisionJournal {
 constructor(private readonly port:JournalPort,private readonly partition:JournalPartition,private readonly lease:ScopeLease) {}
 private key():string{return JSON.stringify([this.partition.workspaceDigest,this.partition.sessionDigest]);}
 private decode(raw:string|null):Envelope {
  if(raw===null)return {...this.partition,schemaVersion:1,revision:0,segments:[]};
  if(Buffer.byteLength(raw)>MAX_BYTES)throw new Error('oversize');
  let v:Envelope;try{v=JSON.parse(raw) as Envelope;}catch{throw new Error('schema');}
  if(!v||typeof v!=='object')throw new Error('schema');
  if(v.workspaceDigest!==this.partition.workspaceDigest||v.sessionDigest!==this.partition.sessionDigest)throw new Error('foreign');
  if(v.schemaVersion!==1||!Number.isSafeInteger(v.revision)||v.revision<0||!Array.isArray(v.segments)||v.segments.length>8)throw new Error('schema');
  const scopes=new Set<string>();
  for(const s of v.segments){
   if(!validScope(s.scope)||s.scope.sessionId!==this.lease.scope.sessionId||scopes.has(scopeKey(s.scope))||!Array.isArray(s.events)||s.events.length>50)throw new Error('segment');
   scopes.add(scopeKey(s.scope));const identities=new Map<string,string>();
   for(const f of s.events){if(!validFact(f)||!sameScope(f.header.scope,s.scope)||identities.has(f.header.eventId))throw new Error('event');identities.set(f.header.eventId,canonical(f));}
  }
  return v;
 }
 async restore():Promise<HistoryRestoreResult>{
  if(!this.lease.current())return {status:'closed',current:[],historical:[]};
  try{return await this.port.transact(this.key(),async tx=>{
   await tx.assertOwned();const v=this.decode(await tx.readBounded(MAX_BYTES));await tx.assertOwned();
   if(!this.lease.current())return {status:'closed',current:[],historical:[]};
   return {status:'available',current:copy(v.segments.find(s=>sameScope(s.scope,this.lease.scope))?.events??[]),historical:copy(v.segments.filter(s=>!sameScope(s.scope,this.lease.scope)))};
  });}catch(e){const reason=e instanceof Error?e.message:'unavailable';return {status:reason==='foreign'?'foreign':['schema','segment','event','oversize'].includes(reason)?'invalid':'unavailable',current:[],historical:[],reason:['foreign','schema','segment','event','oversize'].includes(reason)?reason:'journal-unavailable'};}
 }
 async append(fact:SupervisionFact):Promise<{status:'written'|'duplicate'|'unavailable'|'closed';evicted:number}>{
  if(!this.lease.current()||!sameScope(fact.header.scope,this.lease.scope)||!validFact(fact))return {status:'closed',evicted:0};
  try{return await this.port.transact(this.key(),async tx=>{
   await tx.assertOwned();const v=this.decode(await tx.readBounded(MAX_BYTES));
   if(!this.lease.current())return {status:'closed',evicted:0};
   let segment=v.segments.find(s=>sameScope(s.scope,this.lease.scope));
   if(!segment){segment={scope:copy(this.lease.scope),events:[]};v.segments.push(segment);}
   const old=segment.events.find(f=>f.header.eventId===fact.header.eventId);
   if(old){if(canonical(old)!==canonical(fact))throw new Error('conflict');return {status:'duplicate',evicted:0};}
   segment.events.push(copy(fact));let evicted=0;
   while(segment.events.length>50){segment.events.shift();evicted++;}
   while(v.segments.length>8)evicted+=v.segments.shift()!.events.length;
   v.revision++;let raw=JSON.stringify(v);
   while(Buffer.byteLength(raw)>MAX_BYTES){const first=v.segments[0];if(!first)throw new Error('oversize');if(first.events.length){first.events.shift();evicted++;}else v.segments.shift();raw=JSON.stringify(v);}
   await tx.assertOwned();if(!this.lease.current())return {status:'closed',evicted:0};
   await tx.replaceAtomically(raw);return {status:'written',evicted};
  });}catch{return {status:'unavailable',evicted:0};}
 }
}
