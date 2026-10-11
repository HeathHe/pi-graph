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

const WAKE_TEXT='Graph updates are ready. Inspect the Graph status and integrate the result.';
const wakeKey=Symbol.for('pi-graph.wake/1');
const reservations:WeakMap<object,{sessionId:string;pending:boolean}>=(globalThis as any)[wakeKey]??=new WeakMap();
/** A single follow-up enters SDK prompt admission; notices never start a turn. */
export class GraphParentWake {
 private ctx:any;private reservation?:{sessionId:string;pending:boolean};
 private pi:any;constructor(pi:any){this.pi=pi;}
 bind(ctx:any){this.ctx=ctx;const sid=ctx.sessionManager.getSessionId();const old=reservations.get(ctx.sessionManager);this.reservation=old?.sessionId===sid?old:{sessionId:sid,pending:false};reservations.set(ctx.sessionManager,this.reservation!)}
 notify(content:string){
  if(!this.ctx||!this.reservation)return;
  this.pi.sendMessage({customType:'pi-graph-update',content,display:false},{triggerTurn:false});
  if(this.reservation.pending)return;
  this.reservation.pending=true;
  try{this.pi.sendUserMessage(WAKE_TEXT,{deliverAs:'followUp'})}catch(e){this.reservation.pending=false;throw e}
 }
 messageStarted(message:any){if(message?.role==='user'&&message.content?.some((b:any)=>b.type==='text'&&b.text===WAKE_TEXT)&&this.reservation)this.reservation.pending=false}
 shutdown(reason?:string){if(reason!=='reload'&&this.reservation)this.reservation.pending=false;this.ctx=undefined}
}
