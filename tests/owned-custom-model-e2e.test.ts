import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GraphRuntimeController} from '../src/runtime/controller.ts';
import {SubagentRpcClient} from '../src/v3/rpc.ts';
import {createGraphAgentRole,editGraphAgentRole,writeGraphModelSettings,selectGraphModelProfile} from '../src/runtime/settings.ts';
import {setCustomGraphModel,readCustomGraphModels} from '../src/runtime/custom-models.ts';
import type {CustomGraphModel} from '../src/runtime/custom-models.ts';
import {bindGraphSpecWithRoutingV3} from '../extensions/routing-admission.ts';
import {compileGraphSpecV3} from '../src/v3/compiler.ts';
import {initializeV3Run} from '../src/v3/initialize.ts';
import {freezeV3GraphAgents} from '../src/v3/workspace.ts';
import {V3GraphRunner} from '../src/v3/runner.ts';
import {readV3AttemptEvidence} from '../src/v3/attempt.ts';
import {confirmedProcessExit} from '../src/v3/supervision.ts';

class Bus{private listeners=new Map<string,Set<(x:unknown)=>void>>();on(key:string,fn:(x:unknown)=>void){const s=this.listeners.get(key)??new Set();s.add(fn);this.listeners.set(key,s);return()=>{s.delete(fn)}}emit(key:string,v:unknown){for(const fn of this.listeners.get(key)??[])fn(v)}}
const MODEL:CustomGraphModel={provider:'graph-fixture',id:'local',name:'Local SDK fixture',api:'openai-completions',baseUrl:'https://frozen.invalid/v1',input:['text'],contextWindow:12000,maxTokens:2048,reasoning:true,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},auth:{type:'env',variable:'PI_GRAPH_E2E_UNUSED_CREDENTIAL_REFERENCE'}};
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'graph-custom-model-e2e-'))),cwd=join(root,'work'),agentDir=join(root,'agent');await mkdir(cwd);await mkdir(agentDir);
 const old={NODE_ENV:process.env.NODE_ENV,PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR,PI_GRAPH_RUNTIME_ROOT:process.env.PI_GRAPH_RUNTIME_ROOT};
 process.env.NODE_ENV='test';process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_GRAPH_RUNTIME_ROOT=join(root,'runtime');
 setCustomGraphModel({cwd,agentDir,scope:'project',value:MODEL});
 createGraphAgentRole({cwd,agentDir,scope:'project',name:'custom-e2e-role',description:'Custom E2E role',prompt:'Original fixture-only prompt.',tools:['read'],model:'graph-fixture/local',thinking:'high'});
 editGraphAgentRole({cwd,agentDir,scope:'project',name:'custom-e2e-role',value:{prompt:'Edited fixture-only prompt. Return the fixture response.',tools:['read']}});
 writeGraphModelSettings({cwd,agentDir,scope:'project',profile:'fixture-plan',value:{model:'graph-fixture/local',fallbackModels:[],thinking:'high'}});
 selectGraphModelProfile({cwd,agentDir,scope:'project',role:'custom-e2e-role',profile:'fixture-plan'});
 const bus=new Bus(),controller=new GraphRuntimeController(bus,()=>({sessionId:'custom-owner'}),'success'),rpc=new SubagentRpcClient(bus);
 return {root,cwd,agentDir,bus,controller,rpc,async close(){controller.dispose();for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(root,{recursive:true,force:true});}};
}
async function admit(f:Awaited<ReturnType<typeof fixture>>,graphId:string){
 const bound=await bindGraphSpecWithRoutingV3({schemaVersion:3,graphId,goal:'Custom model/role fixture',nodes:[{taskId:'custom-node',agent:'custom-e2e-role',task:'Return fixture',sideEffect:'none'}]},{cwd:f.cwd,agentDir:f.agentDir,disableNetwork:true,availableModels:[]});
 const graph=compileGraphSpecV3(bound.spec),runDir=join(f.root,graphId);const init=await initializeV3Run({trustedRoot:f.root,runDir,graph,sessionId:'custom-owner',supervisorEpoch:'custom-test',sourceCwd:f.cwd});await freezeV3GraphAgents(runDir,f.cwd,graph.nodes);
 assert.equal(graph.nodes[0]?.launch?.resolvedModel,'graph-fixture/local');assert.equal(graph.nodes[0]?.launch?.thinking,'high');assert.equal(graph.nodes[0]?.launch?.customModelDefinitions?.[0]?.baseUrl,MODEL.baseUrl);
 const frozen=JSON.parse(await readFile(join(runDir,'agent-profiles','custom-node.json'),'utf8'));assert.match(frozen.serialized,/Edited fixture-only prompt/u);
 return {graph,runDir,init};
}
async function runAndRead(f:Awaited<ReturnType<typeof fixture>>,state:Awaited<ReturnType<typeof admit>>){
 const runner=new V3GraphRunner({rpc:f.rpc,runDir:state.runDir,graph:state.graph,authorization:state.init.authorization,sourceCwd:f.cwd,sessionId:'custom-owner',supervisorEpoch:'custom-test'});
 const snapshot=await runner.run();assert.equal(snapshot.status,'complete',JSON.stringify(snapshot.nodes));
 const attempt=await readV3AttemptEvidence(state.runDir,'custom-node',1);assert.equal(attempt?.phase,'accepted');assert.equal(attempt?.child?.output,'Owned fixture response');assert.equal(attempt?.child?.observation?.actualModel,'graph-fixture/local');assert.equal(attempt?.child?.observation?.usage?.totalTokens,5);assert.equal(attempt?.child?.observation?.supervision?.processExitConfirmed,true);assert.ok(attempt?.dispatch?.asyncDir);
 const asyncDir=attempt.dispatch.asyncDir,completion=JSON.parse(await readFile(join(asyncDir,'result.json'),'utf8')),intent=JSON.parse(await readFile(join(asyncDir,'intent.json'),'utf8')),proof=JSON.parse(await readFile(join(asyncDir,'process-terminal.json'),'utf8'));
 assert.equal(confirmedProcessExit(proof,attempt.dispatch.asyncId),true);assert.equal(completion.results[0].thinking,'high');assert.equal(completion.results[0].preActivityEvidence.toolsStarted,0);assert.equal(intent.params.customModelDefinitions[0].auth.variable,MODEL.auth.type==='env'?MODEL.auth.variable:undefined);
 assert.equal(completion.results[0].actualModelDefinition.provider,'graph-fixture');assert.equal(completion.results[0].actualModelDefinition.id,'local');assert.equal(completion.results[0].actualModelDefinition.api,MODEL.api);assert.equal(completion.results[0].actualModelDefinition.contextWindow,12000);assert.equal(completion.results[0].actualModelDefinition.maxTokens,2048);assert.deepEqual(completion.results[0].actualModelDefinition.input,['text']);
 assert.equal(Object.hasOwn(completion.results[0].actualModelDefinition,'auth'),false);
 return {completion,intent};
}
test('custom model CRUD and custom role/profile execute through actual SDK registered metadata',async()=>{const f=await fixture();try{const state=await admit(f,'custom-model-crud');const {completion,intent}=await runAndRead(f,state);assert.equal(completion.results[0].actualModelDefinition.baseUrl,MODEL.baseUrl);assert.equal(intent.agent.systemPrompt.includes('Edited fixture-only prompt'),true);const tools=intent.params.tools??intent.launchContract.tools.effectiveAllowlist;assert.ok(tools.includes('read'));assert.equal(tools.includes('write'),false);}finally{await f.close()}});
test('existing Graph retains frozen custom endpoint and thinking after project model/profile edits',async()=>{const f=await fixture();try{const state=await admit(f,'custom-model-frozen');setCustomGraphModel({cwd:f.cwd,agentDir:f.agentDir,scope:'project',value:{...MODEL,baseUrl:'https://changed.invalid/v2',contextWindow:24000,maxTokens:4096}});writeGraphModelSettings({cwd:f.cwd,agentDir:f.agentDir,scope:'project',profile:'fixture-plan',value:{model:'graph-fixture/local',thinking:'low'}});assert.equal(readCustomGraphModels(f.cwd,f.agentDir)[0]?.baseUrl,'https://changed.invalid/v2');const {completion,intent}=await runAndRead(f,state);assert.equal(intent.params.customModelDefinitions[0].baseUrl,MODEL.baseUrl);assert.equal(completion.results[0].actualModelDefinition.baseUrl,MODEL.baseUrl);assert.equal(completion.results[0].thinking,'high');}finally{await f.close()}});
