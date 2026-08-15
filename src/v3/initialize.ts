import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { authorizationV4For } from "./authorization.ts";
import { canonicalJson } from "./digests.ts";
import { GraphV3Error } from "./errors.ts";
import { graphSnapshotV3For } from "./snapshot.ts";
import type { AuthorizationV4, CompiledGraphV3, GraphSnapshotV3 } from "./types.ts";

export interface InitializeV3RunOptions {
	runDir: string;
	graph: CompiledGraphV3;
	sessionId: string;
	supervisorEpoch: string;
	runInstanceId?: string;
	createdAt?: string;
}

export interface InitializeV3RunResult {
	runDir: string;
	authorization: AuthorizationV4;
	snapshot: GraphSnapshotV3;
}

export interface V3InitializationDependencies {
	atomicRename?: (source: string, destination: string) => Promise<void>;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function durableWrite(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx" });
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function initializeV3Run(options: InitializeV3RunOptions, dependencies: V3InitializationDependencies = {}): Promise<InitializeV3RunResult> {
	const runDir = resolve(options.runDir);
	const parentDir = dirname(runDir);
	const runName = basename(runDir);
	if (!runName || runDir === parentDir) throw new GraphV3Error("INITIALIZATION_FAILED", "V3 runDir must identify a child directory.", { field: "runDir" });
	const createdAt = options.createdAt ?? new Date().toISOString();
	const runInstanceId = options.runInstanceId ?? randomUUID();
	const metadata = { runInstanceId, sessionId: options.sessionId, supervisorEpoch: options.supervisorEpoch, createdAt };
	const authorization = authorizationV4For(options.graph, metadata);
	const snapshot = graphSnapshotV3For(options.graph, metadata);
	const lockDir = join(parentDir, `.${runName}.initialize-lock`);
	let tempDir: string | undefined;
	let lockAcquired = false;
	let targetWasAbsent = false;
	try {
		await mkdir(parentDir, { recursive: true });
		if (await pathExists(runDir)) throw new GraphV3Error("RUN_ALREADY_EXISTS", `V3 run directory already exists: ${runDir}`, { details: { runDir } });
		try {
			await mkdir(lockDir);
			lockAcquired = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GraphV3Error("RUN_ALREADY_EXISTS", `V3 run initialization is already in progress: ${runDir}`, { details: { runDir }, cause: error });
			throw error;
		}
		if (await pathExists(runDir)) throw new GraphV3Error("RUN_ALREADY_EXISTS", `V3 run directory already exists: ${runDir}`, { details: { runDir } });
		targetWasAbsent = true;
		tempDir = await mkdtemp(join(parentDir, `.${runName}.tmp-`));
		await durableWrite(join(tempDir, "authorization.json"), authorization);
		await durableWrite(join(tempDir, "snapshot.json"), snapshot);
		await syncDirectory(tempDir);
		await (dependencies.atomicRename ?? rename)(tempDir, runDir);
		tempDir = undefined;
		return { runDir, authorization, snapshot };
	} catch (error) {
		if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		if (targetWasAbsent) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
		if (error instanceof GraphV3Error) throw error;
		throw new GraphV3Error("INITIALIZATION_FAILED", `Failed to initialize V3 run at ${runDir}: ${error instanceof Error ? error.message : String(error)}`, { details: { runDir }, cause: error });
	} finally {
		if (lockAcquired) await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
