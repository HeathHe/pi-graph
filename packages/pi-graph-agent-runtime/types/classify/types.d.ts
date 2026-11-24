/**
 * Unified classifier contract — the shared shape every classification domain
 * in the plugin follows: an input is mapped to a bounded label set through a
 * layered pipeline (deterministic rules → JEV semantic decision → optional
 * heavyweight LLM), and every layer reports which one produced the label.
 *
 * JEV is TypeSafe's "System One" decision model: given a `state` and a set of
 * questions, it returns typed answers (choice/score/noul) with probability
 * distributions and confidence — a fast (~200ms) "smart if statement". This
 * module only describes the wire format; `client.ts` owns transport.
 */
export type JevQuestionType = "choice" | "score" | "noul";
/** Choice: unordered fixed categories. `criteria` maps option name → description. */
export interface JevChoiceQuestion {
    type: "choice";
    instructions: string;
    criteria: Record<string, string>;
}
/** Score: ordered low→high levels (2–10 entries). */
export interface JevScoreQuestion {
    type: "score";
    instructions: string;
    criteria: readonly string[];
}
/** Noul: yes/no. The returned `noul` is the probability of "yes" (0–1). */
export interface JevNoulQuestion {
    type: "noul";
    instructions: string;
    criteria?: {
        true?: string;
        false?: string;
    };
}
export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;
/** Question id → question definition. Ids are never sent to the model. */
export type JevQuestions = Record<string, JevQuestion>;
export interface JevChoiceAnswer {
    type: "choice";
    choice: string;
    confidence?: number;
    probabilities?: Record<string, number>;
}
export interface JevScoreAnswer {
    type: "score";
    score: number;
    confidence?: number;
    legend?: Record<string, string>;
    probabilities?: Record<string, number>;
}
export interface JevNoulAnswer {
    type: "noul";
    noul: number;
}
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;
/** Answer map keyed by the same question ids sent in the request. */
export type JevAnswers = Record<string, JevAnswer>;
export interface JevRequest {
    state: string;
    model: string;
    questions: JevQuestions;
}
export interface JevResponse {
    model?: string;
    answers: JevAnswers;
}
/** Which pipeline layer produced (or would have produced) the label. */
export type ClassifierLayer = "rule" | "jev" | "llm" | "degraded";
/** Per-domain enable mode. `shadow` = rules decide, JEV judges in background. */
export type ClassifierDomainMode = "off" | "shadow" | "jev";
/** L0 rule outcome. `terminal: false` means the label is provisional (default branch). */
export interface RuleVerdict<D extends string> {
    label: D;
    terminal: boolean;
}
export interface ClassifyResult<D extends string> {
    label: D;
    /** 0–1. Rule hits report 1; degraded/fallback paths report 0. */
    confidence: number;
    layer: ClassifierLayer;
    /** JEV probability distribution behind the chosen label, when available. */
    probabilities?: Record<string, number>;
    /** Concrete JEV model version from the response (e.g. `jev-1.13.0`). */
    model?: string;
    /** Why a degraded/fallback path was taken. */
    degradedReason?: string;
}
/**
 * One classification domain. Domains are data + functions — whoever owns the
 * underlying decision registers it, so flow-owned classifiers (self-evolve
 * signal type, new-context file value) live next to their call sites while
 * teammate-owned ones (retry errors) live in this package.
 */
export interface ClassifyDomain<D extends string, I = unknown> {
    /** Stable domain id, e.g. "retry-error". Used for config + shadow records. */
    readonly name: string;
    /** Modes this domain supports. Sync-only domains must exclude "jev". */
    readonly modes: readonly ClassifierDomainMode[];
    /**
     * L0 deterministic rules. Returning a terminal verdict short-circuits the
     * pipeline; a non-terminal verdict is the provisional label used when JEV
     * is disabled, in shadow mode, or unavailable; `undefined` means "no rule
     * opinion" (JEV-primary domains).
     */
    rules(input: I): RuleVerdict<D> | undefined;
    /** Build the JEV `state` text. Callers must pre-redact untrusted content. */
    state(input: I): string;
    /** JEV question set for this domain. */
    questions(): JevQuestions;
    /** Map JEV answers to a label; `undefined` → treated as a JEV failure. */
    decide(answers: JevAnswers): {
        label: D;
        confidence: number;
        probabilities?: Record<string, number>;
    } | undefined;
    /** Fail-safe result for transport/parse/timeout failures. */
    fallback(reason: string): {
        label: D;
        confidence: number;
    };
}
/** One shadow observation: what rules decided vs what JEV decided. */
export interface ClassifyShadowRecord {
    domain: string;
    at: string;
    state: string;
    rule: {
        label: string;
        terminal: boolean;
    } | null;
    jev?: {
        label: string;
        confidence: number;
        model?: string;
    };
    agree?: boolean;
    error?: string;
}
