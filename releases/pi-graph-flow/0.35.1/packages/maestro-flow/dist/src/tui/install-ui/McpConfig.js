import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { MCP_TOOLS } from '../../commands/install-backend.js';
import { t } from '../../i18n/index.js';
import { C, SYM } from '../shared/index.js';
export function McpConfig({ enabled, tools, projectRoot, mode, onEnableChange, onToolsChange, onRootChange, }) {
    const [editingRoot, setEditingRoot] = useState(false);
    const [rootInput, setRootInput] = useState(projectRoot);
    // Index 0 = enable toggle, 1..N = tools
    const [index, setIndex] = useState(0);
    const totalRows = enabled ? 1 + MCP_TOOLS.length : 1;
    const toggleTool = useCallback((toolIndex) => {
        if (toolIndex < 0 || toolIndex >= MCP_TOOLS.length)
            return;
        const toolName = MCP_TOOLS[toolIndex];
        if (tools.includes(toolName)) {
            onToolsChange(tools.filter((t) => t !== toolName));
        }
        else {
            onToolsChange([...tools, toolName]);
        }
    }, [tools, onToolsChange]);
    useInput((input, key) => {
        if (editingRoot)
            return;
        if (key.upArrow) {
            setIndex((i) => (i <= 0 ? totalRows - 1 : i - 1));
        }
        else if (key.downArrow) {
            setIndex((i) => (i >= totalRows - 1 ? 0 : i + 1));
        }
        else if (input === ' ') {
            if (index === 0) {
                onEnableChange(!enabled);
            }
            else {
                toggleTool(index - 1);
            }
        }
        else if (input === 'y' || input === 'Y') {
            onEnableChange(true);
        }
        else if (input === 'n' || input === 'N') {
            onEnableChange(false);
        }
        else if (input === 'r' || input === 'R') {
            setEditingRoot(true);
        }
        else {
            const num = parseInt(input, 10);
            if (!isNaN(num) && num >= 1 && num <= MCP_TOOLS.length && enabled) {
                toggleTool(num - 1);
            }
        }
    });
    const handleRootSubmit = useCallback((value) => {
        onRootChange(value);
        setEditingRoot(false);
    }, [onRootChange]);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.mcpTitle }), _jsxs(Box, { marginTop: 1, children: [_jsxs(Text, { color: index === 0 ? C.primary : undefined, children: [t.install.mcpEnable, ' '] }), _jsx(Text, { color: enabled ? C.success : C.warning, bold: true, children: enabled ? t.install.mcpYes : t.install.mcpNo }), _jsx(Text, { dimColor: true, children: " [y/n/Space]" })] }), enabled && (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.mcpTools }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: MCP_TOOLS.map((tool, i) => {
                            const checked = tools.includes(tool);
                            const hl = index === i + 1;
                            return (_jsxs(Box, { children: [_jsxs(Text, { color: hl ? C.primary : C.neutral, children: ["[", i + 1, "]"] }), _jsxs(Text, { color: checked ? C.success : C.neutral, children: [" ", checked ? SYM.checkOn : SYM.checkOff, " "] }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: tool })] }, tool));
                        }) }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: t.install.mcpToolsEnabled
                                .replace('{enabled}', String(tools.length))
                                .replace('{total}', String(MCP_TOOLS.length)) }) }), mode === 'project' && (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { children: [t.install.mcpProjectRoot, ' ', editingRoot ? (_jsx(TextInput, { placeholder: projectRoot || process.cwd(), defaultValue: projectRoot, onSubmit: handleRootSubmit, onChange: setRootInput })) : (_jsx(Text, { color: C.primary, children: projectRoot || t.install.mcpProjectRootDefault }))] }), !editingRoot && (_jsx(Text, { dimColor: true, children: t.install.mcpEditRoot }))] }))] })), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { dimColor: true, children: ["[Up/Down] Navigate  [Space/1-", MCP_TOOLS.length, "] Toggle  [y/n] Enable  [Enter] Done  [Esc] Back"] }) })] }));
}
//# sourceMappingURL=McpConfig.js.map