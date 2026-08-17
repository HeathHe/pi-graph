import { createHash } from "node:crypto";
import type { CompiledGraph, GraphSnapshot, ValidationResult } from "./types.ts";

export const ROUTING_DRIFT_RESUME_TERMINAL_ERROR = "The routing decision was explicitly resumed for a fresh capability-bound policy evaluation.";

/**
 * Frozen legacy planning-receipt shape (contract §9 legacy-compat).
 *
 * The V3 mainline no longer validates planning admission: it never issues,
 * verifies or writes a new PlanningReceipt, and the hardcoded assessor/planner
 * model table that admission used is archived with the governance modules.
 * Core only parses the historical bytes it may encounter in a legacy
 * authorization.json, so the type is intentionally opaque and the only checks
 * performed are the generic structural / digest / binding / identity ones in
 * `validateLegacyAuthorizationEnvelope`. Nothing on the V3 mainline acts on
 * the contents of this record.
 */
export interface LegacyPlanningReceipt {
	schemaVersion: 2;
	receiptId: string;
	parentModel: unknown;
	planner: unknown;
	reviewer: unknown;
	promptDigest: string;
	lockedContextDigest: string;
	configDigest: string;
	flashAssessmentDigest: string;
	parentDraftDigest: string;
	plannerOutputDigest: string;
	finalGraphSpecDigest: string;
	lineageDigest: string;
	effectiveTier: string;
	effectiveRiskClass: string;
	flashProposedTier: string;
	flashProposedRisk: string;
	preHardFloor: string;
	postHardFloor: string;
	preRiskFloor: string;
	postRiskFloor: string;
	planningProfile: string;
	consumedByRunId: string;
	cwd: string;
	sessionId?: string;
}

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
	planningReceipt?: LegacyPlanningReceipt;
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
	routingDecision?: unknown;
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

/** Canonical JSON: object keys sorted recursively. Frozen legacy parser helper (§9 legacy-compat). */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

/** Frozen legacy graphSpec digest: sha256 of the canonical-JSON serialization (§9 legacy-compat). */
export function graphSpecDigest(spec: unknown): string {
	return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => [key, canonicalValue(child)]));
}

function isHexDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/**
 * Frozen legacy authorization envelope check (contract §9 legacy-compat).
 *
 * Validates only the generic structural / digest / binding / identity
 * consistency of a persisted legacy authorization.json so a read-only legacy
 * run is never presented with a self-inconsistent envelope. It deliberately
 * does NOT re-validate planning admission: the hardcoded assessor/planner
 * model table and the independent-reviewer model assertions moved to the
 * governance archive. Legacy runs are frozen — nothing on the V3 mainline
 * re-admits or re-routes them.
 */
export function validateLegacyAuthorizationEnvelope(record: Pick<AuthorizationRecord, "schemaVersion" | "runInstanceId" | "graphId" | "graphDigest" | "sourceCwd" | "sourceGraphSpecDigest" | "sessionId" | "planningReceipt" | "planningReceiptDigest" | "planningBindingDigest" | "planningAdmissionId">): void {
	const receipt = record.planningReceipt;
	if (record.schemaVersion === 2) {
		if (receipt || record.planningReceiptDigest || record.planningBindingDigest || record.planningAdmissionId) throw new Error("Legacy planning authorization v2 must not contain partial or downgraded planning admission fields.");
		return;
	}
	if (!receipt || !record.planningReceiptDigest || !record.planningBindingDigest || !record.sourceGraphSpecDigest || !record.planningAdmissionId) throw new Error("Planning authorization v3 is missing its mandatory durable receipt binding.");
	if (!receipt || receipt.schemaVersion !== 2 || record.planningReceiptDigest !== canonicalDigest(receipt)) throw new Error("Invalid durable planning receipt digest.");
	if (record.planningAdmissionId !== receipt.receiptId) throw new Error("Durable planning admission identity does not match its receipt.");
	for (const digest of [receipt.promptDigest, receipt.lockedContextDigest, receipt.configDigest, receipt.flashAssessmentDigest, receipt.parentDraftDigest, receipt.plannerOutputDigest, receipt.finalGraphSpecDigest, receipt.lineageDigest]) {
		if (!isHexDigest(digest)) throw new Error("Durable planning receipt contains an invalid digest.");
	}
	if (record.sourceGraphSpecDigest !== receipt.finalGraphSpecDigest) throw new Error("Durable planning receipt is not bound to the admitted source GraphSpec.");
	const parentModel = (receipt.parentModel ?? {}) as Record<string, unknown>;
	const planner = (receipt.planner ?? {}) as Record<string, unknown>;
	const expectedLineage = createHash("sha256").update(canonicalJson({
		configDigest: receipt.configDigest,
		effectiveRiskClass: receipt.effectiveRiskClass,
		effectiveTier: receipt.effectiveTier,
		finalGraphSpecDigest: receipt.finalGraphSpecDigest,
		flashAssessmentDigest: receipt.flashAssessmentDigest,
		lockedContextDigest: receipt.lockedContextDigest,
		parentDraftDigest: receipt.parentDraftDigest,
		parentModel: {
			identityConfidence: parentModel.identityConfidence,
			modelFamily: parentModel.modelFamily,
			providerDomain: parentModel.providerDomain,
			resolvedModel: parentModel.resolvedModel,
		},
		planner: {
			decisionId: planner.decisionId,
			attemptedModels: planner.attemptedModels,
			modelFamily: planner.modelFamily,
			providerDomain: planner.providerDomain,
			resolvedModel: planner.resolvedModel,
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
	const tier = ["direct", "tactical", "strategic"];
	const risk = ["R0", "R1", "R2", "R3"];
	if (tier.indexOf(receipt.effectiveTier) < Math.max(tier.indexOf(receipt.flashProposedTier), tier.indexOf(receipt.preHardFloor), tier.indexOf(receipt.postHardFloor))
		|| risk.indexOf(receipt.effectiveRiskClass) < Math.max(risk.indexOf(receipt.flashProposedRisk), risk.indexOf(receipt.preRiskFloor), risk.indexOf(receipt.postRiskFloor))) throw new Error("Durable planning receipt violates monotonic gate escalation.");
	const expectedBinding = canonicalDigest({ graphDigest: record.graphDigest, planningReceiptDigest: record.planningReceiptDigest, runInstanceId: record.runInstanceId, sourceGraphSpecDigest: record.sourceGraphSpecDigest });
	if (record.planningBindingDigest !== expectedBinding) throw new Error("Durable planning receipt binding is invalid.");
}

export function authorizationFor(graph: CompiledGraph, snapshot: GraphSnapshot, planningReceipt?: LegacyPlanningReceipt, sourceGraphSpecDigest?: string): AuthorizationRecord {
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
	validateLegacyAuthorizationEnvelope(record);
	return record;
}
