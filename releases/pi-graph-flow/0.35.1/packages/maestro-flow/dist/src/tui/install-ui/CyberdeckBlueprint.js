import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { DEFAULT_INSTALL_CONFIG, WIZARD_STEPS } from './types.js';
import { C, SYM } from '../shared/index.js';
import { GradientHeader } from './GradientHeader.js';
import { ShortcutFooter } from './ShortcutFooter.js';
import { ComponentGrid } from './ComponentGrid.js';
import { BlueprintPreview } from './BlueprintPreview.js';
import { ConfigPanel } from './ConfigPanel.js';
import { ReviewPanel } from './ReviewPanel.js';
import { ExecutionView } from './ExecutionView.js';
import { ResultDashboard } from './ResultDashboard.js';
import { scanComponents, COMPONENT_DEFS } from '../../commands/install-backend.js';
function stepForward(current) {
    const idx = WIZARD_STEPS.indexOf(current);
    if (idx < 0 || idx >= WIZARD_STEPS.length - 1)
        return null;
    return WIZARD_STEPS[idx + 1];
}
function stepBack(current) {
    const idx = WIZARD_STEPS.indexOf(current);
    if (idx <= 0)
        return null;
    return WIZARD_STEPS[idx - 1];
}
export function CyberdeckBlueprint({ pkgRoot, version }) {
    const { exit } = useApp();
    const [currentStep, setCurrentStep] = useState('mode');
    const [config, setConfig] = useState({ ...DEFAULT_INSTALL_CONFIG });
    const [installResult, setInstallResult] = useState(null);
    const goForward = useCallback(() => {
        setCurrentStep((prev) => {
            const next = stepForward(prev);
            return next ?? prev;
        });
    }, []);
    const goBack = useCallback(() => {
        setCurrentStep((prev) => {
            const prevStep = stepBack(prev);
            return prevStep ?? prev;
        });
    }, []);
    // Scan components once mode/projectPath are set
    const scannedComponents = useMemo(() => scanComponents(pkgRoot, config.mode, config.projectPath), [pkgRoot, config.mode, config.projectPath]);
    // Compute labels and file count for ReviewPanel
    const componentLabels = useMemo(() => config.selectedIds
        .map((id) => COMPONENT_DEFS.find((d) => d.id === id)?.label ?? id), [config.selectedIds]);
    const totalFileCount = useMemo(() => scannedComponents
        .filter((c) => config.selectedIds.includes(c.def.id))
        .reduce((sum, c) => sum + c.fileCount, 0), [scannedComponents, config.selectedIds]);
    useInput((input, key) => {
        // executing step: ignore all input
        if (currentStep === 'executing')
            return;
        // Escape: go back or exit
        if (key.escape) {
            if (currentStep === 'mode') {
                exit();
            }
            else {
                goBack();
            }
            return;
        }
        // Enter: advance or exit
        if (key.return) {
            if (currentStep === 'complete') {
                exit();
                return;
            }
            goForward();
            return;
        }
        // Step-specific keys
        if (currentStep === 'mode') {
            if (input === 'g' || input === 'G') {
                setConfig((c) => ({ ...c, mode: 'global' }));
            }
            else if (input === 'p' || input === 'P') {
                setConfig((c) => ({ ...c, mode: 'project' }));
            }
        }
    });
    return (_jsxs(Box, { flexDirection: "column", width: "100%", height: "100%", children: [_jsx(GradientHeader, { currentStep: currentStep, version: version }), _jsxs(Box, { flexGrow: 1, flexDirection: "column", paddingX: 1, children: [currentStep === 'mode' && (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: "Installation Mode" }), _jsxs(Box, { marginTop: 1, children: [_jsxs(Text, { color: config.mode === 'global' ? C.success : C.neutral, children: [config.mode === 'global' ? SYM.checkOn : SYM.checkOff, " Global"] }), _jsx(Text, { children: "  " }), _jsxs(Text, { color: config.mode === 'project' ? C.success : C.neutral, children: [config.mode === 'project' ? SYM.checkOn : SYM.checkOff, " Project"] })] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: config.mode === 'global'
                                        ? 'Install to home directory (~/.claude/, ~/.maestro/)'
                                        : 'Install to a specific project directory' }) })] })), currentStep === 'components' && (_jsx(ComponentGrid, { components: scannedComponents, selectedIds: config.selectedIds, onSelectionChange: (ids) => setConfig((c) => ({ ...c, selectedIds: ids })), onDone: goForward })), currentStep === 'config' && (_jsx(ConfigPanel, { config: config, onConfigChange: (partial) => setConfig((c) => ({ ...c, ...partial })), onDone: goForward, onBack: goBack, existingManifest: false })), currentStep === 'review' && (_jsxs(Box, { flexDirection: "column", children: [_jsx(BlueprintPreview, { mode: config.mode, projectPath: config.projectPath, selectedIds: config.selectedIds }), _jsx(ReviewPanel, { config: config, componentLabels: componentLabels, fileCount: totalFileCount, onConfirm: goForward, onBack: goBack })] })), currentStep === 'executing' && (_jsx(ExecutionView, { components: scanComponents(pkgRoot, config.mode, config.projectPath), config: config, pkgRoot: pkgRoot, version: version, onComplete: (result) => {
                            setInstallResult(result);
                            goForward();
                        } })), currentStep === 'complete' && installResult && (_jsx(ResultDashboard, { result: installResult, onClose: () => exit() }))] }), _jsx(ShortcutFooter, { currentStep: currentStep })] }));
}
//# sourceMappingURL=CyberdeckBlueprint.js.map