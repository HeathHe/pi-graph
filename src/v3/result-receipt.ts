import {completionOutput,legacyCompletionOutput} from './result-output.ts';
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { safeBytes } from "./evidence-files.ts";
import { readLatestV3Attempt, readV3AttemptEvidence, verifyV3AcceptedAttemptChain, v3NodeAttemptDir } from "./attempt.ts";
import { canonicalDigest } from "./digests.ts";
import { summarizeUsage } from "./usage-summary.ts";
import { runtimeRecoveryEvidence } from "./failure-policy.ts";
import type { GraphSnapshotV3, V3AttemptEvidence } from "./types.ts";
const hash = (text:string)=>createHash("sha256").update(text).digest("hex");
const clip = (s:string,n:number)=>Array.from(s).slice(0,n).join("");
function pageCount(points:string[],offset:number,limit:number,budget:number) {
 let low=0,high=Math.max(0,Math.min(limit,points.length-offset));
 while(low<high){const middle=Math.ceil((low+high)/2);if(Buffer.byteLength(JSON.stringify(points.slice(offset,offset+middle).join("")))<=budget)low=middle;else high=middle-1;}
 return low;
}
function identity(id:string) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) || id==="." || id==="..") throw new Error("Invalid result identity"); }
export class GraphSourceChangedError extends Error {
 readonly code = "source_changed";
 readonly restartRequest: Record<string, unknown>;
 readonly sha256: string;
 constructor(restartRequest: Record<string, unknown>, sha256: string) {
  super("Source changed; restart reading at offset 0 using restartRequest.");
  this.restartRequest=restartRequest;this.sha256=sha256;
 }
}
function checkSource(expected: string | undefined, actual: string, restart: Record<string, unknown>): void {
 if (expected !== undefined && !/^[a-fA-F0-9]{64}$/.test(expected)) throw new Error("expectedSha256 must be 64 hexadecimal characters");
 if (expected !== undefined && expected.toLowerCase() !== actual) throw new GraphSourceChangedError(restart, actual);
}
export async function readGraphResult(runsDir:string, graphId:string, taskId?:string, attempt?:number, offset=0, limit=4096, expectedSha256?:string) {
 identity(graphId); if(taskId)identity(taskId);
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>8192) throw new Error("offset/limit are Unicode code-point counts; limit must be 1..8192");
 const runDir=join(runsDir,graphId);
 let text:string, complete:boolean|null=true, source:string, recovery:unknown, resolvedAttempt:number|undefined;
 if(!taskId) {text=(await safeBytes(runDir,"snapshot.json")).toString("utf8");source="snapshot.json";}
 else {
  const evidence=attempt===undefined ? (await readLatestV3Attempt(runDir,taskId))?.evidence : await readV3AttemptEvidence(runDir,taskId,attempt);
  if(!evidence || evidence.graphId!==graphId || evidence.taskId!==taskId)throw new Error("Result evidence missing or identity mismatch");
  resolvedAttempt=evidence.attempt;
  if(evidence.phase==="accepted") {
   const chain=await verifyV3AcceptedAttemptChain(runDir,taskId,evidence.attempt);
   if(!chain.ok)throw new Error(`Accepted result evidence failed verification: ${chain.reasons.join("; ")}`);
  }
  const directory=v3NodeAttemptDir(runDir,taskId,evidence.attempt);
  source=`nodes/${taskId}/attempts/${evidence.attempt}/child-result.json`;
  try {
   const raw=JSON.parse((await safeBytes(directory,"child-result.json")).toString("utf8"));
   if(raw.version!==1||raw.runId!==(evidence.child?.observation?.asyncId??evidence.dispatch?.asyncId)||raw.digest!==canonicalDigest({completion:raw.completion,status:raw.status})||!Array.isArray(raw.completion?.results))throw new Error("Native result identity/digest mismatch");
   if(raw.completion.results.some((r:any)=>typeof r.finalOutput!=="string"))throw new Error("Native result output missing");
   text=completionOutput(raw.completion);
   // Read historical receipts with their exact old projection only when its
   // cryptographic digest matches. Never discard the attempt-bound check.
   if(evidence.child?.fullOutputDigest && hash(text)!==evidence.child.fullOutputDigest) {
    const legacy=legacyCompletionOutput(raw.completion);
    if(hash(legacy)===evidence.child.fullOutputDigest)text=legacy;
   }
   if(evidence.child?.fullOutputDigest && hash(text)!==evidence.child.fullOutputDigest)throw new Error("Full output differs from attempt-bound digest");
   complete=raw.completion.state==="complete"&&raw.completion.results.every((r:any)=>r.truncated!==true&&r.success!==false)&&evidence.child?.fullOutputDigest!==undefined?true:null;
  } catch(error) {
   if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
   text=evidence.child?.output??evidence.failure?.message??"";complete=text.includes("[output truncated]")?false:null;source=`nodes/${taskId}/attempts/${evidence.attempt}/attempt.json`;
  }
  if(evidence.phase==="failed"||evidence.phase==="aborted"||evidence.phase==="needs_attention")recovery=runtimeRecoveryEvidence(evidence.failure?.message??"",taskId,evidence.attempt);
 }
 const sha256=hash(text);
 checkSource(expectedSha256,sha256,{action:"result",id:graphId,...(taskId?{node:taskId,attempt:resolvedAttempt}:{}),offset:0,limit});
 const points=Array.from(text);let count=pageCount(points,offset,limit,2500);
 const build=(take:number)=>({graphId,...(taskId?{taskId}:{}),source,complete,sha256,bytes:Buffer.byteLength(text),unit:"unicode-code-points",offset,text:points.slice(offset,offset+take).join(""),nextOffset:offset+take<points.length?offset+take:null,nextRequest:offset+take<points.length?{action:"result",id:graphId,...(taskId?{node:taskId,attempt:resolvedAttempt}:{}),offset:offset+take,limit,expectedSha256:sha256}:null,...(recovery?{recovery}:{})});
 let page=build(count);
 // Account for metadata and the tool content string's second JSON escaping layer.
 while(count>0 && Buffer.byteLength(JSON.stringify(JSON.stringify(page)))>7600){count=Math.floor(count*0.8);page=build(count);}
 if(Buffer.byteLength(JSON.stringify(JSON.stringify(page)))>7600)throw new Error("Result metadata exceeds bounded response budget");
 return page;
}
export async function graphResultReceipt(snapshot:GraphSnapshotV3,runsDir:string) {
 const runDir=join(runsDir,snapshot.graphId); const lines=[`Graph ${snapshot.graphId}: ${snapshot.status}`,`Full state: graph action=result id=${snapshot.graphId} (paged)`];
 const attempts:V3AttemptEvidence[]=[];let shown=0;const usageReadErrors:string[]=[];
 for(const [taskId,node] of Object.entries(snapshot.nodes??{})) {
  try {
   const dir=join(runDir,"nodes",taskId,"attempts");
   for(const name of await readdir(dir)) if(/^\d+$/.test(name)){const evidence=await readV3AttemptEvidence(runDir,taskId,Number(name));if(evidence)attempts.push(evidence);else usageReadErrors.push(`${taskId}: missing attempt ${name}`);}
  }catch(error) {usageReadErrors.push(`${taskId}: ${clip(String(error),120)}`);}
  if(shown>=6)continue;
  try {
   const value=await readGraphResult(runsDir,snapshot.graphId,taskId,undefined,0,240);
   lines.push(`${taskId}: ${node.terminalStatus??node.phase}; preview ${clip(value.text,240)}; result action=result node=${taskId}; sha256=${value.sha256}; complete=${value.complete}`);
  }catch(error){lines.push(`${taskId}: ${node.terminalStatus??node.phase}; result unavailable: ${clip(String(error),180)}; inspect durable attempt evidence; no replay.`);}
  shown++;
 }
 const usage={...summarizeUsage(attempts),evidenceComplete:usageReadErrors.length===0,missingEvidenceNodes:usageReadErrors.length};
 if(Object.keys(snapshot.nodes??{}).length>shown)lines.push(`Other nodes: ${Object.keys(snapshot.nodes??{}).length-shown}; read full state with action=result.`);
 return {text:lines.join("\n"),usage,details:{graphId:snapshot.graphId,status:snapshot.status,nodeCount:Object.keys(snapshot.nodes??{}).length,result:{action:"result",id:snapshot.graphId},usage:Buffer.byteLength(JSON.stringify(usage))<=3000?usage:{coverage:usage.coverage,main:usage.main,childRuns:usage.childRuns,evidenceComplete:usage.evidenceComplete,missingEvidenceNodes:usage.missingEvidenceNodes,detail:"Inspect per-attempt evidence for model breakdown"}}};
}

