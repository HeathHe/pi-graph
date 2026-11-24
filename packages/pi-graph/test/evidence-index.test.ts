import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  collectEvidenceReceipts,
  mergeEvidenceReceipts,
  normalizeEvidenceReceipts,
  renderEvidenceIndexLines,
  type EvidenceReceipt,
} from "../src/compaction/evidence-index.ts";
import {
  createMaestroCompaction,
  type MaestroCompactionDetails,
} from "../src/compaction/maestro-compaction.ts";
import {
  initTodo,
  onSessionShutdown,
  onSessionStart,
} from "../src/tools/todo.ts";

function assistantCall(id: string, callId: string, name: string, args: Record<string, unknown>): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-07-12T02:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: args }],
    },
  } as never;
}

function toolResult(id: string, callId: string, toolName: string, text: string, isError = false): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-07-12T02:00:01.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content: [{ type: "text", text }],
      isError,
    },
  } as never;
}

test("collectEvidenceReceipts derives a read receipt with its line range and session URI", () => {
  const receipts = collectEvidenceReceipts({
    sessionId: "s-1",
    branchEntries: [
      assistantCall("e1", "c1", "read", { path: "src/foo.ts", offset: 120, limit: 81 }),
      toolResult("e2", "c1", "read", "file body"),
    ],
    firstKeptEntryId: "missing",
  });
  assert.equal(receipts.length, 1);
  const receipt = receipts[0]!;
  assert.equal(receipt.kind, "read");
  assert.equal(receipt.entryId, "e2");
  assert.equal(receipt.uri, "session://s-1/entry/e2");
  assert.equal(receipt.target, "src/foo.ts");
  assert.equal(receipt.detail, "offset=120 limit=81");
  assert.equal(receipt.preview, "file body");
});

