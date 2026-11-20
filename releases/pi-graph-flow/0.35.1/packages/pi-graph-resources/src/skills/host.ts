/** M09 owns skill configuration/prompt policy; M18 owns SDK discovery. M11 only consumes these ports. */
export interface SkillDefaults { params: Record<string, string | boolean | number>; updated?: string; "disable-model-invocation"?: boolean; enabled?: boolean }
export interface SkillPromptBudgets { maxFileBytes: number; maxTotalBytes: number }
export interface LoadedSkillConfig {
  config: { version: string; skills: Record<string, SkillDefaults>; groups: Record<string, { skills: string[] }>; limits: SkillPromptBudgets };
  configHash: string; globalPath: string; projectPath: string;
}
export interface DiscoveredSkill { name: string; filePath: string; baseDir: string; disableModelInvocation?: boolean }
export interface SkillDiscoveryLoader { reload(): Promise<void>; getSkills(): { skills: DiscoveredSkill[] } }
export interface SkillResourceHost {
  getAgentDir(): string;
  homeDir(): string;
  createResourceLoader(options: { cwd: string; agentDir: string; noExtensions: true; noPromptTemplates: true; noThemes: true; noContextFiles: true }): SkillDiscoveryLoader;
  parseFrontmatter<T extends Record<string, unknown>>(content: string): { body: string; frontmatter: T };
  loadSkillConfig(cwd: string, agentDir: string): Promise<LoadedSkillConfig>;
  renderSkillConfigDefaults(name: string, defaults: SkillDefaults | undefined, args: string | undefined): string | null;
}
let configured: Readonly<SkillResourceHost> | undefined;
export function configureSkillResourceHost(host: SkillResourceHost): void { configured = Object.freeze({ ...host }); }
export function skillHost(): Readonly<SkillResourceHost> {
  if (!configured) throw new Error("Skill resource host is not configured");
  return configured;
}
