import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseGraphConfig } from "./config.ts";
import { inspectPiSubagentsRuntime, type PiSubagentsRpcLike, type PiSubagentsRuntimeCapabilities } from "./pi-subagents-compat.ts";
import type { GraphConfig } from "./types.ts";

export type DependencyRecommendationStatus = "ok" | "mismatch" | "missing";
export type GraphRecommendationStatus = "missing" | "valid" | "invalid";

export interface RecommendReport {
	checkedAt: string;
	dependency: {
		required: string | null;
		development: string | null;
		installed: string | null;
		status: DependencyRecommendationStatus;
		recommendation: string;
	};
	piSubagents: PiSubagentsRuntimeCapabilities;
	graph: {
		status: GraphRecommendationStatus;
		issues: string[];
		recommendation: string;
		recommended: GraphConfig;
	};
}

const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENSITIVE_SETTING_KEY = /key|token|secret|password|credential|auth/i;

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function dependencyValue(section: unknown, name: string): string | null {
	return section && typeof section === "object" && !Array.isArray(section)
		&& typeof (section as Record<string, unknown>)[name] === "string"
		? (section as Record<string, string>)[name]!
		: null;
}

async function inspectDependency(packageRoot: string): Promise<RecommendReport["dependency"]> {
	const packageJson = await readJsonObject(join(packageRoot, "package.json"));
	const direct = dependencyValue(packageJson?.dependencies, "pi-subagents");
	const required = dependencyValue(packageJson?.peerDependencies, "pi-subagents");
	const development = dependencyValue(packageJson?.devDependencies, "pi-subagents");
	const installedPackage = await readJsonObject(join(packageRoot, "node_modules", "pi-subagents", "package.json"));
	const installed = typeof installedPackage?.version === "string" ? installedPackage.version : null;
	const issues: string[] = [];
	if (direct) issues.push(`Remove the direct pi-subagents dependency (${direct}) so Pi supplies one current runtime copy.`);
	if (!required) issues.push("Declare pi-subagents as a peer dependency (>=0.40.0). ");
	if (development !== "latest") issues.push(`Declare pi-subagents as devDependency \"latest\" instead of ${development ?? "omitting it"}.`);
	return {
		required,
		development,
		installed,
		status: issues.length === 0 ? "ok" : required ? "mismatch" : "missing",
		recommendation: issues.length > 0
			? issues.join(" ").trim()
			: `Dependency policy is current: peer ${required}, development latest${installed ? ` (installed ${installed}, diagnostic only)` : ""}.`,
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

export async function recommendGraphConfig(options: { agentDir?: string; packageRoot?: string; rpc?: PiSubagentsRpcLike } = {}): Promise<RecommendReport> {
	const agentDir = options.agentDir ?? getAgentDir();
	const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
	const [dependency, piSubagents, graph] = await Promise.all([
		inspectDependency(packageRoot),
		inspectPiSubagentsRuntime(options.rpc),
		inspectGraph(agentDir),
	]);
	return {
		checkedAt: new Date().toISOString(),
		dependency,
		piSubagents,
		graph,
	};
}

export function formatRecommendReport(report: RecommendReport): string {
	const required = report.dependency.required ?? "not declared";
	const development = report.dependency.development ?? "not declared";
	const installed = report.piSubagents.packageVersion ?? report.dependency.installed ?? "not observed";
	const lines = [
		`Graph recommendation: dependency ${report.dependency.status}, runtime ${report.piSubagents.routingCompatible ? "compatible" : "incompatible"}, settings.graph ${report.graph.status}`,
		`pi-subagents: peer ${required}, development ${development}, runtime ${installed} (version is diagnostic only)`,
		`- ${report.dependency.recommendation}`,
		`Runtime capabilities: protocol ${report.piSubagents.rpcProtocol ?? "unknown"}; asyncSpawn=${report.piSubagents.asyncSpawn}; status=${report.piSubagents.status}; stop=${report.piSubagents.stop}; resume=${report.piSubagents.resume}; resolvedModel=${report.piSubagents.resolvedModelObservable}; attemptedModels=${report.piSubagents.attemptedModelsObservable}; providerFailure=${report.piSubagents.providerFailureStructured}; exactModelControl=${report.piSubagents.exactModelControl}; runtimeCompatible=${report.piSubagents.runtimeCompatible}; provenanceObservable=${report.piSubagents.provenanceObservable}; controlledRoutingReady=${report.piSubagents.controlledRoutingReady}`,
		...(report.piSubagents.issues.length ? report.piSubagents.issues.map((issue) => `- runtime_incompatible: ${issue}`) : []),
		...(report.piSubagents.limitations.length ? report.piSubagents.limitations.map((limitation) => `- runtime_limit: ${limitation}`) : []),
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
