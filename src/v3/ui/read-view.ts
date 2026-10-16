import { readUiProcessExits,nodeExitUnverified } from "./process-exit.ts";
import { readGraphSupervisorRequests } from "../native-supervisor.ts";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readV3AttemptEvidence } from "../attempt.ts";
import { readV3RunControl } from "../control.ts";
import { readAtomicRegularFile } from "../safe-read.ts";
import { validateGraphSnapshotV3 } from "../snapshot.ts";
import type { GraphSnapshotV3 } from "../types.ts";
import { setDisplayEvidence, displayEvidence, displayGoalIdentity, safeText, type DisplayEvidence } from "./presentation.ts";

import { validateAuthorizationV4 } from "../authorization.ts";

import { authProvider, isAuthError, readLocalAuthRecords } from "./auth-view.ts";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export async function enrichGraphView(snapshot: GraphSnapshotV3, runsDir: string, agentDir?: string): Promise<void> {
 if (!safeId.test(snapshot.graphId)) return;
 const runDir = join(runsDir, snapshot.graphId);
 const info = await lstat(runDir);
 if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Graph run must be a regular directory.");
 const original=displayEvidence(snapshot);
 const prior=original?.goalIdentity===displayGoalIdentity(snapshot)?original:undefined;
 const display: DisplayEvidence = { ...(prior?.goal?{goal:prior.goal,goalIdentity:prior.goalIdentity}:{}),...(prior?.expectedTaskIds?{expectedTaskIds:[...prior.expectedTaskIds]}:{}),failures: {}, failureTimes: {}, neverDispatched: new Set() };
 try {
  const parent=await realpath(runDir);
  const raw=await readAtomicRegularFile(join(runDir,'authorization.json'),{maxBytes:32*1024*1024,expectedParentRealpath:parent,invalidMessage:'Invalid display authorization.'});
  const auth=validateAuthorizationV4(JSON.parse(raw));
  const after=await lstat(runDir);
  if(after.dev!==info.dev||after.ino!==info.ino||after.isSymbolicLink()||await realpath(runDir)!==parent)throw Error('Display directory changed');
  if(auth.runInstanceId!==snapshot.runInstanceId||auth.sessionId!==snapshot.sessionId||auth.graph.graphId!==snapshot.graphId||auth.graphDigest!==snapshot.graphDigest||auth.sourceGraphSpecDigest!==snapshot.sourceGraphSpecDigest)throw Error('Display authorization identity mismatch');
  display.goal=safeText(auth.graph.goal).slice(0,1200);
  display.goalIdentity=displayGoalIdentity(snapshot);
  display.expectedTaskIds=auth.graph.nodes.map(n=>n.taskId);
 } catch { /* No trustworthy goal: preserve only same-object previously validated display evidence. */ }
 try {
  const control = await readV3RunControl(runDir);
  if (control.runInstanceId === snapshot.runInstanceId && control.graphId === snapshot.graphId) display.stopRequested = control.desiredState === "stopped";
 } catch { /* Missing control evidence never implies a user stop. */ }
 await Promise.all(Object.entries(snapshot.nodes ?? {}).map(async ([id,n]) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !n.attempt || !["failed", "aborted", "needs_attention"].includes(n.terminalStatus ?? n.phase)) return;
  try {
   const a = await readV3AttemptEvidence(runDir, id, n.attempt);
   if (!a || a.runInstanceId !== snapshot.runInstanceId || a.graphId !== snapshot.graphId || a.taskId !== id) return;
   if (a.failure) { display.failures[id] = a.failure.message; display.failureTimes![id] = a.failure.at; }
   if ((a.phase === "aborted" || a.failure?.message?.startsWith("Graph scope contains a symbolic link:") || a.failure?.message === "Graph failed fast before this node started.") && !a.dispatch && !a.dispatchIntent) display.neverDispatched.add(id);
  } catch { display.readError = "部分执行证据暂时不可读；保留已有状态"; }
 }));
 display.processExits = await readUiProcessExits(snapshot, runDir);
 display.exitUnverified = Object.entries(snapshot.nodes??{}).filter(([,n])=>nodeExitUnverified(n)).map(([id])=>id);
 const authNodes = Object.entries(snapshot.nodes ?? {}).flatMap(([id,n]) => {
  if (!isAuthError(display.failures[id] ?? n.observation?.supervision?.error ?? "")) return [];
  const provider = authProvider(n.observation?.actualModel ?? n.observation?.resolvedModel);
  return provider ? [{id,provider}] : [];
 });
 const records = await readLocalAuthRecords(authNodes.map(n=>n.provider),agentDir);
 display.localAuth = Object.fromEntries(authNodes.map(({id,provider})=>[id,records[provider]!]));
 setDisplayEvidence(snapshot, display);
}
/** Inspect persisted state without constructing a Host, adopting a run, or writing files. */
export async function readGraphView(runsDir: string, id: string, agentDir?: string, ownerSessionId?: string, ownerSessionFile?: string): Promise<GraphSnapshotV3> {
 if (!safeId.test(id)) throw new Error("Invalid graph ID.");
 const runDir = join(runsDir, id); const info = await lstat(runDir);
 if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Graph run must be a regular directory.");
 const text=await readAtomicRegularFile(join(runDir,"snapshot.json"),{maxBytes:16*1024*1024,invalidMessage:"Invalid graph snapshot file."});
 let snapshot=validateGraphSnapshotV3(JSON.parse(text));
 if (snapshot.graphId !== id) throw new Error("Graph snapshot identity mismatch.");
 if (ownerSessionId) snapshot = (await readGraphSupervisorRequests(snapshot, ownerSessionId, ownerSessionFile, runDir)).snapshot;
 await enrichGraphView(snapshot, runsDir, agentDir);
 return snapshot;
}
export async function listGraphViews(runsDir: string, ownerSessionId?: string, ownerSessionFile?: string): Promise<GraphSnapshotV3[]> {
 const entries = await readdir(runsDir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if(e.code === "ENOENT") return []; throw e; });
 const views: GraphSnapshotV3[] = [];
 for (const entry of entries) {
  if (!entry.isDirectory() || !safeId.test(entry.name)) continue;
  try { views.push(await readGraphView(runsDir, entry.name, undefined, ownerSessionId, ownerSessionFile)); } catch { /* A malformed run is still available through /graphs doctor. */ }
 }
 return views.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** UI polling reads durable state afresh; it never publishes Supervisor/GraphWait events. */
export async function refreshObservedGraphViews(input:{runsDir:string;snapshots:readonly GraphSnapshotV3[];sessionId:string;sessionFile?:string;isCurrent:(previous:GraphSnapshotV3)=>boolean;commit:(fresh:GraphSnapshotV3)=>void}):Promise<void>{
 for(const previous of input.snapshots){
  if(previous.sessionId!==input.sessionId||!Object.values(previous.nodes??{}).some(n=>["running","dispatched"].includes(n.phase)))continue;
  if(!input.isCurrent(previous))continue;
  try{const fresh=await readGraphView(input.runsDir,previous.graphId,undefined,input.sessionId,input.sessionFile);if(input.isCurrent(previous))input.commit(fresh);}catch{/* A failed UI read cannot fail the Supervisor or block other observed graphs. */}
 }
}
