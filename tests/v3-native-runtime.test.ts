import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { atomicWriteJson } from "../src/v3/durable.ts";
import { NativeResultCapture, NATIVE_COMPLETE_EVENT, nativeResultsDir, reconcileNativeResult } from "../src/v3/native-results.ts";
import { waitForNativeAsyncRun } from "../src/v3/native-monitor.ts";
import { subagentAsyncRoot } from "../src/v3/rpc.ts";
import { waitForConfirmedStop } from "../src/v3/lifecycle.ts";
import { confirmedProcessExit } from "../src/v3/supervision.ts";
import { MockSubagents } from "./helpers/mock-subagents.ts";

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function fixture() {
 const asyncId = `native-${randomUUID()}`, asyncDir = join(subagentAsyncRoot(), asyncId);
 const root = await mkdtemp(join(tmpdir(), "graph-native-result-"));
 const resultPath = join(root, "attempt", "child-result.json");
 const status = { runId: asyncId, sessionId: "session-native", cwd: root, state: "complete", timeoutMs: 1800000, startedAt: Date.now() };
 const completion = { id: asyncId, sessionId: status.sessionId, asyncDir, state: "complete", success: true,
  results: [{ agent: "worker", output: "complete answer", outputState: "present", success: true }] };
 const proof = { version: 1, runId: asyncId, state: "observed", runnerProcessInstanceId: `runner-${asyncId}`, observedAt: Date.now(),
  instances: [{ kind: "runner", processInstanceId: `runner-${asyncId}`, closeObservedAt: Date.now(), exitCode: 0, signal: null }] };
 const bus = new MockSubagents();
 await mkdir(asyncDir, { recursive: true }); await atomicWriteJson(join(asyncDir, "status.json"), status);
 const controller = new AbortController();
 const input = { asyncId, asyncDir, resultPath, events: bus, probeIntervalMs: 10, signal: controller.signal };
 return { ...input, input, root, bus, status, completion, proof, controller,
  publish: () => atomicWriteJson(join(nativeResultsDir(), `${asyncId}.json`), completion),
  exit: () => atomicWriteJson(join(asyncDir, "process-terminal.json"), proof),
  cleanup: async () => { controller.abort(); await bus.dispose(); await rm(asyncDir, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); await rm(join(nativeResultsDir(), `${asyncId}.json`), { force: true }); } };
}

test("early completion is captured before binding, duplicates do not advance the physical-exit gate", async () => {
 const f = await fixture(); const capture = new NativeResultCapture(f.bus); let ended = false;
 try {
  f.bus.emit(NATIVE_COMPLETE_EVENT, f.completion);
  await capture.bind(f, f.resultPath);
  const promise = waitForNativeAsyncRun({ ...f.input, capture }).then(value => { ended = true; return value; });
  f.bus.emit(NATIVE_COMPLETE_EVENT, { ...f.completion, triggerTurn: true });
  await delay(35); assert.equal(ended, false);
  await f.exit(); const terminal = await promise;
  assert.equal(terminal.state, "complete"); assert.equal(terminal.output, "complete answer");
  assert.equal(terminal.observation.supervision?.runtimeLimit, "configured");
  assert.equal(terminal.observation.supervision?.processExitConfirmed, true);
 } finally { await capture.close(); await f.cleanup(); }
});

test("missing notifications recover from public result and Graph retains result/proof after upstream cleanup", async () => {
 const f = await fixture();
 try {
  await f.publish(); await f.exit();
  assert.equal((await waitForNativeAsyncRun(f.input)).output, "complete answer");
  await rm(f.asyncDir, { recursive: true }); await rm(join(nativeResultsDir(), `${f.asyncId}.json`));
  assert.equal((await waitForNativeAsyncRun(f.input)).output, "complete answer");
 } finally { await f.cleanup(); }
});

