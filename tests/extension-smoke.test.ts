import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Pi 0.81 RPC loads the extension and runs the graphs doctor command", { timeout: 20_000 }, async () => {
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
		child.kill("SIGTERM");
	}
});
