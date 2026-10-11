import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { bindGraphSpecWithRoutingV3 } from "../extensions/routing-admission.ts";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { initializeV3Run } from "../src/v3/initialize.ts";
import { V3GraphRunner } from "../src/v3/runner.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { canonicalDigest } from "../src/v3/digests.ts";
import { nativeResultsDir } from "../src/v3/native-results.ts";
import { readV3AttemptEvidence, v3NodeAttemptDir } from "../src/v3/attempt.ts";
import { validateNativePreActivityProof, validateRuntimeFallbackPlan } from "../src/v3/runtime-fallback.ts";
import { classifyProviderFailure } from "../src/v3/failure-policy.ts";
import { MockSubagents, completeChild, type MockChildBehavior } from "./helpers/mock-subagents.ts";

const error = `403 {"error":{"type":"permission_error","message":"You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends."}}`;
const sha = "a".repeat(64);
function proof(binding: unknown) { return {version:1,runtimeKind:'pi-graph-sdk/1',factoryIdentity:'pi-graph-owned-session/1', subscribedBeforePrompt:true, agentStarted:true, toolsStarted:0, assistantToolCalls:0,
 orphanToolResult:false, lateActivity:false, diagnostic:error, invalid:false, officialInProcess:true, controlledEnvironment:true,
 promptSettled:true, shutdownComplete:true, queuedInput:false, stopped:false, timedOut:false, interrupted:false, forced:false,
 diagnosticSource:"assistant_error", launches:1, graphBinding:binding}; }
async function fixture(options: {budget?:number; image?:boolean; usageBudget?:any} = {}) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "graph-fallback-"))), source = join(root,"source");
 await mkdir(join(source,".pi/agents"),{recursive:true});
 await writeFile(join(source,".pi/agents/fallback-agent.md"),"---\nname: fallback-agent\ndescription: fixture\nmodel: kimi-coding/k3\nthinking: high\ntools: read\nextensions: \ninheritSkills: false\ninheritProjectContext: false\n---\nOnly the assigned task.\n");
 const agents=await import('../src/runtime/agents.ts'), launch=agents;
 const def=launch.agentDefinitionDigest(agents.discoverAgents(source,"both").agents.find((a:any)=>a.name==="fallback-agent")!);
 await writeFile(join(root,"routing-policy.json"),JSON.stringify({schemaVersion:1,enforcement:"graph-admission",quarantinedProviderDomains:[],profiles:{"browser-operation":{budget:{modelDegradations:options.budget ?? 1},candidates:[{model:"kimi-coding/k3",thinking:"high",level:"L0"},{model:"xai/grok-4.7",thinking:"high",level:"L1"}]}}}));
 await writeFile(join(root,"subagent-capabilities.json"),JSON.stringify({schemaVersion:1,capabilities:[{capabilityId:"operate.browser",agent:"fallback-agent",routingProfile:"browser-operation"}]}));
 const bound=await bindGraphSpecWithRoutingV3({schemaVersion:3,graphId:"fallback",goal:"fixture",nodes:[{taskId:"node",requires:["operate.browser"],task:"FALLBACK_TASK",sideEffect:"none",...(options.usageBudget ? {usageBudget:options.usageBudget} : {})}]},{agentDir:root,cwd:source,disableNetwork:true,
  availableModels:[{provider:"kimi-coding",id:"k3",input:["text","image"]},{provider:"xai",id:"grok-4.7",input:options.image === false ? ["text"] : ["text","image"]}],
  preflightAgent:async i=>({ok:true,name:i.agent,agentDefinitionDigest:def,launchContractDigest:sha,model:`${i.model}:high`,modelCandidates:[`${i.model}:high`],thinking:"high",extensions:{runtimeExtensions:[],configuredExtensions:[],extensionArgs:[],disableAmbientExtensions:true},toolAllowlist:["read"],explicitToolAllowlist:true})});
 const graph=compileGraphSpecV3(bound.spec), runDir=join(root,"runs/fallback/instance");
 await mkdir(join(root,"runs"),{recursive:true});
 const init=await initializeV3Run({trustedRoot:join(root,"runs"),runDir,graph,sessionId:"session",supervisorEpoch:"epoch",sourceCwd:source,runInstanceId:"instance"});
 const mock=new MockSubagents();mock.start();
 const runner=new V3GraphRunner({graph,runDir,rpc:new SubagentRpcClient(mock),authorization:init.authorization,sourceCwd:source,sessionId:"session",supervisorEpoch:"epoch",preflightAgent:async()=>{}});
 return {root,source,graph,runDir,init,mock,runner};
}
async function providerFailure(input: Parameters<MockChildBehavior>[0], change?: (p:any)=>void, changeResult?: (r:any)=>void) {
 const status=JSON.parse(await readFile(join(input.asyncDir,"status.json"),"utf8")), runner=`runner-${input.asyncId}`;
 const p:any={...proof((input.params.extensionBindings as any)["pi-graph/1"]),runId:input.asyncId,stepIndex:0,agent:"fallback-agent",launchContractDigest:sha};change?.(p);
 status.runtimeKind="pi-graph-sdk/1";status.runnerProcessInstanceId=runner;status.steps=[{toolCount:0}];status.state="failed";status.error=error;status.processTerminal={runnerProcessInstanceId:runner};
 await writeFile(join(input.asyncDir,"status.json"),JSON.stringify(status));
 await mkdir(nativeResultsDir(),{recursive:true});
 const result:any={agent:"fallback-agent",requestedModel:input.params.model,model:input.params.model,launchContractDigest:sha,toolCount:0,preActivityEvidence:p,error,output:"",success:false};changeResult?.(result);
 await writeFile(join(input.asyncDir,"result.json"),JSON.stringify({runId:input.asyncId,asyncDir:input.asyncDir,sessionId:status.sessionId,state:"failed",success:false,results:[result]}));
 await writeFile(join(input.asyncDir,"process-terminal.json"),JSON.stringify({version:1,runtimeKind:"pi-graph-sdk/1",state:"observed",runId:input.asyncId,runnerProcessInstanceId:runner,observedAt:Date.now(),instances:[{kind:"runner",processInstanceId:runner,closeObservedAt:Date.now(),exitCode:0,signal:null}]}));
}

