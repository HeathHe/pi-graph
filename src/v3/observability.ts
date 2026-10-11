import type {
	V3ChildObservation,
	V3ChildSupervision,
	V3ChildProgressObservation,
	V3ChildTokenUsageObservation,
} from "./types.ts";

const AGENT_MAX = 200;
const ID_MAX = 256;
const MODEL_MAX = 256;
const THINKING_MAX = 32;
const SESSION_FILE_MAX = 2_048;
const TOOL_MAX = 128;
const CURRENT_PATH_MAX = 1_024;
const ATTEMPTED_MODELS_MAX = 16;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const OBSERVATION_FIELDS = new Set([
	"asyncId", "runId", "requestedAgent", "resolvedAgent", "actualAgent", "requestedModel", "resolvedModel", "actualModel",
	"supervision", "thinking", "attemptedModels", "sessionFile", "launchContractDigest", "usage", "durationMs", "progress", "observedAt",
]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "turns", "costUsd"]);
const PROGRESS_FIELDS = new Set(["state", "currentTool", "currentPath", "lastTool", "lastToolAt", "toolCount", "turnCount", "lastActivityAt"]);
const CHILD_STATES = new Set(["queued", "running", "complete", "completed", "failed", "paused", "stopped", "rejected"]);

export class V3ObservationValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "V3ObservationValidationError";
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteNonNegative(value: unknown, integer = false): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	const bounded = Math.min(value, Number.MAX_SAFE_INTEGER);
	return integer ? Math.floor(bounded) : bounded;
}

function cleanText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	// The lifecycle file is a projection, not trusted terminal input. Strip ANSI
	// controls and collapse every remaining control/line break before persistence.
	const clean = value
		.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
		.replaceAll(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
		.replaceAll(/\s+/gu, " ")
		.trim()
		.slice(0, maxLength);
	return clean || undefined;
}

function isoFrom(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	}
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
	return new Date(value).toISOString();
}

function boundedStrings(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const output: string[] = [];
	for (const entry of value) {
		const clean = cleanText(entry, maxLength);
		if (!clean || output.includes(clean)) continue;
		output.push(clean);
		if (output.length >= maxItems) break;
	}
	return output.length ? output : undefined;
}

