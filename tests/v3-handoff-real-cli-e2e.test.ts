import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, readdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { piCliPath } from "./helpers/pi-cli.ts";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(read:()=>Promise<T>,accept:(v:T)=>boolean,label:string,timeout=30000):Promise<T>{
 const end=Date.now()+timeout;let last:unknown;
 while(Date.now()<end){try{const v=await read();last=v;if(accept(v))return v;}catch(e){last=String(e);}await sleep(100);}
 throw new Error(`Timeout ${label}: ${JSON.stringify(last)}`);
}
// Public RPC drives the real parent CLI; child CLI uses only a local deterministic SSE provider.
test("real Pi: existing/new mailbox decisions, public reply, persistent declared evidence and strict status gates",{timeout:180000},async()=>{
 const repo=resolve(new URL("..",import.meta.url).pathname),root=await realpath(await mkdtemp(join(tmpdir(),"graph-handoff-cli-")));
 const home=join(root,"home"),runs=join(root,"runs"),native=join(root,"native"),agents=join(root,".pi/agents");
 for(const dir of [home,runs,native,agents])await mkdir(dir,{recursive:true});
 const requests:any[]=[];let freshAskDelay=2500;
 const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on("data",c=>chunks.push(c));req.on("end",async()=>{
  try {
   const body=JSON.parse(Buffer.concat(chunks).toString()),text=JSON.stringify(body.messages),tools=body.messages.filter((m:any)=>m.role==="tool");
   const task=/HANDOFF_(EXISTING_ASK|NEW_ASK|PRODUCER|CONSUMER|BLOCKED|FAIL|INVALID|DOWNSTREAM)/.exec(text)?.[1]??"UNKNOWN";
   requests.push({task,body});let call:any,content:string|undefined;
   if(task.endsWith("ASK")&&tools.length<3){if(task==="NEW_ASK"&&!tools.length){await sleep(freshAskDelay);freshAskDelay=0;}call={name:"graph_mailbox",arguments:JSON.stringify(tools.length===2?{action:"read",messageId:JSON.parse(tools[1].content).messages[0].messageId}:tools.length?{action:"wait"}:{action:"send",to:"@parent",kind:"decision",text:`HANDOFF_${task}_QUESTION`,idempotencyKey:`decision-${task}`})};}
   else if(task==="PRODUCER"&&tools.length<2)call={name:"write",arguments:JSON.stringify({path:tools.length?"secret.txt":"report.json",content:tools.length?"DO_NOT_EXPORT_SECRET":"DECLARED_REAL_EVIDENCE"})};
   else if(task==="CONSUMER"&&!tools.length)call={name:"read",arguments:JSON.stringify({path:".pi-graph/inputs/report.files/report.json"})};
   else if(task==="BLOCKED")content=JSON.stringify({status:"blocked",reason:"Needs user decision; text PASS must not bypass status"});
   else if(task==="FAIL")content=JSON.stringify({status:"fail",reason:"Validation rejected; text PASS must not bypass status"});
   else if(task==="INVALID")content="PASS prose is not the required JSON";
   else content=JSON.stringify({status:"pass",reason:`${task} ${JSON.stringify(tools)}`});
   res.writeHead(200,{"content-type":"text/event-stream"});
   const emit=(delta:any,finish_reason:any)=>res.write(`data: ${JSON.stringify({id:"handoff-local",object:"chat.completion.chunk",created:1,model:"local",choices:[{index:0,delta,finish_reason}]})}\n\n`);
   emit(call?{role:"assistant",tool_calls:[{index:0,id:`call-${task}-${tools.length}`,type:"function",function:call}]}:{role:"assistant",content},null);
   emit({},call?"tool_calls":"stop");res.end("data: [DONE]\n\n");
  }catch(error){res.writeHead(500).end(String(error));}
 });});
 await new Promise<void>((done,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",done);});
 await writeFile(join(home,"settings.json"),JSON.stringify({graph:{enabled:true,runsDir:runs},subagents:{disableBuiltins:true},quietStartup:true}));
 await writeFile(join(home,"models.json"),JSON.stringify({providers:{"fixture-local":{baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,api:"openai-completions",apiKey:"fixture",models:[{id:"local",name:"local",reasoning:false,input:["text"],contextWindow:100000,maxTokens:4000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 await writeFile(join(agents,"worker.md"),"---\nname: worker\ndescription: Isolated handoff CLI fixture\nmodel: fixture-local/local\nthinking: off\ninheritProjectContext: false\ninheritSkills: false\n---\nExecute the exact fixture task.\n");
 const child=spawn(process.execPath,[piCliPath,"--mode","rpc","--offline","--session",join(root,"saved-parent.jsonl"),"--no-context-files","--no-skills","--no-extensions","--provider","pi-graph-faux","--model","faux-1","--extension",join(repo,"tests/helpers/handoff-real-provider.ts"),"--extension",join(repo,"extensions/pi-graph.ts")],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:home,PI_GRAPH_RUNTIME_ROOT:native,PI_OFFLINE:"1",HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:"",NO_PROXY:"127.0.0.1,localhost"},stdio:["pipe","pipe","pipe"]});
 const messages:any[]=[];let buffer="",stderr="",serial=0;
 child.stdout.on("data",d=>{buffer+=String(d);for(;;){const n=buffer.indexOf("\n");if(n<0)break;const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(line.trim())messages.push(JSON.parse(line));}});child.stderr.on("data",d=>stderr+=String(d));
 const turnTimelines:any[]=[];
 async function turn(text:string,toolName?:string){const before=messages.length,id=`prompt-${++serial}`;child.stdin.write(JSON.stringify({type:"prompt",id,message:text,streamingBehavior:"followUp"})+"\n");
  const expected=text.startsWith("PI_GRAPH_PUBLIC_RPC_E2E ")?JSON.parse(text.slice("PI_GRAPH_PUBLIC_RPC_E2E ".length)):text.startsWith("PI_GRAPH_REPLY ")?{action:"mailbox",id:JSON.parse(text.slice("PI_GRAPH_REPLY ".length)).graphId,mailbox:{messageId:JSON.parse(text.slice("PI_GRAPH_REPLY ".length)).messageId}}:undefined;
  const userText=(event:any)=>Array.isArray(event.message?.content)?event.message.content.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n"):event.message?.content;
  let selected:any;
  const events=await until(async()=>messages.slice(before),m=>{
   const response=m.findIndex(e=>e.type==="response"&&e.id===id&&e.command==="prompt");
   const user=m.findIndex(e=>e.type==="message_start"&&e.message?.role==="user"&&userText(e)===text);
   if(response<0)return false;
   assert.equal(m[response].success,true,JSON.stringify(m[response]));
   if(user<0)return false;
   if(!toolName){const end=m.findIndex((e,i)=>i>user&&e.type==="agent_end");if(end<0)return false;selected={response,user,end};return true;}
   const call=m.findIndex((e,i)=>i>user&&e.type==="tool_execution_start"&&e.toolName===toolName&&e.args?.action===expected.action&&(e.args?.id??e.args?.spec?.graphId)===(expected.id??expected.spec?.graphId)&&(!expected.mailbox?.messageId||e.args?.mailbox?.messageId===expected.mailbox.messageId));
   if(call<0)return false;
   const callId=m[call].toolCallId,toolEnd=m.findIndex((e,i)=>i>call&&e.type==="tool_execution_end"&&e.toolCallId===callId&&e.toolName===toolName);
   const end=m.findIndex((e,i)=>i>toolEnd&&e.type==="agent_end");if(toolEnd<0||end<0)return false;
   selected={response,user,call,callId,toolEnd,end};return true;
  },`parent turn ${id}`,35000);
  const result=toolName?events[selected.toolEnd]?.result:undefined;
  turnTimelines.push({id,action:expected?.action,graphId:expected?.id??expected?.spec?.graphId,...selected,oldAgentEnds:events.slice(0,selected.user).filter(e=>e.type==="agent_end").length});
  if(toolName)assert.ok(result,JSON.stringify(turnTimelines));return {result,events};
 }
 const graph=(arg:any)=>turn("PI_GRAPH_PUBLIC_RPC_E2E "+JSON.stringify(arg),"graph");
 const snapshot=(id:string)=>readFile(join(runs,id,"snapshot.json"),"utf8").then(JSON.parse);
 const terminal=(id:string)=>until(()=>snapshot(id),s=>["complete","failed","needs_attention"].includes(s.status),`terminal ${id}`,45000);
 const spec=(id:string,nodes:any[])=>({schemaVersion:3,graphId:id,goal:"Isolated real handoff test",nodes});
 async function pending(id:string,task:string){return until<any>(async()=>{
  const state=JSON.parse(await readFile(join(runs,id,"mailbox-v1/state.json"),"utf8"));
  const message=state.messages.find((m:any)=>m.to==="@parent"&&m.text===`HANDOFF_${task}_QUESTION`);
  return message?{...message,owner:state.owner,runInstanceId:state.runInstanceId}:null;
 },Boolean,`mailbox ${task}`);}
 try{
  for(const [id,task,preexisting] of [["handoff-existing","EXISTING_ASK",true],["handoff-new","NEW_ASK",false]] as const){
   const started=await graph({action:"start",spec:spec(id,[{taskId:"ask",agent:"worker",task:`HANDOFF_${task}`,sideEffect:"none",resultContract:"status-json"}])});assert.equal(started.result.isError,undefined,JSON.stringify(started.result));
   if(preexisting){
    await pending(id,task);
    const attention=await graph({action:"attention",id});
    assert.equal(attention.result.details?.requestCount,1);
    assert.match(JSON.stringify(attention.result),/waiting_user/);
    assert.match(JSON.stringify(attention.result),/HANDOFF_EXISTING_ASK_QUESTION/);
   }
   const before=Date.now(),waited=await graph({action:"wait",id});assert.ok(Date.now()-before<12000,"mailbox decision must return graph wait promptly");
   assert.equal(waited.result.details?.waitReason,"attention_required",JSON.stringify(waited.result));
   assert.match(JSON.stringify(waited.result),new RegExp(`HANDOFF_${task}_QUESTION`));
   assert.match(JSON.stringify(waited.events),/PARENT_RECEIVED_GRAPH_RESULT.*HANDOFF_/s,"actual parent model must receive request content");
   const request=await pending(id,task);
   const savedSnapshot=await snapshot(id);
   const {readLatestV3Attempt}=await import("../src/v3/attempt.ts");
   const binding=(await readLatestV3Attempt(join(runs,id),"ask"))!.evidence.dispatch!;
   const nativeStatus=JSON.parse(await readFile(join(binding.asyncDir,"status.json"),"utf8"));
   const sessionHeader=JSON.parse((await readFile(join(root,"saved-parent.jsonl"),"utf8")).split("\n")[0]);
   assert.equal(sessionHeader.type,"session");assert.equal(sessionHeader.id,savedSnapshot.sessionId);
   assert.equal(request.owner,savedSnapshot.sessionId);
   assert.equal(request.runInstanceId,savedSnapshot.runInstanceId);
   assert.equal(nativeStatus.runtimeKind,"pi-graph-sdk/1");
   assert.equal(nativeStatus.sessionId,request.owner, "runtime status retains the parent owner for result correlation");
   const childSessionFile=nativeStatus.steps[0].sessionFile;
   const childSessionHeader=JSON.parse((await readFile(childSessionFile,"utf8")).split("\n")[0]);
   assert.notEqual(childSessionFile,join(root,"saved-parent.jsonl"));
   assert.notEqual(childSessionHeader.id,request.owner,"actual SDK child session is isolated from its parent");
   await turn("PI_GRAPH_REPLY "+JSON.stringify({graphId:id,messageId:request.id}),"graph");
   assert.equal((await terminal(id)).status,"complete");
   assert.ok(requests.some(r=>r.task===task&&JSON.stringify(r.body.messages).includes("CONTINUE_REAL_CHILD")),"public reply must resume actual child");
   assert.match(JSON.stringify((await turn("ORDINARY_PI_CHECK")).events),/ORDINARY_PI_OK/);
  }
  const evidenceId="handoff-evidence";
  const started=await graph({action:"start",spec:spec(evidenceId,[{taskId:"produce",agent:"worker",task:"HANDOFF_PRODUCER",sideEffect:"external_write",resultContract:"status-json",outputArtifact:"report",evidenceFiles:[{path:"report.json",nonSecret:true}]},{taskId:"consume",agent:"worker",task:"HANDOFF_CONSUMER",sideEffect:"local_read",resultContract:"status-json",dependsOn:["produce"],inputArtifacts:["report"]}])});assert.equal(started.result.isError,undefined,JSON.stringify(started.result));
  const completed=await terminal(evidenceId);assert.equal(completed.status,"complete",JSON.stringify(completed));
  const evidenceDir=join(runs,evidenceId,"artifacts/produce/attempt-1-files");
  assert.equal(await readFile(join(evidenceDir,"files/report.json"),"utf8"),"DECLARED_REAL_EVIDENCE");
  const manifest=JSON.parse(await readFile(join(evidenceDir,"manifest.json"),"utf8"));assert.deepEqual(manifest.files.map((f:any)=>f.path),["report.json"]);
  await assert.rejects(access(join(evidenceDir,"files/secret.txt")));
  await until(async()=>access(join(runs,evidenceId,"shadow/produce-1/workspace")).then(()=>false,()=>true),Boolean,"producer cleanup");
  assert.ok(requests.some(r=>r.task==="CONSUMER"&&JSON.stringify(r.body.messages.filter((m:any)=>m.role==="tool")).includes("DECLARED_REAL_EVIDENCE")),"actual consumer must read retained bytes after producer cleanup");
  assert.ok(!requests.some(r=>r.task==="CONSUMER"&&JSON.stringify(r.body).includes("DO_NOT_EXPORT_SECRET")),"undeclared secret must not enter consumer capsule");
  for(const status of ["BLOCKED","FAIL","INVALID"]){
   const id=`handoff-${status.toLowerCase()}`,before=requests.length;
   const start=await graph({action:"start",spec:spec(id,[{taskId:"gate",agent:"worker",task:`HANDOFF_${status}`,sideEffect:"external_write",resultContract:"status-json",retryPolicy:{maxAttempts:3,retryOn:["task_failed","validation"],backoffMs:0}},{taskId:"downstream",agent:"worker",task:"HANDOFF_DOWNSTREAM",sideEffect:"none",dependsOn:["gate"]}])});assert.equal(start.result.isError,undefined,JSON.stringify(start.result));
   const waited=await graph({action:"wait",id});if(waited.result.details?.status!=="failed"){assert.equal(waited.result.details?.status,"running",JSON.stringify(waited.result));assert.equal(waited.result.details?.waitReason,"attention_required");assert.equal(waited.result.details?.waitEvidence?.kind,"confirmed_exit");assert.notEqual(waited.result.details?.graphContinuesRunning,true);}
   const final=await terminal(id);assert.equal(final.status,"failed");assert.equal(final.nodes.gate.phase,"failed");assert.notEqual(final.nodes.downstream.phase,"accepted");
   assert.equal(requests.slice(before).filter(r=>r.task===status).length,1,"business/invalid results must never replay external operation");assert.equal(requests.slice(before).filter(r=>r.task==="DOWNSTREAM").length,0);
   assert.match(JSON.stringify((await turn("ORDINARY_PI_CHECK")).events),/ORDINARY_PI_OK/);
  }
  console.log("HANDOFF_TURN_TIMELINES "+JSON.stringify(turnTimelines));
  console.log("HANDOFF_REAL_CLI_PASS existing/new wait -> parent result -> public reply -> child complete; evidence retained/read; blocked/fail/invalid gate without replay; ordinary input");
 }catch(error){throw new Error(`${String(error)}\n${stderr}\nRecent RPC=${JSON.stringify(messages.slice(-30).map(m=>({type:m.type,toolName:m.toolName,content:m.message?.content,result:m.result?.content})))}\nRequests=${JSON.stringify(requests.map(r=>({task:r.task,messages:r.body.messages.filter((m:any)=>m.role!=="system")})))}`,{cause:error});}
 finally{child.kill("SIGTERM");await Promise.race([new Promise<void>(r=>child.once("close",()=>r())),sleep(3000)]);if(child.exitCode===null)child.kill("SIGKILL");child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