test("runtime fallback: admitted quota failure dispatches the next frozen model exactly once, keeps static authorization", async()=>{
 const f=await fixture(), graphDigest=f.graph.graphDigest;
 f.mock.behaviors.set("FALLBACK_TASK", async i=>f.mock.spawned.length===1?providerFailure(i):completeChild({...i,output:"accepted"}));
 try {
  const out=await f.runner.run();assert.equal(out.status,"complete");
  assert.deepEqual(f.mock.spawned.map(s=>s.params.model),["kimi-coding/k3:high","xai/grok-4.7:high"]);
  const first=await readV3AttemptEvidence(f.runDir,"node",1),second=await readV3AttemptEvidence(f.runDir,"node",2);
  assert.equal(first?.fallbackContinuation?.failureKind,"quota");assert.equal(second?.routeSelection?.candidateIndex,1);
  assert.equal(first?.phase,"failed");assert.equal(second?.phase,"accepted");assert.equal(f.graph.graphDigest,graphDigest);
  assert.equal(f.init.authorization.graphDigest,graphDigest);assert.equal(new Set(f.mock.spawnRequestIds).size,2);
 } finally {await f.mock.dispose();}
});

test("quota diagnostic recognizes the Kimi five-hour 403 without classifying task output",()=>{
 assert.deepEqual(classifyProviderFailure(error),{eligible:true,kind:"quota"});
 assert.equal(classifyProviderFailure("user asked: "+error).eligible,false);
});

