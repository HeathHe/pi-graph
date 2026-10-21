/** Graph-owned background inventory, intentionally independent of other extensions. */
interface WorkProvider {name:string;listActiveWork:()=>Array<{id:string;sessionId:string}>;wakeChannels?:string[]}
const key=Symbol.for('pi-graph.background-work/1');
const providers:Map<string,WorkProvider>=(globalThis as any)[key]??=new Map();
export function registerBackgroundWorkProvider(provider:WorkProvider){
 if(!provider.name||typeof provider.listActiveWork!=='function')throw Error('Invalid Graph work provider');
 providers.set(provider.name,provider);
 return ()=>{if(providers.get(provider.name)===provider)providers.delete(provider.name)};
}
export function listBackgroundWorkProviders():WorkProvider[]{return [...providers.values()];}
export function snapshotBackgroundWork(sessionId:string){return [...providers.values()].flatMap(p=>p.listActiveWork().filter(i=>i.sessionId===sessionId).map(i=>({...i,provider:p.name})))}

/** Only extension-owned notices participate; user follow-ups are never removed. */
export interface GraphWakeObservation {sessionId:string;graphId:string;runInstanceId:string;fingerprint:string}
const ACK_TYPE='pi-graph-notification-ack-v1';
const wakeKey=Symbol.for('pi-graph.wake/2');
interface WakeState {sessionId:string;generation:number;pending:Map<string,GraphWakeObservation>;consumed:Map<string,string>;delivered:Map<string,string>}
const reservations:WeakMap<object,WakeState>=(globalThis as any)[wakeKey]??=new WeakMap();
const issuedKey=Symbol.for('pi-graph.wake-issued/1');
const issued:Map<string,{state:WakeState;generation:number}>=(globalThis as any)[issuedKey]??=new Map();
const observationKey=(o:GraphWakeObservation)=>JSON.stringify([o.sessionId,o.graphId,o.runInstanceId]);
const validObservation=(o:unknown):o is GraphWakeObservation=>{const v=o as GraphWakeObservation;return !!v&&['sessionId','graphId','runInstanceId','fingerprint'].every(k=>typeof v[k as keyof GraphWakeObservation]==='string'&&v[k as keyof GraphWakeObservation].length>0&&v[k as keyof GraphWakeObservation].length<=256)&&/^[a-f0-9]{64}$/.test(v.fingerprint);};
export class GraphParentWake {
 private ctx:any;private state?:WakeState;private generation=0;private active=false;private body=false;private completed=false;private settleAborted=false;
 private reads=new Map<string,GraphWakeObservation>();private observed=new Map<string,GraphWakeObservation>();
 private ticket?:{text:string;entries:GraphWakeObservation[];generation:number;admitted:boolean};
 private pi:any;constructor(pi:any){this.pi=pi;}
 bind(ctx:any){
  this.ctx=ctx;const sid=ctx.sessionManager.getSessionId(),old=reservations.get(ctx.sessionManager);
  this.state=old?.sessionId===sid?old:{sessionId:sid,generation:0,pending:new Map(),consumed:new Map(),delivered:new Map()};
  reservations.set(ctx.sessionManager,this.state!);this.generation=++this.state!.generation;
  this.reads.clear();this.observed.clear();this.ticket=undefined;this.body=false;this.completed=false;this.settleAborted=false;this.active=false;
  // Rebuild exclusively from the current branch, never from siblings or raw chat text.
  this.state!.consumed.clear();this.state!.delivered.clear();
  for(const entry of ctx.sessionManager.getBranch?.()??[]){const d=entry?.data;if(entry?.type==='custom'&&entry.customType===ACK_TYPE&&d?.version===1&&d.sessionId===sid&&Array.isArray(d.observations)&&d.observations.length<=128)for(const o of d.observations)if(validObservation(o)&&o.sessionId===sid)this.state!.consumed.set(observationKey(o),o.fingerprint);}
  for(const [key,o] of this.state!.pending)if(this.state!.consumed.get(key)===o.fingerprint)this.state!.pending.delete(key);
 }
 private current(){try{return !!this.ctx&&!!this.state&&this.state.generation===this.generation&&this.ctx.sessionManager.getSessionId()===this.state.sessionId;}catch{return false;}}
 private idle(){try{return this.current()&&!this.active&&this.ctx.isIdle?.()===true&&!this.ctx.hasPendingMessages?.();}catch{return false;}}
 notify(_content:string,observation?:GraphWakeObservation){
  if(!this.current()||!validObservation(observation)||observation.sessionId!==this.state!.sessionId)return;
  const key=observationKey(observation);if(this.state!.consumed.get(key)===observation.fingerprint)return;
  const changed=this.state!.pending.get(key)?.fingerprint!==observation.fingerprint;
  this.state!.pending.set(key,{...observation});this.flush(changed);
 }
 observe(callId:string,observation:GraphWakeObservation){if(this.current()&&validObservation(observation)&&observation.sessionId===this.state!.sessionId)this.reads.set(callId,{...observation});}
 toolFinished(callId:string,isError:boolean){const o=this.reads.get(callId);this.reads.delete(callId);if(o&&this.current()&&!isError)this.observed.set(observationKey(o),o);}
 started(){if(!this.current())return;this.active=true;this.settleAborted=false;if(!this.ticket?.admitted)this.ticket=undefined;this.body=false;this.completed=false;this.reads.clear();this.observed.clear();}
 messageEnded(message:any){if(message?.role!=='assistant')return;this.body=message.stopReason==='stop'&&Array.isArray(message.content)&&message.content.some((b:any)=>b.type==='text'&&typeof b.text==='string'&&b.text.trim().length>0);}
 beforeSettle(outcome:string){this.settleAborted=outcome==='aborted';this.completed=outcome==='completed'&&this.body;}
 settled(aborted:boolean){
  if(!this.current())return;aborted=aborted||this.settleAborted;this.settleAborted=false;this.active=false;this.ticket=undefined;
  if(!aborted&&this.completed&&this.body&&this.observed.size){
   const observations=[...this.observed.values()].filter(o=>this.state!.consumed.get(observationKey(o))!==o.fingerprint).slice(-128);
   // appendEntry is the public synchronous session store API. Persistence failure leaves pending intact.
   try{if(observations.length)this.pi.appendEntry(ACK_TYPE,{version:1,sessionId:this.state!.sessionId,observations});for(const o of observations){const key=observationKey(o);this.state!.consumed.set(key,o.fingerprint);if(this.state!.pending.get(key)?.fingerprint===o.fingerprint)this.state!.pending.delete(key);}}catch{/* No durable ACK, so do not claim consumption. */}
  }
  this.observed.clear();this.reads.clear();this.body=false;this.completed=false;
  // Cancellation never immediately starts another turn. A later user turn/new event can reconsider.
  if(!aborted)this.flush();
 }
 flush(reconsiderUndelivered=true){
  if(!this.idle())return;
  // A void public send can fail before input without a delivery callback. Only a new
  // observation or explicit reconsideration retires that unadmitted ticket. Heartbeats
  // do not retry. Once input admitted it, pending auth is indistinguishable from failure;
  // wait for a real lifecycle rather than risk starting two turns.
  if(this.ticket&&!this.ticket.admitted&&reconsiderUndelivered)this.ticket=undefined;
  if(this.ticket)return;
  const entries=[...this.state!.pending.values()].filter(o=>this.state!.delivered.get(observationKey(o))!==o.fingerprint);
  if(!entries.length)return;
  const text=`Graph 有新的结果或待处理事项，请核对并整合；不要重跑已完成工作。 [pi-graph-notice:${globalThis.crypto.randomUUID()}]`;
  const ticket={text,entries,generation:this.generation,admitted:false};this.ticket=ticket;issued.set(text,{state:this.state!,generation:this.generation});while(issued.size>256)issued.delete(issued.keys().next().value!);
  // No deliverAs: a busy admission race must fail rather than enter the SDK user queue.
  try{const sent=this.pi.sendUserMessage(text);if(sent&&typeof sent.catch==='function')void sent.catch(()=>{if(this.ticket===ticket)this.ticket=undefined;});}catch{if(this.ticket===ticket)this.ticket=undefined;}
 }
 input(event:{source:string;text:string}){
  if(event.source!=='extension')return {action:'continue'} as const;
  const owner=issued.get(event.text);if(!owner)return {action:'continue'} as const;
  if(owner.state!==this.state||owner.generation!==this.generation||event.text!==this.ticket?.text)return {action:'handled'} as const;
  const ticket=this.ticket;if(!this.idle()||ticket.generation!==this.generation){this.ticket=undefined;return {action:'handled'} as const;}
  ticket.entries=ticket.entries.filter(o=>this.state!.pending.get(observationKey(o))?.fingerprint===o.fingerprint&&this.state!.consumed.get(observationKey(o))!==o.fingerprint);
  if(!ticket.entries.length){this.ticket=undefined;return {action:'handled'} as const;}
  ticket.admitted=true;return {action:'continue'} as const;
 }
 messageStarted(message:any){if(!this.current()||message?.role!=='user'||!this.ticket?.admitted)return;const ticket=this.ticket;if(message.content?.some((b:any)=>b.type==='text'&&b.text===ticket.text))for(const o of ticket.entries)this.state!.delivered.set(observationKey(o),o.fingerprint);this.ticket=undefined;}
 shutdown(_reason?:string){this.ctx=undefined;this.reads.clear();this.observed.clear();this.ticket=undefined;}
}
