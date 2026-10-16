import {safeText} from "./presentation.ts";
type RecordValue = Record<string, unknown>;
const detailEntry = "展开查看详情。";
function record(value: unknown): value is RecordValue {
 return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parse(text: string): RecordValue | undefined {
 // Rendering must stay bounded even when a caller supplies a full log.
 if (text.length > 32768) return;
 try { const value: unknown = JSON.parse(text); return record(value) ? value : undefined; } catch { return; }
}
function count(value: unknown): number | undefined {
 return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}
function hasNext(value: RecordValue | undefined): boolean {
 return count(value?.nextOffset) !== undefined || record(value?.nextRequest);
}
function completePage(value: RecordValue | undefined): RecordValue | undefined {
 if (typeof value?.text !== "string" || value.offset !== 0 || value.nextOffset !== null) return;
 return parse(value.text);
}
function readableError(text: string, body: RecordValue | undefined): string {
 const raw = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : text;
 const translations: Array<[RegExp, string]> = [
  [/owner mismatch|identity.*no longer active|identity.*mismatch|not authorized/i, "当前会话无权访问这项信息。"],
  [/inactive mailbox.*read-only/i, "邮箱不活动，仅可读取，不能继续发送。"],
  [/source.*missing|result evidence missing|message unavailable|result unavailable/i, "所需记录暂不可用。"],
  [/recipient.*closed|recipient.*stale/i, "收件任务已结束或已进入新的执行轮次。"],
  [/idempotency conflict/i, "这次消息与先前发送的内容不一致。"],
  [/limit must be|invalid page offset|invalid offset|expectedSha256 must/i, "读取参数不符合要求。"],
  [/digest mismatch|failed verification|full output differs/i, "结果记录校验未通过。"],
  [/mailbox unavailable|disconnected before response|state unknown/i, "通信暂不可用，消息是否送达仍需确认。"],
 ];
 for (const [pattern, label] of translations) if (pattern.test(raw)) return label;
 // Keep a genuine plain-text reason, while machine envelopes stay in expansion.
 if (body || /^[\s]*[\[{]/u.test(raw)) return "操作未完成。";
 const line = raw.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x1f\x7f]/g, " ").replace(/\b[a-fA-F0-9]{32,}\b/g, "[标识已隐藏]")
  .replace(/\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b/g, "[标识已隐藏]")
  .replace(/\b(?:graph|owned|run)-[A-Za-z0-9._-]{12,}\b/g, "[标识已隐藏]")
  .replace(/(?:\/Users\/|\/private\/|\/var\/|\/tmp\/|~\/)[^\s"'<>]+/g, "[路径已隐藏]")
  .replace(/\s+/g, " ").trim();
 const characters = Array.from(line);
 return characters.length ? characters.slice(0, 120).join("") + (characters.length > 120 ? "…" : "") : "操作未完成。";
}

/** Display-only receipt. The caller retains the exact original content for expansion. */
export function compactToolReceipt(action: string, text: string, details: unknown, isError: boolean): string {
 const metadata = record(details) ? details : undefined;
 const body = parse(text);
 if(metadata?.code === "mailbox_inactive" || body?.code === "mailbox_inactive") {
  return (metadata?.taskEnded === true || body?.taskEnded === true)
   ? "任务已结束，消息未发送；请把后续要求交给主会话。不可自动重试，不会重启旧任务。展开查看详情。"
   : "当前邮箱只读，消息未发送；请核对运行状态。不可自动重试，不会自动重启或重发。展开查看详情。";
 }
 if (metadata?.code === "source_changed" || body?.code === "source_changed") {
  return "读取快照已更新或失效，请从第一页重新读取。展开查看重读入口。";
 }
 if (isError) return `读取或操作未完成：${readableError(text, body)} ${detailEntry}`;
 if (action === "attention") {
  const payload = completePage(body) ?? (Array.isArray(body?.requests) ? body : undefined);
  const advertised = count(metadata?.requestCount);
  const actual = Array.isArray(payload?.requests) ? payload.requests.length : undefined;
  if (advertised !== undefined && actual !== undefined && advertised !== actual) return `待处理信息已返回，数量需核对。${detailEntry}`;
  const total = advertised ?? actual;
  if (total === 0) return `本次读取没有待处理事项。${detailEntry}`;
  if (total !== undefined) return `待处理事项：${total} 项。${detailEntry}`;
  return `待处理信息已读取${hasNext(body) ? "，仍有后续内容" : ""}。${detailEntry}`;
 }
 if (action === "mailbox") {
  if (Array.isArray(body?.messages)) {
   const amount = body.messages.length;
   if (!amount) return `${body.pending === true ? "暂未收到新消息" : "本页没有消息"}。${detailEntry}`;
   return `本页收到 ${amount} 条消息${hasNext(body) ? "，仍有后续内容" : ""}。${detailEntry}`;
  }
  if (typeof body?.text === "string") return `消息正文已读取${hasNext(body) ? "，仍有后续内容" : ""}。${detailEntry}`;
  const stateLabels: Record<string, string> = {
   queued: "消息已入队", delivered: "消息已送达", acknowledged: "消息已确认", replied: "消息已回复",
   recipient_closed: "收件任务已结束", stale_attempt: "消息属于较早的执行轮次",
  };
  if (typeof body?.state === "string" && stateLabels[body.state]) return `${stateLabels[body.state]}。${detailEntry}`;
  return `邮箱信息已返回。${detailEntry}`;
 }
 if (action === "result") {
  if (hasNext(body) || hasNext(metadata)) return `结果片段已读取，仍有后续内容。${detailEntry}`;
  if (body?.complete === false) return `结果已读取，记录不完整。${detailEntry}`;
  if (body?.complete === null) return `结果已读取，完整性尚未确认。${detailEntry}`;
  const preview=typeof body?.text==="string"?body.text.split("\n").slice(0,6).map(line=>safeText(line).slice(0,240)).join("\n"):"";
  return preview?`${preview}\n结果已读取 · 验收待确认 · ${detailEntry}`:`结果已读取 · 验收待确认。${detailEntry}`;
 }
 return `操作信息已返回。${detailEntry}`;
}
