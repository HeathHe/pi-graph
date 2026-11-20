import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { createEventBus, loadSkills, type PathMetadata } from "@earendil-works/pi-coding-agent";
import { loadOwnedExtensionSet } from "m18:owned-extension-policy";
import { loadPromptTemplates } from "m18:owned-prompts";
import { loadThemeFromPath } from "m18:owned-theme";
import { createSourceInfo } from "m18:owned-source-info";
import type { ResourceLoader, ResourceExtensionPaths, ResourceLoaderReloadOptions, LoadExtensionsResult, InlineExtension } from "./sdk-types.js";
import type { RuntimeInput } from "./host-types.js";

type Resources = Omit<ResourceLoader, "reload" | "extendResources">;
export interface OwnedResourceInput {
  readonly ownedRoots: readonly string[];
  readonly cwd: string;
  readonly agentDir: string;
  readonly extensionPaths: readonly string[];
  /** Exact trusted composition table; never rediscovered or reconstructed from names. */
  readonly extensionFactories?: readonly InlineExtension[];
  /** Explicit enabled builtin names; omission enables none, never daily discovery. */
  readonly builtinNames?: readonly string[];
  readonly skillPaths: readonly string[];
  readonly promptPaths: readonly string[];
  readonly themePaths: readonly string[];
  readonly contextPaths: readonly string[];
  readonly systemPromptPath?: string;
  readonly appendSystemPromptPaths: readonly string[];
}
interface ResourcePaths { skills: string[]; prompts: string[]; themes: string[]; }

/** Explicit owned inputs only. No DefaultResourceLoader, package resolve, or HOME discovery. */
export class OwnedResourceLoader implements ResourceLoader {
  readonly #roots: string[];
  readonly #input: OwnedResourceInput;
  readonly #eventBus = createEventBus();
  #resources: Resources | undefined;
  #loading = false;
  #loadedOnce = false;
  #extra: ResourcePaths = { skills: [], prompts: [], themes: [] };
  #metadata = new Map<string, PathMetadata>();

