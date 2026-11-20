import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { C, BORDER, SP, pad } from '../shared/index.js';
const VIEW_TABS = [
    { key: 's', mode: 'summary', label: 'summary' },
    { key: 'r', mode: 'recent', label: 'recent' },
    { key: 'k', mode: 'keywords', label: 'keywords' },
    { key: 'a', mode: 'agents', label: 'agents' },
    { key: 'h', mode: 'hooks', label: 'hooks' },
];
// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function SpecAnalyticsPanel({ workDir, onBack }) {
    const { exit } = useApp();
    const [mode, setMode] = useState('summary');
    const [entries, setEntries] = useState([]);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [cursor, setCursor] = useState(0);
    const [expandedIdx, setExpandedIdx] = useState(null);
    // Load data
    useEffect(() => {
        (async () => {
            const { readAnalytics, computeStats, getLogFileSize } = await import('../../hooks/spec-analytics.js');
            const all = readAnalytics(workDir);
            const fileSize = getLogFileSize(workDir);
            setEntries(all);
            setStats(computeStats(all, fileSize));
            setLoading(false);
        })();
    }, [workDir]);
    // Filtered entries for recent view
    const recentEntries = useMemo(() => {
        return [...entries].reverse().slice(0, 100);
    }, [entries]);
    useInput((input, key) => {
        // Mode switching
        for (const tab of VIEW_TABS) {
            if (input === tab.key && !key.ctrl) {
                setMode(tab.mode);
                setCursor(0);
                setExpandedIdx(null);
                return;
            }
        }
        if (input === 'q' || key.escape) {
            if (onBack) {
                onBack();
                return;
            }
            exit();
            return;
        }
        // Cursor navigation for list views
        if (mode === 'recent' || mode === 'keywords' || mode === 'agents' || mode === 'hooks') {
            if (key.upArrow) {
                setCursor(c => Math.max(0, c - 1));
                setExpandedIdx(null);
            }
            if (key.downArrow) {
                setCursor(c => c + 1);
                setExpandedIdx(null);
            }
            if (key.return) {
                setExpandedIdx(prev => prev === cursor ? null : cursor);
            }
        }
    });
    if (loading) {
        return (_jsx(Box, { flexDirection: "column", paddingX: 1, children: _jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(Text, { bold: true, color: C.primary, children: "SPEC ANALYTICS" }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "Loading analytics data..." })] }) }));
    }
    if (!stats || entries.length === 0) {
        return (_jsx(Box, { flexDirection: "column", paddingX: 1, children: _jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(Text, { bold: true, color: C.primary, children: "SPEC ANALYTICS" }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "No analytics data yet. Spec injection events will be recorded automatically." }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  [q] back" })] }) }));
    }
    return (_jsx(Box, { flexDirection: "column", paddingX: 1, children: _jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(Text, { bold: true, color: C.primary, children: "SPEC ANALYTICS" }), _jsx(Text, { children: " " }), _jsx(Box, { gap: 1, children: VIEW_TABS.map(tab => (_jsx(Box, { children: tab.mode === mode
                            ? _jsx(Text, { bold: true, inverse: true, color: C.primary, children: ` [${tab.key}]${tab.label} ` })
                            : _jsx(Text, { dimColor: true, children: ` [${tab.key}]${tab.label} ` }) }, tab.key))) }), _jsx(Text, { children: " " }), mode === 'summary' && _jsx(SummaryView, { stats: stats }), mode === 'recent' && _jsx(RecentView, { entries: recentEntries, cursor: cursor, expandedIdx: expandedIdx }), mode === 'keywords' && _jsx(KeywordsView, { stats: stats, cursor: cursor }), mode === 'agents' && _jsx(AgentsView, { stats: stats, cursor: cursor }), mode === 'hooks' && _jsx(HooksView, { stats: stats, cursor: cursor }), _jsx(Text, { children: " " }), _jsxs(Text, { dimColor: true, children: ["  [s/r/k/a/h] mode  [q] back", mode !== 'summary' ? '  [↑↓] navigate  [↵] expand' : ''] })] }) }));
}
// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------
function SummaryView({ stats }) {
    const hitColor = stats.hitRate >= 80 ? C.success : stats.hitRate >= 50 ? C.warning : C.error;
    const sizeKB = (stats.logFileSize / 1024).toFixed(1);
    const earliest = stats.timeRange.earliest ? stats.timeRange.earliest.slice(0, 10) : '—';
    const latest = stats.timeRange.latest ? stats.timeRange.latest.slice(0, 10) : '—';
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "Total injections:" }), _jsx(Text, { bold: true, children: stats.totalInjections })] }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "Successful:" }), _jsx(Text, { bold: true, color: C.success, children: stats.successfulInjections }), _jsxs(Text, { color: hitColor, children: ["(", stats.hitRate.toFixed(1), "%)"] })] }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "Failed:" }), _jsx(Text, { bold: true, color: C.error, children: stats.failedInjections }), _jsxs(Text, { dimColor: true, children: ["(", (100 - stats.hitRate).toFixed(1), "%)"] })] }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "By Source:" }), Object.entries(stats.bySource).map(([src, s]) => {
                const rate = s.total > 0 ? ((s.injected / s.total) * 100).toFixed(1) : '0.0';
                return (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { children: ["  ", pad(src, 28)] }), _jsx(Text, { bold: true, children: String(s.total).padStart(4) }), _jsxs(Text, { dimColor: true, children: [" (", rate, "% hit)"] })] }, src));
            }), Object.keys(stats.byBudgetAction).length > 0 && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Budget Actions:" }), _jsxs(Text, { children: ["  ", Object.entries(stats.byBudgetAction).map(([k, v]) => `${k}: ${v}`).join('  ')] })] })), Object.keys(stats.byCategory).length > 0 && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Categories:" }), _jsxs(Text, { children: ["  ", Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('  ')] })] })), stats.hookStats.totalInvocations > 0 && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsxs(Text, { bold: true, children: ["Hook Invocations: ", _jsx(Text, { color: C.primary, children: stats.hookStats.totalInvocations })] }), _jsxs(Text, { children: ["  ", Object.entries(stats.hookStats.byHook).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('  ')] })] })), Object.keys(stats.cliStats).length > 0 && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "CLI Endpoints:" }), _jsxs(Text, { children: ["  ", Object.entries(stats.cliStats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('  ')] })] })), _jsx(Text, { children: " " }), _jsxs(Text, { dimColor: true, children: ["  Log: ", sizeKB, " KB | ", stats.totalEntries, " entries | ", earliest, " ~ ", latest] })] }));
}
function RecentView({ entries, cursor, expandedIdx }) {
    const PAGE_SIZE = 20;
    const safeC = Math.min(cursor, Math.max(0, entries.length - 1));
    const pageStart = Math.max(0, safeC - Math.floor(PAGE_SIZE / 2));
    const visible = entries.slice(pageStart, pageStart + PAGE_SIZE);
    if (entries.length === 0)
        return _jsx(Text, { dimColor: true, children: "No events recorded." });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { dimColor: true, children: ["  Showing ", visible.length, " of ", entries.length, " events (newest first)"] }), _jsx(Text, { children: " " }), visible.map((entry, i) => {
                const idx = pageStart + i;
                const selected = idx === safeC;
                const expanded = idx === expandedIdx;
                const ts = entry.timestamp.slice(11, 19);
                if (entry.type === 'injection') {
                    const icon = entry.inject ? '\u2713' : '\u2717';
                    const iconColor = entry.inject ? C.success : C.error;
                    const src = entry.source.replace('spec-', '').slice(0, 18).padEnd(18);
                    const agent = (entry.agentType ?? entry.inferredCategory ?? '').slice(0, 20).padEnd(20);
                    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsxs(Text, { color: selected ? C.primary : undefined, bold: selected, children: [selected ? '\u25B6' : ' ', " ", ts, " "] }), _jsx(Text, { color: iconColor, children: icon }), _jsxs(Text, { children: [" ", src, " ", agent, " "] }), _jsxs(Text, { dimColor: true, children: [entry.specCount, " specs"] }), entry.matchedKeywords && entry.matchedKeywords.length > 0 && (_jsxs(Text, { color: C.warning, children: [" kw:[", entry.matchedKeywords.slice(0, 3).join(','), "]"] })), entry.reason && _jsxs(Text, { dimColor: true, children: [" (", entry.reason, ")"] })] }), expanded && (_jsxs(Box, { flexDirection: "column", paddingLeft: 4, children: [_jsxs(Text, { dimColor: true, children: ["  ID: ", entry.id] }), entry.promptSnippet && _jsxs(Text, { dimColor: true, children: ["  Prompt: ", entry.promptSnippet.slice(0, 100), "..."] }), entry.categories.length > 0 && _jsxs(Text, { dimColor: true, children: ["  Categories: ", entry.categories.join(', ')] }), entry.budgetAction && _jsxs(Text, { dimColor: true, children: ["  Budget: ", entry.budgetAction] }), _jsxs(Text, { dimColor: true, children: ["  Content: ", entry.contentLength, " chars"] }), entry.matchedEntryIds && _jsxs(Text, { dimColor: true, children: ["  Entries: ", entry.matchedEntryIds.join(', ')] }), entry.totalPromptKeywords != null && _jsxs(Text, { dimColor: true, children: ["  Prompt keywords: ", entry.totalPromptKeywords, "  Dedup filtered: ", entry.dedupFilteredCount ?? 0] })] }))] }, entry.id));
                }
                if (entry.type === 'cli') {
                    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsxs(Text, { color: selected ? C.primary : undefined, bold: selected, children: [selected ? '\u25B6' : ' ', " ", ts, " "] }), _jsx(Text, { color: C.primary, children: "CLI" }), _jsxs(Text, { children: [" ", entry.command.padEnd(25)] }), _jsx(Text, { dimColor: true, children: JSON.stringify(entry.args) })] }), expanded && (_jsx(Box, { paddingLeft: 4, children: _jsxs(Text, { dimColor: true, children: ["  ID: ", entry.id, "  Full args: ", JSON.stringify(entry.args, null, 2)] }) }))] }, entry.id));
                }
                if (entry.type === 'hook') {
                    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsxs(Text, { color: selected ? C.primary : undefined, bold: selected, children: [selected ? '\u25B6' : ' ', " ", ts, " "] }), _jsx(Text, { color: C.warning, children: "HOOK" }), _jsxs(Text, { children: [" ", entry.hookName.padEnd(20)] }), entry.nodeId && _jsxs(Text, { dimColor: true, children: [" node:", entry.nodeId] }), entry.outcome && _jsxs(Text, { dimColor: true, children: [" outcome:", entry.outcome] })] }), expanded && entry.data && (_jsx(Box, { paddingLeft: 4, children: _jsxs(Text, { dimColor: true, children: ["  ", JSON.stringify(entry.data)] }) }))] }, entry.id));
                }
                return null;
            })] }));
}
function KeywordsView({ stats, cursor }) {
    const kws = stats.keywordStats.topKeywords;
    if (kws.length === 0) {
        return _jsx(Text, { dimColor: true, children: "No keyword matches recorded yet." });
    }
    const maxCount = kws[0]?.count ?? 1;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "Total keyword matches:" }), _jsx(Text, { bold: true, color: C.success, children: stats.keywordStats.totalMatches })] }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "Avg matched/prompt:" }), _jsx(Text, { bold: true, children: stats.keywordStats.avgMatchedPerPrompt.toFixed(1) })] }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "Dedup filtered total:" }), _jsx(Text, { bold: true, color: C.warning, children: stats.keywordStats.dedupFilteredTotal })] }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Top Keywords (by match count):" }), _jsx(Text, { children: " " }), kws.map((kw, i) => {
                const selected = i === cursor;
                const barLen = Math.max(1, Math.round((kw.count / maxCount) * 30));
                const bar = '\u2588'.repeat(barLen);
                return (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { color: selected ? C.primary : undefined, bold: selected, children: [selected ? '\u25B6' : ' ', " ", pad(kw.keyword, 22)] }), _jsx(Text, { color: C.success, children: bar }), _jsxs(Text, { bold: true, children: [" ", kw.count] })] }, kw.keyword));
            })] }));
}
function AgentsView({ stats, cursor }) {
    const agents = Object.entries(stats.byAgentType)
        .map(([name, s]) => ({ name, ...s, rate: s.total > 0 ? (s.injected / s.total) * 100 : 0 }))
        .sort((a, b) => b.total - a.total);
    if (agents.length === 0) {
        return _jsx(Text, { dimColor: true, children: "No agent data recorded yet." });
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "Agent Type Injection Statistics:" }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 1, children: [_jsxs(Text, { dimColor: true, children: ["  ", 'Agent/Category'.padEnd(28)] }), _jsx(Text, { dimColor: true, children: 'Total'.padStart(6) }), _jsx(Text, { dimColor: true, children: 'Hit'.padStart(6) }), _jsx(Text, { dimColor: true, children: 'Miss'.padStart(6) }), _jsx(Text, { dimColor: true, children: 'Rate'.padStart(8) })] }), agents.map((a, i) => {
                const selected = i === cursor;
                const rateColor = a.rate >= 80 ? C.success : a.rate >= 50 ? C.warning : C.error;
                return (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { color: selected ? C.primary : undefined, bold: selected, children: [selected ? '\u25B6' : ' ', " ", pad(a.name, 27)] }), _jsx(Text, { children: String(a.total).padStart(6) }), _jsx(Text, { color: C.success, children: String(a.injected).padStart(6) }), _jsx(Text, { color: C.error, children: String(a.total - a.injected).padStart(6) }), _jsx(Text, { color: rateColor, children: (a.rate.toFixed(1) + '%').padStart(8) })] }, a.name));
            })] }));
}
function HooksView({ stats, cursor }) {
    const hooks = Object.entries(stats.hookStats.byHook)
        .sort((a, b) => b[1] - a[1]);
    const plugins = Object.entries(stats.hookStats.byPlugin)
        .sort((a, b) => b[1] - a[1]);
    if (hooks.length === 0) {
        return _jsx(Text, { dimColor: true, children: "No hook invocations recorded yet." });
    }
    const maxCount = hooks[0]?.[1] ?? 1;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "Total hook invocations:" }), _jsx(Text, { bold: true, color: C.primary, children: stats.hookStats.totalInvocations })] }), stats.hookStats.avgDurationMs > 0 && (_jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "Avg duration:" }), _jsxs(Text, { bold: true, children: [stats.hookStats.avgDurationMs.toFixed(1), "ms"] })] })), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "By Hook Name:" }), _jsx(Text, { children: " " }), hooks.map(([name, count], i) => {
                const selected = i === cursor;
                const barLen = Math.max(1, Math.round((count / maxCount) * 30));
                const bar = '\u2588'.repeat(barLen);
                return (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { color: selected ? C.primary : undefined, bold: selected, children: [selected ? '\u25B6' : ' ', " ", pad(name, 20)] }), _jsx(Text, { color: C.warning, children: bar }), _jsxs(Text, { bold: true, children: [" ", count] })] }, name));
            }), plugins.length > 0 && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "By Plugin:" }), plugins.map(([name, count]) => (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { children: ["  ", pad(name, 20)] }), _jsx(Text, { bold: true, children: count })] }, name)))] }))] }));
}
//# sourceMappingURL=SpecAnalyticsPanel.js.map