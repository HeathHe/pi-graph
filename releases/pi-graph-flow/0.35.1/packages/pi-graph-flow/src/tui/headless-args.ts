// Shared `--field` argument convention for headless (non-overlay) command use.
//
// 配置型斜杠命令在 RPC 模式下没有 ctx.ui.custom() 表单，统一约定用
// `--name=value` / `--name "value"` / `--flag` 携带字段值，位置参数保持原有
// 语义不变。字段名按 kebab-case → camelCase 归一后映射到表单字段 id。

export interface HeadlessArgs {
	/** 去掉了所有 `--` 参数后的位置参数，保持原顺序与原大小写。 */
	positionals: string[];
	/** `--name=value` / `--name value` 收集到的字段值；裸 `--flag` 记为 "true"。 */
	fields: Record<string, string>;
}

/**
 * Quote-aware command tokenizer: `"…"`/`'…'` group words so values may contain
 * spaces or JSON (`--headers-json '{"X":"y"}'`). Backslash escapes the next char
 * inside double quotes. Unmatched quotes treat the rest of the input as one token.
 */
export function splitCommandArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index]!;
		if (quote === '"') {
			if (char === '"') { quote = undefined; continue; }
			if (char === "\\" && index + 1 < input.length) { current += input[index + 1]; index += 1; continue; }
			current += char;
			continue;
		}
		if (quote === "'") {
			if (char === "'") { quote = undefined; continue; }
			current += char;
			continue;
		}
		if (char === '"' || char === "'") { quote = char; started = true; continue; }
		if (/\s/.test(char)) {
			if (started || current) { tokens.push(current); current = ""; started = false; }
			continue;
		}
		current += char;
		started = true;
	}
	if (started || current) tokens.push(current);
	return tokens;
}

const FIELD_NAME = /^--([A-Za-z][A-Za-z0-9_-]*)$/;
const FIELD_NAME_VALUE = /^--([A-Za-z][A-Za-z0-9_-]*)=(.*)$/s;

/**
 * Splits tokens into positionals and `--` field assignments.
 * - `--name=value` → fields[name] = value（可为空串）
 * - `--name value` → fields[name] = value（仅当下一个 token 不以 `--` 开头）
 * - `--name`（无后续值）→ fields[name] = "true"，作为布尔开关
 */
export function extractHeadlessArgs(tokens: readonly string[]): HeadlessArgs {
	const positionals: string[] = [];
	const fields: Record<string, string> = {};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		const withValue = FIELD_NAME_VALUE.exec(token);
		if (withValue) {
			fields[normalizeFieldName(withValue[1]!)] = withValue[2]!;
			continue;
		}
		const bare = FIELD_NAME.exec(token);
		if (bare) {
			const name = normalizeFieldName(bare[1]!);
			const next = tokens[index + 1];
			if (next !== undefined && !next.startsWith("--")) {
				fields[name] = next;
				index += 1;
			} else {
				fields[name] = "true";
			}
			continue;
		}
		positionals.push(token);
	}
	return { positionals, fields };
}

/** `base-url` → `baseUrl`；`--api_key` → `apiKey`。大小写不敏感归一。 */
export function normalizeFieldName(name: string): string {
	return name.replace(/[-_]+([A-Za-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * Lookup a field value trying each alias after kebab→camel normalization.
 * Returns undefined when none of the names were provided.
 */
export function headlessField(fields: Record<string, string>, ...names: string[]): string | undefined {
	for (const name of names) {
		const key = normalizeFieldName(name);
		if (fields[key] !== undefined) return fields[key];
	}
	return undefined;
}

export function hasHeadlessFields(fields: Record<string, string> | undefined): boolean {
	return fields !== undefined && Object.keys(fields).length > 0;
}

/** Parse a boolean field value; undefined when the value is not recognized. */
export function parseHeadlessBoolean(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enable", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disable", "disabled"].includes(normalized)) return false;
	return undefined;
}

/**
 * Comma-separated list field (`--models a,b,c`); a single `*` segment is kept
 * verbatim so glob rules still work. Empty/whitespace input → [].
 */
export function parseHeadlessList(value: string): string[] {
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}
