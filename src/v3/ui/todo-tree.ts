/** Structural plan projection only. No session, Graph, runtime or terminal state. */
export const MAX_TODO_ITEMS = 128;
export const MAX_TODO_DEPTH = 8;
export interface TodoTreeItem { readonly id: string; readonly parentId?: string }
export interface TodoTree<T extends TodoTreeItem = TodoTreeItem> {
 readonly roots: readonly string[];
 readonly preorder: readonly string[];
 readonly byId: ReadonlyMap<string, T>;
 readonly childrenById: ReadonlyMap<string, readonly string[]>;
 readonly parentById: ReadonlyMap<string, string | undefined>;
 readonly depthById: ReadonlyMap<string, number>;
 /** Stable sibling ordinals, without a leading #; root depth is 1. */
 readonly numberById: ReadonlyMap<string, string>;
 readonly groupIds: ReadonlySet<string>;
 readonly leafIds: readonly string[];
 ancestorIds(id: string): readonly string[];
 descendantLeafIds(id: string): readonly string[];
}
export function buildTodoTree<T extends TodoTreeItem>(items: readonly T[]): TodoTree<T> {
 if (!Array.isArray(items) || items.length > MAX_TODO_ITEMS) throw new Error("总计划最多128项（含分组）");
 const byId = new Map<string,T>();
 for (const item of items) {
  if (!item || typeof item.id !== "string" || !item.id || byId.has(item.id)) throw new Error("计划 ID 重复或无效");
  if (item.parentId !== undefined && (typeof item.parentId !== "string" || !item.parentId)) throw new Error("父项 ID 无效");
  byId.set(item.id,item);
 }
 const children = new Map<string,string[]>(items.map(item=>[item.id,[]]));
 const parents = new Map<string,string|undefined>();
 const roots:string[]=[];
 for (const item of items) {
  parents.set(item.id,item.parentId);
  if (item.parentId === undefined) roots.push(item.id);
  else {
   if (!byId.has(item.parentId)) throw new Error("计划父项不存在");
   if (item.parentId === item.id) throw new Error("计划父子关系不能成环或自引用");
   children.get(item.parentId)!.push(item.id);
  }
 }
 const depths=new Map<string,number>(),visiting=new Set<string>();
 const depth=(id:string):number=>{
  if (depths.has(id)) return depths.get(id)!;
  if (visiting.has(id)) throw new Error("计划父子关系不能成环或自引用");
  visiting.add(id);
  const parent=parents.get(id),n=parent===undefined?1:depth(parent)+1;
  if (n>MAX_TODO_DEPTH) throw new Error("计划最多8层任务项（总目标不计层数）");
  visiting.delete(id);depths.set(id,n);return n;
 };
 for (const item of items) depth(item.id);
 const preorder:string[]=[],numbers=new Map<string,string>();
 const walk=(ids:readonly string[],prefix=""):void=>{ids.forEach((id,index)=>{numbers.set(id,prefix+String(index+1));preorder.push(id);walk(children.get(id)!,numbers.get(id)+".");});};
 walk(roots);
 const groupIds=new Set(items.filter(item=>children.get(item.id)!.length>0).map(item=>item.id));
 const leafIds=preorder.filter(id=>!groupIds.has(id));
 const ancestorIds=(id:string):readonly string[]=>{
  if(!byId.has(id))throw new Error("计划项不存在");
  const chain:string[]=[];let parent=parents.get(id);while(parent!==undefined){chain.unshift(parent);parent=parents.get(parent);}return chain;
 };
 const descendantLeafIds=(id:string):readonly string[]=>{
  if(!byId.has(id))throw new Error("计划项不存在");
  const result:string[]=[];const visit=(key:string):void=>{const childIds=children.get(key)!;if(!childIds.length)result.push(key);else childIds.forEach(visit);};visit(id);return result;
 };
 return {roots,preorder,byId,childrenById:children,parentById:parents,depthById:depths,numberById:numbers,groupIds,leafIds,ancestorIds,descendantLeafIds};
}
