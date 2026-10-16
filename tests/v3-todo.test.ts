import test from "node:test";import assert from "node:assert/strict";import {createJiti} from "jiti";import {mkdtemp,mkdir,readFile} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";
const jiti=createJiti(import.meta.url);
const {TodoController,TODO_ENTRY,restoreTodo,reduceTodo,projectTodo}=await jiti.import<any>("../src/v3/ui/todo.ts");
const {registerGraphTodo,GraphTodoSchema}=await jiti.import<any>("../extensions/graph-todo.ts");
const {Check}=await jiti.import<any>("typebox/value");
function memory(){let all:any[]=[],branch:any[]=[],session="owner";return {getSessionId:()=>session,getSessionFile:()=>undefined,getEntries:()=>all,getBranch:()=>branch,append(type:string,data:any){const e={type:"custom",customType:type,data};all.push(e);branch.push(e);},branch(v:any[]){branch=v;},switch(){session="another";all=[];branch=[];}};}
const item=(id="a",links:any[]=[])=>({id,title:"验收一项",status:"pending",links});const link={graphId:"graph-a",runInstanceId:"run-a",taskId:"work"};
const snap=(phase="accepted",extra:any={})=>({graphId:"graph-a",runInstanceId:"run-a",sessionId:"owner",status:"complete",nodes:{work:{phase,attempt:1}},...extra});
test("native plan validates strict schema, bounds and CAS with no graph permissions",()=>{
 assert.ok(Check(GraphTodoSchema,{action:"list"}));assert.equal(Check(GraphTodoSchema,{action:"set",items:[]}),false);assert.equal(Check(GraphTodoSchema,{action:"list",path:"/tmp"}),false);
 for(const items of [[item("../x")],[item(),item()],[{...item(),title:"\x1b[2Junsafe"}],[{...item(),title:"x".repeat(401)}],[{...item(),links:[link,link]}],Array.from({length:129},(_,i)=>item(`a${i}`))])assert.throws(()=>reduceTodo([],0,{action:"set",expectedRevision:0,items}));
 assert.throws(()=>reduceTodo([],2,{action:"set",expectedRevision:1,items:[]}),/版本冲突/);assert.throws(()=>reduceTodo([item()],0,{action:"update",expectedRevision:0,id:"a",path:"/tmp"}),/未知字段/);
});
test("branch restore uses session-wide monotonic revision and refuses corrupted latest content",async()=>{
 const m=memory(),c=new TodoController();c.activate(m);let writes=0;const append=(t:string,d:any)=>{writes++;m.append(t,d);};const read=async()=>snap();
 let v=await c.mutate(m,{action:"set",expectedRevision:0,items:[item()]},read,append);assert.equal(v.persistence,"memory");const first=[...m.getBranch()];
 await c.mutate(m,{action:"update",expectedRevision:1,id:"a",status:"done"},read,append);m.branch(first);c.activate(m);assert.equal(restoreTodo(m).revision,2);assert.equal((await c.view(m,read)).items[0].derivedStatus,"pending");
 v=await c.mutate(m,{action:"update",expectedRevision:2,id:"a",title:"新分支"},read,append);assert.equal(v.revision,3);await c.view(m,read);assert.equal(writes,3);
 m.append(TODO_ENTRY,{version:99,revision:4,items:[]});const bad=await c.view(m,read);assert.match(bad.error,/损坏|版本/);assert.equal(bad.items.length,0);await assert.rejects(()=>c.mutate(m,{action:"set",expectedRevision:3,items:[]},read,append),/损坏/);
});
test("links derive only current node acceptance and discard missing, foreign or stale observations",async()=>{
 const source=[{...item("a",[link]),status:"done"},item("manual")];const before=JSON.stringify(source);
 assert.equal((await projectTodo(source,"owner",async()=>snap()))[0].derivedStatus,"done");
 for(const bad of [snap("accepted",{sessionId:"foreign"}),snap("accepted",{runInstanceId:"old"}),snap("accepted",{nodes:{}})])assert.equal((await projectTodo(source,"owner",async()=>bad))[0].derivedStatus,"unknown");
 assert.equal((await projectTodo(source,"owner",async()=>{throw Error("read failed");}))[0].derivedStatus,"unknown");
 assert.equal((await projectTodo(source,"owner",async()=>snap("running",{status:"running",nodes:{work:{phase:"running",attempt:2}}})))[0].derivedStatus,"in_progress");
 assert.equal((await projectTodo(source,"owner",async()=>snap("accepted",{status:"stopped"})))[0].derivedStatus,"done");
 assert.equal((await projectTodo(source,"owner",async()=>snap("queued",{status:"stopped"})))[0].derivedStatus,"blocked");
 assert.equal((await projectTodo([item()],"owner",async()=>snap()))[0].source,"人工");assert.equal(JSON.stringify(source),before);
 const multiple=[item("multi",[link,{...link,taskId:"other"}])];assert.equal((await projectTodo(multiple,"owner",async()=>snap("accepted",{nodes:{work:{phase:"accepted",attempt:1},other:{phase:"queued",attempt:0}}})))[0].derivedStatus,"pending");
});
test("session/tree/shutdown races and bad links cannot append; failed native append is never retried",async()=>{
 for(const kind of ["tree","switch","shutdown"]){const m=memory(),c=new TodoController();c.activate(m);let finish:any;let writes=0;
 const pending=c.mutate(m,{action:"set",expectedRevision:0,items:[item("a",[link])]},()=>new Promise(r=>finish=r),()=>{writes++;});
 if(kind==="switch")m.switch();if(kind==="shutdown")c.invalidate();else c.activate(m);finish(snap());await assert.rejects(()=>pending,/切换|丢弃/);assert.equal(writes,0);}
 const m=memory(),c=new TodoController();c.activate(m);let calls=0;
 await assert.rejects(()=>c.mutate(m,{action:"set",expectedRevision:0,items:[item("a",[link])]},async()=>snap("accepted",{sessionId:"foreign"}),()=>calls++),/未保存/);assert.equal(calls,0);
 const result=await c.mutate(m,{action:"set",expectedRevision:0,items:[item()]},async()=>snap(),(t:string,d:any)=>{calls++;m.append(t,d);throw Error("disk failed after memory append");});assert.equal(calls,1);assert.equal(result.revision,1);assert.equal(result.persistence,"unconfirmed");assert.match(result.error,/不自动重试/);assert.equal((await c.view(m,async()=>snap())).revision,1);
 await assert.rejects(()=>c.mutate(m,{action:"set",expectedRevision:1,items:[]},async()=>snap(),undefined),/不支持/);
});
test("registered parent tool list is pure read, child does not register and schema rejects excess fields",async()=>{
 const m=memory(),c=new TodoController(),tools:any[]=[];c.activate(m);let writes=0;
 const old=process.env.PI_GRAPH_CHILD;try{delete process.env.PI_GRAPH_CHILD;registerGraphTodo({registerTool:(t:any)=>tools.push(t),appendEntry:(t:string,d:any)=>{writes++;m.append(t,d);}},{controller:c,read:async()=>snap(),changed(){}});assert.equal(tools.length,1);
 const tool=tools[0],ctx={sessionManager:m};await tool.execute("id",{action:"list"},undefined,undefined,ctx);assert.equal(writes,0);
 await tool.execute("id",{action:"set",expectedRevision:0,items:[item()]},undefined,undefined,ctx);assert.equal(writes,1);await tool.execute("id",{action:"list"},undefined,undefined,ctx);assert.equal(writes,1);
 await assert.rejects(()=>tool.execute("id",{action:"list",path:"/tmp"},undefined,undefined,ctx),/schema/);
 process.env.PI_GRAPH_CHILD="1";registerGraphTodo({registerTool:()=>assert.fail("child tool exposed")},{controller:c,read:async()=>snap(),changed(){}});
 }finally{if(old===undefined)delete process.env.PI_GRAPH_CHILD;else process.env.PI_GRAPH_CHILD=old;}
});
test("real native SessionManager persists plan, reopens, compacts and branches without sending plan as LLM context",async()=>{
 const {SessionManager}=await jiti.import<any>("@earendil-works/pi-coding-agent");const root=await mkdtemp(join(tmpdir(),"graph-todo-sdk-"));const dir=join(root,"sessions");await mkdir(dir);
 const m=SessionManager.create(root,dir),c=new TodoController();c.activate(m);const read=async()=>snap(),append=(t:string,d:any)=>m.appendCustomEntry(t,d);
 const initial=await c.mutate(m,{action:"set",expectedRevision:0,items:[item()]},read,append);assert.equal(initial.persistence,"memory");
 const userId=m.appendMessage({role:"user",content:"fixture only",timestamp:Date.now()});m.appendMessage({role:"assistant",content:[{type:"text",text:"fixture response"}],api:"openai-completions",provider:"fixture",model:"fixture",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()});
 const v=await c.mutate(m,{action:"update",expectedRevision:1,id:"a",status:"done"},read,append);assert.equal(v.persistence,"durable");assert.ok((await readFile(m.getSessionFile(),"utf8")).includes(TODO_ENTRY));
 const reopened=SessionManager.open(m.getSessionFile());assert.equal(restoreTodo(reopened).snapshot.items[0].status,"done");reopened.appendCompaction("fixture summary",userId,100);assert.equal(restoreTodo(reopened).revision,2);assert.equal(restoreTodo(reopened).snapshot.items[0].status,"done");
 reopened.branch(userId);assert.equal(restoreTodo(reopened).snapshot.items[0].status,"pending");assert.equal(restoreTodo(reopened).revision,2);
 const context=reopened.buildSessionContext?.();if(context)assert.ok(!JSON.stringify(context).includes(TODO_ENTRY));
});
test("registered tool discards older same-session reads and exposes native save uncertainty as error",async()=>{
 const m=memory(),c=new TodoController();c.activate(m);m.append(TODO_ENTRY,{version:1,revision:1,updatedAt:new Date().toISOString(),items:[item("a",[link])]});
 let finish:any;let deferred=true;let tool:any;const changed:any[]=[];
 registerGraphTodo({registerTool:(t:any)=>tool=t,appendEntry:(t:string,d:any)=>{m.append(t,d);throw Error("disk");}},{controller:c,read:()=>deferred?new Promise(r=>finish=r):Promise.reject(Error("unreadable")),changed:(v:any)=>changed.push(v)});
 const ctx={sessionManager:m},old=tool.execute("old",{action:"list"},undefined,undefined,ctx);deferred=false;
 await tool.execute("new",{action:"list"},undefined,undefined,ctx);assert.equal(changed.at(-1).items[0].derivedStatus,"unknown");finish(snap());await assert.rejects(()=>old,/过期/);assert.equal(changed.length,1);
 const result=await tool.execute("save",{action:"set",expectedRevision:1,items:[item()]},undefined,undefined,ctx);assert.equal(result.isError,true);assert.equal(result.details.persistence,"unconfirmed");assert.equal(changed.length,2);
});
test("unchanged native session durability is cached and invalidated by file changes",async()=>{
 const {TodoPersistence}=await jiti.import<any>("../src/v3/ui/todo.ts");const {writeFile}=await import("node:fs/promises");const root=await mkdtemp(join(tmpdir(),"todo-cache-")),path=join(root,"session.jsonl");const snapshot={version:1,revision:1,updatedAt:new Date().toISOString(),items:[item()]};const content=JSON.stringify({type:"custom",customType:TODO_ENTRY,data:snapshot});await writeFile(path,content);let reads=0;const cache=new TodoPersistence(()=>{reads++;return content;});const m={...memory(),getSessionFile:()=>path};assert.equal(cache.get(m,snapshot),"durable");for(let i=0;i<10;i++)assert.equal(cache.get(m,snapshot),"durable");assert.equal(reads,1);await writeFile(path,content+"\n");cache.get(m,snapshot);assert.equal(reads,2);cache.clear();cache.get(m,snapshot);assert.equal(reads,3);
});
test("cancelled registered mutation during link read has zero append and zero changed",async()=>{
 const m=memory(),c=new TodoController();c.activate(m);let tool:any,finish:any,writes=0,changes=0;registerGraphTodo({registerTool:(t:any)=>tool=t,appendEntry:()=>writes++},{controller:c,read:()=>new Promise(r=>finish=r),changed:()=>changes++});const abort=new AbortController();const pending=tool.execute("id",{action:"set",expectedRevision:0,items:[item("a",[link])]},abort.signal,undefined,{sessionManager:m});abort.abort();finish(snap());await assert.rejects(()=>pending,/取消/);assert.equal(writes,0);assert.equal(changes,0);
});
test("older list cannot publish revision one after mutation publishes revision two",async()=>{
 const m=memory(),c=new TodoController();c.activate(m);m.append(TODO_ENTRY,{version:1,revision:1,updatedAt:new Date().toISOString(),items:[item("a",[link])]});let tool:any,finish:any;const changes:any[]=[];registerGraphTodo({registerTool:(t:any)=>tool=t,appendEntry:(t:string,d:any)=>m.append(t,d)},{controller:c,read:()=>new Promise(r=>finish=r),changed:(v:any)=>changes.push(v)});const ctx={sessionManager:m};const pending=tool.execute("old",{action:"list"},undefined,undefined,ctx);await tool.execute("new",{action:"set",expectedRevision:1,items:[item()]},undefined,undefined,ctx);finish(snap());await assert.rejects(()=>pending,/过期/);assert.equal(changes.length,1);assert.equal(changes[0].revision,2);
});
test("coordinated slow display reads survive repeated polling and clear old accepted evidence",async()=>{
 const {TodoReadCoordinator}=await jiti.import<any>("../src/v3/ui/todo.ts");const m=memory(),c=new TodoController(),gate=new TodoReadCoordinator();c.activate(m);m.append(TODO_ENTRY,{version:1,revision:1,updatedAt:new Date().toISOString(),items:[item("a",[link])]});let rejectRead:any,reads=0;const work=()=>c.view(m,()=>{reads++;return new Promise((_r,j)=>rejectRead=j);});const first=gate.read("session-generation-revision",work);await new Promise(r=>setTimeout(r,5));const second=gate.read("session-generation-revision",work);await new Promise(r=>setTimeout(r,5));const third=gate.read("session-generation-revision",work);assert.equal(first,second);assert.equal(second,third);assert.equal(reads,1);rejectRead(Error("filesystem failed after several UI ticks"));const view=await third;assert.equal(view.items[0].derivedStatus,"unknown");assert.match(view.items[0].reason,/filesystem failed/);assert.equal((await first).items[0].derivedStatus,"unknown");
 const fresh=await gate.read("new-generation",()=>c.view(m,async()=>snap()));assert.equal(fresh.items[0].derivedStatus,"done");
});
test("cancellation after native append reports the committed revision rather than claiming no write",async()=>{
 const m=memory(),c=new TodoController();c.activate(m);const abort=new AbortController();let tool:any,writes=0,changes=0;registerGraphTodo({registerTool:(t:any)=>tool=t,appendEntry:(t:string,d:any)=>{writes++;m.append(t,d);abort.abort();}},{controller:c,read:async()=>snap(),changed:()=>changes++});const result=await tool.execute("id",{action:"set",expectedRevision:0,items:[item()]},abort.signal,undefined,{sessionManager:m});assert.equal(result.details.revision,1);assert.equal(result.isError,undefined);assert.equal(writes,1);assert.equal(changes,1);
});

