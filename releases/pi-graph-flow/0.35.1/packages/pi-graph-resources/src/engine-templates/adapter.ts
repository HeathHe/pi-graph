import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface EngineTemplateMeta { readonly name: string; readonly category: string; readonly path: string }
interface TemplateApi {
  getPromptsDir(): string; getProtocolsDir(): string;
  scanTemplates(forceRescan?: boolean): Promise<Map<string, EngineTemplateMeta>>;
  findTemplate(name: string): Promise<EngineTemplateMeta | undefined>;
  loadTemplate(name: string): Promise<string | null>;
  loadProtocol(mode: "analysis" | "write"): Promise<string | null>;
}
export interface EngineTemplateOptions { approvedEngineRoot: string; maestroHome: string }
function within(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
const sessions = new Map<string, string>();
/** Fixed 0.5.91 deep API adapter; never changes process.env or the engine's global paths/cache. */
export async function openEngineTemplateReader(options: EngineTemplateOptions) {
  const root = await realpath(options.approvedEngineRoot), home = await realpath(options.maestroHome);
  if (resolve(process.env.MAESTRO_HOME ?? "") !== home) throw new Error("Host must set the approved MAESTRO_HOME before the engine's first import");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.name !== "maestro-flow" || manifest.version !== "0.5.91") throw new Error("Unsupported template engine identity/version");
  if (sessions.has(root) && sessions.get(root) !== home) throw new Error("Engine template module is already bound to another home");
  const modulePath = await realpath(join(root, "dist/src/config/template-discovery.js"));
  if (!within(root, modulePath)) throw new Error("Template API escapes approved engine root");
  const api = await import(pathToFileURL(modulePath).href) as TemplateApi;
  for (const key of ["getPromptsDir", "getProtocolsDir", "scanTemplates", "findTemplate", "loadTemplate", "loadProtocol"] as const) {
    if (typeof api[key] !== "function") throw new Error(`Unsupported template API: ${key}`);
  }
  const pathsModule = await import(pathToFileURL(join(root, "dist/src/config/paths.js")).href);
  if (resolve(pathsModule.paths?.home ?? "") !== home) throw new Error("Engine was imported under a different MAESTRO_HOME");
  const global = join(home, "templates/cli"), packaged = join(root, "templates/cli");
  let base = packaged;
  try { await stat(global); base = global; } catch { /* Preserve engine's whole-root fallback. */ }
  const prompts = resolve(api.getPromptsDir()), protocols = resolve(api.getProtocolsDir());
  if (prompts !== join(base, "prompts") || protocols !== join(base, "protocols")) throw new Error("Engine template roots differ from the approved layout");
  // Symlink targets must stay in the host-approved home/package. Missing optional
  // template directories are allowed and remain visible as empty/null API results.
  for (const directory of [prompts, protocols]) {
    let actual: string;
    try { actual = await realpath(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!within(base === global ? home : root, actual)) throw new Error("Template directory escapes approved root");
  }
  sessions.set(root, home);
  const approvedFile = async (path: string): Promise<void> => {
    if (!within(prompts, path) && !within(protocols, path)) throw new Error("Template file escapes declared directories");
    let actual: string;
    try { actual = await realpath(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!within(base === global ? home : root, actual)) throw new Error("Template file escapes approved root");
  };
  const copyMeta = async (value: EngineTemplateMeta): Promise<EngineTemplateMeta> => {
    if (typeof value?.name !== "string" || typeof value.category !== "string" || typeof value.path !== "string") throw new Error("Invalid engine template metadata");
    await approvedFile(value.path);
    return Object.freeze({ name: value.name, category: value.category, path: value.path });
  };
  return Object.freeze({
    engineVersion: "0.5.91" as const, promptsDir: prompts, protocolsDir: protocols,
    async scan(forceRescan = false): Promise<readonly EngineTemplateMeta[]> {
      const live = await api.scanTemplates(forceRescan);
      if (!(live instanceof Map)) throw new Error("Invalid engine template index");
      return Object.freeze(await Promise.all([...live.values()].map(copyMeta)));
    },
    async find(name: string): Promise<EngineTemplateMeta | undefined> {
      const value = await api.findTemplate(name);
      return value && copyMeta(value);
    },
    async loadTemplate(name: string): Promise<string | null> {
      const value = await api.findTemplate(name);
      if (value) await copyMeta(value);
      return api.loadTemplate(name);
    },
    async loadProtocol(mode: "analysis" | "write"): Promise<string | null> {
      if (mode !== "analysis" && mode !== "write") throw new Error("Unsupported protocol mode");
      await approvedFile(join(protocols, `${mode}-protocol.md`));
      return api.loadProtocol(mode);
    },
  });
}
