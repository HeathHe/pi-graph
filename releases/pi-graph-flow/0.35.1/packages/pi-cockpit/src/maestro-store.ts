import { sanitizeExtensionStatusText } from "./extension-status.ts";
import {
	MAESTRO_UI_SNAPSHOT_VERSION,
	type MaestroArtifactV1,
	type MaestroGoalV1,
	type MaestroCurrentDisplayV1,
	type MaestroGoalDeliveryV1,
	type MaestroGoalBudgetViewV1,
	type MaestroModeV1,
	type MaestroSwarmBestV1,
	type MaestroSwarmV1,
	type MaestroSwarmWorkerV1,
	type MaestroUiSnapshotV1,
	type MaestroUiStateSnapshotV1,
	type MaestroWorkflowChainV1,
	type MaestroWorkflowGatesV1,
	type MaestroWorkflowRunV1,
	type MaestroWorkflowSessionV1,
	type MaestroWorkflowV1,
} from "./public/v1/events.ts";

/** Authoritative, generation-fenced replacement store for Maestro UI snapshots. */
export class MaestroStore {
	private value: MaestroUiStateSnapshotV1 | undefined;
	private sessionGeneration: string | undefined;
	private revision: number | undefined;
	private readonly fencedGenerations = new Set<string>();

	applySnapshot(payload: unknown): boolean {
		let next: MaestroUiSnapshotV1 | undefined;
		try {
			next = parseSnapshot(payload);
		} catch {
			return false;
		}
		if (!next) return false;

		if (this.sessionGeneration !== undefined) {
			if (next.sessionGeneration === this.sessionGeneration) {
				if (this.revision !== undefined && next.revision <= this.revision) return false;
			} else {
				if (this.fencedGenerations.has(next.sessionGeneration)) return false;
				this.fencedGenerations.add(this.sessionGeneration);
			}
		}

		this.sessionGeneration = next.sessionGeneration;
		this.revision = next.revision;
		this.value = next.cleared === true ? undefined : next;
		return true;
	}

	snapshot(): MaestroUiStateSnapshotV1 | undefined {
		return this.value === undefined ? undefined : structuredClone(this.value);
	}

	/** Content fingerprint for render memoization; changes on every accepted update. */
	get contentRevision(): string {
		return `${this.sessionGeneration ?? "-"}/${this.revision ?? "-"}`;
	}

	/** Live workflow view for hot render paths; not a defensive copy. */
	workflow(): MaestroWorkflowV1 | null | undefined {
		return this.value?.workflow;
	}

	clear(): void {
		this.value = undefined;
		this.sessionGeneration = undefined;
		this.revision = undefined;
		this.fencedGenerations.clear();
	}
}

