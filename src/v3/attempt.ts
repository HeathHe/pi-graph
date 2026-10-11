import { verifyEvidenceFiles } from "./evidence-files.ts";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteJson } from "./durable.ts";
import { canonicalDigest, canonicalJson } from "./digests.ts";
import { graphV3Error } from "./errors.ts";
import { validateV3ChildObservation } from "./observability.ts";
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
	controlPath: string;
	leasePath: string;
	artifactsDir: string;
	shadowDir: string;
	nodesDir: string;
	sessionsDir: string;
}

/** Absolute lifetime cap across automatic retries and explicit future retry APIs. */
export const V3_MAX_ATTEMPTS_PER_NODE = 100;

export function v3RunPaths(runDir: string): V3RunPaths {
	const root = resolve(runDir);
	return {
		runDir: root,
		authorizationPath: join(root, "authorization.json"),
		snapshotPath: join(root, "snapshot.json"),
		eventsPath: join(root, "events.jsonl"),
		eventsTruncatedPath: join(root, "events.truncated.json"),
		controlPath: join(root, "control.json"),
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
	"routeSelection", "fallbackContinuation", "deadlineAt", "dispatchIntent", "dispatch", "observation", "child", "verification", "applied", "failure", "terminalStatus", "workspaceDigest", "acceptanceDigest", "evidenceManifestDigest",
]);
const PHASES = new Set<V3NodePhase>(["queued", "prepared", "dispatched", "running", "verifying", "applying", "accepted", "failed", "aborted", "needs_attention"]);
const TERMINALS = new Set<V3NodeTerminal>(["accepted", "failed", "aborted", "needs_attention"]);
const FAILURE_KINDS = new Set<V3FailureKind>(["task_failed", "validation", "timeout", "workspace_conflict", "usage_budget", "dispatch_unknown", "child_paused", "child_stopped", "internal"]);
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
	if(value.fullOutputDigest!==undefined && (typeof value.fullOutputDigest!=="string"||!/^[a-f0-9]{64}$/.test(value.fullOutputDigest)))graphV3Error("INVALID_ATTEMPT","Invalid full output digest");
 let observation: V3ChildOutcome["observation"];
	try {
		observation = value.observation === undefined ? undefined : validateV3ChildObservation(value.observation);
	} catch (error) {
		graphV3Error("INVALID_ATTEMPT", `V3 attempt child observation is invalid: ${error instanceof Error ? error.message : String(error)}`, { field: "child" });
	}
	return {
		terminal: value.terminal as V3ChildOutcome["terminal"],
		output: value.output,
        ...(value.fullOutputDigest===undefined?{}:{fullOutputDigest:value.fullOutputDigest as string}),
		completedAt: requireIso(value, "completedAt"),
		...(observation ? { observation } : {}),
	};
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
	if (typeof attemptValue !== "number" || !Number.isInteger(attemptValue) || attemptValue < 1 || attemptValue > V3_MAX_ATTEMPTS_PER_NODE) {
		graphV3Error("INVALID_ATTEMPT", `V3 attempt number must be an integer from 1 through ${V3_MAX_ATTEMPTS_PER_NODE}.`, { field: "attempt" });
	}
	const attemptNonce = requireString(value, "attemptNonce");
	if (typeof value.phase !== "string" || !PHASES.has(value.phase as V3NodePhase)) graphV3Error("INVALID_ATTEMPT", "V3 attempt phase is invalid.", { field: "phase" });
	if (value.terminalStatus !== undefined && (typeof value.terminalStatus !== "string" || !TERMINALS.has(value.terminalStatus as V3NodeTerminal))) graphV3Error("INVALID_ATTEMPT", "V3 attempt terminalStatus is invalid.", { field: "terminalStatus" });
	const phase = value.phase as V3NodePhase;
	const terminalStatus = value.terminalStatus as V3NodeTerminal | undefined;
	if (PHASE_IS_TERMINAL[phase] && terminalStatus === undefined) graphV3Error("INVALID_ATTEMPT", `V3 terminal phase '${phase}' requires terminalStatus.`, { field: "terminalStatus" });
	if (!PHASE_IS_TERMINAL[phase] && terminalStatus !== undefined) graphV3Error("INVALID_ATTEMPT", `V3 non-terminal phase '${phase}' must omit terminalStatus.`, { field: "terminalStatus" });
	const deadlineAt = value.deadlineAt === undefined ? undefined : requireIso(value, "deadlineAt");
	let dispatchIntent: V3AttemptEvidence["dispatchIntent"];
	if (value.dispatchIntent !== undefined) {
		if (!isRecord(value.dispatchIntent)) graphV3Error("INVALID_ATTEMPT", "V3 attempt dispatchIntent must be an object.", { field: "dispatchIntent" });
		const requestId = requireString(value.dispatchIntent, "requestId");
		if (!/^[^\r\n]{1,256}$/u.test(requestId)) graphV3Error("INVALID_ATTEMPT", "V3 dispatch requestId must be a single non-empty line of at most 256 characters.", { field: "dispatchIntent" });
		if (typeof value.dispatchIntent.requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.dispatchIntent.requestDigest)) graphV3Error("INVALID_ATTEMPT", "V3 dispatch intent requestDigest must be a SHA-256 digest.", { field: "dispatchIntent" });
		if (value.dispatchIntent.state !== "prepared" && value.dispatchIntent.state !== "emitting") graphV3Error("INVALID_ATTEMPT", "V3 dispatch intent state must be prepared or emitting.", { field: "dispatchIntent" });
		const emittedAt = value.dispatchIntent.emittedAt === undefined ? undefined : requireIso(value.dispatchIntent, "emittedAt");
		if (value.dispatchIntent.state === "prepared" && emittedAt !== undefined) graphV3Error("INVALID_ATTEMPT", "A prepared V3 dispatch intent must not contain emittedAt.", { field: "dispatchIntent" });
		if (value.dispatchIntent.state === "emitting" && emittedAt === undefined) graphV3Error("INVALID_ATTEMPT", "An emitting V3 dispatch intent requires emittedAt.", { field: "dispatchIntent" });
		dispatchIntent = {
			requestId,
			requestDigest: value.dispatchIntent.requestDigest,
			state: value.dispatchIntent.state,
			preparedAt: requireIso(value.dispatchIntent, "preparedAt"),
			...(emittedAt ? { emittedAt } : {}),
		};
	}
	let dispatch: V3AttemptEvidence["dispatch"];
	if (value.dispatch !== undefined) {
		if (!isRecord(value.dispatch)) graphV3Error("INVALID_ATTEMPT", "V3 attempt dispatch must be an object.", { field: "dispatch" });
		if (typeof value.dispatch.asyncId !== "string" || typeof value.dispatch.asyncDir !== "string") graphV3Error("INVALID_ATTEMPT", "V3 attempt dispatch requires asyncId and asyncDir.", { field: "dispatch" });
		if (typeof value.dispatch.requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.dispatch.requestDigest)) graphV3Error("INVALID_ATTEMPT", "V3 attempt dispatch requestDigest must be a SHA-256 digest.", { field: "dispatch" });
		let observation;
		try {
			observation = value.dispatch.observation === undefined ? undefined : validateV3ChildObservation(value.dispatch.observation);
		} catch (error) {
			graphV3Error("INVALID_ATTEMPT", `V3 dispatch observation is invalid: ${error instanceof Error ? error.message : String(error)}`, { field: "dispatch" });
		}
		if (observation && observation.asyncId !== value.dispatch.asyncId) graphV3Error("INVALID_ATTEMPT", "V3 dispatch observation identity does not match asyncId.", { field: "dispatch" });
		dispatch = {
			asyncId: value.dispatch.asyncId,
			asyncDir: value.dispatch.asyncDir,
			requestDigest: value.dispatch.requestDigest,
			dispatchedAt: requireIso(value.dispatch, "dispatchedAt"),
			...(observation ? { observation } : {}),
		};
	}
	if (dispatch && dispatchIntent && dispatch.requestDigest !== dispatchIntent.requestDigest) graphV3Error("INVALID_ATTEMPT", "V3 dispatch binding does not match its durable request intent.", { field: "dispatch" });
	let observation: V3AttemptEvidence["observation"];
	try {
		observation = value.observation === undefined ? undefined : validateV3ChildObservation(value.observation);
	} catch (error) {
		graphV3Error("INVALID_ATTEMPT", `V3 attempt observation is invalid: ${error instanceof Error ? error.message : String(error)}`, { field: "observation" });
	}
	if (observation && dispatch && observation.asyncId !== dispatch.asyncId) graphV3Error("INVALID_ATTEMPT", "V3 attempt observation identity does not match dispatch asyncId.", { field: "observation" });
	const child = validateChildOutcome(value.child);
	if (child?.observation && dispatch && child.observation.asyncId !== dispatch.asyncId) graphV3Error("INVALID_ATTEMPT", "V3 child observation identity does not match dispatch asyncId.", { field: "child" });
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
	const evidenceManifestDigest = optionalDigest(value.evidenceManifestDigest, "evidenceManifestDigest");
    const routeSelection = value.routeSelection as V3AttemptEvidence["routeSelection"];
    const fallbackContinuation = value.fallbackContinuation as V3AttemptEvidence["fallbackContinuation"];
    for (const selection of [routeSelection, fallbackContinuation]) {
        if (selection !== undefined && (!isRecord(selection) || !Number.isSafeInteger(selection.candidateIndex) || selection.candidateIndex < 0 || selection.candidateIndex > 8
            || typeof selection.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(selection.planDigest))) graphV3Error("INVALID_ATTEMPT", "Invalid runtime route selection.");
    }
    if (fallbackContinuation && (fallbackContinuation.fromAttempt !== attemptValue || !/^[a-f0-9]{64}$/.test(fallbackContinuation.proofDigest)
        || !["quota", "auth", "model", "provider"].includes(fallbackContinuation.failureKind))) graphV3Error("INVALID_ATTEMPT", "Invalid fallback continuation.");
	const result: V3AttemptEvidence = {
        ...(routeSelection ? {routeSelection} : {}), ...(fallbackContinuation ? {fallbackContinuation} : {}),
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
		...(deadlineAt ? { deadlineAt } : {}),
		...(dispatchIntent ? { dispatchIntent } : {}),
		...(dispatch ? { dispatch } : {}),
		...(observation ? { observation } : {}),
		...(child ? { child } : {}),
		...(verification ? { verification } : {}),
		...(applied ? { applied } : {}),
		...(failure ? { failure } : {}),
		...(terminalStatus ? { terminalStatus } : {}),
		...(workspaceDigest ? { workspaceDigest } : {}),
		...(acceptanceDigest ? { acceptanceDigest } : {}),
		...(evidenceManifestDigest ? { evidenceManifestDigest } : {}),
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
	if (value.workspaceKind !== "shadow") graphV3Error("INVALID_ATTEMPT", "V3 workspace kind must be shadow.", { field: "workspaceKind" });
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
	if (typeof value.method !== "string" || !["declared", "machine-verified"].includes(value.method)) graphV3Error("INVALID_ATTEMPT", "V3 acceptance method is invalid.", { field: "method" });
	return value as unknown as V3AcceptanceEvidence;
}

