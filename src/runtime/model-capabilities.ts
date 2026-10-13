/** Shared bounded pool policy. No automatic pool is enabled by this module. */
export const MAX_MODEL_CANDIDATES=64;
export const MAX_MODEL_DEGRADATIONS=MAX_MODEL_CANDIDATES-1;
export interface ModelCapabilities {input:('text'|'image')[];tools:boolean;thinkingLevels:string[];source:string;}
export interface ModelRequirements {requiredInputModalities?:('text'|'image')[];requireToolCalls?:boolean;maximumAutomaticFallback?:string;}
export function modelFamilyId(model:string):string {const id=model.trim().split('/').at(-1)!.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i,'').toLowerCase();if(/^k\d+(?:$|[-_.])/.test(id)||/^kimi(?:$|[-_.])/.test(id))return 'kimi';if(/^gpt(?:$|[-_.0-9])/.test(id))return 'gpt';return id.split(/[-_.:]/)[0]!;}
export function validateModelCapabilities(c:any):asserts c is ModelCapabilities {if(!c||!Array.isArray(c.input)||!c.input.length||c.input.some((v:any)=>!['text','image'].includes(v))||new Set(c.input).size!==c.input.length||typeof c.tools!=='boolean'||!Array.isArray(c.thinkingLevels)||!c.thinkingLevels.length||c.thinkingLevels.some((v:any)=>!['off','minimal','low','medium','high','xhigh','max'].includes(v))||typeof c.source!=='string'||!c.source.trim())throw Error('Invalid model capability evidence');}
export function validateModelRequirements(c:any):void {if(!c||typeof c!=='object'||Array.isArray(c))throw Error('Invalid model requirements');if(c.requiredInputModalities!==undefined&&(!Array.isArray(c.requiredInputModalities)||c.requiredInputModalities.some((v:any)=>!['text','image'].includes(v))))throw Error('Invalid required input modalities');if(c.requireToolCalls!==undefined&&typeof c.requireToolCalls!=='boolean')throw Error('Invalid tool requirement');if(c.maximumAutomaticFallback!==undefined&&!/^L[0-9]+$/.test(c.maximumAutomaticFallback))throw Error('Invalid maximum automatic capability level');}
export function candidateMeetsRequirements(c:any,r:ModelRequirements|undefined,model?:any):boolean {
 if(c.capabilities!==undefined)validateModelCapabilities(c.capabilities);
 if(r)validateModelRequirements(r);
 const input=c.capabilities?.input??model?.input;
 if(r?.requiredInputModalities?.some(i=>!input?.includes(i)))return false;
 if(r?.requireToolCalls&&!c.capabilities?.tools)return false;
 if(r?.maximumAutomaticFallback&&(!/^L[0-9]+$/.test(c.level??'')||Number(c.level.slice(1))>Number(r.maximumAutomaticFallback.slice(1))))return false;
 const thinking=c.thinking===false?'off':c.thinking;
 if(c.capabilities&&thinking!==undefined&&!c.capabilities.thinkingLevels.includes(thinking))return false;
 if(model&&c.capabilities?.input.some((i:string)=>!model.input?.includes(i)))return false;
 if(model&&c.capabilities&&thinking!==undefined&&(!model.reasoning?thinking!=='off':model.thinkingLevelMap?.[thinking]===null||['xhigh','max'].includes(thinking)&&model.thinkingLevelMap?.[thinking]===undefined))return false;
 return true;
}
export function assertCandidateModelCapabilities(c:any,model:any,r?:ModelRequirements):void {if(!candidateMeetsRequirements(c,r,model))throw Error('Frozen model capability requirements violated');}

/** Tool results may introduce images after admission; never silently discard them on a text-only switch. */
export function assertModelContextInput(model:any,context:any):void {
 if(model?.input?.includes('image'))return;
 const messages=Array.isArray(context)?context:context?.messages;
 if(Array.isArray(messages)&&messages.some((m:any)=>Array.isArray(m?.content)&&m.content.some((c:any)=>c?.type==='image')))throw Error('Child model cannot receive existing image context');
}

