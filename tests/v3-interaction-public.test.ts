import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,mkdir,realpath,writeFile,readFile,rm } from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createJiti} from "jiti";
import {createHash} from "node:crypto";
import {V3GraphRunner} from "../src/v3/runner.ts";
import {SubagentRpcClient} from "../src/v3/rpc.ts";
import {MockSubagents,completeChild} from "./helpers/mock-subagents.ts";
import {compileGraphSpecV3} from "../src/v3/compiler.ts";
import {initializeV3Run} from "../src/v3/initialize.ts";
import {acquireV3RunLease} from "../src/v3/lease.ts";
import {interactionUiCapture} from "./helpers/interaction-ui-capture.ts";

// Actual registered command and durable registry/store; no production host/model dispatch.
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),"graph-interaction-")));
 const runDir=join(root,"interaction"),source=join(root,"source"),home=join(root,"agent");await mkdir(source);await mkdir(home);
 await writeFile(join(home,"settings.json"),JSON.stringify({graph:{enabled:true,runsDir:root}}));
 const graph=compileGraphSpecV3({schemaVersion:3,graphId:"interaction",goal:"isolated public interaction",nodes:[{taskId:"a",agent:"fixture-a",task:"never dispatched",sideEffect:"none"},{taskId:"b",agent:"fixture-b",task:"never dispatched",sideEffect:"none"}]});
 const init=await initializeV3Run({trustedRoot:root,runDir,graph,sessionId:"owner",supervisorEpoch:"epoch",sourceCwd:source,runInstanceId:"instance"});
 init.snapshot.nodes={a:{phase:"queued",attempt:1,agent:"fixture-a",dependsOn:[]},b:{phase:"queued",attempt:1,agent:"fixture-b",dependsOn:[]}};await writeFile(join(runDir,"snapshot.json"),JSON.stringify(init.snapshot));
 const lease=await acquireV3RunLease(join(runDir,"lease.json"),"instance");
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=home;
 const jiti=createJiti(import.meta.url);
 const {GraphMailbox,mailboxMessageState}=await jiti.import<any>(new URL("../src/v3/mailbox.ts",import.meta.url).href);
 const {activeMailboxes,mailboxRegistryKey}=await jiti.import<any>(new URL("../src/v3/mailbox-runtime.ts",import.meta.url).href);
 let live=false;
 const store=new GraphMailbox(runDir,lease,async(task:string,attempt:number)=>["a","b"].includes(task)&&attempt===1,()=>true,async(task:string,attempt:number)=>live&&task==="a"&&attempt===1);await store.initialize("instance","owner",[{taskId:"a",attempt:1},{taskId:"b",attempt:1}]);
 const key=mailboxRegistryKey(runDir);const registry:any={mailbox:store,owner:"owner",runInstanceId:"instance"};activeMailboxes.set(key,registry);
 const commands=new Map<string,any>();const counters={sendMessage:0,nativeRpc:0,wake:0};const listeners=new Map<string,Set<Function>>();
 const extension=(await jiti.import<any>(new URL("../extensions/pi-graph.ts",import.meta.url).href)).default;
 extension({events:{on(name:string,fn:Function){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);},emit(name:string,value:unknown){if(name==="subagent:request")counters.nativeRpc++;if(name==="pi-graph:mailbox")counters.wake++;for(const fn of listeners.get(name)??[])fn(value);}},on(){},registerTool(){},registerCommand(name:string,command:any){commands.set(name,command);},sendMessage(){counters.sendMessage++;throw new Error("Parent must not relay/dispatch");},getActiveTools:()=>["graph","read"]});
 assert.ok(commands.get("graphs"));
 const call=async(capture:ReturnType<typeof interactionUiCapture>,owner="owner")=>commands.get("graphs").handler("view interaction",{cwd:source,mode:"tui",sessionManager:{getSessionId:()=>owner,getSessionFile:()=>undefined,getEntries:()=>[]},modelRegistry:{getAvailable:()=>[]},ui:capture.ui});
 return{root,runDir,source,graph,store,mailboxMessageState,lease,registry,init,counters,call,setLive(value:boolean){live=value;},async running(){live=true;init.snapshot.status="running";init.snapshot.nodes!.a.phase="running";await writeFile(join(runDir,"snapshot.json"),JSON.stringify(init.snapshot));},async close(){activeMailboxes.delete(key);await lease.release();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(root,{recursive:true,force:true});}};
}

