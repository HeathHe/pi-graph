/**
 * Prompt-optimize configuration.
 *
 * Shares the EnhanceConfig shape (model pin, thinking level, length cap and
 * context depth) so the optimizer can reuse the enhancer's model resolution
 * and context gathering unchanged. Settings persist in the API manager file
 * (`api-manager.json`) under their own `optimize` section.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  fileExists,
  isRecord,
  readModelsRoot,
  serializeMutation,
  writeModelsRoot,
} from "../providers/api-provider-ops.ts";
import type { EnhanceConfig } from "../prompt-enhance/config.ts";

export const OPTIMIZE_SECTION = "optimize";

/**
 * Same fields as EnhanceConfig plus `translateModelRef` — the translate route
 * may pin a different (typically faster/cheaper) model than the optimizer.
 */
export interface OptimizeConfig extends EnhanceConfig {
  /**
   * Model used when the classifier routes a draft to `translate`.
   * - "same": follow `modelRef`.
   * - "session": follow the session model (ignores `modelRef`).
   * - "provider/modelId": pin a dedicated model.
   */
  translateModelRef: string;
}

export const DEFAULT_OPTIMIZE_CONFIG: OptimizeConfig = {
  enabled: true,
  modelRef: "session",
  translateModelRef: "same",
  thinking: "default",
  maxChars: 3000,
  contextDepth: "codebase",
  includeGit: true,
  maxFiles: 3,
  knowledgeSearch: true,
  knowledgeTopN: 5,
};

const OPTIMIZE_THINKING_LEVELS: readonly (ThinkingLevel | "default")[] = [
  "default", "minimal", "low", "medium", "high", "xhigh", "max",
];

const CONTEXT_DEPTHS: readonly OptimizeConfig["contextDepth"][] = ["none", "session", "codebase"];

function normalizeConfig(value: unknown): OptimizeConfig {
  const record = isRecord(value) ? value : {};
  const enabled = record.enabled === undefined ? DEFAULT_OPTIMIZE_CONFIG.enabled : Boolean(record.enabled);
  const modelRef = typeof record.modelRef === "string" && record.modelRef.trim().length > 0
    ? record.modelRef.trim()
    : DEFAULT_OPTIMIZE_CONFIG.modelRef;
  const translateModelRef = typeof record.translateModelRef === "string" && record.translateModelRef.trim().length > 0
    ? record.translateModelRef.trim()
    : DEFAULT_OPTIMIZE_CONFIG.translateModelRef;
  const thinking = typeof record.thinking === "string" &&
    (OPTIMIZE_THINKING_LEVELS as readonly string[]).includes(record.thinking)
    ? (record.thinking as ThinkingLevel | "default")
    : DEFAULT_OPTIMIZE_CONFIG.thinking;
  const maxChars = typeof record.maxChars === "number" && record.maxChars >= 1
    ? Math.min(Math.floor(record.maxChars), 8000)
    : DEFAULT_OPTIMIZE_CONFIG.maxChars;
  const contextDepth = typeof record.contextDepth === "string" &&
    CONTEXT_DEPTHS.includes(record.contextDepth as OptimizeConfig["contextDepth"])
    ? (record.contextDepth as OptimizeConfig["contextDepth"])
    : DEFAULT_OPTIMIZE_CONFIG.contextDepth;
  const includeGit = record.includeGit === undefined
    ? DEFAULT_OPTIMIZE_CONFIG.includeGit
    : Boolean(record.includeGit);
  const maxFiles = typeof record.maxFiles === "number" && record.maxFiles >= 0
    ? Math.min(Math.floor(record.maxFiles), 10)
    : DEFAULT_OPTIMIZE_CONFIG.maxFiles;
  const knowledgeSearch = record.knowledgeSearch === undefined
    ? DEFAULT_OPTIMIZE_CONFIG.knowledgeSearch
    : Boolean(record.knowledgeSearch);
  const knowledgeTopN = typeof record.knowledgeTopN === "number" && record.knowledgeTopN > 0
    ? Math.min(Math.floor(record.knowledgeTopN), 20)
    : DEFAULT_OPTIMIZE_CONFIG.knowledgeTopN;
  return { enabled, modelRef, translateModelRef, thinking, maxChars, contextDepth, includeGit, maxFiles, knowledgeSearch, knowledgeTopN };
}

export async function loadOptimizeConfig(defaultsPath: string): Promise<OptimizeConfig> {
  if (!await fileExists(defaultsPath)) return { ...DEFAULT_OPTIMIZE_CONFIG };
  const root = await readModelsRoot(defaultsPath);
  return normalizeConfig(root[OPTIMIZE_SECTION]);
}

export async function saveOptimizeConfig(
  config: OptimizeConfig,
  defaultsPath: string,
): Promise<void> {
  await serializeMutation(defaultsPath, async () => {
    const exists = await fileExists(defaultsPath);
    const root = await readModelsRoot(defaultsPath);
    await writeModelsRoot(
      { ...root, version: 1, [OPTIMIZE_SECTION]: { ...config } },
      defaultsPath,
      exists,
    );
  });
}
