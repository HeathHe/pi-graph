import type { AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
export declare class AgyAdapter extends BaseAgentAdapter {
    readonly agentType: "agy";
    private readonly childProcesses;
    private readonly readlineInterfaces;
    private readonly streamMonitors;
    private readonly stoppedEmitted;
    private readonly spawnTimestamps;
    private readonly textBuffers;
    private readonly workDirs;
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    protected doSendMessage(_processId: string, _content: string): Promise<void>;
    protected doRespondApproval(_decision: ApprovalDecision): Promise<void>;
    /**
     * Locate the conversationId agy used for this workspace on this run.
     *
     * Strategy:
     *  1. Read cache/last_conversations.json — agy writes the
     *     workspace→conversationId map on every run. If the cache mtime is
     *     after our spawn and the workdir key resolves, return that id.
     *  2. Fall back to scanning brain/ directories for a transcript.jsonl
     *     touched after our spawn (legacy heuristic; handles edge cases where
     *     the cache write is delayed).
     */
    private resolveConversationId;
    /**
     * After the agy process exits, locate the conversation transcript for our
     * workspace and replay the entries that landed during our turn. The
     * PLANNER_RESPONSE.content carries the model's actual reply text — that's
     * the primary assistant_message source since stdout is empty in non-TTY
     * mode. Tool calls and intermediate results become tool_use entries.
     */
    private enrichFromTranscript;
    private setupProcessListeners;
    private emitStopped;
    private cleanup;
}
