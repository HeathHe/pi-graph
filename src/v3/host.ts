import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateAuthorizationV4 } from "./authorization.ts";
import { readLatestV3Attempt, v3NodeAttemptDir, v3RunPaths } from "./attempt.ts";
import { compileGraphSpecV3 } from "./compiler.ts";
import { v3PreflightAgent } from "./dispatch.ts";
import { graphV3Error, GraphV3Error } from "./errors.ts";
import { detectRunFormat } from "./format-detector.ts";
import { initializeV3Run } from "./initialize.ts";
import { readV3RunLease, validateV3RunLease } from "./lease.ts";
import { buildV3SnapshotProjection } from "./projection.ts";
import { V3GraphRunner, resumeV3GraphRun } from "./runner.ts";
import { validateGraphSnapshotV3 } from "./snapshot.ts";
import type { SubagentRpcClient } from "./rpc.ts";
import type {
	AuthorizationV4,
	CompiledGraphV3,
	GraphRuntimeStatusV3,
	GraphSnapshotV3,
	GraphSpecV3,
} from "./types.ts";

const TERMINAL_STATUSES: ReadonlySet<GraphRuntimeStatusV3> = new Set(["complete", "failed", "stopped", "needs_attention"]);

export interface V3HostContext {
	rpc: SubagentRpcClient;
	runsDir: string;
	sessionId: string;
	supervisorEpoch: string;
	/** Injectable agent preflight; defaults to pi-subagents public preflight. */
	preflightAgent?: (spec: { agent: string; cwd: string; sessionId?: string }) => Promise<void>;
}

export interface V3GraphSummary {
	graphId: string;
	runDir: string;
	snapshot: GraphSnapshotV3;
	supervised: boolean;
}

export interface V3DoctorIssue {
	kind: "stale-lease" | "orphan-shadow" | "invalid-run" | "needs-attention";
	runId?: string;
	detail: string;
}

export interface V3DoctorReport {
	issues: V3DoctorIssue[];
	supervised: string[];
}

export interface V3StartResult {
	graph: CompiledGraphV3;
	runDir: string;
	graphId: string;
	snapshot: GraphSnapshotV3;
}

export interface LoadedV3Run {
	graph: CompiledGraphV3;
	authorization: AuthorizationV4;
	runDir: string;
}

/**
 * Production-facing V3 adapter. Owns the runs directory and the set of runs this
 * process supervises. Every operation re-verifies the run on site (format, digest,
 * lease, source identity) instead of trusting persisted integrity markers.
 */
export class V3GraphHost {
	private readonly supervised = new Map<string, { runner: V3GraphRunner; promise: Promise<GraphSnapshotV3> }>();
	readonly context: V3HostContext;

	constructor(context: V3HostContext) {
		this.context = context;
	}

	/** Re-point the host at a new session (used on session_start). */
	setSessionContext(sessionId: string, supervisorEpoch: string): void {
		this.context.sessionId = sessionId;
		this.context.supervisorEpoch = supervisorEpoch;
	}

	/** Request a graceful stop for every run this process supervises (session shutdown). */
	suspendAll(): void {
		for (const { runner } of this.supervised.values()) runner.requestStop();
	}

	get runsDir(): string {
		return resolve(this.context.runsDir);
	}

	runDirFor(graphId: string): string {
		return join(this.runsDir, graphId);
	}

	private preflight(): (spec: { agent: string; cwd: string; sessionId?: string }) => Promise<void> {
		return this.context.preflightAgent ?? ((spec) => v3PreflightAgent({ agent: spec.agent }, spec.cwd, spec.sessionId));
	}

	private runnerOptions(runDir: string, graph: CompiledGraphV3, authorization: AuthorizationV4, sourceCwd: string): ConstructorParameters<typeof V3GraphRunner>[0] {
		return {
			rpc: this.context.rpc,
			runDir,
			graph,
			authorization,
			sourceCwd,
			sessionId: authorization.sessionId,
			supervisorEpoch: authorization.supervisorEpoch,
			preflightAgent: this.preflight(),
		};
	}

