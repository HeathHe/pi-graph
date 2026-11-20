import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { C, SYM } from '../shared/index.js';
const LABEL_WIDTH = 18;
const FILE_COL_WIDTH = 12;
function padEnd(str, len) {
    if (str.length >= len)
        return str.slice(0, len);
    return str + ' '.repeat(len - str.length);
}
export function CyberItem({ index, label, fileCount, selected, available, highlighted, description, mandatory, }) {
    const paddedLabel = padEnd(label, LABEL_WIDTH);
    const filesStr = `(${fileCount} files)`.padStart(FILE_COL_WIDTH);
    if (!available) {
        return (_jsx(Box, { children: _jsxs(Text, { dimColor: true, color: C.neutral, children: ["[", index, "] ", SYM.checkOff, " ", paddedLabel, " ", filesStr, " [OFFLINE]"] }) }));
    }
    if (mandatory) {
        return (_jsxs(Box, { children: [_jsx(Text, { color: C.neutral, children: "    " }), _jsxs(Text, { color: highlighted ? C.successBright : C.success, children: ['◆', " "] }), _jsx(Text, { color: highlighted ? C.successBright : C.success, bold: highlighted, children: paddedLabel }), _jsxs(Text, { color: C.neutral, children: [" ", filesStr, " "] }), _jsx(Text, { color: C.neutral, children: description })] }));
    }
    const checkbox = selected ? SYM.checkOn : SYM.checkOff;
    if (selected && highlighted) {
        return (_jsxs(Box, { children: [_jsxs(Text, { color: C.neutral, children: ["[", index, "] "] }), _jsxs(Text, { color: C.success, children: [checkbox, " "] }), _jsx(Text, { color: C.successBright, bold: true, children: paddedLabel }), _jsxs(Text, { color: C.neutral, children: [" ", filesStr, " "] }), _jsx(Text, { color: C.neutral, children: description })] }));
    }
    if (selected) {
        return (_jsxs(Box, { children: [_jsxs(Text, { color: C.neutral, children: ["[", index, "] "] }), _jsxs(Text, { color: C.success, children: [checkbox, " "] }), _jsx(Text, { color: C.success, children: paddedLabel }), _jsxs(Text, { color: C.neutral, children: [" ", filesStr, " "] }), _jsx(Text, { color: C.neutral, children: description })] }));
    }
    if (highlighted) {
        return (_jsxs(Box, { children: [_jsxs(Text, { color: C.neutral, children: ["[", index, "] "] }), _jsxs(Text, { color: C.primary, children: [checkbox, " "] }), _jsx(Text, { color: C.primary, bold: true, children: paddedLabel }), _jsxs(Text, { color: C.neutral, children: [" ", filesStr, " "] }), _jsx(Text, { color: C.neutral, children: description })] }));
    }
    return (_jsxs(Box, { children: [_jsxs(Text, { color: C.neutral, children: ["[", index, "] "] }), _jsxs(Text, { color: C.neutral, children: [checkbox, " "] }), _jsx(Text, { children: paddedLabel }), _jsxs(Text, { color: C.neutral, children: [" ", filesStr, " "] }), _jsx(Text, { color: C.neutral, children: description })] }));
}
//# sourceMappingURL=CyberItem.js.map