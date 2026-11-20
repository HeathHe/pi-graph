import {Buffer} from 'node:buffer';
import type {Clock} from '../contracts.ts';
import type {ObservationSnapshot,ObserveParams,ObserveResult} from './contracts.ts';
import type {ObservationRegistry} from './registry.ts';
import {WATCH_MAX_TRANSITIONS,WATCH_MAX_TRANSITION_BYTES} from './text.ts';
/** A hard outer deadline also bounds providers whose snapshot never settles. */
export function watchTargets<D>(registry:ObservationRegistry<D>,clock:Clock,params:ObserveParams,options:{timeoutMs:number;detail:'summary'|'tail'|'full';lines:number},startedAt:number,signal?:AbortSignal):Promise<ObserveResult<D>> {
 const transitions:{observation:ObservationSnapshot<D>;bytes:number}[]=[];
 const keys=new Map<number,string>();
 const latest:ObservationSnapshot<D>[]=params.targets.map(target=>({target,found:true,nativeStatus:'pending',phase:'active',summary:'Still active.',updatedAt:clock.now()}));
 let bytes=2,evicted=0,finished=false;
 let poll:{cancel():void}|undefined,deadline:{cancel():void}|undefined;
 const interval=Math.min(1000,Math.max(100,Math.round(options.timeoutMs/10)));
 return new Promise(resolve=>{
  const finish=()=>{if(finished)return;finished=true;poll?.cancel();deadline?.cancel();signal?.removeEventListener('abort',finish);resolve({action:'watch',reason:signal?.aborted?'aborted':'watch',observations:transitions.map(x=>x.observation),latestObservations:latest,evictedTransitions:evicted,durationMs:clock.now()-startedAt});};
  const record=(index:number,value:ObservationSnapshot<D>)=>{
   if(finished)return;latest[index]=value;
   const key=`${value.nativeStatus}|${value.phase}|${value.revision??''}`;
   if(keys.get(index)===key)return;keys.set(index,key);
   let size=WATCH_MAX_TRANSITION_BYTES+1;try{size=Buffer.byteLength(JSON.stringify(value))+1;}catch{/* oversize/unserializable remains latest */}
   if(size+2>WATCH_MAX_TRANSITION_BYTES){evicted++;return;}
   transitions.push({observation:value,bytes:size});bytes+=size;
   while(transitions.length>WATCH_MAX_TRANSITIONS||bytes>WATCH_MAX_TRANSITION_BYTES){bytes-=transitions.shift()!.bytes;evicted++;}
  };
  const snapshot=async()=>{
   await Promise.all(params.targets.map(async(target,index)=>{
    const provider=registry.get(target.kind);
    try {if(!provider){record(index,{target,found:false,nativeStatus:'not-found',phase:'unknown',waitStatus:'not-found',summary:'No observation provider.',updatedAt:clock.now()});return;}
     const value=await provider.snapshot(target.id,{detail:options.detail,lines:options.lines,view:params.view,cursor:target.cursor});record(index,value);
    }catch{record(index,{target,found:false,nativeStatus:'failed',phase:'unknown',waitStatus:'failed',summary:'Observation provider failed.',updatedAt:clock.now()});}
   }));
   if(!finished)poll=clock.schedule(interval,()=>{void snapshot();});
  };
  deadline=clock.schedule(options.timeoutMs,finish);
  if(signal?.aborted){finish();return;}
  signal?.addEventListener('abort',finish,{once:true});void snapshot();
 });
}
