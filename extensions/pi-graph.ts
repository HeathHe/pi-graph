import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";
import { GraphManager, graphSummary } from "../src/manager.ts";
import { V3GraphHost, graphStatusTextV3, v3IsGraphSpecV3 } from "../src/v3/host.ts";
import type { GraphSpecV3 } from "../src/v3/types.ts";
import { SubagentRpcClient as V3SubagentRpcClient } from "../src/v3/rpc.ts";
import { doctorGraphRuns, formatDoctorReport } from "../src/doctor.ts";
import { loadGraphConfig } from "../src/config.ts";
import { SubagentRpcClient } from "../src/rpc.ts";
import {
	compactRun,
	cancelPrunePlan,
	createPrunePlan,
	discardControlQuarantine,
	discardOrphanPurgeStaging,
	discardProtectedTrash,
	executePrunePlan,
	formatRetentionReport,
	listTrashInventory,
	purgeTrash,
	restoreTrash,
	storageReport,
	updateHistoryFlag,
	DEFAULT_HISTORY_CONFIG,
} from "../src/retention.ts";

export const ScopeEntrySchema = Type.Object({
	kind: Type.String({ enum: ["file", "tree"], description: "Use 'file' for one file or 'tree' for a directory tree." }),
	path: Type.String({ description: "Path inside the node cwd. Absolute paths are allowed only when they remain inside cwd." }),
}, { additionalProperties: false });

export const GraphAcceptanceSchema = Type.Union([
	Type.String({ minLength: 1, description: "A directly observable completion statement." }),
	Type.Boolean({ description: "Under contractPolicy 'strict', true is valid only when validationCommands is non-empty; false is not observable." }),
	Type.Object({
		criteria: Type.Array(Type.Union([
			Type.String({ minLength: 1 }),
			Type.Object({
				id: Type.Optional(Type.String({ minLength: 1 })),
				must: Type.String({ minLength: 1 }),
			}, { additionalProperties: false, description: "Criterion objects support only optional 'id' and required 'must'." }),
		]), { minItems: 1 }),
	}, { additionalProperties: false, description: "Graph supervisor acceptance. The only top-level field is 'criteria'." }),
]);

const RetryPolicySchema = Type.Object({
	maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	maxProviderRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Used only with structured provider-failure evidence." })),
	backoffMs: Type.Optional(Type.Number({ minimum: 0, maximum: 300_000 })),
	providerBackoffMs: Type.Optional(Type.Number({ minimum: 0, maximum: 300_000 })),
	retryOn: Type.Optional(Type.Array(Type.String({ enum: ["dispatch", "timeout", "failed", "validation"] }))),
}, { additionalProperties: false });

const ChildAcceptanceCriterionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	must: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const ChildAcceptanceEvidenceSchema = Type.String({ enum: [
	"changed-files", "tests-added", "commands-run", "validation-output", "residual-risks",
	"no-staged-files", "diff-summary", "review-findings", "manual-notes",
] });

const ChildAcceptanceSchema = Type.Union([
	Type.String({ enum: ["auto", "attested", "checked", "verified"] }),
	Type.Literal(false),
	Type.Object({
		level: Type.Optional(Type.String({ enum: ["auto", "none", "attested", "checked", "verified"] })),
		criteria: Type.Optional(Type.Array(Type.Union([Type.String({ minLength: 1 }), ChildAcceptanceCriterionSchema]))),
		evidence: Type.Optional(Type.Array(ChildAcceptanceEvidenceSchema)),
		verify: Type.Optional(Type.Array(Type.Object({
			id: Type.String({ minLength: 1 }),
			command: Type.String({ minLength: 1 }),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
			cwd: Type.Optional(Type.String({ minLength: 1 })),
			env: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: { type: "string" } })),
			allowFailure: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }))),
		review: Type.Optional(Type.Union([
			Type.Literal(false),
			Type.Object({
				agent: Type.Optional(Type.String({ minLength: 1 })),
				focus: Type.Optional(Type.String({ minLength: 1 })),
				required: Type.Optional(Type.Boolean()),
			}, { additionalProperties: false }),
		])),
		stopRules: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		reason: Type.Optional(Type.String({ minLength: 1 })),
	}, { additionalProperties: false }),
]);

