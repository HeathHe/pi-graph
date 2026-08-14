import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { CompiledNode, ExternalAction, FileDigest, ResourceScope, ScopeEntry, SideEffect } from "./types.ts";

export interface NodeContract {
	schemaVersion: 1;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptDir: string;
	sourceCwd: string;
	workspaceCwd: string;
	readScope: ScopeEntry[];
	writeScope: ScopeEntry[];
	sideEffect?: SideEffect;
	resourceScopes?: ResourceScope[];
	externalAction?: ExternalAction;
	allowBash: boolean;
	writeBaseline: Record<string, string | null>;
	readBaseline: Record<string, string | null>;
	protectedSourceRoots?: string[];
	protectedWorkspaceRoots?: string[];
	inputBaseline: Record<string, { sourcePath: string; digest: string | null }>;
	sourceGitEvidence?: { path: string; digest: string; sourceReadScope: ScopeEntry[] };
	gitRoot?: string;
	gitWorktreeRoot?: string;
	contextDigest?: string;
}

export interface PreparedWorkspace {
	kind: "shadow" | "git";
	cwd: string;
	contract: NodeContract;
	artifactPaths: Record<string, string>;
	sourceGitEvidencePath?: string;
	inspectWrites(): Promise<FileDigest[]>;
	apply(signal?: AbortSignal): Promise<FileDigest[]>;
	cleanup(): Promise<void>;
}

export class WorkspaceConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceConflictError";
	}
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalPath(input: string): string {
	let candidate = resolve(input);
	const suffix: string[] = [];
	while (!existsSync(candidate)) {
		const parent = dirname(candidate);
		if (parent === candidate) break;
		suffix.unshift(basename(candidate));
		candidate = parent;
	}
	const root = existsSync(candidate) ? realpathSync.native(candidate) : candidate;
	return resolve(root, ...suffix);
}

function protectedWorkspaceRoots(root: string, additionalRoots: readonly string[] = []): string[] {
	return [...new Set([join(root, ".pi-graph"), join(root, ".pi", "agents"), join(root, ".pi-subagents"), join(root, ".git"), ...additionalRoots.map((path) => resolve(path))])];
}

function hasProtectedControlSegment(root: string, target: string): boolean {
	if (!within(root, target)) return false;
	const parts = relative(root, target).split(sep).filter(Boolean);
	return parts.some((part, index) => part === ".git" || part === ".pi-graph" || part === ".pi-subagents" || (part === "agents" && parts[index - 1] === ".pi"));
}

function isNestedProtectedControlPath(root: string, target: string): boolean {
	if (!within(root, target)) return false;
	const parts = relative(root, target).split(sep).filter(Boolean);
	return parts.some((part, index) => index > 0 && (part === ".git" || part === ".pi-graph" || part === ".pi-subagents" || (part === "agents" && parts[index - 1] === ".pi")));
}

function isProtectedWorkspacePath(root: string, target: string, additionalRoots: readonly string[] = []): boolean {
	return hasProtectedControlSegment(root, target) || protectedWorkspaceRoots(root, additionalRoots).some((protectedRoot) => within(protectedRoot, target));
}

function scopeIntersectsRoot(scope: ScopeEntry, root: string): boolean {
	return within(root, scope.path) || (scope.kind === "tree" && within(scope.path, root));
}

function relevantProtectedSourceRoots(sourceCwd: string, roots: readonly string[]): string[] {
	return [...new Set(roots.map((root) => canonicalPath(root)).filter((root) => within(sourceCwd, root) || within(root, sourceCwd)))];
}

function mappedProtectedWorkspaceRoots(sourceCwd: string, workspaceCwd: string, roots: readonly string[]): string[] {
	return [...new Set(roots.map((root) => within(sourceCwd, root) ? resolve(workspaceCwd, relative(sourceCwd, root)) : workspaceCwd))];
}

async function copyIfPresent(source: string, target: string): Promise<void> {
	if (!existsSync(source)) return;
	await mkdir(dirname(target), { recursive: true });
	await cp(source, target, { recursive: true, force: true, preserveTimestamps: true });
}

const GRAPH_GUARD_PATH = fileURLToPath(new URL("../extensions/pi-graph-guard.ts", import.meta.url));

interface MaterializedAgent {
	name: string;
	filePath?: string;
	subagentOnlyExtensions?: string[];
	[key: string]: unknown;
}

let agentInternals: Promise<{
	discoverAgents(cwd: string, scope: "both"): { agents: MaterializedAgent[] };
	serializeAgent(agent: MaterializedAgent): string;
}> | undefined;

async function loadAgentInternals() {
	if (agentInternals) return agentInternals;
	agentInternals = (async () => {
		const require = createRequire(import.meta.url);
		const entry = require.resolve("pi-subagents");
		const packageRoot = dirname(entry);
		const jiti = createJiti(import.meta.url);
		const [agentsModule, serializerModule] = await Promise.all([
			jiti.import(join(packageRoot, "src", "agents", "agents.ts")),
			jiti.import(join(packageRoot, "src", "agents", "agent-serializer.ts")),
		]);
		const agents = agentsModule as { discoverAgents(cwd: string, scope: "both"): { agents: MaterializedAgent[] } };
		const serializer = serializerModule as { serializeAgent(agent: MaterializedAgent): string };
		return {
			discoverAgents: agents.discoverAgents,
			serializeAgent: serializer.serializeAgent,
		};
	})();
	return agentInternals;
}

