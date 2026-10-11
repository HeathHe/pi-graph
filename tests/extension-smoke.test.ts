import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { V3RevisionConflictError } from "../src/v3/mutations.ts";
import { piCliPath } from "./helpers/pi-cli.ts";

test("D2: only the retained pi extensions are autoloaded", async () => {
	const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { pi?: { extensions?: string[] } };
	assert.deepEqual(packageJson.pi?.extensions, [
		"./extensions/pi-graph.ts",
		"./extensions/pi-graph-guard.ts",
	]);
	assert.equal(packageJson.pi?.extensions?.includes("./extensions/subagent-model-router.ts"), false);
});

test("D3: graph tool exposes the complete V3 action set plus the Pi Binding authoring layer", () => {
	const jiti = createJiti(import.meta.url);
	const { GraphSpecV3Schema, GraphSpecV3NodeSchema, Parameters } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		GraphSpecV3Schema: {
			properties: {
				mode?: { enum?: string[] };
				contractPolicy?: { enum?: string[] };
				nodes: { minItems?: number; maxItems?: number; items: { properties: Record<string, unknown> } };
			};
		};
		GraphSpecV3NodeSchema: { properties: Record<string, unknown>; required?: string[] };
		Parameters: { properties: Record<string, { enum?: string[]; minimum?: number; minItems?: number; maxItems?: number; uniqueItems?: boolean }> };
	};
	const actions = Parameters.properties.action?.enum;
	assert.deepEqual(actions, ["start", "wait", "result", "attention", "mailbox", "usage", "load", "status", "list", "doctor", "pause", "resume", "stop", "templates", "agents", "retry", "append", "cancel", "seal"]);
	assert.equal(actions?.includes("recommend"), false);
	assert.ok(GraphSpecV3Schema, "the tool must expose the GraphSpec v3 schema");
	assert.deepEqual(GraphSpecV3Schema.properties.mode?.enum, ["sealed", "open"]);
	assert.equal(GraphSpecV3Schema.properties.nodes.minItems, undefined, "open graphs must be representable with an empty node array");
	assert.equal(GraphSpecV3Schema.properties.nodes.maxItems, 512);
	assert.ok(GraphSpecV3NodeSchema.properties.when, "conditional nodes must be visible in the public schema");
	assert.ok(GraphSpecV3NodeSchema.required?.includes("sideEffect"), "sideEffect is required by the V3 compiler contract");
	assert.equal(GraphSpecV3NodeSchema.required?.includes("agent") ?? false, false, "capability-authored nodes must not require an explicit Agent");
	for (const field of ["agent", "capabilityId", "requires", "model", "thinking", "turnBudget", "toolBudget", "usageBudget", "maxTokens"]) {
		assert.ok(field in GraphSpecV3NodeSchema.properties, `${field} must be exposed by the Pi Binding authoring layer`);
	}
	assert.deepEqual(GraphSpecV3Schema.properties.contractPolicy?.enum, ["standard", "strict"]);
	for (const forbidden of ["routingProfile", "maxAuthorization", "binding", "launch"]) {
		assert.equal(forbidden in GraphSpecV3NodeSchema.properties, false, `${forbidden} is internal or obsolete and must not enter public authoring`);
	}
	for (const field of ["revision", "nodes", "taskIds", "cascade", "capsule", "template", "overrides", "node"]) assert.ok(Parameters.properties[field], `${field} must be exposed`);
	assert.equal(Parameters.properties.revision?.minimum, 0);
	assert.equal(Parameters.properties.nodes?.maxItems, 64);
	assert.equal(Parameters.properties.taskIds?.uniqueItems, true);
});

test("public docs use the same standard/strict contract policy as the tool schema", async () => {
	const [readme, contract] = await Promise.all([
		readFile(new URL("../README.md", import.meta.url), "utf8"),
		readFile(new URL("../docs/v3-technical-contract.md", import.meta.url), "utf8"),
	]);
	assert.match(readme, /`contractPolicy` \| authoring-only：`standard`（默认）或 `strict`/u);
	assert.doesNotMatch(readme, /`contractPolicy`[^\n]*`legacy`/u);
	assert.match(contract, /contractPolicy\?: "standard" \| "strict";/u);
	assert.match(contract, /`contractPolicy` \| `standard`（默认）或 `strict`/u);
	assert.match(contract, /standard 合同至少提供 `agent`、`capabilityId` 或 `requires`/u);
	assert.doesNotMatch(contract, /`contractPolicy`[^\n]*`legacy`/u);
});

