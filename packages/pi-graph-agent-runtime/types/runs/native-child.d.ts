export interface NativeChildOptions {
    version?: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    tools?: readonly string[];
    model?: string;
}
/** Probe the chosen executable, never the parent's imported SDK version. */
export declare function probePiChildVersion(command: string, argsPrefix: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<string | undefined>;
export declare function assertVirtualChildExtensionRegistered(selection: string | undefined, virtualModels: readonly string[] | undefined): boolean;
export declare function assertVirtualChildRouter(selection: string | undefined, virtualModels: readonly string[] | undefined, childVersion: unknown): void;
/** Explicit opt-in compensates --no-extensions without overriding operator disables. */
export declare function nativeChildBuiltinArgs(options: NativeChildOptions): string[];
