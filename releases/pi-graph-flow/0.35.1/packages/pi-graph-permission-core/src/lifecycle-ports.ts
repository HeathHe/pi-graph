/** Host supplies a closure over its actual source, never a caller-provided freshness boolean. */
export interface SourceCurrentnessPort<Host> { captureCurrent(host:Host):()=>void; }
export interface LifecycleClock<Timer> { schedule(callback:()=>void,ms:number):Timer;clear(timer:Timer|undefined):void; }
export function createOperationFence<Host>(port:SourceCurrentnessPort<Host>) {
 let generation=0;
 return {invalidate(){generation++;},capture(host:Host){
  const epoch=generation,current=port.captureCurrent(host);
  return ()=>{current();if(epoch!==generation)throw new Error("Permission source changed");};
 }};
}
