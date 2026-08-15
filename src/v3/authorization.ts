import { compileGraphSpecV3 } from "./compiler.ts";
import { canonicalDigest, canonicalJson } from "./digests.ts";
import { GraphV3Error, graphV3Error } from "./errors.ts";
import type { AuthorizationV4, CompiledGraphProjectionV3, CompiledGraphV3 } from "./types.ts";

const AUTHORIZATION_FIELDS = new Set([
	"schemaVersion", "runtimeSchemaVersion", "sourceGraphSpecDigest", "graphDigest", "runInstanceId", "sessionId", "supervisorEpoch", "createdAt", "graph",
]);
const GRAPH_FIELDS = new Set(["schemaVersion", "graphId", "goal", "nodes", "topologicalOrder", "maxConcurrency", "failFast", "workspace"]);
const FORBIDDEN_AUTHORIZATION_FIELDS = new Set([
	"planningReceipt", "planningReceiptDigest", "planningBindingDigest", "planningAdmissionId", "routingDecision", "routingProfile", "model", "thinking",
	"resolvedModel", "modelFamily", "providerDomain", "attemptedModels", "modelCandidates", "evidenceComplete",
]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectForbiddenFields(value: unknown, path = "$", seen = new Set<object>()): void {
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value)) graphV3Error("INVALID_AUTHORIZATION", `Authorization contains a cyclic value at ${path}.`);
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			value.forEach((entry, index) => rejectForbiddenFields(entry, `${path}[${index}]`, seen));
			return;
		}
		for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
			if (FORBIDDEN_AUTHORIZATION_FIELDS.has(field)) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 must not contain '${field}'.`, { field, details: { path } });
			rejectForbiddenFields(entry, `${path}.${field}`, seen);
		}
	} finally {
		seen.delete(value);
	}
}

function requireString(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 field '${field}' must be a non-empty string.`, { field });
	return value;
}

function requireDigest(record: Record<string, unknown>, field: string): string {
	const value = requireString(record, field);
	if (!DIGEST_PATTERN.test(value)) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 field '${field}' must be a lowercase SHA-256 digest.`, { field });
	return value;
}

export function compiledGraphProjectionV3(graph: CompiledGraphV3): CompiledGraphProjectionV3 {
	return {
		schemaVersion: graph.schemaVersion,
		graphId: graph.graphId,
		goal: graph.goal,
		nodes: graph.nodes,
		topologicalOrder: graph.topologicalOrder,
		maxConcurrency: graph.maxConcurrency,
		failFast: graph.failFast,
		workspace: graph.workspace,
	};
}

export interface AuthorizationV4Metadata {
	runInstanceId: string;
	sessionId: string;
	supervisorEpoch: string;
	createdAt: string;
}

export function authorizationV4For(graph: CompiledGraphV3, metadata: AuthorizationV4Metadata): AuthorizationV4 {
	const projection = compiledGraphProjectionV3(graph);
	if (canonicalDigest(projection) !== graph.graphDigest) graphV3Error("INVALID_AUTHORIZATION", "Compiled graph digest does not match its projection.", { field: "graphDigest" });
	return validateAuthorizationV4({
		schemaVersion: 4,
		runtimeSchemaVersion: 3,
		sourceGraphSpecDigest: graph.sourceGraphSpecDigest,
		graphDigest: graph.graphDigest,
		runInstanceId: metadata.runInstanceId,
		sessionId: metadata.sessionId,
		supervisorEpoch: metadata.supervisorEpoch,
		createdAt: metadata.createdAt,
		graph: projection,
	});
}

export function validateAuthorizationV4(value: unknown): AuthorizationV4 {
	rejectForbiddenFields(value);
	if (!isRecord(value)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 must be an object.");
	for (const field of Object.keys(value)) {
		if (!AUTHORIZATION_FIELDS.has(field)) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 contains unknown field '${field}'.`, { field });
	}
	if (value.schemaVersion !== 4) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 requires schemaVersion: 4.", { field: "schemaVersion" });
	if (value.runtimeSchemaVersion !== 3) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 requires runtimeSchemaVersion: 3.", { field: "runtimeSchemaVersion" });
	const sourceGraphSpecDigest = requireDigest(value, "sourceGraphSpecDigest");
	const graphDigest = requireDigest(value, "graphDigest");
	const runInstanceId = requireString(value, "runInstanceId");
	const sessionId = requireString(value, "sessionId");
	const supervisorEpoch = requireString(value, "supervisorEpoch");
	const createdAt = requireString(value, "createdAt");
	if (Number.isNaN(Date.parse(createdAt))) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 createdAt must be an ISO-8601 timestamp.", { field: "createdAt" });
	if (!isRecord(value.graph)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 graph must be a compiled graph projection.", { field: "graph" });
	for (const field of Object.keys(value.graph)) {
		if (!GRAPH_FIELDS.has(field)) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 graph contains unknown field '${field}'.`, { field, details: { path: "$.graph" } });
	}
	if (!Array.isArray(value.graph.topologicalOrder)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 graph.topologicalOrder must be an array.", { field: "topologicalOrder" });
	const { topologicalOrder, ...sourceSpec } = value.graph;
	let recompiled: CompiledGraphV3;
	try {
		recompiled = compileGraphSpecV3(sourceSpec);
	} catch (error) {
		throw new GraphV3Error("INVALID_AUTHORIZATION", `Authorization V4 contains an invalid compiled graph: ${error instanceof Error ? error.message : String(error)}`, { field: "graph", cause: error });
	}
	const projection = compiledGraphProjectionV3(recompiled);
	if (canonicalJson(projection) !== canonicalJson(value.graph)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 graph is not the canonical compiler projection.", { field: "graph" });
	if (canonicalDigest(value.graph) !== graphDigest) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 graphDigest does not match its graph projection.", { field: "graphDigest" });
	return {
		schemaVersion: 4,
		runtimeSchemaVersion: 3,
		sourceGraphSpecDigest,
		graphDigest,
		runInstanceId,
		sessionId,
		supervisorEpoch,
		createdAt,
		graph: value.graph as unknown as CompiledGraphProjectionV3,
	};
}
