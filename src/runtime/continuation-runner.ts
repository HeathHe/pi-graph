import {inspectOwnedQueuedInput} from "./activity-proof.ts";
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {openOwnedChild} from './child-session.ts';
import {atomicWriteJson} from '../v3/durable.ts';
import {canonicalDigest} from '../v3/digests.ts';
import {CONTINUE_MESSAGE,newSegmentProof,continuationControl,eligibleSegment,eligibleTransientSegment,transientFailureKind,validateSegmentProof,assertContinuationCandidate} from './session-continuation.ts';
import {strictSession,deploymentDigest,checkpointIdentity} from './session-checkpoint.ts';
import {validateRuntimeFallbackPlan} from '../v3/runtime-fallback.ts';

export async function runContinuingChild(intent:any,fixture?:any){
 validateRuntimeFallbackPlan(intent.continuation.plan);
 if(intent.continuation.plan.sessionContinuationVersion!==1)throw Error('Continuation protocol was not admitted');
 const cp=intent.resumeCheckpoint,plan=intent.continuation.plan;
 let index=cp?.nextCandidateIndex??intent.continuation.candidateIndex;
 const ledger:any=cp?structuredClone(cp.continuationEvidence):{version:1,kind:'pi-graph-session-continuation/1',planDigest:plan.digest,initialCandidateIndex:index,candidateIndex:index,transitions:[],segments:[],...(plan.transientRetryLimit!==undefined?{transientRetries:0}:{}),sessionId:undefined};
 const usage=cp?structuredClone(cp.usage):{tokens:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0},totalCost:0,toolCount:0,turnCount:0};
 const startedAt=cp?.startedAt??Date.now();
 const initial=plan.candidates[intent.continuation.candidateIndex];
 const step:any={index:0,agent:intent.agent.name??intent.params.agent,state:'running',lifecycle:{phase:'starting'},requestedModel:initial.resolvedModel,model:initial.resolvedModel,launchContractDigest:intent.launchContract.launchContractDigest,...usage,continuationEvidence:ledger};
 const status:any={version:3,runtimeKind:'pi-graph-sdk/1',runId:intent.runId,sessionId:intent.sessionId,cwd:intent.params.cwd,state:'running',startedAt,lastUpdate:Date.now(),runnerProcessInstanceId:intent.runnerProcessInstanceId,generation:intent.generation??0,noTimeout:true,steps:[step]};
 let writes=Promise.resolve();const write=(name:string,value:any)=>{const v=structuredClone(value);writes=writes.then(()=>atomicWriteJson(join(intent.asyncDir,name),v));return writes;};
 const publish=()=>{Object.assign(step,usage);status.lastUpdate=Date.now();void write('status.json',status).catch(()=>{});};
 let startupStage='host_sdk_loading',promptStarted=false;
 let child:any,error:string|undefined,stopped=false,success=false,output='',segment:any=newSegmentProof(),handoff:any,diagnostic:string|undefined;
 const boundary=async()=>{let c=await continuationControl(intent);while(c==='paused'&&!stopped){step.lifecycle={phase:'paused'};publish();await new Promise(r=>setTimeout(r,100));c=await continuationControl(intent);}if(c==='stopped')stopped=true;return !stopped;};
 const stop=()=>{stopped=true;void child?.session.abort();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 const timer=setInterval(()=>{void continuationControl(intent).then(c=>{if(c==='stopped')stop();}).catch(()=>{error='Graph control identity unavailable';stop();});},100);timer.unref();
 try{
  await write('status.json',status);
  child=await openOwnedChild(intent,e=>{
   if(e.type==='owned_startup_stage')startupStage=e.stage;
   segment.observe(e);
   if(e.type==='owned_duplicate_tool_blocked')step.duplicateToolBlocks=(step.duplicateToolBlocks??0)+1;
   if(['owned_budget_exceeded','owned_extension_error','owned_tool_blocked','owned_duplicate_tool_blocked','owned_model_policy_denied'].includes(e.type))error=e.error;
   if(e.type==='turn_start')usage.turnCount++;
   if(e.type==='tool_execution_start'){usage.toolCount++;step.currentTool=e.toolName;}
   if(e.type==='tool_execution_end'){delete step.currentTool;if(e.isError)step.toolErrorCount=(step.toolErrorCount??0)+1;}
   if(e.type==='message_end'&&e.message?.role==='assistant'){if(!e.message.usage||['input','output','totalTokens','cacheRead','cacheWrite'].some(k=>!Number.isFinite(e.message.usage[k])||e.message.usage[k]<0)||!Number.isFinite(e.message.usage.cost?.total)){error='Unknown provider usage prevents continuation';step.usageUnknown=true;}for(const k of Object.keys(usage.tokens))usage.tokens[k]+=e.message.usage?.[k]??0;usage.totalCost+=e.message.usage?.cost?.total??0;}
   publish();
  },fixture);
  if(!child.controlledEnvironment)ledger.continuationDisabledReason='uncontrolled_extensions';
  assertContinuationCandidate(intent,intent.continuation.candidateIndex);
  const session=child.session;step.sessionFile=session.sessionFile;ledger.sessionId=session.sessionManager.getSessionId();
  const frozenDefinitions=canonicalDigest(child.modelDefinitions);
  if(cp&&cp.runtimeFingerprint!==child.runtimeFingerprint)throw Error('Checkpoint effective settings, tools or prompt changed');
  if(cp&&cp.modelDefinitionsDigest!==frozenDefinitions)throw Error('Checkpoint model definitions changed');
  const deployment=await deploymentDigest(intent);
  ledger.modelDefinitions=child.modelDefinitions;
  let initialControl=await continuationControl(intent);while(initialControl==='paused'&&!stopped){step.lifecycle={phase:'paused'};publish();await new Promise(r=>setTimeout(r,100));initialControl=await continuationControl(intent);}
  if(initialControl==='stopped')stopped=true;
  if(cp&&stopped){const last=ledger.segments.at(-1);step.model=last.model;step.thinking=last.thinking;step.actualModelDefinition=ledger.modelDefinitions.find((d:any)=>d.model===last.model)?.definition;}
  if(cp&&!stopped){
   const q=inspectOwnedQueuedInput(session);if(!q.known||q.queued||session.isIdle!==true)throw Error('Checkpoint session has queued or unsettled activity');
   assertContinuationCandidate(intent,index);
   const tr={version:1,from:cp.candidateIndex,to:index,mode:'checkpoint',sourceSegmentIndex:ledger.segments.length-1,state:'intent',diagnostic:cp.diagnostic,segmentDigest:canonicalDigest(cp.segment),checkpointDigest:cp.digest,generation:intent.generation};ledger.transitions.push(tr);ledger.candidateIndex=index;
   await write('continuation-ledger.json',ledger);if(await boundary()){await child.switchModel(index);tr.state='acknowledged';}else{ledger.transitions.pop();ledger.candidateIndex=cp.candidateIndex;const last=ledger.segments.at(-1);step.model=last.model;step.thinking=last.thinking;step.actualModelDefinition=ledger.modelDefinitions.find((d:any)=>d.model===last.model)?.definition;}await write('continuation-ledger.json',ledger);
  }
  for(;;){
   // Pause parks the continuation boundary; it does not cancel a running user turn.
   assertContinuationCandidate(intent,index);
   let control=await continuationControl(intent);while(control==='paused'&&!stopped){step.lifecycle={phase:'paused'};publish();await new Promise(r=>setTimeout(r,100));control=await continuationControl(intent);}
   if(control==='stopped'||stopped){stopped=true;break;}
   if(await deploymentDigest(intent)!==deployment)throw Error('Continuation deployment changed');
   if(ledger.segments.length){const q=inspectOwnedQueuedInput(session);if(!q.known||q.queued||session.isIdle!==true)throw Error('Continuation cannot consume queued or unsettled activity');if(!cp||ledger.segments.at(-1).generation===(intent.generation??0)){ledger.segments.at(-1).proof=segment.settle(session);validateSegmentProof(ledger.segments.at(-1).proof);}}
   const before=structuredClone(usage);segment=newSegmentProof();diagnostic=undefined;
   step.model=plan.candidates[index].resolvedModel;step.thinking=session.thinkingLevel;step.actualModelDefinition=child.actualModelDefinition;step.lifecycle={phase:'running'};publish();
   if(fixture&&intent.params.fixtureScenario==='resume-rejected'&&ledger.segments.length)throw Error('Fixture continuation input rejected');
   promptStarted=true;
   await session.prompt(ledger.segments.length||cp?CONTINUE_MESSAGE:intent.params.task);await session.waitForIdle();
   if(fixture&&intent.params.fixtureScenario==='queued-final'&&index===plan.candidates.length-1)await session.followUp('Fixture queued input after settled prompt');
   const proof=segment.settle(session);const last=session.messages.filter((m:any)=>m.role==='assistant').at(-1);
   if(last&&`${last.provider}/${last.model}`!==`${session.model.provider}/${session.model.id}`)error='Assistant actual model identity differs from the acknowledged session model';
   output=(last?.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');diagnostic=last?.stopReason==='error'?last.errorMessage:undefined;
   const delta={tokens:Object.fromEntries(Object.keys(usage.tokens).map(k=>[k,usage.tokens[k]-before.tokens[k]])),totalCost:usage.totalCost-before.totalCost,turnCount:usage.turnCount-before.turnCount,toolCount:usage.toolCount-before.toolCount};
   ledger.segments.push({index:ledger.segments.length,candidateIndex:index,model:step.model,thinking:step.thinking,generation:intent.generation??0,sessionId:ledger.sessionId,...delta,proof,diagnostic,stopReason:last?.stopReason});ledger.candidateIndex=index;await write('continuation-ledger.json',ledger);
   if(last?.stopReason==='stop'&&!error&&!stopped){validateSegmentProof(proof);success=true;break;}
   const turnLimit=intent.params.turnBudget;const budget=intent.params.usageBudget;
   if(turnLimit&&usage.turnCount>=turnLimit.maxTurns+(turnLimit.graceTurns??0))error??='Graph child hard turn budget reached.';
   if(budget?.tokens&&usage.tokens.totalTokens>=budget.tokens.hard)error??='Graph child hard tokens budget reached.';
   if(budget?.costUsd&&usage.totalCost>=budget.costUsd.hard)error??='Graph child hard costUsd budget reached.';
   const transientKind=transientFailureKind(last);
   if(transientKind){
    const retryLimit=plan.transientRetryLimit??0;
    if(!child.controlledEnvironment||!eligibleTransientSegment(last,proof,{stopped,error})||ledger.transientRetries>=retryLimit||!retryLimit){
     error??=`${diagnostic}. 未自动续接：${!retryLimit?'旧冻结计划未启用瞬时错误续接':ledger.transientRetries>=retryLimit?'本次运行唯一一次续接已使用':!child.controlledEnvironment?'扩展环境不满足安全续接条件':'会话闲置、工具结果或用量证明不完整'}。保留原结果，不重派原任务。`;break;
    }
    const sourceSegmentIndex=ledger.segments.length-1;
    const retry={version:1,from:index,to:index,mode:'transient',runId:intent.runId,sessionId:ledger.sessionId,state:'intent',sourceSegmentIndex,diagnostic,segmentDigest:canonicalDigest(proof),generation:intent.generation??0,retryOrdinal:(ledger.transientRetries??0)+1};
    ledger.transitions.push(retry);ledger.transientRetries=retry.retryOrdinal;
    await write('continuation-ledger.json',ledger);
    if(fixture&&intent.params.fixtureScenario==='transient-stop')await write('control.json',{version:1,runId:intent.runId,runnerProcessInstanceId:intent.runnerProcessInstanceId,action:'stop'});
    if(fixture&&intent.params.fixtureScenario==='transient-pause-stop'){await write('graph-control.json',{graphId:'fixture-graph',runInstanceId:'fixture-run',desiredState:'paused'});setTimeout(()=>{void write('graph-control.json',{graphId:'fixture-graph',runInstanceId:'fixture-run',desiredState:'stopped'});},50);}
    if(fixture&&intent.params.fixtureScenario==='transient-crash')process.kill(process.pid,'SIGKILL');
    if(fixture&&intent.params.fixtureScenario==='transient-late')segment.observe({type:'agent_start'});
    // A reserved retry is never refunded, including stop/late activity after commit.
    if(!await boundary())break;
    ledger.segments[sourceSegmentIndex].proof=segment.settle(session);validateSegmentProof(ledger.segments[sourceSegmentIndex].proof);
    if(canonicalDigest(ledger.segments[sourceSegmentIndex].proof)!==retry.segmentDigest)throw Error('Transient retry settlement changed after reservation');
    if(await deploymentDigest(intent)!==deployment)throw Error('Transient retry deployment changed');
    assertContinuationCandidate(intent,index);
    if(step.model!==plan.candidates[index].resolvedModel||`${session.model.provider}/${session.model.id}`!==step.model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u,'')||session.thinkingLevel!==step.thinking||canonicalDigest(child.actualModelDefinition)!==canonicalDigest(step.actualModelDefinition))throw Error('Transient retry model identity changed');
    if(error||stopped)break;
    retry.state='acknowledged';await write('continuation-ledger.json',ledger);
    continue;
   }
   const eligible=eligibleSegment(last,proof,{stopped,error});
   if(!child.controlledEnvironment||!eligible.eligible||index+1>=plan.candidates.length||index+1>plan.modelDegradations){error??=diagnostic??'Child did not produce a successful terminal result';break;}
   assertContinuationCandidate(intent,index+1);
   control=await continuationControl(intent);while(control==='paused'&&!stopped){step.lifecycle={phase:'paused'};publish();await new Promise(r=>setTimeout(r,100));control=await continuationControl(intent);}
   if(control==='stopped'||stopped){stopped=true;break;}
   validateSegmentProof(segment.settle(session));
   // Completed writes are retained; only the settled exact transcript may be handed off.
   // A clean process generation is the fallback when live switching cannot be used.
   const requestedControl=await import('../v3/native-results.ts').then(m=>m.readNativeJson(join(intent.asyncDir,'control.json')));
   if(requestedControl&&requestedControl.runId===intent.runId&&requestedControl.runnerProcessInstanceId===intent.runnerProcessInstanceId&&['checkpoint','park_checkpoint'].includes(requestedControl.action)){
    handoff={version:1,kind:'pi-graph-session-checkpoint/1',runId:intent.runId,generation:intent.generation??0,runnerProcessInstanceId:intent.workerInstanceId,identity:checkpointIdentity(intent),candidateIndex:index,nextCandidateIndex:index+1,sessionFile:session.sessionFile,session:await strictSession(session.sessionFile,intent.params.cwd),usage:structuredClone(usage),startedAt,continuationEvidence:structuredClone(ledger),segment:proof,diagnostic,runtimeFingerprint:child.runtimeFingerprint,modelDefinitionsDigest:frozenDefinitions,deploymentDigest:deployment};break;
   }
   const transition={version:1,from:index,to:index+1,mode:'live',sourceSegmentIndex:ledger.segments.length-1,state:'intent',diagnostic,segmentDigest:canonicalDigest(proof),generation:intent.generation??0};
   ledger.transitions.push(transition);ledger.candidateIndex=++index;await write('continuation-ledger.json',ledger);
   if(!await boundary()){ledger.transitions.pop();ledger.candidateIndex=--index;await write('continuation-ledger.json',ledger);break;}
   try{await child.switchModel(index);ledger.segments.at(-1).proof=segment.settle(session);validateSegmentProof(ledger.segments.at(-1).proof);}catch(e){error='Continuation model switch rejected: '+String(e);break;}
   transition.state='acknowledged';await write('continuation-ledger.json',ledger);
  }
 }catch(e){error=e instanceof Error?e.message:String(e);success=false;handoff=undefined;if(!promptStarted)step.startupFailure={version:1,stage:startupStage,runId:intent.runId,generation:intent.generation??0,workerInstanceId:intent.workerInstanceId,promptStarted:false};}
 finally{if(child)try{await child.shutdown();const finalProof=segment.settle(child.session);if(ledger.segments.length){ledger.segments.at(-1).proof=finalProof;if(success||handoff)validateSegmentProof(finalProof);}if(handoff){handoff.segment=finalProof;handoff.continuationEvidence=structuredClone(ledger);handoff.shutdownComplete=true;if(canonicalDigest(await strictSession(handoff.sessionFile,intent.params.cwd))!==canonicalDigest(handoff.session))throw Error('Shutdown changed checkpoint');}}catch(e){error=String(e);success=false;handoff=undefined;}clearInterval(timer);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
 if(handoff&&await continuationControl(intent)==='stopped'){stopped=true;handoff=undefined;}
 if(handoff&&!stopped){handoff.digest=canonicalDigest(handoff);await write('checkpoint.json',handoff);status.state='running';step.lifecycle={phase:'checkpoint'};await write('status.json',status);return 0;}
 status.state=stopped?'stopped':success?'complete':'failed';status.error=error;status.endedAt=Date.now();step.state=status.state;step.error=error;step.lifecycle={phase:'settled'};step.durationMs=status.endedAt-startedAt;Object.assign(step,usage);
 ledger.final=true;ledger.digest=canonicalDigest({...ledger,digest:undefined});
 const result={...step,runId:intent.runId,output,finalOutput:output,success,error,stopped,timedOut:false,continuationEvidence:ledger};
 const completion={runId:intent.runId,asyncDir:intent.asyncDir,sessionId:intent.sessionId,state:status.state,success,results:[result],durationMs:step.durationMs};
 await write('continuation-ledger.json',ledger);await write('result.json',completion);await write('status.json',status);return success?0:1;
}
