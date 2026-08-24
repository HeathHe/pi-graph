import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

test("D2: only the retained pi extensions are autoloaded", async () => {
	const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { pi?: { extensions?: string[] } };
	assert.deepEqual(packageJson.pi?.extensions, [
		"./extensions/pi-graph.ts",
		"./extensions/pi-graph-guard.ts",
	]);
	assert.equal(packageJson.pi?.extensions?.includes("./extensions/subagent-model-router.ts"), false);
});

test("D3: graph tool exposes the complete governance-free V3 action set", () => {
	const jiti = createJiti(import.meta.url);
	const { GraphSpecV3Schema, GraphSpecV3NodeSchema, Parameters } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		GraphSpecV3Schema: {
			properties: {
				mode?: { enum?: string[] };
				nodes: { minItems?: number; maxItems?: number; items: { properties: Record<string, unknown> } };
			};
		};
		GraphSpecV3NodeSchema: { properties: Record<string, unknown>; required?: string[] };
		Parameters: { properties: Record<string, { enum?: string[]; minimum?: number; minItems?: number; maxItems?: number; uniqueItems?: boolean }> };
	};
	const actions = Parameters.properties.action?.enum;
	assert.deepEqual(actions, ["start", "load", "status", "list", "doctor", "pause", "resume", "stop", "templates", "agents", "retry", "append", "cancel", "seal"]);
	assert.equal(actions?.includes("recommend"), false);
	assert.ok(GraphSpecV3Schema, "the tool must expose the GraphSpec v3 schema");
	assert.deepEqual(GraphSpecV3Schema.properties.mode?.enum, ["sealed", "open"]);
	assert.equal(GraphSpecV3Schema.properties.nodes.minItems, undefined, "open graphs must be representable with an empty node array");
	assert.equal(GraphSpecV3Schema.properties.nodes.maxItems, 512);
	assert.ok(GraphSpecV3NodeSchema.properties.when, "conditional nodes must be visible in the public schema");
	assert.ok(GraphSpecV3NodeSchema.required?.includes("sideEffect"), "sideEffect is required by the V3 compiler contract");
	for (const forbidden of ["model", "thinking", "routingProfile", "contractPolicy", "maxAuthorization"]) {
		assert.equal(forbidden in GraphSpecV3NodeSchema.properties, false, `${forbidden} must not re-enter the V3 API`);
	}
	for (const field of ["revision", "nodes", "taskIds", "cascade", "capsule", "template", "overrides", "node"]) assert.ok(Parameters.properties[field], `${field} must be exposed`);
	assert.equal(Parameters.properties.revision?.minimum, 0);
	assert.equal(Parameters.properties.nodes?.maxItems, 64);
	assert.equal(Parameters.properties.taskIds?.uniqueItems, true);
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

test("V3 public load/templates/agents actions return useful data without executing a graph", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-extension-public-actions-"));
	try {
		const agentsDir = join(root, ".pi", "agents");
		await mkdir(agentsDir, { recursive: true });
		await writeFile(join(agentsDir, "worker.md"), "---\nname: worker\ndescription: Local worker\nmodel: must-not-leak\n---\nWork.\n");
		const jiti = createJiti(import.meta.url);
		const extension = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href).default as (api: Record<string, unknown>) => void;
		let graphTool: { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }>; details: any; isError?: boolean }> } | undefined;
		const listeners = new Map<string, Array<(data: unknown) => void>>();
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
			on() {},
			registerCommand() {},
			registerTool(tool: unknown) { graphTool = tool as typeof graphTool; },
		} as any);
		assert.ok(graphTool, "graph tool must register");
		const ctx = { cwd: root };
		const loaded = await graphTool.execute("load", {
			action: "load",
			spec: { schemaVersion: 3, goal: "compile only", nodes: [{ taskId: "a", agent: "worker", task: "inspect", sideEffect: "none" }] },
		}, undefined, undefined, ctx);
		assert.equal(loaded.isError, undefined);
		assert.equal(loaded.details.status, "loaded");
		assert.equal(loaded.details.graph.nodeCount, 1);
		assert.deepEqual(loaded.details.graph.topologicalOrder, ["a"]);
		const capsulePath = join(root, "typed.graph.json");
		await writeFile(capsulePath, JSON.stringify({
			manifest: { name: "typed", version: "1.0.0", description: "Typed capsule" },
			source: {
				type: "graph-spec",
				spec: {
					schemaVersion: 3,
					goal: "Process {{count}} items",
					nodes: [{ taskId: "typed", agent: "worker", task: "Enabled={{enabled}}", sideEffect: "none" }],
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
		assert.deepEqual(agents.details.agents, [{ name: "worker", description: "Local worker" }]);
		assert.equal(JSON.stringify(agents.details).includes("must-not-leak"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("graph tool schema exposes only strict GraphSpec V3 fields and graph-wide Guard ceilings", () => {
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
	assert.equal((node.timeoutMs as any)?.minimum, 1);
	assert.equal(schema.properties.readOnly?.type, "boolean");
	assert.equal(schema.properties.toolFilter?.uniqueItems, true);
	assert.deepEqual((schema as any).properties.workspace.enum, ["shadow"]);
	for (const forbidden of ["model", "thinking", "routingProfile", "maxAuthorization", "toolBudget", "allowBash", "resourceScopes", "externalAction"]) {
		assert.equal(forbidden in node, false, `${forbidden} must not exist in the V3 node schema`);
	}
	assert.equal((schema as any).properties.maxConcurrency.maximum, 6);
});

test("Pi 0.81 RPC loads the extension and runs the graphs doctor command", { timeout: 45_000 }, async () => {
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

	const child = spawn(join(process.cwd(), "node_modules", ".bin", "pi"), [
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
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
		await rm(root, { recursive: true, force: true });
	}
});
