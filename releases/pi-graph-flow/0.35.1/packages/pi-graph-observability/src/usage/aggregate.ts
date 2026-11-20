import type {UsageRecord,UsageField} from './contracts.ts';
export interface UsageTotals {records:number;input?:number;output?:number;cacheRead?:number;cacheWrite?:number;totalTokens?:number;totalCost?:number;cacheHitRate?:number;unknownFields:string[]}
const sum=(values:(number|undefined)[]):number|undefined=>values.some(v=>v===undefined)?undefined:values.reduce<number>((a,b)=>a+b!,0);
const round4=(v:number|undefined)=>v===undefined?undefined:Math.round(v*10000)/10000;
export function usageTotals(records:readonly UsageRecord[]):UsageTotals {
 const field=(k:UsageField)=>sum(records.map(r=>r.unknownFields?.includes('usage.'+k)?undefined:r.usage[k]));
 const input=field('input'),output=field('output'),cacheRead=field('cacheRead'),cacheWrite=field('cacheWrite');
 const totalCost=round4(sum(records.map(r=>r.unknownFields?.includes('cost.total')?undefined:r.cost.total)));
 return {records:records.length,input,output,cacheRead,cacheWrite,totalTokens:input===undefined||output===undefined?undefined:input+output,totalCost,cacheHitRate:input===undefined||cacheRead===undefined?undefined:input+cacheRead>0?cacheRead/(input+cacheRead):0,unknownFields:[...['input','output','cacheRead','cacheWrite'].filter(k=>field(k as UsageField)===undefined),...(totalCost===undefined?['totalCost']:[])]};
}
export interface ModelAggregate extends UsageTotals {model:string}
export function aggregateByModel(records:readonly UsageRecord[]):ModelAggregate[]{const map=new Map<string,UsageRecord[]>();for(const r of records){const list=map.get(r.model)??[];list.push(r);map.set(r.model,list);}return [...map].map(([model,rows])=>({model,...usageTotals(rows)})).sort((a,b)=>(b.totalCost??-1)-(a.totalCost??-1));}
export type TimeMetric='tokens'|'cost'|'cache';export type BucketGranularity='hour'|'day';
export interface TimeBucket {ts:number;value?:number}
function metric(rows:readonly UsageRecord[],key:TimeMetric):number|undefined{const t=usageTotals(rows);return key==='tokens'?t.totalTokens:key==='cost'?t.totalCost:t.cacheHitRate;}
export function aggregateByTurn(records:readonly UsageRecord[],key:TimeMetric):(number|undefined)[]{return [...records].sort((a,b)=>a.ts-b.ts).map(r=>metric([r],key));}
export function aggregateByTimeBucket(records:readonly UsageRecord[],key:TimeMetric,granularity:BucketGranularity):TimeBucket[]{const unit=granularity==='hour'?3600000:86400000;const groups=new Map<number,UsageRecord[]>();for(const r of records){const ts=Math.floor(r.ts/unit)*unit,rows=groups.get(ts)??[];rows.push(r);groups.set(ts,rows);}return [...groups].map(([ts,rows])=>({ts,value:metric(rows,key)})).sort((a,b)=>a.ts-b.ts);}
export function daySeries(records:readonly UsageRecord[],key:TimeMetric,start:number,end:number):TimeBucket[]{if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||(end-start)/86400000>3660)throw new Error('Invalid day series bounds');const map=new Map(aggregateByTimeBucket(records,key,'day').map(x=>[x.ts,x.value]));const out:TimeBucket[]=[];for(let ts=start;ts<=end;ts+=86400000)out.push({ts,value:map.has(ts)?map.get(ts):0});return out;}