test("explicit plan ownership and dependencies survive CAS without inventing Graph acceptance",async()=>{
 const a={...item("a"),assignee:"root"},b={...item("b"),dependsOn:["a"],assignee:"backend"};
 const valid=reduceTodo([],0,{action:"set",expectedRevision:0,items:[a,b]});assert.deepEqual(valid,[a,b]);
 for(const entries of [[{...a,dependsOn:["missing"]}],[{...a,dependsOn:["a"]}],[{...a,dependsOn:["b"]},{...b,dependsOn:["a"]}],[a,{...b,dependsOn:["a","a"]}]])assert.throws(()=>reduceTodo([],0,{action:"set",expectedRevision:0,items:entries}));
 const projected=await projectTodo(valid,"owner",()=>assert.fail("unlinked plan must not read Graph"));assert.equal(projected[1].derivedStatus,"blocked");assert.equal(projected[1].source,"人工");assert.match(projected[1].reason,/前置/);assert.equal(valid[1].status,"pending");
 const running=await projectTodo([a,{...b,status:"in_progress"}],"owner",()=>assert.fail());assert.equal(running[1].derivedStatus,"in_progress");
 const edited=reduceTodo(valid,1,{action:"update",expectedRevision:1,id:"b",dependsOn:[],assignee:"reviewer"});assert.deepEqual(edited[1].dependsOn,[]);assert.equal(edited[1].assignee,"reviewer");assert.deepEqual(reduceTodo([],0,{action:"set",expectedRevision:0,items:[item()]}),[item()]);
});
