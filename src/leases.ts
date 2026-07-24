import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ScopeEntry } from "./types.ts";
import { compareClaims, contentionWindow, createClaim, liveClaims, markClaimHeld, releaseClaim, type Claim } from "./claims.ts";

interface LeasePayload {
	graphId: string;
	taskId: string;
	epoch: string;
	scopes: ScopeEntry[];
}

function within(root: string, target: string): boolean {
	const relativePath = relative(root, target);
	return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

export function scopesOverlap(left: ScopeEntry[], right: ScopeEntry[]): boolean {
	return left.some((a) => right.some((b) => a.path === b.path || (a.kind === "tree" && within(a.path, b.path)) || (b.kind === "tree" && within(b.path, a.path))));
}

function conflicts(left: Claim<LeasePayload>, right: Claim<LeasePayload>): boolean {
	return scopesOverlap(left.payload.scopes, right.payload.scopes);
}

export class LeaseRegistry {
	private readonly directory: string;
	private readonly managedRoot: string;

	constructor(file: string) {
		const resolved = resolve(file);
		this.directory = `${resolved}.claims`;
		this.managedRoot = dirname(dirname(resolved));
	}

	async acquire(record: LeasePayload): Promise<(() => Promise<void>) | null> {
		await ensureManagedDirectory(this.managedRoot, this.directory, "Lease claim directory");
		const created = await createClaim(this.directory, record);
		let acquired = false;
		try {
			await contentionWindow();
			const claims = await liveClaims<LeasePayload>(this.directory);
			const overlapping = claims.filter((entry) => conflicts(entry.claim, created.claim));
			if (overlapping.some((entry) => entry.claim.token !== created.claim.token && entry.claim.state === "held")) return null;
			const winner = overlapping.filter((entry) => entry.claim.state === "pending").sort((left, right) => compareClaims(left.claim, right.claim))[0];
			if (!winner || winner.claim.token !== created.claim.token) return null;
			await markClaimHeld(created);
			const competing = (await liveClaims<LeasePayload>(this.directory)).some((entry) => entry.claim.token !== created.claim.token && entry.claim.state === "held" && conflicts(entry.claim, created.claim));
			if (competing) return null;
			acquired = true;
			return async () => releaseClaim(created);
		} finally {
			if (!acquired) await releaseClaim(created);
		}
	}
}

async function ensureManagedDirectory(root: string, target: string, label: string): Promise<void> {
	await mkdir(root, { recursive: true });
	const rootInfo = await lstat(root);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`${label} root must be a real directory.`);
	const token = relative(root, target);
	if (!token || isAbsolute(token) || token === ".." || token.startsWith(`..${sep}`)) throw new Error(`${label} escapes its managed root.`);
	let cursor = root;
	for (const part of token.split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} contains a symbolic link or non-directory.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				await mkdir(cursor);
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				const info = await lstat(cursor);
				if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} contains a symbolic link or non-directory.`);
			}
		}
	}
	const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
	if (!within(canonicalRoot, canonicalTarget) || canonicalRoot === canonicalTarget) throw new Error(`${label} escapes its managed root.`);
}