test("registered /graphs preserves Enter/l/Esc/q navigation and performs no dispatch or mailbox mutation",async()=>{
 const f=await fixture();try{
  const before=await readFile(f.store.path,"utf8");const ui=interactionUiCapture([["\r","l","\x1b","\x1b","q"]]);await f.call(ui);
  assert.equal(ui.customCount,1);assert.equal(ui.inputCount,0);assert.equal(ui.confirmCount,0);
  assert.ok(ui.trace.some(row=>row.kind==="render"&&String(row.text).includes("原始状态记录")),JSON.stringify(ui.trace));
  assert.equal(await readFile(f.store.path,"utf8"),before);assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});
 }finally{await f.close();}
});

for(const cancel of ["input","confirm","empty"]){test(`public selected-node message ${cancel} cancels without durable write`,async()=>{
 const f=await fixture();try{await f.running();const before=await readFile(f.store.path,"utf8");const ui=interactionUiCapture([["m"],["q"]],{input:()=>cancel==="input"?undefined:cancel==="empty"?"   ":"notify only",confirm:()=>false});await f.call(ui);assert.equal(ui.inputCount,1);assert.equal(ui.confirmCount,cancel==="confirm"?1:0);assert.equal(await readFile(f.store.path,"utf8"),before);assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});}finally{await f.close();}
});}

test("public m closes overlay then confirms exact identity and enqueues once with no child wake",async()=>{
 const f=await fixture();try{await f.running();const ui=interactionUiCapture([["m","\r","\r"],["q"]],{input:()=>"isolated notification",confirm:()=>true});await f.call(ui);assert.equal(ui.inputCount,1);assert.equal(ui.confirmCount,1);const state=await f.store.load();assert.equal(state.messages.length,1);assert.equal(state.messages[0].to,"a");assert.equal(state.messages[0].text,"isolated notification");assert.match(String(ui.trace.find(r=>r.kind==="confirm")?.title),/interaction.*a.*attempt 1/);assert.ok(ui.trace.some(r=>r.kind==="notify"&&String(r.text).includes("不代表已送达或处理")));assert.equal(f.mailboxMessageState(state,state.messages[0]),"queued");assert.notEqual(state.messages[0].delivered,true);assert.notEqual(state.messages[0].acknowledged,true);assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});}finally{await f.close();}
});

for(const race of ["attempt","live","owner"]){test(`public input-to-commit ${race} race refuses stale selected child`,async()=>{
 const f=await fixture();try{await f.running();const before=await readFile(f.store.path,"utf8");const ui=interactionUiCapture([["m"],["q"]],{input:async()=>{if(race==="attempt"){f.init.snapshot.nodes!.a.attempt=2;await writeFile(join(f.runDir,"snapshot.json"),JSON.stringify(f.init.snapshot));}if(race==="live")f.setLive(false);if(race==="owner")f.registry.owner="other";return "must not send";},confirm:()=>true});await f.call(ui);assert.equal(ui.confirmCount,1);assert.equal(await readFile(f.store.path,"utf8"),before);assert.ok(ui.trace.some(r=>r.kind==="notify"&&String(r.text).includes("未确认发送")));assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});}finally{await f.close();}
});}

test("public queued and foreign-owner nodes cannot open a sending input",async()=>{
 const f=await fixture();try{const before=await readFile(f.store.path,"utf8");for(const owner of ["owner","foreign"]){const ui=interactionUiCapture([["m","q"]]);await f.call(ui,owner);assert.equal(ui.inputCount,0);}assert.equal(await readFile(f.store.path,"utf8"),before);assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});}finally{await f.close();}
});

