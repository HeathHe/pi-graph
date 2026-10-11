import { V3GraphHost } from "../src/v3/host.ts";
import assert from 'node:assert/strict';
import { createJiti } from "jiti";
import test from 'node:test';
import { Check } from 'typebox/value';
import {mkdir,mkdtemp,realpath,readFile,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {classifyProviderFailure,runtimeRecoveryEvidence} from '../src/v3/failure-policy.ts';
import {summarizeUsage,reportedTotalTokens,summarizeMainSession} from '../src/v3/usage-summary.ts';
import {readGraphResult,graphResultReceipt,boundedGraphToolResult} from '../src/v3/result-receipt.ts';
import {buildV3DependencyCapsule} from '../src/v3/capsule.ts';
import {bindGraphSpecV3} from '../src/v3/binding.ts';
import {compileGraphSpecV3} from '../src/v3/compiler.ts';
import {initializeV3Run} from '../src/v3/initialize.ts';
import {V3GraphRunner} from '../src/v3/runner.ts';
import {SubagentRpcClient,subagentAsyncRoot} from '../src/v3/rpc.ts';
import {readLatestV3Attempt,v3NodeAttemptDir} from '../src/v3/attempt.ts';
import {canonicalDigest} from '../src/v3/digests.ts';
import {MockSubagents,completeChild,failChild} from './helpers/mock-subagents.ts';
import type {GraphSpecV3,V3AttemptEvidence} from '../src/v3/types.ts';

async function run(nodes:GraphSpecV3['nodes'],behaviors:Record<string,Parameters<MockSubagents['behaviors']['set']>[1]>) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'graph-optimization-')));const sourceDir=join(root,'source');await mkdir(sourceDir);const runDir=join(root,'test');
 const graph=compileGraphSpecV3({schemaVersion:3,graphId:'test',goal:'verify',nodes});
 const init=await initializeV3Run({trustedRoot:root,runDir,graph,sessionId:'test-session',supervisorEpoch:'epoch',sourceCwd:sourceDir,runInstanceId:'instance'});
 const mock=new MockSubagents();mock.start();for(const [key,value] of Object.entries(behaviors))mock.behaviors.set(key,value);
 const runner=new V3GraphRunner({rpc:new SubagentRpcClient(mock),runDir,graph,authorization:init.authorization,sourceCwd:sourceDir,sessionId:'test-session',supervisorEpoch:'epoch',preflightAgent:async()=>{}});
 const snapshot=await runner.run();return {root,runDir,mock,snapshot};
}
const producer={taskId:'a',agent:'agent',task:'PRODUCER',sideEffect:'none' as const};

test('receipt preserves >64KiB Unicode suffix through public paged result and bounds all envelopes',async()=>{
 const output='中文😀\\\"'.repeat(14000)+'UNIQUE-END';
 const f=await run([producer],{PRODUCER:input=>completeChild({...input,output})});
 assert.equal(f.snapshot.status,'complete');let full='',offset:number|null=0;
 while(offset!==null){const page=await readGraphResult(f.root,'test','a',undefined,offset,8192);full+=page.text;offset=page.nextOffset;assert.equal(page.complete,true);assert.ok(Buffer.byteLength(JSON.stringify(page))<8000);}
 assert.equal(full,output);assert.equal((await readGraphResult(f.root,'test','a')).sha256,createHash('sha256').update(output).digest('hex'));
 const receipt=await graphResultReceipt(f.snapshot,f.root);assert.ok(Buffer.byteLength(JSON.stringify(boundedGraphToolResult(receipt.text,receipt.details)))<12500);
 for(const waitReason of ['graph_settled','attention_required','aborted','status','retry']) {
  const nodes=Object.fromEntries(Array.from({length:512},(_,i)=>['n'+i,{phase:'accepted',detail:output,output}]));
  const result=boundedGraphToolResult(output,{snapshot:{...f.snapshot,nodes},waitReason});
  assert.ok(Buffer.byteLength(JSON.stringify(result))<12500);assert.ok(!JSON.stringify(result.details).includes('UNIQUE-END'));
 }
 await f.mock.dispose();
});

