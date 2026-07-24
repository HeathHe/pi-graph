import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { compileGraph } from "./compile.ts";
import { canonicalDigest, type AcceptanceRecord, type AttemptRecord, type AttemptRecoveryRecord, type AuthorizationRecord, type ValidatedResultRecord, type WorkspaceRecord } from "./authority.ts";
import { GraphStore } from "./store.ts";
import { digestFile } from "./workspace.ts";
import type { CompiledGraph, GraphSnapshot, GraphSpec, ResultManifest, ValidationResult } from "./types.ts";

export interface ValidatedRun {
	graph: CompiledGraph;
	snapshot: GraphSnapshot;
	protected: false;
}

async function readAuthority<T>(store: GraphStore, path: string, label: string): Promise<T> {
	try {
		await store.assertManagedFilePath(path, label);
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function validIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function assertDigest(value: unknown, message: string): asserts value is string {
	assert(typeof value === "string" && /^[a-f0-9]{64}$/i.test(value), message);
}

function validateAttemptAuthority(authority: AttemptRecord, snapshot: { runInstanceId: string; graphId: string }, taskId: string, attemptNumber: number, attemptNonce: string | undefined): void {
	assert(
		authority.schemaVersion === 2
		&& authority.runInstanceId === snapshot.runInstanceId
		&& authority.graphId === snapshot.graphId
		&& authority.taskId === taskId
		&& authority.attempt === attemptNumber
		&& authority.attemptNonce === attemptNonce,
		`Attempt authority identity mismatch for ${taskId}/${attemptNumber}.`,
	);
	assert(["prepared", "dispatching", "running", "collecting", "validated", "applying", "accepted", "terminal"].includes(authority.phase), `Invalid attempt authority phase for ${taskId}/${attemptNumber}.`);
	assert(/^[a-f0-9-]{36}$/i.test(authority.attemptNonce) && typeof authority.supervisorEpoch === "string" && authority.supervisorEpoch.length > 0, `Invalid attempt authority nonce or Supervisor epoch for ${taskId}/${attemptNumber}.`);
	assert(Number.isInteger(authority.fencingGeneration) && authority.fencingGeneration >= 0, `Invalid attempt authority fence for ${taskId}/${attemptNumber}.`);
	assert(validIsoTimestamp(authority.updatedAt), `Invalid attempt authority timestamp for ${taskId}/${attemptNumber}.`);
	if (authority.requestDigest !== undefined) assertDigest(authority.requestDigest, `Invalid request digest for ${taskId}/${attemptNumber}.`);
	if (authority.phase === "terminal") {
		assert(["failed", "stale", "stopped"].includes(authority.terminalStatus ?? ""), `Invalid terminal attempt authority for ${taskId}/${attemptNumber}.`);
		assert(authority.terminalRetryKind === undefined || ["dispatch", "timeout", "failed", "validation", "provider"].includes(authority.terminalRetryKind), `Invalid terminal retry kind for ${taskId}/${attemptNumber}.`);
		if (authority.terminalStatus === "failed") assert(Boolean(authority.terminalRetryKind), `Failed terminal authority is missing its retry kind for ${taskId}/${attemptNumber}.`);
		else assert(authority.terminalRetryKind === undefined, `Non-failed terminal authority contains a retry kind for ${taskId}/${attemptNumber}.`);
	} else {
		assert(authority.terminalStatus === undefined && authority.terminalError === undefined && authority.terminalRetryKind === undefined, `Non-terminal attempt authority contains terminal fields for ${taskId}/${attemptNumber}.`);
	}
}

function validateWorkspaceAuthority(workspace: WorkspaceRecord, snapshot: { runInstanceId: string; graphId: string }, taskId: string, attemptNumber: number): void {
	assert(
		workspace.schemaVersion === 2
		&& workspace.runInstanceId === snapshot.runInstanceId
		&& workspace.graphId === snapshot.graphId
		&& workspace.taskId === taskId
		&& workspace.attempt === attemptNumber,
		`Workspace authority identity mismatch for ${taskId}/${attemptNumber}.`,
	);
	assert(["shadow", "git"].includes(workspace.workspaceKind), `Invalid workspace kind for ${taskId}/${attemptNumber}.`);
	assertDigest(workspace.contractDigest, `Invalid workspace contract digest for ${taskId}/${attemptNumber}.`);
	assert(validIsoTimestamp(workspace.createdAt), `Invalid workspace timestamp for ${taskId}/${attemptNumber}.`);
	for (const baseline of [workspace.writeBaseline, workspace.readBaseline, workspace.inputBaseline]) {
		assert(Boolean(baseline) && typeof baseline === "object" && !Array.isArray(baseline), `Invalid workspace baseline for ${taskId}/${attemptNumber}.`);
	}
}

function validateValidatedResult(validated: ValidatedResultRecord, snapshot: { runInstanceId: string; graphId: string }, taskId: string, attemptNumber: number, attemptNonce: string | undefined): void {
	assert(
		validated.schemaVersion === 2
		&& validated.runInstanceId === snapshot.runInstanceId
		&& validated.graphId === snapshot.graphId
		&& validated.taskId === taskId
		&& validated.attempt === attemptNumber
		&& validated.attemptNonce === attemptNonce,
		`Validated result identity mismatch for ${taskId}/${attemptNumber}.`,
	);
	assertDigest(validated.outputDigest, `Invalid validated output digest for ${taskId}/${attemptNumber}.`);
	assert(Array.isArray(validated.validation), `Invalid validation evidence for ${taskId}/${attemptNumber}.`);
	for (const result of validated.validation) validateValidationResult(result, taskId, attemptNumber);
	assert(validIsoTimestamp(validated.validatedAt), `Invalid validated result timestamp for ${taskId}/${attemptNumber}.`);
}

function validateValidationResult(result: ValidationResult, taskId: string, attemptNumber: number): void {
	assert(Boolean(result) && typeof result === "object" && !Array.isArray(result), `Invalid validation result for ${taskId}/${attemptNumber}.`);
	assert(
		typeof result.command === "string"
		&& typeof result.ok === "boolean"
		&& (result.exitCode === null || Number.isInteger(result.exitCode))
		&& typeof result.stdout === "string"
		&& typeof result.stderr === "string"
		&& typeof result.durationMs === "number"
		&& Number.isFinite(result.durationMs)
		&& result.durationMs >= 0
		&& (result.timedOut === undefined || typeof result.timedOut === "boolean")
		&& (result.aborted === undefined || typeof result.aborted === "boolean"),
		`Invalid validation result fields for ${taskId}/${attemptNumber}.`,
	);
}

function validateAttemptRecovery(recovery: AttemptRecoveryRecord | undefined, authority: AttemptRecord, status: string, snapshot: { runInstanceId: string; graphId: string }, taskId: string, attemptNumber: number): boolean {
	if (!recovery) return false;
	const identityMatches = recovery.schemaVersion === 2
		&& recovery.runInstanceId === snapshot.runInstanceId
		&& recovery.graphId === snapshot.graphId
		&& recovery.taskId === taskId
		&& recovery.attempt === attemptNumber
		&& recovery.attemptNonce === authority.attemptNonce
		&& recovery.fromStatus === "stale"
		&& validIsoTimestamp(recovery.preparedAt);
	if (!identityMatches || recovery.toStatus !== status) return false;
	return (authority.phase === "terminal" && authority.terminalStatus === "stale") || authority.phase === "collecting";
}

function validateAttemptProjection(authority: AttemptRecord, status: string, taskId: string, attemptNumber: number, recoveryAuthorized = false): void {
	if (status === "accepted") {
		assert(authority.phase === "accepted", `Accepted snapshot requires accepted authority for ${taskId}/${attemptNumber}.`);
		return;
	}
	if (["failed", "stale", "stopped"].includes(status)) {
		assert(authority.phase === "terminal" && authority.terminalStatus === status, `Terminal snapshot/authority mismatch for ${taskId}/${attemptNumber}.`);
		return;
	}
	if (
		authority.phase === "terminal"
		&& ["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(status)
	) return;
	const allowed: Record<string, AttemptRecord["phase"][]> = {
		leased: ["prepared"],
		dispatching: ["prepared", "dispatching"],
		dispatch_unknown: ["dispatching"],
		running: ["dispatching", "running"],
		waiting_input: ["running"],
		collecting: ["running", "collecting"],
		verifying: ["collecting", "validated", "applying", "accepted"],
	};
	const phases = allowed[status];
	if (phases) assert(phases.includes(authority.phase) || recoveryAuthorized, `Snapshot/authority phase mismatch for ${taskId}/${attemptNumber}.`);
}

function validateAcceptance(acceptance: AcceptanceRecord, snapshot: { runInstanceId: string; graphId: string }, taskId: string, attemptNumber: number, attemptNonce: string | undefined): void {
	assert(
		acceptance.schemaVersion === 2
		&& acceptance.runInstanceId === snapshot.runInstanceId
		&& acceptance.graphId === snapshot.graphId
		&& acceptance.taskId === taskId
		&& acceptance.attempt === attemptNumber
		&& acceptance.attemptNonce === attemptNonce,
		`Acceptance identity mismatch for ${taskId}/${attemptNumber}.`,
	);
	assertDigest(acceptance.outputDigest, `Invalid acceptance output digest for ${taskId}/${attemptNumber}.`);
	assertDigest(acceptance.manifestDigest, `Invalid acceptance manifest digest for ${taskId}/${attemptNumber}.`);
	assert(validIsoTimestamp(acceptance.acceptedAt), `Invalid acceptance timestamp for ${taskId}/${attemptNumber}.`);
}

async function validateV2Evidence(store: GraphStore, graph: CompiledGraph, snapshot: GraphSnapshot): Promise<void> {
	if (snapshot.schemaVersion !== 2) return;
	const authorization = await readAuthority<AuthorizationRecord>(store, store.path("authorization.json"), "Invalid authorization");
	assert(authorization.schemaVersion === 2 && authorization.runInstanceId === snapshot.runInstanceId && authorization.graphId === snapshot.graphId, "Authorization identity does not match the v2 snapshot.");
	assert(validIsoTimestamp(authorization.createdAt), "Invalid authorization timestamp.");
	assert(authorization.compilerProjectionVersion === undefined || authorization.compilerProjectionVersion === 1, "Unsupported authorization compiler projection version.");
	const strictFailureProjection = authorization.compilerProjectionVersion === 1;
	const compiledProjection = { ...graph, compiledAt: authorization.graph.compiledAt } as Omit<CompiledGraph, "projectionVersion"> & { projectionVersion?: 1 };
	if (!("projectionVersion" in authorization.graph)) delete compiledProjection.projectionVersion;
	assert(authorization.graphDigest === canonicalDigest(authorization.graph) && canonicalDigest(compiledProjection) === authorization.graphDigest, "Authorization graph digest does not match the compiled graph.");
	assert(authorization.sourceCwd === snapshot.sourceCwd, "Authorization source root does not match the v2 snapshot.");
	for (const node of graph.nodes) {
		const state = snapshot.nodes[node.taskId]!;
		assert(state.attempts.length <= node.retryPolicy.maxAttempts + (node.retryPolicy.maxProviderRetries ?? 0), `Snapshot exceeds retry authorization for ${node.taskId}.`);
		let providerFailures = 0;
		let businessFailures = 0;
		for (let index = 0; index < state.attempts.length; index += 1) {
			const attempt = state.attempts[index]!;
			if (index < state.attempts.length - 1) assert(attempt.status === "failed", `Historical attempt is not retryable for ${node.taskId}/${attempt.attempt}.`);
			const root = store.path("nodes", node.taskId, `attempt-${attempt.attempt}`);
			const authority = await readAuthority<AttemptRecord>(store, join(root, "attempt.json"), `Invalid attempt authority for ${node.taskId}/${attempt.attempt}`);
			validateAttemptAuthority(authority, snapshot, node.taskId, attempt.attempt, attempt.attemptNonce);
			if (attempt.status === "failed" && authority.phase === "terminal" && authority.terminalStatus === "failed") {
				if (strictFailureProjection) assert(attempt.failure?.retryKind !== undefined, `Snapshot failed attempt is missing its retry kind for ${node.taskId}/${attempt.attempt}.`);
			}
			if (attempt.failure?.retryKind !== undefined) {
				assert(attempt.failure.retryKind === authority.terminalRetryKind, `Snapshot failure retry kind does not match authority for ${node.taskId}/${attempt.attempt}.`);
			}
			if (["retry_wait", "failed"].includes(state.status) && index === state.attempts.length - 1 && authority.phase === "terminal" && authority.terminalStatus === "failed") {
				if (strictFailureProjection) assert(state.failure?.retryKind !== undefined, `Snapshot failed node is missing its retry kind for ${node.taskId}/${attempt.attempt}.`);
				if (state.failure?.retryKind !== undefined) {
					assert(state.failure.retryKind === authority.terminalRetryKind, `Snapshot node failure retry kind does not match authority for ${node.taskId}/${attempt.attempt}.`);
				}
			}
			if (index < state.attempts.length - 1) {
				const retryKind = authority.terminalRetryKind!;
				if (retryKind === "provider") {
					providerFailures += 1;
					assert(providerFailures <= (node.retryPolicy.maxProviderRetries ?? 0), `Historical provider retry exceeds authorization for ${node.taskId}/${attempt.attempt}.`);
				} else {
					businessFailures += 1;
					const retryOn = node.retryPolicy.retryOn ?? ["dispatch", "timeout", "failed", "validation"];
					assert(retryOn.includes(retryKind), `Historical attempt retry kind is not authorized for ${node.taskId}/${attempt.attempt}.`);
					assert(businessFailures < node.retryPolicy.maxAttempts, `Historical attempt retry exceeds authorization for ${node.taskId}/${attempt.attempt}.`);
				}
			}
			if (state.status === "retry_wait" && index === state.attempts.length - 1 && attempt.status === "failed") {
				const retryKind = authority.terminalRetryKind!;
				if (retryKind === "provider") {
					providerFailures += 1;
					assert(providerFailures <= (node.retryPolicy.maxProviderRetries ?? 0), `Retry-wait provider projection exceeds retry authorization for ${node.taskId}/${attempt.attempt}.`);
				} else {
					businessFailures += 1;
					const retryOn = node.retryPolicy.retryOn ?? ["dispatch", "timeout", "failed", "validation"];
					assert(retryOn.includes(retryKind), `Retry-wait kind is not authorized for ${node.taskId}/${attempt.attempt}.`);
					assert(businessFailures < node.retryPolicy.maxAttempts, `Retry-wait projection exceeds retry authorization for ${node.taskId}/${attempt.attempt}.`);
				}
			}
			if (["retry_wait", "resource_wait"].includes(state.status) && index === state.attempts.length - 1 && attempt.status !== "failed") {
				assert(["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(attempt.status), `Resource-wait projection lost its active attempt for ${node.taskId}/${attempt.attempt}.`);
			}
			let recovery: AttemptRecoveryRecord | undefined;
			try {
				recovery = await readAuthority<AttemptRecoveryRecord>(store, join(root, "attempt-recovery.json"), `Invalid attempt recovery for ${node.taskId}/${attempt.attempt}`);
			} catch (error) {
				if (!String(error).includes("ENOENT")) throw error;
			}
			validateAttemptProjection(authority, attempt.status, node.taskId, attempt.attempt, validateAttemptRecovery(recovery, authority, attempt.status, snapshot, node.taskId, attempt.attempt));
			const workspace = await readAuthority<WorkspaceRecord>(store, join(root, "workspace.json"), `Invalid workspace authority for ${node.taskId}/${attempt.attempt}`);
			validateWorkspaceAuthority(workspace, snapshot, node.taskId, attempt.attempt);
			if (attempt.asyncId) assert(authority.asyncId === attempt.asyncId, `Child identity mismatch for ${node.taskId}/${attempt.attempt}.`);
			if (["validated", "applying", "accepted"].includes(authority.phase)) {
				const validated = await readAuthority<ValidatedResultRecord>(store, join(root, "validated-result.json"), `Invalid validated result for ${node.taskId}/${attempt.attempt}`);
				validateValidatedResult(validated, snapshot, node.taskId, attempt.attempt, attempt.attemptNonce);
				if (attempt.outputPath) {
					await store.assertManagedFilePath(attempt.outputPath, `Validated output for ${node.taskId}/${attempt.attempt}`);
					assert(await digestFile(attempt.outputPath) === validated.outputDigest, `Validated output digest mismatch for ${node.taskId}/${attempt.attempt}.`);
				}
			}
			if (attempt.status === "accepted" || authority.phase === "accepted") {
				const acceptance = await readAuthority<AcceptanceRecord>(store, join(root, "acceptance.json"), `Invalid acceptance for ${node.taskId}/${attempt.attempt}`);
				validateAcceptance(acceptance, snapshot, node.taskId, attempt.attempt, attempt.attemptNonce);
				const validated = await readAuthority<ValidatedResultRecord>(store, join(root, "validated-result.json"), `Invalid validated result for ${node.taskId}/${attempt.attempt}`);
				validateValidatedResult(validated, snapshot, node.taskId, attempt.attempt, attempt.attemptNonce);
				assert(acceptance.outputDigest === validated.outputDigest, `Acceptance output does not match validated output for ${node.taskId}/${attempt.attempt}.`);
				const manifestPath = attempt.manifestPath ?? join(root, "result-manifest.json");
				await store.assertManagedFilePath(manifestPath, `Result manifest for ${node.taskId}/${attempt.attempt}`);
				assert(await digestFile(manifestPath) === acceptance.manifestDigest, `Acceptance manifest digest mismatch for ${node.taskId}/${attempt.attempt}.`);
				const manifest = await readAuthority<ResultManifest>(store, manifestPath, `Invalid result manifest for ${node.taskId}/${attempt.attempt}`);
				assert(
					manifest.schemaVersion === 1
					&& manifest.graphId === snapshot.graphId
					&& manifest.taskId === node.taskId
					&& manifest.attempt === attempt.attempt
					&& manifest.status === "complete"
					&& Array.isArray(manifest.validation)
					&& canonicalDigest(manifest.validation) === canonicalDigest(validated.validation),
					`Result manifest validation evidence mismatch for ${node.taskId}/${attempt.attempt}.`,
				);
				const canonicalArtifact = store.path("artifacts", node.outputArtifact);
				await store.assertManagedFilePath(canonicalArtifact, `Canonical artifact for ${node.taskId}/${attempt.attempt}`);
				assert(await digestFile(canonicalArtifact) === acceptance.outputDigest, `Acceptance output digest mismatch for ${node.taskId}/${attempt.attempt}.`);
			}
		}
	}
}

export async function loadValidatedRun(store: GraphStore, maxSpawnBudget: number): Promise<ValidatedRun> {
	void maxSpawnBudget;
	const snapshot = await store.loadSnapshot();
	const persisted = await store.loadGraph();
	const graph = compileGraph(persisted as GraphSpec, snapshot.sourceCwd, Number.MAX_SAFE_INTEGER, snapshot.schemaVersion);
	assert(graph.graphId === snapshot.graphId, "Persisted graph identity does not match its snapshot.");
	const expected = graph.nodes.map((node) => node.taskId).sort();
	const actual = Object.keys(snapshot.nodes).sort();
	assert(JSON.stringify(expected) === JSON.stringify(actual), "Persisted graph nodes do not match its snapshot.");
	await validateV2Evidence(store, graph, snapshot);
	return { graph, snapshot, protected: false };
}

export async function rebuildTerminalSnapshotProjection(store: GraphStore, maxSpawnBudget: number): Promise<ValidatedRun> {
	void maxSpawnBudget;
	const authorization = await readAuthority<AuthorizationRecord>(store, store.path("authorization.json"), "Snapshot rebuild requires valid authorization");
	assert(authorization.schemaVersion === 2 && authorization.graphDigest === canonicalDigest(authorization.graph), "Snapshot rebuild authorization digest is invalid.");
	assert(validIsoTimestamp(authorization.createdAt), "Snapshot rebuild authorization timestamp is invalid.");
	assert(authorization.compilerProjectionVersion === undefined || authorization.compilerProjectionVersion === 1, "Unsupported authorization compiler projection version.");
	const graph = compileGraph(authorization.graph as GraphSpec, authorization.sourceCwd, Number.MAX_SAFE_INTEGER, 2);
	const compiledProjection = { ...graph, compiledAt: authorization.graph.compiledAt } as Omit<CompiledGraph, "projectionVersion"> & { projectionVersion?: 1 };
	if (!("projectionVersion" in authorization.graph)) delete compiledProjection.projectionVersion;
	assert(canonicalDigest(compiledProjection) === authorization.graphDigest, "Snapshot rebuild graph does not match authorization.");
	const nodes: GraphSnapshot["nodes"] = {};
	const acceptedAt: string[] = [];
	for (const node of graph.nodes) {
		const nodeRoot = store.path("nodes", node.taskId);
		await store.assertManagedDirectoryPath(nodeRoot, `Snapshot rebuild node evidence for ${node.taskId}`);
		const attemptNames = (await readdir(nodeRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && /^attempt-[1-9][0-9]*$/.test(entry.name))
			.map((entry) => entry.name)
			.sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)));
		assert(attemptNames.length > 0, `Snapshot rebuild requires at least one attempt for ${node.taskId}.`);
		assert(attemptNames.every((name, index) => Number(name.slice(8)) === index + 1), `Snapshot rebuild attempt sequence is not contiguous for ${node.taskId}.`);
		assert(attemptNames.length <= node.retryPolicy.maxAttempts + (node.retryPolicy.maxProviderRetries ?? 0), `Snapshot rebuild exceeds retry authorization for ${node.taskId}.`);
		const rebuiltAttempts: GraphSnapshot["nodes"][string]["attempts"] = [];
		let finalAcceptance: AcceptanceRecord | undefined;
		let providerFailures = 0;
		let businessFailures = 0;
		for (let index = 0; index < attemptNames.length; index += 1) {
			const attemptNumber = index + 1;
			const root = join(nodeRoot, attemptNames[index]!);
			await store.assertManagedDirectoryPath(root, `Snapshot rebuild attempt evidence for ${node.taskId}/${attemptNumber}`);
			const [attempt, workspace] = await Promise.all([
				readAuthority<AttemptRecord>(store, join(root, "attempt.json"), `Invalid attempt authority for ${node.taskId}/${attemptNumber}`),
				readAuthority<WorkspaceRecord>(store, join(root, "workspace.json"), `Invalid workspace authority for ${node.taskId}/${attemptNumber}`),
			]);
			validateAttemptAuthority(attempt, authorization, node.taskId, attemptNumber, attempt.attemptNonce);
			validateWorkspaceAuthority(workspace, authorization, node.taskId, attemptNumber);
			const isFinal = index === attemptNames.length - 1;
			if (!isFinal) {
				assert(attempt.phase === "terminal" && attempt.terminalStatus === "failed", `Snapshot rebuild prior attempt is not retryable for ${node.taskId}/${attemptNumber}.`);
				const retryKind = attempt.terminalRetryKind!;
				if (retryKind === "provider") {
					providerFailures += 1;
					assert(providerFailures <= (node.retryPolicy.maxProviderRetries ?? 0), `Snapshot rebuild provider retry exceeds authorization for ${node.taskId}/${attemptNumber}.`);
				} else {
					businessFailures += 1;
					const retryOn = node.retryPolicy.retryOn ?? ["dispatch", "timeout", "failed", "validation"];
					assert(retryOn.includes(retryKind), `Snapshot rebuild prior retry kind is not authorized for ${node.taskId}/${attemptNumber}.`);
					assert(businessFailures < node.retryPolicy.maxAttempts, `Snapshot rebuild prior retry exceeds authorization for ${node.taskId}/${attemptNumber}.`);
				}
				rebuiltAttempts.push({
					attempt: attemptNumber,
					attemptNonce: attempt.attemptNonce,
					status: attempt.terminalStatus!,
					sessionDir: join(root, "session"),
					workspaceKind: workspace.workspaceKind,
					...(attempt.asyncId ? { asyncId: attempt.asyncId, asyncDir: join((await import("./rpc.ts")).subagentAsyncRoot(), attempt.asyncId) } : {}),
					endedAt: attempt.updatedAt,
					...(attempt.terminalError ? { error: attempt.terminalError } : {}),
					failure: {
						kind: retryKind === "provider" ? "provider_transient"
							: retryKind === "timeout" ? "hard_deadline"
								: retryKind === "dispatch" ? "dispatch_rejected"
									: retryKind === "validation" ? "validation"
										: "task_failed",
						retryKind,
					},
				});
				continue;
			}
			assert(attempt.phase === "accepted", `Snapshot rebuild final attempt is not accepted for ${node.taskId}.`);
			const [validated, acceptance] = await Promise.all([
				readAuthority<ValidatedResultRecord>(store, join(root, "validated-result.json"), `Invalid validated result for ${node.taskId}`),
				readAuthority<AcceptanceRecord>(store, join(root, "acceptance.json"), `Invalid acceptance for ${node.taskId}`),
			]);
			validateValidatedResult(validated, authorization, node.taskId, attemptNumber, attempt.attemptNonce);
			validateAcceptance(acceptance, authorization, node.taskId, attemptNumber, attempt.attemptNonce);
			assert(acceptance.outputDigest === validated.outputDigest, `Snapshot rebuild acceptance identity mismatch for ${node.taskId}.`);
			const outputPath = join(root, "output", node.outputArtifact);
			const manifestPath = join(root, "result-manifest.json");
			await store.assertManagedFilePath(outputPath, `Snapshot rebuild output for ${node.taskId}`);
			await store.assertManagedFilePath(manifestPath, `Snapshot rebuild manifest for ${node.taskId}`);
			await store.assertManagedFilePath(store.path("artifacts", node.outputArtifact), `Snapshot rebuild canonical artifact for ${node.taskId}`);
			assert(await digestFile(outputPath) === validated.outputDigest, `Snapshot rebuild validated output mismatch for ${node.taskId}.`);
			assert(await digestFile(manifestPath) === acceptance.manifestDigest && await digestFile(store.path("artifacts", node.outputArtifact)) === acceptance.outputDigest, `Snapshot rebuild acceptance mismatch for ${node.taskId}.`);
			finalAcceptance = acceptance;
			rebuiltAttempts.push({
				attempt: attemptNumber,
				attemptNonce: attempt.attemptNonce,
				status: "accepted",
				sessionDir: join(root, "session"),
				workspaceKind: workspace.workspaceKind,
				outputPath,
				manifestPath,
				...(attempt.asyncId ? { asyncId: attempt.asyncId, asyncDir: join((await import("./rpc.ts")).subagentAsyncRoot(), attempt.asyncId) } : {}),
				endedAt: acceptance.acceptedAt,
			});
		}
		assert(finalAcceptance, `Snapshot rebuild found no accepted attempt for ${node.taskId}.`);
		acceptedAt.push(finalAcceptance.acceptedAt);
		nodes[node.taskId] = {
			taskId: node.taskId,
			status: "accepted",
			attempt: rebuiltAttempts.length,
			attempts: rebuiltAttempts,
		};
	}
	const terminalAt = acceptedAt.sort().at(-1) ?? authorization.createdAt;
	const snapshot: GraphSnapshot = {
		schemaVersion: 2,
		runInstanceId: authorization.runInstanceId,
		lifecycleRevision: 0,
		fencingGeneration: store.currentFencingGeneration(),
		graphId: authorization.graphId,
		status: "complete",
		goal: graph.goal,
		sourceCwd: authorization.sourceCwd,
		...(authorization.sessionId ? { sessionId: authorization.sessionId } : {}),
		createdAt: authorization.createdAt,
		updatedAt: new Date().toISOString(),
		supervisorEpoch: authorization.supervisorEpoch,
		terminalAt,
		nodes,
	};
	await validateV2Evidence(store, graph, snapshot);
	await store.replaceSnapshotProjection(snapshot);
	await store.event("graph.snapshot_rebuilt", { evidence: "authorization+acceptance" });
	return loadValidatedRun(store, maxSpawnBudget);
}

export async function loadOrRebuildValidatedRun(store: GraphStore, maxSpawnBudget: number): Promise<ValidatedRun> {
	try {
		return await loadValidatedRun(store, maxSpawnBudget);
	} catch (original) {
		try {
			return await rebuildTerminalSnapshotProjection(store, maxSpawnBudget);
		} catch {
			throw original;
		}
	}
}

export async function recordProtectedIncident(store: GraphStore, error: unknown, kind = "evidence_mismatch"): Promise<string> {
	const message = error instanceof Error ? error.message : String(error);
	const incidentId = createHash("sha256").update(`${kind}\0${message}`).digest("hex").slice(0, 24);
	return store.writeJson(join("incidents", `${incidentId}.json`), {
		schemaVersion: 1,
		incidentId,
		kind,
		status: "protected",
		message,
		detectedAt: new Date().toISOString(),
	});
}
