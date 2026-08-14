import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

export type ManagedLaunchTask = Record<string, unknown>;

export interface ManagedLaunchAudit {
	ok: boolean;
	issues: string[];
	contracts: Array<{ taskIndex: number; launchContractDigest?: string; contractDigest?: string; extensionContentDigest?: string }>;
}

export interface AvailableModelSnapshot {
	provider: string;
	id: string;
	fullId?: string;
	reasoning?: boolean;
	input?: ReadonlyArray<"text" | "image">;
}

type PreflightResolver = (input: Record<string, unknown>) => Promise<
	| { ok: true; contract: {
		modelCandidates: string[];
		launchContractDigest?: string;
		digest?: string;
		agent?: { name?: string; source?: string; filePath?: string; definitionDigest?: string };
		tools?: {
			effectiveAllowlist?: unknown;
			effectiveMcpTools?: unknown;
			toolExtensionPaths?: unknown;
			runtimeExtensions?: unknown;
			configuredExtensions?: unknown;
			extensionArgs?: unknown;
			disableAmbientExtensions?: unknown;
		};
	} }
	| { ok: false; message: string }
>;

type CapabilityCeilingResolver = (sessionId: string | undefined) => Record<string, unknown> | undefined;

let cachedResolver: PreflightResolver | undefined;
let cachedResolverPackageRoot: string | undefined;
let cachedCapabilityCeilingResolver: CapabilityCeilingResolver | undefined;
let cachedResolverPromise: Promise<PreflightResolver> | undefined;
let cachedCapabilityCeilingResolverPromise: Promise<CapabilityCeilingResolver> | undefined;
const cachedFileDigests = new Map<string, { signature: string; digest: string }>();
const MAX_CACHED_FILE_DIGESTS = 100_000;
const bundledPiSubagentsPackageRoot = dirname(createRequire(import.meta.url).resolve("pi-subagents"));
const managedPiSubagentsPackageRoot = resolve(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
const knownPiSubagentsPackageRoots = [managedPiSubagentsPackageRoot, bundledPiSubagentsPackageRoot];
const knownPiSubagentsPromptRuntimes = new Set(knownPiSubagentsPackageRoots.map((root) => resolve(root, "src", "runs", "shared", "subagent-prompt-runtime.ts")));

function fileStatSignature(info: BigIntStats): string {
	return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

async function stableFileContentDigest(path: string): Promise<string> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const before = await lstat(path, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink()) throw new Error(`sealed Extension tree contains a non-regular file: '${path}'`);
		const signature = fileStatSignature(before);
		const cached = cachedFileDigests.get(path);
		if (cached?.signature === signature) {
			const after = await lstat(path, { bigint: true });
			if (fileStatSignature(after) === signature) return cached.digest;
			continue;
		}
		const content = await readFile(path);
		const after = await lstat(path, { bigint: true });
		if (fileStatSignature(after) !== signature) continue;
		const digest = createHash("sha256").update(content).digest("hex");
		if (cachedFileDigests.size >= MAX_CACHED_FILE_DIGESTS) cachedFileDigests.clear();
		cachedFileDigests.set(path, { signature, digest });
		return digest;
	}
	throw new Error(`sealed Extension file changed while it was being hashed: '${path}'`);
}

const fastContextEntry = resolve(homedir(), ".pi", "agent", "git", "github.com", "justhil", "pi-fast-context", "src", "index.ts");
const graphGuardEntry = resolve(import.meta.dirname, "..", "extensions", "pi-graph-guard.ts");

function trustedRuntimeExtension(path: string): boolean {
	return knownPiSubagentsPromptRuntimes.has(resolve(path));
}

function pathWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

type GraphGuardSourceToken = {
	kind: "identifier" | "string" | "template" | "punctuator";
	value: string;
	escaped?: boolean;
};

type GraphGuardClosureEntry = {
	absolutePath: string;
	relativePath: string;
	digest: string;
};

type GraphGuardClosureSnapshot = {
	root: string;
	entry: string;
	entries: GraphGuardClosureEntry[];
	relocationDigest: string;
};

