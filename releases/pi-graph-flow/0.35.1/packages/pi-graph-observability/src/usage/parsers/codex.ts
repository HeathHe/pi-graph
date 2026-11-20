import type {UsageData} from '../contracts.ts';
import {asObject,readPercentCandidate,formatDuration} from './financial.ts';
export function parseCodexRateLimit(payload:unknown):UsageData {
 const root=asObject(payload),limits=asObject(root?.rate_limit??root?.rate_limits);
 const primary=asObject(limits?.primary_window??limits?.primary??limits?.five_hour),secondary=asObject(limits?.secondary_window??limits?.secondary??limits?.weekly);
 let session:Record<string,unknown>|null=null,weekly:Record<string,unknown>|null=null;
 for(const [position,window] of [['primary',primary],['secondary',secondary]] as const){if(!window)continue;const duration=window.limit_window_seconds;if(typeof duration==='number'&&Number.isFinite(duration)){if(duration>=2*86400)weekly??=window;else session??=window;}else if(position==='primary')session??=window;else weekly??=window;}
 const reset=(w:Record<string,unknown>|null)=>typeof w?.reset_after_seconds==='number'?formatDuration(w.reset_after_seconds):undefined;
 return {session:readPercentCandidate(session?.used_percent)??undefined,weekly:readPercentCandidate(weekly?.used_percent)??undefined,sessionHidden:!session,weeklyHidden:!weekly,sessionResetsIn:reset(session),weeklyResetsIn:reset(weekly)};
}
export function getChatGPTUsage():UsageData{return {quotaHidden:true,notice:'Subscription quota is not exposed by the usage provider.'};}
