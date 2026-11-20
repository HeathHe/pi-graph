import type { TargetPlatform } from '../core/skill-converter.js';
export type GoalMode = {
    platform: string;
    instructions: string;
};
/**
 * Goal 模式 — prepare frontmatter 声明 `goal: true` 的 step，加载时按平台附带
 * 该宿主原生 Goal 提示。Maestro 不改 Goal 行为：设定、暂停、继续、清除都跟宿主走。
 */
export declare const GOAL_MODE_BLOCKS: Partial<Record<TargetPlatform, string>>;
export declare function extractGoalFlag(raw: string): boolean;
export declare function resolveGoalMode(prepareRaw: string | undefined, platform: TargetPlatform): GoalMode | null;
/**
 * Decide which Goal-UI instruction set to emit.
 *
 * `MAESTRO_PLATFORM` is an explicit override (tests and machine callers).
 * `CURSOR_AGENT=1` means the host is Cursor — emit Cursor-native /goal
 * instructions, not Claude's /goal paste prompt.
 * Do not use this helper to persist `resolved_platform` on a Run.
 */
export declare function inferGoalUiPlatform(resolvedPlatform: TargetPlatform, env?: NodeJS.Dict<string | undefined>): TargetPlatform;
/** Host-aware Goal instructions: Cursor agent gets Cursor-native /goal rules. */
export declare function resolveGoalModeForHost(prepareRaw: string | undefined, resolvedPlatform: TargetPlatform, env?: NodeJS.Dict<string | undefined>): GoalMode | null;
