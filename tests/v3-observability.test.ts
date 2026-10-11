import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import {
	createV3DispatchObservation,
	mergeV3ChildObservation,
	observeV3ChildLifecycle,
	validateV3ChildObservation,
	v3ChildObservationFingerprint,
	V3ObservationValidationError,
} from "../src/v3/observability.ts";
import { graphStatusTextV3 } from "../src/v3/host.ts";
import { validateGraphSnapshotV3 } from "../src/v3/snapshot.ts";

test("V3 child lifecycle projection separates requested/resolved model from actual runtime model", () => {
	const dispatch = createV3DispatchObservation({
		asyncId: "child-1",
		requestedAgent: "review.code",
		resolvedAgent: "code-reviewer",
		requestedModel: "preferred/model",
		resolvedModel: "resolved/model",
		thinking: "high",
		observedAt: "2026-08-24T00:00:00.000Z",
	});
	const runtime = observeV3ChildLifecycle({
		asyncId: "child-1",
		status: {
			runId: "outer-async-run",
			state: "complete",
			startedAt: 1_000,
			endedAt: 3_500,
			lastUpdate: Date.parse("2026-08-24T00:00:02.500Z"),
			steps: [{
				runId: "runtime-child-run",
				agent: "code-reviewer",
				model: "provider/actual-model",
				thinking: "xhigh",
				currentTool: "bash\u001b[31m\nignored",
				currentPath: "src/review.ts",
				turnCount: 4,
				toolCount: 6,
			}],
			totalTokens: { input: 120, output: 30, total: 150 },
			totalCost: { inputTokens: 120, outputTokens: 30, costUsd: 0.0125 },
			sessionFile: "/tmp/session.jsonl",
			launchContractDigest: "a".repeat(64),
		},
	});
	const merged = mergeV3ChildObservation(dispatch, runtime);
	assert.equal(merged.requestedModel, "preferred/model");
	assert.equal(merged.resolvedModel, "resolved/model");
	assert.equal(merged.actualModel, "provider/actual-model");
	assert.equal(merged.actualAgent, "code-reviewer");
	assert.equal(merged.asyncId, "child-1");
	assert.equal(merged.runId, "runtime-child-run");
	assert.equal(merged.thinking, "xhigh");
	assert.equal(merged.usage?.totalTokens, 150);
	assert.equal(merged.usage?.turns, 4);
	assert.equal(merged.usage?.costUsd, 0.0125);
	assert.equal(merged.durationMs, 2_500);
	assert.equal(merged.progress?.currentTool, "bash ignored");
	assert.equal(merged.progress?.currentPath, "src/review.ts");
	assert.equal(merged.progress?.toolCount, 6);
	assert.equal(merged.sessionFile, "/tmp/session.jsonl");
	assert.equal(merged.launchContractDigest, "a".repeat(64));
});

test("V3 child lifecycle projection prefers completion evidence and bounds attempted models", () => {
	const observation = observeV3ChildLifecycle({
		asyncId: "child-2",
		status: {
			runId: "child-2",
			state: "complete",
			steps: [{ agent: "worker", model: "status/model", attemptedModels: Array.from({ length: 40 }, (_, index) => `model-${index}`) }],
		},
		completion: {
			runId: "child-2",
			results: [{ agent: "worker", model: "completion/model", sessionFile: "/tmp/final.jsonl" }],
		},
		now: Date.parse("2026-08-24T00:00:00.000Z"),
	});
	assert.equal(observation.actualModel, "completion/model");
	assert.equal(observation.sessionFile, "/tmp/final.jsonl");
	assert.equal(observation.attemptedModels?.length, 16);
	assert.deepEqual(validateV3ChildObservation(observation), observation);
	assert.throws(
		() => validateV3ChildObservation({ ...observation, prompt: "must never persist" }),
		V3ObservationValidationError,
	);
});

test("V3 snapshot accepts bounded display context without making it graph authority", () => {
	const observation = createV3DispatchObservation({
		asyncId: "child-3",
		resolvedAgent: "worker",
		observedAt: "2026-08-24T00:00:00.000Z",
	});
	assert.equal(observation.runId, undefined, "dispatch evidence must not present the outer async workflow id as a child run id");
	const snapshot = validateGraphSnapshotV3({
		schemaVersion: 3,
		runInstanceId: "run-1",
		graphId: "graph-1",
		graphDigest: "a".repeat(64),
		sourceGraphSpecDigest: "b".repeat(64),
		status: "running",
		sessionId: "session-1",
		supervisorEpoch: "epoch-1",
		createdAt: "2026-08-24T00:00:00.000Z",
		updatedAt: "2026-08-24T00:00:01.000Z",
		nodes: { work: { phase: "running", attempt: 1, agent: "worker", dependsOn: ["prepare"], observation } },
	});
	assert.deepEqual(snapshot.nodes?.work.observation, observation);
	assert.equal(snapshot.nodes?.work.agent, "worker");
	assert.deepEqual(snapshot.nodes?.work.dependsOn, ["prepare"]);
});

