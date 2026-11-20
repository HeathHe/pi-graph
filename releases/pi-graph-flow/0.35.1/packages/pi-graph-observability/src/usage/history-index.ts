import type {UsageRecord,SessionIndex,SessionIndexEntry} from './contracts.ts';
import {usageTotals} from './aggregate.ts';
export function sessionIndexEntry(sessionId:string,rows:readonly UsageRecord[]):SessionIndexEntry|undefined {
 const records=rows.filter(r=>r.sessionId===sessionId);if(!records.length)return undefined;const totals=usageTotals(records);
 let firstTs=Infinity,lastTs=-Infinity;for(const record of records){firstTs=Math.min(firstTs,record.ts);lastTs=Math.max(lastTs,record.ts);}
 return {sessionId,firstTs,lastTs,recordCount:records.length,totalCost:totals.totalCost,modelCount:new Set(records.map(r=>r.model)).size,unknownFields:totals.unknownFields};
}
export function buildSessionIndex(rows:readonly UsageRecord[]):SessionIndex{return {sessions:[...new Set(rows.map(r=>r.sessionId))].map(id=>sessionIndexEntry(id,rows)!).sort((a,b)=>b.lastTs-a.lastTs)};}
