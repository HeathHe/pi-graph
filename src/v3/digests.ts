import { createHash } from "node:crypto";

function canonicalize(value: unknown, seen: Set<object>, inArray = false): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") throw new TypeError("Canonical JSON does not support bigint values.");
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return inArray ? null : undefined;
	if (typeof value !== "object") return value;
	if (seen.has(value)) throw new TypeError("Canonical JSON does not support cyclic values.");
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen, true));
		const source = value as Record<string, unknown>;
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			const normalized = canonicalize(source[key], seen);
			if (normalized !== undefined) output[key] = normalized;
		}
		return output;
	} finally {
		seen.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	const normalized = canonicalize(value, new Set());
	if (normalized === undefined) throw new TypeError("Canonical JSON cannot encode an undefined root value.");
	return JSON.stringify(normalized);
}

export function canonicalDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