test("PI-GRAPH routing guidance is explicit, idempotent, and config-gated", () => {
	const jiti = createJiti(import.meta.url);
	const {
		PI_GRAPH_ROUTING_GUIDANCE,
		PI_GRAPH_ROUTING_GUIDANCE_HASH,
		PI_GRAPH_ROUTING_SENTINEL,
		PI_GRAPH_ROUTING_GUIDANCE_VERSION,
		PI_GRAPH_TOOL_DESCRIPTION,
		piGraphRoutingDiagnosticsV3,
		shouldInjectPiGraphRoutingGuidanceV3,
		withPiGraphRoutingGuidanceV3,
	} = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		PI_GRAPH_ROUTING_GUIDANCE: string;
		PI_GRAPH_ROUTING_GUIDANCE_HASH: string;
		PI_GRAPH_ROUTING_SENTINEL: string;
		PI_GRAPH_ROUTING_GUIDANCE_VERSION: string;
		PI_GRAPH_TOOL_DESCRIPTION: string;
		piGraphRoutingDiagnosticsV3(enabled?: boolean, selectedTools?: readonly string[], injected?: boolean): Record<string, unknown>;
		shouldInjectPiGraphRoutingGuidanceV3(enabled: boolean, selectedTools: readonly string[] | undefined): boolean;
		withPiGraphRoutingGuidanceV3(systemPrompt: string, enabled?: boolean): string | undefined;
	};
	const original = "BASE SYSTEM PROMPT\nKeep this content.";
	const injected = withPiGraphRoutingGuidanceV3(original, true);
	assert.ok(injected);
	assert.ok(injected.startsWith(`${original}\n\n`), "routing guidance must preserve the assembled system prompt byte-for-byte before appending");
	assert.equal(injected.split(PI_GRAPH_ROUTING_SENTINEL).length - 1, 1);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /Delegate all actual investigation and execution/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /Use the `graph` tool for coordinated work units/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /fan-out\/fan-in/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /a dependency chain/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /implementation plus independent testing, review, or validation/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /single-node Graph with an explicit role/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /dynamic model routing, including a single-node task/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /Use Graph for two or more actual execution units/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /parent must explicitly use Graph for execution/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /New Graphs inherit the parent tool ceiling/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /parent must explicitly use Graph for execution/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /single-node Graph with an explicit role/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /explicitly assign the existing generalist/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /Capability Contract mandates shadow isolation, use Graph or report the conflict/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /does not start itself/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /explicitly call the `graph` tool/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /action `start` is asynchronous/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /action: "wait"/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /synthesize the settled node results/u);
	assert.ok(PI_GRAPH_TOOL_DESCRIPTION.includes(PI_GRAPH_ROUTING_GUIDANCE), "the graph tool description must reuse the exact parent-routing contract");
	assert.equal(PI_GRAPH_TOOL_DESCRIPTION.split(PI_GRAPH_ROUTING_SENTINEL).length - 1, 1);
	assert.equal(PI_GRAPH_ROUTING_GUIDANCE_VERSION, "10");
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /readScope and requiredMaterials before start/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /prose MustRead grants and copies nothing/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE, /Do not add task or reply runtime deadlines unless the user explicitly asks/u);
	assert.match(PI_GRAPH_ROUTING_GUIDANCE_HASH, /^[a-f0-9]{64}$/u);
	assert.deepEqual(piGraphRoutingDiagnosticsV3(true, ["read", "graph"], true), {
		version: PI_GRAPH_ROUTING_GUIDANCE_VERSION,
		hash: PI_GRAPH_ROUTING_GUIDANCE_HASH,
		observed: true,
		enabled: true,
		graphVisible: true,
		injected: true,
	});
	assert.deepEqual(piGraphRoutingDiagnosticsV3(), {
		version: PI_GRAPH_ROUTING_GUIDANCE_VERSION,
		hash: PI_GRAPH_ROUTING_GUIDANCE_HASH,
		observed: false,
		enabled: null,
		graphVisible: null,
		injected: null,
	});
	assert.equal(withPiGraphRoutingGuidanceV3(injected, true), undefined, "a chained prompt must not receive a duplicate routing block");
	assert.equal(withPiGraphRoutingGuidanceV3(original, false), undefined, "graph.enabled=false must suppress routing guidance");
	assert.equal(shouldInjectPiGraphRoutingGuidanceV3(true, ["read", "graph"]), true);
	assert.equal(shouldInjectPiGraphRoutingGuidanceV3(false, ["graph"]), false, "graph.enabled=false must suppress the hook");
	assert.equal(shouldInjectPiGraphRoutingGuidanceV3(true, ["read", "subagent"]), false, "child contexts without the graph tool must not receive parent routing guidance");
	assert.equal(shouldInjectPiGraphRoutingGuidanceV3(true, undefined), false);
});

