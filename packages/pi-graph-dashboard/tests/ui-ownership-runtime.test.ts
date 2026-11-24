/**
 * Runtime ownership contract: the real Cockpit / Teammate / Flow extension
 * entries are loaded into one fake host and driven through a session, so the
 * handshake is *executed* instead of asserted against source text.
 *
 * Why this exists: the ghosting defect was a cross-extension ownership race
 * (both extensions mounted the same surface) plus widget churn (a re-created
 * widget factory on every update). Source-pattern tests stayed green through
 * both, so the contract is pinned here at the event/widget level.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as sdk from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

type Handler = (...args: any[]) => any;

/** Session identity the fake host binds; ownership projections must match it. */
const SESSION_ID = "ownership-test-session";
const LEGACY_PROJECTION = {
	workspaceId: "ws-test",
	sessionId: SESSION_ID,
	sourceId: "src-test",
	generation: Number.MAX_SAFE_INTEGER,
};

interface WidgetWrite {
	key: string;
	mounted: boolean;
	placement?: string;
	caller: string;
	factory?: any;
}

interface FooterWrite {
	active: boolean;
	caller: string;
}

interface OwnershipBoundary {
	agents: boolean | undefined;
	before: string[];
	after: string[];
}

interface Host {
	pi: any;
	ctx: any;
	fire(name: string): Promise<void>;
	shortcuts: Map<string, any>;
	tools: Map<string, any>;
	widgets: WidgetWrite[];
	footers: FooterWrite[];
	emitted: string[];
	ownershipBoundaries: OwnershipBoundary[];
	cleanup(): Promise<void>;
}

/** A cockpit config that makes Cockpit the single owner of every surface. */
function writeCockpitConfig(): string {
	const dir = mkdtempSync(join(tmpdir(), "cockpit-ownership-"));
	writeFileSync(join(dir, "cockpit.json"), JSON.stringify({
		version: 1,
		enabled: true,
		// hideNativeAgents intentionally omitted: the default enabled claim must
		// still hand the native roster to Cockpit.
		sidebar: { mode: "off" },
	}, null, 2));
	return dir;
}

/** Stack frame of the extension code that issued a UI call (skips harness frames). */
function callerFrame(): string {
	for (const frame of (new Error().stack ?? "").split("\n").slice(1)) {
		if (frame.includes("ui-ownership-runtime.test.ts")) continue;
		const match = /packages[\\/](pi-[^\\/]+)[\\/](.+?):(\d+):\d+/.exec(frame);
		if (!match) continue;
		return `${match[1]}/${match[2]}:${match[3]}`.replaceAll("\\", "/");
	}
	return "unknown";
}

