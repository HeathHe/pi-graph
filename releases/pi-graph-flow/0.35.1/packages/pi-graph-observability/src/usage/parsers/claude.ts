import type {UsageData} from '../contracts.ts';
import {asObject,readPercentCandidate,normalizeIsoDate,hydrateUsageResets} from './financial.ts';
export function extractClaudeUsage(payload:unknown,nowMs:number):UsageData|null {
 const root=asObject(payload);if(!root)return null;
 const short=asObject(root.five_hour),long=asObject(root.seven_day),extra=asObject(root.extra_usage);
 const session=readPercentCandidate(short?.utilization),weekly=readPercentCandidate(long?.utilization);
 if(session===null&&weekly===null)return null;
 return hydrateUsageResets({session:session??undefined,weekly:weekly??undefined,sessionResetsAt:normalizeIsoDate(short?.resets_at),weeklyResetsAt:normalizeIsoDate(long?.resets_at),extraSpend:typeof extra?.used_credits==='number'?extra.used_credits/100:undefined,extraLimit:typeof extra?.monthly_limit==='number'?extra.monthly_limit/100:undefined},nowMs);
}
export function parseRetryAfterMs(value:string|null|undefined,nowMs:number):number|undefined {if(!value?.trim())return undefined;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-nowMs):undefined;}
export function claudeBackoffMs(failures:number,retryAfterMs?:number):number{return Math.min(15*60000,Math.max(retryAfterMs??0,30000*2**Math.min(5,Math.max(0,failures))));}
