import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validateV3Attempt } from "../attempt.ts";
import { canonicalDigest } from "../digests.ts";
import { assertAsyncRunIdentity, subagentAsyncRoot } from "../rpc.ts";
import { readAtomicRegularFile } from "../safe-read.ts";
import { confirmedProcessExit } from "../supervision.ts";
import type { GraphSnapshotV3, V3NodeProjection } from "../types.ts";

export interface UiProcessExit { runnerInstanceId: string; observedAt: number; attempt:number; asyncId:string; generation?: number }
const unverified = new WeakMap<V3NodeProjection,{attempt:number;asyncId:string}>();
const matchesNode=(node:V3NodeProjection,value:{attempt:number;asyncId:string}|undefined)=>!!value&&!node.terminalStatus&&["running","dispatched"].includes(node.phase)&&value.attempt===node.attempt&&(!node.observation?.asyncId||node.observation.asyncId===value.asyncId);
export function nodeExitUnverified(node:V3NodeProjection):boolean {return matchesNode(node,unverified.get(node));}
const exits = new WeakMap<V3NodeProjection, UiProcessExit>();
export function nodeProcessExit(node: V3NodeProjection): UiProcessExit | undefined { const proof=exits.get(node);return matchesNode(node,proof)?proof:undefined; }
/** Transfer only already-verified receipt evidence to an exact identity-preserving copy. No I/O. */
export function copyUiProcessEvidence(source:GraphSnapshotV3,target:GraphSnapshotV3):void {
 if(source.sessionId!==target.sessionId||source.graphId!==target.graphId||source.runInstanceId!==target.runInstanceId)return;
 for(const [id,node] of Object.entries(source.nodes??{})){
  const copy=target.nodes?.[id];if(!copy||copy===node||copy.attempt!==node.attempt||copy.phase!==node.phase||copy.terminalStatus!==node.terminalStatus||copy.observation?.asyncId!==node.observation?.asyncId)continue;
  const proof=nodeProcessExit(node),pending=unverified.get(node);
  if(proof&&matchesNode(copy,proof))exits.set(copy,{...proof});
  if(nodeExitUnverified(node)&&pending&&matchesNode(copy,pending))unverified.set(copy,{...pending});
 }
}
const digestPattern = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

