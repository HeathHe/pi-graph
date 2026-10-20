import {buildTodoTree} from './todo-tree.ts';
import {truncateToWidth,visibleWidth,wrapTextWithAnsi} from "@earendil-works/pi-tui";
import type {GraphSnapshotV3,V3NodeProjection,GraphWhenV3} from "../types.ts";
import type {TodoView} from "./todo.ts";
import {cockpitFocus,graphIssues,liveAgent} from "./cockpit.ts";
import {displayPhase,displayEvidence,nodeIdentity,nodeReason,orderedNodes,phaseLabel,safeText,readableNodeTitle,readableRole,agentIdentityRows,supervisionWarning} from "./presentation.ts";
// strikethrough stays in the theme contract for other surfaces, but completed todo titles are never struck through (approved design: finished rows stay readable in place).
export interface StackTheme {fg(color:any,text:string):string;bold?(text:string):string;strikethrough?(text:string):string;bg?(color:any,text:string):string}
export interface ParentActivity {active:boolean;tool?:string;sessionId?:string}
export interface StackInput {snapshots:readonly GraphSnapshotV3[];identitySnapshots?:readonly GraphSnapshotV3[];plan:TodoView;expanded:boolean;foldedIds?:ReadonlySet<string>;recentCompletedIds?:readonly string[];expandedCompletedGroupIds?:ReadonlySet<string>;preferred?:string;parent?:ParentActivity;reservedRows?:number;sessionId?:string}
interface Segment {text:string;priority:number;clip?:boolean}
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
export interface StackTask {group?:boolean;depth?:number;number?:string;label?:string;tone?:string;tail?:string;failedNumbers?:string[];phase?:string;manualBlocked?:boolean;reference?:{graphId:string;runInstanceId:string};id:string;title:string;status:string;assignees:string[];dependencies:Array<{id?:string;graphId?:string;runInstanceId?:string;planId?:string;number?:string;targetId?:string;title:string;status:string}>;reason?:string;critical?:boolean;source:string;identities?:Array<{node:V3NodeProjection;taskId:string;phase?:string;project?:string}>;identityMissing?:boolean;waiting?:boolean;when?:GraphWhenV3&{graphId:string;runInstanceId:string;taskId:string};hasError?:boolean}
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
 const nodeTask=(s:GraphSnapshotV3,id:string,n:V3NodeProjection):StackTask=>({id,phase:displayPhase(s,id,n),reference:{graphId:s.graphId,runInstanceId:s.runInstanceId},title:readableNodeTitle(s,id,n),status:normalize(displayPhase(s,id,n)),assignees:[nodeIdentity(id,n).role].filter(Boolean),identities:[{node:n,taskId:id,phase:displayPhase(s,id,n),project:displayEvidence(s)?.project}],dependencies:(n.dependsOn??[]).map(dep=>({id:dep,graphId:s.graphId,runInstanceId:s.runInstanceId,title:s.nodes?.[dep]?readableNodeTitle(s,dep,s.nodes[dep]):'前置任务（目标待补充）',status:s.nodes?.[dep]?normalize(displayPhase(s,dep,s.nodes[dep])):'unknown'})),when:(()=>{const w=displayEvidence(s)?.conditions?.[id];return w?{...w,graphId:s.graphId,runInstanceId:s.runInstanceId,taskId:id}:undefined;})(),critical:['failed','needs_attention','exit_unreconciled','exit_unverified','blocked'].includes(displayPhase(s,id,n))||!!n.observation?.supervision?.attention||!!n.observation?.supervision?.error||!!supervisionWarning(n),reason:inactiveLabels[displayPhase(s,id,n)]??(['failed','needs_attention','exit_unreconciled','exit_unverified','blocked'].includes(displayPhase(s,id,n))?`${phaseLabel(n,s,id)}：${nodeReason(s,id,n)}`:undefined),source:'Graph验收'});
 if(!input.plan.items.length)return decorateTasks(focus?Object.entries(focus.nodes??{}).map(([id,n])=>nodeTask(focus,id,n)):[],false);
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
 const tree=buildTodoTree(input.plan.items),hierarchical=tree.groupIds.size>0;
 const leaves=decorateTasks(input.plan.items.filter(item=>!tree.groupIds.has(item.id)).map(item=>{
  const refs=refsById.get(item.id)??[];
  const deps:StackTask["dependencies"]=[...(item.dependsOn??[]).map(id=>{const dep=input.plan.items.find(i=>i.id===id);return {id,planId:id,title:dep?safeText(dep.title):id,status:dep?normalize(dep.derivedStatus):'unknown'};}),...refs.flatMap(r=>r.dependencies).map(dep=>{const matches=input.plan.items.filter(candidate=>candidate.links.some(link=>link.graphId===dep.graphId&&link.runInstanceId===dep.runInstanceId&&link.taskId===dep.id));return matches.length===1?{...dep,planId:matches[0].id,title:safeText(matches[0].title)}:dep;})];
  // A plan edge and a Graph edge naming the same target merge into the precisely bound Graph edge; a bare plan id never carries condition identity.
 const depKey=(d:StackTask["dependencies"][number])=>d.planId??`${d.graphId}/${d.runInstanceId}/${d.id}`;
 const dependencies=[...deps.reduce((map,d)=>{const key=depKey(d),existing=map.get(key);if(!existing||(!existing.graphId&&d.graphId))map.set(key,d);return map;},new Map<string,StackTask["dependencies"][number]>()).values()];
  const waiting=normalWait(item.id);
  // A reliably identified, uniformly inactive linked phase (skipped/cancelled/not_started) is the actual result and outranks a plan-level blocked derivation. Manual blocks, mixed linked phases and missing identities stay conservative.
  const actualInactive=item.status!=='blocked'&&refs.length>0&&refs.length===item.links.length&&refs.every(r=>!!inactiveLabels[r.status])&&new Set(refs.map(r=>r.status)).size===1?refs[0].status:undefined;
  return {id:item.id,...(hierarchical?{number:'#'+tree.numberById.get(item.id),depth:tree.depthById.get(item.id)}:{}),manualBlocked:item.status==='blocked',title:safeText(item.title),status:actualInactive??normalize(item.derivedStatus),when:refs.length===1&&item.links.length===1?refs[0].when:undefined,reference:refs.length===1&&item.links.length===1?refs[0].reference:undefined,assignees:[...new Set([...(item.assignee?[item.assignee]:[]),...refs.flatMap(r=>r.assignees)])],identities:refs.flatMap(r=>r.identities??[]),identityMissing:refs.length!==item.links.length,dependencies,waiting,critical:refs.some(r=>r.critical)||item.derivedStatus==='unknown',reason:waiting?undefined:item.reason??refs.find(r=>r.reason)?.reason,source:item.source};
 }),true);
 if(!hierarchical)return leaves;
 const leafById=new Map(leaves.map(t=>[t.id,t]));
 return tree.preorder.map(id=>{
  if(!tree.groupIds.has(id))return leafById.get(id)!;
  const item=tree.byId.get(id)!,children=tree.descendantLeafIds(id).map(key=>leafById.get(key)!);
  // Group progress is a rollup of descendant leaves only; the group itself is never counted as a task.
  // Doubt (completed but unverified) is a real exception signal and must feed the group state too.
  const stats=leafStatusStats(children),issues=stats.failed+stats.attention+stats.doubt;
  return {id,title:safeText(item.title),number:'#'+tree.numberById.get(id),depth:tree.depthById.get(id),group:true,status:stats.done===children.length?'completed':stats.running?'in_progress':'pending',assignees:[],dependencies:[],source:'分组汇总',label:formatLeafStats(stats),tone:issues?'warning':stats.done===children.length?'success':stats.running?'accent':'muted',critical:issues>0,hasError:children.some(t=>t.hasError||t.tone==='error'),tail:issues?'组内有待处理任务 · Alt+Shift+T':undefined};
 });
}
/** Display-only numbering and causal state; the original plan and Graph remain untouched. */
function decorateTasks(tasks:StackTask[],hasPlan:boolean):StackTask[]{
 const byId=new Map(tasks.map(t=>[t.id,t]));
 for(const [index,t]of tasks.entries())t.number??=`#${String(index+1).padStart(2,'0')}`;
 for(const t of tasks)for(const dep of t.dependencies){
  const target=dep.planId?byId.get(dep.planId):!hasPlan&&t.reference?.graphId===dep.graphId&&t.reference?.runInstanceId===dep.runInstanceId?byId.get(dep.id??''):undefined;
  if(target){dep.number=target.number;dep.targetId=target.id;}
 }
 const visiting=new Set<string>(),done=new Set<string>(),cycles=new Set<string>(),path:string[]=[];
 const classify=(t:StackTask):void=>{
  if(done.has(t.id))return;
  if(visiting.has(t.id)){for(const id of path.slice(path.indexOf(t.id)))cycles.add(id);return;}
  visiting.add(t.id);path.push(t.id);
  const nodes=(t.identities??[]).map(i=>i.node),phases=[t.phase,...(t.identities??[]).map(i=>i.phase)];
  const failed=phases.includes('failed'),user=phases.includes('waiting_user')||nodes.some(n=>n.observation?.supervision?.attention==='waiting_user');
  const uncertain=t.identityMissing||t.manualBlocked||phases.some(p=>['unknown','needs_attention','exit_unreconciled','exit_unverified','aborted',...(!inactiveLabels[t.status]?['cancelled','skipped','not_started']:[])].includes(p??''))||nodes.some(n=>!!supervisionWarning(n)||!!n.observation?.supervision?.error||!!n.observation?.supervision?.attention);
  for(const edge of t.dependencies){const dep=edge.targetId?byId.get(edge.targetId):undefined;if(dep)classify(dep);}
  // A display-authorized when:failed condition satisfied by a verified failure is not treated as an ordinary accepted-dependency edge; full dependency detail stays in t.dependencies. An actual blocked/skipped phase remains the authoritative result.
  const authoritativeInactive=phases.some(p=>p==='blocked'||p==='skipped');
  const conditionSatisfied=(d:StackTask["dependencies"][number]):boolean=>{
   const w=t.when;
   if(!w||w.status!=='failed'||authoritativeInactive||t.manualBlocked||t.identityMissing)return false;
   // The dependency edge must be the exact conditioned Graph edge (same graph/run, same target node); a bare taskId is never matched across the plan.
   if(d.graphId!==w.graphId||d.runInstanceId!==w.runInstanceId||d.id!==w.node)return false;
   const target=d.targetId?byId.get(d.targetId):undefined;
   if(!target||target.tone!=='error'||!target.failedNumbers?.length)return false;
   // The verified failure must be exactly the conditioned node in the same graph/run; multi-identity targets stay conservative.
   const ids=target.identities??[];
   return ids.length===1&&ids[0].taskId===w.node&&target.reference?.graphId===w.graphId&&target.reference?.runInstanceId===w.runInstanceId;
  };
  const pending=t.dependencies.filter(d=>!conditionSatisfied(d)).filter(d=>d.status!=='completed'||(d.targetId&&['error','warning'].includes(byId.get(d.targetId)?.tone??'')));
  const deps=pending.map(d=>d.targetId?byId.get(d.targetId):undefined);
  if(failed){t.label='失败';t.tone='error';t.failedNumbers=[t.number!];t.tail=t.reason?.replace(/^失败[：:]\s*/u,'')||'请查看失败详情 · Alt+R';}
  else if(cycles.has(t.id)){t.label='待处理';t.tone='warning';t.tail='依赖循环，待核实'+(user?'；待主 Agent 决策':'')+' · Alt+R';}
  else if(user){const realIssue=nodes.map(n=>supervisionWarning(n)).find(w=>!!w&&w!=='待主 Agent 决策');t.hasError=!!realIssue;t.label='待主 Agent 决策';t.tone='warning';t.tail=realIssue?`待主 Agent 决策；${realIssue} · Alt+R`:'待主 Agent 决策 · Alt+R';}
  else if(uncertain){t.label=t.status==='completed'?'已完成 · 待核实':t.status==='in_progress'?'执行中 · 需核实':'待处理';t.tone='warning';t.tail=t.identityMissing?'关联身份待核实 · Alt+R':nodes.map(n=>supervisionWarning(n)).find(Boolean)||(!t.reason?.startsWith('计划前置项未完成：')&&!Object.values(inactiveLabels).includes(t.reason??'')?t.reason:undefined)||'状态待核实 · Alt+R';}
  else if(t.status==='completed'){t.label=t.source==='人工'?'已完成 · 人工':'已完成';t.tone='success';}
  else if(inactiveLabels[t.status]){t.label=inactiveLabels[t.status];t.tone='muted';}
  else if(t.status==='in_progress'){t.label='执行中';t.tone='accent';}
  else if(deps.some(d=>d?.failedNumbers?.length)){
   const uncertainDependency=deps.some(d=>!d||d.tone==='warning'),failedNums=[...new Set(deps.flatMap(d=>d?.failedNumbers??[]))];
   if(authoritativeInactive){t.label='未执行';t.tone=uncertainDependency?'warning':'muted';t.failedNumbers=failedNums;t.tail=`受阻于 ${failedNums.join('、')} · 未执行`+(uncertainDependency?'；另有依赖待核实 · Alt+R':'');}
   // Without an authorized satisfied condition or an authoritative blocked/skipped phase, a failed dependency alone never proves this queued branch did not or will not run.
   else{t.label='待处理';t.tone='warning';t.tail=`前置 ${failedNums.join('、')} 失败 · 执行条件待核实 · Alt+R`;}
  }
  else if(pending.length&&deps.some(d=>!d)||t.tail?.startsWith('依赖循环')){t.label='待处理';t.tone='warning';t.tail=t.tail?.startsWith('依赖循环')?t.tail:'依赖关联待核实 · Alt+R';}
  else if(deps.some(d=>d?.tone==='warning'&&!(d.label==='待主 Agent 决策'&&!d.hasError))){t.label='待处理';t.tone='warning';t.tail='前置任务待核实 · Alt+R';}
  else if(pending.length&&deps.every(d=>!!d&&(['执行中','等待','就绪'].includes(d.label??'')||(d.label==='待主 Agent 决策'&&!d.hasError)))){t.label='等待';t.tone='muted';t.waiting=true;t.tail=`等待 ${pending.map(d=>d.number).join('、')} 完成`;}
  // Display-only release: a plan-level "prerequisite incomplete" derivation whose every dependency is now satisfied — including an authorized, exactly bound when:failed branch — reads as ready. Manual blocks, missing identities, mixed links and authoritative blocked/skipped phases never reach here; the plan and Graph stay untouched.
  else if(t.status==='blocked'&&!authoritativeInactive&&!t.manualBlocked&&!pending.length&&t.reason?.startsWith('计划前置项未完成：')){t.label='就绪';t.tone='muted';t.tail='等待调度';}
  else if(t.status==='blocked'||pending.length){t.label='待处理';t.tone='warning';t.tail='依赖状态待核实 · Alt+R';}
  else{t.label='就绪';t.tone='muted';t.tail='等待调度';}
  if(t.tone==='warning'||t.tone==='error')t.critical=true;
  path.pop();visiting.delete(t.id);done.add(t.id);
 };
 for(const t of tasks)classify(t);
 return tasks;
}
/** Agent leads, then the model; identity pairs are never cross-joined. Only observed actualModel is shown as actual; requested/resolved models stay explicitly planned, and an active node without actualModel is reported as unobserved. The bound project comes from display evidence (authorization sourceCwd) and is honestly unbound when absent. */
export function todoIdentity(t:StackTask,width:number):string {
 if(t.identityMissing)return truncateToWidth('关联身份待核实 · Alt+R',width,'…');
 const activePhases=['prepared','dispatched','running','verifying','applying','in_progress'];
 const pairs=(t.identities??[]).map(({node,phase,project})=>{
  const role=nodeIdentity('',node).role,actual=safeText(node.observation?.actualModel);
  const planned=safeText(node.observation?.resolvedModel)||safeText(node.observation?.requestedModel);
  const agent=role?(node.observation?.actualAgent?'@':'分配@')+role:'Agent待上报';
  const model=actual||(activePhases.includes(phase??'')?'实际模型未观测':planned?`〔计划〕${planned}`:'模型待上报');
  const bound=safeText(project);
  return {key:`${bound} ${agent} ${model}`,project:bound?`项目 ${bound}`:'项目 未绑定',agent,model,short:actual?actual.split('/').at(-1)!:model};
 });
 const unique=pairs.filter((p,i)=>pairs.findIndex(q=>q.key===p.key)===i);if(!unique.length)return '';
 // A project shared by every identity reads once as the row prefix; mixed bindings keep their own project per pair.
 // Width pressure yields the project prefix first, then the provider half of a model id; Agent and model keep a recognizable share.
 const sameProject=unique.every(p=>p.project===unique[0].project),headOptions=sameProject?[unique[0].project+' · ','']:[''];
 const pairText=(p:typeof unique[number],withProject:boolean)=>`${withProject&&!sameProject?p.project+' · ':''}${p.agent} · ${p.model}`;
 for(const head of headOptions){
  const rendered:string[]=[];let out:string|undefined,retry=false;
  for(const [i,pair]of unique.entries()){
   const remaining=unique.length-i-1,suffix=remaining?` +${remaining} Alt+R`:'';
   const options=[pairText(pair,true)];
   // A shortened model id (provider dropped) still keeps both Agent and model recognizable.
   if(pair.short!==pair.model)options.push(pairText({...pair,model:pair.short},true));
   options.push(pairText(pair,false));
   if(pair.short!==pair.model)options.push(pairText({...pair,model:pair.short},false));
   const body=options.find(candidate=>visibleWidth(head+[...rendered,candidate].join(' · ')+suffix)<=width);
   if(body){rendered.push(body);continue;}
   // A bare narrow share is the last resort; retry without the project prefix first.
   if(!rendered.length&&head!==headOptions[headOptions.length-1]){retry=true;break;}
   if(rendered.length)out=head+rendered.join(' · ')+` +${unique.length-rendered.length} Alt+R`;
   else{
    const room=Math.max(0,width-visibleWidth(suffix)),agentWidth=Math.min(visibleWidth(pair.agent),Math.max(8,Math.floor(room*.45))),modelWidth=Math.max(0,room-agentWidth-3);
    const modelText=pair.short!==pair.model&&visibleWidth(pair.short)<=modelWidth?pair.short:pair.model;
    out=truncateToWidth(pair.agent,agentWidth,'…')+' · '+truncateToWidth(modelText,modelWidth,'…')+suffix;
   }
   break;
  }
  if(retry)continue;
  if(out===undefined)out=head+rendered.join(' · ');
  if(visibleWidth(out)<=width)return out;
 }
 return truncateToWidth(unique.map(p=>pairText(p,false)).join(' · '),Math.max(0,width),'…');
}

