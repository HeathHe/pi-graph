import {validateLatestModelPolicy,MAX_MODEL_DEGRADATIONS,modelFamilyId,candidateMeetsRequirements,validateModelRequirements} from '../runtime/model-capabilities.ts';
import { controlledV3FrozenAgent } from "./workspace.ts";
import { join } from "node:path";
import { canonicalDigest } from "./digests.ts";
import { classifyProviderFailure } from "./failure-policy.ts";
import { readNativeJson, readNativeReceipt } from "./native-results.ts";
import { confirmedProcessExit } from "./supervision.ts";
import type { CompiledGraphNodeV3, V3AttemptEvidence, V3RuntimeFallbackPlan, V3FallbackContinuation } from "./types.ts";
import { v3NodeAttemptDir, readLatestV3Attempt, readV3AttemptEvidence } from "./attempt.ts";

const SHA = /^[a-f0-9]{64}$/;
export function validateRuntimeFallbackPlan(value: unknown): asserts value is V3RuntimeFallbackPlan {
 const p = value as V3RuntimeFallbackPlan | undefined;
 if (!p || p.version !== 1 || (p.sessionContinuationVersion!==undefined&&p.sessionContinuationVersion!==1) || typeof p.profile !== "string" || !p.profile || !Number.isSafeInteger(p.modelDegradations)
  || p.modelDegradations < 1 || p.modelDegradations > MAX_MODEL_DEGRADATIONS || !Array.isArray(p.candidates)
  || p.candidates.length < 2 || p.candidates.length > p.modelDegradations + 1
  || !Array.isArray(p.excludedFamilies) || p.excludedFamilies.some(f => typeof f !== "string")
  || typeof p.requireCrossFamilyFromProducers !== "boolean" || !SHA.test(p.digest)) throw new Error("Invalid frozen runtime fallback plan.");
 const {digest, ...base} = p;
 if (canonicalDigest(base) !== digest) throw new Error("Runtime fallback plan digest mismatch.");
 if(p.requirements!==undefined)validateModelRequirements(p.requirements);
 validateLatestModelPolicy(p,p.candidates);
 const models = new Set<string>();
 for (const c of p.candidates) {
  if (!c || typeof c.requestedModel !== "string" || !c.requestedModel.includes("/") || typeof c.resolvedModel !== "string"
   || !c.resolvedModel || !SHA.test(c.agentDefinitionDigest) || !SHA.test(c.admissionLaunchContractDigest)
   || (c.thinking !== undefined && c.thinking !== false && typeof c.thinking !== "string") || models.has(c.requestedModel)
   || !candidateMeetsRequirements(c,p.requirements)) throw new Error("Invalid frozen runtime fallback candidate.");
  models.add(c.requestedModel);
 }
}
export function runtimeModelFamily(model: string): string { return modelFamilyId(model); }

