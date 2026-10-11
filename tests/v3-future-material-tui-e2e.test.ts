import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { piCliPath } from "./helpers/pi-cli.ts";

const cli = process.env.PI_GRAPH_NATIVE_TUI_CLI ?? piCliPath;
const sleep = (ms:number) => new Promise(done=>setTimeout(done,ms));
async function until<T>(read:()=>Promise<T>, accept:(value:T)=>boolean, label:string, timeout=45000):Promise<T> {
 const end=Date.now()+timeout;let last:unknown;
 while(Date.now()<end){try{const value=await read();last=value;if(accept(value))return value;}catch(e){last=String(e);}await sleep(150);}
 throw new Error(`Timed out: ${label}; latest=${JSON.stringify(last)}`);
}

test("real Pi TUI: future material producer/consumer, mailbox decision wait/reply, live UI and ordinary prompt",{timeout:180000},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"graph-future-tui-"))),repo=resolve(new URL("..",import.meta.url).pathname);
 const agentDir=join(root,"agent"),runs=join(root,"runs"),agents=join(root,".pi/agents"),capture=join(root,"capture"),native=join(root,"native");
 for(const dir of [agentDir,runs,agents,capture,native])await mkdir(dir,{recursive:true});
 const evidence:string[]=[];
 const server=createServer((req,res)=>{
  const chunks:Buffer[]=[];req.on("data",c=>chunks.push(c));req.on("end",()=>{
   const body=JSON.parse(Buffer.concat(chunks).toString());const text=JSON.stringify(body.messages);
   const mode=text.includes("FUTURE_PRODUCER")?"producer":text.includes("FUTURE_CONSUMER")?"consumer":"ask";
   const results=body.messages.filter((m:any)=>m.role==="tool");evidence.push(JSON.stringify({mode,results,tools:body.tools?.map((t:any)=>t.function.name)}));
   const call=mode==="producer"?{name:"write",arguments:JSON.stringify({path:"generated/material.txt",content:"REAL_PRODUCER_MATERIAL"})}:mode==="consumer"?{name:"read",arguments:JSON.stringify({path:"generated/material.txt"})}:{name:"graph_mailbox",arguments:JSON.stringify(results.length===2?{action:"read",messageId:JSON.parse(results[1].content).messages[0].messageId}:results.length?{action:"wait"}:{action:"send",to:"@parent",kind:"decision",text:"FUTURE_TUI_DECISION",idempotencyKey:"future-decision"})};
   res.writeHead(200,{"content-type":"text/event-stream"});
   const emit=(delta:any,finish_reason:any)=>res.write(`data: ${JSON.stringify({id:"future-tui",object:"chat.completion.chunk",created:1,model:"local",choices:[{index:0,delta,finish_reason}]})}\n\n`);
   const done = mode === "ask" ? results.length >= 3 : results.length > 0;
   emit(done?{role:"assistant",content:`REAL_${mode.toUpperCase()}_DONE ${JSON.stringify(results)}`}:{role:"assistant",tool_calls:[{index:0,id:`call-${mode}`,type:"function",function:call}]},null);
   emit({},done?"stop":"tool_calls");res.end("data: [DONE]\n\n");
  });
 });
 await new Promise<void>((done,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",done);});
 await writeFile(join(agentDir,"settings.json"),JSON.stringify({graph:{enabled:true,runsDir:runs},subagents:{disableBuiltins:true},quietStartup:true}));
 await writeFile(join(agentDir,"models.json"),JSON.stringify({providers:{"fixture-local":{baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,api:"openai-completions",apiKey:"fixture",models:[{id:"local",name:"local",reasoning:false,input:["text"],contextWindow:100000,maxTokens:4000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 await writeFile(join(agents,"worker.md"),"---\nname: worker\ndescription: Isolated real CLI fixture\nmodel: fixture-local/local\nthinking: off\ninheritProjectContext: false\ninheritSkills: false\n---\nExecute the exact fixture task.\n");
 const child=spawn("python3",[join(repo,"tests/helpers/future-material-pty.py"),process.execPath,cli!,"--offline","--no-session","--no-context-files","--no-skills","--no-extensions","--provider","pi-graph-faux","--model","faux-1","--extension",join(repo,"tests/helpers/future-material-provider.ts"),"--extension",join(repo,"extensions/pi-graph.ts"),"--extension",join(repo,"tests/helpers/native-ui-capture.ts")],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_GRAPH_RUNTIME_ROOT:native,PI_GRAPH_UI_CAPTURE_DIR:capture,TERM:"xterm-256color",PI_OFFLINE:"1",HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:"",NO_PROXY:"127.0.0.1,localhost"},stdio:["pipe","pipe","pipe"]});
 let output="", ptyPid:number|undefined, failed=false;child.stdout.on("data",d=>{output+=String(d);});child.stderr.on("data",d=>{output+=String(d);const match=/PI_GRAPH_TEST_PTY_PID=(\d+)/.exec(output);if(match)ptyPid=Number(match[1]);});
 const screen=()=>readFile(join(capture,"screen.txt"),"utf8");
 const send=(text:string)=>child.stdin.write(text+"\r");
 const snapshot=(id:string)=>readFile(join(runs,id,"snapshot.json"),"utf8").then(JSON.parse);
 try{
  await until(screen,s=>s.length>0,"TUI initialized");
  const spec={schemaVersion:3,graphId:"future-cli-material",goal:"Real producer then consumer",nodes:[{taskId:"produce",agent:"worker",task:"FUTURE_PRODUCER",sideEffect:"local_write",writeScope:[{kind:"file",path:"generated/material.txt"}],validationCommands:["test -f generated/material.txt"]},{taskId:"consume",agent:"worker",task:"FUTURE_CONSUMER",sideEffect:"local_read",dependsOn:["produce"],readScope:[{kind:"file",path:"generated/material.txt"}],requiredMaterials:["generated/material.txt"]}]};
  send("PI_GRAPH_PUBLIC_RPC_E2E "+JSON.stringify({action:"start",spec}));
  const completed=await until(()=>snapshot(spec.graphId),s=>["complete","failed","needs_attention"].includes(s.status),"material graph terminal",60000);
  assert.equal(completed.status,"complete",JSON.stringify(completed));assert.equal(await readFile(join(root,"generated/material.txt"),"utf8"),"REAL_PRODUCER_MATERIAL");
  assert.ok(evidence.some(row=>row.includes('"mode":"consumer"')&&row.includes("REAL_PRODUCER_MATERIAL")),"actual consumer read must return producer bytes");
  await writeFile(join(capture,"material-complete.txt"),await screen());
  send("PI_GRAPH_PUBLIC_RPC_E2E "+JSON.stringify({action:"start",spec:{schemaVersion:3,graphId:"future-cli-ask",goal:"Real native supervisor",nodes:[{taskId:"ask",agent:"worker",task:"FUTURE_ASK",sideEffect:"none"}]}}));
  await until(screen,s=>s.includes("等待用户处理")&&s.includes("ask"),"widget auto waiting",60000);
  await writeFile(join(capture,"widget-waiting.txt"),await screen());
  send("/graphs view future-cli-ask");await until(screen,s=>s.includes("等待用户")&&s.includes("future-cli-ask")&&s.includes("q 关闭")&&s.includes("关闭只返回输入，不停止任务"),"inspector waiting");
  await writeFile(join(capture,"inspector-waiting.txt"),await screen());child.stdin.write("q");await sleep(300);
  const pending=await until<{id:string}|null>(async()=>{
   const state=JSON.parse(await readFile(join(runs,"future-cli-ask/mailbox-v1/state.json"),"utf8"));
   return state.messages.find((m:any)=>m.to==="@parent"&&m.text==="FUTURE_TUI_DECISION")??null;
  },Boolean,"real mailbox decision");
  assert.ok(pending);send("PI_GRAPH_REPLY "+JSON.stringify({graphId:"future-cli-ask",messageId:pending.id}));
  const finished=await until(()=>snapshot("future-cli-ask"),s=>["complete","failed","needs_attention"].includes(s.status),"reply child complete",60000);
  assert.equal(finished.status,"complete",JSON.stringify(finished));assert.ok(evidence.some(row=>row.includes('"mode":"ask"')&&row.includes("CONTINUE_REAL_CHILD")));
  await until(screen,s=>!s.includes("◆ Graph · 等待用户处理"),"widget clears waiting after reply");
  send("/graphs view future-cli-ask");await until(screen,s=>s.includes("已完成")&&s.includes("ask")&&!s.includes("等待用户处理"),"inspector resolved");
  await writeFile(join(capture,"inspector-resolved.txt"),await screen());child.stdin.write("q");await sleep(300);
  send("ORDINARY_PI_CHECK");await until(screen,s=>s.includes("ORDINARY_PI_OK"),"ordinary Pi turn");
  await writeFile(join(capture,"ordinary-pi.txt"),await screen());
  console.log(JSON.stringify({result:"PASS",root,material:"real write -> apply -> requiredMaterials -> real read",supervisor:"actual mailbox send/wait -> widget/inspector -> actual reply -> complete",ordinary:"ORDINARY_PI_OK"}));
 }catch(e){
  failed=true;
  const detail=`${String(e)}\nEvidence root: ${root}\nScreen: ${await screen().catch(()=>output.slice(-20000))}\nRequests: ${evidence.join("\n")}`;
  console.error("TUI_E2E_FAILURE " + detail);
  await writeFile(join(capture,"failure.txt"),detail);
  throw new Error(detail,{cause:e});
 }
 finally{
  // Persist failure details before shutdown, so a stuck CLI cannot hide them.
  await writeFile(join(capture,"model-evidence.jsonl"),evidence.join("\n"));await writeFile(join(capture,"terminal-output.txt"),output);
  const destination=process.env.PI_GRAPH_NATIVE_TUI_EVIDENCE_DIR ?? (failed ? join(repo,".test-evidence",`future-tui-${Date.now()}`) : undefined);
  if(destination){
   const {cp}=await import("node:fs/promises");await mkdir(destination,{recursive:true});
   await cp(capture,join(destination,"capture"),{recursive:true});
   await cp(runs,join(destination,"runs"),{recursive:true});
   console.error("TUI_E2E_EVIDENCE " + destination);
  }
  const exited=()=>child.exitCode!==null||child.signalCode!==null;
  child.kill("SIGTERM");
  const deadline=Date.now()+3000;
  while(!exited()&&Date.now()<deadline)await sleep(50);
  if(!exited()){
   // This group ID comes only from our own freshly spawned PTY wrapper.
   if(ptyPid)try{process.kill(-ptyPid,"SIGKILL");}catch{}
   child.kill("SIGKILL");
  }
  child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();
  await Promise.race([new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections();}),sleep(1000)]);
  await rm(root,{recursive:true,force:true});
 }
});
