import type { TodoSourceScope } from "./todo-source-context.ts";
/** Never serialized into child IPC. Only the actual parent relay can attach this argument. */
export interface ChildTodoParentMetadata {
    readonly sourceScope?: TodoSourceScope;
    /** Actual attempt closure, never reconstructed from child JSON. */
    readonly modelBudget?: {
        open(): Promise<{
            nonce: string;
            kind: "none" | "declared";
            correlationId: string;
            runtimeGeneration: number | null;
            nativeInvocationId: string;
        }>;
        authorizeNone(nonce: string, requestId: string): Promise<void>;
        prepare(nonce: string, requestId: string, control?: {
            signal?: AbortSignal;
        }): Promise<{
            claim: string;
        }>;
        abandon?(nonce: string, claim: string): Promise<void>;
        mark(nonce: string, claim: string, entryId: string, digest: string): Promise<void>;
    };
    readonly correlationId: string;
    readonly runtimeGeneration: number | null;
    readonly signal?: AbortSignal;
    readonly isCurrent: () => boolean;
}
declare const parentContextBrand: unique symbol;
export interface ChildTodoParentContext {
    readonly [parentContextBrand]: true;
}
export declare function createChildTodoParentContext(metadata: ChildTodoParentMetadata): ChildTodoParentContext;
/** A JSON/clone/cid/native UI snapshot cannot substitute for a live invocation. */
export declare function readChildTodoParentContext(context: unknown): ChildTodoParentMetadata;
export {};
