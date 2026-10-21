import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {loadHostSdk,captureHostSdkIdentity} from '../src/runtime/host-sdk.ts';
const worker=fileURLToPath(new URL('../src/runtime/child-runner.mjs',import.meta.url));
async function run(fixture:string,extra:Record<string,unknown>={}){
 const dir=await mkdtemp(join(tmpdir(),'owned-sdk-test-'));
 await mkdir(join(dir,'workspace'));await writeFile(join(dir,'workspace','fixture.txt'),'fixture');
 const intent={hostSdkIdentity:await captureHostSdkIdentity(),version:1,runId:'fixture-run',asyncDir:dir,runnerProcessInstanceId:'fixture-instance',sessionId:'fixture-session',params:{cwd:join(dir,'workspace'),task:'Return fixture response',...extra},agent:{name:'fixture',systemPrompt:'Test role',systemPromptMode:'append'},launchContract:{launchContractDigest:'a'.repeat(64),inheritSkills:false,inheritProjectContext:false,inheritGlobalContext:false,tools:{effectiveAllowlist:fixture==='tool'?['read']:[],extensionArgs:[]}}};
 await writeFile(join(dir,'intent.json'),JSON.stringify(intent));
 const child=spawn(process.execPath,[worker,join(dir,'intent.json'),'--test-fixture',fixture],{env:{...process.env,NODE_ENV:'test'},stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);
 const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
 try{return {code,stderr,result:JSON.parse(await readFile(join(dir,'result.json'),'utf8')),status:JSON.parse(await readFile(join(dir,'status.json'),'utf8'))};}finally{await rm(dir,{recursive:true,force:true});}
}
test('loads the currently installed host Pi SDK, no extension development copy',async()=>{const {root}=await loadHostSdk();assert.match(root,/pi-coding-agent$/);assert.notEqual(root,fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent',import.meta.url)));assert.ok(JSON.parse(await readFile(join(root,'package.json'),'utf8')).version);});
test('isolated SDK worker completes and persists own actual lifecycle/usage',async()=>{const r=await run('success');assert.equal(r.code,0,r.stderr);assert.equal(r.result.state,'complete');assert.equal(r.result.results[0].finalOutput,'Owned fixture response');assert.equal(r.status.steps[0].turnCount,1);assert.equal(r.status.steps[0].tokens.totalTokens,5);const p=r.result.results[0].preActivityEvidence;assert.equal(p.factoryIdentity,'pi-graph-owned-session/1');assert.equal(p.agentStarted,true);assert.equal(p.promptSettled,true);assert.equal(p.shutdownComplete,true);assert.equal(p.invalid,false);assert.equal(p.toolsStarted,0);});
test('assistant quota failure supplies host proof without tool activity',async()=>{const r=await run('quota');assert.equal(r.code,1,r.stderr);assert.equal(r.result.state,'failed');const p=r.result.results[0].preActivityEvidence;assert.equal(p.diagnostic,'429 quota exceeded');assert.equal(p.diagnosticSource,'assistant_error');assert.equal(p.invalid,false);assert.equal(p.toolsStarted,0);assert.equal(p.shutdownComplete,true);assert.equal(p.promptSettled,true);});
test('actual SDK tool event records activity and invalidates zero-activity fallback',async()=>{const r=await run('tool');assert.equal(r.code,0,r.stderr);assert.equal(r.status.steps[0].toolCount,1);assert.equal(r.result.results[0].preActivityEvidence.toolsStarted,1);assert.equal(r.result.results[0].preActivityEvidence.assistantToolCalls,1);});
test('tool hard ceiling blocks the real tool and conservatively records the attempted call',async()=>{const r=await run('tool',{toolBudget:{hard:0}});assert.equal(r.status.steps[0].toolErrorCount,1);assert.equal(r.result.results[0].preActivityEvidence.toolsStarted,1);assert.equal(r.result.results[0].preActivityEvidence.assistantToolCalls,1);});

test('turn hard ceiling ends a multi-turn tool loop',async()=>{const r=await run('tool',{turnBudget:{maxTurns:1}});assert.equal(r.code,1);assert.match(r.result.results[0].error,/turn budget/);assert.equal(r.result.results[0].preActivityEvidence.toolsStarted,1);});

test('startup without required guard fails closed for Graph-bound child',async()=>{const r=await run('success',{extensionBindings:{'pi-graph/1':{graphId:'fixture'}}});assert.equal(r.code,1);assert.match(r.result.results[0].error,/guard.*acknowledge/);assert.equal(r.result.results[0].preActivityEvidence.agentStarted,false);assert.equal(r.result.results[0].preActivityEvidence.invalid,true);});

test('owned session obeys role prompt mode and separately filters project/global context',async()=>{
 const {openOwnedChild}=await import('../src/runtime/child-session.ts');
 const before=process.env.NODE_ENV;const childBefore=process.env.PI_GRAPH_CHILD;const bindingBefore=process.env.PI_GRAPH_EXTENSION_BINDINGS;process.env.NODE_ENV='test';
 const dir=await mkdtemp(join(tmpdir(),'owned-context-test-'));
 try{
  const cwd=join(dir,'workspace');await mkdir(cwd);await mkdir(join(dir,'fixture-agent'));
  await writeFile(join(cwd,'AGENTS.md'),'PROJECT_CONTEXT_MARKER');await writeFile(join(dir,'fixture-agent','AGENTS.md'),'GLOBAL_CONTEXT_MARKER');
  await mkdir(join(cwd,'.pi','skills','selected'),{recursive:true});await writeFile(join(cwd,'.pi','skills','selected','SKILL.md'),'---\nname: selected\ndescription: SELECTED_SKILL_MARKER\n---\nFixture skill');
  for(const mode of ['append','replace']){
   const child=await openOwnedChild({hostSdkIdentity:await captureHostSdkIdentity(),version:1,runId:'context-fixture',asyncDir:dir,runnerProcessInstanceId:'instance',sessionId:'owner',params:{cwd,task:'Fixture'},agent:{name:'fixture',systemPrompt:'ROLE_CONTEXT_MARKER'},launchContract:{systemPromptMode:mode,inheritProjectContext:true,inheritGlobalContext:false,inheritSkills:false,tools:{effectiveAllowlist:[],extensionArgs:[]}}},()=>{},'success');
   try{await child.session.prompt('Fixture');const system=child.session.agent.state.systemPrompt;assert.doesNotMatch(system,/SELECTED_SKILL_MARKER/);assert.match(system,/ROLE_CONTEXT_MARKER/);assert.match(system,/PROJECT_CONTEXT_MARKER/);assert.doesNotMatch(system,/GLOBAL_CONTEXT_MARKER/);if(mode==='append')assert.match(system,/coding assistant/i);else assert.doesNotMatch(system,/coding assistant/i);}finally{await child.shutdown();}
  }
  const explicit=await openOwnedChild({hostSdkIdentity:await captureHostSdkIdentity(),version:1,runId:'skills-fixture',asyncDir:dir,runnerProcessInstanceId:'instance',sessionId:'owner',params:{cwd,task:'Fixture'},agent:{name:'fixture',skills:['selected']},launchContract:{inheritProjectContext:false,inheritGlobalContext:false,inheritSkills:false,tools:{effectiveAllowlist:['read'],extensionArgs:[]}}},()=>{},'success');
  try{await explicit.session.prompt('Fixture');assert.match(explicit.session.agent.state.systemPrompt,/SELECTED_SKILL_MARKER/);}finally{await explicit.shutdown();}
 }finally{if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before;if(childBefore===undefined)delete process.env.PI_GRAPH_CHILD;else process.env.PI_GRAPH_CHILD=childBefore;if(bindingBefore===undefined)delete process.env.PI_GRAPH_EXTENSION_BINDINGS;else process.env.PI_GRAPH_EXTENSION_BINDINGS=bindingBefore;await rm(dir,{recursive:true,force:true});}
});

test('control file stops session and finalizes shutdown without fabricated exit evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'owned-stop-test-'));const cwd=join(dir,'workspace');await mkdir(cwd);
 const intent={hostSdkIdentity:await captureHostSdkIdentity(),version:1,runId:'stop-fixture',asyncDir:dir,runnerProcessInstanceId:'instance',sessionId:'owner',params:{cwd,task:'Fixture'},agent:{name:'fixture'},launchContract:{inheritSkills:false,inheritProjectContext:false,inheritGlobalContext:false,tools:{effectiveAllowlist:[],extensionArgs:[]}}};
 await writeFile(join(dir,'intent.json'),JSON.stringify(intent));await writeFile(join(dir,'control.json'),JSON.stringify({version:1,runId:'stop-fixture',runnerProcessInstanceId:'instance',action:'stop'}));
 const child=spawn(process.execPath,[worker,join(dir,'intent.json'),'--test-fixture','pending'],{env:{...process.env,NODE_ENV:'test'},stdio:'ignore'});
 try{const code=await new Promise<number|null>((r,j)=>{child.on('close',r);child.on('error',j)});assert.equal(code,1);const completion=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));assert.equal(completion.state,'stopped');assert.equal(completion.results[0].preActivityEvidence.shutdownComplete,true);assert.equal(completion.results[0].preActivityEvidence.stopped,true);await assert.rejects(readFile(join(dir,'process-terminal.json')));}finally{await rm(dir,{recursive:true,force:true});}
});

test('actual guard loads, acknowledges and rejects malformed workspace binding before provider activity',async()=>{
 const guard=fileURLToPath(new URL('../extensions/pi-graph-guard.ts',import.meta.url));
 const r=await run('success',{extensionPaths:[guard],extensionBindings:{'pi-graph/1':{graphId:'fixture'}}});
 assert.equal(r.code,1);assert.ok(r.status.steps[0].acknowledgedExtensions.includes('pi-graph-guard'));
 assert.equal(r.result.results[0].preActivityEvidence.agentStarted,false);assert.equal(r.result.results[0].preActivityEvidence.toolsStarted,0);assert.equal(r.result.results[0].preActivityEvidence.shutdownComplete,true);assert.match(r.result.results[0].error,/handled without an assistant/);
});

test('fixed quota fixture uses the frozen model as actual SDK model, preserving fallback identity',async()=>{
 const r=await run('quota',{model:'kimi-coding/k3:high',thinking:'high'});
 assert.equal(r.code,1);const result=r.result.results[0];assert.equal(result.model,'kimi-coding/k3:high');assert.equal(result.requestedModel,'kimi-coding/k3:high');assert.equal(result.thinking,'high');assert.equal(result.preActivityEvidence.invalid,false);assert.equal(result.preActivityEvidence.diagnostic,'429 quota exceeded');assert.equal(result.preActivityEvidence.factoryIdentity,'pi-graph-owned-session/1');
});
test('actual SDK accepts max on a fixture model explicitly supporting max',async()=>{
 const r=await run('success',{model:'fixture/maximum:max',thinking:'max'});assert.equal(r.code,0);assert.equal(r.result.results[0].model,'fixture/maximum:max');assert.equal(r.result.results[0].thinking,'max');
});
test('unsupported frozen thinking rejects before provider activity',async()=>{
 const r=await run('success',{model:'fixture/model',thinking:'invented'});assert.equal(r.code,1);assert.match(r.result.results[0].error,/Unsupported frozen thinking/);assert.equal(r.result.results[0].preActivityEvidence.agentStarted,false);
});


test('current actual SDK keeps busy Graph notifications outside followUp and consumes a returned observation',async()=>{
 const {openOwnedChild}=await import('../src/runtime/child-session.ts');const {GraphParentWake}=await import('../src/runtime/background-work.ts');
 const old=process.env.NODE_ENV;process.env.NODE_ENV='test';const dir=await mkdtemp(join(tmpdir(),'owned-busy-wake-'));const cwd=join(dir,'work');await mkdir(cwd);
 let unblock!:()=>void;let entered!:()=>void;const gate=new Promise<void>(r=>unblock=r),started=new Promise<void>(r=>entered=r);let child:any;
 try{
  child=await openOwnedChild({hostSdkIdentity:await captureHostSdkIdentity(),version:1,runId:'busy',asyncDir:dir,runnerProcessInstanceId:'busy-instance',sessionId:'parent',params:{cwd,task:'Fixture'},agent:{name:'fixture'},launchContract:{inheritSkills:false,inheritProjectContext:false,inheritGlobalContext:false,tools:{effectiveAllowlist:[],extensionArgs:[]}}},()=>{},'success');
  const original=child.session.agent.streamFunction;let calls=0;child.session.agent.streamFunction=async(...args:any[])=>{if(calls++===0){entered();await gate;}return original(...args);};
  const prompt=child.session.prompt('Parent work');await started;
  let notifications=0;const wake=new GraphParentWake({sendMessage(){notifications++;},sendUserMessage(){throw Error('Consumed busy notification must not request another turn');},appendEntry(type:string,data:any){child.session.sessionManager.appendCustomEntry(type,data);}});
  const observation={sessionId:child.session.sessionManager.getSessionId(),graphId:'fixture',runInstanceId:'run',fingerprint:'f'.repeat(64)};
  wake.bind({sessionManager:child.session.sessionManager,isIdle:()=>!child.session.isStreaming,hasPendingMessages:()=>child.session.pendingMessageCount>0});wake.started();wake.notify('one',observation);wake.notify('two',observation);wake.notify('three',observation);
  assert.equal(notifications,0);assert.equal(child.session.getFollowUpMessages().length,0);
  wake.observe('fixture-read',observation);wake.toolFinished('fixture-read',false);unblock();await prompt;await child.session.waitForIdle();wake.messageEnded({role:'assistant',stopReason:'stop',content:[{type:'text',text:'Fixture result integrated'}]});wake.beforeSettle('completed');wake.settled(false);assert.equal(child.session.pendingMessageCount,0);assert.equal(calls,1);

 }finally{unblock();await child?.shutdown();if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;await rm(dir,{recursive:true,force:true});}
});

test('current SDK default-tool modifiers cannot alter a frozen child allowlist',async()=>{
 const r=await run('success',{tools:['+read']});assert.equal(r.code,1);assert.match(r.result.results[0].error,/default-tool modifiers/);assert.equal(r.status.steps[0].toolCount,0);assert.equal(r.result.results[0].preActivityEvidence.agentStarted,false);
});