test("V3 observation fingerprint preserves activity evidence but ignores the sample timestamp", () => {
	const first = {
		...createV3DispatchObservation({
			asyncId: "fingerprint-child",
			resolvedAgent: "worker",
			observedAt: "2026-08-24T00:00:00.000Z",
		}),
		progress: { state: "running" as const, lastActivityAt: "2026-08-24T00:00:00.000Z" },
	};
	assert.equal(v3ChildObservationFingerprint(first), v3ChildObservationFingerprint({
		...first,
		observedAt: "2026-08-24T00:00:01.000Z",
	}), "sampling time alone must remain a lifecycle no-op");
	assert.notEqual(v3ChildObservationFingerprint(first), v3ChildObservationFingerprint({
		...first,
		progress: { ...first.progress, lastActivityAt: "2026-08-24T00:00:01.000Z" },
		observedAt: "2026-08-24T00:00:01.000Z",
	}), "lastActivityAt remains durable observation evidence; only the UI filters it");
});

test("Pi graph panel separates requested, resolved, and actual identities and exposes runtime metrics", async () => {
	const jiti = createJiti(import.meta.url);
	const { graphToolPanelTextV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		graphToolPanelTextV3(snapshot: unknown, expanded: boolean): string;
	};
	const snapshot = {
		schemaVersion: 3,
		runInstanceId: "run-visible",
		graphId: "visible",
		graphDigest: "a".repeat(64),
		sourceGraphSpecDigest: "b".repeat(64),
		status: "running",
		sessionId: "session-visible",
		supervisorEpoch: "epoch-visible",
		createdAt: "2026-08-24T00:00:00.000Z",
		updatedAt: "2026-08-24T00:00:01.000Z",
		revision: 2,
		sealed: false,
		nodes: {
			review: {
				phase: "running",
				attempt: 1,
				agent: "code-reviewer",
				dependsOn: ["implement"],
				observation: {
					asyncId: "outer-visible",
					runId: "child-visible",
					requestedAgent: "requested-reviewer",
					resolvedAgent: "code-reviewer",
					actualAgent: "runtime-reviewer",
					requestedModel: "provider/requested",
					resolvedModel: "provider/resolved",
					actualModel: "provider/actual",
					usage: { totalTokens: 321, costUsd: 0.0125, turns: 3 },
					progress: { currentTool: "read", currentPath: "src/very/long/review.ts", turnCount: 4, toolCount: 6 },
					durationMs: 2_500,
					sessionFile: "/tmp/child-visible.jsonl",
					observedAt: "2026-08-24T00:00:00.000Z",
				},
			},
		},
	};
	const compact = graphToolPanelTextV3(snapshot, false);
	assert.equal(compact.split("\n").length, 2, "collapsed tool cards are receipts, not duplicate task panels");
	assert.match(compact, /运行中 · 运行 1/);
	assert.match(compact, /\/graphs view visible/);
	assert.equal(compact.includes("runtime-reviewer"), false);

	const expanded = graphToolPanelTextV3(snapshot, true);
	for (const expected of [
		"r2 open", "requested agent requested-reviewer", "resolved agent code-reviewer", "actual agent runtime-reviewer",
		"requested model provider/requested", "resolved model provider/resolved", "actual model provider/actual",
		"path src/very/long/review.ts", "duration 2.5s", "run child-visible", "async outer-visible", "session child-visible.jsonl",
	]) assert.ok(expanded.includes(expected), expected);

	const status = await graphStatusTextV3(snapshot as never, "/tmp/runs");
	for (const expected of [
		"requested agent requested-reviewer", "resolved agent code-reviewer", "actual agent runtime-reviewer",
		"requested model provider/requested", "resolved model provider/resolved", "actual model provider/actual",
		"cost $0.01", "4 turns", "6 tools", "child run child-visible", "async outer-visible", "path src/very/long/review.ts",
	]) assert.ok(status.includes(expected), expected);
});

