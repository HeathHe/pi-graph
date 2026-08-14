import { createHash } from "node:crypto";
import type { CompiledGraph, GraphSnapshot, ValidationResult } from "./types.ts";
import type { RoutingDecision } from "./model-routing/types.ts";
import { canonicalJson, PLANNING_ASSESSOR_MODEL, type PlanningReceipt } from "./subagent-router/planning-gate.ts";

export const ROUTING_DRIFT_RESUME_TERMINAL_ERROR = "The routing decision was explicitly resumed for a fresh capability-bound policy evaluation.";

export interface AuthorizationRecord {
	schemaVersion: 2 | 3;
	compilerProjectionVersion: 1;
	runInstanceId: string;
	graphId: string;
	graphDigest: string;
	sourceGraphSpecDigest?: string;
	graph: CompiledGraph;
	sourceCwd: string;
	sessionId?: string;
	supervisorEpoch: string;
	createdAt: string;
	planningReceipt?: PlanningReceipt;
	planningReceiptDigest?: string;
	planningBindingDigest?: string;
	planningAdmissionId?: string;
}

export interface AttemptRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	phase: "prepared" | "dispatching" | "running" | "collecting" | "validated" | "applying" | "accepted" | "terminal";
	supervisorEpoch: string;
	fencingGeneration: number;
	routingDecision?: RoutingDecision;
	requestDigest?: string;
	launchContractDigest?: string;
	extensionContentDigest?: string;
	runtimeLaunchContractDigest?: string;
	runtimeGuardAcknowledged?: true;
	asyncId?: string;
	sessionId?: string;
	terminalStatus?: "failed" | "stale" | "stopped";
	terminalError?: string;
	terminalRetryKind?: "dispatch" | "timeout" | "failed" | "validation" | "provider" | "model_degrade";
	updatedAt: string;
}

export function isRoutingDriftResumeTerminal(authority: AttemptRecord): boolean {
	return authority.phase === "terminal"
		&& authority.terminalStatus === "failed"
		&& authority.terminalRetryKind === "failed"
		&& authority.terminalError === ROUTING_DRIFT_RESUME_TERMINAL_ERROR
		&& authority.requestDigest === undefined
		&& authority.asyncId === undefined;
}

export interface AttemptRecoveryRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	fromStatus: "stale";
	toStatus: "running" | "verifying";
	preparedAt: string;
}

export interface WorkspaceRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	workspaceKind: "shadow" | "git";
	workspaceDir?: string;
	contractDigest: string;
	writeBaseline: Record<string, string | null>;
	readBaseline: Record<string, string | null>;
	inputBaseline: Record<string, { sourcePath: string; digest: string | null }>;
	createdAt: string;
}

export interface ValidatedResultRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	outputDigest: string;
	validation: ValidationResult[];
	validatedAt: string;
}

export interface AcceptanceRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	manifestDigest: string;
	outputDigest: string;
	acceptedAt: string;
}

