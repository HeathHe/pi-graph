import {assertChildModelAllowed,mergeChildModelPolicies,readChildModelPolicy} from './child-model-policy.ts';
import {assertCandidateModelCapabilities,assertModelContextInput} from './model-capabilities.ts';
import {candidateThinking,supportedThinking} from "./session-continuation.ts";
import {canonicalDigest} from "../v3/digests.ts";
import {strictSession} from "./session-checkpoint.ts";
import {ownedProtectedRoots,protectOwnedShell} from "./control-protection.ts";
import {normalizeExtensionBindings} from './extension-bindings.ts';
import {brandOwnedChild,recordOwnedShutdown} from "./activity-proof.ts";
import {validateCustomGraphModel} from "./custom-models.ts";
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadFrozenHostSdk,resolveHostDependencyRoot,type HostSdkIdentity,assertContinuationCapabilities,assertHostSessionCapabilities,assertHostModelRuntimeCapabilities } from './host-sdk.ts';
export interface OwnedChildIntent {
 version:1;runId:string;asyncDir:string;runnerProcessInstanceId:string;sessionId:string;
 continuation?:any;resumeCheckpoint?:any;generation?:number;workerInstanceId?:string;params:Record<string,any>;agent:Record<string,any>;launchContract:Record<string,any>;hostSdkRoot?:string;hostSdkIdentity?:HostSdkIdentity;
}
/** One isolated OS worker owns one SDK session and its extension lifecycle. */
export async function openOwnedChild(intent:OwnedChildIntent, onEvent:(event:any)=>void, fixture?:'success'|'quota'|'tool'|'pending'|'continuation'|'checkpoint'|'route-fallback') {
 if(fixture&&process.env.NODE_ENV!=='test')throw new Error('Owned SDK fixtures require NODE_ENV=test.');
 const {sdk,root}=await loadFrozenHostSdk(intent.hostSdkIdentity);
 onEvent({type:'owned_startup_stage',stage:'session_setup'});
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
 const policy=()=>mergeChildModelPolicies(contract.childModelPolicy,readChildModelPolicy(cwd,intent.agent.name,agentDir));
 const checkModel=(model:any)=>assertChildModelAllowed(model,policy());
 const runtime=await sdk.ModelRuntime.create(fixture?{authPath:join(agentDir,'auth.json'),modelsPath:null,modelsStorePath:join(agentDir,'models-store'),refreshOnCreate:false,allowModelNetwork:false}:{allowModelNetwork:false});
 assertHostModelRuntimeCapabilities(runtime);
 const originalStream=runtime.streamSimple.bind(runtime);
 runtime.streamSimple=(model:any,...args:any[])=>{checkModel(model);assertModelContextInput(model,args[0]);return originalStream(model,...args);};
 const baseSettings=fixture?(params.fixtureDefaultThinking?{defaultThinkingLevel:params.fixtureDefaultThinking}:{}):sdk.SettingsManager.create(cwd,agentDir,{projectTrusted:params.projectTrusted??true}).getSettings();
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
 let calls=intent.resumeCheckpoint?.usage?.toolCount??0,turns=intent.resumeCheckpoint?.usage?.turnCount??0,tokens=intent.resumeCheckpoint?.usage?.tokens?.totalTokens??0,cost=intent.resumeCheckpoint?.usage?.totalCost??0;const notices=new Set<string>();
 const protectedRoots=ownedProtectedRoots({asyncDir:intent.asyncDir,params:{cwd}},agentDir);
 protectedRoots.writes.push(root);
 process.env.PI_GRAPH_PROTECTED_ROOTS=JSON.stringify(protectedRoots);
 const claimedToolIds=new Set<string>(intent.resumeCheckpoint?.session?.completedToolIds??[]);
 const budgetExtension=(api:any)=>{
  if(tools.includes("bash"))api.registerTool(sdk.createBashToolDefinition(cwd,{exposeSessionEnvironment:false,spawnHook:(ctx:any)=>({...ctx,command:protectOwnedShell(ctx.command,protectedRoots)})}));
  const warning=(text:string)=>{if(!notices.has(text)){notices.add(text);api.sendMessage({customType:'pi-graph-budget',content:text,display:false},{triggerTurn:false});}};
  api.on('turn_start',(_e:any,ctx:any)=>{turns++;const t=params.turnBudget;if(t&&turns>t.maxTurns+(t.graceTurns??0)){onEvent({type:'owned_budget_exceeded',error:'Graph child hard turn budget reached.'});ctx.abort();}});
  api.on('message_end',(e:any)=>{if(e.message?.role==='assistant'){tokens+=e.message.usage?.totalTokens??0;cost+=e.message.usage?.cost?.total??0;}});
  api.on('tool_call',(e:any)=>{
   if(intent.continuation){
    if(typeof e.toolCallId!=='string'||claimedToolIds.has(e.toolCallId)){onEvent({type:'owned_duplicate_tool_blocked',error:'Duplicate completed/in-flight tool ID blocked before execution',toolCallId:e.toolCallId});return {block:true,reason:'Duplicate completed/in-flight tool ID: do not replay this tool operation.'};}
    claimedToolIds.add(e.toolCallId);
   }
   const tool=params.toolBudget,turn=params.turnBudget;
   if(tool?.soft!==undefined&&calls>=tool.soft)warning('Graph tool budget soft limit reached; finish remaining work.');
   const blocked=tool?.block==='*'||!tool?.block||tool.block.includes(e.toolName);
   if(tool&&calls>=tool.hard&&blocked){onEvent({type:'owned_tool_blocked',error:'Graph child hard tool budget reached.'});return {block:true,reason:'Graph child hard tool budget reached.'};}
   if(turn&&turns>turn.maxTurns+(turn.graceTurns??0))return {block:true,reason:'Graph child hard turn budget reached.'};
   calls++;
  });
  api.on('before_provider_request',(e:any,ctx:any)=>{
   try{checkModel(ctx.model);if(typeof e.payload?.model==='string')checkModel(e.payload.model);}catch(error){onEvent({type:'owned_model_policy_denied',error:String(error)});ctx.abort();return null;}
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
  runtime.checkAuth=async()=>true;runtime.hasConfiguredAuth=()=>true;runtime.getAuth=async()=>({auth:{apiKey:'FIXTURE-NO-NETWORK'},env:{}});
 }
 else {resolved=sdk.resolveCliModel({cliModel:params.model??contract.model,modelRuntime:runtime});if(resolved.error||!resolved.model)throw new Error(resolved.error??'Frozen child model missing.');}
 checkModel(resolved.model);
 const explicitThinking=params.thinking===false?'off':params.thinking??contract.thinking??resolved.thinkingLevel;
 if(explicitThinking!==undefined&&!['off','minimal','low','medium','high','xhigh','max'].includes(explicitThinking))throw new Error('Unsupported frozen thinking level.');
 const resume=intent.resumeCheckpoint;
 if(resume&&canonicalDigest(await strictSession(resume.sessionFile,cwd))!==canonicalDigest(resume.session))throw Error('Resume session changed before open');
 const manager=resume?sdk.SessionManager.open(resume.sessionFile,params.sessionDir??join(intent.asyncDir,'session'),cwd):sdk.SessionManager.create(cwd,params.sessionDir??join(intent.asyncDir,'session'));
 if(resume&&(manager.getSessionId()!==resume.session.sessionId||canonicalDigest(manager.buildSessionContext().messages)!==resume.session.contextDigest))throw Error('SDK restored a different checkpoint context');
 if(resume&&canonicalDigest(await strictSession(resume.sessionFile,cwd))!==canonicalDigest(resume.session))throw Error('Resume session changed during open');
 const {session}=await sdk.createAgentSession({cwd,agentDir,modelRuntime:runtime,model:resolved.model,...(explicitThinking!==undefined?{thinkingLevel:explicitThinking}:{}),tools:activeTools,resourceLoader:loader,sessionManager:manager,settingsManager:settings,sessionStartEvent:{type:'session_start',reason:'startup'}});
 try{assertHostSessionCapabilities(session);if(intent.continuation)assertContinuationCapabilities(sdk,session);}catch(error){session.dispose?.();throw error;}
 const setModel=session.setModel.bind(session);
 session.setModel=async(model:any,...args:any[])=>{checkModel(model);const result=await setModel(model,...args);checkModel(session.model);return result;};
 const unsubscribe=session.subscribe(onEvent);
 const startupErrors:string[]=[];
 try{await session.bindExtensions({mode:'print',onError:(e:any)=>{startupErrors.push(`${e.extensionPath} (${e.event}): ${e.error}`);onEvent({type:'owned_extension_error',error:`Child extension failed (${e.event}).`});}});
 if(startupErrors.length)throw new Error(`Child extension startup failed: ${startupErrors.join('; ')}`);
 if(params.extensionBindings?.['pi-graph/1']&&!acknowledged.has('pi-graph-guard'))throw new Error('Required Graph guard did not acknowledge loading.');
 }catch(e){unsubscribe();session.dispose();throw e;}
 try{checkModel(session.model);}catch(error){unsubscribe();session.dispose();throw error;}
 if(!fixture){const expected=(params.model??contract.model)?.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u,'');const actual=`${session.model?.provider}/${session.model?.id}`;if(expected!==actual){unsubscribe();session.dispose();throw new Error('Resolved child model differs from frozen model.');}}
 if(explicitThinking!==undefined&&session.thinkingLevel!==explicitThinking){unsubscribe();session.dispose();throw new Error('Effective thinking level is unsupported by the frozen model; refusing silent SDK clamping.');}
 if(fixture){
  const {createAssistantMessageEventStream}=await import(pathToFileURL(join(await resolveHostDependencyRoot(root,"@earendil-works/pi-ai"),"dist/utils/event-stream.js")).href);
  let streamCalls=0;const continuationFixture=fixture==='continuation'||fixture==='checkpoint';
  session.agent.streamFunction=async()=>{
   const stream=createAssistantMessageEventStream();
   if(fixture==='pending'){await new Promise<void>(r=>session.agent.state?.isStreaming?setTimeout(r,50):r());}
   const n=streamCalls++;const model=session.model;
   const completed=session.messages.filter((m:any)=>m.role==='toolResult').length;
   const duplicate=continuationFixture&&completed===14&&(['duplicate-id','new-id'].includes(params.fixtureScenario)&&model.provider==='kimi-coding'||params.fixtureScenario==='transient-duplicate'&&session.messages.some((m:any)=>m.role==='assistant'&&m.stopReason==='error'));
   const call=continuationFixture?completed<14||duplicate:fixture==='tool'&&n===0;
   const transient=continuationFixture&&!call&&params.fixtureScenario?.startsWith('transient-')&&(params.fixtureScenario==='transient-twice'||session.messages.filter((m:any)=>m.role==='assistant'&&m.stopReason==='error').length===0);
   const quota=transient||(!params.fixtureScenario?.startsWith('transient-')||params.fixtureScenario==='transient-provider')&&(fixture==='quota'||fixture==='route-fallback'&&model.provider==='kimi-coding'||continuationFixture&&!call&&(params.fixtureScenario==='completed-tool-error'?model.provider==='glm':params.fixtureScenario==='non-gpt-policy'?model.provider!=='xai':!model.provider.startsWith('parent')||params.fixtureScenario==='exhausted'));
   const toolId=duplicate&&['duplicate-id','transient-duplicate'].includes(params.fixtureScenario)?'fixture-tool-0':continuationFixture?`fixture-tool-${completed}`:'fixture-tool';
   const content=call?[{type:'toolCall',id:toolId,name:continuationFixture&&(completed===0||duplicate)?'write':'read',arguments:continuationFixture&&(completed===0||duplicate)?{path:join(cwd,'written.txt'),content:duplicate?'REPLAYED':'written-once'}:{path:join(cwd,params.fixtureScenario==='handled-tool-error'||params.fixtureScenario==='completed-tool-error'&&completed===1?'missing.txt':'fixture.txt')}}]:[{type:'text',text:quota?'':'Owned fixture response'}];
   const msg={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,stopReason:quota?'error':call?'toolUse':'stop',...(quota?{errorMessage:transient?'Request timed out':model.provider==='glm'?'HTTP 400 InvalidSubscription: CodingPlan expired':'429 quota exceeded'}:{}),timestamp:Date.now(),usage:{input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   if(params.fixtureScenario==='transient-unknown-usage'&&transient)(msg as any).usage=undefined;
   stream.push({type:'start',partial:msg});stream.push(quota?{type:'error',reason:'error',error:msg}:{type:'done',reason:call?'toolUse':'stop',message:msg});stream.end();return stream;
  };
 }
 const guardTransport=(transport:any)=>(model:any,...args:any[])=>{checkModel(model);assertModelContextInput(model,args[0]);return transport(model,...args);};
 let guardedStream=guardTransport(session.agent.streamFunction);
 // Each getter value retains its transport snapshot so legitimate wrapper chains
 // can capture the previous function without recursing into their replacement.
 Object.defineProperty(session.agent,'streamFunction',{configurable:false,get:()=>guardedStream,set:(next:any)=>{if(next!==guardedStream)guardedStream=guardTransport(next);}});
 const ownGuard=await realpath(fileURLToPath(new URL('../../extensions/pi-graph-guard.ts',import.meta.url)));
 const actualPaths=await Promise.all(paths.map((p:string)=>realpath(p).catch(()=>'')));
 const controlledEnvironment=actualPaths.every((p:string)=>p===ownGuard);
 let shutdownComplete=false;
 const modelDefinition=(m:any)=>Object.fromEntries(["provider","id","api","baseUrl","input","contextWindow","maxTokens","reasoning","thinkingLevelMap"].map(k=>[k,m[k]]));
 const frozenModels=new Map<string,any>();
 for(const candidate of intent.continuation?.plan.candidates??[]){
  let r:any;
  if(fixture){const id=candidate.resolvedModel.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u,'');const slash=id.indexOf('/');r={model:{...resolved.model,provider:id.slice(0,slash),id:id.slice(slash+1)}};}
  else r=sdk.resolveCliModel({cliModel:candidate.resolvedModel,modelRuntime:runtime});
  if(r.error||!r.model)throw Error('Frozen continuation model unavailable');
  assertCandidateModelCapabilities(candidate,r.model,intent.continuation?.plan.requirements);
  frozenModels.set(candidate.resolvedModel,r.model);
 }
 const ownedChild={session,acknowledged,root,controlledEnvironment,
 get runtimeFingerprint(){return canonicalDigest({activeTools,settings:baseSettings,systemPrompt:session.agent.state.systemPrompt,extensions:actualPaths});},
 get actualModelDefinition(){return modelDefinition(session.model);},
 modelDefinitions:[...frozenModels].map(([id,m])=>({model:id,definition:modelDefinition(m)})),
 async switchModel(index:number){
  if(fixture&&params.fixtureScenario==='switch-rejected')throw Error('Fixture model switch rejected');
  const c=intent.continuation?.plan.candidates[index],m=c&&frozenModels.get(c.resolvedModel);if(!m)throw Error('Unadmitted continuation model');
  checkModel(m);
  assertCandidateModelCapabilities(c,m,intent.continuation?.plan.requirements);
  assertModelContextInput(m,session.messages);
  const thinking=candidateThinking(c);
  await session.setModel(m,{persist:false});if(thinking!==undefined)session.setThinkingLevel(thinking,{persist:false});
  if(session.model.provider!==m.provider||session.model.id!==m.id||(thinking!==undefined&&session.thinkingLevel!==thinking)||!supportedThinking(m,session.thinkingLevel))throw Error('Continuation model/thinking acknowledgement mismatch');
 },
 async shutdown(){try{await session.abort();if(session.extensionRunner.hasHandlers('session_shutdown'))await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});shutdownComplete=true;recordOwnedShutdown(ownedChild,true);}finally{if(!shutdownComplete)recordOwnedShutdown(ownedChild,false);unsubscribe();session.dispose();}return shutdownComplete;}};
 brandOwnedChild(ownedChild); return ownedChild;
}
