import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
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

// A status RPC may publish physical exit before its final status write. The
// fixture owns that writer and must drain it before removing its directory.
async function cleanupPublishedFixture(bus:MockSubagents,f:{asyncDir:string},publication?:Promise<void>) {
 const errors:unknown[]=[];
 try {await publication;}catch(error){errors.push(error);}
 try {await bus.dispose();await rm(f.asyncDir,{recursive:true,force:true});}catch(error){errors.push(error);}
 if(errors.length===1)throw errors[0];
 if(errors.length)throw new AggregateError(errors,'Fixture publication/cleanup failed');
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
 let publication:Promise<void>|undefined;
 rpc.call=async (method)=>{if(method==="status") { publication=(async()=>{await f.publish({...f.status,state:"failed",error:"Runner process exited before writing a result."});await publishMockTerminal(f,true);})();await publication;}return {};};
 try {const out=await v3MonitorChild(rpc,f);assert.equal(out.terminal,"failed");assert.match(out.output,/Runner exit confirmed/);}
 finally {await cleanupPublishedFixture(bus,f,publication);}
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

test('fixture cleanup waits for its final status writer after physical exit becomes visible',async()=>{
 const f=await fixture();const bus=new MockSubagents();bus.start();const rpc=new SubagentRpcClient(bus);
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let publication:Promise<void>|undefined;let cleaned=false;let cleanup:Promise<void>|undefined;
 rpc.call=async(method)=>{if(method==='status'){publication=(async()=>{await f.publish({...f.status,state:'failed',error:'controlled exit'});await publishMockTerminal(f,true);await gate;await f.publish({...f.status,state:'failed',error:'last fixture write'});})();await publication;}return {};};
 try {
  const result=await v3MonitorChild(rpc,f);assert.equal(result.terminal,'failed');assert.ok(publication);
  cleanup=cleanupPublishedFixture(bus,f,publication).then(()=>{cleaned=true;});
  await access(f.asyncDir);assert.equal(cleaned,false);
  release();await cleanup;assert.equal(cleaned,true);await assert.rejects(access(f.asyncDir),{code:'ENOENT'});
 } finally {release();if(cleanup)await cleanup;else await cleanupPublishedFixture(bus,f,publication);}
});
test('fixture publication errors remain visible after cleanup',async()=>{
 const f=await fixture();const bus=new MockSubagents();const error=new Error('controlled fixture publication failure');
 await assert.rejects(cleanupPublishedFixture(bus,f,Promise.reject(error)),e=>e===error);
 await assert.rejects(access(f.asyncDir),{code:'ENOENT'});
});