test("public o reads real runner accepted Unicode artifact with stable digest/tail and escapes terminal control bytes",{timeout:25000},async()=>{
 const f=await fixture();const mock=new MockSubagents();mock.start();
 try{
  await f.lease.release();
  const output=('资料😀\"\\'.repeat(3000))+'\n\x1b[31mCONTROL\x07\x85\nINDEPENDENT-ARTIFACT-TAIL';
  mock.behaviors.set("never dispatched",input=>completeChild({...input,output}));
  const runner=new V3GraphRunner({rpc:new SubagentRpcClient(mock),runDir:f.runDir,graph:f.graph,authorization:f.init.authorization,sourceCwd:f.source,sessionId:"owner",supervisorEpoch:"epoch",preflightAgent:async()=>{}});
  const snapshot=await runner.run();assert.equal(snapshot.status,"complete");assert.equal(mock.spawned.length,2);
  const jiti=createJiti(import.meta.url);const {readAcceptedArtifactPage}=await jiti.import<any>(new URL("../src/v3/ui/interaction.ts",import.meta.url).href);
  const target={graphId:"interaction",runInstanceId:"instance",taskId:"a",attempt:1};let offset=0,full="",digest:string|undefined,pageCount=0;
  do{const page=await readAcceptedArtifactPage(f.root,target,offset,4096,digest);digest??=page.sha256;assert.equal(page.sha256,digest);full+=page.text;pageCount++;if(page.nextOffset===null)break;offset=page.nextOffset;}while(pageCount<100);
  assert.ok(full===output,JSON.stringify({actualPoints:Array.from(full).length,expectedPoints:Array.from(output).length,pages:pageCount,actualTail:full.slice(-100),expectedTail:output.slice(-100)}));assert.equal(digest,createHash("sha256").update(output).digest("hex"));assert.ok(pageCount>1);assert.ok(full.endsWith("INDEPENDENT-ARTIFACT-TAIL"));
  const ui=interactionUiCapture([["\r","o",...Array.from({length:Math.ceil(Array.from(output).length/2048)+2},()=>"n"),"q"]],{afterStep:async({key,before,read})=>{
   if(!["\r","o","n"].includes(key)||key==="n"&&before.includes("保存文件完整读取至末尾"))return;
   const oldOffset=/offset (\d+)/u.exec(before)?.[1],deadline=Date.now()+3000;
   while(Date.now()<deadline){const current=read();
    if(key==="\r"&&!current.includes("正在读取产物"))return;
    if(key==="o"&&current.includes("保存产物原文"))return;
    if(key==="n"&&(/offset (\d+)/u.exec(current)?.[1]!==oldOffset||current.includes("保存文件完整读取至末尾")))return;
    await new Promise(resolve=>setTimeout(resolve,5));
   }
   throw new Error(`Inspector page not ready after key ${JSON.stringify(key)}; previous offset=${oldOffset}`);
  }});await f.call(ui);
  const rendered=ui.trace.filter(r=>r.kind==="render").map(r=>String(r.text)).join("\n");assert.match(rendered,/INDEPENDENT-ARTIFACT-TAIL/);assert.match(rendered,/保存产物原文/);assert.ok(!rendered.includes("\x1b[31m"));assert.ok(!rendered.includes("\x07"));assert.match(rendered,/\\u001b\[31mCONTROL\\u0007\\u0085/);assert.equal(mock.spawned.length,2);assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});
  await writeFile(join(f.runDir,"artifacts/a/attempt-1.txt"),"tampered must not appear");await assert.rejects(readAcceptedArtifactPage(f.root,target,0,2048,digest),/accepted|变化|chain|artifact/i);
 }finally{await mock.dispose();await f.close();}
});

test("public o for nonaccepted node shows unavailability and never treats state JSON as full artifact",async()=>{
 const f=await fixture();try{const ui=interactionUiCapture([["\r","o","l","q"]],{stepDelayMs:40});await f.call(ui);const text=ui.trace.filter(r=>r.kind==="render").map(r=>String(r.text)).join("\n");assert.match(text,/尚无可校验|accepted/);assert.doesNotMatch(text,/保存产物原文/);assert.match(text,/原始状态记录/);assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});}finally{await f.close();}
});

