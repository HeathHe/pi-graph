import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { C, SYM, SP } from './tokens.js';
import { t } from '../../i18n/index.js';
/**
 * Standardized keyboard hint footer.
 * Always rendered at the bottom of interactive screens with marginTop={1}.
 */
export function KeyHints({ hints }) {
    return (_jsx(Box, { marginTop: SP.sectionGap, paddingX: SP.detailPadX, children: _jsx(Text, { dimColor: true, children: hints }) }));
}
/**
 * Bold cyan section header — the standard heading pattern.
 */
export function SectionHeader({ title }) {
    return _jsx(Text, { bold: true, color: C.primary, children: title });
}
/**
 * Standardized status indicator: green ✓ or red ✗.
 */
export function StatusBadge({ enabled, labels }) {
    const label = enabled
        ? (labels?.on ?? SYM.enabled)
        : (labels?.off ?? SYM.disabled);
    return (_jsx(Text, { color: enabled ? C.success : C.error, children: label }));
}
/**
 * Standardized cursor: ▸ in cyan when active, space when not.
 */
export function CursorMarker({ active }) {
    return (_jsxs(Text, { color: active ? C.primary : undefined, children: [active ? SYM.cursor : SYM.cursorBlank, ' '] }));
}
/**
 * Standardized checkbox: [x] in green when checked, [ ] in gray when not.
 * When highlighted and checked, uses greenBright.
 */
export function Checkbox({ checked, highlighted }) {
    const color = checked
        ? (highlighted ? C.successBright : C.success)
        : C.neutral;
    return (_jsxs(Text, { color: color, children: [checked ? SYM.checkOn : SYM.checkOff, " "] }));
}
export function Breadcrumb({ path }) {
    return (_jsxs(Box, { children: [path.map((segment, i) => (_jsxs(Box, { children: [i > 0 && _jsxs(Text, { dimColor: true, children: [" ", '>', " "] }), _jsx(Text, { color: i === path.length - 1 ? C.primary : C.neutral, bold: i === path.length - 1, children: segment })] }, i))), _jsxs(Text, { dimColor: true, children: ['  ', t.install.breadcrumbBack] })] }));
}
/**
 * Horizontal step progress bar: [x] done [>] current [ ] pending
 */
export function StepProgress({ steps, currentKey }) {
    const currentIdx = steps.findIndex(s => s.key === currentKey);
    return (_jsx(Box, { gap: SP.inlineGap, children: steps.map((s, i) => {
            const isDone = i < currentIdx;
            const isCurrent = s.key === currentKey;
            const symbol = isDone ? SYM.stepDone : isCurrent ? SYM.stepActive : SYM.stepPending;
            const color = isDone ? C.success : isCurrent ? C.primary : C.neutral;
            return (_jsxs(Text, { bold: isCurrent, color: color, children: [symbol, " ", s.label] }, s.key));
        }) }));
}
//# sourceMappingURL=components.js.map