import {createHash} from 'node:crypto';
import type {GraphSnapshotV3} from '../types.ts';
import {displayEvidence,phaseOf,safeText} from './presentation.ts';
import {nodeExitUnverified,nodeProcessExit} from './process-exit.ts';
import {buildTodoTree} from './todo-tree.ts';
import {TODO_ENTRY,validateTodoSnapshot,projectTodo,type TodoManager,type TodoSnapshot,type TodoView,type TodoLink} from './todo.ts';

export const LIFECYCLE_ENTRY='pi-graph-todo-lifecycle/1';
export interface LeafReference {planEntryId:string;itemId:string}
export interface Replacement {old:LeafReference;next:LeafReference;oldDigest:string;nextDigest:string;reason:string}
export interface LifecycleState {version:1;sessionId:string;planEntryId:string;planId:string;revision:number;visibility:'shown'|'hidden';showDigest?:string;dispositions:Record<string,{kind:'defer'|'not_needed';reason:string}>;replacements:Replacement[];delivery?:string;explained?:{digest:string;reason:string}}
export interface LifecycleProjection {revision:number;planEntryId:string;display:'full'|'summary'|'hidden';historyIds:string[];summary:string;risks:string[];delivered:boolean;observations?:LeafObservation[]}
export type LifecycleAction={expectedRevision:number;action:'visibility';visibility:'shown'|'hidden';digest?:string}|{expectedRevision:number;action:'disposition';id:string;kind:'defer'|'not_needed'|'restore';reason:string}|{expectedRevision:number;action:'replacement';replacement:Replacement}|{expectedRevision:number;action:'delivery';digest:string}|{expectedRevision:number;action:'explained';digest:string;reason:string};
const uncertainAppends=new WeakMap<TodoManager,Set<string>>();
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=400&&safeText(v)===v;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function plan(manager:TodoManager,entryId:string):TodoSnapshot {
 const value=branchPlans(manager).find(p=>p.entryId===entryId);
 if(!value)throw Error('计划稳定原生身份不在当前分支，不能迁移旧记录');
 return value.snapshot;
}
export function branchPlans(manager:TodoManager):Array<{entryId:string;snapshotEntryId:string;snapshot:TodoSnapshot}>{
 const plans=new Map<string,{entryId:string;snapshotEntryId:string;snapshot:TodoSnapshot}>();
 for(const e of manager.getBranch())if(e.type==='custom'&&e.customType===TODO_ENTRY){const snapshot=validateTodoSnapshot(e.data);if(!e.id)throw Error('宿主缺少稳定原生entry身份，生命周期保持只读');const key=snapshot.planId??e.id,prior=plans.get(key);plans.set(key,{entryId:prior?.entryId??e.id,snapshotEntryId:e.id,snapshot});}

 return [...plans.values()];
}
export function restoreLifecycle(manager:TodoManager,planEntryId:string):LifecycleState{
 if(uncertainAppends.get(manager)?.has(planEntryId))throw Error('生命周期保存未确认；请重开原生会话核对，不沿用内存隐藏状态');
 const snapshot=plan(manager,planEntryId);let state:LifecycleState={version:1,sessionId:manager.getSessionId(),planEntryId,planId:snapshot.planId??planEntryId,revision:0,visibility:'shown',dispositions:{},replacements:[]};
 for(const e of manager.getBranch())if(e.type==='custom'&&e.customType===LIFECYCLE_ENTRY){
  const v=e.data as LifecycleState;if(!v||v.version!==1||!string(v.planEntryId)||!string(v.sessionId)||v.sessionId!==manager.getSessionId())throw Error('生命周期最新记录损坏/版本未知，保持未确认');if(v.planEntryId!==planEntryId)continue;
  if(Object.keys(v).some(k=>!['version','sessionId','planEntryId','planId','revision','visibility','showDigest','dispositions','replacements','delivery','explained'].includes(k))||v.showDigest!==undefined&&!hash(v.showDigest)||JSON.stringify(v).length>65536||v.version!==1||v.sessionId!==manager.getSessionId()||v.planId!==state.planId||!Number.isSafeInteger(v.revision)||v.revision!==state.revision+1||!['shown','hidden'].includes(v.visibility)||!v.dispositions||typeof v.dispositions!=='object'||Array.isArray(v.dispositions)||!Array.isArray(v.replacements)||v.replacements.length>128||Object.keys(v.dispositions).length>128||v.delivery!==undefined&&!hash(v.delivery)||v.explained!==undefined&&(!hash(v.explained.digest)||!string(v.explained.reason)))throw Error('生命周期记录损坏或身份/版本不符，不能沿用隐藏状态');
  for(const [id,d]of Object.entries(v.dispositions))if(!snapshot.items.some(i=>i.id===id)||!d||!['defer','not_needed'].includes(d.kind)||!string(d.reason))throw Error('生命周期范围结论无效');
  for(const r of v.replacements)if(!r||r.old?.planEntryId!==planEntryId||!buildTodoTree(snapshot.items).leafIds.includes(r.old?.itemId)||!string(r.old?.planEntryId)||!string(r.old?.itemId)||!string(r.next?.planEntryId)||!string(r.next?.itemId)||!hash(r.oldDigest)||!hash(r.nextDigest)||!string(r.reason))throw Error('接替身份记录无效');
  state=structuredClone(v);
 }
 return state;
}
export function appendLifecycle(manager:TodoManager,planEntryId:string,input:LifecycleAction,append:(type:string,data:LifecycleState)=>void):LifecycleState{
 const snapshot=plan(manager,planEntryId),state=restoreLifecycle(manager,planEntryId),tree=buildTodoTree(snapshot.items);
 if(input.expectedRevision!==state.revision)throw Error(`生命周期版本冲突：当前 revision=${state.revision}`);
 const next=structuredClone(state);
 if(input.action==='visibility'){if(!['shown','hidden'].includes(input.visibility))throw Error('显示操作无效');next.visibility=input.visibility;if(input.visibility==='hidden')delete next.showDigest;if(input.visibility==='shown'&&hash(input.digest))next.showDigest=input.digest;}
 else if(input.action==='disposition'){
  if(!tree.leafIds.includes(input.id)||!string(input.reason))throw Error('范围操作必须指向叶项且提供明确原因');
  if(input.kind==='restore'){delete next.dispositions[input.id];next.replacements=next.replacements.filter(r=>r.old.itemId!==input.id);}else if(['defer','not_needed'].includes(input.kind))next.dispositions[input.id]={kind:input.kind,reason:input.reason};else throw Error('范围结论无效');
 }else if(input.action==='replacement'){
  const r=input.replacement;if(r.old.planEntryId!==planEntryId||!tree.leafIds.includes(r.old.itemId)||!string(r.reason)||!hash(r.oldDigest)||!hash(r.nextDigest))throw Error('接替必须提供精确旧叶与已观察digest');
  const target=plan(manager,r.next.planEntryId);if(!buildTodoTree(target.items).leafIds.includes(r.next.itemId)||r.old.planEntryId===r.next.planEntryId&&r.old.itemId===r.next.itemId)throw Error('接替目标无效或自引用');
  if(next.replacements.some(x=>x.old.itemId===r.old.itemId))throw Error('旧义务已有接替关系，不允许冲突覆盖');
  // Exact cross-plan relation cannot point backwards: no implicit cycles or latest-wins semantics.
  const branch=manager.getBranch();if(branch.findIndex(e=>e.id===r.next.planEntryId)<branch.findIndex(e=>e.id===planEntryId))throw Error('接替不能反向指向旧计划');
  const edges=new Map<string,string>();
  for(const p of branchPlans(manager))for(const relation of restoreLifecycle(manager,p.entryId).replacements)edges.set(JSON.stringify(relation.old),JSON.stringify(relation.next));
  const oldKey=JSON.stringify(r.old);let cursor=JSON.stringify(r.next);const visited=new Set<string>();
  while(true){if(cursor===oldKey||visited.has(cursor))throw Error('接替关系不能成环');visited.add(cursor);const nextKey=edges.get(cursor);if(!nextKey)break;cursor=nextKey;}
  next.replacements.push(structuredClone(r));
 }else if(input.action==='delivery'){if(!hash(input.digest))throw Error('交付digest无效');next.delivery=input.digest;}
 else if(input.action==='explained'){if(!hash(input.digest)||!string(input.reason))throw Error('说明意图必须包含精确问题digest及原因');next.explained={digest:input.digest,reason:input.reason};}
 else throw Error('未知生命周期操作');
 next.revision++;
 if(JSON.stringify(next).length>65536)throw Error('生命周期元信息超过64KiB，未保存');
 try{append(LIFECYCLE_ENTRY,next);}catch{let keys=uncertainAppends.get(manager);if(!keys){keys=new Set();uncertainAppends.set(manager,keys);}keys.add(planEntryId);throw Error('生命周期保存未确认，保持风险可见；重新打开原生会话后核对，不自动重放');}
 return next;
}
export interface LeafObservation {ref:LeafReference;digest:string;identityDigest:string;done:boolean;active:boolean;unsettled:boolean;unknownEffects:boolean;issue:boolean}
export async function observePlan(manager:TodoManager,entryId:string,read:(link:TodoLink)=>Promise<GraphSnapshotV3>){
 const snapshot=plan(manager,entryId),tree=buildTodoTree(snapshot.items),session=manager.getSessionId(),cache=new Map<string,Promise<GraphSnapshotV3>>();
 const boundedRead=(link:TodoLink)=>new Promise<GraphSnapshotV3>((resolve,reject)=>{let done=false;const timer=setTimeout(()=>{done=true;reject(Error('生命周期只读观察超时，结果未确认'));},5000);Promise.resolve().then(()=>read(link)).then(value=>{if(!done){done=true;clearTimeout(timer);resolve(value);}},error=>{if(!done){done=true;clearTimeout(timer);reject(error);}});});
 const get=(link:TodoLink)=>{const key=JSON.stringify([link.graphId,link.runInstanceId]);let p=cache.get(key);if(!p){p=boundedRead(link);cache.set(key,p);}return p;};
 const projected=await projectTodo(snapshot.items,session,get),leaves:LeafObservation[]=[];
 for(const id of tree.leafIds){const item=projected.find(i=>i.id===id)!;let active=false,unsettled=false,unknownEffects=false,issue=item.derivedStatus==='unknown'||item.derivedStatus==='blocked';const facts:unknown[]=[],identities:unknown[]=[];
  for(const link of item.links){try{const s=await get(link),n=s.nodes?.[link.taskId];if(s.sessionId!==session||s.graphId!==link.graphId||s.runInstanceId!==link.runInstanceId||!n)throw Error('关联身份变化');identities.push([link,n.attempt,s.graphDigest,s.sourceGraphSpecDigest]);const phase=phaseOf(n),sup=n.observation?.supervision;unsettled ||= !['accepted','failed','aborted','cancelled','skipped','blocked','not_started'].includes(phase);active ||= ['verifying','applying'].includes(phase)||(['dispatched','running'].includes(phase)&&!nodeProcessExit(n)&&!nodeExitUnverified(n)&&sup?.health!=='exited'&&!sup?.processExitConfirmed);const evidence=displayEvidence(s),effect=evidence?.sideEffects?.[link.taskId],knownEffect=effect!==undefined&&['none','local_read','local_write','external_read','external_write'].includes(effect);unknownEffects ||= !!evidence?.readError||nodeExitUnverified(n)||(phase==='accepted'?!knownEffect:effect!=='none'&&!evidence?.neverDispatched.has(link.taskId));issue ||= !!sup?.attention||!!sup?.error||!!sup?.runtimeFailure||sup?.probe==='unreachable'||(sup?.failedProbes??0)>0;facts.push([link,n.attempt,phase,s.status,nodeProcessExit(n),nodeExitUnverified(n),sup?.attention,sup?.error,sup?.runtimeFailure,sup?.phaseStartedAt,sup?.runnerInstanceId,effect,evidence?.readError,evidence?.neverDispatched.has(link.taskId)]);}catch{unknownEffects=true;issue=true;facts.push([link,'unavailable']);}}
  leaves.push({ref:{planEntryId:entryId,itemId:id},digest:digest([item,facts]),identityDigest:digest([session,entryId,id,item.links,identities]),done:item.derivedStatus==='done'&&!issue,active,unsettled,unknownEffects,issue});
 }
 return {snapshot,items:projected,leaves,digest:digest([session,entryId,snapshot,leaves])};
}
export function projectLifecycle(state:LifecycleState,observed:Awaited<ReturnType<typeof observePlan>>,replacementTargets:ReadonlyMap<string,LeafObservation>=new Map()):LifecycleProjection{
 const historyIds:string[]=[],risks:string[]=[];
 for(const leaf of observed.leaves){const id=leaf.ref.itemId,r=state.replacements.find(r=>r.old.itemId===id),target=r&&replacementTargets.get(JSON.stringify(r.next));const replaced=!!r&&leaf.identityDigest===r.oldDigest&&!!target&&target.identityDigest===r.nextDigest&&target.done&&!target.active&&!target.unsettled&&!target.unknownEffects;
  if((Object.hasOwn(state.dispositions,id)||replaced)&&!leaf.active&&!leaf.unsettled&&!leaf.unknownEffects)historyIds.push(id);
  const label=safeText(observed.snapshot.items.find(i=>i.id===id)?.title??id).slice(0,60);if(leaf.active)risks.push(`${label}仍在执行`);else if(leaf.unsettled)risks.push(`${label}关联任务尚未收尾`);if(leaf.unknownEffects)risks.push(`${label}结果或外部效果待核对`);
 }
 const current=observed.leaves.filter(l=>!historyIds.includes(l.ref.itemId));const delivered=state.delivery===observed.digest&&current.length>0&&current.every(l=>l.done&&!l.active&&!l.unsettled&&!l.unknownEffects)&&!risks.length;
 const issues=current.filter(l=>l.issue).length;
 const display=delivered?(state.visibility==='shown'&&state.showDigest===observed.digest?'full':'hidden'):state.visibility==='hidden'?'summary':'full';
 return {revision:state.revision,planEntryId:state.planEntryId,display,historyIds,risks,delivered,summary:risks.length?`${risks[0]}${risks.length>1?` · 另${risks.length-1}条提示`:""} · 详情`:issues?`${state.explained?.digest===observed.digest?`已说明：${state.explained.reason.slice(0,120)}；仍需处理`:'仍需处理'} ${issues} · 详情`:historyIds.length?`历史未完成/范围调整 ${historyIds.length} · 详情`:current.length&&current.every(l=>l.done)?'结果已就绪，待主会话交付':'计划已收起 · 详情'};
}

