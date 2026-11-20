import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function resolveLatestSessionId(workflowRoot: string): string | null {
  const sessionsDir = join(workflowRoot, ".workflow", "sessions");
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  let latest: { id: string; mtime: number } | null = null;
  for (const id of entries) {
    try {
      const sessionPath = join(sessionsDir, id, "session.json");
      const metadata = JSON.parse(readFileSync(sessionPath, "utf8")) as { session_id?: unknown };
      if (metadata.session_id !== id) continue;
      const stats = statSync(sessionPath);
      if (!stats.isFile()) continue;
      if (!latest || stats.mtimeMs > latest.mtime) latest = { id, mtime: stats.mtimeMs };
    } catch {
      // Skip legacy, malformed, and unreadable session directories.
    }
  }
  return latest?.id ?? null;
}

