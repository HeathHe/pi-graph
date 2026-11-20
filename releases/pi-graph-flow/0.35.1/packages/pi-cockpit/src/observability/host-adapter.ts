import {createHash,randomUUID} from 'node:crypto';
import {SupervisionOwner,ScopeGeneration,captureRootLease,resolveJournalPort,subscribeRootLease,scopeKey,validFact,type Clock,type ScopeLease,type JournalPartition,type SupervisionFact} from 'pi-graph-observability';
export const cockpitObservationClock:Clock={now:Date.now,schedule(ms,fn){const timer=setTimeout(fn,ms);return {cancel:()=>clearTimeout(timer)};}};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Owns only derived observations. A local scope never claims to be Teammate Root. */
export class CockpitObservationHost {
 private generation=new ScopeGeneration();private partition:JournalPartition={workspaceDigest:'unconfigured',sessionDigest:'unconfigured'};
 private local?:ScopeLease;private current?:ScopeLease;private owner?:SupervisionOwner;private rootSubscription?:{dispose():void};private ownerSubscription?:{dispose():void};private listener:()=>void=()=>{};
 constructor(private readonly clock:Clock=cockpitObservationClock){}
 start(cwd:string,sessionId:string,onChange:()=>void=()=>{}):void {
  this.stop();this.listener=onChange;this.partition={workspaceDigest:digest(cwd),sessionDigest:digest(sessionId)};
  this.local=this.generation.start({sessionId,runtimeGeneration:1,ownerId:'cockpit-local-observation',incarnation:randomUUID()});
  this.rootSubscription=subscribeRootLease(()=>this.refresh());this.refresh();
 }
 refresh():void {
  if(!this.local)return;const binding=captureRootLease(this.partition),lease=binding?.lease??this.local;
  if(!this.current||!this.owner||scopeKey(this.current.scope)!==scopeKey(lease.scope)||!this.current.current()){
   this.ownerSubscription?.dispose();void this.owner?.close();this.current=lease;this.owner=new SupervisionOwner(lease,this.clock,this.partition);
   this.ownerSubscription=this.owner.subscribe(()=>this.listener());
  }
  if(binding){const port=resolveJournalPort(binding);if(port&&this.owner.attachJournal(port))void this.owner.restoreHistory();}
  this.listener();
 }
 accept(payload:unknown):boolean {if(!this.owner||!validFact(payload as SupervisionFact))return false;return this.owner.accept(payload as SupervisionFact)==='applied';}
 snapshot(){return this.owner?.snapshot();}
 stop():void {this.rootSubscription?.dispose();this.rootSubscription=undefined;this.ownerSubscription?.dispose();this.ownerSubscription=undefined;this.generation.invalidate();this.local=undefined;this.current=undefined;void this.owner?.close();this.owner=undefined;}
}
