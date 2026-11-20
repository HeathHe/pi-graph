import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { loadConfigSources, } from '../../config/cli-tools-config.js';
import { C, SYM } from '../shared/index.js';
export function ConfigSources({ workDir, onBack }) {
    const [data, setData] = useState(null);
    useEffect(() => { loadConfigSources(workDir).then(setData); }, []);
    useInput((_input, key) => { if (key.escape)
        onBack(); });
    if (!data)
        return _jsx(Text, { dimColor: true, children: "Loading..." });
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Config Sources" }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Global" }), _jsxs(Text, { dimColor: true, children: ["  ", data.globalPath] }), data.global ? (_jsx(ConfigSection, { config: data.global, indent: 2, prefix: "g" })) : (_jsx(Text, { dimColor: true, color: C.warning, children: "  (not found)" })), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Workspace" }), _jsxs(Text, { dimColor: true, children: ["  ", data.workspacePath ?? `${workDir}/.maestro/cli-tools.json`] }), data.workspace ? (_jsx(ConfigSection, { config: data.workspace, indent: 2, prefix: "w" })) : (_jsx(Text, { dimColor: true, color: C.warning, children: "  (not found)" })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "Workspace overrides global. [Esc] Back" })] }));
}
function ConfigSection({ config, indent, prefix }) {
    const pad = ' '.repeat(indent);
    const tools = config.tools ? Object.entries(config.tools) : [];
    const roles = config.roles ? Object.entries(config.roles) : [];
    return (_jsxs(Box, { flexDirection: "column", children: [tools.length > 0 && (_jsxs(_Fragment, { children: [_jsxs(Text, { children: [pad, _jsx(Text, { color: C.primary, children: "tools:" })] }), tools.map(([name, entry]) => (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { children: [pad, "  "] }), _jsx(Text, { color: entry.enabled ? C.success : C.error, children: entry.enabled ? SYM.enabled : SYM.disabled }), _jsx(Text, { bold: true, children: name }), entry.primaryModel ? _jsxs(Text, { dimColor: true, children: ["model=", entry.primaryModel] }) : null, entry.tags?.length ? _jsxs(Text, { color: C.warning, children: ["[", entry.tags.join(','), "]"] }) : null, entry.settingsFile ? _jsxs(Text, { dimColor: true, children: ["settings=", entry.settingsFile] }) : null] }, `${prefix}-t-${name}`)))] })), roles.length > 0 && (_jsxs(_Fragment, { children: [_jsxs(Text, { children: [pad, _jsx(Text, { color: C.primary, children: "roles:" })] }), roles.map(([name, mapping]) => {
                        const detail = mapping.tool
                            ? `→ ${mapping.tool}`
                            : mapping.fallbackChain
                                ? mapping.fallbackChain.join(' → ')
                                : '(empty)';
                        return (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { children: [pad, "  "] }), _jsx(Text, { bold: true, children: name }), _jsx(Text, { dimColor: true, children: detail })] }, `${prefix}-r-${name}`));
                    })] })), tools.length === 0 && roles.length === 0 && (_jsxs(Text, { dimColor: true, children: [pad, "(empty config)"] }))] }));
}
//# sourceMappingURL=ConfigSources.js.map