export function v3AttemptEvidenceDigest(evidence: V3AttemptEvidence): string {
	return canonicalDigest(evidence);
}

/**
 * Acceptance cannot directly hash the final Attempt because that Attempt also
 * stores the acceptance digest. The stable basis is therefore the exact final
 * Attempt with only `acceptanceDigest` omitted.
 */
export function v3AcceptedAttemptBasis(evidence: V3AttemptEvidence): V3AttemptEvidence {
	const { acceptanceDigest: _acceptanceDigest, observation: _observation, child, dispatch, ...basis } = evidence;
	return {
		...basis,
		...(dispatch ? {
			dispatch: {
				asyncId: dispatch.asyncId,
				asyncDir: dispatch.asyncDir,
				requestDigest: dispatch.requestDigest,
				dispatchedAt: dispatch.dispatchedAt,
			},
		} : {}),
		...(child ? {
			child: {
				terminal: child.terminal,
				output: child.output,
                ...(child.fullOutputDigest===undefined?{}:{fullOutputDigest:child.fullOutputDigest}),
				completedAt: child.completedAt,
			},
		} : {}),
	};
}

export interface V3AcceptedAttemptChainExpectations {
	runInstanceId?: string;
	graphId?: string;
	method?: V3AcceptanceEvidence["method"];
}