test('result detects rewritten native payload even with self-recomputed digest',async()=>{
 const f=await run([producer],{PRODUCER:input=>completeChild({...input,output:'original'})});
 const path=join(v3NodeAttemptDir(f.runDir,'a',1),'child-result.json');const raw=JSON.parse(await readFile(path,'utf8'));raw.completion.results[0].finalOutput='altered';raw.digest=canonicalDigest({completion:raw.completion,status:raw.status});await writeFile(path,JSON.stringify(raw));
 await assert.rejects(readGraphResult(f.root,'test','a'),/attempt-bound digest/);assert.equal(f.mock.spawned.length,1);await f.mock.dispose();
});

test('failed child yields recovery evidence with no fresh dispatch and never claims complete output',async()=>{
 const f=await run([producer],{PRODUCER:failChild});const page=await readGraphResult(f.root,'test','a');assert.notEqual(page.complete,true);assert.equal(page.text,'synthetic failure');assert.equal((page.recovery as any).freshReplayAllowed,false);assert.equal(f.mock.spawned.length,1);await f.mock.dispose();
});

test('usage deduplicates child projections and counts retry children by actual model with unknown coverage',()=>{
 const make=(attempt:number,asyncId:string,model:string|undefined,usage:any):V3AttemptEvidence=>({graphId:'g',taskId:'n',attempt,dispatch:{} as any,child:{observation:{asyncId,actualModel:model,requestedModel:'wrong',observedAt:String(attempt),usage}}} as any);
 const rows=[make(1,'c1','actual/one',{inputTokens:10,outputTokens:2,costUsd:0}),make(1,'c1','actual/one',{inputTokens:10,outputTokens:2,costUsd:0}),make(2,'c2','actual/two',{inputTokens:5}),make(3,'c3',undefined,undefined)];
 const usage=summarizeUsage(rows);assert.equal(usage.childRuns,3);assert.equal(usage.byActualModel['actual/one']!.totalTokens!.known,12);assert.equal(usage.byActualModel['actual/two']!.totalTokens!.complete,false);assert.equal(usage.main.status,'unknown');assert.equal(usage.byActualModel.unknown!.costUsd!.missing,1);
 for(const u of [{inputTokens:1},{totalTokens:NaN},{inputTokens:-1,outputTokens:2}])assert.equal(reportedTotalTokens(u),undefined);
});

test('typed selectors exclude unselected prose and fail missing/type/oversized values',()=>{
 const node={dependsOn:['a'],dependencyInputs:[{from:'a',field:'status' as const,type:'string' as const,as:'gate'}]};
 const result=buildV3DependencyCapsule(node,{a:{status:'accepted',detail:'SECRET-UNSELECTED',structured:{status:'pass',reason:'UNSELECTED'}}});assert.deepEqual(result[0]!.fields,{gate:'pass'});assert.ok(!JSON.stringify(result).includes('UNSELECTED'));
 for(const structured of [{}, {status:42},{status:'x'.repeat(14000)}])assert.throws(()=>buildV3DependencyCapsule(node,{a:{status:'accepted',structured}}));
});

test('typed artifact handoff actually reads accepted long file from consumer workspace',async()=>{
 let readBack='';let prompt='';const report='long report '.repeat(9000)+'TAIL';
 const f=await run([{...producer,resultContract:'status-json',evidenceFiles:[{path:'report.txt',nonSecret:true}]},{taskId:'b',agent:'agent',task:'CONSUMER',sideEffect:'none',dependsOn:['a'],inputArtifacts:['test/a/out'],dependencyInputs:[{from:'a',field:'status',type:'string',as:'gate'},{from:'a',field:'evidenceFiles',type:'artifact-list',as:'files'}]}],{
 PRODUCER:input=>completeChild({...input,output:JSON.stringify({status:'pass',reason:'UNSELECTED-REASON'}),writes:[{path:'report.txt',content:report}]}),
 CONSUMER:async input=>{prompt=String(input.params.task);readBack=await readFile(join(input.cwd,'.pi-graph/inputs/test/a/out.files/report.txt'),'utf8');await completeChild({...input,output:'read verified'});}
 });assert.equal(f.snapshot.status,'complete');assert.equal(readBack,report);assert.ok(prompt.includes('.pi-graph/inputs/test/a/out.files/report.txt'));assert.ok(!prompt.includes('UNSELECTED-REASON'));await f.mock.dispose();
});

