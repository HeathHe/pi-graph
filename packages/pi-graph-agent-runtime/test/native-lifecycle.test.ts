import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { modelOnlyControlTool } from "../src/extension/native-tool-policy.ts";
import registerStructuredOutput from "../src/extension/structured-output.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertVirtualChildRouter, nativeChildBuiltinArgs, probePiChildVersion } from "../src/runs/native-child.ts";
import { registerTeammateChildExtension } from "../src/runs/child-extensions.ts";
import { runSingleTeammate, sendRpcMessageWithReceipt } from "../src/runs/execution.ts";
import { PiRpcDriver } from "../src/remote/pi-rpc-driver.ts";
import type { AgentProgress } from "../src/shared/types.ts";
import { adaptPiRuntimeSignalV2 } from "../src/runtime-v2/adapters.ts";
import { parseRuntimeEventV2 } from "../src/runtime-v2/validation.ts";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("control exposure is native-only and unrelated callable tools are preserved", () => {
  for (const name of ["structured_output", "teammate", "teammate-send", "observe", "workspace-window", "remote-worker"]) {
    assert.equal((modelOnlyControlTool({ name }, "0.99.0") as any).exposure, "model-only");
    assert.deepEqual(modelOnlyControlTool({ name }, "0.98.0"), { name });
    assert.deepEqual(modelOnlyControlTool({ name }, undefined), { name });
  }
  assert.deepEqual(modelOnlyControlTool({ name: "read" }, "0.99.0"), { name: "read" });
});

test("structured nested preflight blocks before the private result file changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-structured-"));
  const previous = { schema: process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH, output: process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH };
  let tool: any;
  let hook: any;
  try {
    process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH = path.join(root, "schema.json");
    process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH = path.join(root, "output.json");
    fs.writeFileSync(process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH, '{"type":"object"}');
    fs.writeFileSync(process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH, "unchanged");
    registerStructuredOutput({ registerTool: (value: unknown) => { tool = value; }, on: (_name: string, value: unknown) => { hook = value; } } as unknown as ExtensionAPI);
    assert.equal(tool.exposure, "model-only");
    assert.equal((await hook({ toolName: "structured_output", parentToolCallId: "outer" })).block, true);
    assert.equal(fs.readFileSync(process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH, "utf8"), "unchanged");
    assert.equal(await hook({ toolName: "structured_output" }), undefined);
  } finally {
    if (previous.schema === undefined) delete process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH; else process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH = previous.schema;
    if (previous.output === undefined) delete process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH; else process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH = previous.output;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime broker validation preserves exact nested parent identities", () => {
  const actor = { version: 2 as const, revision: 1 as const, workspaceId: "workspace", actorKind: "teammate" as const, actorId: "actor", generation: 1 };
  const events = adaptPiRuntimeSignalV2({ type: "tool_execution_end", toolCallId: "actual-child-id", parentToolCallId: "actual-parent-id", toolName: "read" }, { streamId: "stream", actor });
  const parsed = parseRuntimeEventV2({ ...events[0], sequence: 1, producerEpoch: 1 });
  assert.equal((parsed as any).toolCallId, "actual-child-id");
  assert.equal((parsed as any).parentToolCallId, "actual-parent-id");
});

