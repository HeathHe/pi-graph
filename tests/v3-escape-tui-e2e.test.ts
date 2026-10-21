import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,writeFile,readFile,realpath,cp} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {piCliPath} from "./helpers/pi-cli.ts";
import {cleanupThenSaveEvidence} from "./helpers/fixture-cleanup.ts";
const sleep=(ms:number)=>new Promise(done=>setTimeout(done,ms));
async function until(read:()=>Promise<any>,accept:(value:any)=>boolean,label:string,timeout=45000){const end=Date.now()+timeout;let last:any;while(Date.now()<end){try{last=await read();if(accept(last))return last;}catch(e){last=String(e);}await sleep(100);}throw Error(`${label}: ${JSON.stringify(last)}`);}

test("real Escape cancels Graph/child; inspector, menus and reload preserve cancellation boundaries",{timeout:150000},async()=>{
 const repo=resolve(new URL("..",import.meta.url).pathname),root=await realpath(await mkdtemp(join(tmpdir(),"graph-escape-tui-")));
 const agentDir=join(root,"agent"),runs=join(root,"runs"),agents=join(root,".pi/agents"),capture=join(root,"capture"),native=join(root,"native");
 for(const dir of [agentDir,runs,agents,capture,native])await mkdir(dir,{recursive:true});
 const events:any[]=[];const timers=new Set<ReturnType<typeof setTimeout>>();
 const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on("data",c=>chunks.push(c));req.on("end",()=>{
  const body=JSON.parse(Buffer.concat(chunks).toString()),text=JSON.stringify(body.messages),ask=text.includes("ESCAPE_ASK");
  events.push({event:"child_request",ask,time:Date.now()});res.writeHead(200,{"content-type":"text/event-stream"});
  const emit=(delta:any,finish_reason:any)=>res.write(`data: ${JSON.stringify({id:"escape",object:"chat.completion.chunk",created:1,model:"local",choices:[{index:0,delta,finish_reason}]})}\n\n`);
  emit({role:"assistant",content:"Child active"},null);
  if(ask){emit({tool_calls:[{index:0,id:"ask",type:"function",function:{name:"graph_mailbox",arguments:JSON.stringify(body.messages.some((m:any)=>m.role==="tool")?{action:"wait"}:{action:"send",to:"@parent",kind:"decision",text:"ESCAPE_ASK_PENDING",idempotencyKey:"escape-decision"})}}]},null);emit({},"tool_calls");res.end("data: [DONE]\n\n");return;}
  const timer=setTimeout(()=>{timers.delete(timer);events.push({event:"late_tool_emitted",time:Date.now()});emit({tool_calls:[{index:0,id:"late",type:"function",function:{name:"write",arguments:JSON.stringify({path:"forbidden-after-escape.txt",content:"SHOULD_NOT_HAPPEN"})}}]},null);emit({},"tool_calls");res.end("data: [DONE]\n\n");},60000);timers.add(timer);
  res.on("close",()=>{clearTimeout(timer);timers.delete(timer);events.push({event:"child_connection_closed",time:Date.now()});});
 });});
 await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
 await writeFile(join(agentDir,"settings.json"),JSON.stringify({graph:{enabled:true,runsDir:runs},subagents:{disableBuiltins:true},quietStartup:true}));
 await writeFile(join(agentDir,"models.json"),JSON.stringify({providers:{"fixture-local":{baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,api:"openai-completions",apiKey:"fixture",models:[{id:"local",name:"local",reasoning:false,input:["text"],contextWindow:100000,maxTokens:4000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 await writeFile(join(agents,"worker.md"),"---\nname: worker\ndescription: Esc isolated worker\nmodel: fixture-local/local\nthinking: off\ninheritProjectContext: false\ninheritSkills: false\n---\nExecute the exact fixture task.\n");
 const child=spawn("python3",[join(repo,"tests/helpers/future-material-pty.py"),process.execPath,piCliPath!,"--offline","--no-session","--no-context-files","--no-skills","--no-extensions","--provider","pi-graph-faux","--model","faux-1","--extension",join(repo,"tests/helpers/future-material-provider.ts"),"--extension",join(repo,"extensions/pi-graph.ts"),"--extension",join(repo,"tests/helpers/escape-ui-capture.ts")],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_GRAPH_RUNTIME_ROOT:native,PI_GRAPH_UI_CAPTURE_DIR:capture,TERM:"xterm-256color",PI_OFFLINE:"1",HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:"",NO_PROXY:"127.0.0.1,localhost"},stdio:["pipe","pipe","pipe"]});
 let output="";let ptyPid:number|undefined;child.stdout.on("data",d=>output+=String(d));child.stderr.on("data",d=>{output+=String(d);ptyPid=Number(/PI_GRAPH_TEST_PTY_PID=(\d+)/.exec(output)?.[1])||ptyPid;});
 const send=(text:string)=>child.stdin.write(text+"\r"),key=(data:string)=>child.stdin.write(data),screen=()=>readFile(join(capture,"screen.txt"),"utf8");
 const parentState=()=>readFile(join(capture,"parent-agent.json"),"utf8").then(JSON.parse);
 const parentIdle=(afterEnds:number,label:string)=>until(parentState,s=>s.isIdle && s.ends>afterEnds,label);
 const snapshot=(id:string)=>readFile(join(runs,id,"snapshot.json"),"utf8").then(JSON.parse);
 const control=(id:string)=>readFile(join(runs,id,"control.json"),"utf8").then(JSON.parse);
 const start=(id:string,ask=false)=>send("PI_GRAPH_PUBLIC_RPC_E2E "+JSON.stringify({action:"start",spec:{schemaVersion:3,graphId:id,goal:"Escape fixture",nodes:[{taskId:"child",agent:"worker",task:ask?"ESCAPE_ASK":"ESCAPE_DELAY",sideEffect:ask?"none":"local_write",...(ask?{}:{writeScope:[{kind:"file",path:"forbidden-after-escape.txt"}],validationCommands:["test -f forbidden-after-escape.txt"]})}]}}));
 try{
  await until(screen,(s:string)=>s.length>0,"TUI initialized");
  start("escape-observer");await until(()=>snapshot("escape-observer"),s=>s.nodes.child.phase==="running","real child running");await until(async()=>events,e=>e.some((v:any)=>v.event==="child_request"),"actual HTTP child request");
  send("/graphs view escape-observer");await until(screen,(s:string)=>/q\s*关闭/.test(s),"inspector open");key("\x1b");await sleep(500);
  assert.notEqual((await control("escape-observer")).desiredState,"stopped","closing inspector must not stop");
  send("/model");await sleep(400);key("\x1b");await sleep(300);assert.notEqual((await control("escape-observer")).desiredState,"stopped","closing model menu must not stop");
  send("/reload");await until(()=>control("escape-observer"),s=>s.desiredState==="paused","reload suspends instead of stopping");
  await until(screen,(s:string)=>s.includes("Reloaded keybindings"),"reload completed");await sleep(600);
  start("escape-wait");await until(()=>snapshot("escape-wait"),s=>s.nodes.child.phase==="running","fresh child after reload");
  send("PI_GRAPH_PUBLIC_RPC_E2E "+JSON.stringify({action:"wait",id:"escape-wait"}));await until(parentState,s=>!s.isIdle && s.activeTools?.includes("graph"),"foreground graph wait tool is actually active");
  send("/graphs view escape-wait");await until(screen,(s:string)=>/q\s*关闭/.test(s),"busy inspector");key("\x1b");await sleep(300);assert.notEqual((await control("escape-wait")).desiredState,"stopped","busy inspector close does not abort graph");
  send("/model");await sleep(350);key("\x1b");await sleep(250);assert.notEqual((await control("escape-wait")).desiredState,"stopped","busy model close does not abort graph");
  const waitParentBeforeCancel=await parentState();key("\x1b");
  const stopped=await until(()=>snapshot("escape-wait"),s=>s.status==="stopped","stop terminal evidence");
  assert.equal(stopped.status,"stopped",JSON.stringify(stopped));assert.equal(stopped.nodes.child.terminalStatus,"aborted");
  assert.equal((await control("escape-wait")).desiredState,"stopped");
  assert.notEqual((await control("escape-observer")).desiredState,"stopped","unassociated pre-reload graph is untouched");
  await until(async()=>events,e=>e.some((v:any)=>v.event==="child_connection_closed"),"child HTTP stream closed");
  await parentIdle(waitParentBeforeCancel.ends,"cancelled graph-wait parent ended and idle");
  await writeFile(join(capture,"wait-escape.txt"),await screen());
  // A graph yielded for supervisor attention remains associated while the parent
  // starts another ordinary model turn. Escape of that turn must stop its child.
  start("escape-attention",true);await until(screen,(s:string)=>s.includes("待主 Agent 决策")&&s.includes("fixture-local/local"),"native attention");
  await until(parentState,s=>s.isIdle,"attention start parent idle");
  const attentionWaitBefore=await parentState();
  send("PI_GRAPH_PUBLIC_RPC_E2E "+JSON.stringify({action:"wait",id:"escape-attention"}));
  await parentIdle(attentionWaitBefore.ends,"attention wait actually returned and parent idle");
  key("\x1b");await sleep(250);assert.notEqual((await control("escape-attention")).desiredState,"stopped","idle Escape must be safe");
  const modelBefore=await parentState();send("PI_GRAPH_CHILD_DELAY_MS=20000 PARENT_BUSY");
  await until(parentState,s=>!s.isIdle && s.starts>modelBefore.starts,"parent model truly active");key("\x1b");
  const attentionStopped=await until(()=>snapshot("escape-attention"),s=>s.status==="stopped"||s.status==="needs_attention","parent model abort stop");assert.equal(attentionStopped.status,"stopped",JSON.stringify(attentionStopped));
  await parentIdle(modelBefore.ends,"cancelled model parent ended and idle");
  const ordinaryBefore=await parentState();send("ORDINARY_PI_CHECK");
  await parentIdle(ordinaryBefore.ends,"ordinary prompt actually ended");
  await until(screen,(s:string)=>s.includes("ORDINARY_PI_OK"),"ordinary input remains usable");
  await sleep(1200);assert.equal(events.some(e=>e.event==="late_tool_emitted"),false,"stopped children cannot issue delayed tools");assert.equal(await readFile(join(root,"forbidden-after-escape.txt"),"utf8").catch(()=>null),null);
  await writeFile(join(capture,"success.json"),JSON.stringify({stopped,attentionStopped,events,ordinary:"ORDINARY_PI_OK"},null,2));console.log("ESCAPE_TUI_PASS "+root);
 }catch(error){await writeFile(join(capture,"failure.txt"),String(error)+"\n"+await screen().catch(()=>output));throw error;}
 finally{
  await cleanupThenSaveEvidence(async()=>{
   for(const timer of timers)clearTimeout(timer);
   try{
    child.kill("SIGTERM");await sleep(2300);
    if(child.exitCode===null){if(ptyPid)try{process.kill(-ptyPid,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}child.kill("SIGKILL");}
   }finally{
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();
    server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
   }
  },async()=>{
   await writeFile(join(capture,"terminal.txt"),output);await writeFile(join(capture,"events.json"),JSON.stringify(events,null,2));
   const destination=process.env.PI_GRAPH_ESCAPE_EVIDENCE_DIR ?? join(repo,".test-evidence",`escape-tui-${Date.now()}`);await mkdir(destination,{recursive:true});await cp(capture,join(destination,"capture"),{recursive:true});await cp(runs,join(destination,"runs"),{recursive:true});console.error("ESCAPE_TUI_EVIDENCE "+destination);
  });
 }
});
