import {captureHostSdkIdentity} from '../src/runtime/host-sdk.ts';
import {assertChildModelAllowed,childPolicyFromSettings} from '../src/runtime/child-model-policy.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {resolveSubagentLaunchContract} from '../src/runtime/launch-contract.ts';
import {openOwnedChild} from '../src/runtime/child-session.ts';
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'child-model-policy-')),cwd=join(root,'work'),agentDir=join(root,'agent');await mkdir(join(cwd,'.pi/agents'),{recursive:true});await mkdir(agentDir);const prev=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 await writeFile(join(agentDir,'settings.json'),JSON.stringify({subagents:{modelScope:{denyFamilies:['gpt','codex']}}}));await writeFile(join(cwd,'.pi/agents/worker.md'),'---\nname: worker\ntools: read\n---\nFixture.');
 return {root,cwd,agentDir,close:async()=>{if(prev===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prev;await rm(root,{recursive:true,force:true});}};
}
for(const project of [{subagents:{modelScope:{enforce:false,allow:['inherit','test/gpt-6-astra'],denyFamilies:[]}}},{graphAgents:{modelScope:{enforce:false,denyFamilies:[]}}}])test(`global family deny cannot be cleared by project ${JSON.stringify(project)}`,async()=>{
 const f=await setup();try{await writeFile(join(f.cwd,'.pi/settings.json'),JSON.stringify(project));for(const model of ['test/gpt-6-astra','gpt-6-astra','test/GPT-6-ASTRA:high',undefined])for(const agentScope of ['both','project','user'] as const){if(agentScope==='user')continue;const r=await resolveSubagentLaunchContract({agent:'worker',cwd:f.cwd,agentScope,model,parentModel:{provider:'test',id:'gpt-6-astra'},availableModels:[{provider:'test',id:'gpt-6-astra'},{provider:'test',id:'GPT-6-ASTRA'}]});assert.equal(r.ok,false,`${model} ${agentScope}`);if(!r.ok)assert.match(r.message,/denied.*family|family.*denied/i);}
 const legal=await resolveSubagentLaunchContract({agent:'worker',cwd:f.cwd,model:'kimi-coding/k3',parentModel:{provider:'test',id:'gpt-6-astra'}});assert.equal(legal.ok,true);
 }finally{await f.close();}
});

