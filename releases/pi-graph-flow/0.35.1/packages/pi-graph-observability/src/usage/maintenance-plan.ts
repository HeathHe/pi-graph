import {readableUsageFile} from './records.ts';
import type {UsageHistoryTransaction,UsageFile} from './contracts.ts';
import {parseUsageJSONL,digest,USAGE_MAX_BYTES} from './records.ts';
export interface UsageLiveEvidence {evidenceAvailable:boolean;currentSessionId?:string;activeSessions:ReadonlySet<string>}
export interface UsageInventoryItem extends UsageFile {sessionIds:string[];cwds:string[];cleanupEligible:boolean;protectionReason?:string;previewRevision:string;cwd:string}
export async function inventoryUsage(tx:UsageHistoryTransaction,cwd:string,evidence:UsageLiveEvidence):Promise<UsageInventoryItem[]>{
 const out:UsageInventoryItem[]=[];
 for(const file of await tx.list()){
  if(!file.id.endsWith('.jsonl'))continue;
  let reason:string|undefined,ids:string[]=[],cwds:string[]=[],raw:string|null=null;
  if(!readableUsageFile(file))reason='unsafe-file';
  else try{raw=await tx.read(file.id,USAGE_MAX_BYTES);const records=parseUsageJSONL(raw??'');ids=[...new Set(records.map(r=>r.sessionId))];cwds=[...new Set(records.map(r=>r.cwd))];
   if(!records.length)reason='damaged-or-empty';else if(ids.length!==1||cwds.length!==1)reason='mixed-ownership';else if(cwds[0]!==cwd)reason='foreign-workspace';
   else if(file.active||ids[0]===evidence.currentSessionId)reason='current-session-active';else if(!evidence.evidenceAvailable)reason='live-session-evidence-unavailable';else if(evidence.activeSessions.has(ids[0]!))reason='peer-session-active';
  }catch{reason='invalid-or-oversize';}
  out.push({...file,sessionIds:ids,cwds,cleanupEligible:!reason,protectionReason:reason,previewRevision:digest(JSON.stringify([file,raw])),cwd});
 }return out;
}
export interface UsageDeleteResult {status:'deleted'|'missing'|'stale'|'protected';reclaimedBytes?:number;message?:string}
export async function deleteUsagePreview(tx:UsageHistoryTransaction,preview:UsageInventoryItem,cwd:string,evidence:UsageLiveEvidence,reconcile?:(sessionId:string)=>Promise<void>):Promise<UsageDeleteResult>{
 const item=(await inventoryUsage(tx,cwd,evidence)).find(x=>x.id===preview.id);if(!item)return {status:'missing'};
 if(item.previewRevision!==preview.previewRevision||preview.cwd!==cwd)return {status:'stale'};
 if(!item.cleanupEligible||item.sessionIds.length!==1)return {status:'protected',message:item.protectionReason};
 await tx.assertOwned();await tx.remove(item.id);
 try{await reconcile?.(item.sessionIds[0]!);}catch(error){return {status:'deleted',reclaimedBytes:item.sizeBytes,message:`usage data was deleted, but non-authoritative index reconciliation failed: ${error instanceof Error?error.message:String(error)}`};}
 return {status:'deleted',reclaimedBytes:item.sizeBytes};
}