for(const request of ["preview","full"]){for(const outcome of ["resolve","reject"]){test(`actual Inspector ${request} ${outcome} after Escape/node switch cannot contaminate B or reopen artifact`,async()=>{
 const f=await fixture();try{
  const jiti=createJiti(import.meta.url);const {GraphInspector}=await jiti.import<any>(new URL("../src/v3/ui/inspector.ts",import.meta.url).href);
  let complete:(value:any)=>void=()=>{},fail:(error:Error)=>void=()=>{};const delayed=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});
  const page=(text:string)=>({text,sha256:"a".repeat(64),bytes:Buffer.byteLength(text),offset:0,nextOffset:null,source:"artifacts/fixture.txt"});
  const theme={fg:(_c:string,text:string)=>text,bg:(_c:string,text:string)=>text,bold:(text:string)=>text};
  const panel=new GraphInspector({snapshot:f.init.snapshot,theme,rows:()=>40,requestRender(){},onClose(){},read:async()=>f.init.snapshot,pollMs:60000,
   readArtifact:(target:any,_offset:number,limit:number)=>target.taskId==="b"?Promise.resolve(page("B-PREVIEW-ONLY")):request==="preview"||limit>240?delayed:Promise.resolve(page("A-EARLY-PREVIEW"))});
  try{panel.handleInput("\r");await new Promise(resolve=>setImmediate(resolve));if(request==="full")panel.handleInput("o");panel.handleInput("\x1b");panel.handleInput("j");panel.handleInput("\r");await new Promise(resolve=>setImmediate(resolve));
   if(outcome==="resolve")complete(page("A-LATE-SECRET-MUST-NOT-APPEAR"));else fail(new Error("A-LATE-ERROR-MUST-NOT-APPEAR"));await new Promise(resolve=>setImmediate(resolve));
   const text=panel.render(120).join("\n");assert.match(text,/B-PREVIEW-ONLY/);assert.doesNotMatch(text,/A-LATE|A-EARLY|保存产物原文/);
  }finally{panel.dispose();}
 }finally{await f.close();}
});}}

test("public retry after lost durable-send reply reuses original idempotency key and does not duplicate message",async()=>{
 const f=await fixture();try{await f.running();const original=f.store.request.bind(f.store),keys:string[]=[];let lost=false;
  f.store.request=async(...args:any[])=>{keys.push(args[1].idempotencyKey);const value=await original(...args);if(!lost){lost=true;throw new Error("fixture lost reply after durable commit");}return value;};
  for(let i=0;i<2;i++){const ui=interactionUiCapture([["m"],["q"]],{input:()=>"same draft",confirm:()=>true});await f.call(ui);assert.equal(ui.confirmCount,1);}
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);const state=await f.store.load();assert.equal(state.messages.length,1);assert.equal(f.mailboxMessageState(state,state.messages[0]),"queued");assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});
 }finally{await f.close();}
});

test("public live recipient invalidated only after entering real lease fence is rejected before durable write",async()=>{
 const f=await fixture();try{await f.running();const before=await readFile(f.store.path,"utf8"),original=f.lease.withFence.bind(f.lease);let entered=0;
  f.lease.withFence=async(action:any)=>original(async()=>{entered++;f.setLive(false);return action();});
  const ui=interactionUiCapture([["m"],["q"]],{input:()=>"lost live inside transaction",confirm:()=>true});await f.call(ui);assert.equal(entered,1);assert.equal(await readFile(f.store.path,"utf8"),before);assert.ok(ui.trace.some(r=>r.kind==="notify"&&String(r.text).includes("未确认发送")));assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});
 }finally{await f.close();}
});

