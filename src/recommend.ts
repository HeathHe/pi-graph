import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseGraphConfig } from "./config.ts";
import type { GraphConfig } from "./types.ts";

export type DependencyRecommendationStatus = "ok" | "mismatch" | "missing";
export type GraphRecommendationStatus = "missing" | "valid" | "invalid";

export interface RecommendReport {
	checkedAt: string;
	dependency: {
		required: string | null;
		installed: string | null;
		status: DependencyRecommendationStatus;
		recommendation: string;
	};
	graph: {
		status: GraphRecommendationStatus;
		issues: string[];
		recommendation: string;
		recommended: GraphConfig;
	};
}

interface ExactSemver {
	major: string;
	minor: string;
	patch: string;
	prerelease: string;
}

const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENSITIVE_SETTING_KEY = /key|token|secret|password|credential|auth/i;
const EXACT_SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseExactSemver(value: string, declaration = false): ExactSemver | undefined {
	const normalized = declaration ? value.trim().replace(/^=\s*/, "") : value.trim();
	const match = EXACT_SEMVER.exec(normalized);
	if (!match) return undefined;
	const prerelease = match[4] ?? "";
	if (prerelease.split(".").some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
		return undefined;
	}
	return {
		major: match[1],
		minor: match[2],
		patch: match[3],
		prerelease,
	};
}

function satisfiesExactVersion(installed: string, required: string): boolean {
	const installedVersion = parseExactSemver(installed);
	const requiredVersion = parseExactSemver(required, true);
	if (!installedVersion || !requiredVersion) return false;
	return installedVersion.major === requiredVersion.major
		&& installedVersion.minor === requiredVersion.minor
		&& installedVersion.patch === requiredVersion.patch
		&& installedVersion.prerelease === requiredVersion.prerelease;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

async function inspectDependency(packageRoot: string): Promise<RecommendReport["dependency"]> {
	const packageJson = await readJsonObject(join(packageRoot, "package.json"));
	const dependencies = packageJson?.dependencies;
	const required = dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
		&& typeof (dependencies as Record<string, unknown>)["pi-subagents"] === "string"
		? (dependencies as Record<string, string>)["pi-subagents"]!
		: null;
	const installedPackage = await readJsonObject(join(packageRoot, "node_modules", "pi-subagents", "package.json"));
	const installed = typeof installedPackage?.version === "string" ? installedPackage.version : null;

	if (!required) {
		return {
			required,
			installed,
			status: "missing",
			recommendation: "Declare pi-subagents as an exact dependency in pi-graph package.json, then install dependencies.",
		};
	}
	if (!installed) {
		return {
			required,
			installed,
			status: "missing",
			recommendation: `Install the declared pi-subagents version with npm install pi-subagents@${required}.`,
		};
	}
	if (!satisfiesExactVersion(installed, required)) {
		return {
			required,
			installed,
			status: "mismatch",
			recommendation: `Install the declared pi-subagents version with npm install pi-subagents@${required}.`,
		};
	}
	return {
		required,
		installed,
		status: "ok",
		recommendation: `Installed pi-subagents ${installed} matches the declared version ${required}.`,
	};
}

function extractGraphSection(settings: unknown): { found: boolean; value?: unknown } | undefined {
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
	const record = settings as Record<string, unknown>;
	let found = false;
	let graph: unknown;
	for (const key of Object.keys(record)) {
		// Check the key before reading its value so sensitive settings are never copied or reported.
		if (SENSITIVE_SETTING_KEY.test(key)) continue;
		if (key === "graph") {
			found = true;
			graph = record[key];
		}
	}
	return found ? { found, value: graph } : { found };
}

async function inspectGraph(agentDir: string): Promise<RecommendReport["graph"]> {
	const recommended = parseGraphConfig({}, agentDir);
	let source: string;
	try {
		source = await readFile(join(agentDir, "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				status: "missing",
				issues: [],
				recommendation: "Add the recommended settings.graph block to settings.json.",
				recommended,
			};
		}
		return {
			status: "invalid",
			issues: ["settings.json could not be read."],
			recommendation: "Make settings.json readable, then add or validate its settings.graph block.",
			recommended,
		};
	}

	let settings: unknown;
	try {
		settings = JSON.parse(source) as unknown;
	} catch {
		return {
			status: "invalid",
			issues: ["settings.json is not valid JSON."],
			recommendation: "Repair settings.json, then add the recommended settings.graph block.",
			recommended,
		};
	}
	const graphSection = extractGraphSection(settings);
	if (!graphSection) {
		return {
			status: "invalid",
			issues: ["settings.json must contain a JSON object."],
			recommendation: "Repair settings.json, then add the recommended settings.graph block.",
			recommended,
		};
	}
	if (!graphSection.found) {
		return {
			status: "missing",
			issues: [],
			recommendation: "Add the recommended settings.graph block to settings.json.",
			recommended,
		};
	}
	try {
		parseGraphConfig(graphSection.value, agentDir);
	} catch {
		return {
			status: "invalid",
			issues: ["settings.graph does not match the pi-graph configuration schema."],
			recommendation: "Replace or repair settings.graph using the recommended block below.",
			recommended,
		};
	}
	return {
		status: "valid",
		issues: [],
		recommendation: "The existing settings.graph block is valid; compare it with the defaults below when updating it.",
		recommended,
	};
}

export async function recommendGraphConfig(options: { agentDir?: string; packageRoot?: string } = {}): Promise<RecommendReport> {
	const agentDir = options.agentDir ?? getAgentDir();
	const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
	const [dependency, graph] = await Promise.all([
		inspectDependency(packageRoot),
		inspectGraph(agentDir),
	]);
	return {
		checkedAt: new Date().toISOString(),
		dependency,
		graph,
	};
}

export function formatRecommendReport(report: RecommendReport): string {
	const required = report.dependency.required ?? "not declared";
	const installed = report.dependency.installed ?? "not installed";
	const lines = [
		`Graph recommendation: dependency ${report.dependency.status}, settings.graph ${report.graph.status}`,
		`pi-subagents: required ${required}, installed ${installed}`,
		`- ${report.dependency.recommendation}`,
		`settings.graph: ${report.graph.status}${report.graph.issues.length ? ` - ${report.graph.issues.join("; ")}` : ""}`,
		`- ${report.graph.recommendation}`,
		"Field notes:",
		"- enabled controls Graph execution; runsDir stores durable Graph runs.",
		"- maxConcurrency, readOnlyBurst, maxSpawnBudget, and resourceLimits bound execution.",
		"- rpcTimeoutMs and validationTimeoutMs bound RPC and validation waits.",
		"- notifyOnComplete and runtimeV2Dispatch control completion notices and runtime dispatch.",
		"- history controls compaction, pruning, trash grace, storage limits, and retained terminal runs.",
		"Recommended settings.graph (valid JSON):",
		JSON.stringify(report.graph.recommended, null, 2),
	];
	return lines.join("\n");
}