test('missing typed producer contract stops consumer before dispatch',async()=>{
 const f=await run([producer,{taskId:'b',agent:'agent',task:'CONSUMER',sideEffect:'none',dependsOn:['a'],dependencyInputs:[{from:'a',field:'status',type:'string',as:'gate'}]}],{PRODUCER:input=>completeChild({...input,output:'not typed'})});assert.equal(f.mock.spawned.length,1);assert.notEqual(f.snapshot.status,'complete');await f.mock.dispose();
});

const catalog={schemaVersion:1,capabilities:[{capabilityId:'first',agent:'primary',modelPolicy:{mode:'fixed',model:'p/one'}},{capabilityId:'backup',agent:'backup',modelPolicy:{mode:'fixed',model:'q/two'}}]};
const fallbackSpec={schemaVersion:3,graphId:'fallback',goal:'test',nodes:[{taskId:'a',agent:'primary',fallbackAgents:['backup'],task:'bounded',sideEffect:'none'}]};
function preflight(message:string,seen:string[],tools=['read']) {return async(input:any):Promise<any>=>{seen.push(input.agent);return input.agent==='primary'?{ok:false,message}:{ok:true,name:input.agent,agentDefinitionDigest:'a'.repeat(64),launchContractDigest:'b'.repeat(64),model:input.agent==='backup'?'q/two':'p/one',modelCandidates:[input.agent==='backup'?'q/two':'p/one'],explicitToolAllowlist:true,toolAllowlist:tools,extensions:{runtimeExtensions:[],configuredExtensions:[],extensionArgs:[],disableAmbientExtensions:true}};};}

test('explicit fixed-role fallback selects backup only for trusted eligible preflight error',async()=>{
 const seen:string[]=[];const bound=await bindGraphSpecV3(fallbackSpec,{catalog,parentToolAllowlist:['read'],preflightAgent:preflight('HTTP 429 rate limit exceeded',seen)});assert.deepEqual(seen,['primary','backup']);assert.equal(bound.spec.nodes[0]!.agent,'backup');assert.equal(bound.spec.nodes[0]!.launch!.resolvedModel,'q/two');assert.ok(bound.spec.nodes[0]!.binding!.agentDefinitionDigest);
});
for(const message of ['unknown issue','validation failed','tool error 429','aborted','poor answer'])test(`preflight refuses fallback for ${message}`,async()=>{
 const seen:string[]=[];await assert.rejects(bindGraphSpecV3(fallbackSpec,{catalog,parentToolAllowlist:['read'],preflightAgent:preflight(message,seen)}));assert.deepEqual(seen,['primary']);
});
test('backup cannot elevate tool permission',async()=>{await assert.rejects(bindGraphSpecV3(fallbackSpec,{catalog,parentToolAllowlist:['read'],preflightAgent:preflight('HTTP 401 unauthorized',[],['read','bash'])}),/ceiling/);});
test('provider classification never grants replay without authoritative pre-activity proof',()=>{
 for(const message of ['429 rate limited','401 unauthorized','quota exhausted','model unavailable','provider unavailable']){assert.equal(classifyProviderFailure(message).eligible,true);assert.equal(runtimeRecoveryEvidence(message,'a',1).freshReplayAllowed,false);}
 for(const message of ['', 'timeout','user aborted','validation failed','bad response'])assert.equal(classifyProviderFailure(message).eligible,false);
});


