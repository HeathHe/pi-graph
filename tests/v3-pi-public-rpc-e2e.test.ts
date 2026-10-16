import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateGraphSnapshotV3 } from "../src/v3/snapshot.ts";
import { readLatestV3Attempt } from "../src/v3/attempt.ts";
import { piCliPath } from "./helpers/pi-cli.ts";

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

test("real Pi public RPC rejects extension Providers, blocks child-only overrides, and runs models.json Providers", { timeout: 120_000 }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-graph-v3-real-rpc-")));
	const agentDir = join(root, "agent-home");
	const runsDir = join(root, "runs");
	const agentsDir = join(root, ".pi", "agents");
	const repoRoot = resolve(new URL("..", import.meta.url).pathname);
	const fauxExtension = join(repoRoot, "tests", "helpers", "v3-faux-provider.ts");
	const childProviderOverride = join(repoRoot, "tests", "helpers", "v3-child-provider-override.ts");
	let modelRequests = 0;
	let overrideProbeRequests = 0;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", async () => {
			if (request.url === "/probe") {
				overrideProbeRequests += 1;
				response.writeHead(204).end();
				return;
			}
			modelRequests += 1;
			await new Promise((done) => setTimeout(done, 300));
			assert.equal(request.url, "/v1/chat/completions");
			assert.match(Buffer.concat(chunks).toString("utf8"), /PI_GRAPH_CHILD_REAL_RPC/u);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${JSON.stringify({
				id: "chatcmpl-pi-graph-e2e",
				object: "chat.completion.chunk",
				created: 1,
				model: "local-1",
				choices: [{ index: 0, delta: { role: "assistant", content: "Local child completed" }, finish_reason: null }],
			})}\n\n`);
			response.write(`data: ${JSON.stringify({
				id: "chatcmpl-pi-graph-e2e",
				object: "chat.completion.chunk",
				created: 1,
				model: "local-1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
			})}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address() as AddressInfo;
	const localBaseUrl = `http://127.0.0.1:${address.port}/v1`;
	const overrideProbeUrl = `http://127.0.0.1:${address.port}/probe`;
	await mkdir(agentDir, { recursive: true });
	await mkdir(runsDir, { recursive: true });
	await mkdir(agentsDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		graph: { enabled: true, runsDir },
		subagents: { disableBuiltins: true, timeoutMs: 120000 },
	}, null, 2));
	await writeFile(join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"pi-graph-local": {
				baseUrl: localBaseUrl,
				api: "openai-completions",
				apiKey: "pi-graph-e2e",
				models: [{
					id: "local-1",
					name: "pi-graph local E2E model",
					reasoning: false,
					input: ["text"],
					contextWindow: 128_000,
					maxTokens: 16_384,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}],
			},
		},
	}, null, 2));
	await writeFile(join(agentsDir, "worker.md"), [
		"---",
		"name: worker",
		"description: Deterministic real-Pi E2E worker",
		"timeoutMs: 120000",
		"model: pi-graph-local/local-1",
		"thinking: off",
		"tools: read",
		"inheritProjectContext: false",
		"inheritSkills: false",
		"---",
		"Execute the exact graph task and return a concise result.",
		"",
	].join("\n"));
	await writeFile(join(agentsDir, "known-extension-worker.md"), [
		"---",
		"name: known-extension-worker",
		"description: Parent-visible extension Provider negative case",
		"model: pi-graph-faux/faux-1",
		"thinking: off",
		"tools: read",
		"inheritProjectContext: false",
		"inheritSkills: false",
		"---",
		"This Agent selects an extension-registered Provider visible to admission.",
		"",
	].join("\n"));
	await writeFile(join(agentsDir, "child-override-worker.md"), [
		"---",
		"name: child-override-worker",
		"description: Child-only streamSimple Provider override negative case",
		"model: pi-graph-local/local-1",
		"thinking: off",
		"tools: read",
		`extensions: ${childProviderOverride}`,
		"inheritProjectContext: false",
		"inheritSkills: false",
		"---",
		"This Agent overrides its models.json Provider only inside the child.",
		"",
	].join("\n"));

	const child = spawn(process.execPath, [
		piCliPath,
		"--mode", "rpc",
		"--offline",
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--no-extensions",
		"--provider", "pi-graph-faux",
		"--model", "faux-1",
		"--extension", fauxExtension,
		"--extension", join(repoRoot, "extensions", "pi-graph.ts"),
	], {
		cwd: root,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_GRAPH_CHILD_PROVIDER_PROBE_URL: overrideProbeUrl,
			PI_OFFLINE: "1",
			HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pi = new PiRpcHarness(child);
	let runDir: string | undefined;
	try {
		const rejected = await pi.graph({
			action: "start",
			spec: {
				schemaVersion: 3,
				goal: "reject a parent-visible extension Provider",
				nodes: [{ taskId: "work", agent: "known-extension-worker", task: "MUST_NOT_DISPATCH", sideEffect: "none" }],
			},
		}, "known-extension-reject");
		assert.equal(rejected.isError, true, JSON.stringify(rejected));
		assert.match(rejected.content?.map((entry) => entry.text).join("\n") ?? "", /cannot admit extension Providers/u);
		assert.deepEqual(await readdir(runsDir), [], "rejected admission must not publish a run or child dispatch");

		const guarded = await pi.graph({
			action: "start",
			spec: {
				schemaVersion: 3,
				goal: "block a child-only Provider override before streamSimple",
				nodes: [{ taskId: "work", agent: "child-override-worker", task: "MUST_NOT_REACH_ANY_PROVIDER", sideEffect: "none" }],
			},
		}, "child-override");
		assert.equal(guarded.isError, undefined, guarded.content?.map((entry) => entry.text).join("\n"));
		const guardedGraphId = guarded.details?.graphId;
		assert.equal(typeof guardedGraphId, "string", JSON.stringify(guarded));
		const guardedRunDir = join(runsDir, guardedGraphId as string);
        runDir = guardedRunDir;
		const blocked = await waitForSnapshot(join(guardedRunDir, "snapshot.json"), (snapshot) => snapshot.status === "needs_attention");
		assert.equal(blocked.status, "needs_attention", "handled input without assistant evidence remains conservative; no automatic replay");
		const guardedAttempt = (await readLatestV3Attempt(guardedRunDir, "work"))?.evidence;
		assert.equal(guardedAttempt?.phase, "needs_attention");
		assert.match(guardedAttempt?.failure?.message ?? "", /Child input was handled without an assistant result/u);
        assert.match(guardedAttempt?.failure?.message ?? "", /未自动重派：当前子进程协议未提供重新派发所需的恢复证明/u);
        const guardedObservation = blocked.nodes?.work.observation;
        assert.equal(guardedObservation?.progress?.toolCount, 0);
        assert.equal(guardedObservation?.progress?.turnCount, 0);
        assert.equal(guardedObservation?.supervision?.processExitConfirmed, true);
        const guardedAsyncDir=guardedAttempt?.dispatch?.asyncDir;assert.equal(typeof guardedAsyncDir,"string");
        const terminalProof=JSON.parse(await readFile(join(guardedAsyncDir!,"process-terminal.json"),"utf8"));
        assert.equal(terminalProof.runtimeKind,"pi-graph-sdk/1");
        assert.equal(terminalProof.runId,guardedObservation?.asyncId);
        assert.equal(terminalProof.runnerProcessInstanceId,guardedObservation?.supervision?.runnerInstanceId);
        assert.equal(terminalProof.instances[0].processInstanceId,terminalProof.runnerProcessInstanceId);
        assert.equal(typeof terminalProof.instances[0].closeObservedAt,"number");
        assert.deepEqual(await readdir(join(guardedRunDir,"nodes/work/attempts")),["1"],"guarded task must not retry");
		assert.equal(overrideProbeRequests, 0, "child custom streamSimple must never start");
		assert.equal(modelRequests, 0, "the overridden models.json transport must never start");

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
		assert.match(attempt?.child?.output ?? "", /Local child completed/, `${JSON.stringify(attempt)}\n${childStatus}`);
		assert.equal(JSON.parse(childStatus).runtimeKind, "pi-graph-sdk/1");
		assert.equal(JSON.parse(childStatus).noTimeout, true);
		assert.equal(JSON.parse(childStatus).timeoutMs, undefined);
		assert.equal(JSON.parse(childStatus).deadlineAt, undefined);
		const receipt = JSON.parse(await readFile(join(runDir, "nodes/work/attempts/1/child-result.json"), "utf8"));
		assert.equal(receipt.version, 1);
		assert.match(receipt.completion.results[0].finalOutput, /Local child completed/);
		assert.equal(overrideProbeRequests, 0);
		assert.equal(modelRequests, 1, "the standard models.json Provider should receive exactly one child request");

		const status = await pi.graph({ action: "status", id: graphId }, "status");
		assert.equal(status.isError, undefined, status.content?.map((entry) => entry.text).join("\n"));
		assert.equal(status.details?.status, "complete");
		assert.equal(status.details?.graphId, graphId);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n${await rpcFailureDiagnostics(runDir, pi)}`, { cause: error });
	} finally {
		await pi.close();
		server.closeAllConnections();
		await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		await rm(root, { recursive: true, force: true });
	}
});
