import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { compileGraphSpecV3, MAX_TASK_ID_LENGTH_V3 } from "../src/v3/compiler.ts";
import { loadV3GraphConfig, type V3GraphConfig } from "../src/v3/config.ts";
import { loadAndCompileV3GraphCapsule } from "../src/v3/graph-capsule.ts";
import { V3GraphHost, graphStatusTextV3, v3IsGraphSpecV3 } from "../src/v3/host.ts";
import { readV3MutationJournal, type V3GraphMutationState } from "../src/v3/mutations.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { listBuiltinGraphTemplatesV3, loadBuiltinGraphTemplateV3 } from "../src/v3/templates.ts";
import type { GraphNodeSpecV3, GraphSpecV3 } from "../src/v3/types.ts";

export const ScopeEntrySchema = Type.Object({
	kind: Type.String({ enum: ["file", "tree"], description: "Use 'file' for one file or 'tree' for a directory tree." }),
	path: Type.String({ minLength: 1, description: "Project-relative path inside the graph source directory." }),
}, { additionalProperties: false });

export const GraphSpecV3NodeSchema = Type.Object({
	taskId: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3 }),
	agent: Type.String({ minLength: 1 }),
	task: Type.String({ minLength: 1 }),
	dependsOn: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3 }), { uniqueItems: true })),
	when: Type.Optional(Type.Object({
		node: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3 }),
		status: Type.String({ enum: ["accepted", "failed"] }),
	}, { additionalProperties: false, description: "Run only when this direct dependency reaches the requested terminal status." })),
	inputArtifacts: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
	outputArtifact: Type.Optional(Type.String({ minLength: 1 })),
	readScope: Type.Optional(Type.Array(ScopeEntrySchema)),
	writeScope: Type.Optional(Type.Array(ScopeEntrySchema)),
	sideEffect: Type.String({ enum: ["none", "local_read", "local_write"] }),
	acceptance: Type.Optional(Type.String({ minLength: 1, description: "Declarative only unless backed by deterministic validation." })),
	validationCommands: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
		description: "Deterministic Supervisor commands. Required for local_write; child Bash remains disabled.",
	})),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	retryPolicy: Type.Optional(Type.Object({
		maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
		retryOn: Type.Optional(Type.Array(Type.String({ enum: ["task_failed", "validation", "timeout", "workspace_conflict"] }), { uniqueItems: true })),
		backoffMs: Type.Optional(Type.Integer({ minimum: 0 })),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

export const GraphSpecV3Schema = Type.Object({
	schemaVersion: Type.Literal(3),
	graphId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	goal: Type.String({ minLength: 1, maxLength: 2_000 }),
	mode: Type.Optional(Type.String({ enum: ["sealed", "open"], description: "Open graphs accept revision-CAS append/cancel operations until sealed." })),
	nodes: Type.Array(GraphSpecV3NodeSchema, { maxItems: 512, description: "May be empty only for an open graph." }),
	maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
	failFast: Type.Optional(Type.Boolean()),
	workspace: Type.Optional(Type.String({ enum: ["shadow"], description: "V3 always executes nodes in an isolated shadow workspace." })),
	readOnly: Type.Optional(Type.Boolean({ description: "Mechanically deny local_write nodes and write/edit child tools." })),
	toolFilter: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$" }), {
		uniqueItems: true,
		description: "Exact graph-wide child tool allow-list enforced by Graph Guard.",
	})),
}, {
	additionalProperties: false,
	description: "Governance-free GraphSpec V3. It contains no planning gates, model routing, or policy registry fields.",
});

export const Parameters = Type.Object({
	action: Type.Optional(Type.String({
		enum: ["start", "load", "status", "list", "doctor", "pause", "resume", "stop", "templates", "agents", "retry", "append", "cancel", "seal"],
		description: "V3 graph operation. Omit for start. Topology mutations require revision compare-and-set.",
	})),
	id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$" })),
	spec: Type.Optional(GraphSpecV3Schema),
	capsule: Type.Optional(Type.String({ minLength: 1, description: "Path to a V3 .graph.json capsule, resolved from the current project." })),
	template: Type.Optional(Type.String({ minLength: 1, description: "Built-in V3 template name." })),
	overrides: Type.Optional(Type.Unsafe({
		type: "object",
		additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
		description: "Typed capsule inputs or string template inputs.",
	})),
	node: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3, description: "Root node for an explicit retry." })),
	revision: Type.Optional(Type.Integer({ minimum: 0 })),
	nodes: Type.Optional(Type.Array(GraphSpecV3NodeSchema, { minItems: 1, maxItems: 64 })),
	taskIds: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3 }), { minItems: 1, uniqueItems: true })),
	cascade: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

