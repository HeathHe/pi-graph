import {createHash} from 'node:crypto';
import {join} from 'node:path';
import type {ExtensionAPI,ExtensionContext} from '@earendil-works/pi-coding-agent';
import type {AssistantMessage} from '@earendil-works/pi-ai';
import {captureRootLease,registerJournalFactory,subscribeRootLease,scopeKey,type JournalFactoryBinding,type JournalPort} from 'pi-graph-observability';
import {createPrivateJournalPort} from './private-journal-adapter.ts';
import {recordUsage} from '../providers/usage-history.ts';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export function registerObservabilityHostServices(pi:ExtensionAPI,options:{root?:()=>string;createPort?:(binding:JournalFactoryBinding)=>JournalPort|undefined;record?:typeof recordUsage}={}){
 let ctx:ExtensionContext|undefined,registration:ReturnType<typeof registerJournalFactory>|undefined,bound:string|undefined;let disposed=false,refreshing=false;
 const clear=()=>{registration?.dispose(registration.token);registration=undefined;bound=undefined;};
 const refresh=()=>{if(disposed||!ctx||refreshing)return;refreshing=true;try{const partition={workspaceDigest:digest(ctx.cwd),sessionDigest:digest(ctx.sessionManager.getSessionId())};const binding=captureRootLease(partition);const next=binding?scopeKey(binding.lease.scope):undefined;if(next===bound)return;clear();if(!binding)return;
  bound=next;registration=registerJournalFactory(binding,request=>options.createPort?options.createPort(request):options.root?createPrivateJournalPort({root:options.root()},request):undefined);bound=next;
 }finally{refreshing=false;}};
 type Pending={message:AssistantMessage;manager:ExtensionContext['sessionManager'];sessionId:string;cwd:string};
 const pending=new Map<AssistantMessage,Pending>();
 const flushPending=async(manager:ExtensionContext['sessionManager'],dropMissing=false)=>{
  for(const [message,item] of pending){if(item.manager!==manager)continue;
   // message_end precedes SDK appendMessage. Only the canonical entry can supply identity.
   const entry=manager.getEntries().find(value=>value.type==='message'&&value.message===message);
   if(!entry||entry.type!=='message'){if(dropMissing)pending.delete(message);continue;}
   pending.delete(message);
   try{await (options.record??recordUsage)(entry.message as AssistantMessage,item.sessionId,item.cwd,entry.id);}catch{/* Existing backfill remains the recovery path. */}
  }
 };
 let subscription:{dispose():void}|undefined=subscribeRootLease(refresh);
 pi.on('session_start',async(_event,context)=>{if(ctx)await flushPending(ctx.sessionManager,true);ctx=context;disposed=false;subscription??=subscribeRootLease(refresh);refresh();});
 pi.on('session_shutdown',async(_event,context)=>{await flushPending(context.sessionManager,true);ctx=undefined;subscription?.dispose();subscription=undefined;clear();});
 // Collection remains independent of footer ownership and T availability.
 pi.on('message_end',(event,context)=>{if(event.message.role!=='assistant')return;const message=event.message as AssistantMessage;
  if(pending.size>=1024&&!pending.has(message))pending.delete(pending.keys().next().value!);
  pending.set(message,{message,manager:context.sessionManager,sessionId:context.sessionManager.getSessionId(),cwd:context.cwd});
 });
 pi.on('message_start',async(_event,context)=>{await flushPending(context.sessionManager);});
 pi.on('agent_end',async(_event,context)=>{await flushPending(context.sessionManager,true);});
 return {refresh,dispose(){disposed=true;pending.clear();ctx=undefined;clear();subscription?.dispose();}};
}