/** Bound every tool envelope, including attention/status/abort, without silently clipping paged JSON. */
export function boundedGraphToolResult(text:string, details:unknown={}, isError=false) {
 let projected:any=details??{};
 if(projected.snapshot || projected.nodes) {
  const snapshot=projected.snapshot??projected;
  const nodes=Object.fromEntries(Object.entries(snapshot.nodes??{}).slice(0,6).map(([id,n]:[string,any])=>[id,{taskId:id,phase:n.phase,terminalStatus:n.terminalStatus,attempt:n.attempt}]));
  projected={graphId:snapshot.graphId,status:snapshot.status,revision:snapshot.revision,watching:projected.watching,waitReason:projected.waitReason,graphContinuesRunning:projected.graphContinuesRunning,stopRequested:projected.stopRequested,
   result:{action:"result",id:snapshot.graphId},snapshot:{graphId:snapshot.graphId,status:snapshot.status,nodes},nodeCount:Object.keys(snapshot.nodes??{}).length,supervisorRequests:(projected.supervisorRequests??[]).slice(0,2),supervisorDiagnostics:(projected.supervisorDiagnostics??[]).slice(0,2),attentionRead:{action:"attention",id:snapshot.graphId}};
 }
 if(Buffer.byteLength(JSON.stringify(projected))>4096)projected={graphId:projected.graphId,status:projected.status,waitReason:projected.waitReason,watching:projected.watching,graphContinuesRunning:projected.graphContinuesRunning,stopRequested:projected.stopRequested,attentionRead:projected.attentionRead,result:{action:"result",id:projected.graphId},detailsOmitted:true};
 let body=text;
 if(Buffer.byteLength(JSON.stringify(body))>8000) {
  const points=Array.from(body);const end=pageCount(points,0,7900,7800);
  body=points.slice(0,end).join("")+"\n[Preview bounded; use graph action=result for full state/results.]";
 }
 return {content:[{type:"text" as const,text:body}],details:projected,...(isError?{isError:true}:{})};
}

