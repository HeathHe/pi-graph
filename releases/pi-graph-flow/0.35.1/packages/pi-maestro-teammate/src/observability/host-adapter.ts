import {createHash} from 'node:crypto';
import {registerRootLeaseCapability,type JournalFactoryBinding,type Clock} from 'pi-graph-observability';
import type {SessionProgressInput} from 'pi-graph-observability/execution';
import type {WorkspaceOwnerSnapshot} from '../extension/workspace-peers.ts';
export const hostClock:Clock={now:Date.now,schedule(ms,callback){const timer=setTimeout(callback,ms);return {cancel:()=>clearTimeout(timer)};}};
export function sessionProgressInput(owner:WorkspaceOwnerSnapshot,lifecycle:SessionProgressInput['lifecycle']):SessionProgressInput{return {...owner,lifecycle,agents:[...owner.agents],settled:[...owner.settled]};}
export function observationPartition(cwd:string,sessionId:string){const digest=(s:string)=>createHash('sha256').update(s).digest('hex');return {workspaceDigest:digest(cwd),sessionDigest:digest(sessionId)};}
export interface RootFenceInput {generation:number;sessionId:string|null;workspaceId:string|undefined;sourceId:string|undefined;baseCwd:string}
/** Capture delegates to the actual extension closure; no JSON copy becomes authority. */
export function createRootObservationBridge(capture:()=>RootFenceInput,owns:(fence:RootFenceInput)=>boolean,publisher:()=>{ownerId:string;ownerNonce:string}|undefined){
 let registration:ReturnType<typeof registerRootLeaseCapability>|undefined,key:string|undefined;
 const binding=():JournalFactoryBinding|undefined=>{const fence=capture(),identity=publisher();if(!identity)return undefined;const {ownerId,ownerNonce}=identity;if(!fence.sessionId||!fence.sourceId||!fence.workspaceId||fence.generation<=0||!owns(fence))return undefined;
  return {...observationPartition(fence.baseCwd,fence.sessionId),lease:{scope:Object.freeze({sessionId:fence.sessionId,runtimeGeneration:fence.generation,ownerId,incarnation:ownerNonce}),current:()=>owns(fence)&&publisher()?.ownerId===ownerId&&publisher()?.ownerNonce===ownerNonce}};
 };
 return {capture:binding,refresh(){const current=binding(),next=current?JSON.stringify([current.workspaceDigest,current.sessionDigest]):undefined;
  if(next!==key){registration?.dispose(registration.token);registration=undefined;key=next;if(current)registration=registerRootLeaseCapability(current,{capture:binding});}
  if(registration)registration.notify(registration.token);
 },dispose(){registration?.dispose(registration.token);registration=undefined;key=undefined;}};
}
