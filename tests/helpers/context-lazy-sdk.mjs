// Real runner dispatch -> actual SDK guarded builtin read. RPC lifecycle is mock;
// accepted producer/artifact/copy/prompt/guard/tool/context paths are product code.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const G=fileURLToPath(new URL('../..',import.meta.url));
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'context-lazy-sdk-')));
process.env.PI_CODING_AGENT_DIR=path.join(root,'agent');process.env.PI_GRAPH_RUNTIME_ROOT=path.join(root,'native');
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'settings.json'),'{}');
globalThis.fetch=()=>{throw new Error('Lazy SDK fixture forbids network');};
const SDK='/Users/heathhe/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent';
const {createDefaultChildSessionFactory}=await import('./owned-sdk-factory.mjs');
const {createFauxCore,fauxAssistantMessage,fauxToolCall}=await import(SDK+'/node_modules/@earendil-works/pi-ai/dist/providers/faux.js');
const {createJiti}=await import(G+'/node_modules/jiti/lib/jiti.mjs');const jiti=createJiti(import.meta.url);
const {compileGraphSpecV3}=await jiti.import(G+'/src/v3/compiler.ts');const {initializeV3Run}=await jiti.import(G+'/src/v3/initialize.ts');
const {V3GraphRunner}=await jiti.import(G+'/src/v3/runner.ts');const {SubagentRpcClient}=await jiti.import(G+'/src/v3/rpc.ts');
const {MockSubagents,completeChild}=await jiti.import(G+'/tests/helpers/mock-subagents.ts');
const guard=(await jiti.import(G+'/extensions/pi-graph-guard.ts')).default;
const mode=process.argv[2]??'lazy';
const tail='INDEPENDENT-LAZY-UNIQUE-TAIL',tamper='UNTRUSTED-MATERIAL-MUST-NOT-LEAK';
const lines=Array.from({length:120},(_,i)=>`[L${String(i).padStart(4,'0')}] `+'资料中文😀 '.repeat(8));lines.push('[L0120] '+tail);
const output=mode==='single-line'?'x'.repeat(55*1024)+tail:lines.join('\n')+'\n';
const source=path.join(root,'source'),runDir=path.join(root,'lazy');fs.mkdirSync(path.join(source,'.pi','agents'),{recursive:true});
for(const name of ['producer','consumer'])fs.writeFileSync(path.join(source,'.pi','agents',name+'.md'),`---\nname: ${name}\ndescription: lazy SDK fixture\ntools: read\n---\n\nFixture only.\n`);
const graph=compileGraphSpecV3({schemaVersion:3,graphId:'lazy',goal:'lazy SDK',contextPolicy:'v1',nodes:[
 {taskId:'a',agent:'producer',task:'PRODUCER',sideEffect:'none'},
 {taskId:'b',agent:'consumer',task:'CONSUMER',sideEffect:'none',dependsOn:['a'],inputArtifacts:['lazy/a/out']}
]});
const init=await initializeV3Run({trustedRoot:root,runDir,graph,sessionId:'fixture',supervisorEpoch:'epoch',sourceCwd:source,runInstanceId:'lazy-instance'});
const mock=new MockSubagents();mock.start();let proof;
mock.behaviors.set('PRODUCER',input=>completeChild({...input,output}));
mock.behaviors.set('CONSUMER',async input=>{
 const prompt=String(input.params.task),material=path.join(input.cwd,'.pi-graph','inputs','lazy/a/out'),relative='.pi-graph/inputs/lazy/a/out';
 const before=fs.readFileSync(material,'utf8');assert.equal(before,output,'product copied accepted artifact must retain exact bytes');
 if(mode==='single-line'){
  assert.ok(!prompt.includes('"reference"'),'unpageable >50KiB single-line artifact must stay conservatively inline');
  proof={mode,reference:false,toolCalls:0};await completeChild({...input,output:'conservative inline fixture'});return;
 }
 assert.ok(prompt.includes(relative));assert.ok(prompt.includes('"reference"'));assert.ok(!prompt.includes(tail),'initial dispatched task must not inline long output suffix');
 if(mode==='pre-tamper')fs.writeFileSync(material,tamper+'\n');
 const collected=new Map(),contexts=[];let streamCalls=0,toolCalls=0,lastOffset=1,finished=false,guardPassed=0,mutationApplied=false;
 const faux=createFauxCore({provider:'local-fixture',api:'local-fixture',models:[{id:'fixture'}]});
 faux.setResponses(Array.from({length:20},()=>async context=>{
  streamCalls++;contexts.push(structuredClone(context));
  if(mode==='unread')return fauxAssistantMessage('No material needed.');
  if(streamCalls>1){
   const result=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='read');assert.ok(result);
   if(mode.includes('tamper')){assert.equal(result.isError,true,'tamper must be redacted into explicit tool error');assert.match(JSON.stringify(result.content),/Graph input integrity check failed/);assert.ok(!JSON.stringify(context).includes(tamper));assert.ok(!JSON.stringify(context).includes(tail));finished=true;return fauxAssistantMessage('Integrity rejection acknowledged.');}
   assert.notEqual(result.isError,true);const text=result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
   for(const line of text.split('\n'))if(/^\[L\d{4}\]/.test(line))collected.set(line.slice(0,7),line);
   if(collected.size===lines.length){finished=true;return fauxAssistantMessage('Material fully read.');}
   lastOffset+=25;
  }
  return fauxAssistantMessage(fauxToolCall('read',{path:relative,offset:lastOffset,limit:25}),{stopReason:'toolUse'});
 }));
 const factory=createDefaultChildSessionFactory({loadPiCodingAgent:async()=>{
  const sdk=await import(SDK+'/dist/index.js');return {...sdk,ModelRuntime:{create:async()=>{
   const rt=await sdk.ModelRuntime.create({authPath:path.join(root,'auth.json'),modelsPath:null,modelsStorePath:path.join(root,'models.json'),allowModelNetwork:false,refreshOnCreate:false});await rt.setRuntimeApiKey('openai','fixture-no-network');return rt;
  }},createAgentSession:async options=>{const result=await sdk.createAgentSession(options);result.session.agent.streamFunction=faux.streamSimple;return result;}};
 }});
 let session;
 try{
  const preResult=mode==='post-tamper'?[{name:'tamper-before-result-check',factory:pi=>pi.on('tool_result',event=>{if(event.toolName==='read'){mutationApplied=true;fs.writeFileSync(material,tamper+'\n');}})}]:[];
  const postCall=[{name:'observe-passed-guard-and-race',factory:pi=>pi.on('tool_call',event=>{if(event.toolName==='read'){guardPassed++;if(mode==='race-tamper'){mutationApplied=true;fs.writeFileSync(material,tamper+'\n');}}})}];
  session=await factory.create({cwd:input.cwd,storage:{kind:'dir',sessionDir:path.join(root,'consumer-session')},model:'openai/gpt-4o',tools:['read','graph_mailbox'],extensionPaths:[],ambientExtensions:false,
   hooks:[...preResult,{name:'actual-guard',factory:guard},...postCall],noSkills:true,noContextFiles:true,runtime:{},
   processEnv:{PI_GRAPH_CHILD:'1',PI_GRAPH_EXTENSION_BINDINGS:JSON.stringify(input.params.extensionBindings)},onExtensionError:event=>{throw event.error;}});
  session.subscribe(event=>{if(event.type==='tool_execution_start'&&event.toolName==='read')toolCalls++;});
  await session.prompt(prompt);
  if(mode==='unread'){assert.equal(toolCalls,0);assert.ok(contexts.every(context=>!JSON.stringify(context).includes(tail)));}
  else if(mode.includes('tamper')){assert.equal(finished,true);assert.equal(toolCalls,1);if(mode!=='pre-tamper'){assert.equal(guardPassed,1,'valid material must pass original permission/precheck before injected race');assert.equal(mutationApplied,true,'specified runtime mutation hook must actually execute');}}
  else{assert.equal(finished,true,JSON.stringify({toolCalls,streamCalls,collected:collected.size,lastResults:session.messages.filter(m=>m.role==='toolResult').slice(-2).map(m=>({isError:m.isError,text:m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n').slice(0,500)})),assistantErrors:session.messages.filter(m=>m.role==='assistant'&&m.errorMessage).map(m=>m.errorMessage)}));assert.ok(toolCalls>=5);const text=[...collected.values()].join('\n')+'\n';assert.equal(text,output);assert.equal(createHash('sha256').update(text).digest('hex'),createHash('sha256').update(before).digest('hex'));}
  proof={mode,reference:true,toolCalls,streamCalls,guardPassed,mutationApplied,promptContainsTail:prompt.includes(tail),readFull:mode==='lazy'};
  await completeChild({...input,output:'SDK consumer validated '+mode});
 }finally{if(session){await session.abort().catch(()=>{});await session.dispose();}await factory.dispose();}
});
const runner=new V3GraphRunner({rpc:new SubagentRpcClient(mock),runDir,graph,authorization:init.authorization,sourceCwd:source,sessionId:'fixture',supervisorEpoch:'epoch',preflightAgent:async()=>{}});
try{
 const snapshot=await runner.run();assert.equal(snapshot.status,'complete',JSON.stringify({status:snapshot.status,nodes:snapshot.nodes}));assert.equal(mock.spawned.length,2);assert.ok(proof);
 console.log('PASS actual runner accepted artifact -> guarded SDK lazy '+mode);console.log('LAZY_PROOF '+JSON.stringify(proof));
}finally{await mock.dispose();}
