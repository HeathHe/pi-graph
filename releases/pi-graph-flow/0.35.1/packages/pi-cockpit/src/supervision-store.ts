import {CockpitObservationHost} from './observability/host-adapter.ts';
import {validFact,type SupervisionFact} from 'pi-graph-observability';
export const MAX_SUPERVISION_EVENTS=50;
export const SUPERVISION_SOURCES=['goal','monitor','advisor','completion'] as const;
export const SUPERVISION_KINDS=['evaluating','verdict','intervention','notification','completion','physical-close'] as const;
export const SUPERVISION_SEVERITIES=['info','nit','concern','blocker'] as const;
export type SupervisionSource=typeof SUPERVISION_SOURCES[number];
export type SupervisionKind=typeof SUPERVISION_KINDS[number];
export type SupervisionSeverity=typeof SUPERVISION_SEVERITIES[number];
export interface SupervisionEventLike extends SupervisionFact {timestamp:number;meta?:Record<string,unknown>}
export interface SupervisionTotals {interventions:number;notifications:number;verdicts:number;evaluations:number;publications:number;physicalCloses:number;confirmed:number;unknown:number;attempted:number;failed:number}
export function normalizeSupervisionEvent(payload:unknown):SupervisionEventLike|undefined {if(!validFact(payload as SupervisionFact))return undefined;const f=payload as SupervisionFact;return {...f,timestamp:f.header.observedAt};}
export class SupervisionStore {
 readonly host=new CockpitObservationHost();
 start(cwd:string,sessionId:string,refresh:()=>void):void{this.host.start(cwd,sessionId,refresh);}
 stop():void{this.host.stop();}
 applyEvent(payload:unknown):boolean{return this.host.accept(payload);}
 get revision():number{return this.host.snapshot()?.revision??0;}
 recentEvents(limit=10):SupervisionEventLike[]{return (this.host.snapshot()?.value.events??[]).slice(-Math.max(0,limit)).map(f=>({...f,timestamp:f.header.observedAt}));}
 getTotals():SupervisionTotals {const p=this.host.snapshot()?.value;return {interventions:p?.counts.intervention??0,notifications:p?.counts['notification-receipt']??0,verdicts:p?.counts.verdict??0,evaluations:p?.counts.evaluation??0,publications:p?.counts['execution-publication']??0,physicalCloses:p?.counts['physical-close']??0,confirmed:p?.delivery.confirmed??0,unknown:p?.delivery.unknown??0,attempted:p?.delivery.attempted??0,failed:p?.delivery.failed??0};}
 history(){return this.host.snapshot()?.value.history;}
 footerStatus():string|undefined {const p=this.host.snapshot()?.value;if(!p)return undefined;const t=this.getTotals(),parts:string[]=[];
 if(t.interventions)parts.push(`I${t.interventions}`);if(t.verdicts)parts.push(`V${t.verdicts}`);if(t.publications)parts.push(`Published${t.publications}`);if(t.notifications)parts.push(`N${t.notifications}`);if(t.confirmed)parts.push(`Receipt${t.confirmed}`);if(t.unknown)parts.push(`Unknown${t.unknown}`);if(t.physicalCloses)parts.push(`Closed${t.physicalCloses}`);
 const severity=[...p.events].reverse().find(f=>f.severity==='concern'||f.severity==='blocker')?.severity;if(severity)parts.push(severity==='blocker'?'▲':'△');if(p.history.status!=='available')parts.push('history unavailable');return parts.join(' ')||undefined;
 }
}
