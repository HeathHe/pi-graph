import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const T=process.env.PI_GRAPH_FIXTURE_EVIDENCE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(),'graph-supervisor-evidence-')),G=fileURLToPath(new URL('../..',import.meta.url));
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'graph-supervisor-sdk-')));
process.env.PI_CODING_AGENT_DIR=path.join(root,'agent');process.env.PI_GRAPH_RUNTIME_ROOT=path.join(root,'native');fs.mkdirSync(process.env.PI_CODING_AGENT_DIR,{recursive:true});
const runsDir=path.join(root,'graphs');fs.mkdirSync(runsDir);fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'settings.json'),JSON.stringify({graph:{runsDir}}));
import {SDK,AI} from './supervisor-sdk-loader.mjs';
const {createDefaultChildSessionFactory}=await import('./owned-sdk-factory.mjs');
const {createFauxCore,fauxAssistantMessage,fauxToolCall}=await import(AI+'/dist/providers/faux.js');
const {createJiti}=await import(G+'/node_modules/jiti/lib/jiti.mjs');const jiti=createJiti(import.meta.url);
const graphExtension=(await jiti.import(G+'/extensions/pi-graph.ts')).default;
const {compileGraphSpecV3}=await jiti.import(G+'/src/v3/compiler.ts');const {initializeV3Run}=await jiti.import(G+'/src/v3/initialize.ts');const A=await jiti.import(G+'/src/v3/attempt.ts');
const {subagentAsyncRoot}=await jiti.import(G+'/src/v3/rpc.ts');
const {GraphMailbox}=await jiti.import(G+'/src/v3/mailbox.ts');
const {MailboxBroker}=await jiti.import(G+'/src/v3/mailbox-transport.ts');
const {registerGraphMailboxTool}=await jiti.import(G+'/src/v3/mailbox-client.ts');
const {activeMailboxes,mailboxRegistryKey}=await jiti.import(G+'/src/v3/mailbox-runtime.ts');
const {acquireV3RunLease}=await jiti.import(G+'/src/v3/lease.ts');
const factory=createDefaultChildSessionFactory({loadPiCodingAgent:()=>import(SDK+'/dist/index.js')});
const evidence=[];const record=(who,e)=>{if(['tool_execution_start','tool_execution_end'].includes(e.type)){const row={who,type:e.type,toolName:e.toolName,toolCallId:e.toolCallId,...(e.type==='tool_execution_end'?{result:e.result}:{args:e.args})};evidence.push(row);fs.appendFileSync(T+'/sdk-tools-only.jsonl',JSON.stringify(row)+'\n');}};
fs.writeFileSync(T+'/sdk-tools-only.jsonl','');
let broker,lease,mailbox,parent,child,owner,parentStep=0,childStep=0,pendingId,graphId='sdk-supervisor',asked=false,abortScenario=false,childStarted=false,childAbortObserved=false,parentPi;
const asyncId='sdk-child-'+Date.now(),runDir=path.join(runsDir,graphId),asyncDir=path.join(subagentAsyncRoot(),asyncId);
const model={id:'test',name:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
function provider(role){return {name:'provider-'+role,factory:pi=>{const faux=createFauxCore({provider:'fixture-'+role,api:'fixture-'+role,models:[model]});faux.setResponses(Array.from({length:12},()=>async (ctx,options)=>{
 if(role==='child'&&abortScenario){childStarted=true;await new Promise(resolve=>{options.signal.addEventListener('abort',()=>{childAbortObserved=true;resolve();},{once:true});});return fauxAssistantMessage('fixture child explicitly stopped');}
 if(role==='parent'){
  if(parentStep++===0)return fauxAssistantMessage(fauxToolCall('graph',{action:'wait',id:graphId}),{stopReason:'toolUse'});
  if(parentStep===2){const result=ctx.messages.findLast(m=>m.role==='toolResult'&&m.toolName==='graph');assert.equal(result.details.waitReason,'attention_required');pendingId=result.details.supervisorRequests[0].requestId;return fauxAssistantMessage(fauxToolCall('graph',{action:'mailbox',id:graphId,mailbox:{action:'reply',messageId:pendingId,text:'Proceed with fixture proof',idempotencyKey:'parent-reply'}}),{stopReason:'toolUse'});}
  if(parentStep===3)return fauxAssistantMessage(fauxToolCall('graph',{action:'wait',id:graphId}),{stopReason:'toolUse'});
  return fauxAssistantMessage('Parent observed settled graph');
 }
 const step=childStep++;
 if(step===0){asked=true;return fauxAssistantMessage(fauxToolCall('graph_mailbox',{action:'send',to:'@parent',kind:'decision',text:'Fixture decision?',idempotencyKey:'child-decision'}),{stopReason:'toolUse'});}
 const result=ctx.messages.findLast(m=>m.role==='toolResult'&&m.toolName==='graph_mailbox');assert.ok(result&&!result.isError);const value=JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));
 if(step===1)return fauxAssistantMessage(fauxToolCall('graph_mailbox',{action:'wait'}),{stopReason:'toolUse'});
 if(step===2){assert.equal(value.messages[0].from,'@parent');return fauxAssistantMessage(fauxToolCall('graph_mailbox',{action:'read',messageId:value.messages[0].messageId}),{stopReason:'toolUse'});}
 assert.equal(value.text,'Proceed with fixture proof');return fauxAssistantMessage('Child continued after actual mailbox reply');
}));pi.registerProvider('fixture-'+role,{baseUrl:'http://127.0.0.1:1',apiKey:'fixture',api:faux.api,models:faux.models,streamSimple:faux.streamSimple});}};}
const launch=(role,hooks,tools)=>({cwd:root,storage:{kind:'dir',sessionDir:path.join(root,role)},model:'fixture-'+role+'/test',tools,extensionPaths:[],ambientExtensions:false,hooks:[provider(role),...hooks],noSkills:true,noContextFiles:true,runtime:{},processEnv:{PI_GRAPH_CHILD:undefined,PI_GRAPH_EXTENSION_BINDINGS:undefined},onExtensionError:e=>{throw e.error}});
try{
 parent=await factory.create(launch('parent',[{name:'graph-real',factory:graphExtension},{name:'owner-capture',factory:pi=>{
  parentPi=pi;pi.on('session_start',(_e,ctx)=>{owner=ctx.sessionManager.getSessionId();});
 }}],['graph']));parent.subscribe(e=>record('parent',e));
 const graph=compileGraphSpecV3({schemaVersion:3,graphId,goal:'Real public WAIT/mailbox/SDK roundtrip',nodes:[{taskId:'work',agent:'worker',task:'Fixture question',sideEffect:'none'}]});
 const init=await initializeV3Run({trustedRoot:runsDir,runDir,graph,sourceCwd:root,sessionId:owner,supervisorEpoch:'fixture'});
 const now=new Date().toISOString();let attempt={schemaVersion:1,runInstanceId:init.authorization.runInstanceId,graphId,taskId:'work',attempt:1,attemptNonce:'fixture',phase:'running',createdAt:now,updatedAt:now,supervisorEpoch:'fixture',observation:{asyncId,resolvedAgent:'worker',actualAgent:'worker',observedAt:now,supervision:{activity:'unknown',checkedAt:now,runtimeLimit:'unlimited',probe:'available'}}};await A.writeV3AttemptEvidence(runDir,'work',1,attempt);
 fs.mkdirSync(asyncDir,{recursive:true});
 lease=await acquireV3RunLease(path.join(runDir,'lease.json'),'sdk-supervisor-fixture');
 mailbox=new GraphMailbox(runDir,lease,async(taskId,attempt)=>taskId==='work'&&attempt===1);
 await mailbox.initialize(init.authorization.runInstanceId,owner,[{taskId:'work',attempt:1}]);
 activeMailboxes.set(mailboxRegistryKey(runDir),{mailbox,owner,runInstanceId:init.authorization.runInstanceId});
 broker=new MailboxBroker(mailbox);await broker.start();const status={runId:asyncId,sessionId:owner,state:'running',noTimeout:true,steps:[{agent:'worker',status:'running'}]};fs.writeFileSync(path.join(asyncDir,'status.json'),JSON.stringify(status));
 const childToken=await mailbox.capability('work',1);
 child=await factory.create(launch('child',[{name:'mailbox-client',factory:pi=>registerGraphMailboxTool(pi,{socketPath:broker.socketPath,token:childToken})}],['graph_mailbox']));child.subscribe(e=>record('child',e));
 let waiting,childRun;
 if(process.argv.includes('--existing')){childRun=child.prompt('Ask supervisor then continue');await new Promise(r=>setTimeout(r,100));waiting=parent.prompt('Run fixture Graph wait');}
 else {waiting=parent.prompt('Run fixture Graph wait');await new Promise(r=>setTimeout(r,80));parentPi.events.emit('pi-graph:mailbox',{runInstanceId:init.authorization.runInstanceId,messageId:'early-not-written'});await new Promise(r=>setTimeout(r,80));assert.equal(evidence.filter(e=>e.type==='tool_execution_end'&&e.toolName==='graph').length,0);childRun=child.prompt('Ask supervisor then continue');}
 await childRun;
 // Feed the real child result through valid durable declared-acceptance evidence;
 // no Graph runner spawn is used in this tools-only fixture.
 status.state='complete';status.steps[0].status='complete';fs.writeFileSync(path.join(asyncDir,'status.json'),JSON.stringify(status));
 const workspaceDigest=await A.writeV3WorkspaceEvidence(runDir,'work',1,{schemaVersion:1,runInstanceId:attempt.runInstanceId,graphId,taskId:'work',attempt:1,workspaceKind:'shadow',workspaceDir:root,sourceCwd:root,readBaseline:{},writeBaseline:{},inputBaseline:{},contractDigest:'c'.repeat(64),createdAt:now});
 const basis={...attempt,phase:'accepted',terminalStatus:'accepted',child:{terminal:'complete',output:'Child continued after actual mailbox reply',completedAt:new Date().toISOString()},workspaceDigest,updatedAt:new Date().toISOString()};
 const acceptanceDigest=await A.writeV3AcceptanceEvidence(runDir,'work',1,{schemaVersion:1,runInstanceId:attempt.runInstanceId,graphId,taskId:'work',attempt:1,method:'declared',verified:false,validatedResultDigest:'',attemptDigest:A.v3AttemptEvidenceDigest(A.v3AcceptedAttemptBasis(basis)),recordedAt:new Date().toISOString(),supervisorEpoch:'fixture'});await A.writeV3AttemptEvidence(runDir,'work',1,{...basis,acceptanceDigest});fs.mkdirSync(path.join(runDir,'artifacts','work'),{recursive:true});fs.writeFileSync(path.join(runDir,'artifacts','work','attempt-1.txt'),'Child continued after actual mailbox reply');
 await waiting;
 const waits=evidence.filter(e=>e.who==='parent'&&e.toolName==='graph'&&e.type==='tool_execution_end'&&e.result.details?.waitReason);assert.deepEqual(waits.map(e=>e.result.details.waitReason),['attention_required','graph_settled']);assert.equal(waits[1].result.details.status,'complete');assert.ok(asked&&pendingId);
 for(const [role,session] of [['parent',parent],['child',child]]){const lines=fs.readFileSync(session.sessionFile,'utf8').trim().split('\n').map(JSON.parse);const tools=lines.filter(e=>e.type==='message'&&(e.message.role==='toolResult'||(e.message.role==='assistant'&&e.message.content.some(b=>b.type==='toolCall')))).map(e=>({type:e.type,message:{role:e.message.role,toolName:e.message.toolName,toolCallId:e.message.toolCallId,content:e.message.content.filter(b=>b.type==='toolCall'||b.type==='text')}}));fs.writeFileSync(T+`/${role}-jsonl-tools-only.json`,JSON.stringify(tools,null,2));assert.ok(tools.length);}
 // Actual session.abort ends only the parent WAIT; a simultaneously active SDK child remains alive.
 abortScenario=true;parentStep=0;status.state='running';status.steps[0].status='running';fs.writeFileSync(path.join(asyncDir,'status.json'),JSON.stringify(status));graphId='sdk-abort';const abortDir=path.join(runsDir,graphId);const abortGraph=compileGraphSpecV3({schemaVersion:3,graphId,goal:'Abort wait fixture',nodes:[{taskId:'work',agent:'worker',task:'Stay alive',sideEffect:'none'}]});const abortInit=await initializeV3Run({trustedRoot:runsDir,runDir:abortDir,graph:abortGraph,sourceCwd:root,sessionId:owner,supervisorEpoch:'fixture'});await A.writeV3AttemptEvidence(abortDir,'work',1,{...attempt,graphId,runInstanceId:abortInit.authorization.runInstanceId,updatedAt:new Date().toISOString()});
 const activeChild=child.prompt('Remain alive until explicit fixture cleanup');while(!childStarted)await new Promise(r=>setTimeout(r,10));
 const count=evidence.filter(e=>e.who==='parent'&&e.toolName==='graph'&&e.type==='tool_execution_start').length;const abortWait=parent.prompt('Wait again for abort fixture');while(evidence.filter(e=>e.who==='parent'&&e.toolName==='graph'&&e.type==='tool_execution_start').length===count)await new Promise(r=>setTimeout(r,10));await new Promise(r=>setTimeout(r,50));await parent.abort();await abortWait;assert.equal(childAbortObserved,false);assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir,'status.json'))).state,'running');assert.ok(evidence.some(e=>e.who==='parent'&&e.toolName==='graph'&&e.result?.details?.waitReason==='aborted'));await child.abort();await activeChild;assert.equal(childAbortObserved,true);console.log('PASS actual SDK parent session.abort stops WAIT only; active child survives until explicit child cleanup');
 console.log('PASS actual SDK 1.0.4 + registered public Graph wait + actual Graph mailbox client/broker + actual parent reply + child continue + real durable Graph status settled complete');
}catch(error){console.error(error);process.exitCode=1;}finally{if(mailbox)activeMailboxes.delete(mailboxRegistryKey(runDir));await broker?.close();await lease?.release();await child?.dispose();await parent?.dispose();await factory.dispose();fs.writeFileSync(T+'/sdk-fixture-location.txt',root+'\n');}
