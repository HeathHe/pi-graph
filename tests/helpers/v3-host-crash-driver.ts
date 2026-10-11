// E2E-2 crash driver: starts a V3 graph chain via V3GraphHost and blocks while n2 is
// mid-run so the parent test can SIGKILL this process and then resume the run.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { V3GraphHost } from "../../src/v3/host.ts";
import type { GraphSpecV3 } from "../../src/v3/types.ts";
import { SubagentRpcClient } from "../../src/v3/rpc.ts";
import { MockSubagents, completeChild } from "./mock-subagents.ts";

interface Env {
	runsDir: string;
	sourceDir: string;
	readyFile: string;
	sessionId: string;
	supervisorEpoch: string;
}

function requiredEnv(): Env {
	const read = (name: string): string => {
		const value = process.env[name];
		if (!value) throw new Error(`Missing env ${name}`);
		return value;
	};
	return {
		runsDir: read("V3_E2E_RUNS_DIR"),
		sourceDir: read("V3_E2E_SOURCE_DIR"),
		readyFile: read("V3_E2E_READY_FILE"),
		sessionId: read("V3_E2E_SESSION_ID") ?? "session-crashed",
		supervisorEpoch: read("V3_E2E_EPOCH") ?? "epoch-crashed",
	};
}

export async function main(): Promise<void> {
	const env = requiredEnv();
	const mock = new MockSubagents();
	mock.behaviors.set("N1", (input) => completeChild({ ...input, writes: [{ path: "n1.out", content: "n1\n" }] }));
	// n2 stays mid-run (status stays "running") and signals the parent to SIGKILL us.
	mock.behaviors.set("N2", async (input) => {
		await writeFile(join(input.cwd, "n2.out"), "n2\n", "utf8");
		await writeFile(env.readyFile, "ready\n", "utf8");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 120_000));
	});
	mock.behaviors.set("N3", (input) => completeChild({ ...input, output: "n3-output" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "e2e crash chain",
		nodes: [
			{ taskId: "n1", agent: "test-agent", task: "N1 write", sideEffect: "local_write", writeScope: [{ kind: "file", path: "n1.out" }], validationCommands: ["test -f n1.out"] },
			// This child has no deadline. The recovery test explicitly requests stop
			// and checks that an unconfirmed old child cannot be duplicated.
			{ taskId: "n2", agent: "test-agent", task: "N2 write", dependsOn: ["n1"], sideEffect: "local_write", writeScope: [{ kind: "file", path: "n2.out" }], validationCommands: ["test -f n2.out"] },
			{ taskId: "n3", agent: "test-agent", task: "N3 read", dependsOn: ["n2"], sideEffect: "local_read" },
		],
	};
	const host = new V3GraphHost({ rpc: new SubagentRpcClient(mock), runsDir: env.runsDir, sessionId: env.sessionId, supervisorEpoch: env.supervisorEpoch, preflightAgent: async () => undefined });
	const result = await host.start(spec, env.sourceDir);
	// The run is supervised in the background; block until the parent kills this process.
	await host.waitForCompletion(result.graphId);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	void main().catch((error) => {
		console.error(`v3-host-crash-driver failed: ${error instanceof Error ? error.stack : String(error)}`);
		process.exitCode = 1;
	});
}
