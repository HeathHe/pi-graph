import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bindGraphSpecWithRoutingV3,bindGraphNodesWithRoutingV3} from '../extensions/routing-admission.ts';
import {v3PreflightAgentLaunch,type V3AgentLaunchPreflightInput} from '../src/v3/preflight.ts';

async function fixture(settings=false){
 const root=await mkdtemp(join(tmpdir(),'routing-ceiling-')),cwd=join(root,'source'),agentDir=join(root,'agent');
 await mkdir(join(cwd,'.pi/agents'),{recursive:true});await mkdir(agentDir);
 const previousAgentDir=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 await writeFile(join(cwd,'.pi/settings.json'),JSON.stringify({subagents:{modelScope:{enforce:true,allow:['fixture/primary','fixture/secondary']}}}));
 const file=join(cwd,'.pi/agents/ceiling-agent.md');const definition='---\nname: ceiling-agent\ndescription: fixture\nmodel: fixture/primary\nthinking: high\ntools: read\ninheritSkills: false\ninheritProjectContext: false\n---\nOnly fixture.\n';await writeFile(file,definition);
 await writeFile(join(agentDir,'routing-policy.json'),JSON.stringify({schemaVersion:1,enforcement:'graph-admission',quarantinedProviderDomains:[],profiles:{ceiling:{budget:{modelDegradations:1},candidates:[{model:'fixture/primary',thinking:'high',level:'L0'},{model:'fixture/secondary',thinking:'high',level:'L1'}]}}}));
 await writeFile(join(agentDir,'subagent-capabilities.json'),JSON.stringify({schemaVersion:1,capabilities:[{capabilityId:'fixture.ceiling',agent:'ceiling-agent',routingProfile:'ceiling'}]}));
 if(settings)await writeFile(join(agentDir,'graph-models.json'),JSON.stringify({version:1,roles:{'ceiling-agent':{model:'fixture/primary',thinking:'high',fallbackModels:['fixture/secondary']}},profiles:{},models:{}}));
 const node={taskId:'node',agent:'ceiling-agent',task:'ISOLATED_CEILING_TASK',sideEffect:'none' as const};
 const calls:Array<{input:V3AgentLaunchPreflightInput;result:any}>=[];
 const options={cwd,agentDir,disableNetwork:true,availableModels:[{provider:'fixture',id:'primary',reasoning:true,input:['text']},{provider:'fixture',id:'secondary',reasoning:true,input:['text']}],preflightAgent:async(input:V3AgentLaunchPreflightInput)=>{const result=await v3PreflightAgentLaunch(input);calls.push({input:structuredClone(input),result});return result;}};
 return {root,cwd,agentDir,file,definition,node,calls,options,close:async()=>{if(previousAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousAgentDir;await rm(root,{recursive:true,force:true});}};
}
for(const kind of ['exact','capability','settings','spec-filter','spec-no-filter','append'] as const){
 test(`real owned resolver freezes ${kind} with trusted parent ceiling`,async()=>{
  const f=await fixture(kind==='settings');try{
   const node=kind==='capability'?{...f.node,agent:undefined,requires:['fixture.ceiling']}:f.node;
   const options={...f.options,parentToolAllowlist:['read','bash'],graphToolFilter:['bash']};
   const bound=kind==='append'?await bindGraphNodesWithRoutingV3([node],{...options,graphToolFilter:['read']}):await bindGraphSpecWithRoutingV3({schemaVersion:3,graphId:'fixture',goal:'fixture',nodes:[node],...(kind==='spec-filter'?{toolFilter:['read']}: {})},options);
   const nodes='spec' in bound?bound.spec.nodes:bound.nodes;const plan=nodes[0]!.launch!.runtimeFallback!;
   assert.equal(plan.candidates.length,2);assert.equal(nodes[0]!.binding!.admissionLaunchContractDigest,plan.candidates[0]!.admissionLaunchContractDigest);
   assert.deepEqual(plan.candidates.map(c=>c.requestedModel),['fixture/primary','fixture/secondary']);
   for(const c of f.calls){assert.deepEqual(c.input.parentToolAllowlist,['read','bash']);assert.deepEqual(c.input.graphToolFilter,kind==='spec-filter'||kind==='append'?['read']:undefined);assert.deepEqual(c.result.toolAllowlist,['read']);}
  }finally{await f.close();}
 });
}
for(const drift of ['definition','model','thinking','digest','tool-contract'] as const){
 test(`real resolver still rejects ${drift} drift before any dispatch`,async()=>{
  const f=await fixture();let primaryCalls=0;try{
   const preflightAgent=async(input:V3AgentLaunchPreflightInput)=>{
    if(input.model==='fixture/primary'&&++primaryCalls===2){
     if(drift==='definition')await writeFile(f.file,f.definition.replace('Only fixture.','Changed definition.'));
     const modified=drift==='model'?{...input,model:'fixture/secondary'}:drift==='thinking'?{...input,thinking:'low'}:drift==='tool-contract'?{...input,parentToolAllowlist:[]}:drift==='digest'?{...input,task:input.task+' changed'}:input;
     return v3PreflightAgentLaunch(modified);
    }
    return v3PreflightAgentLaunch(input);
   };
   await assert.rejects(bindGraphSpecWithRoutingV3({schemaVersion:3,graphId:'fixture',goal:'fixture',nodes:[f.node]},{...f.options,parentToolAllowlist:['read'],preflightAgent}),/Fallback admission drifted before freezing/);
  }finally{await f.close();}
 });
}