export function canonicalDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateAuthorizedPlanningReceipt(record: Pick<AuthorizationRecord, "schemaVersion" | "runInstanceId" | "graphId" | "graphDigest" | "sourceCwd" | "sourceGraphSpecDigest" | "sessionId" | "planningReceipt" | "planningReceiptDigest" | "planningBindingDigest" | "planningAdmissionId">): void {
	const receipt = record.planningReceipt;
	if (record.schemaVersion === 2) {
		if (receipt || record.planningReceiptDigest || record.planningBindingDigest || record.planningAdmissionId) throw new Error("Legacy planning authorization v2 must not contain partial or downgraded planning admission fields.");
		return;
	}
	if (!receipt || !record.planningReceiptDigest || !record.planningBindingDigest || !record.sourceGraphSpecDigest || !record.planningAdmissionId) throw new Error("Planning authorization v3 is missing its mandatory durable receipt binding.");
	if (!receipt || receipt.schemaVersion !== 2 || record.planningReceiptDigest !== canonicalDigest(receipt)) throw new Error("Invalid durable planning receipt digest.");
	if (record.planningAdmissionId !== receipt.receiptId) throw new Error("Durable planning admission identity does not match its receipt.");
	if (receipt.parentModel.resolvedModel !== PLANNING_ASSESSOR_MODEL || receipt.parentModel.modelFamily !== "deepseek" || receipt.parentModel.providerDomain !== "deepseek" || !["runtime_reported", "verified"].includes(receipt.parentModel.identityConfidence)) {
		throw new Error(`Durable planning receipt does not attest the required assessor '${PLANNING_ASSESSOR_MODEL}'.`);
	}
	const requiredPlanner = receipt.effectiveRiskClass === "R3"
		? { resolvedModel: "wisdomrouter/gpt-5.6-sol:xhigh", modelFamily: "gpt", providerDomain: "wisdomrouter" }
		: receipt.effectiveTier === "tactical"
			? { resolvedModel: "kimi-coding/k3:high", modelFamily: "kimi", providerDomain: "moonshot" }
			: { resolvedModel: "wisdomrouter/gpt-5.6-sol:high", modelFamily: "gpt", providerDomain: "wisdomrouter" };
	if (receipt.planner.resolvedModel !== requiredPlanner.resolvedModel || receipt.planner.modelFamily !== requiredPlanner.modelFamily || receipt.planner.providerDomain !== requiredPlanner.providerDomain) {
		throw new Error(`Durable planning receipt planner does not match the mandatory ${receipt.effectiveTier}/${receipt.effectiveRiskClass} model '${requiredPlanner.resolvedModel}'.`);
	}
	for (const [label, evidence] of [["planner", receipt.planner], ["reviewer", receipt.reviewer]] as const) {
		if (!Array.isArray(evidence.attemptedModels) || evidence.attemptedModels.length === 0 || evidence.attemptedModels.some((model) => model !== evidence.resolvedModel)) {
			throw new Error(`Durable planning receipt ${label} attempted-model provenance is missing or contains a different model.`);
		}
	}
	if (receipt.consumedByRunId !== record.graphId || receipt.cwd !== record.sourceCwd || (record.sessionId && receipt.sessionId !== record.sessionId)) throw new Error("Durable planning receipt identity does not match the Graph authorization.");
	for (const digest of [receipt.promptDigest, receipt.lockedContextDigest, receipt.configDigest, receipt.flashAssessmentDigest, receipt.parentDraftDigest, receipt.plannerOutputDigest, receipt.finalGraphSpecDigest, receipt.lineageDigest]) {
		if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Durable planning receipt contains an invalid digest.");
	}
	if (record.sourceGraphSpecDigest !== receipt.finalGraphSpecDigest) throw new Error("Durable planning receipt is not bound to the admitted source GraphSpec.");
	const expectedLineage = createHash("sha256").update(canonicalJson({
		configDigest: receipt.configDigest,
		effectiveRiskClass: receipt.effectiveRiskClass,
		effectiveTier: receipt.effectiveTier,
		finalGraphSpecDigest: receipt.finalGraphSpecDigest,
		flashAssessmentDigest: receipt.flashAssessmentDigest,
		lockedContextDigest: receipt.lockedContextDigest,
		parentDraftDigest: receipt.parentDraftDigest,
		parentModel: {
			identityConfidence: receipt.parentModel.identityConfidence,
			modelFamily: receipt.parentModel.modelFamily,
			providerDomain: receipt.parentModel.providerDomain,
			resolvedModel: receipt.parentModel.resolvedModel,
		},
		planner: {
			decisionId: receipt.planner.decisionId,
			attemptedModels: receipt.planner.attemptedModels,
			modelFamily: receipt.planner.modelFamily,
			providerDomain: receipt.planner.providerDomain,
			resolvedModel: receipt.planner.resolvedModel,
		},
		plannerOutputDigest: receipt.plannerOutputDigest,
		planningProfile: receipt.planningProfile,
		postHardFloor: receipt.postHardFloor,
		postRiskFloor: receipt.postRiskFloor,
		preHardFloor: receipt.preHardFloor,
		preRiskFloor: receipt.preRiskFloor,
		promptDigest: receipt.promptDigest,
	})).digest("hex");
	if (receipt.lineageDigest !== expectedLineage) throw new Error("Durable planning receipt lineage is invalid.");
	if (receipt.planner.modelFamily === receipt.reviewer.modelFamily || receipt.planner.providerDomain === receipt.reviewer.providerDomain) throw new Error("Durable planning receipt does not contain an independent reviewer.");
	const tier = ["direct", "tactical", "strategic"];
	const risk = ["R0", "R1", "R2", "R3"];
	if (tier.indexOf(receipt.effectiveTier) < Math.max(tier.indexOf(receipt.flashProposedTier), tier.indexOf(receipt.preHardFloor), tier.indexOf(receipt.postHardFloor))
		|| risk.indexOf(receipt.effectiveRiskClass) < Math.max(risk.indexOf(receipt.flashProposedRisk), risk.indexOf(receipt.preRiskFloor), risk.indexOf(receipt.postRiskFloor))) throw new Error("Durable planning receipt violates monotonic gate escalation.");
	const expectedBinding = canonicalDigest({ graphDigest: record.graphDigest, planningReceiptDigest: record.planningReceiptDigest, runInstanceId: record.runInstanceId, sourceGraphSpecDigest: record.sourceGraphSpecDigest });
	if (record.planningBindingDigest !== expectedBinding) throw new Error("Durable planning receipt binding is invalid.");
}

export function authorizationFor(graph: CompiledGraph, snapshot: GraphSnapshot, planningReceipt?: PlanningReceipt, sourceGraphSpecDigest?: string): AuthorizationRecord {
	if (snapshot.schemaVersion !== 2) throw new Error("Authority records require a Graph Runtime v2 snapshot.");
	const boundReceipt = planningReceipt ? { ...planningReceipt, consumedByRunId: graph.graphId } : undefined;
	if (boundReceipt && (!sourceGraphSpecDigest || sourceGraphSpecDigest !== boundReceipt.finalGraphSpecDigest)) throw new Error("Planning receipt does not authorize the exact source GraphSpec.");
	const graphDigest = canonicalDigest(graph);
	const planningReceiptDigest = boundReceipt ? canonicalDigest(boundReceipt) : undefined;
	const record: AuthorizationRecord = {
		schemaVersion: boundReceipt ? 3 : 2,
		compilerProjectionVersion: 1,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		graphDigest,
		...(sourceGraphSpecDigest ? { sourceGraphSpecDigest } : {}),
		graph,
		sourceCwd: snapshot.sourceCwd,
		...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
		supervisorEpoch: snapshot.supervisorEpoch,
		createdAt: snapshot.createdAt,
		...(boundReceipt ? { planningReceipt: boundReceipt, planningReceiptDigest, planningBindingDigest: canonicalDigest({ graphDigest, planningReceiptDigest, runInstanceId: snapshot.runInstanceId, sourceGraphSpecDigest }) } : {}),
		...(boundReceipt ? { planningAdmissionId: boundReceipt.receiptId } : {}),
	};
	validateAuthorizedPlanningReceipt(record);
	return record;
}