for (const [name, change] of [
 ["tool executed", (p:any)=>{p.toolsStarted=1;}], ["missing complete proof", (p:any)=>{delete p.subscribedBeforePrompt;}],
 ["assistant tool call", (p:any)=>{p.assistantToolCalls=1;}], ["isolated result",(p:any)=>{p.orphanToolResult=true;}],
 ["shutdown failed",(p:any)=>{p.shutdownComplete=false;}], ["unknown factory",(p:any)=>{p.officialInProcess=false;}],
 ["ambient extensions",(p:any)=>{p.controlledEnvironment=false;}], ["late activity",(p:any)=>{p.lateActivity=true;}],
 ["multiple native launches",(p:any)=>{p.launches=2;}], ["provider error absent",(p:any)=>{delete p.diagnostic;}],
 ["untrusted summary",(p:any)=>{p.diagnosticSource="output";}], ["cancelled",(p:any)=>{p.stopped=true;}],
 ["wrong step",(p:any)=>{p.stepIndex=1;}], ["wrong contract",(p:any)=>{p.graphBinding.contractDigest="b".repeat(64);}],
] as Array<[string,(p:any)=>void]>) {
 test(`runtime fallback refuses ${name}`, async()=>{
  const f=await fixture(); f.mock.behaviors.set("FALLBACK_TASK",i=>providerFailure(i,change));
  try {const out=await f.runner.run();assert.equal(out.status,"failed");assert.equal(f.mock.spawned.length,1);
   assert.equal((await readV3AttemptEvidence(f.runDir,"node",1))?.fallbackContinuation,undefined);
  } finally {await f.mock.dispose();}
 });
}
test("all frozen candidates fail: bounded two attempts, no looping or initial-model replay",async()=>{
 const f=await fixture();f.mock.behaviors.set("FALLBACK_TASK",i=>providerFailure(i));
 try {assert.equal((await f.runner.run()).status,"failed");assert.equal(f.mock.spawned.length,2);
  assert.equal((await readV3AttemptEvidence(f.runDir,"node",2))?.fallbackContinuation,undefined);
 } finally {await f.mock.dispose();}
});
test("operator stop before terminal confirmation suppresses automatic fallback",async()=>{
 const f=await fixture();f.mock.stopBehavior="ignore"; f.mock.behaviors.set("FALLBACK_TASK",async i=>{f.runner.requestStop();await providerFailure(i);});
 try {const out=await f.runner.run();assert.notEqual(out.status,"complete");assert.equal(f.mock.spawned.length,1);
  assert.equal((await readV3AttemptEvidence(f.runDir,"node",1))?.fallbackContinuation,undefined);
 } finally {await f.mock.dispose();}
});
test("pause after fallback preparation preserves same attempt and resumes one dispatch",async()=>{
 const f=await fixture();const {updateV3RunControl}=await import("../src/v3/control.ts");
 let ready!:()=>void;const paused=new Promise<void>(r=>ready=r);
 (f.runner as any).options.preflightAgent=async(i:any)=>{if(i.cwd.includes("node-2")) {await updateV3RunControl(f.runDir,"paused");ready();}};
 f.mock.behaviors.set("FALLBACK_TASK",async i=>f.mock.spawned.length===1?providerFailure(i):completeChild({...i,output:"accepted"}));
 const running=f.runner.run();
 try {await paused;assert.equal(f.mock.spawned.length,1);assert.equal((await readV3AttemptEvidence(f.runDir,"node",2))?.phase,"prepared");
  assert.equal((await running).status,"paused");
  await updateV3RunControl(f.runDir,"running");
  const restarted=new V3GraphRunner({...((f.runner as any).options),preflightAgent:async()=>{},rpc:new SubagentRpcClient(f.mock)});
  await restarted.initializeForResume();assert.equal((await restarted.run()).status,"complete");assert.equal(f.mock.spawned.length,2);
  assert.equal((await readV3AttemptEvidence(f.runDir,"node",2))?.phase,"accepted");
 } finally {await f.mock.dispose();}
});
for (const [name, options] of [["explicit zero model budget",{budget:0}],["no image capability for browser alternate",{image:false}]] as const) {
 test(`routing refuses runtime fallback: ${name}`,async()=>{
  const f=await fixture(options);f.mock.behaviors.set("FALLBACK_TASK",i=>providerFailure(i));
  try {assert.equal(f.graph.nodes[0]!.launch?.runtimeFallback,undefined);assert.equal((await f.runner.run()).status,"failed");assert.equal(f.mock.spawned.length,1);} finally {await f.mock.dispose();}
 });
}

test("crash after durable fallback continuation resumes the second model without replaying the failed one",async()=>{
 const f=await fixture();const {updateV3RunControl}=await import("../src/v3/control.ts");
 f.mock.behaviors.set("FALLBACK_TASK",async i=>{await updateV3RunControl(f.runDir,"paused");await providerFailure(i);});
 try {
  const first=await f.runner.run();assert.equal(first.status,"paused");assert.equal(f.mock.spawned.length,1);
  assert.ok((await readV3AttemptEvidence(f.runDir,"node",1))?.fallbackContinuation);
  await updateV3RunControl(f.runDir,"running");
  f.mock.behaviors.set("FALLBACK_TASK",i=>completeChild({...i,output:"accepted"}));
  const restarted=new V3GraphRunner({...((f.runner as any).options),rpc:new SubagentRpcClient(f.mock)});
  await restarted.initializeForResume();
  assert.equal((await restarted.run()).status,"complete");assert.equal(f.mock.spawned.length,2);
  assert.equal(f.mock.spawned[1]!.params.model,"xai/grok-4.7:high");
 } finally {await f.mock.dispose();}
});

test("configured usage budget with unavailable usage evidence forbids fallback",async()=>{
 const f=await fixture({usageBudget:{tokens:{hard:1000}}});f.mock.behaviors.set("FALLBACK_TASK",i=>providerFailure(i));
 try {assert.equal((await f.runner.run()).status,"failed");assert.equal(f.mock.spawned.length,1);assert.equal((await readV3AttemptEvidence(f.runDir,"node",1))?.fallbackContinuation,undefined);} finally {await f.mock.dispose();}
});

