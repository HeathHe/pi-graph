import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GraphConfig } from "./types.ts";

function positive(value: unknown, fallback: number, max?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(Math.floor(value), max ?? Number.MAX_SAFE_INTEGER);
}

function nonNegative(value: unknown, fallback: number, max?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return Math.min(Math.floor(value), max ?? Number.MAX_SAFE_INTEGER);
}

function positiveNumber(value: unknown, fallback: number, max?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return Math.min(fallback, max ?? Number.MAX_SAFE_INTEGER);
	return Math.min(value, max ?? Number.MAX_SAFE_INTEGER);
}

function nonNegativeNumber(value: unknown, fallback: number, max?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return Math.min(fallback, max ?? Number.MAX_SAFE_INTEGER);
	return Math.min(value, max ?? Number.MAX_SAFE_INTEGER);
}

export function parseGraphConfig(raw: unknown, agentDir = getAgentDir()): GraphConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pi-graph settings.graph must be an object.");
	const settings = raw as Record<string, unknown>;
	const history = settings.history && typeof settings.history === "object" && !Array.isArray(settings.history) ? settings.history as Record<string, unknown> : {};
	if (settings.history !== undefined && history !== settings.history) throw new Error("pi-graph settings.graph.history must be an object.");
	const rawResourceLimits = settings.resourceLimits;
	if (rawResourceLimits !== undefined && (!rawResourceLimits || typeof rawResourceLimits !== "object" || Array.isArray(rawResourceLimits))) {
		throw new Error("pi-graph settings.graph.resourceLimits must be an object.");
	}
	const resourceLimits = Object.fromEntries(Object.entries((rawResourceLimits ?? {}) as Record<string, unknown>).map(([key, value]) => {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(key)) throw new Error(`pi-graph resource limit key is invalid: ${key}`);
		if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 6) throw new Error(`pi-graph resource limit '${key}' must be an integer from 1 to 6.`);
		return [key, value as number];
	}));
	const maxStorageGB = positiveNumber(history.maxStorageGB, 5, 1024);
	const targetStorageGB = nonNegativeNumber(history.targetStorageGB, Math.min(4, maxStorageGB), maxStorageGB);
	return {
		enabled: settings.enabled !== false,
		runsDir: typeof settings.runsDir === "string" && settings.runsDir.trim() ? resolve(settings.runsDir) : join(agentDir, "graph-runs"),
		maxConcurrency: positive(settings.maxConcurrency, 3, 6),
		readOnlyBurst: positive(settings.readOnlyBurst, 3, 6),
		maxSpawnBudget: positive(settings.maxSpawnBudget, 20, 100),
		rpcTimeoutMs: positive(settings.rpcTimeoutMs, 10_000),
		validationTimeoutMs: positive(settings.validationTimeoutMs, 300_000),
		notifyOnComplete: settings.notifyOnComplete !== false,
		runtimeV2Dispatch: settings.runtimeV2Dispatch !== false,
		resourceLimits,
		history: {
			autoCompact: history.autoCompact !== false,
			compactAfterDays: nonNegative(history.compactAfterDays, 7, 3650),
			autoPrune: history.autoPrune === true,
			emergencyPurge: history.emergencyPurge === true,
			pruneAfterDays: positive(history.pruneAfterDays, 180, 36500),
			trashGraceDays: positive(history.trashGraceDays, 7, 3650),
			maxStorageBytes: maxStorageGB * 1024 ** 3,
			targetStorageBytes: targetStorageGB * 1024 ** 3,
			keepRecentTerminal: positive(history.keepRecentTerminal, 50, 10_000),
		},
	};
}

export async function loadGraphConfig(): Promise<GraphConfig> {
	let raw: unknown = {};
	try {
		const settings = JSON.parse(await readFile(join(getAgentDir(), "settings.json"), "utf8")) as { graph?: unknown };
		raw = settings.graph ?? {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`pi-graph settings could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseGraphConfig(raw);
}
