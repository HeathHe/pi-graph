/** Structural transport boundary: the knowledge core never imports the Flow session CLI. */
export interface KnowledgeCliResult { argv: string[]; stdout: string; stderr: string; exitCode: number; }
export interface KnowledgeRunnerOptions { signal?: AbortSignal; }
export type KnowledgeRunner = (args: readonly string[], cwd: string, options?: KnowledgeRunnerOptions) => Promise<KnowledgeCliResult>;
/** Stage creates only private ephemeral evidence; canonical knowledge remains external. */
export interface KnowledgeStageFiles {
  createDirectory(): Promise<string>;
  join(directory: string, name: string): string;
  writePrivateFile(path: string, content: string): Promise<void>;
  removeDirectory(directory: string): Promise<void>;
}