test("expired/mismatched replay is ignored; valid public archive restores full output then becomes independent", async () => {
 const f = await fixture();
 const artifact = join(f.root, "full-output.md"), output = "完整答案".repeat(20000);
 const replayPath = join(nativeResultsDir(), "completion-replay", `${f.asyncId}.json`);
 const archivePath = join(nativeResultsDir(), "output-archives", `${f.asyncId}.json`);
 try {
  await writeFile(artifact, output);
  const replay = { version: 1, runId: f.asyncId, sessionId: f.status.sessionId, expiresAt: Date.now() + 60000,
   completion: { runId: f.asyncId, state: "complete", success: true, results: [{ agent: "worker", success: true }] }, archivePath };
  await atomicWriteJson(replayPath, { ...replay, expiresAt: 0 });
  await atomicWriteJson(archivePath, { version: 1, runId: f.asyncId, entries: [{ source: "output-artifact", resultIndex: 0, path: artifact }] });
  assert.equal(await reconcileNativeResult(f, f.resultPath, f.status), undefined);
  await atomicWriteJson(replayPath, { ...replay, sessionId: "other" });
  assert.equal(await reconcileNativeResult(f, f.resultPath, f.status), undefined);
  await atomicWriteJson(replayPath, replay); await f.exit();
  assert.equal((await waitForNativeAsyncRun(f.input)).output, output);
  await rm(artifact); await rm(replayPath); await rm(archivePath);
  assert.equal((await waitForNativeAsyncRun(f.input)).output, output);
 } finally { await rm(replayPath, { force: true }); await rm(archivePath, { force: true }); await f.cleanup(); }
});

