// ---------------------------------------------------------------------------
// Types for install TUI — shared data contracts
// ---------------------------------------------------------------------------
export const WIZARD_STEPS = [
    'mode',
    'components',
    'config',
    'review',
    'executing',
    'complete',
];
export const DEFAULT_INSTALL_CONFIG = {
    mode: 'global',
    projectPath: '',
    selectedIds: [],
    mcpEnabled: true,
    mcpTools: [],
    mcpProjectRoot: '',
    hookLevel: 'none',
    doBackup: false,
    installStatusline: false,
    backupClaudeMd: true,
    backupAll: false,
};
//# sourceMappingURL=types.js.map