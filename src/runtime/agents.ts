import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

export interface AgentConfig {
 name: string; localName?: string; packageName?: string; description: string;
 source: string; filePath: string; systemPrompt: string; tools?: string[];
 excludeTools?: string[]; extensions?: string[]; subagentOnlyExtensions?: string[];
 model?: string; modelProvider?: string; thinking?: string | false;
 systemPromptMode: string; inheritProjectContext: boolean; inheritGlobalContext: boolean; inheritSkills: boolean;
 aliases?: string[]; disabled?: boolean; definitionDigest?: string;
 [key: string]: unknown;
}
export type AgentScope = "both" | "project" | "user";
export function stableJson(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
 if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
 return JSON.stringify(value);
}
export function stableJsonDigest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
const lists = ["tools", "excludeTools", "aliases", "extensions", "subagentOnlyExtensions", "mutationTools", "skills", "skillPath", "allowedAgents", "defaultReads"];
const booleans = ["inheritProjectContext", "inheritGlobalContext", "inheritSkills", "allowNestedSubagents", "defaultProgress", "interactive", "fast", "advertise", "disabled"];
function list(value: unknown): string[] | undefined {
 if(value === undefined) return undefined;
 if(value === null || value === "") return [];
 const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
 if (!values || values.some(v=>typeof v!=="string")) throw new Error("Agent list must contain strings.");
 return values.map(v=>String(v).trim()).filter(Boolean);
}
export function parseAgentDefinition(text: string, filePath: string, source = "project"): AgentConfig {
 const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
 if (!match) throw new Error(`Agent '${filePath}' is missing YAML frontmatter.`);
 const f = parse(match[1]!) as Record<string, unknown>;
 if (!f || typeof f !== "object" || Array.isArray(f) || typeof f.name!=="string" || !f.name.trim()) throw new Error(`Invalid Agent name in '${filePath}'.`);
 const localName=f.name.trim();
 const packageName=typeof f.package==="string" && f.package.trim() ? f.package.trim() : undefined;
 const a: AgentConfig={...f,name:packageName?`${packageName}.${localName}`:localName,localName,...(packageName?{packageName}:{}),description:typeof f.description==="string"?f.description:"",source,filePath:resolve(filePath),systemPrompt:match[2]!.trim(),systemPromptMode:"append",inheritProjectContext:true,inheritGlobalContext:false,inheritSkills:true};
 delete a.package;
 for(const key of lists) { const v=list(f[key] !== undefined ? f[key] : (key==="aliases"?f.alias:key==="skills"?f.skill:undefined)); if(v!==undefined)a[key]=v; }
 for(const key of booleans) if(f[key]!==undefined) { if(typeof f[key]!=="boolean") throw new Error(`Agent '${a.name}' ${key} must be boolean.`); a[key]=f[key]; }
 if(f.systemPromptMode!==undefined) { if(!["append","replace"].includes(String(f.systemPromptMode))) throw new Error("Invalid systemPromptMode."); a.systemPromptMode=String(f.systemPromptMode); }
 for(const [from,to] of [["async","defaultAsync"],["timeoutMs","defaultTimeoutMs"],["toolTimeoutMs","defaultToolTimeoutMs"],["acceptance","defaultAcceptance"]]) if(f[from!]!==undefined){a[to!]=f[from!];delete a[from!];}
 for(const key of ["model","thinking","modelProvider"]) if(f[key]!==undefined && typeof f[key]!=="string" && !(key==="thinking"&&f[key]===false)) throw new Error(`Invalid Agent ${key}.`);
 for(const key of ["extensions","subagentOnlyExtensions"]) if(a[key]!==undefined) a[key]=(a[key] as string[]).map(p=>p.startsWith(".") ? resolve(dirname(filePath),p) : p);
 if(a.tools){ const mcp=a.tools.filter(t=>t.startsWith("mcp:")); a.tools=a.tools.filter(t=>!t.startsWith("mcp:")); if(mcp.length)a.mcpDirectTools=mcp.map(t=>t.slice(4)); }
 return a;
}
export function serializeAgent(agent: AgentConfig): string {
 const f: Record<string,unknown>={};
 const omitted=new Set(["name","localName","packageName","source","filePath","systemPrompt","definitionDigest","modelSource","discoveryPriority","packageSourceName","packageSourceVersion","packageSourceRoot"]);
 f.name=agent.localName ?? (agent.packageName && agent.name.startsWith(`${agent.packageName}.`)?agent.name.slice(agent.packageName.length+1):agent.name);
 if(agent.packageName)f.package=agent.packageName;
 for(const [k,v] of Object.entries(agent)) if(!omitted.has(k)&&v!==undefined) f[k]=v;
 for(const [to,from] of [["async","defaultAsync"],["timeoutMs","defaultTimeoutMs"],["toolTimeoutMs","defaultToolTimeoutMs"],["acceptance","defaultAcceptance"]]) if(f[from!]!==undefined){f[to!]=f[from!];delete f[from!];}
 if(Array.isArray(f.mcpDirectTools)){ f.tools=[...(agent.tools??[]),...f.mcpDirectTools.map(t=>`mcp:${t}`)]; delete f.mcpDirectTools; }
 return `---\n${stringify(f).trimEnd()}\n---\n\n${agent.systemPrompt}\n`;
}
export function agentDefinitionDigest(agent: AgentConfig): string {
 if(agent.definitionDigest) return agent.definitionDigest;
 let fileContentDigest: string | undefined;
 try{ fileContentDigest=createHash("sha256").update(readFileSync(agent.filePath)).digest("hex"); }catch{}
 const excluded=new Set(["definitionDigest","source","description","discoveryPriority","modelSource"]);
 return stableJsonDigest({version:1,...Object.fromEntries(Object.entries(agent).filter(([k])=>!excluded.has(k))),fileContentDigest});
}
function settings(path: string): Record<string,any> { if(!existsSync(path))return {}; const d=JSON.parse(readFileSync(path,"utf8")); if(!d||typeof d!=="object"||Array.isArray(d))throw new Error(`Invalid settings '${path}'.`); return d; }
function isDir(path:string):boolean { try{return statSync(path).isDirectory();}catch{return false;} }
export function discoverAgents(cwd: string, scope: AgentScope = "both", _preferredProvider?: string) {
 const base=resolve(cwd), agentDir=process.env.PI_CODING_AGENT_DIR || join(homedir(),".pi","agent");
 const user=settings(join(agentDir,"settings.json"));
 let projectRoot:string|undefined;
 for(let p=base;;p=dirname(p)){if(isDir(join(p,".pi"))||isDir(join(p,".agents"))){projectRoot=p;break;}if(dirname(p)===p)break;}
 const project=projectRoot?settings(join(projectRoot,".pi","settings.json")):{};
 const dirs:Array<{dir:string;source:string}>=[];
 const add=(dir:string,source:string)=>{if(!dirs.some(d=>d.dir===dir))dirs.push({dir,source});};
 const ownRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../.."); add(join(ownRoot,"agents"),"package");
 if(projectRoot&&existsSync(join(projectRoot,"package.json"))) {
  const pkg=settings(join(projectRoot,"package.json"));
  for(const d of pkg["pi-graph"]?.agents??pkg["pi-subagents"]?.agents??[])if(typeof d==="string")add(resolve(projectRoot,d),"package");
 }
 for(const [s,root] of [[scope==="project"?{}:user,agentDir],[scope==="user"?{}:project,projectRoot??base]] as const){
  for(const entry of s.packages??[]){const p=typeof entry==="string"?entry:entry?.source; if(typeof p!=="string"||p==="npm:pi-subagents")continue;
   const pkgRoot=p.startsWith("npm:")?join(root===agentDir?agentDir:join(root,".pi"),"npm","node_modules",p.slice(4).replace(/@[^/]+$/,"")):isAbsolute(p)?p:p.startsWith(".")?resolve(root,p):undefined;
   if(!pkgRoot||!existsSync(join(pkgRoot,"package.json")))continue;
   const pkg=settings(join(pkgRoot,"package.json"));const configured=pkg["pi-graph"]?.agents??pkg["pi-subagents"]?.agents??[];
   for(const d of configured)if(typeof d==="string")add(resolve(pkgRoot,d),"package");
  }
 }
 const cfg={...(scope!=="project"?(user["graphAgents"]??user.subagents??{}):{}),...(scope!=="user"?(project["graphAgents"]??project.subagents??{}):{})};
 if(scope!=="project") {for(const p of (process.env.PI_GRAPH_EXTRA_AGENT_DIRS??process.env.PI_GRAPH_AGENT_DIRS??process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS??"").split(process.platform==="win32"?";":":").filter(Boolean))add(resolve(p),"user"); for(const d of cfg.agentScanDirs??[])add(resolve(d),"user");add(join(agentDir,"agents"),"user");add(join(homedir(),".agents"),"user");}
 if(scope!=="user"&&projectRoot){add(join(projectRoot,".agents"),"project");add(join(projectRoot,".pi","agents"),"project");}
 const map=new Map<string,AgentConfig>(), diagnostics:Array<{message:string;filePath:string}>=[];
 for(const {dir,source} of dirs){if(!isDir(dir))continue;for(const file of readdirSync(dir).sort()){if(!file.endsWith(".md"))continue;const path=join(dir,file);if(!statSync(path).isFile())continue;
  try {const a=parseAgentDefinition(readFileSync(path,"utf8"),path,source);const override=cfg.agentOverrides?.[a.name]??{};Object.assign(a,override);if(a.model===undefined&&typeof cfg.defaultModel==="string")a.model=cfg.defaultModel;if(a.modelProvider===undefined&&typeof cfg.defaultProvider==="string")a.modelProvider=cfg.defaultProvider;if(a.thinking===undefined&&typeof cfg.defaultThinking==="string")a.thinking=cfg.defaultThinking;map.set(a.name,a);}catch(e){diagnostics.push({filePath:path,message:e instanceof Error?e.message:String(e)});}
 }}
 return {agents:[...map.values()].filter(a=>!a.disabled),agentDiagnostics:diagnostics,cwd:base,scope,projectAgentsDir:projectRoot?join(projectRoot,".pi","agents"):null,modelScope:cfg.modelScope,maxThinking:cfg.maxThinking};
}
