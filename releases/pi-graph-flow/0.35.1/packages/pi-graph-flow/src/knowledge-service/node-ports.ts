import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeStageFiles } from "./ports.ts";
/** OS adapter only; no CLI lookup, account configuration or SDK initialization. */
export const nodeKnowledgeStageFiles: KnowledgeStageFiles = Object.freeze({
  createDirectory: () => mkdtemp(join(tmpdir(), "pi-knowledge-stage-")),
  join,
  writePrivateFile: async (path: string, content: string) => { await writeFile(path, content, { encoding: "utf8", mode: 0o600 }); },
  removeDirectory: async (directory: string) => { await rm(directory, { recursive: true, force: true }); },
});