function parseSnapshot(value: unknown): MaestroUiSnapshotV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== MAESTRO_UI_SNAPSHOT_VERSION
		|| !isOpaqueId(value.sessionGeneration)
		|| !isNonNegativeInteger(value.revision)
		|| !isNonNegativeNumber(value.publishedAt)
	) return undefined;

	const envelope = {
		version: MAESTRO_UI_SNAPSHOT_VERSION,
		sessionGeneration: value.sessionGeneration,
		revision: value.revision,
		publishedAt: value.publishedAt,
	};
	if (value.cleared === true) return { ...envelope, cleared: true };
	if (value.cleared !== undefined && value.cleared !== false) return undefined;

	const workflow = value.workflow === null ? null : parseWorkflow(value.workflow);
	if (workflow === undefined) return undefined;
	if (!Array.isArray(value.goals)) return undefined;
	const goals: MaestroGoalV1[] = [];
	for (const item of value.goals) {
		const goal = parseGoal(item);
		if (!goal) return undefined;
		goals.push(goal);
	}
    let currentDisplay = value.currentDisplay === undefined ? undefined : parseCurrentDisplay(value.currentDisplay);
    if (value.currentDisplay !== undefined && !currentDisplay) return undefined;
    if (currentDisplay && currentDisplay.deliveries.some(d => !goals.some(g => g.id === d.goalId && g.status === "done"
      && g.delivery?.phase === "delivered" && g.delivery.receiptEntryId === d.receiptEntryId && g.delivery.deliveredAt === d.deliveredAt))) return undefined;
    if (currentDisplay) {
      // Verify the producer's exact raw workflow binding before normalizing any display text.
      // Retain known knowledge fields below, so pending knowledge cannot disappear during this join.
      for (const d of currentDisplay.deliveries) {
        if (d.workflowFingerprint !== undefined && (!workflow || d.workflowSessionId !== workflow.session.id
          || d.workflowFingerprint !== JSON.stringify(value.workflow))) return undefined;
      }
      currentDisplay = {...currentDisplay,deliveries:currentDisplay.deliveries.map(d => d.workflowFingerprint === undefined
        ? d : {...d,workflowFingerprint:JSON.stringify(workflow)})};
    }
	const swarm = value.swarm === null ? null : parseSwarm(value.swarm);
	if (swarm === undefined) return undefined;
	const artifact = value.artifact === undefined ? undefined : parseArtifact(value.artifact);
	if (value.artifact !== undefined && artifact === undefined) return undefined;
	const mode = parseMode(value.mode);
	if (mode === undefined) return undefined;
	if (value.currentGoalId !== undefined && !isOpaqueId(value.currentGoalId)) return undefined;

	return {
		...envelope,
		...(value.cleared === false ? { cleared: false as const } : {}),
		workflow,
		goals,
        ...(currentDisplay ? {currentDisplay} : {}),
		...(value.currentGoalId === undefined ? {} : { currentGoalId: value.currentGoalId }),
		swarm,
		...(artifact === undefined ? {} : { artifact }),
		mode,
	};
}

function parseWorkflow(value: unknown): MaestroWorkflowV1 | undefined {
	if (!isRecord(value)) return undefined;
	const session = parseWorkflowSession(value.session);
	const run = value.run === null ? null : parseWorkflowRun(value.run);
	const chain = parseWorkflowChain(value.chain);
	const gates = parseWorkflowGates(value.gates);
	const next = value.next === null ? null : displayString(value.next);
	if (!session || run === undefined || !chain || !gates || next === undefined) return undefined;
    const knowledge = value.knowledge === undefined ? undefined : parseWorkflowKnowledge(value.knowledge);
    if (value.knowledge !== undefined && knowledge === undefined) return undefined;
	return { session, run, chain, gates, next, ...(knowledge === undefined ? {} : {knowledge}) };
}

function parseWorkflowKnowledge(value: unknown): MaestroWorkflowV1["knowledge"] | undefined {
 if (!isRecord(value) || !isNonNegativeInteger(value.consumed) || !isNonNegativeInteger(value.cited)
   || !isNonNegativeInteger(value.validated) || !isNonNegativeInteger(value.contradicted)
   || !isNonNegativeInteger(value.pending) || !isNonNegativeInteger(value.corroborated)
   || !isNonNegativeInteger(value.review) || !isNonNegativeInteger(value.promoted)) return undefined;
 return {consumed:value.consumed,cited:value.cited,validated:value.validated,contradicted:value.contradicted,
   pending:value.pending,corroborated:value.corroborated,review:value.review,promoted:value.promoted};
}

function parseWorkflowSession(value: unknown): MaestroWorkflowSessionV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.id)) return undefined;
	const label = displayString(value.label);
	const status = displayString(value.status);
	return label === undefined || status === undefined ? undefined : { id: value.id, label, status };
}

function parseWorkflowRun(value: unknown): MaestroWorkflowRunV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.id)) return undefined;
	const command = displayString(value.command);
	const status = displayString(value.status);
	return command === undefined || status === undefined ? undefined : { id: value.id, command, status };
}

