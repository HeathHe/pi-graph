import {createHash} from 'node:crypto';
import {captureRootLease,captureLease,scopeKey,type SupervisionFact} from 'pi-graph-observability';
interface Context {cwd:string;sessionManager?:unknown}
interface Bus {emit(name:string,payload:unknown):void}
let root='';const sequences=new Map<string,number>();
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Called before each real asynchronous evaluation/delivery. Scope is never rebound on return. */
export function beginFlowSupervision(ctx:Context,bus:Bus|undefined,source:'advisor'|'goal',operationId:string){
 const manager=ctx.sessionManager;if(!manager||typeof manager!=='object'||!('getSessionId' in manager)||typeof manager.getSessionId!=='function'||!bus)return undefined;const sessionId:unknown=manager.getSessionId();if(typeof sessionId!=='string'||!sessionId)return undefined;
 const binding=captureRootLease({workspaceDigest:digest(ctx.cwd),sessionDigest:digest(sessionId)});if(!binding)return undefined;
 const lease=captureLease(binding.lease),key=scopeKey(lease.scope),producer=`flow:${source}`;
 if(root!==key){root=key;sequences.clear();}
 const next=()=>{const n=(sequences.get(producer)??0)+1;sequences.set(producer,n);return n;},start=next();
 const emit=(kind:SupervisionFact['kind'],detail:Partial<Pick<SupervisionFact,'severity'|'message'|'target'|'verdict'|'delivery'>>={})=>{
  if(!lease.current()||root!==key)return false;const sequence=next();
  try{bus.emit('pi-graph:supervision-fact:v1',{header:{version:1,scope:lease.scope,eventId:`${producer}:${operationId}:${sequence}`,source:producer,sequence,observedAt:Date.now()},source,kind,severity:'info',operationId,operationStartSequence:start,...detail} satisfies SupervisionFact);return true;}catch{return false;}
 };
 return {lease,emit};
}