test("wrong run/session/directory and truncated text never become final results", async () => {
 const f = await fixture();
 try {
  for (const patch of [{ id: "wrong" }, { sessionId: "other" }, { asyncDir: "/tmp/other" }, { results: [{ output: "tail", truncated: true }] }]) {
   assert.equal(await reconcileNativeResult(f, f.resultPath, f.status, { ...f.completion, ...patch }), undefined);
  }
  const source = join(f.root, "outside.txt"), link = join(f.root, "output.md");
  await writeFile(source, "do not follow"); await symlink(source, link);
  assert.equal(await reconcileNativeResult(f, f.resultPath, f.status, { ...f.completion, results: [{ truncated: true, artifactPaths: { outputPath: link } }] }), undefined);
  await f.exit(); let attention = false;
  let observed!: () => void;
  const attentionObserved = new Promise<void>(resolve => { observed = resolve; });
  const promise = waitForNativeAsyncRun({ ...f.input, onObservation: o => {
   if (o.supervision?.attention === "result_unavailable") { attention = true; observed(); }
  } });
  const rejected = assert.rejects(promise, /aborted/);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   await Promise.race([attentionObserved, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Missing result_unavailable observation")), 5000); })]);
   assert.equal(attention, true);
  } finally { if (timer) clearTimeout(timer); f.controller.abort(); }
  await rejected;
 } finally { await f.cleanup(); }
});

test("conflicting duplicate results fail closed and storage errors cannot be acknowledged as successful", async () => {
 const f = await fixture(); const capture = new NativeResultCapture(f.bus);
 try {
  await capture.bind(f, f.resultPath); f.bus.emit(NATIVE_COMPLETE_EVENT, f.completion); await capture.flush();
  const before = await readFile(f.resultPath, "utf8");
  f.bus.emit(NATIVE_COMPLETE_EVENT, { ...f.completion, results: [{ output: "different", success: true }] });
  await assert.rejects(capture.flush(), /Conflicting/); assert.equal(await readFile(f.resultPath, "utf8"), before);
  const blockedPath = join(f.root, "blocked"); await mkdir(blockedPath);
  await assert.rejects(reconcileNativeResult(f, blockedPath, f.status, f.completion));
 } finally { await capture.close(); await f.cleanup(); }
});

test("success labels cannot override failed children; a public timeout stays a failure", async () => {
 const f = await fixture();
 try {
  const result = { ...f.completion, results: [{ output: "partial", timedOut: true, success: false }] };
  await atomicWriteJson(join(nativeResultsDir(), `${f.asyncId}.json`), result); await f.exit();
  const terminal = await waitForNativeAsyncRun(f.input);
  assert.equal(terminal.state, "failed"); assert.equal(terminal.output, "partial");
 } finally { await f.cleanup(); }
});

test("terminal labels and private candidates are not physical-stop proof", async () => {
 const f = await fixture();
 try {
  await atomicWriteJson(join(f.asyncDir, "status.json"), { ...f.status, state: "stopped" });
  await atomicWriteJson(join(f.asyncDir, "process-terminal-candidate.json"), f.proof);
  assert.equal(await waitForConfirmedStop(f.asyncDir, 1), false);
  await atomicWriteJson(join(f.asyncDir, "process-terminal.json"), { ...f.proof, state: "unknown" });
  assert.equal(await waitForConfirmedStop(f.asyncDir, 1), false);
  await f.exit(); assert.equal(await waitForConfirmedStop(f.asyncDir, 100), true);
  assert.equal(confirmedProcessExit(f.proof, f.asyncId, "wrong-runner"), false);
 } finally { await f.cleanup(); }
});

test("RPC availability is not child health; abort drains observations", async () => {
 const f = await fixture(); let entered!: () => void, release!: () => void, ended = false;
 const enteredPromise = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
 try {
  const promise = waitForNativeAsyncRun({ ...f.input, probe: async () => {}, onObservation: async o => {
   assert.equal(o.supervision?.health, "unknown"); entered(); await gate;
  } });
  const rejected = assert.rejects(promise, /aborted/).then(() => { ended = true; });
  await enteredPromise; f.controller.abort(); await delay(20); assert.equal(ended, false); release(); await rejected;
 } finally { release?.(); await f.cleanup(); }
});

test("a corrupt Graph receipt is never silently replaced by a new upstream notification", async () => {
 const f = await fixture();
 try {
  await reconcileNativeResult(f, f.resultPath, f.status, f.completion);
  await writeFile(f.resultPath, "{broken");
  await assert.rejects(reconcileNativeResult(f, f.resultPath, f.status, f.completion), /malformed/);
  assert.equal(await readFile(f.resultPath, "utf8"), "{broken");
 } finally { await f.cleanup(); }
});

test("concurrent conflicting notifications cannot overwrite the first durable receipt", async () => {
 const f = await fixture();
 try {
  const capture = new NativeResultCapture(f.bus);
  await capture.bind(f, f.resultPath);
  f.bus.emit(NATIVE_COMPLETE_EVENT, f.completion);
  const other = new NativeResultCapture(f.bus);
  await other.bind(f, f.resultPath);
  f.bus.emit(NATIVE_COMPLETE_EVENT, { ...f.completion, results: [{ output: "conflict", success: true }] });
  const outcomes = await Promise.allSettled([capture.flush(), other.flush()]);
  assert.ok(outcomes.some(result => result.status === "rejected"));
  assert.equal(JSON.parse(await readFile(f.resultPath, "utf8")).completion.results[0].finalOutput, "complete answer");
  await capture.close(); await other.close();
 } finally { await f.cleanup(); }
});


test("bound receivers reserve same-path arrival before gated status I/O; other paths remain independent", async (t) => {
 const f=await fixture(), otherFixture=await fixture();
 const firstBus=new MockSubagents(), secondBus=new MockSubagents();
 const first=new NativeResultCapture(firstBus),second=new NativeResultCapture(secondBus);
 const independent=new NativeResultCapture(otherFixture.bus);
 let release!:()=>void, entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}), started=new Promise<void>(r=>{entered=r;});
 const originalOpen=fsPromises.open;let blocked=false, statusReads=0;
 try {
  await first.bind(f,f.resultPath);await second.bind(f,f.resultPath);await independent.bind(otherFixture,otherFixture.resultPath);
  t.mock.method(fsPromises,"open",async (...args:Parameters<typeof originalOpen>)=>{
   if(String(args[0])===join(f.asyncDir,"status.json")) {statusReads++;if(!blocked){blocked=true;entered();await gate;}}
   return originalOpen(...args);
  });syncBuiltinESMExports();
  firstBus.emit(NATIVE_COMPLETE_EVENT,f.completion);await started;
  secondBus.emit(NATIVE_COMPLETE_EVENT,{...f.completion,results:[{output:"later conflict",success:true}]});
  otherFixture.bus.emit(NATIVE_COMPLETE_EVENT,otherFixture.completion);
  await independent.flush();
  assert.equal(statusReads,1,"second receiver cannot start status I/O ahead of reserved first arrival");
  assert.equal(JSON.parse(await readFile(otherFixture.resultPath,"utf8")).completion.results[0].finalOutput,"complete answer");
  release();await first.flush();await assert.rejects(second.flush(),/Conflicting/);
  const before=await readFile(f.resultPath,"utf8");
  assert.equal(JSON.parse(before).completion.results[0].finalOutput,"complete answer");
  // A rejection must not poison the shared queue; matching duplicates keep exact bytes.
  assert.ok(await reconcileNativeResult(f,f.resultPath,f.status,f.completion));
  firstBus.emit(NATIVE_COMPLETE_EVENT,f.completion);await first.flush();
  assert.equal(await readFile(f.resultPath,"utf8"),before);
 } finally {release?.();t.mock.restoreAll();syncBuiltinESMExports();await Promise.all([first.close(),second.close(),independent.close()]);await firstBus.dispose();await secondBus.dispose();await f.cleanup();await otherFixture.cleanup();}
});


