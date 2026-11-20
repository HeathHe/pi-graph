import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
import { statuslineConfirmKind } from './statusline-enable.logic.js';
import { t } from '../../i18n/index.js';
import { C, SYM, BORDER } from '../shared/index.js';
function Row({ label, value, valueColor }) {
    return (_jsxs(Box, { children: [_jsxs(Text, { color: C.success, children: [SYM.checkOn, " "] }), _jsx(Text, { bold: true, children: label.padEnd(16) }), _jsx(Text, { color: valueColor, children: value })] }));
}
function SkippedRow({ label }) {
    return (_jsxs(Box, { children: [_jsxs(Text, { color: C.neutral, children: [SYM.checkOff, " "] }), _jsx(Text, { color: C.neutral, children: label })] }));
}
function hookSummary(sel, fallbackLevel) {
    if (sel) {
        return sel.isCustom
            ? `custom (${sel.selectedHooks.length} hooks, based on ${sel.basePreset})`
            : `${sel.basePreset} (${sel.selectedHooks.length} hooks)`;
    }
    return fallbackLevel ?? 'standard';
}
export function InstallConfirm({ config, onConfirm, onBack }) {
    useInput((_input, key) => {
        if (key.return)
            onConfirm();
        if (key.escape || key.leftArrow)
            onBack();
    });
    const target = config.mode === 'global'
        ? '~/.maestro/ + ~/.claude/'
        : config.projectPath || './';
    // Collect items that will be installed vs skipped
    const willInstall = [];
    const skipped = [];
    if (config.installComponents) {
        willInstall.push({ label: 'Components', value: `${config.componentCount} selected · ${config.fileCount} files` });
    }
    else {
        skipped.push('Components');
    }
    if (config.installHooks) {
        willInstall.push({ label: 'Hooks (Claude)', value: hookSummary(config.claudeHooksSelection, config.hookLevel) });
    }
    else {
        skipped.push('Hooks (Claude)');
    }
    if (config.installMcp) {
        willInstall.push({ label: 'MCP Server', value: `${config.mcpToolCount} tools` });
    }
    else {
        skipped.push('MCP Server');
    }
    const statuslineRow = statuslineConfirmKind({
        claudeSelected: config.statuslineApplicable !== false,
        willInstall: config.installStatusline,
    });
    if (statuslineRow === 'install') {
        willInstall.push({ label: 'Statusline', value: `${config.statuslineTheme} theme` });
    }
    else if (statuslineRow === 'skipped') {
        skipped.push('Statusline');
    }
    if (config.installCodexHooks) {
        willInstall.push({ label: 'Codex Hooks', value: hookSummary(config.codexHooksSelection, config.codexHookLevel) });
    }
    else {
        skipped.push('Codex Hooks');
    }
    if (config.installCodexMcp) {
        willInstall.push({ label: 'Codex MCP', value: `${config.codexMcpTools.length} tools` });
    }
    else {
        skipped.push('Codex MCP');
    }
    if (config.installAgyHooks) {
        willInstall.push({ label: 'Agy Hooks', value: hookSummary(config.agyHooksSelection, config.agyHookLevel) });
    }
    else {
        skipped.push('Agy Hooks');
    }
    if (config.installExtraMcp) {
        willInstall.push({ label: 'Extra MCP', value: `${config.extraMcpTargetIds.join(', ')}` });
    }
    else {
        skipped.push('Extra MCP');
    }
    if (config.backupClaudeMd || config.backupAll) {
        willInstall.push({ label: 'Backup', value: config.backupAll ? t.install.backupAllLabel : t.install.backupClaudeMdLabel });
    }
    else {
        skipped.push('Backup');
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.confirmReady }), _jsxs(Box, { marginTop: 1, gap: 1, children: [_jsx(Text, { bold: true, children: t.install.confirmLabelMode }), _jsx(Text, { color: C.primary, children: config.mode }), _jsx(Text, { dimColor: true, children: "\u2192" }), _jsx(Text, { dimColor: true, children: target })] }), _jsxs(Box, { flexDirection: "column", ...BORDER.success, paddingX: 1, marginTop: 1, children: [_jsxs(Text, { bold: true, color: C.success, children: [t.install.confirmWillInstall, " (", willInstall.length, ")"] }), willInstall.map((item) => (_jsx(Row, { label: item.label, value: item.value, valueColor: C.success }, item.label)))] }), skipped.length > 0 && (_jsxs(Box, { flexDirection: "column", ...BORDER.detail, paddingX: 1, marginTop: 1, children: [_jsx(Text, { bold: true, color: C.neutral, children: t.install.confirmSkippedSection }), skipped.map((label) => (_jsx(SkippedRow, { label: label }, label)))] })), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: t.install.confirmKeyHints }) })] }));
}
//# sourceMappingURL=InstallConfirm.js.map