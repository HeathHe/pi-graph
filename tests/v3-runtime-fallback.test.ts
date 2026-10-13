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
async function fixture(options: {budget?:number; image?:boolean; usageBudget?:any; exactRole?:boolean; primary?:string; explicitModel?:string; explicitThinking?:string; catalogProfiles?:string[]; omitCatalog?:boolean; invalidCatalog?:boolean; roleOverride?:any; quarantine?:string[]; fallbackTools?:string[]; fallbackAgent?:string; profileConstraints?:any; parentModel?:any; parentThinking?:string; mixed?:boolean; settingsPeer?:boolean; actualPreflight?:boolean} = {}) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "graph-fallback-"))), source = join(root,"source");
 await mkdir(join(source,".pi/agents"),{recursive:true});
 await writeFile(join(source,".pi/agents/fallback-agent.md"),"---\nname: fallback-agent\ndescription: fixture\nmodel: kimi-coding/k3\nthinking: high\ntools: read\nextensions: \ninheritSkills: false\ninheritProjectContext: false\n---\nOnly the assigned task.\n".replace("model: kimi-coding/k3",`model: ${options.primary??(options.exactRole?"wisdomrouter/glm-5.3":"kimi-coding/k3")}`));
 if(options.settingsPeer){const definition=await readFile(join(source,".pi/agents/fallback-agent.md"),"utf8");await writeFile(join(source,".pi/agents/settings-agent.md"),definition.replace("name: fallback-agent","name: settings-agent"));}
 const agents=await import('../src/runtime/agents.ts'), launch=agents;
 const def=launch.agentDefinitionDigest(agents.discoverAgents(source,"both").agents.find((a:any)=>a.name==="fallback-agent")!);
 await writeFile(join(root,"routing-policy.json"),JSON.stringify({schemaVersion:1,enforcement:"graph-admission",quarantinedProviderDomains:options.quarantine??[],profiles:{"browser-operation":{...(options.profileConstraints?{constraints:options.profileConstraints}:{}),budget:{modelDegradations:options.budget ?? 1},candidates:options.exactRole?[{model:"wisdomrouter/glm-5.3",thinking:"high",level:"L0"},{model:"kimi-coding/k3",thinking:"high",level:"L1"}]:[{model:"kimi-coding/k3",thinking:"high",level:"L0"},{model:"xai/grok-4.7",thinking:"high",level:"L1"}]}}}));
 if(!options.omitCatalog)await writeFile(join(root,"subagent-capabilities.json"),JSON.stringify(options.invalidCatalog?{schemaVersion:999}:{schemaVersion:1,capabilities:(options.catalogProfiles??["browser-operation"]).map((routingProfile,index)=>({capabilityId:index===0?"operate.browser":`operate.browser.${index}`,agent:"fallback-agent",routingProfile}))}));
 if(options.roleOverride||options.settingsPeer)await writeFile(join(root,"graph-models.json"),JSON.stringify({version:1,profiles:{},models:{},roles:{...(options.roleOverride?{"fallback-agent":options.roleOverride}:{}),...(options.settingsPeer?{"settings-agent":{model:"wisdomrouter/glm-5.3",fallbackModels:[],thinking:"high"}}:{})}}));
 const bound=await bindGraphSpecWithRoutingV3({schemaVersion:3,graphId:"fallback",goal:"fixture",nodes:[{taskId:"node",...(options.exactRole?{agent:"fallback-agent",...(options.explicitModel?{model:options.explicitModel}:{}),...(options.explicitThinking?{thinking:options.explicitThinking}:{})}:{requires:["operate.browser"]}),task:"FALLBACK_TASK",sideEffect:"none",...(options.usageBudget ? {usageBudget:options.usageBudget} : {})},...(options.settingsPeer?[{taskId:"settings",agent:"settings-agent",task:"SETTINGS_TASK",sideEffect:"none" as const}]:[]),...(options.mixed?[{taskId:"cap",requires:["operate.browser"],task:"CAP_TASK",sideEffect:"none" as const}]:[])]},{agentDir:root,cwd:source,disableNetwork:true,...(options.parentModel?{parentModel:options.parentModel,parentThinking:options.parentThinking}:{}),
  availableModels:[{provider:"wisdomrouter",id:"glm-5.3",reasoning:true,input:["text","image"]},{provider:"kimi-coding",id:"k3",reasoning:true,input:options.image===false&&options.exactRole?["text"]:["text","image"]},{provider:"xai",id:"grok-4.7",reasoning:true,input:options.image === false ? ["text"] : ["text","image"]}],
  ...(options.actualPreflight?{}:{preflightAgent:async i=>({ok:true,name:options.exactRole&&i.model==="kimi-coding/k3"&&options.fallbackAgent?options.fallbackAgent:i.agent,agentDefinitionDigest:def,launchContractDigest:sha,model:`${i.model??options.primary??(options.exactRole?"wisdomrouter/glm-5.3":"kimi-coding/k3")}:${i.thinking??"high"}`,modelCandidates:[`${i.model}:high`],thinking:typeof i.thinking==="string"?i.thinking:"high",extensions:{runtimeExtensions:[],configuredExtensions:[],extensionArgs:[],disableAmbientExtensions:true},toolAllowlist:options.exactRole&&i.model==="kimi-coding/k3"&&options.fallbackTools?options.fallbackTools:["read"],explicitToolAllowlist:true})})});
 const graph=compileGraphSpecV3(bound.spec), runDir=join(root,"runs/fallback/instance");
 await mkdir(join(root,"runs"),{recursive:true});
 const init=await initializeV3Run({trustedRoot:join(root,"runs"),runDir,graph,sessionId:"session",supervisorEpoch:"epoch",sourceCwd:source,runInstanceId:"instance"});
 const mock=new MockSubagents();mock.start();
 const runner=new V3GraphRunner({graph,runDir,rpc:new SubagentRpcClient(mock),authorization:init.authorization,sourceCwd:source,sessionId:"session",supervisorEpoch:"epoch",preflightAgent:async()=>{}});
 return {root,source,graph,runDir,init,mock,runner,bound};
}
async function providerFailure(input: Parameters<MockChildBehavior>[0], change?: (p:any)=>void, changeResult?: (r:any)=>void) {
 const status=JSON.parse(await readFile(join(input.asyncDir,"status.json"),"utf8")), runner=`runner-${input.asyncId}`;
 const p:any={...proof((input.params.extensionBindings as any)["pi-graph/1"]),runId:input.asyncId,stepIndex:0,agent:"fallback-agent",launchContractDigest:sha};change?.(p);
 const diagnostic=typeof p.diagnostic === "string" ? p.diagnostic : error;
 status.runtimeKind="pi-graph-sdk/1";status.runnerProcessInstanceId=runner;status.steps=[{toolCount:0}];status.state="failed";status.error=diagnostic;status.processTerminal={runnerProcessInstanceId:runner};
 await writeFile(join(input.asyncDir,"status.json"),JSON.stringify(status));
 await mkdir(nativeResultsDir(),{recursive:true});
 const result:any={agent:"fallback-agent",requestedModel:input.params.model,model:input.params.model,launchContractDigest:sha,toolCount:0,preActivityEvidence:p,error:diagnostic,output:"",success:false};changeResult?.(result);
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

const weeklyError = `403 {"error":{"type":"permission_error","message":"You've reached your weekly (7-day) usage limit."}}`;
const refreshNetworkError = "OAuth refresh failed for xai: fetch failed";
const subscriptionError = '400 {"error":{"code":"InvalidSubscription","message":"CodingPlan subscription invalid"}}';
for (const [diagnostic,kind] of [[weeklyError,"quota"],[refreshNetworkError,"provider"],[subscriptionError,"auth"]]) {
 test(`authoritative provider diagnostic classifies ${kind} and frozen zero-activity proof permits one alternate: ${diagnostic}`,async()=>{
  assert.deepEqual(classifyProviderFailure(diagnostic!),{eligible:true,kind});
  const f=await fixture();f.mock.behaviors.set("FALLBACK_TASK",i=>f.mock.spawned.length===1?providerFailure(i,p=>{p.diagnostic=diagnostic;}):completeChild({...i,output:"accepted"}));
  try {assert.equal((await f.runner.run()).status,"complete");assert.equal(f.mock.spawned.length,2);assert.equal((await readV3AttemptEvidence(f.runDir,"node",1))?.fallbackContinuation?.failureKind,kind);}
  finally {await f.mock.dispose();}
 });
}
for (const diagnostic of ["HTTP 403 Forbidden","403 WAF access denied","parse 429 in file","task text: "+weeklyError,"tool error: "+refreshNetworkError,"aborted "+weeklyError,"terminated","request timeout","CodingPlan documentation", "OAuth refresh failed for xai: unknown error"]) {
 test(`non-provider diagnostic cannot authorize fallback: ${diagnostic}`,()=>assert.equal(classifyProviderFailure(diagnostic).eligible,false));
}
for (const [name,change,changeResult] of [
 ["45 tools",(p:any)=>{p.toolsStarted=45;},(r:any)=>{r.toolCount=45;}],
 ["forced",(p:any)=>{p.forced=true;},undefined],
 ["timed out",(p:any)=>{p.timedOut=true;},undefined],
 ["partial result",undefined,(r:any)=>{r.outputPartial=true;}],
 ["file mutation evidence",undefined,(r:any)=>{r.effects={fileMutation:true};}],
] as Array<[string,((p:any)=>void)|undefined,((r:any)=>void)|undefined]>) {
 test(`weekly quota cannot replay ${name}`,async()=>{
  const f=await fixture();f.mock.behaviors.set("FALLBACK_TASK",i=>providerFailure(i,p=>{p.diagnostic=weeklyError;change?.(p);},changeResult));
  try {assert.equal((await f.runner.run()).status,"failed");assert.equal(f.mock.spawned.length,1);assert.equal((await readV3AttemptEvidence(f.runDir,"node",1))?.fallbackContinuation,undefined);}finally{await f.mock.dispose();}
 });
}

test("exact role infers unique existing profile, preserves default GLM and freezes official Kimi without inventing capabilities",async()=>{
 const f=await fixture({exactRole:true});
 try {
  const node=f.graph.nodes[0]!;assert.equal(node.launch?.requestedModel,"wisdomrouter/glm-5.3");
  assert.deepEqual(node.launch?.runtimeFallback?.candidates.map(c=>c.requestedModel),["wisdomrouter/glm-5.3","kimi-coding/k3"]);
  assert.equal(node.binding?.catalogDigest,undefined,"exact authoring must not become a capability grant");
  assert.equal(f.bound.routingAdmission.catalogDigest,undefined);assert.match(f.bound.routingAdmission.inferredCatalogDigest!,/^[a-f0-9]{64}$/);assert.equal(f.bound.routingAdmission.decisions[0]?.inferredFromExactRole,true);assert.deepEqual(f.bound.routingAdmission.decisions[0]?.capabilityIds,[]);
  f.mock.behaviors.set("FALLBACK_TASK",i=>f.mock.spawned.length===1?providerFailure(i,p=>{p.diagnostic=subscriptionError;}):completeChild({...i,output:"accepted"}));
  assert.equal((await f.runner.run()).status,"complete");assert.deepEqual(f.mock.spawned.map(s=>s.params.model),["wisdomrouter/glm-5.3:high","kimi-coding/k3:high"]);
 }finally{await f.mock.dispose();}
});
for(const [name,options] of [
 ["explicit Kimi never returns backwards to GLM",{explicitModel:"kimi-coding/k3"}],
 ["ambiguous catalog profile",{catalogProfiles:["browser-operation","other-profile"]}],
 ["missing catalog",{omitCatalog:true}],
 ["invalid optional catalog",{invalidCatalog:true}],
 ["primary outside profile",{primary:"xai/grok-4.7"}],
 ["explicit thinking conflict",{explicitThinking:"low"}],
 ["zero budget",{budget:0}],
 ["quarantined alternate",{quarantine:["kimi-coding"]}],
 ["alternate image capability missing",{image:false}],
 ["alternate tool permissions differ",{fallbackTools:["read","bash"]}],
 ["alternate resolves different role",{fallbackAgent:"other-agent"}],
 ["alternate conflicts with actual producer family",{profileConstraints:{requireCrossFamilyFromProducers:true,producerSource:"active_main"},parentModel:{provider:"kimi-coding",id:"k3"}}],
 ["explicit settings empty chain",{roleOverride:{model:"wisdomrouter/glm-5.3",fallbackModels:[],thinking:"high"}}],
] as Array<[string,any]>) {
 test(`exact role leaves no fallback when ${name}`,async()=>{
  const f=await fixture({exactRole:true,...options});try{
   assert.equal(f.graph.nodes[0]!.launch?.runtimeFallback,undefined);
   const expected=options.explicitModel??options.primary??"wisdomrouter/glm-5.3";const resolved=f.graph.nodes[0]!.launch?.resolvedModel;
   if(resolved)assert.equal(resolved.split(":")[0],expected);
   else {assert.equal(f.graph.nodes[0]!.launch,undefined,"unrouted fixed role stays unfrozen as before");assert.match(await readFile(join(f.source,".pi/agents/fallback-agent.md"),"utf8"),new RegExp(`model: ${expected.replaceAll(".","\\.")}`));}
  }finally{await f.mock.dispose();}
 });
}

test("mixed exact-role inference and real capability preserve strict captured catalog binding",async()=>{
 const f=await fixture({exactRole:true,mixed:true});try {
  assert.equal(f.bound.routingAdmission.catalogDigest,f.bound.catalog?.digest);
  assert.equal(f.bound.routingAdmission.inferredCatalogDigest,undefined);
  const exact=f.bound.spec.nodes.find(n=>n.taskId==="node")!,cap=f.bound.spec.nodes.find(n=>n.taskId==="cap")!;
  assert.equal(exact.binding?.catalogDigest,undefined);assert.equal(cap.binding?.catalogDigest,f.bound.routingAdmission.catalogDigest);
  assert.equal(f.bound.routingAdmission.decisions.find(d=>d.taskId==="node")?.inferredFromExactRole,true);
  assert.deepEqual(f.bound.routingAdmission.decisions.find(d=>d.taskId==="cap")?.capabilityIds,["operate.browser"]);
  assert.equal(exact.launch?.runtimeFallback?.candidates[1]?.requestedModel,"kimi-coding/k3");
 }finally {await f.mock.dispose();}
});

test("pure exact inferred node coexists with explicit configured role and empty fallback chain",async()=>{
 const f=await fixture({exactRole:true,settingsPeer:true});try{
  assert.equal(f.bound.routingAdmission.catalogDigest,undefined);assert.match(f.bound.routingAdmission.inferredCatalogDigest!,/^[a-f0-9]{64}$/);
  const configured=f.bound.routingAdmission.decisions.find(d=>d.taskId==="settings")!;
  assert.equal(configured.profile,"role-settings:settings-agent");assert.equal(configured.inferredFromExactRole,undefined);assert.equal(configured.runtimeFallback,undefined);
  const node=f.bound.spec.nodes.find(n=>n.taskId==="settings")!;assert.equal(node.launch?.requestedModel,"wisdomrouter/glm-5.3");assert.equal(node.binding?.catalogDigest,undefined);assert.equal(node.launch?.runtimeFallback,undefined);
  assert.equal(f.bound.spec.nodes.find(n=>n.taskId==="node")?.launch?.runtimeFallback?.candidates[1]?.requestedModel,"kimi-coding/k3");
 }finally{await f.mock.dispose();}
});
test("malformed catalog still fails closed for real required capabilities",async()=>{
 await assert.rejects(fixture({invalidCatalog:true}),/schemaVersion 1 capability list/);
});

test("actual owned launch preflight admits inferred GLM role and official Kimi with immutable role/tool identities",async()=>{
 const f=await fixture({exactRole:true,actualPreflight:true});try{
  const node=f.graph.nodes[0]!,plan=node.launch?.runtimeFallback!;
  assert.equal(node.launch?.requestedModel,"wisdomrouter/glm-5.3");assert.equal(node.launch?.thinking,"high");
  assert.deepEqual(plan.candidates.map(c=>c.requestedModel),["wisdomrouter/glm-5.3","kimi-coding/k3"]);
  assert.ok(plan.candidates.every(c=>c.agentDefinitionDigest===node.binding?.agentDefinitionDigest));
  assert.match(plan.candidates[1]!.admissionLaunchContractDigest,/^[a-f0-9]{64}$/);const {v3PreflightAgentLaunch}=await import("../src/v3/preflight.ts");
  const checked=await v3PreflightAgentLaunch({agent:"fallback-agent",cwd:f.source,task:"FALLBACK_TASK",model:"wisdomrouter/glm-5.3",thinking:"high",availableModels:[{provider:"wisdomrouter",id:"glm-5.3",reasoning:true,input:["text","image"]}]});
  assert.equal(checked.ok,true);if(checked.ok)assert.deepEqual(checked.toolAllowlist,["read"]);
 }finally{await f.mock.dispose();}
});


test("explicit role fallback: GLM subscription -> Kimi quota -> configured third model, exactly three attempts",async()=>{
 const f=await fixture({exactRole:true,parentModel:{provider:'xai',id:'grok-4.7'},parentThinking:'low',roleOverride:{model:'wisdomrouter/glm-5.3',fallbackModels:['kimi-coding/k3','xai/grok-4.7'],thinking:'high'}});
 f.mock.behaviors.set('FALLBACK_TASK',async i=>f.mock.spawned.length<3?providerFailure(i,p=>{p.diagnostic=f.mock.spawned.length===1?'400 InvalidSubscription CodingPlan subscription invalid':error;}):completeChild({...i,output:'accepted'}));
 try{assert.equal((await f.runner.run()).status,'complete');assert.deepEqual(f.mock.spawned.map(s=>s.params.model),['wisdomrouter/glm-5.3:high','kimi-coding/k3:high','xai/grok-4.7:high']);assert.equal(f.graph.nodes[0]!.launch!.runtimeFallback!.modelDegradations,2);}finally{await f.mock.dispose();}
});
for(const active of [false,true])test(`strict provider Connection error. ${active?'with tool activity does not switch':'with complete zero-activity evidence switches'}`,async()=>{
 const f=await fixture();f.mock.behaviors.set('FALLBACK_TASK',async i=>f.mock.spawned.length===1?providerFailure(i,p=>{p.diagnostic='Connection error.';if(active)p.toolsStarted=1;}):completeChild({...i,output:'accepted'}));
 try{const result=await f.runner.run();assert.equal(f.mock.spawned.length,active?1:2);if(!active)assert.equal(result.status,'complete');}finally{await f.mock.dispose();}
});
test('Connection error classification is exact and does not accept tool/task/abort prose',()=>{
 assert.deepEqual(classifyProviderFailure('Connection error.'),{eligible:true,kind:'provider'});
 for(const message of ['tool error: Connection error.','task text: Connection error.','user asked Connection error.','Connection error. cancelled','Connection error during read','timeout','terminated'])assert.equal(classifyProviderFailure(message).eligible,false);
});
