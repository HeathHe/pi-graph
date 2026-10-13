import { safeBytes } from '../src/v3/evidence-files.ts';
import { validateGraphSnapshotV3 } from '../src/v3/snapshot.ts';
import { compactToolReceipt } from '../src/v3/ui/tool-receipt.ts';
import { AttentionPageSnapshots } from '../src/v3/attention-pages.ts';
import {registerGraphModelSettings} from "./graph-settings.ts";
import { readAcceptedNativeResultPage, readAcceptedArtifactPage, sendSelectedNode, terminalText, type GraphUiAction } from "../src/v3/ui/interaction.ts";
import { activeMailboxes, mailboxRegistryKey, inspectMailboxParent } from "../src/v3/mailbox-runtime.ts";
import { summarizeMainSession } from "../src/v3/usage-summary.ts";
import { GraphSourceChangedError, graphResultReceipt, readGraphResult, boundedGraphToolResult, pageGraphData } from "../src/v3/result-receipt.ts";
import { NATIVE_SUPERVISOR_EVENT, readGraphSupervisorRequests, type NativeSupervisorRequest } from "../src/v3/native-supervisor.ts";
import { GraphInspector } from "../src/v3/ui/inspector.ts";
import { enrichGraphView, readGraphView, listGraphViews } from "../src/v3/ui/read-view.ts";
import { nodeActivityLines, nodeReason, compactGraphLines, counts, graphLabel, colorCompactLine, safeText, errorSummary } from "../src/v3/ui/presentation.ts";
import { supervisionFacts } from "../src/v3/observability.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey } from "@earendil-works/pi-tui";
import { GraphParentWake, registerBackgroundWorkProvider } from "../src/runtime/background-work.ts";
import { GraphRuntimeController } from "../src/runtime/controller.ts";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	readV3CapabilityCatalog,
	type V3CapabilityCatalogReadOptions,
} from "../src/v3/binding.ts";
import { compileGraphSpecV3, MAX_TASK_ID_LENGTH_V3 } from "../src/v3/compiler.ts";
import { loadV3GraphConfig, type V3GraphConfig } from "../src/v3/config.ts";
import { GraphV3Error } from "../src/v3/errors.ts";
import { loadV3GraphCapsule, resolveV3GraphCapsule } from "../src/v3/graph-capsule.ts";
import { V3GraphHost, graphStatusTextV3, v3IsGraphSpecV3 } from "../src/v3/host.ts";
import { readV3MutationJournal, V3RevisionConflictError, type V3GraphMutationState } from "../src/v3/mutations.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { listBuiltinGraphTemplatesV3, resolveBuiltinGraphTemplateV3 } from "../src/v3/templates.ts";
import type { GraphSnapshotV3, GraphSpecV3, V3ChildObservation } from "../src/v3/types.ts";
import {
	bindGraphNodesWithRoutingV3,
	bindGraphSpecWithRoutingV3,
	type RoutingAdmissionOptionsV3,
	readAcceptedProducerModelsV3,
	type RoutingAdmissionReceiptV3,
} from "./routing-admission.ts";

export const ScopeEntrySchema = Type.Object({
	kind: Type.String({ enum: ["file", "tree"], description: "Use 'file' for one file or 'tree' for a directory tree." }),
	path: Type.String({ minLength: 1, description: "Project-relative path inside the graph source directory." }),
}, { additionalProperties: false });

const CapabilityIdSchema = Type.String({
	pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$",
	description: "Portable capability ID resolved to one exact Pi Agent before DAG admission.",
});

const UsageLimitSchema = Type.Object({
	soft: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	hard: Type.Number({ exclusiveMinimum: 0 }),
}, { additionalProperties: false });

export const GraphSpecV3NodeSchema = Type.Object({
	taskId: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3 }),
	agent: Type.Optional(Type.String({ minLength: 1, description: "Exact Pi Agent. Optional when capabilityId/requires selects one through Binding." })),
	capabilityId: Type.Optional(CapabilityIdSchema),
	requires: Type.Optional(Type.Array(CapabilityIdSchema, {
		minItems: 1,
		uniqueItems: true,
		description: "Capabilities that must all resolve to the same exact Pi Agent.",
	})),
	model: Type.Optional(Type.String({ minLength: 1, description: "Pi-native model preference resolved by pi-graph preflight; not a DAG-core routing decision." })),
	thinking: Type.Optional(Type.Union([
		Type.String({ minLength: 1 }),
		Type.Literal(false),
	], { description: "Pi-native thinking preference, or false to disable it." })),
	turnBudget: Type.Optional(Type.Object({
		maxTurns: Type.Integer({ minimum: 1 }),
		graceTurns: Type.Optional(Type.Integer({ minimum: 0 })),
	}, { additionalProperties: false })),
	toolBudget: Type.Optional(Type.Object({
		soft: Type.Optional(Type.Integer({ minimum: 1 })),
		hard: Type.Integer({ minimum: 1 }),
		block: Type.Optional(Type.Union([
			Type.Literal("*"),
			Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, uniqueItems: true }),
		])),
	}, { additionalProperties: false })),
	usageBudget: Type.Optional(Type.Object({
		tokens: Type.Optional(UsageLimitSchema),
		costUsd: Type.Optional(UsageLimitSchema),
	}, { additionalProperties: false, minProperties: 1 })),
	maxTokens: Type.Optional(Type.Integer({ minimum: 16, description: "Maximum output tokens for each provider request, enforced inside the child by Graph Guard." })),
	task: Type.String({ minLength: 1 }),
	dependsOn: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3 }), { uniqueItems: true })),
	when: Type.Optional(Type.Object({
		node: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3 }),
		status: Type.String({ enum: ["accepted", "failed"] }),
	}, { additionalProperties: false, description: "Run only when this direct dependency reaches the requested terminal status." })),
	inputArtifacts: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
 fallbackAgents: Type.Optional(Type.Array(Type.String({minLength:1}),{minItems:1,maxItems:8,uniqueItems:true})),
 dependencyInputs: Type.Optional(Type.Array(Type.Object({from:Type.String(),field:Type.String({enum:["status","reason","evidenceFiles"]}),type:Type.String({enum:["string","artifact-list"]}),as:Type.String()},{additionalProperties:false}),{maxItems:64})),
	resultContract: Type.Optional(Type.Literal("status-json", {description: "Require exact final JSON {status: pass|blocked|fail, reason: string}; blocked/fail stops accepted-only dependents without retry."})),
	evidenceFiles: Type.Optional(Type.Array(Type.Object({path: Type.String({minLength: 1}), nonSecret: Type.Literal(true)}), {maxItems: 64, description: "Explicit non-secret workspace-relative files to retain before cleanup; downstream inputs include <artifact>.files/<path>."})),
	outputArtifact: Type.Optional(Type.String({ minLength: 1 })),
	requiredMaterials: Type.Optional(Type.Array(Type.String({minLength: 1}), {uniqueItems: true, description: "Source-relative required files; host checks existence and readable scope before any child starts."})),
	readScope: Type.Optional(Type.Array(ScopeEntrySchema)),
	writeScope: Type.Optional(Type.Array(ScopeEntrySchema)),
	readOnly: Type.Optional(Type.Boolean({ description: "Restrict this node to read-only tools; graph readOnly cannot be overridden." })),
	sideEffect: Type.String({ enum: ["none", "local_read", "local_write", "external_read", "external_write"] }),
	acceptance: Type.Optional(Type.String({ minLength: 1, description: "Declarative only unless backed by deterministic validation." })),
	validationCommands: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
		description: "Deterministic Supervisor commands. Required for local_write; forbidden for other side effects; inherited commands run with the parent OS permissions.",
	})),
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
	contextPolicy: Type.Optional(Type.String({ enum: ["v1", "disabled"] })),
	permissionPolicy: Type.Optional(Type.String({ enum: ["inherited", "strict"], description: "New graphs default to inherited parent permissions; strict explicitly retains legacy restrictions." })),
	contractPolicy: Type.Optional(Type.String({
		enum: ["standard", "strict"],
		description: "Binding policy. strict requires capability contracts; standard also accepts exact Agent authoring and optional unmatched-capability fallback.",
	})),
}, {
	additionalProperties: false,
	description: "Public GraphSpec V3 authoring contract. Binding resolves capabilities and Pi launch hints before the governance-free DAG core compiles it.",
});

export const Parameters = Type.Object({
 mailbox: Type.Optional(Type.Object({action:Type.String(),to:Type.Optional(Type.String()),kind:Type.Optional(Type.String()),text:Type.Optional(Type.String()),idempotencyKey:Type.Optional(Type.String()),messageId:Type.Optional(Type.String()),offset:Type.Optional(Type.Integer({minimum:0}))},{additionalProperties:false})),
 expectedSha256: Type.Optional(Type.String({pattern:"^[a-fA-F0-9]{64}$",description:"Copy from nextRequest to bind continuation to the full source hash."})),
 offset: Type.Optional(Type.Integer({minimum:0,description:"Page start in Unicode code points (default 0). Copy nextRequest exactly for continuation."})),
 limit: Type.Optional(Type.Integer({minimum:1,maximum:8192,description:"Maximum Unicode code points per page: default 4096, maximum 8192. Byte budgets may shorten a page; copy nextRequest exactly, never increase limit."})),
 attempt: Type.Optional(Type.Integer({minimum:1,description:"Result attempt; omitted selects latest. Copy nextRequest exactly to keep continuation bound to the original attempt."})),
	action: Type.Optional(Type.String({
		enum: ["start", "wait", "result", "attention", "mailbox", "usage", "load", "status", "list", "doctor", "pause", "resume", "stop", "templates", "agents", "retry", "append", "cancel", "seal"],
		description: "V3 graph operation. Omit for start. wait streams live snapshots until the graph settles or a live child needs attention; topology mutations require revision compare-and-set.",
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
	node: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3, description: "Target node for result reads, or root node for an explicit retry." })),
	revision: Type.Optional(Type.Integer({ minimum: 0 })),
	nodes: Type.Optional(Type.Array(GraphSpecV3NodeSchema, { minItems: 1, maxItems: 64 })),
	taskIds: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: MAX_TASK_ID_LENGTH_V3 }), { minItems: 1, uniqueItems: true })),
	cascade: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const PI_GRAPH_ROUTING_SENTINEL = "## PI-GRAPH Routing";