/** Verify a complete host-side native proof, never task output or a displayed count. */
export function validateNativePreActivityProof(input: {
 receipt: Record<string, any>; exitProof: Record<string, any> | undefined; evidence: V3AttemptEvidence;
 node: CompiledGraphNodeV3; candidateIndex: number; workspace: Record<string, any>;
}): {kind: string; digest: string} | undefined {
 const {receipt, exitProof, evidence, node, candidateIndex, workspace} = input;
 const candidate = node.launch?.runtimeFallback?.candidates[candidateIndex];
 const d = evidence.dispatch, results = receipt.completion?.results;
 if (!candidate || !d || receipt.runId !== d.asyncId || receipt.asyncDir !== d.asyncDir
  || !receipt.sessionId || receipt.sessionId !== receipt.status?.sessionId || receipt.status?.runId !== d.asyncId
  || receipt.completion?.state !== "failed" || !Array.isArray(results) || results.length !== 1
  || !confirmedProcessExit(exitProof, d.asyncId, receipt.status.processTerminal?.runnerProcessInstanceId)
  || !receipt.status.processTerminal?.runnerProcessInstanceId) return;
 const parentExit = exitProof?.instances?.find((i:any) => i.kind === "runner");
 if (!parentExit || parentExit.signal !== null || ![0,1].includes(parentExit.exitCode)) return;
 const r = results[0], p = r?.preActivityEvidence;
 if(receipt.status.runtimeKind!=='pi-graph-sdk/1')return;
 {
  const steps=receipt.status.steps;
  if(!Array.isArray(steps)||steps.length!==1||steps[0]?.toolCount!==0||r.toolCount!==0)return;
 }
 const binding = p?.graphBinding;
 if (!binding || binding.schemaVersion !== 1 || binding.graphId !== evidence.graphId || binding.taskId !== evidence.taskId
  || binding.attempt !== evidence.attempt || binding.workspaceCwd !== workspace.workspaceDir || binding.contractDigest !== workspace.contractDigest
  || workspace.runInstanceId !== evidence.runInstanceId || workspace.attempt !== evidence.attempt || workspace.taskId !== evidence.taskId
  || canonicalDigest(workspace) !== evidence.workspaceDigest) return;
 if (!p || p.runtimeKind !== 'pi-graph-sdk/1' || p.factoryIdentity !== 'pi-graph-owned-session/1' || exitProof?.runtimeKind !== 'pi-graph-sdk/1' || p.version !== 1 || p.runId !== d.asyncId || p.stepIndex !== 0 || p.agent !== node.agent
  || p.launchContractDigest !== r.launchContractDigest || !SHA.test(p.launchContractDigest)
  || r.agent !== node.agent || r.requestedModel !== candidate.resolvedModel || r.model !== candidate.resolvedModel || r.success === true
  || r.timedOut || r.stopped || r.interrupted || r.skipped || r.outputPartial
  || r.structuredOutputFailed || r.error !== p.diagnostic || r.effects?.fileMutation
  || r.effects?.settlementDiagnostic?.mutation?.attempted === true || r.effects?.settlementDiagnostic?.mutation?.observed === true
  || p.launches !== 1 || p.officialInProcess !== true || p.controlledEnvironment !== true
  || p.subscribedBeforePrompt !== true || p.agentStarted !== true || p.promptSettled !== true || p.shutdownComplete !== true
  || p.toolsStarted !== 0 || p.assistantToolCalls !== 0 || p.orphanToolResult !== false || p.lateActivity !== false || p.invalid !== false
  || p.queuedInput !== false || p.stopped !== false || p.timedOut !== false || p.interrupted !== false || p.forced !== false
  || p.diagnosticSource !== "assistant_error" || typeof p.diagnostic !== "string" || !p.diagnostic) return;
 const failure = classifyProviderFailure(p.diagnostic);
 return failure.eligible ? {kind: failure.kind, digest:canonicalDigest({receiptDigest:receipt.digest, exitProof, preActivity:p})} : undefined;
}

