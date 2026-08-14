import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { GraphSpec } from "../types.ts";

export type PlanningTier = "direct" | "tactical" | "strategic";
export type RiskClass = "R0" | "R1" | "R2" | "R3";
export type PlanningVerdict = "pass" | "revise" | "blocked";
export const PLANNING_ASSESSOR_MODEL = "deepseek/deepseek-v4-flash:max";

export interface TaskAssessment {
	schemaVersion: 1;
	taskType: string;
	proposedTier: PlanningTier;
	confidence: number;
	reasons: string[];
	plannedActions: string[];
	complexitySignals: {
		competingDirections?: boolean;
		dynamicDiscovery?: boolean;
		crossDomainDependencies?: boolean;
		hardToVerify?: boolean;
		longHorizon?: boolean;
		highImpact?: boolean;
		requiresRollbackPlan?: boolean;
	};
	riskClass: RiskClass;
	riskReasons: string[];
	riskSignals: {
		externalWrite?: boolean;
		destructive?: boolean;
		production?: boolean;
		money?: boolean;
		permissions?: boolean;
		sensitiveData?: boolean;
		irreversible?: boolean;
		crossAccount?: boolean;
	};
}

export interface PlanningModelEvidence {
	decisionId: string;
	resolvedModel: string;
	attemptedModels: string[];
	modelFamily: string;
	providerDomain: string;
}

export interface ParentModelEvidence {
	resolvedModel: string;
	modelFamily: string;
	providerDomain: string;
	identityConfidence: "unknown" | "selected_only" | "runtime_reported" | "verified";
}

export interface GraphSpecFinding {
	severity: "critical" | "major" | "minor";
	code: string;
	message: string;
	taskId?: string;
}

export interface GraphSpecReview {
	schemaVersion: 2;
	reviewedDigest: string;
	lineageDigest: string;
	verdict: PlanningVerdict;
	findings: GraphSpecFinding[];
}

export class GraphSpecReviewGateError extends Error {
	readonly review: GraphSpecReview;
	readonly repairAllowed: boolean;

	constructor(review: GraphSpecReview, repairAllowed: boolean) {
		const findings = review.findings.length
			? review.findings.map((finding) => `${finding.severity}:${finding.code}${finding.taskId ? `:${finding.taskId}` : ""}: ${finding.message}`).join(" | ")
			: "no findings were supplied";
		super(`spec-reviewer verdict is '${review.verdict}'; Graph start remains blocked. ${repairAllowed ? "Exactly one corrected GraphSpec may be reviewed without reassessment or replanning." : "No further review is allowed for this active plan."} Findings: ${findings}`);
		this.name = "GraphSpecReviewGateError";
		this.review = review;
		this.repairAllowed = repairAllowed;
	}
}

export interface PlanningReceipt {
	schemaVersion: 2;
	receiptId: string;
	sessionId: string;
	cwd: string;
	promptDigest: string;
	lockedContextDigest: string;
	configDigest: string;
	flashProposedTier: PlanningTier;
	flashConfidence: number;
	preHardFloor: PlanningTier;
	postHardFloor: PlanningTier;
	effectiveTier: PlanningTier;
	flashProposedRisk: RiskClass;
	preRiskFloor: RiskClass;
	postRiskFloor: RiskClass;
	effectiveRiskClass: RiskClass;
	flashAssessmentDigest: string;
	parentDraftDigest: string;
	plannerOutputDigest: string;
	finalGraphSpecDigest: string;
	lineageDigest: string;
	planningProfile: string;
	parentModel: ParentModelEvidence;
	planner: PlanningModelEvidence;
	reviewer: PlanningModelEvidence;
	issuedAt: string;
	consumedByRunId?: string;
}

