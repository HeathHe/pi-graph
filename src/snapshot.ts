import { isAbsolute, join, relative, sep } from "node:path";
import { subagentAsyncRoot } from "./rpc.ts";
import type { GraphSnapshot, GraphSnapshotV1, GraphSnapshotV2, NodeAttemptState, NodeRuntimeState, ProviderDispatchState } from "./types.ts";
import { validateGraphId } from "./compile.ts";

const GRAPH_STATUSES = new Set(["queued", "running", "complete", "failed", "blocked", "stopped", "needs_attention"]);
const NODE_STATUSES = new Set(["pending", "ready", "leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying", "accepted", "retry_wait", "resource_wait", "waiting_input", "stale", "blocked", "failed", "stopped"]);
const ATTEMPT_BOUND_STATUSES = new Set(["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying", "accepted", "waiting_input", "stale", "failed", "stopped"]);
const GRAPH_TERMINAL_STATUSES = new Set(["complete", "failed", "blocked", "stopped", "needs_attention"]);
const ATTEMPT_TERMINAL_STATUSES = new Set(["accepted", "waiting_input", "stale", "failed", "stopped"]);
const ASYNC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function validIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

interface PersistedProviderDispatchV2 extends Omit<ProviderDispatchState, "sessionDir" | "asyncDir"> {
	session: string;
}

interface PersistedAttemptV2 extends Omit<NodeAttemptState, "sessionDir" | "workspaceDir" | "asyncDir" | "outputPath" | "manifestPath" | "providerDispatches"> {
	paths: {
		session: string;
		workspace?: string;
		output?: string;
		manifest?: string;
	};
	providerDispatches?: PersistedProviderDispatchV2[];
}

interface PersistedNodeV2 extends Omit<NodeRuntimeState, "attempts"> {
	attempts: PersistedAttemptV2[];
}