export interface V3AcceptedAttemptChainVerification {
	ok: boolean;
	reasons: string[];
	attempt?: V3AttemptEvidence;
	workspace?: V3WorkspaceEvidence;
	validatedResult?: V3ValidatedResult;
	acceptance?: V3AcceptanceEvidence;
	artifactPath: string;
	artifactContents?: string;
}

interface StableFileRead {
	contents: string;
}

function sameFileIdentity(
	left: { dev: number; ino: number },
	right: { dev: number; ino: number },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/** Read an immutable artifact without following a link or accepting a read race. */
async function readStableSingleFile(path: string): Promise<StableFileRead> {
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
		throw new Error("must be a single regular non-symbolic-link file");
	}
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(before, opened)) {
			throw new Error("changed identity while being opened");
		}
		const contents = await handle.readFile("utf8");
		const [finished, current] = await Promise.all([handle.stat(), lstat(path)]);
		if (!sameFileIdentity(opened, finished)
			|| !sameFileIdentity(opened, current)
			|| finished.nlink !== 1
			|| current.nlink !== 1
			|| finished.size !== opened.size
			|| finished.mtimeMs !== opened.mtimeMs) {
			throw new Error("changed while being read");
		}
		return { contents };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function pushIdentityReasons(
	reasons: string[],
	label: string,
	value: { runInstanceId: string; graphId: string; taskId: string; attempt: number },
	expected: { runInstanceId: string; graphId: string; taskId: string; attempt: number },
): void {
	for (const field of ["runInstanceId", "graphId", "taskId", "attempt"] as const) {
		if (value[field] !== expected[field]) reasons.push(`${label.toUpperCase()}_IDENTITY_MISMATCH: ${label}.${field} does not match the accepted Attempt.`);
	}
}