export async function safeFallbackContinuation(runDir: string, node: CompiledGraphNodeV3, evidence: V3AttemptEvidence): Promise<V3FallbackContinuation | undefined> {
 const plan = node.launch?.runtimeFallback;
 if (!plan || !evidence.dispatch || evidence.deadlineAt || node.timeoutMs !== undefined || !await controlledV3FrozenAgent(runDir, node)) return;
 validateRuntimeFallbackPlan(plan);
 const selected = evidence.routeSelection?.candidateIndex ?? 0;
 if (evidence.routeSelection && evidence.routeSelection.planDigest !== plan.digest) return;
 const next = selected + 1;
 if (next >= plan.candidates.length || next > plan.modelDegradations) return;
 if (plan.candidates.some(c => c.agentDefinitionDigest !== node.binding?.agentDefinitionDigest)) return;
 const dir = v3NodeAttemptDir(runDir, node.taskId, evidence.attempt);
 const receipt = await readNativeReceipt(evidence.dispatch, join(dir, "child-result.json"),
  await readNativeJson(join(evidence.dispatch.asyncDir, "status.json")) ?? {});
 const exit = await readNativeJson(join(dir, "child-process-terminal.json"));
 if (!receipt) return;
 const proof = validateNativePreActivityProof({receipt, exitProof:exit, evidence, node, candidateIndex:selected, workspace:await readNativeJson(join(dir, "workspace.json")) ?? {}});
 if (!proof) return;
 return {candidateIndex:next, planDigest:plan.digest, fromAttempt:evidence.attempt, proofDigest:proof.digest, failureKind:proof.kind};
}
export async function verifyFallbackContinuation(runDir: string, node: CompiledGraphNodeV3, evidence: V3AttemptEvidence): Promise<boolean> {
 if (!evidence.fallbackContinuation) return false;
 const verified = await safeFallbackContinuation(runDir, node, evidence);
 return !!verified && canonicalDigest(verified) === canonicalDigest(evidence.fallbackContinuation);
}
export async function selectedRuntimeNode(runDir: string, node: CompiledGraphNodeV3, evidence: V3AttemptEvidence): Promise<CompiledGraphNodeV3> {
 const plan = node.launch?.runtimeFallback;
 if (!plan) { if (evidence.routeSelection) throw new Error("Runtime route selection has no frozen plan."); return node; }
 validateRuntimeFallbackPlan(plan);
 const index = evidence.routeSelection?.candidateIndex ?? 0;
 if (evidence.routeSelection && evidence.routeSelection.planDigest !== plan.digest) throw new Error("Runtime route selection plan drifted.");
 const c = plan.candidates[index];
 if (!c || c.agentDefinitionDigest !== node.binding?.agentDefinitionDigest) throw new Error("Runtime route selection is outside frozen Agent admission.");
 if (index > 0) {
  const previous = await readV3AttemptEvidence(runDir, node.taskId, evidence.attempt - 1);
  // Exact predecessor identity; never use the newest attempt as its own proof.
  if (!previous || previous.attempt !== evidence.attempt - 1 || previous.runInstanceId !== evidence.runInstanceId
   || previous.taskId !== evidence.taskId || previous.graphId !== evidence.graphId || !await verifyFallbackContinuation(runDir, node, previous)
   || previous.fallbackContinuation?.candidateIndex !== index) throw new Error("Runtime fallback lacks its verified predecessor.");
 }
 if (plan.requireCrossFamilyFromProducers) {
  for (const taskId of node.dependsOn) {
   const producer = await readLatestV3Attempt(runDir, taskId);
   const model = producer?.evidence.child?.observation?.actualModel;
   if (!model || runtimeModelFamily(model) === runtimeModelFamily(c.resolvedModel)) throw new Error("Runtime fallback violates the accepted producer family boundary.");
  }
 }
 const {hintDigest: _, ...base} = node.launch!;
 const launch = {...base, requestedModel:c.requestedModel, resolvedModel:c.resolvedModel,
  ...(c.thinking === undefined ? {} : {thinking:c.thinking})};
 return {...node, launch:{...launch, hintDigest:canonicalDigest(launch)}};
}

/** Frozen from accepted dependency evidence, never from task text or declared route hints. */
export async function continuationProducerConstraints(runDir:string,node:CompiledGraphNodeV3){
 const required=node.launch?.runtimeFallback?.requireCrossFamilyFromProducers===true;
 const dependencies:Array<{taskId:string;attempt:number;actualModel:string;family:string;evidenceDigest:string}>=[];
 if(required)for(const taskId of node.dependsOn){
  const producer=await readLatestV3Attempt(runDir,taskId),e=producer?.evidence;
  const actualModel=e?.child?.observation?.actualModel;
  if(!e||e.phase!=='accepted'||!actualModel)throw Error('Accepted producer actual-model evidence is required for session continuation');
  dependencies.push({taskId,attempt:e.attempt,actualModel,family:runtimeModelFamily(actualModel),evidenceDigest:canonicalDigest(e)});
 }
 return {version:1,required,dependencies};
}
