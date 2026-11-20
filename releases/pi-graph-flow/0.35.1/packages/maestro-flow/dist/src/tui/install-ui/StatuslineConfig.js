import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
import { t } from '../../i18n/index.js';
import { THEME_NAMES } from '../../hooks/constants.js';
import { C, SYM } from '../shared/index.js';
// ---------------------------------------------------------------------------
// StatuslineConfig — Statusline toggle + theme selection
// ---------------------------------------------------------------------------
const THEME_LABELS = {
    notion: { label: 'Notion', desc: '柔和暖色，Catppuccin 风格' },
    cyberpunk: { label: 'Cyberpunk', desc: '霓虹高对比，赛博朋克' },
    pastel: { label: 'Fresh Pastel', desc: '柔和粉蓝绿，小清新' },
    nord: { label: 'Nord', desc: '北欧冰蓝，沉稳冷调' },
    monokai: { label: 'Monokai', desc: '经典编辑器，高辨识' },
};
export function StatuslineConfig({ enabled, theme, detected, onToggle, onThemeChange, }) {
    useInput((input) => {
        if (!enabled) {
            if (input === 'y' || input === 'Y')
                onToggle(true);
            else if (input === 'n' || input === 'N')
                onToggle(false);
            return;
        }
        // Theme selection: 1-5
        const idx = parseInt(input, 10) - 1;
        if (idx >= 0 && idx < THEME_NAMES.length) {
            onThemeChange(THEME_NAMES[idx]);
        }
        // Back to toggle
        else if (input === 'n' || input === 'N')
            onToggle(false);
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.statuslineTitle }), detected && (_jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsx(Text, { color: C.warning, children: t.install.statuslineCurrentLabel }), _jsxs(Text, { dimColor: true, children: ["  ", detected] })] })), _jsxs(Box, { marginTop: 1, children: [_jsxs(Text, { children: [t.install.statuslineInstallPrompt, " "] }), _jsx(Text, { color: enabled ? C.success : C.warning, bold: true, children: enabled ? '[Yes]' : '[No]' }), _jsx(Text, { dimColor: true, children: " [y/n]" })] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: t.install.statuslineDesc }) }), detected && enabled && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: C.warning, children: t.install.statuslineOverwriteWarn }) })), enabled && (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Color Theme:" }), THEME_NAMES.map((name, i) => {
                        const info = THEME_LABELS[name] ?? { label: name, desc: '' };
                        const selected = theme === name;
                        return (_jsxs(Box, { marginLeft: 1, children: [_jsx(Text, { color: selected ? C.success : C.neutral, children: selected ? `${SYM.radioOn} ` : `${SYM.radioOff} ` }), _jsxs(Text, { color: selected ? C.success : undefined, bold: selected, children: ["[", i + 1, "] ", info.label] }), _jsxs(Text, { color: C.neutral, children: ["  ", info.desc] })] }, name));
                    })] }))] }));
}
//# sourceMappingURL=StatuslineConfig.js.map