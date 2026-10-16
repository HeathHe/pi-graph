import {captureHostSdkIdentity} from './host-sdk.ts';
import {ownedContinuationAuthority} from "./session-continuation.ts";
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from '../v3/durable.ts';
import { canonicalDigest } from '../v3/digests.ts';
import { RPC_REQUEST, RPC_REPLY_PREFIX, RPC_READY, subagentAsyncRoot, type EventBus } from '../v3/rpc.ts';
import { NATIVE_COMPLETE_EVENT, readNativeJson } from '../v3/native-results.ts';
import { discoverAgents } from './agents.ts';
import { resolveSubagentLaunchContract } from './launch-contract.ts';

export const OWNED_RUNTIME_KIND = 'pi-graph-sdk/1';
const registryKey = Symbol.for('pi-graph.owned-runtime.v1');
interface Entry { child: ChildProcess; dir: string; instance: string; done: Promise<void> }
const entries: Map<string, Entry> = (globalThis as any)[registryKey] ??= new Map();
export const ownedPing = () => ({version:1,runtimeKind:OWNED_RUNTIME_KIND,methods:['spawn','status','stop','interrupt','checkpoint','resume'],capabilities:{asyncSpawn:true,status:true,stop:true,processTerminalProof:{version:1,lifecycleArtifactVersion:3},launchResolvedExtensions:{version:1},runtimeAcknowledgedExtensions:{version:1}},events:{asyncComplete:NATIVE_COMPLETE_EVENT}});

