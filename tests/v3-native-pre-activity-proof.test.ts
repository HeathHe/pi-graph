import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {validateNativePreActivityProof} from "../src/v3/runtime-fallback.ts";
import {canonicalDigest} from "../src/v3/digests.ts";
import {openOwnedChild} from "../src/runtime/child-session.ts";
import {createOwnedActivityProof,ownedChildBrand} from "../src/runtime/activity-proof.ts";
import {loadHostSdk,captureHostSdkIdentity,resolveHostDependencyRoot} from "../src/runtime/host-sdk.ts";
const {root:sdkRoot}=await loadHostSdk();
const {createAssistantMessageEventStream}: any = await import(pathToFileURL(join(await resolveHostDependencyRoot(sdkRoot,"@earendil-works/pi-ai"),"dist/utils/event-stream.js")).href);
const diagnostic = `403 {"error":{"type":"permission_error","message":"You've reached your 5-hour usage limit"}}`;
async function fixture(mode = "clean") {
 const root=mkdtempSync(join(tmpdir(),"owned-proof-"));
 const saved={NODE_ENV:process.env.NODE_ENV,PI_GRAPH_CHILD:process.env.PI_GRAPH_CHILD,PI_GRAPH_EXTENSION_BINDINGS:process.env.PI_GRAPH_EXTENSION_BINDINGS};
 process.env.NODE_ENV='test';
 const binding={schemaVersion:1,graphId:"graph-test",taskId:"task-test",attempt:1,workspaceCwd:root,contractDigest:"a".repeat(64)};
 const intent:any={hostSdkIdentity:await captureHostSdkIdentity(),version:1,runId:"fixture-run",asyncDir:root,runnerProcessInstanceId:"instance",sessionId:"owner",params:{cwd:root,task:"Fixture"},agent:{name:"test-agent",systemPrompt:"Fixture only"},launchContract:{launchContractDigest:"b".repeat(64),inheritSkills:false,inheritProjectContext:false,inheritGlobalContext:false,tools:{effectiveAllowlist:[],extensionArgs:[]}}};
 const activity=createOwnedActivityProof({...intent,params:{...intent.params,extensionBindings:{"pi-graph/1":binding}}});
 let child:any;
 try{
  child=await openOwnedChild(intent,activity.observe,'quota');
  assert.deepEqual(ownedChildBrand(child),{officialInProcess:true,shutdownComplete:false});
  const admitted=mode==='unknown-factory'?{...child}:child;activity.admit(admitted);
  const model=child.session.model;
  child.session.agent.streamFunction=async()=>{
   const stream=createAssistantMessageEventStream();
   const msg={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[],stopReason:"error",errorMessage:diagnostic,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   stream.push({type:"start",partial:msg});stream.push({type:"error",reason:"error",error:msg});stream.end();return stream;
  };
  if(mode==='tool')activity.observe({type:'tool_execution_start',toolName:'fixture_tool',toolCallId:'fixture-call'});
  if(mode==='assistant-tool')activity.observe({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:'tc',name:'fixture_tool',arguments:{}}],stopReason:'toolUse'}});
  if(mode==='orphan-tool')activity.observe({type:'message_end',message:{role:'toolResult',toolCallId:'orphan',toolName:'fixture_tool',content:[]}});
  if(['stopped','timedOut','interrupted'].includes(mode))await child.session.abort();
  if(mode==='steered')await child.session.steer('Fixture steer');
  await child.session.prompt('Fixture');await child.session.waitForIdle();
  if(mode==='queued')child.session.getFollowUpMessages=()=>['Unconsumed fixture input'];
  if(mode==='unknown-queue')child.session.getFollowUpMessages=undefined;
  if(mode==='throwing-queue')child.session.getSteeringMessages=()=>{throw new Error('Unknown queue state')};
  activity.settle(child.session);
  if(mode==='late')activity.observe({type:'agent_start'});
  if(mode==='shutdown-failure'){child.session.extensionRunner.emit=async()=>{throw new Error('Fixture shutdown failed')};child.session.extensionRunner.hasHandlers=()=>true;}
  try{await child.shutdown();}catch{/* failed shutdown is proof, not a test crash */}
  const p=activity.finish(admitted,{stopped:mode==='stopped',timedOut:mode==='timedOut',interrupted:mode==='interrupted',steered:mode==='steered'});
  return {result:{exitCode:1,error:diagnostic,preActivityEvidence:p},shutdown:ownedChildBrand(child),binding};
 }finally{
  for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(root,{recursive:true,force:true});
 }
}
test("owned factory + actual SDK error stream generate branded zero-activity proof",async()=>{
 const {result,shutdown,binding}=await fixture();
 const p=result.preActivityEvidence;
 assert.equal(result.exitCode,1);assert.equal(result.error,diagnostic);
 assert.deepEqual(shutdown,{officialInProcess:true,shutdownComplete:true});
 for(const key of ["officialInProcess","controlledEnvironment","subscribedBeforePrompt","agentStarted","promptSettled","shutdownComplete"])assert.equal(p[key],true,key);
 for(const key of ["orphanToolResult","lateActivity","invalid","queuedInput","stopped","timedOut","interrupted","forced"])assert.equal(p[key],false,key);
 assert.equal(p.version,1);assert.equal(p.toolsStarted,0);assert.equal(p.assistantToolCalls,0);assert.deepEqual(p.graphBinding,binding);assert.equal(p.diagnosticSource,"assistant_error");assert.equal(p.diagnostic,diagnostic);
 assert.equal(ownedChildBrand({...result}),undefined,"caller objects cannot claim factory brand");
});
for(const [mode,key,value] of [["tool","toolsStarted",1],["assistant-tool","assistantToolCalls",1],["orphan-tool","orphanToolResult",true],["late","lateActivity",true],["queued","invalid",true],["shutdown-failure","shutdownComplete",false],["unknown-factory","officialInProcess",false],["stopped","stopped",true],["timedOut","timedOut",true],["interrupted","interrupted",true],["steered","invalid",true],["unknown-queue","invalid",true],["throwing-queue","invalid",true]] as const){
 test(`actual owned factory proof disqualifies ${mode}`,async()=>{const {result}=await fixture(mode);assert.equal(result.preActivityEvidence[key],value);});
}

