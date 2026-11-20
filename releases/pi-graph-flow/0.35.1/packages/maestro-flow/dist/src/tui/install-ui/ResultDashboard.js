import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput, useApp } from 'ink';
import { C, BORDER } from '../shared/index.js';
function Row({ label, value }) {
    return (_jsxs(Box, { children: [_jsx(Text, { color: C.primary, children: label.padEnd(13) }), _jsx(Text, { color: C.success, children: value })] }));
}
export function ResultDashboard({ result, onClose }) {
    const { exit } = useApp();
    useInput((_input, key) => {
        if (key.return) {
            onClose();
            exit();
        }
    });
    const { totalStats, manifestPath, mcpRegistered, hookResult, disabledRestored, overlaysApplied } = result;
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Box, { flexDirection: "column", ...BORDER.success, paddingX: 1, children: [_jsx(Text, { bold: true, color: C.success, children: "Installation Complete" }), _jsx(Row, { label: "Files:", value: `${totalStats.files} installed` }), totalStats.dirs > 0 && (_jsx(Row, { label: "Dirs:", value: `${totalStats.dirs} created` })), totalStats.skipped > 0 && (_jsx(Row, { label: "Preserved:", value: `${totalStats.skipped} settings files` })), disabledRestored > 0 && (_jsx(Row, { label: "Disabled:", value: `${disabledRestored} items restored` })), overlaysApplied > 0 && (_jsx(Row, { label: "Overlays:", value: `${overlaysApplied} applied` })), mcpRegistered && (_jsx(Row, { label: "MCP:", value: "maestro-tools registered" })), hookResult && (_jsx(Row, { label: "Hooks:", value: `${hookResult.level} (${hookResult.installedHooks.length} hooks)` })), _jsxs(Box, { children: [_jsx(Text, { color: C.primary, children: 'Manifest:'.padEnd(13) }), _jsx(Text, { dimColor: true, children: manifestPath })] })] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "Restart Claude Code or IDE to pick up changes." }) }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "Press Enter to exit." }) })] }));
}
//# sourceMappingURL=ResultDashboard.js.map