import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";

/** Real Pi event/turn ordering with deterministic model output and isolated child fixtures. */
export default function(pi: ExtensionAPI) {
 const dir=process.env.PI_NOTIFICATION_CHECK_DIR!;
 const record=(kind:string,data:unknown)=>appendFileSync(join(dir,"events.jsonl"),JSON.stringify({kind,data})+"\n");
 const text=(content:any)=>typeof content==="string"?content:(content??[]).map((c:any)=>c.text??"").join("\n");
 const response=async(context:any)=>{
  record("model",context.messages);
  const lastUser=[...context.messages].reverse().find((m:any)=>m.role==="user");
  if(text(lastUser?.content).includes("LIVE_ATTENTION_FIXTURE"))return fauxAssistantMessage("LIVE_ATTENTION_RECEIVED");
  if(text(lastUser?.content)!=="PI_NOTIFICATION_ORDER_START")return fauxAssistantMessage("UNEXPECTED_LATE_REPLY");
  const outputs=context.messages.filter((m:any)=>m.role==="toolResult" && m.toolName==="graph");
  if(!outputs.length)return fauxAssistantMessage(fauxToolCall("graph",{action:"start",spec:JSON.parse(process.env.PI_NOTIFICATION_CHECK_SPEC!)}),{stopReason:"toolUse"});
  if(outputs.length===1)return fauxAssistantMessage(fauxToolCall("graph",{action:"wait",id:"notification-order"}),{stopReason:"toolUse"});
  return fauxAssistantMessage("FINAL_COMPLETE_SUMMARY: all child results integrated.");
 };
 const faux=createFauxCore({provider:"pi-graph-faux",api:"pi-graph-faux",models:[{id:"faux-1",name:"Notification order test",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:16384}]});
 faux.setResponses(Array.from({length:32},()=>response));
 pi.registerProvider("pi-graph-faux",{baseUrl:"http://127.0.0.1:1",apiKey:"test-only",api:faux.api,models:faux.models,streamSimple:faux.streamSimple});
 let injected=false;
 pi.events.on("subagent:async-started",(value:any)=>{
  record("started",{id:value.id,asyncDir:value.asyncDir});
  if(injected)return;
  injected=true;
  // The parent is inside Graph wait. The fast child will finish before that wait returns.
  const timer=setInterval(()=>{
   try { const status=JSON.parse(readFileSync(join(value.asyncDir,"graph-state.json"),"utf8"));if(status.phase!=="waiting_model")return; } catch { return; }
   clearInterval(timer);
   const event={runId:value.id,index:0,agent:"ui-worker",type:"needs_attention",to:"needs_attention",reason:"idle",ts:Date.now(),message:"STALE_ATTENTION_FIXTURE"};
   appendFileSync(join(value.asyncDir,"events.jsonl"),JSON.stringify({type:"subagent.control",event,channels:["event","intercom"],intercom:{to:"test-parent",message:"STALE_ATTENTION_FIXTURE"}})+"\n");
   record("injected",event);
  },100); timer.unref?.();
 });
 pi.events.on("subagent:control-event",(value:any)=>record("control",{runId:value.event?.runId,message:value.event?.message}));
 pi.events.on("subagent:control-intercom",(value:any)=>record("control-intercom",value));
 pi.events.on("pi-graph:child-complete",(value:any)=>record("complete",{id:value.id,success:value.success,asyncDir:value.asyncDir}));
 pi.registerCommand("notification-live-check",{description:"Emit an isolated pending notice",handler:async(_args,ctx)=>{
  const asyncDir=join(dir,"live-check-child");mkdirSync(asyncDir,{recursive:true});
  writeFileSync(join(asyncDir,"status.json"),JSON.stringify({runId:"live-check-child",sessionId:ctx.sessionManager.getSessionFile(),state:"running",steps:[{status:"running",activityState:"needs_attention"}]}));
  pi.events.emit("subagent:control-event",{source:"async",asyncDir,event:{runId:"live-check-child",agent:"fixture",type:"needs_attention",to:"needs_attention",reason:"idle",ts:1,message:"LIVE_ATTENTION_FIXTURE"}});
 }});
}