function graphGuardSourceTokens(source: string, path: string): GraphGuardSourceToken[] {
	const tokens: GraphGuardSourceToken[] = [];
	let cursor = 0;
	while (cursor < source.length) {
		const character = source[cursor]!;
		if (/\s/.test(character)) {
			cursor += 1;
			continue;
		}
		if (character === "/" && source[cursor + 1] === "/") {
			cursor += 2;
			while (cursor < source.length && source[cursor] !== "\n") cursor += 1;
			continue;
		}
		if (character === "/" && source[cursor + 1] === "*") {
			const end = source.indexOf("*/", cursor + 2);
			if (end < 0) throw new Error(`graph guard source contains an unterminated block comment: '${path}'`);
			cursor = end + 2;
			continue;
		}
		if (character === '"' || character === "'") {
			const quote = character;
			let value = "";
			let escaped = false;
			cursor += 1;
			let terminated = false;
			while (cursor < source.length) {
				const next = source[cursor]!;
				if (next === quote) {
					cursor += 1;
					terminated = true;
					break;
				}
				if (next === "\\") {
					escaped = true;
					cursor += 1;
					if (cursor >= source.length) break;
					value += source[cursor]!;
					cursor += 1;
					continue;
				}
				if (next === "\n" || next === "\r") break;
				value += next;
				cursor += 1;
			}
			if (!terminated) throw new Error(`graph guard source contains an unterminated string literal: '${path}'`);
			tokens.push({ kind: "string", value, escaped });
			continue;
		}
		if (character === "`") {
			cursor += 1;
			let terminated = false;
			while (cursor < source.length) {
				const next = source[cursor]!;
				if (next === "\\") {
					cursor += 2;
					continue;
				}
				if (next === "`") {
					cursor += 1;
					terminated = true;
					break;
				}
				cursor += 1;
			}
			if (!terminated) throw new Error(`graph guard source contains an unterminated template literal: '${path}'`);
			tokens.push({ kind: "template", value: "" });
			continue;
		}
		if (/[A-Za-z_$]/.test(character)) {
			const start = cursor;
			cursor += 1;
			while (cursor < source.length && /[A-Za-z0-9_$]/.test(source[cursor]!)) cursor += 1;
			tokens.push({ kind: "identifier", value: source.slice(start, cursor) });
			continue;
		}
		tokens.push({ kind: "punctuator", value: character });
		cursor += 1;
	}
	return tokens;
}

function graphGuardModuleSpecifier(token: GraphGuardSourceToken | undefined, path: string, form: string): string {
	if (token?.kind !== "string" || token.escaped) throw new Error(`graph guard ${form} uses an unsupported module specifier in '${path}'`);
	return token.value;
}

function graphGuardRuntimeDependencies(source: Buffer, path: string): string[] {
	const tokens = graphGuardSourceTokens(source.toString("utf8"), path);
	const dependencies = new Set<string>();
	const accept = (specifier: string, typeOnly: boolean, form: string): void => {
		if (specifier.startsWith(".")) {
			if (!typeOnly) dependencies.add(specifier);
			return;
		}
		if (typeOnly || specifier.startsWith("node:")) return;
		throw new Error(`graph guard ${form} has a non-node runtime bare import '${specifier}' in '${path}'`);
	};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.kind !== "identifier") continue;
		if (token.value === "import") {
			if (tokens[index + 1]?.value === ".") continue;
			if (tokens[index + 1]?.value === "(") {
				const specifier = graphGuardModuleSpecifier(tokens[index + 2], path, "dynamic import");
				if (tokens[index + 3]?.value !== ")") throw new Error(`graph guard dynamic import uses an unsupported form in '${path}'`);
				accept(specifier, false, "dynamic import");
				continue;
			}
			if (tokens[index + 1]?.kind === "string") {
				accept(graphGuardModuleSpecifier(tokens[index + 1], path, "import"), false, "import");
				continue;
			}
			const typeOnly = tokens[index + 1]?.value === "type";
			let fromIndex = -1;
			for (let probe = index + 1; probe < Math.min(tokens.length, index + 200); probe += 1) {
				if (tokens[probe]?.value === ";") break;
				if (tokens[probe]?.value === "from") { fromIndex = probe; break; }
			}
			if (fromIndex < 0) {
				if (tokens.slice(index + 1, index + 12).some((candidate) => candidate.value === "require")) continue;
				throw new Error(`graph guard import uses an unsupported form in '${path}'`);
			}
			accept(graphGuardModuleSpecifier(tokens[fromIndex + 1], path, "import"), typeOnly, "import");
			continue;
		}
		if (token.value === "export") {
			const typeOnly = tokens[index + 1]?.value === "type";
			let fromIndex = -1;
			for (let probe = index + 1; probe < Math.min(tokens.length, index + 200); probe += 1) {
				if (tokens[probe]?.value === ";") break;
				if (tokens[probe]?.value === "from") { fromIndex = probe; break; }
			}
			if (fromIndex >= 0) accept(graphGuardModuleSpecifier(tokens[fromIndex + 1], path, "export"), typeOnly, "export");
			continue;
		}
		if (token.value === "require") {
			let openIndex = index + 1;
			if (tokens[openIndex]?.value === "." && tokens[openIndex + 1]?.value === "resolve") openIndex += 2;
			if (tokens[openIndex]?.value !== "(") continue;
			const specifier = graphGuardModuleSpecifier(tokens[openIndex + 1], path, "require");
			if (tokens[openIndex + 2]?.value !== ")") throw new Error(`graph guard require uses an unsupported form in '${path}'`);
			accept(specifier, false, "require");
		}
	}
	return [...dependencies];
}

async function stableGraphGuardSource(path: string, canonicalRoot: string): Promise<{ content: Buffer; digest: string }> {
	const normalized = resolve(path);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const before = await lstat(normalized, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink()) throw new Error(`graph guard source is not a real regular file: '${normalized}'`);
		const canonical = await realpath(normalized);
		if (canonical !== normalized || !pathWithin(canonicalRoot, canonical)) throw new Error(`graph guard import escapes or aliases its package: '${normalized}'`);
		const signature = fileStatSignature(before);
		const content = await readFile(normalized);
		const after = await lstat(normalized, { bigint: true });
		if (fileStatSignature(after) !== signature) continue;
		const canonicalAfter = await realpath(normalized);
		if (canonicalAfter !== canonical) continue;
		return { content, digest: createHash("sha256").update(content).digest("hex") };
	}
	throw new Error(`graph guard source changed while it was being read: '${normalized}'`);
}