test("V3 graph wait streams rich snapshots and settles without leaking its subscription", { timeout: 2_000 }, async () => {
	const jiti = createJiti(import.meta.url);
	const { V3GraphWaitRegistry, waitForGraphSnapshotV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		V3GraphWaitRegistry: new () => {
			size: number;
			subscribe(graphId: string, onSnapshot: (snapshot: any) => void, onStop: (reason: string) => void): () => void;
			publish(snapshot: any): void;
		};
		waitForGraphSnapshotV3(options: Record<string, unknown>): Promise<{ reason: string; snapshot?: any }>;
	};
	const base = {
		schemaVersion: 3,
		runInstanceId: "wait-run",
		graphId: "wait-graph",
		graphDigest: "a".repeat(64),
		sourceGraphSpecDigest: "b".repeat(64),
		sessionId: "wait-session",
		supervisorEpoch: "wait-epoch",
		createdAt: "2026-08-25T00:00:00.000Z",
	};
	const running = { ...base, status: "running", updatedAt: "2026-08-25T00:00:01.000Z", nodes: {} };
	const observed = {
		...running,
		updatedAt: "2026-08-25T00:00:02.000Z",
		nodes: {
			work: {
				phase: "running",
				attempt: 1,
				agent: "resolved-worker",
				observation: {
					asyncId: "outer-async",
					runId: "child-run",
					requestedAgent: "requested-worker",
					resolvedAgent: "resolved-worker",
					actualAgent: "actual-worker",
					requestedModel: "provider/requested",
					resolvedModel: "provider/resolved",
					actualModel: "provider/actual",
					usage: { totalTokens: 321, costUsd: 0.0125, turns: 3 },
					progress: { currentTool: "read", currentPath: "src/work.ts", turnCount: 4, toolCount: 6 },
					observedAt: "2026-08-25T00:00:02.000Z",
				},
			},
		},
	};
	const complete = { ...observed, status: "complete", updatedAt: "2026-08-25T00:00:03.000Z" };
	const registry = new V3GraphWaitRegistry();
	const updates: any[] = [];
	let resolveInitial!: () => void;
	let resolveObserved!: () => void;
	const initialUpdate = new Promise<void>((resolve) => { resolveInitial = resolve; });
	const richUpdate = new Promise<void>((resolve) => { resolveObserved = resolve; });
	const pending = waitForGraphSnapshotV3({
		graphId: "wait-graph",
		readStatus: async () => running,
		subscribe: (onSnapshot: (snapshot: any) => void, onStop: (reason: string) => void) => registry.subscribe("wait-graph", onSnapshot, onStop),
		pollIntervalMs: 1_000,
		onUpdate: (snapshot: any) => {
			updates.push(snapshot);
			if (updates.length === 1) resolveInitial();
			if (updates.length === 2) resolveObserved();
			throw new Error("renderer failure must remain observational");
		},
	});
	await initialUpdate;
	assert.equal(registry.size, 1);
	assert.doesNotThrow(() => registry.publish(observed));
	await richUpdate;
	assert.equal(updates.at(-1)?.nodes.work.observation.actualModel, "provider/actual");
	assert.equal(updates.at(-1)?.nodes.work.observation.progress.currentTool, "read");
	registry.publish(complete);
	const outcome = await pending;
	assert.equal(outcome.reason, "graph_settled");
	assert.equal(outcome.snapshot?.status, "complete");
	assert.equal(outcome.snapshot?.nodes.work.observation.runId, "child-run");
	assert.equal(registry.size, 0);
});