async function bootHost(order: readonly string[], teammateRuntimeOptions: Record<string, unknown> = {}): Promise<Host> {
	const agentDir = writeCockpitConfig();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousRuntimeV2Read = process.env.PI_RUNTIME_V2_READ;
	const previousTeammateChild = process.env.PI_TEAMMATE_CHILD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// The fixture represents a root interactive host, even when the test runner
	// was launched by a teammate process.
	delete process.env.PI_TEAMMATE_CHILD;
	// This suite exercises the V1 ownership bus, not broker projection takeover.
	process.env.PI_RUNTIME_V2_READ = "0";

	const widgets: WidgetWrite[] = [];
	const footers: FooterWrite[] = [];
	const emitted: string[] = [];
	const ownershipBoundaries: OwnershipBoundary[] = [];
	const activeWidgets = new Set<string>();
	const activeWidgetSnapshot = (): string[] => [...activeWidgets].sort();
	const bus = new Map<string, Set<Handler>>();
	const lifecycle = new Map<string, Set<Handler>>();
	const shortcuts = new Map<string, any>();
	// Model the public 0.99 host registry rather than Proxy no-op capabilities.
	// Native Cockpit decoration reads settings and ToolInfo after session binding.
	const tools = new Map<string, any>([
		sdk.createReadToolDefinition(process.cwd()), sdk.createBashToolDefinition(process.cwd()),
		sdk.createEditToolDefinition(process.cwd()), sdk.createWriteToolDefinition(process.cwd()),
		sdk.createGrepToolDefinition(process.cwd()), sdk.createFindToolDefinition(process.cwd()),
		sdk.createLsToolDefinition(process.cwd()), sdk.createPowerShellToolDefinition(process.cwd()),
	].map((tool) => [tool.name, tool]));
	const sources = new Map([...tools.keys()].map((name) => [name, "builtin"]));
	let activeTools = ["read", "bash", "edit", "write"];
	let bound = false;
	let shutdown = false;

	const piBase: any = {
		registerFlag() {},
		getSettings() { assert.ok(bound, "native settings are post-bind only"); return {}; },
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		registerTool(tool: any) {
			if (typeof tool?.name === "string") {
				tools.set(tool.name, tool);
				sources.set(tool.name, "extension");
			}
			return () => { if (tools.get(tool?.name) === tool) tools.delete(tool.name); };
		},
		registerCommand: () => () => {},
		registerShortcut: (key: string, config: any) => { shortcuts.set(key, config); },
		registerMessageRenderer: () => () => {},
		registerProvider() {},
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		getAllTools() {
			assert.ok(bound, "native ownership metadata is post-bind only");
			return [...tools.values()].map((tool) => ({
				...tool, exposure: tool.exposure ?? "direct", sourceInfo: { source: sources.get(tool.name) },
			}));
		},
		getThinkingLevel: () => "off",
		log() {}, warn() {}, error() {},
		events: {
			on(name: string, handler: Handler) {
				const set = bus.get(name) ?? new Set<Handler>();
				set.add(handler);
				bus.set(name, set);
				return () => set.delete(handler);
			},
			emit(name: string, payload: unknown) {
				emitted.push(name);
				const boundary = name === "cockpit:ui-ownership"
					? {
						agents: payload && typeof payload === "object"
							&& typeof (payload as { agents?: unknown }).agents === "boolean"
							? (payload as { agents: boolean }).agents
							: undefined,
						before: activeWidgetSnapshot(),
						after: [] as string[],
					}
					: undefined;
				for (const handler of [...(bus.get(name) ?? [])]) {
					try { handler(payload); } catch { /* extension listeners are best-effort */ }
				}
				if (boundary) {
					boundary.after = activeWidgetSnapshot();
					ownershipBoundaries.push(boundary);
				}
			},
			off(name: string, handler: Handler) { bus.get(name)?.delete(handler); },
		},
		on(name: string, handler: Handler) {
			const set = lifecycle.get(name) ?? new Set<Handler>();
			set.add(handler);
			lifecycle.set(name, set);
			return () => set.delete(handler);
		},
	};
	const pi: any = new Proxy(piBase, {
		get: (target: any, prop: string) => (prop in target ? target[prop] : () => undefined),
	});

	const theme: any = new Proxy({}, { get: () => (...args: any[]) => String(args[args.length - 1] ?? "") });
	const ui: any = new Proxy({
		setWidget(key: string, content: unknown, options?: any) {
			if (content === undefined) activeWidgets.delete(key);
			else activeWidgets.add(key);
			widgets.push({
				key,
				mounted: content !== undefined,
				placement: options?.placement,
				caller: callerFrame(),
				...(typeof content === "function" ? { factory: content } : {}),
			});
		},
		setFooter(factory?: unknown) {
			footers.push({ active: factory !== undefined, caller: callerFrame() });
		},
		setStatus() {}, setTitle() {}, setTheme() {}, getTheme: () => theme, getAllThemes: () => [],
		setHiddenThinkingLabel() {}, setEditorText() {}, getEditorText: () => "",
		getEditorComponent: () => undefined, setEditorComponent() {}, setWorkingIndicator() {}, setWorkingMessage() {},
		onTerminalInput: () => () => {}, addAutocompleteProvider: () => () => {}, notify() {},
		select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
	}, { get: (target: any, prop: string) => (prop in target ? target[prop] : () => undefined) });

	const ctx: any = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		ui,
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false }),
		},
		getContextUsage: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => false,
		getConfig: () => ({}),
		getCwd: () => process.cwd(),
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionName: () => undefined,
			getSessionFile: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
			getMessages: () => [],
			getCwd: () => process.cwd(),
		},
	};

	const teammateEntry = (await import(
		new URL("../../pi-graph-agent-runtime/src/extension/index.ts", import.meta.url).href
	)).default;
	const entries: Record<string, (pi: any) => void> = {
		cockpit: (await import("../src/index.ts")).default,
		teammate: (hostPi) => teammateEntry(hostPi, teammateRuntimeOptions),
		flow: (await import(new URL("../../pi-graph/src/extension/index.ts", import.meta.url).href)).default,
	};
	for (const name of order) {
		const entry = entries[name];
		assert.ok(entry, `unknown extension ${name}`);
		entry(pi);
	}

	const fire = async (name: string): Promise<void> => {
		if (name === "session_start") { bound = true; shutdown = false; }
		if (name === "session_shutdown") {
			if (shutdown) return;
			shutdown = true;
		}
		const pending: Promise<unknown>[] = [];
		for (const handler of [...(lifecycle.get(name) ?? [])]) {
			try {
				pending.push(Promise.resolve(handler({ type: name }, ctx)));
			} catch (error) { pending.push(Promise.reject(error)); }
		}
		const results = await Promise.allSettled(pending);
		const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
		assert.deepEqual(errors, [], `${name} handlers must complete: ${errors.map(String).join("; ")}`);
	};

	return {
		pi, ctx, fire, shortcuts, tools, widgets, footers, emitted, ownershipBoundaries,
		async cleanup() {
			// Assertion failures must not bypass the real extensions' shutdown:
			// Flow timers and a running Teammate child otherwise keep Node alive.
			try { await fire("session_shutdown"); }
			finally {
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				if (previousRuntimeV2Read === undefined) delete process.env.PI_RUNTIME_V2_READ;
				else process.env.PI_RUNTIME_V2_READ = previousRuntimeV2Read;
				if (previousTeammateChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
				else process.env.PI_TEAMMATE_CHILD = previousTeammateChild;
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
	};
}

const settle = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms));

