import {assertCandidateModelCapabilities} from './model-capabilities.ts';
import {assertChildModelAllowed,mergeChildModelPolicies} from './child-model-policy.ts';
import {canonicalDigest} from '../v3/digests.ts';
import {validateRuntimeFallbackPlan,runtimeModelFamily} from '../v3/runtime-fallback.ts';
import {classifyProviderFailure} from '../v3/failure-policy.ts';
import {inspectOwnedQueuedInput} from './activity-proof.ts';
import {readNativeJson} from '../v3/native-results.ts';
import {join} from 'node:path';

export const CONTINUE_MESSAGE='Continue the unfinished work from this same session and its existing tool results. Do not repeat completed tool operations. Do not restart the original task.';
const key=Symbol.for('pi-graph.continuation-authority.v1');
const authorities:Map<string,any>=(globalThis as any)[key]??=new Map();
/** Called only by the Graph dispatch implementation, never RPC or task data. */
export function authorizeContinuation(params:any,authority:any):()=>void {
 const digest=canonicalDigest(params);validateRuntimeFallbackPlan(authority.plan);
 if(authority.plan.sessionContinuationVersion!==1)return ()=>{};
 const old=authorities.get(digest);if(old&&canonicalDigest(old)!==canonicalDigest(authority))throw Error('Ambiguous continuation authority');
 authorities.set(digest,structuredClone(authority));return ()=>authorities.delete(digest);
}
export function ownedContinuationAuthority(params:any):any {return structuredClone(authorities.get(canonicalDigest(params)));}
export function newSegmentProof(){
 const calls=new Map<string,string>(),starts=new Set<string>(),ends=new Set<string>(),results=new Set<string>();
 let invalid=false,settled=false,active=false,agentStarts=0,agentEnds=0,toolFailure=false,lateActivity=false;
 return {observe(e:any){
  if(settled&&['agent_start','agent_end','message_end','tool_execution_start','tool_execution_end'].includes(e.type)){invalid=true;lateActivity=true;}
  if(e.type==='agent_start'){if(active)invalid=true;active=true;agentStarts++;}
  if(e.type==='agent_end'){if(!active)invalid=true;active=false;agentEnds++;}
  if(['owned_budget_exceeded','owned_extension_error','owned_tool_blocked','owned_duplicate_tool_blocked','owned_model_policy_denied'].includes(e.type))invalid=true;
  if(e.type==='message_end'&&e.message?.role==='assistant')for(const c of e.message.content??[])if(c.type==='toolCall'){if(typeof c.id!=='string'||calls.has(c.id))invalid=true;else calls.set(c.id,c.name);}
  if(e.type==='tool_execution_start'){if(!calls.has(e.toolCallId)||starts.has(e.toolCallId)||calls.get(e.toolCallId)!==e.toolName)invalid=true;starts.add(e.toolCallId);}
  if(e.type==='tool_execution_end'){if(!starts.has(e.toolCallId)||ends.has(e.toolCallId))invalid=true;ends.add(e.toolCallId);toolFailure||=e.isError===true;}
  if(e.type==='message_end'&&e.message?.role==='toolResult'){const id=e.message.toolCallId;if(!starts.has(id)||results.has(id))invalid=true;results.add(id);toolFailure||=e.message.isError===true;}
 },settle(session:any){settled=true;const q=inspectOwnedQueuedInput(session);const safe=!invalid&&!active&&agentStarts>0&&agentStarts===agentEnds&&q.known&&!q.queued&&session.isIdle===true&&calls.size===starts.size&&starts.size===ends.size&&ends.size===results.size;
  return {version:1,started:agentStarts>0,ended:agentEnds>0,agentStarts,agentEnds,settled,invalid,lateActivity,queued:q.queued,queueKnown:q.known,idle:session.isIdle===true,toolFailure,toolCalls:calls.size,toolsStarted:starts.size,toolsEnded:ends.size,toolResults:results.size,callIds:[...calls.keys()].sort(),startedIds:[...starts].sort(),endedIds:[...ends].sort(),resultIds:[...results].sort(),safe};}};
}
/** The boolean safe is a checked projection, not an assertion supplied by a worker. */
export function validateSegmentProof(p:any,requireSafe=true):void {
 const fields=['started','ended','settled','invalid','lateActivity','queued','queueKnown','idle','toolFailure','safe'];
 if(!p||p.version!==1||fields.some(k=>typeof p[k]!=='boolean'))throw Error('Malformed continuation segment proof');
 for(const k of ['agentStarts','agentEnds','toolCalls','toolsStarted','toolsEnded','toolResults'])if(!Number.isSafeInteger(p[k])||p[k]<0)throw Error('Malformed continuation proof counts');
 for(const [key,count]of [['callIds','toolCalls'],['startedIds','toolsStarted'],['endedIds','toolsEnded'],['resultIds','toolResults']])if(!Array.isArray(p[key])||p[key].length!==p[count]||p[key].some((id:any)=>typeof id!=='string'||!id)||new Set(p[key]).size!==p[key].length)throw Error('Malformed continuation proof tool IDs');
 const paired=['startedIds','endedIds','resultIds'].every(k=>canonicalDigest([...p[k]].sort())===canonicalDigest([...p.callIds].sort()));
 const safe=p.started&&p.ended&&p.settled&&!p.invalid&&!p.lateActivity&&!p.queued&&p.queueKnown&&p.idle&&p.agentStarts>0&&p.agentStarts===p.agentEnds&&paired;
 if(p.safe!==safe||requireSafe&&!safe)throw Error('Unsafe continuation settlement proof');
}
export function candidateThinking(c:any){return c.thinking===false?'off':c.thinking??/:((?:off|minimal|low|medium|high|xhigh|max))$/u.exec(c.resolvedModel)?.[1];}
export function supportedThinking(model:any,level:any):boolean {
 if(!['off','minimal','low','medium','high','xhigh','max'].includes(level))return false;
 if(!model?.reasoning)return level==='off';
 const mapped=model.thinkingLevelMap?.[level];return mapped!==null&&(!['xhigh','max'].includes(level)||mapped!==undefined);
}
export function assertContinuationCandidate(intent:any,index:number):void {
 const c=intent.continuation?.plan?.candidates[index],constraints=intent.continuation?.producerConstraints;
 if(!c)throw Error('Unadmitted continuation candidate');
 assertChildModelAllowed(c.resolvedModel,mergeChildModelPolicies(intent.launchContract?.childModelPolicy));
 if(intent.continuation.plan.requireCrossFamilyFromProducers&&(!constraints||constraints.required!==true))throw Error('Accepted producer evidence missing');
 if(constraints?.required){
  if(constraints.version!==1||!Array.isArray(constraints.dependencies)||constraints.dependencies.some((d:any)=>typeof d.actualModel!=='string'||typeof d.taskId!=='string'||!Number.isSafeInteger(d.attempt)||d.attempt<1||!/^([a-f0-9]{64})$/.test(d.evidenceDigest)||d.family!==runtimeModelFamily(d.actualModel)))throw Error('Accepted producer evidence invalid');
  if(constraints.dependencies.some((d:any)=>d.family===runtimeModelFamily(c.resolvedModel)))throw Error('Continuation candidate violates accepted producer family boundary');
 }
}
export async function continuationControl(intent:any):Promise<'running'|'paused'|'stopped'> {
 const local=await readNativeJson(join(intent.asyncDir,'control.json'));
 if(local&&local.version===1&&local.runId===intent.runId&&local.runnerProcessInstanceId===intent.runnerProcessInstanceId&&local.action==='stop')return 'stopped';
 const a=intent.continuation;
 const binding=intent.params.extensionBindings?.['pi-graph/1'];if(binding){const contract=await readNativeJson(join(intent.params.cwd,'.pi-graph','node-contract.json'));if(!contract||canonicalDigest(contract)!==binding.contractDigest)throw Error('Frozen Graph permission contract changed');}
 if(a?.controlPath){const c=await readNativeJson(a.controlPath);if(!c||c.runInstanceId!==a.runInstanceId||c.graphId!==a.graphId||!['running','paused','stopped'].includes(c.desiredState))throw Error('Continuation Graph control identity unavailable');return c.desiredState;}
 return 'running';
}
export function eligibleSegment(last:any,proof:any,flags:any):{eligible:boolean;kind:string}{
 try{validateSegmentProof(proof);}catch{return {eligible:false,kind:'unsafe'};}
 if(flags.stopped||flags.timedOut||flags.error||last?.stopReason!=='error'||typeof last.errorMessage!=='string')return {eligible:false,kind:'unsafe'};
 return classifyProviderFailure(last.errorMessage);
}

