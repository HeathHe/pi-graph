import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { C, SYM } from '../shared/index.js';
import { executeInstallPipeline, CancelledError } from '../../core/install-executor.js';
import { GENERIC_HOOKS_PLATFORMS } from '../../commands/hooks.js';
import { t } from '../../i18n/index.js';
function StepRow({ step }) {
    const icon = step.status === 'done' ? SYM.checkOn
        : step.status === 'error' ? '✗'
            : step.status === 'active' ? ''
                : SYM.checkOff;
    const color = step.status === 'done' ? C.success
        : step.status === 'error' ? C.error
            : step.status === 'active' ? C.primary
                : C.neutral;
    return (_jsxs(Box, { children: [step.status === 'active' ? (_jsx(Text, { color: C.primary, children: _jsx(Spinner, { type: "dots" }) })) : (_jsx(Text, { color: color, children: icon })), _jsxs(Text, { color: color, children: [" ", step.label.padEnd(16)] }), _jsx(Text, { color: C.neutral, children: step.detail })] }));
}
function getStepLabels() {
    return {
        backup: t.install.hubLabelBackup,
        cleanup: t.install.execCleaning.replace('...', ''),
        components: t.install.hubLabelComponents,
        hooks: 'Claude Hooks',
        statusline: t.install.hubLabelStatusline,
        mcp: 'Claude MCP',
        codexHooks: 'Codex Hooks',
        codexMcp: 'Codex MCP',
        agyHooks: 'Agy Hooks',
        extraMcp: 'Extra MCP',
        manifest: 'Manifest',
    };
}
export function InstallExecution({ config, pkgRoot, version, onComplete }) {
    const stepKeys = useMemo(() => {
        const keys = [];
        if (config.backupClaudeMd || config.backupAll)
            keys.push('backup');
        keys.push('cleanup');
        if (config.installComponents)
            keys.push('components');
        if (config.installHooks)
            keys.push('hooks');
        if (config.installStatusline)
            keys.push('statusline');
        if (config.installMcp)
            keys.push('mcp');
        if (config.installCodexHooks)
            keys.push('codexHooks');
        if (config.installCodexMcp)
            keys.push('codexMcp');
        if (config.installAgyHooks)
            keys.push('agyHooks');
        for (const [platId, level] of Object.entries(config.genericHookLevels)) {
            if (level !== 'none')
                keys.push(`ghooks-${platId}`);
        }
        if (config.installExtraMcp)
            keys.push('extraMcp');
        keys.push('manifest');
        return keys;
    }, [config]);
    const stepLabels = useMemo(() => {
        const labels = getStepLabels();
        for (const gp of GENERIC_HOOKS_PLATFORMS) {
            labels[`ghooks-${gp.id}`] = `${gp.label} Hooks`;
        }
        return labels;
    }, []);
    const [steps, setSteps] = useState(() => stepKeys.map((key) => ({
        key,
        label: stepLabels[key] ?? key,
        status: 'pending',
        detail: '',
    })));
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState(null);
    const cancelledRef = useRef(false);
    const ranRef = useRef(false);
    useEffect(() => {
        const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
        return () => clearInterval(timer);
    }, []);
    useEffect(() => {
        if (ranRef.current)
            return;
        ranRef.current = true;
        const updateStep = (step, status, detail) => {
            setSteps((prev) => prev.map((s) => s.key === step ? { ...s, status, detail } : s));
        };
        executeInstallPipeline({
            config, pkgRoot, version,
            onProgress: updateStep,
            isCancelled: () => cancelledRef.current,
        }).then((result) => {
            onComplete(result);
        }).catch((err) => {
            if (err instanceof CancelledError)
                return;
            setError(err instanceof Error ? err.message : String(err));
        });
        return () => { cancelledRef.current = true; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    // Weighted progress: components step gets weight proportional to component count
    const componentWeight = config.installComponents ? Math.max(config.selectedComponentIds.length, 1) : 1;
    const percent = (() => {
        let totalW = 0, doneW = 0;
        for (const step of steps) {
            const w = step.key === 'components' ? componentWeight : 1;
            totalW += w;
            if (step.status === 'done') {
                doneW += w;
            }
            else if (step.status === 'active') {
                const m = step.detail.match(/\[(\d+)\/(\d+)\]/);
                if (m)
                    doneW += ((parseInt(m[1], 10) - 1) / parseInt(m[2], 10)) * w;
            }
        }
        return totalW > 0 ? Math.round((doneW / totalW) * 100) : 0;
    })();
    const timeStr = elapsed >= 60
        ? `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toString().padStart(2, '0')}s`
        : `${elapsed}s`;
    if (error) {
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { color: C.error, bold: true, children: t.install.execFailed }), _jsx(Text, { color: C.error, children: error })] }));
    }
    const barWidth = 30;
    const filled = Math.round(barWidth * percent / 100);
    const remaining = barWidth - filled;
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Box, { gap: 2, children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.execTitle }), _jsx(Text, { dimColor: true, children: timeStr }), _jsxs(Text, { bold: true, color: percent === 100 ? C.success : C.primary, children: [percent, "%"] })] }), _jsxs(Box, { marginTop: 1, children: [_jsx(Text, { color: C.success, children: '█'.repeat(filled) }), _jsx(Text, { color: C.neutral, children: '░'.repeat(remaining) })] }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: steps.map((step) => (_jsx(StepRow, { step: step }, step.key))) })] }));
}
//# sourceMappingURL=InstallExecution.js.map