async function resolveGraphGuardDependency(importer: string, specifier: string, root: string): Promise<string> {
	const unresolved = resolve(dirname(importer), specifier);
	if (!pathWithin(root, unresolved)) throw new Error(`graph guard relative import '${specifier}' escapes its package`);
	const candidates = [unresolved];
	if (!extname(unresolved)) {
		for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) candidates.push(`${unresolved}${extension}`);
		for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) candidates.push(join(unresolved, `index${extension}`));
	}
	for (const candidate of candidates) {
		if (!pathWithin(root, candidate)) throw new Error(`graph guard relative import '${specifier}' escapes its package`);
		try {
			const info = await lstat(candidate);
			if (info.isSymbolicLink()) throw new Error(`graph guard dependency is a symbolic link: '${candidate}'`);
			if (info.isFile()) return resolve(candidate);
			if (!info.isDirectory()) throw new Error(`graph guard dependency is not a regular file: '${candidate}'`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	throw new Error(`graph guard relative import '${specifier}' cannot be sealed`);
}

async function graphGuardClosureSnapshotOnce(entry: string, root: string, canonicalRoot: string): Promise<GraphGuardClosureSnapshot> {
	const visited = new Map<string, GraphGuardClosureEntry>();
	const visit = async (sourcePath: string): Promise<void> => {
		const normalized = resolve(sourcePath);
		if (visited.has(normalized)) return;
		const stable = await stableGraphGuardSource(normalized, canonicalRoot);
		const relativePath = relative(root, normalized).split(sep).join("/");
		if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) throw new Error(`graph guard source escapes its package: '${normalized}'`);
		visited.set(normalized, { absolutePath: normalized, relativePath, digest: stable.digest });
		for (const specifier of graphGuardRuntimeDependencies(stable.content, normalized)) {
			await visit(await resolveGraphGuardDependency(normalized, specifier, root));
		}
	};
	await visit(entry);
	const entries = [...visited.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	return {
		root,
		entry,
		entries,
		relocationDigest: createHash("sha256").update(entries.map(({ relativePath, digest }) => `${relativePath}\0${digest}`).join("\n")).digest("hex"),
	};
}

async function graphGuardClosureSnapshot(entryPath: string): Promise<GraphGuardClosureSnapshot> {
	const requestedEntry = resolve(entryPath);
	const requestedRoot = dirname(dirname(requestedEntry));
	if (requestedEntry !== join(requestedRoot, "extensions", "pi-graph-guard.ts")) throw new Error(`configured Graph Guard does not have the required package layout: '${requestedEntry}'`);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const before = await lstat(requestedRoot, { bigint: true });
		if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`graph guard package root is not a real directory: '${requestedRoot}'`);
		const signature = fileStatSignature(before);
		const canonicalRoot = await realpath(requestedRoot);
		const canonicalParent = await realpath(dirname(requestedRoot));
		if (dirname(canonicalRoot) !== canonicalParent || canonicalRoot !== join(canonicalParent, requestedRoot.slice(dirname(requestedRoot).length + 1))) {
			throw new Error(`graph guard package root aliases another directory: '${requestedRoot}'`);
		}
		const entry = join(canonicalRoot, "extensions", "pi-graph-guard.ts");
		const snapshot = await graphGuardClosureSnapshotOnce(entry, canonicalRoot, canonicalRoot);
		const after = await lstat(requestedRoot, { bigint: true });
		if (fileStatSignature(after) !== signature || await realpath(requestedRoot) !== canonicalRoot) continue;
		return snapshot;
	}
	throw new Error(`graph guard package root changed while it was being inspected: '${requestedRoot}'`);
}

async function relocatedGraphGuardSnapshot(path: string): Promise<GraphGuardClosureSnapshot> {
	const alternate = await graphGuardClosureSnapshot(path);
	const current = await graphGuardClosureSnapshot(graphGuardEntry);
	if (alternate.relocationDigest !== current.relocationDigest) throw new Error(`configured Graph Guard closure does not match the current package`);
	return alternate;
}

async function trustedConfiguredReadOnlyExtension(path: string): Promise<boolean> {
	const normalized = resolve(path);
	if (normalized === fastContextEntry || normalized === graphGuardEntry) return true;
	try {
		await relocatedGraphGuardSnapshot(normalized);
		return true;
	} catch {
		return false;
	}
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

async function regularFilesUnder(root: string): Promise<string[]> {
	const output: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".DS_Store") continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`sealed Extension tree contains a symbolic link: '${path}'`);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) output.push(path);
			else throw new Error(`sealed Extension tree contains a non-regular entry: '${path}'`);
		}
	};
	await visit(root);
	return output.sort();
}