function createRunningChild(): any {
	const child: any = new EventEmitter();
	const stdout = new PassThrough();
	Object.assign(child, {
		stdin: new PassThrough(),
		stdout,
		stderr: new PassThrough(),
		connected: false,
		exitCode: null,
		signalCode: null,
		pid: undefined,
		kill() {
			if (child.exitCode !== null) return true;
			child.exitCode = 0;
			queueMicrotask(() => child.emit("close", 0, null));
			return true;
		},
	});
	return child;
}

/** Render the currently mounted widget for `key` through its real factory. */
function renderSurface(host: Host, key: string, width = 100): string[] {
	const write = [...host.widgets].reverse().find((entry) => entry.key === key && entry.mounted && entry.factory);
	assert.ok(write, `${key} is mounted with a factory`);
	const theme: any = new Proxy({}, { get: () => (...args: any[]) => String(args[args.length - 1] ?? "") });
	const tui: any = {
		terminal: { columns: width, rows: 40 },
		requestRender() {},
		invalidate() {},
		setTitle() {},
	};
	return write.factory(tui, theme).render(width);
}

const countLines = (lines: readonly string[], needle: string): number =>
	lines.filter((line) => line.includes(needle)).length;

const orders: readonly (readonly string[])[] = [
	["cockpit", "teammate", "flow"],
	["teammate", "flow", "cockpit"],
	["flow", "teammate", "cockpit"],
];

