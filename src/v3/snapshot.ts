import { validateAuthorizationV4 } from "./authorization.ts";
import { canonicalJson } from "./digests.ts";
import { GraphV3Error, graphV3Error } from "./errors.ts";
import type { AuthorizationV4, CompiledGraphV3, GraphRuntimeStatusV3, GraphSnapshotV3, SourceIdentityV3, V3RunVerification } from "./types.ts";

const SNAPSHOT_FIELDS = new Set([
	"schemaVersion", "runInstanceId", "graphId", "graphDigest", "sourceGraphSpecDigest", "status", "sessionId", "supervisorEpoch", "createdAt", "updatedAt",
]);
const STATUSES = new Set<GraphRuntimeStatusV3>(["queued", "running", "complete", "failed", "stopped", "paused", "waiting_input", "needs_attention"]);
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
