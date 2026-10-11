import {normalizeExtensionBindings} from './extension-bindings.ts';
import {readCustomGraphModels,validateCustomGraphModel} from "./custom-models.ts";
import {readRoleModelOverride} from "./settings.ts";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { agentDefinitionDigest, discoverAgents, stableJsonDigest } from "./agents.ts";
import type { AgentConfig, AgentScope } from "./agents.ts";
const DEFAULT_TOOLS=["read","bash","edit","write","grep","find","ls"];
const THINKING=["off","minimal","low","medium","high","xhigh","max"];
const removedTool=(t:string)=>t==="contact_supervisor"||t==="subagent_supervisor"||t==="subagent"||t.startsWith("intercom");
export interface ToolPlanInput {
 tools?: string[]; excludeTools?: string[]; extensions?: string[]; subagentOnlyExtensions?: string[];
 cwd: string; agentName?: string; capabilityCeiling?: {allowedTools?:string[];denyExtensions?:boolean};
 inheritedCapabilityCeiling?: {allowedTools?:string[];denyExtensions?:boolean};
 requiredExtensions?:Array<{id:string;path:string}>; mcpDirectTools?:string[]; permissionRules?:unknown;
 builtinMcpTools?:Array<{name:string}>; structuredOutput?:boolean; requireReadTool?:boolean;
 [key:string]:unknown;
}
export function resolvePiLaunchToolPlan(input:ToolPlanInput) {
 if(input.mcpDirectTools?.length&&!input.builtinMcpTools) throw new Error("MCP selectors require an explicit host-resolved tool snapshot; ambient MCP access is not implicitly granted.");
 if(input.permissionRules&&Object.keys(input.permissionRules as object).length)throw new Error("Agent permission rules require a supported permission runtime; refusing to launch without enforcement.");
 const ceilings=[input.capabilityCeiling,input.inheritedCapabilityCeiling].filter(Boolean);
 const denyExtensions=ceilings.some(c=>c!.denyExtensions===true);
 let allowed:string[]|undefined;
 for(const c of ceilings)if(c!.allowedTools!==undefined)allowed=allowed===undefined?[...c!.allowedTools]:allowed.filter(t=>c!.allowedTools!.includes(t));
 const requestedBuiltinTools=input.tools?.filter(t=>!t.includes("/")&&!/\.[cm]?[jt]s$/u.test(t))??DEFAULT_TOOLS;
 const excludeTools=[...new Set(input.excludeTools??[])];
 const effectiveToolAllowlist=[...new Set([...requestedBuiltinTools,...(input.builtinMcpTools??[]).map(t=>t.name),...(input.structuredOutput?["structured_output"]:[])])].filter(t=>!removedTool(t)&&!excludeTools.includes(t)&&(allowed===undefined||allowed.includes(t)));
 if(input.requireReadTool&&!effectiveToolAllowlist.includes("read"))throw new Error("Agent skill loading requires the read tool within its capability ceiling.");
 const toolExtensionPaths=(input.tools??[]).filter(t=>t.includes("/")||/\.[cm]?[jt]s$/u.test(t));
 const configuredExtensions=denyExtensions?[]:[...new Set([...toolExtensionPaths,...(input.extensions??[]),...(input.subagentOnlyExtensions??[])])].map(p=>isAbsolute(p)?resolve(p):p.startsWith(".")?resolve(input.cwd,p):p);
 const requiredExtensions=input.requiredExtensions??[];
 if(denyExtensions&&requiredExtensions.length)throw new Error("Capability ceiling denies host-required extensions.");
 const extensionArgs=[...new Set([...configuredExtensions,...requiredExtensions.map(e=>e.path)])];
 for(const p of extensionArgs)if(isAbsolute(p)&&!existsSync(p))throw new Error(`Configured Agent extension does not exist: ${p}`);
 return {effectiveCapabilityCeiling:{...(allowed===undefined?{}:{allowedTools:allowed}),denyExtensions},requestedBuiltinTools,declaredBuiltinTools:effectiveToolAllowlist,excludeTools,effectiveToolAllowlist,explicitToolAllowlist:true,requiredChildTools:[...effectiveToolAllowlist],internalTools:input.structuredOutput?["structured_output"]:[],effectiveMcpTools:(input.builtinMcpTools??[]).map(t=>t.name).filter(t=>effectiveToolAllowlist.includes(t)),toolExtensionPaths,runtimeExtensions:[] as string[],configuredExtensions,requiredExtensions,extensionArgs,disableAmbientExtensions:denyExtensions||input.extensions!==undefined,fanoutAuthorized:false,warnings:[] as string[]};
}
export interface LaunchContractInput {
 agent:string; cwd:string; task?:string; agentScope?:AgentScope; context?:string;
 model?:string; thinking?:string|false; parentModel?:{provider:string;id:string};
 availableModels?:readonly {provider:string;id:string;fullId?:string;reasoning?:boolean;thinkingLevelMap?:Partial<Record<string,string|null>>}[];
 preferredProvider?:string; capabilityCeiling?:ToolPlanInput["capabilityCeiling"];
 inheritedCapabilityCeiling?:ToolPlanInput["capabilityCeiling"]; requiredExtensions?:ToolPlanInput["requiredExtensions"];
 [key:string]:unknown;
}
function splitModel(value:string) {const m=/:(off|minimal|low|medium|high|xhigh|max)$/u.exec(value);return {id:m?value.slice(0,-m[0].length):value,thinking:m?.[1]};}
function chooseModel(raw:string,input:LaunchContractInput,agent:AgentConfig):string {
 const available=input.availableModels?.map(m=>({...m,fullId:m.fullId??`${m.provider}/${m.id}`}));
 if(raw.includes("/")){if(available&&!available.some(m=>m.fullId===raw))throw new Error(`Model '${raw}' is unavailable in the supplied model registry.`);return raw;}
 const preferred=agent.modelProvider??input.preferredProvider??input.parentModel?.provider;
 const matches=available?.filter(m=>m.id===raw);
 if(matches){const selected=matches.find(m=>m.provider===preferred)??(matches.length===1?matches[0]:undefined);if(!selected)throw new Error(`Model '${raw}' is unavailable or ambiguous; use provider/model.`);return selected.fullId;}
 if(preferred)return `${preferred}/${raw}`;
 throw new Error(`Model '${raw}' needs a provider or an available-model snapshot.`);
}
function enforceScope(scope:any,name:string,model:string,input:LaunchContractInput){
 if(!scope?.enforce)return;
 const allowedFor=(allow:unknown)=> !Array.isArray(allow)||allow.some(v=>v===model||(v==="inherit"&&input.parentModel&&model===`${input.parentModel.provider}/${input.parentModel.id}`));
 if(!allowedFor(scope.allow)||!allowedFor(scope.agents?.[name]?.allow))throw new Error(`Model '${model}' is outside the configured Agent model scope.`);
}
export async function resolveSubagentLaunchContract(input:LaunchContractInput) {
 try{normalizeExtensionBindings(input.extensionBindings);}catch(error){return {ok:false as const,code:"invalid_extension_bindings",message:error instanceof Error?error.message:String(error),diagnostics:[]};}
 try{
  const customModelDefinitions=(input.customModelDefinitions as unknown[]|undefined)?.map(validateCustomGraphModel)??readCustomGraphModels(input.cwd);
  if(input.availableModels!==undefined)input={...input,availableModels:[...input.availableModels,...customModelDefinitions.map(m=>({...m,fullId:`${m.provider}/${m.id}`}))]};
  if(!statSync(resolve(input.cwd)).isDirectory())throw new Error("Agent cwd must be an existing directory.");
  if(input.context!==undefined&&input.context!=="fresh")throw new Error("Owned Graph runtime accepts fresh child context only.");
  const discovered=discoverAgents(input.cwd,input.agentScope??"both",input.preferredProvider);
  const exact=discovered.agents.find(a=>a.name===input.agent);
  const matches=exact?[exact]:discovered.agents.filter(a=>a.localName===input.agent||a.aliases?.includes(input.agent));
  if(matches.length!==1)throw new Error(matches.length?`Agent '${input.agent}' is ambiguous; use its qualified name.`:`Agent '${input.agent}' was not found. ${discovered.agentDiagnostics.map(d=>d.message).join(" ")}`);
  const a=matches[0]!;
  if(a.runner!==undefined&&typeof a.runner!=="string"&&(a.runner as any)?.type!=="pi")throw new Error(`Agent '${a.name}' declares an unsupported external runner.`);
  if(typeof a.runner==="string"&&a.runner!=="pi")throw new Error(`Agent '${a.name}' declares an unsupported external runner.`);
  if(a.fast===true)throw new Error("Fast provider overrides are not supported by the owned Graph child runtime.");
  const override=readRoleModelOverride(a.name,input.cwd);
  const selected=input.model??override?.model??a.model??(input.parentModel?`${input.parentModel.provider}/${input.parentModel.id}`:undefined);
  let model:string|undefined, suffixThinking:string|undefined;
  if(selected){const parsed=splitModel(selected);model=chooseModel(parsed.id,input,a);suffixThinking=parsed.thinking;enforceScope(discovered.modelScope,a.name,model,input);}
  const thinking=input.thinking===false?"off":input.thinking??suffixThinking??override?.thinking??a.thinking;
  if(thinking!==undefined&&thinking!==false&&!THINKING.includes(thinking))throw new Error(`Invalid thinking level '${thinking}'.`);
  if(thinking&&discovered.maxThinking&&THINKING.indexOf(thinking)>THINKING.indexOf(discovered.maxThinking))throw new Error("Thinking exceeds the configured maximum.");
  const plan=resolvePiLaunchToolPlan({cwd:resolve(input.cwd),agentName:a.name,tools:a.tools,excludeTools:a.excludeTools,extensions:a.extensions,subagentOnlyExtensions:a.subagentOnlyExtensions,mcpDirectTools:a.mcpDirectTools as string[]|undefined,permissionRules:a.permissions??a.permission,capabilityCeiling:input.capabilityCeiling,inheritedCapabilityCeiling:input.inheritedCapabilityCeiling,requiredExtensions:input.requiredExtensions});
  const definitionDigest=agentDefinitionDigest(a);
  const launchContractDigest=stableJsonDigest({version:1,definitionDigest,task:input.task,model,thinking,tools:plan.effectiveToolAllowlist,extensions:plan.extensionArgs,disableAmbientExtensions:plan.disableAmbientExtensions,capabilityCeiling:plan.effectiveCapabilityCeiling,systemPromptMode:a.systemPromptMode,inheritProjectContext:a.inheritProjectContext,inheritGlobalContext:a.inheritGlobalContext,inheritSkills:a.inheritSkills,customModelDefinitions});
  const contract={version:1,...(customModelDefinitions.length?{customModelDefinitions}:{}),agent:{name:a.name,localName:a.localName,source:a.source,filePath:a.filePath,definitionDigest},context:"fresh",model,modelCandidates:model?[model]:[],thinking:thinking===false?"off":thinking,systemPromptMode:a.systemPromptMode,inheritProjectContext:a.inheritProjectContext,inheritGlobalContext:a.inheritGlobalContext,inheritSkills:a.inheritSkills,tools:{...plan,effectiveAllowlist:plan.effectiveToolAllowlist,explicitAllowlist:plan.explicitToolAllowlist},roots:{cwd:resolve(input.cwd)},launchContractDigest,digest:launchContractDigest};
  return {ok:true as const,contract};
 }catch(e){return {ok:false as const,code:"invalid_launch",message:e instanceof Error?e.message:String(e),diagnostics:[]};}
}
