import { createHash } from "node:crypto";
import { canonicalJson } from "./digests.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
type Message = Record<string, any>;
export function builtinContextTools(tools: readonly any[]): Set<string> {
 return new Set(tools.filter(t => READ_TOOLS.has(t.name) && t.sourceInfo?.source === "builtin"
  && [`builtin:${t.name}`, `<builtin:${t.name}>`].includes(t.sourceInfo?.path) && t.sourceInfo?.scope === "temporary"
  && t.sourceInfo?.origin === "top-level").map(t => t.name));
}
function exactJson(value: unknown): string | undefined {
 try {
  const validate = (v: any): boolean => v === null || typeof v === "string" || typeof v === "boolean"
   || (typeof v === "number" && Number.isFinite(v))
   || (Array.isArray(v) ? v.every(validate) : typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype && !Object.hasOwn(v,"__proto__") && Object.values(v).every(validate));
  if (!validate(value)) return;
  return canonicalJson(value);
 } catch { return; }
}
/** Per-call projection only. Never mutate input, skip execution, or remember previous contexts. */
export function projectGraphContext<T>(messages: T[], builtinTools: ReadonlySet<string>): T[] {
 const input = messages as Message[], calls = new Map<string, {name:string; args:string; index:number}>(), invalid = new Set<string>();
 for (let i=0;i<input.length;i++) {
  const m=input[i]; if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
  for (const c of m.content) if(c?.type === "toolCall" && typeof c.id === "string") {
   if (calls.has(c.id)) invalid.add(c.id);
   const args=exactJson(c.arguments);
   if(args !== undefined) calls.set(c.id,{name:c.name,args,index:i}); else invalid.add(c.id);
  }
 }
 const resultCounts=new Map<string,number>();
 for(const m of input) if(m.role === "toolResult") resultCounts.set(m.toolCallId,(resultCounts.get(m.toolCallId)??0)+1);
 const anchors=new Map<string,{index:number;id:string}>(); let output:Message[]|undefined;
 for(let i=0;i<input.length;i++) {
  const m=input[i],call=calls.get(m.toolCallId);
  if(m.role!=="toolResult" || m.isError!==false || !call || call.index>=i || invalid.has(m.toolCallId) || resultCounts.get(m.toolCallId)!==1
   || call.name!==m.toolName || !builtinTools.has(m.toolName) || !Array.isArray(m.content) || !m.content.length
   || !m.content.every((c:any)=>c?.type==="text" && typeof c.text==="string" && Object.keys(c).every(k=>k==="type"||k==="text"))) continue;
  const serialized=JSON.stringify(m.content), bytes=Buffer.byteLength(serialized);
  if(bytes<2048) continue;
  const key=canonicalJson([m.toolName,call.args,m.content]);
  const anchor=anchors.get(key);
  if(!anchor){anchors.set(key,{index:i,id:createHash("sha256").update(key).digest("hex")});continue;}
  const replacement=`[graph-context-repeat anchor:${anchor.id} bytes:${bytes}]`;
  if(Buffer.byteLength(replacement)>=bytes)continue;
  output??=input.slice();
  if(output[anchor.index]===input[anchor.index]) output[anchor.index]={...input[anchor.index],content:[{type:"text",text:`[graph-context-anchor:${anchor.id}]`},...structuredClone(input[anchor.index].content)]};
  output[i]={...m,content:[{type:"text",text:replacement}]};
 }
 return (output??messages) as T[];
}
