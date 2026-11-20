import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ArtifactRef, CollectionManifest } from "../knowledge-service/curator/contracts.ts";
import type { SourceArtifactsPort } from "../knowledge-service/curator/ports.ts";

const MAX_BYTES = 16 * 1024 * 1024;
const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown): boolean => (error as { code?: string })?.code === "ENOENT";
export class SourcePublicationUnknownError extends Error { readonly code = "CURATOR_HEAD_UNKNOWN"; }
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Unsupported source material");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function sourceHash(value: unknown): string { return digest(canonicalJson(value)); }

/** Explicit private root only. A crashed collection lock cannot block another collection. */
export function createImmutableSourceArtifacts(rootInput: string): SourceArtifactsPort {
  if (!rootInput || !isAbsolute(rootInput)) throw new Error("Explicit absolute Curator data root required");
  const root = resolve(rootInput);
  const verifyParents = (path: string, allowRootAncestor = false): void => {
    const absolute = resolve(path);
    if (absolute !== root && !absolute.startsWith(root + sep) && !(allowRootAncestor && root.startsWith(absolute === sep ? sep : absolute + sep))) throw new Error("Source path escaped its private root");
    let current = absolute;
    while (true) {
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error("Source symlink is forbidden");
        if ((current === root || current.startsWith(root + sep)) && stat.isDirectory() && (stat.mode & 0o777) !== 0o700) throw new Error("Source directory must have private 0700 permissions");
      }
      catch (error) { if (!missing(error)) throw error; }
      const parent = dirname(current); if (parent === current) break; current = parent;
    }
  };
  const syncDirectory = (path: string, allowRootAncestor = false): void => {
    verifyParents(path, allowRootAncestor); const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const directory = (path: string): void => {
    verifyParents(path);
    const pending: string[] = []; let current = path;
    while (true) {
      try { if (!lstatSync(current).isDirectory()) throw new Error("Invalid source directory"); break; }
      catch (error) { if (!missing(error)) throw error; pending.push(current); current = dirname(current); }
    }
    // Each new entry needs its own parent publication sync. Existing ancestors
    // outside the explicit root are checked for symlinks, not chmodded or claimed private.
    for (const next of pending.reverse()) {
      verifyParents(next, true);
      try { mkdirSync(next, { mode: 0o700 }); } catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
      const stat = lstatSync(next);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error("New source directory must have private 0700 permissions");
      syncDirectory(next, true); syncDirectory(dirname(next), true);
    }
    verifyParents(path); if (!lstatSync(path).isDirectory()) throw new Error("Invalid source directory");
  };
  directory(root);
  if (realpathSync(root) !== root) throw new Error("Source root must be canonical");
  const blobDir = join(root, "blobs"), collectionDir = join(root, "collections");
  directory(blobDir); directory(collectionDir);
  const id = (value: string): string => { if (!/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error("Invalid collection id"); return value; };
  const safeRead = (path: string): Buffer => {
    verifyParents(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid or oversized source artifact");
      if ((stat.mode & 0o777) !== 0o600) throw new Error("Source artifact must have private 0600 permissions");
      const bytes = readFileSync(fd); if (bytes.length > MAX_BYTES) throw new Error("Oversized source artifact"); return bytes;
    } finally { closeSync(fd); }
  };
  const privateWrite = (path: string, bytes: string): void => {
    verifyParents(path); const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const validateRef = (ref: ArtifactRef): void => { if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || ref.byteLength > MAX_BYTES) throw new Error("Invalid source reference"); };
  const read = <T>(ref: ArtifactRef): T => {
    validateRef(ref); const bytes = safeRead(join(blobDir, ref.sha256 + ".json"));
    if (bytes.length !== ref.byteLength || digest(bytes) !== ref.sha256) throw new Error("Source artifact hash mismatch");
    return JSON.parse(bytes.toString("utf8")) as T;
  };
  const seal = (value: unknown): ArtifactRef => {
    const text = canonicalJson(value), bytes = Buffer.from(text), ref = { sha256: digest(bytes), byteLength: bytes.length };
    validateRef(ref); const path = join(blobDir, ref.sha256 + ".json");
    if (existsSync(path)) { read(ref); return ref; }
    const tmp = join(blobDir, randomUUID() + ".tmp"); privateWrite(tmp, text);
    try { try { linkSync(tmp, path); syncDirectory(blobDir); } catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; } read(ref); }
    finally { unlinkSync(tmp); }
    return ref;
  };
  const head = (collectionId: string): { revision: number; ref: ArtifactRef } | undefined => {
    const path = join(collectionDir, id(collectionId), "HEAD.json"); let bytes: Buffer;
    try { bytes = safeRead(path); } catch (error) { if (missing(error)) return undefined; throw error; }
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || value.schema !== "curator-head/1" || value.collectionId !== collectionId || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Invalid Curator head");
    validateRef(value.ref); const manifest = read<CollectionManifest>(value.ref);
    if (manifest.schema !== "curator-collection/1" || manifest.id !== collectionId || manifest.revision !== value.revision) throw new Error("Curator head manifest mismatch");
    return { revision: value.revision, ref: value.ref };
  };
  return {
    seal, read, head,
    list: () => { verifyParents(collectionDir); return readdirSync(collectionDir).map(id).sort(); },
    commit(collectionId, expectedRevision, value) {
      const dir = join(collectionDir, id(collectionId)); directory(dir);
      const lock = join(dir, "head.lock"); privateWrite(lock, randomUUID());
      let tmp: string | undefined;
      try {
        const old = head(collectionId);
        if ((old?.revision ?? 0) !== expectedRevision || value.revision !== expectedRevision + 1) throw new Error("Curator head revision conflict");
        const ref = seal(value), next = canonicalJson({ schema: "curator-head/1", collectionId, revision: value.revision, ref });
        tmp = join(dir, randomUUID() + ".tmp"); privateWrite(tmp, next);
        try { renameSync(tmp, join(dir, "HEAD.json")); tmp = undefined; syncDirectory(dir); }
        catch (error) { throw new SourcePublicationUnknownError(`Curator publication requires reconciliation: ${String(error)}`); }
        const observed = head(collectionId);
        if (!observed || observed.ref.sha256 !== ref.sha256) throw new SourcePublicationUnknownError("Curator publication not observed");
      } finally { if (tmp) unlinkSync(tmp); unlinkSync(lock); }
    },
  };
}
