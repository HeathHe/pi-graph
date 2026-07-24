import type { Dirent } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectClaimsReadOnly } from "./claims.ts";
import { loadValidatedRun } from "./reconciler.ts";
import { inspectSourceReservations } from "./reservations.ts";
import { GraphStore } from "./store.ts";
import { listInitializationStaging, listTrashInventory } from "./retention.ts";

export interface DoctorRun {
	graphId: string;
	status: "ok" | "protected";
	schemaVersion?: 1 | 2;
	executionStatus?: string;
	issues: string[];
}

export interface DoctorReport {
	checkedAt: string;
	runsRoot: string;
	ok: number;
	protected: number;
	runs: DoctorRun[];
	trashProtected: Array<{ trashId: string; reason: string }>;
	controlProtected: Array<{ path: string; reason: string }>;
}

interface ControlIssue {
	path: string;
	reason: string;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const output = new Array<R>(items.length);
	let cursor = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			output[index] = await worker(items[index]!);
		}
	}));
	return output;
}

async function inspectGraphLockEntry(runsRoot: string, root: string, entry: Dirent): Promise<ControlIssue[]> {
	const output: ControlIssue[] = [];
	const graphRoot = join(root, entry.name);
	let missingPublishedGraph = false;
	let hasLiveClaim = false;
	if (entry.isSymbolicLink() || !entry.isDirectory()) {
		return [{ path: `.control/graph-locks/${entry.name}`, reason: "graph lock entry is a symbolic link or non-directory" }];
	}
	try {
		await lstat(join(runsRoot, entry.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			missingPublishedGraph = true;
		} else {
			output.push({ path: `.control/graph-locks/${entry.name}`, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	try {
		const generationPath = join(graphRoot, "generation.json");
		const generationInfo = await lstat(generationPath);
		if (generationInfo.isSymbolicLink() || !generationInfo.isFile() || generationInfo.nlink > 1) throw new Error("fencing generation is not a single regular file");
		const generation = JSON.parse(await readFile(generationPath, "utf8")) as { version?: unknown; graphId?: unknown; generation?: unknown };
		if (
			generation.version !== 1
			|| (generation.graphId !== undefined && generation.graphId !== entry.name)
			|| !Number.isSafeInteger(generation.generation)
			|| (generation.generation as number) < 0
		) throw new Error("invalid fencing generation");
	} catch (error) {
		output.push({ path: `.control/graph-locks/${entry.name}/generation.json`, reason: error instanceof Error ? error.message : String(error) });
	}
	try {
		for (const child of await readdir(graphRoot)) {
			if (child.startsWith("generation.invalid-")) output.push({ path: `.control/graph-locks/${entry.name}/${child}`, reason: "recovered invalid fencing generation awaits maintenance cleanup" });
		}
	} catch (error) {
		output.push({ path: `.control/graph-locks/${entry.name}`, reason: error instanceof Error ? error.message : String(error) });
		return output;
	}
	const claims = join(graphRoot, "claims");
	try {
		const claimInfo = await lstat(claims);
		if (claimInfo.isSymbolicLink() || !claimInfo.isDirectory()) {
			output.push({ path: `.control/graph-locks/${entry.name}/claims`, reason: "graph claim path is a symbolic link or non-directory" });
		} else {
			for (const claim of await inspectClaimsReadOnly(claims)) {
				if (claim.status === "live") {
					hasLiveClaim = true;
					continue;
				}
				output.push({
					path: `.control/graph-locks/${entry.name}/claims/${claim.name}`,
					reason: `${claim.status} graph Supervisor claim: ${claim.reason}`,
				});
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") output.push({ path: `.control/graph-locks/${entry.name}/claims`, reason: error instanceof Error ? error.message : String(error) });
	}
	if (missingPublishedGraph && !hasLiveClaim) output.push({
		path: `.control/graph-locks/${entry.name}`,
		reason: "graph lock metadata has no published Graph and awaits maintenance cleanup",
	});
	return output;
}

async function inspectControlState(runsRoot: string): Promise<Array<{ path: string; reason: string }>> {
	const output: Array<{ path: string; reason: string }> = [];
	const controlRoot = join(runsRoot, ".control");
	try {
		const info = await lstat(controlRoot);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			return [{ path: ".control", reason: "control root is a symbolic link or non-directory" }];
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return output;
		return [{ path: ".control", reason: error instanceof Error ? error.message : String(error) }];
	}
	for (const name of ["graph-locks", "graph-lock-gate", "graph-lock-quarantine", "restore-transactions", "restore-quarantine", "purge-authorizations", "purge-staging", "purge-quarantine", "prune-plans", "source-reservations", "source-reservation-gate", "retention-lock"]) {
		const root = join(runsRoot, ".control", name);
		try {
			const info = await lstat(root);
			if (info.isSymbolicLink() || !info.isDirectory()) {
				output.push({ path: `.control/${name}`, reason: "control path is a symbolic link or non-directory" });
				continue;
			}
			const entries = await readdir(root, { withFileTypes: true });
			if (name === "graph-locks") {
				const issues = await mapWithConcurrency(entries, 32, (entry) => inspectGraphLockEntry(runsRoot, root, entry));
				for (const entryIssues of issues) output.push(...entryIssues);
			} else if (["graph-lock-quarantine", "restore-transactions", "restore-quarantine", "purge-authorizations", "purge-staging", "purge-quarantine"].includes(name)) {
				for (const entry of entries) output.push({
					path: `.control/${name}/${entry.name}`,
					reason: name === "graph-lock-quarantine"
						? "detached orphan Graph lock metadata awaits maintenance cleanup"
						: name === "purge-staging"
							? "pending or orphan purge staging; inspect /graphs storage"
							: name === "purge-quarantine"
								? "invalid purge authorization quarantined by an explicit discard"
								: name === "restore-quarantine"
									? "invalid restore transaction metadata is isolated"
									: "pending retention recovery",
				});
			} else if (name === "retention-lock" || name === "graph-lock-gate" || name === "source-reservation-gate") {
				const claims = join(root, "claims");
				const label = name === "retention-lock"
					? "retention"
					: name === "graph-lock-gate"
						? "graph lock mutation"
						: "source reservation transaction";
				try {
					const claimInfo = await lstat(claims);
					if (claimInfo.isSymbolicLink() || !claimInfo.isDirectory()) output.push({ path: `.control/${name}/claims`, reason: `${label} claim path is a symbolic link or non-directory` });
					else {
						for (const claim of await inspectClaimsReadOnly(claims)) {
							if (claim.status === "live") continue;
							output.push({
								path: `.control/${name}/claims/${claim.name}`,
								reason: `${claim.status} ${label} claim: ${claim.reason}`,
							});
						}
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") output.push({ path: `.control/${name}/claims`, reason: error instanceof Error ? error.message : String(error) });
				}
			} else if (name === "source-reservations") {
				for (const issue of await inspectSourceReservations(join(runsRoot, ".control"))) {
					output.push({
						path: `.control/source-reservations/${issue.path}`,
						reason: issue.reason,
					});
				}
			} else {
				for (const entry of entries) {
					if (entry.isSymbolicLink()) output.push({ path: `.control/${name}/${entry.name}`, reason: "control entry is a symbolic link" });
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") output.push({ path: `.control/${name}`, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return output;
}

export async function doctorGraphRuns(runsRoot: string, maxSpawnBudget = 20): Promise<DoctorReport> {
	const names = (await GraphStore.discover(runsRoot)).sort();
	const runs = await mapWithConcurrency(names, 16, async (graphId): Promise<DoctorRun> => {
		const issues: string[] = [];
		let schemaVersion: 1 | 2 | undefined;
		let executionStatus: string | undefined;
		try {
			const store = new GraphStore(runsRoot, graphId);
			const { snapshot } = await loadValidatedRun(store, maxSpawnBudget);
			schemaVersion = snapshot.schemaVersion;
			executionStatus = snapshot.status;
			try {
				const staging = store.path(".compact-staging");
				const info = await lstat(staging);
				if (info.isSymbolicLink() || !info.isDirectory()) issues.push("Compaction staging root is a symbolic link or non-directory.");
				else for (const entry of await readdir(staging)) issues.push(`Pending compaction staging: ${entry}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push(error instanceof Error ? error.message : String(error));
			}
			for (const name of ["history-transaction.json"]) {
				try {
					await readFile(store.path(name), "utf8");
					issues.push(`Pending control transaction: ${name}`);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push(error instanceof Error ? error.message : String(error));
				}
			}
			for (const state of Object.values(snapshot.nodes)) {
				for (const attempt of state.attempts) {
					const path = store.path("nodes", state.taskId, `attempt-${attempt.attempt}`, "attempt-recovery.json");
					try {
						await readFile(path, "utf8");
						issues.push(`Pending attempt recovery: ${state.taskId}/${attempt.attempt}`);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push(error instanceof Error ? error.message : String(error));
					}
				}
			}
		} catch (error) {
			issues.push(error instanceof Error ? error.message : String(error));
		}
		return {
			graphId,
			status: issues.length ? "protected" : "ok",
			...(schemaVersion ? { schemaVersion } : {}),
			...(executionStatus ? { executionStatus } : {}),
			issues,
		};
	});
	const [trashInventory, controlProtected, initializationStaging] = await Promise.all([
		listTrashInventory(runsRoot),
		inspectControlState(runsRoot),
		listInitializationStaging(runsRoot),
	]);
	const trashProtected = trashInventory.protected;
	for (const entry of initializationStaging) {
		controlProtected.push({
			path: entry.name,
			reason: `${entry.graphId ? `incomplete initialization for '${entry.graphId}'` : "invalid initialization staging"} awaits safe maintenance cleanup`,
		});
	}
	return {
		checkedAt: new Date().toISOString(),
		runsRoot,
		ok: runs.filter((run) => run.status === "ok").length,
		protected: runs.filter((run) => run.status === "protected").length,
		runs,
		trashProtected,
		controlProtected,
	};
}

export function formatDoctorReport(report: DoctorReport): string {
	const lines = [
		`Graph doctor: ${report.ok} evidence-valid, ${report.protected} protected, ${report.trashProtected.length} protected Trash, ${report.controlProtected.length} control issue(s)`,
		`Runs root: ${report.runsRoot}`,
	];
	for (const run of report.runs) {
		const identity = [run.executionStatus, run.schemaVersion ? `v${run.schemaVersion}` : undefined].filter(Boolean).join(", ");
		lines.push(`- ${run.graphId}: ${run.status}${identity ? ` (${identity})` : ""}${run.issues.length ? ` - ${run.issues.join("; ")}` : ""}`);
	}
	for (const entry of report.trashProtected) lines.push(`- Trash/${entry.trashId}: protected - ${entry.reason}`);
	for (const entry of report.controlProtected) lines.push(`- ${entry.path}: protected - ${entry.reason}`);
	return lines.join("\n");
}
