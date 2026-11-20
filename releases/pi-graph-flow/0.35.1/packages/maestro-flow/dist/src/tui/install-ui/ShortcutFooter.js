import { jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from 'ink';
const STEP_HINTS = {
    mode: '[G]lobal  [P]roject  [Enter] Next',
    components: '[1-9] Toggle  [A]ll  [N]one  [Enter] Next  [Esc] Back',
    config: '[Enter] Next  [Esc] Back',
    review: '[Enter] Install  [Esc] Back',
    executing: 'Installing... please wait',
    complete: '[Enter] Exit',
};
export function ShortcutFooter({ currentStep }) {
    const hint = STEP_HINTS[currentStep];
    return (_jsx(Box, { paddingX: 1, children: _jsx(Text, { dimColor: true, children: hint }) }));
}
//# sourceMappingURL=ShortcutFooter.js.map