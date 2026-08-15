import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const v3SourceDir = join(repositoryRoot, "src", "v3");

async function v3Sources(): Promise<Array<{ file: string; source: string }>> {
	const files = (await readdir(v3SourceDir)).filter((file) => file.endsWith(".ts")).sort();
	return Promise.all(files.map(async (file) => ({ file, source: await readFile(join(v3SourceDir, file), "utf8") })));
}

test("src/v3 has zero imports from model routing, subagent routing, recommendations, adapters, or extensions", async () => {
	const forbidden = /(?:from\s+|import\s*\()["'][^"']*(?:model-routing|subagent-router|recommend|model-routing-adapter|extensions\/)/u;
	for (const { file, source } of await v3Sources()) assert.doesNotMatch(source, forbidden, file);
});

test("V3 initialize and inspect have no governance configuration probes", async () => {
	for (const file of ["initialize.ts", "inspect.ts"]) {
		const source = await readFile(join(v3SourceDir, file), "utf8");
		assert.doesNotMatch(source, /model-registry\.json|routing-policy\.json/u, file);
	}
});
