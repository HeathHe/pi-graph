// ---------------------------------------------------------------------------
// Statusline enablement for the interactive install flow.
//
// Final write requires Claude Code selected AND both UI switches true:
//   1. Hub enabledSteps.statusline (space)
//   2. Config-page installStatusline (y/n)
// ---------------------------------------------------------------------------
/** Full interactive install defaults appearance ON. Subcommand only if listed. */
export function defaultStatuslineEnabled(initialStepIds) {
    if (initialStepIds)
        return initialStepIds.includes('statusline');
    return true;
}
/** Hub space and config-page y/n stay in lockstep. */
export function syncStatuslineSwitches(enabled) {
    return { hubEnabled: enabled, configEnabled: enabled };
}
/** Statusline is written only when Claude is selected and both switches are on. */
export function shouldInstallStatusline(opts) {
    return opts.claudeSelected && opts.hubEnabled && opts.configEnabled;
}
/** Confirm page lists Statusline only when Claude Code is selected. */
export function statuslineConfirmKind(opts) {
    if (!opts.claudeSelected)
        return 'omit';
    return opts.willInstall ? 'install' : 'skipped';
}
//# sourceMappingURL=statusline-enable.logic.js.map