for (const order of orders) {
	test(`single owner holds when extensions load as ${order.join(" → ")}`, async () => {
		const host = await bootHost(order);
		try {
			await host.fire("session_start");
			await settle();

			// Cockpit claims the persistent one-line rail. The active tree remains
			// absent until a teammate actually starts.
			const cockpitMounts = host.widgets.filter((write) => write.mounted && write.key.startsWith("cockpit-"));
			assert.ok(cockpitMounts.some((write) => write.key === "cockpit-session-bar"), "cockpit mounts its teammate rail");
			assert.ok(cockpitMounts.some((write) => write.key === "cockpit-stack"), "cockpit mounts its stack surface");
			assert.equal(cockpitMounts.some((write) => write.key === "cockpit-agents"), false, "inactive tree stays unmounted");

			// ...while the native panels stay unmounted: no duplicate rows.
			const nativeMounts = host.widgets.filter((write) => write.mounted && (
				write.key === "teammate-agents" || write.key === "todo-panel" || write.key === "goal-panel"
			));
			assert.deepEqual(nativeMounts, [], "no native panel mounts while Cockpit owns the surface");
			const claimBoundary = [...host.ownershipBoundaries].reverse().find((boundary) => boundary.agents === true);
			assert.ok(claimBoundary, "enabled default config publishes an agent ownership claim");
			assert.equal(claimBoundary.after.includes("teammate-agents"), false, "native roster withdraws inside the synchronous claim boundary");

			// The handshake really crossed extensions: the alt+r shortcut delegates
			// instead of opening Teammate's own session picker.
			const delegationBefore = host.emitted.length;
			await host.shortcuts.get("alt+r")?.handler(host.ctx);
			assert.ok(
				host.emitted.slice(delegationBefore).includes("cockpit:open-session-list"),
				`Teammate delegates the session list to Cockpit; boundaries=${JSON.stringify(host.ownershipBoundaries)} events=${JSON.stringify(host.emitted.slice(-12))}`,
			);

			// The first active row mounts exactly one fixed below-editor tree. Later
			// starts update its store; they must not re-register any Cockpit surface.
			const writesBeforeBurst = host.widgets.length;
			const footersBeforeBurst = host.footers.length;
			for (let index = 0; index < 5; index += 1) {
				host.pi.events.emit("teammate:started", {
					correlationId: `agent-${index}`,
					agent: "general",
					name: `agent-${index}`,
					status: "running",
					projection: LEGACY_PROJECTION,
				});
			}
			await settle();
			assert.deepEqual(
				host.widgets.slice(writesBeforeBurst).filter((write) => write.key.startsWith("teammate")),
				[],
				"native Teammate does not write a roster while Cockpit owns it",
			);
			const activeTreeWrites = host.widgets.slice(writesBeforeBurst).filter((write) => write.key === "cockpit-agents");
			assert.equal(activeTreeWrites.length, 1, "the zero-to-active transition mounts once");
			assert.equal(activeTreeWrites[0]?.mounted, true);
			assert.equal(activeTreeWrites[0]?.placement, "belowEditor");
			assert.equal(
				host.widgets.slice(writesBeforeBurst).filter((write) => write.key.startsWith("cockpit-") && write.key !== "cockpit-agents").length,
				0,
				"agent updates do not re-register other Cockpit surfaces",
			);
			assert.equal(
				host.footers.length,
				footersBeforeBurst,
				"the ownership replay does not remount the footer",
			);

			// Shutdown releases the surfaces: nothing is left mounted.
			await host.fire("session_shutdown");
			await settle();
			for (const key of ["cockpit-agents", "cockpit-stack", "cockpit-session-bar"]) {
				const writes = host.widgets.filter((write) => write.key === key);
				assert.equal(writes.at(-1)?.mounted, false, `${key} is cleared on shutdown`);
			}
		} finally {
			await host.cleanup();
		}
	});
}

test("teammate-first early query converges through Cockpit factory release and session claim", async () => {
	const host = await bootHost(["teammate", "cockpit"]);
	try {
		const queryIndex = host.emitted.indexOf("cockpit:ui-ownership-query");
		const earlyReleaseIndex = host.emitted.indexOf("cockpit:ui-ownership");
		assert.ok(queryIndex >= 0 && earlyReleaseIndex > queryIndex, "Cockpit answers an earlier Teammate load with a released factory snapshot");
		assert.equal(host.ownershipBoundaries.at(-1)?.agents, false, "factory initialization cannot claim UI before session_start");

		await host.fire("session_start");
		await settle();
		assert.equal([...host.ownershipBoundaries].reverse().find((boundary) => boundary.agents === true)?.after.includes("teammate-agents"), false);
	} finally {
		await host.cleanup();
	}
});