interface PublicProjectAgentV3 {
	name: string;
	description: string;
	aliases?: string[];
}

function stripSimpleYamlQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function publicAgentMetadata(contents: string, fileName: string): PublicProjectAgentV3 {
	const metadata: Record<string, string> = {};
	const normalized = contents.replaceAll("\r\n", "\n");
	if (normalized.startsWith("---\n")) {
		const end = normalized.indexOf("\n---", 4);
		if (end >= 0) {
			for (const line of normalized.slice(4, end).split("\n")) {
				const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u.exec(line);
				if (match?.[1] && match[2] !== undefined) metadata[match[1]] = stripSimpleYamlQuotes(match[2]);
			}
		}
	}
	const name = metadata.name?.trim() || basename(fileName, ".md");
	const description = metadata.description?.trim() || `Project Agent '${name}'.`;
	const aliasesValue = metadata.aliases?.replace(/^\[/u, "").replace(/\]$/u, "");
	const aliases = aliasesValue?.split(",").map(stripSimpleYamlQuotes).filter(Boolean);
	return { name, description, ...(aliases?.length ? { aliases: [...new Set(aliases)] } : {}) };
}

/** Return only public project Agent metadata; model/routing details never cross this boundary. */
export async function listProjectAgentsV3(cwd: string): Promise<PublicProjectAgentV3[]> {
	let cursor = resolve(cwd);
	let directory: string | undefined;
	while (true) {
		const piDirectory = join(cursor, ".pi");
		const piInfo = await lstat(piDirectory).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (piInfo) {
			if (!piInfo.isDirectory() || piInfo.isSymbolicLink()) throw new Error(`Project Agent control directory '${piDirectory}' must be a real directory.`);
			const candidate = join(piDirectory, "agents");
			const candidateInfo = await lstat(candidate).catch((error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			if (candidateInfo) {
				if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) throw new Error("Project .pi/agents must be a real directory.");
				directory = candidate;
				break;
			}
		}
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	if (!directory) return [];
	const agents: PublicProjectAgentV3[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md") || entry.name.endsWith(".chain.md")) continue;
		const file = join(directory, entry.name);
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Project Agent definition '${entry.name}' must be a single regular file.`);
		if (info.size > 1_048_576) throw new Error(`Project Agent definition '${entry.name}' exceeds the 1 MiB read limit.`);
		agents.push(publicAgentMetadata(await readFile(file, "utf8"), entry.name));
	}
	const names = new Set<string>();
	for (const agent of agents) {
		if (!agent.name || agent.name.length > 200) throw new Error("Project Agent names must contain 1..200 characters.");
		if (names.has(agent.name)) throw new Error(`Duplicate project Agent name '${agent.name}'.`);
		names.add(agent.name);
	}
	return agents.sort((left, right) => left.name.localeCompare(right.name));
}

function result(text: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details: details ?? {}, ...(isError ? { isError: true } : {}) };
}

function trustedSessionId(ctx: { sessionManager: { getSessionId: () => string } }): string {
	const sessionId = ctx.sessionManager.getSessionId();
	if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Graph execution requires a trusted Pi session ID.");
	return sessionId.trim();
}

function commandSessionId(ctx: { sessionManager?: { getSessionId: () => string } }): string {
	try {
		return trustedSessionId(ctx as { sessionManager: { getSessionId: () => string } });
	} catch {
		return "graph-command";
	}
}

function templateOverrides(value: unknown): Record<string, string | undefined> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("template overrides must be an object of non-empty string values.");
	const output: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!key || typeof entry !== "string" || entry.trim().length === 0) throw new Error("template overrides must be an object of non-empty string values.");
		output[key] = entry;
	}
	return output;
}

interface ResolvedV3GraphSource {
	spec: GraphSpecV3;
	capsule?: {
		path: string;
		manifest: { name: string; version: string; description: string };
		intent: string;
		inputs: Readonly<Record<string, string | number | boolean>>;
		requires: { readOnly: boolean; toolFilter: string[] };
		provenance?: { created: string; author?: string; source?: string };
	};
}

async function sourceSpecV3(
	params: { spec?: unknown; capsule?: unknown; template?: unknown; overrides?: unknown },
	cwd: string,
): Promise<ResolvedV3GraphSource> {
	const sources = [params.spec !== undefined, params.capsule !== undefined, params.template !== undefined].filter(Boolean).length;
	if (sources !== 1) throw new Error("graph start/load requires exactly one of spec, capsule, or template.");
	if (params.spec !== undefined) {
		if (params.overrides !== undefined) throw new Error("overrides may be used only with capsule or template.");
		if (!v3IsGraphSpecV3(params.spec)) throw new Error("GraphSpec V3 requires schemaVersion: 3.");
		return { spec: params.spec as GraphSpecV3 };
	}
	if (params.template !== undefined) {
		if (typeof params.template !== "string" || params.template.trim().length === 0) throw new Error("template must be a non-empty built-in V3 template name.");
		return { spec: loadBuiltinGraphTemplateV3(params.template, templateOverrides(params.overrides)) };
	}
	if (typeof params.capsule !== "string" || params.capsule.trim().length === 0) throw new Error("capsule must be a non-empty .graph.json path.");
	const path = resolve(cwd, params.capsule);
	const loaded = await loadAndCompileV3GraphCapsule(path, params.overrides ?? {});
	return {
		spec: loaded.spec,
		capsule: {
			path,
			manifest: loaded.capsule.manifest,
			intent: loaded.capsule.intent,
			inputs: loaded.inputs,
			requires: loaded.capsule.requires,
			...(loaded.capsule.provenance ? { provenance: loaded.capsule.provenance } : {}),
		},
	};
}

function graphCompileDetailsV3(graph: ReturnType<typeof compileGraphSpecV3>) {
	return {
		graphId: graph.graphId,
		goal: graph.goal,
		mode: graph.mode ?? "sealed",
		nodeCount: graph.nodes.length,
		topologicalOrder: graph.topologicalOrder,
		maxConcurrency: graph.maxConcurrency,
		failFast: graph.failFast,
		workspace: graph.workspace,
		readOnly: graph.sourceGraphSpec.readOnly ?? false,
		toolFilter: graph.sourceGraphSpec.toolFilter ?? [],
		graphDigest: graph.graphDigest,
		sourceGraphSpecDigest: graph.sourceGraphSpecDigest,
		nodes: graph.nodes,
	};
}

function graphCompileTextV3(graph: ReturnType<typeof compileGraphSpecV3>): string {
	return [
		`Graph: ${graph.graphId}`,
		`Topology: ${graph.mode ?? "sealed"}`,
		`Nodes: ${graph.nodes.length}`,
		`Order: ${graph.topologicalOrder.length ? graph.topologicalOrder.join(" → ") : "(empty)"}`,
		`Concurrency: ${graph.maxConcurrency}`,
		`Workspace: ${graph.workspace}`,
	].join("\n");
}

function mutationTextV3(graphId: string, state: V3GraphMutationState, operation: string): string {
	return [
		`Graph ${operation} committed.`,
		`Graph: ${graphId}`,
		`Revision: ${state.revision}`,
		`Topology: ${state.sealed ? "sealed" : "open"}`,
		`Nodes: ${state.graph.nodes.length}`,
		...(state.cancelledTaskIds.length ? [`Cancelled: ${state.cancelledTaskIds.join(", ")}`] : []),
	].join("\n");
}

function doctorText(report: Awaited<ReturnType<V3GraphHost["doctor"]>>): string {
	if (report.issues.length === 0) return `Graph doctor: healthy\nSupervised: ${report.supervised.length}`;
	return [
		`Graph doctor: ${report.issues.length} issue(s)`,
		...report.issues.map((issue) => `${issue.runId ?? "<unknown>"} | ${issue.kind} | ${issue.detail}`),
	].join("\n");
}

export default function piGraphExtension(pi: ExtensionAPI): void {
	const startExecutions = new Map<string, { signature: string; promise: Promise<ReturnType<typeof result>> }>();
	let host: V3GraphHost | undefined;
	let hostConfig: V3GraphConfig | undefined;
	let supervisorEpoch = `v3-${Date.now()}`;

	const ensureHost = (config: V3GraphConfig, sessionId: string): V3GraphHost => {
		if (!config.enabled) throw new Error("pi-graph is disabled in settings.json.");
		if (!host) {
			host = new V3GraphHost({
				rpc: new SubagentRpcClient(pi.events, config.rpcTimeoutMs),
				runsDir: config.runsDir,
				sessionId,
				supervisorEpoch,
				onStateChange: (snapshot) => pi.events.emit("pi-graph:state", snapshot),
			});
			hostConfig = config;
		} else {
			if (hostConfig?.runsDir !== config.runsDir || hostConfig.rpcTimeoutMs !== config.rpcTimeoutMs) {
				throw new Error("pi-graph configuration changed during an active session; reload the Pi session before operating graphs.");
			}
			host.setSessionContext(sessionId, supervisorEpoch);
		}
		return host;
	};

	const configuredHost = async (sessionId: string): Promise<{ config: V3GraphConfig; host: V3GraphHost }> => {
		const config = await loadV3GraphConfig();
		return { config, host: ensureHost(config, sessionId) };
	};

	registerBackgroundWorkProvider({
		name: "pi-graph",
		listActiveWork: () => host?.listActiveWork() ?? [],
		wakeChannels: ["pi-graph:state"],
	});

	pi.on("session_start", async (_event, ctx) => {
		startExecutions.clear();
		supervisorEpoch = `v3-${Date.now()}`;
		try {
			const config = await loadV3GraphConfig();
			if (!config.enabled) return;
			await ensureHost(config, trustedSessionId(ctx)).adoptCrashedRuns();
		} catch {
			// Startup remains non-invasive. Explicit doctor/status calls surface failures.
		}
	});

	pi.on("session_shutdown", async () => {
		startExecutions.clear();
		await host?.suspendAll();
		host = undefined;
		hostConfig = undefined;
	});

	pi.registerCommand("graphs", {
		description: "Inspect and control governance-free V3 graph runs",
		getArgumentCompletions: (prefix) => {
			const commands = ["doctor", "list", "status", "pause", "resume", "stop"];
			const matches = commands.filter((command) => command.startsWith(prefix.trim()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			try {
				const [command = "doctor", id] = args.trim().split(/\s+/u);
				const current = await configuredHost(commandSessionId(ctx));
				if (command === "doctor") {
					const report = await current.host.doctor();
					ctx.ui.notify(doctorText(report), report.issues.length ? "warning" : "info");
					return;
				}
				if (command === "list") {
					const summaries = await current.host.list();
					const lines = await Promise.all(summaries.map((summary) => graphStatusTextV3(summary.snapshot, current.config.runsDir)));
					ctx.ui.notify(lines.length ? lines.join("\n\n") : "No V3 graph runs found.", "info");
					return;
				}
				if (!id) throw new Error(`Usage: /graphs ${command} <graph-id>`);
				if (!await current.host.isV3Run(current.host.runDirFor(id))) throw new Error(`'${id}' is not a V3 graph run.`);
				const snapshot = command === "status"
					? await current.host.status(id)
					: command === "pause"
						? await current.host.pause(id)
						: command === "resume"
							? await current.host.resume(id)
							: command === "stop"
								? await current.host.stop(id)
								: undefined;
				if (!snapshot) throw new Error("Usage: /graphs doctor|list|status|pause|resume|stop");
				ctx.ui.notify(await graphStatusTextV3(snapshot, current.config.runsDir), "info");
			} catch (error) {
				ctx.ui.notify(`pi-graph error: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
	});

	pi.registerTool({
		name: "graph",
		label: "Graph",
		description: "Compile and execute durable GraphSpec V3 DAGs through pi-subagents. Supports open topology, conditions, revision-CAS mutations, pause/resume, and explicit retry. pi-graph never plans tasks or selects models.",
		parameters: Parameters,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const action = params.action ?? "start";
				if (action === "start") {
					const source = await sourceSpecV3(params, ctx.cwd);
					const sessionId = trustedSessionId(ctx);
					const signature = JSON.stringify({ sessionId, cwd: ctx.cwd, spec: source.spec, capsule: source.capsule });
					const existing = startExecutions.get(toolCallId);
					if (existing) {
						if (existing.signature !== signature) return result("A graph start toolCallId cannot be reused with a different GraphSpec.", undefined, true);
						return existing.promise;
					}
					const promise = (async () => {
						const current = await configuredHost(sessionId);
						const started = await current.host.start(source.spec, ctx.cwd);
						return result(`Graph accepted for asynchronous V3 execution.\n${await graphStatusTextV3(started.snapshot, current.config.runsDir)}`, {
							...started.snapshot,
							runDir: started.runDir,
							snapshot: started.snapshot,
							graph: graphCompileDetailsV3(started.graph),
							...(source.capsule ? { capsule: source.capsule } : {}),
						});
					})();
					startExecutions.set(toolCallId, { signature, promise });
					return promise;
				}
				if (action === "templates") {
					const templates = listBuiltinGraphTemplatesV3();
					const lines = templates.map((template) => {
						const required = Object.entries(template.inputs).filter(([, input]) => input.required).map(([name]) => name);
						return `${template.name} (${template.version}) — ${template.description}${required.length ? ` Required: ${required.join(", ")}.` : ""}`;
					});
					return result(lines.join("\n"), { templates });
				}
				if (action === "agents") {
					const agents = await listProjectAgentsV3(ctx.cwd);
					const text = agents.length
						? agents.map((agent) => `${agent.name} — ${agent.description}${agent.aliases?.length ? ` (aliases: ${agent.aliases.join(", ")})` : ""}`).join("\n")
						: "No project Agents were found in .pi/agents.";
					return result(text, { scope: ".pi/agents", agents });
				}
				if (action === "load") {
					if (params.id !== undefined && (params.spec !== undefined || params.capsule !== undefined || params.template !== undefined || params.overrides !== undefined)) {
						return result("graph load accepts either id or a spec/template source, not both.", undefined, true);
					}
					if (params.id === undefined) {
						const source = await sourceSpecV3(params, ctx.cwd);
						const graph = compileGraphSpecV3(source.spec);
						return result(`GraphSpec V3 compiled without execution.\n${graphCompileTextV3(graph)}`, {
							status: "loaded",
							revision: 0,
							sealed: (graph.mode ?? "sealed") === "sealed",
							graph: graphCompileDetailsV3(graph),
							...(source.capsule ? { capsule: source.capsule } : {}),
						});
					}
					const current = await configuredHost(trustedSessionId(ctx));
					if (!await current.host.isV3Run(current.host.runDirFor(params.id))) return result(`'${params.id}' is not a V3 graph run.`, undefined, true);
					const loaded = await current.host.loadRun(current.host.runDirFor(params.id), params.id);
					const [snapshot, mutation] = await Promise.all([
						current.host.status(params.id),
						readV3MutationJournal(loaded.runDir, loaded.baseGraph),
					]);
					return result(`Durable V3 graph loaded.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}\nRevision: ${mutation.revision}`, {
						status: snapshot.status,
						snapshot,
						revision: mutation.revision,
						sealed: mutation.sealed,
						cancelledTaskIds: mutation.cancelledTaskIds,
						graph: graphCompileDetailsV3(mutation.graph),
					});
				}
				if (action === "list") {
					const current = await configuredHost(trustedSessionId(ctx));
					const summaries = await current.host.list();
					const lines = await Promise.all(summaries.map((summary) => graphStatusTextV3(summary.snapshot, current.config.runsDir)));
					return result(lines.length ? lines.join("\n\n") : "No V3 graph runs found.", { runs: summaries });
				}
				if (action === "doctor") {
					const current = await configuredHost(trustedSessionId(ctx));
					const report = await current.host.doctor();
					return result(doctorText(report), report, report.issues.length > 0);
				}
				if (!params.id) return result(`graph ${action} requires id.`, undefined, true);
				const current = await configuredHost(trustedSessionId(ctx));
				if (!await current.host.isV3Run(current.host.runDirFor(params.id))) return result(`'${params.id}' is not a V3 graph run.`, undefined, true);
				if (action === "pause") {
					const snapshot = await current.host.pause(params.id);
					return result(`Graph pause committed.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, snapshot);
				}
				if (action === "retry") {
					if (!params.node) return result("graph retry requires node.", undefined, true);
					const snapshot = await current.host.retry(params.id, params.node);
					return result(`Graph retry accepted for '${params.node}'.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, snapshot);
				}
				if (action === "append" || action === "cancel" || action === "seal") {
					if (!Number.isSafeInteger(params.revision) || (params.revision ?? -1) < 0) return result(`graph ${action} requires a non-negative revision.`, undefined, true);
					let state: V3GraphMutationState;
					if (action === "append") {
						if (!params.nodes?.length) return result("graph append requires nodes.", undefined, true);
						state = await current.host.append(params.id, params.nodes as GraphNodeSpecV3[], params.revision!);
					} else if (action === "cancel") {
						if (!params.taskIds?.length) return result("graph cancel requires taskIds.", undefined, true);
						state = await current.host.cancel(params.id, params.taskIds, params.cascade ?? false, params.revision!);
					} else {
						state = await current.host.seal(params.id, params.revision!);
					}
					return result(mutationTextV3(params.id, state, action), state);
				}
				if (action === "status") {
					const snapshot = await current.host.status(params.id);
					return result(await graphStatusTextV3(snapshot, current.config.runsDir), snapshot);
				}
				if (action === "stop") {
					const snapshot = await current.host.stop(params.id);
					return result(`Graph stopped.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, snapshot);
				}
				if (action === "resume") {
					const snapshot = await current.host.resume(params.id);
					return result(`Graph resumed.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, snapshot);
				}
				return result(`Unsupported graph action '${action}'.`, undefined, true);
			} catch (error) {
				return result(`pi-graph error: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
			}
		},
	});
}
