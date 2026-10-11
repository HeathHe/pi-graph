/** Only diagnostics obtained at the provider/preflight boundary are eligible. Never pass task prose. */
export function classifyProviderFailure(message: string): { eligible: boolean; kind: string } {
 if (/\b(?:task text|prompt|user asked|user requested)\b/i.test(message))return {eligible:false,kind:"untrusted_context"};
 if (/\b(abort(?:ed)?|cancelled|validation|tool error|schema)\b/i.test(message)) return {eligible:false,kind:"non_provider"};
 const rules: Array<[string, RegExp]> = [
  ["quota", /\b(?:you['’]ve reached your \d+-hour usage limit|(?:HTTP(?: status)?|status(?:Code)?[ :=]+)\s*429|quota (?:exceeded|exhausted)|rate limit(?:ed| exceeded)?|insufficient (?:balance|credits?))\b/i],
  ["auth", /\b(?:(?:HTTP(?: status)?|status(?:Code)?[ :=]+)\s*401|authentication (?:failed|required)|invalid api key|unauthorized|credentials? (?:missing|expired|unavailable))\b/i],
  ["model", /\bmodel\b.{0,100}\b(?:not found|not available|unavailable|access denied)\b/i],
  ["provider", /\bprovider\b.{0,100}\b(?:unavailable|not available|overloaded)\b/i],
 ];
 for (const [kind, pattern] of rules) if (pattern.test(message)) return {eligible:true,kind};
 return {eligible:false,kind:"unknown"};
}
/** The current public lifecycle lacks complete pre-activity proof. Fail closed, even for 429. */
export function runtimeRecoveryEvidence(failure: string, taskId: string, attempt: number) {
 return {taskId,attempt,classification:{eligible:false,kind:"unknown",source:"child-result-untrusted"},diagnostic:failure.slice(0,500),freshReplayAllowed:false,
  reason:"No authoritative complete pre-activity proof; existing tools, writes or external effects must not be replayed.",
  next:"Read the original result. Supply an explicit remaining-task contract or a supported resumable checkpoint; do not repeat the original task."};
}

/** Control-plane parking before a fallback child crosses its emit boundary. */
export class V3FallbackPauseError extends Error { constructor() { super("Fallback attempt paused before child dispatch."); this.name = "V3FallbackPauseError"; } }
