import {ownedProtectedRoots,protectOwnedShell} from "./control-protection.ts";
import {normalizeExtensionBindings} from './extension-bindings.ts';
import {brandOwnedChild,recordOwnedShutdown} from "./activity-proof.ts";
import {validateCustomGraphModel} from "./custom-models.ts";
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadHostSdk,assertHostSessionCapabilities,assertHostModelRuntimeCapabilities } from './host-sdk.ts';
export interface OwnedChildIntent {
 version:1;runId:string;asyncDir:string;runnerProcessInstanceId:string;sessionId:string;
 params:Record<string,any>;agent:Record<string,any>;launchContract:Record<string,any>;hostSdkRoot?:string;
}
/** One isolated OS worker owns one SDK session and its extension lifecycle. */
export async function openOwnedChild(intent:OwnedChildIntent, onEvent:(event:any)=>void, fixture?:'success'|'quota'|'tool'|'pending') {
 if(fixture&&process.env.NODE_ENV!=='test')throw new Error('Owned SDK fixtures require NODE_ENV=test.');
 const {sdk,root}=await loadHostSdk();
 const params=intent.params, contract=intent.launchContract, plan=contract.tools??{};
 normalizeExtensionBindings(params.extensionBindings);
 const tools=params.tools??plan.effectiveAllowlist??plan.effectiveToolAllowlist;
 if(!Array.isArray(tools)||tools.some((x:any)=>typeof x!=='string'||/^[+-]/u.test(x))) throw new Error('Frozen child tool allowlist missing or contains default-tool modifiers.');
 const paths=params.extensionPaths??plan.extensionArgs??[...(plan.runtimeExtensions??[]),...(plan.configuredExtensions??[])];
 if(!Array.isArray(paths)||paths.some((x:any)=>typeof x!=='string')) throw new Error('Frozen extension paths missing.');
 const cwd=params.cwd;
 if(typeof cwd!=='string'||!cwd) throw new Error('Child cwd missing.');
 // Compatibility binding names are data transport, not a pi-subagents dependency.
 process.env.PI_GRAPH_CHILD='1';
 process.env.PI_GRAPH_EXTENSION_BINDINGS=JSON.stringify(params.extensionBindings??{});
 const agentDir=fixture?join(intent.asyncDir,'fixture-agent'):(process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent'));
 const runtime=await sdk.ModelRuntime.create(fixture?{authPath:join(agentDir,'auth.json'),modelsPath:null,modelsStorePath:join(agentDir,'models-store'),refreshOnCreate:false,allowModelNetwork:false}:{allowModelNetwork:false});
 assertHostModelRuntimeCapabilities(runtime);
 const baseSettings=fixture?{}:sdk.SettingsManager.create(cwd,agentDir,{projectTrusted:params.projectTrusted??true}).getSettings();
 const customModels=(params.customModelDefinitions??contract.customModelDefinitions??[]).map(validateCustomGraphModel);
 const registeredProviders=new Set(runtime.getModels().map((m:any)=>m.provider));
 const grouped=new Map<string,any[]>();for(const m of customModels){if(registeredProviders.has(m.provider))throw new Error('Custom Graph model would replace an existing Pi provider.');const g=grouped.get(m.provider)??[];g.push(m);grouped.set(m.provider,g);}
 for(const [provider,models]of grouped)runtime.registerProvider(provider,{api:models[0].api,baseUrl:models[0].baseUrl,models:models.map(({auth,source,provider,...model}:any)=>model)});
 if(grouped.size)await runtime.refresh({allowNetwork:false});
 const originalAuth=runtime.getAuth.bind(runtime),originalHasAuth=runtime.hasConfiguredAuth.bind(runtime);
 runtime.hasConfiguredAuth=(provider:string)=>{const models=grouped.get(provider);return models?models.some((m:any)=>m.auth.type==='env'?Boolean(process.env[m.auth.variable]):originalHasAuth(m.auth.provider)):originalHasAuth(provider)};
 runtime.getAuth=async(model:any,...args:any[])=>{const provider=typeof model==='string'?model:model.provider,m=customModels.find((m:any)=>m.provider===provider&&(typeof model==='string'||m.id===model.id));if(!m)return originalAuth(model,...args);if(m.auth.type==='pi')return originalAuth(m.auth.provider,...args);const key=process.env[m.auth.variable];return key?{auth:{apiKey:key},env:{}}:undefined;};
 process.env.PI_GRAPH_CUSTOM_MODELS=JSON.stringify(customModels);
 const settings=sdk.SettingsManager.inMemory({...baseSettings,retry:{...(baseSettings.retry??{}),enabled:false},...(fixture?{compaction:{enabled:false}}:{})});
 const events=sdk.createEventBus();const acknowledged=new Set<string>();
 events.on('pi-graph:acknowledge-extension',(value:any)=>{if(typeof value?.id==='string')acknowledged.add(value.id);});
 const agent=intent.agent;
 const systemPrompt=agent.systemPrompt??agent.content;
 const append=contract.systemPromptMode!=='replace';
 const inside=(root:string,p:string)=>{const r=relative(root,p);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
 let calls=0,turns=0,tokens=0,cost=0;const notices=new Set<string>();
 const protectedRoots=ownedProtectedRoots({asyncDir:intent.asyncDir,params:{cwd}},agentDir);
 protectedRoots.writes.push(root);
 process.env.PI_GRAPH_PROTECTED_ROOTS=JSON.stringify(protectedRoots);
 const budgetExtension=(api:any)=>{
  if(tools.includes("bash"))api.registerTool(sdk.createBashToolDefinition(cwd,{exposeSessionEnvironment:false,spawnHook:(ctx:any)=>({...ctx,command:protectOwnedShell(ctx.command,protectedRoots)})}));
  const warning=(text:string)=>{if(!notices.has(text)){notices.add(text);api.sendMessage({customType:'pi-graph-budget',content:text,display:false},{triggerTurn:false});}};
  api.on('turn_start',(_e:any,ctx:any)=>{turns++;const t=params.turnBudget;if(t&&turns>t.maxTurns+(t.graceTurns??0)){onEvent({type:'owned_budget_exceeded',error:'Graph child hard turn budget reached.'});ctx.abort();}});
  api.on('message_end',(e:any)=>{if(e.message?.role==='assistant'){tokens+=e.message.usage?.totalTokens??0;cost+=e.message.usage?.cost?.total??0;}});
  api.on('tool_call',(e:any)=>{
   const tool=params.toolBudget,turn=params.turnBudget;
   if(tool?.soft!==undefined&&calls>=tool.soft)warning('Graph tool budget soft limit reached; finish remaining work.');
   const blocked=tool?.block==='*'||!tool?.block||tool.block.includes(e.toolName);
   if(tool&&calls>=tool.hard&&blocked)return {block:true,reason:'Graph child hard tool budget reached.'};
   if(turn&&turns>turn.maxTurns+(turn.graceTurns??0))return {block:true,reason:'Graph child hard turn budget reached.'};
   calls++;
  });
  api.on('before_provider_request',(_e:any,ctx:any)=>{
   const turn=params.turnBudget;let failure=turn&&turns>turn.maxTurns+(turn.graceTurns??0)?'Graph child hard turn budget reached.':undefined;
   for(const [kind,used]of [['tokens',tokens],['costUsd',cost]] as const){const limit=params.usageBudget?.[kind];if(!limit)continue;if(limit.soft!==undefined&&used>=limit.soft)warning(`Graph ${kind} budget soft limit reached; finish remaining work.`);if(used>=limit.hard)failure=`Graph child hard ${kind} budget reached.`;}
   if(failure){onEvent({type:'owned_budget_exceeded',error:failure});ctx.abort();return null;}
  });
 };
 const loader=new sdk.DefaultResourceLoader({cwd,agentDir,settingsManager:settings,eventBus:events,noExtensions:true,
 noSkills:contract.inheritSkills===false&&!(agent.skills?.length),noContextFiles:contract.inheritProjectContext===false&&contract.inheritGlobalContext===false,
 noPromptTemplates:true,noThemes:true,additionalExtensionPaths:paths,
 additionalSkillPaths:[...(agent.skillPath??[])],extensionFactories:[budgetExtension],
 skillsOverride:contract.inheritSkills===false?(base:any)=>({...base,skills:base.skills.filter((skill:any)=>(agent.skills??[]).includes(skill.name)||(agent.skillPath??[]).some((p:string)=>inside(p,skill.filePath)))}):undefined,
 agentsFilesOverride:(base:any)=>({...base,agentsFiles:base.agentsFiles.filter((f:any)=>inside(agentDir,f.path)?contract.inheritGlobalContext===true:contract.inheritProjectContext!==false)}),
 ...(systemPrompt?append?{appendSystemPrompt:[systemPrompt]}:{systemPrompt}:{}),
 });
 await loader.reload();
 const loaded=loader.getExtensions();
 if(loaded.errors.length) throw new Error(`Required child extensions failed: ${loaded.errors.map((e:any)=>`${e.path}: ${e.error}`).join('; ')}`);
 // Explicit required extensions may register providers during load. Never ignore failures.
 for(const p of loaded.runtime.pendingProviderRegistrations??[]){if(grouped.has(p.name))throw new Error('Extension cannot override a frozen Graph model provider.');runtime.registerProvider(p.name,p.config);}
 for(const p of loaded.runtime.pendingNativeProviderRegistrations??[])runtime.registerNativeProvider(p.provider);
 if((loaded.runtime.pendingProviderRegistrations??[]).length || (loaded.runtime.pendingNativeProviderRegistrations??[]).length)await runtime.refresh({allowNetwork:false});
 loaded.runtime.pendingProviderRegistrations=[];loaded.runtime.pendingNativeProviderRegistrations=[];
 // The SDK filters registered extension tools against options.tools. Preserve only
 // tools from the exact frozen extensions, under explicit role/parent ceilings.
 const registeredTools=loaded.extensions.flatMap((extension:any)=>[...extension.tools.keys()]);
 const internalTools=params.extensionBindings?.['pi-graph/1']?['graph_mailbox','graph_readonly_list','graph_readonly_find','graph_readonly_sha256']:[];
 const roleTools=agent.tools;
 const extensionCeilings=[plan.effectiveCapabilityCeiling,params.capabilityCeiling,params.inheritedCapabilityCeiling].filter(Boolean);
 const extensionBusiness=registeredTools.filter((name:string)=>!name.startsWith('graph_')&&!['subagent','contact_supervisor','subagent_supervisor'].includes(name)&&!name.startsWith('intercom')&&(roleTools===undefined||roleTools.includes(name))&&!(agent.excludeTools??[]).includes(name)&&(params.parentToolAllowlist===undefined||params.parentToolAllowlist.includes(name))&&extensionCeilings.every((c:any)=>c.allowedTools===undefined||c.allowedTools.includes(name)));
 const activeTools=[...new Set([...tools,...extensionBusiness,...internalTools])];
 if(activeTools.some((name:string)=>/^[+-]/u.test(name)))throw new Error('Frozen child tool allowlist contains default-tool modifiers.');

 let resolved:any;
 if(fixture){
  const base=runtime.getModels().find((m:any)=>m.type!=='image');const requested=params.model??contract.model;
  const full=typeof requested==='string'?requested.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u,''):undefined;
  if(full&&!/^[^/]+\/.+$/u.test(full))throw new Error('Fixture model requires provider/model identity.');
  const slash=full?.indexOf('/');
  // Fixed fixture transport, real SDK Model object; no registered provider or runtime model override.
  const custom=customModels.find((m:any)=>`${m.provider}/${m.id}`===full);
  const model={...base,...(custom?{...custom,type:"chat"}:{}),...(full?{provider:full.slice(0,slash),id:full.slice(slash!+1)}:{}),reasoning:true,thinkingLevelMap:{off:'off',minimal:'minimal',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'}};
  resolved={model,thinkingLevel:/:((?:off|minimal|low|medium|high|xhigh|max))$/u.exec(requested??'')?.[1]};
  runtime.hasConfiguredAuth=()=>true;runtime.getAuth=async()=>({auth:{apiKey:'FIXTURE-NO-NETWORK'},env:{}});
 }
 else {resolved=sdk.resolveCliModel({cliModel:params.model??contract.model,modelRuntime:runtime});if(resolved.error||!resolved.model)throw new Error(resolved.error??'Frozen child model missing.');}
 const explicitThinking=params.thinking===false?'off':params.thinking??contract.thinking??resolved.thinkingLevel;
 if(explicitThinking!==undefined&&!['off','minimal','low','medium','high','xhigh','max'].includes(explicitThinking))throw new Error('Unsupported frozen thinking level.');
 const manager=sdk.SessionManager.create(cwd,params.sessionDir??join(intent.asyncDir,'session'));
 const {session}=await sdk.createAgentSession({cwd,agentDir,modelRuntime:runtime,model:resolved.model,...(explicitThinking!==undefined?{thinkingLevel:explicitThinking}:{}),tools:activeTools,resourceLoader:loader,sessionManager:manager,settingsManager:settings,sessionStartEvent:{type:'session_start',reason:'startup'}});
 try{assertHostSessionCapabilities(session);}catch(error){session.dispose?.();throw error;}
 const unsubscribe=session.subscribe(onEvent);
 const startupErrors:string[]=[];
 try{await session.bindExtensions({mode:'print',onError:(e:any)=>{startupErrors.push(`${e.extensionPath} (${e.event}): ${e.error}`);onEvent({type:'owned_extension_error',error:`Child extension failed (${e.event}).`});}});
 if(startupErrors.length)throw new Error(`Child extension startup failed: ${startupErrors.join('; ')}`);
 if(params.extensionBindings?.['pi-graph/1']&&!acknowledged.has('pi-graph-guard'))throw new Error('Required Graph guard did not acknowledge loading.');
 }catch(e){unsubscribe();session.dispose();throw e;}
 if(!fixture){const expected=(params.model??contract.model)?.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u,'');const actual=`${session.model?.provider}/${session.model?.id}`;if(expected!==actual){unsubscribe();session.dispose();throw new Error('Resolved child model differs from frozen model.');}}
 if(explicitThinking!==undefined&&session.thinkingLevel!==explicitThinking){unsubscribe();session.dispose();throw new Error('Effective thinking level is unsupported by the frozen model; refusing silent SDK clamping.');}
 if(fixture){
  const {createAssistantMessageEventStream}=await import(new URL(`file://${root}/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`).href);
  let streamCalls=0;
  session.agent.streamFunction=async()=>{
   const stream=createAssistantMessageEventStream();
   if(fixture==='pending'){await new Promise<void>(r=>session.agent.state?.isStreaming?setTimeout(r,50):r());}
   const call=fixture==='tool'&&streamCalls++===0;
   const msg={role:'assistant',api:resolved.model.api,provider:resolved.model.provider,model:resolved.model.id,content:call?[{type:'toolCall',id:'fixture-tool',name:'read',arguments:{path:join(cwd,'fixture.txt')}}]:[{type:'text',text:fixture==='quota'?'':'Owned fixture response'}],stopReason:fixture==='quota'?'error':call?'toolUse':'stop',...(fixture==='quota'?{errorMessage:'429 quota exceeded'}:{}),timestamp:Date.now(),usage:{input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   stream.push({type:'start',partial:msg});stream.push(fixture==='quota'?{type:'error',reason:'error',error:msg}:{type:'done',reason:call?'toolUse':'stop',message:msg});stream.end();return stream;
  };
 }
 const ownGuard=await realpath(fileURLToPath(new URL('../../extensions/pi-graph-guard.ts',import.meta.url)));
 const actualPaths=await Promise.all(paths.map((p:string)=>realpath(p).catch(()=>'')));
 const controlledEnvironment=actualPaths.every((p:string)=>p===ownGuard);
 let shutdownComplete=false;
 const registeredModel=runtime.getModels().find((m:any)=>m.provider===session.model.provider&&m.id===session.model.id);
 const actualModelDefinition=registeredModel?Object.fromEntries(["provider","id","api","baseUrl","input","contextWindow","maxTokens","reasoning"].map(k=>[k,registeredModel[k]])):undefined;
 const ownedChild={session,acknowledged,root,controlledEnvironment,actualModelDefinition,async shutdown(){try{await session.abort();if(session.extensionRunner.hasHandlers('session_shutdown'))await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});shutdownComplete=true;recordOwnedShutdown(ownedChild,true);}finally{if(!shutdownComplete)recordOwnedShutdown(ownedChild,false);unsubscribe();session.dispose();}return shutdownComplete;}};
 brandOwnedChild(ownedChild); return ownedChild;
}