test('main session metadata adapter deduplicates actual-model entries and separates compaction unknown model',()=>{
 const message={type:"message",id:"m1",message:{role:"assistant",provider:"actual",model:"model",usage:{input:10,output:2,totalTokens:12,cost:{total:0}}}};
 const result=summarizeMainSession({getSessionId:()=>"session",getEntries:()=>[message,message,{type:"compaction",id:"c1",usage:{input:2,output:1}}, {type:"message",message:{role:"assistant"}}]});
 assert.equal(result.status,"observed");assert.equal(result.entries,2);assert.equal(result.missingIdentity,1);assert.equal(result.byActualModel?.["actual/model"]?.totalTokens?.known,12);assert.equal(result.byActualModel?.unknown?.costUsd?.missing,1);assert.equal(result.categories?.compaction,1);
 assert.equal(summarizeMainSession({getEntries:()=>[]}).status,"unknown");
});
test('provider numbers in ordinary diagnostics and paths are not provider evidence',()=>{
 for(const message of ['parse response 429 bytes','missing file /tmp/401.md','HTTP 403 WAF blocked','tool error HTTP 429','task asked to check /tmp/429'])assert.equal(classifyProviderFailure(message).eligible,false);
});
test('usage model names are data and arithmetic overflow remains unknown',()=>{
 const rows=['__proto__','constructor'].map((actualModel,i)=>({graphId:'g',taskId:'n',attempt:1,dispatch:{},observation:{asyncId:String(i),observedAt:'',actualModel,usage:{inputTokens:Number.MAX_VALUE,outputTokens:Number.MAX_VALUE}}} as any));
 const usage=summarizeUsage(rows);assert.equal(usage.byActualModel.__proto__!.totalTokens!.complete,false);assert.equal(usage.byActualModel["constructor"]!.totalTokens!.complete,false);
});


test('native result persistence failure reports unavailable evidence and never redispatches',async()=>{
 const f=await run([producer],{PRODUCER:async input=>{
  const contract=JSON.parse(await readFile(join(input.cwd,".pi-graph/node-contract.json"),"utf8"));
  await mkdir(join(contract.attemptDir,"child-result.json"));
  await completeChild({...input,output:"original answer before failed persistence"});
 }});
 assert.notEqual(f.snapshot.status,"complete");assert.equal(f.mock.spawned.length,1);
 const receipt=await graphResultReceipt(f.snapshot,f.root);assert.match(receipt.text,/unavailable/);assert.equal(f.mock.spawned.length,1);await f.mock.dispose();
});