interface ObservationBundle {sessionId:string;head:string;planEntryId:string;planRevision:number;lifecycleRevision:number;observed:Awaited<ReturnType<typeof observePlan>>;projection:LifecycleProjection}
export type LifecycleToolOperation={action:'lifecycle';expectedRevision:number;expectedLifecycleRevision:number;planEntryId:string;operation:'show'|'hide'|'defer'|'not_needed'|'restore'|'replace'|'explain';id?:string;reason?:string;replacement?:{old:LeafReference;next:LeafReference;oldDigest:string;nextDigest:string}};
/** Native lifecycle metadata only: never controls a Graph, mutates a snapshot or runs a task. */
export class TodoLifecycle {
 private owner?:string;private ownerManager?:TodoManager;
 activate(manager:TodoManager){this.invalidate();this.ownerManager=manager;this.owner=JSON.stringify([manager.getSessionId(),manager.getSessionFile()??null]);}
 accepts(manager:TodoManager){const candidate=this.candidates.at(-1)??[...this.observations.values()].at(-1);return this.ownerManager===manager&&this.owner===JSON.stringify([manager.getSessionId(),manager.getSessionFile()??null])&&(!candidate||manager.getBranch().some(e=>e.id===candidate.head));}
 private generation=0;private turn=0;private observations=new Map<string,ObservationBundle>();private candidates:ObservationBundle[]=[];private explanation?:{bundle:ObservationBundle;reason:string};private explanationTool?:string;private explanationConfirmed=false;private body=false;private outcome='';private bindings=new WeakMap<TodoView,ObservationBundle>();
 invalidate(){this.ownerManager=undefined;this.owner=undefined;this.generation++;this.started();}
 started(){this.turn++;this.observations.clear();this.candidates=[];this.explanation=undefined;this.explanationTool=undefined;this.explanationConfirmed=false;this.body=false;this.outcome='';}
 messageEnded(message:unknown){const m=message as {role?:string;stopReason?:string;content?:Array<{type?:string;text?:string}>};if(m?.role==='assistant')this.body=m.stopReason==='stop'&&!!m.content?.some(p=>p.type==='text'&&p.text?.trim());}
 beforeSettle(outcome:string){this.outcome=outcome;}
 private anchor(manager:TodoManager){const b=manager.getBranch(),id=b.at(-1)?.id;if(!id)throw Error('缺少稳定分支entry身份，生命周期保持只读');return id;}
 private check(manager:TodoManager,b:ObservationBundle){if(manager.getSessionId()!==b.sessionId||!manager.getBranch().some(e=>e.id===b.head))throw Error('生命周期请求已过期：会话或分支改变');const current=branchPlans(manager).at(-1);if(!current||current.entryId!==b.planEntryId||current.snapshot.revision!==b.planRevision||restoreLifecycle(manager,b.planEntryId).revision!==b.lifecycleRevision)throw Error('生命周期版本已变化，先读取核对');}
 async decorate(manager:TodoManager,view:TodoView,read:(link:TodoLink)=>Promise<GraphSnapshotV3>,historyPage?:{offset:number;limit:number}):Promise<TodoView>{
  const generation=this.generation,plans=branchPlans(manager),latest=plans.at(-1);if(!latest)return view;const head=this.anchor(manager);
  const sessionId=manager.getSessionId(),observations=new Map<string,Awaited<ReturnType<typeof observePlan>>>();
  const oldPlans=plans.slice(0,-1).reverse(),offset=historyPage?.offset??0,limit=historyPage?.limit??8;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>8)throw Error('历史分页须offset>=0、limit为1至8');
  const selected=oldPlans.slice(offset,offset+limit),readCache=new Map<string,Promise<GraphSnapshotV3>>(),sharedRead=(link:TodoLink)=>{const key=JSON.stringify([link.graphId,link.runInstanceId]);let p=readCache.get(key);if(!p){p=read(link);readCache.set(key,p);}return p;};
  await Promise.all([...selected,latest].map(async p=>{observations.set(p.entryId,await observePlan(manager,p.entryId,sharedRead));}));
  if(generation!==this.generation||manager.getSessionId()!==sessionId||!manager.getBranch().some(e=>e.id===head)||branchPlans(manager).at(-1)?.entryId!==latest.entryId||branchPlans(manager).at(-1)?.snapshot.revision!==latest.snapshot.revision)throw Error('生命周期观察已过期');
  const targets=new Map<string,LeafObservation>();for(const o of observations.values())for(const l of o.leaves)targets.set(JSON.stringify(l.ref),l);
  const state=restoreLifecycle(manager,latest.entryId),observed=observations.get(latest.entryId)!,projection=projectLifecycle(state,observed,targets);
  const history=selected.map(p=>{const o=observations.get(p.entryId)!,s=restoreLifecycle(manager,p.entryId),v=projectLifecycle(s,o,targets);return {planEntryId:p.entryId,planId:p.snapshot.planId,goal:p.snapshot.goal,...(historyPage?{items:o.items,observations:o.leaves}:{}),risks:v.risks,summary:v.summary,delivered:v.delivered};});
  const result:TodoView={...view,lifecycle:{...projection,observations:observed.leaves,history,historyOmitted:Math.max(0,oldPlans.length-selected.length),nextOffset:offset+selected.length<oldPlans.length?offset+selected.length:null}};
  this.bindings.set(result,{sessionId,head,planEntryId:latest.entryId,planRevision:latest.snapshot.revision,lifecycleRevision:state.revision,observed,projection});return result;
 }
 observed(toolCallId:string,view:TodoView){const b=this.bindings.get(view);if(b)this.observations.set(toolCallId,b);}
 toolFinished(toolCallId:string,isError:boolean){const b=this.observations.get(toolCallId);this.observations.delete(toolCallId);if(toolCallId===this.explanationTool)this.explanationConfirmed=!isError;if(b&&!isError)this.candidates=[b];}
 async operate(manager:TodoManager,input:LifecycleToolOperation,read:(link:TodoLink)=>Promise<GraphSnapshotV3>,append:((type:string,data:LifecycleState)=>void)|undefined,assertActive:()=>void,toolCallId?:string):Promise<void>{
  if(!append)throw Error('宿主不支持原生appendEntry，生命周期保持只读');assertActive();
  const generation=this.generation,sessionId=manager.getSessionId(),head=this.anchor(manager),p=plan(manager,input.planEntryId),state=restoreLifecycle(manager,input.planEntryId);
  if(p.revision!==input.expectedRevision||state.revision!==input.expectedLifecycleRevision)throw Error('计划或生命周期版本冲突；先list/history');
  if(input.operation==='explain'&&branchPlans(manager).at(-1)?.entryId!==input.planEntryId)throw Error('历史问题说明保持只读；请先明确整理当前目标');
  const observed=await observePlan(manager,input.planEntryId,read);
  let action:LifecycleAction;
  if(input.operation==='show'||input.operation==='hide')action={expectedRevision:state.revision,action:'visibility',visibility:input.operation==='show'?'shown':'hidden',digest:observed.digest};
  else if(['defer','not_needed','restore'].includes(input.operation))action={expectedRevision:state.revision,action:'disposition',id:input.id??'',kind:input.operation as 'defer'|'not_needed'|'restore',reason:input.reason??''};
  else if(input.operation==='replace'){
   const r=input.replacement;if(!r)throw Error('接替须提供精确引用和观察digest');
   const old=observed.leaves.find(l=>l.ref.itemId===r.old.itemId),next=await observePlan(manager,r.next.planEntryId,read),leaf=next.leaves.find(l=>l.ref.itemId===r.next.itemId);
   if(!old||!leaf||old.identityDigest!==r.oldDigest||leaf.identityDigest!==r.nextDigest)throw Error('接替观察或attempt已变化');
   action={expectedRevision:state.revision,action:'replacement',replacement:{...r,reason:input.reason??''}};
  }else if(input.operation==='explain'){
   if(!toolCallId)throw Error('问题说明须来自可确认的工具调用');
   if(!string(input.reason)||!observed.leaves.some(l=>l.issue||l.unknownEffects))throw Error('问题说明必须有明确原因及当前问题');
   const projection=projectLifecycle(state,observed);this.explanationTool=toolCallId;this.explanationConfirmed=false;this.explanation={bundle:{sessionId,head,planEntryId:input.planEntryId,planRevision:p.revision,lifecycleRevision:state.revision,observed,projection},reason:input.reason!};
   action={expectedRevision:state.revision,action:'visibility',visibility:'hidden'};
  }else throw Error('未知生命周期操作');
  assertActive();if(generation!==this.generation||manager.getSessionId()!==sessionId||!manager.getBranch().some(e=>e.id===head)||plan(manager,input.planEntryId).revision!==p.revision||restoreLifecycle(manager,input.planEntryId).revision!==state.revision)throw Error('生命周期请求已过期');
  try{appendLifecycle(manager,input.planEntryId,action,append);}catch(error){if(input.operation==='explain'){this.explanation=undefined;this.explanationTool=undefined;this.explanationConfirmed=false;}throw error;}
  if(this.explanation?.bundle.planEntryId===input.planEntryId)this.explanation.bundle.lifecycleRevision++;
 }
 async settled(manager:TodoManager,aborted:boolean,read:(link:TodoLink)=>Promise<GraphSnapshotV3>,append:((type:string,data:LifecycleState)=>void)|undefined):Promise<boolean>{
  const candidates=this.candidates,explanation=this.explanation;this.candidates=[];this.explanation=undefined;
  if(!append||aborted||this.outcome!=='completed'||!this.body)return false;
  const generation=this.generation,turn=this.turn;let wrote=false;
  for(const b of candidates){try{this.check(manager,b);const fresh=await observePlan(manager,b.planEntryId,read);this.check(manager,b);if(!this.body||this.outcome!=='completed'||generation!==this.generation||turn!==this.turn||fresh.digest!==b.observed.digest)continue;const state=restoreLifecycle(manager,b.planEntryId),active=fresh.leaves.filter(l=>!b.projection.historyIds.includes(l.ref.itemId));if(!active.length||active.some(l=>!l.done||l.active||l.unsettled||l.unknownEffects)||fresh.leaves.some(l=>l.active||l.unsettled||l.unknownEffects)||state.showDigest===fresh.digest||state.delivery===fresh.digest)continue;appendLifecycle(manager,b.planEntryId,{action:'delivery',expectedRevision:state.revision,digest:fresh.digest},append);wrote=true;}catch{/* No trusted fresh evidence: leave the goal visible. */}}
  if(explanation&&this.explanationConfirmed){const b=explanation.bundle;try{this.check(manager,b);const fresh=await observePlan(manager,b.planEntryId,read);this.check(manager,b);if(this.body&&this.outcome==='completed'&&generation===this.generation&&turn===this.turn&&fresh.digest===b.observed.digest){appendLifecycle(manager,b.planEntryId,{action:'explained',expectedRevision:b.lifecycleRevision,digest:fresh.digest,reason:explanation.reason},append);wrote=true;}}catch{/* Explicit intent alone never claims a delivered explanation. */}}
  return wrote;
 }
}