export const PI_GRAPH_ROUTING_GUIDANCE = `${PI_GRAPH_ROUTING_SENTINEL}

Delegate all actual investigation and execution. The parent Agent may use read-only tools to define a task, inspect evidence, and review results, but must not perform the delegated work itself. Use the \`graph\` tool for coordinated work units, fan-out/fan-in, a dependency chain, implementation plus independent testing, review, or validation, deterministic validation gates, or durable pause/resume/retry needs. When any of these conditions is present, explicitly create a graph.

Use Graph for every capability-authored task that needs dynamic model routing, including a single-node task. Use Graph for two or more actual execution units, including independent tasks, dependencies, implementation plus review, or validation. The parent must explicitly use Graph for execution.

New Graphs inherit the parent tool ceiling and existing user authorization. Explicit graph/node readOnly, non-empty toolFilter, and Agent tool restrictions still apply. Use external_read/external_write for authorized external actions; their results are declared, not rollbackable or machine-verified. Missing runtime tools must be reported precisely. Legacy runs retain strict permissions. Required source materials must be listed in readScope and requiredMaterials before start; prose MustRead grants and copies nothing. For readonly directory discovery and hashes use graph_readonly_list, graph_readonly_find, graph_readonly_sha256 with matching scopes. Do not add task or reply runtime deadlines unless the user explicitly asks.

Human input is a blocked handoff, not executable work. Before starting a child, require the user-saved file, login confirmation, permission decision, or other manual input needed for that task. If missing, state exactly what is missing and the non-secret known path; use an available goal_wait tool to wait for the user reply, or end the turn and wait if no such tool is present. Keep an existing Graph mailbox request or pause when appropriate; do not add watcher tasks. Children report blocked and return control. Do not use fs.watch, polling, or sleep to occupy bash timeout: 600 waiting for a person, and never redispatch the same watcher after a timeout. Do not read or echo credentials. Explicitly requested bounded application/file-event tests remain allowed. This is an authoring contract, not a runtime ban on all watchers.

For a simple isolated execution task, use a single-node Graph with an explicit role. The parent may answer ordinary questions and perform read-only review directly. If no specialist fits, define a narrow contract and explicitly assign the existing generalist; do not silently map an unknown capability or enable temporary agents. If the Capability Contract mandates shadow isolation, use Graph or report the conflict.

PI-GRAPH does not start itself; the parent Agent must explicitly call the \`graph\` tool. Child Agents are started and controlled by the owned Graph runtime.

\`graph\` action \`start\` is asynchronous. If the current turn needs the graph's results, call \`graph\` with \`action: "wait"\` after \`start\`, then synthesize the settled node results before answering the user.
Esc cancels the Pi turn and requests a stop for graphs explicitly started or waited on in this session, including graphs that yielded attention, when the parent turn is being aborted. Escape while Pi is idle does not stop graphs; use graph action stop. Inspector Esc only closes the inspector; reload suspends supervision. A stop request is not confirmed child exit; report needs_attention when exit cannot be confirmed.

For external_write work followed by review/archive, declare evidenceFiles with nonSecret:true for each exact file authorized for retention. Never declare credentials, session files, or whole directories. For reviews that must PASS before a dependent starts, set resultContract:"status-json"; the child must end with exact JSON {"status":"pass"|"blocked"|"fail","reason":"..."}. BLOCKED is a completed business result, not an infinite supervisor conversation. Old graphs without these fields keep legacy semantics and deleted files cannot be recovered.
If graph wait returns attention_required, the graph is still running. Inspect the current child state and pending Graph mailbox decision before acting; handle a genuine request or notify the user when a decision is needed. Do not repeatedly call wait while the same unresolved issue remains, and do not treat silence as failure. After resolving it, continue waiting for settled results.

Paged result/attention reads use Unicode code points: default limit 4096, maximum 8192. Start with {"action":"result","id":"<graph>","node":"<task>"} or {"action":"attention","id":"<graph>"}. Copy the returned nextRequest exactly until it is null; never increase limit or rerun a task to read its output. Byte budgets may shorten pages. nextRequest carries expectedSha256. A source_changed response is recoverable:true and isError:false, with restartRequest at offset 0 and no page text. Discard all old page fragments and copy restartRequest exactly without changing limit; automatically restart this read at most once, without user approval. It is only a read recovery, not execution failure: never rerun, retry, stop or replay a child task. If recovery happens again in the same read, stop the loop and use /graphs details or report the read reason. Attention and result-without-node snapshots renew a 120-second idle lease on valid continuations, with a 10-minute maximum lifetime; a fresh offset-0 read observes latest state.

Final delivery: after waiting, integrate all settled results into one self-contained final answer. If a later result materially changes the answer, provide the complete updated conclusion in the latest reply; do not merely say it was included above. A duplicate completion or a resolved reminder is not a new user task.

User-facing CLI reports: lead with what was completed and what remains, then the root cause and at most one immediate decision needed from the user. Group identical service errors; distinguish tasks that failed from tasks that never ran due to fail-fast or unmet dependencies, using execution evidence. By default use a short paragraph or up to three bullets; preserve substantive findings the user asked for. Keep raw errors, state JSON, run IDs, workspace paths and Git hashes out of the reply unless needed to act or explicitly requested. The live summary and \`/graphs\` inspector hold operational detail; do not repeat their counters and command in every message. Ask a single next-step question only when authorization or information is actually missing; do not bundle unrelated business questions into failure recovery. Do not retry or switch models solely to improve the displayed status.`;

export const PI_GRAPH_ROUTING_GUIDANCE_VERSION = "10";
export const PI_GRAPH_ROUTING_GUIDANCE_HASH = createHash("sha256").update(PI_GRAPH_ROUTING_GUIDANCE, "utf8").digest("hex");

export interface PiGraphRoutingDiagnosticsV3 {
	version: string;
	hash: string;
	observed: boolean;
	enabled: boolean | null;
	graphVisible: boolean | null;
	injected: boolean | null;
}

/** Build privacy-safe, process-local routing diagnostics without retaining either prompt. */
export function piGraphRoutingDiagnosticsV3(
	enabled?: boolean,
	selectedTools?: readonly string[],
	injected?: boolean,
): PiGraphRoutingDiagnosticsV3 {
	return {
		version: PI_GRAPH_ROUTING_GUIDANCE_VERSION,
		hash: PI_GRAPH_ROUTING_GUIDANCE_HASH,
		observed: enabled !== undefined,
		enabled: enabled ?? null,
		graphVisible: enabled === undefined ? null : selectedTools?.includes("graph") === true,
		injected: enabled === undefined ? null : injected === true,
	};
}

export const PI_GRAPH_TOOL_DESCRIPTION = `Compile and execute durable GraphSpec V3 DAGs through its owned Pi SDK child runtime.

${PI_GRAPH_ROUTING_GUIDANCE}

Supports capability-to-Agent binding, Pi-native model and budget preferences, live wait observation, open topology, conditions, revision-CAS mutations, pause/resume, and explicit retry.`;

export function shouldInjectPiGraphRoutingGuidanceV3(enabled: boolean, selectedTools: readonly string[] | undefined): boolean {
	return enabled && selectedTools?.includes("graph") === true;
}

/** Append the fixed parent-routing contract once without changing the user prompt. */
export function withPiGraphRoutingGuidanceV3(systemPrompt: string, enabled = true): string | undefined {
	if (!enabled || systemPrompt.includes(PI_GRAPH_ROUTING_SENTINEL)) return undefined;
	return `${systemPrompt}\n\n${PI_GRAPH_ROUTING_GUIDANCE}`;
}

interface PublicProjectAgentV3 {
	name: string;
	description: string;
	aliases?: string[];
}

export interface PublicCapabilityBindingV3 {
	capabilityId: string;
	agent: string;
}

/** List the exact capability-to-Agent mappings used by Binding, without model policy metadata. */
export async function listCapabilityBindingsV3(
	options: V3CapabilityCatalogReadOptions = {},
): Promise<{ digest: string; entries: PublicCapabilityBindingV3[] } | undefined> {
	try {
		const catalog = await readV3CapabilityCatalog(options);
		return {
			digest: catalog.digest,
			entries: catalog.entries.map(({ capabilityId, agent }) => ({ capabilityId, agent })),
		};
	} catch (error) {
		const cause = error instanceof Error ? error.cause : undefined;
		if (typeof cause === "object" && cause !== null && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
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
	return boundedGraphToolResult(text,details,isError);
}

const ANSI_CSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const TUI_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Width used by the TUI renderer after ANSI escapes are removed. */
export function graphVisibleWidthV3(value: string): number {
	const plain = value.replaceAll(ANSI_CSI_PATTERN, "");
	let width = 0;
	for (const { segment } of TUI_SEGMENTER.segment(plain)) {
		if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(segment)) continue;
		if (/\p{Extended_Pictographic}/u.test(segment) || /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(segment)) width += 2;
		else width += 1;
	}
	return width;
}

function truncateGraphLineV3(value: string, width: number): string {
	if (width <= 0) return "";
	if (graphVisibleWidthV3(value) <= width) return value;
	const target = Math.max(0, width - 1);
	let visible = 0;
	let output = "";
	let cursor = 0;
	for (const match of value.matchAll(ANSI_CSI_PATTERN)) {
		const index = match.index;
		const plain = value.slice(cursor, index);
		for (const { segment } of TUI_SEGMENTER.segment(plain)) {
			const segmentWidth = graphVisibleWidthV3(segment);
			if (visible + segmentWidth > target) return `${output}…\u001b[0m`;
			output += segment;
			visible += segmentWidth;
		}
		output += match[0];
		cursor = index + match[0].length;
	}
	for (const { segment } of TUI_SEGMENTER.segment(value.slice(cursor))) {
		const segmentWidth = graphVisibleWidthV3(segment);
		if (visible + segmentWidth > target) break;
		output += segment;
		visible += segmentWidth;
	}
	return `${output}…\u001b[0m`;
}

export class GraphTextComponent {
	constructor(private readonly text: string) {}
	render(width: number): string[] { return this.text.split("\n").map((line) => truncateGraphLineV3(line, width)); }
	invalidate(): void {}
}

function graphSnapshotFromDetails(details: unknown): GraphSnapshotV3 | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const record = details as Record<string, unknown>;
	const candidate = typeof record.snapshot === "object" && record.snapshot !== null ? record.snapshot : record;
	if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;
	return typeof (candidate as Record<string, unknown>).graphId === "string" && typeof (candidate as Record<string, unknown>).status === "string"
		? candidate as GraphSnapshotV3
		: undefined;
}

function compactSessionReference(value: string): string {
	const name = basename(value);
	return name.length > 32 ? `${name.slice(0, 29)}…` : name;
}

function observationIdentityFacts(observation: V3ChildObservation | undefined, resolvedAgent: string | undefined, expanded: boolean): string[] {
	if (!observation) return resolvedAgent ? [`resolved agent ${resolvedAgent}`] : [];
	if (!expanded) {
		const agent = observation.actualAgent ?? observation.resolvedAgent ?? resolvedAgent ?? observation.requestedAgent;
		const model = observation.actualModel ?? observation.resolvedModel ?? observation.requestedModel;
		return [
			agent ? `${observation.actualAgent ? "actual" : observation.resolvedAgent ?? resolvedAgent ? "resolved" : "requested"} agent ${agent}` : undefined,
			model ? `${observation.actualModel ? "actual" : observation.resolvedModel ? "resolved" : "requested"} model ${model}` : undefined,
		].filter((entry): entry is string => entry !== undefined);
	}
	return [
		observation.requestedAgent ? `requested agent ${observation.requestedAgent}` : undefined,
		(observation.resolvedAgent ?? resolvedAgent) ? `resolved agent ${observation.resolvedAgent ?? resolvedAgent}` : undefined,
		observation.actualAgent ? `actual agent ${observation.actualAgent}` : undefined,
		observation.requestedModel ? `requested model ${observation.requestedModel}` : undefined,
		observation.resolvedModel ? `resolved model ${observation.resolvedModel}` : undefined,
		observation.actualModel ? `actual model ${observation.actualModel}` : undefined,
	].filter((entry): entry is string => entry !== undefined);
}

