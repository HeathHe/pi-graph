import test from "node:test";
import assert from "node:assert/strict";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readChildModelPolicy } from "../src/runtime/child-model-policy.ts";

test("isolated runner replaces ambient Pi configuration with an empty private agent directory", async () => {
 const sandbox = process.env.PI_GRAPH_TEST_SANDBOX_ROOT;
 assert.ok(sandbox);
 assert.equal(resolve(process.env.PI_CODING_AGENT_DIR!), resolve(join(sandbox, "pi-agent")));
 const files = await readdir(process.env.PI_CODING_AGENT_DIR!);
 for (const name of ["settings.json", "auth.json", "models.json", "ambient-marker"]) assert.equal(files.includes(name), false, `Ambient ${name} must not be copied`);
 const cwd = await mkdtemp(join(tmpdir(), "isolated-policy-"));
 try { assert.deepEqual(readChildModelPolicy(cwd).denyFamilies, []); }
 finally { await rm(cwd, {recursive:true, force:true}); }
});
