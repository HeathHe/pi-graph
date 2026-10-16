import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { initializeV3Run } from "../src/v3/initialize.ts";
import { acquireV3RunLease } from "../src/v3/lease.ts";

// Public tool execution, real durable run/lease/store/UDS/active registry.
// No host.start, child/model dispatch, production RPC or provider is used.
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),"mailbox-public-")));
  const runDir=join(root,"public"),source=join(root,"source"),home=join(root,"agent");
  await mkdir(source);await mkdir(home);
  await writeFile(join(home,"settings.json"),JSON.stringify({graph:{enabled:true,runsDir:root}}));
  const graph=compileGraphSpecV3({schemaVersion:3,graphId:"public",goal:"public mailbox",nodes:[
    {taskId:"a",agent:"fixture-a",task:"not dispatched",sideEffect:"none"},
    {taskId:"b",agent:"fixture-b",task:"not dispatched",sideEffect:"none"},
  ]});
  await initializeV3Run({trustedRoot:root,runDir,graph,sessionId:"owner",supervisorEpoch:"epoch",sourceCwd:source,runInstanceId:"instance"});
  const lease=await acquireV3RunLease(join(runDir,"lease.json"),"instance");
  const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=home;
  const jiti=createJiti(import.meta.url);
  const {GraphMailbox}=await jiti.import<any>(new URL("../src/v3/mailbox.ts",import.meta.url).href);
  const {MailboxBroker,mailboxRequest}=await jiti.import<any>(new URL("../src/v3/mailbox-transport.ts",import.meta.url).href);
  const {activeMailboxes,mailboxRegistryKey}=await jiti.import<any>(new URL("../src/v3/mailbox-runtime.ts",import.meta.url).href);
  const store=new GraphMailbox(runDir,lease,async(task:string,attempt:number)=>["a","b"].includes(task)&&attempt===1);
  await store.initialize("instance","owner",[{taskId:"a",attempt:1},{taskId:"b",attempt:1}]);
  const broker=new MailboxBroker(store);await broker.start();
  const key=mailboxRegistryKey(runDir);activeMailboxes.set(key,{mailbox:store,owner:"owner",runInstanceId:"instance"});
  const counters={sendMessage:0,rootMailboxEvents:0,providerCalls:0,nativeRpcRequests:0};
  const handlers=new Map<string,Function[]>();let tool:any;
  const listeners=new Map<string,Set<Function>>();
  const events={on(name:string,fn:Function){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);},
    emit(name:string,value:unknown){if(name==="pi-graph:mailbox")counters.rootMailboxEvents++;if(name==="subagent:request")counters.nativeRpcRequests++;for(const fn of listeners.get(name)??[])fn(value);}};
  const extension=(await jiti.import<any>(new URL("../extensions/pi-graph.ts",import.meta.url).href)).default;
  extension({events,on(name:string,fn:Function){const rows=handlers.get(name)??[];rows.push(fn);handlers.set(name,rows);},registerCommand(){},registerTool(value:any){if(value.name==="graph")tool=value;},
    sendMessage(){counters.sendMessage++;throw new Error("Parent must not relay mailbox text");},getActiveTools:()=>["graph","read"]});
  assert.ok(tool,"actual Graph extension must register its public tool");
  const context=(owner="owner")=>({cwd:source,mode:"json",sessionManager:{getSessionId:()=>owner,getSessionFile:()=>undefined,getEntries:()=>[]},modelRegistry:{getAvailable:()=>[]},ui:{notify(){}}});
  let callId=0;
  const call=async(action:string,mailbox?:unknown,owner="owner")=>tool.execute("public-"+(++callId),{action,id:"public",...(mailbox?{mailbox}:{})},undefined,undefined,context(owner));
  const body=(value:any)=>{assert.notEqual(value.isError,true,JSON.stringify(value));return JSON.parse(value.content[0].text);};
  const send=async(actor:string,request:unknown)=>mailboxRequest({socketPath:broker.socketPath,token:await store.capability(actor,1)},request);
  return {store,broker,key,activeMailboxes,counters,call,body,send,runDir,tool,graph,source,
    async close(){activeMailboxes.delete(key);await broker.close();await lease.release();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(root,{recursive:true,force:true});}};
}

