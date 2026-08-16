import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "./digests.ts";
import { detectRunFormat } from "./format-detector.ts";
import { captureTrustedDirectoryAnchor, unsafeDirectoryComponent } from "./path-safety.ts";
import { resolveSourceIdentityV3 } from "./source-identity.ts";
import { verifyV3Run } from "./snapshot.ts";
import type { RunFormatDetection, SourceIdentityV3, V3RunInspection } from "./types.ts";

interface JsonReadResult {
	present: boolean;
	value?: unknown;
	issue?: string;
	observation?: FileObservation;
}

interface FileIdentity {
	dev: number;
	ino: number;
}

interface FileObservation extends FileIdentity {
	size: number;
	mtimeMs: number;
	contents: string;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameFileObservation(left: FileObservation | undefined, right: FileObservation | undefined): boolean {
	return left !== undefined
		&& right !== undefined
		&& sameIdentity(left, right)
		&& left.size === right.size
		&& left.mtimeMs === right.mtimeMs
		&& left.contents === right.contents;
}

export interface InspectV3RunOptions {
	trustedRoot: string;
	sourceCwd?: string;
}

export interface V3InspectionDependencies {
	sourceIdentityFor?: (sourceCwd: string) => Promise<SourceIdentityV3>;
}

async function readJsonFile(path: string, label: string): Promise<JsonReadResult> {
	let pathStat;
	try {
		pathStat = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, issue: `MISSING_FILE: ${label} is missing.` };
		return { present: false, issue: `READ_FAILED: ${label} could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (pathStat.isSymbolicLink() || !pathStat.isFile()) return { present: true, value: null, issue: `UNSAFE_FILE: ${label} must be a regular non-symbolic-link file.` };
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const openedStat = await handle.stat();
		if (!openedStat.isFile()) return { present: true, value: null, issue: `UNSAFE_FILE: ${label} changed to a non-regular file while being opened.` };
		if (!sameIdentity(pathStat, openedStat)) return { present: true, value: null, issue: `UNSAFE_FILE: ${label} changed identity while being opened.` };
		const contents = await handle.readFile("utf8");
		const [finishedStat, currentPathStat] = await Promise.all([handle.stat(), lstat(path)]);
		if (!sameIdentity(openedStat, finishedStat) || !sameIdentity(openedStat, currentPathStat) || finishedStat.size !== openedStat.size || finishedStat.mtimeMs !== openedStat.mtimeMs) {
			return { present: true, value: null, issue: `UNSAFE_FILE: ${label} changed while being read.` };
		}
		try {
			return {
				present: true,
				value: JSON.parse(contents) as unknown,
				observation: { dev: finishedStat.dev, ino: finishedStat.ino, size: finishedStat.size, mtimeMs: finishedStat.mtimeMs, contents },
			};
		} catch (error) {
			return { present: true, value: null, issue: `INVALID_JSON: ${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "EMLINK") return { present: true, value: null, issue: `UNSAFE_FILE: ${label} became a symbolic link while being opened.` };
		return { present: true, value: null, issue: `READ_FAILED: ${label} could not be read safely: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function basicMetadata(value: unknown): { graphId?: string; runInstanceId?: string; graphStatus?: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	return {
		...(typeof record.graphId === "string" ? { graphId: record.graphId } : {}),
		...(typeof record.runInstanceId === "string" ? { runInstanceId: record.runInstanceId } : {}),
		...(typeof record.status === "string" ? { graphStatus: record.status } : {}),
	};
}

function unsafeRunRoot(runDir: string, reason: string): V3RunInspection {
	const format: RunFormatDetection = { kind: "invalid", reason };
	return { status: "needs_attention", format, runDir, reasons: [reason] };
}

async function runBoundaryChanged(runDir: string, initialRunIdentity: FileIdentity, trustedAnchor: Awaited<ReturnType<typeof captureTrustedDirectoryAnchor>>): Promise<boolean> {
	const [currentRunStat, unsafeParent] = await Promise.all([
		lstat(runDir).catch(() => undefined),
		unsafeDirectoryComponent(dirname(runDir), trustedAnchor).catch(() => dirname(runDir)),
	]);
	return unsafeParent !== undefined
		|| currentRunStat === undefined
		|| currentRunStat.isSymbolicLink()
		|| !currentRunStat.isDirectory()
		|| !sameIdentity(initialRunIdentity, currentRunStat);
}

export async function inspectV3Run(runDirectory: string, options: InspectV3RunOptions, dependencies: V3InspectionDependencies = {}): Promise<V3RunInspection> {
	const runDir = resolve(runDirectory);
	const trustedRoot = options.trustedRoot;
	const sourceCwd = options.sourceCwd ?? process.cwd();
	const sourceIdentityFor = dependencies.sourceIdentityFor ?? resolveSourceIdentityV3;
	let trustedAnchor;
	try {
		trustedAnchor = await captureTrustedDirectoryAnchor(trustedRoot);
	} catch (error) {
		return unsafeRunRoot(runDir, `UNSAFE_TRUSTED_ROOT: ${error instanceof Error ? error.message : String(error)}`);
	}
	const unsafeParent = await unsafeDirectoryComponent(dirname(runDir), trustedAnchor).catch((error) => `inspection failed: ${error instanceof Error ? error.message : String(error)}`);
	if (unsafeParent) return unsafeRunRoot(runDir, `UNSAFE_RUN_PARENT: run parent path contains a symbolic link, non-directory, or unreadable component: ${unsafeParent}`);
	let runStat;
	try {
		runStat = await lstat(runDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return unsafeRunRoot(runDir, "MISSING_RUN_DIRECTORY: run directory is missing.");
		return unsafeRunRoot(runDir, `READ_FAILED: run directory could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (runStat.isSymbolicLink() || !runStat.isDirectory()) return unsafeRunRoot(runDir, "UNSAFE_RUN_DIRECTORY: run root must be a regular non-symbolic-link directory.");
	let parentStat;
	try {
		parentStat = await lstat(dirname(runDir));
	} catch (error) {
		return unsafeRunRoot(runDir, `READ_FAILED: run parent could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return unsafeRunRoot(runDir, "UNSAFE_RUN_PARENT: run parent must be a regular non-symbolic-link directory.");
	const [snapshotRead, authorizationRead] = await Promise.all([
		readJsonFile(join(runDir, "snapshot.json"), "snapshot.json"),
		readJsonFile(join(runDir, "authorization.json"), "authorization.json"),
	]);
	if (await runBoundaryChanged(runDir, runStat, trustedAnchor)) {
		return unsafeRunRoot(runDir, "UNSAFE_RUN_DIRECTORY: run root changed while it was being inspected.");
	}
	const format = detectRunFormat(snapshotRead.value, authorizationRead.present ? authorizationRead.value : undefined);
	const metadata = basicMetadata(snapshotRead.value);
	const readIssues = [snapshotRead.issue, authorizationRead.issue].filter((issue): issue is string => issue !== undefined);
	if (format.kind === "legacy-readonly" || format.kind === "legacy-v2") {
		const relevantIssues = readIssues.filter((issue) => !(format.kind === "legacy-readonly" && issue === "MISSING_FILE: authorization.json is missing."));
		if (relevantIssues.length > 0) {
			return { status: "needs_attention", format: { ...format, kind: "invalid", reason: relevantIssues.join(" ") }, runDir, ...metadata, reasons: relevantIssues, snapshot: snapshotRead.value, ...(authorizationRead.present ? { authorization: authorizationRead.value } : {}) };
		}
		return {
			status: format.kind,
			format,
			runDir,
			...metadata,
			reasons: [],
			snapshot: snapshotRead.value,
			...(authorizationRead.present ? { authorization: authorizationRead.value } : {}),
		};
	}
	if (format.kind !== "v3") {
		const reasons = [...readIssues, format.reason ?? "INVALID_FORMAT: run format is not supported."];
		return { status: "needs_attention", format, runDir, ...metadata, reasons, ...(snapshotRead.present ? { snapshot: snapshotRead.value } : {}), ...(authorizationRead.present ? { authorization: authorizationRead.value } : {}) };
	}
	if (readIssues.length > 0) {
		return { status: "needs_attention", format, runDir, ...metadata, reasons: readIssues, snapshot: snapshotRead.value, authorization: authorizationRead.value };
	}
	let observedSourceIdentity;
	try {
		observedSourceIdentity = JSON.parse(canonicalJson(await sourceIdentityFor(sourceCwd))) as SourceIdentityV3;
	} catch (error) {
		return { status: "needs_attention", format, runDir, ...metadata, reasons: [`SOURCE_IDENTITY_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`], snapshot: snapshotRead.value, authorization: authorizationRead.value };
	}
	if (await runBoundaryChanged(runDir, runStat, trustedAnchor)) {
		return unsafeRunRoot(runDir, "UNSAFE_RUN_DIRECTORY: run root changed while source identity was being inspected.");
	}
	const [currentSnapshotRead, currentAuthorizationRead] = await Promise.all([
		readJsonFile(join(runDir, "snapshot.json"), "snapshot.json"),
		readJsonFile(join(runDir, "authorization.json"), "authorization.json"),
	]);
	if (await runBoundaryChanged(runDir, runStat, trustedAnchor)) {
		return unsafeRunRoot(runDir, "UNSAFE_RUN_DIRECTORY: run root changed during final authority verification.");
	}
	if (currentSnapshotRead.issue
		|| currentAuthorizationRead.issue
		|| !sameFileObservation(snapshotRead.observation, currentSnapshotRead.observation)
		|| !sameFileObservation(authorizationRead.observation, currentAuthorizationRead.observation)) {
		return unsafeRunRoot(runDir, "UNSAFE_FILE: V3 authority files changed while source identity was being inspected.");
	}
	const verification = verifyV3Run(currentSnapshotRead.value, currentAuthorizationRead.value, observedSourceIdentity);
	if (!verification.ok) {
		return { status: "needs_attention", format, runDir, ...metadata, reasons: verification.reasons, snapshot: snapshotRead.value, authorization: authorizationRead.value };
	}
	return {
		status: "ok",
		format,
		runDir,
		graphId: verification.snapshot!.graphId,
		runInstanceId: verification.snapshot!.runInstanceId,
		graphStatus: verification.snapshot!.status,
		reasons: [],
		snapshot: verification.snapshot,
		authorization: verification.authorization,
	};
}