async function owned(f:Awaited<ReturnType<typeof setup>>,model:string|undefined='kimi-coding/k3',extra:any={}){
 const dir=join(f.root,'run');await mkdir(dir,{recursive:true});await mkdir(join(dir,'fixture-agent'),{recursive:true});await writeFile(join(dir,'fixture-agent/settings.json'),JSON.stringify({subagents:{modelScope:{denyFamilies:['gpt','codex']}}}));
 const intent:any={hostSdkIdentity:await captureHostSdkIdentity(),version:1,runId:'fixture',asyncDir:dir,runnerProcessInstanceId:'fixture',sessionId:'fixture',params:{cwd:f.cwd,model,...extra.params},agent:{name:'worker'},launchContract:{childModelPolicy:{denyFamilies:['gpt','codex']},inheritSkills:false,inheritGlobalContext:false,inheritProjectContext:false,tools:{effectiveAllowlist:['read'],extensionArgs:extra.paths??[]}},...extra.intent};
 const events:any[]=[];const old=process.env.NODE_ENV;process.env.NODE_ENV='test';try{return {child:await openOwnedChild(intent,e=>events.push(e),'success'),events};}finally{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
}
test('real SDK blocks denied initial resolved model before transport',async()=>{const f=await setup();try{for(const m of ['test/gpt-6-astra','test/GPT-6.1-SOL:high','test/CODEX-auto-review:high'])await assert.rejects(owned(f,m),/family.*denied/);}finally{await f.close();}});
test('real SDK extension switching to GPT is refused before any request',async()=>{
 const f=await setup();try{const ext=join(f.root,'switch.ts');await writeFile(ext,`export default function(api:any){api.on('session_start',async(_e:any,ctx:any)=>{await api.setModel({...ctx.model,id:'GPT-6-ASTRA'});});}`);await assert.rejects(owned(f,'kimi-coding/k3',{paths:[ext]}),/startup failed.*family.*denied/i);}finally{await f.close();}
});
test('real SDK stream boundary remains guarded after transport replacement and low-level model mutation',async()=>{
 const f=await setup();let child:any;try{({child}=await owned(f));let calls=0;child.session.agent.streamFunction=()=>{calls++;throw Error('transport reached');};child.session.agent.state.model={...child.session.model,id:'gpt-6-astra'};await child.session.prompt('do not send');assert.equal(calls,0);assert.match(JSON.stringify(child.session.messages),/family.*denied/);await assert.rejects(child.session.setModel({...child.session.model,id:'GPT-6.1-SOL'}),/family.*denied/);}finally{await child?.shutdown();await f.close();}
});
test('real SDK before_provider_request denies a forbidden resolved model and payload',async()=>{
 const f=await setup();let child:any;try{const r=await owned(f);child=r.child;child.session.agent.state.model={...child.session.model,id:'gpt-6-astra'};assert.equal(await child.session.extensionRunner.emitBeforeProviderRequest({model:'gpt-6-astra'}),null);assert.equal(r.events.filter(e=>e.type==='owned_model_policy_denied').length,1);child.session.agent.state.model={...child.session.model,id:'k3'};assert.equal(await child.session.extensionRunner.emitBeforeProviderRequest({model:'GPT-6-AStra'}),null);assert.equal(r.events.filter(e=>e.type==='owned_model_policy_denied').length,2);}finally{await child?.shutdown();await f.close();}
});
test('real SDK old frozen GPT fallback is blocked but official model and main identity remain legal',async()=>{
 const f=await setup();let child:any;try{({child}=await owned(f,'kimi-coding/k3',{intent:{continuation:{plan:{candidates:[{resolvedModel:'kimi-coding/k3',thinking:'high'},{resolvedModel:'test/gpt-6-astra',thinking:'low'}]}}}}));await child.session.prompt('fixture safe request');assert.equal(child.session.messages.filter((m:any)=>m.role==='assistant').at(-1).stopReason,'stop');await assert.rejects(child.switchModel(1),/family.*denied/);assert.equal(child.session.model.id,'k3');}finally{await child?.shutdown();await f.close();}
});

test('role definitions and global/project graph-model overrides cannot authorize GPT',async()=>{
 const f=await setup();try{
 for(const scope of [f.agentDir,join(f.cwd,'.pi')]){await writeFile(join(scope,'graph-models.json'),JSON.stringify({version:1,roles:{worker:{model:'test/gpt-6-astra'}},profiles:{},models:{}}));const r=await resolveSubagentLaunchContract({agent:'worker',cwd:f.cwd});assert.equal(r.ok,false);if(!r.ok)assert.match(r.message,/family.*denied/);await rm(join(scope,'graph-models.json'));}
 await writeFile(join(f.cwd,'.pi/agents/worker.md'),'---\nname: worker\nmodel: test/GPT-6-ASTRA\ntools: read\n---\nFixture.');const r=await resolveSubagentLaunchContract({agent:'worker',cwd:f.cwd});assert.equal(r.ok,false);if(!r.ok)assert.match(r.message,/family.*denied/);
 }finally{await f.close();}
});
test('family policy is opt-in and projects may add but not remove denied families',async()=>{
 const f=await setup();try{await writeFile(join(f.cwd,'.pi/settings.json'),JSON.stringify({graphAgents:{modelScope:{denyFamilies:['glm']}}}));let r=await resolveSubagentLaunchContract({agent:'worker',cwd:f.cwd,model:'test/glm-5'});assert.equal(r.ok,false);await writeFile(join(f.agentDir,'settings.json'),'{}');await writeFile(join(f.cwd,'.pi/settings.json'),'{}');r=await resolveSubagentLaunchContract({agent:'worker',cwd:f.cwd,model:'test/gpt-6-astra'});assert.equal(r.ok,true);}finally{await f.close();}
});

test('normalization covers namespaced resolved IDs and both global settings namespaces',()=>{const policy=childPolicyFromSettings({subagents:{modelScope:{denyFamilies:['GPT']}},graphAgents:{modelScope:{denyFamilies:['glm']}}},{graphAgents:{modelScope:{enforce:false,denyFamilies:[]}}});assert.deepEqual(policy.denyFamilies,['glm','gpt']);for(const model of ['  openrouter/openai/GPT-6-astra:HIGH  ',{provider:'openrouter',id:'  openai/GPT-6-astra  '},'gpt6'])assert.throws(()=>assertChildModelAllowed(model,policy),/family.*denied/);assertChildModelAllowed({provider:'kimi-coding',id:'k3'},policy);assertChildModelAllowed({provider:'xai',id:'grok-4.7'},policy);});

test('real SDK nested transport wrappers retain snapshots and cannot bypass GPT denial',async()=>{const f=await setup();let child:any;try{({child}=await owned(f));let calls=0;for(let i=0;i<3;i++){const previous=child.session.agent.streamFunction;child.session.agent.streamFunction=(...args:any[])=>{calls++;return previous(...args);};}await child.session.prompt('legal Kimi request');assert.equal(calls,3);assert.equal(child.session.messages.filter((m:any)=>m.role==='assistant').at(-1).stopReason,'stop');child.session.agent.state.model={...child.session.model,id:'GPT-6-astra'};await child.session.prompt('blocked request');assert.equal(calls,3);assert.match(JSON.stringify(child.session.messages.at(-1)),/family.*denied/);}finally{await child?.shutdown();await f.close();}});

test('real SDK transport guard blocks namespaced Codex after model mutation with zero requests',async()=>{const f=await setup();let child:any;try{({child}=await owned(f));let requests=0;child.session.agent.streamFunction=()=>{requests++;throw Error('unexpected request');};child.session.agent.state.model={...child.session.model,id:'openai/CODEX-auto-review'};await child.session.prompt('fixture');assert.equal(requests,0);assert.match(JSON.stringify(child.session.messages),/family.*denied/);}finally{await child?.shutdown();await f.close();}});
test('real SDK final transport refuses image context on a text-only model without a request',async()=>{const f=await setup();let child:any;try{({child}=await owned(f));let requests=0;child.session.agent.streamFunction=()=>{requests++;throw Error('unexpected request');};const textModel={...child.session.model,input:['text']};assert.throws(()=>child.session.agent.streamFunction(textModel,{messages:[{role:'toolResult',content:[{type:'image',data:'fixture',mimeType:'image/png'}]}]},{}),/image context/);assert.equal(requests,0);}finally{await child?.shutdown();await f.close();}});
