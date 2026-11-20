import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { loadCliToolsConfig, resetCliToolsConfig, } from '../../config/cli-tools-config.js';
import { ToolsOverview } from './ToolsOverview.js';
import { RoleMappings } from './RoleMappings.js';
import { RegisterSettings } from './RegisterSettings.js';
import { CommandReference } from './CommandReference.js';
import { ConfigSources } from './ConfigSources.js';
import { C, SP, BORDER, pad, KeyHints, SectionHeader, StatusBadge } from '../shared/index.js';
export function ToolsDashboard({ workDir, initialView }) {
    const { exit } = useApp();
    const [view, setView] = useState(initialView ?? 'dashboard');
    const [config, setConfig] = useState(null);
    const reload = async () => {
        const cfg = await loadCliToolsConfig(workDir);
        setConfig(cfg);
    };
    useEffect(() => { reload(); }, []);
    useInput((input, key) => {
        if (view === 'reset-confirm') {
            if (key.escape || input === 'n') {
                setView('dashboard');
                return;
            }
            if (key.return || input === 'y') {
                resetCliToolsConfig().then(cfg => { setConfig(cfg); setView('dashboard'); });
            }
            return;
        }
        if (view !== 'dashboard')
            return;
        if (input === '1')
            setView('tools');
        if (input === '2')
            setView('roles');
        if (input === '3')
            setView('register');
        if (input === '4')
            setView('reference');
        if (input === '5')
            setView('sources');
        if (input === '6')
            setView('reset-confirm');
        if (input === 'q' || key.escape)
            exit();
    });
    if (!config) {
        return _jsx(Text, { dimColor: true, children: "Loading configuration..." });
    }
    if (view === 'tools') {
        return _jsx(ToolsOverview, { config: config, workDir: workDir, onBack: () => { reload(); setView('dashboard'); }, onReload: reload });
    }
    if (view === 'roles') {
        return _jsx(RoleMappings, { config: config, workDir: workDir, onBack: () => { reload(); setView('dashboard'); }, onReload: reload });
    }
    if (view === 'register') {
        return (_jsx(RegisterSettings, { config: config, workDir: workDir, onBack: () => { reload(); setView('dashboard'); } }));
    }
    if (view === 'reference') {
        return _jsx(CommandReference, { config: config, onBack: () => setView('dashboard') });
    }
    if (view === 'sources') {
        return _jsx(ConfigSources, { workDir: workDir, onBack: () => setView('dashboard') });
    }
    if (view === 'reset-confirm') {
        return (_jsxs(Box, { flexDirection: "column", paddingX: SP.detailPadX, children: [_jsxs(Box, { ...BORDER.warning, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(Text, { bold: true, color: C.warning, children: "Reset CLI tools to defaults?" }), _jsx(Text, { children: " " }), _jsx(Text, { children: "This will overwrite ~/.maestro/cli-tools.json with default" }), _jsx(Text, { children: "tool definitions and re-detect CLI availability." }), _jsx(Text, { children: "Custom roles and aliases will be lost." })] }), _jsx(KeyHints, { hints: "[y] Confirm  [n/Esc] Cancel" })] }));
    }
    // Dashboard view
    const toolEntries = Object.entries(config.tools);
    return (_jsxs(Box, { flexDirection: "column", paddingX: SP.detailPadX, children: [_jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(SectionHeader, { title: "MAESTRO TOOLS" }), _jsx(Text, { children: " " }), toolEntries.length === 0 ? (_jsx(Text, { dimColor: true, children: "  No tools configured in cli-tools.json" })) : (toolEntries.map(([name, entry]) => (_jsxs(Box, { gap: SP.inlineGap, children: [_jsx(Text, { children: "  " }), _jsx(StatusBadge, { enabled: entry.enabled }), _jsx(Text, { bold: true, children: pad(name, 12) }), _jsx(Text, { dimColor: true, children: pad(entry.primaryModel || '—', 24) }), _jsx(Text, { color: C.accent, children: pad(entry.reasoningEffort ?? '—', 8) }), _jsx(Text, { color: C.warning, children: entry.tags?.length ? `[${entry.tags.join(', ')}]` : '—' })] }, name)))), _jsx(Text, { children: " " }), _jsxs(Box, { gap: SP.tabGap, children: [_jsx(Text, { color: C.primary, children: "[1]" }), _jsx(Text, { children: "Tools" }), _jsx(Text, { color: C.primary, children: "[2]" }), _jsx(Text, { children: "Roles" }), _jsx(Text, { color: C.primary, children: "[3]" }), _jsx(Text, { children: "Register" }), _jsx(Text, { color: C.primary, children: "[4]" }), _jsx(Text, { children: "Ref" }), _jsx(Text, { color: C.primary, children: "[5]" }), _jsx(Text, { children: "Config" }), _jsx(Text, { color: C.primary, children: "[6]" }), _jsx(Text, { children: "Reset" })] })] }), _jsx(KeyHints, { hints: "[1-6] Select  [q] Quit" })] }));
}
//# sourceMappingURL=ToolsDashboard.js.map