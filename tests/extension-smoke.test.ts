import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

test("D3: graph tool exposes only the retained governance-free action set", () => {
	const jiti = createJiti(import.meta.url);
	const { GraphSpecV3Schema, Parameters } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as {
		GraphSpecV3Schema: unknown;
		Parameters: { properties: { action?: { enum?: string[] }; spec?: unknown } };
	};
	const actions = Parameters.properties.action?.enum;
	assert.deepEqual(actions, ["start", "status", "list", "stop", "resume", "doctor"]);
	assert.equal(actions?.includes("recommend"), false);
	assert.ok(GraphSpecV3Schema, "the tool must expose the GraphSpec v3 schema");
});

test("graph tool schema exposes strict nested GraphSpec fields and read-only guidance", () => {
	const jiti = createJiti(import.meta.url);
	const { GraphSpecSchema } = jiti(new URL("../extensions/pi-graph.ts", import.meta.url).href) as { GraphSpecSchema: unknown };
	const schema = GraphSpecSchema as unknown as {
		properties: {
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
	assert.match(node.allowBash?.description ?? "", /Deprecated and rejected/);
	assert.match(node.validationCommands?.description ?? "", /Usually omit this field for read-only review\/search nodes/);
	assert.match(node.validationCommands?.description ?? "", /cwd is itself a Git repository/);
	assert.equal((node.retryPolicy as any)?.properties?.maxAttempts?.type, "integer");
	assert.equal((node.retryPolicy as any)?.required?.includes("maxAttempts") ?? false, false);
	assert.equal((node.toolBudget as any)?.properties?.hard?.minimum, 1);
	assert.equal((node.maxAuthorization as any)?.properties?.singleUse?.const, true);
	assert.ok((node.childAcceptance as any)?.anyOf, "childAcceptance must expose its nested alternatives");
	assert.equal((node.timeoutMs as any)?.minimum, 1_000);
	assert.equal((node.timeoutMs as any)?.maximum, 7_200_000);
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
