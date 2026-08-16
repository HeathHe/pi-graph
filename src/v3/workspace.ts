import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson, syncDirectory } from "./durable.ts";
import { canonicalJson } from "./digests.ts";
import { graphV3Error } from "./errors.ts";
import { readV3WorkspaceEvidence, writeV3WorkspaceEvidence, v3NodeAttemptDir } from "./attempt.ts";
import type {
	CompiledGraphNodeV3,
	ScopeEntryV3,
	V3FileDigest,
	V3WorkspaceEvidence,
} from "./types.ts";

export interface V3WorkspaceInput {
	runInstanceId: string;
	graphId: string;
	node: CompiledGraphNodeV3;
	attempt: number;
	runDir: string;
	sourceCwd: string;
	workspace?: "auto" | "shadow" | "git";
	protectedSourceRoots?: string[];
	artifacts?: Array<{ name: string; source: string }>;
}

export interface V3PreparedWorkspace {
	workspaceCwd: string;
	kind: "shadow";
	evidence: V3WorkspaceEvidence;
	inspectWrites(): Promise<V3FileDigest[]>;
	apply(signal?: AbortSignal): Promise<V3FileDigest[]>;
	cleanup(): Promise<void>;
}

export class V3WorkspaceConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "V3WorkspaceConflictError";
	}
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveScope(scope: ScopeEntryV3, sourceCwd: string): { kind: "file" | "tree"; path: string } {
	const path = isAbsolute(scope.path) ? scope.path : resolve(sourceCwd, scope.path);
	return { kind: scope.kind, path };
}

export async function digestFile(path: string): Promise<string | undefined> {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function copyIfPresent(source: string, target: string): Promise<void> {
	if (!existsSync(source)) return;
	const info = await lstat(source);
	if (info.isSymbolicLink()) throw new V3WorkspaceConflictError(`Graph scope is a symbolic link: ${source}`);
	await mkdir(dirname(target), { recursive: true });
	if (info.isDirectory()) {
		await cp(source, target, { recursive: true, force: false, dereference: false });
	} else if (info.isFile()) {
		await cp(source, target, { recursive: false, force: false });
	}
}

async function rejectSymlinks(path: string): Promise<void> {
	const info = await lstat(path).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!info) return;
	if (info.isSymbolicLink()) throw new V3WorkspaceConflictError(`Graph scope traverses a symbolic link: ${path}`);
	if (!info.isDirectory()) return;
	const entries = await readdir(path, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isSymbolicLink()) throw new V3WorkspaceConflictError(`Graph scope contains a symbolic link: ${join(path, entry.name)}`);
	}
}

interface Baseline {
	path: string;
	digest: string | undefined;
}

async function scopeBaseline(scope: { kind: "file" | "tree"; path: string }): Promise<Baseline[]> {
	const entries: Baseline[] = [];
	if (scope.kind === "file") {
		const digest = await digestFile(scope.path);
		entries.push({ path: scope.path, digest });
		return entries;
	}
	const info = await lstat(scope.path).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!info || !info.isDirectory()) {
		entries.push({ path: scope.path, digest: undefined });
		return entries;
	}
	const files = await filesUnder(scope.path);
	for (const file of files) {
		if (file.includes(`.pi-graph${sep}`)) continue;
		entries.push({ path: file, digest: await digestFile(file) });
	}
	return entries;
}

async function filesUnder(directory: string): Promise<string[]> {
	const output: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				output.push(full);
			}
		}
	};
	await walk(directory);
	return output.sort();
}

