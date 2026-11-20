import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { C, SYM, SP, BORDER, pad, wrapCursor, KeyHints, SectionHeader, StatusBadge } from '../shared/index.js';
export function HooksPanel({ workDir, onBack }) {
    const { exit } = useApp();
    const [hooks, setHooks] = useState([]);
    const [globalInstalled, setGlobalInstalled] = useState(false);
    const [cursor, setCursor] = useState(0);
    const [statusLine, setStatusLine] = useState(false);
    useEffect(() => {
        loadStatus();
    }, []);
    async function loadStatus() {
        const { HOOK_DEFS, HOOK_LEVEL_DESCRIPTIONS, getClaudeSettingsPath, loadClaudeSettings, } = await import('../../commands/hooks.js');
        const { loadHooksConfig, normalizeHookToggleKey } = await import('../../config/index.js');
        const settingsPath = getClaudeSettingsPath();
        const settings = loadClaudeSettings(settingsPath);
        const config = loadHooksConfig();
        const hasStatusline = settings.statusLine?.command?.includes('maestro') || false;
        setStatusLine(hasStatusline);
        setGlobalInstalled(!!settings.hooks);
        const items = [];
        for (const [name, def] of Object.entries(HOOK_DEFS)) {
            // Check if installed in settings
            const installed = findHook(settings, name);
            // Check toggle
            const toggleKey = normalizeHookToggleKey(name);
            const enabled = config.toggles[toggleKey] !== false;
            items.push({
                name,
                event: def.event,
                matcher: def.matcher,
                level: def.level,
                installed,
                enabled,
                requiresWorkspace: !!def.requiresWorkspace,
            });
        }
        setHooks(items);
    }
    useInput((input, key) => {
        if (input === 'q' || key.escape) {
            if (onBack)
                onBack();
            else
                exit();
        }
        if (key.upArrow)
            setCursor(c => wrapCursor(c, -1, hooks.length));
        if (key.downArrow)
            setCursor(c => wrapCursor(c, 1, hooks.length));
    });
    if (hooks.length === 0) {
        return _jsx(Text, { dimColor: true, children: "Loading hooks status..." });
    }
    const selected = hooks[cursor];
    return (_jsxs(Box, { flexDirection: "column", paddingX: SP.detailPadX, children: [_jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(SectionHeader, { title: "HOOKS STATUS" }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: SP.tabGap, children: [_jsx(Text, { children: "Statusline:" }), _jsx(StatusBadge, { enabled: statusLine, labels: { on: 'installed', off: 'not installed' } })] }), _jsx(Text, { children: " " }), _jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: SP.inlineGap, children: [_jsx(Text, { dimColor: true, children: pad('', 2) }), _jsx(Text, { dimColor: true, bold: true, children: pad('Hook', 24) }), _jsx(Text, { dimColor: true, bold: true, children: pad('Event', 20) }), _jsx(Text, { dimColor: true, bold: true, children: pad('Level', 10) }), _jsx(Text, { dimColor: true, bold: true, children: pad('Status', 12) })] }), hooks.map((h, i) => {
                                const isCurrent = i === cursor;
                                const icon = h.installed
                                    ? (h.enabled ? SYM.enabled : SYM.dotEmpty)
                                    : SYM.disabled;
                                const iconColor = h.installed
                                    ? (h.enabled ? C.success : C.warning)
                                    : C.error;
                                const matcher = h.matcher ? ` [${h.matcher}]` : '';
                                return (_jsxs(Box, { gap: SP.inlineGap, children: [_jsx(Text, { color: C.primary, children: isCurrent ? SYM.cursor : ' ' }), _jsx(Text, { color: iconColor, children: icon }), _jsx(Text, { bold: isCurrent, children: pad(h.name, 23) }), _jsx(Text, { dimColor: !isCurrent, children: pad(`${h.event}${matcher}`, 20) }), _jsx(Text, { dimColor: !isCurrent, children: pad(h.level, 10) }), _jsx(Text, { color: iconColor, children: h.installed ? (h.enabled ? 'active' : 'disabled') : 'not installed' })] }, h.name));
                            })] }), selected && selected.requiresWorkspace && (_jsx(Box, { marginTop: SP.sectionGap, children: _jsx(Text, { dimColor: true, children: "\u2691 Requires workspace" }) })), _jsx(Text, { children: " " }), _jsxs(Text, { dimColor: true, children: ["  CLI: maestro hooks install --level ", '<', "minimal|standard|full", '>'] })] }), _jsx(KeyHints, { hints: "[\u2191\u2193] Navigate  [q] Back" })] }));
}
function findHook(settings, name) {
    if (!settings.hooks)
        return false;
    for (const eventKey of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop']) {
        const groups = settings.hooks[eventKey];
        if (!Array.isArray(groups))
            continue;
        for (const group of groups) {
            if (Array.isArray(group.hooks)) {
                for (const h of group.hooks) {
                    if (h.command?.includes(name))
                        return true;
                }
            }
        }
    }
    return false;
}
//# sourceMappingURL=HooksPanel.js.map