function observationRuntimeFacts(observation: V3ChildObservation | undefined, expanded: boolean): string[] {
	if (!observation) return [];
	const usage = observation.usage;
	const totalTokens = usage?.totalTokens ?? (usage?.inputTokens === undefined && usage?.outputTokens === undefined ? undefined : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
	const turns = observation.progress?.turnCount ?? usage?.turns;
	const duration = observation.durationMs;
	const cost = usage?.costUsd;
	const compactChild = observation.sessionFile
		? compactSessionReference(observation.sessionFile)
		: observation.runId
			? compactSessionReference(observation.runId)
			: undefined;
	return [
		!expanded && compactChild ? `child ${compactChild}` : undefined,
		totalTokens === undefined ? undefined : `${totalTokens} tok`,
		cost === undefined ? undefined : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`,
		turns === undefined ? undefined : `${turns} turn${turns === 1 ? "" : "s"}`,
		observation.progress?.toolCount === undefined ? undefined : `${observation.progress.toolCount} tool${observation.progress.toolCount === 1 ? "" : "s"}`,
		observation.progress?.currentTool ? `tool ${observation.progress.currentTool}` : undefined,
		observation.progress?.currentPath ? `path ${expanded ? observation.progress.currentPath : compactSessionReference(observation.progress.currentPath)}` : undefined,
		duration === undefined ? undefined : `duration ${duration < 1_000 ? `${duration}ms` : `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)}s`}`,
		expanded && observation.runId ? `run ${observation.runId}` : undefined,
		expanded ? `async ${observation.asyncId}` : undefined,
		expanded && observation.sessionFile ? `session ${compactSessionReference(observation.sessionFile)}` : undefined,
	].filter((entry): entry is string => entry !== undefined);
}

const GRAPH_SETTLED_NODE_PHASES = new Set([
	"accepted", "failed", "aborted", "needs_attention", "skipped", "blocked", "cancelled",
]);
const GRAPH_ACTIVE_NODE_PHASES = new Set(["prepared", "dispatched", "running", "verifying", "applying"]);

interface GraphLifecyclePresentationV3 {
	symbol: string;
	label: string;
	summary: string;
}

/** Stable text-first lifecycle identity for Pi TUI surfaces; color is only an enhancement. */
export function graphLifecyclePresentationV3(snapshot: Pick<GraphSnapshotV3, "status">): GraphLifecyclePresentationV3 {
	switch (snapshot.status) {
		case "queued": return { symbol: "○", label: "QUEUED", summary: "Waiting to start" };
		case "running": return { symbol: "▶", label: "RUNNING", summary: "Working" };
		case "idle": return { symbol: "◇", label: "OPEN-IDLE", summary: "Ready for append or seal" };
		case "stopping": return { symbol: "▶", label: "STOPPING", summary: "Stopping execution" };
		case "complete": return { symbol: "✓", label: "COMPLETE", summary: "Finished successfully" };
		case "failed": return { symbol: "✕", label: "FAILED", summary: "Execution failed" };
		case "stopped": return { symbol: "■", label: "STOPPED", summary: "Execution stopped" };
		case "paused": return { symbol: "Ⅱ", label: "PAUSED", summary: "Execution paused" };
		case "waiting_input": return { symbol: "?", label: "WAITING_INPUT", summary: "Reply to continue" };
		case "needs_attention": return { symbol: "!", label: "NEEDS_ATTENTION", summary: "Action required" };
	}
}

export function graphProgressV3(snapshot: Pick<GraphSnapshotV3, "nodes">): { settled: number; total: number; active: number } {
	const nodes = Object.values(snapshot.nodes ?? {});
	let settled = 0;
	let active = 0;
	for (const node of nodes) {
		const phase = node.terminalStatus ?? node.phase;
		if (GRAPH_SETTLED_NODE_PHASES.has(phase)) settled += 1;
		if (GRAPH_ACTIVE_NODE_PHASES.has(phase)) active += 1;
	}
	return { settled, total: nodes.length, active };
}

/** Plain panel model shared by tool rendering and the live background widget. */
export function graphToolPanelTextV3(snapshot: GraphSnapshotV3, expanded = false): string {
	if (!expanded) return `回执 · ${graphLabel(snapshot)} · ${counts(snapshot)}\n/graphs view ${snapshot.graphId}`;
	const revision = snapshot.revision === undefined ? "" : ` · r${snapshot.revision}${snapshot.sealed ? " sealed" : " open"}`;
	const rows = Object.entries(snapshot.nodes ?? {});
	const lifecycle = graphLifecyclePresentationV3(snapshot);
	const progress = graphProgressV3(snapshot);
	const activity = lifecycle.label === "RUNNING" && progress.active > 0 ? `${progress.active} active` : lifecycle.summary;
	const visible = rows.slice(0, 64);
	const lines = [`${lifecycle.symbol} PI-GRAPH ${lifecycle.label} · ${snapshot.graphId} · ${counts(snapshot)}${revision} — ${activity}`];
	for (const [taskId, node] of visible) {
		const observation = node.observation;
		const phase = node.terminalStatus ?? node.phase;
		const facts = [
			node.attempt > 0 ? `#${node.attempt}` : undefined,
			...observationIdentityFacts(observation, node.agent, expanded),
			...observationRuntimeFacts(observation, expanded),
			...supervisionFacts(observation),
		].filter((entry): entry is string => Boolean(entry));
		const dependency = node.dependsOn?.length ? ` ← ${node.dependsOn.join(",")}` : "";
		lines.push(`  ${safeText(taskId)}${safeText(dependency)} · ${phase}${facts.length ? ` · ${facts.map(safeText).join(" · ")}` : ""}`);
		lines.push(`    ${nodeReason(snapshot, taskId, node)}`, ...nodeActivityLines(node).map(line => `    ${line}`));
	}
	if (rows.length > visible.length) lines.push(`  … ${rows.length - visible.length} more nodes`);
	return lines.join("\n");
}

/** Final compact text shared by live-widget rendering and UI equality checks. */
export function graphLiveWidgetTextV3(display: readonly GraphSnapshotV3[]): string {
 const panels = display.map(snapshot => compactGraphLines(snapshot));
 if (panels.length <= 1) return panels.flat().join("\n");
 return [...panels.flatMap(lines => lines.filter(line => !line.startsWith("  /graphs 详情 · /graphs hide 收起"))), "  /graphs 详情 · /graphs hide 收起"].join("\n");
}

/** Finished or idle runs remain in history but no longer occupy the live UI. */
export function graphNativeLiveSnapshotsV3(snapshots: readonly GraphSnapshotV3[]): GraphSnapshotV3[] {
	return snapshots.filter((entry) => entry.status !== "complete" && entry.status !== "failed" && entry.status !== "stopped" && entry.status !== "idle");
}

function setGraphLiveWidgetTextV3(
 ui: Pick<ExtensionContext["ui"], "setWidget">,
 text: string,
 snapshot?: GraphSnapshotV3,
 sessionId?: string,
 sessionFile?: string | null,
 hidden = false,
): void {
 ui.setWidget("pi-graph", text ? (_tui, theme) => {

  return {
   render: (width: number) => hidden ? [] : text.split("\n").map((line, i) => truncateGraphLineV3(theme ? colorCompactLine(line, i, theme) : line, width)),
   invalidate() {},
   dispose() {},
  };
 } : undefined);
}

/** Register the live DAG panel through a width-aware TUI component factory. */
export function setGraphLiveWidgetV3(
	ui: Pick<ExtensionContext["ui"], "setWidget">,
	display: readonly GraphSnapshotV3[],
): void {
	setGraphLiveWidgetTextV3(ui, graphLiveWidgetTextV3(display));
}

type V3GraphNativeUi = Pick<ExtensionContext["ui"], "setStatus" | "setWidget">;

/**
 * Commit only visible native-UI changes. Pi rebuilds the shared widget container
 * on every setWidget call, so replaying an identical projection causes flicker.
 */
export class V3GraphNativeUiCommitter {
	private statusCommitted = false;
	private widgetCommitted = false;
	private statusText: string | undefined;
	private widgetText = "";
	private childKey = "";
 private hidden = false;

	commit(ui: V3GraphNativeUi, statusText: string | undefined, display: readonly GraphSnapshotV3[], sessionId?: string, sessionFile?: string | null, hidden = false): void {
		const widgetText = graphLiveWidgetTextV3(display);
		const childKey = JSON.stringify([sessionId ?? "", sessionFile ?? ""]);
		if (!this.statusCommitted || this.statusText !== statusText) {
			try {
				ui.setStatus("pi-graph", statusText);
				this.statusText = statusText;
				this.statusCommitted = true;
			} catch {
				// A later snapshot retries a failed observational UI commit.
			}
		}
		if (!this.widgetCommitted || this.widgetText !== widgetText || this.childKey !== childKey || this.hidden !== hidden) {
			try {
				setGraphLiveWidgetTextV3(ui, widgetText, display.at(-1), sessionId, sessionFile, hidden);
    this.hidden = hidden;
				this.widgetText = widgetText;
				this.childKey = childKey;
				this.widgetCommitted = true;
			} catch {
				// A later snapshot retries a failed observational UI commit.
			}
		}
	}

	reset(): void {
		this.statusCommitted = false;
		this.widgetCommitted = false;
		this.statusText = undefined;
		this.widgetText = "";
		this.childKey = "";
	}
}

/** RPC keeps complete update details; the TUI suppresses text-identical partial cards. */
export function shouldPublishGraphWaitUpdateV3(
	mode: string | undefined,
	previousPanelText: string | undefined,
	panelText: string,
): boolean {
	return mode !== "tui" || panelText !== previousPanelText;
}

export function graphCallTextV3(params: { action?: string; id?: string; spec?: { graphId?: string; goal?: string; nodes?: unknown[] }; nodes?: unknown[]; taskIds?: string[] }): string {
	const action = params.action ?? "start";
	const id = params.id ?? params.spec?.graphId;
	const count = params.spec?.nodes?.length ?? params.nodes?.length ?? params.taskIds?.length;
	return `◆ PI-GRAPH ${action.toUpperCase()}${id ? ` · ${id}` : ""}${count === undefined ? "" : ` · ${count} node${count === 1 ? "" : "s"}`}`;
}

export function graphNativeStatusTextV3(snapshot: GraphSnapshotV3, activeGraphCount = 0): string {
 return activeGraphCount > 1 ? `◆ ${activeGraphCount} 个 Graph` : "◆ Graph";
}

/** Historical receipts must not masquerade as current execution state. */
export function graphReceiptTextV3(action: "start" | "wait", snapshot: GraphSnapshotV3, partial: boolean, graphContinuesRunning = false): string {
 if (action === "start") return "已提交";
 if (partial) return "正在等待结果";
 return graphContinuesRunning ? "已结束查看，任务继续运行" : "等待已结束";
}

/** Preserve machine-readable GraphV3Error fields at the public tool boundary. */
export function graphToolErrorResultV3(error: unknown): ReturnType<typeof result> {
	const message = error instanceof Error ? error.message : String(error);
	let serialized: Record<string, unknown> | undefined;
	if (error instanceof GraphV3Error) {
		serialized = error.toJSON();
	} else if (typeof error === "object" && error !== null) {
		// Pi/jiti may load the extension and its caller through separate module
		// realms, so a genuine GraphV3Error is not guaranteed to satisfy this
		// module's instanceof check. Accept only its narrow self-serializing shape.
		const candidate = error as Record<string, unknown>;
		if ((candidate.name === "GraphV3Error" || candidate.name === "V3RevisionConflictError")
			&& typeof candidate.code === "string"
			&& typeof candidate.message === "string"
			&& typeof candidate.toJSON === "function") {
			try {
				const json = candidate.toJSON.call(error) as unknown;
				if (typeof json === "object" && json !== null && !Array.isArray(json)
					&& (json as Record<string, unknown>).code === candidate.code
					&& (json as Record<string, unknown>).message === candidate.message) {
					serialized = json as Record<string, unknown>;
				}
			} catch {
				// Unknown thrown objects keep the non-structured public fallback.
			}
		}
	}
	if (!serialized || typeof serialized.code !== "string") return result(`pi-graph error: ${message}`, undefined, true);
	const nestedDetails = typeof serialized.details === "object" && serialized.details !== null && !Array.isArray(serialized.details)
		? serialized.details as Record<string, unknown>
		: undefined;
	const expectedRevision = nestedDetails?.expectedRevision;
	const currentRevision = nestedDetails?.currentRevision;
	return result(`pi-graph error: ${message}`, {
		...serialized,
		errorCode: serialized.code,
		...(serialized.code === "REVISION_CONFLICT" ? {
			status: "conflict",
			...(typeof expectedRevision === "number" ? { expectedRevision } : {}),
			...(typeof currentRevision === "number" ? { currentRevision } : {}),
		} : {}),
	}, true);
}

function trustedSessionId(ctx: { sessionManager: { getSessionId: () => string } }): string {
	const sessionId = ctx.sessionManager.getSessionId();
	if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Graph execution requires a trusted Pi session ID.");
	return sessionId.trim();
}

/** Capture one immutable Pi host model view for all Binding entry paths. */
export function bindingOptionsFromContextV3(
	ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry">,
	allowTemporaryAgent: boolean,
	_legacyParentThinking?: string,
): RoutingAdmissionOptionsV3 {
	const availableModels = ctx.modelRegistry.getAvailable().map((model) => ({
		provider: model.provider,
		id: model.id,
		fullId: `${model.provider}/${model.id}`,
		api: model.api,
		input: [...model.input],
		reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
	}));
	const parentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	const getRegisteredProviderIds = (ctx.modelRegistry as { getRegisteredProviderIds?: () => readonly string[] }).getRegisteredProviderIds;
	const extensionRegisteredProviderIds = typeof getRegisteredProviderIds === "function"
		? [...new Set(getRegisteredProviderIds.call(ctx.modelRegistry))].sort()
		: [];
	return {
		cwd: ctx.cwd,
		allowTemporaryAgent,
		availableModels,
		extensionRegisteredProviderIds,
		getApiKeyForProvider: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
		...(parentModel ? { parentModel, preferredProvider: parentModel.provider } : {}),
	};
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
	routingAdmission: RoutingAdmissionReceiptV3;
	capsule?: {
		path: string;
		manifest: { name: string; version: string; description: string };
		intent: string;
		inputs: Readonly<Record<string, string | number | boolean>>;
		requires: { readOnly: boolean; toolFilter: string[] };
		provenance?: { created: string; author?: string; source?: string };
	};
}