test("collectEvidenceReceipts keeps entries after firstKeptEntryId out of the index", () => {
  const receipts = collectEvidenceReceipts({
    sessionId: "s-1",
    branchEntries: [
      assistantCall("e1", "c1", "read", { path: "src/dropped.ts" }),
      toolResult("e2", "c1", "read", "dropped"),
      { type: "thinking_level_change", id: "kept-1", parentId: "e2", timestamp: "t", thinkingLevel: "high" } as never,
      assistantCall("e3", "c2", "read", { path: "src/kept.ts" }),
      toolResult("e4", "c2", "read", "kept"),
    ],
    firstKeptEntryId: "kept-1",
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.target, "src/dropped.ts");
});

test("collectEvidenceReceipts indexes every entry when the boundary is synthetic (new-context)", () => {
  const receipts = collectEvidenceReceipts({
    sessionId: "s-1",
    branchEntries: [
      assistantCall("e1", "c1", "read", { path: "a.ts" }),
      toolResult("e2", "c1", "read", "body"),
    ],
    firstKeptEntryId: "new-context-boundary",
  });
  assert.equal(receipts.length, 1);
});

test("collectEvidenceReceipts dedups a repeated identical read to the newest entry", () => {
  const receipts = collectEvidenceReceipts({
    sessionId: "s-1",
    branchEntries: [
      assistantCall("e1", "c1", "read", { path: "a.ts", offset: 1, limit: 10 }),
      toolResult("e2", "c1", "read", "v1"),
      assistantCall("e3", "c2", "read", { path: "a.ts", offset: 1, limit: 10 }),
      toolResult("e4", "c2", "read", "v2"),
    ],
    firstKeptEntryId: "missing",
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.entryId, "e4");
});

test("collectEvidenceReceipts keeps distinct read ranges of the same file", () => {
  const receipts = collectEvidenceReceipts({
    sessionId: "s-1",
    branchEntries: [
      assistantCall("e1", "c1", "read", { path: "a.ts", offset: 1, limit: 10 }),
      toolResult("e2", "c1", "read", "first"),
      assistantCall("e3", "c2", "read", { path: "a.ts", offset: 50, limit: 10 }),
      toolResult("e4", "c2", "read", "second"),
    ],
    firstKeptEntryId: "missing",
  });
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map((receipt) => receipt.detail), ["offset=1 limit=10", "offset=50 limit=10"]);
});

test("collectEvidenceReceipts captures edit counts, write sizes, and command heads", () => {
  const receipts = collectEvidenceReceipts({
    sessionId: "s-1",
    branchEntries: [
      assistantCall("e1", "c1", "edit", { path: "a.ts", edits: [{ old: "x", new: "y" }, { old: "p", new: "q" }] }),
      toolResult("e2", "c1", "edit", "ok"),
      assistantCall("e3", "c2", "write", { path: "b.ts", content: "x".repeat(100) }),
      toolResult("e4", "c2", "write", "ok"),
      assistantCall("e5", "c3", "bash", { command: "maestro   search\n foo" }),
      toolResult("e6", "c3", "bash", "0 hits"),
    ],
    firstKeptEntryId: "missing",
  });
  assert.deepEqual(
    receipts.map((receipt) => [receipt.kind, receipt.target, receipt.detail]),
    [
      ["edit", "a.ts", "edits=2"],
      ["edit", "b.ts", "write 100 chars"],
      ["command", "maestro search foo", undefined],
    ],
  );
});

test("collectEvidenceReceipts marks failed results with the first error line", () => {
  const receipts = collectEvidenceReceipts({
    sessionId: "s-1",
    branchEntries: [
      assistantCall("e1", "c1", "bash", { command: "npm test" }),
      toolResult("e2", "c1", "bash", "\n\nError: boom\nstack", true),
    ],
    firstKeptEntryId: "missing",
  });
  assert.equal(receipts[0]!.kind, "command");
  assert.equal(receipts[0]!.error, "Error: boom");
  assert.equal(receipts[0]!.preview, undefined);
});

test("collectEvidenceReceipts skips state tools and pairs orphan results via toolName", () => {
  const receipts = collectEvidenceReceipts({
    sessionId: "s-1",
    branchEntries: [
      assistantCall("e1", "c1", "todo", { action: "list" }),
      toolResult("e2", "c1", "todo", "tasks"),
      assistantCall("e3", "c2", "session_history", { action: "search" }),
      toolResult("e4", "c2", "session_history", "matches"),
      assistantCall("e5", "c3", "plan-status", {}),
      toolResult("e6", "c3", "plan-status", "empty"),
      toolResult("e7", "unknown-call", "read", "orphan result"),
    ],
    firstKeptEntryId: "missing",
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.tool, "read");
  assert.equal(receipts[0]!.target, "read");
  assert.equal(receipts[0]!.entryId, "e7");
});

test("collectEvidenceReceipts caps the index at the newest receipts", () => {
  const entries: SessionEntry[] = [];
  for (let index = 0; index < 10; index++) {
    entries.push(
      assistantCall(`call-${index}`, `c-${index}`, "read", { path: `f-${index}.ts` }),
      toolResult(`result-${index}`, `c-${index}`, "read", "body"),
    );
  }
  const receipts = collectEvidenceReceipts({ sessionId: "s-1", branchEntries: entries, limit: 4 });
  assert.equal(receipts.length, 4);
  assert.deepEqual(receipts.map((receipt) => receipt.entryId), ["result-6", "result-7", "result-8", "result-9"]);
});

test("mergeEvidenceReceipts supersedes identical calls and preserves distinct history", () => {
  const inherited: EvidenceReceipt[] = [
    { entryId: "old-1", uri: "session://s-1/entry/old-1", kind: "read", tool: "read", target: "a.ts", detail: "offset=1 limit=10" },
    { entryId: "old-2", uri: "session://s-1/entry/old-2", kind: "command", tool: "bash", target: "npm test" },
  ];
  const current: EvidenceReceipt[] = [
    { entryId: "new-1", uri: "session://s-1/entry/new-1", kind: "read", tool: "read", target: "a.ts", detail: "offset=1 limit=10" },
  ];
  const merged = mergeEvidenceReceipts(inherited, current);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((receipt) => receipt.tool === "read")?.entryId, "new-1");
  assert.equal(merged.find((receipt) => receipt.tool === "bash")?.entryId, "old-2");
});

test("mergeEvidenceReceipts enforces the cap across compactions", () => {
  const inherited: EvidenceReceipt[] = Array.from({ length: 70 }, (_, index) => ({
    entryId: `old-${index}`, uri: `u${index}`, kind: "read", tool: "read", target: `f-${index}.ts`,
  }));
  const merged = mergeEvidenceReceipts(inherited, [], 64);
  assert.equal(merged.length, 64);
  assert.equal(merged.at(-1)!.entryId, "old-69");
});

test("renderEvidenceIndexLines renders a bounded section with an omitted count", () => {
  const receipts: EvidenceReceipt[] = Array.from({ length: 30 }, (_, index) => ({
    entryId: `e-${index}`, uri: `session://s-1/entry/e-${index}`, kind: "read" as const,
    tool: "read", target: `f-${index}.ts`, detail: `offset=1 limit=${index + 1}`, preview: `line one of f-${index}`,
  }));
  receipts.push({ entryId: "err", uri: "session://s-1/entry/err", kind: "command", tool: "bash", target: "npm test", error: "Error: boom" });
  const lines = renderEvidenceIndexLines(receipts, 3);
  assert.match(lines[0]!, /## Evidence Index/);
  assert.match(lines[1]!, /31 dropped tool result/);
  assert.match(lines[1]!, /pass the exact session:\/\/ URI to the resource tool/);
  assert.match(lines[2]!, /- read f-28\.ts offset=1 limit=29 → line one of f-28 — session:\/\/s-1\/entry\/e-28/);
  assert.match(lines.at(-2)!, /- bash npm test \[error: Error: boom\] — session:\/\/s-1\/entry\/err/);
  assert.match(lines.at(-1)!, /28 earlier receipt\(s\) omitted/);
  assert.deepEqual(renderEvidenceIndexLines([]), []);
});

test("normalizeEvidenceReceipts filters malformed receipts and clears empty input", () => {
  assert.equal(normalizeEvidenceReceipts("nope"), undefined);
  assert.equal(normalizeEvidenceReceipts([]), undefined);
  const normalized = normalizeEvidenceReceipts([
    { entryId: "e1", uri: "session://s/e1", kind: "read", tool: "read", target: "a.ts", detail: "L1-2" },
    { entryId: "", uri: "session://s/e2", kind: "read", tool: "read", target: "b.ts" },
    { entryId: "e3", uri: "session://s/e3", kind: "bogus", tool: "read", target: "c.ts" },
    "junk",
  ]);
  assert.equal(normalized?.length, 1);
  assert.equal(normalized?.[0]?.entryId, "e1");
});

function compactionFixture(branchEntries: SessionEntry[], dependencies: Record<string, unknown> = {}) {
  initTodo({ appendEntry() {} } as never);
  const todoContext = {
    cwd: "D:\\repo",
    ui: { setStatus() {} },
    sessionManager: { getEntries: () => [] },
  };
  onSessionStart(todoContext);
  return {
    todoContext,
    event: {
      preparation: {
        firstKeptEntryId: "kept-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
      },
      branchEntries,
      signal: new AbortController().signal,
      type: "session_before_compact",
    } as never,
    ctx: {
      cwd: "D:\\repo",
      model: { id: "faux", maxTokens: 2000 },
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify() {}, setStatus() {} },
    } as never,
    dependencies: {
      checkpointId: () => "checkpoint-evidence",
      now: () => new Date("2026-07-12T02:30:00.000Z"),
      ...dependencies,
    },
  };
}

test("createMaestroCompaction attaches categorized receipts and appends the index to the summary", async () => {
  const fixture = compactionFixture([
    assistantCall("e1", "c1", "read", { path: "src/foo.ts", offset: 10, limit: 20 }),
    toolResult("e2", "c1", "read", "body"),
    assistantCall("e3", "c2", "bash", { command: "npm test" }),
    toolResult("e4", "c2", "bash", "pass", true),
  ], {
    completeSummary: async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "## Session\n- Current Objective: continue" }],
    }),
  });
  try {
    const result = await createMaestroCompaction(fixture.event, fixture.ctx, fixture.dependencies as never);
    const details = result?.compaction?.details as MaestroCompactionDetails;
    assert.equal(details.evidenceIndex?.length, 2);
    assert.equal(details.evidenceIndex?.[0]?.detail, "offset=10 limit=20");
    assert.equal(details.evidenceIndex?.[1]?.kind, "command");
    assert.match(result?.compaction?.summary ?? "", /## Evidence Index/);
    assert.match(result?.compaction?.summary ?? "", /session:\/\/session-1\/entry\/e2/);
  } finally {
    onSessionShutdown(fixture.todoContext);
  }
});

