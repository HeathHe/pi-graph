import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteJson } from "./durable.ts";
import { canonicalDigest } from "./digests.ts";
import { graphV3Error } from "./errors.ts";
import type {
	V3AcceptanceEvidence,
	V3AttemptEvidence,
	V3ChildOutcome,
	V3FailureKind,
	V3FileDigest,
	V3NodePhase,
	V3NodeTerminal,
	V3ValidatedResult,
	V3WorkspaceEvidence,
} from "./types.ts";
import { V3_ATTEMPT_SCHEMA_VERSION } from "./types.ts";

export interface V3RunPaths {
	runDir: string;
	authorizationPath: string;
	snapshotPath: string;
	eventsPath: string;
	eventsTruncatedPath: string;
	leasePath: string;
	artifactsDir: string;
	shadowDir: string;
	nodesDir: string;
	sessionsDir: string;
}

export function v3RunPaths(runDir: string): V3RunPaths {
	const root = resolve(runDir);
	return {
		runDir: root,
		authorizationPath: join(root, "authorization.json"),
		snapshotPath: join(root, "snapshot.json"),
		eventsPath: join(root, "events.jsonl"),
		eventsTruncatedPath: join(root, "events.truncated.json"),
		leasePath: join(root, "lease.json"),
		artifactsDir: join(root, "artifacts"),
		shadowDir: join(root, "shadow"),
		nodesDir: join(root, "nodes"),
		sessionsDir: join(root, "sessions"),
	};
}

export function v3NodeAttemptDir(runDir: string, taskId: string, attempt: number): string {
	return join(v3RunPaths(runDir).nodesDir, taskId, "attempts", String(attempt));
}

export function v3NodeEvidencePaths(runDir: string, taskId: string, attempt: number): Record<"attempt" | "workspace" | "validatedResult" | "acceptance", string> {
	const dir = v3NodeAttemptDir(runDir, taskId, attempt);
	return {
		attempt: join(dir, "attempt.json"),
		workspace: join(dir, "workspace.json"),
		validatedResult: join(dir, "validated-result.json"),
		acceptance: join(dir, "acceptance.json"),
	};
}

const ATTEMPT_FIELDS = new Set([
	"schemaVersion", "runInstanceId", "graphId", "taskId", "attempt", "attemptNonce", "phase", "createdAt", "updatedAt", "supervisorEpoch",
	"dispatch", "child", "verification", "applied", "failure", "terminalStatus", "workspaceDigest", "acceptanceDigest",
]);
const PHASES = new Set<V3NodePhase>(["queued", "prepared", "dispatched", "running", "verifying", "applying", "accepted", "failed", "aborted", "needs_attention"]);
const TERMINALS = new Set<V3NodeTerminal>(["accepted", "failed", "aborted", "needs_attention"]);
const FAILURE_KINDS = new Set<V3FailureKind>(["task_failed", "validation", "timeout", "workspace_conflict", "dispatch_unknown", "child_paused", "child_stopped", "internal"]);
const CHILD_TERMINALS = new Set(["complete", "failed", "stopped", "paused"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) graphV3Error("INVALID_ATTEMPT", `V3 attempt field '${field}' must be a non-empty string.`, { field });
	return value;
}

function requireIso(record: Record<string, unknown>, field: string): string {
	const value = requireString(record, field);
	if (Number.isNaN(Date.parse(value))) graphV3Error("INVALID_ATTEMPT", `V3 attempt field '${field}' must be an ISO-8601 timestamp.`, { field });
	return value;
}

function validateChildOutcome(value: unknown): V3ChildOutcome | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) graphV3Error("INVALID_ATTEMPT", "V3 attempt child outcome must be an object.", { field: "child" });
	if (typeof value.terminal !== "string" || !CHILD_TERMINALS.has(value.terminal)) graphV3Error("INVALID_ATTEMPT", "V3 attempt child terminal is invalid.", { field: "child" });
	if (typeof value.output !== "string") graphV3Error("INVALID_ATTEMPT", "V3 attempt child output must be a string.", { field: "child" });
	return { terminal: value.terminal as V3ChildOutcome["terminal"], output: value.output, completedAt: requireIso(value, "completedAt") };
}

