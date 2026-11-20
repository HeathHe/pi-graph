export declare function resolvePiAgentDirectory(env?: {
    PI_CODING_AGENT_DIR?: string;
}, homeDirectory?: string): string;
/** Explicit agent profiles own their Teammate state; default profiles retain the legacy layout. */
export declare function resolveTeammateStateRoot(env?: {
    PI_CODING_AGENT_DIR?: string;
}, homeDirectory?: string): string;
