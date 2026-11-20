/**
 * Arch-KB Command — 隔离架构知识库查询 (基于 awesome-architecture)
 *
 * 独立于 maestro search，仅通过 `maestro arch-kb <cmd>` 触发。
 * 索引预构建于 resources/arch-kb/index.json，运行时只读。
 *
 * 精简子命令集: list, show, search
 * - search: 自由搜索（BM25-lite），--type template 等价于原 match
 * - show:   命中后查看完整正文（--section 只看章节）
 * - list:   浏览条目
 */
import type { Command } from 'commander';
export declare function registerArchKbCommand(program: Command): void;
//# sourceMappingURL=arch-kb.d.ts.map