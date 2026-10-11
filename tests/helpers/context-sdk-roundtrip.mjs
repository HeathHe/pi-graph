// Independent actual-SDK fixture. Public fake transport, real frozen workspace
// and Graph guard; no production provider registration or HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const graphRoot=fileURLToPath(new URL('../..',import.meta.url));
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'graph-context-sdk-')));
process.env.PI_CODING_AGENT_DIR=path.join(root,'agent');
process.env.PI_GRAPH_RUNTIME_ROOT=path.join(root,'native');
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR,{recursive:true});
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'settings.json'),'{}');
const SDK='/Users/heathhe/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent';
const {createDefaultChildSessionFactory}=await import('./owned-sdk-factory.mjs');
const {createFauxCore,fauxAssistantMessage,fauxToolCall}=await import(SDK+'/node_modules/@earendil-works/pi-ai/dist/providers/faux.js');
const {createJiti}=await import(graphRoot+'/node_modules/jiti/lib/jiti.mjs');
const jiti=createJiti(import.meta.url);
const {freezeV3GraphAgents,prepareV3Workspace}=await jiti.import(graphRoot+'/src/v3/workspace.ts');
const {v3GraphGuardExtensionBindings}=await jiti.import(graphRoot+'/src/v3/dispatch.ts');
const guard=(await jiti.import(graphRoot+'/extensions/pi-graph-guard.ts')).default;
const {discoverAgents}=await jiti.import(graphRoot+'/src/runtime/agents.ts');
const {resolvePiLaunchToolPlan}=await jiti.import(graphRoot+'/src/runtime/launch-contract.ts');
const mode=process.argv[2]??'baseline';
const policy=process.env.PI_GRAPH_CONTEXT_TEST_POLICY ? JSON.parse(process.env.PI_GRAPH_CONTEXT_TEST_POLICY) : undefined;
const source=path.join(root,'source'),runDir=path.join(root,'run');
fs.mkdirSync(path.join(source,'.pi','agents'),{recursive:true});fs.mkdirSync(runDir);
const marker='INDEPENDENT-CONTEXT-ORIGINAL-END';
const text='Original material 中文😀 '.repeat(180)+'\n'+marker+'\n';
fs.writeFileSync(path.join(source,'sample.txt'),text);
fs.writeFileSync(path.join(source,'image.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64'));
fs.writeFileSync(path.join(source,'.pi','agents','reader.md'),'---\nname: reader\ndescription: SDK context fixture\ntools: read\n---\n\nRead only fixture files.\n');
const node={taskId:'reader',agent:'reader',task:'read twice',dependsOn:[],inputArtifacts:[],outputArtifact:'fixture/reader',readScope:[{kind:'file',path:'sample.txt'},{kind:'file',path:'image.png'},{kind:'file',path:'missing.txt'}],writeScope:[],sideEffect:'none',retryPolicy:{maxAttempts:1,retryOn:[],backoffMs:0},validationCommands:[],...(policy?{contextPolicy:policy}:{})};
await freezeV3GraphAgents(runDir,source,[node]);
const workspace=await prepareV3Workspace({runInstanceId:'context-fixture',graphId:'context',node,attempt:1,runDir,sourceCwd:source,workspace:'shadow'});
const agent=discoverAgents(workspace.workspaceCwd,'project').agents.find(agent=>agent.name==='reader');
assert.ok(agent);const plan=resolvePiLaunchToolPlan({tools:agent.tools,cwd:workspace.workspaceCwd,agentName:'reader'});
let step=0,toolStarts=0,toolEnds=0,guardCalls=0,providerCalls=0,registeredPi,actualSession;
const contexts=[],providerInputs=[];
const faux=createFauxCore({provider:'fixture-local',api:'fixture-local',models:[{id:'fixture'}]});
faux.setResponses(Array.from({length:6},()=>async context=>{
 providerCalls++;contexts.push(structuredClone(context));
 const current=step++;
 if(current<2){
  if(current===1 && mode==='changed')fs.writeFileSync(path.join(workspace.workspaceCwd,'sample.txt'),text.replace(marker,'INDEPENDENT-CONTEXT-CHANGED-END'));
  const args=mode==='offset'?{path:'sample.txt',offset:current+1,limit:2}:{path:mode==='image'?'image.png':mode==='errors'?'missing.txt':'sample.txt'};
  return fauxAssistantMessage(fauxToolCall('read',args),{stopReason:'toolUse'});
 }
 return fauxAssistantMessage('Fixture reads complete.');
}));
const factory=createDefaultChildSessionFactory({loadPiCodingAgent:async()=>{
 const sdk=await import(SDK+'/dist/index.js');
 globalThis.fetch=()=>{throw new Error('Context SDK fixture forbids network');};
 return {...sdk,ModelRuntime:{create:async()=>{
  const runtime=await sdk.ModelRuntime.create({authPath:path.join(root,'auth.json'),modelsPath:null,modelsStorePath:path.join(root,'models.json'),allowModelNetwork:false,refreshOnCreate:false});
  await runtime.setRuntimeApiKey('openai','fixture-no-network');return runtime;
 }},createAgentSession:async options=>{
  const result=await sdk.createAgentSession(options);actualSession=result.session;result.session.agent.streamFunction=(model,context,options)=>{providerInputs.push(structuredClone(context));return faux.streamSimple(model,context,options);};return result;
 }};
}});
let session;
try{
 session=await factory.create({cwd:workspace.workspaceCwd,storage:{kind:'dir',sessionDir:path.join(root,'session')},model:'openai/gpt-4o',tools:plan.effectiveToolAllowlist,extensionPaths:[],ambientExtensions:false,
  hooks:[...(mode==='custom'?[{name:'custom-read-fixture',factory:pi=>pi.registerTool({name:'read',label:'custom read',description:'fixture override',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},execute:async()=>({content:[{type:'text',text}]})})}]:[]),{name:'real-frozen-guard',factory:pi=>{guard(pi);registeredPi=pi;pi.on('tool_call',()=>{guardCalls++;});}}],noSkills:true,noContextFiles:true,runtime:{},
  processEnv:{PI_GRAPH_CHILD:'1',PI_GRAPH_EXTENSION_BINDINGS:mode==='inert'?undefined:JSON.stringify(v3GraphGuardExtensionBindings(workspace.evidence))},onExtensionError:event=>{throw event.error;}});
 session.subscribe(event=>{if(event.toolName==='read'){if(event.type==='tool_execution_start')toolStarts++;if(event.type==='tool_execution_end')toolEnds++;}});
 await session.prompt('Read the same fixture file twice with the supplied tool sequence.');
 assert.equal(toolStarts,2);assert.equal(toolEnds,2);assert.equal(guardCalls,2);assert.equal(providerCalls,3);
 const journal=fs.readFileSync(session.sessionFile,'utf8').trim().split('\n').map(JSON.parse);
 const persisted=journal.filter(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='read').map(entry=>entry.message);
 assert.equal(persisted.length,2);assert.ok(persisted.every(message=>mode==='errors'?message.isError===true:message.isError!==true));
 const finalResults=contexts.at(-1).messages.filter(message=>message.role==='toolResult'&&message.toolName==='read');
 assert.equal(finalResults.length,2,'context must retain tool response pairs');
 const occurrences=messages=>JSON.stringify(messages).split(marker).length-1;
 if(mode==='repeat'){
  assert.ok(policy,'repeat feature proof requires explicit product policy');
  assert.equal(occurrences(persisted),2,'persistent transcript retains both full results');
  assert.equal(occurrences(finalResults),1,'final model context contains exactly one original full body');
  assert.ok(JSON.stringify(finalResults).length<JSON.stringify(persisted).length-2000,'duplicate body replaced by bounded reference');
  assert.match(JSON.stringify(finalResults),/graph-context-repeat anchor:[a-f0-9]{64}/);
  // Remove the earlier full result through the real SDK's public compaction
  // journal/projection. The remaining raw duplicate must become a fresh anchor.
  const calls=journal.filter(entry=>entry.type==='message'&&entry.message.role==='assistant'&&entry.message.content?.some(block=>block.type==='toolCall'&&block.name==='read'));
  actualSession.sessionManager.appendCompaction('Fixture compaction removed first full body.',calls[1].id,10000);
  const projection=actualSession.sessionManager.buildSessionProjection();
  assert.equal(occurrences(projection.messages.filter(message=>message.role==='toolResult')),1);
  await session.prompt('Read-only compaction continuation; do not call additional tools.');
  const rebuilt=contexts.at(-1).messages.filter(message=>message.role==='toolResult'&&message.toolName==='read');
  assert.equal(occurrences(rebuilt),1,'sole surviving full raw body must remain visible after compaction');
  assert.equal(rebuilt.length,1);assert.ok(!JSON.stringify(rebuilt).includes('graph-context-repeat'));
 }else if(mode==='changed'){
  assert.equal(occurrences(finalResults),1);assert.ok(JSON.stringify(finalResults).includes('INDEPENDENT-CONTEXT-CHANGED-END'));
 }else if(mode==='image'){
  assert.equal(persisted.flatMap(message=>message.content).filter(block=>block.type==='image').length,2,'raw session must retain both image results');
  assert.equal(providerInputs.at(-1).messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(block=>block.type==='image').length,2,'provider request retains both images even if normalized to separate user messages');
 }else if(mode==='errors'){
  assert.ok(finalResults.every(message=>message.isError===true));assert.ok(!JSON.stringify(finalResults).includes('graph-context-repeat'));
 }else assert.equal(occurrences(finalResults),2,'nonduplicate/excluded baseline preserves both bodies');
 if(mode==='custom')assert.notEqual(registeredPi.getAllTools().find(tool=>tool.name==='read')?.sourceInfo?.source,'builtin');
 const proof={mode,toolStarts,toolEnds,guardCalls,providerCalls,persistentOriginalCount:occurrences(persisted),providerOriginalCount:occurrences(finalResults),providerResultsSha256:createHash('sha256').update(JSON.stringify(finalResults)).digest('hex'),sourceInfo:registeredPi.getAllTools().find(tool=>tool.name==='read')?.sourceInfo};
 fs.writeFileSync(path.join(root,'context-sdk-proof.json'),JSON.stringify(proof,null,2));
 console.log('PASS actual frozen guarded SDK context '+mode);console.log('CONTEXT_PROOF '+JSON.stringify(proof));
}finally{
 if(session){await session.abort().catch(()=>{});await session.dispose();}await factory.dispose();await workspace.cleanup();
}
