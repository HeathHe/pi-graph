/** Host-owned identity, never task text or caller-supplied boolean claims. */
// Jiti and native TS loaders can coexist in the worker; share identity, not flags.
const brandKey=Symbol.for('pi-graph.owned-session-brand.v1');
const ownedChildren:WeakMap<object,{shutdownComplete:boolean}>=(globalThis as any)[brandKey]??=((new WeakMap<object,{shutdownComplete:boolean}>()));
export function brandOwnedChild(child:object):void { if(!ownedChildren.has(child))ownedChildren.set(child,{shutdownComplete:false}); }
export function recordOwnedShutdown(child:object,complete:boolean):void { const state=ownedChildren.get(child);if(state)state.shutdownComplete=complete===true; }
export function ownedChildBrand(child:object):{officialInProcess:true;shutdownComplete:boolean}|undefined { const state=ownedChildren.get(child);return state?{officialInProcess:true,shutdownComplete:state.shutdownComplete}:undefined; }

/** Unknown queue APIs cannot attest zero queued input. */
export function inspectOwnedQueuedInput(session:any):{known:boolean;queued:boolean} {
 try{
  const count=session.pendingMessageCount;
  const steering=session.getSteeringMessages?.(),followUp=session.getFollowUpMessages?.();
  if(!Number.isSafeInteger(count)||count<0||!Array.isArray(steering)||!Array.isArray(followUp))return {known:false,queued:true};
  return {known:true,queued:count>0||steering.length>0||followUp.length>0};
 }catch{return {known:false,queued:true};}
}
export function createOwnedActivityProof(intent:any) {
 const proof:Record<string,any>={version:1,runtimeKind:'pi-graph-sdk/1',factoryIdentity:'pi-graph-owned-session/1',runId:intent.runId,stepIndex:0,agent:intent.agent.name??intent.params.agent,launchContractDigest:intent.launchContract.launchContractDigest??intent.launchContract.digest,launches:1,officialInProcess:false,controlledEnvironment:false,subscribedBeforePrompt:false,agentStarted:false,promptSettled:false,shutdownComplete:false,toolsStarted:0,assistantToolCalls:0,orphanToolResult:false,lateActivity:false,invalid:false,queuedInput:false,stopped:false,timedOut:false,interrupted:false,forced:false,graphBinding:intent.params.extensionBindings?.['pi-graph/1']};
 const startedTools=new Set<string>();let settled=false,agentStarts=0;
 const observe=(event:any)=>{
  if(settled&&['agent_start','tool_execution_start','message_end'].includes(event.type))proof.lateActivity=true;
  if(event.type==='agent_start'){proof.agentStarted=true;if(++agentStarts>1)proof.invalid=true;}
  if(event.type==='tool_execution_start'){proof.toolsStarted++;if(typeof event.toolCallId==='string')startedTools.add(event.toolCallId);else proof.invalid=true;}
  if(event.type==='tool_execution_end'&&!startedTools.has(event.toolCallId))proof.orphanToolResult=true;
  if(event.type==='message_end'){
   const m=event.message;
   if(m?.role==='toolResult'&&!startedTools.has(m.toolCallId))proof.orphanToolResult=true;
   if(m?.role==='assistant'){
    proof.assistantToolCalls+=(m.content??[]).filter((c:any)=>c.type==='toolCall').length;
    if(m.stopReason==='error'&&typeof m.errorMessage==='string'&&m.errorMessage){proof.diagnostic=m.errorMessage;proof.diagnosticSource='assistant_error';}
   }
  }
  if(event.type==='owned_extension_error')proof.invalid=true;
 };
 return {proof,observe,
  admit(child:any){const brand=ownedChildBrand(child);proof.officialInProcess=brand?.officialInProcess===true;proof.controlledEnvironment=brand!==undefined&&child.controlledEnvironment===true;proof.subscribedBeforePrompt=brand!==undefined;},
  settle(session:any){settled=true;proof.promptSettled=true;const queue=inspectOwnedQueuedInput(session);proof.queuedInput=queue.queued;if(!queue.known||queue.queued)proof.invalid=true;},
  finish(child:any,flags:Record<string,boolean>={}){const brand=child?ownedChildBrand(child):undefined;proof.officialInProcess=brand?.officialInProcess===true;proof.shutdownComplete=brand?.shutdownComplete===true;for(const key of ['stopped','timedOut','interrupted','forced'])proof[key]=flags[key]===true;if(flags.steered){proof.queuedInput=true;proof.invalid=true;}return proof;},
 };
}