test('registered public graph tool reads full result pages and main usage metadata',async()=>{
 const output='English中文😀'.repeat(9000)+'"'.repeat(10000)+'\\'.repeat(10000)+'\u0000'.repeat(1000)+'PUBLIC-END';
 const f=await run([producer],{PRODUCER:input=>completeChild({...input,output})});
 const home=join(f.root,'agent-home');await mkdir(home);await writeFile(join(home,'settings.json'),JSON.stringify({graph:{enabled:true,runsDir:f.root}}));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=home;
 try {
  const module=createJiti(import.meta.url)(new URL('../extensions/pi-graph.ts',import.meta.url).href);let tool:any;let parentMessages=0;
  module.default({events:f.mock,on(){},registerCommand(){},registerTool(t:any){tool=t;},sendMessage(){parentMessages++;},getActiveTools:()=>['read','graph']});
  const ctx={cwd:f.root,mode:'json',sessionManager:{getSessionId:()=>"test-session",getEntries:()=>[{type:'message',id:'entry',message:{role:'assistant',provider:'actual',model:'main',usage:{input:3,output:1,totalTokens:4,cost:{total:0}}}}],getSessionFile:()=>undefined},modelRegistry:{getAvailable:()=>[]},ui:{notify(){}}};
  assert.equal(Check(tool.parameters,{action:'result',id:'test',limit:8192}),true);
  assert.equal(Check(tool.parameters,{action:'result',id:'test',limit:18000}),false);
  assert.match(tool.parameters.properties.limit.description,/default 4096, maximum 8192/);
  assert.match(tool.description,/default limit 4096, maximum 8192/);
  let full='',offset:number|null=0;let next:any={action:'result',id:'test',node:'a'};let pages=0;
  while(next!==null){assert.equal(Check(tool.parameters,next),true);const response=await tool.execute('read',next,undefined,undefined,ctx);assert.notEqual(response.isError,true,JSON.stringify(response));assert.ok(Buffer.byteLength(JSON.stringify(response))<12500);const page=JSON.parse(response.content[0].text);assert.equal(page.offset,Array.from(full).length);full+=page.text;pages++;if(page.nextRequest!==null)assert.deepEqual(page.nextRequest,{action:'result',id:'test',node:'a',attempt:1,offset:page.nextOffset,limit:4096,expectedSha256:page.sha256});else assert.equal(page.nextOffset,null);next=page.nextRequest;}
  assert.ok(pages>1);
  for(const action of ['result','attention']){const response=await tool.execute('small',{action,id:'test',...(action==='result'?{node:'a'}:{}),limit:1},undefined,undefined,ctx);assert.notEqual(response.isError,true);const page=JSON.parse(response.content[0].text);assert.equal(Array.from(page.text).length,1);assert.equal(page.nextRequest.limit,1);assert.equal(page.nextRequest.offset,1);}
  assert.equal(full,output);
  const response=await tool.execute('usage',{action:'usage',id:'test'},undefined,undefined,ctx);assert.notEqual(response.isError,true,JSON.stringify(response));const page=JSON.parse(response.content[0].text);const usage=JSON.parse(page.text);assert.equal(usage.mainSession.byActualModel['actual/main'].totalTokens.known,4);
  // Real Graph mailbox decision; the public attention view and reply use the same store.
  const jiti=createJiti(import.meta.url);
  const {GraphMailbox}=jiti(new URL('../src/v3/mailbox.ts',import.meta.url).href);
  const {activeMailboxes,mailboxRegistryKey}=jiti(new URL('../src/v3/mailbox-runtime.ts',import.meta.url).href);
  const {acquireV3RunLease}=await import('../src/v3/lease.ts');
  const lease=await acquireV3RunLease(join(f.runDir,'lease.json'),'instance');
  try {
   const store=new GraphMailbox(f.runDir,lease,async()=>true);await store.initialize('instance','test-session',[]);
   const latest=(await readLatestV3Attempt(f.runDir,'a'))!.evidence;
   const {terminalStatus:_terminal,acceptanceDigest:_acceptance,child:_child,...basis}=latest;
   await writeFile(join(v3NodeAttemptDir(f.runDir,'a',1),'attempt.json'),JSON.stringify({...basis,phase:'running',observation:{...latest.observation,resolvedAgent:'agent'}}));
   await store.admit([{taskId:'b',attempt:1}]);
   activeMailboxes.set(mailboxRegistryKey(f.runDir),{mailbox:store,owner:'test-session',runInstanceId:'instance'});
   await store.request(await store.capability('a',1),{action:'send',to:'b',text:'peer only',idempotencyKey:'peer'});
   let waitDone=false;const waitAbort=new AbortController();const waiting=tool.execute('wait',{action:'wait',id:'test'},waitAbort.signal,undefined,ctx).then((value:any)=>{waitDone=true;return value;});
   await new Promise(r=>setTimeout(r,200));assert.equal(waitDone,false);assert.equal(parentMessages,0);
   const text='"'.repeat(8000)+'QUESTION-END';const request=await store.request(await store.capability('a',1),{action:'send',to:'@parent',kind:'decision',text,idempotencyKey:'public-decision'});
   activeMailboxes.set(mailboxRegistryKey(f.runDir),{mailbox:store,owner:'test-session',runInstanceId:'instance'});
   const waitResult=await waiting;assert.equal(waitResult.details.waitReason,'attention_required');assert.equal(parentMessages,0);
   let attentionText='';offset=0;
   next={action:'attention',id:'test',limit:8192};while(next!==null){assert.equal(Check(tool.parameters,next),true);const response=await tool.execute('attention',next,undefined,undefined,ctx);assert.notEqual(response.isError,true,JSON.stringify(response));assert.ok(Buffer.byteLength(JSON.stringify(response))<12500);const page=JSON.parse(response.content[0].text);assert.equal(page.offset,Array.from(attentionText).length);attentionText+=page.text;if(page.nextRequest!==null)assert.deepEqual(page.nextRequest,{action:'attention',id:'test',offset:page.nextOffset,limit:8192,expectedSha256:page.sha256});else assert.equal(page.nextOffset,null);next=page.nextRequest;}
   const attention=JSON.parse(attentionText);assert.equal(attention.requests[0].requestId,request.messageId);assert.equal(attention.requests[0].message,text.slice(0,1000));assert.match(attention.requests[0].replyHint,/mailbox/);
   let body='';offset=0;while(offset!==null){const response=await tool.execute('mailbox',{action:'mailbox',id:'test',mailbox:{action:'read',messageId:request.messageId,offset}},undefined,undefined,ctx);assert.notEqual(response.isError,true,JSON.stringify(response));const page=JSON.parse(response.content[0].text);body+=page.text;offset=page.nextOffset;}assert.equal(body,text);
   const replied=await tool.execute('mailbox',{action:'mailbox',id:'test',mailbox:{action:'reply',messageId:request.messageId,text:'decision',idempotencyKey:'answer'}},undefined,undefined,ctx);assert.notEqual(replied.isError,true,JSON.stringify(replied));
   assert.equal((await store.request(await store.capability('a',1),{action:'receive'})).messages.length,1);
   const short=boundedGraphToolResult('attention',{snapshot:f.snapshot,stopRequested:true,supervisorRequests:attention.requests});assert.equal(short.details.attentionRead.action,'attention');assert.equal(short.details.stopRequested,true);
  } finally {activeMailboxes.delete(mailboxRegistryKey(f.runDir));await lease.release();}

 }finally{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await f.mock.dispose();}
});


