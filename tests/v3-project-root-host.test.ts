import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { graphProjectScopeV3 } from "../extensions/project-root.ts";
import { readLatestV3Attempt } from "../src/v3/attempt.ts";
import { validateAuthorizationV4 } from "../src/v3/authorization.ts";
import { V3GraphHost } from "../src/v3/host.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { MockSubagents, completeChild } from "./helpers/mock-subagents.ts";

// Independent of registered-entry mocks: real Host, shadow, validation and apply.
// Only the child transport/preflight is synthetic; no SDK/model/provider is used.
test("explicit B project from parent A validates and applies shadow output only to B", { timeout: 15_000 }, async () => {
 const sandbox = await realpath(await mkdtemp(join(tmpdir(), "project-root-host-review-")));
 const parentA = join(sandbox, "project-a"), projectB = join(sandbox, "project-b"), runsDir = join(sandbox, "runs");
 const mock = new MockSubagents();
 try {
  await Promise.all([parentA, projectB, runsDir].map(path => mkdir(path)));
  await writeFile(join(parentA, "input.txt"), "A-input\n");
  await writeFile(join(parentA, "result.txt"), "A-untouched\n");
  await writeFile(join(projectB, "input.txt"), "B-input\n");
  await writeFile(join(projectB, "result.txt"), "B-before\n");
  await writeFile(join(projectB, "verify.cjs"), 'require("node:assert/strict").equal(require("node:fs").readFileSync("result.txt", "utf8"), "B-after\\n");\n');
  const parent = Object.freeze({ cwd: parentA, sessionId: "parent-session-a" });
  const selected = await graphProjectScopeV3("../project-b", parent.cwd);
  assert.equal(selected.explicit, true);
  assert.equal(selected.cwd, projectB);
  let childCwd: string | undefined;
  let sourceUnchangedBeforeApply = false;
  const preflightCwds: string[] = [];
  mock.behaviors.set("INDEPENDENT_PROJECT_B_WRITE", async input => {
   childCwd = input.cwd;
   assert.notEqual(input.cwd, parentA);
   assert.notEqual(input.cwd, projectB, "child must write shadow, never the target directly");
   assert.equal(await readFile(join(input.cwd, "input.txt"), "utf8"), "B-input\n");
   await writeFile(join(input.cwd, "result.txt"), "B-after\n");
   assert.equal(await readFile(join(projectB, "result.txt"), "utf8"), "B-before\n", "target is unchanged until real runner apply");
   assert.equal(await readFile(join(parentA, "result.txt"), "utf8"), "A-untouched\n");
   sourceUnchangedBeforeApply = true;
   await completeChild({ ...input, output: "independent B fixture finished" });
  });
  mock.start();
  const host = new V3GraphHost({
   rpc: new SubagentRpcClient(mock), runsDir, sessionId: parent.sessionId, supervisorEpoch: "independent-review",
   preflightAgent: async input => { preflightCwds.push(input.cwd); },
  });
  await selected.assertUnchanged();
  const handle = await host.start({
   schemaVersion: 3, graphId: "independent-explicit-b", goal: "verify target-only writeback",
   nodes: [{ taskId: "write-b", agent: "test-agent", task: "INDEPENDENT_PROJECT_B_WRITE", sideEffect: "local_write",
    readScope: [{ kind: "file", path: "input.txt" }, { kind: "file", path: "verify.cjs" }], writeScope: [{ kind: "file", path: "result.txt" }],
    validationCommands: ["node verify.cjs"],
   }],
  }, selected.cwd);
  const snapshot = await host.waitForCompletion(handle.graphId);
  assert.equal(snapshot.status, "complete", JSON.stringify((await readLatestV3Attempt(handle.runDir, "write-b"))?.evidence.failure));
  assert.equal(snapshot.nodes?.["write-b"]?.phase, "accepted");
  assert.equal(mock.spawned.length, 1);
  assert.ok(sourceUnchangedBeforeApply);
  assert.ok(childCwd);
  const shadowRelative = relative(join(handle.runDir, "shadow"), childCwd);
  assert.ok(shadowRelative && shadowRelative !== ".." && !shadowRelative.startsWith(".." + sep) && !isAbsolute(shadowRelative));
  assert.deepEqual(preflightCwds, [childCwd]);
  assert.equal(await readFile(join(projectB, "result.txt"), "utf8"), "B-after\n");
  assert.equal(await readFile(join(projectB, "input.txt"), "utf8"), "B-input\n");
  assert.equal(await readFile(join(parentA, "input.txt"), "utf8"), "A-input\n");
  assert.equal(await readFile(join(parentA, "result.txt"), "utf8"), "A-untouched\n");
  assert.equal(parent.cwd, parentA);
  const authorization = validateAuthorizationV4(JSON.parse(await readFile(join(handle.runDir, "authorization.json"), "utf8")));
  assert.equal(authorization.sourceCwd, projectB);
  assert.equal(authorization.sessionId, parent.sessionId);
  const attempt = (await readLatestV3Attempt(handle.runDir, "write-b"))!.evidence;
  assert.equal(attempt.phase, "accepted");
  assert.equal(attempt.verification?.allPassed, true);
  assert.deepEqual(attempt.applied?.writes.map(file => file.path), [join(projectB, "result.txt")]);
 } finally {
  await mock.dispose();
  await rm(sandbox, { recursive: true, force: true });
 }
});
