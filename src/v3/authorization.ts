import { isAbsolute, relative, resolve, sep } from "node:path";
import { compileGraphSpecV3 } from "./compiler.ts";
import { canonicalDigest, canonicalJson } from "./digests.ts";
import { GraphV3Error, graphV3Error } from "./errors.ts";
import type { AuthorizationV4, CompiledGraphProjectionV3, CompiledGraphV3, SourceIdentityV3, SourceRepositoryIdentityV3 } from "./types.ts";

const AUTHORIZATION_FIELDS = new Set([
	"schemaVersion", "runtimeSchemaVersion", "sourceGraphSpec", "sourceGraphSpecDigest", "sourceCwd", "sourceRepository", "graphDigest", "runInstanceId", "sessionId", "supervisorEpoch", "createdAt", "graph",
]);
const GRAPH_FIELDS = new Set(["schemaVersion", "graphId", "goal", "nodes", "topologicalOrder", "maxConcurrency", "failFast", "workspace", "bindingPolicy"]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const FILE_SYSTEM_ID_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function requireCanonicalAbsolutePath(record: Record<string, unknown>, field: string): string {
	const value = requireString(record, field);
	if (!isAbsolute(value) || resolve(value) !== value) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 field '${field}' must be a normalized absolute path.`, { field });
	return value;
}

function requireFileSystemId(record: Record<string, unknown>, field: string): string {
	const value = requireString(record, field);
	if (!FILE_SYSTEM_ID_PATTERN.test(value)) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 sourceRepository.${field} must be a decimal file-system identity.`, { field });
	return value;
}

function validateSourceRepository(value: unknown, sourceCwd: string): SourceRepositoryIdentityV3 {
	if (!isRecord(value)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 sourceRepository must be an object.", { field: "sourceRepository" });
	if (value.kind === "git") {
		for (const field of Object.keys(value)) {
			if (!["kind", "root", "gitDir", "device", "inode"].includes(field)) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 sourceRepository contains unknown field '${field}'.`, { field });
		}
		const root = requireCanonicalAbsolutePath(value, "root");
		const gitDir = requireCanonicalAbsolutePath(value, "gitDir");
		const device = requireFileSystemId(value, "device");
		const inode = requireFileSystemId(value, "inode");
		const pathFromRoot = relative(root, sourceCwd);
		if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 sourceCwd must be inside sourceRepository.root.", { field: "sourceCwd" });
		return { kind: "git", root, gitDir, device, inode };
	}
	if (value.kind === "directory") {
		for (const field of Object.keys(value)) {
			if (!["kind", "root", "device", "inode"].includes(field)) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 sourceRepository contains unknown field '${field}'.`, { field });
		}
		const root = requireCanonicalAbsolutePath(value, "root");
		const device = requireFileSystemId(value, "device");
		const inode = requireFileSystemId(value, "inode");
		if (root !== sourceCwd) graphV3Error("INVALID_AUTHORIZATION", "Directory sourceRepository.root must equal sourceCwd.", { field: "sourceRepository" });
		return { kind: "directory", root, device, inode };
	}
	graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 sourceRepository.kind must be 'git' or 'directory'.", { field: "sourceRepository" });
}

export function compiledGraphProjectionV3(graph: CompiledGraphV3): CompiledGraphProjectionV3 {
	const projection: CompiledGraphProjectionV3 = {
		schemaVersion: graph.schemaVersion,
		graphId: graph.graphId,
		goal: graph.goal,
		nodes: graph.nodes,
		topologicalOrder: graph.topologicalOrder,
		maxConcurrency: graph.maxConcurrency,
		failFast: graph.failFast,
		workspace: graph.workspace,
		...(graph.bindingPolicy === "strict" ? { bindingPolicy: "strict" as const } : {}),
	};
	return JSON.parse(canonicalJson(projection)) as CompiledGraphProjectionV3;
}

export interface AuthorizationV4Metadata extends SourceIdentityV3 {
	runInstanceId: string;
	sessionId: string;
	supervisorEpoch: string;
	createdAt: string;
}

