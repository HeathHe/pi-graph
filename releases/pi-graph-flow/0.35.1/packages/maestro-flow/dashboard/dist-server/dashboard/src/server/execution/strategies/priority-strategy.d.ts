import type { DispatchStrategy, DispatchContext, DispatchDecision } from '../dispatch-strategy.js';
export declare class PriorityStrategy implements DispatchStrategy {
    readonly name = "priority";
    selectIssues(context: DispatchContext): Promise<DispatchDecision[]>;
}
