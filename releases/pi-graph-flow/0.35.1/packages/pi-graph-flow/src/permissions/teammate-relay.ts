/** Process transport adapter; the process singleton contains only the core owner. */
import { randomUUID } from "node:crypto";
import { createRelayLifecycle, type RelayFailureReason, type RelayResult } from "pi-graph-permission-core";
export type TeammateInteractionFailureReason = RelayFailureReason;
export type TeammateInteractionResult<T> = RelayResult<T>;
const relayKey = Symbol.for("pi-maestro-flow.teammate-interactions");
export function isTeammateChild(): boolean {
  return process.env.PI_TEAMMATE_CHILD === "1" && typeof process.send === "function" && process.connected !== false;
}
function createOwner(inherited?:unknown) {
  return createRelayLifecycle<ReturnType<typeof setTimeout>>({
    available:isTeammateChild,connected:()=>process.connected!==false,id:randomUUID,
    correlationId:()=>process.env.PI_TEAMMATE_CORRELATION_ID,
    send:(message,done)=>{process.send?.(message as Record<string, unknown>,done);},
    listen:(message,disconnect)=>{process.on("message",message);process.on("disconnect",disconnect);},
    timer:(callback,ms)=>{const timer=setTimeout(callback,ms);timer.unref?.();return timer;},
    clear:timer=>clearTimeout(timer),
  },inherited);
}
function relayOwner(): ReturnType<typeof createOwner> {
  const globals=globalThis as typeof globalThis & Record<symbol,unknown>;
  const existing=globals[relayKey] as ReturnType<typeof createOwner>|undefined;
  if(existing && typeof existing.request==="function")return existing;
  const owner=createOwner(existing);globals[relayKey]=owner;return owner;
}
export function requestTeammateInteraction<T>(interaction:"permission"|"question",payload:Record<string,unknown>,timeoutMs=10*60_000,signal?:AbortSignal):Promise<TeammateInteractionResult<T>> {
  return relayOwner().request<T>(interaction,payload,timeoutMs,signal);
}
