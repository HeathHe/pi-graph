/**
 * Prompt-optimize generation engine.
 *
 * Same completion pattern as the enhancer — resolve the configured model
 * (session or pinned), one non-streaming call, clean + clamp, never throw.
 * The difference is upstream: the classifier-chosen route is baked into the
 * rendered prompt, so the model knows whether to translate first.
 */
import { completeSimple, type Message, type ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EnhancerContext } from "../prompt-enhance/context.ts";
import { resolveEnhanceModel } from "../prompt-enhance/engine.ts";
import type { OptimizeConfig } from "./config.ts";
import type { PromptRoute } from "./domain.ts";
import { cleanOptimizedText, OPTIMIZE_SYSTEM_PROMPT, renderOptimizePrompt } from "./template.ts";

export interface OptimizeResult {
  kind: "optimized" | "error";
  text: string;
  error?: string;
}

/** Model ref that applies for a route: translate may pin its own model. */
export function effectiveOptimizeModelRef(config: OptimizeConfig, route: PromptRoute): string {
  return route === "translate" && config.translateModelRef !== "same"
    ? config.translateModelRef
    : config.modelRef;
}

function clampOptimized(value: string, maxChars: number): string {
  const collapsed = value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!collapsed) return "";
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars).trimEnd() : collapsed;
}

export async function generateOptimizedPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: OptimizeConfig,
  prompt: string,
  route: PromptRoute,
  context: EnhancerContext,
): Promise<OptimizeResult> {
  const resolved = resolveEnhanceModel(pi, ctx, { ...config, modelRef: effectiveOptimizeModelRef(config, route) });
  if (!resolved) {
    return { kind: "error", text: "", error: "No active model for prompt optimization." };
  }

  const userMessage = renderOptimizePrompt({ ...context, prompt, route });
  const requestContext: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userMessage }],
      timestamp: Date.now(),
    },
  ];

  try {
    const response = await completeSimple(
      resolved.model,
      { systemPrompt: OPTIMIZE_SYSTEM_PROMPT, messages: requestContext },
      {
        reasoning: config.thinking === "default" ? undefined : (config.thinking as AiThinkingLevel),
        sessionId: ctx.sessionManager.getSessionId(),
      },
    );
    const raw = response.content
      ? typeof response.content === "string"
        ? response.content
        : response.content
            .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
            .join("")
            .trim()
      : "";
    const cleaned = cleanOptimizedText(raw);
    const text = clampOptimized(cleaned, config.maxChars);
    if (!text) {
      return { kind: "error", text: "", error: "Model returned an empty optimized prompt." };
    }
    return { kind: "optimized", text };
  } catch (error) {
    return {
      kind: "error",
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
