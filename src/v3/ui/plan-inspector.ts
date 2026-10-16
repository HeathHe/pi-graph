import {matchesKey,truncateToWidth,visibleWidth,wrapTextWithAnsi} from "@earendil-works/pi-tui";
import {TodoReadSupersededError,type TodoView,type TodoLink} from "./todo.ts";
import type {CockpitTab} from "./cockpit.ts";
import {todoStateLabel} from "./cockpit.ts";
import {safeText,type GraphTheme} from "./presentation.ts";
export class PlanInspector {
 private selected=0;private detail=false;private scroll=0;private closed=false;private reading=false;private view:TodoView;private timer:ReturnType<typeof setInterval>;
 constructor(private options:{view:TodoView;theme:GraphTheme;rows:()=>number;requestRender:()=>void;close:()=>void;navigate:(tab:CockpitTab)=>void;openLink:(link:TodoLink)=>void;history:()=>void;read:()=>Promise<TodoView>}){this.view=options.view;this.timer=setInterval(()=>void this.refresh(),1500);this.timer.unref?.();}
 async refresh(){if(this.closed||this.reading)return;this.reading=true;try{const next=await this.options.read();if(!this.closed){this.view=next;this.options.requestRender();}}catch(e){if(e instanceof TodoReadSupersededError)return;if(!this.closed){this.view={...this.view,items:[],error:safeText(e instanceof Error?e.message:e),persistence:"unconfirmed"};this.options.requestRender();}}finally{this.reading=false;}}
 dispose(){this.closed=true;clearInterval(this.timer);}invalidate(){}
 handleInput(data:string){if(this.closed||data.includes("\x1b[200~"))return;if(data==="q"||matchesKey(data,"ctrl+c")){this.dispose();this.options.close();return;}if(matchesKey(data,"escape")){if(this.detail){this.detail=false;this.scroll=0;}else{this.dispose();this.options.close();}return;}
 if(!this.detail&&(data==="t"||data==="a")){this.dispose();this.options.navigate(data==="t"?"tasks":"agents");return;}if(data==="g"){this.dispose();this.options.history();return;}if(data==="r"){void this.refresh();return;}
 const item=this.view.items[this.selected];if(matchesKey(data,"enter")){if(this.detail&&item?.links.length){this.options.openLink(item.links[Math.min(this.scroll,item.links.length-1)]);this.dispose();}else{this.detail=true;this.scroll=0;}}
 else if(matchesKey(data,"up")||data==="k"){if(this.detail)this.scroll=Math.max(0,this.scroll-1);else this.selected=Math.max(0,this.selected-1);}else if(matchesKey(data,"down")||data==="j"){if(this.detail)this.scroll++;else this.selected=Math.min(this.view.items.length-1,this.selected+1);}this.options.requestRender();}
 render(width:number){
  const limit=Math.max(1,Math.floor(width)),height=Math.max(1,Math.floor(this.options.rows()*0.9));
  const fg=(color:any,text:string)=>this.options.theme.fg(color,text),bg=(color:any,text:string)=>this.options.theme.bg?.(color,text)??text;
  const pad=(text:string,size:number)=>{const clipped=truncateToWidth(text,Math.max(0,size));return clipped+" ".repeat(Math.max(0,size-visibleWidth(clipped)));};
  if(limit<4||height<3)return [bg("customMessageBg",pad(fg("muted","计划 · Esc/q关闭"),limit))];
  const inner=limit-2,room=Math.max(1,height-4);
  this.selected=Math.max(0,Math.min(this.selected,this.view.items.length-1));const item=this.view.items[this.selected];
  let body:Array<{text:string;selected?:boolean}>=[];
  const ownership=(i:TodoView["items"][number])=>i.assignee?` · @${safeText(i.assignee)}`:"";
  const dependency=(i:TodoView["items"][number])=>(i.dependsOn??[]).map(id=>{const dep=this.view.items.find(d=>d.id===id);return `${safeText(dep?.title??id)}（${dep?todoStateLabel(dep.derivedStatus):"待核实"}）`;}).join("、");
  if(this.view.error)body=[{text:fg("error",`待核实：${safeText(this.view.error)}`)}];
  else if(!item)body=[{text:"暂无总计划；父级用 graph_todo 明确维护。"},{text:"t 查看Graph执行清单；不会自动从聊天生成。"}];
  else if(this.detail){
   const info=[...wrapTextWithAnsi(`${safeText(item.id)} · ${safeText(item.title)}`,Math.max(1,inner)),`${todoStateLabel(item.derivedStatus)} · 来源：${item.source}${ownership(item)}`,...(item.dependsOn?.length?[`前置：${dependency(item)}`]:[]),...(item.reason?[safeText(item.reason)]:[])];
   if(item.links.length){this.scroll=Math.min(this.scroll,item.links.length-1);const infoRoom=Math.min(info.length,Math.max(0,room-1)),linkRoom=Math.max(1,room-infoRoom),start=Math.max(0,this.scroll-linkRoom+1);body=[...info.slice(0,infoRoom).map(text=>({text})),...item.links.slice(start,start+linkRoom).map((l,i)=>({text:`${start+i===this.scroll?">":" "} ${safeText(l.graphId)} / ${safeText(l.taskId)} · ${safeText(l.runInstanceId)}`,selected:start+i===this.scroll}))];}
   else {const lines=[...info,"人工完成不等于Graph验收"];this.scroll=Math.min(this.scroll,Math.max(0,lines.length-room));body=lines.slice(this.scroll,this.scroll+room).map(text=>({text}));}
  }else{const start=Math.max(0,this.selected-room+1);body=this.view.items.slice(start,start+room).map((i,index)=>({text:`${start+index===this.selected?">":" "} ${todoStateLabel(i.derivedStatus)} · ${safeText(i.title)}${ownership(i)}（${i.source}）${i.dependsOn?.length?` ← ${dependency(i)}`:""}`,selected:start+index===this.selected}));}
  const footer=this.detail?"Esc返回 · ↑↓关联 · Enter打开 · q关闭":"Esc/q返回 · ↑↓选择 · Enter详情 · t/a · g选图 · r刷新";
  const summary=`完成 ${this.view.items.filter(i=>i.derivedStatus==="done").length}/${this.view.items.length} · ${this.view.persistence==="durable"?"已保存":this.view.persistence==="memory"?"会话内存":"保存未确认"} · revision ${this.view.revision}`;
  const title=truncateToWidth(` 总计划${this.detail?"详情":""} · p/t/a `,inner);
  const border=(left:string,text:string,right:string)=>bg("customMessageBg",fg("border",left+text+right));
  const row=(text:string,selected=false)=>bg("customMessageBg",fg("border","│")+bg(selected?"selectedBg":"customMessageBg",pad(selected?fg("accent",text):text,inner))+fg("border","│"));
  const top=border("┌",title+"─".repeat(Math.max(0,inner-visibleWidth(title))),"┐"),bottom=border("└","─".repeat(inner),"┘");
  if(height<5)return [top,...(height===4?[row(fg("muted",summary))]:[]),row(fg("muted","Esc/q关闭")),bottom];
  return [top,row(fg("muted",summary)),...body.slice(0,room).map(line=>row(line.text,line.selected)),row(fg("muted",footer)),bottom];
 }
}
