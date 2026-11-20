import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { selectToolByRole, getDefaultRoleMappings, saveCliToolsConfig, DELEGATE_ROLES, } from '../../config/cli-tools-config.js';
import { pad, wrapCursor } from '../shared/index.js';
export function RoleMappings({ config, workDir, onBack, onReload }) {
    const defaults = getDefaultRoleMappings();
    const userRoles = config.roles ?? {};
    const enabledTools = Object.entries(config.tools).filter(([, e]) => e.enabled).map(([n]) => n);
    const [cursor, setCursor] = useState(0);
    const [mode, setMode] = useState('list');
    const [editChain, setEditChain] = useState([]);
    const [chainCursor, setChainCursor] = useState(0);
    const [saving, setSaving] = useState(false);
    const roles = [...DELEGATE_ROLES];
    useInput((input, key) => {
        if (saving)
            return;
        if (mode === 'list') {
            if (key.escape) {
                onBack();
                return;
            }
            if (key.upArrow)
                setCursor(c => wrapCursor(c, -1, roles.length));
            if (key.downArrow)
                setCursor(c => wrapCursor(c, 1, roles.length));
            if (key.return || input === 'e') {
                // Edit fallback chain for this role
                const role = roles[cursor];
                const mapping = userRoles[role] ?? defaults[role];
                const chain = mapping?.fallbackChain ?? enabledTools;
                setEditChain([...chain]);
                setChainCursor(0);
                setMode('edit-order');
            }
        }
        if (mode === 'edit-order') {
            if (key.escape) {
                setMode('list');
                return;
            }
            if (key.upArrow)
                setChainCursor(c => c > 0 ? c - 1 : editChain.length - 1);
            if (key.downArrow)
                setChainCursor(c => c < editChain.length - 1 ? c + 1 : 0);
            // Move up/down with shift (K/J)
            if (input === 'K' && chainCursor > 0) {
                setEditChain(prev => {
                    const arr = [...prev];
                    [arr[chainCursor - 1], arr[chainCursor]] = [arr[chainCursor], arr[chainCursor - 1]];
                    return arr;
                });
                setChainCursor(c => c - 1);
            }
            if (input === 'J' && chainCursor < editChain.length - 1) {
                setEditChain(prev => {
                    const arr = [...prev];
                    [arr[chainCursor], arr[chainCursor + 1]] = [arr[chainCursor + 1], arr[chainCursor]];
                    return arr;
                });
                setChainCursor(c => c + 1);
            }
            // Toggle include/exclude
            if (input === ' ') {
                const tool = enabledTools.find(t => !editChain.includes(t));
                if (tool) {
                    // Add next available tool
                    setEditChain(prev => [...prev, tool]);
                }
            }
            if (input === 'd') {
                // Remove current from chain
                if (editChain.length > 1) {
                    setEditChain(prev => prev.filter((_, i) => i !== chainCursor));
                    setChainCursor(c => Math.min(c, editChain.length - 2));
                }
            }
            if (input === 's') {
                const role = roles[cursor];
                setSaving(true);
                saveCliToolsConfig({ roles: { [role]: { fallbackChain: editChain } } }, 'global', workDir).then(() => { onReload(); setSaving(false); setMode('list'); });
            }
        }
    });
    if (mode === 'edit-order') {
        const role = roles[cursor];
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Edit Fallback Chain: ", _jsx(Text, { color: "green", children: role })] }), _jsx(Text, { dimColor: true, children: "First enabled tool in chain wins" }), _jsx(Text, { children: " " }), editChain.map((tool, i) => {
                    const active = i === chainCursor;
                    return (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { color: active ? 'cyan' : undefined, children: [active ? '▸' : ' ', " ", i + 1, "."] }), _jsx(Text, { bold: active, color: i === 0 ? 'green' : active ? 'cyan' : undefined, children: tool })] }, `${tool}-${i}`));
                }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "[\u2191\u2193] Select  [Shift+K/J] Move up/down  [d] Remove  [s] Save  [Esc] Cancel" }), saving && _jsx(Text, { dimColor: true, children: "Saving..." })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "Role Mappings" }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: pad('  Role', 16) }), _jsx(Text, { dimColor: true, children: pad('Resolved', 12) }), _jsx(Text, { dimColor: true, children: pad('Source', 10) }), _jsx(Text, { dimColor: true, children: "Fallback Chain" })] }), _jsx(Text, { dimColor: true, children: '─'.repeat(76) }), roles.map((role, i) => {
                const active = i === cursor;
                const selected = selectToolByRole(role, config);
                const mapping = userRoles[role] ?? defaults[role];
                const chain = mapping?.fallbackChain?.join(' → ') ?? (mapping?.tool ? `→ ${mapping.tool}` : '—');
                const source = userRoles[role] ? 'user' : 'default';
                return (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: active ? 'cyan' : undefined, children: active ? '▸' : ' ' }), _jsx(Text, { bold: active, color: active ? 'cyan' : undefined, children: pad(role, 14) }), _jsx(Text, { color: "green", children: pad(selected?.name ?? '(none)', 12) }), _jsx(Text, { color: source === 'user' ? 'yellow' : undefined, dimColor: source === 'default', children: pad(source, 10) }), _jsx(Text, { dimColor: true, children: chain })] }, role));
            }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "[\u2191\u2193] Navigate  [Enter/e] Edit chain  [Esc] Back" })] }));
}
//# sourceMappingURL=RoleMappings.js.map