test("a Teammate instance loaded after session_start still receives ownership", async () => {
	const host = await bootHost(["cockpit"]);
	try {
		await host.fire("session_start");
		await settle();

		// Simulate /reload: the host re-runs the extension factory after the session
		// already started, so the one-shot session_start broadcast is in the past.
		const teammate = (await import(
			new URL("../../pi-graph-agent-runtime/src/extension/index.ts", import.meta.url).href
		)).default;
		teammate(host.pi, {});
		await settle(60);

		const before = host.emitted.length;
		await host.shortcuts.get("alt+r")?.handler(host.ctx);
		assert.ok(
			host.emitted.slice(before).includes("cockpit:open-session-list"),
			"a late-loaded Teammate converges without waiting for another session_start",
		);
	} finally {
		await host.cleanup();
	}
});

test("Cockpit mount failure rolls back partial UI and releases native ownership", async () => {
	const host = await bootHost(["cockpit", "teammate"]);
	try {
		const setWidget = host.ctx.ui.setWidget.bind(host.ctx.ui);
		let injected = false;
		host.ctx.ui.setWidget = (key: string, content: unknown, options?: unknown) => {
			if (!injected && key === "cockpit-stack" && content !== undefined) {
				injected = true;
				throw new Error("injected Cockpit mount failure");
			}
			return setWidget(key, content, options);
		};

		await host.fire("session_start");
		await settle();
		assert.equal(injected, true, "the focused mount failure was exercised");
		const released = [...host.ownershipBoundaries].reverse().find((boundary) => boundary.agents === false);
		assert.ok(released, "failed acquire publishes a release");
		assert.equal(released.after.some((key) => key.startsWith("cockpit-")), false, "partial Cockpit widgets are uninstalled before release");
		const beforeShortcut = host.emitted.length;
		await host.shortcuts.get("alt+r")?.handler(host.ctx);
		assert.equal(host.emitted.slice(beforeShortcut).includes("cockpit:open-session-list"), false, "native session-list fallback is no longer suppressed");
	} finally {
		await host.cleanup();
	}
});

test("late active-tree mount failure removes Cockpit before releasing native ownership", async () => {
	const host = await bootHost(["cockpit", "teammate"]);
	try {
		await host.fire("session_start");
		await settle();
		const setWidget = host.ctx.ui.setWidget.bind(host.ctx.ui);
		let injected = false;
		host.ctx.ui.setWidget = (key: string, content: unknown, options?: unknown) => {
			if (!injected && key === "cockpit-agents" && content !== undefined) {
				injected = true;
				throw new Error("injected active-tree mount failure");
			}
			return setWidget(key, content, options);
		};

		host.pi.events.emit("teammate:started", {
			correlationId: "late-mount-failure",
			agent: "general",
			status: "running",
			projection: LEGACY_PROJECTION,
		});
		await settle();
		assert.equal(injected, true);
		const release = [...host.ownershipBoundaries].reverse().find((boundary) => boundary.agents === false);
		assert.ok(release, "failed late mount releases native ownership");
		assert.equal(release.after.some((key) => key.startsWith("cockpit-")), false, "Cockpit surfaces are gone before release");
	} finally {
		await host.cleanup();
	}
});

