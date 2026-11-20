import type { LifecycleClock } from "./lifecycle-ports.ts";
export interface SubmissionPorts<Message,Timer> extends LifecycleClock<Timer> {send(message:Message):void;report(error:unknown):void;}
/** Input serialization only: this owner never grants tool permission or business completion. */
export function createSubmissionLifecycle<Message,Timer>(ports:SubmissionPorts<Message,Timer>,timeoutMs=60_000) {
 const queued:Message[]=[];let pending=false,flushTimer:Timer|undefined,timeoutTimer:Timer|undefined;
 function flush(){ports.clear(flushTimer);if(!pending||!queued.length)return;flushTimer=ports.schedule(()=>{flushTimer=undefined;if(!pending||!queued.length)return;const message=queued.shift()!;try{ports.send(message);}catch(error){queued.unshift(message);ports.report(error);}},0);}
 function arm(){pending=true;ports.clear(timeoutTimer);timeoutTimer=ports.schedule(()=>{timeoutTimer=undefined;pending=false;if(queued.length){arm();flush();}},timeoutMs);}
 function release(){ports.clear(timeoutTimer);timeoutTimer=undefined;if(!queued.length){pending=false;ports.clear(flushTimer);flushTimer=undefined;return;}arm();flush();}
 return {
  input(message:Message,streaming:boolean,extension:boolean):"continue"|"queued" {if(streaming||extension)return "continue";if(pending){queued.push(message);return "queued";}arm();return "continue";},
  settled:release,
  shutdown(){ports.clear(flushTimer);ports.clear(timeoutTimer);queued.length=0;},
 };
}
