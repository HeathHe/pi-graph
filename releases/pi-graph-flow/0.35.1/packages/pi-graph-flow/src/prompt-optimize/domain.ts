/**
 * Prompt-optimize classifier domain — `prompt-route`.
 *
 * Routes a draft prompt to the optimization pipeline that fits it:
 * - `translate`: draft contains CJK text — translate to English, then optimize.
 * - `format`:    English but rough/unstructured — restructure into an
 *                actionable request.
 * - `polish`:    already precise English — minimal edits only.
 *
 * L0 rules are deterministic: any CJK character makes `translate` terminal
 * (mixed drafts still need their Chinese parts translated; code and
 * identifiers are preserved by the LLM route instruction). English drafts
 * return a provisional format/polish verdict that JEV may adjudicate when
 * the domain runs in "jev" mode — register via the classifier extension
 * (`/classifier mode prompt-route shadow|jev`).
 */

import type { ClassifyDomain } from "pi-maestro-teammate/v1/classify";

export type PromptRoute = "translate" | "format" | "polish";

export interface PromptRouteInput {
  /** Raw draft prompt text. */
  text: string;
}

export const PROMPT_ROUTE_DOMAIN = "prompt-route";

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-ퟯ]/u;
const LIST_ITEM_RE = /^\s*(?:[-*•]|\d+[.)])\s+\S/m;
const SECTION_LABEL_RE = /^\s*(?:goal|objective|context|requirements?|constraints?|steps?|notes?|acceptance|deliverables?)\s*:/im;

/** True when the draft contains any CJK characters (Chinese/Japanese/Korean). */
export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** True when the draft already carries prompt-like structure (lists/sections). */
export function looksStructured(text: string): boolean {
  if (!text.includes("\n")) return false;
  return LIST_ITEM_RE.test(text) || SECTION_LABEL_RE.test(text);
}

const ROUTE_CRITERIA: Record<PromptRoute, string> = {
  translate:
    "The draft contains Chinese (or other CJK) natural-language text that must be translated to English before optimization. Mixed Chinese/English counts — code and identifiers stay verbatim.",
  format:
    "The draft is English but rough, vague, or unstructured — rewrite it into a clear, actionable request with explicit requirements/constraints.",
  polish:
    "The draft is already a precise, well-structured English request — apply only minimal clarifying edits.",
};

export const promptRouteDomain: ClassifyDomain<PromptRoute, PromptRouteInput> = {
  name: PROMPT_ROUTE_DOMAIN,
  modes: ["off", "shadow", "jev"],
  rules(input) {
    const text = input.text;
    if (hasCjk(text)) return { label: "translate", terminal: true };
    return { label: looksStructured(text) ? "polish" : "format", terminal: false };
  },
  state(input) {
    return input.text.slice(0, 3_000);
  },
  questions: () => ({
    route: {
      type: "choice",
      instructions:
        "Pick the optimization route for this draft prompt for a coding agent. translate = contains Chinese/CJK text needing English translation; format = rough English needing restructuring; polish = already precise English needing only light edits.",
      criteria: ROUTE_CRITERIA,
    },
    hasChinese: {
      type: "noul",
      instructions: "The draft contains Chinese (or other CJK) natural-language text.",
    },
  }),
  decide(answers) {
    const answer = answers.route;
    if (answer?.type !== "choice") return undefined;
    const label = answer.choice as PromptRoute;
    if (!(label in ROUTE_CRITERIA)) return undefined;
    return {
      label,
      confidence: answer.confidence ?? answer.probabilities?.[answer.choice] ?? 0.5,
      ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
    };
  },
  fallback: () => ({ label: "format", confidence: 0 }),
};
