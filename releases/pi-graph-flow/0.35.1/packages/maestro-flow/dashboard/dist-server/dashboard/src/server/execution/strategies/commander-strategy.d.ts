import type { DispatchStrategy, DispatchContext, DispatchDecision } from '../dispatch-strategy.js';
import type { CommanderAgent } from '../../commander/commander-agent.js';
export declare class CommanderStrategy implements DispatchStrategy {
    private readonly commander;
    readonly name = "commander";
    constructor(commander: CommanderAgent);
    selectIssues(context: DispatchContext): Promise<DispatchDecision[]>;
}
