import type { V3AttemptEvidence, V3ChildObservation, V3ChildTokenUsageObservation } from "./types.ts";
export function reportedTotalTokens(usage?: V3ChildTokenUsageObservation): number | undefined {
 if (!usage) return undefined;
 if (usage.totalTokens !== undefined) return Number.isFinite(usage.totalTokens)&&usage.totalTokens>=0 ? usage.totalTokens : undefined;
 if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
 if(!Number.isFinite(usage.inputTokens)||!Number.isFinite(usage.outputTokens)||usage.inputTokens<0||usage.outputTokens<0)return undefined;
 const total=usage.inputTokens + usage.outputTokens;return Number.isFinite(total)?total:undefined;
}
const metrics = ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;
export function summarizeUsage(attempts: readonly V3AttemptEvidence[]) {
 const unique = new Map<string, V3ChildObservation | undefined>();
 for (const evidence of attempts) {
  if (!evidence.dispatch && evidence.dispatchIntent?.state !== "emitting" && !evidence.child) continue;
  const obs = evidence.child?.observation ?? evidence.observation;
  const key = obs?.asyncId ?? obs?.runId ?? `${evidence.graphId}/${evidence.taskId}/${evidence.attempt}`;
  const previous = unique.get(key);
  if (!unique.has(key) || (obs && (!previous || obs.observedAt >= previous.observedAt))) unique.set(key,obs);
 }
 const byActualModel: Record<string, Record<string, {known:number;missing:number;complete:boolean}>> = Object.create(null);
 for (const obs of unique.values()) {
  const model = (obs?.attemptedModels?.length ?? 0)>1 ? "mixed/unknown" : obs?.actualModel ?? "unknown";
  const bucket = byActualModel[model] ??= Object.fromEntries(metrics.map(m=>[m,{known:0,missing:0,complete:true}]));
  for (const metric of metrics) {
   const value = metric === "totalTokens" ? reportedTotalTokens(obs?.usage) : obs?.usage?.[metric];
   if (value === undefined || !Number.isFinite(value) || value<0) {bucket[metric]!.missing++;bucket[metric]!.complete=false;}
   else {const total=bucket[metric]!.known+value;if(Number.isFinite(total))bucket[metric]!.known=total;else {bucket[metric]!.missing++;bucket[metric]!.complete=false;}}
  }
 }
 return {coverage:"observed child runs only",main:{status:"unknown",reason:"No attributable main-session usage evidence"},childRuns:unique.size,byActualModel};
}

/** Only white-listed usage metadata is copied; session text never enters this projection. */
export function summarizeMainSession(manager: {getSessionId?:()=>string;getEntries?:()=>readonly unknown[]}) {
 try {
  const sessionId=manager.getSessionId?.();const entries=manager.getEntries?.();
  if(!sessionId||!entries)return {status:"unknown",scope:"main-session",reason:"Session identity or public entries unavailable"};
  const seen=new Set<string>();const rows:V3AttemptEvidence[]=[];const categories:Record<string,number>=Object.create(null);let missingIdentity=0;
  for(const raw of entries) {
   const e=raw as any;if(!e||typeof e!=="object")continue;
   const assistant=e.type==="message"&&e.message?.role==="assistant";
   if(!assistant && !["usage","compaction","branch_summary"].includes(e.type))continue;
   if(typeof e.id!=="string"||!e.id){missingIdentity++;continue;}
   const key=`${sessionId}/${e.id}`;if(seen.has(key))continue;seen.add(key);
   const source=assistant?e.message:e;const usage=source.usage;
   const category=assistant?"assistant":e.type==="usage"&&typeof e.kind==="string"?e.kind:e.type;
   categories[category]=(categories[category]??0)+1;
   const model=typeof source.provider==="string"&&typeof source.model==="string"?`${source.provider}/${source.model}`:undefined;
   rows.push({graphId:sessionId,taskId:category,attempt:1,dispatch:{} as any,observation:{asyncId:key,observedAt:typeof e.timestamp==="string"?e.timestamp:"",actualModel:model,
    ...(usage?{usage:{inputTokens:usage.input,outputTokens:usage.output,totalTokens:usage.totalTokens,cacheReadTokens:usage.cacheRead,cacheWriteTokens:usage.cacheWrite,costUsd:usage.cost?.total}}:{})}} as V3AttemptEvidence);
  }
  const summary=summarizeUsage(rows);
  return {status:"observed",scope:"main-session",attribution:"Entire session; not exclusive to this graph. Child totals are separate.",sessionId,entries:rows.length,missingIdentity,categories,byCategory:Object.fromEntries(Object.keys(categories).map(category=>[category,summarizeUsage(rows.filter(row=>row.taskId===category)).byActualModel])),byActualModel:summary.byActualModel};
 }catch {return {status:"unknown",scope:"main-session",reason:"Public session metadata read failed"};}
}