function parseWorkflowChain(value: unknown): MaestroWorkflowChainV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (
		!isNonNegativeInteger(value.completed)
		|| !isNonNegativeInteger(value.running)
		|| !isNonNegativeInteger(value.pending)
		|| !isNonNegativeInteger(value.total)
	) return undefined;
	return {
		completed: value.completed,
		running: value.running,
		pending: value.pending,
		total: value.total,
	};
}

function parseWorkflowGates(value: unknown): MaestroWorkflowGatesV1 | undefined {
	if (!isRecord(value) || !isNonNegativeInteger(value.passed) || !isNonNegativeInteger(value.total)) return undefined;
	if (value.failed !== undefined && !isNonNegativeInteger(value.failed)) return undefined;
	return {
		passed: value.passed,
		total: value.total,
		...(value.failed === undefined ? {} : { failed: value.failed }),
	};
}

function isBudgetKind(value: unknown): value is MaestroGoalBudgetViewV1["kind"] {
  return typeof value === "string" && ["none", "uninitialized", "ledger", "unknown", "unavailable"].includes(value);
}
function isBudgetAdmission(value: unknown): value is MaestroGoalBudgetViewV1["admission"] {
  return typeof value === "string" && ["none", "first-reservation", "ready", "waiting", "exhausted", "unknown", "unavailable"].includes(value);
}
function parseBudgetView(value: unknown): MaestroGoalBudgetViewV1 | undefined {
  if (value === undefined) return undefined;
  const invalid: MaestroGoalBudgetViewV1 = { version: 1, kind: "unavailable", admission: "unavailable", text: "预算状态数据无效" };
  if (!isRecord(value) || value.version !== 1 || !isBudgetKind(value.kind) || !isBudgetAdmission(value.admission)) return invalid;
  const text = displayString(value.text); if (!text || text.length > 240) return invalid;
  for (const key of ["knownConsumed", "held"]) if (value[key] !== undefined
    && (typeof value[key] !== "string" || !/^(0|[1-9][0-9]{0,31})$/.test(value[key]))) return invalid;
  for (const key of ["declaredLimit", "poolLimit", "revision", "available", "unknownRequests"]) if (value[key] !== undefined
    && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0)) return invalid;
  if (value.progress !== undefined && (typeof value.progress !== "number" || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1)) return invalid;
  const reason = value.reason === undefined ? undefined : displayString(value.reason);
  if (value.reason !== undefined && (!reason || reason.length > 80)) return invalid;
  return { version: 1, kind: value.kind, admission: value.admission, text,
    ...(typeof value.knownConsumed === "string" ? { knownConsumed: value.knownConsumed } : {}),
    ...(typeof value.held === "string" ? { held: value.held } : {}),
    ...(typeof value.declaredLimit === "number" ? { declaredLimit: value.declaredLimit } : {}),
    ...(typeof value.poolLimit === "number" ? { poolLimit: value.poolLimit } : {}),
    ...(typeof value.revision === "number" ? { revision: value.revision } : {}),
    ...(typeof value.available === "number" ? { available: value.available } : {}),
    ...(typeof value.unknownRequests === "number" ? { unknownRequests: value.unknownRequests } : {}),
    ...(typeof value.progress === "number" ? { progress: value.progress } : {}), ...(reason ? { reason } : {}),
  };
}