/** Owns only launch/control: SDK prompts live exclusively inside isolated children. */
export class GraphRuntimeController {
 private off?: () => void;
 private launches=new Map<string,{digest:string;promise:Promise<any>}>();
 private events:EventBus; private owner:()=>{sessionId:string;sessionFile?:string};private testFixture?: "success"|"quota"|"tool"|"pending"|"quota-then-success";
 constructor(events: EventBus, owner: () => {sessionId:string;sessionFile?:string}, testFixture?: "success"|"quota"|"tool"|"pending"|"quota-then-success") {
  this.events=events;this.owner=owner;this.testFixture=testFixture;
  if(testFixture && process.env.NODE_ENV!=="test")throw Error("Test runtime fixture requires NODE_ENV=test");
  const off=events.on(RPC_REQUEST, raw=>{void this.reply(raw as any)});if(typeof off==='function')this.off=off;
  events.emit(RPC_READY,ownedPing());
 }
 dispose(){this.off?.();this.off=undefined;/* Children survive host reload. */}
 private async reply(req:any){
  if(req?.version!==1||typeof req.requestId!=='string'||req.source?.extension!=='pi-graph')return;
  try{const data=await this.call(req.method,req.params,req.requestId);this.events.emit(RPC_REPLY_PREFIX+req.requestId,{version:1,requestId:req.requestId,success:true,data});}
  catch(error){this.events.emit(RPC_REPLY_PREFIX+req.requestId,{version:1,requestId:req.requestId,success:false,error:{code:'OWNED_RUNTIME_REJECTED',message:error instanceof Error?error.message:String(error)}});}
 }
 async call(method:string,params:any,requestId:string):Promise<any>{
  if(method==='ping')return ownedPing();
  if(method==='spawn'){
   const digest=canonicalDigest(params),old=this.launches.get(requestId);
   if(old){if(old.digest!==digest)throw Error('Existing launch intent is ambiguous; never replaying');return old.promise;}
   const promise=this.launch(params,requestId);this.launches.set(requestId,{digest,promise});
   try{return await promise;}finally{this.launches.delete(requestId);}
  }
  const id=params?.id??params?.runId??params?.asyncId;
  if(typeof id!=='string'||!/^[a-zA-Z0-9._-]+$/.test(id))throw Error('Invalid owned run id');
  const dir=join(subagentAsyncRoot(),id),intent=await readNativeJson(join(dir,'intent.json'));
  if(!intent||intent.runtimeKind!==OWNED_RUNTIME_KIND||intent.sessionId!==this.owner().sessionId)throw Error('Run is not owned by this session/runtime');
  if(method==='status')return await readNativeJson(join(dir,'status.json'));
  if(method==='checkpoint'){
   if(!intent.continuation)throw Error('Legacy run has no checkpoint protocol');
   await atomicWriteJson(join(dir,'control.json'),{version:1,runId:id,runnerProcessInstanceId:intent.runnerProcessInstanceId,action:params.park===true?'park_checkpoint':'checkpoint'});
   return {runId:id,state:'checkpoint_requested'};
  }
  if(method==='resume'){
   const state=await readNativeJson(join(dir,'generation-state.json'));
   if(!intent.continuation||state?.state!=='parked'||entries.has(id))throw Error('Only a clean parked generation can be adopted');
   const child=spawn(process.execPath,[fileURLToPath(new URL('./guardian.mjs',import.meta.url)),join(dir,'intent.json'),'--adopt'],{cwd:intent.params.cwd,stdio:'ignore',env:{...process.env,PI_GRAPH_CHILD:'1'}});
   const done=new Promise<void>(resolve=>child.once('close',async()=>{try{const result=await readNativeJson(join(dir,'result.json'));if(result)this.events.emit(NATIVE_COMPLETE_EVENT,result);}finally{entries.delete(id);resolve();}}));
   entries.set(id,{child,dir,instance:intent.runnerProcessInstanceId,done});return {runId:id,state:'adopting_checkpoint'};
  }
  if(method==='stop'||method==='interrupt'){
   await atomicWriteJson(join(dir,'control.json'),{version:1,runId:id,runnerProcessInstanceId:intent.runnerProcessInstanceId,action:'stop'});
   return {runId:id,state:'stop_requested'};
  }
  throw Error('Automatic resume/replay is disabled; create a new Graph for remaining work');
 }
 private async launch(params:any,requestId:string){
  const id='owned-'+createHash('sha256').update(requestId).digest('hex').slice(0,40),dir=join(subagentAsyncRoot(),id),digest=canonicalDigest(params);
  const existing=await readNativeJson(join(dir,'intent.json'));
  if(existing){if(existing.requestId!==requestId||existing.requestDigest!==digest||existing.sessionId!==this.owner().sessionId)throw Error('Existing launch intent is ambiguous; never replaying');return {details:{asyncId:id,asyncDir:dir,runtimeKind:OWNED_RUNTIME_KIND}};}
  const hostSdkIdentity=await captureHostSdkIdentity();
  await mkdir(subagentAsyncRoot(),{recursive:true});
  try{await mkdir(dir);}catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   const saved=await readNativeJson(join(dir,'intent.json'));
   if(!saved||saved.requestId!==requestId||saved.requestDigest!==digest||saved.sessionId!==this.owner().sessionId)throw Error('Existing launch intent is ambiguous; never replaying');
   return {details:{asyncId:id,asyncDir:dir,runtimeKind:OWNED_RUNTIME_KIND}};
  }
  const resolved=await resolveSubagentLaunchContract(params);
  if(!resolved.ok)throw Error(resolved.message);
  const agent=discoverAgents(params.cwd,params.agentScope??'both').agents.find((a:any)=>a.name===params.agent);
  if(!agent)throw Error('Frozen Agent unavailable');
  const instance=randomUUID(),owner=this.owner();
  const authority=ownedContinuationAuthority(params);
  let continuation:any;
  if(authority){
   const contracts=[];const first=authority.plan.candidates[authority.candidateIndex];
   if(!first||first.resolvedModel!==params.model||authority.plan.candidates.some((c:any)=>c.agentDefinitionDigest!==first.agentDefinitionDigest))throw Error('Frozen continuation admission mismatch');
   for(const c of authority.plan.candidates){
    const check=await resolveSubagentLaunchContract({...params,model:c.resolvedModel,thinking:c.thinking});
    if(!check.ok)throw Error('Frozen continuation candidate launch rejected: '+check.message);
    const strip=(v:any)=>{const {model,modelCandidates,thinking,launchContractDigest,digest,...rest}=v;return rest};
    if(canonicalDigest(strip(check.contract))!==canonicalDigest(strip(resolved.contract)))throw Error('Continuation candidate changes frozen tools or Agent');
    contracts.push(check.contract);
   }
   continuation={...authority,contracts};
  }
  const intent={hostSdkIdentity,version:1,runtimeKind:OWNED_RUNTIME_KIND,runId:id,asyncDir:dir,runnerProcessInstanceId:instance,sessionId:owner.sessionId,sessionFile:owner.sessionFile,requestId,requestDigest:digest,params,agent,launchContract:resolved.contract,...(continuation?{continuation}: {})};
  await atomicWriteJson(join(dir,'intent.json'),intent);
  await atomicWriteJson(join(dir,'status.json'),{version:3,runtimeKind:OWNED_RUNTIME_KIND,runId:id,sessionId:owner.sessionId,cwd:params.cwd,state:'queued',steps:[]});
  const childEnv={...process.env,PI_GRAPH_CHILD:'1',PI_GRAPH_EXTENSION_BINDINGS:JSON.stringify(params.extensionBindings??{})};
  for(const key of Object.keys(childEnv))if(key.startsWith('PI_SUBAGENT')||key.startsWith('GIT_')||key==='PI_GRAPH_TEST_FIXTURE')delete (childEnv as any)[key];
  const fixture=this.testFixture==='quota-then-success'?(continuation?'route-fallback':String(params.model).includes('kimi-coding/')?'quota':'success'):this.testFixture;
  const args=[fileURLToPath(new URL('./guardian.mjs',import.meta.url)),join(dir,'intent.json'),...(fixture?['--test-fixture',fixture]:[])];
  const child=spawn(process.execPath,args,{cwd:params.cwd,stdio:['ignore','ignore','pipe'],env:childEnv});
  // Keep stderr local and bounded; do not forward credentials/task payload to parent.
  let diagnostic='';child.stderr?.on('data',(b:Buffer)=>{if(diagnostic.length<8192)diagnostic+=b.toString().slice(0,8192-diagnostic.length)});
  const done=new Promise<void>(resolve=>{child.once('close',async(code,signal)=>{
   try{
    const result=await readNativeJson(join(dir,'result.json'));
    if(result){this.events.emit(NATIVE_COMPLETE_EVENT,result);}
   }finally{entries.delete(id);resolve();}
  });child.once('error',()=>{/* close is the exclusive physical exit gate. */});});
  entries.set(id,{child,dir,instance,done});
  return {details:{asyncId:id,asyncDir:dir,runtimeKind:OWNED_RUNTIME_KIND}};
 }
}
