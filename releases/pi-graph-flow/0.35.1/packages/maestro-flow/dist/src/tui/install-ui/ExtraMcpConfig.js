import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { C, SYM } from '../shared/index.js';
import { EXTRA_MCP_TARGETS } from '../../commands/install-backend.js';
export function ExtraMcpConfig({ mode, selectedIds, onSelectionChange, onDone, onBack, }) {
    const [cursor, setCursor] = useState(0);
    // Roo is project-only; hide entries with no path for current scope
    const visible = EXTRA_MCP_TARGETS.filter((t) => t.configPath(mode, '') !== null || mode === 'project');
    const count = visible.length;
    const safeIndex = Math.max(0, Math.min(cursor, count - 1));
    const toggle = useCallback((id) => {
        onSelectionChange(selectedIds.includes(id)
            ? selectedIds.filter((x) => x !== id)
            : [...selectedIds, id]);
    }, [selectedIds, onSelectionChange]);
    useInput((input, key) => {
        if (key.return) {
            onDone();
            return;
        }
        if (key.escape) {
            onBack();
            return;
        }
        if (key.upArrow) {
            setCursor((i) => (i - 1 + count) % count);
            return;
        }
        if (key.downArrow) {
            setCursor((i) => (i + 1) % count);
            return;
        }
        if (input === ' ') {
            toggle(visible[safeIndex].id);
            return;
        }
        if (input === 'a' || input === 'A') {
            onSelectionChange(visible.map((t) => t.id));
            return;
        }
        if (input === 'n' || input === 'N') {
            onSelectionChange([]);
            return;
        }
        // Number key 1-9 toggles by index
        const num = parseInt(input, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= count) {
            toggle(visible[num - 1].id);
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: "Extra MCP Targets (opt-in)" }), _jsx(Text, { color: C.neutral, children: "Register maestro-tools MCP server in additional CLI/IDE configs. Default: none selected." }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: visible.map((target, i) => {
                    const selected = selectedIds.includes(target.id);
                    const highlighted = i === safeIndex;
                    const path = target.configPath(mode, '<project>') ?? '(unsupported in global scope)';
                    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsxs(Text, { color: highlighted ? C.primary : C.neutral, children: ["[", i + 1, "]"] }), _jsxs(Text, { color: selected ? (highlighted ? C.successBright : C.success) : C.neutral, children: [' ', selected ? SYM.checkOn : SYM.checkOff, ' '] }), _jsx(Text, { color: highlighted ? C.primary : undefined, bold: highlighted, children: target.label })] }), _jsxs(Text, { color: C.neutral, children: ["      \u2192 ", path] })] }, target.id));
                }) }), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { dimColor: true, children: ["[Space/1-", count, "] Toggle  [a] All  [n] None  [Enter] Done  [Esc] Back"] }) }), _jsx(Box, { children: _jsxs(Text, { dimColor: true, children: ["Selected: ", selectedIds.length, "/", count] }) })] }));
}
//# sourceMappingURL=ExtraMcpConfig.js.map