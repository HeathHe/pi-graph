import { validateAuthorizationV4 } from "./authorization.ts";
import { canonicalJson } from "./digests.ts";
import { GraphV3Error, graphV3Error } from "./errors.ts";
import { validateV3ChildObservation } from "./observability.ts";
import type { AuthorizationV4, CompiledGraphV3, GraphRuntimeStatusV3, GraphSnapshotV3, SourceIdentityV3, V3NodeProjection, V3NodeProjectionPhase, V3NodeProjectionTerminal, V3RunVerification } from "./types.ts";

const SNAPSHOT_FIELDS = new Set([
	"schemaVersion", "runInstanceId", "graphId", "graphDigest", "sourceGraphSpecDigest", "status", "sessionId", "supervisorEpoch", "createdAt", "updatedAt", "topology", "revision", "sealed", "nodes",
]);
const NODE_PROJECTION_FIELDS = new Set(["modelFallback", "phase", "attempt", "terminalStatus", "agent", "dependsOn", "observation"]);
const NODE_PHASES = new Set<V3NodeProjectionPhase>(["queued", "prepared", "dispatched", "running", "verifying", "applying", "accepted", "failed", "aborted", "needs_attention", "skipped", "blocked", "cancelled"]);
const NODE_TERMINALS = new Set<V3NodeProjectionTerminal>(["accepted", "failed", "aborted", "needs_attention", "skipped", "blocked", "cancelled"]);

function validateNodeProjections(nodes: unknown): Record<string, V3NodeProjection> | undefined {
	if (nodes === undefined) return undefined;
	if (typeof nodes !== "object" || nodes === null || Array.isArray(nodes)) graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 nodes projection must be an object.", { field: "nodes" });
	const output: Record<string, V3NodeProjection> = {};
	for (const [taskId, rawProjection] of Object.entries(nodes as Record<string, unknown>)) {
		if (typeof rawProjection !== "object" || rawProjection === null || Array.isArray(rawProjection)) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 node projection for '${taskId}' must be an object.`, { field: "nodes", details: { taskId } });
		const projection = rawProjection as Record<string, unknown>;
		for (const field of Object.keys(projection)) {
			if (!NODE_PROJECTION_FIELDS.has(field)) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 node projection '${taskId}' contains unknown field '${field}'.`, { field: "nodes", details: { taskId } });
		}
		if (typeof projection.phase !== "string" || !NODE_PHASES.has(projection.phase as V3NodeProjectionPhase)) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 node projection '${taskId}' has an invalid phase.`, { field: "nodes", details: { taskId } });
		if (typeof projection.attempt !== "number" || !Number.isInteger(projection.attempt) || (projection.attempt as number) < 0) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 node projection '${taskId}' has an invalid attempt.`, { field: "nodes", details: { taskId } });
		if (projection.terminalStatus !== undefined && (typeof projection.terminalStatus !== "string" || !NODE_TERMINALS.has(projection.terminalStatus as V3NodeProjectionTerminal))) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 node projection '${taskId}' has an invalid terminalStatus.`, { field: "nodes", details: { taskId } });
		if (projection.agent !== undefined && (typeof projection.agent !== "string" || projection.agent.length === 0 || projection.agent.length > 200)) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 node projection '${taskId}' has an invalid agent.`, { field: "nodes", details: { taskId } });
		if (projection.dependsOn !== undefined && (!Array.isArray(projection.dependsOn) || projection.dependsOn.some((entry) => typeof entry !== "string" || entry.length === 0) || new Set(projection.dependsOn).size !== projection.dependsOn.length)) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 node projection '${taskId}' has invalid dependencies.`, { field: "nodes", details: { taskId } });
        const fallback = projection.modelFallback as V3NodeProjection["modelFallback"];
        if (fallback !== undefined && (!fallback || typeof fallback !== "object" || [fallback.from, fallback.to, fallback.reason].some(v => typeof v !== "string" || !v || v.length > 500))) graphV3Error("INVALID_SNAPSHOT", "Invalid model fallback display.");
		let observation: V3NodeProjection["observation"];
		try {
			observation = projection.observation === undefined ? undefined : validateV3ChildObservation(projection.observation);
		} catch (error) {
			graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 node projection '${taskId}' has an invalid child observation: ${error instanceof Error ? error.message : String(error)}`, { field: "nodes", details: { taskId } });
		}
		output[taskId] = {
			phase: projection.phase as V3NodeProjectionPhase,
			attempt: projection.attempt as number,
			...(projection.terminalStatus === undefined ? {} : { terminalStatus: projection.terminalStatus as V3NodeProjectionTerminal }),
			...(projection.agent === undefined ? {} : { agent: projection.agent as string }),
			...(projection.dependsOn === undefined ? {} : { dependsOn: [...projection.dependsOn] as string[] }),
			...(observation ? { observation } : {}),
            ...(fallback ? {modelFallback:{...fallback}} : {}),
		};
	}
	return output;
}
const STATUSES = new Set<GraphRuntimeStatusV3>(["queued", "running", "idle", "stopping", "complete", "failed", "stopped", "paused", "waiting_input", "needs_attention"]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 field '${field}' must be a non-empty string.`, { field });
	return value;
}

function requireDigest(record: Record<string, unknown>, field: string): string {
	const value = requireString(record, field);
	if (!DIGEST_PATTERN.test(value)) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 field '${field}' must be a lowercase SHA-256 digest.`, { field });
	return value;
}

