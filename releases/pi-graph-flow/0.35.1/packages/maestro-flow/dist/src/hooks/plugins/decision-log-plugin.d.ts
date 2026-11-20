import type { MaestroPlugin } from '../../types/index.js';
import type { WorkflowHookRegistry } from '../workflow-hooks.js';
export interface DecisionEntry {
    id: string;
    timestamp: string;
    source: string;
    node_id: string;
    type: string;
    verdict: string;
    resolved_value: unknown;
    summary: string;
}
export declare class DecisionLogPlugin implements MaestroPlugin {
    private readonly logPath;
    readonly name = "decisionLog";
    constructor(logPath: string);
    apply(registry: WorkflowHookRegistry): void;
}
//# sourceMappingURL=decision-log-plugin.d.ts.map