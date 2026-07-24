import assert from "node:assert/strict";
import test from "node:test";
import { classifyChildFailure } from "../src/failure.ts";

test("child failure classifier distinguishes provider, budget, and task failures", () => {
	assert.deepEqual(
		classifyChildFailure({ error: "HTTP 429 too many requests; retry-after: 2 seconds" }, "failed"),
		{ kind: "provider_rate_limit", retryKind: "provider", retryAfterMs: 2_000 },
	);
	assert.deepEqual(
		classifyChildFailure({ error: "provider overloaded with HTTP 503" }, "failed"),
		{ kind: "provider_transient", retryKind: "provider" },
	);
	assert.deepEqual(
		classifyChildFailure({ timedOut: true }, "failed"),
		{ kind: "hard_deadline", retryKind: "timeout" },
	);
	assert.deepEqual(
		classifyChildFailure({ turnBudgetExceeded: true }, "failed"),
		{ kind: "budget_checkpoint", retryKind: "failed" },
	);
	assert.deepEqual(
		classifyChildFailure({ error: "tests failed" }, "failed"),
		{ kind: "task_failed", retryKind: "failed" },
	);
});