export interface SnapshotV3Metadata {
	runInstanceId: string;
	sessionId: string;
	supervisorEpoch: string;
	createdAt: string;
	updatedAt?: string;
}

export function graphSnapshotV3For(graph: CompiledGraphV3, metadata: SnapshotV3Metadata): GraphSnapshotV3 {
	return validateGraphSnapshotV3({
		schemaVersion: 3,
		runInstanceId: metadata.runInstanceId,
		graphId: graph.graphId,
		graphDigest: graph.graphDigest,
		sourceGraphSpecDigest: graph.sourceGraphSpecDigest,
		status: "queued",
		sessionId: metadata.sessionId,
		supervisorEpoch: metadata.supervisorEpoch,
		createdAt: metadata.createdAt,
		updatedAt: metadata.updatedAt ?? metadata.createdAt,
	});
}

export function validateGraphSnapshotV3(value: unknown): GraphSnapshotV3 {
	if (!isRecord(value)) graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 must be an object.");
	for (const field of Object.keys(value)) {
		if (!SNAPSHOT_FIELDS.has(field)) graphV3Error("INVALID_SNAPSHOT", `Snapshot V3 contains unknown field '${field}'.`, { field });
	}
	if (value.schemaVersion !== 3) graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 requires schemaVersion: 3.", { field: "schemaVersion" });
	const runInstanceId = requireString(value, "runInstanceId");
	const graphId = requireString(value, "graphId");
	const graphDigest = requireDigest(value, "graphDigest");
	const sourceGraphSpecDigest = requireDigest(value, "sourceGraphSpecDigest");
	if (typeof value.status !== "string" || !STATUSES.has(value.status as GraphRuntimeStatusV3)) graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 contains an invalid status.", { field: "status" });
	const sessionId = requireString(value, "sessionId");
	const supervisorEpoch = requireString(value, "supervisorEpoch");
	const createdAt = requireString(value, "createdAt");
	const updatedAt = requireString(value, "updatedAt");
	if (Number.isNaN(Date.parse(createdAt))) graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 createdAt must be an ISO-8601 timestamp.", { field: "createdAt" });
	if (Number.isNaN(Date.parse(updatedAt))) graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 updatedAt must be an ISO-8601 timestamp.", { field: "updatedAt" });
	const nodes = validateNodeProjections(value.nodes);
	if (value.topology !== undefined && value.topology !== "open" && value.topology !== "sealed") graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 topology must be 'open' or 'sealed'.", { field: "topology" });
	if (value.revision !== undefined && (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0)) graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 revision must be a non-negative safe integer.", { field: "revision" });
	if (value.sealed !== undefined && typeof value.sealed !== "boolean") graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 sealed must be a boolean.", { field: "sealed" });
	if ((value.revision === undefined) !== (value.sealed === undefined) || (value.revision === undefined) !== (value.topology === undefined)) graphV3Error("INVALID_SNAPSHOT", "Snapshot V3 dynamic topology fields must be present together.");
	return {
		schemaVersion: 3,
		runInstanceId,
		graphId,
		graphDigest,
		sourceGraphSpecDigest,
		status: value.status as GraphRuntimeStatusV3,
		sessionId,
		supervisorEpoch,
		createdAt,
		updatedAt,
		...(value.topology === undefined ? {} : { topology: value.topology as "open" | "sealed", revision: value.revision as number, sealed: value.sealed as boolean }),
		...(nodes ? { nodes } : {}),
	};
}

