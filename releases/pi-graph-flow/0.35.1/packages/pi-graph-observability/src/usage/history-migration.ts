import {readableUsageFile} from './records.ts';
import type {UsageHistoryTransaction,UsageRecord} from './contracts.ts';
import {usageIdentity,usageSessionBasename,legacySessionBasename,parseUsageJSONL,mergeUsageRecords,USAGE_MAX_BYTES} from './records.ts';
/** Read-only plan: a legacy collision is never treated as owned data or deleted. */
export async function planSessionMigration(tx:UsageHistoryTransaction,sessionId:string):Promise<{id:string;legacyId?:string;records:UsageRecord[]}>{
 const id=usageSessionBasename(sessionId),legacy=legacySessionBasename(sessionId),files=await tx.list();
 for(const file of files.filter(f=>f.id===id||f.id===legacy)){if(!readableUsageFile(file))throw new Error('Unsafe history file');}
 const current=parseUsageJSONL(await tx.read(id,USAGE_MAX_BYTES)??'');if(current.some(r=>r.sessionId!==sessionId))throw new Error('Foreign canonical partition');
 const old=parseUsageJSONL(await tx.read(legacy,USAGE_MAX_BYTES)??'');
 if(old.some(r=>r.sessionId!==sessionId))return {id,records:current};
 return {id,legacyId:files.some(f=>f.id===legacy)?legacy:undefined,records:mergeUsageRecords(current,old)};
}
export function extractSessionUsage(raw:string):UsageRecord[]{
 // Explicit supplied transcript only; this routine never scans or discovers files.
 if(raw.length>USAGE_MAX_BYTES)throw new Error('Session size limit');
 const entries=raw.split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);
 const header=entries.find(e=>e.type==='session');if(typeof header?.id!=='string'||typeof header.cwd!=='string')return [];
 const result:UsageRecord[]=[];
 for(const entry of entries){if(entry.type!=='message'||!entry.message||typeof entry.message!=='object')continue;
 const m=entry.message as Record<string,unknown>;if(m.role!=='assistant'||!m.usage||typeof m.usage!=='object')continue;
 const u=m.usage as Record<string,unknown>,numeric=(keys:string[])=>Object.fromEntries(keys.flatMap(k=>typeof u[k]==='number'&&Number.isFinite(u[k])&&Number(u[k])>=0?[[k,u[k]]]:[]));
 const rawTs=m.timestamp??entry.timestamp;const ts=typeof rawTs==='number'?rawTs:typeof rawTs==='string'?Date.parse(rawTs):NaN;if(!Number.isFinite(ts))continue;
 const r:UsageRecord={ts,model:String(m.model??'unknown'),provider:String(m.provider??'unknown'),sessionId:header.id,cwd:header.cwd,usage:numeric(['input','output','cacheRead','cacheWrite']),cost:(u.cost&&typeof u.cost==='object'?u.cost:{}) as UsageRecord['cost'],...(typeof entry.id==='string'?{messageIdentity:entry.id,identityStrength:'host' as const}:{})};
 result.push(r);
 }return mergeUsageRecords(result);
}
/** Preserve legacy timestamp ambiguity without inventing a canonical identity. */
export function selectBackfillRecords(existing:readonly UsageRecord[],candidates:readonly UsageRecord[]):{records:UsageRecord[];skippedLegacyAmbiguous:number;partial:boolean}{
 const exact=new Set(existing.map(usageIdentity));
 const weak=new Set(existing.filter(r=>!r.messageIdentity||r.identityStrength==='weak'||r.identityStrength!=='host'&&r.messageIdentity.startsWith('weak:')).map(r=>JSON.stringify([r.sessionId,r.ts])));
 let skippedLegacyAmbiguous=0;const records=mergeUsageRecords([...candidates]).filter(r=>{if(exact.has(usageIdentity(r)))return false;if(weak.has(JSON.stringify([r.sessionId,r.ts]))){skippedLegacyAmbiguous++;return false;}return true;});
 return {records,skippedLegacyAmbiguous,partial:skippedLegacyAmbiguous>0};
}