test('failed diagnostic metadata and escaped page survive the final JSON envelope',async()=>{
 const f=await run([producer],{PRODUCER:failChild});const directory=v3NodeAttemptDir(f.runDir,'a',1);
 const raw=JSON.parse(await readFile(join(directory,'child-result.json'),'utf8'));
 const output='"'.repeat(20000);raw.completion.results[0].finalOutput=output;raw.digest=canonicalDigest({completion:raw.completion,status:raw.status});await writeFile(join(directory,'child-result.json'),JSON.stringify(raw));
 const evidence=(await readLatestV3Attempt(f.runDir,'a'))!.evidence;evidence.child!.fullOutputDigest=createHash('sha256').update(output).digest('hex');evidence.failure!.message='\u0000'.repeat(500);await writeFile(join(directory,'attempt.json'),JSON.stringify(evidence));
 let combined='',offset:number|null=0;while(offset!==null){const page=await readGraphResult(f.root,'test','a',1,offset,8192);const envelope=boundedGraphToolResult(JSON.stringify(page),{graphId:'test',nextOffset:page.nextOffset});assert.ok(Buffer.byteLength(JSON.stringify(envelope))<12500);const decoded=JSON.parse(envelope.content[0]!.text);combined+=decoded.text;offset=decoded.nextOffset;}
 assert.equal(combined,output);
 await unlink(join(directory,'child-result.json'));evidence.child!.output='legacy [output truncated]';await writeFile(join(directory,'attempt.json'),JSON.stringify(evidence));assert.equal((await readGraphResult(f.root,'test','a')).complete,false);
 await mkdir(join(f.runDir,'nodes/a/attempts/2'));const receipt=await graphResultReceipt(f.snapshot,f.root);assert.equal(receipt.usage.evidenceComplete,false);assert.equal(receipt.usage.missingEvidenceNodes,1);
 await f.mock.dispose();
});