async function prepareProjectAgent(sourceCwd: string, workspaceCwd: string, agentName: string): Promise<void> {
	for (const directory of [join(sourceCwd, ".pi", "agents"), join(sourceCwd, ".agents")]) {
		if (existsSync(directory)) await rejectSymlinks(directory, "Project Agent definitions");
	}
	const internals = await loadAgentInternals();
	const discovered = internals.discoverAgents(sourceCwd, "both").agents.find((candidate) => candidate.name === agentName);
	const agent: MaterializedAgent = discovered ?? {
		name: agentName,
		description: `Graph-isolated execution role for ${agentName}.`,
		systemPrompt: "Complete the assigned graph node within its declared contract.",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
	};
	if (agent.filePath) {
		const info = await lstat(agent.filePath);
		if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error(`Project Agent definitions may not contain symlinks or multiply-linked files: ${agent.filePath}`);
	}
	const guarded: MaterializedAgent = {
		...agent,
		// An explicit array makes pi-subagents pass --no-extensions and then add
		// only the resolved runtime/configured paths. Without it, ambient host
		// Extensions remain eligible even though Graph injected its own guard.
		extensions: Array.isArray(agent.extensions) ? agent.extensions : [],
		subagentOnlyExtensions: [...new Set([...(agent.subagentOnlyExtensions ?? []), GRAPH_GUARD_PATH])],
	};
	const target = join(workspaceCwd, ".pi", "agents");
	await mkdir(target, { recursive: true });
	const sourceName = agent.filePath ? basename(agent.filePath) : `${agentName.replace(/[^A-Za-z0-9._-]/g, "_")}.md`;
	const fileName = sourceName.endsWith(".md") && !sourceName.endsWith(".chain.md")
		? sourceName
		: `${agentName.replace(/[^A-Za-z0-9._-]/g, "_")}.md`;
	await writeFile(join(target, fileName), internals.serializeAgent(guarded), "utf8");
}

async function filesUnder(path: string, excludedRoots: readonly string[] = []): Promise<string[]> {
	if (excludedRoots.some((root) => within(root, path))) return [];
	if (!existsSync(path)) return [];
	const info = await stat(path);
	if (!info.isDirectory()) return [path];
	const output: string[] = [];
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (excludedRoots.some((root) => within(root, child))) continue;
		if (isNestedProtectedControlPath(path, child)) continue;
		if (entry.isDirectory()) output.push(...await filesUnder(child, excludedRoots));
		else if (entry.isFile() || entry.isSymbolicLink()) output.push(child);
	}
	return output;
}

async function writeBaseline(scopes: ScopeEntry[], excludedRoots: readonly string[] = []): Promise<Record<string, string | null>> {
	const baseline: Record<string, string | null> = {};
	for (const scope of scopes) {
		if (excludedRoots.some((root) => within(root, scope.path))) continue;
		if (scope.kind === "file") {
			baseline[scope.path] = (await digestFile(scope.path)) ?? null;
			continue;
		}
		for (const path of await filesUnder(scope.path, excludedRoots)) baseline[path] = (await digestFile(path)) ?? null;
	}
	return baseline;
}

async function rejectSymlinks(path: string, label = "Graph scopes"): Promise<void> {
	if (!existsSync(path)) return;
	const info = await lstat(path);
	if (info.isSymbolicLink()) throw new Error(`${label} may not contain symlinks: ${path}`);
	if (info.isFile() && info.nlink > 1) throw new Error(`${label} may not contain multiply-linked files: ${path}`);
	if (!info.isDirectory()) return;
	for (const entry of await readdir(path)) await rejectSymlinks(join(path, entry), label);
}

