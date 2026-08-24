import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface V3GraphConfig {
	enabled: boolean;
	runsDir: string;
	rpcTimeoutMs: number;
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) <= 0) return fallback;
	return Math.min(value as number, maximum);
}

/**
 * V3 deliberately owns a narrow configuration surface. Settings may still contain
 * historical graph keys, but the V3 executor neither interprets nor imports them.
 */
export function parseV3GraphConfig(raw: unknown, agentDir = getAgentDir()): V3GraphConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("pi-graph settings.graph must be an object.");
	}
	const settings = raw as Record<string, unknown>;
	return {
		enabled: settings.enabled !== false,
		runsDir: typeof settings.runsDir === "string" && settings.runsDir.trim().length > 0
			? resolve(settings.runsDir)
			: join(agentDir, "graph-runs"),
		rpcTimeoutMs: positiveInteger(settings.rpcTimeoutMs, 10_000, 300_000),
	};
}

export async function loadV3GraphConfig(): Promise<V3GraphConfig> {
	let raw: unknown = {};
	try {
		const settings = JSON.parse(await readFile(join(getAgentDir(), "settings.json"), "utf8")) as { graph?: unknown };
		raw = settings.graph ?? {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`pi-graph settings could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return parseV3GraphConfig(raw);
}
