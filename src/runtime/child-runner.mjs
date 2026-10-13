import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url,{moduleCache:false});
const {openOwnedChild}=await jiti.import('./child-session.ts');
const {createOwnedActivityProof}=await jiti.import('./activity-proof.ts');
const intent=JSON.parse(await readFile(process.argv[2],'utf8'));
if(intent.version!==1||typeof intent.runId!=='string'||typeof intent.asyncDir!=='string')throw new Error('Invalid owned child intent.');
// Test scenarios are fixed and require a test process marker. No arbitrary modules/config hooks.
const requested=process.argv[3]==='--test-fixture'?process.argv[4]:undefined;
if(requested && (process.env.NODE_ENV!=='test'||!['success','quota','tool','pending','continuation','checkpoint','route-fallback'].includes(requested)))throw new Error('Invalid child test fixture.');
await mkdir(intent.asyncDir,{recursive:true,mode:0o700});
if(intent.continuation){const {runContinuingChild}=await jiti.import('./continuation-runner.ts');process.exitCode=await runContinuingChild(intent,requested);process.exit(process.exitCode);}
let writes=Promise.resolve();
const write=(file,value)=>{const snapshot=JSON.stringify(value);const work=writes.then(async()=>{const temporary=join(intent.asyncDir,`${file}.${process.pid}.tmp`);await writeFile(temporary,snapshot,{mode:0o600});await rename(temporary,join(intent.asyncDir,file));});writes=work;return work;};
const startedAt=Date.now();let child,stopped=false,timedOut=false,promptSettled=false;
const digest=intent.launchContract.launchContractDigest??intent.launchContract.digest;
const step={index:0,agent:intent.agent.name??intent.params.agent,state:'running',lifecycle:{phase:'starting'},requestedModel:intent.params.model??intent.launchContract.model,model:intent.params.model??intent.launchContract.model,thinking:intent.params.thinking??intent.launchContract.thinking,launchContractDigest:digest,toolCount:0,turnCount:0,tokens:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0},totalCost:0,recentTools:[],acknowledgedExtensions:[]};
const status={version:3,runtimeKind:"pi-graph-sdk/1",runId:intent.runId,sessionId:intent.sessionId,cwd:intent.params.cwd,state:'running',startedAt,lastUpdate:startedAt,runnerProcessInstanceId:intent.runnerProcessInstanceId,noTimeout:true,steps:[step]};
const activity=createOwnedActivityProof(intent),proof=activity.proof;
let diagnostic;
const touch=()=>{status.lastUpdate=Date.now();status.lastActivityAt=status.lastUpdate;step.lastActivityAt=status.lastUpdate;void write('status.json',status).catch(()=>{});};
const stop=()=>{stopped=true;void child?.session.abort();};
const controls=setInterval(()=>{void readFile(join(intent.asyncDir,'control.json'),'utf8').then(text=>{const c=JSON.parse(text);if(c.version===1&&c.runId===intent.runId&&c.runnerProcessInstanceId===intent.runnerProcessInstanceId&&c.action==='stop')stop();}).catch(()=>{});},100);controls.unref();process.on('SIGTERM',stop);process.on('SIGINT',stop);
let error,output='',success=false;
try{
 await write('status.json',status);
 child=await openOwnedChild(intent,event=>{
  activity.observe(event);
  if(event.type==='owned_budget_exceeded'){error=event.error;}
  if(event.type==='owned_extension_error'){error=event.error;proof.invalid=true;}
  if(event.type==='agent_start'){step.lifecycle={phase:'running'};}
  if(event.type==='turn_start')step.turnCount++;
  if(event.type==='tool_execution_start'){
   step.toolCount++;step.currentTool=event.toolName;step.currentPath=typeof event.args?.path==='string'?event.args.path:undefined;step.lastToolAt=Date.now();step.lastTool=event.toolName;
  }
  if(event.type==='tool_execution_end'){if(event.isError)step.toolErrorCount=(step.toolErrorCount??0)+1;step.recentTools=[...step.recentTools,{tool:event.toolName,endMs:Date.now()}].slice(-5);delete step.currentTool;delete step.currentPath;}
  if(event.type==='message_end'&&event.message?.role==='assistant'){
   const message=event.message;
   if(message.stopReason==='error'&&typeof message.errorMessage==='string')diagnostic=message.errorMessage;
   for(const key of ['input','output','totalTokens','cacheRead','cacheWrite'])step.tokens[key]+=message.usage?.[key]??0;step.totalCost+=message.usage?.cost?.total??0;
  }
  touch();
 },requested);
 activity.admit(child);
 step.actualModelDefinition=child.actualModelDefinition;step.acknowledgedExtensions=[...child.acknowledged];step.sessionFile=child.session.sessionFile;
 // Requested model includes effective thinking; preserve identity for fallback receipts.
 const actualModel=`${child.session.model.provider}/${child.session.model.id}`;
 const suffix=/:((?:off|minimal|low|medium|high|xhigh|max))$/u.exec(step.requestedModel??'');
 step.thinking=child.session.thinkingLevel;
 if(suffix&&suffix[1]!==step.thinking)throw new Error('Effective child thinking differs from frozen model suffix.');
 step.model=actualModel+(suffix?`:${step.thinking}`:'');
 if(stopped)throw new Error('Child stopped before prompt.');
 await child.session.prompt(intent.params.task);await child.session.waitForIdle();
 promptSettled=true;activity.settle(child.session);
 const messages=child.session.messages;
 const assistant=messages.filter(m=>m.role==='assistant');
 const last=assistant.at(-1);
 output=(last?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
 error??=diagnostic;
 if(!last&&!error)error='Child input was handled without an assistant result.';
 success=!error&&!stopped&&!timedOut&&last?.stopReason==='stop';
 if(!success&&!error)error='Child did not produce a successful terminal assistant result.';
}catch(e){error=e instanceof Error?e.message:String(e);proof.invalid=true;}
finally{
 if(child){try{proof.shutdownComplete=await child.shutdown();}catch(e){error??=String(e);success=false;proof.invalid=true;}}
 clearInterval(controls);
 process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
}
activity.finish(child,{stopped,timedOut});
if(diagnostic){proof.diagnostic=diagnostic;proof.diagnosticSource='assistant_error';}
status.state=stopped?'stopped':success?'complete':'failed';status.error=error;step.error=error;status.endedAt=Date.now();status.lastUpdate=status.endedAt;step.state=status.state;step.status=status.state;step.lifecycle={phase:'settled'};step.durationMs=status.endedAt-startedAt;
const result={actualModelDefinition:step.actualModelDefinition,runId:intent.runId,agent:step.agent,requestedModel:step.requestedModel,model:step.model,thinking:step.thinking,launchContractDigest:digest,sessionFile:step.sessionFile,output,finalOutput:output,success,error,stopped,timedOut,tokens:step.tokens,totalCost:step.totalCost,turnCount:step.turnCount,toolCount:step.toolCount,durationMs:step.durationMs,preActivityEvidence:proof};
const completion={runId:intent.runId,asyncDir:intent.asyncDir,sessionId:intent.sessionId,state:status.state,success,results:[result],durationMs:step.durationMs};
await write('worker-proof.json',proof);await write('result.json',completion);await write('status.json',status);
process.exitCode=success?0:1;
