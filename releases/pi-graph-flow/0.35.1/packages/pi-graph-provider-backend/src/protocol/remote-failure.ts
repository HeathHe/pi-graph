import type { RecoveryFailureRecordV1 } from "./failure.ts";

/** Optional wire fact. The configured worker remains the trust boundary. */
export interface RemotePiAssistantFailureV1 {
  readonly version: 1;
  readonly source: "pi-rpc-assistant-error";
  readonly record: Readonly<RecoveryFailureRecordV1>;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > maximumBytes) return false;
  }
  return true;
}

/** Validate wire shape and clone only known fields; never infer a cause from text. */
export function parseRemotePiAssistantFailure(value: unknown): RemotePiAssistantFailureV1 | undefined {
  if (!plainRecord(value) || value.version !== 1 || value.source !== "pi-rpc-assistant-error"
    || !plainRecord(value.record)) return undefined;
  const record = value.record;
  if (record.phase !== "message_end" || !Number.isSafeInteger(record.sequence)
    || typeof record.sequence !== "number" || record.sequence < 1
    || !boundedText(record.sanitizedMessage, 4096)
    || (record.model !== undefined && !boundedText(record.model, 256))) return undefined;
  const knownPair = (record.layer === "transport" && record.code === "network")
    || (record.layer === "provider" && (record.code === "provider" || record.code === "auth" || record.code === "fallback-only"))
    || (record.layer === "recovery" && (record.code === "unknown" || record.code === "non-retryable"));
  if (!knownPair) return undefined;
  // The checks above deliberately narrow each public field without importing a runtime classifier.
  if (typeof record.code !== "string"
    || (record.layer !== "provider" && record.layer !== "transport" && record.layer !== "recovery")) return undefined;
  const cloned: Readonly<RecoveryFailureRecordV1> = Object.freeze({
    code: record.code,
    layer: record.layer,
    phase: "message_end",
    sequence: record.sequence,
    sanitizedMessage: record.sanitizedMessage,
    ...(record.model === undefined ? {} : { model: record.model }),
  });
  return Object.freeze({ version: 1, source: "pi-rpc-assistant-error", record: cloned });
}
