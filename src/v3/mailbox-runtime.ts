import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { GraphMailbox, mailboxMessageState } from "./mailbox.ts";
import type { MailboxRequest } from "./mailbox.ts";
export function mailboxRegistryKey(runDir:string):string{return realpathSync(resolve(runDir));}
export const activeMailboxes = new Map<string,{mailbox:GraphMailbox;owner:string;runInstanceId:string;ownerSessionFile?:string}>();
export async function inspectMailboxParent(runDir:string,runInstanceId:string,owner:string,request:MailboxRequest):Promise<unknown>{
 if(!["receive","read","status"].includes(request.action))throw new Error("Inactive mailbox is read-only; no task restarted");
 const store=new GraphMailbox(runDir,{withFence:async()=>{throw new Error("Read-only mailbox has no mutation authority");}},async()=>false);
 const state=await store.load();if(state.runInstanceId!==runInstanceId||state.owner!==owner)throw new Error("Mailbox owner mismatch");
 const receipt=(m:typeof state.messages[number])=>({messageId:m.id,from:m.from,to:m.to,kind:m.kind,state:mailboxMessageState(state,m),digest:m.digest,bytes:Buffer.byteLength(m.text),readOnly:true});
 const offset=request.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error("Invalid offset");
 if(request.action==="receive"){const all=state.messages.filter(m=>m.to==="@parent");return {messages:all.slice(offset,offset+8).map(receipt),nextOffset:offset+8<all.length?offset+8:null,readOnly:true};}
 const m=state.messages.find(m=>m.id===request.messageId);if(!m)throw new Error("Message unavailable");
 // Authorized run owner may inspect closed-task evidence, never send as a child.
 if(request.action==="status")return receipt(m);
 const chars=Array.from(m.text),text=chars.slice(offset,offset+500).join("");return {...receipt(m),text,offset,unit:"Unicode code points",nextOffset:offset+500<chars.length?offset+500:null};
}