test("native child builtins respect actual version, disabled settings and restricted tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-builtins-"));
  fs.mkdirSync(path.join(root, ".pi"));
  try {
    fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp", "-builtin:codemode"] }));
    assert.deepEqual(nativeChildBuiltinArgs({ cwd: root, version: "0.99.0", tools: ["read"] }), []);
    assert.deepEqual(nativeChildBuiltinArgs({ cwd: root, version: "0.98.0" }), []);
    assert.deepEqual(nativeChildBuiltinArgs({ cwd: root }), []);
    assert.deepEqual(nativeChildBuiltinArgs({ cwd: root, version: "0.99.0" }), ["--extension", "builtin:tool-search"]);
    assert.deepEqual(nativeChildBuiltinArgs({ cwd: root, version: "0.99.0", tools: ["read"], model: "llama.cpp/local" }), ["--extension", "builtin:llama.cpp"]);
    const global = path.join(root, "agent");
    fs.mkdirSync(global);
    fs.writeFileSync(path.join(global, "settings.json"), JSON.stringify({ extensions: ["!builtin:*", "+builtin:mcp"] }));
    fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ extensions: ["+builtin:codemode", "-builtin:mcp"] }));
    assert.deepEqual(nativeChildBuiltinArgs({ cwd: root, env: { PI_CODING_AGENT_DIR: global }, version: "0.99.0" }), ["--extension", "builtin:codemode"]);
    const script = path.join(root, "child-version.mjs");
    fs.writeFileSync(script, 'console.log("0.98.0")');
    assert.equal(await probePiChildVersion(process.execPath, [script], root, process.env), "0.98.0");
    assert.throws(() => assertVirtualChildRouter("router/dynamic", ["router/dynamic"], "0.99.0"), /cannot launch/);
    const dispose = registerTeammateChildExtension(script, { virtualModels: ["router/dynamic"] });
    try {
      assert.doesNotThrow(() => assertVirtualChildRouter("router/dynamic", ["router/dynamic"], "0.99.0"));
      assert.throws(() => assertVirtualChildRouter("router/dynamic", ["router/dynamic"], "0.98.0"), /cannot launch/);
    } finally { dispose(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("child version probing does not block the host event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-version-probe-"));
  const script = path.join(root, "slow-version.mjs");
  fs.writeFileSync(script, 'setTimeout(() => console.log("0.99.0"), 150)');
  try {
    const started = Date.now();
    const pending = probePiChildVersion(process.execPath, [script], root, process.env);
    assert.ok(Date.now() - started < 100, "probe returns before the child prints its version");
    await delay(5);
    assert.equal(await pending, "0.99.0");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("version probe timeout reclaims the owned child before resolving", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-version-timeout-"));
  const script = path.join(root, "hung-version.mjs");
  fs.writeFileSync(script, "setInterval(() => {}, 1000)");
  try {
    const started = Date.now();
    assert.equal(await probePiChildVersion(process.execPath, [script], root, process.env, 50), undefined);
    assert.ok(Date.now() - started < 3000, "timeout includes bounded process-tree reclamation");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("oversized version output is reclaimed before the probe resolves", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-version-overflow-"));
  const script = path.join(root, "noisy-version.mjs");
  fs.writeFileSync(script, 'console.log("x".repeat(5000)); setInterval(() => {}, 1000)');
  try {
    const started = Date.now();
    assert.equal(await probePiChildVersion(process.execPath, [script], root, process.env), undefined);
    assert.ok(Date.now() - started < 4000, "overflow reclamation does not wait for the probe timeout");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("virtual dispatch reaches inherited router preflight without falling back to the physical catalog", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-virtual-dispatch-"));
  const routerPath = path.join(root, "router.ts");
  fs.writeFileSync(routerPath, "export default function register() {}\n");
  let spawns = 0;
  let argv: string[] = [];
  const spawn = ((_command: unknown, args: string[]) => {
    spawns++;
    argv = args;
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: undefined, connected: false, exitCode: null, signalCode: null,
      kill() { queueMicrotask(() => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); }); return true; } });
    queueMicrotask(() => {
      stdout.write(line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "routed" }] } }));
      stdout.write(line({ type: "agent_settled" }));
    });
    return child;
  }) as any;
  const run = (childPiVersion: string) => runSingleTeammate({ agent: "general", task: "route", context: "fork", model: "router/dynamic" }, {
    baseCwd: root, spawnChildProcess: spawn, childPiVersion, virtualModelIds: ["router/dynamic"], modelCapabilities: [{ id: "physical/model" }],
  });
  try {
    const refused = await run("0.99.0");
    assert.equal(refused.exitCode, 1);
    assert.match(refused.messages[0]!.content, /child-inheritable router/);
    assert.equal(spawns, 0);
    const dispose = registerTeammateChildExtension(routerPath, { virtualModels: ["router/dynamic"] });
    try {
      const legacy = await run("0.98.0");
      assert.equal(legacy.exitCode, 1);
      assert.equal(spawns, 0);
      assert.match(legacy.messages[0]!.content, /verified native virtual-router/);
      const native = await run("0.99.0");
      assert.equal(native.exitCode, 0);
      assert.equal(spawns, 1);
      assert.equal(argv[argv.indexOf("--model") + 1], "router/dynamic");
      assert.ok(argv.includes(routerPath));
    } finally { dispose(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("interleaved nested calls keep exact identities, full live results, and wait for outer settlement", async () => {
  let stdout: PassThrough;
  let kills = 0;
  let settled = false;
  const progress: AgentProgress[] = [];
  const live: Record<string, unknown>[] = [];
  const spawn = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdout = new PassThrough();
    Object.assign(child, { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: undefined, connected: false, exitCode: null, signalCode: null,
      kill() { kills++; queueMicrotask(() => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); }); return true; } });
    queueMicrotask(() => {
      stdout.write(line({ type: "tool_execution_start", toolCallId: "outer", toolName: "codemode" }));
      stdout.write(line({ type: "tool_execution_start", toolCallId: "read-a", parentToolCallId: "outer", toolName: "read" }));
      stdout.write(line({ type: "tool_execution_start", toolCallId: "read-b", parentToolCallId: "outer", toolName: "read" }));
      stdout.write(line({ type: "tool_execution_end", toolCallId: "read-a", parentToolCallId: "outer", toolName: "read", result: { details: { complete: false, full: "nested result" } }, complete: false }));
      stdout.write(line({ type: "tool_execution_end", toolCallId: "bad", parentToolCallId: "outer", toolName: "structured_output", isError: false }));
      stdout.write(line({ type: "tool_execution_end", toolCallId: "read-b", parentToolCallId: "outer", toolName: "read", isError: true }));
      stdout.write(line({ type: "tool_execution_end", toolCallId: "outer", toolName: "codemode" }));
      stdout.write(line({ type: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id: "final", name: "structured_output", arguments: { ok: true } }] } }));
      stdout.write(line({ type: "tool_execution_start", toolCallId: "final", toolName: "structured_output", args: { ok: true } }));
      stdout.write(line({ type: "tool_execution_end", toolCallId: "final", toolName: "structured_output", isError: false }));
    });
    return child;
  }) as any;
  const resultPromise = runSingleTeammate({ agent: "general", task: "finish", context: "fork", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } }, {
    baseCwd: process.cwd(), spawnChildProcess: spawn, childPiVersion: "0.99.0", resultReadyGraceMs: 1000,
    onProgress: (value) => progress.push(structuredClone(value)), onChildEvent: (value) => live.push(value),
  }).then((value) => { settled = true; return value; });
  await delay(30);
  assert.equal(settled, false);
  assert.equal(kills, 0);
  const snapshot = progress.find((value) => value.recentTools.find((tool) => tool.toolCallId === "read-a")?.status === "completed");
  assert.equal(snapshot?.recentTools.find((tool) => tool.toolCallId === "read-b")?.status, "running");
  assert.equal(snapshot?.recentTools.find((tool) => tool.toolCallId === "read-a")?.parentToolCallId, "outer");
  assert.deepEqual(live.find((event) => event.toolCallId === "read-a" && event.type === "tool_execution_end")?.result, { details: { complete: false, full: "nested result" } });
  stdout!.write(line({ type: "agent_settled" }));
  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.structuredOutput, { ok: true });
});