export function safelyCompletedTask(t:StackTask):boolean{return !t.group&&t.status==='completed'&&!t.critical&&!t.identityMissing&&!['warning','error'].includes(t.tone??'')&&(t.identities??[]).every(i=>i.phase==='accepted');}
/** Mutually exclusive leaf buckets; done/failed/attention/running/waiting/ready/inactive/todo always sum to total. skipped/cancelled/not_started (and blocked-not-executed) leaves are their own terminal 未执行 bucket, never 待办 — even when an uncertain dependency keeps such a leaf at warning tone, it counts once in inactive and never again as attention. doubt is a subset annotation of the done and inactive buckets only (a completed-with-doubt leaf, or an inactive/未执行 leaf still carrying a real warning): it overlaps those buckets, is never an extra task, and must never be added into — or subtracted from — a mutually exclusive total. */
export interface LeafStatusStats {total:number;done:number;failed:number;attention:number;running:number;waiting:number;ready:number;inactive:number;todo:number;doubt:number}
export function leafStatusStats(leaves:readonly StackTask[]):LeafStatusStats{
 const stats:LeafStatusStats={total:leaves.length,done:0,failed:0,attention:0,running:0,waiting:0,ready:0,inactive:0,todo:0,doubt:0};
 const inactiveLabelList=Object.values(inactiveLabels);
 for(const t of leaves){
  if(t.status==='completed'){stats.done++;if(t.critical||t.tone==='warning'||t.tone==='error')stats.doubt++;continue;}
  if(t.tone==='error'){stats.failed++;continue;}
  // The truthful terminal label wins over the warning tone: a 未执行/inactive leaf whose dependency is
  // uncertain stays in the inactive bucket; its warning survives only as the doubt subset annotation.
  if(t.label==='未执行'||!!t.label&&inactiveLabelList.includes(t.label)){stats.inactive++;if(t.critical||t.tone==='warning'||t.tone==='error')stats.doubt++;continue;}
  if(t.tone==='warning'){stats.attention++;continue;}
  if(t.label==='执行中'){stats.running++;continue;}
  if(t.label==='等待'){stats.waiting++;continue;}
  if(t.label==='就绪'){stats.ready++;continue;}
  stats.todo++;
 }
 return stats;
}
/** Exceptions (失败/待处理/其中待核实) lead the count string right after the progress anchor so a narrow row never loses them to right-side truncation. compact shortens only the waiting label (等待依赖→等待); every bucket stays explicit. */
export function formatLeafStats(stats:LeafStatusStats,compact=false):string{
 return [`已完成 ${stats.done}/${stats.total}`,
  stats.failed?`失败 ${stats.failed}`:'',stats.attention?`待处理 ${stats.attention}`:'',stats.doubt?`其中待核实 ${stats.doubt}`:'',
  stats.running?`执行中 ${stats.running}`:'',stats.waiting?(compact?`等待 ${stats.waiting}`:`等待依赖 ${stats.waiting}`):'',stats.ready?`就绪 ${stats.ready}`:'',
  stats.inactive?`未执行 ${stats.inactive}`:'',stats.todo?`待办 ${stats.todo}`:''].filter(Boolean).join(' · ');
}
const metric=(value:number)=>value<100?String(value):`${(value/(value<999950?1000:1000000)).toFixed(1).replace(/\.0$/,"")}${value<999950?"k":"m"}`;
export function stackRoleColor(role:string):string{const name=role.toLowerCase();if(name.includes("backend"))return "syntaxVariable";if(name.includes("general"))return "syntaxString";if(name.includes("qa")||name.includes("review"))return "syntaxKeyword";const palette=["syntaxFunction","syntaxType","syntaxString","syntaxVariable","syntaxKeyword","mdLink"];let hash=5381;for(const char of role)hash=(hash*33+char.codePointAt(0)!)>>>0;return palette[hash%palette.length];}
/** Legacy exported reading width; layout now uses the full available terminal width. */
export const TODO_READING_CAP=118;
export function terminalStack(input:StackInput,width:number,height:number,theme:StackTheme):{todo:string[];agents:string[]}{
 const max=Math.max(0,width-1),total=Math.max(0,Math.min(input.expanded?24:8,height-(input.reservedRows??6)));
 if(!total)return {todo:[],agents:[]};
 const allTasks=stackTasks(input),tree=input.plan.items.length?buildTodoTree(input.plan.items):undefined;
 const byId=new Map(allTasks.map(t=>[t.id,t])),leaves=allTasks.filter(t=>!t.group);
 // Completed leaves stay in place; only explicit group folding hides rows, and folding never changes numbering or counts.
 const folded=input.foldedIds??new Set<string>();
 const tasks=allTasks.filter(t=>!tree?.ancestorIds(t.id).some(id=>folded.has(id))),focus=cockpitFocus(input.snapshots,input.preferred);
 const live=input.snapshots.flatMap(s=>orderedNodes(s).filter(([,n])=>liveAgent(n)).map(([id,n])=>({s,id,n}))).sort((a,b)=>Number(b.s===focus)-Number(a.s===focus));
 const hasTodo=tasks.length>0||!!input.plan.error;
 const minimumTodo=hasTodo?1:0;
 // Collapsed first guarantees the overview, two tasks with two identity rows and a more entry (6 rows); duplicate agent trees and telemetry share only what remains.
 const guaranteedTodo=hasTodo?(input.expanded?minimumTodo:Math.min(6,total)):0;
 const desiredAgentRows=live.length*(width<70?2:1)+Number(!!input.parent?.active)+1;
 const reservedAgents=live.length?Math.min(Math.max(0,total-guaranteedTodo),Math.max(1,Math.min(desiredAgentRows,Math.floor(total/2)))):input.parent?.active?Math.min(1,Math.max(0,total-minimumTodo)):0;
 const todoBudget=hasTodo?(input.expanded?total-reservedAgents:Math.max(1,Math.min(6,total-reservedAgents))):0;
 const agentBudget=total-todoBudget,todo:string[]=[],agents:string[]=[];
 const fg=(color:string,text:string)=>theme.fg(color,text),seg=(text:string,priority:number,clip=false):Segment=>({text,priority,clip});
 const priority=(t:StackTask)=>t.tone==='error'?0:t.tone==='warning'?1:t.label==='执行中'?2:t.label==='等待'?3:t.label==='未执行'?4:t.status==='completed'?6:5;
 const ordered=tasks.map((t,index)=>({t,index})).sort((a,b)=>priority(a.t)-priority(b.t)||Number(!!a.t.group)-Number(!!b.t.group)||a.index-b.index);
 // A real exception (a failure or a decision request carrying a supervision error) always keeps an identifiable 异常 marker and a detail entry, even in a single cramped row.
 const exceptionSummary=(t:StackTask):string|undefined=>{
  if(t.tone!=='error'&&!t.hasError)return undefined;
  const raw=safeText(t.tail??'').replace(/\s*· Alt\+R\s*$/u,'').replace(/^待主 Agent 决策；/u,'').trim();
  return raw&&raw!=='待主 Agent 决策'?raw:undefined;
 };
 // Tree lines follow the plan hierarchy: one continuation segment per ancestor with later siblings,
 // then a real ├─/└─ connector for the current row, so the last sibling properly ends the branch.
 // Metadata/cause rows continue the same ancestor bars plus a bar (or blank) for the current level.
 // Narrow terminals compress the oldest segments behind an ellipsis; number and status are never compressed away.
 const lastSibling=(id:string):boolean=>{
  const parent=tree!.parentById.get(id),siblings=parent?tree!.childrenById.get(parent)??[]:tree!.roots;
  return siblings.indexOf(id)===siblings.length-1;
 };
 const treeLines=(t:StackTask,reserved=0):{prefix:string;indent:string}=>{
  if(!tree||t.depth===undefined)return {prefix:'  ',indent:'    '};
  const levels=tree.ancestorIds(t.id).map(ancestor=>lastSibling(ancestor)?'  ':'│ ');
  if(!levels.length)return {prefix:'  ',indent:'    '};
  const connector=lastSibling(t.id)?'└─ ':'├─ ',continuation=lastSibling(t.id)?'  ':'│ ';
  const cap=Math.max(3,Math.min(Math.max(6,Math.floor(max/4)),max-reserved));
  let prefix='  '+levels.join('')+connector;
  if(visibleWidth(prefix)>cap){
   const kept:string[]=[];let room=cap-visibleWidth('  …'+connector);
   for(let i=levels.length-1;i>=0;i--){if(room<2)break;kept.unshift(levels[i]);room-=2;}
   prefix='  …'+kept.join('')+connector;
   if(visibleWidth(prefix)>cap)prefix=connector;
  }
  const indent=(prefix.endsWith(connector)?prefix.slice(0,prefix.length-connector.length):prefix)+continuation+' ';
  return {prefix,indent};
 };
 const statusColor=(t:StackTask)=>t.tone==='error'?'error':t.tone==='warning'?'warning':t.tone==='success'?'success':t.tone==='accent'?'accent':'muted';
 // Executing leaf rows get a shallow theme background (customMessageBg), padded to the available width.
 // Selection/focus styling (selectedBg) belongs to inspectors and is never used here, so focus and execution cannot be confused.
 const paintExecuting=(t:StackTask,line:string):string=>{
  if(!theme.bg||t.group||t.label!=='执行中')return line;
  return theme.bg('customMessageBg',line+' '.repeat(Math.max(0,max-visibleWidth(line))));
 };
 const reasonRow=(t:StackTask):string|undefined=>{
  const tail=t.tail?.trim();
  if(t.tone==='error'||t.tone==='warning'){
   if(!tail||tail==='待主 Agent 决策 · Alt+R')return undefined;
   return t.hasError?`异常：${tail.replace(/^待主 Agent 决策；/u,'')}`:tail;
  }
  if(t.waiting&&tail?.startsWith('等待 #'))return tail;
  if(t.failedNumbers?.length&&tail?.startsWith('受阻于 #'))return tail;
  return undefined;
 };
 // Keep tree/number/status/title on the left. Observed identity anchors to the available right edge.
 // If both do not fit, finish every title continuation before the separate identity row.
 const taskRows=(t:StackTask,allowReason:boolean):string[]=>{
  const marker=t.group?(folded.has(t.id)?'▸ ':'▾ '):'',label=t.label??'',color=statusColor(t),number=t.number?`${t.number} `:'';
  const {prefix,indent:treeIndent}=treeLines(t,visibleWidth(marker+number)+(t.group?0:visibleWidth(label)+1)+2);
  // Completed titles keep the plain typeface per the approved design: a finished row is shown in place, never struck through.
  const title=t.label==='执行中'?(theme.bold?.(t.title)??t.title):t.title;
  const lead=prefix+marker+number+(t.group?'':label?label+' ':''),groupTail=t.group&&label?label:'';
  // The title keeps its share on group rows; the aggregate stats label truncates first.
  const titleRoom=Math.max(1,max-visibleWidth(lead)),wrapped=titleRoom>=4?wrapTextWithAnsi(title,titleRoom):[truncateToWidth(title,titleRoom,'…')],shown=wrapped[0]??'';
  let main=fg('dim',prefix+marker)+fg(color,number)+(t.group?'':fg(color,label)+' ')+shown;
  if(groupTail){const roomLeft=max-visibleWidth(prefix+marker+number+shown)-1;if(roomLeft>=4)main+=' '+fg('muted',truncateToWidth(groupTail,roomLeft,'…'));}
  const lines=[paintExecuting(t,main)];
  const rawIndent=treeIndent+' '.repeat(visibleWidth(marker));
  const indent=visibleWidth(rawIndent)>Math.max(0,max-4)?truncateToWidth(rawIndent,Math.max(0,max-4),'…'):rawIndent;
  for(const extra of wrapped.slice(1))lines.push(' '.repeat(Math.min(max-1,visibleWidth(lead)))+extra);
  const identity=todoIdentity(t,Math.max(0,max-visibleWidth(indent)))||t.assignees.map(r=>'分配@'+r).join(' · ');
  if(identity){
   if(wrapped.length===1&&visibleWidth(main)+1+visibleWidth(identity)<=max)lines[0]=paintExecuting(t,main+' '.repeat(max-visibleWidth(main)-visibleWidth(identity))+fg('muted',identity));
   else lines.push(paintExecuting(t,indent+' '.repeat(Math.max(0,max-visibleWidth(indent)-visibleWidth(identity)))+fg('muted',identity)));
  }
  // Groups never carry their own cause row: leaf causes are on the leaf rows, and a folded group gets the summary below.
  const reason=allowReason&&!t.group?reasonRow(t):undefined;
  if(reason)lines.push(indent+fg(t.tone==='error'?'error':t.tone==='warning'?'warning':'muted',truncateToWidth(safeText(reason),Math.max(0,max-visibleWidth(indent)),'…')));
  // A manually folded group keeps a visible summary of hidden exceptions; folding never renumbers.
  // Only real exceptions (error/warning tone or critical doubt) are listed — healthy running work stays in the rollup counts and is never flagged ⚠.
  if(t.group&&folded.has(t.id)&&tree){
   const hidden=tree.descendantLeafIds(t.id).map(id=>byId.get(id)).filter((x):x is StackTask=>!!x);
   const notable=hidden.filter(x=>x.tone==='error'||x.tone==='warning'||x.critical).sort((a,b)=>(a.tone==='error'?0:1)-(b.tone==='error'?0:1));
   if(notable.length){
    const first=notable[0],summary=`⚠ ${first.number} ${first.title}${first.label?` · ${first.label}`:''}${notable.length>1?` · 等 ${notable.length} 项需关注`:''} · 组内 ${hidden.length} 项已折叠 · Alt+Shift+T 详情`;
    lines.push(indent+fg(notable.some(x=>x.tone==='error')?'error':'warning',truncateToWidth(summary,Math.max(0,max-visibleWidth(indent)),'…')));
   }
  }
  return lines;
 };
 const compactTask=(t:StackTask,suffix?:string):string=>{
  const head=`${treeLines(t,visibleWidth(`${t.number} ${t.label} `)+4).prefix}${t.group?(folded.has(t.id)?'▸ ':'▾ '):''}${t.number} ${t.label} `,exception=exceptionSummary(t);
  if(exception){
   const lead='异常：',entry=suffix??'Alt+R';
   let room=max-visibleWidth(head)-visibleWidth(lead)-visibleWidth(entry)-2;
   if(room>=8){
    const summary=truncateToWidth(exception,room,'…'),rest=max-visibleWidth(head)-visibleWidth(lead)-visibleWidth(summary)-visibleWidth(entry)-3;
    return truncateToWidth(fg(t.tone??'muted',head)+lead+summary+(rest>=4?' '+truncateToWidth(t.title,rest,'…'):'')+' '+fg('muted',entry),max,'…');
   }
   // Extremely narrow: the head itself is clipped; the 异常 marker and Alt+R survive.
   room=max-visibleWidth(head)-visibleWidth(lead)-visibleWidth('Alt+R')-2;
   if(room>=0)return truncateToWidth(fg(t.tone??'muted',head)+lead+truncateToWidth(exception,room,'…')+' '+fg('muted','Alt+R'),max,'…');
   const headRoom=Math.max(4,max-visibleWidth(lead)-visibleWidth('Alt+R')-2);
   return truncateToWidth(fg(t.tone??'muted',truncateToWidth(`${t.number} ${t.label}`,headRoom,'…')+' ')+lead+fg('muted','Alt+R'),max,'…');
  }
  const tail=[t.tail?.startsWith('等待 #')||t.tail?.startsWith('受阻于 #')?t.tail:undefined,suffix].filter(Boolean).join(' · ');
  const titleWidth=Math.min(12,Math.max(4,Math.floor(max*.2))),hasIdentity=!!(t.identityMissing||t.identities?.length);
  const identity=hasIdentity?todoIdentity(t,Math.max(8,max-visibleWidth(head+tail)-titleWidth-2)):'';
  const room=Math.max(0,max-visibleWidth(head+tail+identity)-(identity?2:1));
  const left=fg(t.tone??'muted',head)+truncateToWidth(t.title,room,'…')+(tail?' '+fg('muted',tail):'');
  return truncateToWidth(left+(identity?' '.repeat(Math.max(1,max-visibleWidth(left)-visibleWidth(identity)))+identity:''),max,'…');
 };
 if(total===1&&hasTodo)return {todo:[input.plan.error?fg('warning',truncateToWidth(`待处理 · 待核实 ${safeText(input.plan.error)} · Alt+R`,max,'…')):compactTask(ordered[0].t,tasks.length>1?`另${tasks.length-1}项 · Alt+R`:undefined)],agents:[]};
 if(input.plan.error)todo.push(fg('warning',truncateToWidth(`Todo · 待处理 ${safeText(input.plan.error)} · Alt+T`,max,'…')));
 else if(tasks.length){
  // Mutually exclusive real leaf states; waiting/ready/exception/inactive are never lumped into failure.
  const stats=leafStatusStats(leaves),statsFull=formatLeafStats(stats),statsCompact=formatLeafStats(stats,true);
  const hintFull=input.expanded?'Alt+T 收起':'已收起 · Alt+T 展开',hintShort=input.expanded?'Alt+T 收起':'Alt+T 展开';
  // Width degradation ladder: full counts → short-label counts → aggregate. The aggregate is a pair of
  // ORTHOGONAL dimensions — 需关注 N (失败+待处理+其中待核实; doubt is a subset of done/inactive, so the
  // focus count may overlap the completion fraction and is never a mutually exclusive bucket) plus
  // 完成 done/total. There is no derived 其他 remainder, so the aggregate can never under-count or go
  // negative. A non-zero focus count leads so the guaranteed right-side cap can only trim the goal; the
  // focus count, the completion fraction and the Alt+T entry always keep a visible share. The hint sheds
  // its state prefix down to a bare Alt+T before any count form is sacrificed.
  const issues=stats.failed+stats.attention+stats.doubt;
  const statsAggregate=[...(issues?[`需关注 ${issues}`]:[]),`完成 ${stats.done}/${stats.total}`].join(' · ');
  const statsAggregateShort=[...(issues?[`关注${issues}`]:[]),`完${stats.done}/${stats.total}`].join(' ');
  const fits=(text:string,hint:string)=>visibleWidth(text)+visibleWidth(hint)+1<=max;
  let statsText=statsAggregateShort,hint='Alt+T';
  for(const candidate of [[statsFull,hintFull],[statsFull,hintShort],[statsCompact,hintFull],[statsCompact,hintShort],[statsAggregate,hintFull],[statsAggregate,hintShort],[statsAggregateShort,hintShort]] as const){
   if(fits(candidate[0],candidate[1])){statsText=candidate[0];hint=candidate[1];break;}
  }
  // The goal keeps only the room left after the counts and the hint; below a recognizable share it is
  // dropped entirely, so a long goal always yields before any count.
  const goalLabel=input.plan.items.length?(input.plan.goal?`总目标 · ${safeText(input.plan.goal)}`:'总计划'):'当前任务（未建总计划）';
  const goalRoom=Math.max(0,max-visibleWidth(hint)-visibleWidth(statsText)-4);
  const goalText=goalRoom>=8?truncateToWidth(goalLabel,goalRoom,'…'):'';
  const headText=(goalText?goalText+' · ':'')+statsText;
  const head=fg('syntaxFunction',truncateToWidth(headText,Math.max(0,max-visibleWidth(hint)-1),'…'));
  const overview=head+' '.repeat(Math.max(1,max-visibleWidth(head)-visibleWidth(hint)))+fg('dim',hint);
  const moreRow=(remaining:number)=>fg('dim',`  … 另 ${remaining} 项 · ${input.expanded?'Alt+Shift+T':'Alt+T 展开'}`);
  if(input.expanded){
   const header=todoBudget>=4?[overview]:[],available=todoBudget-header.length;
   const full=tasks.flatMap(t=>taskRows(t,true));
   if(full.length<=available)todo.push(...header,...full);
   else{
    // Keep structural preorder; select urgent leaves and their ancestors before filling spare rows.
    const selected=new Set<string>();let used=0;const capacity=Math.max(1,available-1);
    const add=(t:StackTask)=>{const path=[...(tree?.ancestorIds(t.id)??[]),t.id].filter(id=>tasks.some(v=>v.id===id)&&!selected.has(id));const cost=path.reduce((sum,id)=>{const row=byId.get(id)!;return sum+(!row.group&&(row.critical||row.label==='执行中')?taskRows(row,true).length:1);},0);if(used+cost>capacity){if(!selected.size&&!t.group&&capacity>0){selected.add(t.id);used++;}return;}for(const id of path)selected.add(id);used+=cost;};
    for(const t of [...tasks].sort((a,b)=>priority(a)-priority(b)))if(!t.group&&(t.critical||t.label==='执行中'||t.label==='待主 Agent 决策'))add(t);
    for(const t of tasks)add(t);
    todo.push(...header);let remaining=capacity-selected.size;
    for(const t of tasks.filter(v=>selected.has(v.id))){const rows=taskRows(t,true);if(remaining>=rows.length-1){todo.push(...rows);remaining-=rows.length-1;}else if(remaining>=1&&rows.length===2){todo.push(...rows);remaining--;}else todo.push(compactTask(t));}
    if(!selected.size&&tasks.length)todo.push(compactTask(ordered[0].t));
    const omitted=tasks.length-selected.size;if(omitted>0&&todo.length<todoBudget)todo.push(moreRow(omitted));
   }
  }else{
   // Collapsed: overview plus actually executing work; severe failures and main-Agent decision requests sort first and are never swallowed.
   // Failure > main-Agent decision > real warning > healthy running > waiting > blocked; a completed item with critical doubt is never filtered out.
   const collapsedPriority=(t:StackTask)=>t.tone==='error'?0:t.label==='待主 Agent 决策'?1:t.tone==='warning'?2:t.label==='执行中'?3:t.label==='等待'?4:t.label==='未执行'?5:6;
   const collapsedOrdered=tasks.map((t,index)=>({t,index})).sort((a,b)=>collapsedPriority(a.t)-collapsedPriority(b.t)||a.index-b.index).map(o=>o.t);
   const open=collapsedOrdered.filter(t=>t.status!=='completed'||t.critical),pool=(open.length?open:collapsedOrdered).slice(0,2);
   if(todoBudget>=4){
    todo.push(overview);
    let shown=0;
    for(const t of pool){
     const needMore=tasks.length-shown-1>0?1:0,available=todoBudget-todo.length,exception=!!exceptionSummary(t),rows=taskRows(t,exception);
     if(available-rows.length>=needMore){todo.push(...rows);shown++;}
     // A real exception keeps its reason row even at the cost of the more entry.
     else if(exception&&available>=rows.length){todo.push(...rows);shown++;}
     else if(available-1>=needMore){todo.push(compactTask(t));shown++;}
     else break;
    }
    if(shown<tasks.length&&todo.length<todoBudget)todo.push(moreRow(tasks.length-shown));
   }else if(todoBudget===3){
    todo.push(overview,compactTask(pool[0]));
    if(tasks.length>1)todo.push(moreRow(tasks.length-1));
   }else if(todoBudget===2){
    todo.push(compactTask(pool[0]));
    if(tasks.length>1)todo.push(moreRow(tasks.length-1));
   }else todo.push(compactTask(pool[0]));
  }
 }
 let displayed=0;
 for(const [index,{s,id,n}] of live.entries()){
  const remaining=agentBudget-agents.length;if(remaining<1)break;
  const others=live.length-index-1,twoLines=width<70&&remaining-Math.min(others,remaining-1)>=2;
  const consumed=twoLines?2:1,lastSlot=remaining===consumed,overflow=lastSlot&&others?` +${others}`:'';
  const waiting=displayPhase(s,id,n)==='waiting_user';
  const phase=phaseLabel(n,s,id),prefix=`${index===live.length-1?'└':'├'} ${waiting?'○':'●'} ${phase} `,hint=' Alt+R';
  const room=Math.max(0,max-visibleWidth(prefix)-visibleWidth(overflow)-visibleWidth(hint));
  const identity=agentIdentityRows(n,room,twoLines);
  const color=waiting||supervisionWarning(n)||n.observation?.supervision?.error?'warning':stackRoleColor(nodeIdentity(id,n).role);
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