test("duplicate and malformed ownership snapshots do not release or rewrite Teammate UI", async () => {
	const host = await bootHost(["cockpit", "teammate"]);
	try {
		await host.fire("session_start");
		await settle();

		const writesBefore = host.widgets.length;
		host.pi.events.emit("cockpit:ui-ownership", {
			agents: true,
			sessionList: true,
			quiet: false,
			quietSymbols: "check",
		});
		host.pi.events.emit("cockpit:ui-ownership", {
			agents: "invalid",
			sessionList: false,
			quiet: false,
			quietSymbols: "check",
		});
		assert.equal(host.widgets.length, writesBefore, "duplicate/malformed snapshots do not write widgets");

		const beforeShortcut = host.emitted.length;
		await host.shortcuts.get("alt+r")?.handler(host.ctx);
		assert.ok(
			host.emitted.slice(beforeShortcut).includes("cockpit:open-session-list"),
			"malformed agents value cannot release the existing Cockpit claim",
		);
	} finally {
		await host.cleanup();
	}
});

test("Cockpit release hands a real running agent back to the native roster at the boundary", async () => {
	const host = await bootHost(["cockpit", "teammate"], {
		spawnChildProcess: () => createRunningChild(),
	});
	try {
		await host.fire("session_start");
		const tool = host.tools.get("teammate");
		assert.ok(tool, "real Teammate tool is registered");
		const result = await tool.execute(
			"ownership-real-agent",
			{ tasks: [{ agent: "general", prompt: "Stay active for ownership handoff" }], background: true },
			new AbortController().signal,
			undefined,
			host.ctx,
		);
		assert.equal(result.isError, false, `dispatch starts: ${JSON.stringify(result.content)}`);
		await settle();
		assert.equal(
			host.widgets.filter((write) => write.key === "teammate-agents" && write.mounted).length,
			0,
			"Cockpit claim suppresses the native roster while the agent runs",
		);

		const writesBeforeShutdown = host.widgets.length;
		await host.fire("session_shutdown");
		const fallbackBoundary = [...host.ownershipBoundaries].reverse().find(
			(boundary) => boundary.agents === false && boundary.after.includes("teammate-agents"),
		);
		assert.ok(fallbackBoundary, "native roster mounts synchronously only after Cockpit has uninstalled and released");
		await settle(220);
		assert.deepEqual(
			host.widgets.slice(writesBeforeShutdown).filter((write) => write.key === "teammate-agents" && write.mounted).slice(1),
			[],
			"shutdown fence prevents any delayed second native remount",
		);
	} finally {
		await host.cleanup();
	}
});

test("failed assertions still shut down Flow and a real running Teammate child", async () => {
	const child = createRunningChild();
	const host = await bootHost(["cockpit", "teammate", "flow"], {
		spawnChildProcess: () => child,
	});
	await assert.rejects(async () => {
		try {
			await host.fire("session_start");
			const result = await host.tools.get("teammate").execute(
				"ownership-cleanup-agent",
				{ tasks: [{ agent: "general", prompt: "Stay active for cleanup" }], background: true },
				new AbortController().signal,
				undefined,
				host.ctx,
			);
			assert.equal(result.isError, false, `dispatch starts: ${JSON.stringify(result.content)}`);
			assert.equal(child.exitCode, null, "child is genuinely running before failure");
			assert.fail("injected ownership assertion failure");
		} finally {
			await host.cleanup();
		}
	}, /injected ownership assertion failure/);
	assert.equal(child.exitCode, 0, "cleanup stops the running child even after assertion failure");
	for (const key of ["cockpit-agents", "cockpit-stack", "cockpit-session-bar"]) {
		assert.equal(host.widgets.filter((write) => write.key === key).at(-1)?.mounted, false, `${key} is cleared`);
	}
});

test("rejected shutdown still restores the fixture environment and removes temporary config", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const host = await bootHost(["cockpit", "teammate"]);
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	try {
		await host.fire("session_start");
		host.pi.on("session_shutdown", () => { throw new Error("injected shutdown failure"); });
		await assert.rejects(host.cleanup(), /injected shutdown failure/);
		assert.equal(process.env.PI_CODING_AGENT_DIR, previousAgentDir);
		assert.equal(existsSync(agentDir), false);
	} finally {
		await host.cleanup();
	}
});

