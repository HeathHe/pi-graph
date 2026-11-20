import type { AgentType, AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
/** Grok CLI prints update prompts on stderr; they must not become error entries. */
export declare function isGrokUpdateNotice(text: string): boolean;
export declare class GrokAdapter extends BaseAgentAdapter {
    readonly agentType: AgentType;
    private readonly executable;
    private readonly childProcesses;
    private readonly readlineInterfaces;
    /** toolCallId → tool name, scoped per process to avoid cross-session collisions */
    private readonly toolIdNames;
    private readonly stoppedEmitted;
    private readonly streamMonitors;
    private readonly promptFiles;
    /** Thought deltas are accumulated and flushed as a single thinking entry */
    private readonly thoughtBuffers;
    /** Bumps on each spawn of a processId so a previous child's exit cannot tear down the replacement. */
    private readonly spawnGenerations;
    constructor(executable?: string);
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    protected doSendMessage(processId: string, content: string): Promise<void>;
    protected doRespondApproval(_decision: ApprovalDecision): Promise<void>;
    private parseStreamJsonMessage;
    /** Emit any buffered thought deltas as one thinking entry */
    private flushThoughts;
    /** Best-effort extraction of a readable result string from a tool update */
    private extractToolResult;
    protected buildArgs(config: AgentConfig, promptFile: string): string[];
    /**
     * Model id is config/request data — restrict to safe characters so it can
     * never inject a second command under the Windows shell spawn.
     */
    private assertValidModel;
    private deletePromptFile;
    private emitStopped;
    private setupProcessListeners;
    private cleanup;
}