test("generated owned proof has bounded schema; Graph checks version, source and launch identity",async()=>{
 const {result,binding}=await fixture();
 const keys=["version","runtimeKind","factoryIdentity","runId","stepIndex","agent","launchContractDigest","launches","subscribedBeforePrompt","agentStarted","toolsStarted","assistantToolCalls","orphanToolResult","lateActivity","diagnostic","invalid","shutdownComplete","officialInProcess","controlledEnvironment","graphBinding","promptSettled","queuedInput","stopped","timedOut","interrupted","forced","diagnosticSource"];
 assert.deepEqual(Object.keys(result.preActivityEvidence).sort(),keys.sort());
 const workspace:any={workspaceDir:binding.workspaceCwd,contractDigest:binding.contractDigest,runInstanceId:"instance-test",attempt:1,taskId:"task-test"};
 const digest="b".repeat(64), runId="async-test", agent="test-agent", resolvedModel="test-provider/test-model";
 const input:any={receipt:{runId,asyncDir:"/tmp/native-fixture",sessionId:"parent-session",digest:"c".repeat(64),status:{runtimeKind:"pi-graph-sdk/1",steps:[{toolCount:0}],runId,sessionId:"parent-session",processTerminal:{runnerProcessInstanceId:"runner-test"}},completion:{state:"failed",results:[{toolCount:0,agent,requestedModel:resolvedModel,model:resolvedModel,error:result.error,launchContractDigest:digest,preActivityEvidence:{...result.preActivityEvidence,launches:1,runId,stepIndex:0,agent,launchContractDigest:digest}}]}},exitProof:{version:1,runtimeKind:"pi-graph-sdk/1",state:"observed",runId,runnerProcessInstanceId:"runner-test",observedAt:Date.now(),instances:[{kind:"runner",processInstanceId:"runner-test",closeObservedAt:Date.now(),exitCode:0,signal:null}]},evidence:{graphId:binding.graphId,taskId:binding.taskId,attempt:1,runInstanceId:"instance-test",workspaceDigest:canonicalDigest(workspace),dispatch:{asyncId:runId,asyncDir:"/tmp/native-fixture"}},node:{agent,launch:{runtimeFallback:{candidates:[{resolvedModel}]}}},candidateIndex:0,workspace};
 assert.ok(validateNativePreActivityProof(input),"actual owned proof qualifies after runner identity projection");
 const mutate=(fn:(i:any)=>void)=>{const cloned=structuredClone(input);fn(cloned);assert.equal(validateNativePreActivityProof(cloned),undefined);};
 mutate(i=>i.receipt.status.steps[0].toolCount=1);mutate(i=>delete i.receipt.status.runtimeKind);mutate(i=>i.receipt.completion.results[0].toolCount=1);
 mutate(i=>i.receipt.completion.results[0].error="different final failure");
 mutate(i=>delete i.receipt.completion.results[0].error);
 mutate(i=>i.receipt.completion.results[0].structuredOutputFailed=true);
 mutate(i=>i.receipt.completion.results[0].effects={fileMutation:true});
 mutate(i=>i.receipt.completion.results[0].effects={settlementDiagnostic:{mutation:{attempted:true}}});
 mutate(i=>i.receipt.completion.results[0].effects={settlementDiagnostic:{mutation:{observed:true}}});
 mutate(i=>delete i.receipt.completion.results[0].preActivityEvidence.version);
 mutate(i=>i.receipt.completion.results[0].preActivityEvidence.version=2);
 mutate(i=>delete i.receipt.sessionId);
 mutate(i=>i.receipt.status.sessionId="wrong-parent");
 mutate(i=>i.receipt.runId="wrong-child");
 mutate(i=>i.receipt.completion.results[0].preActivityEvidence.graphBinding.taskId="wrong-task");
 mutate(i=>i.receipt.completion.results[0].preActivityEvidence.graphBinding.schemaVersion=2);
 mutate(i=>i.receipt.completion.results[0].launchContractDigest="d".repeat(64));
 mutate(i=>i.receipt.completion.results[0].preActivityEvidence.launches=2);
 for(const key of ["toolsStarted","assistantToolCalls"])mutate(i=>i.receipt.completion.results[0].preActivityEvidence[key]=1);
 for(const key of ["orphanToolResult","lateActivity","invalid","queuedInput","stopped","timedOut","interrupted","forced"])mutate(i=>i.receipt.completion.results[0].preActivityEvidence[key]=true);
 for(const key of ["officialInProcess","shutdownComplete","controlledEnvironment","agentStarted","subscribedBeforePrompt","promptSettled"])mutate(i=>i.receipt.completion.results[0].preActivityEvidence[key]=false);
});
test("owned runner durable projection preserves actual observer identity and lifecycle proof",()=>{
 // Source boundary check; actual detached persistence is separately tested in owned-child-worker.
 const source=readFileSync(new URL('../src/runtime/child-runner.mjs',import.meta.url),"utf8");
 assert.match(source,/createOwnedActivityProof/);assert.match(source,/activity\.observe\(event\)/);assert.match(source,/activity\.settle\(child\.session\)/);assert.match(source,/activity\.finish\(child/);assert.match(source,/preActivityEvidence:proof/);assert.match(source,/write\('result\.json',completion\)/);
});
