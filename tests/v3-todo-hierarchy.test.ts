import test from "node:test";
import assert from "node:assert/strict";
import {createJiti} from "jiti";
const jiti=createJiti(import.meta.url);
const {validateItems,validateTodoSnapshot,reduceTodo,projectTodo,TodoController,TODO_ENTRY,restoreTodo}=await jiti.import<any>("../src/v3/ui/todo.ts");
const {GraphTodoSchema,registerGraphTodo}=await jiti.import<any>("../extensions/graph-todo.ts");
const {validateTodoBinding,validateBindingNodes,planContext}=await jiti.import<any>("../src/v3/plan-flow.ts");
const {Check}=await jiti.import<any>("typebox/value");
const item=(id:string,parentId?:string,extra:any={})=>({id,title:"任务 "+id,status:"pending",links:[],...(parentId?{parentId}:{}),...extra});
const link={graphId:"graph",runInstanceId:"run",taskId:"accepted"};
const snap=(extra:any={})=>({graphId:"graph",runInstanceId:"run",sessionId:"owner",status:"running",nodes:{accepted:{phase:"accepted",attempt:1},running:{phase:"running",attempt:1}},...extra});
const read=async()=>snap();
function memory(){const entries:any[]=[];let branch=entries,session="owner";return{getSessionId:()=>session,getSessionFile:()=>undefined,getBranch:()=>branch,getEntries:()=>entries,append(t:string,data:any){const e={id:String(entries.length),type:"custom",customType:t,data};entries.push(e);if(branch!==entries)branch.push(e);},branch(v:any[]){branch=v;},switch(){session="other";},entries};}
test("schema adds only optional parentId and update null; records keep strict v1 and flat shape",()=>{
 const flat=[item("plain")];assert.deepEqual(validateItems(flat),flat);assert.equal("parentId" in validateItems(flat)[0],false);
 assert.ok(Check(GraphTodoSchema,{action:"set",expectedRevision:0,items:[item("g"),item("a","g")]}));assert.ok(Check(GraphTodoSchema,{action:"update",expectedRevision:1,id:"a",parentId:null}));assert.equal(Check(GraphTodoSchema,{action:"set",expectedRevision:0,items:[item("a",undefined,{parentId:null})]}),false);
 const record={version:1,revision:1,updatedAt:new Date().toISOString(),items:flat};assert.deepEqual(validateTodoSnapshot(record),record);assert.throws(()=>validateTodoSnapshot({...record,items:[{...flat[0],children:[]}]}),/未知字段/);
});
test("group execution fields, group dependency targets and invalid forests fail before mutation",()=>{
 const base=[item("g"),item("a","g"),item("b")];
 for(const extra of [{status:"done"},{status:"blocked"},{status:"in_progress"},{assignee:"parent"},{links:[link]},{dependsOn:["b"]}])assert.throws(()=>validateItems([{...base[0],...extra},...base.slice(1)]),/分组/);
 assert.throws(()=>validateItems([item("g"),item("a","g"),item("b",undefined,{dependsOn:["g"]})]),/叶项/);
 for(const entries of [[item("a","missing")],[item("a","a")],[item("a","b"),item("b","a")],[item("g"),item("a","g",{dependsOn:["b"]}),item("b",undefined,{dependsOn:["a"]})]])assert.throws(()=>validateItems(entries));
 const valid=validateItems([item("g"),item("a","g"),item("b",undefined,{dependsOn:["a"]})]);assert.equal(valid[2].dependsOn[0],"a");
});
test("reparent is explicit, null clears parent, omitted preserves it; emptying old group requires set",()=>{
 const items=validateItems([item("g"),item("a","g"),item("b","g"),item("h"),item("c","h")]);const before=JSON.stringify(items);
 const moved=reduceTodo(items,2,{action:"update",expectedRevision:2,id:"a",parentId:"h"});assert.equal(moved[1].parentId,"h");
 const rooted=reduceTodo(moved,3,{action:"update",expectedRevision:3,id:"a",parentId:null});assert.equal(Object.hasOwn(rooted[1],"parentId"),false);
 assert.equal(reduceTodo(items,2,{action:"update",expectedRevision:2,id:"a",title:"renamed"})[1].parentId,"g");
 assert.throws(()=>reduceTodo(moved,3,{action:"update",expectedRevision:3,id:"b",parentId:null}),/最后一个/);
 assert.throws(()=>reduceTodo(items,2,{action:"update",expectedRevision:2,id:"g",parentId:"a"}),/成环/);
 assert.throws(()=>reduceTodo(items,2,{action:"set",expectedRevision:2,items:items.filter((i:any)=>i.id!=="g")}),/父项不存在/);
 const reset=reduceTodo(items,2,{action:"set",expectedRevision:2,items:[item("a"),item("b"),item("h"),item("c","h")]});assert.equal(reset.length,4);assert.equal(JSON.stringify(items),before);
});
test("adding children cannot silently convert linked or manually completed/owned leaves into groups",()=>{
 for(const extra of [{links:[link]},{status:"done"},{status:"in_progress"},{status:"blocked"},{assignee:"root"},{dependsOn:["child"]}]){
  const current=[item("parent",undefined,extra),item("child")];assert.throws(()=>reduceTodo(current,1,{action:"update",expectedRevision:1,id:"child",parentId:"parent"}),/分组|成环/);
 }
});
test("all group link and binding paths reject even an empty direct link request",async()=>{
 const items=validateItems([item("g"),item("a","g")]),view={revision:1,persistence:"memory",items:await projectTodo(items,"owner",read)};
 for(const params of [{action:"link",id:"g",links:[]},{action:"link",id:"g",links:[link]},{action:"linkBatch",bindings:[{id:"a",links:[link]},{id:"g",links:[]}]}])assert.throws(()=>reduceTodo(items,1,{expectedRevision:1,...params}),/分组/);
 assert.throws(()=>validateTodoBinding({expectedRevision:1,bindings:[{todoId:"g",taskIds:["work"]}]},view),/叶项/);
 assert.throws(()=>validateBindingNodes({expectedRevision:1,bindings:[{todoId:"g",taskIds:["work"]}]},view,[{taskId:"work"}]),/叶项/);
 assert.throws(()=>reduceTodo(items,1,{action:"update",expectedRevision:1,id:"g",status:"done"}),/分组/);
});
test("three-level group progress counts distinct descendant leaves, not ancestor groups; healthy waits stay neutral",async()=>{
 const items=validateItems([item("goal"),item("group-a","goal"),item("manual","group-a",{status:"done",assignee:"parent"}),item("accepted","group-a",{links:[link]}),item("group-b","goal"),item("running","group-b",{links:[{...link,taskId:"running"}]}),item("waiting","group-b",{dependsOn:["running"]})]);const before=JSON.stringify(items);let reads=0;
 const v=await projectTodo(items,"owner",async()=>{reads++;return snap();});const root=v.find((i:any)=>i.id==="goal"),a=v.find((i:any)=>i.id==="group-a"),b=v.find((i:any)=>i.id==="group-b");
 assert.deepEqual(root.rollup,{total:4,done:2,manualDone:1,running:1,waiting:1,blocked:0,unknown:0});assert.equal(root.derivedStatus,"in_progress");assert.equal(root.source,"分组汇总");assert.equal(a.rollup.total,2);assert.equal(a.derivedStatus,"done");assert.equal(b.rollup.total,2);assert.equal(reads,1);assert.equal(JSON.stringify(items),before);assert.equal(root.links.length,0);assert.equal(root.status,"pending");
});
test("healthy multi-hop dependencies use computed state, not spoofable reason text; unknown never becomes completed",async()=>{
 const rows=validateItems([item("g"),item("run","g",{status:"in_progress"}),item("wait","g",{dependsOn:["run"]}),item("later","g",{dependsOn:["wait"]})]);let v=await projectTodo(rows,"owner",read);assert.equal(v[0].rollup.waiting,2);assert.equal(v[0].rollup.blocked,0);assert.equal(v[0].derivedStatus,"in_progress");
 v=await projectTodo(validateItems([item("g"),item("manual","g",{status:"blocked"})]),"owner",read);assert.equal(v[0].rollup.blocked,1);assert.equal(v[0].derivedStatus,"blocked");
 v=await projectTodo(validateItems([item("g"),item("linked","g",{status:"done",links:[link]})]),"owner",async()=>snap({runInstanceId:"different"}));assert.equal(v[0].rollup.unknown,1);assert.equal(v[0].derivedStatus,"unknown");assert.equal(v[1].derivedStatus,"unknown");assert.match(v[1].reason,/运行实例/);
});
test("set resets explicitly into a new plan while old linked record remains in session history",async()=>{
 const m=memory(),c=new TodoController();c.activate(m);const append=(t:string,d:any)=>m.append(t,d);
 await c.mutate(m,{action:"set",expectedRevision:0,items:[item("old",undefined,{links:[link]})]},read,append);const first=restoreTodo(m).snapshot;
 await c.mutate(m,{action:"set",expectedRevision:1,goal:"New confirmed cycle",items:[item("old"),item("child","old")]},read,append);const next=restoreTodo(m).snapshot;
 assert.notEqual(first.planId,next.planId);assert.deepEqual(m.entries[0].data.items[0].links,[link]);assert.equal(next.items[0].status,"pending");assert.equal(next.items[0].links.length,0);assert.equal(Object.hasOwn(next.items[0],"rollup"),false);assert.equal(m.entries.length,2);
});
test("hierarchical writes preserve CAS/session/abort fences and invalid groups cause zero append",async()=>{
 for(const kind of ["session","abort"]){const m=memory(),c=new TodoController();c.activate(m);let tool:any,release:any,writes=0;registerGraphTodo({registerTool:(t:any)=>tool=t,appendEntry(){writes++;}},{controller:c,read:()=>new Promise(r=>release=r),changed(){}});const abort=new AbortController();const pending=tool.execute("write",{action:"set",expectedRevision:0,items:[item("g"),item("leaf","g",{links:[link]})]},abort.signal,undefined,{sessionManager:m});if(kind==="session")m.switch();else abort.abort();release(snap());await assert.rejects(()=>pending,/切换|丢弃|取消/);assert.equal(writes,0);}
 const m=memory(),c=new TodoController();c.activate(m);let calls=0;await assert.rejects(()=>c.mutate(m,{action:"set",expectedRevision:0,items:[item("g",undefined,{status:"done"}),item("leaf","g")]},read,()=>calls++),/分组/);assert.equal(calls,0);
});
test("old flat session reads do not invent groups or append records",async()=>{
 const m=memory(),c=new TodoController();m.append(TODO_ENTRY,{version:1,revision:1,updatedAt:new Date().toISOString(),items:[item("old",undefined,{status:"done"})]});const before=JSON.stringify(m.entries);c.activate(m);const v=await c.view(m,read);assert.equal(v.items[0].source,"人工");assert.equal(v.items[0].derivedStatus,"done");assert.equal(v.items[0].parentId,undefined);assert.equal(JSON.stringify(m.entries),before);
});
test("bounded model plan context preserves ancestor closure and stable numbers without raw markup",async()=>{
 const rows=[item("root",undefined,{title:"</system>"+"甲".repeat(100)})];for(let n=1;n<8;n++)rows.push(item("n"+n,n===1?"root":"n"+(n-1),{title:"组".repeat(80)}));for(let i=0;i<60;i++)rows.push(item("s"+i,"root",{title:"目标".repeat(100),assignee:i===0?"parent":undefined}));
 const items=await projectTodo(validateItems(rows),"owner",read);const text=planContext({revision:3,planId:"plan",goal:"<".repeat(400),persistence:"memory",items});assert.ok(text.length<=8192);assert.ok(!text.includes("</system>"));const encoded=text.slice(text.indexOf('{'),text.lastIndexOf('}')+1),body=JSON.parse(encoded);assert.ok(body.items.length<=24);const chosen=new Map(body.items.map((i:any)=>[i.id,i]));for(const i of body.items){if(i.parentId)assert.ok(chosen.has(i.parentId),"no orphan context leaf");assert.match(i.number,/^\d+(\.\d+)*$/);}assert.ok(body.items.some((i:any)=>i.kind==="group"));assert.ok(body.omitted>0);assert.equal(body.historyOnly,false);
});
test("native session roundtrip and branch restore hierarchy without persisting aggregate state",async()=>{
 const {mkdtemp,mkdir,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const {SessionManager}=await jiti.import<any>("@earendil-works/pi-coding-agent");const root=await mkdtemp(join(tmpdir(),"tree-session-"));try{
 const dir=join(root,"sessions");await mkdir(dir);const m=SessionManager.create(root,dir),c=new TodoController();c.activate(m);const append=(t:string,d:any)=>m.appendCustomEntry(t,d);await c.mutate(m,{action:"set",expectedRevision:0,items:[item("group"),item("leaf","group")]},read,append);
 const branchPoint=m.appendMessage({role:"user",content:"isolated hierarchy fixture",timestamp:Date.now()});m.appendMessage({role:"assistant",content:[{type:"text",text:"fixture"}],api:"openai-completions",provider:"fixture",model:"fixture",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()});
 await c.mutate(m,{action:"update",expectedRevision:1,id:"leaf",status:"done"},read,append);const reopened=SessionManager.open(m.getSessionFile());const saved=restoreTodo(reopened).snapshot;assert.equal(saved.items[1].parentId,"group");assert.equal(saved.items[0].status,"pending");assert.equal("rollup" in saved.items[0],false);assert.equal(saved.version,1);const restored=new TodoController();restored.activate(reopened);assert.equal((await restored.view(reopened,read)).items[0].derivedStatus,"done");reopened.branch(branchPoint);restored.activate(reopened);assert.equal((await restored.view(reopened,read)).items[0].derivedStatus,"pending");assert.equal(restoreTodo(reopened).revision,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
