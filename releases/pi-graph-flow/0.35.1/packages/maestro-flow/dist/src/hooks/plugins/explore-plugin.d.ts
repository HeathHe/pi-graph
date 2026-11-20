import type { MaestroPlugin } from '../../types/index.js';
import type { WorkflowHookRegistry } from '../workflow-hooks.js';
export interface ExploreMarker {
    queries: string[];
    maxTurns?: number;
    endpoint?: string;
}
export declare class ExplorePlugin implements MaestroPlugin {
    private readonly cwd;
    readonly name = "explore";
    private pendingResults;
    constructor(cwd?: string);
    apply(registry: WorkflowHookRegistry): void;
    private runQueries;
}
//# sourceMappingURL=explore-plugin.d.ts.map