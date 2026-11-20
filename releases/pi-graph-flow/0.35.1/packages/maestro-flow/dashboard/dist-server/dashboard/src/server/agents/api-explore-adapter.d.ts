import type { AgentConfig } from '../../shared/agent-types.js';
import { StreamJsonAdapter } from './stream-json-adapter.js';
export declare class ApiExploreAdapter extends StreamJsonAdapter {
    constructor();
    protected buildArgs(config: AgentConfig): string[];
}
