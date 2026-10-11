import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { activeMailboxes, mailboxRegistryKey } from "../mailbox-runtime.ts";
import { safeBytes } from "../evidence-files.ts";
import { verifyV3AcceptedAttemptChain } from "../attempt.ts";
import { readGraphResult } from "../result-receipt.ts";
import { readGraphView } from "./read-view.ts";
import type { GraphSnapshotV3 } from "../types.ts";
export interface GraphUiTarget { graphId:string; runInstanceId:string; taskId:string; attempt:number; }
export interface GraphUiAction { kind:"message"; target:GraphUiTarget; }
export interface ArtifactPage { text:string; sha256:string; bytes:number; offset:number; nextOffset:number|null; source:string; truncated?:boolean; }
export function terminalText(value:unknown):string {return String(value??"").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,"0")}`);}
export function selectedGraphTarget(snapshot:GraphSnapshotV3,taskId:string):GraphUiTarget {
 const node=snapshot.nodes?.[taskId];if(!node||!Number.isSafeInteger(node.attempt)||node.attempt<1)throw new Error("节点尚未开始执行");
 return {graphId:snapshot.graphId,runInstanceId:snapshot.runInstanceId,taskId,attempt:node.attempt};
}
function assertTarget(target:GraphUiTarget):void {
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(target.graphId)||![target.graphId,target.taskId].every(x=>x!=='.'&&x!=='..')||!/^([a-z0-9][a-z0-9-]*)$/.test(target.taskId)||!Number.isSafeInteger(target.attempt)||target.attempt<1)throw new Error("Invalid selected node identity");
}
export async function sendSelectedNode(runsDir:string,target:GraphUiTarget,owner:string,text:string,idempotencyKey:string,ownerSessionFile?:string):Promise<unknown>{
 assertTarget(target);if(!text.trim()||Buffer.byteLength(text)>1024*1024)throw new Error("消息不能为空且不得超过1 MiB");
 const snapshot=await readGraphView(runsDir,target.graphId);
 if(snapshot.sessionId!==owner||snapshot.runInstanceId!==target.runInstanceId||snapshot.nodes?.[target.taskId]?.attempt!==target.attempt)throw new Error("会话归属或选中执行尝试已变化；未发送");
 const active=activeMailboxes.get(mailboxRegistryKey(join(runsDir,target.graphId)));
 if(!active||active.owner!==owner||active.runInstanceId!==target.runInstanceId||(active.ownerSessionFile!==undefined&&(!ownerSessionFile||resolve(active.ownerSessionFile)!==resolve(ownerSessionFile))))throw new Error("当前节点没有活动邮箱；不会启动或恢复任务");
 return active.mailbox.request(await active.mailbox.capability("@parent",1),{action:"send",to:target.taskId,kind:"message",text,idempotencyKey},{owner,runInstanceId:target.runInstanceId,taskId:target.taskId,attempt:target.attempt});
}
export async function readAcceptedArtifactPage(runsDir:string,target:GraphUiTarget,offset=0,limit=2048,expectedDigest?:string):Promise<ArtifactPage>{
 assertTarget(target);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>4096)throw new Error("Invalid artifact page");
 const runDir=join(runsDir,target.graphId),snapshot=await readGraphView(runsDir,target.graphId);
 if(snapshot.runInstanceId!==target.runInstanceId)throw new Error("Graph identity changed");
 const chain=await verifyV3AcceptedAttemptChain(runDir,target.taskId,target.attempt,{runInstanceId:target.runInstanceId,graphId:target.graphId});
 if(!chain.ok||chain.artifactContents===undefined)throw new Error("尚无可校验的 accepted 保存产物");
 const source=`artifacts/${target.taskId}/attempt-${target.attempt}.txt`;
 if(relative(runDir,chain.artifactPath)!==source)throw new Error("Unexpected accepted artifact path");
 const bytes=await safeBytes(runDir,source),sha256=createHash("sha256").update(bytes).digest("hex");
 if(bytes.toString("utf8")!==chain.artifactContents||(expectedDigest!==undefined&&sha256!==expectedDigest))throw new Error("保存产物已变化；停止展开");
 const points=Array.from(bytes.toString("utf8")),page=points.slice(offset,offset+limit).join("");
 return {text:page,sha256,bytes:bytes.length,truncated:bytes.toString("utf8").includes("[output truncated]"),offset,nextOffset:offset+limit<points.length?offset+limit:null,source};
}

export interface NativeResultPage extends ArtifactPage { complete:boolean|null; sourceKind:"native_capture"|"fallback"; }
export async function readAcceptedNativeResultPage(runsDir:string,target:GraphUiTarget,offset=0,limit=2048,expectedDigest?:string):Promise<NativeResultPage>{
 assertTarget(target);
 const snapshot=await readGraphView(runsDir,target.graphId);
 if(snapshot.runInstanceId!==target.runInstanceId||snapshot.nodes?.[target.taskId]?.attempt!==target.attempt)throw new Error("Graph identity or selected attempt changed");
 const chain=await verifyV3AcceptedAttemptChain(join(runsDir,target.graphId),target.taskId,target.attempt,{runInstanceId:target.runInstanceId,graphId:target.graphId});
 if(!chain.ok)throw new Error("尚无可校验的 accepted 原生结果");
 const page=await readGraphResult(runsDir,target.graphId,target.taskId,target.attempt,offset,limit,expectedDigest);
 return {...page,sourceKind:page.source.endsWith("/child-result.json")?"native_capture":"fallback"};
}
