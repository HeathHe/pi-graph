import { Buffer } from "node:buffer";
const CURSOR_VERSION = 1 as const;
const CURSOR_MAX_CHARS = 2_048;


export interface WorkspaceSessionCursor {
  version: typeof CURSOR_VERSION;
  incarnation: string;
  sequence: number;
  revision: number;
}

export function encodeCursor(cursor: WorkspaceSessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): WorkspaceSessionCursor | undefined {
  if (!cursor || cursor.length > CURSOR_MAX_CHARS) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<WorkspaceSessionCursor>;
    if (parsed.version !== CURSOR_VERSION
      || typeof parsed.incarnation !== "string"
      || !/^[a-f0-9]{32}$/.test(parsed.incarnation)
      || typeof parsed.sequence !== "number"
      || !Number.isSafeInteger(parsed.sequence)
      || parsed.sequence < 0
      || typeof parsed.revision !== "number"
      || !Number.isSafeInteger(parsed.revision)
      || parsed.revision < 0) return undefined;
    return {
      version: CURSOR_VERSION,
      incarnation: parsed.incarnation,
      sequence: parsed.sequence,
      revision: parsed.revision,
    };
  } catch {
    return undefined;
  }
}

