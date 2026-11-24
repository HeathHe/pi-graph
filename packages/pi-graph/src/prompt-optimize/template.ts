/**
 * Prompt-optimize template.
 *
 * The system prompt fixes the model as a translator + formatter: whatever
 * the input language, the output is always an English optimized prompt for
 * a coding agent. The user message carries the classifier-chosen route, its
 * route-specific instruction, the gathered context, and the draft.
 */
import type { EnhancerContext, KnowledgeHit } from "../prompt-enhance/context.ts";
import { cleanEnhancedText } from "../prompt-enhance/template.ts";
import type { PromptRoute } from "./domain.ts";

export const OPTIMIZE_SYSTEM_PROMPT = `You are a prompt optimizer for a coding agent. You do not answer the user's request. You do not solve, implement, explain, or carry out the work described in the prompt. Your only job is to turn the user's rough draft into a better request that a *different* coding agent will execute later.

The output is ALWAYS English. When the draft contains Chinese or other non-English text, translate its natural-language content faithfully into English — keep code snippets, file paths, commands, and identifiers verbatim.

Given the draft and optional live context (recent messages, project tree, git state, referenced file contents, retrieved knowledge hits), produce a precise, actionable, codebase-aware request.

Rules:
- Preserve the user's intent exactly. Do not invent new requirements.
- If the draft references files or functions, anchor the rewrite to the actual paths and code present in the context.
- If relevant project knowledge or specs were retrieved, reference them to ground the request in established conventions.
- Format for scanability: open with a one-sentence goal, then add "Requirements:"/"Constraints:" bullet sections ONLY when the draft actually carries multiple distinct requirements or constraints. Keep simple drafts as one concise paragraph.
- Output only the optimized prompt — no preamble, no commentary, no markdown headings, no quoting of the original.
- Do not address the agent in the second person unless the original did.
- If you catch yourself answering the request, writing code, listing steps to do the work, or saying "here is the fix", stop. Output the optimized *request* instead.

Return only the optimized prompt as plain English text.`;

export const ROUTE_INSTRUCTIONS: Record<PromptRoute, string> = {
  translate:
    "Route=translate: the draft contains Chinese/CJK text. Translate ALL natural-language content into English first (code, paths, commands and identifiers stay verbatim), then apply the optimization rules.",
  format:
    "Route=format: the draft is rough English. Restructure it into a clear, actionable request — explicit goal plus requirement/constraint bullets when warranted.",
  polish:
    "Route=polish: the draft is already precise English. Apply only minimal clarifying edits; near-verbatim output is acceptable.",
};

export interface OptimizePromptContext extends EnhancerContext {
  prompt: string;
  route: PromptRoute;
}

function block(items: string[] | undefined, label: string, formatter: (item: string) => string = (i) => `- ${i}`): string {
  const list = items && items.length > 0 ? items.map(formatter).join("\n") : "(none)";
  return `${label}:\n${list}`;
}

function knowledgeBlock(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return `KnowledgeHits:\n(none)`;
  const lines = hits.map((h) => `- [${h.category || "?"}] ${h.name || h.id}: ${h.summary}`.trim());
  return `KnowledgeHits:\n${lines.join("\n")}`;
}

export function renderOptimizePrompt(context: OptimizePromptContext): string {
  return `Optimize the draft prompt below into a clear, actionable English request for a coding agent. Output only the optimized prompt.

${ROUTE_INSTRUCTIONS[context.route]}

${block(context.recentMessages, "RecentMessages")}

${block(context.projectTree?.split("\n"), "ProjectTree")}

${block(context.gitLog?.split("\n"), "GitLog")}

${block(context.mentionedFiles, "MentionedFiles", (f) => f)}

${knowledgeBlock(context.knowledgeHits)}

PromptToOptimize:
\`\`\`
${context.prompt}
\`\`\``;
}

/** Reuse the enhancer's trimmer — same fences/headings/quotes cleanup applies. */
export const cleanOptimizedText = cleanEnhancedText;
