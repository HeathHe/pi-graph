import {captureHostSdkIdentity} from '../src/runtime/host-sdk.ts';
import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {normalizeExtensionBindings as normalize} from "../src/runtime/extension-bindings.ts";
import {resolveSubagentLaunchContract as preflight} from "../src/runtime/launch-contract.ts";
import {openOwnedChild} from "../src/runtime/child-session.ts";
import {compileGraphSpecV3} from "../src/v3/compiler.ts";
import {initializeV3Run} from "../src/v3/initialize.ts";
import {V3GraphRunner} from "../src/v3/runner.ts";
import {SubagentRpcClient} from "../src/v3/rpc.ts";
import {MockSubagents,completeChild} from "./helpers/mock-subagents.ts";
import {MAILBOX_BINDING_NAMESPACE} from "../src/v3/mailbox-bindings.ts";

let fixture:any;
const previousAgentDir=process.env.PI_CODING_AGENT_DIR,previousFetch=globalThis.fetch;
before(async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"native-mailbox-binding-"))),source=join(root,"source"),home=join(root,"agent");await mkdir(join(source,".pi/agents"),{recursive:true});await mkdir(home);
 process.env.PI_CODING_AGENT_DIR=home;await writeFile(join(home,"settings.json"),"{}");globalThis.fetch=async()=>{throw new Error("No production network permitted in native binding test");};
 await writeFile(join(source,".pi/agents/binding-reader.md"),"---\nname: binding-reader\ndescription: isolated native binding fixture\nmodel: openai/gpt-4o\ntools: read\n---\nRead only fixture.\n");
 const graph=compileGraphSpecV3({schemaVersion:3,graphId:"binding",goal:"real Graph bindings",nodes:[{taskId:"a",agent:"binding-reader",task:"BINDING",sideEffect:"none"}]});const runDir=join(root,"binding");const init=await initializeV3Run({trustedRoot:root,runDir,graph,sourceCwd:source,sessionId:"owner",supervisorEpoch:"epoch",runInstanceId:"instance"});
 const mock=new MockSubagents();mock.start();mock.behaviors.set("BINDING",input=>completeChild({...input,output:"accepted fixture"}));const runner=new V3GraphRunner({rpc:new SubagentRpcClient(mock),runDir,graph,authorization:init.authorization,sourceCwd:source,sessionId:"owner",supervisorEpoch:"epoch",preflightAgent:async()=>{}});
 const snapshot=await runner.run();assert.equal(snapshot.status,"complete");assert.equal(mock.spawned.length,1);const params=mock.spawned[0]!.params;assert.ok(params.extensionBindings);
 fixture={root,runDir,source,mock,params,bindings:params.extensionBindings};

});
after(async()=>{globalThis.fetch=previousFetch;if(previousAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousAgentDir;if(fixture){await fixture.mock.dispose();await rm(fixture.root,{recursive:true,force:true});}});
const bad=()=>{const value={...fixture.bindings};value["pi-graph/mailbox-v1"]=value[MAILBOX_BINDING_NAMESPACE];delete value[MAILBOX_BINDING_NAMESPACE];return value;};
const preflightInput=(bindings:any)=>({agent:fixture.params.agent,cwd:fixture.source,task:fixture.params.task,agentScope:"project" as const,model:"openai/gpt-4o",availableModels:[{provider:"openai",id:"gpt-4o",reasoning:false}],extensionBindings:bindings,requiredExtensions:[{id:"pi-graph-guard",path:fileURLToPath(new URL("../extensions/pi-graph-guard.ts",import.meta.url))}],artifacts:false,context:"fresh",intercomBridge:{mode:"off"}});

test("actual Graph dispatch bindings pass owned normalizer; wire/store names remain unchanged",async()=>{
 assert.equal(MAILBOX_BINDING_NAMESPACE,"pi-graph-mailbox/1");assert.ok(fixture.bindings[MAILBOX_BINDING_NAMESPACE]);assert.ok(fixture.bindings["pi-graph/1"]);assert.ok(!("pi-graph/mailbox-v1" in fixture.bindings));assert.deepEqual(normalize(fixture.bindings)!.value,fixture.bindings);
 const mailbox=JSON.parse(await readFile(join(fixture.runDir,"mailbox-v1/state.json"),"utf8"));assert.equal(mailbox.protocol,"graph-mailbox-v1");console.log("NATIVE_BINDING_PROOF",JSON.stringify({runtime:"pi-graph-sdk/1",keys:Object.keys(fixture.bindings),phase:"Graph mock-RPC dispatch params and owned normalize; no OS launch"}));
});
test("same owned normalizer rejects original malformed mailbox namespace",()=>{assert.throws(()=>normalize(bad()),/package-like.*positive-version/);});
test("owned public preflight accepts actual Graph bindings and explicitly rejects old namespace",async()=>{
 const good=await preflight(preflightInput(fixture.bindings));assert.equal(good.ok,true,JSON.stringify({code:good.code,message:good.message,diagnostics:good.diagnostics}));const rejected=await preflight(preflightInput(bad()));assert.equal(rejected.ok,false);assert.equal(rejected.code,"invalid_extension_bindings");assert.match(rejected.message,/pi-graph\/mailbox-v1/);console.log("PREFLIGHT_PROOF",JSON.stringify({good:good.ok,bad:rejected.code,networkRequests:0,scope:"contract preflight, not OS spawn"}));
});
test("owned actual SDK child accepts dispatch bindings and refuses malformed namespaces before prompt",async()=>{
 const saved={NODE_ENV:process.env.NODE_ENV,PI_GRAPH_CHILD:process.env.PI_GRAPH_CHILD,PI_GRAPH_EXTENSION_BINDINGS:process.env.PI_GRAPH_EXTENSION_BINDINGS};process.env.NODE_ENV='test';
 try{
  const contract=await preflight(preflightInput(fixture.bindings));if(!contract.ok)throw Error(contract.message);assert.equal(contract.ok,true);
  const intent:any={hostSdkIdentity:await captureHostSdkIdentity(),version:1,runId:'bindings-fixture',asyncDir:join(fixture.root,'owned-child'),sessionId:'owner',runnerProcessInstanceId:'instance',params:{...fixture.params,model:'openai/gpt-4o',extensionBindings:fixture.bindings},agent:{name:fixture.params.agent},launchContract:contract.contract};
  const child=await openOwnedChild(intent,()=>{},'success');
  try{assert.deepEqual(JSON.parse(process.env.PI_GRAPH_EXTENSION_BINDINGS!),normalize(fixture.bindings)!.value);assert.ok(child.acknowledged.has('pi-graph-guard'));}finally{await child.shutdown();}
  await assert.rejects(openOwnedChild({...intent,params:{...intent.params,extensionBindings:bad()}},()=>{},'success'),/package-like.*positive-version/);
 }finally{for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
