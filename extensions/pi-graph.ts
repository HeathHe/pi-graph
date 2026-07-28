import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";
import { GraphManager, graphSummary } from "../src/manager.ts";
import { doctorGraphRuns, formatDoctorReport } from "../src/doctor.ts";
import { recommendGraphConfig, formatRecommendReport } from "../src/recommend.ts";
import { loadGraphConfig } from "../src/config.ts";
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
import type { GraphSpec } from "../src/types.ts";

const Parameters = Type.Object({
	action: Type.Optional(Type.String({ enum: ["start", "status", "list", "stop", "resume", "doctor", "recommend"], description: "Operation. Omit for start." })),
	id: Type.Optional(Type.String({ description: "Graph id for status, stop, or resume." })),
	spec: Type.Optional(Type.Unsafe({
		type: "object",
		description: "GraphSpec v1: {schemaVersion:1, goal, nodes:[{taskId,agent,task,dependsOn?,inputArtifacts?,outputArtifact,readScope?,writeScope?,sideEffect,idempotent?,atomic?,scopeJustification?,validationCommands?,retryPolicy?,model?,timeoutMs?,allowBash?}], maxConcurrency?, failFast?, workspace?}. allowBash is opt-in for isolated local_write nodes; supervisor validation does not require it.",
		additionalProperties: true,
	})),
}, { additionalProperties: false });

function result(text: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details: details ?? {}, ...(isError ? { isError: true } : {}) };
}

export default function piGraphExtension(pi: ExtensionAPI): void {
	const manager = new GraphManager(pi);
	registerBackgroundWorkProvider({
		name: "pi-graph",
		listActiveWork: () => manager.listActiveWork(),
		wakeChannels: ["pi-graph:state"],
	});
	pi.on("session_start", async (_event, ctx) => manager.initialize(ctx));
	pi.on("session_shutdown", async () => manager.suspendAll());
	pi.registerCommand("graphs", {
		description: "Inspect, maintain, restore, or remove pi-graph runs",
		getArgumentCompletions: (prefix) => {
			const commands = ["doctor", "recommend", "list", "storage", "maintain", "pin", "unpin", "archive", "unarchive", "acknowledge", "compact", "delete", "trash", "restore", "purge", "discard-trash", "discard-staging", "discard-control"];
			const matches = commands.filter((command) => command.startsWith(prefix.trim()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
			handler: async (args, ctx) => {
				const [command = "doctor", ...argumentParts] = args.trim().split(/\s+/);
				const id = argumentParts.join(" ") || undefined;
			if (command === "recommend") {
				ctx.ui.notify(formatRecommendReport(await recommendGraphConfig()), "info");
				return;
			}
			const config = await loadGraphConfig();
			if (command === "doctor") {
				ctx.ui.notify(formatDoctorReport(await doctorGraphRuns(config.runsDir, config.maxSpawnBudget)), "info");
				return;
			}
			if (command === "list") {
				const report = await manager.listReport();
				const lines = [
					...report.snapshots.map((snapshot) => graphSummary(snapshot, config.runsDir)),
					...report.protected.map((entry) => `Graph: ${entry.graphId}\nStatus: protected\nError: ${entry.reason}`),
				];
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
				ctx.ui.notify(`Usage: /graphs recommend or /graphs ${command} <graph-or-trash-id>`, "warning");
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
				ctx.ui.notify("Usage: /graphs doctor|recommend|list|storage|maintain|pin|unpin|archive|unarchive|acknowledge|compact|delete|trash|restore|purge|discard-trash|discard-staging|discard-control", "warning");
		},
	});
	pi.registerTool({
		name: "graph",
		label: "Graph",
		description: "Execute an approved multi-node DAG durably through pi-subagents. Use only when work has independent units, dependencies, or explicit parallelism; ordinary questions and small tasks stay direct. Each writing node must declare non-overlapping writeScope and acceptance validation.",
		parameters: Parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			try {
				const action = params.action ?? "start";
				if (action === "start") {
					if (!params.spec) return result("graph start requires spec.", undefined, true);
					const snapshot = await manager.start(params.spec as GraphSpec);
					const config = await loadGraphConfig();
					return result(`Graph accepted for asynchronous execution.\n${graphSummary(snapshot, config.runsDir)}`, snapshot);
				}
				if (action === "list") {
					const config = await loadGraphConfig();
					const report = await manager.listReport();
					const lines = [
						...report.snapshots.map((snapshot) => graphSummary(snapshot, config.runsDir)),
						...report.protected.map((entry) => `Graph: ${entry.graphId}\nStatus: protected\nError: ${entry.reason}`),
					];
					return result(lines.length ? lines.join("\n\n") : "No graph runs found.", report, report.protected.length > 0);
				}
				if (action === "doctor") {
					const config = await loadGraphConfig();
					const report = await doctorGraphRuns(config.runsDir, config.maxSpawnBudget);
					return result(formatDoctorReport(report), report);
				}
				if (action === "recommend") {
					const report = await recommendGraphConfig();
					return result(formatRecommendReport(report), report);
				}
				if (!params.id) return result(`graph ${action} requires id.`, undefined, true);
				if (action === "status") {
					const snapshot = await manager.status(params.id);
					const config = await loadGraphConfig();
					return result(graphSummary(snapshot, config.runsDir), snapshot);
				}
				if (action === "stop") {
					const snapshot = await manager.stop(params.id);
					const config = await loadGraphConfig();
					return result(graphSummary(snapshot, config.runsDir), snapshot);
				}
				const snapshot = await manager.resume(params.id);
				const config = await loadGraphConfig();
				return result(`Graph resumed.\n${graphSummary(snapshot, config.runsDir)}`, snapshot);
			} catch (error) {
				return result(`pi-graph error: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
			}
		},
	});
}