export interface LatestModelIdentity {
 family:string;tier:string;version:string;releaseStatus:'stable';
 metadataSource:{urls:string[];checkedAt:string;validationStatus:'tool-protocol-verified'|'declared-current-quota'};
}
export interface LatestModelPolicy {latestPolicy?:'latest-per-tier';approvedLatestIds?:string[];}
/** Parse fixed identities, not release ordering. Approval remains exclusively in profile configuration. */
function fixedModelIdentity(id:string):readonly [string,string,string]|undefined {
 let m:RegExpMatchArray|null;
 if((m=id.match(/^glm-(\d+(?:\.\d+)*)(-flash)?$/)))return ['glm',m[2]?'flash':'standard',m[1]!];
 if((m=id.match(/^(k\d+(?:\.\d+)*)$/)))return ['kimi','coding',m[1]!];
 if((m=id.match(/^mimo-v(\d+(?:\.\d+)*)-(pro|flash|pro-ultraspeed)$/)))return ['mimo',m[2]==='pro-ultraspeed'?'ultraspeed':m[2]!,m[1]!];
 if((m=id.match(/^grok-(\d+(?:\.\d+)*)$/)))return ['grok','standard',m[1]!];
 if((m=id.match(/^gemini-(\d+(?:\.\d+)*)-(flash-lite|flash|pro)$/)))return ['gemini',m[2]!,m[1]!];
 if((m=id.match(/^claude-(opus|sonnet|haiku)-(\d+(?:-\d+)*)$/)))return ['claude',m[1]!,m[2]!.replaceAll('-','.')];
 if((m=id.match(/^deepseek-(v\d+(?:\.\d+)*|r\d+(?:\.\d+)*)(?:-(pro|flash))?$/)))return ['deepseek',m[2]??'standard',m[1]!.slice(1)];
 if((m=id.match(/^jev-(\d+(?:\.\d+)*)$/)))return ['jev','unspecified',m[1]!];
 // Unrecognized aliases/classifier IDs require explicit schema support, not guessed identities.
 return undefined;
}
const IDENTITY_FIELDS=['family','tier','version','releaseStatus','metadataSource'] as const;
export function modelIdentityFields(candidate:any):Partial<LatestModelIdentity> {return Object.fromEntries(IDENTITY_FIELDS.filter(k=>candidate[k]!==undefined).map(k=>[k,structuredClone(candidate[k])])) as Partial<LatestModelIdentity>;}
export function validateLatestIdentity(candidate:any,required=false):void {
 if(!required&&!IDENTITY_FIELDS.some(k=>candidate[k]!==undefined))return;
 const full=candidate.model??candidate.requestedModel;
 if(typeof full!=='string'||!full.includes('/'))throw Error('Latest candidate requires a full model identity');
 const id=full.split('/').at(-1)!.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i,'').toLowerCase();
 const family=modelFamilyId(full);
 if(!['glm','kimi','mimo','grok','gemini','claude','deepseek','jev'].includes(family)||candidate.family!==family)throw Error('Latest candidate family does not match resolved model identity');
 const canonical=fixedModelIdentity(id);
 if(!canonical||candidate.family!==canonical[0]||candidate.tier!==canonical[1]||candidate.version!==canonical[2])throw Error('Latest candidate tier/version does not match canonical identity');
 if(candidate.releaseStatus!=='stable'||/(?:^|[-_.])(latest|preview|build)(?:$|[-_.])/.test(id))throw Error('Latest candidate must be a fixed stable model');
 if(candidate.resolvedModel!==undefined&&candidate.resolvedModel.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i,'')!==full.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i,''))throw Error('Latest resolved model differs from approved identity');
 const source=candidate.metadataSource;
 if(!source||Object.keys(source).some(k=>!['urls','checkedAt','validationStatus'].includes(k))||!Array.isArray(source.urls)||!source.urls.length||source.urls.length>8||source.urls.some((raw:any)=>{try{const url=new URL(raw);return typeof raw!=='string'||url.protocol!=='https:'||!!url.username||!!url.password||!!url.search||!!url.hash;}catch{return true;}})||typeof source.checkedAt!=='string'||!Number.isFinite(Date.parse(source.checkedAt))||!['tool-protocol-verified','declared-current-quota'].includes(source.validationStatus))throw Error('Latest model metadata source is invalid');
}
export function validateLatestModelPolicy(policy:any,candidates:any[]):void {
 if(policy.latestPolicy===undefined){if(policy.approvedLatestIds!==undefined)throw Error('Approved latest IDs require an explicit policy');for(const c of candidates)validateLatestIdentity(c);return;}
 if(policy.latestPolicy!=='latest-per-tier'||!Array.isArray(policy.approvedLatestIds)||!policy.approvedLatestIds.length||policy.approvedLatestIds.length>MAX_MODEL_CANDIDATES||policy.approvedLatestIds.some((id:any)=>typeof id!=='string'||!/^\S+\/\S+$/.test(id)||['gpt','codex'].includes(modelFamilyId(id)))||new Set(policy.approvedLatestIds).size!==policy.approvedLatestIds.length)throw Error('Invalid latest-per-tier approval policy');
 const tiers=new Set<string>();for(const c of candidates){validateLatestIdentity(c,true);if(!policy.approvedLatestIds.includes(c.model??c.requestedModel))throw Error('Model is not an approved latest candidate');const tier=`${c.family}/${c.tier}`;if(tiers.has(tier))throw Error('Latest policy permits only one model per family/tier');tiers.add(tier);}
}
