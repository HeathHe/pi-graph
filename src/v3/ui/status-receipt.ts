import {receiptReason} from './expanded-receipt.ts';
import {truncateToWidth,visibleWidth} from "@earendil-works/pi-tui";
import type {GraphSnapshotV3} from "../types.ts";
import {displayPhase,graphLabel,nodeReason,safeText,errorSummary,supervisionWarning,type GraphTheme} from "./presentation.ts";
/** Small observation receipt, never a new dispatch/completion notification. */
export class StatusReceipt {
 constructor(private snapshot:GraphSnapshotV3,private action:string,private theme:GraphTheme,private isError=false,private errorText=""){}
 invalidate(){}
 render(width:number):string[]{
  const limit=Math.max(1,width-1),inner=Math.max(0,limit-2),s=this.snapshot,nodes=Object.entries(s.nodes??{}),accepted=nodes.filter(([id,n])=>displayPhase(s,id,n)==="accepted").length;
  const issues=nodes.filter(([id,n])=>["failed","needs_attention","blocked","exit_unreconciled","exit_unverified","not_started","aborted","cancelled","skipped","waiting_user"].includes(displayPhase(s,id,n))||Boolean(supervisionWarning(n))).sort((a,b)=>Number(["exit_unreconciled","exit_unverified","failed","not_started"].includes(displayPhase(s,b[0],b[1])))-Number(["exit_unreconciled","exit_unverified","failed","not_started"].includes(displayPhase(s,a[0],a[1]))));
  const names:Record<string,string>={status:"状态查询",resume:"恢复操作",pause:"暂停操作",stop:"停止操作",append:"追加操作",retry:"重试操作"};
  const label=`${names[this.action]??"状态记录"}（系统回执）`,summary=`${s.runInstanceId?"子任务":"回执节点"}已验收 ${accepted}/${nodes.length} · 记录状态：${graphLabel(s)}`;
  const details=[...issues.slice(0,2).map(([id,n])=>`${["accepted","queued","prepared","running","dispatched"].includes(displayPhase(s,id,n))&&supervisionWarning(n)?`${displayPhase(s,id,n)==="accepted"?"历史监管警告：":""}${supervisionWarning(n)}`:receiptReason(nodeReason(s,id,n))} · @${safeText(id)}`),...(this.isError?[errorSummary(this.errorText)||"操作未完成"]:[])];
  const fg=(c:any,t:string)=>this.theme.fg(c,t),bg=(t:string)=>this.theme.bg?.("customMessageBg",t)??t;
  const pad=(t:string)=>{const clipped=truncateToWidth(t,inner);return clipped+" ".repeat(Math.max(0,inner-visibleWidth(clipped)));};
  if(limit<8)return [bg(truncateToWidth(`${label} ${details[0]??summary}`,limit))];
  const title=truncateToWidth(` ${label} `,inner),lines=[bg(fg("border",`┌${title}${"─".repeat(Math.max(0,inner-visibleWidth(title)))}┐`))];
  const row=(text:string,color:any)=>bg(fg("border","│")+pad(fg(color,text))+fg("border","│"));
  lines.push(row(`${summary}${issues.length?` · 待处理 ${issues.length}`:""} · 展开查看详情`,this.isError||issues.length?"warning":"muted"));
  for(const detail of details)lines.push(row(detail,"error"));
  lines.push(bg(fg("border",`└${"─".repeat(inner)}┘`)));return lines;
 }
}