test("owned startup failure uses its valid receipt during guardian proof/status publication gap",async()=>{
 const f=await fixture();
 try {
  const status={...f.status,runtimeKind:'pi-graph-sdk/1',state:'failed',runnerProcessInstanceId:f.proof.runnerProcessInstanceId,error:'SDK startup rejected: missing capability'};
  const completion={runId:f.asyncId,sessionId:status.sessionId,asyncDir:f.asyncDir,state:'failed',success:false,results:[{agent:'worker',output:'',finalOutput:'',success:false,error:status.error}]};
  const proof={...f.proof,runtimeKind:"pi-graph-sdk/1",instances:f.proof.instances.map(v=>({...v,exitCode:1}))};
  await atomicWriteJson(join(f.asyncDir,'status.json'),status);await atomicWriteJson(join(f.asyncDir,'result.json'),completion);await atomicWriteJson(join(f.asyncDir,'process-terminal.json'),proof);
  const terminal=await waitForNativeAsyncRun(f.input);assert.equal(terminal.state,'failed');assert.equal(terminal.output,status.error);assert.equal(terminal.observation.supervision?.processExitConfirmed,true);
  const receipt=JSON.parse(await readFile(f.resultPath,'utf8'));assert.equal(receipt.completion.results[0].error,status.error);assert.equal(receipt.status.processTerminal.runnerProcessInstanceId,proof.runnerProcessInstanceId);
 }finally{await f.cleanup();}
});


test("successful receipt cannot override an independently observed nonzero runner close",async()=>{
 const f=await fixture();try{await f.publish();await atomicWriteJson(join(f.asyncDir,'process-terminal.json'),{...f.proof,instances:f.proof.instances.map(v=>({...v,exitCode:1}))});const terminal=await waitForNativeAsyncRun(f.input);assert.equal(terminal.state,'failed');assert.equal(terminal.output,'complete answer');assert.equal(terminal.observation.supervision?.runtimeFailure,true);}finally{await f.cleanup();}
});

test("foreign owned runner proof cannot bridge a missing final-status marker",async()=>{
 const f=await fixture();try{
  await atomicWriteJson(join(f.asyncDir,'status.json'),{...f.status,runtimeKind:'pi-graph-sdk/1',runnerProcessInstanceId:'expected-runner',state:'failed'});await atomicWriteJson(join(f.asyncDir,'result.json'),{...f.completion,runId:f.asyncId,state:'failed',success:false});await atomicWriteJson(join(f.asyncDir,'process-terminal.json'),{...f.proof,runtimeKind:'pi-graph-sdk/1'});
  let settled=false;const pending=waitForNativeAsyncRun(f.input);const rejecting=assert.rejects(pending,/monitoring aborted/).then(()=>{settled=true;});await delay(30);assert.equal(settled,false);f.controller.abort();await rejecting;
 }finally{await f.cleanup();}
});