function usageFrom(value: unknown): V3ChildTokenUsageObservation | undefined {
	const raw = record(value);
	if (!raw) return undefined;
	const inputTokens = finiteNonNegative(raw.inputTokens ?? raw.input, true);
	const outputTokens = finiteNonNegative(raw.outputTokens ?? raw.output, true);
	const reportedTotal = finiteNonNegative(raw.totalTokens ?? raw.total, true);
	const calculatedTotal = inputTokens === undefined && outputTokens === undefined
		? undefined
		: (inputTokens ?? 0) + (outputTokens ?? 0);
	const totalTokens = reportedTotal === undefined ? calculatedTotal : Math.max(reportedTotal, calculatedTotal ?? 0);
	const cacheReadTokens = finiteNonNegative(raw.cacheReadTokens ?? raw.cacheRead, true);
	const cacheWriteTokens = finiteNonNegative(raw.cacheWriteTokens ?? raw.cacheWrite, true);
	const turns = finiteNonNegative(raw.turns, true);
	const costUsd = finiteNonNegative(raw.costUsd ?? raw.cost);
	if ([inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, turns, costUsd].every((entry) => entry === undefined)) return undefined;
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(totalTokens === undefined ? {} : { totalTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
		...(turns === undefined ? {} : { turns }),
		...(costUsd === undefined ? {} : { costUsd }),
	};
}

function mergeUsage(
	base: V3ChildTokenUsageObservation | undefined,
	next: V3ChildTokenUsageObservation | undefined,
): V3ChildTokenUsageObservation | undefined {
	if (!base) return next;
	if (!next) return base;
	return { ...base, ...next };
}

function usageFromModelAttempts(value: unknown): V3ChildTokenUsageObservation | undefined {
	if (!Array.isArray(value)) return undefined;
	let aggregate: V3ChildTokenUsageObservation | undefined;
	for (const attempt of value.slice(0, ATTEMPTED_MODELS_MAX)) {
		const next = usageFrom(record(attempt)?.usage);
		if (!next) continue;
		aggregate = {
			inputTokens: (aggregate?.inputTokens ?? 0) + (next.inputTokens ?? 0),
			outputTokens: (aggregate?.outputTokens ?? 0) + (next.outputTokens ?? 0),
			totalTokens: (aggregate?.totalTokens ?? 0) + (next.totalTokens ?? 0),
			cacheReadTokens: (aggregate?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
			cacheWriteTokens: (aggregate?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
			turns: (aggregate?.turns ?? 0) + (next.turns ?? 0),
			costUsd: (aggregate?.costUsd ?? 0) + (next.costUsd ?? 0),
		};
	}
	return aggregate;
}

function attemptedModelsFromAttempts(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return boundedStrings(value.map((entry) => record(entry)?.model), ATTEMPTED_MODELS_MAX, MODEL_MAX);
}

function firstResult(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	return Array.isArray(value?.results) ? record(value.results[0]) : undefined;
}

function firstStep(value: Record<string, unknown>): Record<string, unknown> | undefined {
	return Array.isArray(value.steps) ? record(value.steps[0]) : undefined;
}

// Read only completed-tool identity/time; arguments are deliberately never inspected.
function latestFinishedTool(value: unknown): { lastTool: string; lastToolAt: string } | undefined {
	if (!Array.isArray(value)) return undefined;
	let latest: { lastTool: string; lastToolAt: string } | undefined;
	let latestMs = -1;
	for (const entry of value) {
		const row = record(entry);
		if (!row || typeof row.tool !== "string" || row.tool.length > TOOL_MAX) continue;
		const tool = cleanText(row.tool, TOOL_MAX);
		if (!tool || typeof row.endMs !== "number" || !Number.isSafeInteger(row.endMs) || row.endMs < 0) continue;
		const at = isoFrom(row.endMs);
		if (at && row.endMs >= latestMs) { latestMs = row.endMs; latest = { lastTool: tool, lastToolAt: at }; }
	}
	return latest;
}

function rawProgress(status: Record<string, unknown>, step: Record<string, unknown> | undefined): V3ChildProgressObservation | undefined {
	const finished = latestFinishedTool(step?.recentTools);
	const stateValue = cleanText(step?.status ?? status.state, 16);
	const state = stateValue && CHILD_STATES.has(stateValue) ? stateValue as V3ChildProgressObservation["state"] : undefined;
	const currentTool = cleanText(step?.currentTool ?? status.currentTool, TOOL_MAX);
	const currentPath = cleanText(step?.currentPath ?? status.currentPath, CURRENT_PATH_MAX);
	const toolCount = finiteNonNegative(step?.toolCount ?? status.toolCount, true);
	const turnCount = finiteNonNegative(step?.turnCount ?? status.turnCount, true);
	const lastActivityAt = isoFrom(step?.lastActivityAt ?? status.lastActivityAt);
	if ([state, currentTool, currentPath, finished, toolCount, turnCount, lastActivityAt].every((entry) => entry === undefined)) return undefined;
	return {
		...(state ? { state } : {}),
		...finished,
		...(currentTool ? { currentTool } : {}),
		...(currentPath ? { currentPath } : {}),
		...(toolCount === undefined ? {} : { toolCount }),
		...(turnCount === undefined ? {} : { turnCount }),
		...(lastActivityAt ? { lastActivityAt } : {}),
	};
}

function terminalUsage(
	status: Record<string, unknown>,
	step: Record<string, unknown> | undefined,
	completion: Record<string, unknown> | undefined,
	result: Record<string, unknown> | undefined,
): V3ChildTokenUsageObservation | undefined {
	const attemptsUsage = usageFromModelAttempts(result?.modelAttempts ?? step?.modelAttempts);
	const directUsage = usageFrom(result?.usage);
	const tokenUsage = usageFrom(result?.tokens ?? step?.tokens ?? completion?.totalTokens ?? status.totalTokens);
	const costUsage = usageFrom(result?.totalCost ?? step?.totalCost ?? completion?.totalCost ?? status.totalCost);
	const turnUsage = finiteNonNegative(result?.turnCount ?? step?.turnCount ?? completion?.turnCount ?? status.turnCount, true);
	return mergeUsage(
		mergeUsage(mergeUsage(mergeUsage(attemptsUsage, directUsage), tokenUsage), costUsage),
		turnUsage === undefined ? undefined : { turns: turnUsage },
	);
}

export function childSupervision(status: Record<string, unknown>, now: number, probe: V3ChildSupervision["probe"] = "not_checked"): V3ChildSupervision {
	const startedAt = isoFrom(status.startedAt);
	const terminal = ["complete", "completed", "failed", "paused", "stopped", "rejected"].includes(String(status.state));
	const activity = terminal ? "terminal" : "unknown";
	const deadlineAt = isoFrom(status.deadlineAt);
	const error = status.state === "failed" ? cleanText(status.error ?? firstStep(status)?.error, 1_024) : undefined;
	return {
		activity, checkedAt: new Date(now).toISOString(), probe,
		runtimeLimit: status.noTimeout === true ? "unlimited" : deadlineAt || typeof status.timeoutMs === "number" ? "configured" : "unknown",
		...(startedAt ? { startedAt } : {}), ...(deadlineAt ? { deadlineAt } : {}), ...(error ? { error } : {}),
	};
}

function validateSupervision(value: unknown): V3ChildSupervision | undefined {
	if (value === undefined) return undefined;
	const raw = record(value);
	if (!raw || Object.keys(raw).some((key) => !["activity", "checkedAt", "startedAt", "runtimeLimit", "deadlineAt", "probe", "error", "version", "phase", "phaseStartedAt", "runnerInstanceId", "seq", "health", "failedProbes", "observedMutation", "runtimeRetries", "repeatedErrors", "processExitConfirmed", "runtimeFailure", "attention"].includes(key))) throw new V3ObservationValidationError("Invalid supervision fields");
	if (!["active", "quiet", "unknown", "terminal"].includes(String(raw.activity)) || !["unlimited", "configured", "unknown"].includes(String(raw.runtimeLimit)) || !["available", "unreachable", "not_checked"].includes(String(raw.probe))) throw new V3ObservationValidationError("Invalid supervision state");
	for (const key of ["checkedAt", "startedAt", "deadlineAt"]) {
		if ((key === "checkedAt" || raw[key] !== undefined) && (typeof raw[key] !== "string" || isoFrom(raw[key]) !== raw[key])) throw new V3ObservationValidationError(`Invalid supervision ${key}`);
	}
	optionalCleanString(raw.error, "supervision.error", 1_024);
	for (const key of ["phase", "runnerInstanceId", "attention"]) optionalCleanString(raw[key], `supervision.${key}`, 256);
	for (const key of ["seq", "failedProbes", "runtimeRetries", "repeatedErrors"]) validatedNumber(raw[key], `supervision.${key}`);
	for (const key of ["observedMutation", "processExitConfirmed", "runtimeFailure"]) if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new V3ObservationValidationError(`Invalid supervision ${key}`);
	if (raw.version !== undefined && raw.version !== 2) throw new V3ObservationValidationError("Invalid supervision version");
	if (raw.health !== undefined && !["responsive", "unknown", "suspected_unresponsive", "exited"].includes(String(raw.health))) throw new V3ObservationValidationError("Invalid supervision health");
	if (raw.phaseStartedAt !== undefined && isoFrom(raw.phaseStartedAt) !== raw.phaseStartedAt) throw new V3ObservationValidationError("Invalid phase timestamp");
	return { ...raw } as unknown as V3ChildSupervision;
}

export function supervisionFacts(observation: V3ChildObservation | undefined): string[] {
	const value = observation?.supervision;
	if (!value) return [];
	const elapsed = value.startedAt ? Math.max(0, Date.parse(value.checkedAt) - Date.parse(value.startedAt)) : undefined;
	return [
		`runtime ${value.runtimeLimit}`,
		value.phase ? `phase ${value.phase}` : undefined,
		value.health ? `runner ${value.health} (not a progress signal)` : undefined,
		value.attention ? `attention ${value.attention}` : undefined,
		value.repeatedErrors ? `repeated errors ${value.repeatedErrors}` : undefined,
		value.activity === "quiet" ? "no recent activity; progress unconfirmed (still waiting)" : value.activity === "unknown" ? "progress unknown (still waiting)" : undefined,
		value.probe === "unreachable" ? "status probe unavailable" : undefined,
		value.activity !== "terminal" && elapsed !== undefined ? `elapsed ${Math.floor(elapsed / 1_000)}s` : undefined,
		value.error ? `error ${value.error}` : undefined,
	].filter((item): item is string => item !== undefined);
}

/**
 * Project only the bounded public lifecycle fields needed by pi-graph. The raw
 * status/completion payload is never retained and no path found here is opened.
 */
export function observeV3ChildLifecycle(input: {
	asyncId: string;
	status: Record<string, unknown>;
	completion?: Record<string, unknown>;
	now?: number;
}): V3ChildObservation {
	const step = firstStep(input.status);
	const result = firstResult(input.completion);
	const asyncId = cleanText(input.asyncId, ID_MAX) ?? input.asyncId.slice(0, ID_MAX);
	// The outer async workflow id and the child run id can differ. Prefer the
	// child row/step identity; keep asyncId separately for lifecycle lookup.
	const runId = cleanText(result?.runId ?? step?.runId ?? input.completion?.runId ?? input.completion?.id ?? input.status.runId, ID_MAX);
	const actualAgent = cleanText(result?.agent ?? step?.agent ?? input.completion?.agent ?? input.status.agent, AGENT_MAX);
	const actualModel = cleanText(result?.model ?? step?.model ?? input.completion?.model ?? input.status.model, MODEL_MAX);
	const thinking = cleanText(result?.thinking ?? step?.thinking ?? input.completion?.thinking ?? input.status.thinking, THINKING_MAX);
	const attemptedModels = boundedStrings(
		result?.attemptedModels ?? step?.attemptedModels,
		ATTEMPTED_MODELS_MAX,
		MODEL_MAX,
	) ?? attemptedModelsFromAttempts(result?.modelAttempts ?? step?.modelAttempts);
	const sessionFile = cleanText(result?.sessionFile ?? step?.sessionFile ?? input.completion?.sessionFile ?? input.status.sessionFile, SESSION_FILE_MAX);
	const launchContractDigestRaw = result?.launchContractDigest ?? step?.launchContractDigest ?? input.completion?.launchContractDigest ?? input.status.launchContractDigest;
	const launchContractDigest = typeof launchContractDigestRaw === "string" && DIGEST_PATTERN.test(launchContractDigestRaw) ? launchContractDigestRaw : undefined;
	const usage = terminalUsage(input.status, step, input.completion, result);
	const durationMs = finiteNonNegative(
		input.completion?.durationMs
			?? result?.durationMs
			?? step?.durationMs
			?? (typeof input.status.endedAt === "number" && typeof input.status.startedAt === "number" ? input.status.endedAt - input.status.startedAt : undefined),
		true,
	);
	const progress = rawProgress(input.status, step);
	const supervision = childSupervision(input.status, input.now ?? Date.now());
	const observedAt = isoFrom(input.status.lastUpdate ?? input.status.endedAt ?? input.status.startedAt)
		?? new Date(input.now ?? Date.now()).toISOString();
	return {
		asyncId,
		...(runId ? { runId } : {}),
		...(actualAgent ? { actualAgent } : {}),
		...(actualModel ? { actualModel } : {}),
		...(thinking ? { thinking } : {}),
		...(attemptedModels ? { attemptedModels } : {}),
		...(sessionFile ? { sessionFile } : {}),
		...(launchContractDigest ? { launchContractDigest } : {}),
		...(usage ? { usage } : {}),
		...(durationMs === undefined ? {} : { durationMs }),
		...(progress ? { progress } : {}),
		...(supervision ? { supervision } : {}),
		observedAt,
	};
}

export function createV3DispatchObservation(input: {
	asyncId: string;
	requestedAgent?: string;
	resolvedAgent: string;
	requestedModel?: string;
	resolvedModel?: string;
	thinking?: string | false;
	observedAt?: string;
}): V3ChildObservation {
	const asyncId = cleanText(input.asyncId, ID_MAX) ?? input.asyncId.slice(0, ID_MAX);
	const requestedAgent = cleanText(input.requestedAgent, AGENT_MAX);
	const resolvedAgent = cleanText(input.resolvedAgent, AGENT_MAX);
	const requestedModel = cleanText(input.requestedModel, MODEL_MAX);
	const resolvedModel = cleanText(input.resolvedModel, MODEL_MAX);
	const thinking = input.thinking === false ? "off" : cleanText(input.thinking, THINKING_MAX);
	return {
		asyncId,
		...(requestedAgent ? { requestedAgent } : {}),
		...(resolvedAgent ? { resolvedAgent } : {}),
		...(requestedModel ? { requestedModel } : {}),
		...(resolvedModel ? { resolvedModel } : {}),
		...(thinking ? { thinking } : {}),
		observedAt: isoFrom(input.observedAt) ?? new Date().toISOString(),
	};
}

export function mergeV3ChildObservation(base: V3ChildObservation, next: V3ChildObservation, options: { replaceCurrentActivity?: boolean } = {}): V3ChildObservation {
	const previousProgress = { ...base.progress };
	// Only callers holding a complete native status sample opt in. Identity-only
	// and legacy partial updates must retain current activity.
	if (options.replaceCurrentActivity && next.progress) {
		delete previousProgress.currentTool;
		delete previousProgress.currentPath;
	}
	const attemptedModels = boundedStrings(
		[...(base.attemptedModels ?? []), ...(next.attemptedModels ?? [])],
		ATTEMPTED_MODELS_MAX,
		MODEL_MAX,
	);
	return {
		...base,
		...next,
		...(attemptedModels ? { attemptedModels } : {}),
		...(mergeUsage(base.usage, next.usage) ? { usage: mergeUsage(base.usage, next.usage)! } : {}),
		...(base.progress || next.progress ? { progress: { ...previousProgress, ...next.progress } } : {}),
	};
}

/** Fingerprint excludes observedAt so an unchanged status poll is a no-op. */
export function v3ChildObservationFingerprint(observation: V3ChildObservation): string {
	const { observedAt: _observedAt, ...stable } = observation;
	const supervision = stable.supervision;
	return JSON.stringify({ ...stable, ...(supervision ? { supervision: { ...supervision, checkedAt: Math.floor(Date.parse(supervision.checkedAt) / 30_000) } } : {}) });
}

function requireCleanString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength || cleanText(value, maxLength) !== value) {
		throw new V3ObservationValidationError(`child observation '${field}' is not a clean string of at most ${maxLength} characters`);
	}
	return value;
}

function optionalCleanString(value: unknown, field: string, maxLength: number): string | undefined {
	return value === undefined ? undefined : requireCleanString(value, field, maxLength);
}

function validatedNumber(value: unknown, field: string, integer = true): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isInteger(value))) {
		throw new V3ObservationValidationError(`child observation '${field}' must be a bounded non-negative ${integer ? "integer" : "number"}`);
	}
	return value;
}

