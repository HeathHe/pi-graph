import {readableUsageFile} from './records.ts';
import {Buffer} from 'node:buffer';
import type {UsageHistoryPort,UsageFact,UsageRecord,ReadScope,ReadOptions,UsageHistoryTransaction} from './contracts.ts';
import {factToRecord,mergeUsageRecords,parseUsageJSONL,USAGE_MAX_BYTES,usageSessionBasename,legacySessionBasename} from './records.ts';
import {planSessionMigration,extractSessionUsage,selectBackfillRecords} from './history-migration.ts';
import {buildSessionIndex,sessionIndexEntry} from './history-index.ts';
import {inventoryUsage,deleteUsagePreview,type UsageInventoryItem,type UsageLiveEvidence} from './maintenance-plan.ts';
export class UsageHistoryOwner {
 constructor(private readonly port:UsageHistoryPort){}
 private async write(tx:UsageHistoryTransaction,sessionId:string,incoming:UsageRecord[]):Promise<{added:number;indexAvailable:boolean}>{
  const plan=await planSessionMigration(tx,sessionId);if(incoming.some(r=>r.sessionId!==sessionId))throw new Error('Foreign usage input');
  const merged=mergeUsageRecords(plan.records,incoming),raw=merged.map(r=>JSON.stringify(r)).join('\n')+'\n';if(Buffer.byteLength(raw)>USAGE_MAX_BYTES)throw new Error('Usage history limit');
  await tx.assertOwned();await tx.replace(plan.id,raw);
  // Legacy file deletion is deliberately separate from migration: only preview authorizes removal.
  let indexAvailable=true;
  try {
   const rawIndex=await tx.read('index.json',USAGE_MAX_BYTES);
   const index=rawIndex===null?{sessions:[]}:JSON.parse(rawIndex) as {sessions:unknown[]};
   if(!index||!Array.isArray(index.sessions)||index.sessions.some(row=>!row||typeof row!=='object'||typeof (row as {sessionId?:unknown}).sessionId!=='string'))throw new Error('Invalid history index');
   const entry=sessionIndexEntry(sessionId,merged);
   const sessions=index.sessions.filter(row=>(row as {sessionId:string}).sessionId!==sessionId);if(entry)sessions.push(entry);
   await tx.assertOwned();await tx.replace('index.json',JSON.stringify({sessions})+'\n');
  }catch{indexAvailable=false;}
  return {added:merged.length-plan.records.length,indexAvailable};
 }
 async record(fact:UsageFact):Promise<{status:'recorded'|'duplicate'|'unavailable';added?:number;indexAvailable?:boolean}>{
  try{const record=factToRecord(fact);return await this.port.transact(async tx=>{await tx.assertOwned();const result=await this.write(tx,record.sessionId,[record]);return {status:result.added?'recorded':'duplicate',...result};});}catch{return {status:'unavailable'};}
 }
 private async readLocked(tx:UsageHistoryTransaction,scope:ReadScope,options:ReadOptions):Promise<UsageRecord[]>{
  let records:UsageRecord[]=[];for(const file of await tx.list()){if(!file.id.endsWith('.jsonl'))continue;if(scope.kind==='session'&&file.id!==usageSessionBasename(scope.sessionId)&&file.id!==legacySessionBasename(scope.sessionId))continue;if(!readableUsageFile(file))continue;const raw=await tx.read(file.id,USAGE_MAX_BYTES);records.push(...parseUsageJSONL(raw??''));}
  records=mergeUsageRecords(records).filter(r=>(scope.kind==='all'||scope.kind==='session'&&r.sessionId===scope.sessionId||scope.kind==='workspace'&&r.cwd===scope.cwd)&&(options.since===undefined||r.ts>=options.since)).sort((a,b)=>b.ts-a.ts);
  return records.slice(0,Math.max(0,Math.min(100000,options.limit??100000)));
 }
 read(scope:ReadScope,options:ReadOptions={}):Promise<UsageRecord[]>{return this.port.transact(async tx=>{await tx.assertOwned();return this.readLocked(tx,scope,options);});}
 /** Called only by an explicitly authorized existing host policy. No discovery or background job. */
 backfill(sessionId:string,transcript:string){return this.port.transact(async tx=>{await tx.assertOwned();const current=await planSessionMigration(tx,sessionId),selection=selectBackfillRecords(current.records,extractSessionUsage(transcript));const result=await this.write(tx,sessionId,selection.records);return {added:result.added,skippedLegacyAmbiguous:selection.skippedLegacyAmbiguous,partial:selection.partial};});}
 inventory(cwd:string,active:UsageLiveEvidence):Promise<UsageInventoryItem[]>{return this.port.transact(tx=>inventoryUsage(tx,cwd,active));}
 guardedDelete(preview:UsageInventoryItem,cwd:string,active:UsageLiveEvidence){return this.port.transact(async tx=>{await tx.assertOwned();return deleteUsagePreview(tx,preview,cwd,active,async()=>{const rows=await this.readLocked(tx,{kind:'all'},{});await tx.assertOwned();await tx.replace('index.json',JSON.stringify(buildSessionIndex(rows))+'\n');});});}
}
