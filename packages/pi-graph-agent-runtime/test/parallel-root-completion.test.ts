import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test, { afterEach } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTeammateExtension, {
  type TeammateRuntimeOptions,
} from "../src/extension/index.ts";
import { getCompletionDurabilityRegistry } from "../src/public/v1/completion-durability.ts";
import type { Details } from "../src/shared/types.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Details;
};

type RegisteredTeammateTool = {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: ((result: ToolResult) => void) | undefined,
    ctx: Record<string, unknown>,
  ): Promise<ToolResult>;
};

type SentMessage = {
  customType?: string;
  content?: string;
  details?: Details;
};

const ROOT_REGISTRY_KEY = Symbol.for("pi-graph-teammate.root-registry");

function resetRootRegistry(): void {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[ROOT_REGISTRY_KEY];
}

afterEach(resetRootRegistry);

function controlledSpawn(): {
  spawnChildProcess: NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  stdouts: PassThrough[];
} {
  const stdouts: PassThrough[] = [];
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    stdouts.push(stdout);
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  return { spawnChildProcess, stdouts };
}

function createRootTool(
  runtimeOptions: TeammateRuntimeOptions,
  sentMessages: SentMessage[],
  emittedEvents: string[],
): RegisteredTeammateTool {
  resetRootRegistry();
  let teammateTool: RegisteredTeammateTool | undefined;
  const pi = new Proxy({
    events: {
      on: () => () => {},
      emit(event: string) { emittedEvents.push(event); },
    },
    registerTool(tool: RegisteredTeammateTool & { name: string }) {
      if (tool.name === "teammate") teammateTool = tool;
    },
    sendMessage(message: SentMessage) {
      sentMessages.push(message);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const previousDepth = process.env.PI_TEAMMATE_DEPTH;
  delete process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_DEPTH;
  try {
    registerTeammateExtension(pi as unknown as ExtensionAPI, runtimeOptions);
  } finally {
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
    if (previousDepth === undefined) delete process.env.PI_TEAMMATE_DEPTH;
    else process.env.PI_TEAMMATE_DEPTH = previousDepth;
  }
  assert.ok(teammateTool);
  return teammateTool;
}

function rootContext(): Record<string, unknown> {
  return {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: {
      getSessionId: () => "parallel-root-completion-session",
      getSessionFile: () => undefined,
    },
  };
}

function finish(stdout: PassThrough, text: string): void {
  stdout.write(`${JSON.stringify({
    type: "agent_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  })}\n`);
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const parallelTasks = [
  { agent: "general", name: "first", prompt: "return first" },
  { agent: "general", name: "second", prompt: "return second" },
];

test("non-durable root background parallel completion sends one model message per result", async () => {
  assert.equal(getCompletionDurabilityRegistry().current(), undefined, "test requires no durability provider");
  const sentMessages: SentMessage[] = [];
  const emittedEvents: string[] = [];
  const { spawnChildProcess, stdouts } = controlledSpawn();
  const tool = createRootTool({ spawnChildProcess }, sentMessages, emittedEvents);

  const dispatch = await tool.execute(
    "parallel-background",
    { tasks: parallelTasks, background: true },
    new AbortController().signal,
    undefined,
    rootContext(),
  );

  assert.equal(dispatch.details.mode, "parallel");
  assert.deepEqual(dispatch.details.results, []);
  await waitFor(() => stdouts.length === 2, "both parallel children to spawn");

  finish(stdouts[0]!, "first result");
  await waitFor(
    () => sentMessages.filter((message) => message.customType === "teammate-complete").length === 1,
    "the first per-task completion message",
  );

  const first = sentMessages.filter((message) => message.customType === "teammate-complete")[0]!;
  assert.deepEqual(first.details?.results.map((result) => result.name), ["first"]);
  assert.match(first.content ?? "", /first result/);
  assert.doesNotMatch(first.content ?? "", /second result/);
  assert.match(first.content ?? "", /Parallel status: 1\/2 results ready/);

  finish(stdouts[1]!, "second result");
  await waitFor(
    () => sentMessages.filter((message) => message.customType === "teammate-complete").length === 2,
    "the second per-task completion message",
  );

  const second = sentMessages.filter((message) => message.customType === "teammate-complete")[1]!;
  assert.deepEqual(second.details?.results.map((result) => result.name), ["second"]);
  assert.match(second.content ?? "", /second result/);
  assert.doesNotMatch(second.content ?? "", /first result/);
  assert.match(second.content ?? "", /Parallel status: 2\/2 results ready/);

  await waitFor(
    () => emittedEvents.filter((event) => event === "teammate:complete").length === 1,
    "the final graph settlement event",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    sentMessages.filter((message) => message.customType === "teammate-complete").length,
    2,
    "final graph settlement must not send a third aggregate model message",
  );
});

test("non-durable root foreground parallel completion returns one aggregate and no passive messages", async () => {
  assert.equal(getCompletionDurabilityRegistry().current(), undefined, "test requires no durability provider");
  const sentMessages: SentMessage[] = [];
  const emittedEvents: string[] = [];
  const { spawnChildProcess, stdouts } = controlledSpawn();
  const tool = createRootTool({ spawnChildProcess }, sentMessages, emittedEvents);

  const execution = tool.execute(
    "parallel-foreground",
    { tasks: parallelTasks, background: false, timeoutMs: 60_000 },
    new AbortController().signal,
    undefined,
    rootContext(),
  );
  await waitFor(() => stdouts.length === 2, "both foreground parallel children to spawn");
  finish(stdouts[0]!, "first foreground result");
  finish(stdouts[1]!, "second foreground result");

  const result = await execution;
  assert.equal(result.details.mode, "parallel");
  assert.deepEqual(result.details.results.map((entry) => entry.name), ["first", "second"]);
  assert.match(result.content[0]?.text ?? "", /\[general\/first\]/);
  assert.match(result.content[0]?.text ?? "", /\[general\/second\]/);
  assert.deepEqual(sentMessages, []);
});

test("root parallel detach flushes an early result once and then sends each later result", async () => {
  const sentMessages: SentMessage[] = [];
  const emittedEvents: string[] = [];
  const { spawnChildProcess, stdouts } = controlledSpawn();
  const tool = createRootTool({ spawnChildProcess }, sentMessages, emittedEvents);
  let detach: ((data: string) => void) | undefined;
  const execution = tool.execute(
    "parallel-detach",
    { tasks: parallelTasks, background: false, timeoutMs: 60_000 },
    new AbortController().signal,
    undefined,
    {
      ...rootContext(),
      hasUI: true,
      ui: { onTerminalInput(handler: (data: string) => void) { detach = handler; return () => {}; } },
    },
  );
  await waitFor(() => stdouts.length === 2 && detach !== undefined, "parallel children and detach handler");
  stdouts[0]!.write(`${JSON.stringify({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "early result" }],
    },
    toolResults: [],
  })}\n`);
  await waitFor(() => emittedEvents.includes("teammate:result-published"), "first child publication");
  assert.equal(sentMessages.length, 0, "foreground must buffer first result");
  detach!("\x1bb");
  const ack = await execution;
  assert.match(ack.content[0]?.text ?? "", /detached/);
  await waitFor(() => sentMessages.length === 1, "buffered completion after detach");
  assert.match(sentMessages[0]?.content ?? "", /Parallel status: 1\/2 results ready/);
  stdouts[0]!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  stdouts[0]!.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  finish(stdouts[1]!, "late result");
  await waitFor(() => sentMessages.length === 2, "late completion");
  assert.match(sentMessages[1]?.content ?? "", /Parallel status: 2\/2 results ready/);
});

test("root concurrency-one parallel dispatch delivers results independently", async () => {
  const sentMessages: SentMessage[] = [];
  const { spawnChildProcess, stdouts } = controlledSpawn();
  const tool = createRootTool({ spawnChildProcess }, sentMessages, []);
  const ack = await tool.execute(
    "parallel-serial-capacity",
    { tasks: parallelTasks, background: true, concurrency: 1 },
    new AbortController().signal,
    undefined,
    rootContext(),
  );
  assert.equal(ack.details.mode, "parallel");
  await waitFor(() => stdouts.length === 1, "first capacity slot");
  finish(stdouts[0]!, "first capacity result");
  await waitFor(() => sentMessages.length === 1 && stdouts.length === 2, "first completion and second slot");
  assert.match(sentMessages[0]?.content ?? "", /Parallel status: 1\/2 results ready/);
  finish(stdouts[1]!, "second capacity result");
  await waitFor(() => sentMessages.length === 2, "second completion");
  assert.match(sentMessages[1]?.content ?? "", /Parallel status: 2\/2 results ready/);
});

test("root dependency chain retains one aggregate completion", async () => {
  const sentMessages: SentMessage[] = [];
  const { spawnChildProcess, stdouts } = controlledSpawn();
  const tool = createRootTool({ spawnChildProcess }, sentMessages, []);
  const ack = await tool.execute(
    "dependent-chain",
    {
      tasks: [parallelTasks[0], { ...parallelTasks[1], dependsOn: ["first"] }],
      background: true,
    },
    new AbortController().signal,
    undefined,
    rootContext(),
  );
  assert.equal(ack.details.mode, "chain");
  await waitFor(() => stdouts.length === 1, "first chain child");
  finish(stdouts[0]!, "first chain result");
  await waitFor(() => stdouts.length === 2, "dependent chain child");
  assert.equal(sentMessages.length, 0, "chain must not notify per task");
  finish(stdouts[1]!, "second chain result");
  await waitFor(() => sentMessages.length === 1, "chain aggregate completion");
  assert.equal(sentMessages[0]?.details?.results.length, 2);
});

test("root DAG graph retains one aggregate completion", async () => {
  const sentMessages: SentMessage[] = [];
  const { spawnChildProcess, stdouts } = controlledSpawn();
  const tool = createRootTool({ spawnChildProcess }, sentMessages, []);
  const ack = await tool.execute(
    "dependent-dag",
    {
      tasks: [
        parallelTasks[0],
        parallelTasks[1],
        { agent: "general", name: "combine", prompt: "combine", dependsOn: ["first", "second"] },
      ],
      background: true,
    },
    new AbortController().signal,
    undefined,
    rootContext(),
  );
  assert.equal(ack.details.mode, "graph");
  await waitFor(() => stdouts.length === 2, "independent DAG inputs");
  finish(stdouts[0]!, "first DAG result");
  finish(stdouts[1]!, "second DAG result");
  await waitFor(() => stdouts.length === 3, "DAG dependent child");
  assert.equal(sentMessages.length, 0);
  finish(stdouts[2]!, "combined result");
  await waitFor(() => sentMessages.length === 1, "DAG aggregate completion");
  assert.equal(sentMessages[0]?.details?.results.length, 3);
});