test("crash after a new fallback prepared record but before dispatch intent resumes that exact attempt once",async()=>{
 const f=await fixture();const {updateV3RunControl}=await import("../src/v3/control.ts");const {writeV3AttemptEvidence}=await import("../src/v3/attempt.ts");
 f.mock.behaviors.set("FALLBACK_TASK",async i=>{await updateV3RunControl(f.runDir,"paused");await providerFailure(i);});
 try {
  assert.equal((await f.runner.run()).status,"paused");const first=(await readV3AttemptEvidence(f.runDir,"node",1))!;
  assert.ok(first.fallbackContinuation);
  const now=new Date().toISOString();
  await writeV3AttemptEvidence(f.runDir,"node",2,{schemaVersion:1,runInstanceId:first.runInstanceId,graphId:first.graphId,taskId:first.taskId,
   attempt:2,attemptNonce:"crash-before-intent",phase:"prepared",createdAt:now,updatedAt:now,supervisorEpoch:first.supervisorEpoch,
   routeSelection:{candidateIndex:1,planDigest:first.fallbackContinuation.planDigest}});
  await updateV3RunControl(f.runDir,"running");f.mock.behaviors.set("FALLBACK_TASK",i=>completeChild({...i,output:"accepted"}));
  const restarted=new V3GraphRunner({...((f.runner as any).options),rpc:new SubagentRpcClient(f.mock)});
  await restarted.initializeForResume();assert.equal((await restarted.run()).status,"complete");assert.equal(f.mock.spawned.length,2);
  assert.equal((await readV3AttemptEvidence(f.runDir,"node",2))?.attemptNonce,"crash-before-intent");
  assert.equal((await readV3AttemptEvidence(f.runDir,"node",3)),undefined);
 } finally {await f.mock.dispose();}
});

test("compact progress renders one quota replacement line only while the alternate is active", async()=>{
 const {compactGraphLines}=await import("../src/v3/ui/presentation.ts");
 const snapshot:any={status:"running",nodes:{node:{phase:"running",attempt:2,modelFallback:{from:"kimi-coding/k3:high",to:"xai/grok-4.7:high",reason:"quota"}}}};
 const lines=compactGraphLines(snapshot);assert.equal(lines.filter(x=>x.includes("模型接替")).length,1);assert.match(lines.join("\n"),/额度用尽 → xai\/grok-4.7:high/);
 snapshot.nodes.node.phase="accepted";snapshot.status="complete";assert.equal(compactGraphLines(snapshot).some(x=>x.includes("模型接替")),false);
});

test("pause after spawn reply never parks before the durable child binding is saved",async()=>{
 const f=await fixture();const {updateV3RunControl}=await import("../src/v3/control.ts");
 const operation=(f.runner as any).withAttemptOperation.bind(f.runner);
 (f.runner as any).withAttemptOperation=async(e:any,stage:string,...rest:any[])=>{
  if(e.routeSelection?.candidateIndex===1 && stage==="dispatch binding persistence") await updateV3RunControl(f.runDir,"paused");
  return operation(e,stage,...rest);
 };
 f.mock.behaviors.set("FALLBACK_TASK",async i=>f.mock.spawned.length===1?providerFailure(i):completeChild({...i,output:"accepted"}));
 try {const out=await f.runner.run();assert.equal(out.status,"paused");assert.equal(f.mock.spawned.length,2);
  const second=await readV3AttemptEvidence(f.runDir,"node",2);assert.ok(second?.dispatch);assert.equal(second.phase,"accepted");
  await updateV3RunControl(f.runDir,"running");const restarted=new V3GraphRunner({...((f.runner as any).options),rpc:new SubagentRpcClient(f.mock)});
  await restarted.initializeForResume();assert.equal((await restarted.run()).status,"complete");assert.equal(f.mock.spawned.length,2);
 } finally {await f.mock.dispose();}
});

test("provider quota proof cannot hide model validation or tracked mutation failures",async()=>{
 for (const changeResult of [(r:any)=>{r.error="Model verification failed";},(r:any)=>{r.structuredOutputFailed=true;},(r:any)=>{r.effects={fileMutation:{observed:true}};},(r:any)=>{r.effects={settlementDiagnostic:{mutation:{attempted:true}}};},(r:any)=>{r.effects={settlementDiagnostic:{mutation:{observed:true}}};}]) {
  const f=await fixture();f.mock.behaviors.set("FALLBACK_TASK",i=>providerFailure(i,undefined,changeResult));
  try {assert.equal((await f.runner.run()).status,"failed");assert.equal(f.mock.spawned.length,1);assert.equal((await readV3AttemptEvidence(f.runDir,"node",1))?.fallbackContinuation,undefined);}finally{await f.mock.dispose();}
 }
});