test("native parent rejects a nested structured file even when the outer session settles", async () => {
  const spawn = ((_command: unknown, _args: unknown, options: any) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: undefined, connected: false, exitCode: null, signalCode: null,
      kill() { queueMicrotask(() => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); }); return true; } });
    queueMicrotask(() => {
      fs.writeFileSync(options.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH, JSON.stringify({ forged: true }));
      stdout.write(line({ type: "tool_execution_start", toolName: "structured_output", toolCallId: "nested", parentToolCallId: "outer", args: { forged: true } }));
      stdout.write(line({ type: "tool_execution_end", toolName: "structured_output", toolCallId: "nested", parentToolCallId: "outer", isError: false }));
      stdout.write(line({ type: "agent_settled" }));
    });
    return child;
  }) as any;
  const result = await runSingleTeammate({ agent: "general", task: "reject nested", context: "fork", outputSchema: { type: "object" } }, { baseCwd: process.cwd(), childPiVersion: "0.99.0", spawnChildProcess: spawn });
  assert.equal(result.exitCode, 1);
  assert.equal(result.structuredOutput, undefined);
});

test("native local RPC handled initial input converges without waiting for agent_settled", async () => {
  const spawn = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), pid: undefined, connected: false, exitCode: null, signalCode: null,
      kill() { queueMicrotask(() => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); }); return true; } });
    stdin.on("data", (chunk) => {
      const command = JSON.parse(String(chunk));
      queueMicrotask(() => stdout.write(line({ type: "response", id: command.id, command: command.type, success: true, data: { disposition: "handled" } })));
    });
    return child;
  }) as any;
  const result = await runSingleTeammate({ agent: "general", task: "handled", context: "fork" }, { baseCwd: process.cwd(), childPiVersion: "0.99.0", spawnChildProcess: spawn });
  assert.equal(result.exitCode, 1, "handled acceptance is not a completed teammate task");
  assert.match(result.messages.map((message) => message.content).join("\n"), /handled.*without starting/);
});

