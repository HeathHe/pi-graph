// E2E-2b crash driver: completes n2's child, then SIGKILLs this process the moment
// n2 reaches verifying/applying/accepted (post-child-completion, around the write
// commit). The parent resumes and must NOT re-dispatch n2 or duplicate its apply.
import { readFile, writeFile } from "node:fs/promises";
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

async function readPhase(graphId: string, runsDir: string): Promise<string | undefined> {
	try {
		const raw = JSON.parse(await readFile(join(runsDir, graphId, "nodes", "n2", "attempts", "1", "attempt.json"), "utf8")) as { phase?: string };
		return raw.phase;
	} catch {
		return undefined;
	}
}

export async function main(): Promise<void> {
	const env = requiredEnv();
	const mock = new MockSubagents();
	mock.behaviors.set("N1", (input) => completeChild({ ...input, writes: [{ path: "n1.out", content: "n1\n" }] }));
	// n2 completes its child, then the process is killed around the commit/acceptance.
	mock.behaviors.set("N2", (input) => completeChild({ ...input, writes: [{ path: "n2.out", content: "n2\n" }] }));
	mock.behaviors.set("N3", (input) => completeChild({ ...input, output: "n3-output" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "e2e commit crash chain",
		nodes: [
			{ taskId: "n1", agent: "test-agent", task: "N1 write", sideEffect: "local_write", writeScope: [{ kind: "file", path: "n1.out" }], validationCommands: ["test -f n1.out"] },
			{ taskId: "n2", agent: "test-agent", task: "N2 write", dependsOn: ["n1"], sideEffect: "local_write", writeScope: [{ kind: "file", path: "n2.out" }], validationCommands: ["test -f n2.out"] },
			{ taskId: "n3", agent: "test-agent", task: "N3 read", dependsOn: ["n2"], sideEffect: "local_read" },
		],
	};
	const host = new V3GraphHost({ rpc: new SubagentRpcClient(mock), runsDir: env.runsDir, sessionId: env.sessionId, supervisorEpoch: env.supervisorEpoch, preflightAgent: async () => undefined });
	const result = await host.start(spec, env.sourceDir);
	const graphId = result.graphId;
	// Signal the parent that the run is underway, then kill this process the instant
	// n2 passes its child-completion boundary (verifying/applying/accepted).
	await writeFile(env.readyFile, "started\n", "utf8");
	const poller = setInterval(() => {
		void readPhase(graphId, env.runsDir).then((phase) => {
			if (phase === "verifying" || phase === "applying" || phase === "accepted") {
				clearInterval(poller);
				// SIGKILL self while n2 is inside its verify/apply/accept window.
				process.kill(process.pid, "SIGKILL");
			}
		});
	}, 10);
	await host.waitForCompletion(graphId);
	clearInterval(poller);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	void main().catch((error) => {
		console.error(`v3-host-crash-driver-2 failed: ${error instanceof Error ? error.stack : String(error)}`);
		process.exitCode = 1;
	});
}
