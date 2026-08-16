import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { subagentAsyncRoot } from "../src/rpc.ts";

const sandboxRoot = process.env.PI_GRAPH_TEST_SANDBOX_ROOT;
const hostAsyncRoot = process.env.PI_GRAPH_TEST_HOST_ASYNC_ROOT;

assert.ok(sandboxRoot, "The isolated test runner must declare PI_GRAPH_TEST_SANDBOX_ROOT.");
assert.ok(hostAsyncRoot, "The isolated test runner must declare PI_GRAPH_TEST_HOST_ASYNC_ROOT.");
assert.equal(resolve(tmpdir()), resolve(sandboxRoot), "The test process must use the isolated temporary directory.");

const asyncRoot = resolve(subagentAsyncRoot());
const sandboxRelativePath = relative(resolve(sandboxRoot), asyncRoot);
assert.ok(
	sandboxRelativePath !== ""
		&& sandboxRelativePath !== ".."
		&& !sandboxRelativePath.startsWith(`..${sep}`)
		&& !isAbsolute(sandboxRelativePath),
	"The pi-subagents async root must remain inside the isolated test directory.",
);
assert.notEqual(asyncRoot, resolve(hostAsyncRoot), "Tests must not use the host Pi async-run directory.");
