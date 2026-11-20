import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { t } from '../../i18n/index.js';
import { C, SYM } from '../shared/index.js';
export function BackupConfig({ backupClaudeMd, backupAll, existingFileCount, onClaudeMdChange, onAllChange, }) {
    const options = [
        {
            id: 'claude-md',
            label: t.install.backupOptClaudeMd,
            desc: t.install.backupOptClaudeMdDesc,
            value: backupClaudeMd,
            toggle: onClaudeMdChange,
        },
        {
            id: 'all',
            label: t.install.backupOptAll,
            desc: t.install.backupOptAllDesc.replace('{count}', String(existingFileCount)),
            value: backupAll,
            toggle: onAllChange,
        },
    ];
    const [index, setIndex] = useState(0);
    useInput((input, key) => {
        if (key.upArrow) {
            setIndex((i) => (i <= 0 ? options.length - 1 : i - 1));
        }
        else if (key.downArrow) {
            setIndex((i) => (i >= options.length - 1 ? 0 : i + 1));
        }
        else if (input === ' ') {
            options[index].toggle(!options[index].value);
        }
        else {
            const num = parseInt(input, 10);
            if (!isNaN(num) && num >= 1 && num <= options.length) {
                const opt = options[num - 1];
                opt.toggle(!opt.value);
            }
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.backupTitle }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: options.map((opt, i) => {
                    const hl = i === index;
                    return (_jsxs(Box, { children: [_jsxs(Text, { color: hl ? C.primary : C.neutral, children: ["[", i + 1, "]"] }), _jsxs(Text, { color: opt.value ? C.success : C.neutral, children: [" ", opt.value ? SYM.checkOn : SYM.checkOff, " "] }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: opt.label }), _jsxs(Text, { color: C.neutral, children: [" \u2014 ", opt.desc] })] }, opt.id));
                }) }), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { dimColor: true, children: ["[Up/Down] Navigate  [Space/1-", options.length, "] Toggle  [Enter] Done  [Esc] Back"] }) })] }));
}
//# sourceMappingURL=BackupConfig.js.map