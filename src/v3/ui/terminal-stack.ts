import {truncateToWidth,visibleWidth} from "@earendil-works/pi-tui";
import type {GraphSnapshotV3,V3NodeProjection} from "../types.ts";
import type {TodoView} from "./todo.ts";
import {cockpitFocus,graphIssues,liveAgent} from "./cockpit.ts";
import {displayPhase,nodeIdentity,nodeReason,orderedNodes,phaseLabel,safeText,readableNodeTitle,readableRole,agentIdentityRows,supervisionWarning} from "./presentation.ts";
export interface StackTheme {fg(color:any,text:string):string;bold?(text:string):string;strikethrough?(text:string):string}
export interface ParentActivity {active:boolean;tool?:string;sessionId?:string}
export interface StackInput {snapshots:readonly GraphSnapshotV3[];identitySnapshots?:readonly GraphSnapshotV3[];plan:TodoView;expanded:boolean;preferred?:string;parent?:ParentActivity;reservedRows?:number;sessionId?:string}
interface Segment {text:string;priority:number;clip?:boolean}
// Independently implemented terminal grammar, informed by pi-cockpit fd83ac0.
function fit(segments:Segment[],width:number,separator=" "):string{
 const remaining=segments.map(s=>({...s}));
 while(visibleWidth(remaining.map(s=>s.text).join(separator))>width&&remaining.length){
  let index=0;for(let i=1;i<remaining.length;i++)if(remaining[i].priority<remaining[index].priority)index=i;
  const over=visibleWidth(remaining.map(s=>s.text).join(separator))-width,available=visibleWidth(remaining[index].text)-over;
  if(remaining[index].clip&&available>=8){remaining[index].text=truncateToWidth(remaining[index].text,available,"…");break;}
  remaining.splice(index,1);
 }
 return truncateToWidth(remaining.map(s=>s.text).join(separator),Math.max(0,width),"…");
}
export interface StackTask {id:string;title:string;status:string;assignees:string[];dependencies:Array<{id?:string;graphId?:string;runInstanceId?:string;planId?:string;title:string;status:string}>;reason?:string;critical?:boolean;source:string;identities?:Array<{node:V3NodeProjection;taskId:string}>;identityMissing?:boolean;waiting?:boolean}
const inactiveLabels:Record<string,string>={cancelled:"已取消",skipped:"已跳过",not_started:"未启动"};
const normalize=(status:string)=>inactiveLabels[status]?status:status==="accepted"||status==="done"?"completed":["running","dispatched","prepared","applying","verifying","in_progress"].includes(status)?"in_progress":["blocked","failed","needs_attention","exit_unreconciled","exit_unverified","unknown","aborted"].includes(status)?"blocked":"pending";
export function stackTasks(input:StackInput):StackTask[]{
 const focus=cockpitFocus(input.snapshots,input.preferred),sessions=[...new Set(input.snapshots.map(s=>s.sessionId))];
 const session=input.sessionId??input.parent?.sessionId??(sessions.length===1?sessions[0]:undefined);
 const identityByRun=new Map<string,GraphSnapshotV3>();
 // Same ordering as the entry UI projection: revision first, then updatedAt.
 // Whole source objects retain their attached proof; later live entries win ties.
 for(const candidate of [...(input.identitySnapshots??[]),...input.snapshots]){
  const key=JSON.stringify([candidate.sessionId,candidate.graphId,candidate.runInstanceId]),existing=identityByRun.get(key);
  if(existing){if(existing.revision!==undefined&&candidate.revision!==undefined){if(candidate.revision<existing.revision)continue;if(candidate.revision>existing.revision){identityByRun.set(key,candidate);continue;}}if(Date.parse(candidate.updatedAt)-Date.parse(existing.updatedAt)<0)continue;}
  identityByRun.set(key,candidate);
 }
 const identitySources=[...identityByRun.values()];
 const nodeTask=(s:GraphSnapshotV3,id:string,n:V3NodeProjection):StackTask=>({id,title:readableNodeTitle(s,id,n),status:normalize(displayPhase(s,id,n)),assignees:[nodeIdentity(id,n).role].filter(Boolean),identities:[{node:n,taskId:id}],dependencies:(n.dependsOn??[]).map(dep=>({id:dep,graphId:s.graphId,runInstanceId:s.runInstanceId,title:s.nodes?.[dep]?readableNodeTitle(s,dep,s.nodes[dep]):'前置任务（目标待补充）',status:s.nodes?.[dep]?normalize(displayPhase(s,dep,s.nodes[dep])):'unknown'})),critical:['failed','needs_attention','exit_unreconciled','exit_unverified','blocked'].includes(displayPhase(s,id,n))||!!n.observation?.supervision?.attention||!!n.observation?.supervision?.error||!!supervisionWarning(n),reason:inactiveLabels[displayPhase(s,id,n)]??(['failed','needs_attention','exit_unreconciled','exit_unverified','blocked'].includes(displayPhase(s,id,n))?`${phaseLabel(n,s,id)}：${nodeReason(s,id,n)}`:undefined),source:'Graph验收'});
 if(!input.plan.items.length)return focus?Object.entries(focus.nodes??{}).map(([id,n])=>nodeTask(focus,id,n)):[];
 const byId=new Map(input.plan.items.map(item=>[item.id,item]));
 const refsById=new Map(input.plan.items.map(item=>[item.id,item.links.flatMap(ref=>{const matches=identitySources.filter(s=>s.sessionId===session&&s.graphId===ref.graphId&&s.runInstanceId===ref.runInstanceId),s=matches.length===1?matches[0]:undefined,n=s?.nodes?.[ref.taskId];return s&&n?[nodeTask(s,ref.taskId,n)]:[];})]));
 const locallySafe=(item:TodoView["items"][number])=>item.status!=='blocked'&&item.derivedStatus!=='unknown'&&(refsById.get(item.id)?.length??0)===item.links.length&&!refsById.get(item.id)?.some(ref=>ref.critical||ref.status==='blocked'||inactiveLabels[ref.status]);
 const waitingMemo=new Map<string,boolean>(),visiting=new Set<string>();
 const normalWait=(id:string):boolean=>{
  if(waitingMemo.has(id))return waitingMemo.get(id)!;
  const item=byId.get(id);
  if(!item||visiting.has(id))return false;
  if(item.status!=='pending'||item.derivedStatus!=='blocked'||!item.reason?.startsWith('计划前置项未完成：')||!locallySafe(item)){waitingMemo.set(id,false);return false;}
  visiting.add(id);
  const pending=(item.dependsOn??[]).map(key=>byId.get(key)).filter(dep=>dep?.derivedStatus!=='done');
  const waiting=pending.length>0&&pending.every(dep=>!!dep&&locallySafe(dep)&&(['pending','in_progress'].includes(dep.derivedStatus)||normalWait(dep.id)));
  visiting.delete(id);waitingMemo.set(id,waiting);return waiting;
 };
 return input.plan.items.map(item=>{
  const refs=refsById.get(item.id)??[];
  const deps:StackTask["dependencies"]=[...(item.dependsOn??[]).map(id=>{const dep=input.plan.items.find(i=>i.id===id);return {id,planId:id,title:dep?safeText(dep.title):id,status:dep?normalize(dep.derivedStatus):'unknown'};}),...refs.flatMap(r=>r.dependencies).map(dep=>{const matches=input.plan.items.filter(candidate=>candidate.links.some(link=>link.graphId===dep.graphId&&link.runInstanceId===dep.runInstanceId&&link.taskId===dep.id));return matches.length===1?{...dep,planId:matches[0].id,title:safeText(matches[0].title)}:dep;})];
  const dependencies=deps.filter((d,i)=>deps.findIndex(x=>(x.planId??`${x.graphId}/${x.runInstanceId}/${x.id}`)===(d.planId??`${d.graphId}/${d.runInstanceId}/${d.id}`))===i);
  const waiting=normalWait(item.id);
  return {id:item.id,title:safeText(item.title),status:normalize(item.derivedStatus),assignees:[...new Set([...(item.assignee?[item.assignee]:[]),...refs.flatMap(r=>r.assignees)])],identities:refs.flatMap(r=>r.identities??[]),identityMissing:refs.length!==item.links.length,dependencies,waiting,critical:refs.some(r=>r.critical)||item.derivedStatus==='unknown',reason:waiting?undefined:item.reason??refs.find(r=>r.reason)?.reason,source:item.source};
 });
}
/** Model IDs lead when space is tight; identity pairs are never cross-joined. */
function todoIdentity(t:StackTask,width:number):string {
 if(t.identityMissing)return truncateToWidth('关联身份待核实 · Alt+R',width,'…');
 const pairs=(t.identities??[]).map(({node})=>{const actual=safeText(node.observation?.actualModel),role=nodeIdentity('',node).role,phase=displayPhase({} as GraphSnapshotV3,'',node),model=['queued','prepared'].includes(phase)?'待执行':actual||'模型待上报';return {key:actual,full:model,model:actual&&model===actual?actual.split('/').at(-1)!:model,role:role?(node.observation?.actualAgent?'@':'分配@')+role:'Agent待上报'};});
 const unique=pairs.filter((p,i)=>pairs.findIndex(q=>q.key===p.key&&q.model===p.model&&q.role===p.role)===i);if(!unique.length)return '';
 const rendered:string[]=[];
 for(const [i,pair]of unique.entries()){
  const model=width>=70?pair.full:pair.model,text=model+' '+pair.role,remaining=unique.length-i-1,suffix=remaining?` +${remaining} Alt+R`:'';
  const next=[...rendered,text].join(' · ');
  if(visibleWidth(next+suffix)<=width){rendered.push(text);continue;}
  if(rendered.length)return rendered.join(' · ')+` +${unique.length-rendered.length} Alt+R`;
  const room=Math.max(0,width-visibleWidth(suffix)),modelWidth=Math.min(visibleWidth(pair.model),Math.max(8,Math.floor(room*.55))),roleWidth=Math.max(0,room-modelWidth-1);
  return truncateToWidth(pair.model,modelWidth,'…')+' '+truncateToWidth(pair.role,roleWidth,'…')+suffix;
 }
 return rendered.join(' · ');
}

