/**
 * 在 WASM 模块加载前应用 V8 运行时 flag
 *
 * --liftoff-only: 禁用 turboshaft 优化编译器, 只用 Liftoff 基线编译
 * 牺牲 ~10% WASM 执行速度, 换取 100% 内存安全
 *
 * 注意: 此函数必须在任何 WASM 模块加载之前调用 (通常在进程启动时)
 * 在已运行的进程中, flag 设置是 no-op (V8 已初始化)
 */
export declare function applyWasmRuntimeFlags(): void;
/** 每 N 次解析重置一次 parser (回收 WASM 线性内存) */
export declare const PARSER_RESET_INTERVAL = 5000;
/** 每 N 个文件回收 worker (配合 parse-worker 线程池) */
export declare const WORKER_RECYCLE_INTERVAL = 250;
/**
 * Parser 计数器 — 跟踪解析次数, 达到阈值时提示重置
 */
export declare class ParserResetCounter {
    private parseCount;
    private readonly interval;
    constructor(interval?: number);
    /** 记录一次解析, 返回 true 表示需要重置 parser */
    tickAndCheckReset(): boolean;
    get count(): number;
    reset(): void;
}
/**
 * 拦截 Emscripten abort() 产生的 stderr 噪声
 * 返回一个 cleanup 函数用于恢复原始 stderr.write
 */
export declare function installEmscriptenStderrFilter(): () => void;
/**
 * 应用全部 WASM 稳定性机制:
 * 1. V8 --liftoff-only flag (Node 22+ OOM 缓解)
 * 2. Emscripten stderr 噪声过滤
 *
 * Parser 周期重置由调用方在使用 ParserResetCounter 时自行管理
 */
export declare function ensureWasmStability(): void;
/**
 * 清理 WASM 稳定性机制 (测试 / 进程退出时调用)
 */
export declare function cleanupWasmStability(): void;
