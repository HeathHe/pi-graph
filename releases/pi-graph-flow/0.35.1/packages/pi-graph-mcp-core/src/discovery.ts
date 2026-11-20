const MCP_DISCOVERY_MAX_PAGES = 100;
const MCP_DISCOVERY_MAX_ITEMS = 10_000;
const MCP_DISCOVERY_MAX_METADATA_BYTES = 8 * 1024 * 1024;

export class McpDiscoveryPaginationError extends Error {}

class McpMetadataLimitExceeded extends Error {}

class McpMetadataValueError extends Error {}

export interface McpDiscoveryPage<T> {
  items: T[];
  nextCursor?: string;
}

type JsonByteCountFrame =
  | { kind: "value"; value: unknown }
  | { kind: "array"; value: unknown[]; index: number }
  | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number };

function countJsonStringBytes(value: string, addBytes: (bytes: number) => void): void {
  addBytes(2); // Quotes.
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      addBytes(2);
    } else if (codeUnit <= 0x1f) {
      addBytes(
        codeUnit === 0x08
          || codeUnit === 0x09
          || codeUnit === 0x0a
          || codeUnit === 0x0c
          || codeUnit === 0x0d
          ? 2
          : 6,
      );
    } else if (codeUnit <= 0x7f) {
      addBytes(1);
    } else if (codeUnit <= 0x7ff) {
      addBytes(2);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        addBytes(4);
        index += 1;
      } else {
        addBytes(6);
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      addBytes(6);
    } else {
      addBytes(3);
    }
  }
}

function countUtf8StringBytes(value: string, maxBytes: number): number {
  let bytes = 0;
  const addBytes = (additionalBytes: number): void => {
    if (additionalBytes > maxBytes - bytes) throw new McpMetadataLimitExceeded();
    bytes += additionalBytes;
  };

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      addBytes(1);
    } else if (codeUnit <= 0x7ff) {
      addBytes(2);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        addBytes(4);
        index += 1;
      } else {
        addBytes(3);
      }
    } else {
      addBytes(3);
    }
  }
  return bytes;
}

function countJsonCompatibleBytes(value: unknown, maxBytes: number): number {
  let bytes = 0;
  const activeObjects = new Set<object>();
  const frames: JsonByteCountFrame[] = [{ kind: "value", value }];
  const addBytes = (additionalBytes: number): void => {
    if (additionalBytes > maxBytes - bytes) throw new McpMetadataLimitExceeded();
    bytes += additionalBytes;
  };

  while (frames.length > 0) {
    const frame = frames.pop()!;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        addBytes(1);
        activeObjects.delete(frame.value);
        continue;
      }
      if (frame.index > 0) addBytes(1);
      const index = frame.index;
      frame.index += 1;
      frames.push(frame, { kind: "value", value: frame.value[index] });
      continue;
    }

    if (frame.kind === "object") {
      if (frame.index >= frame.keys.length) {
        addBytes(1);
        activeObjects.delete(frame.value);
        continue;
      }
      if (frame.index > 0) addBytes(1);
      const key = frame.keys[frame.index];
      frame.index += 1;
      countJsonStringBytes(key, addBytes);
      addBytes(1);
      frames.push(frame, { kind: "value", value: frame.value[key] });
      continue;
    }

    const current = frame.value;
    if (current === null) {
      addBytes(4);
      continue;
    }
    switch (typeof current) {
      case "string":
        countJsonStringBytes(current, addBytes);
        continue;
      case "boolean":
        addBytes(current ? 4 : 5);
        continue;
      case "number":
        if (!Number.isFinite(current)) {
          throw new McpMetadataValueError("non-finite numbers are not JSON-compatible");
        }
        addBytes(String(current).length);
        continue;
      case "object": {
        if (activeObjects.has(current)) {
          throw new McpMetadataValueError("cyclic values are not JSON-compatible");
        }
        activeObjects.add(current);
        if (Array.isArray(current)) {
          addBytes(1);
          frames.push({ kind: "array", value: current, index: 0 });
          continue;
        }

        let prototype: object | null;
        let keys: string[];
        try {
          prototype = Object.getPrototypeOf(current);
          keys = Object.keys(current);
        } catch {
          throw new McpMetadataValueError("metadata objects must be inspectable");
        }
        if (prototype !== Object.prototype && prototype !== null) {
          throw new McpMetadataValueError("objects with non-JSON prototypes are not supported");
        }
        addBytes(1);
        frames.push({
          kind: "object",
          value: current as Record<string, unknown>,
          keys,
          index: 0,
        });
        continue;
      }
      default:
        throw new McpMetadataValueError(`values of type ${typeof current} are not JSON-compatible`);
    }
  }

  return bytes;
}

function metadataLimitError(kind: "tools" | "resources"): McpDiscoveryPaginationError {
  return new McpDiscoveryPaginationError(
    `MCP ${kind} discovery exceeded metadata limit of ${MCP_DISCOVERY_MAX_METADATA_BYTES} bytes.`,
  );
}

function countMcpPageMetadataBytes(
  kind: "tools" | "resources",
  value: unknown,
  remainingBytes: number,
): number {
  try {
    return countJsonCompatibleBytes(value, remainingBytes);
  } catch (error) {
    if (error instanceof McpMetadataLimitExceeded) throw metadataLimitError(kind);
    if (error instanceof McpMetadataValueError) {
      throw new McpDiscoveryPaginationError(
        `MCP ${kind} discovery received invalid metadata: ${error.message}.`,
      );
    }
    throw error;
  }
}

function countMcpCursorBytes(
  kind: "tools" | "resources",
  cursor: string,
  remainingBytes: number,
): number {
  if (typeof cursor !== "string") {
    throw new McpDiscoveryPaginationError(
      `MCP ${kind} discovery received an invalid non-string pagination cursor.`,
    );
  }
  try {
    return countUtf8StringBytes(cursor, remainingBytes);
  } catch (error) {
    if (error instanceof McpMetadataLimitExceeded) throw metadataLimitError(kind);
    throw error;
  }
}

export async function collectPaginatedMcpItems<T>(
  kind: "tools" | "resources",
  fetchPage: (cursor: string | undefined) => Promise<McpDiscoveryPage<T>>,
  checkAborted: () => void,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  let metadataBytes = 0;

  while (true) {
    checkAborted();
    if (pageCount >= MCP_DISCOVERY_MAX_PAGES) {
      throw new McpDiscoveryPaginationError(
        `MCP ${kind} discovery exceeded page limit of ${MCP_DISCOVERY_MAX_PAGES}.`,
      );
    }

    const page = await fetchPage(cursor);
    checkAborted();
    pageCount += 1;

    if (items.length + page.items.length > MCP_DISCOVERY_MAX_ITEMS) {
      throw new McpDiscoveryPaginationError(
        `MCP ${kind} discovery exceeded item limit of ${MCP_DISCOVERY_MAX_ITEMS}.`,
      );
    }

    metadataBytes += countMcpPageMetadataBytes(
      kind,
      page.items,
      MCP_DISCOVERY_MAX_METADATA_BYTES - metadataBytes,
    );
    items.push(...page.items);

    const nextCursor = page.nextCursor;
    if (!nextCursor) return items;
    if (seenCursors.has(nextCursor)) {
      throw new McpDiscoveryPaginationError(
        `MCP ${kind} discovery received a repeated pagination cursor.`,
      );
    }
    metadataBytes += countMcpCursorBytes(
      kind,
      nextCursor,
      MCP_DISCOVERY_MAX_METADATA_BYTES - metadataBytes,
    );
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

