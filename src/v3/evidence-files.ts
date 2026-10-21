import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, parse, relative } from "node:path";
import { createDurableFile } from "./durable.ts";
import { canonicalDigest } from "./digests.ts";
import type { GraphEvidenceFileV3 } from "./types.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export class V3RequiredEvidenceMissingError extends Error {
 readonly code = "REQUIRED_EVIDENCE_MISSING";
 readonly path: string;
 constructor(path: string, cause: unknown) {
  super(`未生成必需验收文件：${path}；验收未通过，请查看已保留的子任务结果确认阻塞原因。`, {cause});
  this.name = "V3RequiredEvidenceMissingError";
  this.path = path;
 }
}
export function parseBusinessResult(output: string): { status: "pass" | "blocked" | "fail"; reason: string } {
 let raw;
 try { raw = JSON.parse(output); } catch { throw new Error("resultContract status-json requires exact final JSON, without Markdown fences."); }
 if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["status", "reason"].includes(k)) || !["pass", "blocked", "fail"].includes(raw.status) || typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 16384) throw new Error("resultContract requires {status: pass|blocked|fail, reason: non-empty string (max 16384)}.");
 return raw;
}
async function safeDirectories(directory: string, create = false): Promise<void> {
 const anchor = parse(directory).root;
 let cursor = anchor;
 for (const component of relative(anchor, directory).split("/")) {
  cursor = join(cursor, component);
  if (create) await mkdir(cursor, {mode: 0o700}).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const info = await lstat(cursor);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe evidence directory: ${cursor}`);
 }
}
export async function safeBytes(root: string, path: string): Promise<Buffer> {
 if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe evidence path.");
 await safeDirectories(root);
 let cursor = root;
 for (const component of path.split("/").slice(0, -1)) {
  cursor = join(cursor, component);
  const info = await lstat(cursor);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Evidence directory is unsafe: ${path}`);
 }
 const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error(`Evidence must be a single regular file <= 32 MiB: ${path}`);
  const bytes = await handle.readFile();
  const after = await handle.stat();
  if (bytes.length > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`Evidence changed while reading: ${path}`);
  return bytes;
 } finally { await handle.close(); }
}
export interface EvidenceManifest { schemaVersion: 1; taskId: string; attempt: number; files: Array<{path: string; sha256: string; size: number}>; }
export function evidenceDirectory(runDir: string, taskId: string, attempt: number): string { return join(runDir, "artifacts", taskId, `attempt-${attempt}-files`); }
async function immutable(path: string, bytes: string | Buffer): Promise<void> {
 await safeDirectories(dirname(path), true);
 try { await createDurableFile(path, bytes); }
 catch(error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await safeBytes(dirname(path), path.slice(dirname(path).length + 1))).equals(Buffer.from(bytes))) throw error; }
}
export async function persistEvidenceFiles(runDir: string, taskId: string, attempt: number, root: string, files: GraphEvidenceFileV3[]): Promise<string> {
 const manifest: EvidenceManifest = {schemaVersion: 1, taskId, attempt, files: []};
 const destination = evidenceDirectory(runDir, taskId, attempt);
 let totalBytes = 0;
 for (const entry of files) {
  if (entry.nonSecret !== true) throw new Error("Evidence retention requires explicit nonSecret:true authorization.");
  let bytes: Buffer;
  try { bytes = await safeBytes(root, entry.path); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
   // A lost/unsafe workspace is an internal integrity problem, not a missing deliverable.
   await safeDirectories(root);
   throw new V3RequiredEvidenceMissingError(entry.path, error);
  }
  totalBytes += bytes.length;
  if (totalBytes > 64 * 1024 * 1024) throw new Error("Declared evidence exceeds total 64 MiB limit.");
  await immutable(join(destination, "files", entry.path), bytes);
  manifest.files.push({path: entry.path, sha256: digest(bytes), size: bytes.length});
 }
 await immutable(join(destination, "manifest.json"), JSON.stringify(manifest));
 const bound = canonicalDigest(manifest);
 await verifyEvidenceFiles(runDir, taskId, attempt, bound);
 return bound;
}
export async function verifyEvidenceFiles(runDir: string, taskId: string, attempt: number, expectedDigest: string): Promise<EvidenceManifest> {
 const root = evidenceDirectory(runDir, taskId, attempt);
 const manifest = JSON.parse((await safeBytes(root, "manifest.json")).toString("utf8")) as EvidenceManifest;
 if (canonicalDigest(manifest) !== expectedDigest || manifest.schemaVersion !== 1 || manifest.taskId !== taskId || manifest.attempt !== attempt || !Array.isArray(manifest.files) || manifest.files.length > 64) throw new Error("Evidence manifest identity/digest mismatch.");
 for (const file of manifest.files) {
  const bytes = await safeBytes(root, `files/${file.path}`);
  if (digest(bytes) !== file.sha256 || bytes.length !== file.size) throw new Error(`Evidence file digest mismatch: ${file.path}`);
 }
 return manifest;
}
