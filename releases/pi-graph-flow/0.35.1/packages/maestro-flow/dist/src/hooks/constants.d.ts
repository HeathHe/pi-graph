/** Active layout — 'compact' (default 2-line) or 'expanded' (3-line) */
export declare const STATUSLINE_LAYOUT: "compact" | "expanded";
/** Ignore bridge metrics older than this (seconds) */
export declare const STALE_SECONDS = 60;
/** Claude Code reserves ~16.5% for autocompact buffer */
export declare const AUTO_COMPACT_BUFFER_PCT = 16.5;
/** Bridge file prefix in os.tmpdir() */
export declare const BRIDGE_PREFIX = "maestro-ctx-";
/** Delegate notification file prefix in os.tmpdir() */
export declare const NOTIFY_PREFIX = "maestro-notify-";
/** Coordinator tracker bridge file prefix in os.tmpdir() */
export declare const COORD_BRIDGE_PREFIX = "maestro-coord-";
/** Spec keyword injection dedup bridge file prefix in os.tmpdir() */
export declare const SPEC_KW_BRIDGE_PREFIX = "spec-kw-";
/** Max ms to wait for stdin before exiting (Windows pipe safety) */
export declare const STDIN_TIMEOUT_MS = 3000;
export declare const ICONS: {
    readonly model: "";
    readonly milestone: "";
    readonly phase: "◆";
    readonly coord: "󰑌";
    readonly task: "";
    readonly team: "󰡉";
    readonly dir: "";
    readonly git: "";
    readonly ctx: "";
} | {
    readonly model: "✎";
    readonly milestone: "⚑";
    readonly phase: "◆";
    readonly coord: "⚙";
    readonly task: "▸";
    readonly team: "👥";
    readonly dir: "■";
    readonly git: "⎇";
    readonly ctx: "◔";
};
/** Git status icons */
export declare const GIT_ICONS: {
    readonly clean: "✓";
    readonly dirty: "△";
    readonly conflict: "⚠";
    readonly ahead: "↑";
    readonly behind: "↓";
};
/** Hook error alert icon (same glyph in Nerd Font and Unicode sets) */
export declare const ALERT_ICON = "\u26A0";
export type CtxLevel = 'ok' | 'warn' | 'alert' | 'crit';
export declare function getCtxLevel(usedPct: number): CtxLevel;
export declare function ansiBg(rgb: readonly [number, number, number]): string;
export declare function ansiFg(rgb: readonly [number, number, number]): string;
export declare const ANSI_RESET = "\u001B[0m";
export declare const ANSI_DIM = "\u001B[2m";
export declare const ANSI_BOLD = "\u001B[1m";
export declare const ANSI_CYAN = "\u001B[36m";
export declare const ANSI_BLINK = "\u001B[5m";
type RGB = readonly [number, number, number];
interface ThemeColors {
    model: RGB;
    milestone: RGB;
    phase: RGB;
    coord: RGB;
    task: RGB;
    team: RGB;
    dir: RGB;
    git: RGB;
    ctxOk: RGB;
    ctxWarn: RGB;
    ctxAlert: RGB;
    ctxCrit: RGB;
    separator: RGB;
}
/** All available themes */
export declare const THEMES: Record<string, ThemeColors>;
/** Available theme names for install UI */
export declare const THEME_NAMES: string[];
/** Active theme colors — used as foreground on transparent background */
export declare const TEXT_COLORS: ThemeColors;
export declare const FACES: {
    readonly happy: "^_^";
    readonly neutral: "-_-";
    readonly alert: "O_O";
    readonly critical: "X_X";
};
export type FaceLevel = keyof typeof FACES;
export declare function getFaceLevel(usedPct: number): FaceLevel;
export declare const FACE_COLORS: Record<FaceLevel, string>;
export {};
//# sourceMappingURL=constants.d.ts.map