  constructor(input: OwnedResourceInput) {
    if (input.ownedRoots.length === 0) throw new Error("M18 owned roots are required");
    this.#roots = input.ownedRoots.map((path) => {
      if (!isAbsolute(path)) throw new Error("M18 roots must be absolute");
      const canonical = realpathSync(path);
      if (!statSync(canonical).isDirectory()) throw new Error("M18 root must be a directory");
      return canonical;
    });
    this.#input = {
      ...input,
      ownedRoots: [...input.ownedRoots], extensionPaths: [...input.extensionPaths],
      extensionFactories: input.extensionFactories, builtinNames: [...(input.builtinNames ?? [])],
      skillPaths: [...input.skillPaths], promptPaths: [...input.promptPaths],
      themePaths: [...input.themePaths], contextPaths: [...input.contextPaths],
      appendSystemPromptPaths: [...input.appendSystemPromptPaths],
    };
    // Validate the whole surface before the first factory; reload repeats these checks.
    this.#validateInputs();
  }
  #path(path: string): string {
    if (!isAbsolute(path)) throw new Error(`M18 explicit absolute owned path required: ${path}`);
    const canonical = realpathSync(path); // Missing paths are failures, never fake empty success.
    const allowed = this.#roots.some((root) => {
      const rel = relative(root, canonical);
      return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
    });
    if (!allowed) throw new Error(`M18 resource escapes owned roots: ${path}`);
    return canonical;
  }
  #file(path: string): string {
    const canonical = this.#path(path);
    if (!statSync(canonical).isFile()) throw new Error(`M18 expected a real file: ${path}`);
    return canonical;
  }
  #tree(path: string, ancestors = new Set<string>()): string {
    const canonical = this.#path(path);
    const stat = statSync(canonical);
    if (stat.isFile()) return canonical;
    if (!stat.isDirectory()) throw new Error(`M18 unsupported resource node: ${path}`);
    if (ancestors.has(canonical)) throw new Error(`M18 cyclic resource directory: ${path}`);
    const next = new Set(ancestors).add(canonical);
    for (const entry of readdirSync(canonical)) this.#tree(join(canonical, entry), next);
    return canonical;
  }
  #validateInputs(): void {
    this.#path(this.#input.cwd);
    this.#path(this.#input.agentDir);
    const entries = this.#input.extensionPaths.map((path) => this.#file(path));
    if (new Set(entries).size !== entries.length) throw new Error("M18 duplicate FILE entry");
    for (const path of [...this.#input.skillPaths, ...this.#input.promptPaths, ...this.#input.themePaths,
      ...this.#extra.skills, ...this.#extra.prompts, ...this.#extra.themes]) this.#tree(path);
    for (const path of [...this.#input.contextPaths, ...this.#input.appendSystemPromptPaths]) this.#file(path);
    if (this.#input.systemPromptPath !== undefined) this.#file(this.#input.systemPromptPath);
  }
  #get(): Resources {
    if (this.#resources === undefined) throw new Error("M18 resources have not loaded successfully");
    return this.#resources;
  }
  getExtensions(): LoadExtensionsResult { return this.#get().getExtensions(); }
  getSkills(): ReturnType<ResourceLoader["getSkills"]> { return this.#get().getSkills(); }
  getPrompts(): ReturnType<ResourceLoader["getPrompts"]> { return this.#get().getPrompts(); }
  getThemes(): ReturnType<ResourceLoader["getThemes"]> { return this.#get().getThemes(); }
  getAgentsFiles(): ReturnType<ResourceLoader["getAgentsFiles"]> { return this.#get().getAgentsFiles(); }
  getSystemPrompt(): string | undefined { return this.#get().getSystemPrompt(); }
  getSystemPromptSource(): ReturnType<ResourceLoader["getSystemPromptSource"]> { return this.#get().getSystemPromptSource(); }
  getAppendSystemPrompt(): string[] { return this.#get().getAppendSystemPrompt(); }
  getAppendSystemPromptSources(): ReturnType<ResourceLoader["getAppendSystemPromptSources"]> { return this.#get().getAppendSystemPromptSources(); }
  #readResources(paths: ResourcePaths): Omit<Resources, "getExtensions"> {
    const skills = loadSkills({ cwd: this.#input.cwd, agentDir: this.#input.agentDir, skillPaths: paths.skills, includeDefaults: false });
    const prompts = loadPromptTemplates({ cwd: this.#input.cwd, agentDir: this.#input.agentDir, promptPaths: paths.prompts, includeDefaults: false });
    const themeFiles: string[] = [];
    for (const path of paths.themes) {
      const canonical = this.#tree(path);
      if (statSync(canonical).isFile()) themeFiles.push(canonical);
      else for (const name of readdirSync(canonical)) {
        const file = join(canonical, name);
        if (name.endsWith(".json") && statSync(this.#path(file)).isFile()) themeFiles.push(this.#file(file));
      }
    }
    const themes = [...new Set(themeFiles)].map((path) => loadThemeFromPath(path));
    const source = (path: string) => {
      const canonical = this.#file(path);
      for (const [entry, metadata] of this.#metadata) {
        const rel = relative(entry, canonical);
        if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) return createSourceInfo(canonical, metadata);
      }
      return undefined;
    };
    for (const skill of skills.skills) skill.sourceInfo = source(skill.filePath) ?? skill.sourceInfo;
    for (const prompt of prompts.templates) prompt.sourceInfo = source(prompt.filePath) ?? prompt.sourceInfo;
    for (const theme of themes) if (theme.sourcePath !== undefined) theme.sourceInfo = source(theme.sourcePath) ?? theme.sourceInfo;
    const context = this.#input.contextPaths.map((path) => ({ path: this.#file(path), content: readFileSync(this.#file(path), "utf8") }));
    const systemPath = this.#input.systemPromptPath === undefined ? undefined : this.#file(this.#input.systemPromptPath);
    const system = systemPath === undefined ? undefined : readFileSync(systemPath, "utf8");
    const appendPaths = this.#input.appendSystemPromptPaths.map((path) => this.#file(path));
    const append = appendPaths.map((path) => readFileSync(path, "utf8"));
    return {
      getSkills: () => ({ skills: skills.skills.slice(), diagnostics: skills.diagnostics.slice() }),
      getPrompts: () => ({ prompts: prompts.templates.slice(), diagnostics: prompts.diagnostics.slice() }),
      // Theme errors throw with their original error; empty is only legitimate for explicit empty input.
      getThemes: () => ({ themes: themes.slice(), diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: context.map((entry) => ({ ...entry })) }),
      getSystemPrompt: () => system,
      getSystemPromptSource: () => systemPath === undefined ? undefined : { path: systemPath },
      getAppendSystemPrompt: () => append.slice(),
      getAppendSystemPromptSources: () => appendPaths.map((path) => ({ path })),
    };
  }
  #paths(extra = this.#extra): ResourcePaths {
    return {
      skills: [...new Set([...this.#input.skillPaths, ...extra.skills].map((path) => this.#tree(path)))],
      prompts: [...new Set([...this.#input.promptPaths, ...extra.prompts].map((path) => this.#tree(path)))],
      themes: [...new Set([...this.#input.themePaths, ...extra.themes].map((path) => this.#tree(path)))],
    };
  }
  extendResources(paths: ResourceExtensionPaths): void {
    if (this.#loading) throw new Error("M18 resource extension during reload is not allowed");
    const previous = this.#get();
    const metadata = new Map(this.#metadata);
    const validate = (entries: NonNullable<ResourceExtensionPaths["skillPaths"]>) => entries.map((entry) => {
      const path = this.#tree(entry.path);
      // Metadata does not gain permission to reference an external package/base directory.
      if (entry.metadata.baseDir !== undefined) this.#path(entry.metadata.baseDir);
      if (entry.metadata.packageRoot !== undefined) this.#path(entry.metadata.packageRoot);
      metadata.set(path, { ...entry.metadata });
      return path;
    });
    // All three categories are validated before reading any new resource.
    const extra = { skills: [...this.#extra.skills, ...validate(paths.skillPaths ?? [])],
      prompts: [...this.#extra.prompts, ...validate(paths.promptPaths ?? [])],
      themes: [...this.#extra.themes, ...validate(paths.themePaths ?? [])] };
    const oldMetadata = this.#metadata;
    try {
      this.#metadata = metadata;
      const resources = this.#readResources(this.#paths(extra));
      this.#extra = extra;
      this.#resources = { ...resources, getExtensions: () => previous.getExtensions() };
    } catch (error) { this.#metadata = oldMetadata; throw error; }
  }
  async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
    if (this.#loading) throw new Error("M18 concurrent resource reload");
    // Explicit owned input does not implement project trust discovery. Never silently discard it.
    if (options?.resolveProjectTrust !== undefined) throw new Error("M18 owned loader does not perform project trust discovery");
    this.#loading = true;
    this.#resources = undefined;
    try {
      this.#validateInputs();
      const resources = this.#readResources(this.#paths());
      // The entire input surface is checked before a single extension module/factory is evaluated.
      const paths = this.#input.extensionPaths.map((path) => this.#file(path));
      const extensions = await loadOwnedExtensionSet({
        cwd: this.#input.cwd, eventBus: this.#eventBus, extensionPaths: paths,
        extensionFactories: this.#input.extensionFactories ?? [], builtinNames: this.#input.builtinNames ?? [],
        clearCache: this.#loadedOnce,
      });
      // Original loader reports FILE errors/conflicts in errors, preserves warnings and precedence.
      // Never replace these diagnostics with an empty-success result or throw on every conflict.
      this.#loadedOnce = true;
      this.#validateInputs();
      this.#resources = { ...resources, getExtensions: () => extensions };
    } finally { this.#loading = false; }
  }
}

/** Trusted Host callback adapter: forwards the exact same composed factory table before loading. */
export function createOwnedHostResourceLoader(
  input: RuntimeInput,
  owned: Omit<OwnedResourceInput, "cwd" | "agentDir" | "extensionFactories">,
): OwnedResourceLoader {
  return new OwnedResourceLoader({ ...owned, cwd: input.cwd, agentDir: input.agentDir,
    extensionFactories: input.extensionFactories });
}