function parseGoal(value: unknown): MaestroGoalV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.id)) return undefined;
    const delivery = value.delivery === undefined ? undefined : parseGoalDelivery(value.delivery);
    if (value.delivery !== undefined && !delivery) return undefined;
	const objective = displayString(value.objective);
	const status = displayString(value.status);
	const pauseReason = value.pauseReason === undefined ? undefined : displayString(value.pauseReason);
	if (
		objective === undefined
		|| status === undefined
		|| (value.pauseReason !== undefined && pauseReason === undefined)
		|| !isNonNegativeInteger(value.iteration)
		|| !isNonNegativeNumber(value.tokensUsed)
		|| (value.tokenBudget !== undefined && !isNonNegativeNumber(value.tokenBudget))
		|| !isNonNegativeNumber(value.timeUsedSeconds)
		|| !isNonNegativeNumber(value.startedAt)
		|| !isNonNegativeNumber(value.updatedAt)
	) return undefined;
	return {
		id: value.id,
		objective,
		status,
        ...(delivery ? {delivery} : {}),
		...(pauseReason === undefined ? {} : { pauseReason }),
		iteration: value.iteration,
		tokensUsed: value.tokensUsed,
		...(value.tokenBudget === undefined ? {} : { tokenBudget: value.tokenBudget }),
		...(value.budgetView === undefined ? {} : { budgetView: parseBudgetView(value.budgetView) }),
		timeUsedSeconds: value.timeUsedSeconds,
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
	};
}

function parseSwarm(value: unknown): MaestroSwarmV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.sessionId) || !Array.isArray(value.workers)) return undefined;
	const objective = displayString(value.objective);
	const status = displayString(value.status);
	if (
		objective === undefined
		|| status === undefined
		|| !isNonNegativeInteger(value.iteration)
		|| !isNonNegativeInteger(value.maxIterations)
		|| !isNonNegativeNumber(value.updatedAt)
	) return undefined;
	const workers: MaestroSwarmWorkerV1[] = [];
	for (const item of value.workers) {
		const worker = parseSwarmWorker(item);
		if (!worker) return undefined;
		workers.push(worker);
	}
	const best = value.best === null ? null : parseSwarmBest(value.best);
	if (best === undefined) return undefined;
	return {
		sessionId: value.sessionId,
		objective,
		status,
		iteration: value.iteration,
		maxIterations: value.maxIterations,
		workers,
		best,
		updatedAt: value.updatedAt,
	};
}

function parseSwarmWorker(value: unknown): MaestroSwarmWorkerV1 | undefined {
	if (!isRecord(value) || !isOpaqueId(value.id)) return undefined;
	const label = value.label === undefined ? undefined : displayString(value.label);
	const status = displayString(value.status);
	if (status === undefined || (value.label !== undefined && label === undefined)) return undefined;
	return { id: value.id, ...(label === undefined ? {} : { label }), status };
}

function parseSwarmBest(value: unknown): MaestroSwarmBestV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (value.workerId !== undefined && !isOpaqueId(value.workerId)) return undefined;
	const summary = value.summary === undefined ? undefined : displayString(value.summary);
	if (
		(value.summary !== undefined && summary === undefined)
		|| !isNonNegativeInteger(value.iteration)
		|| !isFiniteNumber(value.score)
	) return undefined;
	return {
		...(value.workerId === undefined ? {} : { workerId: value.workerId }),
		iteration: value.iteration,
		score: value.score,
		...(summary === undefined ? {} : { summary }),
	};
}

function parseArtifact(value: unknown): MaestroArtifactV1 | undefined {
	if (!isRecord(value) || typeof value.available !== "boolean") return undefined;
	if (value.planRevision !== undefined && !isNonNegativeInteger(value.planRevision)) return undefined;
	const planStatus = value.planStatus === undefined ? undefined : displayString(value.planStatus);
	if (value.planStatus !== undefined && planStatus === undefined) return undefined;
	if (value.knowledgeSessionId !== undefined && !isOpaqueId(value.knowledgeSessionId)) return undefined;
	return {
		available: value.available,
		...(value.planRevision === undefined ? {} : { planRevision: value.planRevision }),
		...(planStatus === undefined ? {} : { planStatus }),
		...(value.knowledgeSessionId === undefined ? {} : { knowledgeSessionId: value.knowledgeSessionId }),
	};
}