test("public Graph mailbox/attention exposes only parent decisions/exceptions/results; P2P never relays or wakes root",async()=>{
  const f=await fixture();try{
    const peer:any=await f.send("a",{action:"send",to:"b",kind:"message",text:"private peer fixture",idempotencyKey:"peer"});
    assert.equal(f.body(await f.call("mailbox",{action:"receive"})).messages.length,0);
    const initial=f.body(await f.call("attention"));assert.equal(JSON.parse(initial.text).requests.length,0);
    assert.deepEqual(f.counters,{sendMessage:0,rootMailboxEvents:0,providerCalls:0,nativeRpcRequests:0});
    await assert.rejects(f.send("a",{action:"send",to:"@parent",kind:"message",text:"ordinary forbidden",idempotencyKey:"ordinary"}),/Parent receives/);
    const ids:string[]=[];
    for(const kind of ["decision","exception","result"]){const value:any=await f.send("a",{action:"send",to:"@parent",kind,text:"root "+kind,idempotencyKey:kind});ids.push(value.messageId);}
    const inbox=f.body(await f.call("mailbox",{action:"receive"}));assert.deepEqual(inbox.messages.map((m:any)=>m.kind),["decision","exception","result"]);
    assert.ok(!inbox.messages.some((m:any)=>m.messageId===peer.messageId));
    const attention=JSON.parse(f.body(await f.call("attention")).text);assert.deepEqual(attention.requests.map((r:any)=>r.requestId),ids);
    const reply=f.body(await f.call("mailbox",{action:"reply",messageId:ids[0],text:"fixture decision only",idempotencyKey:"answer"}));
    assert.equal(reply.replyTo,ids[0]);
    const after=JSON.parse(f.body(await f.call("attention")).text);assert.equal(after.requests.length,2);assert.ok(!after.requests.some((r:any)=>r.requestId===ids[0]));
    assert.deepEqual(f.counters,{sendMessage:0,rootMailboxEvents:0,providerCalls:0,nativeRpcRequests:0});
  }finally{await f.close();}
});

