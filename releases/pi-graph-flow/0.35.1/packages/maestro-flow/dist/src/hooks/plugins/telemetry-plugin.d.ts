import type { MaestroPlugin } from '../../types/index.js';
import type { WorkflowHookRegistry } from '../workflow-hooks.js';
export interface TelemetryEntry {
    type: 'node_exit' | 'command_result' | 'error';
    nodeId: string | null;
    timestamp: number;
    data: Record<string, unknown>;
}
export declare class TelemetryPlugin implements MaestroPlugin {
    readonly name = "telemetry";
    private entries;
    apply(registry: WorkflowHookRegistry): void;
    /** Return collected telemetry entries. */
    getEntries(): readonly TelemetryEntry[];
    /** Clear collected entries. */
    clear(): void;
}
//# sourceMappingURL=telemetry-plugin.d.ts.map