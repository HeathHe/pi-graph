import type {GraphSnapshotV3} from "../types.ts";
import {displayEvidence,displayPhase,nodeReason,phaseOf,safeText,supervisionWarning,displayGoalIdentity} from "./presentation.ts";
import {liveAgent} from "./cockpit.ts";
const attention=new Set(["failed","needs_attention","blocked","exit_unreconciled","exit_unverified","aborted","cancelled","skipped","not_started","waiting_user"]);
/** Pure, historical receipt-bound facts. Raw details and expanded view remain available. */
export function graphEventCard(action:string,snapshot:GraphSnapshotV3,partial:boolean,continues=false):string {
 const entries=Object.entries(snapshot.nodes??{}),e=displayEvidence(snapshot),lines:string[]=[];
 if(!['queued','running','complete'].includes(snapshot.status)){
  const status:Record<string,string>={paused:'· Graph 已暂停；继续前核对暂停原因',waiting_input:'· Graph 正在等待输入；请核对待处理请求',needs_attention:'! Graph 需要处理；请核对监管记录',stopped:'· Graph 已停止；请核对已有结果，不要自动重跑',failed:'! Graph 失败；请查看原始原因'};
  lines.push(status[snapshot.status]??`· Graph 状态待核对：${safeText(snapshot.status)||'未提供'}`);
 }

 if(!snapshot.graphId||!snapshot.runInstanceId||!snapshot.sessionId||e?.goalIdentity!==displayGoalIdentity(snapshot))lines.push('· 状态证据待核对：运行身份不完整或不匹配');
 if(!e?.expectedTaskIds?.length||e.expectedTaskIds.length!==entries.length||e.expectedTaskIds.some(id=>!snapshot.nodes?.[id]))lines.push('· 状态证据待核对：节点覆盖未核实，不能判断整体完成');
 if(e?.readError)lines.push('· 状态证据待核对：部分证据暂时不可读');
 if(e?.stopRequested)lines.push('! 已提交停止请求，是否退出以证据为准');
 for(const [id,n]of entries){const phase=displayPhase(snapshot,id,n),warning=supervisionWarning(n);
  if(warning)lines.push('! '+(phaseOf(n)==='accepted'?'已验收，仍有历史问题：':'')+warning);
  else if(attention.has(phase))lines.push('! '+nodeReason(snapshot,id,n));
  else if(!['accepted','queued','prepared'].includes(phase)&&!liveAgent(n))lines.push('! 执行状态待核对');
 }
 if(e?.exitUnverified?.length)lines.push('! 退出证据未核实');
 if(Object.keys(e?.processExits??{}).length)lines.push('! 进程已退出，Graph 状态待核对');
 if(Object.keys(e?.failures??{}).length&&!entries.some(([id,n])=>attention.has(displayPhase(snapshot,id,n))))lines.push('! 存在历史失败记录，请核对详情');
 if(!lines.length)return '';
 const facts=[...new Set(lines)].sort((a,b)=>Number(b.startsWith('!'))-Number(a.startsWith('!')));return facts.slice(0,2).concat(facts.length>2?[`另 ${facts.length-2} 项，展开查看`]:[]).concat('展开查看详情；先核对状态与原始原因，不要自动重跑。').join('\n');
}
/** Quiet requires complete identity/coverage and no warning; unknown alone is neutral. */
export function quietGraphEvent(snapshot:GraphSnapshotV3,partial:boolean):boolean {
 const e=displayEvidence(snapshot),entries=Object.entries(snapshot.nodes??{}),ids=e?.expectedTaskIds;
 if(e?.goalIdentity!==displayGoalIdentity(snapshot)||!snapshot.graphId||!snapshot.runInstanceId||!snapshot.sessionId||!entries.length||!ids?.length||ids.length!==entries.length||ids.some(id=>!snapshot.nodes?.[id]))return false;
 if(!['queued','running','complete'].includes(snapshot.status)||e?.stopRequested||e?.readError||e?.exitUnverified?.length||Object.keys(e?.processExits??{}).length||Object.keys(e?.failures??{}).length)return false;
 return entries.every(([id,n])=>{const phase=displayPhase(snapshot,id,n);return !supervisionWarning(n)&&(['accepted','queued','prepared'].includes(phase)||liveAgent(n));});
}
