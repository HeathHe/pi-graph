import { altKey } from "pi-graph-shared-settings/v1";
import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentBar } from "../src/agent-bar.ts";
import type { CockpitEndpoint } from "../src/endpoint-store.ts";
import { SessionUiState } from "../src/session-ui-state.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";
import type { AgentRow } from "../src/types.ts";

cockpitTuiLocale.setLocale("en");

/** `altKey` escaped for use inside a regular expression: `+` is a metacharacter. */
const altRe = (key: string): string => altKey(key).replaceAll("+", "\\+");

const theme: Pick<Theme, "fg" | "bold"> = {
	fg: (color, text) => `\x1b[${color === "error" ? 31 : color === "warning" ? 33 : color === "success" ? 32 : 36}m${text}\x1b[0m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

const LOCAL_OWNER = "b".repeat(32);

const row: AgentRow = {
	correlationId: "c1",
	agent: "general",
	name: "builder",
	role: "general",
	task: "build",
	status: "running",
	tail: "working",
	startedAt: 1_000,
	lastActivityAt: 9_000,
};

const endpoints: CockpitEndpoint[] = [{
	id: "root",
	logicalKey: "main",
	kind: "root",
	label: "main",
	ordinal: 0,
	status: "running",
	contentRevision: "root-r1",
	routeSelector: "root",
	source: "registry",
	registryEndpoint: {
		version: 1,
		id: "root",
		kind: "root",
		scope: "local",
		transport: "local-root",
		workspaceId: "workspace",
		ownerId: LOCAL_OWNER,
		ownerNonce: "c".repeat(32),
		status: "running",
		capabilities: [],
		ordinal: 0,
		contentRevision: "root-r1",
	},
}, {
	id: "agent",
	logicalKey: "agent:c1",
	kind: "agent",
	label: "builder",
	ordinal: 1,
	correlationId: "c1",
	status: "running",
	contentRevision: "agent-r1",
	outputRevision: "output-r1",
	routeSelector: "agent",
	source: "registry",
	agentRow: row,
}];

test("Teammate Rail renders one row with status glyphs, identities, localized state, and unread", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	state.reconcile("agent", endpoints, "root");
	const lines = renderAgentBar(endpoints, state, 120, theme as Theme, {
		mainRunning: true,
		now: 10_000,
	});
	assert.equal(lines.length, 1);
	const plain = stripAnsi(lines[0]!);
	assert.match(plain, new RegExp(`▸ ● @main·${LOCAL_OWNER.slice(0, 6)} · running`));
	assert.match(plain, /● @builder •1$/);
	// The removed right-edge status/metrics summary stays gone.
	assert.doesNotMatch(plain, /ctx|tokens|tools/);
});

test("Teammate Rail keeps the selected marker distinct from the endpoint identity color", () => {
	const sleeping = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, status: "sleeping" as const, agentRow: { ...row, status: "sleeping" as const } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", sleeping, "agent");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(sleeping, state, 120, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<accent>▸<\/accent> <muted>○<\/muted> <muted>@builder<\/muted>/);
	assert.match(line, / · sleeping/);
});

test("Agent Bar pans horizontally and keeps the selected chip visible when agents overflow", () => {
	const many: CockpitEndpoint[] = [
		endpoints[0]!,
		...Array.from({ length: 10 }, (_, index) => ({
			id: `agent${index}`,
			logicalKey: `agent:cx${index}`,
			kind: "agent" as const,
			label: `worker${index}`,
			ordinal: index + 1,
			correlationId: `cx${index}`,
			status: "running" as const,
			contentRevision: `r${index}`,
			routeSelector: `agent${index}`,
			source: "registry" as const,
		})),
	];
	const state = new SessionUiState();
	state.reconcile("agent", many, "root");
	state.select("agent7");
	const [line] = renderAgentBar(many, state, 60, theme as Theme, { now: 10_000 });
	const plain = stripAnsi(line);
	// The selection is always visible, at the right edge of the panned window.
	assert.match(plain, /▸ ● @worker7/);
	// Both sides report what stays hidden; chips far left are out of view.
	assert.match(plain, /◀\d+/);
	assert.match(plain, /2▶/);
	assert.doesNotMatch(plain, /@main/);
	assert.ok(visibleWidth(line) <= 60);
});

test("Agent Bar falls back to a highlighted chip when the selected id is stale", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	state.select("ghost");
	const plain = stripAnsi(renderAgentBar(endpoints, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /▸ [^ ]+ @main/);
});

test("Agent Bar pans so every selection stays visible and highlighted at a fixed width", () => {
	const many: CockpitEndpoint[] = [
		endpoints[0]!,
		...Array.from({ length: 10 }, (_, index) => ({
			id: `agent${index}`,
			logicalKey: `agent:cx${index}`,
			kind: "agent" as const,
			label: `worker${index}`,
			ordinal: index + 1,
			correlationId: `cx${index}`,
			status: "running" as const,
			contentRevision: `r${index}`,
			routeSelector: `agent${index}`,
			source: "registry" as const,
		})),
	];
	const state = new SessionUiState();
	state.reconcile("agent", many, "root");
	for (let index = 0; index < many.length; index++) {
		const endpoint = many[index]!;
		state.select(endpoint.id);
		const plain = stripAnsi(renderAgentBar(many, state, 60, theme as Theme, { now: 10_000 })[0]);
		const label = endpoint.kind === "root" ? "main" : endpoint.label;
		assert.match(plain, new RegExp(`▸ [^ ]+ @${label}`), `selection ${endpoint.id}`);
		// At the first chip nothing is hidden on the left; at the last, on the right.
		if (index === 0) assert.doesNotMatch(plain, /◀/, `selection ${endpoint.id}`);
		if (index === many.length - 1) assert.doesNotMatch(plain, /▶/, `selection ${endpoint.id}`);
	}
});

test("Agent Bar renders every chip without markers when content plus the reserved column fits", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	state.select("agent");
	const wide = renderAgentBar(endpoints, state, 200, theme as Theme, { now: 10_000 })[0];
	const exact = visibleWidth(wide);
	const plain = stripAnsi(renderAgentBar(endpoints, state, exact + 1, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /▸ ● @builder/);
	assert.match(plain, /@main/);
	assert.doesNotMatch(plain, /◀|▶/);
});

test("Teammate Rail is exactly one safe row at widths 1 through 120 and reserves the final column", () => {
	const many: CockpitEndpoint[] = [
		endpoints[0]!,
		...Array.from({ length: 10 }, (_, index) => ({
			id: `agent${index}`,
			logicalKey: `agent:cx${index}`,
			kind: "agent" as const,
			label: `worker${index}`,
			ordinal: index + 1,
			correlationId: `cx${index}`,
			status: "running" as const,
			contentRevision: `r${index}`,
			routeSelector: `agent${index}`,
			source: "registry" as const,
		})),
	];
	const state = new SessionUiState();
	state.reconcile("agent", many, "root");
	for (let width = 1; width <= 120; width++) {
		state.select("agent7");
		const lines = renderAgentBar(many, state, width, theme as Theme, { now: 10_000 });
		assert.equal(lines.length, 1, `width ${width}`);
		const line = lines[0]!;
		const liveWidth = Math.max(0, width - 1);
		assert.ok(visibleWidth(line) <= liveWidth, `width ${width}: ${visibleWidth(line)} > ${liveWidth}`);
	}
	assert.deepEqual(renderAgentBar(many, state, 1, theme as Theme, { now: 10_000 }), [""]);
	assert.deepEqual(renderAgentBar([], new SessionUiState(), 1, theme as Theme, { now: 10_000 }), [""]);
});

test("Agent Bar shows the concise Alt+R Agent hint only when the surface is not covered by an overlay", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	const visible = stripAnsi(renderAgentBar(endpoints, state, 80, theme as Theme, {
		now: 10_000,
		shortcutHint: `${altKey("R")} Agent`,
	})[0]);
	const hidden = stripAnsi(renderAgentBar(endpoints, state, 80, theme as Theme, { now: 10_000 })[0]);
	assert.match(visible, new RegExp(`${altRe("R")} Agent$`));
	assert.equal(visibleWidth(visible), 79, "the live bar reserves the terminal's final column");
	assert.doesNotMatch(hidden, new RegExp(`${altRe("R")}`));
});

test("Agent Bar renders the /artifact replacement hint in the requested accent color", () => {
	const state = new SessionUiState();
	state.reconcile("agent", endpoints, "root");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(endpoints, state, 100, taggedTheme as Theme, {
		now: 10_000,
		shortcutHint: { text: "/artifact", color: "accent" },
	})[0]!;
	assert.match(line, /<accent>\/artifact<\/accent>$/);
	assert.doesNotMatch(line, new RegExp(`${altRe("R")} list`));
});

test("Teammate Rail uses the live tool name as its single suffix", () => {
	const running = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, activeTool: "bash" } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", running, "root");
	const plain = stripAnsi(renderAgentBar(running, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /@builder.* · bash/);
	assert.doesNotMatch(plain, /@builder.* · bash.*running/);
	assert.match(plain, /@main·[a-f0-9]+ · idle/);
});

test("Teammate Rail never exposes tool arguments", () => {
	const running = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, activeTool: "bash", activeToolArgs: "command=git diff" } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", running, "root");
	const plain = stripAnsi(renderAgentBar(running, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /@builder.* · bash/);
	assert.doesNotMatch(plain, /command=git diff/);
});

test("Agent Bar does not show a tool suffix on a sleeping agent", () => {
	const sleeping = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, status: "sleeping" as const, agentRow: { ...row, status: "sleeping" as const, activeTool: "bash" } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", sleeping, "root");
	const plain = stripAnsi(renderAgentBar(sleeping, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.doesNotMatch(plain, /· bash/);
	assert.match(plain, /@builder.* · sleeping/);
});

test("Teammate Rail marks canonically stalled chips with an explicit error glyph and state", () => {
	const stalled = endpoints.map((endpoint) => endpoint.kind === "agent"
		? {
			...endpoint,
			agentRow: {
				...row,
				status: "running" as const,
				runtime: {
					lifecycle: "running" as const,
					health: "stalled" as const,
					activity: "running" as const,
					toolActivity: "active" as const,
					resultReady: false,
				},
			},
		}
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", stalled, "agent");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(stalled, state, 120, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<error>!<\/error> <error>@builder<\/error>.* · stalled/);
});

test("Teammate Rail renders pending, retrying, result-ready, and CLI status explicitly", () => {
	const cases: Array<{ row: AgentRow; glyph: string; state?: string }> = [
		{ row: { ...row, status: "pending" }, glyph: "○", state: "pending" },
		{ row: { ...row, status: "retrying" }, glyph: "↻" },
		{
			row: {
				...row,
				resolvedModel: "cli/agy",
				runtime: {
					lifecycle: "running",
					health: "healthy",
					activity: "running",
					toolActivity: "idle",
					resultReady: true,
				},
			},
			glyph: "✓",
			state: "result ready",
		},
	];
	for (const item of cases) {
		const projected = endpoints.map((endpoint) => endpoint.kind === "agent"
			? { ...endpoint, agentRow: item.row }
			: endpoint);
		const state = new SessionUiState();
		state.reconcile("agent", projected, "agent");
		const plain = stripAnsi(renderAgentBar(projected, state, 160, theme as Theme, { now: 10_000 })[0]);
		assert.match(plain, new RegExp(`▸ ${item.glyph} @builder`));
		if (item.state) assert.match(plain, new RegExp(`@builder.* · ${item.state}`));
		else assert.doesNotMatch(plain, /@builder.* · /);
	}
	const resultReady = cases.at(-1)!;
	const projected = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: resultReady.row }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", projected, "agent");
	assert.match(stripAnsi(renderAgentBar(projected, state, 160, theme as Theme, { now: 10_000 })[0]), /@builder ⌘ cli · result ready/);
});

test("Teammate Rail localizes the non-live state suffix", () => {
	const failed = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, status: "failed" as const } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", failed, "agent");
	cockpitTuiLocale.setLocale("zh-CN");
	try {
		assert.match(stripAnsi(renderAgentBar(failed, state, 120, theme as Theme, { now: 10_000 })[0]), /@builder · 失败/);
	} finally {
		cockpitTuiLocale.setLocale("en");
	}
});

test("Agent Bar shows the completed check on a done agent", () => {
	const done = endpoints.map((endpoint) => endpoint.kind === "agent"
		? {
			...endpoint,
			agentRow: {
				...row,
				status: "done" as const,
				lastOutcome: { status: "completed" as const, settledAt: 9_500 },
			},
		}
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", done, "agent");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(done, state, 120, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<success>✓<\/success> <muted>@builder<\/muted>.* · done/);
	assert.doesNotMatch(line, /<error>!/);
});

test("Teammate Rail shows the failed glyph and localized state without the error message", () => {
	const failed = endpoints.map((endpoint) => endpoint.kind === "agent"
		? {
			...endpoint,
			agentRow: {
				...row,
				status: "failed" as const,
				lastOutcome: {
					status: "failed" as const,
					message: "provider timeout: " + "x".repeat(80),
					settledAt: 9_500,
				},
			},
		}
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", failed, "root");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(failed, state, 200, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<error>✗<\/error> <error>@builder<\/error>.* · failed/);
	assert.doesNotMatch(line, /provider timeout|x{10}/);
});

test("Agent Bar shows the terminated cross without a reason", () => {
	const terminated = endpoints.map((endpoint) => endpoint.kind === "agent"
		? {
			...endpoint,
			agentRow: {
				...row,
				status: "terminated" as const,
				lastOutcome: { status: "terminated" as const, settledAt: 9_500 },
			},
		}
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", terminated, "agent");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(terminated, state, 120, taggedTheme as Theme, { now: 10_000 })[0];
	assert.match(line, /<warning>✗<\/warning> <muted>@builder<\/muted>.* · terminated/);
});

test("Agent Bar hides the previous turn outcome while the agent is live again", () => {
	// The store deliberately retains lastOutcome across a restart; a running
	// agent must not carry the previous turn's ✓/✗ badge.
	const restarted = endpoints.map((endpoint) => endpoint.kind === "agent"
		? {
			...endpoint,
			agentRow: {
				...row,
				status: "running" as const,
				lastOutcome: { status: "failed" as const, message: "old failure", settledAt: 9_000 },
			},
		}
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", restarted, "root");
	const taggedTheme: Pick<Theme, "fg" | "bold"> = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => text,
	};
	const line = renderAgentBar(restarted, state, 200, taggedTheme as Theme, { now: 10_000 })[0];
	assert.doesNotMatch(line, /old failure/);
	assert.doesNotMatch(line, /<error>✗/);
	assert.match(line, /@builder/);
});

test("Teammate Rail never appends selected-session tool/token metrics", () => {
	const withMetrics = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, toolCount: 3, tokens: 1_200 } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", withMetrics, "agent");
	const plain = stripAnsi(renderAgentBar(withMetrics, state, 120, theme as Theme, { now: 10_000 })[0]);
	assert.doesNotMatch(plain, /tools|工具|1\.2k/);
	assert.match(plain, /@builder/);
	assert.doesNotMatch(plain, /@builder.* · /);
});

test("Teammate Rail preserves status and active tool for a read-only external chip without detail telemetry", () => {
	const external: CockpitEndpoint = {
		id: "external",
		logicalKey: "external:ssh-gateway:remote-1",
		kind: "agent",
		label: "remote-builder",
		ordinal: 1,
		status: "running",
		contentRevision: "external-r1",
		routeSelector: "",
		source: "external",
		readOnly: true,
		externalAgent: {
			version: 1,
			source: "ssh-gateway",
			sessionId: "session",
			id: "remote-1",
			label: "remote-builder",
			status: "stalled",
			activeTool: "bash",
			activeToolArgs: "command=git status",
			metrics: { toolCount: 4, tokens: 2_500 },
			updatedAt: 1,
		},
	};
	const projected = [endpoints[0]!, external];
	const state = new SessionUiState();
	state.reconcile("agent", projected, "external");
	const plain = stripAnsi(renderAgentBar(projected, state, 160, theme as Theme, { now: 10_000 })[0]);
	assert.match(plain, /▸ ! @remote-builder · stalled/);
	assert.doesNotMatch(plain, /command=git status|tools|2\.5k/);

	const running = [{ ...external, externalAgent: { ...external.externalAgent!, status: "running" as const } }];
	state.reconcile("agent", running, "external");
	const runningPlain = stripAnsi(renderAgentBar(running, state, 160, theme as Theme, { now: 10_000 })[0]);
	assert.match(runningPlain, /@remote-builder · bash/);
	assert.doesNotMatch(runningPlain, /command=git status/);
});

test("Teammate Rail omits metrics at narrow widths while keeping the selected identity", () => {
	const withMetrics = endpoints.map((endpoint) => endpoint.kind === "agent"
		? { ...endpoint, agentRow: { ...row, toolCount: 3, tokens: 1_200 } }
		: endpoint);
	const state = new SessionUiState();
	state.reconcile("agent", withMetrics, "agent");
	// Chip-only width: metrics must yield, chips stay intact and in-bounds.
	const plain = stripAnsi(renderAgentBar(withMetrics, state, 22, theme as Theme, { now: 10_000 })[0]);
	assert.doesNotMatch(plain, /tools/);
	assert.match(plain, /@builder/);
	assert.ok(visibleWidth(renderAgentBar(withMetrics, state, 22, theme as Theme, { now: 10_000 })[0]) <= 22);
});