export function validateV3Attempt(value: unknown): V3AttemptEvidence {
	if (!isRecord(value)) graphV3Error("INVALID_ATTEMPT", "V3 attempt evidence must be an object.");
	for (const field of Object.keys(value)) {
		if (!ATTEMPT_FIELDS.has(field)) graphV3Error("INVALID_ATTEMPT", `V3 attempt evidence contains unknown field '${field}'.`, { field });
	}
	if (value.schemaVersion !== V3_ATTEMPT_SCHEMA_VERSION) graphV3Error("INVALID_ATTEMPT", "V3 attempt evidence requires schemaVersion 1.", { field: "schemaVersion" });
	const runInstanceId = requireString(value, "runInstanceId");
	const graphId = requireString(value, "graphId");
	const taskId = requireString(value, "taskId");
	const attemptValue = value.attempt;
	if (typeof attemptValue !== "number" || !Number.isInteger(attemptValue) || attemptValue < 1) graphV3Error("INVALID_ATTEMPT", "V3 attempt number must be a positive integer.", { field: "attempt" });
	const attemptNonce = requireString(value, "attemptNonce");
	if (typeof value.phase !== "string" || !PHASES.has(value.phase as V3NodePhase)) graphV3Error("INVALID_ATTEMPT", "V3 attempt phase is invalid.", { field: "phase" });
	if (value.terminalStatus !== undefined && (typeof value.terminalStatus !== "string" || !TERMINALS.has(value.terminalStatus as V3NodeTerminal))) graphV3Error("INVALID_ATTEMPT", "V3 attempt terminalStatus is invalid.", { field: "terminalStatus" });
	const phase = value.phase as V3NodePhase;
	const terminalStatus = value.terminalStatus as V3NodeTerminal | undefined;
	if (PHASE_IS_TERMINAL[phase] && terminalStatus === undefined) graphV3Error("INVALID_ATTEMPT", `V3 terminal phase '${phase}' requires terminalStatus.`, { field: "terminalStatus" });
	if (!PHASE_IS_TERMINAL[phase] && terminalStatus !== undefined) graphV3Error("INVALID_ATTEMPT", `V3 non-terminal phase '${phase}' must omit terminalStatus.`, { field: "terminalStatus" });
	let dispatch: V3AttemptEvidence["dispatch"];
	if (value.dispatch !== undefined) {
		if (!isRecord(value.dispatch)) graphV3Error("INVALID_ATTEMPT", "V3 attempt dispatch must be an object.", { field: "dispatch" });
		if (typeof value.dispatch.asyncId !== "string" || typeof value.dispatch.asyncDir !== "string") graphV3Error("INVALID_ATTEMPT", "V3 attempt dispatch requires asyncId and asyncDir.", { field: "dispatch" });
		if (typeof value.dispatch.requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.dispatch.requestDigest)) graphV3Error("INVALID_ATTEMPT", "V3 attempt dispatch requestDigest must be a SHA-256 digest.", { field: "dispatch" });
		dispatch = {
			asyncId: value.dispatch.asyncId,
			asyncDir: value.dispatch.asyncDir,
			requestDigest: value.dispatch.requestDigest,
			dispatchedAt: requireIso(value.dispatch, "dispatchedAt"),
		};
	}
	const child = validateChildOutcome(value.child);
	let verification: V3AttemptEvidence["verification"];
	if (value.verification !== undefined) {
		if (!isRecord(value.verification)) graphV3Error("INVALID_ATTEMPT", "V3 attempt verification must be an object.", { field: "verification" });
		if (typeof value.verification.allPassed !== "boolean") graphV3Error("INVALID_ATTEMPT", "V3 attempt verification allPassed must be a boolean.", { field: "verification" });
		if (typeof value.verification.validatedResultDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.verification.validatedResultDigest)) graphV3Error("INVALID_ATTEMPT", "V3 attempt verification validatedResultDigest must be a SHA-256 digest.", { field: "verification" });
		verification = { allPassed: value.verification.allPassed, validatedResultDigest: value.verification.validatedResultDigest, verifiedAt: requireIso(value.verification, "verifiedAt") };
	}
	let applied: V3AttemptEvidence["applied"];
	if (value.applied !== undefined) {
		if (!isRecord(value.applied)) graphV3Error("INVALID_ATTEMPT", "V3 attempt applied must be an object.", { field: "applied" });
		if (!Array.isArray(value.applied.writes)) graphV3Error("INVALID_ATTEMPT", "V3 attempt applied writes must be an array.", { field: "applied" });
		applied = { writes: value.applied.writes as V3FileDigest[], appliedAt: requireIso(value.applied, "appliedAt") };
	}
	let failure: V3AttemptEvidence["failure"];
	if (value.failure !== undefined) {
		if (!isRecord(value.failure)) graphV3Error("INVALID_ATTEMPT", "V3 attempt failure must be an object.", { field: "failure" });
		if (typeof value.failure.kind !== "string" || !FAILURE_KINDS.has(value.failure.kind as V3FailureKind)) graphV3Error("INVALID_ATTEMPT", "V3 attempt failure kind is invalid.", { field: "failure" });
		if (typeof value.failure.message !== "string") graphV3Error("INVALID_ATTEMPT", "V3 attempt failure message must be a string.", { field: "failure" });
		failure = { kind: value.failure.kind as V3FailureKind, message: value.failure.message, at: requireIso(value.failure, "at") };
	}
	const workspaceDigest = optionalDigest(value.workspaceDigest, "workspaceDigest");
	const acceptanceDigest = optionalDigest(value.acceptanceDigest, "acceptanceDigest");
	const result: V3AttemptEvidence = {
		schemaVersion: V3_ATTEMPT_SCHEMA_VERSION,
		runInstanceId,
		graphId,
		taskId,
		attempt: attemptValue,
		attemptNonce,
		phase,
		createdAt: requireIso(value, "createdAt"),
		updatedAt: requireIso(value, "updatedAt"),
		supervisorEpoch: requireString(value, "supervisorEpoch"),
		...(dispatch ? { dispatch } : {}),
		...(child ? { child } : {}),
		...(verification ? { verification } : {}),
		...(applied ? { applied } : {}),
		...(failure ? { failure } : {}),
		...(terminalStatus ? { terminalStatus } : {}),
		...(workspaceDigest ? { workspaceDigest } : {}),
		...(acceptanceDigest ? { acceptanceDigest } : {}),
	};
	return result;
}

