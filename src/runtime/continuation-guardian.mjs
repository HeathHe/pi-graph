import {spawn} from 'node:child_process';
import {mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{moduleCache:false});
const {canonicalDigest}=await jiti.import('../v3/digests.ts');
const {atomicWriteJson}=await jiti.import('../v3/durable.ts');
const {readNativeJson}=await jiti.import('../v3/native-results.ts');
const {validateCheckpoint}=await jiti.import('./session-checkpoint.ts');
const {continuationControl,validateContinuationResult}=await jiti.import('./session-continuation.ts');
export async function guardContinuation(original,args){
 const dir=original.asyncDir,lock=join(dir,'generation-owner.lock');
 // Never steal a stale lock on PID disappearance: missing close proof is unknown effect.
 await mkdir(lock,{mode:0o700});
 let intent={...original,generation:0,workerInstanceId:randomUUID()};let rejected=false;let finalOutcome={exitCode:1,signal:null},pid;
 try{
  if(args.includes('--adopt')){
   const parked=await readNativeJson(join(dir,'generation-state.json'));
   if(parked?.state!=='parked')throw Error('Only an explicitly parked clean checkpoint may be adopted');
   const previous=await readNativeJson(join(dir,`generation-${parked.generation}.json`));
   const cp=await readNativeJson(join(dir,`checkpoint-${parked.generation}.json`));
   const exit=await readNativeJson(join(dir,`exit-${parked.generation}.json`));pid=exit?.pid;finalOutcome={exitCode:exit?.exitCode,signal:exit?.signal};
   await validateCheckpoint(previous,cp,exit);
   intent={...original,generation:previous.generation+1,workerInstanceId:randomUUID(),resumeCheckpoint:cp};
  }
  for(;;){
   // A stopped handoff publishes retained usage against the already observed old close.
   if(intent.resumeCheckpoint&&await continuationControl(original)==='stopped'){
    const cp=intent.resumeCheckpoint,status=await readNativeJson(join(dir,'status.json'));const ledger=structuredClone(cp.continuationEvidence);ledger.final=true;ledger.digest=canonicalDigest({...ledger,digest:undefined});
    const step=status.steps[0];Object.assign(step,cp.usage,{state:'stopped',stopped:true,success:false,error:'Graph stopped at checkpoint boundary',continuationEvidence:ledger});
    status.state='stopped';status.endedAt=Date.now();await atomicWriteJson(join(dir,'result.json'),{runId:original.runId,asyncDir:dir,sessionId:original.sessionId,state:'stopped',success:false,results:[{...step,runId:original.runId,output:'',finalOutput:''}]});
    await atomicWriteJson(join(dir,'status.json'),status);await atomicWriteJson(join(dir,'generation-state.json'),{version:1,state:'sealed',generation:intent.generation-1,ledgerDigest:ledger.digest});break;
   }
   await atomicWriteJson(join(dir,`generation-${intent.generation}.json`),intent);
   await atomicWriteJson(join(dir,'generation-state.json'),{version:1,state:'running',generation:intent.generation,workerInstanceId:intent.workerInstanceId});
   const child=spawn(process.execPath,[fileURLToPath(new URL('./child-runner.mjs',import.meta.url)),join(dir,`generation-${intent.generation}.json`),...args.filter(x=>x!=='--adopt')],{cwd:intent.params.cwd,stdio:['ignore','ignore','ignore'],env:process.env});
   let started=false;
   const ready=new Promise(resolve=>{child.once('spawn',()=>{started=true;pid=child.pid;resolve(true);});child.once('error',()=>resolve(false));});
   const closed=new Promise(resolve=>{child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));child.once('error',()=>{});});
   await ready;if(started)await atomicWriteJson(join(dir,'generation-state.json'),{version:1,state:'running',generation:intent.generation,workerInstanceId:intent.workerInstanceId,workerPid:pid});
   const outcome=await closed;finalOutcome=outcome;
   const cp=await readNativeJson(join(dir,'checkpoint.json'));
   const exit={version:1,runId:intent.runId,generation:intent.generation,workerInstanceId:intent.workerInstanceId,...outcome,observedAt:Date.now(),...(started?{pid}:{}),checkpointDigest:cp?.digest};
   await atomicWriteJson(join(dir,`exit-${intent.generation}.json`),exit);
   if(!started||outcome.signal!==null||![0,1].includes(outcome.exitCode))throw Error('Worker crash or signal: checkpoint continuation refused; needs_attention');
   const result=await readNativeJson(join(dir,'result.json'));if(result){validateContinuationResult(original,result.results?.[0]);await atomicWriteJson(join(dir,'generation-state.json'),{version:1,state:'sealed',generation:intent.generation,ledgerDigest:result.results[0].continuationEvidence.digest});break;}
   await validateCheckpoint(intent,cp,exit);
   await atomicWriteJson(join(dir,`checkpoint-${intent.generation}.json`),cp);
   const control=await readNativeJson(join(dir,'control.json'));
   if(control?.action==='park_checkpoint'&&control.runId===intent.runId&&control.runnerProcessInstanceId===intent.runnerProcessInstanceId){
    await atomicWriteJson(join(dir,'generation-state.json'),{version:1,state:'parked',generation:intent.generation,checkpointDigest:cp.digest});await rm(lock,{recursive:true});return {parked:true};
   }
   await atomicWriteJson(join(dir,'generation-state.json'),{version:1,state:'handoff',generation:intent.generation,checkpointDigest:cp.digest});
   intent={...original,generation:intent.generation+1,workerInstanceId:randomUUID(),resumeCheckpoint:cp};
  }
 }catch(e){
  rejected=true;
  const status=await readNativeJson(join(dir,'status.json'))??{};
  status.state='failed';status.error=String(e);status.needsAttention=true;status.steps??=[];
  await atomicWriteJson(join(dir,'status.json'),status);
  await atomicWriteJson(join(dir,'generation-state.json'),{version:1,state:'needs_attention',generation:intent.generation,error:String(e)});
 }
 const seal=await readNativeJson(join(dir,'generation-state.json'));const terminal={runnerProcessInstanceId:original.runnerProcessInstanceId,generation:seal?.generation,ledgerDigest:seal?.ledgerDigest};
 const at=Date.now();if(pid){await atomicWriteJson(join(dir,'process-terminal.json'),{version:1,runtimeKind:'pi-graph-sdk/1',state:'observed',runId:original.runId,runnerProcessInstanceId:original.runnerProcessInstanceId,observedAt:at,...terminal,instances:[{kind:'runner',processInstanceId:original.runnerProcessInstanceId,pid,closeObservedAt:at,...finalOutcome}]});}
 const status=await readNativeJson(join(dir,'status.json'))??{};status.processTerminal=terminal;await atomicWriteJson(join(dir,'status.json'),status);
 await rm(lock,{recursive:true});return rejected?{...finalOutcome,exitCode:1}:finalOutcome;
}
