import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { childSupervision, supervisionFacts, validateV3ChildObservation } from "../src/v3/observability.ts";
import { waitForAsyncRun } from "../src/v3/lifecycle.ts";
import { v3MonitorChild } from "../src/v3/dispatch.ts";
import { SubagentRpcClient, subagentAsyncRoot } from "../src/v3/rpc.ts";
import { MockSubagents, publishMockTerminal } from "./helpers/mock-subagents.ts";

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function fixture() {
 const asyncId = `supervision-${randomUUID()}`;
 const asyncDir = join(subagentAsyncRoot(), asyncId);
 await mkdir(asyncDir, {recursive:true});
 const status = {runId:asyncId, state:"running", noTimeout:true, startedAt:Date.now()-3*86400000,lastActivityAt:Date.now()-86400000};
 const publish = (value: object) => writeFile(join(asyncDir,"status.json"),JSON.stringify(value));
 await publish(status);
 return {asyncId,asyncDir,status,publish};
}

test("unlimited quiet task remains running beyond notice threshold, then completes", async () => {
 const f = await fixture(); const observations: string[] = []; let ended = false;
 try {
  const promise = waitForAsyncRun({events:new MockSubagents(),...f,onObservation:o=>{observations.push(o.supervision!.activity);}}).then(v=>{ended=true;return v;});
  await delay(35);
  assert.equal(ended,false);
  assert.ok(observations.includes("unknown"));
  await f.publish({...f.status,state:"complete",workflow:{value:{output:"finished slowly"}}});
  assert.equal((await promise).output,"finished slowly");
 } finally { await rm(f.asyncDir,{recursive:true,force:true}); }
});

test("unreachable status probe is visible without terminating a live task", async () => {
 const f=await fixture();let seen=false;const controller=new AbortController();
 try {
  const promise=waitForAsyncRun({events:new MockSubagents(),...f,signal:controller.signal,probe:async()=>{throw new Error("offline");},onObservation:o=>{seen ||= o.supervision?.probe==="unreachable";}});
  const rejection=assert.rejects(promise,/monitoring aborted/);
  await delay(40);assert.equal(seen,true);assert.equal(JSON.parse(await readFile(join(f.asyncDir,"status.json"),"utf8")).state,"running");
  controller.abort();await rejection;
 } finally {await rm(f.asyncDir,{recursive:true,force:true});}
});

test("targeted reconciliation surfaces a dead process and its explicit error", async()=>{
 const f=await fixture();const bus=new MockSubagents();bus.start();const rpc=new SubagentRpcClient(bus);
 // Real runtimes reconcile targeted status requests; this fixture controls that result.
 rpc.call=async (method)=>{if(method==="status") { await f.publish({...f.status,state:"failed",error:"Runner process exited before writing a result."}); await publishMockTerminal(f,true); }return {};};
 try {const out=await v3MonitorChild(rpc,f);assert.equal(out.terminal,"failed");assert.match(out.output,/Runner exit confirmed/);}
 finally {await bus.dispose();await rm(f.asyncDir,{recursive:true,force:true});}
});

test("legacy monitor deadline is ignored until explicit cancellation",async()=>{
 const f=await fixture();const controller=new AbortController();let settled=false;
 try {const promise=waitForAsyncRun({events:new MockSubagents(),...f,timeoutMs:5,signal:controller.signal});
 const rejection=assert.rejects(promise,/monitoring aborted/).then(()=>{settled=true;});
 await delay(35);assert.equal(settled,false);controller.abort();await rejection;}
 finally {await rm(f.asyncDir,{recursive:true,force:true});}
});

test("supervision text never equates silence or a successful probe with task completion",()=>{
 const now=Date.now();const s=childSupervision({state:"running",noTimeout:true,startedAt:now-86400000,lastActivityAt:now-500000},now,"available");
 assert.equal(s.activity,"unknown");assert.equal(s.runtimeLimit,"unlimited");
 const o=validateV3ChildObservation({asyncId:"test",observedAt:new Date(now).toISOString(),supervision:s});
 assert.match(supervisionFacts(o).join(" "),/progress unknown.*still waiting/);
 assert.equal(childSupervision({state:"running",lastActivityAt:now},now,"unreachable").activity,"unknown");
});

test("abort drains an in-flight observation before monitor settles",async()=>{
 const f=await fixture();const controller=new AbortController();let entered!:()=>void;let release!:()=>void;
 const started=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});let settled=false;
 try {
  const promise=waitForAsyncRun({events:new MockSubagents(),...f,signal:controller.signal,onObservation:async()=>{entered();await gate;}});
  const rejection=assert.rejects(promise,/monitoring aborted/).then(()=>{settled=true;});
  await started;controller.abort();await delay(15);assert.equal(settled,false);release();await rejection;
 } finally {release?.();await rm(f.asyncDir,{recursive:true,force:true});}
});


test("Graph refuses missing public capabilities before spawning",async()=>{
 const bus=new MockSubagents();const rpc=new SubagentRpcClient(bus);let spawned=false;
 rpc.call=async()=>({capabilities:{asyncSpawn:true}});
 rpc.spawn=async()=>{spawned=true;throw new Error("must not spawn");};
 const {v3DispatchChild}=await import("../src/v3/dispatch.ts");
 await assert.rejects(v3DispatchChild(rpc,{agent:"worker",task:"inspect",cwd:"/tmp",sessionDir:"/tmp"}),/owned runtime incompatible/);
 assert.equal(spawned,false);
});
