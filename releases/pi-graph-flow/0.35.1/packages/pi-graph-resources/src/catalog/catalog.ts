import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

export const RESOURCE_KINDS = ["agent", "skill", "prompt", "workflow", "template", "instruction"] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];
export interface ResourceDeclaration {
  kind: ResourceKind;
  name: string;
  source: string;
  filePath: string;
  optional?: boolean;
  /** Source declaration only: execution belongs to another module/host. */
  execution?: "host-owned" | "unavailable";
  aliases?: readonly string[];
}
export interface ResourceEntry extends Readonly<ResourceDeclaration> {
  readonly id: string;
  readonly status: "readable" | "missing" | "unreadable";
  readonly revision?: string;
  readonly diagnostic?: string;
  readonly execution: "host-owned" | "unavailable";
}
export class ResourceCatalogReadError extends Error {
  constructor(readonly code: "E_RESOURCE_UNKNOWN" | "E_RESOURCE_UNREADABLE" | "E_RESOURCE_CHANGED", message: string) { super(message); this.name = "ResourceCatalogReadError"; }
}
function hash(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function identity(value: ResourceDeclaration): string { return JSON.stringify([value.kind, value.source, value.name, resolve(value.filePath)]); }

/** Source snapshots, not activation or execution authority. Only declared files can be read. */
export class ResourceCatalog {
  private readonly entries = new Map<string, ResourceEntry>();
  async register(declarations: readonly ResourceDeclaration[]): Promise<readonly ResourceEntry[]> {
    const next = new Map<string, ResourceEntry>();
    for (const declaration of declarations) {
      if (!RESOURCE_KINDS.includes(declaration.kind) || !declaration.name || !declaration.source || !declaration.filePath) throw new Error("Invalid resource declaration");
      const filePath = resolve(declaration.filePath);
      const id = identity(declaration);
      let status: ResourceEntry["status"] = "readable", revision: string | undefined, diagnostic: string | undefined;
      try {
        if (!(await stat(filePath)).isFile()) throw new Error("Resource is not a file");
        revision = hash(await readFile(filePath));
      } catch (error) {
        status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
        diagnostic = error instanceof Error ? error.message : String(error);
      }
      next.set(id, Object.freeze({ ...declaration, id, filePath, aliases: Object.freeze([...(declaration.aliases ?? [])]), status, revision, diagnostic, execution: declaration.execution ?? "unavailable" }));
    }
    this.entries.clear();
    for (const [id, entry] of next) this.entries.set(id, entry);
    return this.snapshot();
  }
  snapshot(kind?: ResourceKind): readonly ResourceEntry[] { return Object.freeze([...this.entries.values()].filter(entry => kind === undefined || entry.kind === kind)); }
  find(kind: ResourceKind, name: string): readonly ResourceEntry[] { return Object.freeze(this.snapshot(kind).filter(entry => entry.name === name || entry.aliases?.includes(name))); }
  async read(id: string): Promise<Readonly<{ entry: ResourceEntry; content: string }>> {
    const entry = this.entries.get(id);
    if (!entry) throw new ResourceCatalogReadError("E_RESOURCE_UNKNOWN", "Resource was not declared by its host");
    if (entry.status !== "readable") throw new ResourceCatalogReadError("E_RESOURCE_UNREADABLE", entry.diagnostic ?? entry.status);
    const content = await readFile(entry.filePath);
    if (hash(content) !== entry.revision) throw new ResourceCatalogReadError("E_RESOURCE_CHANGED", "Resource changed; refresh its source snapshot before reading");
    return Object.freeze({ entry, content: content.toString("utf8") });
  }
}

export interface ResourceTreeSource { kind: ResourceKind; source: string; root: string; optional?: boolean; execution?: ResourceDeclaration["execution"]; accept(relativePath: string): boolean }
/** Enumerates actual files in explicit host roots; no implicit user/global scan or optional activation. */
export async function declareResourceTree(source: ResourceTreeSource): Promise<ResourceDeclaration[]> {
  const output: ResourceDeclaration[] = [];
  const visit = async (directory: string): Promise<void> => {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (directory === resolve(source.root)) output.push({ kind: source.kind, source: source.source, filePath: directory, name: basename(directory), optional: source.optional, execution: source.execution });
      return;
    }
    for (const child of children) {
      const path = join(directory, child.name);
      if (child.isDirectory()) await visit(path);
      else if (child.isFile() || child.isSymbolicLink()) {
        const rel = relative(resolve(source.root), path).replaceAll("\\", "/");
        if (source.accept(rel)) output.push({ kind: source.kind, name: rel, source: source.source, filePath: path, optional: source.optional, execution: source.execution });
      }
    }
  };
  await visit(resolve(source.root));
  return output;
}
