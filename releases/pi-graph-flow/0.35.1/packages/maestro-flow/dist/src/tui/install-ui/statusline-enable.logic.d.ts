/** Full interactive install defaults appearance ON. Subcommand only if listed. */
export declare function defaultStatuslineEnabled(initialStepIds?: string[]): boolean;
/** Hub space and config-page y/n stay in lockstep. */
export declare function syncStatuslineSwitches(enabled: boolean): {
    hubEnabled: boolean;
    configEnabled: boolean;
};
/** Statusline is written only when Claude is selected and both switches are on. */
export declare function shouldInstallStatusline(opts: {
    claudeSelected: boolean;
    hubEnabled: boolean;
    configEnabled: boolean;
}): boolean;
export type StatuslineConfirmKind = 'install' | 'skipped' | 'omit';
/** Confirm page lists Statusline only when Claude Code is selected. */
export declare function statuslineConfirmKind(opts: {
    claudeSelected: boolean;
    willInstall: boolean;
}): StatuslineConfirmKind;
//# sourceMappingURL=statusline-enable.logic.d.ts.map