/** Only a settled assistant transport error, never tool/task text or a host deadline. */
export function transientFailureKind(last:any):string|undefined {
 if(last?.stopReason!=='error'||typeof last.errorMessage!=='string')return;
 const message=last.errorMessage.trim();
 if(/^(?:Request timed out\.?|Connection error\.?|fetch failed|(?:read )?ECONNRESET|ETIMEDOUT|socket hang up)$/i.test(message))return /timed out|ETIMEDOUT/i.test(message)?'request_timeout':'connection_failure';
}
export function eligibleTransientSegment(last:any,proof:any,flags:any):boolean {
 try{validateSegmentProof(proof);}catch{return false;}
 return !flags.stopped&&!flags.timedOut&&!flags.error&&!!transientFailureKind(last);
}

export function validateContinuationResult(intent:any,result:any,checkpoint=false){
 const l=result?.continuationEvidence,p=intent.continuation?.plan;
 validateRuntimeFallbackPlan(p);
 if(result.usageUnknown)throw Error('Unknown provider usage cannot be sealed as complete accounting');
 if(!l||!p||l.version!==1||l.kind!=='pi-graph-session-continuation/1'||l.planDigest!==p.digest||!checkpoint&&(l.final!==true||l.digest!==canonicalDigest({...l,digest:undefined}))||l.initialCandidateIndex!==intent.continuation.candidateIndex||!Array.isArray(l.transitions)||!Array.isArray(l.segments)||l.transitions.length>p.modelDegradations+(p.transientRetryLimit??0))throw Error('Continuation result ledger invalid');
 if(!Array.isArray(l.modelDefinitions)||l.modelDefinitions.length!==p.candidates.length||p.candidates.some((c:any,i:number)=>{const d=l.modelDefinitions[i];return d?.model!==c.resolvedModel||`${d.definition?.provider}/${d.definition?.id}`!==c.resolvedModel.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u,'');}))throw Error('Continuation model-definition identities differ from admission');
 for(const [i,c] of p.candidates.entries())assertCandidateModelCapabilities(c,l.modelDefinitions[i].definition,p.requirements);
 if(l.segments.length&&typeof l.sessionId!=='string')throw Error('Continuation SDK session identity missing');
 if(l.continuationDisabledReason!==undefined&&(l.continuationDisabledReason!=='uncontrolled_extensions'||l.transitions.length))throw Error('Continuation was disabled for these extensions');
 const retries=l.transitions.filter((t:any)=>t.mode==='transient');
 if(retries.length>(p.transientRetryLimit??0)||(p.transientRetryLimit!==undefined||l.transientRetries!==undefined)&&l.transientRetries!==retries.length)throw Error('Transient retry count differs from frozen policy');
 let candidate=l.initialCandidateIndex;let previousSource=-1;
 for(const t of l.transitions){
  assertContinuationCandidate(intent,t.to);
  const transient=t.mode==='transient';
  if(t.version!==1||t.from!==candidate||t.to!==(transient?candidate:candidate+1)||!['live','checkpoint','transient'].includes(t.mode)||!['intent','acknowledged'].includes(t.state)||!p.candidates[t.to]||typeof t.segmentDigest!=='string')throw Error('Continuation transition chain invalid');
  const source=t.sourceSegmentIndex??(p.transientRetryLimit===undefined?l.segments.findIndex((s:any)=>s.candidateIndex===t.from):-1),s=l.segments[source];
  if(!Number.isSafeInteger(source)||source<=previousSource||!s||s.candidateIndex!==t.from)throw Error('Missing or duplicate continuation predecessor');previousSource=source;
  validateSegmentProof(s.proof);
  if((t.mode==='live'||transient)&&t.generation!==s.generation||t.mode==='checkpoint'&&(t.generation!==s.generation+1||!/^([a-f0-9]{64})$/.test(t.checkpointDigest??'')))throw Error('Continuation transition generation mismatch');
  if(s.stopReason!=='error'||t.segmentDigest!==canonicalDigest(s.proof)||t.diagnostic!==s.diagnostic||(transient?!transientFailureKind({stopReason:s.stopReason,errorMessage:t.diagnostic}):!classifyProviderFailure(t.diagnostic??'').eligible))throw Error('Continuation transition lacks matching settled provider failure');
  if(transient&&(t.runId!==intent.runId||t.sessionId!==l.sessionId))throw Error('Transient retry run/session identity mismatch');
  if(transient&&(t.retryOrdinal!==retries.indexOf(t)+1||t.retryOrdinal>1))throw Error('Invalid transient retry ordinal');
  const next=l.segments[source+1];
  if(next&&(t.state!=='acknowledged'||next.candidateIndex!==t.to||next.generation!==t.generation))throw Error('Continuation transition acknowledgement mismatch');
  candidate=t.to;
 }
 if(candidate!==l.candidateIndex)throw Error('Continuation candidate index mismatch');
 let previous=l.initialCandidateIndex-1;const totals:any={input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0,totalCost:0,turnCount:0,toolCount:0};
 const completedIds=new Set<string>();
 for(const [i,s] of l.segments.entries()){
  assertContinuationCandidate(intent,s.candidateIndex);validateSegmentProof(s.proof);if(s.toolCount!==s.proof.toolsStarted||!Number.isSafeInteger(s.generation)||s.generation<0)throw Error('Continuation segment tool/generation accounting mismatch');const frozenThinking=candidateThinking(p.candidates[s.candidateIndex]);if(frozenThinking!==undefined&&s.thinking!==frozenThinking||!supportedThinking(l.modelDefinitions[s.candidateIndex]?.definition,s.thinking))throw Error('Continuation candidate thinking mismatch');for(const id of s.proof.resultIds){if(completedIds.has(id))throw Error('Duplicate completed tool ID across segments');completedIds.add(id);}
  if(s.index!==i||s.sessionId!==l.sessionId||s.candidateIndex<previous||s.model!==p.candidates[s.candidateIndex]?.resolvedModel||s.candidateIndex>candidate)throw Error('Continuation segment identity mismatch');previous=s.candidateIndex;
  if(i===0&&s.candidateIndex!==l.initialCandidateIndex)throw Error('Initial continuation segment mismatch');
  if(i>0){const transition=l.transitions.find((t:any)=>(t.sourceSegmentIndex??(p.transientRetryLimit===undefined?l.segments.findIndex((v:any)=>v.candidateIndex===t.from):-1))===i-1);if(!transition||transition.state!=='acknowledged'||transition.to!==s.candidateIndex||transition.from!==l.segments[i-1].candidateIndex)throw Error('Continuation segment lacks acknowledged transition');if(transition.mode==='transient'&&(s.model!==l.segments[i-1].model||s.thinking!==l.segments[i-1].thinking))throw Error('Transient retry changed model or thinking');}
  for(const k of ['input','output','totalTokens','cacheRead','cacheWrite']){if(!Number.isFinite(s.tokens?.[k])||s.tokens[k]<0)throw Error('Unknown continuation usage');totals[k]+=s.tokens[k];}
  for(const k of ['totalCost','turnCount','toolCount']){if(!Number.isFinite(s[k])||s[k]<0)throw Error('Unknown continuation usage');totals[k]+=s[k];}
 }
 for(const k of ['input','output','totalTokens','cacheRead','cacheWrite'])if(result.tokens?.[k]!==totals[k])throw Error('Continuation token totals mismatch');
 for(const k of ['totalCost','turnCount','toolCount'])if(result[k]!==totals[k])throw Error('Continuation usage totals mismatch');
 const last=l.segments.at(-1);if(last&&(result.model!==last.model||result.thinking!==last.thinking))throw Error('Continuation final model mismatch');
 const def=l.modelDefinitions?.find((d:any)=>d.model===result.model)?.definition;
 if(last&&canonicalDigest(def??{})!==canonicalDigest(result.actualModelDefinition??{}))throw Error('Continuation actual model definition mismatch');
 if(result.success&&last?.stopReason!=='stop')throw Error('Successful continuation lacks a terminal assistant stop');
 if(result.success&&(!last||last.candidateIndex!==candidate||l.transitions.some((t:any)=>t.state!=='acknowledged')))throw Error('Unacknowledged continuation cannot succeed');
 return l;
}