test("V3 live UI projection rejects stale start snapshots and refreshes completed start cards", () => {
	const jiti = createJiti(import.meta.url);
	const { V3GraphLiveUiProjection, newestGraphSnapshotV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as any;
	const base = {
		schemaVersion: 3,
		runInstanceId: "live-run",
		graphId: "live-graph",
		graphDigest: "a".repeat(64),
		sourceGraphSpecDigest: "b".repeat(64),
		sessionId: "live-session",
		supervisorEpoch: "live-epoch",
		createdAt: "2026-08-25T00:00:00.000Z",
		nodes: { work: { phase: "queued", attempt: 0 } },
	};
	const queued = { ...base, status: "queued", updatedAt: "2026-08-25T00:00:00.000Z" };
	const running = {
		...base,
		status: "running",
		updatedAt: "2026-08-25T00:00:02.000Z",
		nodes: {
			work: {
				phase: "running",
				attempt: 1,
				observation: {
					asyncId: "live-child",
					progress: { state: "running", lastActivityAt: "2026-08-25T00:00:02.000Z" },
					observedAt: "2026-08-25T00:00:02.000Z",
				},
			},
		},
	};
	const staleStartAcknowledgement = {
		...base,
		status: "queued",
		updatedAt: running.updatedAt,
	};
	assert.equal(newestGraphSnapshotV3(running, staleStartAcknowledgement, { preserveExistingOnTie: true }), running);

	const live = new V3GraphLiveUiProjection();
	live.project(queued);
	let invalidations = 0;
	live.watchToolCard("start-card", queued.graphId, () => { invalidations += 1; });
	assert.equal(live.watchedToolCardCount, 1);
	assert.equal(live.project(running), running);
	assert.equal(invalidations, 1, "a post-return Supervisor snapshot must invalidate the completed start card");
	const hiddenTimestampUpdate = {
		...running,
		updatedAt: "2026-08-25T00:00:03.000Z",
		nodes: {
			work: {
				...running.nodes.work,
				observation: {
					...running.nodes.work.observation,
					progress: { state: "running", lastActivityAt: "2026-08-25T00:00:03.000Z" },
					observedAt: "2026-08-25T00:00:03.000Z",
				},
			},
		},
	};
	assert.equal(live.project(hiddenTimestampUpdate), hiddenTimestampUpdate);
	assert.equal(live.get(running.graphId), hiddenTimestampUpdate, "hidden timestamps must remain available in the latest durable projection");
	assert.equal(invalidations, 2, "visible activity timestamps refresh expanded details");
	const sameTimeLiveEvent = {
		...hiddenTimestampUpdate,
		nodes: { work: { ...hiddenTimestampUpdate.nodes.work, phase: "verifying", attempt: 1 } },
	};
	assert.equal(live.project(sameTimeLiveEvent), sameTimeLiveEvent, "ordered Supervisor events may advance within one clock millisecond");
	assert.equal(invalidations, 3);
	assert.equal(live.current(staleStartAcknowledgement), sameTimeLiveEvent, "the renderer must use the existing live snapshot on a timestamp tie");
	assert.equal(live.project(staleStartAcknowledgement, { preserveExistingOnTie: true }), sameTimeLiveEvent);
	assert.equal(invalidations, 3, "an equal-time read/start acknowledgement must not cause a UI rollback or redraw");

	const complete = {
		...sameTimeLiveEvent,
		status: "complete",
		updatedAt: "2026-08-25T00:00:04.000Z",
		nodes: { work: { phase: "accepted", attempt: 1, terminalStatus: "accepted" } },
	};
	live.project(complete);
	assert.equal(invalidations, 4);
	assert.equal(live.watchedToolCardCount, 0, "terminal graphs must release their tool-card invalidators");
	live.project({ ...complete, updatedAt: "2026-08-25T00:00:05.000Z" });
	assert.equal(invalidations, 4);
});

test("V3 live UI projection orders open-graph snapshots by revision before timestamp", () => {
	const jiti = createJiti(import.meta.url);
	const { newestGraphSnapshotV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as any;
	const base = {
		schemaVersion: 3,
		runInstanceId: "open-run",
		graphId: "open-graph",
		graphDigest: "a".repeat(64),
		sourceGraphSpecDigest: "b".repeat(64),
		status: "running",
		sessionId: "open-session",
		supervisorEpoch: "open-epoch",
		createdAt: "2026-08-25T00:00:00.000Z",
		topology: "open",
		sealed: false,
		nodes: {},
	};
	const revisionTwo = { ...base, revision: 2, updatedAt: "2026-08-25T00:00:02.000Z" };
	const staleRevisionWithLaterClock = { ...base, revision: 1, updatedAt: "2026-08-25T00:00:09.000Z" };
	assert.equal(newestGraphSnapshotV3(revisionTwo, staleRevisionWithLaterClock), revisionTwo);
});

test("V3 live UI projection keeps multi-graph order stable for hidden timestamp updates", () => {
	const jiti = createJiti(import.meta.url);
	const { V3GraphLiveUiProjection } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as any;
	const makeSnapshot = (graphId: string, second: number) => ({
		schemaVersion: 3,
		runInstanceId: `${graphId}-run`,
		graphId,
		graphDigest: "a".repeat(64),
		sourceGraphSpecDigest: "b".repeat(64),
		status: "running",
		sessionId: "order-session",
		supervisorEpoch: "order-epoch",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: `2026-08-25T00:00:0${second}.000Z`,
		nodes: {
			work: {
				phase: "running",
				attempt: 1,
				observation: {
					asyncId: `${graphId}-child`,
					progress: { state: "running", lastActivityAt: `2026-08-25T00:00:0${second}.000Z` },
					observedAt: `2026-08-25T00:00:0${second}.000Z`,
				},
			},
		},
	});
	const live = new V3GraphLiveUiProjection();
	for (const [index, graphId] of ["a", "b", "c", "d"].entries()) live.project(makeSnapshot(graphId, index + 1));
	assert.deepEqual(live.values().map((snapshot: any) => snapshot.graphId), ["a", "b", "c", "d"]);
	const hiddenUpdate = makeSnapshot("a", 6);
	Object.assign(hiddenUpdate.nodes.work.observation.progress, { toolCount: 42, lastTool: "read" });
	live.project(hiddenUpdate);
	assert.equal(live.get("a"), hiddenUpdate, "the complete newest snapshot must still replace the stored value");
	assert.deepEqual(live.values().map((snapshot: any) => snapshot.graphId), ["a", "b", "c", "d"], "hidden activity must not rotate the visible last-three graphs");
	const visibleUpdate = {
		...makeSnapshot("a", 7),
		nodes: { work: { phase: "accepted", terminalStatus: "accepted", attempt: 1 } },
	};
	live.project(visibleUpdate);
	assert.deepEqual(live.values().map((snapshot: any) => snapshot.graphId), ["b", "c", "d", "a"], "a compact-summary count change retains recency ordering");
});

test("V3 graph wait handles fast terminal state and durable polling fallback", { timeout: 2_000 }, async () => {
	const jiti = createJiti(import.meta.url);
	const { V3GraphWaitRegistry, waitForGraphSnapshotV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as any;
	const base = {
		schemaVersion: 3,
		runInstanceId: "fast-run",
		graphId: "fast-graph",
		graphDigest: "a".repeat(64),
		sourceGraphSpecDigest: "b".repeat(64),
		sessionId: "fast-session",
		supervisorEpoch: "fast-epoch",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:01.000Z",
		nodes: {},
	};
	const fastRegistry = new V3GraphWaitRegistry();
	const fast = await waitForGraphSnapshotV3({
		graphId: "fast-graph",
		readStatus: async () => ({ ...base, status: "complete" }),
		subscribe: (onSnapshot: (snapshot: any) => void, onStop: (reason: string) => void) => fastRegistry.subscribe("fast-graph", onSnapshot, onStop),
	});
	assert.equal(fast.reason, "graph_settled");
	assert.equal(fastRegistry.size, 0);

	const pollingRegistry = new V3GraphWaitRegistry();
	let durable = { ...base, status: "running" };
	const polled = waitForGraphSnapshotV3({
		graphId: "fast-graph",
		readStatus: async () => durable,
		subscribe: (onSnapshot: (snapshot: any) => void, onStop: (reason: string) => void) => pollingRegistry.subscribe("fast-graph", onSnapshot, onStop),
		pollIntervalMs: 25,
		onUpdate: (snapshot: any) => {
			if (snapshot.status === "running") durable = { ...base, status: "idle", updatedAt: "2026-08-25T00:00:02.000Z" };
		},
	});
	assert.equal((await polled).snapshot?.status, "idle");
	assert.equal(pollingRegistry.size, 0);
});

test("V3 graph wait abort and session shutdown stop watching only", { timeout: 2_000 }, async () => {
	const jiti = createJiti(import.meta.url);
	const { V3GraphWaitRegistry, graphWaitResultV3, waitForGraphSnapshotV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as any;
	const running = {
		schemaVersion: 3,
		runInstanceId: "cancel-run",
		graphId: "cancel-graph",
		graphDigest: "a".repeat(64),
		sourceGraphSpecDigest: "b".repeat(64),
		status: "running",
		sessionId: "cancel-session",
		supervisorEpoch: "cancel-epoch",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:01.000Z",
		nodes: {},
	};
	const abortRegistry = new V3GraphWaitRegistry();
	const controller = new AbortController();
	let resolveObserved!: () => void;
	const observed = new Promise<void>((resolve) => { resolveObserved = resolve; });
	const aborted = waitForGraphSnapshotV3({
		graphId: "cancel-graph",
		readStatus: async () => running,
		subscribe: (onSnapshot: (snapshot: any) => void, onStop: (reason: string) => void) => abortRegistry.subscribe("cancel-graph", onSnapshot, onStop),
		signal: controller.signal,
		onUpdate: resolveObserved,
	});
	await observed;
	controller.abort();
	const abortedOutcome = await aborted;
	assert.equal(abortedOutcome.reason, "aborted");
	assert.equal(abortedOutcome.snapshot?.status, "running", "abort returns the latest view without changing graph state");
	assert.equal(abortRegistry.size, 0);
	const abortedResult = await graphWaitResultV3("cancel-graph", abortedOutcome, "/tmp/pi-graph-wait-tests");
	assert.match(abortedResult.content[0].text, /Stopped watching/u);
	assert.match(abortedResult.content[0].text, /Graph continues running/u);
	assert.equal(abortedResult.details.watching, false);
	assert.equal(abortedResult.details.graphContinuesRunning, true);
	assert.equal(abortedResult.details.snapshot.status, "running");

	const shutdownRegistry = new V3GraphWaitRegistry();
	const shutdown = waitForGraphSnapshotV3({
		graphId: "cancel-graph",
		initialSnapshot: running,
		readStatus: async () => running,
		subscribe: (onSnapshot: (snapshot: any) => void, onStop: (reason: string) => void) => shutdownRegistry.subscribe("cancel-graph", onSnapshot, onStop),
	});
	assert.equal(shutdownRegistry.size, 1);
	shutdownRegistry.shutdown();
	assert.equal((await shutdown).reason, "session_shutdown");
	assert.equal(shutdownRegistry.size, 0);
});

test("Extension source admission reduces capability/model authoring to exact durable Agent evidence", async () => {
	const jiti = createJiti(import.meta.url);
	const { sourceSpecV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		sourceSpecV3(params: unknown, cwd: string, binding: unknown): Promise<{ spec: any }>;
	};
	const root = await mkdtemp(join(tmpdir(), "pi-graph-extension-binding-"));
	try {
		await writeFile(join(root, "routing-policy.json"), JSON.stringify({
			schemaVersion: 1,
			enforcement: "graph-admission",
			quarantinedProviderDomains: [],
			profiles: { "implementation-review": { candidates: [{ model: "provider/preferred", thinking: "high", level: "L0" }] } },
		}));
		await writeFile(join(root, "subagent-capabilities.json"), JSON.stringify({
			schemaVersion: 1,
			capabilities: [{ capabilityId: "review.code", agent: "code-reviewer", routingProfile: "implementation-review" }],
		}));
		await writeFile(join(root, "models.json"), JSON.stringify({ providers: {} }));
		const source = await sourceSpecV3({
			spec: {
				schemaVersion: 3,
				goal: "Select a reviewer through the public capability contract",
				contractPolicy: "strict",
				nodes: [{
					taskId: "review",
					requires: ["review.code"],
					model: "provider/preferred",
					maxTokens: 8_192,
					task: "Review the change",
					sideEffect: "none",
				}],
			},
		}, root, {
			cwd: root,
			agentDir: root,
			catalog: { schemaVersion: 1, capabilities: [{ capabilityId: "review.code", agent: "code-reviewer", routingProfile: "implementation-review" }] },
			preflightAgent: async (input: { agent: string; model?: string }) => ({
				ok: true,
				name: input.agent,
				agentDefinitionDigest: "a".repeat(64),
				launchContractDigest: "b".repeat(64),
				modelCandidates: input.model ? [input.model] : [],
				extensions: {
					runtimeExtensions: [],
					configuredExtensions: [],
					extensionArgs: [],
					disableAmbientExtensions: true,
				},
				...(input.model ? { model: input.model } : {}),
			}),
		});
		const node = source.spec.nodes[0];
		assert.equal(source.spec.bindingPolicy, "strict");
		assert.equal(node.agent, "code-reviewer");
		assert.equal(node.binding.resolution, "capability-catalog");
		assert.equal(node.launch.requestedModel, "provider/preferred");
		assert.equal(node.launch.resolvedModel, "provider/preferred");
		assert.equal(node.launch.maxTokens, 8_192);
		assert.equal(node.launch.usageBudget, undefined);
		for (const authoringOnly of ["requires", "capabilityId", "model", "maxTokens"]) {
			assert.equal(authoringOnly in node, false, `${authoringOnly} must not enter the DAG core`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("V3 agents projection reads only project manifests and omits model-routing fields", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-extension-agents-"));
	try {
		const agentsDir = join(root, ".pi", "agents");
		await mkdir(agentsDir, { recursive: true });
		await writeFile(join(agentsDir, "reviewer.md"), [
			"---",
			"name: code-reviewer",
			"description: Read-only code review",
			"aliases: reviewer, audit",
			"model: provider/private-model",
			"thinking: xhigh",
			"routingProfile: forbidden",
			"---",
			"Review the code.",
		].join("\n"));
		await writeFile(join(agentsDir, "workflow.chain.md"), "---\nname: ignored-chain\n---\n");
		const jiti = createJiti(import.meta.url);
		const { listProjectAgentsV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
			listProjectAgentsV3(cwd: string): Promise<Array<Record<string, unknown>>>;
		};
		const agents = await listProjectAgentsV3(root);
		assert.deepEqual(agents, [{ name: "code-reviewer", description: "Read-only code review", aliases: ["reviewer", "audit"] }]);
		const serialized = JSON.stringify(agents);
		for (const forbidden of ["private-model", "thinking", "routingProfile", "systemPrompt"]) assert.equal(serialized.includes(forbidden), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("V3 capability listing exposes exact Agent bindings without model-routing metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-extension-capabilities-"));
	try {
		const path = join(root, "subagent-capabilities.json");
		await writeFile(path, JSON.stringify({
			schemaVersion: 1,
			capabilities: [{
				capabilityId: "review.code",
				agent: "code-reviewer",
				routingProfile: "private-routing-profile",
				modelPolicy: { mode: "fixed", model: "provider/private-model" },
			}],
		}));
		const jiti = createJiti(import.meta.url);
		const { listCapabilityBindingsV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
			listCapabilityBindingsV3(options: { path: string }): Promise<{ digest: string; entries: Array<Record<string, unknown>> }>;
		};
		const projection = await listCapabilityBindingsV3({ path });
		assert.deepEqual(projection.entries, [{ capabilityId: "review.code", agent: "code-reviewer" }]);
		assert.match(projection.digest, /^[a-f0-9]{64}$/u);
		const serialized = JSON.stringify(projection);
		for (const forbidden of ["private-model", "private-routing-profile", "modelPolicy", "routingProfile"]) {
			assert.equal(serialized.includes(forbidden), false);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("V3 public load/templates/agents actions return useful data without executing a graph", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-extension-public-actions-"));
	const agentDir = join(root, "agent-home");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentsDir = join(root, ".pi", "agents");
		await Promise.all([mkdir(agentsDir, { recursive: true }), mkdir(agentDir, { recursive: true })]);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ graph: { enabled: true } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await writeFile(join(agentsDir, "extension-smoke-worker.md"), "---\nname: extension-smoke-worker\ndescription: Local worker\nmodel: fixture/must-not-leak\n---\nWork.\n");
		const jiti = createJiti(import.meta.url);
		const extensionModule = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
			default: (api: Record<string, unknown>) => void;
			PI_GRAPH_ROUTING_GUIDANCE: string;
			PI_GRAPH_TOOL_DESCRIPTION: string;
		};
		const extension = extensionModule.default;
		let graphTool: { label?: string; description?: string; execute: (...args: any[]) => Promise<{ content: Array<{ text: string }>; details: any; isError?: boolean }> } | undefined;
		const listeners = new Map<string, Array<(data: unknown) => void>>();
		const hooks = new Map<string, (event: unknown) => unknown>();
		const events = {
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = listeners.get(channel) ?? [];
				handlers.push(handler);
				listeners.set(channel, handlers);
				return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((candidate) => candidate !== handler));
			},
			emit(channel: string, data: unknown) {
				for (const handler of listeners.get(channel) ?? []) handler(data);
			},
		};
		extension({
			events,
			on(event: string, handler: (value: unknown) => unknown) { hooks.set(event, handler); },
			registerCommand() {},
			registerTool(tool: unknown) { graphTool = tool as typeof graphTool; },
			getActiveTools: () => ["read", "bash", "write", "edit", "grep", "find", "ls", "graph"],
		} as any);
		assert.ok(graphTool, "graph tool must register");
		assert.equal(graphTool.label, "◆ PI-GRAPH");
		assert.equal(graphTool.description, extensionModule.PI_GRAPH_TOOL_DESCRIPTION, "the registered tool must use the shared routing description");
		assert.equal(typeof hooks.get("before_agent_start"), "function", "the extension must guide the parent Agent before each turn");
		const beforeAgentStart = hooks.get("before_agent_start") as (event: {
			systemPrompt: string;
			systemPromptOptions: { selectedTools?: string[] };
		}) => Promise<{ systemPrompt: string } | undefined>;
		const visibleRouting = await beforeAgentStart({
			systemPrompt: "BASE SYSTEM PROMPT",
			systemPromptOptions: { selectedTools: ["read", "graph"] },
		});
		assert.ok(visibleRouting?.systemPrompt.includes(extensionModule.PI_GRAPH_ROUTING_GUIDANCE));
		assert.equal(visibleRouting?.systemPrompt.split("## PI-GRAPH Routing").length, 2, "the real lifecycle hook must inject one routing block");
		assert.equal(await beforeAgentStart({
			systemPrompt: "BASE SYSTEM PROMPT",
			systemPromptOptions: { selectedTools: ["read", "subagent"] },
		}), undefined, "child/tool-filtered contexts must not receive Graph routing");
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ graph: { enabled: false } }));
		assert.equal(await beforeAgentStart({
			systemPrompt: "BASE SYSTEM PROMPT",
			systemPromptOptions: { selectedTools: ["read", "graph"] },
		}), undefined, "graph.enabled=false must suppress the real lifecycle hook");
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ graph: { enabled: true } }));
		const ctx = { cwd: root, model: undefined, modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "must-not-leak", api: "openai-completions", input: ["text"], reasoning: false }] } };
		const loaded = await graphTool.execute("load", {
			action: "load",
			spec: { schemaVersion: 3, goal: "compile only", nodes: [{ taskId: "a", agent: "extension-smoke-worker", task: "inspect", sideEffect: "none" }] },
		}, undefined, undefined, ctx);
		assert.equal(loaded.isError, undefined, JSON.stringify(loaded));
		assert.equal(loaded.details.status, "loaded");
		assert.equal(loaded.details.graph.nodeCount, 1);
		assert.deepEqual(loaded.details.graph.topologicalOrder, ["a"]);
		const rejectedValidation = await graphTool.execute("load-invalid-validation", {
			action: "load",
			spec: {
				schemaVersion: 3,
				goal: "reject a silently ignored validation",
				nodes: [{ taskId: "read", agent: "extension-smoke-worker", task: "inspect", sideEffect: "local_read", validationCommands: ["npm test"] }],
			},
		}, undefined, undefined, ctx);
		assert.equal(rejectedValidation.isError, true);
		assert.equal(rejectedValidation.details.code, "INVALID_VALIDATION_COMMAND");
		assert.equal(rejectedValidation.details.field, "validationCommands");
		assert.equal(rejectedValidation.details.details.sideEffect, "local_read");
		const capsulePath = join(root, "typed.graph.json");
		await writeFile(capsulePath, JSON.stringify({
			manifest: { name: "typed", version: "1.0.0", description: "Typed capsule" },
			source: {
				type: "graph-spec",
				spec: {
					schemaVersion: 3,
					goal: "Process {{count}} items",
					nodes: [{ taskId: "typed", agent: "extension-smoke-worker", task: "Enabled={{enabled}}", sideEffect: "none" }],
				},
			},
			intent: "Exercise the public capsule path.",
			inputs: {
				count: { type: "number", required: true },
				enabled: { type: "boolean", required: true },
			},
			requires: { readOnly: true, toolFilter: ["read"] },
			provenance: { created: "2026-08-24T00:00:00.000Z", author: "test" },
		}));
		const capsuleLoaded = await graphTool.execute("capsule-load", {
			action: "load",
			capsule: "typed.graph.json",
			overrides: { count: 3, enabled: true },
		}, undefined, undefined, ctx);
		assert.equal(capsuleLoaded.isError, undefined);
		assert.equal(capsuleLoaded.details.graph.goal, "Process 3 items");
		assert.equal(capsuleLoaded.details.graph.nodes[0].task, "Enabled=true");
		assert.equal(capsuleLoaded.details.capsule.manifest.name, "typed");
		assert.deepEqual(capsuleLoaded.details.capsule.inputs, { count: 3, enabled: true });
		assert.deepEqual(capsuleLoaded.details.capsule.requires, { readOnly: true, toolFilter: ["read"] });
		const templates = await graphTool.execute("templates", { action: "templates" }, undefined, undefined, ctx);
		assert.equal(templates.details.templates.length, 3);
		const agents = await graphTool.execute("agents", { action: "agents" }, undefined, undefined, ctx);
		assert.deepEqual(agents.details.agents, [{ name: "extension-smoke-worker", description: "Local worker" }]);
		assert.equal(JSON.stringify(agents.details).includes("must-not-leak"), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("V3 public graph errors preserve a stable revision-conflict envelope", () => {
	const jiti = createJiti(import.meta.url);
	const { graphToolErrorResultV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		graphToolErrorResultV3(error: unknown): { content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean };
	};
	const response = graphToolErrorResultV3(new V3RevisionConflictError(3, 5));
	assert.equal(response.isError, true);
	assert.equal(response.details.code, "REVISION_CONFLICT");
	assert.equal(response.details.errorCode, "REVISION_CONFLICT");
	assert.equal(response.details.status, "conflict");
	assert.equal(response.details.expectedRevision, 3);
	assert.equal(response.details.currentRevision, 5);
	assert.deepEqual(response.details.details, { expectedRevision: 3, currentRevision: 5 });
	assert.match(response.content[0]?.text ?? "", /revision conflict/u);
});

test("graph tool schema exposes Binding hints and graph-wide Guard ceilings without internal evidence fields", () => {
	const jiti = createJiti(import.meta.url);
	const { GraphSpecV3Schema } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as { GraphSpecV3Schema: unknown };
	const schema = GraphSpecV3Schema as unknown as {
		properties: {
			readOnly?: { type?: string };
			toolFilter?: { uniqueItems?: boolean };
			nodes: {
				items: {
					properties: Record<string, { description?: string; items?: { properties?: Record<string, { enum?: string[] }> } }>;
				};
			};
		};
	};
	const node = schema.properties.nodes.items.properties;
	assert.ok(node.acceptance, "acceptance must be visible in the tool schema");
	assert.deepEqual(node.readScope?.items?.properties?.kind?.enum, ["file", "tree"]);
	assert.match(node.validationCommands?.description ?? "", /Required for local_write/);
	assert.equal((node.retryPolicy as any)?.properties?.maxAttempts?.type, "integer");
	assert.equal((node.retryPolicy as any)?.required?.includes("maxAttempts") ?? false, false);
	assert.equal("childAcceptance" in node, false, "removed childAcceptance pseudo-contract must not be exposed");
	assert.equal(node.timeoutMs, undefined);
	assert.equal(schema.properties.readOnly?.type, "boolean");
	assert.equal(schema.properties.toolFilter?.uniqueItems, true);
	assert.deepEqual((schema as any).properties.workspace.enum, ["shadow"]);
	for (const field of ["capabilityId", "requires", "model", "thinking", "turnBudget", "toolBudget", "usageBudget", "maxTokens"]) {
		assert.ok(field in node, `${field} must exist in public GraphSpec authoring`);
	}
	assert.equal((node.maxTokens as any)?.minimum, 16);
	assert.equal((node.turnBudget as any)?.properties?.maxTurns?.minimum, 1);
	assert.equal((node.toolBudget as any)?.properties?.hard?.minimum, 1);
	for (const forbidden of ["routingProfile", "maxAuthorization", "allowBash", "resourceScopes", "externalAction", "binding", "launch"]) {
		assert.equal(forbidden in node, false, `${forbidden} must not exist in the V3 node schema`);
	}
	assert.equal((schema as any).properties.maxConcurrency.maximum, 6);
});

test("Current Pi RPC loads the extension and runs the graphs doctor command", { timeout: 45_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-extension-smoke-"));
	const agentDir = join(root, "agent");
	const runsDir = join(root, "runs");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		graph: {
			enabled: true,
			runsDir,
			history: { autoCompact: false, autoPrune: false, emergencyPurge: false },
		},
	}));
	const source = await readFile(join(process.cwd(), "extensions", "pi-graph.ts"), "utf8");
	assert.match(source, /registerTool\(\{[\s\S]*?name:\s*"graph"/);

	const child = spawn(process.execPath, [
		piCliPath,
		"--mode", "rpc",
		"--offline",
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--no-extensions",
		"--extension", join(process.cwd(), "extensions", "pi-graph.ts"),
	], {
		cwd: root,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});

	const messages: Array<Record<string, unknown>> = [];
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	let buffer = "";
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const completed = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (!messages.some((message) => message.id === "doctor" && message.type === "response")) {
				reject(new Error(`Pi RPC exited before the smoke test completed (${String(code)}/${String(signal)}): ${stderr}`));
			}
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const message = JSON.parse(line) as Record<string, unknown>;
				messages.push(message);
				if (message.id === "commands" && message.type === "response") {
					const data = message.data as { commands?: Array<{ name?: string }> } | undefined;
					assert.equal(data?.commands?.some((command) => command.name === "graphs"), true);
					child.stdin.write(`${JSON.stringify({ id: "doctor", type: "prompt", message: "/graphs doctor" })}\n`);
				}
				if (message.id === "doctor" && message.type === "response") resolve();
			}
		});
	});

	try {
		child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
		await completed;
		assert.equal(messages.some((message) => message.type === "extension_ui_request" && String(message.message).includes("Graph doctor:")), true);
		assert.equal(messages.some((message) => message.type === "extension_ui_request"
			&& String(message.message).includes("Routing guidance: version=10 hash=")
			&& String(message.message).includes("observed=false enabled=true graphVisible=unknown injected=unknown")), true);
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
		await rm(root, { recursive: true, force: true });
	}
});
test("Graph wait yields for current attention without stopping tasks, ignores cached/resolved attention",async()=>{
 const { waitForGraphSnapshotV3, graphWaitResultV3 }=createJiti(import.meta.url)(new URL("../extensions/pi-graph.ts", import.meta.url).href) as any;
 const running:any={graphId:"g",status:"running",updatedAt:"2026-09-09T00:00:00Z",nodes:{t:{phase:"running",observation:{asyncId:"child",supervision:{attention:"waiting_user"}}}}};
 let disposed=0;const options={graphId:"g",readStatus:async()=>running,subscribe:()=>()=>{disposed++;}};
 const outcome=await waitForGraphSnapshotV3(options);assert.equal(outcome.reason,"attention_required");assert.equal(disposed,1);assert.equal(running.status,"running");
 const result=await graphWaitResultV3("g",outcome,"/unused");assert.equal(result.details.graphContinuesRunning,true);assert.match(result.content[0].text,/not task completion/);
 const completed={...running,status:"complete",updatedAt:"2026-09-09T00:00:01Z"};
 assert.equal((await waitForGraphSnapshotV3({...options,initialSnapshot:running,readStatus:async()=>completed})).reason,"graph_settled");
});
