import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateGraphSnapshotV3 } from "../src/v3/snapshot.ts";
import { readLatestV3Attempt } from "../src/v3/attempt.ts";

interface RpcMessage extends Record<string, unknown> {
	type?: string;
	id?: string;
}

interface GraphToolResult {
	content?: Array<{ type?: string; text?: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
}

class PiRpcHarness {
	readonly child: ChildProcessWithoutNullStreams;
	readonly messages: RpcMessage[] = [];
	private readonly waiters = new Set<{
		predicate: (message: RpcMessage) => boolean;
		resolve: (message: RpcMessage) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
	}>();
	private buffer = "";
	private stderr = "";

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
		child.stdout.on("data", (chunk) => this.ingest(String(chunk)));
		child.once("error", (error) => this.failAll(error));
		child.once("exit", (code, signal) => {
			if (this.waiters.size) this.failAll(new Error(`Pi RPC exited ${String(code)}/${String(signal)}.\n${this.stderr}`));
		});
	}

	private ingest(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			let message: RpcMessage;
			try {
				message = JSON.parse(line) as RpcMessage;
			} catch (error) {
				this.failAll(new Error(`Pi RPC emitted invalid JSON: ${line}`, { cause: error }));
				continue;
			}
			this.messages.push(message);
			for (const waiter of [...this.waiters]) {
				if (!waiter.predicate(message)) continue;
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				waiter.resolve(message);
			}
		}
	}

	private failAll(error: Error): void {
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters.clear();
	}

	waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs = 30_000): Promise<RpcMessage> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolvePromise, reject) => {
			const waiter = {
				predicate,
				resolve: resolvePromise,
				reject,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error(`Timed out waiting for Pi RPC event.\n${this.stderr}`));
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
	}

	async graph(action: Record<string, unknown>, callId: string): Promise<GraphToolResult> {
		const before = this.messages.length;
		const promptId = `prompt-${callId}`;
		this.child.stdin.write(`${JSON.stringify({
			id: promptId,
			type: "prompt",
			message: `PI_GRAPH_PUBLIC_RPC_E2E ${JSON.stringify(action)}`,
		})}\n`);
		await this.waitFor((message) => message.id === promptId && message.type === "response");
		const tool = await this.waitFor((message) => {
			if (this.messages.indexOf(message) < before || message.type !== "tool_execution_end" || message.toolName !== "graph") return false;
			return true;
		}, 60_000);
		await this.waitFor((message) => this.messages.indexOf(message) >= before && message.type === "agent_end", 60_000);
		return tool.result as GraphToolResult;
	}

	async close(): Promise<void> {
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
		await new Promise<void>((resolvePromise) => {
			if (this.child.exitCode !== null) return resolvePromise();
			this.child.once("close", () => resolvePromise());
			setTimeout(() => resolvePromise(), 5_000).unref();
		});
	}

	diagnostics(): string {
		return JSON.stringify({
			stderr: this.stderr,
			messages: this.messages.slice(-40),
		}, null, 2);
	}
}

async function diagnosticFile(path: string): Promise<string> {
	return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => `<${error.code ?? error.message}>`);
}

async function rpcFailureDiagnostics(runDir: string | undefined, pi: PiRpcHarness): Promise<string> {
	const sections = [`Pi RPC:\n${pi.diagnostics()}`];
	if (!runDir) return sections.join("\n\n");
	sections.push(`snapshot.json:\n${await diagnosticFile(join(runDir, "snapshot.json"))}`);
	sections.push(`control.json:\n${await diagnosticFile(join(runDir, "control.json"))}`);
	sections.push(`events.jsonl:\n${await diagnosticFile(join(runDir, "events.jsonl"))}`);
	const attempt = await readLatestV3Attempt(runDir, "work").catch(() => undefined);
	if (attempt) {
		const attemptDir = join(runDir, "nodes", "work", "attempts", String(attempt.attempt));
		sections.push(`attempt.json:\n${await diagnosticFile(join(attemptDir, "attempt.json"))}`);
		sections.push(`workspace.json:\n${await diagnosticFile(join(attemptDir, "workspace.json"))}`);
		sections.push(`child status.json:\n${attempt.evidence.dispatch?.asyncDir ? await diagnosticFile(join(attempt.evidence.dispatch.asyncDir, "status.json")) : "<no dispatch binding>"}`);
	}
	return sections.join("\n\n");
}

