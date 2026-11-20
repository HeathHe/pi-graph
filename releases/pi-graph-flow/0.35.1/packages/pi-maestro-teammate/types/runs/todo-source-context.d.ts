/** Parent-process canonical Todo authority. Untrusted prompt context is a separate API. */
export interface TodoSourceHost {
    readonly cwd: string;
    readonly sessionId: string;
    readonly manager: object;
}
declare const sourceScopeBrand: unique symbol;
export interface TodoSourceScope {
    readonly [sourceScopeBrand]: true;
}
export interface TodoSourceProvider {
    /** Host-owned services remain associated with this exact registration. */
    services?: object;
    capture(host: TodoSourceHost): object;
    assert(lease: object): void;
    host(lease: object): TodoSourceHost;
    run?<T>(lease: object, operation: () => T, scope: TodoSourceScope): T;
    subscribe?(lease: object, onInvalidated: () => void): () => void;
}
export declare function registerTodoSourceProvider(provider: TodoSourceProvider): () => void;
/** Missing/foreign hosts do not authorize Todo, but do not disable non-Todo execution. */
export declare function captureTodoSourceScope(host: TodoSourceHost): TodoSourceScope | undefined;
export declare function assertTodoSourceScope(scope: unknown): asserts scope is TodoSourceScope;
export declare function readTodoSourceHost(scope: unknown): TodoSourceHost;
export declare function readTodoSourceServices(scope: unknown): object;
/** Preserve the original issuer/registration through the owner's existing queue context. */
export declare function withTodoSourceScope<T>(scope: unknown, operation: () => T): T;
/** Active waits only; callers must release this subscription in finally. */
export declare function subscribeTodoSourceInvalidation(scope: unknown, onInvalidated: () => void): () => void;
export {};
