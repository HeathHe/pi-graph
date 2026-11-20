// ---------------------------------------------------------------------------
// CommanderStrategy — wraps CommanderAgent assess+decide as a DispatchStrategy
// ---------------------------------------------------------------------------
export class CommanderStrategy {
    commander;
    name = 'commander';
    constructor(commander) {
        this.commander = commander;
    }
    async selectIssues(context) {
        // Commander has its own internal tick that handles:
        //   1. gatherContext (reads issues, project state, scheduler status)
        //   2. assess (LLM call via Agent SDK)
        //   3. decide (deterministic filtering by risk threshold + capacity)
        //   4. dispatch (execute approved actions via scheduler)
        //
        // When used as a strategy, we delegate the full tick to the commander.
        // The commander's dispatch() calls scheduler.executeIssue() directly,
        // so we return an empty array here — the commander handles dispatch itself.
        await this.commander.tick('strategy_tick');
        return [];
    }
}
//# sourceMappingURL=commander-strategy.js.map