test("shutdown cancels a queued native roster update and prevents delayed remount", async () => {
	const host = await bootHost(["teammate"]);
	try {
		await host.fire("session_start");
		host.pi.events.emit("teammate:started", { correlationId: "queued-agent", agent: "general" });
		const shutdownWrite = host.widgets.length;
		await host.fire("session_shutdown");
		await settle(220);
		assert.deepEqual(
			host.widgets.slice(shutdownWrite).filter((write) => write.key === "teammate-agents" && write.mounted),
			[],
			"no timer callback remounts the native roster after shutdown begins",
		);
	} finally {
		await host.cleanup();
	}
});

test("active agents render once in the Rail and content-sized below-editor tree, then collapse at zero active", async () => {
	const host = await bootHost(["cockpit", "flow"]);
	try {
		await host.fire("session_start");
		await settle();

		// A re-advertised agent (same correlationId) must upsert its row, not add a
		// second one: repeated rows are the visible form of the ghosting defect.
		host.pi.events.emit("teammate:started", { correlationId: "dup-one", agent: "general", name: "dup-one", status: "running", projection: LEGACY_PROJECTION });
		host.pi.events.emit("teammate:started", { correlationId: "dup-one", agent: "general", name: "dup-one", status: "running", projection: LEGACY_PROJECTION });
		host.pi.events.emit("teammate:started", { correlationId: "dup-two", agent: "general", name: "dup-two", status: "running", projection: LEGACY_PROJECTION });
		await settle();

		const rail = renderSurface(host, "cockpit-session-bar");
		assert.equal(rail.length, 1, `teammate rail stays one row: ${JSON.stringify(rail)}`);
		assert.equal(countLines(rail, "dup-one"), 1, `dup-one renders once in Rail: ${JSON.stringify(rail)}`);
		assert.equal(countLines(rail, "dup-two"), 1, `dup-two renders once in Rail: ${JSON.stringify(rail)}`);

		const tree = renderSurface(host, "cockpit-agents");
		assert.equal(tree.length, 2, "two active agents use two rows without padding the editor region");
		assert.ok(tree.length <= 6, "the active tree stays within the 40-row terminal's 15% budget");
		assert.equal(countLines(tree, "dup-one"), 1, `dup-one renders once in tree: ${JSON.stringify(tree)}`);
		assert.equal(countLines(tree, "dup-two"), 1, `dup-two renders once in tree: ${JSON.stringify(tree)}`);
		const treeWrites = host.widgets.filter((write) => write.key === "cockpit-agents" && write.mounted);
		assert.equal(treeWrites.length, 1, "duplicate starts do not remount the tree");
		assert.equal(treeWrites[0]?.placement, "belowEditor");

		host.pi.events.emit("teammate:complete", { correlationId: "dup-one", exitCode: 0, projection: LEGACY_PROJECTION });
		host.pi.events.emit("teammate:complete", { correlationId: "dup-two", exitCode: 0, projection: LEGACY_PROJECTION });
		await settle();
		const writes = host.widgets.filter((write) => write.key === "cockpit-agents");
		assert.equal(writes.at(-1)?.mounted, false, "the active-to-zero transition removes the tree");
	} finally {
		await host.cleanup();
	}
});

test("Cockpit is the only footer owner while Flow is loaded", async () => {
	const host = await bootHost(["flow", "cockpit", "teammate"]);
	try {
		await host.fire("session_start");
		await settle();

		// Flow installs its statusline first and withdraws once Cockpit claims the
		// footer; a second live footer is exactly the duplicated-footer ghosting.
		assert.ok(host.footers.some((write) => write.caller.startsWith("pi-graph/src/statusline")), `Flow installs its statusline: ${JSON.stringify(host.footers)}`);
		const statuslineWrites = host.footers.filter((write) => write.caller.startsWith("pi-graph/src/statusline"));
		assert.equal(statuslineWrites.at(-1)?.active, false, "Flow withdraws its statusline");
		assert.equal(host.footers.at(-1)?.active, true, "Cockpit ends up owning the footer");
		assert.ok(host.footers.at(-1)?.caller.startsWith("pi-graph-dashboard/"), "the surviving footer belongs to Cockpit");
	} finally {
		await host.cleanup();
	}
});
