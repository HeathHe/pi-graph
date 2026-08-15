import type { RunFormatDetection } from "./types.ts";

function recordVersion(value: unknown, field: string): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const version = (value as Record<string, unknown>)[field];
	return typeof version === "number" && Number.isInteger(version) ? version : undefined;
}

export function detectRunFormat(snapshot: unknown, authorization?: unknown): RunFormatDetection {
	const snapshotSchemaVersion = recordVersion(snapshot, "schemaVersion");
	const authorizationPresent = authorization !== undefined;
	const authorizationSchemaVersion = authorizationPresent ? recordVersion(authorization, "schemaVersion") : undefined;
	const runtimeSchemaVersion = authorizationPresent ? recordVersion(authorization, "runtimeSchemaVersion") : undefined;
	const versions = {
		...(snapshotSchemaVersion === undefined ? {} : { snapshotSchemaVersion }),
		...(authorizationSchemaVersion === undefined ? {} : { authorizationSchemaVersion }),
		...(runtimeSchemaVersion === undefined ? {} : { runtimeSchemaVersion }),
	};
	if (snapshotSchemaVersion === 1 && !authorizationPresent) return { kind: "legacy-readonly", ...versions };
	if (snapshotSchemaVersion === 2 && (authorizationSchemaVersion === 2 || authorizationSchemaVersion === 3)) return { kind: "legacy-v2", ...versions };
	if (snapshotSchemaVersion === 3 && authorizationSchemaVersion === 4 && runtimeSchemaVersion === 3) return { kind: "v3", ...versions };
	return {
		kind: "invalid",
		...versions,
		reason: `Unsupported run format combination: snapshot=${snapshotSchemaVersion ?? "missing/invalid"}, authorization=${authorizationPresent ? authorizationSchemaVersion ?? "invalid" : "absent"}, runtime=${runtimeSchemaVersion ?? "missing"}.`,
	};
}