function parseMode(value: unknown): MaestroModeV1 | undefined {
	if (typeof value === "string") return sanitizeExtensionStatusText(value);
	if (!isRecord(value)) return undefined;
	const kind = displayString(value.kind);
	const label = value.label === undefined ? undefined : displayString(value.label);
	if (kind === undefined || (value.label !== undefined && label === undefined)) return undefined;
	return { kind, ...(label === undefined ? {} : { label }) };
}

function displayString(value: unknown): string | undefined {
	return typeof value === "string" ? sanitizeExtensionStatusText(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return isNonNegativeNumber(value) && Number.isInteger(value);
}

function parseGoalDelivery(value: unknown): MaestroGoalDeliveryV1 | undefined {
 if (!isRecord(value) || (value.phase !== "awaiting-reply" && value.phase !== "delivered")) return undefined;
 if (value.receiptEntryId !== undefined && !isOpaqueId(value.receiptEntryId)) return undefined;
 if (value.deliveredAt !== undefined && !isNonNegativeNumber(value.deliveredAt)) return undefined;
 return {phase:value.phase,...(value.receiptEntryId === undefined ? {} : {receiptEntryId:value.receiptEntryId as string}),
 ...(value.deliveredAt === undefined ? {} : {deliveredAt:value.deliveredAt as number})};
}
function parseCurrentDisplay(value: unknown): MaestroCurrentDisplayV1 | undefined {
 if (!isRecord(value) || value.version !== 1 || !isRecord(value.source)
   || !isOpaqueId(value.source.cwd) || !isOpaqueId(value.source.sessionId) || !isOpaqueId(value.source.branchAnchor)
   || !Array.isArray(value.deliveries)) return undefined;
 const deliveries: MaestroCurrentDisplayV1["deliveries"] = [], ids = new Set<string>();
 for (const d of value.deliveries) {
   if (!isRecord(d) || ![d.goalId,d.receiptEntryId,d.contractDigest,d.groupDigest].every(isOpaqueId)
     || !isNonNegativeNumber(d.deliveredAt) || !isNonNegativeNumber(d.visibleUntil)
     || d.visibleUntil !== d.deliveredAt + 8_000 || !["verified","settled"].includes(String(d.phase))
     || !Array.isArray(d.tasks) || (d.workflowSessionId !== undefined && !isOpaqueId(d.workflowSessionId))
     || (d.workflowFingerprint !== undefined && typeof d.workflowFingerprint !== "string")) return undefined;
   const goalId = d.goalId as string; if (ids.has(goalId)) return undefined; ids.add(goalId);
   const tasks: MaestroCurrentDisplayV1["deliveries"][number]["tasks"] = [], taskIds = new Set<string>();
   for (const t of d.tasks) {
     if (!isRecord(t) || ![t.id,t.taskInstanceId,t.contractDigest,t.qualificationDigest,t.goalId,t.groupId].every(isOpaqueId)
       || !isNonNegativeInteger(t.contractVersion) || t.goalId !== goalId || taskIds.has(String(t.id))) return undefined;
     taskIds.add(String(t.id)); tasks.push({id:t.id as string,taskInstanceId:t.taskInstanceId as string,contractVersion:t.contractVersion,
       contractDigest:t.contractDigest as string,qualificationDigest:t.qualificationDigest as string,goalId,groupId:t.groupId as string});
   }
   deliveries.push({goalId,receiptEntryId:d.receiptEntryId as string,contractDigest:d.contractDigest as string,groupDigest:d.groupDigest as string,
     deliveredAt:d.deliveredAt,visibleUntil:d.visibleUntil,phase:d.phase as "verified"|"settled",tasks,
     ...(d.workflowSessionId === undefined ? {} : {workflowSessionId:d.workflowSessionId as string}),
     ...(d.workflowFingerprint === undefined ? {} : {workflowFingerprint:d.workflowFingerprint as string})});
 }
 return {version:1,source:{cwd:value.source.cwd,sessionId:value.source.sessionId,branchAnchor:value.source.branchAnchor},deliveries};
}
