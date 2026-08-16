import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface TrustedDirectoryAnchor {
	root: string;
	dev: number;
	ino: number;
}

function sameDirectory(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function currentTrustedRoot(anchor: TrustedDirectoryAnchor): Promise<boolean> {
	const before = await lstat(anchor.root).catch(() => undefined);
	if (!before || before.isSymbolicLink() || !before.isDirectory() || !sameDirectory(anchor, before)) return false;
	const canonical = await realpath(anchor.root).catch(() => undefined);
	const after = await lstat(anchor.root).catch(() => undefined);
	return canonical === anchor.root
		&& after !== undefined
		&& !after.isSymbolicLink()
		&& after.isDirectory()
		&& sameDirectory(anchor, after);
}

export async function captureTrustedDirectoryAnchor(trustedRoot: string): Promise<TrustedDirectoryAnchor> {
	const root = resolve(trustedRoot);
	let rootBefore;
	try {
		rootBefore = await lstat(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`V3 trusted root does not exist: ${root}`);
		throw error;
	}
	if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) throw new Error(`V3 trusted root is not a regular directory: ${root}`);
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(root);
	} catch (error) {
		throw new Error(`V3 trusted root could not be canonicalized: ${root}`, { cause: error });
	}
	const rootAfter = await lstat(root).catch(() => undefined);
	if (canonicalRoot !== root) throw new Error(`V3 trusted root must be passed using its canonical path: ${root}`);
	if (!rootAfter || rootAfter.isSymbolicLink() || !rootAfter.isDirectory() || !sameDirectory(rootBefore, rootAfter)) throw new Error(`V3 trusted root changed while its identity was captured: ${root}`);
	return { root, dev: rootAfter.dev, ino: rootAfter.ino };
}

export async function unsafeDirectoryComponent(path: string, anchor: TrustedDirectoryAnchor): Promise<string | undefined> {
	const absolute = resolve(path);
	const root = anchor.root;
	if (!await currentTrustedRoot(anchor)) return root;
	const token = relative(root, absolute);
	if (token === "") return undefined;
	if (token === ".." || token.startsWith(`..${sep}`) || isAbsolute(token)) return absolute;
	let cursor = root;
	for (const component of token.split(sep).filter(Boolean)) {
		cursor = join(cursor, component);
		let stat;
		try {
			stat = await lstat(cursor);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) return cursor;
	}
	return undefined;
}
