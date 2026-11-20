import type {Clock,ScopeLease,ReadView,Subscription} from '../contracts.ts';
import {frozen} from '../contracts.ts';
import {captureLease} from '../scope.ts';
import type {ProviderKey,QuotaObservation,QuotaProviderPort} from './contracts.ts';
export interface QuotaState {provider?:ProviderKey;accountRevision?:string;observation:QuotaObservation;pending:boolean}
export class QuotaOwner {
 private lease?:ScopeLease;private provider?:ProviderKey;private account='';private epoch=0;private revision=0;private closed=false;
 private pending?:Promise<void>;private controller?:AbortController;private timeout?:{cancel():void};private wake?:()=>void;private timer?:{cancel():void};private interval=0;private nextAllowed=0;private queued=false;
 private readonly listeners=new Set<()=>void>();private readonly cache=new Map<string,QuotaObservation>();
 private state:QuotaState={observation:{status:'unconfigured',observedAt:0},pending:false};
 constructor(private readonly clock:Clock,private readonly port:QuotaProviderPort,private readonly deadlineMs=10000,private readonly minRefreshMs=1000,private readonly retainStaleOnError=true){}
 private changed():void{this.revision++;for(const fn of this.listeners){try{fn();}catch{}}}
 configure(lease:ScopeLease,provider:ProviderKey,accountRevision:string,pollIntervalMs=0):void {
  this.invalidate();this.closed=false;this.lease=captureLease(lease);this.provider=provider;this.account=accountRevision;this.interval=Number.isFinite(pollIntervalMs)?Math.max(0,pollIntervalMs):0;this.nextAllowed=0;
  const cached=this.cache.get(JSON.stringify([provider,accountRevision]));this.state={provider,accountRevision,pending:false,observation:cached?{...cached,status:'stale'}:{status:accountRevision?'unknown':'unconfigured',observedAt:this.clock.now()}};this.changed();
  if(this.interval>0)this.schedule(this.interval);
 }
 private invalidate():void {this.epoch++;this.timer?.cancel();this.timer=undefined;this.timeout?.cancel();this.timeout=undefined;this.controller?.abort();this.wake?.();this.wake=undefined;this.pending=undefined;this.queued=false;}
 private schedule(delay:number):void {this.timer?.cancel();if(this.closed||this.interval<=0)return;this.timer=(this.clock.scheduleBackground?.bind(this.clock)??this.clock.schedule.bind(this.clock))(Math.max(1,delay),()=>{this.timer=undefined;void this.poll();});}
 poll():Promise<void> {
  if(this.closed||!this.lease?.current()||!this.provider||!this.account)return Promise.resolve();
  if(this.pending){this.queued=true;return this.pending;}
  if(this.clock.now()<this.nextAllowed){if(this.interval>0)this.schedule(this.nextAllowed-this.clock.now());return Promise.resolve();}
  const lease=this.lease,provider=this.provider,account=this.account,epoch=this.epoch,controller=new AbortController();this.controller=controller;
  const current=()=>!this.closed&&this.epoch===epoch&&lease.current()&&!controller.signal.aborted;
  this.state.pending=true;this.changed();
  const work=(async()=>{
   let deadlineTimer:{cancel():void}|undefined;
   const cancelled=new Promise<QuotaObservation|null>(resolve=>{this.wake=()=>resolve(null);deadlineTimer=this.clock.schedule(this.deadlineMs,()=>resolve({status:'error',errorCode:'timeout',observedAt:this.clock.now()}));this.timeout=deadlineTimer;});
   try {
    const request=Promise.resolve().then(()=>current()?this.port.fetch({scope:lease.scope,provider,accountRevision:account,signal:controller.signal,deadline:this.clock.now()+this.deadlineMs}):null).catch(():QuotaObservation=>({status:'error',errorCode:'unavailable',observedAt:this.clock.now()}));
    const value=await Promise.race([request,cancelled]);
    if(!value||!current())return;
    const old=this.cache.get(JSON.stringify([provider,account]));
    const observation:QuotaObservation=this.retainStaleOnError&&value.status==='error'&&value.errorCode!=='timeout'&&old?.data?{...value,status:'stale',data:old.data}:value;
    // Cache and visible state commit occur only after account/session epoch recheck.
    if(!current())return;
    this.state.observation=frozen(observation);
    if(value.status==='known'){const key=JSON.stringify([provider,account]);this.cache.set(key,frozen(value));if(this.cache.size>32)this.cache.delete(this.cache.keys().next().value!);}
    this.nextAllowed=this.clock.now()+Math.max(this.minRefreshMs,value.retryAfterMs??0);
   }finally{
    deadlineTimer?.cancel();controller.abort();
    if(this.epoch===epoch){this.timeout=undefined;this.wake=undefined;this.controller=undefined;this.state.pending=false;this.pending=undefined;this.changed();const queued=this.queued;this.queued=false;if(queued&&this.clock.now()>=this.nextAllowed)void this.poll();else this.schedule(Math.max(this.interval,this.nextAllowed-this.clock.now()));}
   }
  })();this.pending=work;return work;
 }
 snapshot():ReadView<QuotaState>{return frozen({revision:this.revision,value:this.state});}
 subscribe(fn:()=>void):Subscription{this.listeners.add(fn);return {dispose:()=>this.listeners.delete(fn)};}
 close():void{this.closed=true;this.invalidate();this.state.pending=false;this.listeners.clear();}
}
