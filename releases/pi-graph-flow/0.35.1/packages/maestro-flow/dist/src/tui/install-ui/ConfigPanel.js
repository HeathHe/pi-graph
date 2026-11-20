import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { McpConfig } from './McpConfig.js';
import { HooksConfig } from './HooksConfig.js';
import { BackupConfig } from './BackupConfig.js';
import { getHooksForLevel } from '../../commands/hooks.js';
import { C, BORDER } from '../shared/index.js';
const TABS = ['MCP', 'Hooks', 'Backup'];
export function ConfigPanel({ config, onConfigChange, onDone, onBack, existingManifest, }) {
    const [activeTab, setActiveTab] = useState(0);
    const cycleTab = useCallback(() => {
        setActiveTab((prev) => ((prev + 1) % 3));
    }, []);
    useInput((_input, key) => {
        // Tab: cycle through tabs
        if (key.tab) {
            cycleTab();
            return;
        }
        // Enter: advance to review
        if (key.return) {
            onDone();
            return;
        }
        // Escape: go back to components
        if (key.escape) {
            onBack();
            return;
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: "Configuration" }), _jsx(Box, { marginTop: 1, gap: 2, children: TABS.map((tab, i) => {
                    const isActive = i === activeTab;
                    return (_jsx(Text, { color: isActive ? C.primary : C.neutral, bold: isActive, children: isActive ? `[${tab}]` : ` ${tab} ` }, tab));
                }) }), _jsxs(Box, { flexDirection: "column", marginTop: 1, ...BORDER.detail, paddingX: 1, children: [activeTab === 0 && (_jsx(McpConfig, { enabled: config.mcpEnabled, tools: config.mcpTools, projectRoot: config.mcpProjectRoot, mode: config.mode, onEnableChange: (v) => onConfigChange({ mcpEnabled: v }), onToolsChange: (tools) => onConfigChange({ mcpTools: tools }), onRootChange: (root) => onConfigChange({ mcpProjectRoot: root }) })), activeTab === 1 && (_jsx(HooksConfig, { selection: config.hooksSelection ?? {
                            basePreset: config.hookLevel,
                            selectedHooks: getHooksForLevel(config.hookLevel, 'claude'),
                            isCustom: false,
                        }, onSelectionChange: (sel) => onConfigChange({
                            hookLevel: sel.basePreset,
                            hooksSelection: sel,
                        }), tool: "claude" })), activeTab === 2 && (_jsx(BackupConfig, { backupClaudeMd: config.backupClaudeMd, backupAll: config.backupAll, existingFileCount: 0, onClaudeMdChange: (v) => onConfigChange({ backupClaudeMd: v }), onAllChange: (v) => onConfigChange({ backupAll: v }) }))] })] }));
}
//# sourceMappingURL=ConfigPanel.js.map