async function waitForSnapshot(path: string, predicate: (value: ReturnType<typeof validateGraphSnapshotV3>) => boolean, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let latest: ReturnType<typeof validateGraphSnapshotV3> | undefined;
	while (Date.now() < deadline) {
		try {
			latest = validateGraphSnapshotV3(JSON.parse(await readFile(path, "utf8")) as unknown);
			if (predicate(latest)) return latest;
		} catch {
			// Atomic publication may briefly leave the path absent, never partial.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error(`Timed out waiting for snapshot predicate; last status=${latest?.status ?? "missing"}.`);
}

test("real Pi public RPC starts and observes a V3 graph through real pi-subagents", { timeout: 90_000 }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-graph-v3-real-rpc-")));
	const agentDir = join(root, "agent-home");
	const runsDir = join(root, "runs");
	const agentsDir = join(root, ".pi", "agents");
	const repoRoot = resolve(new URL("..", import.meta.url).pathname);
	const fauxExtension = join(repoRoot, "tests", "helpers", "v3-faux-provider.ts");
	await mkdir(agentDir, { recursive: true });
	await mkdir(runsDir, { recursive: true });
	await mkdir(agentsDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		graph: { enabled: true, runsDir },
		subagents: { disableBuiltins: true },
	}, null, 2));
	await writeFile(join(agentsDir, "worker.md"), [
		"---",
		"name: worker",
		"description: Deterministic real-Pi E2E worker",
		"model: pi-graph-faux/faux-1",
		"thinking: off",
		"tools: read",
		`extensions: ${fauxExtension}`,
		"inheritProjectContext: false",
		"inheritSkills: false",
		"---",
		"Execute the exact graph task and return a concise result.",
		"",
	].join("\n"));

	const child = spawn(join(repoRoot, "node_modules", ".bin", "pi"), [
		"--mode", "rpc",
		"--offline",
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--no-extensions",
		"--provider", "pi-graph-faux",
		"--model", "faux-1",
		"--extension", fauxExtension,
		"--extension", join(repoRoot, "node_modules", "pi-subagents", "index.ts"),
		"--extension", join(repoRoot, "extensions", "pi-graph.ts"),
	], {
		cwd: root,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pi = new PiRpcHarness(child);
	let runDir: string | undefined;
	try {
		const started = await pi.graph({
			action: "start",
			spec: {
				schemaVersion: 3,
				goal: "exercise real Pi public RPC",
				nodes: [{ taskId: "work", agent: "worker", task: "PI_GRAPH_CHILD_REAL_RPC", sideEffect: "none" }],
			},
		}, "start");
		assert.equal(started.isError, undefined, started.content?.map((entry) => entry.text).join("\n"));
		const graphId = started.details?.graphId;
		assert.equal(typeof graphId, "string", JSON.stringify(started));
		runDir = join(runsDir, graphId as string);
		const completed = await waitForSnapshot(join(runDir, "snapshot.json"), (snapshot) => snapshot.status === "complete");
		assert.equal(completed.status, "complete");
		const attempt = (await readLatestV3Attempt(runDir, "work"))?.evidence;
		assert.equal(attempt?.phase, "accepted");
		const childStatus = attempt?.dispatch?.asyncDir
			? await readFile(join(attempt.dispatch.asyncDir, "status.json"), "utf8").catch(() => "missing")
			: "no dispatch";
		assert.match(attempt?.child?.output ?? "", /Faux child completed/, `${JSON.stringify(attempt)}\n${childStatus}`);

		const status = await pi.graph({ action: "status", id: graphId }, "status");
		assert.equal(status.isError, undefined, status.content?.map((entry) => entry.text).join("\n"));
		assert.equal(status.details?.status, "complete");
		assert.equal(status.details?.graphId, graphId);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n${await rpcFailureDiagnostics(runDir, pi)}`, { cause: error });
	} finally {
		await pi.close();
		await rm(root, { recursive: true, force: true });
	}
});
