import assert from "node:assert/strict";
import test from "node:test";
import { classifyChildFailure } from "../src/failure.ts";

test("child failure classifier distinguishes provider, budget, and task failures", () => {
	assert.deepEqual(
		classifyChildFailure({ failureDomain: "provider", failureCode: "rate_limit", failureStage: "runtime", retryAfterMs: 2_000 }, "failed"),
		{ kind: "provider_rate_limit", retryKind: "provider", retryAfterMs: 2_000 },
	);
	assert.deepEqual(
		classifyChildFailure({ failure: { domain: "provider", code: "overloaded", stage: "prelaunch" } }, "failed"),
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
	assert.deepEqual(
		classifyChildFailure({ error: "expected HTTP 500 but got 200; document mentions rate limit policy" }, "failed"),
		{ kind: "task_failed", retryKind: "failed" },
	);
	for (const code of ["auth_error", "invalid_request", "billing_error", "quota_exceeded", "401", "403"]) {
		assert.deepEqual(
			classifyChildFailure({ failure: { domain: "provider", code, stage: "runtime" } }, "failed"),
			{ kind: "task_failed", retryKind: "failed" },
		);
	}
});
