import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { SourceIdentityV3 } from "./types.ts";

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
			if (error) rejectPromise(error);
			else resolvePromise(stdout.trim());
		});
	});
}

export async function resolveSourceIdentityV3(sourceDirectory: string): Promise<SourceIdentityV3> {
	const sourceCwd = await realpath(resolve(sourceDirectory));
	const sourceStat = await lstat(sourceCwd);
	if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`V3 source directory is not a regular directory: ${sourceCwd}`);
	try {
		const reportedRoot = await git(sourceCwd, ["rev-parse", "--show-toplevel"]);
		const root = await realpath(reportedRoot);
		const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
		if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head)) throw new Error("Git HEAD is not a supported SHA-1 or SHA-256 object identity.");
		return { sourceCwd, sourceRepository: { kind: "git", root, head } };
	} catch {
		return { sourceCwd, sourceRepository: { kind: "directory", root: sourceCwd } };
	}
}
