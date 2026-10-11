import { readGraphSupervisorRequests } from "../native-supervisor.ts";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readV3AttemptEvidence } from "../attempt.ts";
import { readV3RunControl } from "../control.ts";
import { validateGraphSnapshotV3 } from "../snapshot.ts";
import type { GraphSnapshotV3 } from "../types.ts";
import { setDisplayEvidence, type DisplayEvidence } from "./presentation.ts";

import { authProvider, isAuthError, readLocalAuthRecords } from "./auth-view.ts";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export async function enrichGraphView(snapshot: GraphSnapshotV3, runsDir: string, agentDir?: string): Promise<void> {
 if (!safeId.test(snapshot.graphId)) return;
 const runDir = join(runsDir, snapshot.graphId);
 const info = await lstat(runDir);
 if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Graph run must be a regular directory.");
 const display: DisplayEvidence = { failures: {}, failureTimes: {}, neverDispatched: new Set() };
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
   if ((a.phase === "aborted" || a.failure?.message === "Graph failed fast before this node started.") && !a.dispatch && !a.dispatchIntent) display.neverDispatched.add(id);
  } catch { display.readError = "部分执行证据暂时不可读；保留已有状态"; }
 }));
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
 const file = await open(join(runDir, "snapshot.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
 let snapshot: GraphSnapshotV3;
 try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("Invalid graph snapshot file.");
  snapshot = validateGraphSnapshotV3(JSON.parse(await file.readFile("utf8")));
 } finally { await file.close(); }
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
