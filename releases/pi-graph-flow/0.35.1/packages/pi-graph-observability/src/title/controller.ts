import type {Clock,Scope,ScopeLease,ReadView,Subscription} from '../contracts.ts';
import {frozen} from '../contracts.ts';
import {captureLease} from '../scope.ts';
import {cleanTitle,suggestTitle} from './rules.ts';
export interface TitleModelPort {generate(request:{scope:Scope;requestId:string;text:string;deadline:number;signal:AbortSignal}):Promise<string|null>}
export interface TitleState {title?:string;manual:boolean;requested:boolean;pending:boolean;source:'none'|'rules'|'model'|'manual';outcome?:'generated'|'fallback'|'timeout'|'cancelled'}
export class TitleOwner {
 private lease?:ScopeLease;private epoch=0;private revision=0;private closed=false;
 private controller?:AbortController;private timer?:{cancel():void};private wake?:()=>void;
 private state:TitleState={manual:false,requested:false,pending:false,source:'none'};
 private readonly listeners=new Set<()=>void>();
 constructor(private readonly clock:Clock,private readonly model?:TitleModelPort){}
 private changed():void{this.revision++;for(const fn of this.listeners){try{fn();}catch{}}}
 start(lease:ScopeLease):void{this.cancel();this.closed=false;this.lease=captureLease(lease);this.state={manual:false,requested:false,pending:false,source:'none'};this.changed();}
 setManualName(name:string|undefined):void {
  if(name?.trim()){this.cancel();this.state={...this.state,title:name,manual:true,source:'manual',pending:false};}
  else {this.state={manual:false,requested:false,pending:false,source:'none'};}
  this.changed();
 }
 async consider(userText:string,assistantText=''):Promise<void>{
  if(this.closed||this.state.manual||this.state.requested||!this.lease?.current())return;
  const fallback=suggestTitle(userText);if(!fallback)return;
  const lease=this.lease,epoch=++this.epoch,controller=new AbortController();this.controller=controller;
  this.state={title:fallback,manual:false,requested:true,pending:!!this.model,source:'rules',outcome:'fallback'};this.changed();
  if(!this.model){this.controller=undefined;return;}
  const deadline=this.clock.now()+10000;
  type Result={kind:'text';text:string|null}|{kind:'timeout'|'cancelled'|'error'};
  const cutoff=new Promise<Result>(resolve=>{this.wake=()=>resolve({kind:'cancelled'});this.timer=this.clock.schedule(10000,()=>resolve({kind:'timeout'}));});
  const request=Promise.resolve().then(()=>this.epoch===epoch&&lease.current()&&!controller.signal.aborted?this.model!.generate({scope:lease.scope,requestId:JSON.stringify([lease.scope,epoch]),text:[userText,assistantText].join('\n').slice(0,12000),deadline,signal:controller.signal}):null).then(text=>({kind:'text' as const,text}),()=>({kind:'error' as const}));
  // Race includes host authentication and transport, even when either ignores abort.
  const result=await Promise.race([request,cutoff]);
  if(this.epoch!==epoch||!lease.current()||this.state.manual||this.closed)return;
  this.timer?.cancel();this.timer=undefined;this.wake=undefined;controller.abort();this.controller=undefined;this.state.pending=false;
  if(result.kind==='text'&&result.text){const title=cleanTitle(result.text);if(title){this.state.title=title;this.state.source='model';this.state.outcome='generated';}}
  else if(result.kind==='timeout')this.state.outcome='timeout';
  this.changed();
 }
 cancel():void{this.epoch++;this.controller?.abort();this.controller=undefined;this.timer?.cancel();this.timer=undefined;this.wake?.();this.wake=undefined;this.state.pending=false;this.state.outcome='cancelled';}
 snapshot():ReadView<TitleState>{return frozen({revision:this.revision,value:this.state});}
 subscribe(fn:()=>void):Subscription{this.listeners.add(fn);return {dispose:()=>this.listeners.delete(fn)};}
 close():void{this.cancel();this.closed=true;this.listeners.clear();}
}
