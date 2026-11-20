import { type ExecFileOptions } from 'node:child_process';
/** Common child_process options with windowsHide:true for all calls. */
export declare function subprocessOpts(cwd?: string): ExecFileOptions;
export interface CreatePaneOptions {
    cwd: string;
    cmd?: string;
    direction?: 'right' | 'bottom';
    percent?: number;
    parentPaneId?: string;
}
export interface TerminalBackend {
    readonly type: 'tmux' | 'wezterm';
    createPane(options: CreatePaneOptions): Promise<string>;
    sendText(paneId: string, text: string): Promise<void>;
    isAlive(paneId: string): Promise<boolean>;
    getText(paneId: string, lines?: number): Promise<string>;
    killPane(paneId: string): Promise<void>;
}
export declare class TmuxBackend implements TerminalBackend {
    readonly type: "tmux";
    private enterDelay;
    constructor(options?: {
        enterDelayMs?: number;
    });
    createPane(options: CreatePaneOptions): Promise<string>;
    sendText(paneId: string, text: string): Promise<void>;
    isAlive(paneId: string): Promise<boolean>;
    getText(paneId: string, lines?: number): Promise<string>;
    killPane(paneId: string): Promise<void>;
}
export declare class WeztermBackend implements TerminalBackend {
    readonly type: "wezterm";
    private enterDelay;
    private weztermBin;
    constructor(options?: {
        enterDelayMs?: number;
        weztermBin?: string;
    });
    createPane(options: CreatePaneOptions): Promise<string>;
    sendText(paneId: string, text: string): Promise<void>;
    /**
     * 3-level Enter key fallback:
     * 1. wezterm cli send-key --key Enter (flag form)
     * 2. wezterm cli send-key Enter (positional form)
     * 3. CR byte via send-text --no-paste (final fallback)
     */
    private sendEnter;
    isAlive(paneId: string): Promise<boolean>;
    getText(paneId: string, lines?: number): Promise<string>;
    killPane(paneId: string): Promise<void>;
}
export declare function detectBackend(): TerminalBackend | null;