test("createMaestroCompaction appends the index to deterministic summary overrides", async () => {
  const fixture = compactionFixture([
    assistantCall("e1", "c1", "read", { path: "src/foo.ts" }),
    toolResult("e2", "c1", "read", "body"),
  ], {
    summaryOverride: "capsule body",
    firstKeptEntryIdOverride: "new-context-boundary",
  });
  try {
    const result = await createMaestroCompaction(fixture.event, fixture.ctx, fixture.dependencies as never);
    const summary = result?.compaction?.summary ?? "";
    assert.match(summary, /^capsule body\n\n## Evidence Index/);
    assert.equal(result?.compaction?.firstKeptEntryId, "new-context-boundary");
    const details = result?.compaction?.details as MaestroCompactionDetails;
    assert.equal(details.evidenceIndex?.[0]?.uri, "session://session-1/entry/e2");
  } finally {
    onSessionShutdown(fixture.todoContext);
  }
});

test("createMaestroCompaction inherits receipts from the previous checkpoint", async () => {
  const previous: MaestroCompactionDetails = {
    kind: "maestro-session-checkpoint",
    schemaVersion: 4,
    checkpointId: "checkpoint-old",
    sessionId: "session-1",
    projectRoot: "D:\\repo",
    createdAt: "2026-07-12T01:00:00.000Z",
    todo: { stateVersion: 2, revision: 0, tasks: [] } as never,
    activeSkills: [],
    references: [],
    knowhowPath: "D:\\repo\\KNW-old.md",
    evidenceIndex: [
      { entryId: "old-e", uri: "session://session-1/entry/old-e", kind: "edit", tool: "edit", target: "old.ts" },
      "malformed" as never,
    ],
  };
  const fixture = compactionFixture([
    {
      type: "compaction",
      id: "previous-entry",
      parentId: "parent-entry",
      timestamp: "2026-07-12T02:00:00.000Z",
      summary: "previous",
      firstKeptEntryId: "previous-kept",
      tokensBefore: 900,
      details: previous,
    } as never,
    assistantCall("e1", "c1", "read", { path: "src/new.ts" }),
    toolResult("e2", "c1", "read", "body"),
  ], {
    completeSummary: async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "## Session\n- Current Objective: continue" }],
    }),
  });
  try {
    const result = await createMaestroCompaction(fixture.event, fixture.ctx, fixture.dependencies as never);
    const details = result?.compaction?.details as MaestroCompactionDetails;
    assert.equal(details.evidenceIndex?.length, 2);
    assert.equal(details.evidenceIndex?.find((receipt) => receipt.tool === "edit")?.entryId, "old-e");
    assert.equal(details.evidenceIndex?.find((receipt) => receipt.tool === "read")?.entryId, "e2");
  } finally {
    onSessionShutdown(fixture.todoContext);
  }
});