test("Pi graph lifecycle headers make graph use and progress unmistakable", () => {
	const jiti = createJiti(import.meta.url);
	const { graphCallTextV3, graphNativeStatusTextV3, graphToolPanelTextV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		graphCallTextV3(params: unknown): string;
		graphNativeStatusTextV3(snapshot: unknown, activeGraphCount?: number): string;
		graphToolPanelTextV3(snapshot: unknown, expanded: boolean): string;
	};
	const base = {
		graphId: "visible-lifecycle",
		status: "running",
		nodes: {
			done: { phase: "accepted", terminalStatus: "accepted", attempt: 1 },
			active: { phase: "running", attempt: 1 },
			queued: { phase: "queued", attempt: 0 },
		},
	};
	const running = graphToolPanelTextV3(base, false).split("\n")[0]!;
	assert.equal(running, "回执 · 运行中 · 成功 1 · 运行 1 · 排队 1");
	assert.equal(graphNativeStatusTextV3(base), "◆ Graph");
	assert.equal(graphNativeStatusTextV3(base, 2), "◆ 2 个 Graph");
	assert.equal(graphCallTextV3({ action: "start", spec: { graphId: "visible-lifecycle", nodes: [{}, {}] } }), "◆ PI-GRAPH START · visible-lifecycle · 2 nodes");

	const cases = [
		["queued", "○ PI-GRAPH QUEUED"],
		["idle", "◇ PI-GRAPH OPEN-IDLE"],
		["stopping", "▶ PI-GRAPH STOPPING"],
		["complete", "✓ PI-GRAPH COMPLETE"],
		["failed", "✕ PI-GRAPH FAILED"],
		["stopped", "■ PI-GRAPH STOPPED"],
		["paused", "Ⅱ PI-GRAPH PAUSED"],
		["waiting_input", "? PI-GRAPH WAITING_INPUT"],
		["needs_attention", "! PI-GRAPH NEEDS_ATTENTION"],
	] as const;
	for (const [status, expected] of cases) {
		const header = graphToolPanelTextV3({ ...base, status }, true).split("\n")[0]!;
		assert.ok(header.startsWith(expected), `${status}: ${header}`);
	}
	const openIdle = graphToolPanelTextV3({ ...base, status: "idle", topology: "open", revision: 3, sealed: false }, true).split("\n")[0]!;
	assert.match(openIdle, /^◇ PI-GRAPH OPEN-IDLE/u);
	assert.equal(openIdle.includes("COMPLETE"), false);
});

test("Pi graph TUI component truncates ANSI and wide-character lines to the requested visible width", () => {
	const jiti = createJiti(import.meta.url);
	const { GraphTextComponent, graphVisibleWidthV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		GraphTextComponent: new (text: string) => { render(width: number): string[] };
		graphVisibleWidthV3(value: string): number;
	};
	const component = new GraphTextComponent("\u001b[31mGraph 图表 🧭 with a very long runtime path\u001b[39m\nshort");
	const lines = component.render(18);
	assert.equal(lines.length, 2);
	for (const line of lines) assert.ok(graphVisibleWidthV3(line) <= 18, `${graphVisibleWidthV3(line)}: ${line}`);
	assert.match(lines[0]!, /…/u);
	assert.equal(lines[1], "short");
});

test("Pi graph live widget registers a width-aware component factory", () => {
	const jiti = createJiti(import.meta.url);
	const { graphVisibleWidthV3, setGraphLiveWidgetV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		graphVisibleWidthV3(value: string): number;
		setGraphLiveWidgetV3(ui: unknown, display: unknown[]): void;
	};
	let content: unknown;
	setGraphLiveWidgetV3({
		setWidget(key: string, next: unknown) {
			assert.equal(key, "pi-graph");
			content = next;
		},
	}, [{
		graphId: "图表-with-a-very-long-name",
		status: "running",
		nodes: {
			work: {
				phase: "running",
				attempt: 1,
				agent: "worker-with-a-very-long-name",
				observation: {
					asyncId: "outer-widget",
					resolvedAgent: "worker-with-a-very-long-name",
					progress: { currentPath: "src/非常长的路径/widget.ts" },
					observedAt: "2026-08-24T00:00:00.000Z",
				},
			},
		},
	}]);
	assert.equal(typeof content, "function", "live widget must not bypass width-aware component rendering with string[]");
	const component = (content as () => { render(width: number): string[] })();
	for (const line of component.render(24)) {
		assert.ok(graphVisibleWidthV3(line) <= 24, `${graphVisibleWidthV3(line)}: ${line}`);
	}
});

