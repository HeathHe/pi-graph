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
			messages: this.messages.filter(m => !["message_update", "message_start", "message_end", "extension_ui_request"].includes(String(m.type))).slice(-12),
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


test("real Pi RPC inherits native tools, blocks readonly/parent/role ceilings, and records external results honestly", { timeout: 180_000 }, async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), "pi-graph-inherited-rpc-")));
 const repoRoot = resolve(new URL("..", import.meta.url).pathname);
 const agentDir = join(root, "agent-home"), runsDir = join(root, "runs"), agentsDir = join(root, ".pi", "agents");
 const outside = join(root, "outside.txt");
 await mkdir(agentDir, { recursive: true }); await mkdir(runsDir); await mkdir(agentsDir, { recursive: true });
 await writeFile(outside, "OUTSIDE_READ_PROVEN");
 const requests: Array<{ mode: string; tools: string[]; results: unknown[] }> = [];
 const server = createServer((request, response) => {
  const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
   const body = JSON.parse(Buffer.concat(chunks).toString());
   const text = JSON.stringify(body.messages);
   const mode = /INHERIT_CASE_(allowed|readonly|parentdeny|agentdeny)/.exec(text)?.[1] ?? "unknown";
   const results = body.messages.filter((entry: { role: string }) => entry.role === "tool");
   requests.push({ mode, tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name), results });
   const calls = [
    { index: 0, id: "call-bash", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `printf marker > '${join(root, mode + ".marker")}'` }) } },
    { index: 1, id: "call-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: outside }) } },
    { index: 2, id: "call-external", type: "function", function: { name: "fake_external_write", arguments: JSON.stringify({ path: join(root, mode + ".ledger") }) } },
   ];
   response.writeHead(200, { "content-type": "text/event-stream" });
   const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id: "inherited-test", object: "chat.completion.chunk", created: 1, model: "local-1", choices: [{ index: 0, delta, finish_reason }] })}\n\n`.replaceAll("\\n", "\n"));
   send(results.length ? { role: "assistant", content: "RESULT_EVIDENCE " + JSON.stringify(results) } : { role: "assistant", tool_calls: calls }, null);
   send({}, results.length ? "stop" : "tool_calls"); response.end("data: [DONE]\n\n".replaceAll("\\n", "\n"));
  });
 });
 await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
 const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
 await writeFile(join(agentDir, "settings.json"), JSON.stringify({ graph: { enabled: true, runsDir }, subagents: { disableBuiltins: true, timeoutMs: 120000 } }));
 await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "pi-graph-local": { baseUrl, api: "openai-completions", apiKey: "local-fixture", models: [{ id: "local-1", name: "Local fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
 const extension = join(root, "fixture-tools.ts");
 await writeFile(extension, `import { appendFileSync } from "node:fs";
 export default function(pi) {
 pi.registerTool({ name: "fake_external_write", label: "fake", description: "Write only a temporary test ledger", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, async execute(id, args) { appendFileSync(args.path, "external\\n"); return { content: [{type:"text",text:"FAKE_EXTERNAL_PROVEN"}] }; } });
 if (process.env.PI_GRAPH_CHILD !== "1") pi.on("before_agent_start", (event) => { const tools = pi.getAllTools().map(t => t.name); pi.setActiveTools(event.prompt.includes("INHERIT_CASE_parentdeny") ? tools.filter(t => t !== "bash" && t !== "fake_external_write") : tools); });
 }`);
 for (const [name, tools] of [["worker", ""], ["reader", "tools: read\n"]]) await writeFile(join(agentsDir, name + ".md"), `---\nname: ${name}\ndescription: Test ${name}\nmodel: pi-graph-local/local-1\nthinking: off\n${tools}subagentOnlyExtensions: ${extension}\ninheritProjectContext: false\ninheritSkills: false\n---\nExecute the assigned test.\n`);
 const actualCli = process.env.PI_GRAPH_INHERITED_GLOBAL_CLI ?? piCliPath;
 const child = spawn(process.execPath, [actualCli, "--mode", "rpc", "--offline", "--no-session", "--no-context-files", "--no-skills", "--no-extensions", "--provider", "pi-graph-faux", "--model", "faux-1", "--extension", join(repoRoot, "tests/helpers/v3-faux-provider.ts"), "--extension", extension, "--extension", join(repoRoot, "extensions/pi-graph.ts")], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "127.0.0.1,localhost" }, stdio: ["pipe", "pipe", "pipe"] });
 const pi = new PiRpcHarness(child); let runDir: string | undefined;
 try {
  for (const mode of ["allowed", "readonly", "parentdeny", "agentdeny"] as const) {
   const started = await pi.graph({ action: "start", spec: { schemaVersion: 3, goal: "Inherited permission test", nodes: [{ taskId: "work", agent: mode === "agentdeny" ? "reader" : "worker", task: "INHERIT_CASE_" + mode, sideEffect: mode === "readonly" ? "external_read" : "external_write", ...(mode === "readonly" ? { readOnly: true } : {}) }, ...(mode === "allowed" ? [{ taskId: "safe", agent: "worker", task: "INHERIT_CASE_readonly", sideEffect: "external_read", readOnly: true, dependsOn: ["work"] }] : [])] } }, mode);
   assert.equal(started.isError, undefined, JSON.stringify(started));
   runDir = join(runsDir, started.details!.graphId as string);
   const snapshot = await waitForSnapshot(join(runDir, "snapshot.json"), s => ["complete", "failed", "needs_attention"].includes(s.status), 45000);
   assert.equal(snapshot.status, "complete", await rpcFailureDiagnostics(runDir, pi));
   if (mode === "allowed") {
    const safe = (await readLatestV3Attempt(runDir, "safe"))!.evidence;
    assert.match(safe.child!.output, /read-only/);
    assert.equal(await readFile(join(root, "readonly.marker"), "utf8").catch(() => null), null);
    assert.equal(await readFile(join(root, "readonly.ledger"), "utf8").catch(() => null), null);
   }
   const attempt = (await readLatestV3Attempt(runDir, "work"))!.evidence;
   assert.match(attempt.child!.output, /OUTSIDE_READ_PROVEN/);
   const marker = await readFile(join(root, mode + ".marker"), "utf8").catch(() => null);
   const ledger = await readFile(join(root, mode + ".ledger"), "utf8").catch(() => null);
   assert.equal(marker, mode === "allowed" ? "marker" : null);
   assert.equal(ledger, mode === "allowed" ? "external\n" : null);
   if (mode === "readonly") assert.match(attempt.child!.output, /read-only/);
   const acceptance = JSON.parse(await readFile(join(runDir, "nodes/work/attempts/1/acceptance.json"), "utf8"));
   assert.equal(acceptance.method, "declared"); assert.equal(acceptance.verified, false);
   const initial = requests.find(request => request.mode === mode)!;
   assert.ok(initial.tools.includes("read"));
   assert.equal(initial.tools.includes("bash"), mode === "allowed" || mode === "readonly");
   assert.equal(initial.tools.includes("fake_external_write"), mode === "allowed" || mode === "readonly");
   console.log(JSON.stringify({ mode, actualTools: initial.tools, marker, ledger, output: attempt.child!.output, acceptance: { method: acceptance.method, verified: acceptance.verified } }));
  }
 } catch (error) { throw new Error(`${String(error)}\n${await rpcFailureDiagnostics(runDir, pi)}`, { cause: error }); }
 finally { await pi.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
});
