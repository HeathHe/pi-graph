import type { DispatchStrategy, DispatchContext, DispatchDecision } from '../dispatch-strategy.js';
export declare class SmartStrategy implements DispatchStrategy {
    readonly name = "smart";
    selectIssues(context: DispatchContext): Promise<DispatchDecision[]>;
}
