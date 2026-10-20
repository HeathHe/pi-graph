/** Bounds one read, never the lifetime of a Graph or child. Late results are ignored. */
export class WaitObservationUnavailable extends Error {
 constructor(readonly stage:string,readonly cancelled=false){super(cancelled?`Graph observation cancelled during ${stage}.`:`Graph observation unavailable during ${stage}.`);}
}
export function boundedGraphObservation<T>(stage:string,read:()=>Promise<T>,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<T>{
 return new Promise((resolve,reject)=>{
  let settled=false,timer:ReturnType<typeof setTimeout>|undefined;
  const finish=(value:T|unknown,failed:boolean)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(failed)reject(value);else resolve(value as T);};
  const abort=()=>finish(new WaitObservationUnavailable(stage,true),true);
  if(options.signal?.aborted){abort();return;}
  options.signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>finish(new WaitObservationUnavailable(stage),true),Math.max(1,Math.min(options.timeoutMs??5000,5000)));
  Promise.resolve().then(()=>{if(settled||options.signal?.aborted)return;return read();}).then(v=>{if(!settled)finish(v as T,false);},e=>finish(e,true));
 });
}
