import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rename, symlink, rm } from "node:fs/promises";
import { renameSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { graphProjectScopeV3, graphProjectReceiptV3 } from "../extensions/project-root.ts";
import { MockSubagents, completeChild } from "./helpers/mock-subagents.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";

const jiti=createJiti(import.meta.url);
const {projectTodo}=await jiti.import<any>("../src/v3/ui/todo.ts");
const {default:register,PI_GRAPH_ROUTING_GUIDANCE,Parameters}=await jiti.import<any>("../extensions/pi-graph.ts");
const {V3GraphHost}=await jiti.import<any>("../src/v3/host.ts");
const {compileGraphSpecV3}=await jiti.import<any>("../src/v3/compiler.ts");
const worker=(id:string)=>`---\nname: worker\ndescription: Worker ${id}\nmodel: fixture/${id}\ntools: read,write\n---\nFixture`;
const spec=(id="graph-b")=>({schemaVersion:3,graphId:id,goal:"Isolated project test",nodes:[{taskId:"work",agent:"worker",task:"Check project",thinking:"off",sideEffect:"none"}]});
async function fixture(){
 const dir=await realpath(await mkdtemp(join(tmpdir(),"project-root-"))),A=join(dir,"A"),B=join(dir,"B"),agentDir=join(dir,"agent");
 for(const p of [A,B]){await mkdir(join(p,".pi/agents"),{recursive:true});await writeFile(join(p,".pi/agents/worker.md"),worker(p===A?"a":"b"));}
 await mkdir(agentDir);await writeFile(join(agentDir,"settings.json"),JSON.stringify({graph:{enabled:true,runsDir:join(dir,"runs")}}));
 const prior=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const starts:any[]=[];let registryHook:undefined|(()=>void),large=false;const original=V3GraphHost.prototype.start;
 V3GraphHost.prototype.start=async function(input:any,cwd:string){starts.push({input,cwd});const graph=compileGraphSpecV3(input);const nodes=Object.fromEntries(graph.nodes.map((n:any)=>[n.taskId,{phase:"queued",attempt:0}]));if(large)for(let i=0;i<8;i++)nodes["extra-"+i+"x".repeat(600)]={phase:"queued",attempt:0};return{graph,runDir:join(dir,"runs",graph.graphId),snapshot:{version:3,graphId:graph.graphId,runInstanceId:graph.graphId,sessionId:"owner",status:"running",nodes}};};
 const parentTools=["read","graph","graph_todo"];const tools=new Map<string,any>(),hooks=new Map<string,any[]>(),entries:any[]=[];
 const manager={getSessionId:()=>"owner",getSessionFile:()=>undefined,getEntries:()=>entries,getBranch:()=>entries};
 const api:any={events:{on(){return()=>{}},emit(){}},on(n:string,f:any){hooks.set(n,[...(hooks.get(n)??[]),f]);},registerTool(t:any){tools.set(t.name,t);},registerCommand(){},registerShortcut(){},getActiveTools:()=>parentTools,appendEntry(type:string,data:any){entries.push({id:String(entries.length),type:"custom",customType:type,data});}};
 register(api);const ctx:any={cwd:A,mode:"rpc",sessionManager:manager,modelRegistry:{getAvailable(){registryHook?.();return["a","b"].map(id=>({provider:"fixture",id,api:"openai-completions",input:["text"],reasoning:false}));}},ui:{setWidget(){},setStatus(){},notify(){}}};
 return {dir,A,B,agentDir,parentTools,ctx,starts,tools,hooks,entries,setRegistryHook(fn:()=>void){registryHook=fn;},setLarge(){large=true;},call(p:any,id="call"){return tools.get("graph").execute(id,p,undefined,undefined,ctx);},async close(){V3GraphHost.prototype.start=original;if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;await rm(dir,{recursive:true,force:true});}};
}

test("explicit relative project root binds B model and host source, preserving parent cwd and tool ceiling",async()=>{const f=await fixture();try{
 const r=await f.call({projectRoot:"../B",spec:spec()});assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(f.starts.length,1);assert.equal(f.starts[0].cwd,f.B);assert.equal(f.starts[0].input.nodes[0].launch.resolvedModel,"fixture/b");assert.deepEqual(f.starts[0].input.parentToolAllowlist,["read","graph"]);assert.equal(f.ctx.cwd,f.A);assert.equal(r.details.projectRoot,f.B);assert.match(r.content[0].text,/Project:/);
 }finally{await f.close();}});
test("target Agent tools cannot exceed parent ceiling even for an authorized other project",async()=>{const f=await fixture();try{const definition={...spec(),toolFilter:["write"]};const r=await f.call({projectRoot:f.B,spec:definition});assert.equal(r.isError,true);assert.match(r.content[0].text,/unavailable|tool.*allow|ceiling/i);assert.equal(f.starts.length,0);}finally{await f.close();}});
test("omitting projectRoot preserves parent cwd and original receipt shape",async()=>{const f=await fixture();try{const r=await f.call({spec:spec()});assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(f.starts[0].cwd,f.A);assert.equal(f.starts[0].input.nodes[0].launch.resolvedModel,"fixture/a");assert.equal(r.details.projectRoot,undefined);}finally{await f.close();}});
test("agents uses only selected project's public Agent metadata without mutating context",async()=>{const f=await fixture();try{const r=await f.call({action:"agents",projectRoot:"../B"});assert.equal(r.isError,undefined);assert.equal(r.details.projectRoot,f.B);assert.equal(r.details.agents[0].description,"Worker b");assert.equal(f.starts.length,0);assert.equal(f.ctx.cwd,f.A);}finally{await f.close();}});
test("source-only load binds inline spec and capsule paths against the same canonical B root",async()=>{const f=await fixture();try{
 const cap={manifest:{name:"fixture",version:"1.0.0",description:"Project B fixture"},intent:"Check",inputs:{},requires:{readOnly:true,toolFilter:["read"]},source:{type:"graph-spec",spec:spec()}};
 await writeFile(join(f.B,"check.graph.json"),JSON.stringify(cap));
 for(const source of [{spec:spec()},{capsule:"check.graph.json"}]){const r=await f.call({action:"load",projectRoot:"../B",...source});assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(r.details.projectRoot,f.B);assert.equal(r.details.graph.nodes[0].launch.resolvedModel,"fixture/b");if("capsule" in source)assert.equal(r.details.capsule.path,join(f.B,"check.graph.json"));}
 assert.equal(f.starts.length,0);assert.equal(f.ctx.cwd,f.A);
 }finally{await f.close();}});
test("template-only load resolves target Agent definitions and keeps selected project in receipt",async()=>{const f=await fixture();try{
 f.parentTools.push("grep","find");await writeFile(join(f.B,".pi/agents/worker.md"),worker("b").replace("read,write","read,grep,find,write"));await writeFile(join(f.agentDir,"subagent-capabilities.json"),JSON.stringify({schemaVersion:1,capabilities:[{capabilityId:"discover.code",agent:"worker",routingProfile:"fixture"},{capabilityId:"review.code",agent:"worker",routingProfile:"fixture"}]}));
 await writeFile(join(f.agentDir,"routing-policy.json"),JSON.stringify({schemaVersion:1,enforcement:"graph-admission",quarantinedProviderDomains:[],profiles:{fixture:{candidates:[{model:"fixture/b",level:"L0"}]}}}));
 const r=await f.call({action:"load",projectRoot:f.B,template:"code-review",overrides:{target:"src"}});assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(r.details.projectRoot,f.B);assert.match(r.content[0].text,/Nodes: 3/);assert.ok(Buffer.byteLength(JSON.stringify(r.details))<=4096);assert.equal(f.starts.length,0);
 }finally{await f.close();}});
test("Project receipt text strips terminal controls while canonical details preserve the exact directory",async()=>{const f=await fixture();try{
 const target=join(f.dir,"control\n\x1b[31mred");await rename(f.B,target);
 for(const params of [{action:"agents"},{action:"load",spec:spec()},{action:"start",spec:spec()}]){const r=await f.call({...params,projectRoot:target},"control-"+params.action);assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(r.details.projectRoot,target);const text=r.content[0].text;assert.ok(!text.includes("\x1b"));assert.ok(!text.includes("control\n"));assert.match(text,/Project: .*control red/);}
 }finally{await f.close();}});
for(const action of ["wait","status","retry","append","resume","load","list","doctor","pause","stop","result","templates","mailbox","usage","attention","cancel","seal"])test(`existing/non-source ${action} rejects projectRoot before host operations`,async()=>{const f=await fixture();try{const r=await f.call({action,id:"old-run",projectRoot:f.B});assert.equal(r.isError,true);assert.match(r.content[0].text,/existing runs keep their stored project root/);assert.equal(f.starts.length,0);}finally{await f.close();}});
test("same toolCallId reuses original promise; changing raw root or parent cwd refuses redispatch",async()=>{const f=await fixture();try{
 const p={spec:spec(),projectRoot:"../B"};const [a,b]=await Promise.all([f.call(p,"same"),f.call(p,"same")]);assert.deepEqual(a,b);assert.equal(f.starts.length,1);
 await rename(f.B,f.B+"-gone");const replay=await f.call(p,"same");assert.deepEqual(replay,a,"replay must not recanonicalize a completed start");assert.equal(f.starts.length,1);
 const changed=await f.call({...p,projectRoot:f.A},"same");assert.equal(changed.isError,true);f.ctx.cwd=f.dir;assert.equal((await f.call(p,"same")).isError,true);assert.equal(f.starts.length,1);
 }finally{await f.close();}});
test("start freezes parent cwd before its queued admission promise",async()=>{const f=await fixture();try{const call=f.call({projectRoot:"../B",spec:spec()},"frozen-parent");f.ctx.cwd=f.dir;const r=await call;assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(f.starts[0].cwd,f.B);assert.equal(r.details.projectRoot,f.B);}finally{await f.close();}});
test("invalid explicit roots fail before dispatch; omission performs no new filesystem lookup",async()=>{const f=await fixture();try{
 await writeFile(join(f.dir,"file"),"x");for(const projectRoot of [""," ",null,12,join(f.dir,"absent"),join(f.dir,"file")])assert.equal((await f.call({projectRoot,spec:spec()},"invalid-"+String(projectRoot))).isError,true);
 assert.equal(f.starts.length,0);const omitted=await graphProjectScopeV3(undefined,"/a/nonexistent/legacy/cwd");assert.equal(omitted.cwd,"/a/nonexistent/legacy/cwd");await omitted.assertUnchanged();
 }finally{await f.close();}});
test("explicit alias retarget or canonical directory replacement is rejected after capture",async()=>{const f=await fixture();try{
 const alias=join(f.dir,"selected");await symlink(f.B,alias);const scoped=await graphProjectScopeV3(alias,f.A);assert.equal(scoped.cwd,f.B);await rm(alias);await symlink(f.A,alias);await assert.rejects(scoped.assertUnchanged,/identity changed/);
 const dirScope=await graphProjectScopeV3(f.B,f.A);await rename(f.B,f.B+"-old");await mkdir(f.B);await assert.rejects(dirScope.assertUnchanged,/identity changed/);
 }finally{await f.close();}});
test("directory replacement during source admission refuses host.start, even with identical Agent bytes",async()=>{const f=await fixture();try{
 let changed=false;f.setRegistryHook(()=>{if(changed)return;changed=true;renameSync(f.B,f.B+"-old");mkdirSync(join(f.B,".pi/agents"),{recursive:true});writeFileSync(join(f.B,".pi/agents/worker.md"),worker("b"));});
 const r=await f.call({spec:spec(),projectRoot:f.B});assert.equal(r.isError,true,JSON.stringify(r));assert.match(r.content[0].text,/projectRoot.*identity changed/);assert.equal(f.starts.length,0);
 }finally{await f.close();}});
test("start project identity survives large-snapshot fallback and receipt paths remain bounded",async()=>{const f=await fixture();try{f.setLarge();const r=await f.call({spec:spec(),projectRoot:f.B});assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(r.details.projectRoot,f.B);assert.ok(Buffer.byteLength(JSON.stringify(r.details))<=4096);const info=graphProjectReceiptV3("/"+"目录".repeat(3000));assert.equal(info.projectRootTruncated,true);assert.match(info.projectRootSha256 as string,/^[a-f0-9]{64}$/);assert.ok(Buffer.byteLength(JSON.stringify(info))<1100);}finally{await f.close();}});
test("C0 directory roots respect encoded JSON receipt budgets including generic and start fallback",async()=>{const f=await fixture();try{
 const selected=join(f.dir,...Array.from({length:3},()=>"\x01".repeat(250)));await mkdir(join(selected,".pi/agents"),{recursive:true});await writeFile(join(selected,".pi/agents/worker.md"),worker("b"));const {createHash}=await import("node:crypto");
 const info=graphProjectReceiptV3(selected);assert.equal(info.projectRootTruncated,true);assert.equal(info.projectRootSha256,createHash("sha256").update(selected).digest("hex"));assert.ok(Buffer.byteLength(JSON.stringify(info))<1100);
 f.setLarge();for(const params of [{action:"agents"},{action:"load",spec:spec()},{action:"start",spec:spec()}]){const r=await f.call({...params,projectRoot:selected},"c0-"+params.action);assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(r.details.projectRootTruncated,true);assert.equal(r.details.projectRootSha256,info.projectRootSha256);assert.ok(Buffer.byteLength(JSON.stringify(r.details))<=4096);assert.ok(!r.content[0].text.includes("\x01"));}
 }finally{await f.close();}});
test("public schema and injected routing instructions explain source-only selection and separate Graph coordination",()=>{assert.ok(Parameters.properties.projectRoot);assert.match(PI_GRAPH_ROUTING_GUIDANCE,/graph\.projectRoot/);assert.match(PI_GRAPH_ROUTING_GUIDANCE,/not an automatic cross-Graph DAG or material transfer/);});

test("real host dummy B shadow writes apply only B; later A and stored B retry preserve roots and Todo run identity",{timeout:30000},async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),"project-host-"))),A=join(dir,"A"),B=join(dir,"B"),runsDir=join(dir,"runs");for(const p of [A,B,runsDir])await mkdir(p);
 await writeFile(join(A,"out.txt"),"original-A");await writeFile(join(B,"out.txt"),"original-B");
 const mock=new MockSubagents();mock.start();const writes:Array<{task:string;cwd:string}>=[];
 mock.behaviors.set("PROJECT_B",async input=>{writes.push({task:"B",cwd:input.cwd});await completeChild({...input,writes:[{path:"out.txt",content:"changed-B"}]});});
 mock.behaviors.set("PROJECT_A",async input=>{writes.push({task:"A",cwd:input.cwd});await completeChild({...input,writes:[{path:"out.txt",content:"changed-A"}]});});
 mock.behaviors.set("VERIFY_B",async input=>{writes.push({task:"B-read",cwd:input.cwd});assert.equal(await readFile(join(input.cwd,"out.txt"),"utf8"),"changed-B");await completeChild({...input,output:"verified B only"});});
 const host=new V3GraphHost({rpc:new SubagentRpcClient(mock),runsDir,sessionId:"owner-A",supervisorEpoch:"fixture",preflightAgent:async()=>undefined});
 const make=(id:string,tag:string)=>({schemaVersion:3,graphId:id,goal:tag,nodes:[{taskId:"work",agent:"fixture",task:tag,sideEffect:"local_write",writeScope:[{kind:"file",path:"out.txt"}],validationCommands:["test -s out.txt"]}]});
 try{
 const scopeB=await graphProjectScopeV3("../B",A);await scopeB.assertUnchanged();const bSpec=make("project-b","PROJECT_B");(bSpec.nodes as any[]).push({taskId:"verify",agent:"fixture",task:"VERIFY_B",sideEffect:"local_read",readOnly:true,readScope:[{kind:"file",path:"out.txt"}],dependsOn:["work"]});const b=await host.start(bSpec,scopeB.cwd);assert.equal((await host.waitForCompletion(b.graphId)).status,"complete");assert.equal(await readFile(join(B,"out.txt"),"utf8"),"changed-B");assert.equal(await readFile(join(A,"out.txt"),"utf8"),"original-A");
 const a=await host.start(make("project-a","PROJECT_A"),A);assert.equal((await host.waitForCompletion(a.graphId)).status,"complete");assert.equal(await readFile(join(A,"out.txt"),"utf8"),"changed-A");
 const restored=new V3GraphHost({rpc:new SubagentRpcClient(mock),runsDir,sessionId:"owner-A",supervisorEpoch:"restored",preflightAgent:async()=>undefined});
 assert.equal((await restored.loadRun(b.runDir,b.graphId)).authorization.sourceCwd,B);await restored.retry(b.graphId,"verify");assert.equal((await restored.waitForCompletion(b.graphId)).status,"complete");assert.equal(await readFile(join(A,"out.txt"),"utf8"),"changed-A");assert.equal(await readFile(join(B,"out.txt"),"utf8"),"changed-B");assert.equal(writes.filter(x=>x.task==="B").length,1);assert.equal(writes.filter(x=>x.task==="A").length,1);assert.equal(writes.filter(x=>x.task==="B-read").length,2);assert.ok(writes.every(x=>x.cwd!==A&&x.cwd!==B),"children execute in isolated shadows, never source projects");
 const snapshots=new Map([[a.graphId,await restored.status(a.graphId)],[b.graphId,await restored.status(b.graphId)]]);
 const items=[{id:"a",title:"A",status:"pending" as const,links:[{graphId:a.graphId,runInstanceId:a.snapshot.runInstanceId,taskId:"work"}]},{id:"b",title:"B",status:"pending" as const,dependsOn:["a"],links:[{graphId:b.graphId,runInstanceId:b.snapshot.runInstanceId,taskId:"work"}]}];
 assert.deepEqual((await projectTodo(items,"owner-A",async (l:any)=>snapshots.get(l.graphId)!)).map((i:any)=>i.derivedStatus),["done","done"]);
 const wrong=structuredClone(items);wrong[1]!.links[0]!.runInstanceId="different-run";const mismatch=(await projectTodo(wrong,"owner-A",async (l:any)=>snapshots.get(l.graphId)!))[1]!;assert.equal(mismatch.derivedStatus,"unknown");assert.match(mismatch.reason,/运行实例已变化/);
 }finally{await mock.dispose();await rm(dir,{recursive:true,force:true});}
});