interface PersistedSnapshotV2 extends Omit<GraphSnapshotV2, "nodes"> {
	nodes: Record<string, PersistedNodeV2>;
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeToken(root: string, path: string, label: string): string {
	if (!isAbsolute(path) || !within(root, path)) throw new Error(`Invalid graph snapshot ${label}: path escapes the run.`);
	const token = relative(root, path);
	if (!token || isAbsolute(token) || token.split(sep).some((part) => part === ".." || part === "")) throw new Error(`Invalid graph snapshot ${label}: unsafe path token.`);
	return token.split(sep).join("/");
}

function expandToken(root: string, token: unknown, label: string): string {
	if (typeof token !== "string" || !token || token.startsWith("/") || token.includes("\\") || token.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error(`Invalid graph snapshot ${label}: unsafe path token.`);
	}
	const path = join(root, ...token.split("/"));
	if (!within(root, path)) throw new Error(`Invalid graph snapshot ${label}: path token escapes the run.`);
	return path;
}

function validateCommon(snapshot: GraphSnapshot, expectedGraphId: string, graphRoot: string): GraphSnapshot {
	if (snapshot.graphId !== expectedGraphId || !GRAPH_STATUSES.has(snapshot.status)) throw new Error("Invalid graph snapshot identity or status.");
	if (typeof snapshot.goal !== "string" || typeof snapshot.sourceCwd !== "string" || !isAbsolute(snapshot.sourceCwd) || typeof snapshot.supervisorEpoch !== "string" || !snapshot.supervisorEpoch) throw new Error("Invalid graph snapshot metadata.");
	if (!validIsoTimestamp(snapshot.createdAt) || !validIsoTimestamp(snapshot.updatedAt) || !snapshot.nodes || typeof snapshot.nodes !== "object" || Array.isArray(snapshot.nodes)) throw new Error("Invalid graph snapshot nodes or timestamps.");
	if (snapshot.schemaVersion === 2) {
		if (!UUID.test(snapshot.runInstanceId) || !Number.isInteger(snapshot.lifecycleRevision) || snapshot.lifecycleRevision < 0 || !Number.isInteger(snapshot.fencingGeneration) || snapshot.fencingGeneration < 0) throw new Error("Invalid graph snapshot v2 lifecycle identity.");
		if (snapshot.planningAdmissionId !== undefined && !UUID.test(snapshot.planningAdmissionId)) throw new Error("Invalid graph snapshot v2 planning admission identity.");
		if (snapshot.terminalAt !== undefined && !validIsoTimestamp(snapshot.terminalAt)) throw new Error("Invalid graph snapshot v2 terminal timestamp.");
		if (snapshot.attentionAt !== undefined && (!validIsoTimestamp(snapshot.attentionAt) || snapshot.status !== "needs_attention")) throw new Error("Invalid graph snapshot v2 attention timestamp.");
	}
	for (const [taskId, raw] of Object.entries(snapshot.nodes)) {
		validateGraphId(taskId);
		if (!raw || typeof raw !== "object" || raw.taskId !== taskId || !NODE_STATUSES.has(raw.status) || !Number.isInteger(raw.attempt) || raw.attempt < 0 || !Array.isArray(raw.attempts)) throw new Error(`Invalid graph snapshot node: ${taskId}`);
		if (raw.attempts.length !== raw.attempt) throw new Error(`Invalid graph snapshot attempt count: ${taskId}`);
		for (let index = 0; index < raw.attempts.length; index += 1) {
			const attempt = raw.attempts[index];
			if (!attempt || typeof attempt !== "object" || !Number.isInteger(attempt.attempt) || attempt.attempt < 1 || !NODE_STATUSES.has(attempt.status) || typeof attempt.sessionDir !== "string" || !attempt.sessionDir) throw new Error(`Invalid graph snapshot attempt: ${taskId}`);
			if (attempt.attempt !== index + 1) throw new Error(`Invalid graph snapshot attempt ordering: ${taskId}`);
			for (const [label, timestamp] of Object.entries({ startedAt: attempt.startedAt, endedAt: attempt.endedAt, writesCommittedAt: attempt.writesCommittedAt })) {
				if (timestamp !== undefined && !validIsoTimestamp(timestamp)) throw new Error(`Invalid graph snapshot attempt ${label}: ${taskId}`);
			}
			const attemptRoot = join(graphRoot, "nodes", taskId, `attempt-${attempt.attempt}`);
			if (attempt.sessionDir !== join(attemptRoot, "session")) throw new Error(`Invalid graph snapshot session path: ${taskId}`);
			for (const path of [attempt.workspaceDir, attempt.manifestPath]) if (path !== undefined && (typeof path !== "string" || !within(attemptRoot, path))) throw new Error(`Invalid graph snapshot attempt path: ${taskId}`);
			if (attempt.outputPath !== undefined) {
				const legacyTerminalOutput = typeof attempt.outputPath === "string"
					&& snapshot.schemaVersion === 1
					&& GRAPH_TERMINAL_STATUSES.has(snapshot.status)
					&& ATTEMPT_TERMINAL_STATUSES.has(attempt.status)
					&& within(join(graphRoot, "artifacts"), attempt.outputPath);
				if (typeof attempt.outputPath !== "string" || (!within(attemptRoot, attempt.outputPath) && !legacyTerminalOutput)) throw new Error(`Invalid graph snapshot attempt path: ${taskId}`);
			}
			if ((attempt.asyncId === undefined) !== (attempt.asyncDir === undefined)) throw new Error(`Invalid graph snapshot async identity: ${taskId}`);
			if (attempt.asyncId !== undefined) {
				if (typeof attempt.asyncId !== "string" || !ASYNC_ID.test(attempt.asyncId) || attempt.asyncDir !== join(subagentAsyncRoot(), attempt.asyncId)) throw new Error(`Invalid graph snapshot async path: ${taskId}`);
			}
			if (attempt.providerDispatches !== undefined) {
				if (!Array.isArray(attempt.providerDispatches) || attempt.providerDispatches.length === 0) throw new Error(`Invalid graph snapshot provider dispatches: ${taskId}`);
				for (const [dispatchIndex, dispatch] of attempt.providerDispatches.entries()) {
					const number = dispatchIndex + 1;
					const expectedSession = number === 1 ? attempt.sessionDir : join(attemptRoot, `provider-dispatch-${number}`, "session");
					if (!dispatch || dispatch.dispatch !== number || !["prepared", "dispatching", "dispatch_unknown", "running", "complete", "failed", "stopped", "paused"].includes(dispatch.status) || dispatch.sessionDir !== expectedSession || !validIsoTimestamp(dispatch.startedAt) || (dispatch.endedAt !== undefined && !validIsoTimestamp(dispatch.endedAt))) throw new Error(`Invalid graph snapshot provider dispatch: ${taskId}/${attempt.attempt}/${number}`);
					if ((dispatch.asyncId === undefined) !== (dispatch.asyncDir === undefined)) throw new Error(`Invalid graph snapshot provider dispatch identity: ${taskId}/${attempt.attempt}/${number}`);
					if (dispatch.asyncId !== undefined && (typeof dispatch.asyncId !== "string" || !ASYNC_ID.test(dispatch.asyncId) || dispatch.asyncDir !== join(subagentAsyncRoot(), dispatch.asyncId))) throw new Error(`Invalid graph snapshot provider dispatch path: ${taskId}/${attempt.attempt}/${number}`);
					if (dispatch.requestDigest !== undefined && (typeof dispatch.requestDigest !== "string" || !/^[a-f0-9]{64}$/i.test(dispatch.requestDigest))) throw new Error(`Invalid graph snapshot provider request digest: ${taskId}/${attempt.attempt}/${number}`);
					if (dispatch.launchContractDigest !== undefined && (typeof dispatch.launchContractDigest !== "string" || !/^[a-f0-9]{64}$/i.test(dispatch.launchContractDigest))) throw new Error(`Invalid graph snapshot provider launch contract digest: ${taskId}/${attempt.attempt}/${number}`);
					if (dispatch.extensionContentDigest !== undefined && (typeof dispatch.extensionContentDigest !== "string" || !/^[a-f0-9]{64}$/i.test(dispatch.extensionContentDigest))) throw new Error(`Invalid graph snapshot provider Extension content digest: ${taskId}/${attempt.attempt}/${number}`);
					if (dispatch.runtimeLaunchContractDigest !== undefined && (typeof dispatch.runtimeLaunchContractDigest !== "string" || !/^[a-f0-9]{64}$/i.test(dispatch.runtimeLaunchContractDigest))) throw new Error(`Invalid graph snapshot provider runtime launch contract digest: ${taskId}/${attempt.attempt}/${number}`);
				}
			}
		}
		const latest = raw.attempts.at(-1);
		if (ATTEMPT_BOUND_STATUSES.has(raw.status) && !(raw.status === "stopped" && raw.attempt === 0) && (!latest || latest.status !== raw.status)) throw new Error(`Invalid graph snapshot node/attempt status: ${taskId}`);
	}
	if (snapshot.status === "complete" && Object.values(snapshot.nodes).some((node) => node.status !== "accepted")) throw new Error("Invalid complete graph snapshot: every node must be accepted.");
	return snapshot;
}

function decodeV2(value: PersistedSnapshotV2, graphRoot: string): GraphSnapshotV2 {
	const nodes = Object.fromEntries(Object.entries(value.nodes ?? {}).map(([taskId, node]) => [
		taskId,
		{
			...node,
			attempts: (node.attempts ?? []).map((attempt) => {
				const { paths, asyncId, providerDispatches, ...rest } = attempt;
				if (!paths || typeof paths !== "object") throw new Error(`Invalid graph snapshot v2 attempt paths: ${taskId}`);
				return {
					...rest,
					...(asyncId ? { asyncId, asyncDir: join(subagentAsyncRoot(), asyncId) } : {}),
					...(providerDispatches ? { providerDispatches: providerDispatches.map(({ session, asyncId: dispatchAsyncId, ...dispatch }) => ({
						...dispatch,
						...(dispatchAsyncId ? { asyncId: dispatchAsyncId, asyncDir: join(subagentAsyncRoot(), dispatchAsyncId) } : {}),
						sessionDir: expandToken(graphRoot, session, `${taskId}.providerDispatch.session`),
					})) } : {}),
					sessionDir: expandToken(graphRoot, paths.session, `${taskId}.session`),
					...(paths.workspace ? { workspaceDir: expandToken(graphRoot, paths.workspace, `${taskId}.workspace`) } : {}),
					...(paths.output ? { outputPath: expandToken(graphRoot, paths.output, `${taskId}.output`) } : {}),
					...(paths.manifest ? { manifestPath: expandToken(graphRoot, paths.manifest, `${taskId}.manifest`) } : {}),
				};
			}),
		},
	]));
	return { ...value, nodes };
}

export function validateAndDecodeSnapshot(value: unknown, expectedGraphId: string, graphRoot: string): GraphSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid graph snapshot: expected an object.");
	const raw = value as { schemaVersion?: unknown };
	if (raw.schemaVersion === 1) return validateCommon(value as GraphSnapshotV1, expectedGraphId, graphRoot);
	if (raw.schemaVersion === 2) return validateCommon(decodeV2(value as PersistedSnapshotV2, graphRoot), expectedGraphId, graphRoot);
	throw new Error(`Unsupported graph snapshot schema version: ${String(raw.schemaVersion)}.`);
}