export function pageGraphData(value:unknown, offset=0, limit=4096, attention?:{action:"attention";id:string}, expectedSha256?:string) {
 if(attention)identity(attention.id);
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>8192)throw new Error("Invalid page offset or limit");
 const serialized=JSON.stringify(value),sha256=hash(serialized);
 checkSource(expectedSha256,sha256,{...(attention??{}),offset:0,limit});
 const points=Array.from(serialized);let count=pageCount(points,offset,limit,2500);
 const build=(take:number)=>({unit:"unicode-code-points",sha256,bytes:Buffer.byteLength(serialized),offset,text:points.slice(offset,offset+take).join(""),nextOffset:offset+take<points.length?offset+take:null,...(attention?{nextRequest:offset+take<points.length?{action:attention.action,id:attention.id,offset:offset+take,limit,expectedSha256:sha256}:null}:{})});
 let page=build(count);
 while(count>0 && Buffer.byteLength(JSON.stringify(JSON.stringify(page)))>7600){count=Math.floor(count*0.8);page=build(count);}
 if(Buffer.byteLength(JSON.stringify(JSON.stringify(page)))>7600)throw new Error("Page metadata exceeds bounded response budget");
 return page;
}

/** Snapshot-only raw-text paging. Node/attempt outputs still use readGraphResult verification. */
export function pageGraphSnapshotText(text:string,graphId:string,offset=0,limit=4096,expectedSha256?:string) {
 identity(graphId);
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>8192)throw new Error("offset/limit are Unicode code-point counts; limit must be 1..8192");
 const sha256=hash(text);checkSource(expectedSha256,sha256,{action:"result",id:graphId,offset:0,limit});
 const points=Array.from(text);let count=pageCount(points,offset,limit,2500);
 const build=(take:number)=>({graphId,source:"snapshot.json",complete:true,sha256,bytes:Buffer.byteLength(text),unit:"unicode-code-points",offset,text:points.slice(offset,offset+take).join(""),nextOffset:offset+take<points.length?offset+take:null,nextRequest:offset+take<points.length?{action:"result",id:graphId,offset:offset+take,limit,expectedSha256:sha256}:null});
 let page=build(count);while(count>0&&Buffer.byteLength(JSON.stringify(JSON.stringify(page)))>7600){count=Math.floor(count*.8);page=build(count);}
 if(Buffer.byteLength(JSON.stringify(JSON.stringify(page)))>7600)throw new Error("Result metadata exceeds bounded response budget");return page;
}
