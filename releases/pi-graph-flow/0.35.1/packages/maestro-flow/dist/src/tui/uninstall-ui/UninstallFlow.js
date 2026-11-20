import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';
import Spinner from 'ink-spinner';
import { basename, dirname } from 'node:path';
import { C, SYM, SP, BORDER, pad, wrapCursor, SectionHeader, CursorMarker, StepProgress } from '../shared/index.js';
import { uninstallManifest } from '../../commands/install-backend.js';
import { t } from '../../i18n/index.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function executeUninstall(manifest) {
    return uninstallManifest(manifest);
}
/** Group manifest entries by parent directory for display. */
function groupEntries(entries) {
    const groups = new Map();
    for (const e of entries) {
        if (e.type !== 'file')
            continue;
        const dir = dirname(e.path);
        if (!groups.has(dir))
            groups.set(dir, []);
        groups.get(dir).push(basename(e.path));
    }
    return Array.from(groups.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dir, files]) => ({ dir, files: files.sort() }));
}
export function UninstallFlow({ manifests }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const termRows = stdout?.rows ?? 30;
    const [step, setStep] = useState(manifests.length === 1 ? 'detail' : 'select');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selected, setSelected] = useState(manifests[0]);
    const [detailScroll, setDetailScroll] = useState(0);
    const [result, setResult] = useState(null);
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState(null);
    // Grouped entries for detail view
    const grouped = useMemo(() => groupEntries(selected.entries ?? []), [selected]);
    const detailLines = useMemo(() => {
        const lines = [];
        for (const g of grouped) {
            lines.push(g.dir);
            for (const f of g.files)
                lines.push(`  ${f}`);
        }
        return lines;
    }, [grouped]);
    const maxScroll = Math.max(0, detailLines.length - (termRows - 14));
    // Timer
    useEffect(() => {
        if (step !== 'executing')
            return;
        const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
        return () => clearInterval(timer);
    }, [step]);
    // Execute
    useEffect(() => {
        if (step !== 'executing')
            return;
        let cancelled = false;
        const timeout = setTimeout(() => {
            if (cancelled)
                return;
            try {
                const r = executeUninstall(selected);
                if (!cancelled) {
                    setResult(r);
                    setStep('complete');
                }
            }
            catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                    setStep('complete');
                }
            }
        }, 50);
        return () => { cancelled = true; clearTimeout(timeout); };
    }, [step, selected]);
    useInput((input, key) => {
        if (step === 'executing')
            return;
        if (key.escape) {
            if (step === 'detail') {
                if (manifests.length > 1) {
                    setStep('select');
                    setDetailScroll(0);
                }
                else
                    exit();
            }
            else if (step === 'confirm') {
                setStep('detail');
            }
            else {
                exit();
            }
            return;
        }
        if (step === 'select') {
            if (key.upArrow)
                setSelectedIndex((i) => wrapCursor(i, -1, manifests.length));
            else if (key.downArrow)
                setSelectedIndex((i) => wrapCursor(i, 1, manifests.length));
            else if (key.return) {
                setSelected(manifests[selectedIndex]);
                setDetailScroll(0);
                setStep('detail');
            }
        }
        else if (step === 'detail') {
            if (key.upArrow)
                setDetailScroll((s) => Math.max(0, s - 1));
            else if (key.downArrow)
                setDetailScroll((s) => Math.min(maxScroll, s + 1));
            else if (key.return)
                setStep('confirm');
        }
        else if (step === 'confirm') {
            if (key.return)
                setStep('executing');
        }
        else if (step === 'complete') {
            if (key.return)
                exit();
        }
    });
    // Progress
    const progressSteps = [
        ...(manifests.length > 1 ? [{ key: 'select', label: t.uninstall.stepSelect }] : []),
        { key: 'detail', label: t.uninstall.stepDetail },
        { key: 'confirm', label: t.uninstall.stepConfirm },
        { key: 'executing', label: t.uninstall.stepUninstall },
        { key: 'complete', label: t.uninstall.stepDone },
    ];
    const stepIndex = progressSteps.findIndex((s) => s.key === step);
    const safeEntries = selected.entries ?? [];
    const fileCount = safeEntries.filter((e) => e.type === 'file').length;
    const dirCount = safeEntries.filter((e) => e.type === 'dir').length;
    const visibleLines = Math.max(1, termRows - 14);
    const timeStr = elapsed >= 60
        ? `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toString().padStart(2, '0')}s`
        : `${elapsed}s`;
    return (_jsxs(Box, { flexDirection: "column", width: "100%", children: [_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Gradient, { name: "retro", children: _jsx(BigText, { text: "MAESTRO", font: "slick" }) }), _jsx(Box, { marginTop: -2, children: _jsx(Text, { dimColor: true, children: _jsx(BigText, { text: "flow", font: "slick" }) }) }), _jsx(Box, { marginLeft: 2, children: _jsx(Text, { dimColor: true, children: "uninstall" }) })] }), _jsx(StepProgress, { steps: progressSteps, currentKey: step })] }), _jsxs(Box, { flexGrow: 1, flexDirection: "column", paddingX: 1, marginTop: 1, children: [step === 'select' && (_jsxs(Box, { flexDirection: "column", children: [_jsx(SectionHeader, { title: t.uninstall.selectTitle }), _jsx(Box, { flexDirection: "column", marginTop: SP.sectionGap, children: manifests.map((m, i) => {
                                    const hl = i === selectedIndex;
                                    const date = m.installedAt.split('T')[0];
                                    const files = (m.entries ?? []).filter((e) => e.type === 'file').length;
                                    return (_jsxs(Box, { children: [_jsx(CursorMarker, { active: hl }), _jsxs(Text, { color: hl ? C.primary : undefined, bold: hl, children: ["[", m.scope, "]"] }), _jsxs(Text, { children: [" ", m.targetPath, " "] }), _jsxs(Text, { dimColor: true, children: ["(", t.uninstall.selectFileDate
                                                        .replace('{files}', String(files))
                                                        .replace('{date}', date), ")"] })] }, m.id));
                                }) })] })), step === 'detail' && (_jsxs(Box, { flexDirection: "column", children: [_jsx(SectionHeader, { title: t.uninstall.detailTitle }), _jsxs(Box, { flexDirection: "column", ...BORDER.detail, paddingX: SP.detailPadX, marginTop: SP.sectionGap, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, children: pad(t.uninstall.detailScope, SP.labelWidth) }), _jsx(Text, { children: selected.scope })] }), _jsxs(Box, { children: [_jsx(Text, { bold: true, children: pad(t.uninstall.detailTarget, SP.labelWidth) }), _jsx(Text, { children: selected.targetPath })] }), _jsxs(Box, { children: [_jsx(Text, { bold: true, children: pad(t.uninstall.detailFiles, SP.labelWidth) }), _jsx(Text, { children: t.uninstall.detailFiles
                                                    .replace('{files}', String(fileCount))
                                                    .replace('{dirs}', String(dirCount))
                                                    .replace(/^.{12}/, '') })] }), _jsxs(Box, { children: [_jsx(Text, { bold: true, children: pad(t.uninstall.detailInstalled, SP.labelWidth) }), _jsx(Text, { children: selected.installedAt.split('T')[0] })] })] }), _jsxs(Text, { bold: true, color: "cyan", dimColor: true, children: ['\n', t.uninstall.detailFilesRange
                                        .replace('{from}', String(detailScroll + 1))
                                        .replace('{to}', String(Math.min(detailScroll + visibleLines, detailLines.length)))
                                        .replace('{total}', String(detailLines.length))] }), _jsx(Box, { flexDirection: "column", children: detailLines.slice(detailScroll, detailScroll + visibleLines).map((line, i) => {
                                    const isDir = !line.startsWith('  ');
                                    return (_jsx(Text, { color: isDir ? 'yellow' : undefined, dimColor: !isDir, children: line }, detailScroll + i));
                                }) }), maxScroll > 0 && (_jsxs(Text, { dimColor: true, children: [detailScroll > 0 ? SYM.scrollUp : ' ', " ", t.uninstall.detailScroll, " ", detailScroll < maxScroll ? SYM.scrollDown : ' '] }))] })), step === 'confirm' && (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.warning, children: t.uninstall.confirmTitle }), _jsxs(Box, { flexDirection: "column", ...BORDER.warning, paddingX: SP.detailPadX, marginTop: SP.sectionGap, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, children: pad(t.uninstall.confirmScope, SP.labelWidth) }), _jsx(Text, { children: selected.scope })] }), _jsxs(Box, { children: [_jsx(Text, { bold: true, children: pad(t.uninstall.confirmTarget, SP.labelWidth) }), _jsx(Text, { children: selected.targetPath })] }), _jsxs(Box, { children: [_jsx(Text, { bold: true, children: pad(t.uninstall.confirmRemove, SP.labelWidth) }), _jsxs(Text, { color: C.error, children: [fileCount, " files, ", dirCount, " dirs"] })] }), _jsxs(Box, { children: [_jsx(Text, { bold: true, children: pad(t.uninstall.confirmCleanup, SP.labelWidth) }), _jsx(Text, { children: "MCP config + hooks + overlays" })] })] }), _jsx(Box, { marginTop: SP.sectionGap, children: _jsx(Text, { color: C.warning, children: t.uninstall.confirmCannotUndo }) })] })), step === 'executing' && !error && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { color: C.primary, children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" ", t.uninstall.executingText] })] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: t.uninstall.executingElapsed.replace('{time}', timeStr) }) })] })), error && (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: "red", bold: true, children: t.uninstall.execFailed }), _jsx(Text, { color: "red", children: error })] })), step === 'complete' && result && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { flexDirection: "column", ...BORDER.success, paddingX: SP.detailPadX, children: [_jsx(Text, { bold: true, color: C.success, children: t.uninstall.resultTitle }), _jsxs(Box, { children: [_jsx(Text, { color: C.primary, children: pad('Removed:', SP.labelWidth) }), _jsx(Text, { color: C.success, children: t.uninstall.resultRemoved.replace('{count}', String(result.filesRemoved)) })] }), result.filesSkipped > 0 && (_jsxs(Box, { children: [_jsx(Text, { color: C.primary, children: pad('Preserved:', SP.labelWidth) }), _jsx(Text, { children: t.uninstall.resultPreserved.replace('{count}', String(result.filesSkipped)) })] })), (result.claudeHooksRemoved + result.codexHooksRemoved + result.agyHooksRemoved) > 0 && (_jsxs(Box, { children: [_jsx(Text, { color: C.primary, children: pad('Hooks:', SP.labelWidth) }), _jsx(Text, { color: C.success, children: [
                                                    result.claudeHooksRemoved && `${result.claudeHooksRemoved} claude`,
                                                    result.codexHooksRemoved && `${result.codexHooksRemoved} codex`,
                                                    result.agyHooksRemoved && `${result.agyHooksRemoved} agy`,
                                                ].filter(Boolean).join(', ') })] })), _jsxs(Box, { children: [_jsx(Text, { color: C.primary, children: pad('Statusline:', SP.labelWidth) }), _jsx(Text, { color: result.statuslineRemoved ? C.success : C.neutral, children: result.statuslineRemoved ? 'removed' : 'not installed' })] }), _jsxs(Box, { children: [_jsx(Text, { color: C.primary, children: pad('MCP:', SP.labelWidth) }), _jsx(Text, { color: (result.mcpRemoved.claude || result.mcpRemoved.codex || result.mcpRemoved.extras.length > 0) ? C.success : C.neutral, children: [
                                                    result.mcpRemoved.claude && 'claude',
                                                    result.mcpRemoved.codex && 'codex',
                                                    result.mcpRemoved.extras.length > 0 && result.mcpRemoved.extras.join('+'),
                                                ].filter(Boolean).join(', ') || t.uninstall.resultMcpNotFound })] })] }), _jsx(Box, { marginTop: SP.sectionGap, children: _jsx(Text, { dimColor: true, children: t.uninstall.resultRestart }) })] }))] }), _jsx(Box, { paddingX: 1, children: _jsxs(Text, { dimColor: true, children: [step === 'select' && t.uninstall.footerSelect, step === 'detail' && t.uninstall.footerDetail, step === 'confirm' && t.uninstall.footerConfirm, step === 'executing' && t.uninstall.footerExecuting, step === 'complete' && t.uninstall.footerComplete] }) })] }));
}
//# sourceMappingURL=UninstallFlow.js.map