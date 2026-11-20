/**
 * submit-gate extension entry — serializes idle submissions across the
 * pre-prompt window to prevent the "Agent is already processing a prompt"
 * single-flight assertion error in pi-agent-core.
 *
 * Root cause (pi-agent-core activeRun single-flight):
 *   AgentSession.prompt()'s busy check (`_isAgentRunActive`) only latches
 *   *after* the submission's async prelude (model auth / pre-submit auto
 *   compaction / extension events) finishes. Auto-compaction stretches this
 *   unlocked window to tens of seconds; a second idle submission during it
 *   slips past the isStreaming/isCompacting guards and reaches
 *   agent.prompt() concurrently, where the later one hits the activeRun
 *   assertion and throws.
 *
 * This extension gates at the `input` event (every session.prompt() passes
 * through it):
 *   - after releasing one idle submission it sets `pending`, held until
 *     `agent_settled` (run fully finished) releases it;
 *   - idle submissions during `pending` are intercepted and queued, then
 *     replayed serially after `settled`;
 *   - a 60s timeout backstops submissions that fail inside the prelude (e.g.
 *     a compaction throw) so the gate never deadlocks.
 *
 * Streaming submissions (streamingBehavior=steer/followUp) are handled by the
 * core queue and have no such race, so they pass straight through.
 *
 * Registered as a separate pi extension entry (`package.json` `pi.extensions`),
 * so it never touches the main maestro extension's registration surface.
 */

import type { ExtensionAPI, InputEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createSubmissionLifecycle } from "pi-graph-permission-core";
interface QueuedMessage {text:string;images?:ImageContent[];}
export default function registerSubmitGate(pi:ExtensionAPI):void {
 const owner=createSubmissionLifecycle<QueuedMessage,ReturnType<typeof setTimeout>>({
  schedule:(callback,ms)=>setTimeout(callback,ms),clear:timer=>clearTimeout(timer),
  send(message){const content:string|(TextContent|ImageContent)[]=message.images&&message.images.length>0?[{type:"text",text:message.text},...message.images]:message.text;pi.sendUserMessage(content);},
  report:error=>console.error("[submit-gate] failed to flush queued message:",error),
 });
 pi.on("input",(event:InputEvent,ctx:ExtensionContext)=>{
  if(owner.input({text:event.text,images:event.images},event.streamingBehavior!==undefined,event.source==="extension")==="queued"){
   ctx.ui.notify("上一条消息仍在压缩/收尾,本条已排队,完成后自动发送。","info");return {action:"handled" as const};
  }
  return {action:"continue" as const};
 });
 pi.on("agent_settled",()=>owner.settled());
 pi.on("session_shutdown",()=>owner.shutdown());
}
