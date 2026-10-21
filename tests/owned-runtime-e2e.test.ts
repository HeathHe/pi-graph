import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,readdir}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import {GraphRuntimeController}from'../src/runtime/controller.ts';import{SubagentRpcClient}from'../src/v3/rpc.ts';import{waitForNativeAsyncRun}from'../src/v3/native-monitor.ts';import{confirmedProcessExit}from'../src/v3/supervision.ts';
class Bus{private listeners=new Map<string,Set<(x:unknown)=>void>>();on(key:string,fn:(x:unknown)=>void){const s=this.listeners.get(key)??new Set();s.add(fn);this.listeners.set(key,s);return()=>{s.delete(fn)}}emit(key:string,v:unknown){for(const fn of this.listeners.get(key)??[])fn(v)}}
async function fixture(scenario:'success'|'quota'|'tool'|'pending'='success'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'graph-owned-e2e-'))),cwd=join(root,'work');await mkdir(join(cwd,'.pi/agents'),{recursive:true});await writeFile(join(cwd,'.pi/agents/owned-e2e-agent.md'),'---\nname: owned-e2e-agent\ntools: read\nmodel: anthropic/claude-sonnet-4-5\ninheritSkills: false\ninheritProjectContext: false\n---\nOnly fixture work.\n');await writeFile(join(cwd,'fixture.txt'),'test');
 const env=process.env.NODE_ENV,oldAgent=process.env.PI_CODING_AGENT_DIR,oldRuntime=process.env.PI_GRAPH_RUNTIME_ROOT;process.env.PI_GRAPH_RUNTIME_ROOT=join(root,'runtime');process.env.NODE_ENV='test';process.env.PI_CODING_AGENT_DIR=join(root,'agent');await mkdir(join(root,'agent'));await writeFile(join(root,'agent/settings.json'),'{}');const bus=new Bus(),controller=new GraphRuntimeController(bus,()=>({sessionId:'owner'}),scenario),rpc=new SubagentRpcClient(bus);const params={agent:'owned-e2e-agent',cwd,task:'Return fixture',sessionDir:join(root,'session')};
 return{root,cwd,bus,controller,rpc,params,async close(){controller.dispose();if(oldRuntime===undefined)delete process.env.PI_GRAPH_RUNTIME_ROOT;else process.env.PI_GRAPH_RUNTIME_ROOT=oldRuntime;if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;if(oldAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldAgent;// A physical worker proof can precede the guardian's final status write.
 const dirs=await readdir(join(root,'runtime','async-subagent-runs')).catch(()=>[]);
 for(const name of dirs){const dir=join(root,'runtime','async-subagent-runs',name);let intent:any;try{intent=JSON.parse(await readFile(join(dir,'intent.json'),'utf8'));}catch{continue;}
  const deadline=Date.now()+3000;
  while(true){let status:any;try{status=JSON.parse(await readFile(join(dir,'status.json'),'utf8'));}catch{}
   if(status?.runId===intent.runId&&status.processTerminal?.runnerProcessInstanceId===intent.runnerProcessInstanceId)break;
   if(Date.now()>=deadline)throw new Error('Fixture guardian did not finish its matching final status publication');
   await new Promise(r=>setTimeout(r,10));
  }
 }
 await rm(root,{recursive:true,force:true})}};
}
test('owned broker launches actual isolated SDK, waits for physical close, returns output and usage',async()=>{
 const f=await fixture();try{await f.rpc.requireNativeRuntime();const id=await f.rpc.spawn(f.params,'e2e-first');const r=await waitForNativeAsyncRun({...id,events:f.bus,probeIntervalMs:20});assert.equal(r.state,'complete');assert.equal(r.output,'Owned fixture response');assert.equal(r.observation.usage?.totalTokens,5);assert.equal(r.observation.supervision?.processExitConfirmed,true);assert.equal(r.observation.progress?.toolCount,0);const proof=JSON.parse(await readFile(join(id.asyncDir,'process-terminal.json'),'utf8'));assert.equal(proof.runtimeKind,'pi-graph-sdk/1');assert.equal(confirmedProcessExit(proof,id.asyncId),true);assert.ok(proof.instances[0].pid);assert.notEqual(proof.instances[0].pid,process.pid);}finally{await f.close()}
});
test('stable launch idempotency returns same actual worker; changed intent and foreign owner rejected',async()=>{
 const f=await fixture();try{const [a,b]=await Promise.all([f.rpc.spawn(f.params,'e2e-stable'),f.rpc.spawn(f.params,'e2e-stable')]);assert.deepEqual(a,b);await assert.rejects(f.rpc.spawn({...f.params,task:'different'},'e2e-stable'),/ambiguous/);await waitForNativeAsyncRun({...a,events:f.bus,probeIntervalMs:20});f.controller.dispose();const other=new GraphRuntimeController(f.bus,()=>({sessionId:'foreign'}));await assert.rejects(f.rpc.call('status',{id:a.asyncId}),/not owned/);other.dispose();}finally{await f.close()}
});
test('actual worker tool calls survive own status/result receipt',async()=>{const f=await fixture('tool');try{const a=await f.rpc.spawn(f.params,'e2e-tool');const r=await waitForNativeAsyncRun({...a,events:f.bus,probeIntervalMs:20});assert.equal(r.state,'complete');assert.equal(r.observation.progress?.toolCount,1);assert.equal(r.observation.progress?.lastTool,'read');const result=JSON.parse(await readFile(join(a.asyncDir,'result.json'),'utf8'));assert.equal(result.results[0].preActivityEvidence.toolsStarted,1);}finally{await f.close()}});
test('legacy native run cannot be resumed/stopped as owned identity',async()=>{const f=await fixture();try{await assert.rejects(f.rpc.call('resume',{id:'legacy-native-id'}),/not owned/);await assert.rejects(f.rpc.call('stop',{id:'legacy-native-id'}),/not owned/);}finally{await f.close()}});