export function encodeSnapshot(snapshot: GraphSnapshot, graphRoot: string): GraphSnapshotV1 | PersistedSnapshotV2 {
	validateCommon(snapshot, snapshot.graphId, graphRoot);
	if (snapshot.schemaVersion === 1) return snapshot;
	const nodes = Object.fromEntries(Object.entries(snapshot.nodes).map(([taskId, node]) => [
		taskId,
		{
			...node,
			attempts: node.attempts.map((attempt) => {
				const { sessionDir, workspaceDir, asyncDir: _asyncDir, outputPath, manifestPath, providerDispatches, ...rest } = attempt;
				return {
					...rest,
					...(providerDispatches ? { providerDispatches: providerDispatches.map(({ sessionDir: dispatchSession, asyncDir: _dispatchAsyncDir, ...dispatch }) => ({
						...dispatch,
						session: safeToken(graphRoot, dispatchSession, `${taskId}.providerDispatch.session`),
					})) } : {}),
					paths: {
						session: safeToken(graphRoot, sessionDir, `${taskId}.session`),
						...(workspaceDir ? { workspace: safeToken(graphRoot, workspaceDir, `${taskId}.workspace`) } : {}),
						...(outputPath ? { output: safeToken(graphRoot, outputPath, `${taskId}.output`) } : {}),
						...(manifestPath ? { manifest: safeToken(graphRoot, manifestPath, `${taskId}.manifest`) } : {}),
					},
				};
			}),
		},
	]));
	return { ...snapshot, nodes };
}

export function isTerminalGraphStatus(status: string): boolean {
	return GRAPH_TERMINAL_STATUSES.has(status);
}
