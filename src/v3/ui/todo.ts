import {randomUUID} from 'node:crypto';
import {nodeProcessExit,nodeExitUnverified} from "./process-exit.ts";
import { readFileSync, statSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphSnapshotV3 } from "../types.ts";
import { safeText, phaseOf } from "./presentation.ts";

export const TODO_ENTRY = "pi-graph-todo/1";
export type TodoStatus = "pending" | "in_progress" | "blocked" | "done";
export interface TodoLink { graphId: string; runInstanceId: string; taskId: string }
export interface TodoItem { id: string; title: string; status: TodoStatus; links: TodoLink[]; dependsOn?: string[]; assignee?: string }
export interface TodoSnapshot { version: 1; revision: number; updatedAt: string; planId?: string; goal?: string; items: TodoItem[] }
export type TodoMutation = { action: "set"; expectedRevision: number; goal?:string; items: TodoItem[] } | { action: "update"; expectedRevision: number; id: string; title?: string; status?: TodoStatus; dependsOn?: string[]; assignee?: string } | { action: "link"; expectedRevision: number; id: string; links: TodoLink[] };
export interface TodoViewItem extends TodoItem { derivedStatus: TodoStatus | "unknown"; source: "人工" | "Graph验收"; reason?: string }
export interface TodoView { revision: number; planId?:string; goal?:string; items: TodoViewItem[]; persistence: "memory" | "durable" | "unconfirmed"; error?: string }
export type TodoManager = Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile" | "getBranch" | "getEntries">;
const statuses = new Set(["pending", "in_progress", "blocked", "done"]);
function object(value: unknown, keys: string[]): Record<string, any> {
 if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error("计划结构无效或包含未知字段");
 return value as Record<string, any>;
}
function id(value: unknown): string {
 if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) || value.includes("..")) throw new Error("计划或关联 ID 无效（不接受路径或 URL）");
 return value;
}
function title(value: unknown): string {
 if (typeof value !== "string" || !value.trim() || [...value].length > 400) throw new Error("计划标题须为1至400字符");
 if (safeText(value) !== value.trim()) throw new Error("计划标题不得含终端控制字符或换行");
 return value.trim();
}
function status(value: unknown): TodoStatus { if (!statuses.has(value as string)) throw new Error("计划状态无效"); return value as TodoStatus; }
export function validateLinks(value: unknown): TodoLink[] {
 if (!Array.isArray(value) || value.length > 128) throw new Error("关联须为最多128项的数组");
 const links = value.map(v => { const x = object(v,["graphId","runInstanceId","taskId"]); return {graphId:id(x.graphId),runInstanceId:id(x.runInstanceId),taskId:id(x.taskId)}; });
 if (new Set(links.map(x => JSON.stringify(x))).size !== links.length) throw new Error("关联不能重复");
 return links;
}
export function validateItems(value: unknown): TodoItem[] {
 if (!Array.isArray(value) || value.length > 128) throw new Error("总计划最多128项");
 const items = value.map(v => { const x=object(v,["id","title","status","links","dependsOn","assignee"]); if(x.dependsOn!==undefined&&(!Array.isArray(x.dependsOn)||x.dependsOn.length>128))throw new Error("计划依赖须为最多128项的数组"); const dependsOn=x.dependsOn?.map(id); if(dependsOn&&new Set(dependsOn).size!==dependsOn.length)throw new Error("计划依赖不能重复"); return {id:id(x.id),title:title(x.title),status:status(x.status),links:validateLinks(x.links ?? []),...(dependsOn!==undefined?{dependsOn}:{}),...(x.assignee!==undefined?{assignee:id(x.assignee)}:{})}; });
 if (new Set(items.map(x=>x.id)).size !== items.length) throw new Error("计划 ID 不能重复");
 const byId=new Map(items.map(i=>[i.id,i]));const visiting=new Set<string>(),done=new Set<string>();
 const visit=(key:string)=>{if(visiting.has(key))throw new Error("计划依赖不能成环或自引用");if(done.has(key))return;const item=byId.get(key);if(!item)throw new Error("计划依赖引用不存在");visiting.add(key);for(const dep of item.dependsOn??[])visit(dep);visiting.delete(key);done.add(key);};for(const item of items)visit(item.id);
 return items;
}
export function validateTodoSnapshot(value: unknown): TodoSnapshot {
 const x=object(value,["version","revision","updatedAt","items","planId","goal"]);
 if (x.version !== 1 || !Number.isSafeInteger(x.revision) || x.revision < 1 || typeof x.updatedAt !== "string" || !Number.isFinite(Date.parse(x.updatedAt))) throw new Error("计划快照版本、修订号或时间无效");
 return {version:1,revision:x.revision,updatedAt:x.updatedAt,...(x.planId!==undefined?{planId:id(x.planId)}:{}),...(x.goal!==undefined?{goal:title(x.goal)}:{}),items:validateItems(x.items)};
}
export function reduceTodo(current: TodoItem[], revision: number, input: unknown): TodoItem[] {
 const x=object(input,["action","expectedRevision","items","id","title","status","links","dependsOn","assignee","goal","bindings"]);
 if (!Number.isSafeInteger(x.expectedRevision) || x.expectedRevision !== revision) throw new Error(`计划版本冲突：当前 revision=${revision}；先 list 再更新`);
 if (revision >= Number.MAX_SAFE_INTEGER) throw new Error("计划修订号已达上限");
 if (x.action === "set") { object(x,["action","expectedRevision","items","goal"]);if(x.goal!==undefined)title(x.goal); return validateItems(x.items); }
 if(x.action==="linkBatch"){
  object(x,["action","expectedRevision","bindings"]);if(!Array.isArray(x.bindings)||!x.bindings.length||x.bindings.length>128)throw Error("批量关联数量无效");
  const items=structuredClone(current),seen=new Set<string>();for(const raw of x.bindings){const b=object(raw,["id","links","assignee"]),key=id(b.id);if(seen.has(key))throw Error("批量关联计划项重复");seen.add(key);const item=items.find(i=>i.id===key);if(!item)throw Error("找不到计划项");const links=validateLinks(b.links);item.links=validateLinks([...new Map([...item.links,...links].map(l=>[JSON.stringify(l),l])).values()]);if(b.assignee!==undefined&&item.assignee===undefined)item.assignee=id(b.assignee);}
  return validateItems(items);
 }
 if (x.action !== "update" && x.action !== "link") throw new Error("未知计划操作");
 object(x,x.action === "link" ? ["action","expectedRevision","id","links"] : ["action","expectedRevision","id","title","status","dependsOn","assignee"]);
 const key=id(x.id), items=structuredClone(current), item=items.find(i=>i.id===key);
 if (!item) throw new Error("找不到计划项");
 if (x.action === "link") item.links=validateLinks(x.links);
 else { if(x.title===undefined&&x.status===undefined&&x.dependsOn===undefined&&x.assignee===undefined)throw new Error("update需要title/status/dependsOn/assignee"); if(x.title!==undefined)item.title=title(x.title);if(x.status!==undefined)item.status=status(x.status);if(x.dependsOn!==undefined)item.dependsOn=x.dependsOn;if(x.assignee!==undefined)item.assignee=x.assignee; }
 return validateItems(items);
}
export function restoreTodo(manager: TodoManager): { snapshot?: TodoSnapshot; revision: number; error?: string } {
 let revision=0, snapshot:TodoSnapshot|undefined;
 for(const e of manager.getEntries())if(e.type==="custom"&&e.customType===TODO_ENTRY){try{revision=Math.max(revision,validateTodoSnapshot(e.data).revision);}catch{ /* other branches never supply content */ }}
 const branch=manager.getBranch();
 for(let i=branch.length-1;i>=0;i--){const e=branch[i];if(e.type==="custom"&&e.customType===TODO_ENTRY){try{snapshot=validateTodoSnapshot(e.data);}catch{return {revision,error:"当前分支最新计划记录损坏或版本不支持，不能沿用旧完成状态"};}break;}}
 return {snapshot,revision};
}
export class TodoPersistence {
 private cached?:{key:string;value:TodoView["persistence"]};
 constructor(private read:(path:string)=>string=path=>readFileSync(path,"utf8")){}
 clear(){this.cached=undefined;}
 get(manager:TodoManager,snapshot?:TodoSnapshot):TodoView["persistence"]{
  const path=manager.getSessionFile();if(!path||!snapshot)return "memory";
  try {const st=statSync(path),key=JSON.stringify([manager.getSessionId(),path,st.ino,st.size,st.mtimeMs,st.ctimeMs,snapshot]);if(this.cached?.key===key)return this.cached.value;
   const value=this.read(path).split("\n").some(line=>{try{const e=JSON.parse(line);return e.type==="custom"&&e.customType===TODO_ENTRY&&JSON.stringify(e.data)===JSON.stringify(snapshot);}catch{return false;}})?"durable":"unconfirmed";
   this.cached={key,value};return value;
  }catch(e){return (e as NodeJS.ErrnoException).code==="ENOENT"?"memory":"unconfirmed";}
 }
}
export async function projectTodo(items: TodoItem[], sessionId: string, read: (link: TodoLink)=>Promise<GraphSnapshotV3>): Promise<TodoViewItem[]> {
 const cache=new Map<string,Promise<GraphSnapshotV3>>();
 const projected:TodoViewItem[]=await Promise.all(items.map(async item=>{
  if(!item.links.length)return {...item,source:"人工" as const,derivedStatus:item.status};
  try {
   const nodes=await Promise.all(item.links.map(async link=>{
    const key=JSON.stringify([link.graphId,link.runInstanceId]);let promise=cache.get(key);if(!promise){promise=read(link);cache.set(key,promise);}const s=await promise;
    if(s.sessionId!==sessionId||s.graphId!==link.graphId||s.runInstanceId!==link.runInstanceId||!s.nodes?.[link.taskId])throw new Error("关联任务缺失、会话不符或运行实例已变化");
    const n=s.nodes[link.taskId];if(!Number.isSafeInteger(n.attempt)||n.attempt<0)throw new Error("关联任务尝试记录无效");return {s,n};
   }));
   if(nodes.some(({n})=>nodeExitUnverified(n)))throw new Error("退出证据未核实，Graph 状态待核对");
   const phases=nodes.map(({n})=>phaseOf(n));
   const derivedStatus=phases.every(p=>p==="accepted")?"done":nodes.some(({s,n})=>nodeProcessExit(n)||["failed","needs_attention","blocked","aborted","cancelled","skipped"].includes(phaseOf(n))||n.observation?.supervision?.attention||["stopped","failed"].includes(s.status)&&phaseOf(n)!=="accepted")?"blocked":phases.some(p=>["prepared","dispatched","running","verifying","applying"].includes(p))?"in_progress":"pending";
   return {...item,source:"Graph验收" as const,derivedStatus};
  }catch(error){return {...item,source:"Graph验收" as const,derivedStatus:"unknown" as const,reason:safeText(error instanceof Error?error.message:error)};}
 }));
 const byId=new Map(projected.map(i=>[i.id,i])),assessed=new Set<string>();
 const assess=(item:TodoViewItem):void=>{if(assessed.has(item.id))return;assessed.add(item.id);for(const key of item.dependsOn??[]){const dep=byId.get(key);if(dep)assess(dep);}const pending=(item.dependsOn??[]).filter(key=>byId.get(key)?.derivedStatus!=="done");if(pending.length&&item.derivedStatus==="pending"){item.derivedStatus="blocked";item.reason=`计划前置项未完成：${pending.map(key=>byId.get(key)?.title??key).join("、")}`;}};for(const item of projected)assess(item);
 return projected;
}
export class TodoReadSupersededError extends Error { constructor(){super("计划读取已过期，已丢弃旧结果");this.name="TodoReadSupersededError";} }
/** Session-local UI/controller state, never a second durable store. */
export class TodoController {
 private generation=0; private identity=""; private closed=false; private viewSequence=0; private persistence=new TodoPersistence();
 private key(manager:TodoManager){return JSON.stringify([manager.getSessionId(),manager.getSessionFile()??null]);}
 activate(manager:TodoManager){this.closed=false;this.identity=this.key(manager);this.generation++;this.viewSequence++;this.persistence.clear();}
 invalidate(){this.closed=true;this.generation++;this.viewSequence++;this.persistence.clear();}
 private branch(manager:TodoManager){return JSON.stringify(manager.getBranch().map((e:any)=>e.id??[e.type,e.customType,e.data]));}
 private token(manager:TodoManager){if(this.closed)throw new Error("计划会话已关闭");if(this.identity!==this.key(manager))this.activate(manager);return {generation:this.generation,key:this.identity,branch:this.branch(manager)};}
 private check(manager:TodoManager, token:{generation:number;key:string;branch:string}){if(this.closed||this.generation!==token.generation||this.identity!==token.key||this.key(manager)!==token.key||this.branch(manager)!==token.branch)throw new Error("请求已过期：会话或分支已切换，已丢弃旧计划请求");}
 fence(manager:TodoManager,requireRevision=true){const token=this.token(manager),state=restoreTodo(manager);if(state.error&&requireRevision)throw Error(state.error);return {scope:JSON.stringify(token),revision:state.revision,assert:()=>{this.check(manager,token);const latest=restoreTodo(manager);if(latest.error&&requireRevision)throw Error(latest.error);if(requireRevision&&latest.revision!==state.revision)throw Error("计划版本冲突：派发期间计划已变化；先list核对");}};}
 async view(manager:TodoManager, read:(link:TodoLink)=>Promise<GraphSnapshotV3>):Promise<TodoView>{
  const token=this.token(manager), sequence=++this.viewSequence, state=restoreTodo(manager);if(state.error)return {revision:state.revision,items:[],persistence:"unconfirmed",error:state.error};
  const items=await projectTodo(state.snapshot?.items??[],manager.getSessionId(),read);this.check(manager,token);
  if(sequence!==this.viewSequence||restoreTodo(manager).revision!==state.revision)throw new TodoReadSupersededError();
  return {revision:state.revision,...(state.snapshot?.planId?{planId:state.snapshot.planId}:{}),...(state.snapshot?.goal?{goal:state.snapshot.goal}:{}),items,persistence:this.persistence.get(manager,state.snapshot)};
 }
 async mutate(manager:TodoManager,input:unknown,read:(link:TodoLink)=>Promise<GraphSnapshotV3>,append:((type:string,data:TodoSnapshot)=>void)|undefined,assertActive?:()=>void):Promise<TodoView>{
  const token=this.token(manager),state=restoreTodo(manager);this.viewSequence++;if(state.error)throw new Error(state.error);if(!append)throw new Error("宿主不支持appendEntry；计划保持只读");
  const items=reduceTodo(state.snapshot?.items??[],state.revision,input),projected=await projectTodo(items,manager.getSessionId(),read);
  if(projected.some(i=>i.derivedStatus==="unknown"))throw new Error("关联尚未核实，未保存计划；请核对当前会话的Graph/run/task");
  this.check(manager,token);const latest=restoreTodo(manager);if(latest.error)throw new Error(latest.error);reduceTodo(latest.snapshot?.items??[],latest.revision,input);
  const snapshot:TodoSnapshot={version:1,revision:latest.revision+1,updatedAt:new Date().toISOString(),...((input as any).action==="set"?{planId:randomUUID(),...((input as any).goal!==undefined?{goal:title((input as any).goal)}:{})}:{...(latest.snapshot?.planId?{planId:latest.snapshot.planId}:{}),...(latest.snapshot?.goal?{goal:latest.snapshot.goal}:{})}),items};
  assertActive?.();
  // No await from the final session/CAS check through the native append.
  this.viewSequence++;this.persistence.clear();
  try{append(TODO_ENTRY,snapshot);}catch{const recovered=restoreTodo(manager);return {revision:recovered.revision,items:[],persistence:"unconfirmed",error:"计划保存未确认：宿主可能已更新内存。先list核对，不自动重试"};}
  return {revision:snapshot.revision,...(snapshot.planId?{planId:snapshot.planId}:{}),...(snapshot.goal?{goal:snapshot.goal}:{}),items:projected,persistence:this.persistence.get(manager,snapshot)};
 }
}
/** Join concurrent display reads so a slow filesystem read cannot be starved by UI polling. */
export class TodoReadCoordinator {
 private pending?:{key:string;promise:Promise<TodoView>};
 read(key:string,work:()=>Promise<TodoView>):Promise<TodoView>{
  if(this.pending?.key===key)return this.pending.promise;
  const promise=work().finally(()=>{if(this.pending?.promise===promise)this.pending=undefined;});
  this.pending={key,promise};return promise;
 }
}