test('saved independent role models freeze and execute quota fallback through real SDK children',async()=>{
 const f=await fixture();const {writeGraphModelSettings}=await import('../src/runtime/settings.ts');const {bindGraphSpecWithRoutingV3}=await import('../extensions/routing-admission.ts');const {compileGraphSpecV3}=await import('../src/v3/compiler.ts');const {initializeV3Run}=await import('../src/v3/initialize.ts');const {V3GraphRunner}=await import('../src/v3/runner.ts');const {freezeV3GraphAgents}=await import('../src/v3/workspace.ts');const {readV3AttemptEvidence}=await import('../src/v3/attempt.ts');
 try{
  writeGraphModelSettings({cwd:f.cwd,scope:'project',role:'owned-e2e-agent',value:{model:'kimi-coding/k3',fallbackModels:['xai/grok-4.7'],thinking:'high'}});
  const bound=await bindGraphSpecWithRoutingV3({schemaVersion:3,graphId:'owned-fallback',goal:'Fixture own fallback',nodes:[{taskId:'one',agent:'owned-e2e-agent',task:'Return fixture',sideEffect:'none'}]},{cwd:f.cwd,agentDir:join(f.root,'agent'),disableNetwork:true,availableModels:[{provider:'kimi-coding',id:'k3',input:['text']},{provider:'xai',id:'grok-4.7',input:['text']}]});
  assert.equal(bound.spec.nodes[0].launch?.requestedModel,'kimi-coding/k3');assert.equal(bound.spec.nodes[0].launch?.runtimeFallback?.candidates.length,2);
  const graph=compileGraphSpecV3(bound.spec),runDir=join(f.root,'graph');const init=await initializeV3Run({trustedRoot:f.root,runDir,graph,sessionId:'owner',supervisorEpoch:'test',sourceCwd:f.cwd});await freezeV3GraphAgents(runDir,f.cwd,graph.nodes);
  f.controller.dispose();const controller=new GraphRuntimeController(f.bus,()=>({sessionId:'owner'}),'quota-then-success');
  const runner=new V3GraphRunner({rpc:f.rpc,runDir,graph,authorization:init.authorization,sourceCwd:f.cwd,sessionId:'owner',supervisorEpoch:'test'});
  try{const result=await runner.run();assert.equal(result.status,'complete',JSON.stringify(result.nodes));const first=await readV3AttemptEvidence(runDir,'one',1),second=await readV3AttemptEvidence(runDir,'one',2);assert.equal(first?.phase,'accepted');assert.equal(second,undefined);assert.equal(first?.child?.observation?.actualModel,'xai/grok-4.7');assert.equal(first?.child?.observation?.usage?.totalTokens,10);assert.equal(first?.child?.observation?.usageSegments?.length,2);const {continuationProducerConstraints}=await import('../src/v3/runtime-fallback.ts');const {assertContinuationCandidate}=await import('../src/runtime/session-continuation.ts');const plan={...graph.nodes[0].launch!.runtimeFallback!,requireCrossFamilyFromProducers:true};const constraints=await continuationProducerConstraints(runDir,{...graph.nodes[0],dependsOn:['one'],launch:{...graph.nodes[0].launch!,runtimeFallback:plan}});assert.equal(constraints.dependencies[0]?.actualModel,'xai/grok-4.7');const source={continuation:{plan,producerConstraints:constraints}};assert.doesNotThrow(()=>assertContinuationCandidate(source,0));assert.throws(()=>assertContinuationCandidate(source,1),/producer family/);}finally{controller.dispose()}
 }finally{await f.close()}
});