test("over-limit original output is identified as truncated while o reproduces exact accepted saved-file bytes and tail",{timeout:25000},async()=>{
 const f=await fixture();const mock=new MockSubagents();mock.start();try{
  await f.lease.release();const original='资料😀"\\'.repeat(14000)+'\nORIGINAL-UNSAVED-END';mock.behaviors.set("never dispatched",input=>completeChild({...input,output:original}));
  const runner=new V3GraphRunner({rpc:new SubagentRpcClient(mock),runDir:f.runDir,graph:f.graph,authorization:f.init.authorization,sourceCwd:f.source,sessionId:"owner",supervisorEpoch:"epoch",preflightAgent:async()=>{}});assert.equal((await runner.run()).status,"complete");
  const accepted=await readFile(join(f.runDir,"artifacts/a/attempt-1.txt"));assert.ok(accepted.length<Buffer.byteLength(original));assert.ok(accepted.toString("utf8").endsWith("[output truncated]"));assert.ok(!accepted.toString("utf8").includes("ORIGINAL-UNSAVED-END"));
  const jiti=createJiti(import.meta.url);const {readAcceptedArtifactPage}=await jiti.import<any>(new URL("../src/v3/ui/interaction.ts",import.meta.url).href);const target={graphId:"interaction",runInstanceId:"instance",taskId:"a",attempt:1};let offset=0,text="",digest:string|undefined;
  for(let count=0;count<100;count++){const page=await readAcceptedArtifactPage(f.root,target,offset,4096,digest);digest??=page.sha256;text+=page.text;if(page.nextOffset===null)break;offset=page.nextOffset;}
  assert.equal(Buffer.compare(Buffer.from(text),accepted),0);assert.equal(digest,createHash("sha256").update(accepted).digest("hex"));assert.ok(text.endsWith("[output truncated]"));
  const ui=interactionUiCapture([["\r","o",...Array.from({length:Math.ceil(Array.from(text).length/2048)+2},()=>"n"),"q"]],{afterStep:async({key,before,read})=>{
   if(!["\r","o","n"].includes(key)||key==="n"&&before.includes("保存文件完整读取至末尾"))return;
   const oldOffset=/offset (\d+)/u.exec(before)?.[1],deadline=Date.now()+3000;
   while(Date.now()<deadline){const current=read();
    if(key==="\r"&&!current.includes("正在读取产物"))return;
    if(key==="o"&&current.includes("保存产物原文"))return;
    if(key==="n"&&(/offset (\d+)/u.exec(current)?.[1]!==oldOffset||current.includes("保存文件完整读取至末尾")))return;
    await new Promise(resolve=>setTimeout(resolve,5));
   }
   throw new Error(`Inspector page not ready after key ${JSON.stringify(key)}; previous offset=${oldOffset}`);
  }});await f.call(ui);const rendered=ui.trace.filter(r=>r.kind==="render").map(r=>String(r.text)).join("\n");assert.match(rendered,/保存产物原文（不保证完整模型输出）/);assert.match(rendered,/已截断/);assert.match(rendered,/\[output truncated\]/);assert.equal(mock.spawned.length,2);assert.deepEqual(f.counters,{sendMessage:0,nativeRpc:0,wake:0});
  console.log("ACCEPTED_FILE_BOUNDARY",JSON.stringify({originalBytes:Buffer.byteLength(original),acceptedBytes:accepted.length,acceptedSha256:digest,originalTailSaved:false,acceptedTail:"[output truncated]"}));
 }finally{await mock.dispose();await f.close();}
});

for(const outcome of ["resolve","reject"]){test(`actual Inspector pending o then l raw view ignores late ${outcome} and never reopens artifact`,async()=>{
 const f=await fixture();try{
  const jiti=createJiti(import.meta.url);const {GraphInspector}=await jiti.import<any>(new URL("../src/v3/ui/inspector.ts",import.meta.url).href);let complete:(value:any)=>void=()=>{},fail:(error:Error)=>void=()=>{};const pending=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});
  const page={text:"PREVIEW",sha256:"a".repeat(64),bytes:7,offset:0,nextOffset:null,source:"artifacts/a/attempt-1.txt"};const theme={fg:(_c:string,text:string)=>text,bg:(_c:string,text:string)=>text,bold:(text:string)=>text};
  const panel=new GraphInspector({snapshot:f.init.snapshot,theme,rows:()=>40,requestRender(){},onClose(){},read:async()=>f.init.snapshot,pollMs:60000,readArtifact:(_target:any,_offset:number,limit:number)=>limit>240?pending:Promise.resolve(page)});
  try{panel.handleInput("\r");await new Promise(resolve=>setImmediate(resolve));panel.handleInput("o");panel.handleInput("l");const before=panel.render(120).join("\n");assert.match(before,/原始状态记录/);
   if(outcome==="resolve")complete({...page,text:"LATE-ARTIFACT-FROM-OLD-MODE"});else fail(new Error("LATE-ERROR-FROM-OLD-MODE"));await new Promise(resolve=>setImmediate(resolve));const after=panel.render(120).join("\n");assert.equal(after,before);assert.doesNotMatch(after,/LATE-|保存产物原文/);panel.handleInput("l");assert.doesNotMatch(panel.render(120).join("\n"),/LATE-/);
  }finally{panel.dispose();}
 }finally{await f.close();}
});}