export async function prepareV3Workspace(input: V3WorkspaceInput): Promise<V3PreparedWorkspace> {
	const attemptDir = v3NodeAttemptDir(input.runDir, input.node.taskId, input.attempt);
	const sourceCwd = await realpath(input.sourceCwd);
	const workspaceRoot = join(input.runDir, "shadow", `${input.node.taskId}-${input.attempt}`);
	const workspaceCwd = join(workspaceRoot, "workspace");
	await mkdir(workspaceCwd, { recursive: true });
	const readScopes = input.node.readScope.map((scope) => resolveScope(scope, sourceCwd));
	const writeScopes = input.node.writeScope.map((scope) => resolveScope(scope, sourceCwd));
	for (const scope of [...readScopes, ...writeScopes]) await rejectSymlinks(scope.path);
	const writeBaseline: Record<string, string | null> = {};
	const readBaseline: Record<string, string | null> = {};
	for (const scope of writeScopes) {
		for (const entry of await scopeBaseline(scope)) {
			writeBaseline[entry.path] = entry.digest ?? null;
			await copyIfPresent(entry.path, resolve(workspaceCwd, relative(sourceCwd, entry.path)));
		}
	}
	for (const scope of readScopes) {
		for (const entry of await scopeBaseline(scope)) {
			readBaseline[entry.path] = entry.digest ?? null;
			if (!(entry.path in writeBaseline)) await copyIfPresent(entry.path, resolve(workspaceCwd, relative(sourceCwd, entry.path)));
		}
	}
	const inputBaseline: Record<string, { sourcePath: string; digest: string | null }> = {};
	for (const artifact of input.artifacts ?? []) {
		const target = join(workspaceCwd, ".pi-graph", "inputs", artifact.name);
		await copyIfPresent(artifact.source, target);
		inputBaseline[artifact.name] = { sourcePath: artifact.source, digest: (await digestFile(artifact.source)) ?? null };
	}
	const evidence: V3WorkspaceEvidence = {
		schemaVersion: 1,
		runInstanceId: input.runInstanceId,
		graphId: input.graphId,
		taskId: input.node.taskId,
		attempt: input.attempt,
		workspaceKind: "shadow",
		workspaceDir: workspaceCwd,
		sourceCwd,
		readBaseline,
		writeBaseline,
		inputBaseline,
		contractDigest: createHash("sha256").update(canonicalJson({ attemptDir, sourceCwd, workspaceCwd, writeBaseline, readBaseline, inputBaseline })).digest("hex"),
		createdAt: new Date().toISOString(),
	};
	await writeV3WorkspaceEvidence(input.runDir, input.node.taskId, input.attempt, evidence);
	return {
		workspaceCwd,
		kind: "shadow",
		evidence,
		inspectWrites: () => inspectWrites(input.node, workspaceCwd, evidence),
		apply: (signal) => applyWrites(input.node, attemptDir, workspaceCwd, evidence, signal),
		cleanup: async () => {
			await rm(workspaceRoot, { recursive: true, force: true });
		},
	};
}

export async function reopenV3Workspace(input: {
	runInstanceId: string;
	graphId: string;
	node: CompiledGraphNodeV3;
	attempt: number;
	runDir: string;
	sourceCwd: string;
	workspaceCwd: string;
	kind: "shadow" | "git";
	protectedSourceRoots?: string[];
}): Promise<V3PreparedWorkspace> {
	const evidence = await readV3WorkspaceEvidence(input.runDir, input.node.taskId, input.attempt);
	if (!evidence) graphV3Error("INVALID_ATTEMPT", `V3 workspace evidence is missing for '${input.node.taskId}' attempt ${input.attempt}.`, { taskId: input.node.taskId });
	if (evidence.workspaceDir !== input.workspaceCwd) graphV3Error("INVALID_ATTEMPT", "V3 workspace evidence path does not match the requested workspace.", { taskId: input.node.taskId });
	if (!existsSync(evidence.workspaceDir)) graphV3Error("RUN_NEEDS_ATTENTION", `V3 shadow workspace no longer exists: ${evidence.workspaceDir}`, { taskId: input.node.taskId });
	const attemptDir = v3NodeAttemptDir(input.runDir, input.node.taskId, input.attempt);
	return {
		workspaceCwd: evidence.workspaceDir,
		kind: "shadow",
		evidence,
		inspectWrites: () => inspectWrites(input.node, evidence.workspaceDir, evidence),
		apply: (signal) => applyWrites(input.node, attemptDir, evidence.workspaceDir, evidence, signal),
		cleanup: async () => {
			await rm(dirname(evidence.workspaceDir), { recursive: true, force: true });
		},
	};
}