test("Pi graph native UI skips timestamp-only redraws and retries failed commits", () => {
	const jiti = createJiti(import.meta.url);
	const { graphLiveWidgetTextV3, shouldPublishGraphWaitUpdateV3, V3GraphNativeUiCommitter } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as any;
	const base = {
		schemaVersion: 3,
		runInstanceId: "native-ui-run",
		graphId: "native-ui",
		graphDigest: "a".repeat(64),
		sourceGraphSpecDigest: "b".repeat(64),
		status: "running",
		sessionId: "native-ui-session",
		supervisorEpoch: "native-ui-epoch",
		createdAt: "2026-08-24T00:00:00.000Z",
		updatedAt: "2026-08-24T00:00:01.000Z",
		nodes: {
			work: {
				phase: "running",
				attempt: 1,
				observation: {
					asyncId: "native-ui-child",
					progress: { state: "running", lastActivityAt: "2026-08-24T00:00:01.000Z" },
					observedAt: "2026-08-24T00:00:01.000Z",
				},
			},
		},
	};
	const timestampOnly = {
		...base,
		updatedAt: "2026-08-24T00:00:02.000Z",
		nodes: {
			work: {
				...base.nodes.work,
				observation: {
					...base.nodes.work.observation,
					progress: { state: "running", lastActivityAt: "2026-08-24T00:00:02.000Z" },
					observedAt: "2026-08-24T00:00:02.000Z",
				},
			},
		},
	};
	const initialWidgetText = graphLiveWidgetTextV3([base]);
	assert.equal(graphLiveWidgetTextV3([timestampOnly]), initialWidgetText);
	assert.equal(shouldPublishGraphWaitUpdateV3("tui", initialWidgetText, graphLiveWidgetTextV3([timestampOnly])), false);
	assert.equal(shouldPublishGraphWaitUpdateV3("rpc", initialWidgetText, graphLiveWidgetTextV3([timestampOnly])), true, "RPC retains full snapshot updates");

	let statusCalls = 0;
	let widgetCalls = 0;
	const ui = {
		setStatus() { statusCalls += 1; },
		setWidget() { widgetCalls += 1; },
	};
	const committer = new V3GraphNativeUiCommitter();
	committer.commit(ui, "running", [base]);
	committer.commit(ui, "running", [timestampOnly]);
	assert.equal(statusCalls, 1, "unchanged footer status must not be recommitted");
	assert.equal(widgetCalls, 1, "timestamp-only snapshots must not rebuild the shared widget container");
	committer.commit({ ...ui }, "running", [timestampOnly]);
	assert.equal(statusCalls, 1, "a facade with a new object identity must not reset the session-local status cache");
	assert.equal(widgetCalls, 1, "a facade with a new object identity must not restore per-snapshot widget rebuilds");

	const visibleUpdate = {
		...timestampOnly,
		updatedAt: "2026-08-24T00:00:03.000Z",
		nodes: {
			work: {
				...timestampOnly.nodes.work,
				observation: {
					...timestampOnly.nodes.work.observation,
					progress: { ...timestampOnly.nodes.work.observation.progress, currentTool: "read" },
				},
			},
		},
	};
	committer.commit(ui, "running", [visibleUpdate]);
	assert.equal(statusCalls, 1);
	assert.equal(widgetCalls, 2, "owned current-tool facts refresh the Graph summary without changing footer status");
 const countOnly = structuredClone(visibleUpdate);
 (countOnly.nodes.work.observation.progress as any).toolCount = 99;
 committer.commit(ui, "running", [countOnly]);
 assert.equal(widgetCalls, 2, "count-only observations remain hidden and must not rebuild the compact widget");
 const queuedUpdate = { ...visibleUpdate, nodes: { ...visibleUpdate.nodes, later: {phase:"queued",attempt:0,dependsOn:["work"]} } };
 committer.commit(ui, "running", [queuedUpdate]);
 assert.equal(widgetCalls, 3, "visible queue count and dependency reason must refresh the summary");

	const complete = {
		...visibleUpdate,
		status: "complete",
		updatedAt: "2026-08-24T00:00:04.000Z",
		nodes: { work: { phase: "accepted", terminalStatus: "accepted", attempt: 1 } },
	};
	committer.commit(ui, "complete", [complete]);
	assert.equal(statusCalls, 2, "a visible footer change must still be committed");
	assert.equal(widgetCalls, 4, "a terminal graph must replace the RUNNING widget text");

	let widgetAttempts = 0;
	const retryCommitter = new V3GraphNativeUiCommitter();
	const retryUi = {
		setStatus() {},
		setWidget() {
			widgetAttempts += 1;
			if (widgetAttempts === 1) throw new Error("transient renderer failure");
		},
	};
	retryCommitter.commit(retryUi, "running", [base]);
	retryCommitter.commit(retryUi, "running", [base]);
	assert.equal(widgetAttempts, 2, "a failed UI commit must not poison the equality cache");

	let statusAttempts = 0;
	const retryStatusCommitter = new V3GraphNativeUiCommitter();
	const retryStatusUi = {
		setStatus() {
			statusAttempts += 1;
			if (statusAttempts === 1) throw new Error("transient status failure");
		},
		setWidget() {},
	};
	retryStatusCommitter.commit(retryStatusUi, "running", [base]);
	retryStatusCommitter.commit(retryStatusUi, "running", [base]);
	assert.equal(statusAttempts, 2, "a failed status commit must be retried independently");
	retryStatusCommitter.reset();
	retryStatusCommitter.commit(retryStatusUi, "running", [base]);
	assert.equal(statusAttempts, 3, "a new session must recommit its native UI after reset");
});