export function verifyV3Run(snapshotValue: unknown, authorizationValue: unknown, observedSourceIdentity: SourceIdentityV3): V3RunVerification {
	const reasons: string[] = [];
	let snapshot: GraphSnapshotV3 | undefined;
	let authorization: AuthorizationV4 | undefined;
	try {
		snapshot = validateGraphSnapshotV3(snapshotValue);
	} catch (error) {
		reasons.push(error instanceof GraphV3Error ? `${error.code}: ${error.message}` : `INVALID_SNAPSHOT: ${String(error)}`);
	}
	try {
		authorization = validateAuthorizationV4(authorizationValue);
	} catch (error) {
		reasons.push(error instanceof GraphV3Error ? `${error.code}: ${error.message}` : `INVALID_AUTHORIZATION: ${String(error)}`);
	}
	if (snapshot && authorization) {
		if (snapshot.status !== "queued") reasons.push("STATUS_MISMATCH: a V3 admission without attempt evidence must remain queued.");
		if (snapshot.updatedAt !== snapshot.createdAt) reasons.push("UPDATED_AT_MISMATCH: a V3 admission without attempt evidence must retain its creation timestamp.");
		if (snapshot.nodes !== undefined && Object.keys(snapshot.nodes).length > 0) reasons.push("NODES_MISMATCH: a V3 admission without attempt evidence must carry an empty nodes projection.");
		const comparisons: Array<[string, string, string]> = [
			["runInstanceId", snapshot.runInstanceId, authorization.runInstanceId],
			["graphId", snapshot.graphId, authorization.graph.graphId],
			["graphDigest", snapshot.graphDigest, authorization.graphDigest],
			["sourceGraphSpecDigest", snapshot.sourceGraphSpecDigest, authorization.sourceGraphSpecDigest],
			["sessionId", snapshot.sessionId, authorization.sessionId],
			["supervisorEpoch", snapshot.supervisorEpoch, authorization.supervisorEpoch],
			["createdAt", snapshot.createdAt, authorization.createdAt],
		];
		for (const [field, snapshotField, authorizationField] of comparisons) {
			if (snapshotField !== authorizationField) reasons.push(`IDENTITY_MISMATCH: snapshot.${field} does not match authorization.${field}.`);
		}
		if (authorization.sourceCwd !== observedSourceIdentity.sourceCwd) reasons.push("SOURCE_IDENTITY_MISMATCH: current sourceCwd does not match the admitted sourceCwd.");
		if (canonicalJson(authorization.sourceRepository) !== canonicalJson(observedSourceIdentity.sourceRepository)) reasons.push("SOURCE_IDENTITY_MISMATCH: current repository identity does not match the admitted repository identity.");
	}
	return {
		ok: reasons.length === 0,
		reasons,
		...(snapshot ? { snapshot } : {}),
		...(authorization ? { authorization } : {}),
	};
}
