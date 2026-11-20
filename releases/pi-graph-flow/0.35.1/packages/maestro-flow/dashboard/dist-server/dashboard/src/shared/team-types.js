// ---------------------------------------------------------------------------
// Team Session Types — shared between server and client
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Skill prefix → label mapping
// ---------------------------------------------------------------------------
export const SKILL_PREFIX_MAP = {
    'TC-': 'Coordinate',
    'TLV4-': 'Lifecycle',
    'QA-': 'QA',
    'RV-': 'Review',
    'TST-': 'Testing',
    'TFD-': 'Frontend Debug',
    'TPO-': 'Perf Opt',
    'TTD-': 'Tech Debt',
    'TPX-': 'Plan & Execute',
    'TBS-': 'Brainstorm',
    'TRD-': 'Roadmap Dev',
    'TIS-': 'Issue',
    'TID-': 'Iter Dev',
    'TUA-': 'Ultra Analyze',
    'TUX-': 'UX Improve',
    'TUI-': 'UI Design',
    'TAO-': 'Arch Opt',
};
export function inferSkill(sessionId) {
    for (const [prefix, label] of Object.entries(SKILL_PREFIX_MAP)) {
        if (sessionId.startsWith(prefix))
            return label;
    }
    return 'Team';
}
// ---------------------------------------------------------------------------
// Status colors for team sessions
// ---------------------------------------------------------------------------
export const TEAM_STATUS_COLORS = {
    active: '#B89540',
    paused: '#4A90D9',
    completed: '#5A9E78',
    failed: '#C46555',
    abandoned: '#8B6BBF',
    archived: '#A09D97',
};
export const PIPELINE_STATUS_COLORS = {
    done: '#5A9E78',
    in_progress: '#B89540',
    pending: '#A09D97',
    skipped: '#D1CEC8',
};
export const ROLE_STATUS_COLORS = {
    done: '#5A9E78',
    active: '#B89540',
    pending: '#A09D97',
    injected: '#8B6BBF',
};
export const AGENT_STATUS_COLORS = {
    idle: '#A09D97',
    active: '#4A90D9',
    busy: '#B89540',
    error: '#C46555',
    offline: '#6B6860',
};
//# sourceMappingURL=team-types.js.map