test('controller reload preserves same identity without replay; durable completion recovers after notifier disposal',async()=>{
 const f=await fixture();try{const first=await f.rpc.spawn(f.params,'reload-same');f.controller.dispose();const next=new GraphRuntimeController(f.bus,()=>({sessionId:'owner'}),'success');const again=await f.rpc.spawn(f.params,'reload-same');assert.deepEqual(first,again);next.dispose();const result=await waitForNativeAsyncRun({...first,events:f.bus,probeIntervalMs:20});assert.equal(result.state,'complete');const intent=JSON.parse(await readFile(join(first.asyncDir,'intent.json'),'utf8'));const proof=JSON.parse(await readFile(join(first.asyncDir,'process-terminal.json'),'utf8'));assert.equal(proof.runnerProcessInstanceId,intent.runnerProcessInstanceId);}finally{await f.close()}
});

test('independent guardian persists real child close after cold host process exits',async()=>{
 const f=await fixture();try{
  const {spawn}=await import('node:child_process');const moduleUrl=new URL('../src/runtime/controller.ts',import.meta.url).href;
  const code=`process.argv[1]=${JSON.stringify(process.argv[1])};import {GraphRuntimeController}from ${JSON.stringify(moduleUrl)};const bus={on(){return()=>{}},emit(){}};const c=new GraphRuntimeController(bus,()=>({sessionId:'owner'}),'success');const result=await c.call('spawn',${JSON.stringify(f.params)},'cold-host');process.stdout.write(JSON.stringify(result.details));process.exit(0);`;
  const parent=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{env:process.env,stdio:['ignore','pipe','pipe']});let output='',error='';parent.stdout.on('data',b=>output+=b);parent.stderr.on('data',b=>error+=b);assert.equal(await new Promise(r=>parent.once('close',r)),0,error);const id=JSON.parse(output);
  const r=await waitForNativeAsyncRun({...id,events:f.bus,probeIntervalMs:20});assert.equal(r.state,'complete');const proof=JSON.parse(await readFile(join(id.asyncDir,'process-terminal.json'),'utf8'));assert.equal(confirmedProcessExit(proof,id.asyncId),true);assert.notEqual(proof.instances[0].pid,parent.pid);
  const again=await f.rpc.spawn(f.params,'cold-host');assert.equal(again.asyncId,id.asyncId);assert.equal(again.asyncDir,id.asyncDir);
 }finally{await f.close()}
});

test('caller SDK params and environment cannot replace the trusted parent capture',async()=>{
 const f=await fixture();const previous=process.env.PI_GRAPH_HOST_SDK_ROOT;process.env.PI_GRAPH_HOST_SDK_ROOT='/invalid/task-selected-sdk';
 try{const a=await f.rpc.spawn({...f.params,hostSdkRoot:'/invalid/task-selected-sdk',hostSdkIdentity:{root:'/invalid/task-selected-sdk'}},'untrusted-sdk');const r=await waitForNativeAsyncRun({...a,events:f.bus,probeIntervalMs:20});assert.equal(r.state,'complete');const intent=JSON.parse(await readFile(join(a.asyncDir,'intent.json'),'utf8'));assert.notEqual(intent.hostSdkIdentity.root,'/invalid/task-selected-sdk');assert.ok(intent.hostSdkIdentity.packageVersion);}
 finally{if(previous===undefined)delete process.env.PI_GRAPH_HOST_SDK_ROOT;else process.env.PI_GRAPH_HOST_SDK_ROOT=previous;await f.close();}
});
test('failed host capture leaves no run directory and a repeated request does not become ambiguous',async()=>{
 const f=await fixture(),argv=process.argv[1],execPath=process.execPath;try{
  process.argv[1]=join(f.root,'missing-host-cli');process.execPath=join(f.root,'missing-node');
  for(let n=0;n<2;n++)await assert.rejects(f.rpc.spawn(f.params,'host-missing'),/Cannot locate host Pi SDK/);
  assert.deepEqual(await readdir(join(f.root,'runtime/async-subagent-runs')).catch(()=>[]),[]);
 }finally{process.argv[1]=argv;process.execPath=execPath;await f.close();}
});
