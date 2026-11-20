import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {validHeader} from '../scope.ts';
import {canonical} from '../supervision/normalize.ts';
import type {UsageRecordV1,UsageFact,TokenCounts,CostCounts,UsageFile} from './contracts.ts';
/** Host private proof or explicitly trusted legacy permissions; regular-file ownership stays mandatory. */
export function readableUsageFile(file:UsageFile):boolean{return file.regular&&(file.private||file.trustedLegacyStore===true);}
export const USAGE_MAX_BYTES=16*1024*1024,USAGE_MAX_RECORDS=100000;
export const digest=(value:string):string=>createHash('sha256').update(value).digest('hex');
export function usageSessionBasename(sessionId:string):string {const prefix=sessionId.replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^\.+/,'').slice(0,80)||'unknown';return `${prefix}--${digest(sessionId)}.jsonl`;}
export function legacySessionBasename(sessionId:string):string{return (sessionId.replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^\.+/,'').slice(0,200)||'unknown')+'.jsonl';}
function counts(v:unknown,allowed:readonly string[]):boolean{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.entries(v).every(([k,x])=>allowed.includes(k)&&typeof x==='number'&&Number.isFinite(x)&&x>=0);}
export function validUsageRecord(v:unknown):v is UsageRecordV1 {
 if(!v||typeof v!=='object')return false;const r=v as UsageRecordV1;
 return Number.isFinite(r.ts)&&r.ts>=0&&[r.model,r.provider,r.sessionId,r.cwd].every(s=>typeof s==='string'&&s.length>0&&s.length<=4096)&&counts(r.usage,['input','output','cacheRead','cacheWrite'])&&counts(r.cost,['input','output','cacheRead','cacheWrite','total'])&&(r.messageIdentity===undefined||(typeof r.messageIdentity==='string'&&r.messageIdentity.length>0&&r.messageIdentity.length<=1024));
}
export function usageIdentity(r:UsageRecordV1):string {return digest(JSON.stringify([r.sessionId,r.messageIdentity??['weak',r.ts,r.provider,r.model,digest(canonical({usage:r.usage,cost:r.cost}))]]));}
export function factToRecord(f:UsageFact):UsageRecordV1 {
 if(!validHeader(f.header))throw new Error('Invalid usage header');
 const identity=f.messageIdentity??'weak:'+digest(JSON.stringify([f.header.scope.sessionId,f.header.observedAt,f.provider,f.model,f.contentDigest??f.header.eventId]));
 const r:UsageRecordV1={ts:f.header.observedAt,model:f.model,provider:f.provider,sessionId:f.header.scope.sessionId,cwd:f.cwd,usage:{...f.usage},cost:{...f.cost},messageIdentity:identity,identityStrength:f.messageIdentity?'host':'weak'};
 if(!validUsageRecord(r))throw new Error('Invalid usage fact');return r;
}
export function unknownFields(r:UsageRecordV1):string[]{return [...['input','output','cacheRead','cacheWrite'].filter(k=>r.usage[k as keyof TokenCounts]===undefined).map(k=>'usage.'+k),...['input','output','cacheRead','cacheWrite','total'].filter(k=>r.cost[k as keyof CostCounts]===undefined).map(k=>'cost.'+k)];}
export function toLegacyUsageRecord(r:UsageRecordV1):UsageRecordV1 {return {...r,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,...r.usage},cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0,...r.cost},unknownFields:[...new Set([...(r.unknownFields??[]),...unknownFields(r)])]};}
export function parseUsageJSONL(raw:string):UsageRecordV1[]{
 if(Buffer.byteLength(raw)>USAGE_MAX_BYTES)throw new Error('Usage history size limit');const rows:UsageRecordV1[]=[];
 for(const line of raw.split('\n')){if(!line.trim())continue;const r:unknown=JSON.parse(line);if(!validUsageRecord(r))throw new Error('Invalid usage history record');rows.push(r);if(rows.length>USAGE_MAX_RECORDS)throw new Error('Usage record limit');}return rows;
}
export function mergeUsageRecords(...groups:readonly UsageRecordV1[][]):UsageRecordV1[]{
 const map=new Map<string,UsageRecordV1>();
 for(const r of groups.flat()){if(!validUsageRecord(r))throw new Error('Invalid usage record');const key=usageIdentity(r),old=map.get(key);if(old&&canonical(old)!==canonical(r))throw new Error('Usage identity conflict');if(!old)map.set(key,r);if(map.size>USAGE_MAX_RECORDS)throw new Error('Usage record limit');}
 return [...map.values()].sort((a,b)=>a.ts-b.ts);
}
