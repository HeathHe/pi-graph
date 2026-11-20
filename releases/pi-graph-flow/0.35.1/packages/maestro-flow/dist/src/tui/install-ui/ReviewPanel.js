import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
import { C, BORDER } from '../shared/index.js';
export function ReviewPanel({ config, componentLabels, fileCount, onConfirm, onBack, }) {
    useInput((_input, key) => {
        if (key.return) {
            onConfirm();
            return;
        }
        if (key.escape) {
            onBack();
            return;
        }
    });
    const targetDir = config.mode === 'global'
        ? '~/.maestro/ + ~/.claude/'
        : config.projectPath || './';
    const componentsStr = componentLabels.length > 0
        ? componentLabels.join(', ')
        : 'None';
    const mcpStr = config.mcpEnabled
        ? `${config.mcpTools.length} tools enabled`
        : 'disabled';
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: "Installation Summary" }), _jsxs(Box, { flexDirection: "column", ...BORDER.primary, paddingX: 1, marginTop: 1, children: [_jsxs(Box, { children: [_jsxs(Text, { bold: true, children: ["Mode:", '        '] }), _jsx(Text, { children: config.mode })] }), _jsxs(Box, { children: [_jsxs(Text, { bold: true, children: ["Target:", '      '] }), _jsx(Text, { children: targetDir })] }), _jsxs(Box, { children: [_jsxs(Text, { bold: true, children: ["Components:", '  '] }), _jsx(Text, { children: componentsStr })] }), _jsxs(Box, { children: [_jsxs(Text, { bold: true, children: ["Files:", '       '] }), _jsxs(Text, { children: [fileCount, " total"] })] }), _jsxs(Box, { children: [_jsxs(Text, { bold: true, children: ["MCP:", '        '] }), _jsx(Text, { children: mcpStr })] }), _jsxs(Box, { children: [_jsxs(Text, { bold: true, children: ["Hooks:", '      '] }), _jsx(Text, { children: config.hookLevel })] }), _jsxs(Box, { children: [_jsxs(Text, { bold: true, children: ["Backup:", '     '] }), _jsx(Text, { children: config.doBackup ? 'yes' : 'no' })] })] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "Enter to install, Esc to go back" }) })] }));
}
//# sourceMappingURL=ReviewPanel.js.map