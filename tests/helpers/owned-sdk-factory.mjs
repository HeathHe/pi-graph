// Test-only SDK adapter: production execution remains the isolated owned worker.
// This lets historical guard/context fixtures exercise the same host SDK without native dependencies.
import {join} from 'node:path';import{homedir}from'node:os';
export function createDefaultChildSessionFactory({loadPiCodingAgent}){
 let runtime;
 return {async create(launch){
  const sdk=await loadPiCodingAgent();runtime??=await sdk.ModelRuntime.create();
  for(const[k,v]of Object.entries(launch.processEnv??{})){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  const agentDir=process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi/agent');
  const settings=sdk.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const loader=new sdk.DefaultResourceLoader({cwd:launch.cwd,agentDir,settingsManager:settings,noExtensions:!launch.ambientExtensions,noSkills:launch.noSkills,noContextFiles:launch.noContextFiles,noPromptTemplates:true,noThemes:true,additionalExtensionPaths:launch.extensionPaths??[],extensionFactories:launch.hooks??[],...(launch.noSkills?{skillsOverride:b=>({...b,skills:[]})}:{}),...(launch.systemPrompt!==undefined?{systemPrompt:launch.systemPrompt}:{}),...(launch.appendSystemPrompt!==undefined?{appendSystemPrompt:[launch.appendSystemPrompt]}:{})});
  await loader.reload();const loaded=loader.getExtensions();if(loaded.errors.length)throw Error(JSON.stringify(loaded.errors));
  for(const p of loaded.runtime.pendingProviderRegistrations??[])runtime.registerProvider(p.name,p.config);for(const p of loaded.runtime.pendingNativeProviderRegistrations??[])runtime.registerNativeProvider(p.provider);
  if(loaded.runtime.pendingProviderRegistrations?.length||loaded.runtime.pendingNativeProviderRegistrations?.length)await runtime.refresh({allowNetwork:false});
  loaded.runtime.pendingProviderRegistrations=[];loaded.runtime.pendingNativeProviderRegistrations=[];
  const resolved=sdk.resolveCliModel({cliModel:launch.model,modelRuntime:runtime});if(resolved.error)throw Error(resolved.error);
  const manager=launch.storage?.kind==='dir'?sdk.SessionManager.create(launch.cwd,launch.storage.sessionDir):sdk.SessionManager.inMemory(launch.cwd);
  const{session}=await sdk.createAgentSession({cwd:launch.cwd,agentDir,modelRuntime:runtime,model:resolved.model,tools:launch.tools??['read','bash','edit','write','grep','find','ls'],resourceLoader:loader,sessionManager:manager,settingsManager:settings});
  await session.bindExtensions({mode:'print',onError:launch.onExtensionError??(e=>{throw e.error})});
  return {prompt:(...args)=>session.prompt(...args),abort:()=>session.abort(),subscribe:fn=>session.subscribe(fn),get messages(){return session.messages},get agent(){return session.agent},get sessionFile(){return session.sessionManager.getSessionFile()},async dispose(){await session.abort();if(session.extensionRunner.hasHandlers('session_shutdown'))await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose()}};
 },async dispose(){}};
}
