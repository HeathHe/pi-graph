export interface McpLaunch {
    command: string;
    args: string[];
}
export interface McpLaunchOptions {
    platform?: NodeJS.Platform;
    execPath?: string;
    packageRoot?: string;
}
export declare function resolveMaestroPackageRoot(fromFile?: string): string;
export declare function resolveMaestroMcpLaunch(opts?: McpLaunchOptions): McpLaunch;
export declare function maestroHookCommand(name: string, opts?: McpLaunchOptions): string;
export declare function maestroStatuslineCommand(opts?: McpLaunchOptions): string;
//# sourceMappingURL=mcp-launch.d.ts.map