test("Pi graph background-work wakes only when active membership can change", () => {
	const jiti = createJiti(import.meta.url);
	const { V3GraphBackgroundWorkWakeProjection } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as any;
	const projection = new V3GraphBackgroundWorkWakeProjection();
	const a = { id: "wake-graph-a", sessionId: "wake-session" };
	const b = { id: "wake-graph-b", sessionId: "wake-session" };
	assert.equal(projection.shouldWake([]), false, "an initially empty provider has no membership change to announce");
	assert.equal(projection.shouldWake([a]), true, "adding active work wakes bg_wait");
	assert.equal(projection.shouldWake([a]), false, "repeated snapshots of the same inventory stay quiet");
	assert.equal(projection.shouldWake([a, b]), true, "adding another graph changes membership");
	assert.equal(projection.shouldWake([b, a]), false, "host Map order cannot create a false wake");
	assert.equal(projection.shouldWake([]), true, "removing settled work wakes bg_wait after Host deletion");
	projection.clear();
	assert.equal(projection.shouldWake([a]), true, "a new Pi session gets a fresh membership announcement");
});

test("compact DAG summary shows active task and queue count without repeating node rows", () => {
	const jiti = createJiti(import.meta.url);
	const { graphLiveWidgetTextV3 } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		graphLiveWidgetTextV3(snapshots: unknown[]): string;
	};
	const nodes: Record<string, unknown> = {};
	for (let index = 0; index < 7; index += 1) {
		nodes[`queued-${index}`] = { phase: "queued", attempt: 0, agent: "worker" };
	}
	nodes.active = {
		phase: "running",
		attempt: 1,
		agent: "worker",
		observation: {
			asyncId: "active-async",
			runId: "active-child-run",
			actualModel: "provider/active",
			sessionFile: "/tmp/active-child.jsonl",
			observedAt: "2026-08-25T00:00:00.000Z",
		},
	};
	const compact = graphLiveWidgetTextV3([{ graphId: "priority", status: "running", nodes }]);
	assert.doesNotMatch(compact, /正在执行 active/u);
	assert.match(compact, /当前：worker/u);
 assert.match(compact, /provider\/active/u);
 assert.equal((compact.match(/当前：worker/g) ?? []).length, 1, "one owned row without duplicated task identity");
	assert.match(compact, /排队 7/u);
	assert.doesNotMatch(compact, /排队 queued-0/u);
	assert.ok(compact.split("\n").length <= 6);
	assert.equal(compact.includes("active-child.jsonl"), false);
	assert.equal(compact.includes("queued-6"), false);
});


