// Reproduce the V1 apply crash window exactly: applyingIndex was durable even
// though its corresponding source operation had not started yet.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicWriteJson } from "../../src/v3/durable.ts";

interface CrashFixture {
	planPath: string;
	plan: unknown;
}

async function main(): Promise<void> {
	const fixturePath = process.argv[2];
	if (!fixturePath) throw new Error("Expected a crash fixture path.");
	const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8")) as CrashFixture;
	if (!fixture.planPath || !fixture.plan) throw new Error("Crash fixture is malformed.");
	await atomicWriteJson(fixture.planPath, fixture.plan);
	process.kill(process.pid, "SIGKILL");
}

void main().catch((error) => {
	console.error(`v3-workspace-apply-crash-driver failed: ${error instanceof Error ? error.stack : String(error)}`);
	process.exitCode = 1;
});