const PHASE_IS_TERMINAL: Record<V3NodePhase, boolean> = {
	queued: false, prepared: false, dispatched: false, running: false, verifying: false, applying: false,
	accepted: true, failed: true, aborted: true, needs_attention: true,
};

export function isV3TerminalPhase(phase: V3NodePhase): boolean {
	return PHASE_IS_TERMINAL[phase];
}

function optionalDigest(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) graphV3Error("INVALID_ATTEMPT", `V3 attempt field '${field}' must be a SHA-256 digest.`, { field });
	return value;
}

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeJson(path: string, value: unknown): Promise<string> {
	const digest = canonicalDigest(value);
	await atomicWriteJson(path, value);
	return digest;
}

export async function writeV3AttemptEvidence(runDir: string, taskId: string, attempt: number, evidence: V3AttemptEvidence): Promise<string> {
	return writeJson(v3NodeEvidencePaths(runDir, taskId, attempt).attempt, evidence);
}

export async function readV3AttemptEvidence(runDir: string, taskId: string, attempt: number): Promise<V3AttemptEvidence | undefined> {
	const raw = await readJson(v3NodeEvidencePaths(runDir, taskId, attempt).attempt);
	return raw === undefined ? undefined : validateV3Attempt(raw);
}

export interface LatestAttemptRef {
	attempt: number;
	evidence: V3AttemptEvidence;
}

export async function readLatestV3Attempt(runDir: string, taskId: string): Promise<LatestAttemptRef | undefined> {
	const base = join(v3RunPaths(runDir).nodesDir, taskId, "attempts");
	let entries;
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const attempts = entries
		.filter((entry) => entry.isDirectory() && /^[0-9]+$/u.test(entry.name))
		.map((entry) => Number(entry.name))
		.sort((left, right) => left - right);
	for (let index = attempts.length - 1; index >= 0; index -= 1) {
		const evidence = await readV3AttemptEvidence(runDir, taskId, attempts[index]!);
		if (evidence) return { attempt: attempts[index]!, evidence };
	}
	return undefined;
}

export interface V3WorkspaceEvidenceMeta extends V3WorkspaceEvidence {
	digest: string;
}

export async function writeV3WorkspaceEvidence(runDir: string, taskId: string, attempt: number, evidence: V3WorkspaceEvidence): Promise<string> {
	return writeJson(v3NodeEvidencePaths(runDir, taskId, attempt).workspace, evidence);
}

export async function readV3WorkspaceEvidence(runDir: string, taskId: string, attempt: number): Promise<V3WorkspaceEvidence | undefined> {
	const raw = await readJson(v3NodeEvidencePaths(runDir, taskId, attempt).workspace);
	return raw === undefined ? undefined : validateV3WorkspaceEvidence(raw);
}

