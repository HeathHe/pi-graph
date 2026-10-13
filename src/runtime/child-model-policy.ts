import {modelFamilyId} from './model-capabilities.ts';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';

/** A child-only deny ceiling. Project settings may add restrictions, never remove them. */
export interface ChildModelPolicy {denyFamilies:string[]}
export function mergeChildModelPolicies(...values:any[]):ChildModelPolicy {
 const families=new Set<string>();
 for(const value of values){const deny=value?.denyFamilies;if(deny===undefined)continue;if(!Array.isArray(deny)||deny.some(x=>typeof x!=='string'||!/^[-a-z0-9_]+$/i.test(x)))throw Error('Invalid child model denyFamilies policy');for(const family of deny)families.add(family.toLowerCase());}
 return {denyFamilies:[...families].sort()};
}
function policies(settings:any,name?:string){return ['subagents','graphAgents'].flatMap(key=>{const scope=settings?.[key]?.modelScope;return [scope,...(name?[scope?.agents?.[name]]:[])];});}
export function childPolicyFromSettings(user:any,project:any,name?:string):ChildModelPolicy {return mergeChildModelPolicies(...policies(user,name),...policies(project,name));}
export function readChildModelPolicy(cwd:string,name?:string,agentDir=process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent')):ChildModelPolicy {
 const read=(path:string)=>{if(!existsSync(path))return {};const value=JSON.parse(readFileSync(path,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid child model policy settings');return value;};
 let project:any={};for(let p=resolve(cwd);;p=dirname(p)){if(['.pi','.agents'].some(d=>{try{return statSync(join(p,d)).isDirectory();}catch{return false;}})){project=read(join(p,'.pi/settings.json'));break;}if(p===dirname(p))break;}
 return childPolicyFromSettings(read(join(agentDir,'settings.json')),project,name);
}
export function assertChildModelAllowed(model:string|{id:string;provider?:string}|undefined,policy:ChildModelPolicy):void {
 if(!policy.denyFamilies.length)return;
 const raw=(typeof model==='string'?model:model?.id)?.trim();
 const id=raw?.slice(raw.lastIndexOf('/')+1).trim().replace(/:(off|minimal|low|medium|high|xhigh|max)$/i,'').toLowerCase();
 if(!id)throw Error('Child model identity missing under family deny policy');
 const family=modelFamilyId(id);
 if(policy.denyFamilies.includes(family))throw Error(`Child model family '${family}' is denied by model policy.`);
}
