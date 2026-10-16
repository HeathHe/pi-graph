import {matchesKey,truncateToWidth,visibleWidth,wrapTextWithAnsi} from '@earendil-works/pi-tui';
import type {GraphSnapshotV3} from '../types.ts';
import {safeText,displayPhase,phaseLabel,phaseColor,graphLabel,nodeReason,nodeNextStep,type GraphTheme} from './presentation.ts';
export const receiptId=(id:unknown):id is string=>typeof id==='string'&&id.length>0&&id.length<=240&&!/[\s\x00-\x1f\x7f-\x9f]/u.test(id);
export function receiptReason(reason:string):string{if(!reason.includes('Continuation model-definition identities differ from admission'))return reason;return reason.replace('Child run failed: Error: ','').replace('Child run failed: ','').replace('Continuation model-definition identities differ from admission','恢复时模型定义与启动登记不一致').replace(' Automatic recovery is unsafe or exhausted; reconcile the existing run before retrying.','');}
export class ExpandedReceipt{
 constructor(private snapshot:GraphSnapshotV3,private action:string,private theme:GraphTheme,private toolCallId:unknown,private isError=false,private errorText="",private partial=false){}
 invalidate(){}
 render(width:number):string[]{const size=Math.max(1,width-2),s=this.snapshot,rows=Object.entries(s.nodes??{}).sort(([a,x],[b,y])=>Number(!!y.observation?.supervision?.attention||['failed','needs_attention','exit_unreconciled','exit_unverified','not_started'].includes(displayPhase(s,b,y)))-Number(!!x.observation?.supervision?.attention||['failed','needs_attention','exit_unreconciled','exit_unverified','not_started'].includes(displayPhase(s,a,x)))),out:string[]=[];const add=(color:any,text:string)=>out.push(...wrapTextWithAnsi(this.theme.fg(color,text),size));
 const labels:Record<string,string>={status:'状态查询',wait:'等待结果',start:'提交结果',resume:'恢复结果'};
 add('accent',`${labels[this.action]??'操作结果'} · 回执快照`);add('muted',`${this.partial||!s.runInstanceId?"回执所含节点（非完整统计）":"子任务"}已验收 ${rows.filter(([id,n])=>displayPhase(s,id,n)==='accepted').length}/${rows.length} · 记录状态：${graphLabel(s)}`);
 if(this.isError&&this.errorText)add('error',`错误：${receiptReason(safeText(this.errorText))}`);
 for(const [id,n]of rows.slice(0,6)){out.push('');add('accent',`─ ${safeText(id)} · ${phaseLabel(n,s,id)}`);const reason=nodeReason(s,id,n);add(phaseColor(n,s,id),`原因：${receiptReason(reason)}`);if(displayPhase(s,id,n)==='accepted'&&n.observation?.supervision?.attention)add('warning',`历史监管警告：${safeText(n.observation.supervision.attention)}（节点已验收）`);const next=reason.includes('Continuation model-definition identities differ from admission')?'已阻止自动恢复；需核对原始记录与候选定义':nodeNextStep(s,id,n);if(next)add('muted',`下一步：${safeText(next)}`);
 const o:any=n.observation;add('muted','执行信息');add('text',`实际Agent：${safeText(o?.actualAgent)||'未观测'} · 执行尝试：${n.attempt??'未知'}`);const assigned=safeText(o?.resolvedAgent??n.agent);if(assigned&&assigned!==o?.actualAgent)add('muted',`解析/配置岗位：${assigned}`);
 if(typeof o?.durationMs==='number'&&Number.isFinite(o.durationMs)&&o.durationMs>=0)add('muted',`已观测时长：${Math.round(o.durationMs/1000)} 秒`);
 const requested=safeText(o?.requestedModel??(n as any).model),resolved=safeText(o?.resolvedModel),actual=safeText(o?.actualModel);
 if(requested&&requested===resolved&&resolved===actual)add('text',`请求/解析/实际模型：${actual}`);else{if(requested)add('text',`请求模型：${requested}`);if(resolved)add('text',`解析模型：${resolved}`);add('text',`实际模型：${actual||'未观测'}`);}
 if(o?.usage&&typeof o.usage==='object'){const labels:Record<string,string>={inputTokens:'输入',outputTokens:'输出',cacheReadTokens:'缓存读取',cacheWriteTokens:'缓存写入',totalTokens:'合计',costUsd:'费用（美元）'};const usage=Object.entries(labels).flatMap(([k,label])=>typeof o.usage[k]==='number'&&Number.isFinite(o.usage[k])&&o.usage[k]>=0?[`${label} ${k==='costUsd'?Number(o.usage[k].toFixed(6)):o.usage[k]}`]:[]);if(usage.length)add('muted',usage.join(' · '));}
 if(typeof o?.progress?.toolCount==='number')add('muted',`工具调用 ${o.progress.toolCount} 次 · 仅为已观测记录`);
 }
 if(rows.length>6)add('warning',`另有 ${rows.length-6} 个节点；请查看原始回执或实时图详情`);
 add('accent','详情');if(receiptId(this.toolCallId))add('muted',`原始回执（历史）：/graphs receipt ${this.toolCallId}`);else add('muted','原始回执入口不可用：缺少有效工具调用ID');add('muted',`实时图详情：/graphs view ${safeText(s.graphId)}`);return out;
 }
}
/** Reads only the supplied current branch. Never substitutes live Graph data. */
export function findRawReceipt(branch:readonly any[],id:string):string{
 if(!receiptId(id))throw Error('原始回执ID无效');const entry=[...branch].reverse().find(e=>e.type==='message'&&e.message?.role==='toolResult'&&e.message?.toolCallId===id&&e.message?.toolName==='graph');
 if(!entry)throw Error('当前分支没有该原始回执，记录不可用');return JSON.stringify({content:entry.message.content,details:entry.message.details,isError:entry.message.isError},null,2);
}
export class RawReceiptViewer{
 private scroll=0;private max=0;private closed=false;
 constructor(private text:string,private theme:GraphTheme,private rows:()=>number,private renderRequest:()=>void,private close:()=>void,private valid:()=>boolean){}
 dispose(){this.closed=true;}invalidate(){}
 handleInput(key:string){if(this.closed)return;if(!this.valid()||matchesKey(key,'escape')||key==='q'){this.dispose();this.close();return;}if(matchesKey(key,'up'))this.scroll--;if(matchesKey(key,'down'))this.scroll++;if(matchesKey(key,'pageUp'))this.scroll-=10;if(matchesKey(key,'pageDown'))this.scroll+=10;if(matchesKey(key,'home'))this.scroll=0;if(matchesKey(key,'end'))this.scroll=this.max;this.scroll=Math.max(0,Math.min(this.max,this.scroll));this.renderRequest();}
 render(width:number){if(this.closed)return[];if(!this.valid()){this.dispose();this.close();return[];}const w=Math.max(1,width),h=Math.max(1,Math.floor(this.rows()*.9)),inner=Math.max(1,w-2);const bg=(s:string)=>this.theme.bg?.('customMessageBg',s)??s;const pad=(s:string)=>{const t=truncateToWidth(s,inner);return t+' '.repeat(Math.max(0,inner-visibleWidth(t)));};if(w<4||h<4)return[truncateToWidth('原始回执 · Esc关闭',w)];
 const lines=this.text.split('\n').flatMap(line=>wrapTextWithAnsi(line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x1f\x7f-\x9f]/g,' '),inner)),room=h-3;this.max=Math.max(0,lines.length-room);this.scroll=Math.min(this.scroll,this.max);return[bg('┌'+pad(this.theme.fg('accent','原始回执（历史记录）'))+'┐'),...lines.slice(this.scroll,this.scroll+room).map(line=>bg('│'+pad(line)+'│')),bg('│'+pad(this.theme.fg('muted',`↑↓ PgUp/PgDn Home/End · Esc关闭 ${this.scroll+1}/${lines.length}`))+'│'),bg('└'+'─'.repeat(inner)+'┘')];
 }
}