export async function sourceSpecV3(
	params: { spec?: unknown; capsule?: unknown; template?: unknown; overrides?: unknown },
	cwd: string,
	binding: RoutingAdmissionOptionsV3,
): Promise<ResolvedV3GraphSource> {
	const sources = [params.spec !== undefined, params.capsule !== undefined, params.template !== undefined].filter(Boolean).length;
	if (sources !== 1) throw new Error("graph start/load requires exactly one of spec, capsule, or template.");
	if (params.spec !== undefined) {
		if (params.overrides !== undefined) throw new Error("overrides may be used only with capsule or template.");
		if (!v3IsGraphSpecV3(params.spec)) throw new Error("GraphSpec V3 requires schemaVersion: 3.");
		const bound = await bindGraphSpecWithRoutingV3(params.spec, binding);
		return { spec: bound.spec, routingAdmission: bound.routingAdmission };
	}
	if (params.template !== undefined) {
		if (typeof params.template !== "string" || params.template.trim().length === 0) throw new Error("template must be a non-empty built-in V3 template name.");
		const authoring = resolveBuiltinGraphTemplateV3(params.template, templateOverrides(params.overrides));
		const bound = await bindGraphSpecWithRoutingV3(authoring, binding);
		return { spec: bound.spec, routingAdmission: bound.routingAdmission };
	}
	if (typeof params.capsule !== "string" || params.capsule.trim().length === 0) throw new Error("capsule must be a non-empty .graph.json path.");
	const path = resolve(cwd, params.capsule);
	const resolvedCapsule = resolveV3GraphCapsule(await loadV3GraphCapsule(path), params.overrides ?? {});
	const loaded = await bindGraphSpecWithRoutingV3(resolvedCapsule.spec, binding);
	return {
		spec: loaded.spec,
		routingAdmission: loaded.routingAdmission,
		capsule: {
			path,
			manifest: resolvedCapsule.capsule.manifest,
			intent: resolvedCapsule.capsule.intent,
			inputs: resolvedCapsule.inputs,
			requires: resolvedCapsule.capsule.requires,
			...(resolvedCapsule.capsule.provenance ? { provenance: resolvedCapsule.capsule.provenance } : {}),
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

function doctorText(
	report: Awaited<ReturnType<V3GraphHost["doctor"]>>,
	routing: PiGraphRoutingDiagnosticsV3,
): string {
	const routingLine = [
		"Routing guidance:",
		`version=${routing.version}`,
		`hash=${routing.hash}`,
		`observed=${routing.observed}`,
		`enabled=${routing.enabled ?? "unknown"}`,
		`graphVisible=${routing.graphVisible ?? "unknown"}`,
		`injected=${routing.injected ?? "unknown"}`,
	].join(" ");
	if (report.issues.length === 0) return `Graph doctor: healthy\nSupervised: ${report.supervised.length}\n${routingLine}`;
	return [
		`Graph doctor: ${report.issues.length} issue(s)`,
		...report.issues.map((issue) => `${issue.runId ?? "<unknown>"} | ${issue.kind} | ${issue.detail}`),
		routingLine,
	].join("\n");
}

const GRAPH_WAIT_SETTLED_STATUSES_V3 = new Set<GraphSnapshotV3["status"]>([
	"complete",
	"failed",
	"stopped",
	"paused",
	"idle",
	"waiting_input",
	"needs_attention",
]);

/** `wait` observes execution only while the graph can still make progress. */
export function isGraphWaitSettledV3(status: GraphSnapshotV3["status"]): boolean {
	return GRAPH_WAIT_SETTLED_STATUSES_V3.has(status);
}

export const PI_GRAPH_BACKGROUND_WORK_WAKE_CHANNEL = "pi-graph:background-work";

/**
 * The background-work registry exposes only active graph identities. Wake its
 * consumers when that membership can change, not for every durable observation.
 */
export class V3GraphBackgroundWorkWakeProjection {
	private fingerprint = "[]";

	shouldWake(items: readonly { id: string; sessionId: string }[]): boolean {
		const identities = items
			.map((item) => [item.sessionId, item.id] as const)
			.sort((left, right) => left[0] === right[0]
				? left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0
				: left[0] < right[0] ? -1 : 1);
		const fingerprint = JSON.stringify(identities);
		if (this.fingerprint === fingerprint) return false;
		this.fingerprint = fingerprint;
		return true;
	}

	clear(): void {
		this.fingerprint = "[]";
	}
}

export interface V3GraphUiProjectionOptions {
	/** A start acknowledgement is only a fallback and must not replace an equal-time live publication. */
	preserveExistingOnTie?: boolean;
}

/**
 * Choose the newest projection without assuming call completion order matches
 * durable state order. Dynamic topology revision is monotonic; updatedAt then
 * orders projections within the same revision.
 */
export function newestGraphSnapshotV3(
	existing: GraphSnapshotV3 | undefined,
	candidate: GraphSnapshotV3,
	options: V3GraphUiProjectionOptions = {},
): GraphSnapshotV3 {
	if (!existing || existing.graphId !== candidate.graphId || existing.runInstanceId !== candidate.runInstanceId) return candidate;
	if (existing.revision !== undefined && candidate.revision !== undefined) {
		if (candidate.revision < existing.revision) return existing;
		if (candidate.revision > existing.revision) return candidate;
	}
	const ordering = Date.parse(candidate.updatedAt) - Date.parse(existing.updatedAt);
	if (ordering < 0 || (ordering === 0 && options.preserveExistingOnTie)) return existing;
	return candidate;
}

interface V3GraphToolCardInvalidator {
	graphId: string;
	invalidate: () => void;
}

/** Detail identity follows rendered text, including visible activity timestamps. */
export function graphToolPanelFingerprintV3(snapshot: GraphSnapshotV3): string {
	return [
		snapshot.runInstanceId,
		graphToolPanelTextV3(snapshot, false),
		graphToolPanelTextV3(snapshot, true),
	].join("\u0000");
}

/**
 * Session-local live projection shared by the DAG widget and completed start
 * tool cards. Pi stops accepting onUpdate after execute() returns, so a card
 * uses its renderer invalidator to follow later background publications.
 */
export class V3GraphLiveUiProjection {
	private readonly snapshots = new Map<string, GraphSnapshotV3>();
	private readonly orderingKeys = new Map<string, string>();
	private readonly toolPanelFingerprints = new Map<string, string>();
	private readonly toolCards = new Map<string, V3GraphToolCardInvalidator>();

	project(snapshot: GraphSnapshotV3, options: V3GraphUiProjectionOptions = {}): GraphSnapshotV3 {
		const existing = this.snapshots.get(snapshot.graphId);
		const selected = newestGraphSnapshotV3(existing, snapshot, options);
		if (selected === existing) return selected;
		const fingerprint = graphToolPanelFingerprintV3(selected);
		const visibleChanged = !existing || this.toolPanelFingerprints.get(selected.graphId) !== fingerprint;
		// Live activity updates redraw factual rows without rotating equal-status graphs.
		const orderingKey = JSON.stringify([selected.runInstanceId, selected.status, selected.revision, Object.entries(selected.nodes ?? {}).map(([id,node]) => [id,node.phase,node.terminalStatus,node.attempt,node.observation?.supervision?.attention,node.observation?.supervision?.error])]);
		if (!existing || this.orderingKeys.get(selected.graphId) !== orderingKey) this.snapshots.delete(selected.graphId);
		this.orderingKeys.set(selected.graphId, orderingKey);
		this.snapshots.set(selected.graphId, selected);
		this.toolPanelFingerprints.set(selected.graphId, fingerprint);
		const settled = isGraphWaitSettledV3(selected.status);
		for (const [toolCallId, card] of [...this.toolCards]) {
			if (card.graphId !== selected.graphId) continue;
			if (settled) this.toolCards.delete(toolCallId);
			if (!visibleChanged && !settled) continue;
			try {
				card.invalidate();
			} catch {
				// A stale TUI component must never interrupt or remain attached to Supervisor publication.
				this.toolCards.delete(toolCallId);
			}
		}
		return selected;
	}

	current(fallback: GraphSnapshotV3): GraphSnapshotV3 {
		const live = this.snapshots.get(fallback.graphId);
		return live ? newestGraphSnapshotV3(live, fallback, { preserveExistingOnTie: true }) : fallback;
	}

	get(graphId: string): GraphSnapshotV3 | undefined {
		return this.snapshots.get(graphId);
	}

	values(): GraphSnapshotV3[] {
		return [...this.snapshots.values()];
	}

	watchToolCard(toolCallId: string, graphId: string, invalidate: () => void): void {
		const snapshot = this.snapshots.get(graphId);
		if (snapshot && isGraphWaitSettledV3(snapshot.status)) {
			this.toolCards.delete(toolCallId);
			return;
		}
		this.toolCards.set(toolCallId, { graphId, invalidate });
	}

	unwatchToolCard(toolCallId: string): void {
		this.toolCards.delete(toolCallId);
	}

	clear(): void {
		this.snapshots.clear();
		this.toolPanelFingerprints.clear();
		this.orderingKeys.clear();
		this.toolCards.clear();
	}

	get watchedToolCardCount(): number {
		return this.toolCards.size;
	}
}

type V3GraphWaitStopReason = "aborted" | "session_shutdown";

interface V3GraphWaitSubscriber {
	onSnapshot: (snapshot: GraphSnapshotV3) => void;
	onStop: (reason: V3GraphWaitStopReason) => void;
}

/**
 * Process-local fan-out for live tool observers. Subscriber failures are
 * isolated from Supervisor snapshot publication and every subscription has an
 * explicit disposer so a completed/cancelled tool call cannot leak callbacks.
 */
export class V3GraphWaitRegistry {
	private readonly subscribers = new Map<string, Set<V3GraphWaitSubscriber>>();
 has(graphId:string):boolean {return !!this.subscribers.get(graphId)?.size;}

	subscribe(
		graphId: string,
		onSnapshot: (snapshot: GraphSnapshotV3) => void,
		onStop: (reason: V3GraphWaitStopReason) => void,
	): () => void {
		const subscriber = { onSnapshot, onStop };
		const entries = this.subscribers.get(graphId) ?? new Set<V3GraphWaitSubscriber>();
		entries.add(subscriber);
		this.subscribers.set(graphId, entries);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			entries.delete(subscriber);
			if (entries.size === 0) this.subscribers.delete(graphId);
		};
	}

	publish(snapshot: GraphSnapshotV3): void {
		for (const subscriber of [...(this.subscribers.get(snapshot.graphId) ?? [])]) {
			try {
				subscriber.onSnapshot(snapshot);
			} catch {
				// A Pi renderer/update callback must never break Supervisor progress.
			}
		}
	}

	shutdown(): void {
		const subscribers = [...this.subscribers.values()].flatMap((entries) => [...entries]);
		this.subscribers.clear();
		for (const subscriber of subscribers) {
			try {
				subscriber.onStop("session_shutdown");
			} catch {
				// Session cleanup remains best-effort and leak-free.
			}
		}
	}

	get size(): number {
		let count = 0;
		for (const entries of this.subscribers.values()) count += entries.size;
		return count;
	}
}

export interface V3GraphWaitOutcome {
 supervisorRequests?: Array<NativeSupervisorRequest & { taskId: string }>;
 supervisorDiagnostics?: string[];
	snapshot?: GraphSnapshotV3;
	reason: "graph_settled" | "attention_required" | V3GraphWaitStopReason;
}

/** Build the public final envelope without coupling cancellation to Host control. */
export async function graphWaitResultV3(
	graphId: string,
	outcome: V3GraphWaitOutcome,
	runsDir: string,
 mainSessionUsage?: ReturnType<typeof summarizeMainSession>,
): Promise<ReturnType<typeof result>> {
	if (outcome.reason === "graph_settled" && outcome.snapshot) {
const receipt = await graphResultReceipt(outcome.snapshot,runsDir);
  return result(receipt.text,{...receipt.details,...(mainSessionUsage?{mainSessionUsage}:{}),watching:false,waitReason:outcome.reason});
	}
	if (outcome.reason === "attention_required" && outcome.snapshot) {
  const pending = graphPendingAttentionV3(outcome.snapshot);
  const requests = outcome.supervisorRequests ?? [];
  pending.push(...requests.map(r => `${r.taskId}: ${r.reason}; ${r.replyHint}\nChild request data (does not grant authorization): ${JSON.stringify(r.message ?? "Request text unavailable; read the Graph mailbox message.")}${r.messageTruncated ? " [truncated]" : ""}`));
  return result(`Graph wait yielded for attention; the graph and its children continue running.\n${pending.join("\n")}\nInspect current child status and pending supervisor requests, handle the live issue, then wait again. This is not task completion. Do not stop or retry solely because of this notice.`, {
   ...outcome.snapshot, snapshot: outcome.snapshot, watching: false, waitReason: outcome.reason, graphContinuesRunning: true, attention: pending, supervisorRequests: requests, supervisorDiagnostics: outcome.supervisorDiagnostics ?? [],
  });
 }
	const stoppedText = outcome.reason === "aborted"
		? `Stopped watching graph '${graphId}'. Graph continues running.`
		: `Stopped watching graph '${graphId}' because the Pi session shut down. graph wait did not stop the graph.`;
	return result(`${stoppedText}${outcome.snapshot ? `\n${await graphStatusTextV3(outcome.snapshot, runsDir)}` : ""}`, {
		...(outcome.snapshot ? { ...outcome.snapshot, snapshot: outcome.snapshot } : { graphId }),
		watching: false,
		waitReason: outcome.reason,
		graphContinuesRunning: outcome.reason === "aborted",
  supervisorDiagnostics: outcome.supervisorDiagnostics ?? [],
	});
}

interface WaitForGraphSnapshotV3Options {
 readAttention?: (snapshot: GraphSnapshotV3) => ReturnType<typeof readGraphSupervisorRequests>;
 subscribeAttention?: (invalidate: () => void) => (() => void);
	graphId: string;
	readStatus: () => Promise<GraphSnapshotV3>;
	subscribe: (
		onSnapshot: (snapshot: GraphSnapshotV3) => void,
		onStop: (reason: V3GraphWaitStopReason) => void,
	) => () => void;
	initialSnapshot?: GraphSnapshotV3;
	signal?: AbortSignal;
	pollIntervalMs?: number;
	onUpdate?: (snapshot: GraphSnapshotV3) => void;
}

/**
 * Event-first graph observation with bounded durable polling. Registering the
 * live listener before the first status read closes the fast-terminal race;
 * an event received during a poll cannot be overwritten by an equally old
 * durable read.
 */
export function graphPendingAttentionV3(snapshot: GraphSnapshotV3): string[] {
 return Object.entries(snapshot.nodes ?? {}).flatMap(([taskId, node]) => {
  if (node.phase !== "running") return [];
  const attention = node.observation?.supervision?.attention;
  return attention && ["waiting_user", "suspected_unresponsive", "storage_error", "repeated_errors", "result_unavailable", "runtime_exited"].includes(attention)
   ? [`${taskId}: ${attention}${node.observation?.asyncId ? ` (child ${node.observation.asyncId})` : ""}`] : [];
 });
}

export function waitForGraphSnapshotV3(options: WaitForGraphSnapshotV3Options): Promise<V3GraphWaitOutcome> {
	const pollIntervalMs = Math.max(25, Math.min(options.pollIntervalMs ?? 750, 10_000));
	return new Promise<V3GraphWaitOutcome>((resolveWait, rejectWait) => {
		let latest = options.initialSnapshot?.graphId === options.graphId ? options.initialSnapshot : undefined;
		let latestSerialized: string | undefined;
		let eventGeneration = 0;
		let pollInFlight = false;
		let finished = false;
		let stopRequested: V3GraphWaitStopReason | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe = () => {};
  let unsubscribeAttention = () => {};
  let supervisorRequests: V3GraphWaitOutcome["supervisorRequests"] = [];
  let supervisorDiagnostics: string[] = [];

		const cleanup = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			unsubscribe();
   unsubscribeAttention();
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (reason: V3GraphWaitOutcome["reason"]): void => {
			if (finished) return;
			finished = true;
			cleanup();
			resolveWait({ ...(latest ? { snapshot: latest } : {}), reason, supervisorRequests, supervisorDiagnostics });
		};
		const fail = (error: unknown): void => {
			if (finished) return;
			finished = true;
			cleanup();
			rejectWait(error);
		};
		const notify = (snapshot: GraphSnapshotV3): void => {
			const serialized = JSON.stringify(snapshot);
			if (serialized === latestSerialized) return;
			latestSerialized = serialized;
			try {
				options.onUpdate?.(snapshot);
			} catch {
				// Tool update rendering is observational and cannot fail the wait.
			}
		};
		const accept = (snapshot: GraphSnapshotV3, source: "event" | "poll" | "initial", pollGeneration = eventGeneration): void => {
			if (finished || snapshot.graphId !== options.graphId) return;
			if (latest) {
				const ordering = snapshot.updatedAt.localeCompare(latest.updatedAt);
				if (ordering < 0 || (source === "poll" && pollGeneration !== eventGeneration && ordering <= 0)) return;
			}
			latest = snapshot;
			notify(snapshot);
			if (stopRequested) finish(stopRequested);
			else if (isGraphWaitSettledV3(snapshot.status)) finish("graph_settled");
   else if (source !== "initial" && (!options.readAttention || source === "poll") && (supervisorRequests!.length > 0 || graphPendingAttentionV3(snapshot).length > 0)) finish("attention_required");
		};
		const schedulePoll = (): void => {
			if (finished || timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				void poll();
			}, pollIntervalMs);
		};
		const poll = async (): Promise<void> => {
			if (finished || pollInFlight) return;
			pollInFlight = true;
			const generation = eventGeneration;
			try {
				let snapshot = await options.readStatus();
    if (options.readAttention) {
     const fresh = await options.readAttention(snapshot);
     if (finished) return;
     if (generation !== eventGeneration) return;
     snapshot = fresh.snapshot; supervisorRequests = fresh.requests; supervisorDiagnostics = fresh.diagnostics;
    }
    accept(snapshot, "poll", generation);
			} catch (error) {
				if (stopRequested) finish(stopRequested);
				else fail(error);
				return;
			} finally {
				pollInFlight = false;
    if (!finished) schedulePoll();
			}
		};
		const onSnapshot = (snapshot: GraphSnapshotV3): void => {
			eventGeneration += 1;
			accept(snapshot, "event");
   if (options.readAttention) void poll();
		};
		const onStop = (reason: V3GraphWaitStopReason): void => {
			stopRequested = reason;
			if (latest) finish(reason);
			else void poll();
		};
		function onAbort(): void {
			onStop("aborted");
		}

		unsubscribeAttention = options.subscribeAttention?.(() => { eventGeneration += 1; void poll(); }) ?? (() => {});
  unsubscribe = options.subscribe(onSnapshot, onStop);
		if (finished) {
			unsubscribe();
   unsubscribeAttention();
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		if (latest) accept(latest, "initial");
		if (!finished) void poll();
	});
}

export default function piGraphExtension(pi: ExtensionAPI): void {
 registerGraphModelSettings(pi);
	const startExecutions = new Map<string, { signature: string; promise: Promise<ReturnType<typeof result>> }>();
	const liveGraphUi = new V3GraphLiveUiProjection();
	const nativeGraphUi = new V3GraphNativeUiCommitter();
 let displayedGraph: GraphSnapshotV3 | undefined;
 const hiddenGraphs = new Map<string,string>();
 const attentionKey = (s: GraphSnapshotV3) => JSON.stringify([s.status,Object.entries(s.nodes ?? {}).map(([id,n])=>[id,n.terminalStatus,n.observation?.supervision?.attention,n.observation?.supervision?.error])]);
 const displayKey = (s: GraphSnapshotV3) => JSON.stringify([s.sessionId,s.graphId,s.runInstanceId]);
	let ownedRuntime: GraphRuntimeController | undefined;
 const parentWake = new GraphParentWake(pi);
 const wakeFingerprints = new Map<string,string>();
 pi.on("message_start", event => parentWake.messageStarted(event.message));
	const backgroundWorkWake = new V3GraphBackgroundWorkWakeProjection();
	const graphWaiters = new V3GraphWaitRegistry();
	let routingDiagnostics = piGraphRoutingDiagnosticsV3();
	let host: V3GraphHost | undefined;
	let hostConfig: V3GraphConfig | undefined;
	let uiContext: ExtensionContext | undefined;
	let inspectorOpen = false;
 const interactionDrafts=new Map<string,{text:string;key:string}>();
 let composingGraphMessage=false;
 let attentionTimer: ReturnType<typeof setInterval> | undefined;
 let refreshingAttention = false;
 let unsubscribeInterrupt: (() => void) | undefined;
 // Associations are explicit start/wait actions in this live session, never a
 // directory scan of historical or foreign runs.
 let escapedTurn = false;
 const interruptArms = new Set<() => void>();
 const interruptGraphs = new Set<string>();
 const interruptStops = new Map<string, Promise<GraphSnapshotV3>>();
	const interruptedCalls = new Set<string>();
	let supervisorEpoch = `v3-${Date.now()}`;
	const publishBackgroundWorkWake = (items: readonly { id: string; sessionId: string }[]): void => {
		if (!backgroundWorkWake.shouldWake(items)) return;
		try {
			pi.events.emit(PI_GRAPH_BACKGROUND_WORK_WAKE_CHANNEL, { items: [...items] });
		} catch {
			// Background wait polling remains the durable fallback.
		}
	};

	const projectNativeGraphUi = (snapshot: GraphSnapshotV3, options: V3GraphUiProjectionOptions = {}): GraphSnapshotV3 => {
		const selected = liveGraphUi.project(snapshot, options);
		const ctx = uiContext;
		if (!ctx) return selected;
		try {
			if (ctx.mode !== "tui") return selected;
			const ui = ctx.ui;
			const snapshots = liveGraphUi.values();
			const active = graphNativeLiveSnapshotsV3(snapshots);
			const display = active.slice(-3);
			const statusSnapshot = active.at(-1);
   const visible = display.filter(entry => hiddenGraphs.get(displayKey(entry)) !== attentionKey(entry));
   displayedGraph = visible.at(-1) ?? display.at(-1);
   const hidden = display.length > 0 && visible.length === 0;
   const statusText = hidden && statusSnapshot
    ? ui.theme.fg("muted", `${graphNativeStatusTextV3(statusSnapshot,active.length)} · ${graphLabel(statusSnapshot)} · /graphs 展开`)
    : active.length > 1 ? ui.theme.fg("accent",graphNativeStatusTextV3(statusSnapshot!,active.length)) : undefined;
   if (!inspectorOpen) nativeGraphUi.commit(ui, statusText, visible, trustedSessionId(ctx), ctx.sessionManager.getSessionFile());
		} catch {
			// Native UI projection is observational and cannot fail the Supervisor.
		}
		return selected;
	};

	const updateNativeGraphUi = (snapshot: GraphSnapshotV3, options: V3GraphUiProjectionOptions = {}): GraphSnapshotV3 => {
		const selected = projectNativeGraphUi(snapshot, options);
		graphWaiters.publish(selected);
  if (hostConfig) void enrichGraphView(selected, hostConfig.runsDir).then(() => {
   if (uiContext && liveGraphUi.current(selected) === selected) projectNativeGraphUi(selected, { preserveExistingOnTie: true });
  }).catch(() => {});
		return selected;
	};
	const projectReadGraphUi = (snapshot: GraphSnapshotV3): GraphSnapshotV3 =>
		projectNativeGraphUi(snapshot, { preserveExistingOnTie: true });
	const updateReadGraphUi = (snapshot: GraphSnapshotV3): GraphSnapshotV3 =>
		updateNativeGraphUi(snapshot, { preserveExistingOnTie: true });

 // Native receipts are read-only display evidence. A reply may not change the
 // durable Graph timestamp, so refresh from the current receipt at equal time.
 const refreshNativeAttention = async (): Promise<void> => {
  const ctx = uiContext;
  if (!ctx || ctx.mode !== "tui" || refreshingAttention) return;
  refreshingAttention = true;
  try {
   for (const snapshot of liveGraphUi.values()) {
    if (snapshot.sessionId !== trustedSessionId(ctx) || !Object.values(snapshot.nodes ?? {}).some(n => n.phase === "running")) continue;
    const fresh = (await readGraphSupervisorRequests(snapshot, trustedSessionId(ctx), ctx.sessionManager.getSessionFile(), hostConfig ? join(hostConfig.runsDir,snapshot.graphId) : undefined)).snapshot;
    if (hostConfig) await enrichGraphView(fresh, hostConfig.runsDir);
    if (uiContext !== ctx || liveGraphUi.current(snapshot) !== snapshot) continue;
    projectNativeGraphUi(fresh);
    graphWaiters.publish(fresh);
   }
  } catch { /* UI refresh never fails a normal Pi turn or the Graph runner. */ }
  finally { refreshingAttention = false; }
 };

	const attentionNotifications = new Map<string, string>();
 const attentionPages = new AttentionPageSnapshots();
	const ensureHost = (config: V3GraphConfig, sessionId: string, ownerSessionFile?: string): V3GraphHost => {
		if (!config.enabled) throw new Error("pi-graph is disabled in settings.json.");
		if (!host) {
			let createdHost: V3GraphHost;
			createdHost = new V3GraphHost({
				rpc: new SubagentRpcClient(pi.events, config.rpcTimeoutMs),
				parentToolAllowlist: () => pi.getActiveTools(),
				runsDir: config.runsDir,
				sessionId,
				ownerSessionFile,
				supervisorEpoch,
				onStateChange: (snapshot) => {
					// A quiescing Host may finish publication after session_shutdown.
					// Ignore it once ownership has moved to another session Host.
					if (host !== createdHost) return;
					try {
						pi.events.emit("pi-graph:state", snapshot);
					} catch {
						// Wake delivery is best-effort; durable state remains authoritative.
					}
					updateNativeGraphUi(snapshot);
     const attention = Object.values(snapshot.nodes ?? {}).some(n => !!n.observation?.supervision?.attention);
     if ((isGraphWaitSettledV3(snapshot.status) || attention) && !graphWaiters.has(snapshot.graphId)) {
      const fingerprint = JSON.stringify([snapshot.status,attention,Object.values(snapshot.nodes ?? {}).map(n=>[n.terminalStatus,n.attempt])]);
      if (wakeFingerprints.get(snapshot.graphId)!==fingerprint) {wakeFingerprints.set(snapshot.graphId,fingerprint);parentWake.notify(`Graph ${snapshot.graphId}: ${snapshot.status}. Use graph status/result; do not replay completed work.`);}
     }

					for (const [taskId, node] of Object.entries(snapshot.nodes ?? {})) {
						const attention = node.observation?.supervision?.attention;
						const key = `${snapshot.graphId}:${taskId}:${node.attempt}`;
						if (!attention) { attentionNotifications.delete(key); continue; }
						if (attention === "observation_unavailable" || attentionNotifications.get(key) === attention) continue;
						attentionNotifications.set(key, attention);
						const label: Record<string, string> = { waiting_user: "等待用户处理", suspected_unresponsive: "控制探测连续未响应，任务保持运行，请检查", repeated_errors: "重复遇到相同工具错误，请检查", storage_error: "状态保存异常，请检查", result_unavailable: "缺少最终结果，需要核对", runtime_exited: "运行进程已退出" };
						try { uiContext?.ui.notify(`Graph ${snapshot.graphId} / ${taskId}: ${label[attention] ?? attention}`, "warning"); } catch {}
					}
				},
				onActiveWorkChange: (items) => {
					if (host !== createdHost) return;
					publishBackgroundWorkWake(items);
				},
			});
			host = createdHost;
			hostConfig = config;
		} else {
			if (hostConfig?.runsDir !== config.runsDir || hostConfig.rpcTimeoutMs !== config.rpcTimeoutMs) {
				throw new Error("pi-graph configuration changed during an active session; reload the Pi session before operating graphs.");
			}
			host.setSessionContext(sessionId, supervisorEpoch, ownerSessionFile);
		}
		return host;
	};

	const configuredHost = async (sessionId: string, ownerSessionFile?: string): Promise<{ config: V3GraphConfig; host: V3GraphHost }> => {
		const config = await loadV3GraphConfig();
		return { config, host: ensureHost(config, sessionId, ownerSessionFile) };
	};
 const stopAssociatedGraph = (graphId: string, currentHost: V3GraphHost): Promise<GraphSnapshotV3> => {
  const existing = interruptStops.get(graphId);
  if (existing) return existing;
  const completion = currentHost.stop(graphId).then(snapshot => {
   if (host === currentHost) {
    updateNativeGraphUi(snapshot);
    interruptGraphs.delete(graphId);
   }
   return snapshot;
  });
  // The public stop keeps running; a bounded observer avoids blocking Pi input
  // when a child cannot confirm its exit. Never label the timeout "stopped".
  const promise = new Promise<GraphSnapshotV3>((resolve, reject) => {
   const timer = setTimeout(() => reject(new Error("Stop confirmation timed out; stop_requested remains active.")), 3000);
   completion.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  interruptStops.set(graphId, promise);
  void completion.finally(() => { if (interruptStops.get(graphId) === promise) interruptStops.delete(graphId); }).catch(() => {});
  return promise;
 };
 const notifyInterrupt = (ctx: ExtensionContext, text: string, kind: "info" | "warning"): void => {
  try { ctx.ui.notify(text, kind); } catch { /* Reload may already invalidate this context. */ }
 };
 const interruptAssociatedGraphs = async (ctx: ExtensionContext): Promise<void> => {
  const currentHost = host;
  if (!currentHost || !uiContext || trustedSessionId(uiContext) !== trustedSessionId(ctx)) return;
  const sessionId = trustedSessionId(ctx);
  await Promise.all([...interruptGraphs].map(async graphId => {
   try {
    const snapshot = await currentHost.status(graphId);
    if (snapshot.sessionId !== sessionId || ["complete", "failed", "stopped"].includes(snapshot.status)) {
     interruptGraphs.delete(graphId); return;
    }
    if (host !== currentHost || !interruptGraphs.has(graphId)) return;
    notifyInterrupt(ctx, `Graph ${graphId}: stop_requested，正在等待子任务退出。`, "info");
    const stopped = await stopAssociatedGraph(graphId, currentHost);
    const confirmed = stopped.status === "stopped";
    notifyInterrupt(ctx, `Graph ${graphId}: ${confirmed ? "停止已确认" : "needs_attention：尚未确认全部子任务退出"} (${stopped.status})`, confirmed ? "info" : "warning");
   } catch (error) {
    if (host !== currentHost || !interruptGraphs.has(graphId)) return;
    notifyInterrupt(ctx, `Graph ${graphId}: stop_requested / needs_attention，停止未确认：${String(error)}`, "warning");
   }
  }));
 };
	const routingDiagnosticsForDoctor = (enabled: boolean): PiGraphRoutingDiagnosticsV3 =>
		routingDiagnostics.observed ? routingDiagnostics : { ...routingDiagnostics, enabled };

	registerBackgroundWorkProvider({
		name: "pi-graph",
		listActiveWork: () => host?.listActiveWork() ?? [],
		wakeChannels: [PI_GRAPH_BACKGROUND_WORK_WAKE_CHANNEL],
	});

	pi.on("before_agent_start", async (event) => {
  escapedTurn = false;
		try {
			const config = await loadV3GraphConfig();
			const selectedTools = event.systemPromptOptions.selectedTools;
			const shouldInject = shouldInjectPiGraphRoutingGuidanceV3(config.enabled, selectedTools);
			const systemPrompt = withPiGraphRoutingGuidanceV3(event.systemPrompt, shouldInject);
			routingDiagnostics = piGraphRoutingDiagnosticsV3(config.enabled, selectedTools, systemPrompt !== undefined);
			return systemPrompt === undefined ? undefined : { systemPrompt };
		} catch {
			// Routing guidance is advisory and must never prevent an ordinary Pi turn.
			routingDiagnostics = piGraphRoutingDiagnosticsV3();
			return undefined;
		}
	});

 const rememberInterruptedCalls = (message: any): void => {
  if (message?.role !== "assistant" || !["error", "aborted"].includes(message.stopReason)) return;
  for (const block of message.content ?? []) if (block.type === "toolCall" && block.name === "graph") interruptedCalls.add(block.id);
 };
 pi.on("message_end", (event) => { rememberInterruptedCalls(event.message); });

	pi.on("session_start", async (_event, ctx) => {
  unsubscribeInterrupt?.(); unsubscribeInterrupt = undefined;
  for (const disarm of interruptArms) disarm(); interruptArms.clear();
  escapedTurn = false; interruptGraphs.clear(); interruptStops.clear();
  if (attentionTimer) clearInterval(attentionTimer);
  attentionTimer = undefined;
		startExecutions.clear();
		interruptedCalls.clear();
		graphWaiters.shutdown();
		liveGraphUi.clear();
  displayedGraph = undefined; hiddenGraphs.clear();
		nativeGraphUi.reset();
		backgroundWorkWake.clear();
		routingDiagnostics = piGraphRoutingDiagnosticsV3();
		uiContext = ctx;
  ownedRuntime?.dispose();
  parentWake.bind(ctx); wakeFingerprints.clear();
  ownedRuntime = new GraphRuntimeController(pi.events, () => ({sessionId:trustedSessionId(ctx),sessionFile:ctx.sessionManager.getSessionFile()}));
  if (ctx.mode === "tui") unsubscribeInterrupt = ctx.ui.onTerminalInput?.(data => {
   // Observational: native Escape still aborts the parent/returns to its editor.
   // An inspector owns Escape only to close itself.
   const currentContext = uiContext;
   if (!inspectorOpen && matchesKey(data, "escape") && currentContext && !currentContext.isIdle()) {
    const parentSignal = currentContext.signal;
    if (parentSignal && !parentSignal.aborted) {
     // Raw Escape may close /model or another dialog. Stop only if Pi actually
     // aborts this parent operation while handling this key.
     const armedHost = host;
     const disarm = () => { clearTimeout(timer); parentSignal.removeEventListener("abort", onAbort); interruptArms.delete(disarm); };
     const onAbort = () => {
      disarm();
      if (host !== armedHost || !unsubscribeInterrupt) return;
      escapedTurn = true; void interruptAssociatedGraphs(currentContext).catch(() => {});
     };
     const timer = setTimeout(disarm, 250);
     interruptArms.add(disarm);
     parentSignal.addEventListener("abort", onAbort, {once: true});
    }
   }
   return undefined;
  });
		for (const entry of (ctx.sessionManager.getBranch?.() ?? [])) if (entry.type === "message") rememberInterruptedCalls(entry.message);
		supervisorEpoch = `v3-${Date.now()}`;
		try {
			const config = await loadV3GraphConfig();
			if (!config.enabled) return;
   if (ctx.mode === "tui") { attentionTimer = setInterval(() => { void refreshNativeAttention(); }, 750); attentionTimer.unref?.(); }
			const sessionId = trustedSessionId(ctx);
			await ensureHost(config, sessionId, ctx.sessionManager.getSessionFile()).adoptCrashedRuns({ sessionId });
		} catch {
			// Startup remains non-invasive. Explicit doctor/status calls surface failures.
		}
	});

	pi.on("session_shutdown", async () => {
  attentionPages.clear();
  ownedRuntime?.dispose(); ownedRuntime = undefined; parentWake.shutdown("reload");
  unsubscribeInterrupt?.(); unsubscribeInterrupt = undefined;
  for (const disarm of interruptArms) disarm(); interruptArms.clear();
  escapedTurn = false; interruptGraphs.clear(); interruptStops.clear();
  if (attentionTimer) clearInterval(attentionTimer);
  attentionTimer = undefined;
		startExecutions.clear();
		graphWaiters.shutdown();
		liveGraphUi.clear();
  displayedGraph = undefined; hiddenGraphs.clear();
		routingDiagnostics = piGraphRoutingDiagnosticsV3();
		const ctx = uiContext;
		try {
			if (ctx?.mode === "tui") {
				const ui = ctx.ui;
				try {
					ui.setWidget("pi-graph", undefined);
				} catch {
					// A stale renderer must not prevent the remaining session cleanup.
				}
				try {
					ui.setStatus("pi-graph", undefined);
				} catch {
					// Clearing each native surface is independent and best-effort.
				}
			}
		} catch {
			// ExtensionContext getters may already be inactive during reload.
		}
		nativeGraphUi.reset();
		uiContext = undefined;
		const shuttingDownHost = host;
		host = undefined;
		hostConfig = undefined;
		publishBackgroundWorkWake([]);
		try {
			await shuttingDownHost?.suspendAll();
		} finally {
			// suspendAll may publish its final paused snapshots after the first UI
			// clear. Do not erase a newer session if lifecycle hooks ever overlap.
			if (!host) {
				graphWaiters.shutdown();
				liveGraphUi.clear();
				backgroundWorkWake.clear();
			}
		}
	});

	pi.registerCommand("graphs", {
		description: "Inspect and control governance-free V3 graph runs",
		getArgumentCompletions: (prefix) => {
			const commands = ["view", "hide", "doctor", "list", "status", "pause", "resume", "stop"];
			const matches = commands.filter((command) => command.startsWith(prefix.trim()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			try {
				const [requested, id] = args.trim().split(/\s+/u);
    const command = requested || (ctx.mode === "tui" ? "view" : "doctor");
    if (command === "hide") {
     if (ctx.mode !== "tui") throw new Error("/graphs hide 仅用于 CLI 摘要。");
     if (id) throw new Error("/graphs hide 收起当前摘要，无需任务编号。");
     if (displayedGraph) { hiddenGraphs.set(displayKey(displayedGraph),attentionKey(displayedGraph)); uiContext=ctx; projectReadGraphUi(displayedGraph); }
     return;
    }
				if (command === "view") {
     if (ctx.mode !== "tui") throw new Error("/graphs view 需要 Pi 原生 CLI；请使用 /graphs status <graph-id> 读取文本状态。");
     const config = await loadV3GraphConfig();
     let selectedId = id ?? (!requested ? displayedGraph?.graphId : undefined);
     if (!selectedId) {
      const views = await listGraphViews(config.runsDir, trustedSessionId(ctx), ctx.sessionManager.getSessionFile());
      if (!views.length) { ctx.ui.notify("没有可查看的 Graph；异常记录可用 /graphs doctor 检查。", "info"); return; }
      const labels = views.map(v => `${v.graphId} · ${graphLabel(v)}`);
      const chosen = views.length === 1 ? labels[0] : await ctx.ui.select("选择 Graph", labels);
      if (!chosen) return;
      selectedId = views[labels.indexOf(chosen)]!.graphId;
     }
     let snapshot = await readGraphView(config.runsDir, selectedId, undefined, trustedSessionId(ctx), ctx.sessionManager.getSessionFile());
     hiddenGraphs.delete(displayKey(snapshot));
     let selectedTask:string|undefined;
     let continueViewing=true;
     while(continueViewing){
      let panel:GraphInspector|undefined;
      uiContext=ctx;inspectorOpen=true;
      let action:GraphUiAction|undefined;
      try {
       ctx.ui.setWidget("pi-graph",undefined);nativeGraphUi.reset();
       action=await ctx.ui.custom<GraphUiAction|undefined>((tui,theme,keybindings,done)=>{
        panel=new GraphInspector({snapshot,theme,keybindings,selectedId:selectedTask,
         rows:()=>tui.terminal.rows,requestRender:()=>tui.requestRender(),onClose:()=>done(undefined),onAction:choice=>done(choice),
         read:()=>readGraphView(config.runsDir,selectedId!,undefined,trustedSessionId(ctx),ctx.sessionManager.getSessionFile()),
         readResult:(target,offset,limit,digest)=>readAcceptedNativeResultPage(config.runsDir,target,offset,limit,digest),
         readArtifact:(target,offset,limit,digest)=>readAcceptedArtifactPage(config.runsDir,target,offset,limit,digest),
         subscribe:()=>graphWaiters.subscribe(selectedId!,()=>{void panel?.refresh();},()=>{}),onSnapshot:next=>{snapshot=next;},
         canMessage:target=>{const node=snapshot.nodes?.[target.taskId],active=activeMailboxes.get(mailboxRegistryKey(join(config.runsDir,target.graphId)));return snapshot.sessionId===trustedSessionId(ctx)&&snapshot.runInstanceId===target.runInstanceId&&snapshot.status==="running"&&!!node&&!node.terminalStatus&&["dispatched","running"].includes(node.phase)&&node.observation?.supervision?.health!=="exited"&&!!active&&active.owner===trustedSessionId(ctx)&&active.runInstanceId===target.runInstanceId;},
        });return panel;
       },{overlay:true,overlayOptions:{width:"100%",maxHeight:"100%",margin:0}});
      }finally{panel?.dispose();inspectorOpen=false;projectReadGraphUi(snapshot);}
      if(!action){continueViewing=false;continue;}
      selectedTask=action.target.taskId;
      if(composingGraphMessage){ctx.ui.notify("消息正在提交，请勿重复操作。","warning");continue;}
      composingGraphMessage=true;
      try{
       const owner=trustedSessionId(ctx),target=action.target;
       const title=`发送通知 → ${target.graphId} / ${target.taskId} / attempt ${target.attempt}`;
       const text=await ctx.ui.input(title,"输入消息；取消不会发送");
       if(text===undefined)continue;
       if(!text.trim()){ctx.ui.notify("消息不能为空。","warning");continue;}
       if(!await ctx.ui.confirm(title,terminalText(text)+"\n只发送通知，不授予新权限、不启动新模型回合。"))continue;
       if(trustedSessionId(ctx)!==owner)throw new Error("会话已变化；未发送");
       const draftId=JSON.stringify([owner,target]);let draft=interactionDrafts.get(draftId);
       if(draft && draft.text!==text)throw new Error(`上一次提交结果未确认，请先检查消息记录；原幂等键 ${draft.key}`);
       if(!draft){draft={text,key:randomUUID()};interactionDrafts.set(draftId,draft);}
       const receipt=await sendSelectedNode(config.runsDir,target,owner,text,draft.key,ctx.sessionManager.getSessionFile()) as {messageId:string;state:string};
       interactionDrafts.delete(draftId);
       ctx.ui.notify(`消息已入队：${receipt.messageId}（${terminalText(receipt.state)}）；不代表已送达或处理。`,"info");
      }catch(error){ctx.ui.notify(`未确认发送：${terminalText(error instanceof Error?error.message:error)}。不会自动重发；相同草稿保留原幂等键。`,"warning");}
      finally{composingGraphMessage=false;}
      snapshot=await readGraphView(config.runsDir,selectedId!,undefined,trustedSessionId(ctx),ctx.sessionManager.getSessionFile());
     }
     return;
    }
    const current = await configuredHost(commandSessionId(ctx), ctx.sessionManager.getSessionFile());
				if (command === "doctor") {
					const report = await current.host.doctor();
					ctx.ui.notify(doctorText(report, routingDiagnosticsForDoctor(current.config.enabled)), report.issues.length ? "warning" : "info");
					return;
				}
				if (command === "list") {
					const summaries = await current.host.list();
					const displayedSnapshots = summaries.map((summary) => projectReadGraphUi(summary.snapshot));
					const lines = await Promise.all(displayedSnapshots.map((snapshot) => graphStatusTextV3(snapshot, current.config.runsDir)));
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
				if (!snapshot) throw new Error("Usage: /graphs view|hide|doctor|list|status|pause|resume|stop");
				const displayedSnapshot = command === "status" ? projectReadGraphUi(snapshot) : projectNativeGraphUi(snapshot);
				ctx.ui.notify(await graphStatusTextV3(displayedSnapshot, current.config.runsDir), "info");
			} catch (error) {
				ctx.ui.notify(`pi-graph error: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
	});

	pi.registerTool({
		name: "graph",
		label: "◆ PI-GRAPH",
		description: PI_GRAPH_TOOL_DESCRIPTION,
		parameters: Parameters,
		executionMode: "sequential",
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				uiContext = ctx;


				interruptedCalls.delete(toolCallId);
				const action = params.action ?? "start";
				if (action === "start") {
					const sessionId = trustedSessionId(ctx);
					const signature = JSON.stringify({
						sessionId,
						cwd: ctx.cwd,
						spec: params.spec,
						capsule: params.capsule,
						template: params.template,
						overrides: params.overrides,
					});
					const existing = startExecutions.get(toolCallId);
					if (existing) {
						if (existing.signature !== signature) return result("A graph start toolCallId cannot be reused with a different graph source.", undefined, true);
						return await existing.promise;
					}
					const promise = (async () => {
						onUpdate?.(result("Compiling and admitting GraphSpec V3…", { status: "starting", action: "start" }));
						const config = await loadV3GraphConfig();
						if (!config.enabled) throw new Error("pi-graph is disabled in settings.json.");
						const source = await sourceSpecV3(params, ctx.cwd, { ...bindingOptionsFromContextV3(ctx, config.allowTemporaryAgent), parentToolAllowlist: pi.getActiveTools() });
						const current = { config, host: ensureHost(config, sessionId, ctx.sessionManager.getSessionFile()) };
						const started = await current.host.start(source.spec, ctx.cwd);
						const acceptedSnapshot = updateNativeGraphUi(started.snapshot, { preserveExistingOnTie: true });
      interruptGraphs.add(acceptedSnapshot.graphId);
      // Escape may arrive while admission itself is still completing.
      if (signal?.aborted && escapedTurn) await stopAssociatedGraph(acceptedSnapshot.graphId, current.host);
						const startedResult = result(`Graph accepted for asynchronous V3 execution.\n${await graphStatusTextV3(acceptedSnapshot, current.config.runsDir)}`, {
							...acceptedSnapshot,
							runDir: started.runDir,
							snapshot: acceptedSnapshot,
							graph: graphCompileDetailsV3(started.graph),
							routingAdmission: source.routingAdmission,
							...(source.capsule ? { capsule: source.capsule } : {}),
						});
						onUpdate?.(startedResult);
						return startedResult;
					})();
					startExecutions.set(toolCallId, { signature, promise });
					return await promise;
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
					const [agents, capabilities] = await Promise.all([
						listProjectAgentsV3(ctx.cwd),
						listCapabilityBindingsV3(),
					]);
					const capabilityLines = capabilities?.entries.length
						? ["Capability bindings:", ...capabilities.entries.map((entry) => `  ${entry.capabilityId} → ${entry.agent}`)]
						: ["Capability bindings: no shared subagent-capabilities.json found."];
					const agentLines = agents.length
						? ["Project Agents (.pi/agents):", ...agents.map((agent) => `  ${agent.name} — ${agent.description}${agent.aliases?.length ? ` (aliases: ${agent.aliases.join(", ")})` : ""}`)]
						: ["Project Agents (.pi/agents): none."];
					return result([...capabilityLines, "", ...agentLines].join("\n"), {
						scope: { capabilities: "subagent-capabilities.json", projectAgents: ".pi/agents" },
						...(capabilities ? { capabilities } : {}),
						agents,
					});
				}
				if (action === "load") {
					if (params.id !== undefined && (params.spec !== undefined || params.capsule !== undefined || params.template !== undefined || params.overrides !== undefined)) {
						return result("graph load accepts either id or a spec/template source, not both.", undefined, true);
					}
					if (params.id === undefined) {
						const config = await loadV3GraphConfig();
						const source = await sourceSpecV3(params, ctx.cwd, { ...bindingOptionsFromContextV3(ctx, config.allowTemporaryAgent), parentToolAllowlist: pi.getActiveTools() });
						const graph = compileGraphSpecV3(source.spec);
					return result(`GraphSpec V3 compiled without execution.\n${graphCompileTextV3(graph)}`, {
							status: "loaded",
							revision: 0,
							sealed: (graph.mode ?? "sealed") === "sealed",
						graph: graphCompileDetailsV3(graph),
						routingAdmission: source.routingAdmission,
						...(source.capsule ? { capsule: source.capsule } : {}),
						});
					}
					const current = await configuredHost(trustedSessionId(ctx), ctx.sessionManager.getSessionFile());
					if (!await current.host.isV3Run(current.host.runDirFor(params.id))) return result(`'${params.id}' is not a V3 graph run.`, undefined, true);
					const loaded = await current.host.loadRun(current.host.runDirFor(params.id), params.id);
					const [snapshot, mutation] = await Promise.all([
						current.host.status(params.id),
						readV3MutationJournal(loaded.runDir, loaded.baseGraph),
					]);
					const displayedSnapshot = updateReadGraphUi(snapshot);
					return result(`Durable V3 graph loaded.\n${await graphStatusTextV3(displayedSnapshot, current.config.runsDir)}\nRevision: ${mutation.revision}`, {
						...displayedSnapshot,
						snapshot: displayedSnapshot,
						revision: mutation.revision,
						sealed: mutation.sealed,
						cancelledTaskIds: mutation.cancelledTaskIds,
						graph: graphCompileDetailsV3(mutation.graph),
					});
				}
				if (action === "list") {
					const current = await configuredHost(trustedSessionId(ctx), ctx.sessionManager.getSessionFile());
					const summaries = await current.host.list();
					const displayedSummaries = summaries.map((summary) => ({ ...summary, snapshot: projectReadGraphUi(summary.snapshot) }));
					const lines = await Promise.all(displayedSummaries.map((summary) => graphStatusTextV3(summary.snapshot, current.config.runsDir)));
					return result(lines.length ? lines.join("\n\n") : "No V3 graph runs found.", { runs: displayedSummaries });
				}
				if (action === "doctor") {
					const current = await configuredHost(trustedSessionId(ctx), ctx.sessionManager.getSessionFile());
					const report = await current.host.doctor();
					const displayedRoutingDiagnostics = routingDiagnosticsForDoctor(current.config.enabled);
					return result(doctorText(report, displayedRoutingDiagnostics), {
						...report,
						routingGuidance: displayedRoutingDiagnostics,
					}, report.issues.length > 0);
				}
				if (!params.id) return result(`graph ${action} requires id.`, undefined, true);
				const current = await configuredHost(trustedSessionId(ctx), ctx.sessionManager.getSessionFile());
				if (!await current.host.isV3Run(current.host.runDirFor(params.id))) return result(`'${params.id}' is not a V3 graph run.`, undefined, true);
				if(action === "mailbox") {
     const active=activeMailboxes.get(mailboxRegistryKey(current.host.runDirFor(params.id)));
     if(!params.mailbox)return result("mailbox request required",undefined,true);
     if(!active){const snapshot=await current.host.status(params.id);if(snapshot.sessionId!==trustedSessionId(ctx))return result("Mailbox owner mismatch",undefined,true);const value=await inspectMailboxParent(current.host.runDirFor(params.id),snapshot.runInstanceId,trustedSessionId(ctx),params.mailbox);return result(JSON.stringify(value),{graphId:params.id,protocol:"graph-mailbox-v1",readOnly:true});}
     if(active.owner!==trustedSessionId(ctx))return result("Mailbox owner mismatch",undefined,true);
     const value=await active.mailbox.request(await active.mailbox.capability("@parent",1),params.mailbox);
     return result(JSON.stringify(value),{graphId:params.id,protocol:"graph-mailbox-v1"});
    }
    if(action === "usage") {
     const receipt=await graphResultReceipt(await current.host.status(params.id),current.config.runsDir);
     return result(JSON.stringify(pageGraphData({child:receipt.usage,mainSession:summarizeMainSession(ctx.sessionManager)},params.offset,params.limit)),{graphId:params.id,scope:"usage"});
    }
    if(action === "attention") {
     const snapshot=await current.host.status(params.id);const attention=await readGraphSupervisorRequests(snapshot,trustedSessionId(ctx),ctx.sessionManager.getSessionFile(),current.host.runDirFor(snapshot.graphId));
     const page=attentionPages.read({graphId:snapshot.graphId,runInstanceId:snapshot.runInstanceId,ownerSessionId:snapshot.sessionId,readerSessionId:trustedSessionId(ctx),readerSessionFile:ctx.sessionManager.getSessionFile(),runDir:current.host.runDirFor(snapshot.graphId),authorization:snapshot.sessionId===trustedSessionId(ctx)&&!attention.diagnostics.includes("owner_mismatch")?"owner":"readonly"},attention,params.offset,params.limit,params.expectedSha256);
     return result(JSON.stringify(page),{graphId:params.id,requestCount:page.requestCount,nextOffset:page.nextOffset,readOnlySnapshot:true});
    }
    if(action === "result") {
     let page;
     if(params.node){page=await readGraphResult(current.config.runsDir,params.id,params.node,params.attempt,params.offset,params.limit,params.expectedSha256);}
     else {
      const snapshot=await current.host.status(params.id),runDir=current.host.runDirFor(params.id),raw=(await safeBytes(runDir,"snapshot.json")).toString("utf8"),persisted=validateGraphSnapshotV3(JSON.parse(raw));
      if(persisted.graphId!==params.id||persisted.runInstanceId!==snapshot.runInstanceId||persisted.sessionId!==snapshot.sessionId||persisted.graphDigest!==snapshot.graphDigest)throw new Error("Result snapshot identity mismatch");
      page=attentionPages.readSnapshot({graphId:snapshot.graphId,runInstanceId:snapshot.runInstanceId,ownerSessionId:snapshot.sessionId,readerSessionId:trustedSessionId(ctx),readerSessionFile:ctx.sessionManager.getSessionFile(),runDir,authorization:snapshot.sessionId===trustedSessionId(ctx)?"owner":"readonly"},raw,params.offset,params.limit,params.expectedSha256);
     }
     return result(JSON.stringify(page),{graphId:params.id,source:page.source,sha256:page.sha256,nextOffset:page.nextOffset});
    }
    if (action === "wait") {
     const waitingSnapshot = await current.host.status(params.id);
     if (waitingSnapshot.sessionId === trustedSessionId(ctx)) interruptGraphs.add(params.id);
					let lastTuiPanelText: string | undefined;
					const outcome = await waitForGraphSnapshotV3({
						graphId: params.id,
						readStatus: () => current.host.status(params.id!),
      readAttention: snapshot => readGraphSupervisorRequests(snapshot, trustedSessionId(ctx), ctx.sessionManager.getSessionFile(), current.host.runDirFor(snapshot.graphId)),
      subscribeAttention: invalidate => { const off = pi.events.on(NATIVE_SUPERVISOR_EVENT, invalidate); return typeof off === "function" ? off : () => {}; },
						subscribe: (onSnapshot, onStop) => graphWaiters.subscribe(params.id!, onSnapshot, onStop),
						...(liveGraphUi.get(params.id) ? { initialSnapshot: liveGraphUi.get(params.id) } : {}),
						...(signal ? { signal } : {}),
						onUpdate: (snapshot) => {
							const displayedSnapshot = projectReadGraphUi(snapshot);
							const panelText = graphToolPanelTextV3(displayedSnapshot, true);
							if (!shouldPublishGraphWaitUpdateV3(ctx.mode, lastTuiPanelText, panelText)) return;
							if (ctx.mode === "tui") lastTuiPanelText = panelText;
							onUpdate?.(result(`Watching graph '${params.id}'.\n${panelText}`, {
								...displayedSnapshot,
								snapshot: displayedSnapshot,
								watching: true,
							}));
						},
					});
     if (outcome.reason === "aborted" && escapedTurn && interruptGraphs.has(params.id)) {
      try {
       const snapshot = await stopAssociatedGraph(params.id, current.host);
       return result(`Graph cancellation requested by the interrupted Pi turn.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, {
        ...snapshot, snapshot, watching: false, waitReason: "aborted", stopRequested: true,
        graphContinuesRunning: snapshot.status === "needs_attention",
       });
      } catch (error) {
       return result(`Graph stop_requested / needs_attention: child exit is not confirmed. ${String(error)}`, {watching: false, waitReason: "aborted", stopRequested: true, graphContinuesRunning: true}, true);
      }
     }
					return await graphWaitResultV3(params.id, outcome, current.config.runsDir, summarizeMainSession(ctx.sessionManager));
				}
				if (action === "pause") {
					const snapshot = updateNativeGraphUi(await current.host.pause(params.id));
					return result(`Graph pause committed.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, { ...snapshot, snapshot });
				}
				if (action === "retry") {
					if (!params.node) return result("graph retry requires node.", undefined, true);
					const snapshot = updateNativeGraphUi(await current.host.retry(params.id, params.node));
					return result(`Graph retry accepted for '${params.node}'.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, { ...snapshot, snapshot });
				}
				if (action === "append" || action === "cancel" || action === "seal") {
					if (!Number.isSafeInteger(params.revision) || (params.revision ?? -1) < 0) return result(`graph ${action} requires a non-negative revision.`, undefined, true);
					let state: V3GraphMutationState;
					let routingAdmission: RoutingAdmissionReceiptV3 | undefined;
					if (action === "append") {
						if (!params.nodes?.length) return result("graph append requires nodes.", undefined, true);
						const loaded = await current.host.loadRun(current.host.runDirFor(params.id), params.id);
						if (loaded.mutation.revision !== params.revision) {
							throw new V3RevisionConflictError(params.revision!, loaded.mutation.revision);
						}
							const bound = await bindGraphNodesWithRoutingV3(params.nodes, {
								...bindingOptionsFromContextV3(ctx, current.config.allowTemporaryAgent),
								cwd: loaded.authorization.sourceCwd,
								graphToolFilter: loaded.graph.sourceGraphSpec.toolFilter,
								...(loaded.graph.sourceGraphSpec.parentToolAllowlist === undefined ? {} : { parentToolAllowlist: loaded.graph.sourceGraphSpec.parentToolAllowlist.filter((tool) => pi.getActiveTools().includes(tool)) }),
								contractPolicy: loaded.graph.sourceGraphSpec.bindingPolicy === "strict" ? "strict" : "standard",
								resolveTrustedProducerModel: async (taskId) => (await readAcceptedProducerModelsV3({
									runDir: loaded.runDir,
									graph: loaded.graph,
									runInstanceId: loaded.authorization.runInstanceId,
									taskIds: [taskId],
								}))[taskId],
							});
						routingAdmission = bound.routingAdmission;
						state = await current.host.append(params.id, bound.nodes, params.revision!);
					} else if (action === "cancel") {
						if (!params.taskIds?.length) return result("graph cancel requires taskIds.", undefined, true);
						state = await current.host.cancel(params.id, params.taskIds, params.cascade ?? false, params.revision!);
					} else {
						state = await current.host.seal(params.id, params.revision!);
					}
					const snapshot = updateNativeGraphUi(await current.host.status(params.id));
					return result(`${mutationTextV3(params.id, state, action)}\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, {
						...state,
						snapshot,
						...(routingAdmission ? { routingAdmission } : {}),
					});
				}
				if (action === "status") {
					const snapshot = updateReadGraphUi(await current.host.status(params.id));
					return result(await graphStatusTextV3(snapshot, current.config.runsDir), { ...snapshot, snapshot });
				}
				if (action === "stop") {
					const snapshot = updateNativeGraphUi(await current.host.stop(params.id));
					return result(`Graph stopped.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, { ...snapshot, snapshot });
				}
				if (action === "resume") {
					const snapshot = updateNativeGraphUi(await current.host.resume(params.id));
					return result(`Graph resumed.\n${await graphStatusTextV3(snapshot, current.config.runsDir)}`, { ...snapshot, snapshot });
				}
				return result(`Unsupported graph action '${action}'.`, undefined, true);
			} catch (error) {
    if (error instanceof GraphSourceChangedError) {
     const recovery={discardPreviousPages:true,maxAutomaticRestarts:1,copyRestartRequestExactly:true,keepLimit:true,rerunTask:false,onRepeatedRecovery:"stop_read_loop_and_open_graphs_details"};
     const data={code:error.code,recoverable:true,message:"读取快照已更新或失效，请丢弃旧分页，从第一页重新读取；自动重读最多一次，仍失败请查看 /graphs 详情，不要重跑任务或改变 limit。",sha256:error.sha256,restartRequest:error.restartRequest,recovery};
     return {...result(JSON.stringify(data),data),isError:false};
    }
				return graphToolErrorResultV3(error);
			}
		},
		renderCall(params, theme, context) {
   const action = params.action ?? "start";
   const id = params.id ?? params.spec?.graphId;
   // The result renderer fills state during the same Pi render pass.
   return {
    render(width: number): string[] {
     const pending = action === "start" ? (context.executionStarted ? "正在提交" : "准备启动") : action === "wait" ? "正在等待" : "";
     const label = interruptedCalls.has(context.toolCallId) ? "未执行 · 主 Agent 响应中断" : context.state.receipt ?? pending;
     const text = action === "start" || action === "wait"
      ? `◆ ${label || (action === "start" ? "已提交" : "正在等待")}`
      : ["attention","mailbox","result"].includes(action) ? `◆ ${{attention:"待处理信息",mailbox:"邮箱",result:"读取结果"}[action]}${label ? ` · ${label}` : ""}`
      : `◆ PI-GRAPH ${action.toUpperCase()}${id ? ` · ${safeText(id)}` : ""}${label ? ` · ${label}` : ""}`;
     return [truncateGraphLineV3(theme.fg(context.state.sourceChanged ? "warning" : context.isError ? "error" : "muted", text), width)];
    },
    invalidate() {},
   };
  },
		renderResult(toolResult, { expanded, isPartial }, theme, context) {
			const isError = context.isError;
   const recovery = (toolResult.details as {code?:string}|undefined)?.code === "source_changed";
   context.state.sourceChanged = recovery;
			const detailSnapshot = graphSnapshotFromDetails(toolResult.details);
			if (detailSnapshot) {
				const snapshot = detailSnapshot;
    liveGraphUi.unwatchToolCard(context.toolCallId);
    const action = context.args.action ?? "start";
    if (action === "start" || action === "wait") {
     const details = toolResult.details as { graphContinuesRunning?: boolean } | undefined;
     context.state.receipt = graphReceiptTextV3(action, snapshot, isPartial, details?.graphContinuesRunning);
     if (!expanded) return { render: () => [], invalidate() {} };
    }
    const color = isError ? "error" : snapshot.status === "complete" ? "success" : "muted";
    const receipt = expanded && (action === "start" || action === "wait")
     ? `回执快照 · /graphs view ${safeText(snapshot.graphId)} 实时详情\n` : "";
    return new GraphTextComponent(theme.fg(color, receipt + graphToolPanelTextV3(snapshot, expanded)));
   }
			const content = toolResult.content.find((entry) => entry.type === "text");
			const text = content?.type === "text" ? content.text : "Graph result unavailable.";
   if (isError && interruptedCalls.has(context.toolCallId) && !expanded) {
    return new GraphTextComponent(theme.fg("error", `  ${errorSummary(text)}\n  本次指令未执行，可让主 Agent 重新发起。`));
   }
			return new GraphTextComponent(theme.fg(recovery ? "warning" : isError ? "error" : isPartial ? "warning" : "toolOutput", expanded ? text : recovery || ["attention","mailbox","result"].includes(context.args.action ?? "start") ? compactToolReceipt(context.args.action ?? "start", text, toolResult.details, isError) : text.split("\n").slice(0,8).join("\n")));
		},
	});
}