export function validateV3WorkspaceEvidence(value: unknown): V3WorkspaceEvidence {
	if (!isRecord(value)) graphV3Error("INVALID_ATTEMPT", "V3 workspace evidence must be an object.");
	if (value.schemaVersion !== V3_ATTEMPT_SCHEMA_VERSION) graphV3Error("INVALID_ATTEMPT", "V3 workspace evidence requires schemaVersion 1.", { field: "schemaVersion" });
	for (const field of ["runInstanceId", "graphId", "taskId", "workspaceKind", "workspaceDir", "sourceCwd", "readBaseline", "writeBaseline", "inputBaseline", "contractDigest", "createdAt"]) {
		if (!(field in value)) graphV3Error("INVALID_ATTEMPT", `V3 workspace evidence is missing '${field}'.`, { field });
	}
	if (typeof value.workspaceKind !== "string" || !["shadow", "git"].includes(value.workspaceKind)) graphV3Error("INVALID_ATTEMPT", "V3 workspace kind must be shadow or git.", { field: "workspaceKind" });
	if (!isRecord(value.readBaseline) || !isRecord(value.writeBaseline) || !isRecord(value.inputBaseline)) graphV3Error("INVALID_ATTEMPT", "V3 workspace baselines must be objects.", { field: "baselines" });
	return value as unknown as V3WorkspaceEvidence;
}

export async function writeV3ValidatedResult(runDir: string, taskId: string, attempt: number, evidence: V3ValidatedResult): Promise<string> {
	return writeJson(v3NodeEvidencePaths(runDir, taskId, attempt).validatedResult, evidence);
}

export async function readV3ValidatedResult(runDir: string, taskId: string, attempt: number): Promise<V3ValidatedResult | undefined> {
	const raw = await readJson(v3NodeEvidencePaths(runDir, taskId, attempt).validatedResult);
	return raw === undefined ? undefined : validateV3ValidatedResult(raw);
}

export function validateV3ValidatedResult(value: unknown): V3ValidatedResult {
	if (!isRecord(value)) graphV3Error("INVALID_ATTEMPT", "V3 validated-result evidence must be an object.");
	if (value.schemaVersion !== V3_ATTEMPT_SCHEMA_VERSION) graphV3Error("INVALID_ATTEMPT", "V3 validated-result evidence requires schemaVersion 1.", { field: "schemaVersion" });
	if (!Array.isArray(value.validations) || typeof value.allPassed !== "boolean" || !Array.isArray(value.writes)) graphV3Error("INVALID_ATTEMPT", "V3 validated-result evidence is malformed.", { field: "validations" });
	return value as unknown as V3ValidatedResult;
}

export async function writeV3AcceptanceEvidence(runDir: string, taskId: string, attempt: number, evidence: V3AcceptanceEvidence): Promise<string> {
	return writeJson(v3NodeEvidencePaths(runDir, taskId, attempt).acceptance, evidence);
}

export async function readV3AcceptanceEvidence(runDir: string, taskId: string, attempt: number): Promise<V3AcceptanceEvidence | undefined> {
	const raw = await readJson(v3NodeEvidencePaths(runDir, taskId, attempt).acceptance);
	return raw === undefined ? undefined : validateV3AcceptanceEvidence(raw);
}

export function validateV3AcceptanceEvidence(value: unknown): V3AcceptanceEvidence {
	if (!isRecord(value)) graphV3Error("INVALID_ATTEMPT", "V3 acceptance evidence must be an object.");
	if (value.schemaVersion !== V3_ATTEMPT_SCHEMA_VERSION) graphV3Error("INVALID_ATTEMPT", "V3 acceptance evidence requires schemaVersion 1.", { field: "schemaVersion" });
	for (const field of ["runInstanceId", "graphId", "taskId", "method", "verified", "validatedResultDigest", "attemptDigest", "recordedAt", "supervisorEpoch"]) {
		if (!(field in value)) graphV3Error("INVALID_ATTEMPT", `V3 acceptance evidence is missing '${field}'.`, { field });
	}
	if (typeof value.method !== "string" || !["declared", "machine-verified", "child-acceptance"].includes(value.method)) graphV3Error("INVALID_ATTEMPT", "V3 acceptance method is invalid.", { field: "method" });
	return value as unknown as V3AcceptanceEvidence;
}

export function v3AttemptEvidenceDigest(evidence: V3AttemptEvidence): string {
	return canonicalDigest(evidence);
}