test('completed local write cannot fresh-retry and original accepted output remains readable',async()=>{
 const f=await run([{...producer,sideEffect:'local_write',writeScope:[{kind:'file',path:'out.txt'}],validationCommands:['test -f out.txt']}],{PRODUCER:input=>completeChild({...input,output:'done once',writes:[{path:'out.txt',content:'once'}]})});
 assert.equal(f.snapshot.status,'complete');const host=new V3GraphHost({rpc:new SubagentRpcClient(f.mock),runsDir:f.root,sessionId:'test-session',supervisorEpoch:'retry',preflightAgent:async()=>{}});
 await assert.rejects(host.retry('test','a'),/remaining work|external effects/);assert.equal(f.mock.spawned.length,1);assert.equal((await readGraphResult(f.root,'test','a')).text,'done once');await f.mock.dispose();
});

test('legacy communication is read-only: status/result retained and resume/retry refuse before mutation',async()=>{const f=await run([{...producer,readOnly:true}],{PRODUCER:input=>completeChild({...input,output:'legacy result'})});try{await unlink(join(f.runDir,'communication.json'));const before=await readFile(join(f.runDir,'snapshot.json'),'utf8');const host=new V3GraphHost({rpc:new SubagentRpcClient(f.mock),runsDir:f.root,sessionId:'test-session',supervisorEpoch:'legacy',preflightAgent:async()=>{}});assert.equal((await host.status('test')).status,'complete');await assert.rejects(host.resume('test'),/read-only/);await assert.rejects(host.retry('test','a'),/read-only/);assert.equal(await readFile(join(f.runDir,'snapshot.json'),'utf8'),before);assert.equal(f.mock.spawned.length,1);assert.equal((await readGraphResult(f.root,'test','a')).text,'legacy result');}finally{await f.mock.dispose();}});


test('result nextRequest pins the selected attempt when a newer attempt appears',async()=>{
 const output='原始😀'.repeat(1500);const f=await run([producer],{PRODUCER:input=>completeChild({...input,output})});
 const home=join(f.root,'agent-home');await mkdir(home);await writeFile(join(home,'settings.json'),JSON.stringify({graph:{enabled:true,runsDir:f.root}}));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=home;
 try {
  const module=createJiti(import.meta.url)(new URL('../extensions/pi-graph.ts',import.meta.url).href);let tool:any;
  module.default({events:f.mock,on(){},registerCommand(){},registerTool(t:any){tool=t;},getActiveTools:()=>['read','graph']});
  const ctx={cwd:f.root,mode:'json',sessionManager:{getSessionId:()=>"test-session",getEntries:()=>[],getSessionFile:()=>undefined},modelRegistry:{getAvailable:()=>[]},ui:{notify(){}}};
  const read=async(params:any)=>{assert.equal(Check(tool.parameters,params),true);const response=await tool.execute('pin',params,undefined,undefined,ctx);assert.notEqual(response.isError,true);assert.ok(Buffer.byteLength(JSON.stringify(response))<12500);return JSON.parse(response.content[0].text);};
  const first=await read({action:'result',id:'test',node:'a',limit:1});assert.equal(first.nextRequest!.attempt,1);
  const original=(await readLatestV3Attempt(f.runDir,'a'))!.evidence;
  const directory=v3NodeAttemptDir(f.runDir,'a',2);await mkdir(directory);await writeFile(join(directory,'attempt.json'),JSON.stringify({...original,attempt:2,phase:'failed',child:{...original.child,output:'NEW ATTEMPT',fullOutputDigest:undefined}}));
  assert.equal((await readGraphResult(f.root,'test','a')).text,'NEW ATTEMPT');
  const next=first.nextRequest!;const second=await read(next);
  assert.equal(first.text+second.text,Array.from(output).slice(0,2).join(''));assert.equal(second.sha256,first.sha256);assert.equal(f.mock.spawned.length,1);
 }finally{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await f.mock.dispose();}
});