async function assertSafeSourceTarget(root: string, path: string, protectedSourceRoots: readonly string[] = []): Promise<void> {
	if (!within(root, path)) throw new WorkspaceConflictError(`Graph source target escapes its declared cwd: ${path}`);
	if (isProtectedWorkspacePath(root, path, protectedSourceRoots)) throw new WorkspaceConflictError(`Graph source target enters a protected runtime or repository-control directory: ${path}`);
	let cursor = root;
	for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkspaceConflictError(`Graph source parent changed into a symlink or non-directory: ${cursor}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw error;
		}
	}
	let ancestor = dirname(path);
	while (true) {
		try {
			const [resolvedRoot, resolvedAncestor] = await Promise.all([realpath(root), realpath(ancestor)]);
			if (!within(resolvedRoot, resolvedAncestor)) throw new WorkspaceConflictError(`Graph source parent escapes its declared cwd through a symlink: ${path}`);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === root) throw error;
			ancestor = dirname(ancestor);
		}
	}
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new WorkspaceConflictError(`Graph source target is no longer a single regular file: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function digestFile(path: string): Promise<string | undefined> {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function mapScope(scope: ScopeEntry[], sourceCwd: string, workspaceCwd: string): ScopeEntry[] {
	return scope.map((entry) => {
		if (!within(sourceCwd, entry.path)) throw new Error(`Scope escapes source cwd: ${entry.path}`);
		return { ...entry, path: resolve(workspaceCwd, relative(sourceCwd, entry.path)) };
	});
}

function gitInfo(cwd: string): { root: string; relativeCwd: string } | null {
	const repository = gitRepositoryInfo(cwd);
	if (!repository) return null;
	const clean = spawnSync("git", ["-C", repository.root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
	if (clean.status !== 0 || clean.stdout.trim()) return null;
	return repository;
}

function gitRepositoryInfo(cwd: string): { root: string; relativeCwd: string } | null {
	const rootResult = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (rootResult.status !== 0) return null;
	const root = rootResult.stdout.trim();
	return { root, relativeCwd: relative(root, cwd) };
}

function sourceGitEvidence(sourceCwd: string, scopes: ScopeEntry[]): string {
	const repositories = new Map<string, Set<string>>();
	for (const scope of scopes) {
		const repository = gitRepositoryInfo(scope.kind === "file" ? dirname(scope.path) : scope.path);
		if (!repository) continue;
		const paths = repositories.get(repository.root) ?? new Set<string>();
		paths.add(relative(repository.root, scope.path) || ".");
		repositories.set(repository.root, paths);
	}
	const lines = ["PI_GRAPH_SOURCE_GIT_EVIDENCE_V2"];
	if (repositories.size === 0) lines.push("", "No Git repository was detected from the declared read/write scope entries.");
	for (const [root, scopedPaths] of [...repositories.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const paths = [...scopedPaths].sort();
		const options = { encoding: "utf8" as const, maxBuffer: 64 * 1024 * 1024 };
		const capture = () => {
			const gitDir = spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], options);
			const commonDir = spawnSync("git", ["-C", root, "rev-parse", "--git-common-dir"], options);
			const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], options);
			const branch = spawnSync("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], options);
			const status = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--", ...paths], options);
			for (const [label, result] of [["Git directory", gitDir], ["Git common directory", commonDir], ["scoped Git status", status]] as const) {
				if (result.status !== 0 || result.error) throw new Error(`Could not capture ${label} for '${root}': ${result.error?.message ?? result.stderr.trim()}`);
			}
			let diff = "[HEAD is unavailable; no tracked diff could be generated.]";
			if (head.status === 0 && !head.error) {
				const result = spawnSync("git", ["-C", root, "diff", "--no-ext-diff", "--no-color", "HEAD", "--", ...paths], options);
				if (result.status !== 0 || result.error) throw new Error(`Could not capture scoped Git diff for '${root}': ${result.error?.message ?? result.stderr.trim()}`);
				diff = result.stdout || "[No tracked changes in the declared scope.]";
			}
			return {
				repositoryRoot: realpathSync(root),
				gitDir: realpathSync(gitDir.stdout.trim()),
				commonDir: realpathSync(resolve(root, commonDir.stdout.trim())),
				head: head.status === 0 ? head.stdout.trim() : "unborn",
				branch: branch.status === 0 ? branch.stdout.trim() : "detached-or-unborn",
				status: status.stdout || "[Clean in the declared scope.]",
				diff,
			};
		};
		let snapshot = capture();
		let stable = false;
		for (let retry = 0; retry < 3; retry += 1) {
			const confirmation = capture();
			if (JSON.stringify(snapshot) === JSON.stringify(confirmation)) {
				stable = true;
				break;
			}
			snapshot = confirmation;
		}
		if (!stable) throw new Error(`Scoped Git evidence for '${root}' did not remain stable while it was sampled.`);
		lines.push(
			"",
			`Repository: ${relative(sourceCwd, root) || "."}`,
			`Repository root identity: ${snapshot.repositoryRoot}`,
			`Git directory identity: ${snapshot.gitDir}`,
			`Git common directory identity: ${snapshot.commonDir}`,
			`Branch: ${snapshot.branch}`,
			`HEAD: ${snapshot.head}`,
			"Scoped paths:",
			...paths.map((path) => `- ${path}`),
			"Status:",
			snapshot.status,
			"Diff against HEAD:",
			snapshot.diff,
		);
	}
	return `${lines.join("\n")}\n`;
}

async function atomicCopy(source: string, target: string): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.pi-graph-${process.pid}-${randomUUID()}`;
	await cp(source, temp, { recursive: false, force: true, preserveTimestamps: true });
	await rename(temp, target);
}

interface ApplyPlanEntry {
	workspacePath?: string;
	sourcePath: string;
	before?: string;
	after?: string;
	deleted?: boolean;
	backupPath?: string;
	backupDigest?: string;
}

interface ApplyPlan {
	version: 1 | 2;
	graphId?: string;
	taskId?: string;
	attempt?: number;
	attemptDir?: string;
	contractDigest?: string;
	status: "prepared" | "applying" | "committed" | "rolled_back";
	applyingIndex?: number;
	entries: ApplyPlanEntry[];
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path);
	const parent = await open(dirname(path), "r");
	try { await parent.sync(); } finally { await parent.close(); }
}

async function readApplyPlan(path: string): Promise<ApplyPlan | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as ApplyPlan;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function scopeContains(scope: ScopeEntry, path: string): boolean {
	return scope.kind === "file" ? scope.path === path : within(scope.path, path);
}

function contractDigest(contract: NodeContract): string {
	return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function validDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validateApplyPlan(plan: ApplyPlan, node: CompiledNode, workspaceCwd: string, contract: NodeContract, planPath: string): void {
	if (![1, 2].includes(plan.version) || !["prepared", "applying", "committed", "rolled_back"].includes(plan.status) || !Array.isArray(plan.entries)) throw new Error(`Invalid graph apply plan: ${planPath}`);
	if (plan.version === 2 && (plan.graphId !== contract.graphId || plan.taskId !== contract.taskId || plan.attempt !== contract.attempt || plan.attemptDir !== contract.attemptDir || plan.contractDigest !== contractDigest(contract))) throw new Error(`Invalid graph apply plan identity: ${planPath}`);
	if (plan.applyingIndex !== undefined && (!Number.isInteger(plan.applyingIndex) || plan.applyingIndex < 0 || plan.applyingIndex >= plan.entries.length)) throw new Error(`Invalid graph apply index: ${planPath}`);
	const seen = new Set<string>();
	for (const entry of plan.entries) {
		if (!entry || typeof entry.sourcePath !== "string" || !isAbsolute(entry.sourcePath) || isProtectedWorkspacePath(node.cwd, entry.sourcePath, contract.protectedSourceRoots) || !node.writeScope.some((scope) => scopeContains(scope, entry.sourcePath)) || seen.has(entry.sourcePath)) throw new Error(`Invalid graph apply target: ${planPath}`);
		seen.add(entry.sourcePath);
		if (entry.workspacePath !== undefined) {
			const expected = resolve(workspaceCwd, relative(node.cwd, entry.sourcePath));
			if (entry.workspacePath !== expected || !within(workspaceCwd, entry.workspacePath)) throw new Error(`Invalid graph apply source: ${planPath}`);
		}
		if (entry.backupPath !== undefined && !within(contract.attemptDir, entry.backupPath)) throw new Error(`Invalid graph apply backup: ${planPath}`);
		for (const digest of [entry.before, entry.after, entry.backupDigest]) if (digest !== undefined && !validDigest(digest)) throw new Error(`Invalid graph apply digest: ${planPath}`);
		if (plan.version === 2 && entry.before && (!entry.backupPath || !entry.backupDigest)) throw new Error(`Invalid graph apply backup metadata: ${planPath}`);
	}
}

function planDigests(plan: ApplyPlan): FileDigest[] {
	return plan.entries.map((entry) => ({ path: entry.sourcePath, ...(entry.before ? { before: entry.before } : {}), ...(entry.after ? { after: entry.after } : {}), ...(entry.deleted ? { deleted: true } : {}) }));
}

async function assertSafeAttemptFile(attemptDir: string, path: string, label: string): Promise<void> {
	if (!within(attemptDir, path)) throw new WorkspaceConflictError(`${label} escapes the graph attempt directory: ${path}`);
	const [resolvedAttempt, resolvedParent] = await Promise.all([realpath(attemptDir), realpath(dirname(path))]);
	if (!within(resolvedAttempt, resolvedParent)) throw new WorkspaceConflictError(`${label} parent escapes through a symlink: ${path}`);
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new WorkspaceConflictError(`${label} is not a single regular file: ${path}`);
}

async function recoverApplyPlan(path: string, plan: ApplyPlan, node: CompiledNode, contract: NodeContract): Promise<FileDigest[] | null> {
	const observed = await Promise.all(plan.entries.map(async (entry) => {
		await assertSafeSourceTarget(node.cwd, entry.sourcePath, contract.protectedSourceRoots);
		const current = await digestFile(entry.sourcePath);
		const after = entry.deleted ? undefined : entry.after;
		if (current === entry.before) return "before" as const;
		if (current === after) return "after" as const;
		return "conflict" as const;
	}));
	if (observed.includes("conflict")) {
		const index = observed.indexOf("conflict");
		throw new WorkspaceConflictError(`Cannot recover graph write because the source has a third digest: ${plan.entries[index]!.sourcePath}`);
	}
	if (observed.every((state) => state === "after")) {
		plan.status = "committed";
		await atomicJson(path, plan);
		return planDigests(plan);
	}
	if (plan.status === "committed") throw new WorkspaceConflictError("Committed graph apply plan is not fully present on disk.");
	if (observed.every((state) => state === "before")) {
		if (plan.status === "applying") {
			plan.status = "rolled_back";
			await atomicJson(path, plan);
		}
		return null;
	}
	if (plan.status !== "applying") throw new WorkspaceConflictError("Graph apply plan and source files disagree before commit.");

	const restore = plan.entries.map((entry, index) => ({ entry, state: observed[index]! })).filter((item) => item.state === "after");
	for (const { entry } of restore) {
		if (!entry.before) continue;
		if (!entry.backupPath) throw new WorkspaceConflictError(`Cannot roll back graph write without its backup: ${entry.sourcePath}`);
		await assertSafeAttemptFile(contract.attemptDir, entry.backupPath, "Graph write backup");
		const backup = await digestFile(entry.backupPath);
		const expectedBackup = entry.backupDigest ?? entry.before;
		if (backup !== expectedBackup || backup !== entry.before) throw new WorkspaceConflictError(`Cannot roll back graph write with an invalid backup: ${entry.sourcePath}`);
	}
	for (const { entry } of restore.reverse()) {
		await assertSafeSourceTarget(node.cwd, entry.sourcePath, contract.protectedSourceRoots);
		if (entry.before) await atomicCopy(entry.backupPath!, entry.sourcePath);
		else await rm(entry.sourcePath, { force: true });
	}
	for (const entry of plan.entries) {
		await assertSafeSourceTarget(node.cwd, entry.sourcePath, contract.protectedSourceRoots);
		if (await digestFile(entry.sourcePath) !== entry.before) throw new WorkspaceConflictError(`Graph write rollback could not restore: ${entry.sourcePath}`);
	}
	plan.status = "rolled_back";
	await atomicJson(path, plan);
	return null;
}

async function assertBaselineUnchanged(scopes: ScopeEntry[], baseline: Record<string, string | null>, label: string): Promise<void> {
	const current = await writeBaseline(scopes);
	const paths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
	for (const path of paths) if ((current[path] ?? null) !== (baseline[path] ?? null)) throw new WorkspaceConflictError(`${label} changed while node was running: ${path}`);
}

async function assertInputsUnchanged(contract: NodeContract): Promise<void> {
	await assertBaselineUnchanged(contract.readScope.map((entry) => ({ ...entry, path: resolve(contract.sourceCwd, relative(contract.workspaceCwd, entry.path)) })).filter((entry) => within(contract.sourceCwd, entry.path)), contract.readBaseline, "Read source");
	for (const [name, input] of Object.entries(contract.inputBaseline)) {
		if ((await digestFile(input.sourcePath) ?? null) !== input.digest) throw new WorkspaceConflictError(`Input artifact changed while node was running: ${name}`);
	}
	if (contract.sourceGitEvidence) {
		const current = sourceGitEvidence(contract.sourceCwd, contract.sourceGitEvidence.sourceReadScope);
		const digest = createHash("sha256").update(current).digest("hex");
		if (digest !== contract.sourceGitEvidence.digest) throw new WorkspaceConflictError("Scoped Git HEAD, index, or working-tree evidence changed while node was running.");
	}
}

async function inspectWorkspaceWrites(node: CompiledNode, workspaceCwd: string, workspaceContract: NodeContract): Promise<FileDigest[]> {
	const entries = new Map<string, FileDigest>();
	const protectedRoots = protectedWorkspaceRoots(workspaceCwd, workspaceContract.protectedWorkspaceRoots);
	for (const scope of node.writeScope) {
		const workspacePath = resolve(workspaceCwd, relative(node.cwd, scope.path));
		for (const workspaceFile of await filesUnder(workspacePath, protectedRoots)) {
			if ((await lstat(workspaceFile)).isSymbolicLink()) continue;
			const sourcePath = resolve(scope.path, scope.kind === "tree" ? relative(workspacePath, workspaceFile) : "");
			const before = workspaceContract.writeBaseline[sourcePath] ?? undefined;
			const after = await digestFile(workspaceFile);
			if (before !== after) entries.set(sourcePath, { path: sourcePath, before, after });
		}
		if (!node.allowDelete) continue;
		for (const [sourcePath, before] of Object.entries(workspaceContract.writeBaseline)) {
			if (!scopeContains(scope, sourcePath)) continue;
			const workspaceFile = resolve(workspacePath, scope.kind === "tree" ? relative(scope.path, sourcePath) : "");
			if (!existsSync(workspaceFile)) entries.set(sourcePath, { path: sourcePath, before: before ?? undefined, deleted: true });
		}
	}
	return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function applyScopes(node: CompiledNode, workspaceCwd: string, workspaceContract: NodeContract, signal?: AbortSignal): Promise<FileDigest[]> {
	const planPath = join(workspaceContract.attemptDir, "apply-plan.json");
	const prior = await readApplyPlan(planPath);
	if (prior) {
		validateApplyPlan(prior, node, workspaceCwd, workspaceContract, planPath);
		const recovered = await recoverApplyPlan(planPath, prior, node, workspaceContract);
		if (recovered) return recovered;
	}
	if (signal?.aborted) throw new Error("Graph source apply aborted before commit.");
	await assertInputsUnchanged(workspaceContract);
	const entries = new Map<string, ApplyPlanEntry>();
	const protectedWorkspace = protectedWorkspaceRoots(workspaceCwd, workspaceContract.protectedWorkspaceRoots);
	const protectedSource = protectedWorkspaceRoots(node.cwd, workspaceContract.protectedSourceRoots);
	for (const scope of node.writeScope) {
		const workspacePath = resolve(workspaceCwd, relative(node.cwd, scope.path));
		const workspaceFiles = await filesUnder(workspacePath, protectedWorkspace);
		for (const sourceFile of workspaceFiles) {
			const sourcePath = resolve(scope.path, scope.kind === "tree" ? relative(workspacePath, sourceFile) : "");
			await assertSafeSourceTarget(node.cwd, sourcePath, workspaceContract.protectedSourceRoots);
			if ((await lstat(sourceFile)).isSymbolicLink()) throw new WorkspaceConflictError(`Refusing to apply a symlink from graph workspace: ${sourceFile}`);
			const before = await digestFile(sourcePath);
			const after = await digestFile(sourceFile);
			const expected = workspaceContract.writeBaseline[sourcePath] ?? null;
			if (before === after) {
				if ((expected ?? undefined) !== after) entries.set(sourcePath, { sourcePath, workspacePath: sourceFile, before: expected ?? undefined, after });
				continue;
			}
			if ((before ?? null) !== expected) throw new WorkspaceConflictError(`Source changed while node was running: ${sourcePath}`);
			if (existsSync(sourcePath) && (await lstat(sourcePath)).isSymbolicLink()) throw new WorkspaceConflictError(`Refusing to replace a source symlink: ${sourcePath}`);
			entries.set(sourcePath, { sourcePath, workspacePath: sourceFile, before, after });
		}
		if (!node.allowDelete || !existsSync(scope.path)) continue;
		for (const sourceFile of await filesUnder(scope.path, protectedSource)) {
			const workspaceFile = resolve(workspacePath, scope.kind === "tree" ? relative(scope.path, sourceFile) : "");
			if (existsSync(workspaceFile)) continue;
			await assertSafeSourceTarget(node.cwd, sourceFile, workspaceContract.protectedSourceRoots);
			const before = await digestFile(sourceFile);
			const expected = workspaceContract.writeBaseline[sourceFile] ?? null;
			if ((before ?? null) !== expected) throw new WorkspaceConflictError(`Source changed while node was running: ${sourceFile}`);
			if ((await lstat(sourceFile)).isSymbolicLink()) throw new WorkspaceConflictError(`Refusing to delete a source symlink: ${sourceFile}`);
			entries.set(sourceFile, { sourcePath: sourceFile, before, deleted: true });
		}
	}
	const plan: ApplyPlan = {
		version: 2,
		graphId: workspaceContract.graphId,
		taskId: workspaceContract.taskId,
		attempt: workspaceContract.attempt,
		attemptDir: workspaceContract.attemptDir,
		contractDigest: contractDigest(workspaceContract),
		status: "prepared",
		entries: [...entries.values()],
	};
	const backupDir = join(workspaceContract.attemptDir, "apply-backups");
	for (let index = 0; index < plan.entries.length; index += 1) {
		const entry = plan.entries[index]!;
		if (!entry.before || !existsSync(entry.sourcePath)) continue;
		const backupPath = join(backupDir, `${index}-${createHash("sha256").update(entry.sourcePath).digest("hex").slice(0, 12)}.bak`);
		await atomicCopy(entry.sourcePath, backupPath);
		entry.backupPath = backupPath;
		entry.backupDigest = await digestFile(backupPath);
		if (entry.backupDigest !== entry.before) throw new WorkspaceConflictError(`Graph write backup did not match its source: ${entry.sourcePath}`);
	}
	await atomicJson(planPath, plan);
	if (signal?.aborted) throw new Error("Graph source apply aborted before commit.");
	plan.status = "applying";
	await atomicJson(planPath, plan);
	try {
		for (let index = 0; index < plan.entries.length; index += 1) {
			if (signal?.aborted) throw new Error("Graph source apply aborted during commit.");
			const entry = plan.entries[index]!;
			await assertSafeSourceTarget(node.cwd, entry.sourcePath, workspaceContract.protectedSourceRoots);
				const current = await digestFile(entry.sourcePath);
				if (current !== entry.before) throw new WorkspaceConflictError(`Source changed immediately before graph commit: ${entry.sourcePath}`);
			plan.applyingIndex = index;
			await atomicJson(planPath, plan);
			if (entry.deleted) await rm(entry.sourcePath, { force: true });
			else if (entry.workspacePath) await atomicCopy(entry.workspacePath, entry.sourcePath);
			if (signal?.aborted) {
				const recovered = await recoverApplyPlan(planPath, plan, node, workspaceContract);
				if (recovered) return recovered;
				throw new Error("Graph source apply aborted during commit.");
			}
		}
		plan.status = "committed";
		await atomicJson(planPath, plan);
		return planDigests(plan);
	} catch (error) {
		const recovered = await recoverApplyPlan(planPath, plan, node, workspaceContract);
		if (recovered) return recovered;
		throw error;
	}
}

export async function prepareWorkspace(input: {
	graphId: string;
	node: CompiledNode;
	attempt: number;
	attemptDir: string;
	strategy: "auto" | "shadow" | "git";
	protectedSourceRoots?: string[];
	contextDigest?: string;
	artifacts?: Array<{ name: string; source: string }>;
}): Promise<PreparedWorkspace> {
	const { graphId, node, attempt, attemptDir } = input;
	const protectedSourceRoots = relevantProtectedSourceRoots(node.cwd, input.protectedSourceRoots ?? []);
	for (const scope of [...node.readScope, ...node.writeScope]) {
		const protectedRoot = protectedSourceRoots.find((root) => scopeIntersectsRoot(scope, root));
		if (protectedRoot) throw new WorkspaceConflictError(`Graph scope intersects protected Graph runs root: ${protectedRoot}`);
	}
	await mkdir(attemptDir, { recursive: true });
	for (const scope of [...node.readScope, ...node.writeScope]) await rejectSymlinks(scope.path);
	const baseline = await writeBaseline(node.writeScope, protectedWorkspaceRoots(node.cwd, protectedSourceRoots));
	const readBaseline = await writeBaseline(node.readScope, protectedSourceRoots);
	const forceShadowForRetry = (node.retryPolicy.maxProviderRetries ?? 0) > 0;
	const git = input.strategy !== "shadow" && !(input.strategy === "auto" && (node.routingProfile || forceShadowForRetry)) ? gitInfo(node.cwd) : null;
	let kind: "shadow" | "git" = "shadow";
	let workspaceCwd = join(attemptDir, "workspace");
	let gitWorktreeRoot: string | undefined;
	if (input.strategy === "git" && !git) throw new Error("Git workspace requested, but repository is not clean or cwd is not in Git.");
	if (git) {
		kind = "git";
		gitWorktreeRoot = join(attemptDir, "worktree");
		const result = spawnSync("git", ["-C", git.root, "worktree", "add", "--detach", gitWorktreeRoot, "HEAD"], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git worktree add failed: ${result.stderr.trim()}`);
		workspaceCwd = resolve(gitWorktreeRoot, git.relativeCwd);
	} else {
		await mkdir(workspaceCwd, { recursive: true });
		const sources = [...node.readScope, ...node.writeScope];
		const copied = new Set<string>();
		for (const entry of sources) {
			if (copied.has(entry.path)) continue;
			copied.add(entry.path);
			await copyIfPresent(entry.path, resolve(workspaceCwd, relative(node.cwd, entry.path)));
		}
	}
	await rm(join(workspaceCwd, ".pi-graph"), { recursive: true, force: true });
	await rm(join(workspaceCwd, ".pi", "agents"), { recursive: true, force: true });
	await rm(join(workspaceCwd, ".pi-subagents"), { recursive: true, force: true });
	if (kind === "shadow") await rm(join(workspaceCwd, ".git"), { recursive: true, force: true });
	await prepareProjectAgent(node.cwd, workspaceCwd, node.agent);
	const artifactPaths: Record<string, string> = {};
	const inputBaseline: NodeContract["inputBaseline"] = {};
	for (const artifact of input.artifacts ?? []) {
		if (!existsSync(artifact.source)) throw new Error(`Required graph input artifact disappeared before workspace preparation: ${artifact.name}`);
		const sourceInfo = await lstat(artifact.source);
		if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error(`Graph input artifact must be a regular file: ${artifact.name}`);
		const target = join(workspaceCwd, ".pi-graph", "inputs", artifact.name);
		await copyIfPresent(artifact.source, target);
		artifactPaths[artifact.name] = target;
		inputBaseline[artifact.name] = { sourcePath: artifact.source, digest: await digestFile(artifact.source) ?? null };
	}
	const sourceEvidencePath = join(workspaceCwd, ".pi-graph", "source-git-evidence.txt");
	const evidenceScopes = [...node.readScope, ...node.writeScope].filter((entry, index, entries) => entries.findIndex((candidate) => candidate.kind === entry.kind && candidate.path === entry.path) === index);
	const sourceEvidence = sourceGitEvidence(node.cwd, evidenceScopes);
	await mkdir(dirname(sourceEvidencePath), { recursive: true });
	await writeFile(sourceEvidencePath, sourceEvidence, "utf8");
	const sourceEvidenceDigest = createHash("sha256").update(sourceEvidence).digest("hex");
	const protectedWorkspace = mappedProtectedWorkspaceRoots(node.cwd, workspaceCwd, protectedSourceRoots);
	const contract: NodeContract = {
		schemaVersion: 1,
		graphId,
		taskId: node.taskId,
		attempt,
		attemptDir,
		sourceCwd: node.cwd,
		workspaceCwd,
		readScope: [
			...mapScope(node.readScope, node.cwd, workspaceCwd),
			...Object.values(artifactPaths).map((path) => ({ kind: "file" as const, path })),
			{ kind: "file", path: sourceEvidencePath },
			...(input.attempt > 1 ? [{ kind: "file" as const, path: join(workspaceCwd, ".pi-graph", "recovery-handoff.md") }] : []),
		],
		writeScope: mapScope(node.writeScope, node.cwd, workspaceCwd),
		sideEffect: node.sideEffect,
		resourceScopes: node.resourceScopes,
		externalAction: node.externalAction,
		allowBash: node.allowBash === true,
		writeBaseline: baseline,
		readBaseline,
		...(protectedSourceRoots.length ? { protectedSourceRoots, protectedWorkspaceRoots: protectedWorkspace } : {}),
		inputBaseline,
		sourceGitEvidence: { path: sourceEvidencePath, digest: sourceEvidenceDigest, sourceReadScope: evidenceScopes },
		...(git ? { gitRoot: git.root } : {}),
		...(gitWorktreeRoot ? { gitWorktreeRoot } : {}),
		...(input.contextDigest ? { contextDigest: input.contextDigest } : {}),
	};
	await mkdir(join(workspaceCwd, ".pi-graph"), { recursive: true });
	await writeFile(join(workspaceCwd, ".pi-graph", "node-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
	return {
		kind,
		cwd: workspaceCwd,
		contract,
		artifactPaths,
		sourceGitEvidencePath: sourceEvidencePath,
		inspectWrites: () => inspectWorkspaceWrites(node, workspaceCwd, contract),
		apply: (signal) => applyScopes(node, workspaceCwd, contract, signal),
		cleanup: async () => {
			if (gitWorktreeRoot && git) {
				spawnSync("git", ["-C", git.root, "worktree", "remove", "--force", gitWorktreeRoot], { encoding: "utf8" });
			}
		},
	};
}

export async function reopenWorkspace(node: CompiledNode, workspaceCwd: string, kind: "shadow" | "git", protectedRoots: readonly string[] = []): Promise<PreparedWorkspace> {
	const contract = JSON.parse(await readFile(join(workspaceCwd, ".pi-graph", "node-contract.json"), "utf8")) as NodeContract;
	const graphRoot = isAbsolute(contract.attemptDir ?? "") ? dirname(dirname(dirname(contract.attemptDir))) : "";
	if (contract.schemaVersion !== 1 || contract.graphId !== basename(graphRoot) || contract.taskId !== node.taskId || !Number.isInteger(contract.attempt) || contract.attempt < 1 || contract.attemptDir !== join(graphRoot, "nodes", node.taskId, `attempt-${contract.attempt}`) || contract.sourceCwd !== node.cwd || contract.workspaceCwd !== workspaceCwd || !isAbsolute(contract.attemptDir) || !within(contract.attemptDir, workspaceCwd)) throw new Error("Persisted graph node contract does not match the recovered node.");
	const expectedWriteScope = mapScope(node.writeScope, node.cwd, workspaceCwd);
	if (JSON.stringify(contract.writeScope) !== JSON.stringify(expectedWriteScope)) throw new Error("Persisted graph node contract has a modified write scope.");
	const expectedProtectedSourceRoots = relevantProtectedSourceRoots(node.cwd, protectedRoots);
	const expectedProtectedWorkspaceRoots = mappedProtectedWorkspaceRoots(node.cwd, workspaceCwd, expectedProtectedSourceRoots);
	if (JSON.stringify(contract.protectedSourceRoots ?? []) !== JSON.stringify(expectedProtectedSourceRoots) || JSON.stringify(contract.protectedWorkspaceRoots ?? []) !== JSON.stringify(expectedProtectedWorkspaceRoots)) throw new Error("Persisted graph node contract has modified protected Graph runs roots.");
	if (contract.sideEffect !== undefined && contract.sideEffect !== node.sideEffect) throw new Error("Persisted graph node contract has a modified side effect.");
	if (JSON.stringify(contract.resourceScopes ?? []) !== JSON.stringify(node.resourceScopes ?? [])) throw new Error("Persisted graph node contract has modified remote resource scopes.");
	if (JSON.stringify(contract.externalAction ?? null) !== JSON.stringify(node.externalAction ?? null)) throw new Error("Persisted graph node contract has a modified external action.");
	const expectedArtifactPaths = Object.fromEntries((node.inputArtifacts ?? []).map((name) => [name, join(workspaceCwd, ".pi-graph", "inputs", name)]));
	const sourceEvidencePath = join(workspaceCwd, ".pi-graph", "source-git-evidence.txt");
	const expectedReadScope = [...mapScope(node.readScope, node.cwd, workspaceCwd), ...Object.values(expectedArtifactPaths).map((path) => ({ kind: "file" as const, path })), ...(contract.sourceGitEvidence ? [{ kind: "file" as const, path: sourceEvidencePath }] : []), ...(contract.attempt > 1 ? [{ kind: "file" as const, path: join(workspaceCwd, ".pi-graph", "recovery-handoff.md") }] : [])];
	if (!Array.isArray(contract.readScope) || JSON.stringify(contract.readScope) !== JSON.stringify(expectedReadScope)) throw new Error("Persisted graph node contract has a modified read scope.");
	if (contract.sourceGitEvidence) {
		const evidenceScopes = [...node.readScope, ...node.writeScope].filter((entry, index, entries) => entries.findIndex((candidate) => candidate.kind === entry.kind && candidate.path === entry.path) === index);
		const persistedScopes = JSON.stringify(contract.sourceGitEvidence.sourceReadScope);
		if (contract.sourceGitEvidence.path !== sourceEvidencePath || !validDigest(contract.sourceGitEvidence.digest) || (persistedScopes !== JSON.stringify(node.readScope) && persistedScopes !== JSON.stringify(evidenceScopes)) || await digestFile(sourceEvidencePath) !== contract.sourceGitEvidence.digest) throw new Error("Persisted graph node contract has invalid source Git evidence.");
	}
	if (!contract.writeBaseline || typeof contract.writeBaseline !== "object" || Array.isArray(contract.writeBaseline) || Object.entries(contract.writeBaseline).some(([path, digest]) => !node.writeScope.some((scope) => scopeContains(scope, path)) || (digest !== null && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))))) throw new Error("Persisted graph node contract has an invalid write baseline.");
	if (!contract.readBaseline || typeof contract.readBaseline !== "object" || Array.isArray(contract.readBaseline) || Object.entries(contract.readBaseline).some(([path, digest]) => !node.readScope.some((scope) => scopeContains(scope, path)) || (digest !== null && !validDigest(digest)))) throw new Error("Persisted graph node contract has an invalid read baseline.");
	const expectedInputNames = [...(node.inputArtifacts ?? [])].sort();
	if (!contract.inputBaseline || typeof contract.inputBaseline !== "object" || Array.isArray(contract.inputBaseline) || JSON.stringify(Object.keys(contract.inputBaseline).sort()) !== JSON.stringify(expectedInputNames) || Object.entries(contract.inputBaseline).some(([name, input]) => !input || input.sourcePath !== join(graphRoot, "artifacts", name) || (input.digest !== null && !validDigest(input.digest)))) throw new Error("Persisted graph node contract has an invalid input baseline.");
	const artifactPaths = expectedArtifactPaths;
	return {
		kind,
		cwd: workspaceCwd,
		contract,
		artifactPaths,
		...(contract.sourceGitEvidence ? { sourceGitEvidencePath: sourceEvidencePath } : {}),
		inspectWrites: () => inspectWorkspaceWrites(node, workspaceCwd, contract),
		apply: (signal) => applyScopes(node, workspaceCwd, contract, signal),
		cleanup: async () => {
			if (kind !== "git") return;
			const repositoryRoot = gitRepositoryInfo(node.cwd)?.root;
			const worktreeRoot = contract.gitWorktreeRoot;
			if (!repositoryRoot || !worktreeRoot) return;
			if (!within(contract.attemptDir, worktreeRoot) || !within(worktreeRoot, workspaceCwd)) {
				throw new Error("Persisted Git worktree metadata escapes the graph attempt directory.");
			}
			const result = spawnSync("git", ["-C", repositoryRoot, "worktree", "remove", "--force", worktreeRoot], { encoding: "utf8" });
			if (result.status !== 0 && existsSync(worktreeRoot)) throw new Error(`git worktree remove failed: ${result.stderr.trim()}`);
		},
	};
}
