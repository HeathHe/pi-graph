import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAuthError, type LocalAuthRecord } from "./auth-view.ts";
import type { GraphSnapshotV3, V3NodeProjection, V3ChildSupervision } from "../types.ts";

export type GraphTheme = ExtensionContext["ui"]["theme"];
export interface DisplayEvidence {
 stopRequested?: boolean;
 failures: Record<string, string>;
 failureTimes?: Record<string,string>;
 localAuth?: Record<string,LocalAuthRecord>;
 neverDispatched: Set<string>;
 readError?: string;
}
const evidence = new WeakMap<GraphSnapshotV3, DisplayEvidence>();
export function setDisplayEvidence(snapshot: GraphSnapshotV3, value: DisplayEvidence): void { evidence.set(snapshot, value); }
export function displayEvidence(snapshot: GraphSnapshotV3): DisplayEvidence | undefined { return evidence.get(snapshot); }
// Durable text is data, never terminal control sequences (including OSC hyperlinks).
export function safeText(value: unknown): string {
 return String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}
export function pad(value: string, width: number): string {
 const text = truncateToWidth(value, Math.max(0, width));
 return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
export const phaseOf = (n: V3NodeProjection): string => n.terminalStatus ?? n.phase;
export const activeNode = (n: V3NodeProjection): boolean => ["prepared", "dispatched", "running", "verifying", "applying"].includes(phaseOf(n));
/** Only explicit fail-fast evidence can turn a stored failure into "not executed". */
export function displayPhase(snapshot: GraphSnapshotV3, id: string, n: V3NodeProjection): string {
 const e = evidence.get(snapshot);
 if (phaseOf(n) === "running" && n.observation?.supervision?.attention === "waiting_user") return "waiting_user";
 return phaseOf(n) === "failed" && e?.neverDispatched.has(id) && e.failures[id] === "Graph failed fast before this node started." ? "not_started" : phaseOf(n);
}
export function orderedNodes(snapshot: GraphSnapshotV3): Array<[string, V3NodeProjection]> {
 const priority = (id: string, n: V3NodeProjection) => {
  const p = displayPhase(snapshot,id,n);
  return p === "failed" || p === "needs_attention" || n.observation?.supervision?.attention ? 0 : activeNode(n) ? 1 : p === "blocked" || p === "not_started" ? 2 : 3;
 };
 return Object.entries(snapshot.nodes ?? {}).sort(([a,x],[b,y]) => priority(a,x)-priority(b,y));
}
export function phaseLabel(n: V3NodeProjection, snapshot?: GraphSnapshotV3, id?: string): string {
 if (phaseOf(n) === "running" && n.observation?.supervision?.attention === "waiting_user") return "等待用户";
 if (phaseOf(n) === "aborted" && snapshot && id && evidence.get(snapshot)?.neverDispatched.has(id)) return "未启动";
 if (snapshot && id && displayPhase(snapshot,id,n) === "not_started") return "未执行";
 return ({ queued: "排队", prepared: "准备", dispatched: "已派发", running: "运行", verifying: "验收", applying: "应用", accepted: "成功", failed: "失败", aborted: "已停止", needs_attention: "待处理", skipped: "跳过", blocked: "未执行", cancelled: "已取消" } as Record<string,string>)[phaseOf(n)] ?? phaseOf(n);
}
export function phaseColor(n: V3NodeProjection, snapshot?: GraphSnapshotV3, id?: string): Parameters<GraphTheme["fg"]>[0] {
 if (snapshot && id && displayPhase(snapshot,id,n) === "not_started") return "muted";
 return phaseOf(n) === "failed" ? "error" : phaseOf(n) === "accepted" ? "success" : phaseOf(n) === "needs_attention" || n.observation?.supervision?.attention ? "warning" : activeNode(n) ? "accent" : "muted";
}
export function counts(snapshot: GraphSnapshotV3): string {
 const values = Object.entries(snapshot.nodes ?? {}).map(([id,n]) => displayPhase(snapshot,id,n));
 const groups: Array<[string,string[]]> = [
  ["成功",["accepted"]], ["运行",["prepared","dispatched","running","verifying","applying"]], ["失败",["failed"]],
  ["未执行",["not_started","blocked"]], ["排队",["queued"]], ["停止",["aborted"]],
  ["等待用户",["waiting_user"]], ["待处理",["needs_attention"]], ["取消",["cancelled"]], ["跳过",["skipped"]],
 ];
 return groups.flatMap(([label,phases]) => { const count=values.filter(p=>phases.includes(p)).length; return count ? [`${label} ${count}`] : []; }).join(" · ") || "暂无任务";
}

export function graphLabel(snapshot: GraphSnapshotV3): string {
 const nodes = Object.values(snapshot.nodes ?? {});
 const failed = Object.entries(snapshot.nodes ?? {}).filter(([id,n]) => displayPhase(snapshot,id,n) === "failed").length;
 // A failed node plus an aborted sibling alone is not proof of operator intent.
 if (evidence.get(snapshot)?.stopRequested && nodes.some(n => phaseOf(n) === "aborted") && nodes.every(n => !activeNode(n) && phaseOf(n) !== "queued")) return `已停止${failed ? ` · 含 ${failed} 项失败` : ""}`;
 if (snapshot.status === "running" && nodes.some(n => phaseOf(n) === "running" && n.observation?.supervision?.attention === "waiting_user")) return "等待用户处理";
 if (snapshot.status === "running" && failed) return "部分失败，其余继续";
 return ({ queued: "等待启动", running: "运行中", idle: "等待追加任务", stopping: "正在停止", complete: "已完成", failed: "未完成", stopped: "已停止", paused: "已暂停", waiting_input: "等待输入", needs_attention: "需要处理" })[snapshot.status];
}
export function errorSummary(error: string): string {
 const text = safeText(error);
 if (/runtime incompatible|does not support unlimited supervision v2/.test(text)) return "运行器不兼容，子任务未启动";
 if (text.includes("Runner exited without a durable final result") || text.includes("Runner exited but a complete final result is unavailable")) return "子任务已结束，但缺少最终结果，尚未验收";
 if (text === "Graph failed fast before this node started.") return "其他任务失败后，本任务未启动";
 if (/\b402\b/.test(text)) return "HTTP 402：额度或订阅不可用";
 if (/invalid_grant|refresh.token.*invalid/i.test(text)) return "当次执行时登录凭据失效";
 if (isAuthError(text)) return "当次请求未通过身份验证";
 if (/\b429\b/.test(text)) return "HTTP 429：请求受限，查看服务返回详情";
 if (/stream (?:ended|closed|disconnected)|request_timeout|terminated|ECONNRESET/i.test(text)) return "模型连接中断，未收到完整结果";
 return text;
}
export function localAuthLines(snapshot: GraphSnapshotV3, id: string, n: V3NodeProjection): string[] {
 const e = evidence.get(snapshot);
 if (!isAuthError(e?.failures[id] ?? n.observation?.supervision?.error ?? "")) return [];
 const auth = e?.localAuth?.[id];
 const heading = `本机当前登录记录${auth ? `（${auth.provider}）` : ""}`;
 const detail = auth?.state === "oauth_saved" ? `已保存登录凭据${auth.hasRefresh ? "和续期凭据" : ""}；当前有效性未验证。`
  : auth?.state === "api_key_saved" ? "已保存 API 密钥配置；当前有效性未验证。"
  : auth?.state === "missing" ? "未找到本机保存的凭据；可能使用环境变量或其他配置。"
  : "当前登录记录无法确认；不依据旧任务判断现在是否已登录。";
 return [heading,detail];
}
export function localTimestamp(value: string): string {
 const date = new Date(value);
 return Number.isNaN(date.getTime()) ? safeText(value) : date.toLocaleString("zh-CN", {hour12:false, timeZoneName:"short"});
}
export function nodeNextStep(snapshot: GraphSnapshotV3, id: string, n: V3NodeProjection): string | undefined {
 if (n.observation?.supervision?.attention === "result_unavailable") return "先核对运行器兼容性和已有结果；验收前不要重跑或写回。";
 const p = displayPhase(snapshot,id,n);
 if (p === "not_started" || p === "blocked") return "先处理失败的任务，再决定是否继续。";
 if (p !== "failed" && p !== "needs_attention") return undefined;
 const error = errorSummary(evidence.get(snapshot)?.failures[id] ?? n.observation?.supervision?.error ?? "");
 if (error === "运行器不兼容，子任务未启动") return "检查 pi-subagents 是否提供所需公开能力，再重新加载 Pi；子任务尚未启动。";
 if (error.includes("402")) return "检查该模型服务的额度或订阅；也可指定其他可用模型后重试。";
 if (isAuthError(evidence.get(snapshot)?.failures[id] ?? n.observation?.supervision?.error ?? "")) {
  const auth = evidence.get(snapshot)?.localAuth?.[id];
  if (auth?.state === "oauth_saved" || auth?.state === "api_key_saved") return "已保存凭据；不要仅凭这条历史错误重复登录。若后续请求仍失败，再检查对应服务的认证。";
  return "先检查当前 Pi 的登录或密钥配置；这条历史错误不能证明现在仍未登录。";
 }
 if (error.includes("429")) return "查看服务返回的重试提示，再决定何时重试。";
 return "按 l 查看原始记录，确认原因后再重试。";
}
export function nodeReason(snapshot: GraphSnapshotV3, id: string, n: V3NodeProjection): string {
 const phase = displayPhase(snapshot,id,n), s = n.observation?.supervision;
 const error = evidence.get(snapshot)?.failures[id] ?? s?.error;
 if (phase === "queued") {
  if (snapshot.status === "paused") return "Graph 已暂停，等待恢复";
  if (snapshot.status === "waiting_input") return "Graph 等待输入";
  if (s?.attention === "waiting_user") return "等待用户处理";
  const pending = (n.dependsOn ?? []).filter(task => !snapshot.nodes?.[task] || phaseOf(snapshot.nodes[task]!) !== "accepted");
  const describe = (task: string) => {
   const dependency = snapshot.nodes?.[task];
   return `${safeText(task)}（${dependency ? phaseLabel(dependency, snapshot, task) : "状态未观测到"}）`;
  };
  if (pending.length) {
   const ended = pending.some(task => snapshot.nodes?.[task] && ["failed","blocked","aborted","cancelled","skipped"].includes(phaseOf(snapshot.nodes[task]!)));
   return `${ended ? "前置任务未通过" : "等待前置任务"}：${pending.map(describe).join("、")}`;
  }
  return "等待调度";
 }
 if (phase === "not_started") return "其他任务失败后，本任务未启动";
 if (phase === "failed" || phase === "needs_attention") return error ? errorSummary(error) : "原因尚未记录，按 Enter 查看证据";
 if (phase === "blocked") return "前置任务未满足执行条件";
 if (phase === "aborted") {
  if (evidence.get(snapshot)?.neverDispatched.has(id)) return "停止前尚未派发";
  if (s?.attention === "result_unavailable") return "已停止：子任务已结束，但缺少最终结果，尚未验收";
  if (s?.error) return `已停止；停止前异常：${errorSummary(s.error)}`;
  if (s?.attention && s.attention !== "observation_unavailable") return `已停止；停止前：${attentionReason(s.attention)}`;
  return s?.processExitConfirmed ? "停止，进程退出已确认" : "执行已中止";
 }
 if (phase === "cancelled") return "任务已取消";
 if (phase === "skipped") return "执行条件不满足，已跳过";
 if (phase === "accepted") return "结果已验收";
 if (s?.attention) return attentionReason(s.attention) + (s.attention === "suspected_unresponsive" ? "，任务保持运行" : "");
 if (activeNode(n) && error) return `最近异常：${errorSummary(error)}`;
 if (n.observation?.progress?.currentTool) return `工具：${safeText(n.observation.progress.currentTool)}`;
 return ({ receiving: "接收模型响应", waiting_model: "等待模型响应", streaming_model: "接收模型响应", requesting: "等待模型响应", tool_running: "执行工具", retrying: "正在重试", starting: "正在启动", waiting_user: "等待用户处理" } as Record<string,string>)[s?.phase ?? ""] ?? (activeNode(n) ? `执行阶段：${safeText(s?.phase ?? n.phase)}` : "等待调度");
}
/** Display facts only: no clock is stored in Graph state or execution input. */
export function nodeActivityLines(n: V3NodeProjection, now = Date.now()): string[] {
 const o = n.observation, p = o?.progress;
 if (!o && ["queued", "prepared"].includes(phaseOf(n))) return [];
 const lines: string[] = [], missing: string[] = [];
 const timestamp = (at: string): string => {
  const time = Date.parse(at);
  return !Number.isFinite(time) ? "时间无效，待核对"
   : `${localTimestamp(at)}${Number.isFinite(now) && time > now ? "（时间晚于当前时钟，待核对）" : ""}`;
 };
 const model = safeText(o?.actualModel), tool = safeText(p?.currentTool), path = safeText(p?.currentPath);
 if (model) lines.push(`实际模型   ${model}`); else missing.push("实际模型");
 const current = activeNode(n) ? "当前" : "最后观测";
 if (tool) lines.push(`${current}工具   ${tool}`);

 if (path) lines.push(`${current}路径   ${path}`);
 if (p?.lastTool) lines.push(`最近完成工具   ${safeText(p.lastTool)}${p.lastToolAt ? ` · ${timestamp(p.lastToolAt)}` : ""}`);
 const count = p?.toolCount;
 if (Number.isSafeInteger(count) && count! >= 0) lines.push(`工具调用   ${count} 次`); else missing.push("工具调用次数");
 if (p?.lastActivityAt) lines.push(`最近活动   ${timestamp(p.lastActivityAt)}`); else missing.push("最近活动时间");
 const notes = [!tool && activeNode(n) ? "本次状态未报告正在执行的工具" : "", missing.length ? `本次观测未提供：${missing.join("、")}` : ""].filter(Boolean);
 if (notes.length) lines.push(notes.join("；"));
 return lines;
}
function attentionReason(attention: NonNullable<V3ChildSupervision["attention"]>): string {
 return ({ waiting_user: "等待用户处理", suspected_unresponsive: "疑似无响应", repeated_errors: "重复工具错误，需要检查", storage_error: "状态保存异常", observation_unavailable: "暂时无法读取监管状态", result_unavailable: "子任务已结束，但缺少最终结果，尚未验收", runtime_exited: "进程已退出，需要核对" })[attention];
}
export function compactGraphLines(snapshot: GraphSnapshotV3): string[] {
 const rows = orderedNodes(snapshot);
 const active = rows.filter(([,n]) => activeNode(n));
 // While work is running, only unresolved needs_attention and live issues on running nodes stay current causes; terminated failed/aborted history stays in the counts and /graphs details instead of misleading the present state.
 const stalePhase = new Set(["failed","accepted","cancelled","skipped","aborted","not_started"]);
 const issues = rows.filter(([id,n]) => (["failed","needs_attention"].includes(displayPhase(snapshot,id,n)) || n.observation?.supervision?.attention || (activeNode(n) && (evidence.get(snapshot)?.failures[id] || n.observation?.supervision?.error))) && displayPhase(snapshot,id,n) !== "accepted" && (!active.length || !stalePhase.has(displayPhase(snapshot,id,n))));
 const groups = new Map<string,number>();
 for (const [id,n] of issues) { const reason=nodeReason(snapshot,id,n); groups.set(reason,(groups.get(reason) ?? 0)+1); }
 const out = [`◆ Graph 摘要 · ${graphLabel(snapshot)} · ${counts(snapshot)}`];
 // Owned runtime observations are facts; omit unavailable fields and keep at most two task rows.
 if (active.length > 1) out.push(`  并行 ${active.length} 项`);
 const compact = (value: unknown, width: number) => safeText(truncateToWidth(safeText(value), width));
 for (const [id,n] of active.slice(0,2)) {
  const role = n.observation?.actualAgent ?? n.agent;
  const model = n.observation?.actualModel;
  const progress = n.observation?.progress;
  const tool = progress?.currentTool ?? progress?.lastTool;
  const facts = [compact(role || id,20), model ? compact(model,26) : "", tool ? `${progress?.currentTool ? "工具" : "最近工具"} ${compact(tool,12)}` : ""].filter(Boolean);
  out.push(`  当前：${facts.join(" · ")}`);
 }
 if (active.length > 2) out.push(`  另有 ${active.length-2} 项运行，/graphs 查看`);
 const readError = evidence.get(snapshot)?.readError;
 if (readError) out.push(`  详情读取异常：${safeText(readError)}（执行状态以已保存结果为准）`);
 const fallback = active.find(([,n]) => n.modelFallback)?.[1].modelFallback;
 if (fallback) out.push(`  模型接替：${fallback.reason === "quota" ? "额度用尽" : "模型不可用"} → ${safeText(fallback.to)}`);
 const waiting = active.some(([,n]) => n.observation?.supervision?.attention === "waiting_user");
 if (["paused", "waiting_input"].includes(snapshot.status) || waiting) {
  out.push(`  ${snapshot.status === "paused" ? "已暂停，等待恢复" : "等待用户处理"}`);
 } else if (["running", "queued"].includes(snapshot.status) && !rows.some(([,n]) => n.observation?.supervision?.attention || phaseOf(n) === "needs_attention")) {
  const queued = rows.filter(([id,n]) => displayPhase(snapshot,id,n) === "queued");
  const ready = queued.filter(([,n]) => n.dependsOn !== undefined && n.dependsOn.every(id => snapshot.nodes?.[id] && phaseOf(snapshot.nodes[id]) === "accepted"));
  const following = queued.filter(([,n]) => n.dependsOn?.length && n.dependsOn.some(id => active.some(([key]) => key === id)) && n.dependsOn.every(id => snapshot.nodes?.[id] && (phaseOf(snapshot.nodes[id]) === "accepted" || active.some(([key]) => key === id))));
  const candidates = ready.length ? ready : following;
  if (candidates.length === 1) out.push(`  下一项：${compact(candidates[0][0],40)}`);
  else if (candidates.length > 1) out.push(`  ${ready.length ? "就绪" : "后续可并行"} ${candidates.length} 项`);
 }
 const reasons = [...groups];
 const shown = active.length ? 1 : 2;
 for (const [reason,count] of reasons.slice(0,shown)) out.push(`  原因（${count} 项）：${reason}`);
 if (reasons.length > shown) out[out.length-1] += ` · 另有 ${reasons.length-shown} 类原因`;
 const limits = active.map(([,n]) => n.observation?.supervision?.runtimeLimit);
 const limit = limits.includes("configured") ? "存在配置时限" : limits.length && limits.every(x => x === "unlimited") ? "执行不限时" : "";
 out.push(`  /graphs 详情 · /graphs hide 收起${limit ? ` · ${limit}` : ""}`);
 return out;
}
export function colorCompactLine(line: string, index: number, theme: GraphTheme): string {
 return line.startsWith("◆ Graph") ? theme.bold(theme.fg(/未完成|部分失败|需要处理/.test(line) ? "warning" : /已完成/.test(line) ? "success" : "accent", line)) : /^\s+原因/.test(line) ? theme.fg("warning", line) : line.includes("/graphs") ? theme.fg("dim", line) : theme.fg("muted", line);
}
