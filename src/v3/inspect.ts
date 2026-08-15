import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { detectRunFormat } from "./format-detector.ts";
import { resolveSourceIdentityV3 } from "./source-identity.ts";
import { verifyV3Run } from "./snapshot.ts";
import type { RunFormatDetection, V3RunInspection } from "./types.ts";

interface JsonReadResult {
	present: boolean;
	value?: unknown;
	issue?: string;
}

export interface InspectV3RunOptions {
	sourceCwd?: string;
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
		const contents = await handle.readFile("utf8");
		try {
			return { present: true, value: JSON.parse(contents) as unknown };
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

export async function inspectV3Run(runDirectory: string, options: InspectV3RunOptions = {}): Promise<V3RunInspection> {
	const runDir = resolve(runDirectory);
	let runStat;
	try {
		runStat = await lstat(runDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return unsafeRunRoot(runDir, "MISSING_RUN_DIRECTORY: run directory is missing.");
		return unsafeRunRoot(runDir, `READ_FAILED: run directory could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (runStat.isSymbolicLink() || !runStat.isDirectory()) return unsafeRunRoot(runDir, "UNSAFE_RUN_DIRECTORY: run root must be a regular non-symbolic-link directory.");
	const [snapshotRead, authorizationRead] = await Promise.all([
		readJsonFile(join(runDir, "snapshot.json"), "snapshot.json"),
		readJsonFile(join(runDir, "authorization.json"), "authorization.json"),
	]);
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
		observedSourceIdentity = await resolveSourceIdentityV3(options.sourceCwd ?? process.cwd());
	} catch (error) {
		return { status: "needs_attention", format, runDir, ...metadata, reasons: [`SOURCE_IDENTITY_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`], snapshot: snapshotRead.value, authorization: authorizationRead.value };
	}
	const verification = verifyV3Run(snapshotRead.value, authorizationRead.value, observedSourceIdentity);
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
