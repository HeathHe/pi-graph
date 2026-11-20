import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { existsSync } from 'node:fs';
import { saveCliToolsConfig, DELEGATE_ROLES, } from '../../config/cli-tools-config.js';
import { C, SYM } from '../shared/index.js';
export function RegisterSettings({ config, workDir, onBack }) {
    const [phase, setPhase] = useState('name');
    const [alias, setAlias] = useState('');
    const [role, setRole] = useState('');
    const [roleCursor, setRoleCursor] = useState(0);
    const [path, setPath] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    // Existing aliases
    const existing = Object.entries(config.tools)
        .filter(([, e]) => e.baseTool === 'claude')
        .map(([name, e]) => ({ name, settings: e.settingsFile ?? '—' }));
    useInput((input, key) => {
        if (key.escape) {
            onBack();
            return;
        }
        if (phase === 'role') {
            if (key.upArrow)
                setRoleCursor(c => c > 0 ? c - 1 : DELEGATE_ROLES.length - 1);
            if (key.downArrow)
                setRoleCursor(c => c < DELEGATE_ROLES.length - 1 ? c + 1 : 0);
            if (key.return) {
                setRole(DELEGATE_ROLES[roleCursor]);
                const ex = config.tools[alias];
                if (ex?.settingsFile)
                    setPath(ex.settingsFile);
                setPhase('path');
            }
            // Number hotkeys 1-7
            const n = parseInt(input, 10);
            if (n >= 1 && n <= DELEGATE_ROLES.length) {
                setRoleCursor(n - 1);
                setRole(DELEGATE_ROLES[n - 1]);
                const ex = config.tools[alias];
                if (ex?.settingsFile)
                    setPath(ex.settingsFile);
                setPhase('path');
            }
        }
        if (phase === 'scope') {
            if (input === 'g')
                doSave('global');
            if (input === 'p')
                doSave('workspace');
        }
        if (phase === 'done' || phase === 'error') {
            if (key.return || key.escape)
                onBack();
        }
    });
    const handleNameSubmit = (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
            setError('Name is required');
            return;
        }
        setAlias(trimmed);
        setError('');
        if (trimmed === 'claude') {
            // Base tool — skip role selection
            setRole('');
            const ex = config.tools.claude;
            if (ex?.settingsFile)
                setPath(ex.settingsFile);
            setPhase('path');
        }
        else {
            setPhase('role');
        }
    };
    const handlePathSubmit = (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
            setError('Path is required');
            return;
        }
        const expanded = trimmed.startsWith('~/')
            ? trimmed.replace('~', process.env.HOME ?? process.env.USERPROFILE ?? '~')
            : trimmed;
        if (!existsSync(expanded)) {
            setError(`File not found: ${expanded}`);
            return;
        }
        setPath(trimmed);
        setError('');
        setPhase('scope');
    };
    const doSave = async (scope) => {
        setPhase('saving');
        try {
            const isBase = alias === 'claude';
            const base = config.tools.claude ?? { enabled: true, primaryModel: '', tags: [], type: 'builtin' };
            const entry = config.tools[alias] ?? {
                enabled: true,
                primaryModel: isBase ? base.primaryModel : base.primaryModel,
                tags: isBase ? base.tags : base.tags,
                type: 'builtin',
            };
            const toolUpdate = {
                ...entry,
                settingsFile: path,
                ...(!isBase ? { baseTool: 'claude' } : {}),
            };
            // Also update role mapping if a role was selected
            const rolesUpdate = role ? { [role]: { tool: alias } } : undefined;
            await saveCliToolsConfig({ tools: { [alias]: toolUpdate }, ...(rolesUpdate ? { roles: rolesUpdate } : {}) }, scope, workDir);
            const roleMsg = role ? ` (role: ${role})` : '';
            setMessage(`${alias}${roleMsg} → ${path} saved to ${scope}`);
            setPhase('done');
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setPhase('error');
        }
    };
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Register Settings (Claude)" }), _jsx(Text, { children: " " }), existing.length > 0 && (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: "Existing aliases:" }), existing.map(e => (_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "  " }), _jsx(Text, { bold: true, children: e.name }), _jsxs(Text, { dimColor: true, children: ["\u2192 ", e.settings] })] }, e.name))), _jsx(Text, { children: " " })] })), phase === 'name' && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "Name:" }), _jsx(TextInput, { placeholder: "claude-analysis (or 'claude' for base)", onSubmit: handleNameSubmit })] }), error && _jsxs(Text, { color: C.error, children: ["  ", error] }), _jsx(Text, { dimColor: true, children: "Enter alias name. Use \"claude\" to set base settings." })] })), phase === 'role' && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "Name:" }), _jsx(Text, { bold: true, color: C.success, children: alias })] }), _jsx(Text, { children: "Assign to role:" }), DELEGATE_ROLES.map((r, i) => (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { color: i === roleCursor ? C.primary : undefined, children: [i === roleCursor ? ` ${SYM.cursor}` : '  ', " ", i + 1, "."] }), _jsx(Text, { bold: i === roleCursor, color: i === roleCursor ? C.primary : undefined, children: r })] }, r))), _jsx(Text, { dimColor: true, children: "[\u2191\u2193] Navigate  [1-7] Select  [Enter] Confirm" })] })), phase === 'path' && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "Name:" }), _jsx(Text, { bold: true, color: C.success, children: alias })] }), role && _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "Role:" }), _jsx(Text, { color: C.warning, children: role })] }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "Path:" }), _jsx(TextInput, { defaultValue: path, placeholder: "~/.maestro/profiles/claude-analysis.json", onSubmit: handlePathSubmit })] }), error && _jsxs(Text, { color: C.error, children: ["  ", error] })] })), phase === 'scope' && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "Name:" }), _jsx(Text, { bold: true, color: C.success, children: alias })] }), role && _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "Role:" }), _jsx(Text, { color: C.warning, children: role })] }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "Path:" }), _jsx(Text, { dimColor: true, children: path })] }), _jsx(Text, { children: " " }), _jsx(Text, { children: "Save to:" }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { color: C.primary, children: "[g]" }), _jsx(Text, { children: "Global" })] }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { color: C.primary, children: "[p]" }), _jsx(Text, { children: "Project" })] })] })), phase === 'saving' && _jsx(Text, { dimColor: true, children: "Saving..." }), phase === 'done' && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: C.success, children: [SYM.enabled, " ", message] }), _jsx(Text, { dimColor: true, children: "[Enter] Back" })] })), phase === 'error' && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: C.error, children: [SYM.disabled, " ", error] }), _jsx(Text, { dimColor: true, children: "[Enter] Back" })] }))] }));
}
//# sourceMappingURL=RegisterSettings.js.map