	/** Rebuild the compiled graph from the stored authorization source spec and verify its digests on site. */
	async loadRun(runDir: string, graphId?: string): Promise<LoadedV3Run> {
		const resolved = resolve(runDir);
		const authorizationRaw = JSON.parse(await readFile(join(resolved, "authorization.json"), "utf8")) as unknown;
		const authorization = validateAuthorizationV4(authorizationRaw);
		const graph = compileGraphSpecV3(authorization.sourceGraphSpec as GraphSpecV3);
		if (graph.sourceGraphSpecDigest !== authorization.sourceGraphSpecDigest) {
			graphV3Error("INVALID_AUTHORIZATION", "V3 run sourceGraphSpecDigest no longer matches its admitted source GraphSpec.", { field: "sourceGraphSpecDigest" });
		}
		if (graph.graphDigest !== authorization.graphDigest) {
			graphV3Error("INVALID_AUTHORIZATION", "V3 run graphDigest no longer matches its admitted compiled graph.", { field: "graphDigest" });
		}
		return { graph, authorization, runDir: resolved };
	}

	async isV3Run(runDir: string): Promise<boolean> {
		try {
			const [snapshotRaw, authorizationRaw] = await Promise.all([
				readFile(join(runDir, "snapshot.json"), "utf8"),
				readFile(join(runDir, "authorization.json"), "utf8"),
			]);
			return detectRunFormat(JSON.parse(snapshotRaw), JSON.parse(authorizationRaw)).kind === "v3";
		} catch {
			return false;
		}
	}

	/** Start a new V3 graph: admit, initialize, and run in the background. */
	async start(spec: GraphSpecV3, sourceCwd: string): Promise<V3StartResult> {
		const graph = compileGraphSpecV3(spec);
		const graphId = graph.graphId;
		const runDir = this.runDirFor(graphId);
		if (this.supervised.has(graphId)) graphV3Error("RUN_ALREADY_EXISTS", `V3 graph '${graphId}' is already supervised by this session.`, { details: { runDir } });
		const init = await initializeV3Run({
			trustedRoot: this.runsDir,
			runDir,
			graph,
			sessionId: this.context.sessionId,
			supervisorEpoch: this.context.supervisorEpoch,
			sourceCwd,
			runInstanceId: graphId,
		});
		const runner = new V3GraphRunner(this.runnerOptions(runDir, graph, init.authorization, sourceCwd));
		const promise = runner.run();
		this.supervised.set(graphId, { runner, promise });
		void promise.finally(() => {
			if (this.supervised.get(graphId)?.promise === promise) this.supervised.delete(graphId);
		}).catch(() => undefined);
		const snapshot = await buildV3SnapshotProjection({
			runDir,
			graph,
			authorization: init.authorization,
			sessionId: init.authorization.sessionId,
			supervisorEpoch: init.authorization.supervisorEpoch,
		});
		return { graph, runDir, graphId, snapshot };
	}

	/** Live status projection for a V3 run. */
	async status(graphId: string): Promise<GraphSnapshotV3> {
		const runDir = this.runDirFor(graphId);
		const { graph, authorization } = await this.loadRun(runDir, graphId);
		const supervised = this.supervised.get(graphId);
		return buildV3SnapshotProjection({
			runDir,
			graph,
			authorization,
			sessionId: authorization.sessionId,
			supervisorEpoch: authorization.supervisorEpoch,
			...(supervised ? { stopRequested: supervised.runner.isStopRequested } : {}),
		});
	}

	/** Await the supervised run's terminal snapshot, or return the live projection. */
	async waitForCompletion(graphId: string): Promise<GraphSnapshotV3> {
		const supervised = this.supervised.get(graphId);
		if (supervised) return supervised.promise;
		return this.status(graphId);
	}

