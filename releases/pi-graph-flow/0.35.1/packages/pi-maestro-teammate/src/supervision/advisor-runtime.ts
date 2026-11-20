import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisorCommandHost } from "../run-executor/supervision-owner.ts";

export { getAdvisorRuntimeOwner, registerAdvisorRuntime } from "../run-executor/supervision-owner.ts";
export type { AdvisorRuntimeCandidate, AdvisorRuntimeLease } from "../run-executor/supervision-owner.ts";

export function ensureAdvisorCommandRegistered(pi: ExtensionAPI): void {
  registerAdvisorCommandHost(
    pi,
    handler => pi.registerCommand("advisor", {
      description: "Configure or inspect the active Advisor runtime",
      handler,
    }),
    ctx => ctx.ui.notify("Advisor runtime is unavailable.", "warning"),
  );
}