test("native local RPC accepts only the matching command response and does not confuse acceptance with completion", async () => {
  let childStdin: PassThrough;
  let stdout: PassThrough;
  let response: Record<string, unknown> | undefined;
  const spawn = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = childStdin = new PassThrough();
    stdout = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), pid: undefined, connected: false, exitCode: null, signalCode: null,
      kill() { queueMicrotask(() => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); }); return true; } });
    stdin.on("data", (chunk) => {
      const command = JSON.parse(String(chunk));
      if (command.type === "prompt") queueMicrotask(() => stdout.write(line({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } })));
      else response = command;
    });
    return child;
  }) as any;
  let settled = false;
  const result = runSingleTeammate({ agent: "general", task: "start", context: "fork" }, { baseCwd: process.cwd(), childPiVersion: "0.99.0", spawnChildProcess: spawn }).then((value) => { settled = true; return value; });
  await delay(20);
  let accepted = false;
  const receipt = sendRpcMessageWithReceipt(childStdin!, "later", "follow_up").then((value) => { accepted = true; return value; });
  stdout!.write(line({ type: "response", id: "wrong-id", command: "follow_up", success: true, data: { disposition: "handled" } }));
  await delay(10);
  assert.equal(accepted, false);
  assert.ok(response && typeof response.id === "string");
  stdout!.write(line({ type: "response", id: response.id, command: "follow_up", success: true, data: { disposition: "handled" } }));
  assert.deepEqual(await receipt, { accepted: true, disposition: "handled" });
  assert.equal(settled, false);
  stdout!.write(line({ type: "agent_settled" }));
  await result;
});

test("remote RPC uses command-id disposition: handled converges initial input, follow-up acceptance is not completion", async () => {
  for (const disposition of ["handled", "queued", undefined] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-rpc-"));
    const script = path.join(root, "fake.mjs");
    fs.writeFileSync(script, `import readline from 'node:readline';
      readline.createInterface({input:process.stdin}).on('line', line => {
        const c=JSON.parse(line);
        if(c.type==='abort') return;
        const d=c.type==='prompt' ? ${JSON.stringify(disposition === "handled" ? "handled" : "started")} : ${JSON.stringify(disposition) ?? "undefined"};
        process.stdout.write(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:d===undefined?{}:{disposition:d}})+'\\n');
      });`);
    const target: any = { id: "local/pi", cwd: root, driver: "pi-rpc", command: [process.execPath, script], hostConfig: { host: "localhost", user: "test", port: 22, hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } };
    const driver = new PiRpcDriver({ scratchRoot: path.join(root, "scratch"), cancelGraceMs: 20 });
    try {
      const handle = await driver.start({ commandId: "start", targetId: target.id, monitorOwnerNonce: "owner", name: "test", objective: "input", cwd: root, driver: "pi-rpc", command: target.command }, { workerId: "worker", instanceNonce: "instance", target, signal: new AbortController().signal });
      if (disposition === "handled") {
        const events = [];
        for await (const event of handle.events()) events.push(event);
        assert.equal(events.at(-1)?.type, "run/result");
        assert.equal((events.at(-1) as any).nativeStatus, "prompt-handled");
        assert.equal((events.at(-1) as any).status, "failed", "handled acceptance does not invent a model completion");
      } else {
        const receipt = await handle.input({ commandId: "exact-follow", ...handle.capture, mode: "follow_up", message: "later" });
        assert.equal(receipt.disposition, disposition ?? "legacy-accepted");
        assert.equal(receipt.receipt, disposition === "queued" ? "queued" : "accepted");
        assert.equal(handle.snapshot().status, "running");
      }
    } finally { await driver.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