const MaxAuthorizationSchema = Type.Object({
	authorizationId: Type.String({ minLength: 1 }),
	issuer: Type.String({ minLength: 1 }),
	keyId: Type.String({ minLength: 1 }),
	taskBinding: Type.String({ minLength: 1 }),
	model: Type.String({ minLength: 1 }),
	thinking: Type.Literal("max"),
	issuedAt: Type.String({ minLength: 1 }),
	expiresAt: Type.String({ minLength: 1 }),
	nonce: Type.String({ minLength: 1 }),
	singleUse: Type.Literal(true),
	signature: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const ToolBudgetSchema = Type.Object({
	soft: Type.Optional(Type.Integer({ minimum: 0 })),
	hard: Type.Integer({ minimum: 1 }),
	block: Type.Optional(Type.Union([
		Type.Literal("*"),
		Type.Array(Type.String({ minLength: 1 })),
	])),
}, { additionalProperties: false });

const NodeOutputSchema = Type.Object({
	type: Type.String({ enum: ["file", "text", "json", "table", "citation-set", "url", "screenshot", "document", "email-draft", "connector-record", "decision"] }),
	path: Type.Optional(Type.String({ minLength: 1 })),
	mediaType: Type.Optional(Type.String({ minLength: 1 })),
	schema: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const ResourceScopeSchema = Type.Object({
	kind: Type.String({ enum: ["url", "domain", "service", "account", "database", "table", "record", "mailbox", "calendar", "document", "browser-session", "connector", "action"] }),
	resource: Type.String({ minLength: 1 }),
	access: Type.String({ enum: ["read", "write"] }),
	toolNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	toolInput: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true })),
}, { additionalProperties: false });

const ExternalActionSchema = Type.Object({
	service: Type.String({ minLength: 1 }),
	account: Type.Optional(Type.String({ minLength: 1 })),
	action: Type.String({ minLength: 1 }),
	target: Type.String({ minLength: 1 }),
	idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
	requiresApproval: Type.Boolean(),
	approvalRef: Type.Optional(Type.String({ minLength: 1 })),
	reversible: Type.Boolean(),
	compensation: Type.Optional(Type.String({ minLength: 1 })),
	expectedState: Type.Optional(Type.String({ minLength: 1 })),
	verifyByReadback: Type.Boolean(),
}, { additionalProperties: false });

export const GraphNodeSchema = Type.Object({
	taskId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$" }),
	agent: Type.String({ minLength: 1 }),
	task: Type.String({ minLength: 1 }),
	capabilityId: Type.Optional(Type.String({ minLength: 1, description: "Required when contractPolicy is 'strict'." })),
	dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	inputArtifacts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	outputArtifact: Type.Optional(Type.String({ minLength: 1, description: "Relative output file path under the Graph artifact directory. Optional when typed output is supplied." })),
	output: Type.Optional(NodeOutputSchema),
	readScope: Type.Optional(Type.Array(ScopeEntrySchema, { description: "Each entry is exactly {kind:'file'|'tree', path:'...'}; use [] when no repository reads are needed." })),
	writeScope: Type.Optional(Type.Array(ScopeEntrySchema, { description: "Must be [] unless sideEffect is 'local_write'." })),
	resourceScopes: Type.Optional(Type.Array(ResourceScopeSchema, { description: "Remote or connector resources, separate from local file/tree scope." })),
	externalAction: Type.Optional(ExternalActionSchema),
	sideEffect: Type.String({ enum: ["none", "local_read", "local_write", "external_read", "external_write"] }),
	idempotent: Type.Optional(Type.Boolean()),
	parallelizable: Type.Optional(Type.Boolean()),
	atomic: Type.Optional(Type.Boolean()),
	scopeJustification: Type.Optional(Type.String()),
	acceptance: Type.Optional(GraphAcceptanceSchema),
	childAcceptance: Type.Optional(ChildAcceptanceSchema),
	validationCommands: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Deterministic supervisor commands executed in the node workspace cwd. Usually omit this field for read-only review/search nodes and use acceptance criteria instead. A git command works only when that cwd is itself a Git repository; a parent directory containing nested repositories is not sufficient. Commands do not require allowBash." })),
	retryPolicy: Type.Optional(RetryPolicySchema),
	taskRisk: Type.Optional(Type.String({ enum: ["low", "medium", "high"] })),
	routingProfile: Type.Optional(Type.String({ minLength: 1 })),
	producerRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	maxAuthorization: Type.Optional(MaxAuthorizationSchema),
	model: Type.Optional(Type.String({ minLength: 1 })),
	thinking: Type.Optional(Type.String({ enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] })),
	context: Type.Optional(Type.Object({
		packId: Type.String(), revision: Type.String(), digest: Type.String(), decisionRevision: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
	cwd: Type.Optional(Type.String({ description: "Node working directory; it must remain inside the Graph source cwd. validationCommands run here, so choose the actual package/repository root required by those commands." })),
	progress: Type.Optional(Type.Boolean()),
	toolBudget: Type.Optional(ToolBudgetSchema),
	priority: Type.Optional(Type.Number()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 7_200_000 })),
	resourceClass: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$" })),
	allowDelete: Type.Optional(Type.Boolean()),
	allowBash: Type.Optional(Type.Boolean({ description: "Deprecated and rejected. Child Bash is disabled; trusted deterministic validationCommands run under the Supervisor without this field." })),
}, { additionalProperties: false });

export const GraphSpecSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	graphId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$" })),
	goal: Type.String({ minLength: 1 }),
	contractPolicy: Type.Optional(Type.String({ enum: ["legacy", "strict"] })),
	context: Type.Optional(Type.Object({
		packId: Type.String(), revision: Type.String(), digest: Type.String(), decisionRevision: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
	nodes: Type.Array(GraphNodeSchema, { minItems: 1 }),
	maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
	failFast: Type.Optional(Type.Boolean()),
	workspace: Type.Optional(Type.String({ enum: ["auto", "shadow", "git"] })),
}, {
	additionalProperties: false,
	description: "GraphSpec v1. Nodes need outputArtifact or typed output. Strict nodes need capabilityId plus observable acceptance. External writes additionally require write resourceScopes and a fully authorized, verifiable externalAction contract.",
});

export const GraphSpecV3NodeSchema = Type.Object({
	taskId: Type.String({ minLength: 1 }),
	agent: Type.String({ minLength: 1 }),
	task: Type.String({ minLength: 1 }),
	dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	inputArtifacts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	outputArtifact: Type.Optional(Type.String({ minLength: 1 })),
	readScope: Type.Optional(Type.Array(ScopeEntrySchema)),
	writeScope: Type.Optional(Type.Array(ScopeEntrySchema)),
	sideEffect: Type.Optional(Type.String({ enum: ["none", "local_read", "local_write"] })),
	acceptance: Type.Optional(Type.String({ description: "Declared natural-language acceptance; never used for verdicts unless machine-verified." })),
	childAcceptance: Type.Optional(Type.Object({ criteria: Type.Array(Type.String({ minLength: 1 })) })),
	validationCommands: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	retryPolicy: Type.Optional(Type.Object({
		maxAttempts: Type.Integer({ minimum: 1 }),
		retryOn: Type.Array(Type.String({ enum: ["task_failed", "validation", "timeout", "workspace_conflict"] })),
		backoffMs: Type.Integer({ minimum: 0 }),
	})),
}, { additionalProperties: false });

export const GraphSpecV3Schema = Type.Object({
	schemaVersion: Type.Literal(3),
	graphId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	goal: Type.String({ minLength: 1 }),
	nodes: Type.Array(GraphSpecV3NodeSchema, { minItems: 1 }),
	maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
	failFast: Type.Optional(Type.Boolean()),
	workspace: Type.Optional(Type.String({ enum: ["auto", "shadow", "git"] })),
}, {
	additionalProperties: false,
	description: "GraphSpec v3: governance-free DAG executed by the V3 kernel. Strict validation happens in the compiler; this schema only routes.",
});

export const Parameters = Type.Object({
	action: Type.Optional(Type.String({ enum: ["start", "status", "list", "stop", "resume", "doctor"], description: "Operation. Omit for start." })),
	id: Type.Optional(Type.String({ description: "Graph id for status, stop, or resume." })),
	spec: Type.Optional(GraphSpecV3Schema),
}, { additionalProperties: false });

function result(text: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details: details ?? {}, ...(isError ? { isError: true } : {}) };
}

function trustedSessionId(ctx: { sessionManager: { getSessionId: () => string } }): string {
	const sessionId = ctx.sessionManager.getSessionId();
	if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Graph start requires a trusted Pi session ID.");
	return sessionId.trim();
}

function commandSessionId(ctx: { sessionManager?: { getSessionId: () => string } }): string {
	try {
		return trustedSessionId(ctx as { sessionManager: { getSessionId: () => string } });
	} catch {
		return "graph-command";
	}
}

export default function piGraphExtension(pi: ExtensionAPI): void {
	const manager = new GraphManager(pi);
	const rpc = new SubagentRpcClient(pi.events);
	const v3Rpc = new V3SubagentRpcClient(pi.events);
	const startExecutions = new Map<string, { signature: string; promise: Promise<ReturnType<typeof result>> }>();
	let v3Host: V3GraphHost | undefined;
	let supervisorEpochV3 = `v3-${Date.now()}`;
	const ensureV3Host = (config: { runsDir: string }, sessionId: string): V3GraphHost => {
		if (!v3Host) v3Host = new V3GraphHost({ rpc: v3Rpc, runsDir: config.runsDir, sessionId, supervisorEpoch: supervisorEpochV3 });
		else v3Host.setSessionContext(sessionId, supervisorEpochV3);
		return v3Host;
	};
	registerBackgroundWorkProvider({
		name: "pi-graph",
		listActiveWork: () => manager.listActiveWork(),
		wakeChannels: ["pi-graph:state"],
	});
	pi.on("session_start", async (_event, ctx) => {
		startExecutions.clear();
		supervisorEpochV3 = `v3-${Date.now()}`;
		await manager.initialize(ctx);
		// Recover any V3 runs left mid-flight by a crashed/previous supervisor.
		try {
			const config = await loadGraphConfig();
			const host = ensureV3Host(config, trustedSessionId(ctx));
			await host.adoptCrashedRuns();
		} catch {
			// Adoption must not break session startup; doctor can surface issues.
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		startExecutions.clear();
		await manager.suspendAll();
		v3Host?.suspendAll();
	});
	pi.registerCommand("graphs", {
		description: "Inspect, maintain, restore, or remove pi-graph runs",
		getArgumentCompletions: (prefix) => {
			const commands = ["doctor", "list", "storage", "maintain", "pin", "unpin", "archive", "unarchive", "acknowledge", "compact", "delete", "trash", "restore", "purge", "discard-trash", "discard-staging", "discard-control"];
			const matches = commands.filter((command) => command.startsWith(prefix.trim()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
			handler: async (args, ctx) => {
				const [command = "doctor", ...argumentParts] = args.trim().split(/\s+/);
				const id = argumentParts.join(" ") || undefined;
			const config = await loadGraphConfig();
			const host = ensureV3Host(config, commandSessionId(ctx));
			if (command === "doctor") {
				const report = await doctorGraphRuns(config.runsDir, config.maxSpawnBudget);
				const v3Doctor = await host.doctor();
				const v3Lines = v3Doctor.issues.map((issue) => `Graph: ${issue.runId ?? "<unknown>"}\nV3 ${issue.kind}: ${issue.detail}`);
				ctx.ui.notify(`${formatDoctorReport(report)}${v3Lines.length ? `\n\nV3 issues:\n${v3Lines.join("\n")}` : ""}`, report.protected > 0 || v3Doctor.issues.length > 0 ? "warning" : "info");
				return;
			}
			if (command === "list") {
				const report = await manager.listReport();
				const lines = [
					...report.snapshots.map((snapshot) => graphSummary(snapshot, config.runsDir)),
					...report.protected.map((entry) => `Graph: ${entry.graphId}\nStatus: protected\nError: ${entry.reason}`),
				];
				for (const summary of await host.list()) lines.push(await graphStatusTextV3(summary.snapshot, config.runsDir));
				ctx.ui.notify(lines.length ? lines.join("\n\n") : "No graph runs found.", report.protected.length ? "warning" : "info");
				return;
			}
			if (command === "storage") {
				ctx.ui.notify(formatRetentionReport(await storageReport(config)), "info");
				return;
			}
			if (command === "maintain") {
				ctx.ui.notify(formatRetentionReport(await manager.runMaintenance()), "info");
				return;
			}
			if (command === "trash") {
				const inventory = await listTrashInventory(config.runsDir);
				const lines = [
					...inventory.valid.map((record) => `${record.trashId} | trashed ${record.trashedAt} | purge after ${record.purgeAfter}`),
					...inventory.protected.map((entry) => `${entry.trashId} | PROTECTED | ${entry.reason}`),
				];
				ctx.ui.notify(lines.length ? lines.join("\n") : "Trash is empty.", inventory.protected.length ? "warning" : "info");
				return;
			}
			if (command === "purge") {
				const confirmed = await ctx.ui.confirm("Purge Graph Trash", "Permanently delete every item whose Trash grace period has elapsed?");
				if (!confirmed) return;
				const purged = await purgeTrash(config.runsDir);
				ctx.ui.notify(`Purged ${purged.length} Trash item(s).`, "info");
				return;
			}
			if (!id) {
				ctx.ui.notify(`Usage: /graphs ${command} <graph-or-trash-id>`, "warning");
				return;
			}
			if (["pin", "unpin", "archive", "unarchive"].includes(command)) {
				await updateHistoryFlag(config.runsDir, id, command as "pin" | "unpin" | "archive" | "unarchive");
				ctx.ui.notify(`Graph '${id}' updated: ${command}.`, "info");
				return;
			}
			if (command === "acknowledge") {
				const confirmed = await ctx.ui.confirm("Acknowledge Graph Risk", `Acknowledge the terminal incidents for '${id}'? This does not delete the run, but it allows a later explicit delete confirmation.`);
				if (!confirmed) return;
				await updateHistoryFlag(config.runsDir, id, "acknowledge");
				ctx.ui.notify(`Graph '${id}' incidents acknowledged.`, "warning");
				return;
			}
			if (command === "compact") {
				const result = await compactRun(config.runsDir, id, { force: true });
				ctx.ui.notify(result.compacted ? `Graph '${id}' compacted; reclaimed ${(result.bytesReclaimed / 1024 ** 2).toFixed(1)} MiB.` : `Graph '${id}' was not compacted: ${result.reason}.`, result.compacted ? "info" : "warning");
				return;
			}
			if (command === "delete") {
				const plan = await createPrunePlan(config.runsDir, [id]);
				const confirmed = await ctx.ui.confirm("Move Graph To Trash", `Move '${id}' to same-disk Trash? It can be restored during the grace period.\nPlan: ${plan.planId}`);
				if (!confirmed) {
					await cancelPrunePlan(config.runsDir, plan.planId);
					return;
				}
				const policy = config.history ?? DEFAULT_HISTORY_CONFIG;
				const trashed = await executePrunePlan(config.runsDir, plan.planId, policy.trashGraceDays, plan.planDigest);
				ctx.ui.notify(`Moved to Trash: ${trashed.join(", ")}`, "info");
				return;
			}
			if (command === "restore") {
				ctx.ui.notify(`Restored Graph '${await restoreTrash(config.runsDir, id)}'.`, "info");
				return;
			}
			if (command === "discard-trash") {
				const confirmed = await ctx.ui.confirm("Discard Protected Trash", `Permanently delete the invalid protected Trash directory '${id}'? Its metadata cannot be validated, so this cannot be undone.`);
				if (!confirmed) return;
				await discardProtectedTrash(config.runsDir, id);
				ctx.ui.notify(`Discarded protected Trash '${id}'.`, "warning");
				return;
			}
				if (command === "discard-staging") {
				const confirmed = await ctx.ui.confirm("Discard Orphan Purge Staging", `Permanently delete orphan purge staging '${id}'? Its durable authorization is missing or invalid, so inspect it first. This cannot be undone.`);
				if (!confirmed) return;
				await discardOrphanPurgeStaging(config.runsDir, id);
				ctx.ui.notify(`Discarded orphan purge staging '${id}'.`, "warning");
					return;
				}
				if (command === "discard-control") {
					const confirmed = await ctx.ui.confirm("Discard Quarantined Control Metadata", `Permanently delete quarantined control metadata '${id}'? This command never deletes Graph, Trash, or staging payloads.`);
					if (!confirmed) return;
					ctx.ui.notify(`Discarded ${await discardControlQuarantine(config.runsDir, id)}.`, "warning");
					return;
				}
				ctx.ui.notify("Usage: /graphs doctor|list|storage|maintain|pin|unpin|archive|unarchive|acknowledge|compact|delete|trash|restore|purge|discard-trash|discard-staging|discard-control", "warning");
		},
	});
	pi.registerTool({
		name: "graph",
		label: "Graph",
		description: "Execute an approved multi-node DAG durably through pi-subagents. Use only when work has independent units, dependencies, or explicit parallelism; ordinary questions and small tasks stay direct. Each writing node must declare non-overlapping writeScope and acceptance validation.",
		parameters: Parameters,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const action = params.action ?? "start";
				if (action === "start") {
					if (!params.spec) return result("graph start requires spec.", undefined, true);
					const spec = params.spec;
					if (!v3IsGraphSpecV3(spec)) return result("Graph start now requires GraphSpec v3 (schemaVersion: 3). Legacy GraphSpec v1 starts are retired with the planning gate.", undefined, true);
					const sessionId = trustedSessionId(ctx);
					const signature = JSON.stringify({ sessionId, cwd: ctx.cwd, v3: spec });
					const existing = startExecutions.get(toolCallId);
					if (existing) {
						if (existing.signature !== signature) return result("A graph start toolCallId cannot be reused with a different GraphSpec.", undefined, true);
						return existing.promise;
					}
					const promise = (async () => {
						const config = await loadGraphConfig();
						const host = ensureV3Host(config, sessionId);
						const started = await host.start(spec as GraphSpecV3, ctx.cwd);
						return result(`Graph accepted for asynchronous V3 execution.\n${await graphStatusTextV3(started.snapshot, config.runsDir)}`, started.snapshot);
					})();
					startExecutions.set(toolCallId, { signature, promise });
					return promise;
				}
				if (action === "list") {
					const config = await loadGraphConfig();
					const host = ensureV3Host(config, trustedSessionId(ctx));
					const report = await manager.listReport();
					const lines = [
						...report.snapshots.map((snapshot) => graphSummary(snapshot, config.runsDir)),
						...report.protected.map((entry) => `Graph: ${entry.graphId}\nStatus: protected\nError: ${entry.reason}`),
					];
					const v3Summaries = await host.list();
					for (const summary of v3Summaries) lines.push(await graphStatusTextV3(summary.snapshot, config.runsDir));
					return result(lines.length ? lines.join("\n\n") : "No graph runs found.", { legacy: report, v3: v3Summaries }, report.protected.length > 0);
				}
				if (action === "doctor") {
					const config = await loadGraphConfig();
					const host = ensureV3Host(config, trustedSessionId(ctx));
					const report = await doctorGraphRuns(config.runsDir, config.maxSpawnBudget);
					const v3Doctor = await host.doctor();
					const v3Lines = v3Doctor.issues.map((issue) => `Graph: ${issue.runId ?? "<unknown>"}\nV3 ${issue.kind}: ${issue.detail}`);
					const text = `${formatDoctorReport(report)}${v3Lines.length ? `\n\nV3 issues:\n${v3Lines.join("\n")}` : ""}`;
					return result(text, { legacy: report, v3: v3Doctor }, report.protected > 0 || v3Doctor.issues.length > 0);
				}
				if (!params.id) return result(`graph ${action} requires id.`, undefined, true);
				const config = await loadGraphConfig();
				const host = ensureV3Host(config, trustedSessionId(ctx));
				if (action === "status" || action === "stop" || action === "resume") {
					if (await host.isV3Run(host.runDirFor(params.id))) {
						if (action === "status") {
							const snapshot = await host.status(params.id);
							return result(await graphStatusTextV3(snapshot, config.runsDir), snapshot);
						}
						if (action === "stop") {
							const snapshot = await host.stop(params.id);
							return result(`Graph stopped.\n${await graphStatusTextV3(snapshot, config.runsDir)}`, snapshot);
						}
						const snapshot = await host.resume(params.id);
						return result(`Graph resumed.\n${await graphStatusTextV3(snapshot, config.runsDir)}`, snapshot);
					}
				}
				if (action === "status") {
					const snapshot = await manager.status(params.id);
					return result(graphSummary(snapshot, config.runsDir), snapshot);
				}
				if (action === "stop") {
					const snapshot = await manager.stop(params.id);
					return result(graphSummary(snapshot, config.runsDir), snapshot);
				}
				const snapshot = await manager.resume(params.id);
				return result(`Graph resumed.\n${graphSummary(snapshot, config.runsDir)}`, snapshot);
			} catch (error) {
				return result(`pi-graph error: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
			}
		},
	});
}