export function authorizationV4For(graph: CompiledGraphV3, metadata: AuthorizationV4Metadata): AuthorizationV4 {
	const projection = compiledGraphProjectionV3(graph);
	if (canonicalDigest(graph.sourceGraphSpec) !== graph.sourceGraphSpecDigest) graphV3Error("INVALID_AUTHORIZATION", "Compiled graph sourceGraphSpecDigest does not match its source GraphSpec material.", { field: "sourceGraphSpecDigest" });
	if (canonicalDigest(projection) !== graph.graphDigest) graphV3Error("INVALID_AUTHORIZATION", "Compiled graph digest does not match its projection.", { field: "graphDigest" });
	return validateAuthorizationV4({
		schemaVersion: 4,
		runtimeSchemaVersion: 3,
		sourceGraphSpec: graph.sourceGraphSpec,
		sourceGraphSpecDigest: graph.sourceGraphSpecDigest,
		sourceCwd: metadata.sourceCwd,
		sourceRepository: metadata.sourceRepository,
		graphDigest: graph.graphDigest,
		runInstanceId: metadata.runInstanceId,
		sessionId: metadata.sessionId,
		supervisorEpoch: metadata.supervisorEpoch,
		createdAt: metadata.createdAt,
		graph: projection,
	});
}

export function validateAuthorizationV4(value: unknown): AuthorizationV4 {
	if (!isRecord(value)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 must be an object.");
	for (const field of Object.keys(value)) {
		if (!AUTHORIZATION_FIELDS.has(field)) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 contains unknown field '${field}'.`, { field });
	}
	if (value.schemaVersion !== 4) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 requires schemaVersion: 4.", { field: "schemaVersion" });
	if (value.runtimeSchemaVersion !== 3) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 requires runtimeSchemaVersion: 3.", { field: "runtimeSchemaVersion" });
	const sourceGraphSpecDigest = requireDigest(value, "sourceGraphSpecDigest");
	const graphDigest = requireDigest(value, "graphDigest");
	const sourceCwd = requireCanonicalAbsolutePath(value, "sourceCwd");
	const sourceRepository = validateSourceRepository(value.sourceRepository, sourceCwd);
	const runInstanceId = requireString(value, "runInstanceId");
	const sessionId = requireString(value, "sessionId");
	const supervisorEpoch = requireString(value, "supervisorEpoch");
	const createdAt = requireString(value, "createdAt");
	if (Number.isNaN(Date.parse(createdAt))) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 createdAt must be an ISO-8601 timestamp.", { field: "createdAt" });
	if (!isRecord(value.sourceGraphSpec)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 sourceGraphSpec must contain the admitted source GraphSpec.", { field: "sourceGraphSpec" });
	let observedSourceDigest: string;
	try {
		observedSourceDigest = canonicalDigest(value.sourceGraphSpec);
	} catch (error) {
		throw new GraphV3Error("INVALID_AUTHORIZATION", `Authorization V4 sourceGraphSpec cannot be digested: ${error instanceof Error ? error.message : String(error)}`, { field: "sourceGraphSpec", cause: error });
	}
	if (observedSourceDigest !== sourceGraphSpecDigest) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 sourceGraphSpecDigest does not match the stored source GraphSpec material.", { field: "sourceGraphSpecDigest" });
	if (!isRecord(value.graph)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 graph must be a compiled graph projection.", { field: "graph" });
	for (const field of Object.keys(value.graph)) {
		if (!GRAPH_FIELDS.has(field)) graphV3Error("INVALID_AUTHORIZATION", `Authorization V4 graph contains unknown field '${field}'.`, { field, details: { path: "$.graph" } });
	}
	if (!Array.isArray(value.graph.topologicalOrder)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 graph.topologicalOrder must be an array.", { field: "topologicalOrder" });
	let recompiled: CompiledGraphV3;
	try {
		recompiled = compileGraphSpecV3(value.sourceGraphSpec, { historical: true });
	} catch (error) {
		throw new GraphV3Error("INVALID_AUTHORIZATION", `Authorization V4 contains an invalid source GraphSpec: ${error instanceof Error ? error.message : String(error)}`, { field: "sourceGraphSpec", cause: error });
	}
	if (recompiled.sourceGraphSpecDigest !== sourceGraphSpecDigest) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 source GraphSpec recompilation changed its digest.", { field: "sourceGraphSpecDigest" });
	const projection = compiledGraphProjectionV3(recompiled);
	if (canonicalJson(projection) !== canonicalJson(value.graph)) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 graph is not the compiler projection of its source GraphSpec.", { field: "graph" });
	if (canonicalDigest(value.graph) !== graphDigest || recompiled.graphDigest !== graphDigest) graphV3Error("INVALID_AUTHORIZATION", "Authorization V4 graphDigest does not match its graph projection.", { field: "graphDigest" });
	return {
		schemaVersion: 4,
		runtimeSchemaVersion: 3,
		sourceGraphSpec: recompiled.sourceGraphSpec,
		sourceGraphSpecDigest,
		sourceCwd,
		sourceRepository,
		graphDigest,
		runInstanceId,
		sessionId,
		supervisorEpoch,
		createdAt,
		graph: projection,
	};
}
