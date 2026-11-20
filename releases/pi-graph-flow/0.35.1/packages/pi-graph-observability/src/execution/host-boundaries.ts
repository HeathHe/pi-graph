/** Producer sequence remains shared with the legacy facade; observation cannot steer. */
export interface HostBoundary {correlationId:string;incarnation:string;sequence:number;parentSessionFile?:string;runtimeGeneration:number;event:Readonly<Record<string,unknown>>}
const sequenceKey=Symbol.for('pi-maestro-teammate.host-boundary-sequence.v1');
const state=globalThis as typeof globalThis & Record<symbol,unknown>;
export function nextTeammateHostSequence():number { const n=typeof state[sequenceKey]==='number'?state[sequenceKey] as number:0; return state[sequenceKey]=n+1; }
export class HostBoundaryRegistry<B extends HostBoundary = HostBoundary> {
 private readonly observers:Map<string,(boundary:Readonly<B>)=>void>;
 constructor(key=Symbol.for('pi-graph-observability.readonly-host-boundaries.v1')) { const found=state[key]; this.observers=found instanceof Map?found:new Map(); state[key]=this.observers; }
 register(owner:string,observer:(boundary:Readonly<B>)=>void):()=>void { if(!owner.trim())throw new Error('Host observer owner is required'); if(!this.observers.has(owner)&&this.observers.size>=64)throw new Error('Host observer registry is full'); this.observers.set(owner,observer);return()=>{if(this.observers.get(owner)===observer)this.observers.delete(owner);}; }
 publish(boundary:B):void { const passive={...boundary}; delete (passive as B & {steer?:unknown}).steer; for(const observer of this.observers.values()){try{observer(Object.freeze(passive));}catch{/* passive observers cannot break execution */}} }
}