/** Public runner proof is display evidence only; it never changes a durable phase. */
export async function readUiProcessExits(snapshot: GraphSnapshotV3, runDir: string): Promise<Record<string, UiProcessExit>> {
 const found: Record<string, UiProcessExit> = {};
 await Promise.all(Object.entries(snapshot.nodes ?? {}).map(async ([taskId, node]) => {
  exits.delete(node);unverified.delete(node);
  if (node.terminalStatus || !["running", "dispatched"].includes(node.phase) || !Number.isSafeInteger(node.attempt) || node.attempt < 1 || !/^[a-z0-9][a-z0-9-]*$/.test(taskId)) return;
  try {
   const pins: Array<{path:string;dev:number;ino:number;canonical:string}> = [];
   const pin = async (path:string) => { const stat=await lstat(path),canonical=await realpath(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("Untrusted exit evidence directory");pins.push({path,dev:stat.dev,ino:stat.ino,canonical});return canonical; };
   const checkPins = async () => { for(const p of pins){const stat=await lstat(p.path);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==p.dev||stat.ino!==p.ino||await realpath(p.path)!==p.canonical)throw Error("Exit evidence directory replaced");} };
   const json = async (dir:string,name:string) => {const raw=JSON.parse(await readAtomicRegularFile(join(dir,name),{maxBytes:32*1024*1024,expectedParentRealpath:await realpath(dir),invalidMessage:"Untrusted exit evidence file"}));if(!record(raw))throw Error("Invalid exit evidence");return raw;};
   await pin(runDir);
   let attemptDir=runDir;for(const part of ["nodes",taskId,"attempts",String(node.attempt)]){attemptDir=join(attemptDir,part);await pin(attemptDir);}
   const attemptRaw=await json(attemptDir,"attempt.json"),attempt=validateV3Attempt(attemptRaw),dispatch=attempt.dispatch;
   if(attempt.graphId!==snapshot.graphId||attempt.runInstanceId!==snapshot.runInstanceId||attempt.taskId!==taskId||attempt.attempt!==node.attempt||!dispatch||!attempt.dispatchIntent||node.observation?.asyncId&&node.observation.asyncId!==dispatch.asyncId)return;
   const root=subagentAsyncRoot(),dir=join(root,dispatch.asyncId);assertAsyncRunIdentity(dispatch.asyncId,dispatch.asyncDir,root);await pin(root);await pin(dir);
   const intent=await json(dir,"intent.json"),status=await json(dir,"status.json"),proof=await json(dir,"process-terminal.json");
   const binding=intent.params?.extensionBindings?.["pi-graph/1"],runner=intent.runnerProcessInstanceId;
   if(intent.version!==1||intent.runtimeKind!=="pi-graph-sdk/1"||intent.runId!==dispatch.asyncId||intent.asyncDir!==dir||intent.sessionId!==snapshot.sessionId||typeof runner!=="string"||!runner||intent.requestId!==attempt.dispatchIntent.requestId||intent.requestDigest!==dispatch.requestDigest||canonicalDigest(intent.params)!==dispatch.requestDigest)return;
   if(dispatch.asyncId!==`owned-${createHash("sha256").update(intent.requestId).digest("hex").slice(0,40)}`||binding?.schemaVersion!==1||binding.graphId!==snapshot.graphId||binding.taskId!==taskId||binding.attempt!==node.attempt)return;
   if(status.runtimeKind!=="pi-graph-sdk/1"||status.runId!==dispatch.asyncId||status.sessionId!==snapshot.sessionId||status.runnerProcessInstanceId!==runner||proof.runtimeKind!=="pi-graph-sdk/1"||!confirmedProcessExit(proof,dispatch.asyncId,runner))return;
   let seal:Record<string,any>|undefined;let pendingExit=false;
   if(intent.continuation){
    seal=await json(dir,"generation-state.json");
    pendingExit=seal.version===1&&seal.state==="needs_attention";
    if(intent.continuation.runInstanceId!==snapshot.runInstanceId||intent.continuation.graphId!==snapshot.graphId||seal.version!==1||!pendingExit&&(seal.state!=="sealed"||!Number.isSafeInteger(seal.generation)||seal.generation<0||!digestPattern.test(seal.ledgerDigest??"")||status.generation!==seal.generation||proof.generation!==seal.generation||proof.ledgerDigest!==seal.ledgerDigest||status.processTerminal?.runnerProcessInstanceId!==runner||status.processTerminal.generation!==seal.generation||status.processTerminal.ledgerDigest!==seal.ledgerDigest))return;
   }else if(proof.generation!==undefined||proof.ledgerDigest!==undefined)return;
   // Cross-file reads must still refer to the same physical directories and immutable launch.
   await checkPins();
   if(canonicalDigest(await json(dir,"intent.json"))!==canonicalDigest(intent)||canonicalDigest(await json(dir,"status.json"))!==canonicalDigest(status)||canonicalDigest(await json(dir,"process-terminal.json"))!==canonicalDigest(proof)||canonicalDigest(await json(attemptDir,"attempt.json"))!==canonicalDigest(attemptRaw))return;
   if(seal&&canonicalDigest(await json(dir,"generation-state.json"))!==canonicalDigest(seal))return;
   const current=await json(runDir,"snapshot.json"),currentNode=current.nodes?.[taskId];
   if(current.sessionId!==snapshot.sessionId||current.graphId!==snapshot.graphId||current.runInstanceId!==snapshot.runInstanceId||currentNode?.attempt!==node.attempt||currentNode.phase!==node.phase||currentNode.terminalStatus)return;
   await checkPins();
   if(pendingExit){unverified.set(node,{attempt:node.attempt,asyncId:dispatch.asyncId});return;}
   const evidence:UiProcessExit={runnerInstanceId:runner,observedAt:proof.observedAt,attempt:node.attempt,asyncId:dispatch.asyncId,...(seal?{generation:seal.generation}:{})};
   found[taskId]=evidence;exits.set(node,evidence);
  } catch { /* Missing, replaced or ambiguous proof is unknown, never physical exit. */ }
 }));
 return found;
}