export function validateV3ChildObservation(value: unknown): V3ChildObservation {
	const raw = record(value);
	if (!raw) throw new V3ObservationValidationError("child observation must be an object");
	for (const field of Object.keys(raw)) {
		if (!OBSERVATION_FIELDS.has(field)) throw new V3ObservationValidationError(`child observation contains unknown field '${field}'`);
	}
	const asyncId = requireCleanString(raw.asyncId, "asyncId", ID_MAX);
	const supervision = validateSupervision(raw.supervision);
	const runId = optionalCleanString(raw.runId, "runId", ID_MAX);
	const requestedAgent = optionalCleanString(raw.requestedAgent, "requestedAgent", AGENT_MAX);
	const resolvedAgent = optionalCleanString(raw.resolvedAgent, "resolvedAgent", AGENT_MAX);
	const actualAgent = optionalCleanString(raw.actualAgent, "actualAgent", AGENT_MAX);
	const requestedModel = optionalCleanString(raw.requestedModel, "requestedModel", MODEL_MAX);
	const resolvedModel = optionalCleanString(raw.resolvedModel, "resolvedModel", MODEL_MAX);
	const actualModel = optionalCleanString(raw.actualModel, "actualModel", MODEL_MAX);
	const thinking = optionalCleanString(raw.thinking, "thinking", THINKING_MAX);
	let attemptedModels: string[] | undefined;
	if (raw.attemptedModels !== undefined) {
		if (!Array.isArray(raw.attemptedModels) || raw.attemptedModels.length > ATTEMPTED_MODELS_MAX) throw new V3ObservationValidationError("child observation attemptedModels is invalid");
		attemptedModels = raw.attemptedModels.map((entry, index) => requireCleanString(entry, `attemptedModels[${index}]`, MODEL_MAX));
		if (new Set(attemptedModels).size !== attemptedModels.length) throw new V3ObservationValidationError("child observation attemptedModels must be unique");
	}
	const sessionFile = optionalCleanString(raw.sessionFile, "sessionFile", SESSION_FILE_MAX);
	let launchContractDigest: string | undefined;
	if (raw.launchContractDigest !== undefined) {
		if (typeof raw.launchContractDigest !== "string" || !DIGEST_PATTERN.test(raw.launchContractDigest)) throw new V3ObservationValidationError("child observation launchContractDigest must be a SHA-256 digest");
		launchContractDigest = raw.launchContractDigest;
	}
	let usage: V3ChildTokenUsageObservation | undefined;
	if (raw.usage !== undefined) {
		const rawUsage = record(raw.usage);
		if (!rawUsage) throw new V3ObservationValidationError("child observation usage must be an object");
		for (const field of Object.keys(rawUsage)) if (!USAGE_FIELDS.has(field)) throw new V3ObservationValidationError(`child observation usage contains unknown field '${field}'`);
		usage = {
			...(validatedNumber(rawUsage.inputTokens, "usage.inputTokens") === undefined ? {} : { inputTokens: rawUsage.inputTokens as number }),
			...(validatedNumber(rawUsage.outputTokens, "usage.outputTokens") === undefined ? {} : { outputTokens: rawUsage.outputTokens as number }),
			...(validatedNumber(rawUsage.totalTokens, "usage.totalTokens") === undefined ? {} : { totalTokens: rawUsage.totalTokens as number }),
			...(validatedNumber(rawUsage.cacheReadTokens, "usage.cacheReadTokens") === undefined ? {} : { cacheReadTokens: rawUsage.cacheReadTokens as number }),
			...(validatedNumber(rawUsage.cacheWriteTokens, "usage.cacheWriteTokens") === undefined ? {} : { cacheWriteTokens: rawUsage.cacheWriteTokens as number }),
			...(validatedNumber(rawUsage.turns, "usage.turns") === undefined ? {} : { turns: rawUsage.turns as number }),
			...(validatedNumber(rawUsage.costUsd, "usage.costUsd", false) === undefined ? {} : { costUsd: rawUsage.costUsd as number }),
		};
	}
	const durationMs = validatedNumber(raw.durationMs, "durationMs");
	let progress: V3ChildProgressObservation | undefined;
	if (raw.progress !== undefined) {
		const rawProgressValue = record(raw.progress);
		if (!rawProgressValue) throw new V3ObservationValidationError("child observation progress must be an object");
		for (const field of Object.keys(rawProgressValue)) if (!PROGRESS_FIELDS.has(field)) throw new V3ObservationValidationError(`child observation progress contains unknown field '${field}'`);
		if (rawProgressValue.state !== undefined && (typeof rawProgressValue.state !== "string" || !CHILD_STATES.has(rawProgressValue.state))) throw new V3ObservationValidationError("child observation progress state is invalid");
		const currentTool = optionalCleanString(rawProgressValue.currentTool, "progress.currentTool", TOOL_MAX);
		const currentPath = optionalCleanString(rawProgressValue.currentPath, "progress.currentPath", CURRENT_PATH_MAX);
		const lastTool = optionalCleanString(rawProgressValue.lastTool, "progress.lastTool", TOOL_MAX);
		const lastToolAt = optionalCleanString(rawProgressValue.lastToolAt, "progress.lastToolAt", 64);
		if ((lastTool === undefined) !== (lastToolAt === undefined) || (lastToolAt !== undefined && isoFrom(lastToolAt) !== lastToolAt)) throw new V3ObservationValidationError("child observation completed tool requires identity and canonical ISO timestamp");
		const toolCount = validatedNumber(rawProgressValue.toolCount, "progress.toolCount");
		const turnCount = validatedNumber(rawProgressValue.turnCount, "progress.turnCount");
		const lastActivityAt = rawProgressValue.lastActivityAt === undefined ? undefined : isoFrom(rawProgressValue.lastActivityAt);
		if (rawProgressValue.lastActivityAt !== undefined && lastActivityAt !== rawProgressValue.lastActivityAt) throw new V3ObservationValidationError("child observation progress.lastActivityAt must be a canonical ISO timestamp");
		progress = {
			...(rawProgressValue.state === undefined ? {} : { state: rawProgressValue.state as V3ChildProgressObservation["state"] }),
			...(currentTool ? { currentTool } : {}),
			...(currentPath ? { currentPath } : {}),
			...(lastTool && lastToolAt ? { lastTool, lastToolAt } : {}),
			...(toolCount === undefined ? {} : { toolCount }),
			...(turnCount === undefined ? {} : { turnCount }),
			...(lastActivityAt ? { lastActivityAt } : {}),
		};
	}
	const observedAt = requireCleanString(raw.observedAt, "observedAt", 64);
	if (isoFrom(observedAt) !== observedAt) throw new V3ObservationValidationError("child observation observedAt must be a canonical ISO timestamp");
	return {
		asyncId,
		...(runId ? { runId } : {}),
		...(requestedAgent ? { requestedAgent } : {}),
		...(resolvedAgent ? { resolvedAgent } : {}),
		...(actualAgent ? { actualAgent } : {}),
		...(requestedModel ? { requestedModel } : {}),
		...(resolvedModel ? { resolvedModel } : {}),
		...(actualModel ? { actualModel } : {}),
		...(thinking ? { thinking } : {}),
		...(attemptedModels ? { attemptedModels } : {}),
		...(sessionFile ? { sessionFile } : {}),
		...(launchContractDigest ? { launchContractDigest } : {}),
		...(usage ? { usage } : {}),
		...(durationMs === undefined ? {} : { durationMs }),
		...(progress ? { progress } : {}),
		...(supervision ? { supervision } : {}),
		observedAt,
	};
}