test("public Graph rejects wrong owner before mutation and inactive inspection preserves bytes",async()=>{
  const f=await fixture();try{
    const sent:any=await f.send("a",{action:"send",to:"@parent",kind:"decision",text:"persisted decision",idempotencyKey:"d"});
    const before=await readFile(f.store.path,"utf8"),snapshotBefore=await readFile(join(f.runDir,"snapshot.json"),"utf8");
    const rejected=await f.call("mailbox",{action:"reply",messageId:sent.messageId,text:"wrong owner",idempotencyKey:"wrong"},"other");
    assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/owner mismatch/i);assert.equal(await readFile(f.store.path,"utf8"),before);
    const attention=JSON.parse(f.body(await f.call("attention",undefined,"other")).text);assert.equal(attention.requests.length,0);assert.ok(attention.diagnostics.includes("owner_mismatch"));
    f.activeMailboxes.delete(f.key);
    const received=f.body(await f.call("mailbox",{action:"receive"}));assert.equal(received.readOnly,true);assert.equal(received.messages[0].messageId,sent.messageId);
    assert.equal(f.body(await f.call("mailbox",{action:"read",messageId:sent.messageId})).text,"persisted decision");
    assert.equal(f.body(await f.call("mailbox",{action:"status",messageId:sent.messageId})).readOnly,true);
    for(const action of ["ack","reply","send","wait","send"]){
      const response=await f.call("mailbox",{action,messageId:sent.messageId,to:"a",text:"no restart",idempotencyKey:"inactive"});
      assert.equal(response.isError,true);const payload=JSON.parse(response.content[0].text);
      assert.equal(payload.code,"mailbox_inactive");assert.equal(payload.action,action);assert.equal(payload.delivery,"not_sent");assert.equal(payload.taskRestarted,false);assert.equal(payload.canRetry,false);assert.deepEqual(payload.readOnlyActions,["receive","read","status"]);assert.equal(payload.taskEnded,false);assert.match(payload.message,/消息未发送.*核对运行状态/);assert.doesNotMatch(payload.message,/任务已结束/);assert.match(payload.nextStep,/子任务结束不等于总目标完成/);
      for(const key of ["code","action","delivery","taskRestarted","canRetry","readOnlyActions"])assert.deepEqual(response.details[key],payload[key]);
      const theme={fg:(_:string,text:string)=>text},context={args:{action:"mailbox"},state:{},toolCallId:"inactive-render",isError:true};
      const compact=f.tool.renderResult(response,{expanded:false,isPartial:false},theme,context).render(120).join("\n");assert.match(compact,/消息未发送/);assert.match(compact,/不可自动重试/);
      const expanded=f.tool.renderResult(response,{expanded:true,isPartial:false},theme,context).render(10000).join("\n");assert.match(expanded,/"delivery":"not_sent"/);assert.match(expanded,/"taskRestarted":false/);assert.match(expanded,/"canRetry":false/);assert.match(expanded,/核对运行状态/);

    }
    const foreign=await f.call("mailbox",{action:"send",to:"a",text:"foreign",idempotencyKey:"foreign"},"other");assert.equal(foreign.isError,true);assert.match(foreign.content[0].text,/owner mismatch/i);assert.doesNotMatch(foreign.content[0].text,/mailbox_inactive|任务已结束|persisted decision/);
    assert.equal(await readFile(join(f.runDir,"snapshot.json"),"utf8"),snapshotBefore);
    assert.equal(await readFile(f.store.path,"utf8"),before);
    assert.deepEqual(f.counters,{sendMessage:0,rootMailboxEvents:0,providerCalls:0,nativeRpcRequests:0});
  }finally{await f.close();}
});

 test("inactive mailbox distinguishes running from persisted terminal Graph status without mutation",async()=>{
  const f=await fixture();try{
   f.activeMailboxes.delete(f.key);
   const path=join(f.runDir,"snapshot.json"), original=JSON.parse(await readFile(path,"utf8"));
   const mailboxBefore=await readFile(f.store.path,"utf8");
   for(const status of ["running","complete","stopped"]){
    const now=new Date().toISOString();
    const {writeV3AttemptEvidence,writeV3AcceptanceEvidence,v3AcceptedAttemptBasis}=await import("../src/v3/attempt.ts");
    const {canonicalDigest}=await import("../src/v3/digests.ts");
    const {prepareV3Workspace}=await import("../src/v3/workspace.ts");
    for(const node of f.graph.nodes){
     let attempt:any={schemaVersion:1,runInstanceId:"instance",graphId:"public",taskId:node.taskId,attempt:1,attemptNonce:"fixture",supervisorEpoch:"epoch",createdAt:now,updatedAt:now,phase:status==="running"?"running":status==="complete"?"accepted":"aborted",...(status==="running"?{}:{terminalStatus:status==="complete"?"accepted":"aborted"})};
     if(status==="complete"){
      const workspace=await prepareV3Workspace({runInstanceId:"instance",graphId:"public",node,attempt:1,runDir:f.runDir,sourceCwd:f.source,workspace:"shadow"});
      attempt={...attempt,workspaceDigest:canonicalDigest(workspace.evidence),child:{terminal:"complete",output:"fixture done",completedAt:now}};
      attempt.acceptanceDigest=await writeV3AcceptanceEvidence(f.runDir,node.taskId,1,{schemaVersion:1,runInstanceId:"instance",graphId:"public",taskId:node.taskId,attempt:1,method:"declared",verified:false,validatedResultDigest:"",attemptDigest:canonicalDigest(v3AcceptedAttemptBasis(attempt)),recordedAt:now,supervisorEpoch:"epoch"});
      await mkdir(join(f.runDir,"artifacts",node.taskId),{recursive:true});await writeFile(join(f.runDir,"artifacts",node.taskId,"attempt-1.txt"),"fixture done");
     }
     await writeV3AttemptEvidence(f.runDir,node.taskId,1,attempt);
    }
    const controlPath=join(f.runDir,"control.json");const control={schemaVersion:1,runInstanceId:"instance",graphId:"public",desiredState:"running",revision:0,createdAt:now,updatedAt:now};control.desiredState=status==="stopped"?"stopped":"running";await writeFile(controlPath,JSON.stringify(control));
    const snapshot=structuredClone(original);snapshot.status=status;
    const bytes=JSON.stringify(snapshot);await writeFile(path,bytes);
    const response=await f.call("mailbox",{action:"send",to:"a",text:"not sent",idempotencyKey:status});
    assert.equal(response.isError,true);const body=JSON.parse(response.content[0].text);
    assert.equal(body.graphStatus,status);assert.equal(body.taskEnded,status!=="running");assert.equal(body.delivery,"not_sent");assert.equal(body.canRetry,false);
    if(status==="running")assert.doesNotMatch(body.message,/任务已结束/);else assert.match(body.message,/任务已结束/);
    const compact=f.tool.renderResult(response,{expanded:false,isPartial:false},{fg:(_:string,text:string)=>text},{args:{action:"mailbox"},state:{},isError:true}).render(200).join(" ");
    if(status==="running")assert.doesNotMatch(compact,/任务已结束/);else assert.match(compact,/任务已结束/);
    assert.equal(await readFile(path,"utf8"),bytes);assert.equal(await readFile(f.store.path,"utf8"),mailboxBefore);
   }
   assert.deepEqual(f.counters,{sendMessage:0,rootMailboxEvents:0,providerCalls:0,nativeRpcRequests:0});
  }finally{await f.close();}
 });
