import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep, basename } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GRAPH_READONLY_TOOLS = ["graph_readonly_list", "graph_readonly_find", "graph_readonly_sha256"] as const;
export interface ReadonlyAuthority {
 cwd: string;
 scopes: Array<{kind: "file" | "tree"; path: string}>;
 deniedRoots?: string[];
 inputFiles?: string[];
}
interface ReadonlyInput { path: string; namePattern?: string; maxDepth?: number; offset?: number; limit?: number }
const within = (root: string, target: string) => { const rel = relative(root, target); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const denied = () => new Error("Readonly access denied or unavailable.");
function checkInput(name: string, input: ReadonlyInput) {
 const fields = name.endsWith("sha256") ? ["path"] : name.endsWith("find") ? ["path", "namePattern", "maxDepth", "offset", "limit"] : ["path", "offset", "limit"];
 if (!input || Object.keys(input).some(key => !fields.includes(key)) || typeof input.path !== "string" || !input.path || input.path.includes("\0") || input.path.split(/[\\/]/u).includes("..")) throw denied();
 for (const [value, min, max] of [[input.offset, 0, 100000], [input.limit, 1, 200], [input.maxDepth, 0, 32]] as const) if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) throw denied();
 if (input.namePattern !== undefined && (typeof input.namePattern !== "string" || input.namePattern.length > 200 || /[\\/\0]/u.test(input.namePattern))) throw denied();
}
export async function executeGraphReadonly(name: string, input: ReadonlyInput, authority: ReadonlyAuthority, signal?: AbortSignal) {
 try {
  if (!(GRAPH_READONLY_TOOLS as readonly string[]).includes(name)) throw denied();
  checkInput(name, input);
  const root = await realpath(authority.cwd);
  const scopes: ReadonlyAuthority["scopes"] = [];
  for (const scope of authority.scopes) {
   const path = resolve(root, scope.path);
   try { if (await realpath(path) === path) scopes.push({...scope, path}); } catch { /* Missing scope grants nothing. */ }
  }
  const target = resolve(root, input.path);
  const explicitInput = (path: string) => (authority.inputFiles ?? []).some(file => scopes.some(scope => scope.kind === "file" && scope.path === file) && within(resolve(root, ".pi-graph/inputs"), file) && within(path, file));
  const isDenied = (path: string) => !within(root, path) || (!explicitInput(path) && ( (authority.deniedRoots ?? []).some(block => within(resolve(block), path)) || relative(root, path).split(sep).some((part, i, all) => [".git", ".pi-graph", ".pi-subagents"].includes(part) || (part === "agents" && all[i - 1] === ".pi"))));
  const allowed = (path: string) => !isDenied(path) && scopes.some(scope => scope.kind === "tree" ? within(scope.path, path) : path === scope.path);
  const navigable = (path: string) => !isDenied(path) && (allowed(path) || scopes.some(scope => within(path, scope.path)));
  const inspect = async (path: string) => {
   if (signal?.aborted) throw new Error("Readonly operation cancelled.");
   if (!navigable(path)) throw denied();
   let current = root;
   for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw denied();
   }
   const canonical = await realpath(path);
   if (canonical !== path || !navigable(canonical)) throw denied();
   const info = await lstat(path);
   if (!info.isFile() && !info.isDirectory()) throw denied();
   return info;
  };
  const info = await inspect(target);
  if (name.endsWith("sha256")) {
   if (!info.isFile() || !allowed(target)) throw denied();
   // O_NOFOLLOW blocks final-component replacement; verify the opened descriptor
   // still matches the checked regular file before consuming any bytes.
   const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
   try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || await realpath(target) !== target) throw denied();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({autoClose: false})) { if (signal?.aborted) throw new Error("Readonly operation cancelled."); hash.update(chunk); }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("File changed during hashing; retry.");
    return {path: relative(root, target), algorithm: "sha256", digest: hash.digest("hex"), bytes: opened.size};
   } finally { await handle.close(); }
  }
  if (!info.isDirectory()) throw denied();
  const pattern = input.namePattern ?? "*";
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "u");
  const entries: Array<{path: string; kind: string}> = [];
  const maxDepth = name.endsWith("find") ? input.maxDepth ?? 8 : 0;
  const offset = input.offset ?? 0, limit = input.limit ?? 100;
  let visited = 0, truncated = false;
  async function walk(directory: string, depth: number): Promise<void> {
   await inspect(directory);
   for (const leaf of (await readdir(directory)).sort()) {
    const path = resolve(directory, leaf);
    if (!navigable(path)) continue;
    if (++visited > 10000 || entries.length > offset + limit) { truncated = true; return; }
    let child;
    try { child = await inspect(path); } catch { continue; }
    if (allowed(path) && (name.endsWith("list") || regex.test(basename(path)))) entries.push({path: relative(root, path), kind: child.isDirectory() ? "directory" : "file"});
    if (child.isDirectory() && depth < maxDepth) await walk(path, depth + 1);
    if (truncated) return;
   }
  }
  await walk(target, 0);
  const page = entries.slice(offset, offset + limit);
  const hasMore = entries.length > offset + limit;
  return {entries: page, truncated: truncated || hasMore, ...(hasMore ? {nextOffset: offset + limit} : {}), ...(truncated && !hasMore ? {note: "Traversal capacity reached; narrow path or namePattern."} : {})};
 } catch (error) {
  if (signal?.aborted) throw new Error("Readonly operation cancelled.");
  if (error instanceof Error && error.message === "File changed during hashing; retry.") throw error;
  throw denied();
 }
}
export function registerGraphReadonlyTools(pi: ExtensionAPI, authority: (cwd: string) => ReadonlyAuthority) {
 const page = {offset: Type.Optional(Type.Integer({minimum: 0, maximum: 100000})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 200}))};
 for (const name of GRAPH_READONLY_TOOLS) {
  const parameters = Type.Object({path: Type.String({minLength: 1}), ...(name.endsWith("sha256") ? {} : page), ...(name.endsWith("find") ? {namePattern: Type.Optional(Type.String({maxLength: 200})), maxDepth: Type.Optional(Type.Integer({minimum: 0, maximum: 32}))} : {})}, {additionalProperties: false});
  pi.registerTool({name, label: name, description: "Read-only scoped filesystem inspection. No shell. Paths are relative to the supplied workspace; find supports * and ? filename patterns. Results report truncation.", parameters,
   async execute(_id, params, signal, _update, ctx) { const result = await executeGraphReadonly(name, params as ReadonlyInput, authority(ctx.cwd), signal); return {content: [{type: "text", text: JSON.stringify(result)}], details: result}; }
  });
 }
}