interface TurnState {
	sessionId: string;
	cwd: string;
	prompt: string;
	promptDigest: string;
	configDigest?: string;
	lockedContext?: string;
	assessment?: TaskAssessment;
	assessmentReceiptId?: string;
	parentModel?: ParentModelEvidence;
	flashAssessmentDigest?: string;
	flashDraft?: GraphSpec;
	parentDraftDigest?: string;
	preHardFloor?: PlanningTier;
	preRiskFloor?: RiskClass;
	effectiveTier?: PlanningTier;
	effectiveRiskClass?: RiskClass;
	planningProfile?: string;
	expectedPlannerModel?: string;
	planner?: PlanningModelEvidence;
	plannerOutput?: string;
	plannerOutputDigest?: string;
	reviewSpecDigest?: string;
	reviewAttempted?: boolean;
	reviewAttemptCount?: number;
	revisionAllowed?: boolean;
	postHardFloor?: PlanningTier;
	postRiskFloor?: RiskClass;
	lineageDigest?: string;
	review?: GraphSpecReview;
	reviewer?: PlanningModelEvidence;
	receipt?: PlanningReceipt;
	reservedToolCallId?: string;
}

const TIER_ORDER: PlanningTier[] = ["direct", "tactical", "strategic"];
const RISK_ORDER: RiskClass[] = ["R0", "R1", "R2", "R3"];

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => [key, canonicalValue(child)]));
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

