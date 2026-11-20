import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { C, SYM, SP, SectionHeader, KeyHints } from '../shared/index.js';
export function EntryCommandsConfig({ eligibleSteps, selectedSteps, onSelectionChange, onDone, }) {
    const [cursor, setCursor] = useState(0);
    const count = eligibleSteps.length;
    const safeIndex = Math.max(0, Math.min(cursor, count - 1));
    const toggle = useCallback((step) => {
        onSelectionChange(selectedSteps.includes(step)
            ? selectedSteps.filter((s) => s !== step)
            : [...selectedSteps, step]);
    }, [selectedSteps, onSelectionChange]);
    useInput((input, key) => {
        if (key.return) {
            onDone();
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
            toggle(eligibleSteps[safeIndex].step);
            return;
        }
        if (input === 'a' || input === 'A') {
            onSelectionChange(eligibleSteps.map((s) => s.step));
            return;
        }
        if (input === 'n' || input === 'N') {
            onSelectionChange([]);
            return;
        }
        const num = parseInt(input, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= count) {
            toggle(eligibleSteps[num - 1].step);
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(SectionHeader, { title: "Entry Commands \u2014 Step Selection" }), _jsx(Box, { marginTop: SP.sectionGap, children: _jsx(Text, { color: C.neutral, children: "Generate slash-command wrappers (maestro run thin entries) for selected steps." }) }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: eligibleSteps.map((info, i) => {
                    const selected = selectedSteps.includes(info.step);
                    const hl = i === safeIndex;
                    return (_jsxs(Box, { children: [_jsxs(Text, { color: hl ? C.primary : C.neutral, children: ["[", i + 1, "]"] }), _jsxs(Text, { color: selected ? (hl ? C.successBright : C.success) : C.neutral, children: [' ', selected ? SYM.checkOn : SYM.checkOff, ' '] }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: info.step.padEnd(16) }), _jsx(Text, { color: C.neutral, children: info.description.slice(0, 60) })] }, info.step));
                }) }), _jsxs(Box, { marginTop: 1, children: [_jsxs(Text, { dimColor: true, children: ["Selected: ", selectedSteps.length, "/", count] }), selectedSteps.length > 0 && (_jsxs(Text, { dimColor: true, children: ["  (", selectedSteps.join(', '), ")"] }))] }), _jsx(KeyHints, { hints: `[Space/1-${count}] Toggle  [A]ll  [N]one  [Enter] Done` })] }));
}
//# sourceMappingURL=EntryCommandsConfig.js.map