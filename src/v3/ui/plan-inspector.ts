import {buildTodoTree} from './todo-tree.ts';
import {todoIdentity,type StackTask} from './terminal-stack.ts';
import {matchesKey,truncateToWidth,visibleWidth,wrapTextWithAnsi} from "@earendil-works/pi-tui";
import {TodoReadSupersededError,type TodoView,type TodoLink} from "./todo.ts";
import type {CockpitTab} from "./cockpit.ts";
import {todoStateLabel} from "./cockpit.ts";
import {safeText,type GraphTheme} from "./presentation.ts";
export class PlanInspector {
 private history=false;private selectedId:string|undefined;private localFolded=new Set<string>();private detail=false;private scroll=0;private closed=false;private reading=false;private hideCompleted=false;private view:TodoView;private timer:ReturnType<typeof setInterval>;
 constructor(private options:{view:TodoView;theme:GraphTheme;rows:()=>number;requestRender:()=>void;close:()=>void;navigate:(tab:CockpitTab)=>void;openLink:(link:TodoLink)=>void;history:()=>void;read:()=>Promise<TodoView>;getFoldedIds?:()=>ReadonlySet<string>;toggleGroup?:(id:string)=>void;tasks?:()=>readonly StackTask[];selection?:{id?:string};getExpandedCompleted?:()=>ReadonlySet<string>;toggleCompleted?:(id:string)=>void;showPlan?:()=>Promise<TodoView>}){this.view=options.view;this.selectedId=options.selection?.id;this.timer=setInterval(()=>void this.refresh(),1500);this.timer.unref?.();}
 private rows(){const tree=buildTodoTree(this.view.items),folded=this.options.getFoldedIds?.()??this.localFolded;return tree.preorder.filter(id=>!tree.ancestorIds(id).some(parent=>folded.has(parent))).filter(id=>!this.hideCompleted||tree.groupIds.has(id)||tree.byId.get(id)!.derivedStatus!=='done').map(id=>tree.byId.get(id)!);}
 private select(){const rows=this.rows();if(!rows.some(i=>i.id===this.selectedId)){const tree=buildTodoTree(this.view.items),parent=this.selectedId&&tree.byId.has(this.selectedId)?[...tree.ancestorIds(this.selectedId)].reverse().find(id=>rows.some(i=>i.id===id)):undefined;this.selectedId=parent??rows[0]?.id;}if(this.options.selection)this.options.selection.id=this.selectedId;return rows.find(i=>i.id===this.selectedId);}
 private fold(id:string,collapsed?:boolean){const folded=this.options.getFoldedIds?.()??this.localFolded;if(collapsed!==undefined&&folded.has(id)===collapsed)return;if(this.options.toggleGroup)this.options.toggleGroup(id);else if(folded.has(id))this.localFolded.delete(id);else this.localFolded.add(id);this.select();this.options.requestRender();}
 async refresh(){if(this.closed||this.reading)return;this.reading=true;try{const next=await this.options.read();if(!this.closed){if(next.planId!==this.view.planId){this.localFolded.clear();this.selectedId=undefined;if(this.options.selection)delete this.options.selection.id;}this.view=next;this.select();this.options.requestRender();}}catch(e){if(e instanceof TodoReadSupersededError)return;if(!this.closed){this.view={...this.view,items:[],error:safeText(e instanceof Error?e.message:e),persistence:"unconfirmed"};this.options.requestRender();}}finally{this.reading=false;}}
 dispose(){this.closed=true;clearInterval(this.timer);}invalidate(){}
 handleInput(data:string){if(this.closed||data.includes("\x1b[200~"))return;if(data==="q"||matchesKey(data,"ctrl+c")){this.dispose();this.options.close();return;}if(matchesKey(data,"escape")){if(this.detail){this.detail=false;this.scroll=0;this.options.requestRender();}else{this.dispose();this.options.close();}return;}
 if(!this.detail&&(data==="t"||data==="a")){this.dispose();this.options.navigate(data==="t"?"tasks":"agents");return;}if(data==="g"){this.dispose();this.options.history();return;}if(data==="r"){void this.refresh();return;}
 if(!this.detail&&data==='h'){this.history=!this.history;this.options.requestRender();return;}
 if(!this.detail&&data==='v'&&this.options.showPlan){void this.options.showPlan().then(view=>{if(!this.closed){this.view=view;this.options.requestRender();}}).catch(error=>{if(!this.closed){this.view={...this.view,persistence:'unconfirmed',error:safeText(error instanceof Error?error.message:error)};this.options.requestRender();}});return;}
 const item=this.select(),tree=buildTodoTree(this.view.items),group=!!item&&tree.groupIds.has(item.id);
 // Preserve the installed Inspector-local toggle; no widget/plan mutation.
 if(!this.detail&&data==='c'){this.hideCompleted=!this.hideCompleted;this.select();this.options.requestRender();return;}
 if(!this.detail&&group&&(matchesKey(data,'enter')||data===' '||matchesKey(data,'left')||matchesKey(data,'right'))){this.fold(item!.id,matchesKey(data,'left')?true:matchesKey(data,'right')?false:undefined);return;}
 if(matchesKey(data,"enter")){if(this.detail&&item?.links.length){this.options.openLink(item.links[Math.min(this.scroll,item.links.length-1)]);this.dispose();}else{this.detail=true;this.scroll=0;}}
 else if(matchesKey(data,"up")||data==="k"){if(this.detail)this.scroll=Math.max(0,this.scroll-1);else {const rows=this.rows(),index=rows.findIndex(i=>i.id===this.selectedId);this.selectedId=rows[Math.max(0,index-1)]?.id;}}else if(matchesKey(data,"down")||data==="j"){if(this.detail)this.scroll++;else {const rows=this.rows(),index=rows.findIndex(i=>i.id===this.selectedId);this.selectedId=rows[Math.min(rows.length-1,index+1)]?.id;}}if(this.options.selection)this.options.selection.id=this.selectedId;this.options.requestRender();}
 render(width:number){
  const limit=Math.max(1,Math.floor(width)),height=Math.max(1,Math.floor(this.options.rows()*0.9));
  const fg=(color:any,text:string)=>this.options.theme.fg(color,text),bg=(color:any,text:string)=>this.options.theme.bg?.(color,text)??text;
  const pad=(text:string,size:number)=>{const clipped=truncateToWidth(text,Math.max(0,size));return clipped+" ".repeat(Math.max(0,size-visibleWidth(clipped)));};
  if(limit<4||height<3)return [bg("customMessageBg",pad(fg("muted","计划 · Esc/q关闭"),limit))];
  const inner=limit-2,room=Math.max(1,height-4);
  const item=this.select(),tree=buildTodoTree(this.view.items),visible=this.rows(),selected=Math.max(0,visible.findIndex(i=>i.id===this.selectedId)),folded=this.options.getFoldedIds?.()??this.localFolded,tasks=new Map((this.options.tasks?.()??[]).map(t=>[t.id,t]));
  let body:Array<{text:string;selected?:boolean}>=[];
  const ownership=(i:TodoView["items"][number])=>i.assignee?` · @${safeText(i.assignee)}`:"";
  const dependency=(i:TodoView["items"][number])=>(i.dependsOn??[]).map(id=>{const dep=this.view.items.find(d=>d.id===id);return `${safeText(dep?.title??id)}（${dep?todoStateLabel(dep.derivedStatus):"待核实"}）`;}).join("、");
  if(this.view.error)body=[{text:fg("error",`待核实：${safeText(this.view.error)}`)}];
  else if(this.history){body=[{text:'历史不计成功；graph_todo history 可分页核对/恢复归属'},...(this.view.lifecycle?.history??[]).map(h=>({text:`${safeText(h.goal??h.planId??h.planEntryId)} · ${safeText(h.summary)}`})),...(this.view.lifecycle?.historyOmitted?[{text:`另 ${this.view.lifecycle.historyOmitted} 历史未核对；history offset 翻页`}]:[])];}
  else if(!item)body=[{text:"暂无总计划；父级用 graph_todo 明确维护。"},{text:"t 查看Graph执行清单；不会自动从聊天生成。"}];
  else if(this.detail){
   const info=[...wrapTextWithAnsi(`${safeText(item.id)} · ${safeText(item.title)}`,Math.max(1,inner)),`${todoStateLabel(item.derivedStatus)} · 来源：${item.source}${ownership(item)}${this.view.lifecycle?.historyIds.includes(item.id)?" · 历史义务（不是成功）":""}`,...(item.dependsOn?.length?[`前置：${dependency(item)}`]:[]),...(item.reason?[safeText(item.reason)]:[])];
   if(item.links.length){this.scroll=Math.min(this.scroll,item.links.length-1);const infoRoom=Math.min(info.length,Math.max(0,room-1)),linkRoom=Math.max(1,room-infoRoom),start=Math.max(0,this.scroll-linkRoom+1);body=[...info.slice(0,infoRoom).map(text=>({text})),...item.links.slice(start,start+linkRoom).map((l,i)=>({text:`${start+i===this.scroll?">":" "} ${safeText(l.graphId)} / ${safeText(l.taskId)} · ${safeText(l.runInstanceId)}`,selected:start+i===this.scroll}))];}
   else {const lines=[...info,"人工完成不等于Graph验收"];this.scroll=Math.min(this.scroll,Math.max(0,lines.length-room));body=lines.slice(this.scroll,this.scroll+room).map(text=>({text}));}
  }else{for(const i of visible){
   const group=tree.groupIds.has(i.id),task=tasks.get(i.id),depth=tree.depthById.get(i.id)??1,number=tree.numberById.get(i.id),prefix=`${i.id===this.selectedId?'>':' '} ${' '.repeat(Math.min(10,(depth-1)*2))}${group?(folded.has(i.id)?'▸ ':'▾ '):''}#${number} `;
   const leafIds=tree.descendantLeafIds(i.id),rawRight=task?.label??(group?`已完成 ${leafIds.filter(id=>tree.byId.get(id)?.derivedStatus==='done').length}/${leafIds.length}`:todoStateLabel(i.derivedStatus)),right=truncateToWidth(rawRight,Math.max(5,Math.floor(inner*.46)),'…');
   const titleLines=wrapTextWithAnsi((this.view.lifecycle?.historyIds.includes(i.id)?"〔历史义务〕":"")+safeText(i.title),Math.max(1,inner-visibleWidth(prefix)-visibleWidth(right)-2)),title=titleLines[0]??'';
   body.push({text:prefix+title+' '.repeat(Math.max(1,inner-visibleWidth(prefix+title+right)))+fg(task?.tone??'muted',right),selected:i.id===this.selectedId});
   const identity=!group&&(task?todoIdentity(task,Math.max(1,inner-4)):ownership(i).replace(/^ · /,''));if(identity)body.push({text:'    '+fg('muted',identity),selected:i.id===this.selectedId});for(const line of titleLines.slice(1,3))body.push({text:'    '+line,selected:i.id===this.selectedId});
   if(!group&&i.dependsOn?.length&&!task)body.push({text:'    ← '+dependency(i),selected:i.id===this.selectedId});
  }const selectedLine=body.findIndex(line=>line.selected),start=Math.max(0,selectedLine-Math.max(0,Math.floor(room/3)));body=body.slice(start,start+room);}
  const footer=this.detail?"Esc返回 · ↑↓关联 · Enter打开 · q关闭":`Esc/q返回 · ↑↓选择 · Enter组折叠/叶详情 · ←→/空格 · ${this.hideCompleted?"c显示完成项(本面板)":"c隐藏完成项(本面板)"} · h历史 · v恢复显示 · t/a · g选图`;
  const effectiveLeaves=tree.leafIds.filter(id=>!this.view.lifecycle?.historyIds.includes(id));
  const summary=`${this.view.lifecycle?`历史义务 ${this.view.lifecycle.historyIds.length} · `:""}当前 ${effectiveLeaves.filter(id=>tree.byId.get(id)?.derivedStatus==='done').length}/${effectiveLeaves.length} · ${this.view.persistence==="durable"?"已保存":this.view.persistence==="memory"?"会话内存":"保存未确认"} · revision ${this.view.revision}`;
  const title=truncateToWidth(` 总计划${this.detail?"详情":""}${this.view.goal?" · "+safeText(this.view.goal):""} · p/t/a `,inner);
  const border=(left:string,text:string,right:string)=>bg("customMessageBg",fg("border",left+text+right));
  const row=(text:string,selected=false)=>bg("customMessageBg",fg("border","│")+bg(selected?"selectedBg":"customMessageBg",pad(selected?fg("accent",text):text,inner))+fg("border","│"));
  const top=border("┌",title+"─".repeat(Math.max(0,inner-visibleWidth(title))),"┐"),bottom=border("└","─".repeat(inner),"┘");
  if(height<5)return [top,...(height===4?[row(fg("muted",summary))]:[]),row(fg("muted","Esc/q关闭")),bottom];
  return [top,row(fg("muted",summary)),...body.slice(0,room).map(line=>row(line.text,line.selected)),row(fg("muted",footer)),bottom];
 }
}