	/**
	 * Stop a V3 run. If this session supervises it, request a graceful stop and wait.
	 * Otherwise adopt it (load on-disk state), request a stop, and run to a stopped
	 * snapshot; a live lease held by another process surfaces as needs_attention.
	 */
	async stop(graphId: string): Promise<GraphSnapshotV3> {
		const runDir = this.runDirFor(graphId);
		const supervised = this.supervised.get(graphId);
		if (supervised) {
			supervised.runner.requestStop();
			return supervised.promise;
		}
		const { graph, authorization } = await this.loadRun(runDir, graphId);
		const runner = new V3GraphRunner(this.runnerOptions(runDir, graph, authorization, authorization.sourceCwd));
		await runner.initializeForResume();
		runner.requestStop();
		const promise = runner.run();
		this.supervised.set(graphId, { runner, promise });
		void promise.finally(() => {
			if (this.supervised.get(graphId)?.promise === promise) this.supervised.delete(graphId);
		}).catch(() => undefined);
		return promise;
	}

	/** Resume a crashed/interrupted V3 run (crash recovery). */
	async resume(graphId: string): Promise<GraphSnapshotV3> {
		const runDir = this.runDirFor(graphId);
		if (this.supervised.has(graphId)) return this.supervised.get(graphId)!.promise;
		const { graph, authorization } = await this.loadRun(runDir, graphId);
		const promise = resumeV3GraphRun(this.runnerOptions(runDir, graph, authorization, authorization.sourceCwd));
		this.supervised.set(graphId, { runner: promise as unknown as V3GraphRunner, promise });
		void promise.finally(() => {
			if (this.supervised.get(graphId)?.promise === promise) this.supervised.delete(graphId);
		}).catch(() => undefined);
		return promise;
	}

