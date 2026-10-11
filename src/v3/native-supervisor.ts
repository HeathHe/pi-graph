/** Compatibility names now project ONLY the Graph mailbox. No native channel IO. */
import { activeMailboxes, mailboxRegistryKey } from "./mailbox-runtime.ts";
import type { GraphSnapshotV3, V3ChildSupervision } from "./types.ts";
export const NATIVE_SUPERVISOR_RECEIPT_COMPATIBILITY = "graph-mailbox-v1";
export const NATIVE_SUPERVISOR_EVENT = "pi-graph:mailbox";
export const SUPERVISOR_RECEIPT_PHASE = "graph_mailbox_pending";
export interface NativeSupervisorRequest {requestId:string;runId:string;agent:string;childIndex:number;reason:"need_decision"|"interview_request";message?:string;messageTruncated?:boolean;replyHint:string}
export interface NativeSupervisorRead {requests:NativeSupervisorRequest[];diagnostics:string[]}
/** Retired native reader intentionally has no filesystem behavior. */
export async function readNativeSupervisorRequests(_input:unknown):Promise<NativeSupervisorRead>{return {requests:[],diagnostics:["legacy_native_communication_disabled"]};}
export function projectNativeSupervisorAttention(supervision:V3ChildSupervision,pending:boolean):V3ChildSupervision {const result={...supervision};if([SUPERVISOR_RECEIPT_PHASE,"graph_native_supervisor_pending"].includes(result.phase??"")){delete result.phase;if(result.attention==="waiting_user")delete result.attention;}if(pending&&!result.attention){result.attention="waiting_user";result.phase=SUPERVISOR_RECEIPT_PHASE;}return result;}
export async function readGraphSupervisorRequests(snapshot:GraphSnapshotV3,ownerSessionId:string,_ownerSessionFile?:string,runDir?:string):Promise<{snapshot:GraphSnapshotV3;requests:Array<NativeSupervisorRequest&{taskId:string}>;diagnostics:string[]}>{
 const projected=structuredClone(snapshot);const requests:Array<NativeSupervisorRequest&{taskId:string}>=[];
 for(const node of Object.values(projected.nodes??{}))if(node.observation?.supervision)node.observation.supervision=projectNativeSupervisorAttention(node.observation.supervision,false);
 if(snapshot.sessionId!==ownerSessionId)return {snapshot:projected,requests,diagnostics:["owner_mismatch"]};
 const active=runDir?activeMailboxes.get(mailboxRegistryKey(runDir)):undefined;if(!active)return {snapshot:projected,requests,diagnostics:[]};
 if(active.owner!==ownerSessionId||active.runInstanceId!==snapshot.runInstanceId)return {snapshot:projected,requests,diagnostics:["owner_mismatch"]};
 const state=await active.mailbox.load();
 for(const m of state.messages){if(m.to!=="@parent"||m.acknowledged||m.replyId)continue;
  requests.push({requestId:m.id,runId:state.runInstanceId,agent:m.from,taskId:m.from,childIndex:0,reason:"need_decision",message:m.text.slice(0,1000),messageTruncated:m.text.length>1000,replyHint:`graph({action:"mailbox",id:${JSON.stringify(snapshot.graphId)},mailbox:{action:"reply",messageId:${JSON.stringify(m.id)},text:"...",idempotencyKey:"..."}})`});
  const node=projected.nodes?.[m.from];if(node?.observation?.supervision)node.observation.supervision=projectNativeSupervisorAttention(node.observation.supervision,true);
 }
 return {snapshot:projected,requests,diagnostics:[]};
}
