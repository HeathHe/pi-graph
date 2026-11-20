import type {JournalFactoryBinding,ScopeLease,SupervisionFact} from 'pi-graph-observability';
import {captureLease} from 'pi-graph-observability';
export const OBSERVABILITY_SUPERVISION_EVENT='pi-graph:supervision-fact:v1';
/** One source sequence per Root incarnation, allocated only by the producer adapter. */
export function createSupervisionProducer(capture:()=>JournalFactoryBinding|undefined,emit:(name:string,fact:SupervisionFact)=>void,source:SupervisionFact['source'],producerKey:string){
 let sequence=0;let root='';
 function begin(kind:SupervisionFact['kind'],operationId:string,detail:Partial<Pick<SupervisionFact,'target'|'message'|'severity'>>={}){
  const binding=capture();if(!binding)return undefined;const lease=captureLease(binding.lease),key=JSON.stringify(lease.scope);if(key!==root){root=key;sequence=0;}
  const start=++sequence;
  const publish=(extra:Partial<Pick<SupervisionFact,'kind'|'verdict'|'delivery'|'terminalOutcome'|'message'|'target'|'severity'>>)=>{if(!lease.current())return false;const n=++sequence;emit(OBSERVABILITY_SUPERVISION_EVENT,{...detail,...extra,header:{version:1,scope:lease.scope,eventId:`${producerKey}:${operationId}:${n}`,source:producerKey,sequence:n,observedAt:Date.now()},source,kind:extra.kind??kind,severity:extra.severity??detail.severity??'info',operationId,operationStartSequence:start});return true;};
  return {lease,start,publish,attempt(){return publish({delivery:{state:'attempted'}});},settle(result:unknown){return publish({delivery:{state:result===false?'failed':'unknown'}});}};
 }
 return {begin};
}
