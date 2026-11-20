import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export { getAdvisorRuntimeOwner, registerAdvisorRuntime } from "../run-executor/supervision-owner.ts";
export type { AdvisorRuntimeCandidate, AdvisorRuntimeLease } from "../run-executor/supervision-owner.ts";
export declare function ensureAdvisorCommandRegistered(pi: ExtensionAPI): void;
