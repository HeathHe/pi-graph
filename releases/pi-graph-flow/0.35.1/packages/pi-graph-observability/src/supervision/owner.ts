import type {Clock,ScopeLease,Subscription,ReadView} from '../contracts.ts';
import {copy,frozen} from '../contracts.ts';
import {captureLease,sameScope} from '../scope.ts';
import type {AcceptResult,SupervisionFact,SupervisionProjection,HistoryRestoreResult,JournalPort,JournalPartition} from './contracts.ts';
import {domainOf,validFact,canonical} from './normalize.ts';
import {BoundedSupervisionJournal} from './journal.ts';
export class SupervisionOwner {
 private readonly lease:ScopeLease;
 private revision=0;private closed=false;private draining=false;private restoring?:Promise<HistoryRestoreResult>;
 private journal?:BoundedSupervisionJournal;
 private readonly listeners=new Set<()=>void>();
 private readonly identities=new Map<string,string>();
 private readonly highWater=new Map<string,number>();
 private readonly operations=new Map<string,SupervisionFact>();
 private readonly evictedOperationStarts=new Map<string,number>();
 private readonly queue:SupervisionFact[]=[];
 private drainWaiters=new Set<()=>void>();
 private projection:SupervisionProjection;
 constructor(lease:ScopeLease,private readonly clock:Clock,private readonly partition:JournalPartition,port?:JournalPort){
  const captured=captureLease(lease);this.lease={scope:captured.scope,current:()=>!this.closed&&captured.current()};
  this.projection={scope:copy(lease.scope),events:[],counts:{'execution-publication':0,'notification-receipt':0,verdict:0,'physical-close':0,evaluation:0,intervention:0},delivery:{attempted:0,unknown:0,confirmed:0,failed:0},publications:{completed:0,failed:0,terminated:0,unknown:0},history:{status:'unavailable',reason:'journal-not-configured',current:[],historical:[]},dropped:0,evicted:0,diagnostics:0};
  if(port)this.attachJournal(port);
 }
 private changed():void{this.revision++;for(const fn of this.listeners){try{fn();}catch{/* UI cannot break producer */}}}
 attachJournal(port:JournalPort):boolean {if(this.closed||!this.lease.current()||this.journal)return false;this.journal=new BoundedSupervisionJournal(port,this.partition,this.lease);return true;}
 accept(fact:SupervisionFact):AcceptResult{return this.apply(fact,true);}
 private apply(fact:SupervisionFact,persist:boolean):AcceptResult {
  if(this.closed)return 'closed';
  if(!validFact(fact)){this.projection.diagnostics++;this.changed();return 'invalid';}
  if(!this.lease.current()||!sameScope(this.lease.scope,fact.header.scope))return 'foreign';
  const id=fact.header.eventId,signature=canonical(fact),previous=this.identities.get(id);
  if(previous!==undefined){if(previous===signature)return 'duplicate';this.projection.diagnostics++;this.changed();return 'conflict';}
  const source=fact.header.source,water=this.highWater.get(source);
  if(water!==undefined&&fact.header.sequence<=water)return this.identities.size>=1024?'dedup-expired':'out-of-order';
  if(!this.highWater.has(source)&&this.highWater.size>=64)return 'invalid';
  const domain=domainOf(fact),op=fact.kind==='completion'?JSON.stringify([domain,fact.delivery!.receiptId]):JSON.stringify([source,domain,fact.operationId??fact.delivery?.receiptId??id]);
  const old=this.operations.get(op);
  if(old&&fact.kind==='completion'&&old.terminalOutcome!==fact.terminalOutcome){this.projection.diagnostics++;this.changed();return 'conflict';}
  if(old?.delivery?.state==='confirmed'&&fact.delivery?.state!=='confirmed')return 'out-of-order';
  const start=fact.operationStartSequence??fact.header.sequence;
  if(old&&(old.operationStartSequence??old.header.sequence)!==start)return 'conflict';
  // A producer supplies the ORIGINAL operation sequence on every later receipt.
  // Old associations outside the window are explicit, while new operations keep flowing.
  if(!old&&start<=(this.evictedOperationStarts.get(source)??-1))return 'dedup-expired';
  if(!old&&this.operations.size>=1024){
   const oldestKey=this.operations.keys().next().value!,expired=this.operations.get(oldestKey)!;
   this.operations.delete(oldestKey);
   const expiredSource=expired.header.source,expiredStart=expired.operationStartSequence??expired.header.sequence;
   this.evictedOperationStarts.set(expiredSource,Math.max(expiredStart,this.evictedOperationStarts.get(expiredSource)??-1));
  }
  const owned=copy(fact);this.identities.set(id,signature);if(this.identities.size>1024)this.identities.delete(this.identities.keys().next().value!);
  this.highWater.set(source,fact.header.sequence);this.operations.set(op,owned);
  if(!old){this.projection.counts[domain]++;if(domain==='execution-publication')this.projection.publications[fact.terminalOutcome??'unknown']++;}
  if(old?.delivery)this.projection.delivery[old.delivery.state]--;
  if(fact.delivery)this.projection.delivery[fact.delivery.state]++;
  this.projection.events.push(owned);if(this.projection.events.length>50){this.projection.events.shift();this.projection.evicted++;}
  if(persist&&this.journal){if(this.queue.length>=64)this.projection.dropped++;else{this.queue.push(owned);void this.drain();}}
  this.changed();return 'applied';
 }
 snapshot():ReadView<SupervisionProjection>{return frozen({revision:this.revision,value:this.projection});}
 subscribe(listener:()=>void):Subscription{if(this.closed)return {dispose(){}};this.listeners.add(listener);return {dispose:()=>this.listeners.delete(listener)};}
 async restoreHistory():Promise<HistoryRestoreResult>{
  if(this.closed)return {status:'closed',current:[],historical:[]};
  if(this.restoring)return this.restoring;
  if(!this.journal)return copy(this.projection.history);
  this.restoring=(async()=>{const result=await this.journal!.restore();if(this.closed||!this.lease.current())return {status:'closed' as const,current:[],historical:[]};
   if(result.status==='available')for(const fact of result.current)this.apply(fact,false);
   this.projection.history=copy(result);this.changed();return copy(result);
  })().finally(()=>{this.restoring=undefined;});return this.restoring;
 }
 private async drain():Promise<void>{
  if(this.draining||!this.journal||this.closed)return;this.draining=true;
  try{while(this.queue.length&&!this.closed&&this.lease.current()){
   const result=await this.journal.append(this.queue.shift()!);
   if(this.closed)break;
   if(result.status==='unavailable')this.projection.history={status:'unavailable',reason:'journal-write-failed',current:[],historical:[]};
   this.projection.evicted+=result.evicted;this.changed();
  }}finally{this.draining=false;for(const resolve of this.drainWaiters)resolve();this.drainWaiters.clear();}
 }
 async close():Promise<void>{
  if(this.closed)return;
  if(this.draining||this.queue.length)await new Promise<void>(resolve=>{
   let done=false;let timer:{cancel():void}|undefined;
   const finish=()=>{if(done)return;done=true;timer?.cancel();this.drainWaiters.delete(finish);resolve();};
   this.drainWaiters.add(finish);timer=this.clock.schedule(1000,finish);void this.drain();
  });
  this.closed=true;this.projection.dropped+=this.queue.length;this.queue.length=0;this.listeners.clear();this.drainWaiters.clear();
 }
}
