import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SourceIdentityV3, SourceRepositoryIdentityV3 } from "./types.ts";

interface FileSystemIdentity {
	device: string;
	inode: string;
}

async function fileSystemIdentity(path: string): Promise<FileSystemIdentity> {
	const stat = await lstat(path, { bigint: true });
	return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

async function gitDirectoryFromMarker(root: string, marker: string, markerStat: Stats): Promise<string> {
	if (markerStat.isSymbolicLink()) throw new Error(`V3 Git marker must not be a symbolic link: ${marker}`);
	if (markerStat.isDirectory()) return realpath(marker);
	if (!markerStat.isFile()) throw new Error(`V3 Git marker must be a directory or gitdir file: ${marker}`);
	const contents = await readFile(marker, "utf8");
	const match = /^gitdir:\s*(.+?)\s*$/u.exec(contents);
	if (!match) throw new Error(`V3 Git marker has an invalid gitdir reference: ${marker}`);
	const referenced = match[1]!;
	return realpath(isAbsolute(referenced) ? referenced : resolve(root, referenced));
}

async function findRepository(sourceCwd: string): Promise<SourceRepositoryIdentityV3 | undefined> {
	let cursor = sourceCwd;
	while (true) {
		const marker = join(cursor, ".git");
		let markerStat: Stats | undefined;
		try {
			markerStat = await lstat(marker);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (markerStat) {
			const gitDir = await gitDirectoryFromMarker(cursor, marker, markerStat);
			const gitDirStat = await lstat(gitDir);
			if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) throw new Error(`V3 Git directory is not a regular directory: ${gitDir}`);
			return { kind: "git", root: cursor, gitDir, ...(await fileSystemIdentity(gitDir)) };
		}
		const parent = dirname(cursor);
		if (parent === cursor) return undefined;
		cursor = parent;
	}
}

export async function resolveSourceIdentityV3(sourceDirectory: string): Promise<SourceIdentityV3> {
	const sourceCwd = await realpath(resolve(sourceDirectory));
	const sourceStat = await lstat(sourceCwd);
	if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`V3 source directory is not a regular directory: ${sourceCwd}`);
	const sourceRepository = await findRepository(sourceCwd)
		?? { kind: "directory" as const, root: sourceCwd, ...(await fileSystemIdentity(sourceCwd)) };
	return { sourceCwd, sourceRepository };
}