test("native start/end samples clear current activity while retaining separately completed tool evidence", async () => {
 const jiti = createJiti(import.meta.url);
 const {nodeActivityLines} = await jiti.import<any>("../src/v3/ui/presentation.ts");
 const read = (step: Record<string,unknown>) => observeV3ChildLifecycle({asyncId:"activity-child",now:3000,status:{state:"running",steps:[{status:"running",model:"fixture/runtime",toolCount:1,...step}]}});
 const started = read({currentTool:"read",currentPath:"/fixture/file",lastActivityAt:1000});
 assert.match(nodeActivityLines({phase:"running",observation:started},3000).join("\n"),/当前工具\s+read/);
 const completed = read({recentTools:[{tool:"read",endMs:2000,args:{secret:"MUST_NOT_PERSIST"}}],lastActivityAt:2000});
 assert.equal(completed.progress?.currentTool,undefined);
 const merged=mergeV3ChildObservation(started,completed,{replaceCurrentActivity:true});
 assert.equal(merged.progress?.currentTool,undefined);assert.equal(merged.progress?.currentPath,undefined);
 assert.equal(merged.progress?.lastTool,"read");assert.equal(merged.progress?.lastToolAt,"1970-01-01T00:00:02.000Z");
 assert.equal(merged.actualModel,"fixture/runtime");assert.equal(merged.progress?.toolCount,1);
 assert.deepEqual(validateV3ChildObservation(merged),merged);
 const rendered=nodeActivityLines({phase:"running",observation:merged},3000).join("\n");
 assert.match(rendered,/最近完成工具\s+read/);assert.match(rendered,/本次状态未报告正在执行的工具/);
 assert.doesNotMatch(rendered,/当前工具\s+read|当前路径|MUST_NOT_PERSIST/);
 const next=mergeV3ChildObservation(merged,read({currentTool:"bash"}),{replaceCurrentActivity:true});
 assert.equal(next.progress?.currentTool,"bash");assert.equal(next.progress?.lastTool,"read");
 assert.equal(next.progress?.currentPath,undefined);
 assert.doesNotMatch(JSON.stringify(next),/args|secret|MUST_NOT_PERSIST/);
});

test("complete sampling is opt-in and identity-only updates preserve existing current activity",()=>{
 const base=observeV3ChildLifecycle({asyncId:"partial",status:{state:"running",currentTool:"bash",currentPath:"/fixture",model:"fixture/model",toolCount:0,totalTokens:{input:4}}});
 const identity={asyncId:"partial",observedAt:base.observedAt};
 assert.deepEqual(mergeV3ChildObservation(base,identity,{replaceCurrentActivity:true}).progress,base.progress);
 assert.deepEqual(mergeV3ChildObservation(base,{...identity,progress:{state:"running"}}).progress,base.progress);
 const full=mergeV3ChildObservation(base,{...identity,progress:{state:"running"}},{replaceCurrentActivity:true});
 assert.equal(full.progress?.currentTool,undefined);assert.equal(full.progress?.currentPath,undefined);
 assert.equal(full.progress?.toolCount,0);assert.deepEqual(full.usage,base.usage);assert.equal(full.actualModel,base.actualModel);
});

test("completed-tool adapter ignores malformed records and never reads tool arguments",()=>{
 const row={tool:"bash",endMs:2000,get args(){throw Error("arguments must never be read");}};
 const observation=observeV3ChildLifecycle({asyncId:"last-tool",status:{state:"running",steps:[{recentTools:[
 {tool:"old",endMs:1000},row,{tool:"out-of-order",endMs:1500},
 {tool:"future-invalid",endMs:Infinity},{tool:"date-string",endMs:"2026-01-01"},
 {tool:"negative",endMs:-1},{tool:"fraction",endMs:2001.5},{tool:"range",endMs:8640000000000001},
 {tool:"x".repeat(129),endMs:3000},{tool:123,endMs:3001},{tool:"  ",endMs:4000},null
 ]}]}});
 assert.equal(observation.progress?.lastTool,"bash");assert.equal(observation.progress?.lastToolAt,"1970-01-01T00:00:02.000Z");
 assert.equal(observation.progress?.currentTool,undefined);assert.equal(observation.progress?.currentPath,undefined);
 assert.deepEqual(validateV3ChildObservation(observation),observation);
 for(const progress of [{lastTool:"x"},{lastToolAt:"1970-01-01T00:00:02.000Z"},{lastTool:"x",lastToolAt:"invalid"},{lastTool:"x",lastToolAt:"2026-01-01"},{lastTool:"x".repeat(129),lastToolAt:"1970-01-01T00:00:02.000Z"},{lastTool:"x\x1b[2J",lastToolAt:"1970-01-01T00:00:02.000Z"}]) {
  assert.throws(()=>validateV3ChildObservation({...observation,progress}),V3ObservationValidationError);
 }
 const legacy={asyncId:"old",observedAt:"1970-01-01T00:00:02.000Z",progress:{toolCount:0}};
 assert.deepEqual(validateV3ChildObservation(legacy),legacy);
});
