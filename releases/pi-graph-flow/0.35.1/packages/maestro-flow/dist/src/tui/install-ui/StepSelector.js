import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { C, SYM, SP, wrapCursor, parseNumberKey, KeyHints, SectionHeader } from '../shared/index.js';
export function StepSelector({ steps, selectedIds, onSelectionChange, onDone }) {
    const [index, setIndex] = useState(0);
    useInput((input, key) => {
        if (key.upArrow) {
            setIndex((i) => wrapCursor(i, -1, steps.length));
        }
        else if (key.downArrow) {
            setIndex((i) => wrapCursor(i, 1, steps.length));
        }
        else if (input === ' ') {
            const id = steps[index].id;
            const next = selectedIds.includes(id)
                ? selectedIds.filter((s) => s !== id)
                : [...selectedIds, id];
            onSelectionChange(next);
        }
        else if (input === 'a' || input === 'A') {
            onSelectionChange(steps.map((s) => s.id));
        }
        else if (input === 'n' || input === 'N') {
            onSelectionChange([]);
        }
        else if (key.return) {
            onDone();
        }
        else {
            const idx = parseNumberKey(input, steps.length);
            if (idx !== null) {
                const id = steps[idx].id;
                const next = selectedIds.includes(id)
                    ? selectedIds.filter((s) => s !== id)
                    : [...selectedIds, id];
                onSelectionChange(next);
            }
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(SectionHeader, { title: "Select Installation Steps" }), _jsx(Box, { flexDirection: "column", marginTop: SP.sectionGap, children: steps.map((step, i) => {
                    const sel = selectedIds.includes(step.id);
                    const hl = i === index;
                    return (_jsxs(Box, { children: [_jsxs(Text, { color: hl ? C.primary : C.neutral, children: ["[", i + 1, "]"] }), _jsxs(Text, { color: sel ? (hl ? C.successBright : C.success) : C.neutral, children: [" ", sel ? SYM.checkOn : SYM.checkOff, " "] }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: step.label }), _jsxs(Text, { color: C.neutral, children: [" \u2014 ", step.description] })] }, step.id));
                }) }), _jsx(KeyHints, { hints: `[Space] Toggle  [1-${steps.length}] Quick toggle  [A]ll  [N]one  [Enter] Next` })] }));
}
//# sourceMappingURL=StepSelector.js.map