async function inspectWrites(node: CompiledGraphNodeV3, workspaceCwd: string, evidence: V3WorkspaceEvidence): Promise<V3FileDigest[]> {
	const sourceCwd = evidence.sourceCwd;
	const writes: V3FileDigest[] = [];
	for (const sourcePath of Object.keys(evidence.writeBaseline)) {
		const workspaceFile = resolve(workspaceCwd, relative(sourceCwd, sourcePath));
		const before = evidence.writeBaseline[sourcePath];
		if (existsSync(workspaceFile)) {
			const after = await digestFile(workspaceFile);
			if (after !== before) writes.push({ path: sourcePath, ...(before ? { before } : {}), ...(after ? { after } : {}) });
		} else if (before !== null) {
			writes.push({ path: sourcePath, before, deleted: true });
		}
	}
	return writes;
}

interface ApplyPlanEntry {
	sourcePath: string;
	before?: string;
	after?: string;
	deleted?: boolean;
	backupPath?: string;
}

interface ApplyPlan {
	version: 1;
	status: "prepared" | "applying" | "committed";
	entries: ApplyPlanEntry[];
	attemptDir: string;
	workspaceCwd: string;
	contractDigest: string;
	applyingIndex?: number;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await (await import("node:fs/promises")).open(temporary, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path);
	await syncDirectory(dirname(path));
}

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function atomicCopy(source: string, target: string): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.pi-graph-${process.pid}-${randomUUID()}`;
	await cp(source, temp, { recursive: false, force: true });
	await rename(temp, target);
	await syncDirectory(dirname(target));
}

async function applyWrites(
	node: CompiledGraphNodeV3,
	attemptDir: string,
	workspaceCwd: string,
	evidence: V3WorkspaceEvidence,
	signal?: AbortSignal,
): Promise<V3FileDigest[]> {
	const planPath = join(attemptDir, "apply-plan.json");
	const sourceCwd = evidence.sourceCwd;
	const prior = await readApplyPlan(planPath);
	if (prior) {
		const recovered = await recoverApplyPlan(planPath, prior, sourceCwd);
		if (recovered) return recovered;
	}
	if (signal?.aborted) throw new Error("V3 source apply aborted before commit.");
	const entries: ApplyPlanEntry[] = [];
	for (const sourcePath of Object.keys(evidence.writeBaseline)) {
		const workspaceFile = resolve(workspaceCwd, relative(sourceCwd, sourcePath));
		const before = evidence.writeBaseline[sourcePath] ?? undefined;
		if (existsSync(workspaceFile)) {
			const after = await digestFile(workspaceFile);
			if (after === before) continue;
			const current = await digestFile(sourcePath);
			if (current !== before) throw new V3WorkspaceConflictError(`V3 source changed before apply (concurrent edit): ${sourcePath}`);
			entries.push({ sourcePath, ...(before ? { before } : {}), ...(after ? { after } : {}) });
		} else if (before !== undefined) {
			const current = await digestFile(sourcePath);
			if (current !== before) throw new V3WorkspaceConflictError(`V3 source changed before apply (concurrent delete): ${sourcePath}`);
			entries.push({ sourcePath, before, deleted: true });
		}
	}
	if (entries.length === 0) {
		await atomicJson(planPath, { version: 1, status: "committed", entries: [], attemptDir, workspaceCwd, contractDigest: evidence.contractDigest });
		return [];
	}
	const plan: ApplyPlan = { version: 1, status: "prepared", entries, attemptDir, workspaceCwd, contractDigest: evidence.contractDigest };
	await atomicJson(planPath, plan);
	plan.status = "applying";
	await atomicJson(planPath, plan);
	try {
		for (let index = 0; index < plan.entries.length; index += 1) {
			if (signal?.aborted) throw new Error("V3 source apply aborted during commit.");
			const entry = plan.entries[index]!;
			if (!within(sourceCwd, entry.sourcePath)) throw new V3WorkspaceConflictError(`V3 apply target escapes source cwd: ${entry.sourcePath}`);
			const current = await digestFile(entry.sourcePath);
			if (current !== entry.before) throw new V3WorkspaceConflictError(`V3 source changed immediately before commit: ${entry.sourcePath}`);
			if (entry.deleted) {
				await rm(entry.sourcePath, { force: true });
			} else if (entry.before !== undefined) {
				const backupPath = join(attemptDir, "backups", `${index}-${createHash("sha256").update(entry.sourcePath).digest("hex").slice(0, 12)}.bak`);
				await mkdir(dirname(backupPath), { recursive: true });
				await atomicCopy(entry.sourcePath, backupPath);
				entry.backupPath = backupPath;
			}
			plan.applyingIndex = index;
			await atomicJson(planPath, plan);
			if (entry.deleted) {
				// deletion already performed above
			} else {
				const workspaceFile = resolve(workspaceCwd, relative(sourceCwd, entry.sourcePath));
				await atomicCopy(workspaceFile, entry.sourcePath);
			}
		}
		plan.status = "committed";
		await atomicJson(planPath, plan);
		return planDigests(plan);
	} catch (error) {
		if (signal?.aborted) throw error;
		const recovered = await recoverApplyPlan(planPath, plan, sourceCwd);
		if (recovered) return recovered;
		throw error;
	}
}

async function recoverApplyPlan(path: string, plan: ApplyPlan, sourceCwd: string): Promise<V3FileDigest[] | null> {
	const observed = await Promise.all(plan.entries.map(async (entry) => {
		if (!within(sourceCwd, entry.sourcePath)) return "conflict" as const;
		const current = await digestFile(entry.sourcePath);
		if (entry.deleted) return current === undefined ? "after" as const : "before" as const;
		if (current === entry.before) return "before" as const;
		if (current === entry.after) return "after" as const;
		return "conflict" as const;
	}));
	if (observed.includes("conflict")) {
		const index = observed.indexOf("conflict");
		throw new V3WorkspaceConflictError(`Cannot recover V3 write because the source has a third digest: ${plan.entries[index]!.sourcePath}`);
	}
	if (observed.every((state) => state === "after")) {
		plan.status = "committed";
		await atomicJson(path, plan);
		return planDigests(plan);
	}
	if (plan.status === "committed") throw new V3WorkspaceConflictError("Committed V3 apply plan is not fully present on disk.");
	// Finish remaining entries from where the plan stopped.
	for (let index = (plan.applyingIndex ?? -1) + 1; index < plan.entries.length; index += 1) {
		const entry = plan.entries[index]!;
		if (entry.deleted) {
			await rm(entry.sourcePath, { force: true });
		} else {
			const workspaceFile = resolve(plan.workspaceCwd, relative(sourceCwd, entry.sourcePath));
			await atomicCopy(workspaceFile, entry.sourcePath);
		}
	}
	plan.status = "committed";
	await atomicJson(path, plan);
	return planDigests(plan);
}

function planDigests(plan: ApplyPlan): V3FileDigest[] {
	return plan.entries.map((entry) => ({
		path: entry.sourcePath,
		...(entry.before ? { before: entry.before } : {}),
		...(entry.after ? { after: entry.after } : {}),
		...(entry.deleted ? { deleted: true } : {}),
	}));
}

async function readApplyPlan(path: string): Promise<ApplyPlan | null> {
	const raw = await readJson(path);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const plan = raw as ApplyPlan;
	if (plan.version !== 1 || !["prepared", "applying", "committed"].includes(plan.status) || !Array.isArray(plan.entries)) return null;
	return plan;
}

