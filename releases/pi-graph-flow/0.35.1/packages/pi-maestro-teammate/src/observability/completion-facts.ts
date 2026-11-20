import type {JournalFactoryBinding,SupervisionFact} from 'pi-graph-observability';
import {createSupervisionProducer} from './supervision-events.ts';
/** Captures are associated with the ORIGINAL admitted publication/message object.
 * Receipt callbacks receive a closure, never an id-to-new-operation lookup.
 * Weak ownership retains no unbounded strong id registry and cannot promote an
 * unknown string id to a new start sequence after a bounded window expires.
 */
export function createCompletionFacts(capture:()=>JournalFactoryBinding|undefined,emit:(name:string,fact:SupervisionFact)=>void,producerKey='teammate:completion'){
 const producer=createSupervisionProducer(capture,emit,'completion',producerKey);
 const publications=new WeakMap<object,ReturnType<typeof producer.begin>>();
 const notifications=new WeakMap<object,ReturnType<typeof producer.begin>>();
 const captured=(original:object,id:string,kind:'completion'|'notification')=>{
  const map=kind==='completion'?publications:notifications;
  if(map.has(original))return map.get(original);
  const operation=producer.begin(kind,id);map.set(original,operation);return operation;
 };
 return {
  publication(original:object,id:string){const operation=captured(original,id,'completion');return (acknowledged:boolean,outcome?:'completed'|'failed'|'terminated')=>{if(acknowledged)operation?.publish({terminalOutcome:outcome,delivery:{state:'confirmed',stage:'canonical-result-published',receiptId:id}});};},
  notification(original:object,id:string){const operation=captured(original,id,'notification');return (applied:boolean)=>{if(applied)operation?.publish({delivery:{state:'confirmed',stage:'host-receipt-observed',receiptId:id}});};},
 };
}

const hosts=new WeakMap<object,ReturnType<typeof createCompletionFacts>>();
export function registerCompletionFactsHost(host:object,capture:()=>JournalFactoryBinding|undefined,emit:(name:string,fact:SupervisionFact)=>void){const owner=createCompletionFacts(capture,emit);hosts.set(host,owner);return {owner,dispose(){if(hosts.get(host)===owner)hosts.delete(host);}};}
export function capturePublicationObservation(host:object,original:object,id:string|undefined){return id?hosts.get(host)?.publication(original,id):undefined;}
export function captureNotificationObservation(host:object,message:object){
 const details=(message as {details?:unknown}).details;if(!details||typeof details!=='object')return undefined;
 const {deliveryId,contentRevision}=details as {deliveryId?:unknown;contentRevision?:unknown};
 if(typeof deliveryId!=='string'||!(typeof contentRevision==='number'||typeof contentRevision==='string'))return undefined;
 return hosts.get(host)?.notification(message,`${deliveryId}:${contentRevision}`);
}
