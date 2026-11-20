import type { KnowledgeRunner, KnowledgeCliResult, KnowledgeStageFiles } from "./ports.ts";
import { nodeKnowledgeStageFiles } from "./node-ports.ts";
import type { KnowledgeReviewView, KnowledgeSearchOptions, KnowledgeSearchResult, KnowledgeLoadResult, KnowledgeAudit, KnowledgeResolveOptions, ResolveManyItem, ResolveManyResult, KnowledgePromoteResult, KnowledgeRecordOptions, KnowledgeRecordResult, KnowledgeStageOptions, KnowledgeStageResult } from "./contracts.ts";

export class KnowledgeCliAdapter {
  constructor(
    readonly workflowRoot: string,
    private readonly runner: KnowledgeRunner,
    private readonly stageFiles: KnowledgeStageFiles = nodeKnowledgeStageFiles,
  ) {}

  async review(
    sessionId: string,
    options: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<KnowledgeReviewView> {
    return this.invokeJson<KnowledgeReviewView>([
      "knowledge", "review", required(sessionId, "sessionId"),
      ...(options.refresh ? ["--refresh"] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ], options.signal);
  }

  async search(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchResult> {
    const limit = options.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new Error("limit must be an integer in [1, 100]");
    }
    const result = await this.invokeJson<KnowledgeSearchResult>([
      "search", required(query, "query"),
      ...(options.kind ? ["--type", options.kind] : []),
      ...(limit === undefined ? [] : ["--limit", String(limit)]),
      "--json",
      "--workflow-root", this.workflowRoot,
    ], options.signal);
    if (!Array.isArray(result.results) || !Number.isSafeInteger(result.count) || result.count < 0) {
      throw new Error("maestro search returned an unsupported JSON schema");
    }
    return result;
  }

  async load(kind: "spec" | "knowhow", id: string, options: { signal?: AbortSignal } = {}): Promise<KnowledgeLoadResult> {
    // `maestro load` resolves the repository from cwd and intentionally has no
    // --workflow-root option in the supported CLI schema.
    const args = ["load", "--type", kind, "--id", required(id, "id")];
    const result = await this.runner(args, this.workflowRoot, { signal: options.signal });
    if (result.exitCode !== 0) {
      throw new Error(`maestro ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    if (!result.stdout.trim()) throw new Error(`maestro ${args.join(" ")} returned empty output`);
    return { id, kind, content: result.stdout };
  }

  async audit(
    scope: "spec" | "knowhow" | "all" = "all",
    options: { signal?: AbortSignal } = {},
  ): Promise<KnowledgeAudit> {
    return this.invokeJson<KnowledgeAudit>([
      "knowledge", "audit",
      "--scope", scope,
      "--json",
      "--workflow-root", this.workflowRoot,
    ], options.signal);
  }

  async resolve(sessionId: string, candidateId: string, options: KnowledgeResolveOptions): Promise<KnowledgeReviewView> {
    return this.invokeJson<KnowledgeReviewView>([
      "knowledge", "review", required(sessionId, "sessionId"),
      "--resolve", required(candidateId, "candidateId"),
      "--as", required(options.as, "as"),
      ...(options.target ? ["--target", options.target] : []),
      "--reason", required(options.reason, "reason"),
      "--json",
      "--workflow-root", this.workflowRoot,
    ], options.signal);
  }

  async resolveMany(
    sessionId: string,
    items: readonly ResolveManyItem[],
    options: { signal?: AbortSignal } = {},
  ): Promise<ResolveManyResult> {
    const failed: Array<{ candidateId: string; error: string }> = [];
    let resolved = 0;
    for (const item of items) {
      const signal = options.signal ?? item.signal;
      try {
        await this.resolve(sessionId, item.candidateId, {
          as: item.as,
          target: item.target,
          reason: item.reason,
          signal,
        });
        resolved += 1;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        failed.push({ candidateId: item.candidateId, error: errorMessage(error) });
      }
    }
    return { resolved, failed };
  }

  async promote(
    sessionId: string,
    options: { candidates?: readonly string[]; all?: boolean; signal?: AbortSignal },
  ): Promise<KnowledgePromoteResult> {
    const candidates = options.candidates ?? [];
    if (!options.all && candidates.length === 0) {
      throw new Error("promote requires at least one candidate id or --all");
    }
    return this.invokeJson<KnowledgePromoteResult>([
      "knowledge", "promote", required(sessionId, "sessionId"),
      ...candidates.flatMap((candidate) => ["--candidate", candidate]),
      ...(options.all ? ["--all"] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ], options.signal);
  }

  async recordInputs(
    options: KnowledgeRecordOptions,
    invocation: { signal?: AbortSignal } = {},
  ): Promise<KnowledgeRecordResult> {
    const ids = options.knowledgeIds.map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) throw new Error("knowledgeIds must be non-empty");
    return this.invokeJson<KnowledgeRecordResult>([
      "knowledge", "record", ...ids,
      "--signal", options.signal ?? "consumed",
      "--source", options.source ?? "search",
      ...(options.evidence?.length ? ["--evidence", options.evidence.join(",")] : []),
      ...(options.runId ? ["--run", required(options.runId, "runId")] : []),
      ...(options.sessionId ? ["--session", required(options.sessionId, "sessionId")] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ], invocation.signal);
  }

  async stage(
    options: KnowledgeStageOptions,
    invocation: { signal?: AbortSignal } = {},
  ): Promise<KnowledgeStageResult> {
    const target = required(options.target, "target");
    const title = required(options.title, "title");
    const content = required(options.content, "content");
    if (options.signal && !options.signalIds?.length) {
      throw new Error("signal requires signalIds");
    }
    if (options.signalIds?.length && !options.signal) {
      throw new Error("signalIds requires signal");
    }
    const args = [
      "knowledge", "stage", target, title,
      ...(options.sessionId ? ["--session", required(options.sessionId, "sessionId")] : []),
      ...(options.runId ? ["--run", required(options.runId, "runId")] : []),
      ...(options.action ? ["--action", options.action] : []),
      ...(options.category ? ["--category", options.category] : []),
      ...(options.evidence?.length ? ["--evidence", options.evidence.join(",")] : []),
      ...(options.signal ? ["--signal", options.signal] : []),
      ...(options.signalIds?.length ? ["--signal-ids", options.signalIds.join(",")] : []),
      ...(options.executionAuthorityFile ? ["--execution-authority", required(options.executionAuthorityFile, "executionAuthorityFile")] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ];
    // K13/K14: --transcript-quote <path> 透传。defaultRunner（src/session/cli-adapter.ts）
    // 以 stdio:["ignore",...] 拉起子进程，不支持 stdin 注入，因此 JSON 写入
    // os.tmpdir() 下的私有临时目录；argv 只出现文件路径，quote 原文不进进程列表。
    // 显式 transcriptQuote（JSON 字符串）优先于 transcriptQuoteFile。
    let transcriptQuotePath: string | undefined;
    let privateTmpDir: string | undefined;
    try {
      // Candidate content is sensitive and may be large. Keep it out of argv and
      // process listings; the current Maestro CLI accepts only --content-file.
      privateTmpDir = await this.stageFiles.createDirectory();
      const contentPath = this.stageFiles.join(privateTmpDir, "content.md");
      await this.stageFiles.writePrivateFile(contentPath, content);
      args.push("--content-file", contentPath);
      if (options.transcriptQuote !== undefined) {
        transcriptQuotePath = this.stageFiles.join(privateTmpDir, "quote.json");
        await this.stageFiles.writePrivateFile(transcriptQuotePath, options.transcriptQuote);
      } else if (options.transcriptQuoteFile !== undefined) {
        transcriptQuotePath = required(options.transcriptQuoteFile, "transcriptQuoteFile");
      }
      if (transcriptQuotePath) args.push("--transcript-quote", transcriptQuotePath);
      const result = await this.invokeJson<KnowledgeStageResult>(args, invocation.signal);
      if (typeof result.candidate_id !== "string" || result.candidate_id.trim() === "") {
        throw new Error("maestro knowledge stage returned an unsupported JSON schema");
      }
      return result;
    } finally {
      if (privateTmpDir) {
        try {
          await this.stageFiles.removeDirectory(privateTmpDir);
        } catch (error) {
          // Cleanup failure must be visible because the directory contains
          // candidate content and may contain a transcript quote.
          console.warn(
            `[pi-graph-flow][knowledge] failed to remove stage temp directory ${privateTmpDir}: ${errorMessage(error)}`,
          );
        }
      }
    }
  }

  private async invokeJson<T>(args: readonly string[], signal?: AbortSignal): Promise<T> {
    const result = await this.runner(args, this.workflowRoot, { signal });
    if (result.exitCode !== 0) {
      throw new Error(`maestro ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    return parseJson<T>(result);
  }
}

function parseJson<T>(result: KnowledgeCliResult): T {
  const text = result.stdout.trim();
  if (!text) throw new Error(`maestro ${result.argv.join(" ")} returned empty output`);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`maestro ${result.argv.join(" ")} returned invalid JSON: ${errorMessage(error)}`);
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
