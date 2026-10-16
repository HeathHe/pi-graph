import {nodeProcessExit,nodeExitUnverified} from "./process-exit.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { GraphSnapshotV3,V3NodeProjection } from "../types.ts";
import type { TodoView } from "./todo.ts";
import {activeNode,counts,displayPhase,graphLabel,nodeIdentity,nodeReason,orderedNodes,phaseLabel,phaseOf,safeText} from "./presentation.ts";
export type CockpitTab="plan"|"tasks"|"agents";
export const emptyTodo=():TodoView=>({revision:0,items:[],persistence:"memory"});
export function liveAgent(n:V3NodeProjection):boolean{return !nodeProcessExit(n)&&!nodeExitUnverified(n)&&!!n.observation?.asyncId&&["dispatched","running"].includes(phaseOf(n))&&n.observation?.supervision?.health!=="exited"&&!n.observation?.supervision?.processExitConfirmed;}
export function graphIssues(s:GraphSnapshotV3):number{return Object.entries(s.nodes??{}).filter(([id,n])=>["failed","needs_attention","exit_unreconciled","exit_unverified","blocked","not_started"].includes(displayPhase(s,id,n))||!!n.observation?.supervision?.attention).length;}
export function cockpitFocus(snapshots:readonly GraphSnapshotV3[],preferred?:string):GraphSnapshotV3|undefined{
 const recent=[...snapshots].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 const active=recent.filter(s=>Object.values(s.nodes??{}).some(activeNode));
 return active.find(s=>s.graphId===preferred)??active[0]??recent.find(s=>s.graphId===preferred)??recent.find(s=>graphIssues(s)>0)??recent[0];
}
export const todoStateLabel=(s:string)=>({pending:"待办",in_progress:"进行中",blocked:"待处理",done:"完成",unknown:"待核实"})[s]??s;
export function cockpitLines(snapshots:readonly GraphSnapshotV3[],plan:TodoView,width:number,height:number,preferred?:string):string[]{
 const focus=cockpitFocus(snapshots,preferred), budget=Math.max(2,Math.min(13,Math.floor(height/2)-2));
 if(!focus&&!plan.items.length&&!plan.error)return [];
 const rows:Array<{text:string;priority:number}>=[];const add=(text:string,priority:number)=>rows.push({text,priority});
 const current=focus&&orderedNodes(focus).find(([,n])=>activeNode(n));
 add(focus?`◆ Graph · ${graphLabel(focus)}${current?` · ${safeText(current[0])}`:` · ${safeText(focus.graphId)}`}`:"◆ 总计划 · 尚未关联执行图",100);
 if(plan.error)add(`总计划待核实：${safeText(plan.error)}`,98);
 else if(plan.items.length){const done=plan.items.filter(i=>i.derivedStatus==="done"),manual=done.filter(i=>i.source==="人工").length;
  add(`总计划 完成 ${done.length}/${plan.items.length}（人工${manual} / 执行${done.length-manual}） · ${plan.persistence==="durable"?"已保存":plan.persistence==="memory"?"会话内存":"保存待核实"}`,96);
  const order=[...plan.items].sort((a,b)=>({unknown:0,blocked:1,in_progress:2,pending:3,done:4}[a.derivedStatus]-{unknown:0,blocked:1,in_progress:2,pending:3,done:4}[b.derivedStatus]));
  for(const [i,item] of order.slice(0,3).entries())add(`  ${todoStateLabel(item.derivedStatus)} · ${safeText(item.title)}（${item.source}）`,70-i);
 }
 if(focus){const nodes=Object.values(focus.nodes??{});add(`Graph 已验收 ${nodes.filter(n=>phaseOf(n)==="accepted").length}/${nodes.length} · ${counts(focus)}`,94);
  if(!plan.items.length)for(const [i,[id,n]] of orderedNodes(focus).slice(0,3).entries())add(`  ${phaseLabel(n,focus,id)} · ${safeText(id)}`,72-i);
  const issue=orderedNodes(focus).find(([id,n])=>["failed","needs_attention","exit_unreconciled","exit_unverified"].includes(displayPhase(focus,id,n))||n.observation?.supervision?.attention);
  if(issue)add(`待处理：${nodeReason(focus,...issue)}`,93);
  const agents=orderedNodes(focus).filter(([,n])=>liveAgent(n));
  for(const [i,[id,n]] of agents.slice(0,2).entries()){const identity=nodeIdentity(id,n),p=n.observation?.progress;add(`Agent · ${identity.task}${identity.role?` · ${identity.role}`:""}`,84-i*8);const facts=[identity.model?`模型：${identity.model}`:"",p?.currentTool?`工具 ${safeText(p.currentTool)}`:p?.lastTool?`最近工具 ${safeText(p.lastTool)}`:""].filter(Boolean);if(facts.length)add(`  ${facts.join(" · ")}`,83-i*8);}
  if(agents.length>2)add(`另有 ${agents.length-2} 个活动执行者 · /graphs agents`,60);
 }
 const other=snapshots.filter(s=>s!==focus);if(other.length)add(`其他记录 ${other.length} · 待处理图 ${other.filter(s=>graphIssues(s)>0).length}（本会话已观测）`,92);
 add("Alt+G 面板 · /graphs todo/tasks/agents · /graphs history",99);
 const keep=new Set(rows.map((r,i)=>({...r,i})).sort((a,b)=>b.priority-a.priority).slice(0,budget).map(r=>r.i));
 return rows.filter((_,i)=>keep.has(i)).map(r=>truncateToWidth(safeText(r.text),Math.max(0,width-1)));
}
