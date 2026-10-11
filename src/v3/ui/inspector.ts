import { selectedGraphTarget, terminalText, type GraphUiAction, type GraphUiTarget, type ArtifactPage, type NativeResultPage } from "./interaction.ts";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { GraphSnapshotV3 } from "../types.ts";
import { nodeActivityLines, counts, localAuthLines, localTimestamp, displayPhase, orderedNodes, nodeNextStep, displayEvidence, graphLabel, nodeReason, pad, phaseColor, phaseLabel, safeText, type GraphTheme } from "./presentation.ts";

interface InspectorOptions {
 snapshot: GraphSnapshotV3;
 theme: GraphTheme;
 rows: () => number;
 requestRender: () => void;
 onClose: () => void;
 keybindings?: { matches(data: string, action: any): boolean };
 read: () => Promise<GraphSnapshotV3>;
 subscribe?: (accept: (snapshot: GraphSnapshotV3) => void) => () => void;
 onSnapshot?: (snapshot: GraphSnapshotV3) => void;
 pollMs?: number;
 selectedId?:string;
 onAction?:(action:GraphUiAction)=>void;
 canMessage?:(target:GraphUiTarget)=>boolean;
 readResult?:(target:GraphUiTarget,offset:number,limit:number,digest?:string)=>Promise<NativeResultPage>;
 readArtifact?:(target:GraphUiTarget,offset:number,limit:number,digest?:string)=>Promise<ArtifactPage>;
}
/** Read-only view. It has no execution, stop, retry, or steering capabilities. */
export class GraphInspector {
 private snapshot: GraphSnapshotV3;
 private selectedId?: string;
 private mode: "list" | "detail" | "raw" | "artifact" | "native" = "list";
 private artifact?:ArtifactPage | NativeResultPage;
 private artifactTarget?:GraphUiTarget;
 private artifactLoading=false;
 private artifactError?:string;
 private preview?:string;
 private requestVersion=0;
 private scroll = 0;
 private listOffset = 0;
 private pageSize = 1;
 private maxScroll = 0;
 private closed = false;
 private reading = false;
 private error?: string;
 private fingerprint = "";
 private timer: ReturnType<typeof setInterval>;
 private unsubscribe?: () => void;
 private options: InspectorOptions;
 constructor(options: InspectorOptions) {
  this.options = options; this.snapshot = options.snapshot;
  this.selectedId = options.selectedId && this.snapshot.nodes?.[options.selectedId] ? options.selectedId : orderedNodes(this.snapshot)[0]?.[0];
  this.unsubscribe = options.subscribe?.(snapshot => this.accept(snapshot));
  this.timer = setInterval(() => void this.refresh(), options.pollMs ?? 1500);
  this.timer.unref?.();
 }
 private accept(snapshot: GraphSnapshotV3): void {
  if (this.closed || snapshot.graphId !== this.snapshot.graphId || snapshot.runInstanceId !== this.snapshot.runInstanceId) return;
  if (Date.parse(snapshot.updatedAt) < Date.parse(this.snapshot.updatedAt)) return;
  const fingerprint = JSON.stringify([snapshot, displayEvidence(snapshot), [...(displayEvidence(snapshot)?.neverDispatched ?? [])]]);
  if (fingerprint === this.fingerprint) return;
  this.fingerprint = fingerprint;
  const previousAttempt=this.selectedId?this.snapshot.nodes?.[this.selectedId]?.attempt:undefined;
  if(this.selectedId && snapshot.nodes?.[this.selectedId]?.attempt!==previousAttempt){
   this.invalidateArtifactRequest();this.preview=undefined;this.artifact=undefined;this.artifactTarget=undefined;
   if(this.mode==="native"||this.mode==="artifact")this.mode="detail";
  }
  this.snapshot = snapshot;
  if (!this.selectedId || !snapshot.nodes?.[this.selectedId]) this.selectedId = orderedNodes(snapshot)[0]?.[0];
  this.options.onSnapshot?.(snapshot);
  this.options.requestRender();
 }
 async refresh(): Promise<void> {
  if (this.closed || this.reading) return;
  this.reading = true;
  try { const next = await this.options.read(); if (!this.closed) { if (this.error) this.fingerprint = ""; this.error = undefined; this.accept(next); } }
  catch (e) { if (!this.closed) { this.error = `刷新失败，显示上次状态：${safeText(e instanceof Error ? e.message : e)}`; this.options.requestRender(); } }
  finally { this.reading = false; }
 }
 dispose(): void { if(this.closed) return; this.closed = true; this.invalidateArtifactRequest(); clearInterval(this.timer); this.unsubscribe?.(); }
 private invalidateArtifactRequest():void {this.requestVersion++;this.artifactLoading=false;this.artifactError=undefined;}
 private async loadArtifact(full:boolean,offset=0,native=false):Promise<void>{
  const readPage=native?this.options.readResult:this.options.readArtifact;
  if(!this.selectedId||!readPage)return;
  // Switching readers cancels the detail preview; late promises cannot change the mode.
  if(this.artifactLoading && !(full && offset===0))return;
  const version=++this.requestVersion;
  try {
   const target=full&&(this.mode==="artifact"||this.mode==="native")&&this.artifactTarget?this.artifactTarget:selectedGraphTarget(this.snapshot,this.selectedId);
   this.artifactLoading=true;this.artifactError=undefined;
   const page=await readPage(target,offset,full?2048:240,offset>0?this.artifact?.sha256:undefined);
   if(this.closed||version!==this.requestVersion)return;
   if(full){this.artifact=page;this.artifactTarget=target;this.mode=native?"native":"artifact";this.scroll=0;}else this.preview=terminalText(page.text);
  }catch(error){if(!this.closed&&version===this.requestVersion)this.artifactError=terminalText(error instanceof Error?error.message:error);}
  finally{if(version===this.requestVersion){this.artifactLoading=false;if(!this.closed)this.options.requestRender();}}
 }
 private close(): void { this.dispose(); this.options.onClose(); }
 invalidate(): void {}
 handleInput(data: string): void {
  if(this.closed)return;
  if (data.includes("\x1b[200~") || data.includes("\x1b[201~")) return;
  const key = (action: string, fallback: Parameters<typeof matchesKey>[1]) => this.options.keybindings?.matches(data, action) ?? matchesKey(data, fallback);
  if (data === "q" || matchesKey(data, "ctrl+c")) { this.close(); return; }
  if (key("tui.select.cancel", "escape")) {
   this.invalidateArtifactRequest();
   if (this.mode === "raw" || this.mode === "artifact" || this.mode === "native") this.mode = "detail";
   else if (this.mode === "detail") this.mode = "list";
   else { this.close(); return; }
   this.scroll = 0;
  } else if (data === "m" && this.mode!=="artifact" && this.mode!=="native" && this.selectedId && this.options.onAction) {
   try {const target=selectedGraphTarget(this.snapshot,this.selectedId);if(!this.options.canMessage?.(target))throw new Error("仅当前会话的活动节点可发消息；不会启动或恢复任务");this.dispose();this.options.onAction({kind:"message",target});}catch(error){this.error=terminalText(error instanceof Error?error.message:error);}
  } else if (data === "o" && this.mode === "detail") {void this.loadArtifact(true);}
  else if (data === "f" && this.mode === "detail") {void this.loadArtifact(true,0,true);}
  else if (data === "n" && (this.mode === "artifact"||this.mode === "native") && this.artifact?.nextOffset!=null) {void this.loadArtifact(true,this.artifact.nextOffset,this.mode==="native");}
  else if (data === "r") { void this.refresh(); }
  else if (this.mode === "list") {
   const ids = orderedNodes(this.snapshot).map(([id])=>id); let index = Math.max(0, ids.indexOf(this.selectedId ?? ""));
   if (key("tui.select.up", "up") || data === "k") index--;
   else if (key("tui.select.down", "down") || data === "j") index++;
   else if (key("tui.select.pageUp", "pageUp")) index -= this.pageSize;
   else if (key("tui.select.pageDown", "pageDown")) index += this.pageSize;
   else if (matchesKey(data, "home")) index = 0;
   else if (matchesKey(data, "end")) index = ids.length - 1;
   else if (key("tui.select.confirm", "enter") && this.selectedId) { this.mode = "detail"; this.scroll = 0;this.preview=undefined;this.artifactError=undefined;void this.loadArtifact(false); }
   const nextId=ids[Math.max(0, Math.min(ids.length-1, index))];
   if(nextId!==this.selectedId){this.invalidateArtifactRequest();this.preview=undefined;}
   this.selectedId=nextId;
  } else {
   if (key("tui.select.up", "up") || data === "k") this.scroll--;
   else if (key("tui.select.down", "down") || data === "j") this.scroll++;
   else if (key("tui.select.pageUp", "pageUp")) this.scroll -= this.pageSize;
   else if (key("tui.select.pageDown", "pageDown")) this.scroll += this.pageSize;
   else if (matchesKey(data, "home")) this.scroll = 0;
   else if (matchesKey(data, "end")) this.scroll = this.maxScroll;
   else if (data === "l") { this.invalidateArtifactRequest(); this.mode = this.mode === "raw" ? "detail" : "raw"; this.scroll = 0; }
   this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
  }
  this.options.requestRender();
 }
 render(width: number): string[] {
  const t = this.options.theme, height = Math.max(1, this.options.rows()-2), inner = Math.max(1,width-4);
  if (width < 40 || height < 9) return ["终端过小，请扩大窗口。", "Esc / q 关闭，任务继续运行。"].slice(0,height).map(l => truncateToWidth(l,width));
  const s = this.snapshot;
  const header = [t.bold(t.fg("accent", `◆ PI-GRAPH / ${safeText(s.graphId)}`)), t.fg("muted", graphLabel(s) + " · " + counts(s)), t.fg("dim", this.error ?? `记录更新：${localTimestamp(s.updatedAt)} · ${["failed","complete","stopped"].includes(s.status) ? "历史任务记录" : "只读任务状态"}`), t.fg("borderMuted", "─".repeat(inner))];
  const room = Math.max(1, height - header.length - 3); this.pageSize = room;
  let content: string[] = [], footer: string;
  if (this.mode === "list") {
   const rows = orderedNodes(s), index = Math.max(0,rows.findIndex(([id]) => id === this.selectedId));
   if (index < this.listOffset) this.listOffset = index;
   if (index >= this.listOffset + room) this.listOffset = index - room + 1;
   for (const [id,n] of rows.slice(this.listOffset, this.listOffset + room)) {
    const selected = id === this.selectedId;
    const label = `${selected ? ">" : " "} ${t.fg(phaseColor(n,s,id),pad(phaseLabel(n,s,id),8))}`;
    const idWidth = Math.min(30, Math.max(16, Math.floor(inner * .42)));
    const text = inner >= 66 ? label + pad(safeText(id), idWidth) + "  " + t.fg("muted",nodeReason(s,id,n)) : label + safeText(id);
    content.push(selected ? t.bg("selectedBg",pad(text,inner)) : text);
   }
   if (!rows.length) content = ["暂无任务；开放 Graph 可以继续追加任务。"];
   footer = `↑↓/jk 选择  Enter 详情  m 消息  q 关闭  ${rows.length ? index+1 : 0}/${rows.length}`;
  } else {
   const id = this.selectedId!, n = s.nodes?.[id];
   if (!n) { this.mode = "list"; return this.render(width); }
   const o = n.observation, sup = o?.supervision, e = displayEvidence(s);
   const raw = [t.fg(phaseColor(n,s,id),phaseLabel(n,s,id)) + "  " + t.bold(safeText(id)), ""];
   if (this.mode === "native" && this.artifact && "complete" in this.artifact) {
    const page=this.artifact;
    raw.push("原生结果（只读分页）",page.complete===true?"complete:true · 已验证完整结果":page.complete===false?"complete:false · 已截断":"complete:null · 完整性未证明",`来源 ${page.sourceKind}`,`SHA256 ${page.sha256}`,`文件 ${terminalText(page.source)} · ${page.bytes} bytes · offset ${page.offset}`,"",...terminalText(page.text).split("\n"),"",page.nextOffset===null?"已读取至当前来源末尾":"n 下一页；Esc 返回详情");
    if(this.artifactError)raw.push(this.artifactError);
   } else if (this.mode === "artifact" && this.artifact) {
    raw.push("保存产物原文（不保证完整模型输出）",this.artifact.truncated?"已截断：保存文件含既有截断标志":"文件内容按页读取；模型原输出完整性未证明",`SHA256 ${this.artifact.sha256}`,`文件 ${terminalText(this.artifact.source)} · ${this.artifact.bytes} bytes · offset ${this.artifact.offset}`,"",...terminalText(this.artifact.text).split("\n"),"",this.artifact.nextOffset===null?"保存文件完整读取至末尾":"n 下一页；Esc 返回详情");
   } else if (this.mode === "raw") {
    raw.push("原始状态记录（JSON，非会话全文）", "", ...terminalText(JSON.stringify({ graphStatus:s.status, stopRequested:e?.stopRequested, taskId:id, node:n, failure:e?.failures[id] },null,2)).split("\n"));
   } else {
    if(this.preview)raw.push("保存产物预览",this.preview,"o 打开已校验保存产物","");
    if(this.artifactLoading)raw.push("正在读取产物…");
    if(this.artifactError)raw.push(this.artifactError);
    const failed = displayPhase(s,id,n) === "failed";
    if (failed) raw.push(t.fg("muted",`当次失败${e?.failureTimes?.[id] ? ` · ${localTimestamp(e.failureTimes[id]!)}` : ""}`));
    raw.push(t.fg(failed ? "error" : "text",nodeReason(s,id,n)));
    const auth = localAuthLines(s,id,n);
    if (auth.length) raw.push("", t.fg("accent",auth[0]!),...auth.slice(1));
    const error = sup?.error ?? e?.failures[id];
    const next = nodeNextStep(s,id,n);
    if (next) raw.push("",t.fg("accent","下一步"),next);
    if (error) raw.push("",t.fg("dim","原始错误已保留，按 l 查看。"));
    raw.push("", "Agent      " + safeText(o?.actualAgent ?? o?.resolvedAgent ?? n.agent ?? "未观测到"));
    raw.push(...nodeActivityLines(n));
    if (o?.requestedModel) raw.push("请求模型   " + safeText(o.requestedModel));
    if (o?.resolvedModel) raw.push("解析模型   " + safeText(o.resolvedModel));
    raw.push("执行尝试   " + n.attempt, "依赖任务   " + safeText(n.dependsOn?.join(", ") || "无"));
    if (o?.durationMs !== undefined) raw.push(`已用时     ${(o.durationMs/1000).toFixed(1)} 秒`);
    if (o?.usage?.totalTokens !== undefined) raw.push(`用量       ${o.usage.totalTokens} tokens`);
    if (o?.usage?.costUsd !== undefined) raw.push(`费用       $${o.usage.costUsd}`);
    if (sup) {
     raw.push("", "监管状态", `阶段       ${safeText(sup.phase ?? "未观测到")}`, `执行时限   ${{unlimited:"不限时", configured:"已配置", unknown:"未观测到"}[sup.runtimeLimit]}`);
     raw.push(`控制探测   ${sup.health === "responsive" ? "有响应（仅说明运行器可回应）" : sup.health === "suspected_unresponsive" ? "疑似无响应，需检查" : sup.health === "exited" ? "进程已退出" : "未知"}`);
     if (sup.deadlineAt) raw.push(`上游截止   ${safeText(sup.deadlineAt)}`);
     raw.push(`监管检查   ${safeText(sup.checkedAt)}`);
     if (sup.runtimeRetries !== undefined) raw.push(`底层重试   ${sup.runtimeRetries} 次`);
     if (sup.health === "responsive") raw.push("控制通道有响应，不代表模型已经产出结果。");
    }
    if (e?.readError) raw.push("", t.fg("warning",e.readError));
    raw.push("", t.fg("dim","m 发消息 · f 原生结果 · o 保存产物 · l 状态JSON · Esc 返回列表。"));
   }
   const wrapped = raw.flatMap(line => wrapTextWithAnsi(line, inner));
   this.maxScroll = Math.max(0,wrapped.length-room); this.scroll = Math.min(this.scroll,this.maxScroll);
   content = wrapped.slice(this.scroll,this.scroll+room);
   footer = inner < 66 ? "↑↓ 滚动  f 原生 o 产物 n 下页 m 消息 l 记录  Esc 返回  q 关闭" : "↑↓ 滚动  PgUp/Dn 翻页  f 原生 o 产物 n 下页 m 消息 l 记录  Esc 返回  q 关闭";
  }
  while (content.length < room) content.push("");
  return [...header,...content,t.fg("borderMuted","─".repeat(inner)),t.fg("accent",footer),t.fg("dim",["failed","complete","stopped"].includes(s.status) ? "运行已结束 · r 刷新 · q 返回输入" : "关闭只返回输入，不停止任务 · r 刷新")].map(line => "  " + pad(line,inner) + "  ").map(line=>truncateToWidth(line,width));
 }
}
