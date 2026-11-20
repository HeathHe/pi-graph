/**
 * 解析 detached delegate worker 的 CLI 入口脚本。
 *
 * 不能默认用 process.argv[1]：在 MCP server（bin/maestro-mcp.js）进程里
 * argv[1] 指向 MCP 入口，spawn 出的 worker 会再起一个 stdio MCP server，
 * delegate --worker 逻辑从不执行，job 永远卡 queued、完成通知永不回报。
 * 按包结构定位 bin/maestro.js（含 WASM relaunch 包装的 CLI 入口）。
 */
export declare function defaultDelegateWorkerEntryScript(): string | undefined;
//# sourceMappingURL=delegate-worker-entry.d.ts.map