const metric=(value:number)=>value<100?String(value):`${(value/(value<999950?1000:1000000)).toFixed(1).replace(/\.0$/,"")}${value<999950?"k":"m"}`;
export function stackRoleColor(role:string):string{const name=role.toLowerCase();if(name.includes("backend"))return "syntaxVariable";if(name.includes("general"))return "syntaxString";if(name.includes("qa")||name.includes("review"))return "syntaxKeyword";const palette=["syntaxFunction","syntaxType","syntaxString","syntaxVariable","syntaxKeyword","mdLink"];let hash=5381;for(const char of role)hash=(hash*33+char.codePointAt(0)!)>>>0;return palette[hash%palette.length];}
const glyph=(status:string)=>inactiveLabels[status]?"–":status==="completed"?"✓":status==="in_progress"?"●":status==="blocked"?"!":"○";
const stateColor=(status:string)=>status==="completed"?"success":status==="blocked"?"error":status==="in_progress"?"accent":"dim";
export function terminalStack(input:StackInput,width:number,height:number,theme:StackTheme):{todo:string[];agents:string[]}{
 const max=Math.max(0,width-1),total=Math.max(0,Math.min(input.expanded?18:8,height-(input.reservedRows??6)));
 if(!total)return {todo:[],agents:[]};
 const tasks=stackTasks(input),focus=cockpitFocus(input.snapshots,input.preferred);
 const live=input.snapshots.flatMap(s=>orderedNodes(s).filter(([,n])=>liveAgent(n)).map(([id,n])=>({s,id,n}))).sort((a,b)=>Number(b.s===focus)-Number(a.s===focus));
 const hasTodo=tasks.length>0||!!input.plan.error;
 const minimumTodo=hasTodo?1:0;
 const desiredAgentRows=live.length*(width<70?2:1)+Number(!!input.parent?.active)+1;
 const reservedAgents=live.length?Math.min(Math.max(0,total-minimumTodo),Math.max(1,Math.min(desiredAgentRows,Math.floor(total/2)))):input.parent?.active?Math.min(1,Math.max(0,total-minimumTodo)):0;
 const todoBudget=hasTodo?(input.expanded?total-reservedAgents:1):0;
 const agentBudget=total-todoBudget,todo:string[]=[],agents:string[]=[];
 if(total===1&&hasTodo){
  const current=tasks.find(t=>t.critical||t.status==='blocked')??tasks.find(t=>t.status==='in_progress')??tasks.find(t=>t.status!=='completed')??tasks[0];
  const error=!!input.plan.error,title=error?`待核实 ${safeText(input.plan.error)}`:(current?.waiting?'等待前置 · ':'')+(current?.title??'待办待核实');
  const mark=error?'!':current?.waiting?'○':current?.critical?'!':glyph(current?.status??'pending'),color=error?'error':current?.waiting?'muted':current?.critical?'error':stateColor(current?.status??'pending');
  const hint=' Alt+R',identity=current&&!error?todoIdentity(current,Math.max(0,max-16)):'';
  const lead=identity?truncateToWidth(title,Math.min(10,Math.max(2,max-32)),'…'):truncateToWidth(title,Math.max(0,max-visibleWidth(hint)-2),'…');
  const body=identity?`${lead} ${todoIdentity(current!,Math.max(0,max-visibleWidth(lead)-visibleWidth(hint)-3))}`:lead;
  return {todo:[truncateToWidth(theme.fg(color,mark)+' '+body+hint,max,'…')],agents:[]};
 }

 const fg=(color:string,text:string)=>theme.fg(color,text),seg=(text:string,priority:number,clip=false):Segment=>({text,priority,clip});
 const taskTitle=(t:StackTask,index:number)=>{let title=t.title;title=fg(t.waiting?"muted":t.critical?"error":t.status==="completed"?"success":t.status==="blocked"?"error":"text",title);if(t.status==="completed")return theme.strikethrough?.(title)??title;return t.status==="in_progress"?(theme.bold?.(title)??title):title;};
 const taskSegments=(t:StackTask,index:number)=>[seg(fg(t.waiting?"muted":t.critical?"error":stateColor(t.status),t.waiting?"○":t.critical?"!":glyph(t.status)),95),...(t.assignees.length?[seg(fg("mdLink",t.assignees.map(r=>readableRole(r)).join("/")),85,true)]:[]),seg(taskTitle({...t,title:(t.waiting?"等待前置 · ":"")+t.title},index),90,true)];
 if(input.plan.error)todo.push(fit([seg(fg("error",`Todo · 待核实 ${safeText(input.plan.error)}`),95,true),seg(fg("dim","(Alt+T展开)"),60)],max));
 else if(tasks.length){
  const done=tasks.filter(t=>t.status==="completed").length;
  const summary=[seg(fg("syntaxFunction",input.plan.items.length?`待办 已完成 ${done}/${tasks.length}`:'当前任务（未建总计划）'),100)];
  summary.push(seg(fg("dim",`${input.expanded?"Alt+T 收起":"已收起 · Alt+T 展开"}`),10));todo.push(fit(summary,max," · "));
  if(input.expanded){
   if(todoBudget<=2)todo.length=0;
   const rank:Record<string,number>={in_progress:0,blocked:1,pending:2,cancelled:3,skipped:3,not_started:3,completed:4};const ordered=tasks.map((t,index)=>({t,index})).sort((a,b)=>rank[a.t.status]-rank[b.t.status]);
   const reserve=todoBudget>1&&ordered.length>todoBudget-todo.length?1:0;let shown=0;
   for(const {t,index} of ordered){
    if(todo.length>=todoBudget-reserve)break;
    const identity=todoIdentity(t,Math.max(0,max-4)),room=todoBudget-reserve-todo.length,mark=fg(t.waiting?'muted':t.critical?'error':stateColor(t.status),t.waiting?'○':t.critical?'!':glyph(t.status));
    if(identity){
     if(width>=100){const title=truncateToWidth((t.waiting?'等待前置 · ':'')+t.title,Math.min(30,Math.floor(max*.3)),'…'),body=todoIdentity(t,max-visibleWidth(title)-7);todo.push(`  ${mark} ${taskTitle({...t,title},index)} · ${fg('muted',body)}`);}
     else {if(room===1){const title=truncateToWidth((t.waiting?'等待前置 · ':'')+t.title,Math.min(10,Math.floor(max*.22)),'…');todo.push(`  ${mark} ${taskTitle({...t,title},index)} ${fg('muted',todoIdentity(t,max-visibleWidth(title)-5))}`);}else{todo.push(`  ${mark} ${fg('muted',identity)}`);todo.push('    '+taskTitle({...t,title:truncateToWidth((t.waiting?'等待前置 · ':'')+t.title,max-4,'…')},index));}}
    }else todo.push('  '+fit(taskSegments(t,index),Math.max(0,max-2)));
    const pending=t.dependencies.filter(d=>d.status!=='completed'),reason=t.waiting?'等待前置：'+[...new Set(pending.map(d=>d.title))].join('、'):t.reason?.includes('前置任务未满足')&&pending.length?'未执行：'+pending.map(d=>`← ${glyph(d.status)} ${d.title}`).join('、'):t.reason;
    if(reason&&todo.length<todoBudget-reserve)todo.push('    '+fg(t.waiting?'muted':'error',truncateToWidth(safeText(reason),max-4,'…')));
    shown++;
   }
   if(shown<tasks.length&&todo.length<todoBudget)todo.push(fg("dim",`  … 另 ${tasks.length-shown} 项 · /graphs todo`));
  }
 }
 let displayed=0;
 for(const [index,{s,id,n}] of live.entries()){
  const remaining=agentBudget-agents.length;if(remaining<1)break;
  const others=live.length-index-1,twoLines=width<70&&remaining-Math.min(others,remaining-1)>=2;
  const consumed=twoLines?2:1,lastSlot=remaining===consumed,overflow=lastSlot&&others?` +${others}`:'';
  const phase=phaseLabel(n,s,id),prefix=`${index===live.length-1?'└':'├'} ${phase==='等待用户'?'!':'●'} ${phase} `,hint=' Alt+R';
  const room=Math.max(0,max-visibleWidth(prefix)-visibleWidth(overflow)-visibleWidth(hint));
  const identity=agentIdentityRows(n,room,twoLines);
  const color=stackRoleColor(nodeIdentity(id,n).role);
  agents.push(fg(color,prefix+identity.lines[0]+(!twoLines?overflow+(identity.clipped||overflow?hint:''):'')));
  if(twoLines)agents.push(fg('muted',' '.repeat(visibleWidth(prefix))+identity.lines[1]+overflow+(identity.clipped||overflow?hint:'')));
  displayed++;
 }
 if(displayed<live.length&&agents.length<agentBudget)agents.push(fg('dim',`… 另 ${live.length-displayed} 成员 · Alt+R`));
 // Parent activity and telemetry use only rows left after child identities.
 if(input.parent?.active&&agents.length<agentBudget)agents.push(fit([seg(fg('accent',input.parent.sessionId?`▸ ● @main:${safeText(input.parent.sessionId).slice(0,8)} · 运行中`:'主会话处理中'),90),...(input.parent.tool?[seg(fg('accent',safeText(input.parent.tool)),80,true)]:[])],max));
 if(agents.length<agentBudget&&live.length){const {n}=live[0],p=n.observation?.progress,u=n.observation?.usage;const parts:Segment[]=[];
  if(p?.currentTool||p?.lastTool)parts.push(seg(fg('accent',`${p.currentTool?'工具':'最近工具'}:${safeText(p.currentTool??p.lastTool)}`),80,true));
  if(p?.toolCount!==undefined)parts.push(seg(fg('muted',`${p.toolCount} 次工具调用`),70));
  if(n.observation?.durationMs!==undefined)parts.push(seg(fg('muted',`已观测${Math.floor(n.observation.durationMs/1000)}s`),60));
  if(u?.cacheReadTokens!==undefined||u?.cacheWriteTokens!==undefined)parts.push(seg(fg('muted',`缓存 ${u.cacheReadTokens!==undefined?metric(u.cacheReadTokens)+'读':''}${u.cacheReadTokens!==undefined&&u.cacheWriteTokens!==undefined?'/':''}${u.cacheWriteTokens!==undefined?metric(u.cacheWriteTokens)+'写':''}`),50));
  if(u?.inputTokens!==undefined)parts.push(seg(fg('muted',`入 ${metric(u.inputTokens)}`),40));if(u?.outputTokens!==undefined)parts.push(seg(fg('muted',`出 ${metric(u.outputTokens)}`),30));
  if(parts.length)agents.push(fit(parts,max));
 }
 // Historical problems remain reachable without adding permanent header rows.
 const others=input.snapshots.filter(s=>s!==focus);if(input.expanded&&others.length&&todo.length<todoBudget)todo.push(fit([seg(fg("dim",`其他记录${others.length}/待处理图${others.filter(s=>graphIssues(s)>0).length} · /graphs history`),80,true)],max));
 return {todo:todo.slice(0,todoBudget).map(l=>truncateToWidth(l,max)),agents:agents.slice(0,agentBudget).map(l=>truncateToWidth(l,max))};
}
