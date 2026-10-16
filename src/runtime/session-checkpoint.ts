import {assertChildModelAllowed,mergeChildModelPolicies,readChildModelPolicy} from './child-model-policy.ts';
import {validateContinuationResult,validateSegmentProof,assertContinuationCandidate,eligibleSegment} from "./session-continuation.ts";
import {open,readFile,realpath,readdir,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,relative,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonicalDigest} from '../v3/digests.ts';
import {validateHostSdkIdentity} from './host-sdk.ts';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export async function strictSession(file:string,cwd:string){
 const parent=await realpath(dirname(file)),beforeParent=await lstat(parent),beforePath=await lstat(file);
 if(beforePath.isSymbolicLink()||!beforePath.isFile()||beforePath.nlink!==1||await realpath(file)!==join(parent,file.slice(file.lastIndexOf('/')+1)))throw Error('Unsafe checkpoint path identity');
 const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let text:string;let identity:any;
 try{const st=await h.stat();if(!st.isFile()||st.nlink!==1||st.size>32*1024*1024)throw Error('Unsafe checkpoint session file');text=await h.readFile('utf8');const after=await h.stat();const afterPath=await lstat(file),afterParent=await lstat(parent);if(st.ino!==beforePath.ino||st.dev!==beforePath.dev||st.size!==after.size||st.mtimeMs!==after.mtimeMs||after.nlink!==1||afterPath.ino!==st.ino||afterPath.dev!==st.dev||afterPath.isSymbolicLink()||afterParent.ino!==beforeParent.ino||afterParent.dev!==beforeParent.dev)throw Error('Checkpoint changed while reading');identity={file:await realpath(file),device:st.dev,inode:st.ino,parent, parentDevice:afterParent.dev,parentInode:afterParent.ino};}finally{await h.close();}
 if(!text.endsWith('\n'))throw Error('Truncated checkpoint session');
 const lines=text.slice(0,-1).split('\n');if(lines.some(x=>!x.trim()))throw Error('Incomplete checkpoint JSONL');
 const entries=lines.map(x=>JSON.parse(x)),header=entries.shift();
 if(header?.type!=='session'||typeof header.id!=='string'||header.cwd!==cwd)throw Error('Checkpoint session identity mismatch');
 const usage:any={tokens:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0},totalCost:0,toolCount:0,turnCount:0};
 const ids=new Set<string>();let previous:string|null=null;const messages:any[]=[];const calls=new Set<string>(),results=new Set<string>();
 for(const e of entries){if(typeof e.id!=='string'||ids.has(e.id)||e.parentId!==previous)throw Error('Checkpoint session parent chain mismatch');ids.add(e.id);previous=e.id;
  if(e.type==='compaction'||e.type==='branch_summary')throw Error('Checkpoint compacted/branched history is not supported');
  if(e.type==='message'){const m=e.message;messages.push(m);if(m?.role==='assistant'){usage.turnCount++;for(const k of Object.keys(usage.tokens)){if(!Number.isFinite(m.usage?.[k])||m.usage[k]<0)throw Error('Unknown checkpoint usage');usage.tokens[k]+=m.usage[k];}if(!Number.isFinite(m.usage?.cost?.total)||m.usage.cost.total<0)throw Error('Unknown checkpoint cost');usage.totalCost+=m.usage.cost.total;}if(m?.role==='assistant')for(const c of m.content??[])if(c.type==='toolCall'){if(typeof c.id!=='string'||calls.has(c.id))throw Error('Duplicate checkpoint tool call');calls.add(c.id);}if(m?.role==='toolResult'){if(!calls.has(m.toolCallId)||results.has(m.toolCallId))throw Error('Unsafe checkpoint tool result');results.add(m.toolCallId);}}
 }
 if(calls.size!==results.size)throw Error('Checkpoint contains unfinished tool calls');
 return {identity,sha256:sha(text),sessionId:header.id,cwd,leafId:previous,entryCount:entries.length,contextDigest:canonicalDigest(messages),lastAssistant:(()=>{const m=messages.filter(m=>m.role==='assistant').at(-1);return m?{model:`${m.provider}/${m.model}`,stopReason:m.stopReason,...(m.errorMessage?{errorMessage:m.errorMessage}:{})}:undefined;})(),completedToolIds:[...results].sort(),toolCount:results.size,usage:{...usage,toolCount:results.size}};
}
/** Frozen code + host deployment + exact required extensions, never credential material. */
export async function deploymentDigest(intent:any){
 const host=await validateHostSdkIdentity(intent.hostSdkIdentity);const root=host.root;const base=fileURLToPath(new URL('../../',import.meta.url));const files:string[]=[];
 for(const sub of ['src/runtime','src/v3','extensions']){const walk=async(p:string):Promise<void>=>{for(const d of await readdir(p,{withFileTypes:true})){if(d.isDirectory())await walk(join(p,d.name));else if(/\.(?:ts|mjs)$/.test(d.name))files.push(join(p,d.name));}};await walk(join(base,sub));}
 files.push(...host.files.map(f=>f.path),...(intent.params.extensionPaths??intent.launchContract.tools?.extensionArgs??[]));
 return canonicalDigest({hostSdkIdentity:host,sdkRoot:root,files:await Promise.all([...new Set(files)].sort().map(async p=>[await realpath(p),sha(await readFile(p))]))});
}
export function checkpointIdentity(intent:any){return canonicalDigest({hostSdkIdentity:intent.hostSdkIdentity,runId:intent.runId,owner:intent.sessionId,params:intent.params,agent:intent.agent,contract:intent.launchContract,continuation:intent.continuation});}
export async function validateCheckpoint(intent:any,cp:any,exit:any){
 if(!cp||cp.version!==1||cp.kind!=='pi-graph-session-checkpoint/1'||cp.identity!==checkpointIdentity(intent)||cp.runId!==intent.runId||cp.generation!==intent.generation||cp.runnerProcessInstanceId!==intent.workerInstanceId||cp.nextCandidateIndex!==cp.candidateIndex+1||cp.nextCandidateIndex>=intent.continuation.plan.candidates.length||cp.shutdownComplete!==true||cp.segment?.safe!==true)throw Error('Checkpoint identity or settlement proof invalid');
 const {digest,...body}=cp;if(canonicalDigest(body)!==digest)throw Error('Checkpoint digest mismatch');
 if(!exit||exit.version!==1||exit.runId!==intent.runId||exit.workerInstanceId!==cp.runnerProcessInstanceId||exit.generation!==cp.generation||exit.signal!==null||![0,1].includes(exit.exitCode)||exit.checkpointDigest!==digest)throw Error('Checkpoint lacks observed normal process exit');
 if(cp.deploymentDigest!==await deploymentDigest(intent))throw Error('Checkpoint deployment changed');
 const directory=await realpath(intent.params.sessionDir??join(intent.asyncDir,'session'));const originalInfo=await lstat(cp.sessionFile);if(originalInfo.isSymbolicLink()||originalInfo.nlink!==1)throw Error('Unsafe checkpoint original path');const file=await realpath(cp.sessionFile);const r=relative(directory,file);if(r.startsWith('..')||isAbsolute(r))throw Error('Checkpoint session outside frozen directory');
 if(canonicalDigest(await strictSession(file,intent.params.cwd))!==canonicalDigest(cp.session))throw Error('Checkpoint session hash or history changed');
 if(canonicalDigest(cp.usage)!==canonicalDigest(cp.session.usage))throw Error('Checkpoint budget ledger differs from session usage');
 validateSegmentProof(cp.segment);assertContinuationCandidate(intent,cp.nextCandidateIndex);
 assertChildModelAllowed(intent.continuation.plan.candidates[cp.nextCandidateIndex].resolvedModel,mergeChildModelPolicies(intent.launchContract.childModelPolicy,readChildModelPolicy(intent.params.cwd,intent.agent.name)));
 const ledger=cp.continuationEvidence,last=ledger?.segments?.at(-1);
 if(!eligibleSegment({stopReason:cp.session.lastAssistant?.stopReason,errorMessage:cp.session.lastAssistant?.errorMessage},cp.segment,{}).eligible||cp.session.lastAssistant?.model!==last?.model?.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u,''))throw Error('Checkpoint lacks matching eligible assistant failure');
 if(!last||canonicalDigest(last.proof)!==canonicalDigest(cp.segment)||last.diagnostic!==cp.diagnostic||ledger.sessionId!==cp.session.sessionId)throw Error('Checkpoint settled segment/context mismatch');
 validateContinuationResult(intent,{...cp.usage,continuationEvidence:ledger,model:last.model,thinking:last.thinking,actualModelDefinition:ledger.modelDefinitions?.find((d:any)=>d.model===last.model)?.definition,success:false},true);
 if(cp.continuationEvidence?.candidateIndex!==cp.candidateIndex||cp.continuationEvidence?.version!==1)throw Error('Checkpoint candidate ledger invalid');
 return cp;
}
