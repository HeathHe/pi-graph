import { isAbsolute, sep } from "node:path";

const ALLOWED_EXECUTABLES = new Set(["npm", "npx", "pnpm", "yarn", "bun", "node", "tsc", "vitest", "jest", "eslint", "prettier", "pytest", "python3", "ruff", "go", "cargo", "git", "test", "jq"]);

function validateInvocation(executable: string, args: string[]): void {
	for (const argument of args) {
		if (argument.includes("\0")) throw new Error("Validation arguments may not contain NUL bytes.");
		const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument;
		const segments = value.split(/[\\/]+/u);
		if (isAbsolute(value) || value === "~" || value.startsWith(`~${sep}`) || segments.includes("..")) throw new Error(`Validation argument escapes the isolated workspace: ${argument}`);
	}
	if (executable === "node" && args.some((argument) => ["-e", "--eval", "-p", "--print"].includes(argument))) throw new Error("Inline Node.js evaluation is not allowed in validation commands.");
	if (executable === "python3" && args.some((argument) => argument === "-c")) throw new Error("Inline Python evaluation is not allowed in validation commands.");
	if (executable === "npx" && !args.includes("--no-install")) throw new Error("npx validation must use --no-install to prevent package downloads.");
	if (["npm", "pnpm", "yarn", "bun"].includes(executable) && args.some((argument) => ["--prefix", "--cwd", "--dir", "-C"].includes(argument) || argument.startsWith("--prefix=") || argument.startsWith("--cwd=") || argument.startsWith("--dir="))) throw new Error("Package-manager validation may not change cwd.");
	if (executable === "git") {
		if (args.some((argument) => argument === "-C" || argument.startsWith("--git-dir") || argument.startsWith("--work-tree"))) throw new Error("Git validation may not redirect its repository.");
		const subcommand = args.find((argument) => !argument.startsWith("-"));
		if (!subcommand || !["status", "diff", "show", "rev-parse", "ls-files"].includes(subcommand)) throw new Error(`Git validation subcommand is not read-only: ${subcommand ?? "<missing>"}`);
	}
}

export function parseValidationCommandV3(command: string): string[] {
	if (!command.trim()) throw new Error("Validation command is empty.");
	const output: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (const character of command) {
		if (escaped) {
			token += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			else token += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (token) output.push(token);
			token = "";
			continue;
		}
		if (/[;&|<>`]/u.test(character)) throw new Error(`Shell operator '${character}' is not allowed in validation commands.`);
		token += character;
	}
	if (escaped || quote) throw new Error("Validation command has an unterminated escape or quote.");
	if (token) output.push(token);
	return output;
}

export function validateValidationCommandV3(command: string): string[] {
	const parsed = parseValidationCommandV3(command);
	const [executable, ...args] = parsed;
	if (!executable || !ALLOWED_EXECUTABLES.has(executable)) throw new Error(`Validation executable is not allowed: ${executable ?? "<empty>"}`);
	validateInvocation(executable, args);
	return parsed;
}
