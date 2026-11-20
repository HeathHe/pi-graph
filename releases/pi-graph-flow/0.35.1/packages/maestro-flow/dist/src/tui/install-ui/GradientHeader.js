import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';
import { WIZARD_STEPS } from './types.js';
import { StepProgress } from '../shared/index.js';
const STEP_LABELS = {
    mode: 'Mode',
    components: 'Components',
    config: 'Config',
    review: 'Review',
    executing: 'Installing',
    complete: 'Done',
};
export function GradientHeader({ currentStep, version }) {
    const stepIndex = WIZARD_STEPS.indexOf(currentStep);
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Gradient, { name: "fruit", children: _jsx(BigText, { text: "MAESTRO", font: "slick" }) }), _jsx(Box, { marginTop: -2, children: _jsx(Text, { dimColor: true, children: _jsx(BigText, { text: "flow", font: "slick" }) }) }), _jsx(Box, { marginLeft: 2, children: _jsxs(Text, { dimColor: true, children: ["install wizard  v", version] }) })] }), _jsx(StepProgress, { steps: WIZARD_STEPS.map(s => ({ key: s, label: STEP_LABELS[s] })), currentKey: currentStep })] }));
}
//# sourceMappingURL=GradientHeader.js.map