export async function contentTreeDigest(root: string): Promise<string> {
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`content tree root '${root}' is not a real directory`);
	const canonicalRoot = await realpath(root);
	const entries = await Promise.all((await regularFilesUnder(canonicalRoot)).map(async (path) => {
		return `${relative(canonicalRoot, path)}\0${await stableFileContentDigest(path)}`;
	}));
	return createHash("sha256").update(entries.join("\n")).digest("hex");
}

type PackageLockEntry = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; optional?: boolean };

async function packageLockFor(packageRoot: string): Promise<{
	lockRoot: string;
	lockPath: string;
	lockDigest: string;
	packages: Record<string, PackageLockEntry>;
}> {
	let cursor = resolve(packageRoot);
	while (true) {
		const lockPath = join(cursor, "package-lock.json");
		try {
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const before = await lstat(lockPath, { bigint: true });
				if (!before.isFile() || before.isSymbolicLink()) throw new Error(`package runtime seal requires a regular package-lock.json: '${lockPath}'`);
				const signature = fileStatSignature(before);
				const content = await readFile(lockPath);
				const after = await lstat(lockPath, { bigint: true });
				if (fileStatSignature(after) !== signature) continue;
				const parsed = JSON.parse(content.toString("utf8")) as { packages?: Record<string, PackageLockEntry> };
				if (!parsed.packages) throw new Error(`package runtime seal requires a package-lock.json v2/v3 packages map: '${lockPath}'`);
				return {
					lockRoot: cursor,
					lockPath,
					lockDigest: createHash("sha256").update(content).digest("hex"),
					packages: parsed.packages,
				};
			}
			throw new Error(`package-lock.json changed while it was being read: '${lockPath}'`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = dirname(cursor);
		if (parent === cursor) throw new Error(`package runtime seal could not find a package-lock.json for '${packageRoot}'`);
		cursor = parent;
	}
}

function resolveLockedPackageKey(packages: Record<string, PackageLockEntry>, fromKey: string, dependency: string): string | undefined {
	let cursor = fromKey;
	while (true) {
		const candidate = cursor ? `${cursor}/node_modules/${dependency}` : `node_modules/${dependency}`;
		if (packages[candidate]) return candidate;
		const nested = cursor.lastIndexOf("/node_modules/");
		if (nested >= 0) cursor = cursor.slice(0, nested);
		else if (cursor) cursor = "";
		else return undefined;
	}
}

export async function packageRuntimeContentDigest(packageRoot: string): Promise<string> {
	const canonicalPackageRoot = resolve(packageRoot);
	const { lockRoot, lockPath, lockDigest, packages } = await packageLockFor(canonicalPackageRoot);
	const rootKey = relative(lockRoot, canonicalPackageRoot).split(sep).join("/");
	if (!packages[rootKey]) throw new Error(`package runtime seal cannot locate '${rootKey || "."}' in '${lockPath}'`);
	const selected = new Set<string>();
	const queue: string[] = [];
	const enqueueDependencies = (fromKey: string, entry: PackageLockEntry): void => {
		for (const dependency of Object.keys(entry.dependencies ?? {})) {
			const key = resolveLockedPackageKey(packages, fromKey, dependency);
			if (!key) throw new Error(`required runtime dependency '${dependency}' is absent from package-lock.json`);
			if (!selected.has(key)) { selected.add(key); queue.push(key); }
		}
		for (const dependency of Object.keys(entry.optionalDependencies ?? {})) {
			const key = resolveLockedPackageKey(packages, fromKey, dependency);
			if (key && !selected.has(key)) { selected.add(key); queue.push(key); }
		}
	};
	enqueueDependencies(rootKey, packages[rootKey]!);
	while (queue.length > 0) {
		const key = queue.shift()!;
		enqueueDependencies(key, packages[key]!);
	}
	const entries: Array<{ label: string; digest: string }> = [
		{ label: ".", digest: await contentTreeDigest(canonicalPackageRoot) },
		{ label: `lock:${relative(lockRoot, lockPath)}`, digest: lockDigest },
	];
	for (const key of [...selected].sort()) {
		try {
			entries.push({ label: key, digest: await contentTreeDigest(join(lockRoot, key)) });
		} catch (error) {
			// npm retains every platform-specific optional package in the lockfile while
			// installing only the package compatible with the current runtime.
			if (packages[key]?.optional === true && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
	}
	return createHash("sha256").update(entries.map(({ label, digest }) => `${label}\0${digest}`).join("\n")).digest("hex");
}

async function extensionSealInputs(path: string): Promise<Array<{ label: string; digest: string }>> {
	const normalized = resolve(path);
	if (normalized === fastContextEntry) {
		const packageRoot = resolve(dirname(normalized), "..");
		return [{ label: packageRoot, digest: await packageRuntimeContentDigest(packageRoot) }];
	}
	if (trustedRuntimeExtension(normalized)) {
		const packageRoot = resolve(dirname(normalized), "..", "..", "..");
		return [{ label: packageRoot, digest: await packageRuntimeContentDigest(packageRoot) }];
	}
	if (normalized === graphGuardEntry) {
		const snapshot = await graphGuardClosureSnapshot(normalized);
		return snapshot.entries.map(({ absolutePath, digest }) => ({ label: absolutePath, digest }));
	}
	if (normalized === join(dirname(dirname(normalized)), "extensions", "pi-graph-guard.ts")) {
		const snapshot = await relocatedGraphGuardSnapshot(normalized);
		return snapshot.entries.map(({ absolutePath, digest }) => ({ label: absolutePath, digest }));
	}
	const canonical = await realpath(normalized);
	if (canonical !== normalized) throw new Error(`extension path '${path}' is a symbolic link`);
	const content = await readFile(canonical);
	return [{ label: canonical, digest: createHash("sha256").update(content).digest("hex") }];
}

async function extensionContentDigest(paths: string[]): Promise<string> {
	const nested = await Promise.all([...new Set(paths)].sort().map((path) => extensionSealInputs(path)));
	const entries = nested.flat().sort((left, right) => left.label.localeCompare(right.label)).map(({ label, digest }) => {
		return `${label}\0${digest}`;
	});
	return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export async function graphGuardRuntimeDigest(): Promise<string> {
	const entries = await extensionSealInputs(graphGuardEntry);
	return createHash("sha256").update(entries.sort((left, right) => left.label.localeCompare(right.label)).map(({ label, digest }) => `${label}\0${digest}`).join("\n")).digest("hex");
}

async function publicPreflightResolver(): Promise<PreflightResolver> {
	if (cachedResolver) return cachedResolver;
	if (cachedResolverPromise) return cachedResolverPromise;
	cachedResolverPromise = (async () => {
	// Pi runs the user-installed remote package, while this Extension also keeps a
	// local `latest` dependency for type checking and tests. Launch contracts include
	// absolute Extension paths, so preflight must come from the same installed package
	// that handles the delegation event or every otherwise-identical launch will hash
	// differently. Prefer Pi's managed package and fall back to the bundled dependency
	// outside a normal Pi installation.
	const candidates = [
		resolve(managedPiSubagentsPackageRoot, "src", "api", "preflight.ts"),
		"pi-subagents/preflight",
	];
	const failures: string[] = [];
	for (const candidate of candidates) {
		try {
			if (candidate.startsWith("/")) {
				const info = await lstat(candidate);
				if (!info.isFile() || info.isSymbolicLink()) throw new Error("managed preflight entry is not a regular file");
			}
			const loaded = await createJiti(import.meta.url).import(candidate) as { resolveSubagentLaunchContract?: PreflightResolver };
			if (typeof loaded.resolveSubagentLaunchContract !== "function") throw new Error("resolveSubagentLaunchContract is not exported");
			cachedResolver = loaded.resolveSubagentLaunchContract;
			cachedResolverPackageRoot = candidate.startsWith("/") ? managedPiSubagentsPackageRoot : bundledPiSubagentsPackageRoot;
			return cachedResolver;
		} catch (error) {
			failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`pi-subagents/preflight is unavailable. ${failures.join("; ")}`);
	})();
	try {
		return await cachedResolverPromise;
	} catch (error) {
		cachedResolverPromise = undefined;
		throw error;
	}
}

async function publicCapabilityCeilingResolver(): Promise<CapabilityCeilingResolver> {
	if (cachedCapabilityCeilingResolver) return cachedCapabilityCeilingResolver;
	if (cachedCapabilityCeilingResolverPromise) return cachedCapabilityCeilingResolverPromise;
	cachedCapabilityCeilingResolverPromise = (async () => {
	const failures: string[] = [];
	const candidates = [...new Set([
		...(cachedResolverPackageRoot ? [resolve(cachedResolverPackageRoot, "src", "api", "capability-ceiling.ts")] : []),
		resolve(managedPiSubagentsPackageRoot, "src", "api", "capability-ceiling.ts"),
		createRequire(import.meta.url).resolve("pi-subagents/capability-ceiling"),
	])];
	for (const candidate of candidates) {
		try {
			const loaded = await createJiti(import.meta.url).import(candidate) as { resolveCurrentSubagentCapabilityCeiling?: CapabilityCeilingResolver };
			if (typeof loaded.resolveCurrentSubagentCapabilityCeiling !== "function") throw new Error("resolveCurrentSubagentCapabilityCeiling is not exported");
			cachedCapabilityCeilingResolver = loaded.resolveCurrentSubagentCapabilityCeiling;
			return cachedCapabilityCeilingResolver;
		} catch (error) {
			failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`pi-subagents/capability-ceiling is unavailable. ${failures.join("; ")}`);
	})();
	try {
		return await cachedCapabilityCeilingResolverPromise;
	} catch (error) {
		cachedCapabilityCeilingResolverPromise = undefined;
		throw error;
	}
}

export interface ManagedAgentDefinition {
	name: string;
	source: string;
	filePath: string;
	definitionDigest?: string;
}

/** Resolve one known Agent through pi-subagents' public discovery and capability-ceiling path. */
export async function resolveManagedAgentDefinition(input: {
	agent: string;
	cwd: string;
	sessionId?: string;
	resolver?: PreflightResolver;
	capabilityCeilingResolver?: CapabilityCeilingResolver;
}): Promise<{ ok: true; agent: ManagedAgentDefinition } | { ok: false; message: string }> {
	try {
		const preflight = input.resolver ?? await publicPreflightResolver();
		const resolveCeiling = input.capabilityCeilingResolver ?? await publicCapabilityCeilingResolver();
		const capabilityCeiling = resolveCeiling(input.sessionId);
		const result = await preflight({
			agent: input.agent,
			cwd: resolve(input.cwd),
			context: "fresh",
			task: "Resolve this Agent for the parent capability catalog without launching it.",
			...(capabilityCeiling ? { capabilityCeiling } : {}),
		});
		if (!result.ok) return { ok: false, message: result.message };
		const agent = result.contract.agent;
		if (!agent || typeof agent.name !== "string" || typeof agent.source !== "string" || typeof agent.filePath !== "string") {
			return { ok: false, message: "the public preflight result omitted the selected Agent definition" };
		}
		return {
			ok: true,
			agent: {
				name: agent.name,
				source: agent.source,
				filePath: agent.filePath,
				...(agent.definitionDigest ? { definitionDigest: agent.definitionDigest } : {}),
			},
		};
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

async function applyHostIntercomProjection(input: {
	contract: Record<string, any>;
	task: ManagedLaunchTask;
	cwd: string;
	orchestratorIntercomTarget: string;
}): Promise<void> {
	const packageRoot = cachedResolverPackageRoot;
	if (!packageRoot) throw new Error("the selected pi-subagents preflight package root is unknown");
	const jiti = createJiti(import.meta.url);
	const agentsApi = jiti(resolve(packageRoot, "src", "agents", "agents.ts")) as {
		discoverAgentsAll(cwd: string): Record<string, unknown>;
	};
	const intercomApi = jiti(resolve(packageRoot, "src", "intercom", "intercom-bridge.ts")) as {
		resolveIntercomBridge(input: Record<string, unknown>): Record<string, any>;
		applyIntercomBridgeToAgent(agent: Record<string, any>, bridge: Record<string, any>): Record<string, any>;
	};
	const turnBudgetApi = jiti(resolve(packageRoot, "src", "runs", "shared", "turn-budget.ts")) as {
		appendTurnBudgetSystemPrompt(prompt: string, budget?: Record<string, unknown>): string;
	};
	const singleOutputApi = jiti(resolve(packageRoot, "src", "runs", "shared", "single-output.ts")) as {
		injectOutputPathSystemPrompt(prompt: string, outputPath?: string, capabilities?: Record<string, unknown>): string;
	};
	const refinementApi = jiti(resolve(packageRoot, "src", "agents", "agent-refinements.ts")) as {
		appendAgentRefinementOverlay(prompt: string, input: { cwd: string; agentName: string }): string;
	};
	const piArgsApi = jiti(resolve(packageRoot, "src", "runs", "shared", "pi-args.ts")) as {
		resolvePiLaunchToolPlan(input: Record<string, unknown>): Record<string, any>;
	};
	const launchApi = jiti(resolve(packageRoot, "src", "shared", "launch-contract.ts")) as {
		agentDefinitionDigest(agent: Record<string, any>): string;
		launchBindingDigest(input: Record<string, unknown>): string;
	};
	const discovered = agentsApi.discoverAgentsAll(input.cwd);
	const candidates = Object.values(discovered).flatMap((value) => Array.isArray(value) ? value : []);
	const selected = candidates.find((candidate) => candidate && typeof candidate === "object"
		&& (candidate as Record<string, unknown>).filePath === input.contract.agent?.filePath
		&& (candidate as Record<string, unknown>).name === input.contract.agent?.name) as Record<string, any> | undefined;
	if (!selected) throw new Error("the preflight-selected Agent could not be reconstructed for host Intercom projection");
	if ((input.contract.skills?.requested?.length ?? 0) > 0 || selected.memory !== undefined) {
		throw new Error("host Intercom projection does not support managed Agents with skills or memory");
	}
	const context = input.contract.context === "fork" ? "fork" : "fresh";
	const bridge = intercomApi.resolveIntercomBridge({ context, orchestratorTarget: input.orchestratorIntercomTarget });
	if (bridge.active !== true) return;
	const agent = intercomApi.applyIntercomBridgeToAgent(selected, bridge);
	const toolPlan = piArgsApi.resolvePiLaunchToolPlan({
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		mcpDirectTools: agent.mcpDirectTools,
		cwd: input.cwd,
		requireReadTool: false,
		structuredOutput: false,
		agentName: agent.name,
	});
	const turnBudget = input.task.turnBudget ?? agent.defaultTurnBudget;
	const outputPath = typeof input.contract.roots?.outputPath === "string" ? input.contract.roots.outputPath : undefined;
	let effectiveSystemPrompt = refinementApi.appendAgentRefinementOverlay(agent.systemPrompt?.trim() ?? "", { cwd: input.cwd, agentName: agent.name });
	effectiveSystemPrompt = singleOutputApi.injectOutputPathSystemPrompt(effectiveSystemPrompt, outputPath, agent);
	effectiveSystemPrompt = turnBudgetApi.appendTurnBudgetSystemPrompt(effectiveSystemPrompt, turnBudget as Record<string, unknown> | undefined);
	const definitionDigest = launchApi.agentDefinitionDigest(agent);
	input.contract.agent.definitionDigest = definitionDigest;
	input.contract.tools = {
		...input.contract.tools,
		requestedBuiltin: toolPlan.requestedBuiltinTools,
		declaredBuiltin: toolPlan.declaredBuiltinTools,
		effectiveAllowlist: toolPlan.effectiveToolAllowlist,
		explicitAllowlist: toolPlan.explicitToolAllowlist,
		requiredChildTools: toolPlan.requiredChildTools,
		internalTools: toolPlan.internalTools,
		mcp: toolPlan.effectiveMcpSelections,
		effectiveMcpTools: toolPlan.effectiveMcpTools,
		toolExtensionPaths: toolPlan.toolExtensionPaths,
		runtimeExtensions: toolPlan.runtimeExtensions,
		configuredExtensions: toolPlan.configuredExtensions,
		extensionArgs: toolPlan.extensionArgs,
		disableAmbientExtensions: toolPlan.disableAmbientExtensions,
		fanoutAuthorized: toolPlan.fanoutAuthorized,
	};
	input.contract.launchContractDigest = launchApi.launchBindingDigest({
		definitionDigest,
		task: typeof input.task.task === "string" ? input.task.task : "",
		modelCandidates: input.contract.modelCandidates,
		thinking: input.contract.thinking,
		systemPrompt: effectiveSystemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		skills: [],
		tools: toolPlan.effectiveToolAllowlist,
		extensions: toolPlan.extensionArgs,
		mcpDirectTools: toolPlan.effectiveMcpTools,
		...(outputPath ? { outputPath } : {}),
		outputMode: typeof input.task.outputMode === "string" ? input.task.outputMode : "inline",
	});
}

export async function auditManagedLaunchContracts(input: {
	tasks: ManagedLaunchTask[];
	cwd: string;
	availableModels?: ReadonlyArray<AvailableModelSnapshot>;
	resolver?: PreflightResolver;
	requireReadOnly?: boolean;
	requireExtensionSeal?: boolean;
	requireModelSeal?: boolean;
	graphWorkspaceKind?: "shadow" | "git";
	orchestratorIntercomTarget?: string;
}): Promise<ManagedLaunchAudit> {
	const issues: string[] = [];
	const contracts: ManagedLaunchAudit["contracts"] = [];
	let preflight: PreflightResolver;
	try {
		preflight = input.resolver ?? await publicPreflightResolver();
	} catch (error) {
		return { ok: false, issues: [`The public pi-subagents preflight API is unavailable: ${error instanceof Error ? error.message : String(error)}`], contracts };
	}
	for (const [index, task] of input.tasks.entries()) {
		const agent = typeof task.agent === "string" ? task.agent : undefined;
		if (!agent) continue;
		const model = typeof task.model === "string" ? task.model : undefined;
		let result: Awaited<ReturnType<PreflightResolver>>;
		try {
			result = await preflight({
				agent,
				task: typeof task.task === "string" ? task.task : undefined,
				cwd: typeof task.cwd === "string" ? resolve(input.cwd, task.cwd) : input.cwd,
				context: task.context === "fork" ? "fork" : "fresh",
				...(model ? { model } : {}),
				...(typeof task.output === "string" || typeof task.output === "boolean" ? { output: task.output } : {}),
				...(typeof task.outputMode === "string" ? { outputMode: task.outputMode } : {}),
				...(typeof task.artifacts === "boolean" ? { artifacts: task.artifacts } : {}),
				...(typeof task.agentScope === "string" ? { agentScope: task.agentScope } : {}),
				...(typeof task.sessionDir === "string" ? { sessionDir: task.sessionDir } : {}),
				...(task.turnBudget !== undefined ? { turnBudget: task.turnBudget } : {}),
				...(task.toolBudget !== undefined ? { toolBudget: task.toolBudget } : {}),
				...(task.skill !== undefined ? { skill: task.skill } : {}),
				...(input.availableModels ? { availableModels: input.availableModels } : {}),
			});
		} catch (error) {
			issues.push(`Managed task ${index} (${agent}) preflight threw: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!result.ok) {
			issues.push(`Managed task ${index} (${agent}) preflight failed: ${result.message}`);
			continue;
		}
		if (input.orchestratorIntercomTarget) {
			try {
				await applyHostIntercomProjection({
					contract: result.contract as Record<string, any>,
					task,
					cwd: typeof task.cwd === "string" ? resolve(input.cwd, task.cwd) : input.cwd,
					orchestratorIntercomTarget: input.orchestratorIntercomTarget,
				});
			} catch (error) {
				issues.push(`Managed task ${index} (${agent}) host Intercom projection failed: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
		}
		contracts.push({
			taskIndex: index,
			...(result.contract.launchContractDigest ? { launchContractDigest: result.contract.launchContractDigest } : {}),
			...(result.contract.digest ? { contractDigest: result.contract.digest } : {}),
		});
		if (input.requireReadOnly) {
			if (result.contract.agent?.source === "project") issues.push(`Managed task ${index} (${agent}) resolves a project-level Agent override; routed retries require a trusted non-project Agent definition.`);
			const effectiveTools = result.contract.tools?.effectiveAllowlist;
			const allowedTools = new Set(["read", "grep", "find", "ls", "fast_context_search", "intercom", "contact_supervisor"]);
			if (!Array.isArray(effectiveTools) || effectiveTools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool))) {
				issues.push(`Managed task ${index} (${agent}) does not have a verified read-only tool allowlist.`);
			}
			const effectiveMcpTools = result.contract.tools?.effectiveMcpTools;
			if (!Array.isArray(effectiveMcpTools) || effectiveMcpTools.length > 0) issues.push(`Managed task ${index} (${agent}) exposes MCP tools; routed retry safety requires none.`);
		}
			if (input.graphWorkspaceKind) {
			const tools = result.contract.tools;
			const effectiveTools = tools?.effectiveAllowlist;
			const runtimeExtensions = stringArray(tools?.runtimeExtensions);
			const configuredExtensions = stringArray(tools?.configuredExtensions);
			const extensionArgs = stringArray(tools?.extensionArgs);
			const sealedNativeSupervisorRuntime = runtimeExtensions !== undefined
				&& configuredExtensions !== undefined
				&& extensionArgs !== undefined
				&& runtimeExtensions.length === 1
				&& trustedRuntimeExtension(runtimeExtensions[0]!)
				&& extensionArgs.includes(runtimeExtensions[0]!);
			const allowedTools = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "contact_supervisor"]);
			if (input.graphWorkspaceKind === "shadow") allowedTools.add("fast_context_search");
			// pi-subagents' sealed prompt runtime registers `intercom` only as a
			// compatibility alias for the native child-to-supervisor channel. It
			// cannot address arbitrary sessions or touch the Graph workspace.
			if (sealedNativeSupervisorRuntime) allowedTools.add("intercom");
			if (!Array.isArray(effectiveTools) || effectiveTools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool))) {
				issues.push(`Managed task ${index} (${agent}) exposes a tool whose filesystem or side-effect behavior is not covered by the Graph workspace contract.`);
			}
			const effectiveMcpTools = tools?.effectiveMcpTools;
			if (!Array.isArray(effectiveMcpTools) || effectiveMcpTools.length > 0) issues.push(`Managed task ${index} (${agent}) exposes MCP tools; Graph workspace enforcement requires none.`);
		}
		if (input.requireReadOnly || input.requireExtensionSeal) {
			const tools = result.contract.tools;
			const toolExtensionPaths = stringArray(tools?.toolExtensionPaths);
			const runtimeExtensions = stringArray(tools?.runtimeExtensions);
			const configuredExtensions = stringArray(tools?.configuredExtensions);
			const extensionArgs = stringArray(tools?.extensionArgs);
			if (!toolExtensionPaths || !runtimeExtensions || !configuredExtensions || !extensionArgs || tools?.disableAmbientExtensions !== true) {
				issues.push(`Managed task ${index} (${agent}) does not expose a closed, ambient-disabled Extension contract.`);
			} else {
				const declared = [...runtimeExtensions, ...configuredExtensions];
				let configuredExtensionsTrusted = true;
				for (const path of configuredExtensions) {
					if (!await trustedConfiguredReadOnlyExtension(path)) {
						configuredExtensionsTrusted = false;
						break;
					}
				}
				if (toolExtensionPaths.length > 0 || runtimeExtensions.some((path) => !trustedRuntimeExtension(path)) || !configuredExtensionsTrusted || new Set(extensionArgs).size !== new Set(declared).size || extensionArgs.some((path) => !declared.includes(path))) {
					issues.push(`Managed task ${index} (${agent}) exposes an untrusted or inconsistent Extension path.`);
				} else {
					try {
						contracts[contracts.length - 1]!.extensionContentDigest = await extensionContentDigest(extensionArgs);
					} catch (error) {
						issues.push(`Managed task ${index} (${agent}) Extension content could not be sealed: ${error instanceof Error ? error.message : String(error)}.`);
					}
				}
			}
		}
		const candidates = [...new Set(result.contract.modelCandidates)];
		if (input.requireModelSeal !== false && (candidates.length !== 1 || (model && candidates[0] !== model))) {
			issues.push(`Managed task ${index} (${agent}) resolves model candidates [${result.contract.modelCandidates.join(", ")}]; controlled routing requires exactly '${model ?? "the routed model"}'.`);
		}
		if (input.requireModelSeal !== false && input.availableModels && candidates.length === 1) {
			const selected = candidates[0]!;
			const thinkingMatch = selected.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
			const base = thinkingMatch ? selected.slice(0, -thinkingMatch[0].length) : selected;
			const available = input.availableModels.find((candidate) => (candidate.fullId ?? `${candidate.provider}/${candidate.id}`) === base);
			if (!available) {
				issues.push(`Managed task ${index} (${agent}) selects unavailable model '${selected}' in the active Pi model registry.`);
			} else if (thinkingMatch?.[1] !== undefined && thinkingMatch[1] !== "off" && available.reasoning !== true) {
				issues.push(`Managed task ${index} (${agent}) selects thinking '${thinkingMatch[1]}' without confirmed reasoning support for model '${base}'.`);
			}
		}
	}
	return { ok: issues.length === 0, issues, contracts };
}