export function canonicalGraphSpec(spec: GraphSpec): string {
	return canonicalJson(spec);
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function graphSpecDigest(spec: GraphSpec): string {
	return sha256(canonicalGraphSpec(spec));
}

export function maxPlanningTier(...values: PlanningTier[]): PlanningTier {
	return TIER_ORDER[Math.max(...values.map((value) => TIER_ORDER.indexOf(value)))]!;
}

export function maxRiskClass(...values: RiskClass[]): RiskClass {
	return RISK_ORDER[Math.max(...values.map((value) => RISK_ORDER.indexOf(value)))]!;
}

export function planningProfileKey(tier: PlanningTier, risk: RiskClass): "tactical" | "strategic" | "strategicHighRisk" {
	if (tier === "direct") throw new Error("Direct tasks do not have a Graph planning profile.");
	return risk === "R3" ? "strategicHighRisk" : tier === "tactical" ? "tactical" : "strategic";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, label: string, allowEmpty = false): string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
		throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings.`);
	}
	return value.map((entry) => (entry as string).trim());
}

function booleanSignals(value: unknown, label: string, keys: readonly string[]): Record<string, boolean> {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	for (const [key, entry] of Object.entries(value)) {
		if (!keys.includes(key) || typeof entry !== "boolean") throw new Error(`${label}.${key} is unsupported or is not boolean.`);
	}
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry === true)) as Record<string, boolean>;
}

export function validateTaskAssessment(value: unknown): TaskAssessment {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("assessment must be a schemaVersion 1 object.");
	if (typeof value.taskType !== "string" || !value.taskType.trim()) throw new Error("assessment.taskType is required.");
	if (!TIER_ORDER.includes(value.proposedTier as PlanningTier)) throw new Error("assessment.proposedTier must be direct, tactical, or strategic.");
	if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error("assessment.confidence must be between 0 and 1.");
	if (!RISK_ORDER.includes(value.riskClass as RiskClass)) throw new Error("assessment.riskClass must be R0, R1, R2, or R3.");
	const complexitySignals = booleanSignals(value.complexitySignals, "assessment.complexitySignals", [
		"competingDirections", "dynamicDiscovery", "crossDomainDependencies", "hardToVerify", "longHorizon", "highImpact", "requiresRollbackPlan",
	]);
	const riskSignals = booleanSignals(value.riskSignals, "assessment.riskSignals", [
		"externalWrite", "destructive", "production", "money", "permissions", "sensitiveData", "irreversible", "crossAccount",
	]);
	return {
		schemaVersion: 1,
		taskType: value.taskType.trim(),
		proposedTier: value.proposedTier as PlanningTier,
		confidence: value.confidence,
		reasons: stringList(value.reasons, "assessment.reasons"),
		plannedActions: stringList(value.plannedActions, "assessment.plannedActions"),
		complexitySignals,
		riskClass: value.riskClass as RiskClass,
		riskReasons: stringList(value.riskReasons, "assessment.riskReasons", true),
		riskSignals,
	};
}

export function graphSpecFloors(spec: GraphSpec): { tier: PlanningTier; risk: RiskClass } {
	const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
	let tier: PlanningTier = nodes.length ? "tactical" : "direct";
	const dependencyCount = nodes.reduce((sum, node) => sum + (node.dependsOn?.length ?? 0), 0);
	const dependencyFan = new Map<string, number>();
	for (const node of nodes) for (const parent of node.dependsOn ?? []) dependencyFan.set(parent, (dependencyFan.get(parent) ?? 0) + 1);
	const crossDomain = new Set(nodes.flatMap((node) => (node.resourceScopes ?? []).map((scope) => scope.kind))).size > 1;
	if (nodes.length >= 3 || dependencyCount >= 2 || [...dependencyFan.values()].some((count) => count > 1)
		|| nodes.some((node) => (node.dependsOn?.length ?? 0) > 1)
		|| (nodes.length > 1 && (spec.maxConcurrency ?? 2) > 1)
		|| crossDomain) tier = "strategic";
	let risk: RiskClass = "R0";
	if (nodes.some((node) => node.sideEffect === "local_write" || node.sideEffect === "external_read")) risk = "R1";
	if (nodes.some((node) => node.sideEffect === "external_write" || node.allowDelete || node.externalAction?.requiresApproval)) risk = "R2";
	if (nodes.some((node) => node.externalAction && (!node.externalAction.reversible
		|| /(?:payment|transfer|purchase|delete|permission|deploy|publish|send)/iu.test(node.externalAction.action)))) risk = "R3";
	return { tier, risk };
}

export function prePlanningFloors(prompt: string, assessment: TaskAssessment, draftSpec: GraphSpec): { tier: PlanningTier; risk: RiskClass } {
	const graph = graphSpecFloors(draftSpec);
	const complexityCount = Object.values(assessment.complexitySignals).filter(Boolean).length;
	let tier = graph.tier;
	if (complexityCount >= 2
		|| assessment.complexitySignals.competingDirections || assessment.complexitySignals.crossDomainDependencies
		|| assessment.complexitySignals.longHorizon || assessment.complexitySignals.highImpact
		|| assessment.complexitySignals.requiresRollbackPlan) tier = "strategic";
	if (/(?:规划|方案|架构|迁移|调研|比较|长期|路线图|plan|strategy|architecture|migration|research|compare|roadmap)/iu.test(prompt)) tier = maxPlanningTier(tier, "tactical");
	if (/(?:跨系统|跨仓库|多阶段|多个方案|长期规划|系统架构|cross[- ](?:system|repo)|multi[- ]stage|competing (?:options|directions)|system architecture)/iu.test(prompt)) tier = "strategic";
	// Prompt-only floors must still catch complex work when Flash under-reports
	// planned actions and every structured signal. These clusters intentionally
	// cover organizational, operational, research, and product work as well as code.
	const structuralChange = /(?:迁移|拆分|拆开|合并|重组|割接|切换.{0,16}(?:系统|平台|供应商|流程|账户|数据)|migrat|cutover|restructur|split|merge)/iu.test(prompt);
	const crossBoundary = /(?:跨(?:模块|部门|团队|组织|平台|服务|系统|账户|地区|渠道|数据源)|多(?:模块|部门|团队|组织|平台|服务|系统|账户|地区|渠道|数据源)|(?:多个|至少[二两三四五六七八九十\d]+个).{0,12}(?:系统|平台|服务|部门|团队|供应商|数据源)|(?:登录|订单|支付|库存|客户|账户|社群|邮件|销售|客服)(?:[、,，/和与及]|以及).{0,20}(?:模块|系统|服务)|cross[- ](?:module|team|organization|platform|service|system|account|region|channel|data source)|multi(?:ple)?[- ](?:module|team|organization|platform|service|system|account|region|channel|data source)|multiple .{0,16}(?:teams|systems|platforms|services|vendors|data sources))/iu.test(prompt);
	const integrity = /(?:数据|库存|账目|身份|权限|配置).{0,12}(?:一致|一致性|完整性|不丢失|同步)|(?:保持|保证).{0,12}(?:数据|库存|账目|身份|权限|配置)?(?:一致|一致性|完整性)|对账|data (?:consistency|integrity)|identity consistency|reconciliation|no data loss|interdependent data sources/iu.test(prompt);
	const continuity = /(?:向后兼容|兼容旧(?:版|客户端|流程|系统)|旧(?:版|客户端|流程|系统).{0,16}(?:不中断|继续可用|兼容)|业务.{0,8}(?:不能|不可|不中断)|业务连续性|不中断服务|零停机|backward compatib|legacy .{0,20}(?:uninterrupted|available|compatib)|business continuity|zero[- ]downtime|without (?:service )?interruption)/iu.test(prompt);
	const hardToUndo = /(?:难以?回滚|不可回滚|难以?撤销|不可撤销|回滚困难|hard to roll back|difficult to (?:rollback|undo)|irreversible)/iu.test(prompt);
	const semanticClusters = [structuralChange, crossBoundary, integrity, continuity, hardToUndo].filter(Boolean).length;
	if (semanticClusters >= 1) tier = maxPlanningTier(tier, "tactical");
	if (semanticClusters >= 2 || crossBoundary && structuralChange || hardToUndo) tier = "strategic";
	let risk = graph.risk;
	const signals = assessment.riskSignals;
	if (signals.externalWrite || signals.destructive || signals.production || signals.money || signals.permissions || signals.sensitiveData || signals.crossAccount) risk = maxRiskClass(risk, "R2");
	if (signals.irreversible || ((signals.money || signals.permissions || signals.production) && (signals.externalWrite || signals.destructive))) risk = "R3";
	if (/(?:生产环境|线上环境|付款|转账|购买|删除|发布|部署|发送邮件|修改权限|密钥|敏感数据|production|payment|transfer|purchase|delete|deploy|publish|send email|permission|credential|sensitive data)/iu.test(prompt)) risk = maxRiskClass(risk, "R2");
	if (structuralChange && (integrity || continuity || crossBoundary) || hardToUndo) risk = maxRiskClass(risk, "R2");
	if (maxRiskClass(assessment.riskClass, risk) === "R3") tier = "strategic";
	else if (RISK_ORDER.indexOf(maxRiskClass(assessment.riskClass, risk)) >= RISK_ORDER.indexOf("R2")) tier = maxPlanningTier(tier, "tactical");
	return { tier, risk };
}

export function parseGraphSpecReview(raw: string): GraphSpecReview {
	const candidate = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
	let value: unknown;
	try { value = JSON.parse(candidate); } catch { throw new Error("spec-reviewer did not return strict JSON."); }
	if (!isRecord(value)) throw new Error("spec-reviewer result must be a JSON object.");
	if (value.schemaVersion !== 2 || typeof value.reviewedDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.reviewedDigest)
		|| typeof value.lineageDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.lineageDigest)) {
		throw new Error("spec-reviewer result has an invalid schemaVersion, reviewedDigest, or lineageDigest.");
	}
	if (!["pass", "revise", "blocked"].includes(value.verdict as string) || !Array.isArray(value.findings)) throw new Error("spec-reviewer result has an invalid verdict or findings list.");
	const findings = value.findings.map((finding, index): GraphSpecFinding => {
		if (!isRecord(finding)) throw new Error(`spec-reviewer finding ${index} must be an object.`);
		if (!["critical", "major", "minor"].includes(finding.severity as string) || typeof finding.code !== "string" || !finding.code.trim()
			|| typeof finding.message !== "string" || !finding.message.trim() || (finding.taskId !== undefined && (typeof finding.taskId !== "string" || !finding.taskId.trim()))) {
			throw new Error(`spec-reviewer finding ${index} is malformed.`);
		}
		return { severity: finding.severity as GraphSpecFinding["severity"], code: finding.code.trim(), message: finding.message.trim(), ...(typeof finding.taskId === "string" ? { taskId: finding.taskId.trim() } : {}) };
	});
	return { schemaVersion: 2, reviewedDigest: value.reviewedDigest, lineageDigest: value.lineageDigest, verdict: value.verdict as PlanningVerdict, findings };
}

function key(sessionId: string, cwd: string): string { return `${sessionId}\0${resolve(cwd)}`; }

export class PlanningGate {
	private readonly turns = new Map<string, TurnState>();
	private configDigestResolver?: () => Promise<string>;

	setConfigDigestResolver(resolver: () => Promise<string>): void { this.configDigestResolver = resolver; }
	async currentConfigDigest(): Promise<string> {
		if (!this.configDigestResolver) throw new Error("Planning-gate routing configuration resolver is unavailable.");
		const digest = await this.configDigestResolver();
		if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("Planning-gate routing configuration resolver returned an invalid digest.");
		return digest;
	}

	beginTurn(input: { sessionId: string; cwd: string; prompt: string }): Readonly<TurnState> {
		const state: TurnState = { sessionId: input.sessionId, cwd: resolve(input.cwd), prompt: input.prompt, promptDigest: sha256(input.prompt) };
		this.turns.set(key(input.sessionId, input.cwd), state);
		return state;
	}

	current(sessionId: string, cwd: string): Readonly<TurnState> | undefined { return this.turns.get(key(sessionId, cwd)); }
	resetSession(sessionId: string): void { for (const [entryKey, state] of this.turns) if (state.sessionId === sessionId) this.turns.delete(entryKey); }
	resetAll(): void { this.turns.clear(); }

	assessTurn(input: { sessionId: string; cwd: string; assessment: unknown; draftSpec?: GraphSpec; parentModel: ParentModelEvidence }): Readonly<TurnState> {
		const state = this.requireTurn(input.sessionId, input.cwd);
		const assessment = validateTaskAssessment(input.assessment);
		const previousTier = state.effectiveTier;
		const previousRisk = state.effectiveRiskClass;
		const previousDraft = state.flashDraft;
		const floorSpec = input.draftSpec ?? previousDraft ?? ({ schemaVersion: 1, goal: state.prompt || "direct task", nodes: [] } as GraphSpec);
		const floors = prePlanningFloors(state.prompt, assessment, floorSpec);
		const effectiveTier = maxPlanningTier(assessment.proposedTier, floors.tier, ...(previousTier ? [previousTier] : []));
		const effectiveRiskClass = maxRiskClass(assessment.riskClass, floors.risk, ...(previousRisk ? [previousRisk] : []));
		if (effectiveTier !== "direct" && !input.draftSpec && !previousDraft) throw new Error(`Assessment resolved to ${effectiveTier}/${effectiveRiskClass}; a first-draft GraphSpec is required.`);
		state.assessment = assessment;
		state.assessmentReceiptId = randomUUID();
		state.parentModel = input.parentModel;
		state.flashAssessmentDigest = sha256(canonicalJson(assessment));
		state.flashDraft = input.draftSpec ?? previousDraft;
		state.parentDraftDigest = state.flashDraft ? graphSpecDigest(state.flashDraft) : sha256("");
		state.preHardFloor = previousTier ? maxPlanningTier(floors.tier, state.preHardFloor ?? "direct") : floors.tier;
		state.preRiskFloor = previousRisk ? maxRiskClass(floors.risk, state.preRiskFloor ?? "R0") : floors.risk;
		state.effectiveTier = effectiveTier;
		state.effectiveRiskClass = effectiveRiskClass;
		for (const field of ["configDigest", "lockedContext", "planningProfile", "expectedPlannerModel", "planner", "plannerOutput", "plannerOutputDigest", "reviewSpecDigest", "reviewAttempted", "reviewAttemptCount", "revisionAllowed", "postHardFloor", "postRiskFloor", "lineageDigest", "review", "reviewer", "receipt", "reservedToolCallId"] as const) delete state[field];
		return state;
	}

	beginPlanning(input: { sessionId: string; cwd: string; configDigest: string; context?: string; planningProfile: string; expectedPlannerModel: string }): Readonly<TurnState> {
		const state = this.requireTurn(input.sessionId, input.cwd);
		if (!state.assessment || !state.parentModel || !state.effectiveTier || !state.effectiveRiskClass || !state.preHardFloor || !state.preRiskFloor || !state.flashAssessmentDigest || !state.parentDraftDigest) throw new Error("Run assess_task for the current turn before plan_graph.");
		if (state.effectiveTier === "direct") throw new Error("This task is direct and must not start a Graph. Handle it in the main model without plan_graph.");
		if (!state.flashDraft) throw new Error("Non-direct planning requires the assessed first-draft GraphSpec.");
		state.configDigest = input.configDigest;
		state.lockedContext = input.context?.trim() || undefined;
		state.planningProfile = input.planningProfile;
		state.expectedPlannerModel = input.expectedPlannerModel;
		for (const field of ["planner", "plannerOutput", "plannerOutputDigest", "reviewSpecDigest", "reviewAttempted", "reviewAttemptCount", "revisionAllowed", "postHardFloor", "postRiskFloor", "lineageDigest", "review", "reviewer", "receipt", "reservedToolCallId"] as const) delete state[field];
		return state;
	}

	completePlanning(input: { sessionId: string; cwd: string; configDigest: string; evidence: PlanningModelEvidence; output: string }): void {
		const state = this.requireTurn(input.sessionId, input.cwd);
		if (state.configDigest !== input.configDigest || !state.assessment || !state.flashDraft || !state.planningProfile || !state.expectedPlannerModel || input.evidence.resolvedModel.length === 0 || input.output.trim().length === 0) throw new Error("Planner completion does not match the active planning gate or has no usable output.");
		if (input.evidence.resolvedModel !== state.expectedPlannerModel) throw new Error(`Planner resolved as '${input.evidence.resolvedModel}', but this gate requires the exact L0 model '${state.expectedPlannerModel}'. Automatic planner downgrade is forbidden.`);
		if (input.evidence.attemptedModels.length === 0 || input.evidence.attemptedModels.some((model) => model !== state.expectedPlannerModel)) throw new Error("Planner must attest that every model attempt used only the exact authorized model.");
		state.planner = input.evidence;
		state.plannerOutput = input.output.trim();
		state.plannerOutputDigest = sha256(state.plannerOutput);
	}

	beginReview(input: { sessionId: string; cwd: string; configDigest: string; spec: GraphSpec }): {
		digest: string; lineageDigest: string; planner: PlanningModelEvidence; prompt: string; promptDigest: string; lockedContext?: string;
		assessment: TaskAssessment; parentModel: ParentModelEvidence; flashDraft: GraphSpec; plannerOutput: string; effectiveTier: PlanningTier; effectiveRiskClass: RiskClass;
	} {
		const state = this.requireTurn(input.sessionId, input.cwd);
		if (!state.planner || !state.plannerOutput || !state.plannerOutputDigest || !state.assessment || !state.flashDraft || !state.parentModel || !state.effectiveTier || !state.effectiveRiskClass) throw new Error("Graph planning gate requires a completed planner result before review.");
		if (state.configDigest !== input.configDigest) throw new Error("Routing configuration changed after planning; run plan_graph again.");
		const reviewAttemptCount = state.reviewAttemptCount ?? 0;
		if (reviewAttemptCount > 0 && !(reviewAttemptCount === 1 && state.revisionAllowed === true)) {
			throw new Error("review_graph_spec exhausted the active plan's review budget. Start a new user turn and repeat assessment and planning before another review.");
		}
		const post = graphSpecFloors(input.spec);
		if (TIER_ORDER.indexOf(post.tier) > TIER_ORDER.indexOf(state.effectiveTier) || RISK_ORDER.indexOf(post.risk) > RISK_ORDER.indexOf(state.effectiveRiskClass)) {
			throw new Error(`Final GraphSpec raises the required gate to ${post.tier}/${post.risk}; run plan_graph again with an updated assessment and Flash draft.`);
		}
		const digest = graphSpecDigest(input.spec);
		if (reviewAttemptCount === 1 && digest === state.reviewSpecDigest) throw new Error("The one allowed GraphSpec revision must change the previously reviewed canonical specification.");
		const lockedContextDigest = sha256(state.lockedContext ?? "");
		const lineageDigest = sha256(canonicalJson({
			promptDigest: state.promptDigest, lockedContextDigest, flashAssessmentDigest: state.flashAssessmentDigest, parentDraftDigest: state.parentDraftDigest,
			plannerOutputDigest: state.plannerOutputDigest, finalGraphSpecDigest: digest, configDigest: input.configDigest,
			preHardFloor: state.preHardFloor, postHardFloor: post.tier, effectiveTier: state.effectiveTier,
			preRiskFloor: state.preRiskFloor, postRiskFloor: post.risk, effectiveRiskClass: state.effectiveRiskClass,
			planningProfile: state.planningProfile, parentModel: state.parentModel, planner: state.planner,
		}));
		state.reviewSpecDigest = digest;
		state.reviewAttempted = true;
		state.reviewAttemptCount = reviewAttemptCount + 1;
		state.revisionAllowed = false;
		state.postHardFloor = post.tier;
		state.postRiskFloor = post.risk;
		state.lineageDigest = lineageDigest;
		delete state.review; delete state.reviewer; delete state.receipt; delete state.reservedToolCallId;
		return { digest, lineageDigest, planner: state.planner, prompt: state.prompt, promptDigest: state.promptDigest, ...(state.lockedContext ? { lockedContext: state.lockedContext } : {}), assessment: state.assessment, parentModel: state.parentModel, flashDraft: state.flashDraft, plannerOutput: state.plannerOutput, effectiveTier: state.effectiveTier, effectiveRiskClass: state.effectiveRiskClass };
	}

	completeReview(input: { sessionId: string; cwd: string; configDigest: string; review: GraphSpecReview; reviewer: PlanningModelEvidence }): PlanningReceipt {
		const state = this.requireTurn(input.sessionId, input.cwd);
		if (!state.planner || !state.parentModel || !state.assessment || !state.reviewSpecDigest || !state.lineageDigest || !state.plannerOutputDigest || !state.parentDraftDigest || !state.flashAssessmentDigest || !state.preHardFloor || !state.postHardFloor || !state.preRiskFloor || !state.postRiskFloor || !state.effectiveTier || !state.effectiveRiskClass || !state.planningProfile || state.configDigest !== input.configDigest) throw new Error("Graph review is not bound to a completed active plan.");
		if (input.review.reviewedDigest !== state.reviewSpecDigest || input.review.lineageDigest !== state.lineageDigest) throw new Error("spec-reviewer digest does not match the reviewed GraphSpec and complete planning lineage.");
		if (input.reviewer.modelFamily === state.planner.modelFamily || input.reviewer.providerDomain === state.planner.providerDomain) throw new Error("planner and spec-reviewer must use different model families and provider domains.");
		if (input.reviewer.attemptedModels.length === 0 || input.reviewer.attemptedModels.some((model) => model !== input.reviewer.resolvedModel)) throw new Error("spec-reviewer must attest that every model attempt used only its exact resolved model.");
		if (input.review.verdict !== "pass") {
			const repairAllowed = input.review.verdict === "revise" && state.reviewAttemptCount === 1;
			state.review = input.review;
			state.reviewer = input.reviewer;
			state.revisionAllowed = repairAllowed;
			throw new GraphSpecReviewGateError(input.review, repairAllowed);
		}
		if (input.review.findings.some((finding) => finding.severity === "critical" || finding.severity === "major")) throw new Error("spec-reviewer returned pass with a critical or major finding; Graph start remains blocked.");
		state.revisionAllowed = false;
		state.review = input.review;
		state.reviewer = input.reviewer;
		const receipt: PlanningReceipt = {
			schemaVersion: 2, receiptId: randomUUID(), sessionId: state.sessionId, cwd: state.cwd, promptDigest: state.promptDigest, lockedContextDigest: sha256(state.lockedContext ?? ""), configDigest: input.configDigest,
			flashProposedTier: state.assessment.proposedTier, flashConfidence: state.assessment.confidence, preHardFloor: state.preHardFloor, postHardFloor: state.postHardFloor, effectiveTier: state.effectiveTier,
			flashProposedRisk: state.assessment.riskClass, preRiskFloor: state.preRiskFloor, postRiskFloor: state.postRiskFloor, effectiveRiskClass: state.effectiveRiskClass,
			flashAssessmentDigest: state.flashAssessmentDigest, parentDraftDigest: state.parentDraftDigest, plannerOutputDigest: state.plannerOutputDigest, finalGraphSpecDigest: state.reviewSpecDigest, lineageDigest: state.lineageDigest,
			planningProfile: state.planningProfile, parentModel: state.parentModel, planner: state.planner, reviewer: input.reviewer, issuedAt: new Date().toISOString(),
		};
		state.receipt = receipt;
		return receipt;
	}

	reserveStart(input: { sessionId: string; cwd: string; configDigest: string; spec: GraphSpec; toolCallId: string }): PlanningReceipt {
		const state = this.requireTurn(input.sessionId, input.cwd);
		const receipt = state.receipt;
		if (!receipt) throw new Error("Graph start requires plan_graph followed by a passing review_graph_spec in this session and turn.");
		if (receipt.consumedByRunId) throw new Error(`Planning receipt was already consumed by Graph '${receipt.consumedByRunId}'.`);
		if (receipt.configDigest !== input.configDigest) throw new Error("Routing configuration changed after GraphSpec review; repeat both planning gates.");
		if (receipt.finalGraphSpecDigest !== graphSpecDigest(input.spec)) throw new Error("GraphSpec changed after review; review the exact new GraphSpec before starting it.");
		if (state.reservedToolCallId && state.reservedToolCallId !== input.toolCallId) throw new Error("Planning receipt is already reserved by another Graph start.");
		state.reservedToolCallId = input.toolCallId;
		return receipt;
	}

	commitStart(input: { sessionId: string; cwd: string; toolCallId: string; runId: string }): PlanningReceipt {
		const state = this.requireTurn(input.sessionId, input.cwd);
		if (!state.receipt || state.reservedToolCallId !== input.toolCallId) throw new Error("Graph start reservation is missing or belongs to another call.");
		state.receipt.consumedByRunId = input.runId;
		return state.receipt;
	}

	releaseStart(input: { sessionId: string; cwd: string; toolCallId: string }): void {
		const state = this.turns.get(key(input.sessionId, input.cwd));
		if (state?.reservedToolCallId === input.toolCallId && !state.receipt?.consumedByRunId) delete state.reservedToolCallId;
	}

	private requireTurn(sessionId: string, cwd: string): TurnState {
		const state = this.turns.get(key(sessionId, cwd));
		if (!state) throw new Error("No active planning-gate turn is bound to this Pi session and workspace.");
		return state;
	}
}

const PLANNING_GATE_GLOBAL = Symbol.for("pi-graph.planning-gate.v2");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;
const existingPlanningGate = globalRegistry[PLANNING_GATE_GLOBAL];
export const planningGate = existingPlanningGate ? existingPlanningGate as PlanningGate : (globalRegistry[PLANNING_GATE_GLOBAL] = new PlanningGate()) as PlanningGate;