/**
 * Rebuild and verify every durable link required to trust an accepted Attempt.
 * This intentionally ignores the mutable `artifacts/<taskId>.txt` convenience
 * alias; downstream execution must consume the immutable Attempt artifact.
 */
export async function verifyV3AcceptedAttemptChain(
	runDir: string,
	taskId: string,
	attemptNumber: number,
	expectations: V3AcceptedAttemptChainExpectations = {},
): Promise<V3AcceptedAttemptChainVerification> {
	const artifactPath = join(v3RunPaths(runDir).artifactsDir, taskId, `attempt-${attemptNumber}.txt`);
	const reasons: string[] = [];
	let attempt: V3AttemptEvidence | undefined;
	let workspace: V3WorkspaceEvidence | undefined;
	let validatedResult: V3ValidatedResult | undefined;
	let acceptance: V3AcceptanceEvidence | undefined;
	let artifactContents: string | undefined;

	try {
		attempt = await readV3AttemptEvidence(runDir, taskId, attemptNumber);
	} catch (error) {
		reasons.push(`INVALID_ATTEMPT: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!attempt) reasons.push("MISSING_ATTEMPT: accepted Attempt evidence is missing.");
	if (attempt) {
		if (attempt.phase !== "accepted" || attempt.terminalStatus !== "accepted") reasons.push("ATTEMPT_NOT_ACCEPTED: Attempt is not durably terminal accepted.");
		if (attempt.failure !== undefined) reasons.push("ATTEMPT_FAILURE_CONFLICT: an accepted Attempt must not retain failure evidence.");
		if (attempt.child?.terminal !== "complete") reasons.push("CHILD_NOT_COMPLETE: an accepted Attempt requires a complete Child outcome.");
		if (!attempt.workspaceDigest) reasons.push("MISSING_WORKSPACE_DIGEST: accepted Attempt does not bind workspace.json.");
		if (!attempt.acceptanceDigest) reasons.push("MISSING_ACCEPTANCE_DIGEST: accepted Attempt does not bind acceptance.json.");
		if (expectations.runInstanceId !== undefined && attempt.runInstanceId !== expectations.runInstanceId) reasons.push("RUN_IDENTITY_MISMATCH: Attempt belongs to a different runInstanceId.");
		if (expectations.graphId !== undefined && attempt.graphId !== expectations.graphId) reasons.push("GRAPH_IDENTITY_MISMATCH: Attempt belongs to a different graphId.");
		if (attempt.taskId !== taskId || attempt.attempt !== attemptNumber) reasons.push("ATTEMPT_IDENTITY_MISMATCH: Attempt path and payload identity disagree.");
	}

	try {
		workspace = await readV3WorkspaceEvidence(runDir, taskId, attemptNumber);
	} catch (error) {
		reasons.push(`INVALID_WORKSPACE: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!workspace) reasons.push("MISSING_WORKSPACE: workspace.json is missing.");

	try {
		acceptance = await readV3AcceptanceEvidence(runDir, taskId, attemptNumber);
	} catch (error) {
		reasons.push(`INVALID_ACCEPTANCE: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!acceptance) reasons.push("MISSING_ACCEPTANCE: acceptance.json is missing.");

	if (attempt && workspace) {
		pushIdentityReasons(reasons, "workspace", workspace, attempt);
		if (canonicalDigest(workspace) !== attempt.workspaceDigest) reasons.push("WORKSPACE_DIGEST_MISMATCH: workspace.json no longer matches the digest bound by Attempt.");
	}
	if (attempt && acceptance) {
		pushIdentityReasons(reasons, "acceptance", acceptance, attempt);
		if (canonicalDigest(acceptance) !== attempt.acceptanceDigest) reasons.push("ACCEPTANCE_DIGEST_MISMATCH: acceptance.json no longer matches the digest bound by Attempt.");
		if (canonicalDigest(v3AcceptedAttemptBasis(attempt)) !== acceptance.attemptDigest) reasons.push("ATTEMPT_DIGEST_MISMATCH: acceptance.json does not bind the final accepted Attempt basis.");
		if (acceptance.supervisorEpoch !== attempt.supervisorEpoch) reasons.push("SUPERVISOR_EPOCH_MISMATCH: acceptance and Attempt were not published by the same Supervisor epoch.");
		if (expectations.method !== undefined && acceptance.method !== expectations.method) reasons.push("ACCEPTANCE_METHOD_MISMATCH: acceptance method does not match the compiled node side effect.");

		if (acceptance.method === "machine-verified") {
			if (!acceptance.verified) reasons.push("ACCEPTANCE_NOT_VERIFIED: machine verification must be recorded as verified.");
			if (!attempt.verification?.allPassed) reasons.push("VERIFICATION_NOT_PASSED: machine-verified acceptance requires a passing Attempt verification.");
			if (!attempt.applied) reasons.push("MISSING_APPLY_EVIDENCE: machine-verified acceptance requires durable apply evidence.");
			try {
				validatedResult = await readV3ValidatedResult(runDir, taskId, attemptNumber);
			} catch (error) {
				reasons.push(`INVALID_VALIDATED_RESULT: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!validatedResult) {
				reasons.push("MISSING_VALIDATED_RESULT: machine-verified acceptance requires validated-result.json.");
			} else {
				pushIdentityReasons(reasons, "validated-result", validatedResult, attempt);
				const validatedDigest = canonicalDigest(validatedResult);
				if (validatedDigest !== attempt.verification?.validatedResultDigest
					|| validatedDigest !== acceptance.validatedResultDigest) {
					reasons.push("VALIDATED_RESULT_DIGEST_MISMATCH: validated-result.json is not bound by both Attempt and acceptance.");
				}
				if (!validatedResult.allPassed) reasons.push("VALIDATED_RESULT_FAILED: accepted validation evidence contains a failed command.");
				if (attempt.applied && canonicalJson(attempt.applied.writes) !== canonicalJson(validatedResult.writes)) {
					reasons.push("APPLIED_WRITES_MISMATCH: applied writes do not match the machine-validated workspace writes.");
				}
			}
		} else {
			if (acceptance.verified) reasons.push("DECLARED_ACCEPTANCE_VERIFIED: declared acceptance must not claim machine verification.");
			if (acceptance.validatedResultDigest !== "") reasons.push("UNEXPECTED_VALIDATED_RESULT: declared acceptance must not bind machine-validation evidence.");
			if (attempt.verification !== undefined || attempt.applied !== undefined) reasons.push("UNEXPECTED_MACHINE_EVIDENCE: declared acceptance carries machine-only evidence.");
		}
	}

	try {
		artifactContents = (await readStableSingleFile(artifactPath)).contents;
	} catch (error) {
		reasons.push(`INVALID_ARTIFACT: immutable Attempt artifact ${error instanceof Error ? error.message : String(error)}.`);
	}
	if (attempt?.child && acceptance && artifactContents !== undefined) {
		const expectedContents = acceptance.method === "machine-verified"
			? JSON.stringify({ taskId, output: attempt.child.output })
			: attempt.child.output;
		if (artifactContents !== expectedContents) reasons.push("ARTIFACT_CONTENT_MISMATCH: immutable Attempt artifact does not match the accepted Child output.");
	}

    if (attempt?.evidenceManifestDigest) {
        try { await verifyEvidenceFiles(runDir, taskId, attemptNumber, attempt.evidenceManifestDigest); }
        catch (error) { reasons.push(`INVALID_EVIDENCE_FILES: ${String(error)}`); }
    }
	return {
		ok: reasons.length === 0,
		reasons,
		...(attempt ? { attempt } : {}),
		...(workspace ? { workspace } : {}),
		...(validatedResult ? { validatedResult } : {}),
		...(acceptance ? { acceptance } : {}),
		artifactPath,
		...(artifactContents === undefined ? {} : { artifactContents }),
	};
}
