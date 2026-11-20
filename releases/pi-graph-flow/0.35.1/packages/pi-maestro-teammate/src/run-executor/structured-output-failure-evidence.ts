import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolvePiAgentDirectory } from "../shared/agent-directory.ts";

/** Evidence describes bytes from a rejected attempt; it grants no completion authority. */
export type StructuredOutputFailureEvidence =
  | { kind: "structured-output-failure"; correlationId: string; complete: true; path: string; sha256: string; bytes: number }
  | { kind: "structured-output-failure"; correlationId: string; complete: false; bytes: number | "unknown"; reason: "limit-exceeded" | "read-failed" | "evidence-write-failed" };

/** Persist bounded original bytes independently of prompt/transcript truncation. */
export function preserveStructuredOutputFailure(
  correlationId: string,
  raw: Buffer | undefined,
  incomplete?: { bytes: number | "unknown"; reason: "limit-exceeded" | "read-failed" },
): StructuredOutputFailureEvidence {
  if (raw && raw.length > 1024 * 1024) incomplete = { bytes: raw.length, reason: "limit-exceeded" };
  const base = { kind: "structured-output-failure" as const, correlationId };
  if (!raw || incomplete) return { ...base, complete: false, bytes: incomplete?.bytes ?? "unknown", reason: incomplete?.reason ?? "read-failed" };
  try {
    const directory = path.join(resolvePiAgentDirectory(), "pi-graph-next", "evidence", "structured-output", randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const outputPath = path.join(directory, "raw-output.bin");
    fs.writeFileSync(outputPath, raw, { flag: "wx", mode: 0o600 });
    return { ...base, complete: true, path: outputPath, bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
  } catch {
    return { ...base, complete: false, bytes: raw.length, reason: "evidence-write-failed" };
  }
}