	/** List V3 runs with their live projections. Legacy runs are not shown here. */
	async list(): Promise<V3GraphSummary[]> {
		const entries = await readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
		const summaries: V3GraphSummary[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const runDir = join(this.runsDir, entry.name);
			if (!await this.isV3Run(runDir)) continue;
			try {
				const { graph, authorization } = await this.loadRun(runDir, entry.name);
				const supervised = this.supervised.has(entry.name);
				const snapshot = await buildV3SnapshotProjection({
					runDir,
					graph,
					authorization,
					sessionId: authorization.sessionId,
					supervisorEpoch: authorization.supervisorEpoch,
					...(supervised ? { stopRequested: this.supervised.get(entry.name)!.runner.isStopRequested } : {}),
				});
				summaries.push({ graphId: entry.name, runDir, snapshot, supervised });
			} catch (error) {
				// Unreadable or tampered V3 runs are reported by doctor, not list.
			}
		}
		summaries.sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt));
		return summaries;
	}

	/** Adoption scan: recover every non-terminal V3 run not supervised by this host. */
	async adoptCrashedRuns(): Promise<Array<{ graphId: string; outcome: "resumed" | "needs_attention" | "skipped" }>> {
		const entries = await readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
		const adopted: Array<{ graphId: string; outcome: "resumed" | "needs_attention" | "skipped" }> = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			if (this.supervised.has(entry.name)) continue;
			const runDir = join(this.runsDir, entry.name);
			if (!await this.isV3Run(runDir)) continue;
			let status: GraphRuntimeStatusV3;
			try {
				const raw = JSON.parse(await readFile(join(runDir, "snapshot.json"), "utf8"));
				status = validateGraphSnapshotV3(raw).status;
			} catch {
				adopted.push({ graphId: entry.name, outcome: "needs_attention" });
				continue;
			}
			if (TERMINAL_STATUSES.has(status)) continue;
			try {
				await this.resume(entry.name);
				adopted.push({ graphId: entry.name, outcome: "resumed" });
			} catch (error) {
				adopted.push({ graphId: entry.name, outcome: "needs_attention" });
			}
		}
		return adopted;
	}

	/** Doctor: report lease health, orphan shadow dirs, invalid runs, and needs_attention runs. */
	async doctor(): Promise<V3DoctorReport> {
		const issues: V3DoctorIssue[] = [];
		const entries = await readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const runDir = join(this.runsDir, entry.name);
			if (!await this.isV3Run(runDir)) continue;
			const paths = v3RunPaths(runDir);
			const lease = await readV3RunLease(paths.leasePath);
			if (lease && !await this.leaseIsLive(lease)) {
				issues.push({ kind: "stale-lease", runId: entry.name, detail: `Lease records ${lease.pid} but that process identity is no longer alive; a resume will take it over.` });
			}
			issues.push(...await this.orphanShadows(entry.name, runDir));
			try {
				const snapshot = await this.status(entry.name);
				if (snapshot.status === "needs_attention") issues.push({ kind: "needs-attention", runId: entry.name, detail: "Run is in needs_attention and will not auto-resume." });
			} catch (error) {
				issues.push({ kind: "invalid-run", runId: entry.name, detail: error instanceof Error ? error.message : String(error) });
			}
		}
		return { issues, supervised: [...this.supervised.keys()] };
	}

	private async leaseIsLive(lease: NonNullable<Awaited<ReturnType<typeof readV3RunLease>>>): Promise<boolean> {
		try {
			validateV3RunLease(lease);
			return (await import("./claims.ts")).processIdentityForPid(lease.pid) !== undefined;
		} catch {
			return false;
		}
	}

	private async orphanShadows(graphId: string, runDir: string): Promise<V3DoctorIssue[]> {
		const { readdir: readShadowDirs, stat } = await import("node:fs/promises");
		const shadowRoot = join(runDir, "shadow");
		const children = await readShadowDirs(shadowRoot).catch(() => []);
		const issues: V3DoctorIssue[] = [];
		for (const child of children) {
			const shadowDir = join(shadowRoot, child);
			const info = await stat(shadowDir).catch(() => undefined);
			if (!info || !info.isDirectory()) continue;
			const taskId = child;
			const latest = await readLatestV3Attempt(runDir, taskId);
			const evidenceDir = v3NodeAttemptDir(runDir, taskId, latest?.attempt ?? 1);
			const referenced = latest && (latest.evidence.phase === "running" || latest.evidence.phase === "verifying" || latest.evidence.phase === "applying" || latest.evidence.phase === "prepared" || latest.evidence.phase === "dispatched");
			if (!referenced) {
				const evidenceExists = await stat(join(evidenceDir, "workspace.json")).then(() => true).catch(() => false);
				if (!evidenceExists || latest?.evidence.phase === "accepted" || latest?.evidence.phase === "failed" || latest?.evidence.phase === "aborted") {
					issues.push({ kind: "orphan-shadow", runId: graphId, detail: `Shadow directory '${shadowDir}' is not referenced by any active attempt.` });
				}
			}
		}
		return issues;
	}
}

export async function graphStatusTextV3(snapshot: GraphSnapshotV3, runsDir: string): Promise<string> {
	const nodeLines: string[] = [];
	for (const [taskId, node] of Object.entries(snapshot.nodes ?? {})) {
		const phase = node.terminalStatus ?? node.phase;
		nodeLines.push(`  - ${taskId}: ${phase}${node.attempt > 0 ? ` (attempt ${node.attempt})` : ""}`);
	}
	return [
		`Graph: ${snapshot.graphId}`,
		`Status: ${snapshot.status}`,
		`Created: ${snapshot.createdAt}`,
		`State: ${join(resolve(runsDir), snapshot.graphId, "snapshot.json")}`,
		`Nodes:${nodeLines.length ? `\n${nodeLines.join("\n")}` : " (none)"}`,
	].join("\n");
}

export function v3IsGraphSpecV3(spec: unknown): spec is GraphSpecV3 {
	return typeof spec === "object" && spec !== null && (spec as { schemaVersion?: unknown }).schemaVersion === 3;
}

export function isV3GraphError(error: unknown): boolean {
	return error instanceof GraphV3Error;
}
