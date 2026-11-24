import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  handleProxyRequest,
  type TeammateRuntimeOptions,
} from "../src/extension/index.ts";
import type {
  ActiveAgent,
  Details,
  TeammateState,
} from "../src/shared/types.ts";

type CompletionMessage = {
  customType?: string;
  content?: string;
  details?: Details;
};

type ProxyReply = {
  type: "teammate_proxy_result";
  result: {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
    details: Details;
  };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class AsyncQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(value);
    else this.#values.push(value);
  }

  next(): Promise<T> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise<T>((resolve) => this.#waiters.push(resolve));
  }
}

function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 2_000);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createState(
  controlMessages: Array<Record<string, unknown>>,
  controlQueue: AsyncQueue<Record<string, unknown>>,
): { state: TeammateState; parentCid: string } {
  const parentCid = "nested-parallel-parent";
  const now = Date.now();
  const parent: ActiveAgent = {
    agent: "general",
    name: "parent",
    correlationId: parentCid,
    startedAt: now,
    sessionId: "nested-parent-session",
    runtimeGeneration: 7,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
    sendControl(message) {
      controlMessages.push(message);
      controlQueue.push(message);
      return true;
    },
  };
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: "nested-root-session",
    sessionGeneration: 11,
    activeRuns: new Map([[parentCid, parent]]),
    namedAgents: new Map([["parent", parentCid]]),
  };
  return { state, parentCid };
}

function createPi(
  sentMessages: CompletionMessage[],
  sentQueue: AsyncQueue<CompletionMessage>,
  graphSettled: ReturnType<typeof deferred<void>>,
): ExtensionAPI {
  return new Proxy({
    events: {
      on() { return () => {}; },
      emit(event: string) {
        if (event === "teammate:complete") graphSettled.resolve();
      },
    },
    sendMessage(message: CompletionMessage) {
      if (message.customType !== "teammate-complete") return;
      sentMessages.push(message);
      sentQueue.push(message);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  }) as unknown as ExtensionAPI;
}

function controlledSpawn() {
  const stdouts: PassThrough[] = [];
  const bothSpawned = deferred<void>();
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    stdouts.push(stdout);
    if (stdouts.length === 2) bothSpawned.resolve();
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
  return { spawnChildProcess, stdouts, bothSpawned: bothSpawned.promise };
}

function finish(stdout: PassThrough, text: string): void {
  stdout.write(`${JSON.stringify({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
    },
    toolResults: [],
  })}\n`);
  stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
}

const tasks = [
  { agent: "general", name: "first", prompt: "return first" },
  { agent: "general", name: "second", prompt: "return second" },
];

async function startBackground(replyTo: "caller" | "main") {
  const sentMessages: CompletionMessage[] = [];
  const sentQueue = new AsyncQueue<CompletionMessage>();
  const controlMessages: Array<Record<string, unknown>> = [];
  const controlQueue = new AsyncQueue<Record<string, unknown>>();
  const graphSettled = deferred<void>();
  const { state, parentCid } = createState(controlMessages, controlQueue);
  const { spawnChildProcess, stdouts, bothSpawned } = controlledSpawn();
  const replies: ProxyReply[] = [];

  await handleProxyRequest(
    createPi(sentMessages, sentQueue, graphSettled),
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: `nested-parallel-${replyTo}`,
      correlationId: parentCid,
      params: { tasks, background: true, reply_to: replyTo },
    },
    (message) => replies.push(message as ProxyReply),
    parentCid,
    [],
    undefined,
    undefined,
    { spawnChildProcess },
  );

  await withTimeout(bothSpawned, "both nested parallel children to spawn");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.result.details.mode, "parallel");
  assert.deepEqual(replies[0]?.result.details.results, []);
  return {
    sentMessages,
    controlMessages,
    graphSettled: graphSettled.promise,
    stdouts,
    nextSent: () => sentQueue.next(),
    nextControl: () => controlQueue.next(),
  };
}

test("nested background parallel completion routes each result only to the caller", async () => {
  const run = await startBackground("caller");

  finish(run.stdouts[0]!, "first caller result");
  const firstControl = await withTimeout(run.nextControl(), "first caller completion");
  assert.equal(firstControl.type, "teammate_complete_delivery");
  assert.equal(firstControl.correlationId, "nested-parallel-parent");
  assert.equal(firstControl.sessionId, "nested-parent-session");
  assert.equal(firstControl.runtimeGeneration, 7);
  const firstEnvelope = firstControl.envelope as CompletionMessage;
  assert.deepEqual(firstEnvelope.details?.results.map((result) => result.name), ["first"]);
  assert.match(firstEnvelope.content ?? "", /first caller result/);
  assert.match(firstEnvelope.content ?? "", /Parallel status: 1\/2 results ready/);
  assert.equal(run.sentMessages.length, 0, "caller-targeted completion must not leak into root main");

  finish(run.stdouts[1]!, "second caller result");
  const secondControl = await withTimeout(run.nextControl(), "second caller completion");
  const secondEnvelope = secondControl.envelope as CompletionMessage;
  assert.deepEqual(secondEnvelope.details?.results.map((result) => result.name), ["second"]);
  assert.match(secondEnvelope.content ?? "", /second caller result/);
  assert.match(secondEnvelope.content ?? "", /Parallel status: 2\/2 results ready/);

  await withTimeout(run.graphSettled, "nested parallel graph lifecycle settlement");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(run.controlMessages.length, 2, "final graph settlement must not send an aggregate duplicate");
  assert.equal(run.sentMessages.length, 0, "caller results remain isolated from root main");
});

test("nested background parallel completion routes each result only to main", async () => {
  const run = await startBackground("main");

  finish(run.stdouts[0]!, "first main result");
  const first = await withTimeout(run.nextSent(), "first main completion");
  assert.deepEqual(first.details?.results.map((result) => result.name), ["first"]);
  assert.match(first.content ?? "", /Parallel status: 1\/2 results ready/);
  assert.equal(run.controlMessages.length, 0);

  finish(run.stdouts[1]!, "second main result");
  const second = await withTimeout(run.nextSent(), "second main completion");
  assert.deepEqual(second.details?.results.map((result) => result.name), ["second"]);
  assert.match(second.content ?? "", /Parallel status: 2\/2 results ready/);

  await withTimeout(run.graphSettled, "nested parallel graph lifecycle settlement");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(run.sentMessages.length, 2, "final graph settlement must not send an aggregate duplicate");
  assert.equal(run.controlMessages.length, 0, "main-targeted completion must not be sent to the child caller");
});
