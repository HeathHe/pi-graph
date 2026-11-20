import type {UsageData} from '../contracts.ts';
import {asObject,readPercentCandidate,normalizeUsagePair,formatDuration} from './financial.ts';
export function extractZaiUsageFromPayload(payload:unknown,nowMs:number):UsageData|null {
 const root=asObject(payload),data=asObject(root?.data),quota=asObject(root?.quota),dataQuota=asObject(data?.quota);
 const values=[data?.limits,root?.limits,quota?.limits,dataQuota?.limits].find(Array.isArray) as unknown[]|undefined;
 const limits=values?.map(asObject).filter(x=>x&&['TOKENS_LIMIT','CREDIT_LIMIT'].includes(String(x.type).toUpperCase()));
 const session=limits?.find(x=>x?.unit===3),weekly=limits?.find(x=>x?.unit===6);
 const a=readPercentCandidate(session?.percentage),b=readPercentCandidate(weekly?.percentage);if(a===null&&b===null)return null;
 const reset=(x:Record<string,unknown>|null|undefined)=>typeof x?.nextResetTime==='number'&&x.nextResetTime>0?formatDuration(Math.max(0,x.nextResetTime-nowMs)/1000):undefined;
 return {session:a??undefined,weekly:b??undefined,sessionResetsIn:reset(session),weeklyResetsIn:reset(weekly)};
}
