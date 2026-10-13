import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readAtomicRegularFile } from "./safe-read.ts";
import { atomicWriteJson } from "./durable.ts";
import type { V3LeaseHandle } from "./lease.ts";

export const MAILBOX_PROTOCOL = "graph-mailbox-v1" as const;
export interface MailboxParticipant { taskId: string; attempt: number; token: string; closed?: boolean }
export interface MailboxMessage { id: string; from: string; fromAttempt: number; to: string; toAttempt: number; kind: string; text: string; digest: string; createdAt: string; replyTo?: string; delivered?: boolean; acknowledged?: boolean; replyId?: string }
export interface MailboxState { protocol: typeof MAILBOX_PROTOCOL; runInstanceId: string; owner: string; participants: MailboxParticipant[]; messages: MailboxMessage[]; keys: Record<string, { digest: string; id: string }> }
export interface ParentMailboxTarget { owner:string; runInstanceId:string; taskId:string; attempt:number; }
export interface MailboxRequest { action: string; to?: string; kind?: string; text?: string; idempotencyKey?: string; messageId?: string; offset?: number; limit?: number }
export function mailboxMessageState(state:MailboxState,m:MailboxMessage):string{const p=state.participants.find(p=>p.taskId===m.to);return !p||p.attempt!==m.toAttempt?"stale_attempt":p.closed?"recipient_closed":m.replyId?"replied":m.acknowledged?"acknowledged":m.delivered?"delivered":"queued";}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export class GraphMailbox {
 private tail: Promise<unknown> = Promise.resolve();
 readonly path: string;
 private canonicalRoot?:string;
 private identity?: {runInstanceId:string;owner:string};
 private readonly liveRecipient?:(taskId:string,attempt:number)=>Promise<boolean>;
 readonly runDir:string; readonly lease:Pick<V3LeaseHandle,"withFence">; readonly checkParticipant:(taskId:string,attempt:number)=>Promise<boolean>; readonly canQuestion:(from:string,to:string)=>boolean;
 constructor(runDir:string,lease:Pick<V3LeaseHandle,"withFence">,checkParticipant:(taskId:string,attempt:number)=>Promise<boolean>,canQuestion:(from:string,to:string)=>boolean=()=>true, liveRecipient?:(taskId:string,attempt:number)=>Promise<boolean>){this.liveRecipient=liveRecipient;this.canQuestion=canQuestion;this.runDir=runDir;this.lease=lease;this.checkParticipant=checkParticipant;this.path=join(runDir,"mailbox-v1","state.json");}
 async initialize(runInstanceId: string, owner: string, targets: Array<{taskId: string; attempt: number}>): Promise<void> {
  const rootInfo=await lstat(this.runDir);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error("Unsafe run directory");this.canonicalRoot=await realpath(this.runDir);
  this.identity={runInstanceId,owner};
  await this.lease.withFence(async () => {
   await mkdir(join(this.runDir, "mailbox-v1"), { recursive: true, mode: 0o700 });
   const prior = await this.load().catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
   if (prior) { if (prior.runInstanceId !== runInstanceId || prior.owner !== owner) throw new Error("Mailbox owner mismatch"); return; }
   await atomicWriteJson(this.path, { protocol: MAILBOX_PROTOCOL, runInstanceId, owner, participants: [...targets, {taskId:"@parent",attempt:1}].map(x => ({...x,token:randomBytes(32).toString("hex")})), messages:[], keys:{} } satisfies MailboxState);
  });
 }
 async load(): Promise<MailboxState> {
  if(await realpath(join(this.runDir,"mailbox-v1"))!==join(this.canonicalRoot??await realpath(this.runDir),"mailbox-v1"))throw new Error("Unsafe mailbox directory");
  const text=await readAtomicRegularFile(this.path,{maxBytes:16*1024*1024,invalidMessage:"Unsafe mailbox store",limitMessage:"Mailbox storage limit exceeded",expectedParentRealpath:join(this.canonicalRoot??await realpath(this.runDir),"mailbox-v1")});
  let state:MailboxState;try{state=JSON.parse(text);}catch{throw new Error("Mailbox state unreadable or invalid JSON");}
  if (state.protocol !== MAILBOX_PROTOCOL) throw new Error("Legacy communication is read-only");
  if(!Array.isArray(state.participants)||!Array.isArray(state.messages)||state.messages.length>1024||!state.keys||typeof state.keys!=="object"||Array.isArray(state.keys)||typeof state.owner!=="string"||typeof state.runInstanceId!=="string")throw new Error("Invalid mailbox evidence");
  if(this.identity&&(state.owner!==this.identity.owner||state.runInstanceId!==this.identity.runInstanceId))throw new Error("Mailbox identity changed");
  const tokens=new Set<string>();const ids=new Set<string>();for(const p of state.participants){if(typeof p.taskId!=="string"||!/^(@parent|[a-z0-9][a-z0-9-]*)$/.test(p.taskId)||ids.has(p.taskId)||tokens.has(p.token)||(p.closed!==undefined&&typeof p.closed!=="boolean")||!Number.isSafeInteger(p.attempt)||p.attempt<1||typeof p.token!=="string"||!/^[a-f0-9]{64}$/.test(p.token))throw new Error("Invalid participant evidence");ids.add(p.taskId);tokens.add(p.token);}
  const messages=new Set<string>();for(const m of state.messages){if(typeof m.id!=="string"||messages.has(m.id)||typeof m.text!=="string"||m.digest!==digest(m.text)||!ids.has(m.from)||!ids.has(m.to)||!Number.isSafeInteger(m.fromAttempt)||m.fromAttempt<1||!Number.isSafeInteger(m.toAttempt)||m.toAttempt<1)throw new Error("Invalid message evidence");messages.add(m.id);}
  for(const [key,value] of Object.entries(state.keys)){const m=state.messages.find(m=>m.id===value?.id);if(!/^[a-f0-9]{64}$/.test(key)||!m||m.id!==key||value.digest!==digest(JSON.stringify([m.to,m.toAttempt,m.kind,m.text,m.replyTo])))throw new Error("Mailbox idempotency evidence invalid");}
  for(const m of state.messages){if(!["message","question","decision","exception","result","reply"].includes(m.kind)||typeof m.createdAt!=="string"||!Number.isFinite(Date.parse(m.createdAt))||[m.delivered,m.acknowledged].some(flag=>flag!==undefined&&typeof flag!=="boolean")||[m.replyTo,m.replyId].some(id=>id!==undefined&&(typeof id!=="string"||!/^[a-f0-9]{64}$/.test(id)))||(m.kind==="reply")!==(m.replyTo!==undefined))throw new Error("Mailbox message schema invalid");if(!Object.hasOwn(state.keys,m.id))throw new Error("Mailbox key missing");if(m.replyTo){const original=state.messages.find(x=>x.id===m.replyTo);if(!original||original.replyId!==m.id||original.to!==m.from||original.toAttempt!==m.fromAttempt||original.from!==m.to||original.fromAttempt!==m.toAttempt)throw new Error("Mailbox reply evidence invalid");}if(m.replyId&&!state.messages.some(x=>x.id===m.replyId&&x.replyTo===m.id))throw new Error("Mailbox reply missing");}
  return state;
 }
 async admit(targets:Array<{taskId:string;attempt:number}>):Promise<void>{await this.lease.withFence(async()=>{const state=await this.load();let changed=false;for(const target of targets)if(!state.participants.some(p=>p.taskId===target.taskId)){state.participants.push({...target,token:randomBytes(32).toString("hex")});changed=true;}if(changed)await atomicWriteJson(this.path,state);});}
 async advance(taskId:string,attempt:number):Promise<void>{await this.lease.withFence(async()=>{const state=await this.load();const p=state.participants.find(p=>p.taskId===taskId);if(!p)throw new Error("Task was not admitted");if(p.attempt===attempt)return;if(attempt!==p.attempt+1)throw new Error("Invalid attempt generation");p.attempt=attempt;p.token=randomBytes(32).toString("hex");p.closed=false;await atomicWriteJson(this.path,state);});}
 async capability(taskId: string, attempt: number): Promise<string> { const p=(await this.load()).participants.find(x=>x.taskId===taskId && x.attempt===attempt && !x.closed); if(!p) throw new Error("No admitted mailbox attempt"); return p.token; }
 async request(token: string, request: MailboxRequest, parentTarget?:ParentMailboxTarget): Promise<unknown> {
  const operation = this.tail.then(() => this.lease.withFence(async () => {
   const state=await this.load(); const actor=state.participants.find(p=>typeof token==="string" && /^[a-f0-9]{64}$/.test(token) && token.length===p.token.length && timingSafeEqual(Buffer.from(p.token),Buffer.from(token)));
   if(!actor || actor.closed || (actor.taskId!=="@parent" && !await this.checkParticipant(actor.taskId,actor.attempt))) throw new Error("Mailbox identity is no longer active");
   if (!request || typeof request !== "object" || Object.keys(request).some(k=>!["action","to","kind","text","idempotencyKey","messageId","offset","limit"].includes(k))) throw new Error("Invalid mailbox request");
   const verifyParentTarget=async()=>{
    if(!parentTarget)return;
    if(actor.taskId!=="@parent" || request.action!=="send" || request.kind!=="message" || request.to!==parentTarget.taskId
     || state.owner!==parentTarget.owner || state.runInstanceId!==parentTarget.runInstanceId || parentTarget.taskId==="@parent"
     || state.participants.find(p=>p.taskId===parentTarget.taskId)?.attempt!==parentTarget.attempt
     || !this.liveRecipient || !await this.liveRecipient(parentTarget.taskId,parentTarget.attempt))throw new Error("Selected child is no longer live or its identity changed; nothing sent");
   };
   await verifyParentTarget();
   for(const p of state.participants)if(p.taskId!=="@parent"&&!p.closed&&!await this.checkParticipant(p.taskId,p.attempt))p.closed=true;
   const visible=(m:MailboxMessage)=>m.from===actor.taskId && m.fromAttempt===actor.attempt || m.to===actor.taskId && m.toAttempt===actor.attempt;
   const stateOf=(m:MailboxMessage)=>mailboxMessageState(state,m);
   const receipt=(m:MailboxMessage)=>({messageId:m.id,from:m.from,to:m.to,kind:m.kind,state:stateOf(m),replyTo:m.replyTo,digest:m.digest,bytes:Buffer.byteLength(m.text),read:{action:"read",messageId:m.id}});
   let changed=false; let result:unknown;
   if(request.action==="send" || request.action==="reply") {
    if(typeof request.text!=="string" || Buffer.byteLength(request.text)>1024*1024 || typeof request.idempotencyKey!=="string" || request.idempotencyKey.length<1 || request.idempotencyKey.length>128) throw new Error("Message requires bounded text and idempotencyKey");
    const original=request.action==="reply"?state.messages.find(m=>m.id===request.messageId && m.to===actor.taskId && m.toAttempt===actor.attempt):undefined;
    if(request.action==="reply" && !original) throw new Error("Reply target is not this inbox");
    const to=original?.from ?? request.to; const target=state.participants.find(p=>p.taskId===to);
    if(!target) throw new Error("Recipient is not admitted");
    const kind=original?"reply":request.kind??"message";
    if(kind==="question"&&!this.canQuestion(actor.taskId,target.taskId))throw new Error("Recipient depends on sender; blocking question would deadlock DAG");
    if(request.action==="send" && kind==="reply")throw new Error("Reply kind requires an authorized reply thread");
    if(!["message","question","decision","exception","result","reply"].includes(kind) || to==="@parent" && !["decision","exception","result","reply"].includes(kind)) throw new Error("Parent receives only decisions, exceptions and results");
    const key=digest(JSON.stringify([actor.taskId,actor.attempt,request.idempotencyKey]));
    const previous=state.keys[key];const previousMessage=previous?state.messages.find(m=>m.id===previous.id):undefined;
    const hash=digest(JSON.stringify([to,previousMessage?.toAttempt??target.attempt,kind,request.text,original?.id]));
    if(previous) {if(previous.digest!==hash) throw new Error("Idempotency conflict"); const message=state.messages.find(m=>m.id===previous.id); if(!message)throw new Error("Mailbox evidence missing"); return receipt(message);}
    if(target.closed || original && target.attempt!==original.fromAttempt) throw new Error("Recipient is closed or stale");
    if(original?.replyId) throw new Error("Request already replied");
    const m:MailboxMessage={id:key,from:actor.taskId,fromAttempt:actor.attempt,to:target.taskId,toAttempt:target.attempt,kind,text:request.text,digest:digest(request.text),createdAt:new Date().toISOString(),...(original?{replyTo:original.id}:{})};
    if(state.messages.length>=1024 || Buffer.byteLength(JSON.stringify(state))+Buffer.byteLength(JSON.stringify(m))>15*1024*1024)throw new Error("Mailbox storage quota reached");
    state.messages.push(m);state.keys[key]={digest:hash,id:key};if(original)original.replyId=key;changed=true;result=receipt(m);
   } else if(request.action==="receive" || request.action==="wait") {
    const offset=request.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error("Invalid cursor");
    const inbox=state.messages.filter(m=>m.to===actor.taskId&&m.toAttempt===actor.attempt);const remaining=inbox.slice(offset);const page=(request.action==="wait"?remaining.filter(m=>!m.acknowledged&&!m.replyId):remaining).slice(0,8);const nextCursor=page.length?inbox.indexOf(page.at(-1)!)+1:inbox.length;
    // Reading is non-consuming; delivery acknowledgement is a separate client receipt.
    result={messages:page.map(receipt),nextCursor,nextOffset:nextCursor<inbox.length?nextCursor:null,pending:page.length===0};
   } else {
    const m=state.messages.find(m=>m.id===request.messageId&&visible(m));if(!m)throw new Error("Message not authorized");
    if(request.action==="delivered"){if(m.to!==actor.taskId||m.toAttempt!==actor.attempt)throw new Error("Only recipient confirms delivery");m.delivered=true;changed=true;result=receipt(m);}
    else if(request.action==="ack"){if(m.to!==actor.taskId||m.toAttempt!==actor.attempt)throw new Error("Only recipient may acknowledge");m.acknowledged=true;changed=true;result=receipt(m);}
    else if(request.action==="status")result=receipt(m);
    else if(request.action==="read") {const offset=request.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error("Invalid offset");const chars=Array.from(m.text);let text=chars.slice(offset,offset+500).join("");result={...receipt(m),text,offset,unit:"Unicode code points",nextOffset:offset+Array.from(text).length<chars.length?offset+Array.from(text).length:null};}
    else throw new Error("Unknown mailbox action");
   }
   if(changed){for(const p of state.participants)if(p.taskId!=="@parent"&&!p.closed&&!await this.checkParticipant(p.taskId,p.attempt))p.closed=true;if(actor.closed)throw new Error("Stale actor before commit");if(request.action==="send"||request.action==="reply"){const m=state.messages.at(-1)!;if(state.participants.find(p=>p.taskId===m.to)?.closed)throw new Error("Recipient closed before commit");}if(actor.taskId!=="@parent"&&!await this.checkParticipant(actor.taskId,actor.attempt))throw new Error("Stale attempt before commit");await verifyParentTarget();await atomicWriteJson(this.path,state);}return result;
  })); this.tail=operation.catch(()=>undefined);return operation;
 }
}
