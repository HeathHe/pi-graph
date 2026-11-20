import type { ChildProcess } from "node:child_process";
import type { TodoSourceScope } from "../runs/todo-source-context.ts";
import { type TaskDispatchRequest } from "../public/v1/task-dispatch-binding.ts";
import type { ChildTodoParentMetadata } from "../runs/child-parent-context.ts";
export type ChildModelBudgetPort = NonNullable<ChildTodoParentMetadata["modelBudget"]> & {
    isReplayNeutralControl(message: Record<string, unknown>): boolean;
    observeSession(message: Record<string, unknown>): void;
    interceptFact(message: Record<string, unknown>, reply: (message: Record<string, unknown>) => void): boolean;
    close(): void;
};
/** Bound once by the actual attempt. Child JSON supplies neither identity nor amount. */
export declare function createChildModelBudgetPort(input: {
    child: ChildProcess;
    sourceScope?: TodoSourceScope;
    nativeGate?: object;
    originalDispatch?: {
        readonly origin: object | undefined;
        readonly request: TaskDispatchRequest;
    };
    correlationId: string;
    runtimeGeneration: number | null;
    nativeInvocationId(): string | undefined;
    launch: {
        cwd: string;
        sessionDir?: string;
        resumeSessionFile?: string;
        forkSessionFile?: string;
    };
    assertCurrent(): void;
    onFactError?(error: unknown): void;
}): ChildModelBudgetPort | undefined;
