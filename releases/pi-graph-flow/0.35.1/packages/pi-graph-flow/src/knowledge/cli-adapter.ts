/** Host composition: preserve the old constructor while the core owns all algorithms. */
import { defaultRunner, type RunCliRunner } from "../session/cli-adapter.ts";
import { KnowledgeCliAdapter as KnowledgeLifecycle } from "../knowledge-service/lifecycle.ts";
export * from "../knowledge-service/contracts.ts";
export { resolveLatestSessionId } from "../knowledge-service/session-discovery.ts";
export class KnowledgeCliAdapter extends KnowledgeLifecycle {
  constructor(workflowRoot: string, runner: RunCliRunner = defaultRunner) { super(workflowRoot, runner); }
}
