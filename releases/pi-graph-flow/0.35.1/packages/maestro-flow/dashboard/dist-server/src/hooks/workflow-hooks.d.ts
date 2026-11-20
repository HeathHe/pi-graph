import { SyncHook, AsyncSeriesHook, AsyncSeriesBailHook, AsyncSeriesWaterfallHook } from './hook-engine.js';
import type { MaestroPlugin } from '../types/index.js';
import type { CommandNode, ExecuteResult, WalkerState } from '../coordinator/graph-types.js';
export interface RunContext {
    sessionId: string;
    graphId: string;
    intent: string;
}
export interface NodeContext {
    nodeId: string;
    node: CommandNode;
    state: WalkerState;
}
export interface CommandContext {
    nodeId: string;
    cmd: string;
    prompt: string;
}
export interface CommandResultContext {
    nodeId: string;
    cmd: string;
    result: ExecuteResult;
}
export interface ErrorContext {
    nodeId: string | null;
    error: Error;
    state: WalkerState;
}
export interface DecisionContext {
    nodeId: string;
    resolvedValue: unknown;
    target: string;
}
export declare class WorkflowHookRegistry {
    /** Fires before a workflow run starts. Bail to cancel. */
    readonly beforeRun: AsyncSeriesBailHook<[RunContext]>;
    /** Fires after a workflow run completes. */
    readonly afterRun: AsyncSeriesHook<[RunContext, WalkerState]>;
    /** Fires before entering a node. Bail to skip. */
    readonly beforeNode: AsyncSeriesBailHook<[NodeContext]>;
    /** Fires after exiting a node. */
    readonly afterNode: AsyncSeriesHook<[NodeContext, string]>;
    /** Fires before executing a command. Bail to skip execution. */
    readonly beforeCommand: AsyncSeriesBailHook<[CommandContext]>;
    /** Fires after a command completes. */
    readonly afterCommand: AsyncSeriesHook<[CommandResultContext]>;
    /** Fires when an error occurs during execution. */
    readonly onError: AsyncSeriesHook<[ErrorContext]>;
    /** Transforms the assembled prompt before sending to agent. */
    readonly transformPrompt: AsyncSeriesWaterfallHook<string>;
    /** Fires synchronously when a decision node resolves. */
    readonly onDecision: SyncHook<[DecisionContext]>;
    /** Apply a plugin — plugin taps into hooks via the registry. */
    apply(plugin: MaestroPlugin): void;
    /** Get a hook by name (for dynamic access). */
    getHook(name: string): unknown;
}
