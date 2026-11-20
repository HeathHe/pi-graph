/**
 * Skill Context Hook — UserPromptSubmit
 *
 * When a user invokes a workflow skill (e.g., `/maestro-ralph` or `/maestro-next`),
 * injects the current canonical Session and sealed Run artifacts.
 *
 * Uses `additionalContext` (not `updatedInput`) to avoid interfering
 * with skill expansion.
 *
 * Formal artifacts are read only from each canonical Session `artifacts.json`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveWorkspace } from './workspace.js';
const KNOWLEDGE_POLICY = 'Knowledge policy: search/injection=exposure-only | explicit-load=consumed | '
    + 'record=explicit-attribution | completion=stage-candidates | promotion=explicit-review';
// ---------------------------------------------------------------------------
// Skill invocation patterns
// ---------------------------------------------------------------------------
const SKILL_PATTERNS = [
    { pattern: /\/maestro-ralph(?:\s|$)/, skill: 'maestro-ralph' },
    { pattern: /\/maestro-next(?:\s|$)/, skill: 'maestro-next' },
    { pattern: /\/maestro-session-seal(?:\s|$)/, skill: 'maestro-session-seal' },
    { pattern: /\/maestro(?:\s|$)/, skill: 'maestro' },
];
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Parse a user prompt for workflow skill invocation.
 * Returns null if no skill pattern is matched.
 */
export function parseSkillInvocation(prompt) {
    for (const { pattern, skill } of SKILL_PATTERNS) {
        const match = prompt.match(pattern);
        if (match) {
            const phaseNum = match[1] ? parseInt(match[1], 10) : undefined;
            return { skill, phaseNum, raw: match[0] };
        }
    }
    return null;
}
/**
 * Parse any /command-name invocation from user prompt (generalized).
 * Used for skill config parameter injection — works with all commands,
 * not just workflow-specific ones.
 */
export function parseAnySkillInvocation(prompt) {
    const match = prompt.match(/\/([a-z][\w-]*)/);
    return match ? match[1] : null;
}
/**
 * Load skill-config.json with workspace override (inline to keep hooks self-contained).
 */
function loadSkillConfigInline(workDir) {
    const globalPath = join(homedir(), '.maestro', 'skill-config.json');
    let global = null;
    try {
        if (existsSync(globalPath)) {
            global = JSON.parse(readFileSync(globalPath, 'utf8'));
        }
    }
    catch { /* */ }
    let workspace = null;
    if (workDir) {
        const wsPath = join(workDir, '.maestro', 'skill-config.json');
        try {
            if (existsSync(wsPath)) {
                workspace = JSON.parse(readFileSync(wsPath, 'utf8'));
            }
        }
        catch { /* */ }
    }
    if (!global && !workspace)
        return null;
    if (!workspace)
        return global;
    if (!global)
        return workspace;
    // Merge: workspace params override global params per-skill
    const merged = {
        version: workspace.version ?? global.version,
        skills: { ...global.skills },
    };
    for (const [skill, defaults] of Object.entries(workspace.skills)) {
        const existing = merged.skills[skill];
        merged.skills[skill] = existing
            ? { params: { ...existing.params, ...defaults.params }, updated: defaults.updated ?? existing.updated }
            : defaults;
    }
    return merged;
}
/**
 * Build additionalContext section for skill config parameter injection.
 * Only includes params the user hasn't explicitly specified in their prompt.
 */
function buildParamInjectionSection(skillName, userPrompt, workDir) {
    const config = loadSkillConfigInline(workDir);
    if (!config)
        return null;
    const defaults = config.skills[skillName];
    if (!defaults || Object.keys(defaults.params).length === 0)
        return null;
    const lines = [];
    for (const [param, value] of Object.entries(defaults.params)) {
        // Check if user already specified this param in the prompt
        if (userPrompt.includes(param)) {
            continue; // User explicitly set — skip injection
        }
        lines.push(`${param}: ${value}`);
    }
    if (lines.length === 0)
        return null;
    return [
        `## Skill Config Defaults (${skillName})`,
        'The following parameter defaults are configured. Apply these unless the user explicitly specified otherwise:',
        ...lines,
    ].join('\n');
}
/**
 * Evaluate skill context and return workflow state + artifact tree + param defaults.
 * Returns null if no skill invocation detected.
 *
 * Two independent concern layers:
 * 1. Workflow context (state, artifacts, outcomes) — uses canonical Sessions
 * 2. Skill config param injection — works for ANY /command, no workflow required
 */
export async function evaluateSkillContext(data) {
    const prompt = data.user_prompt ?? '';
    if (!prompt)
        return null;
    const sections = [];
    const cwd = resolveWorkspace(data);
    // --- Layer 1: Canonical Session/Run context ---
    const skill = parseSkillInvocation(prompt)
        ?? (/^(继续|继续执行|continue|resume)[。.!！]?\s*$/i.test(prompt.trim())
            ? { skill: 'maestro', raw: prompt.trim() }
            : null);
    if (skill && cwd) {
        const statePath = join(cwd, '.workflow', 'state.json');
        const sessionsPath = join(cwd, '.workflow', 'sessions');
        if (existsSync(statePath) || existsSync(sessionsPath)) {
            let state = {};
            if (existsSync(statePath)) {
                try {
                    state = JSON.parse(readFileSync(statePath, 'utf8'));
                }
                catch {
                    // A canonical v3 Session can still be selected without state.json.
                }
            }
            try {
                const sessionSection = await buildCanonicalSessionSection(cwd, state, skill);
                if (sessionSection)
                    sections.push(sessionSection);
            }
            catch {
                // Canonical Session context is best-effort for prompt injection.
            }
        }
    }
    // --- Layer 2: Skill config parameter injection (works for all commands) ---
    const anySkill = skill?.skill ?? parseAnySkillInvocation(prompt);
    if (anySkill) {
        const paramSection = buildParamInjectionSection(anySkill, prompt, cwd ?? data.cwd ?? null);
        if (paramSection)
            sections.push(paramSection);
    }
    if (sections.length === 0)
        return null;
    return {
        hookSpecificOutput: {
            hookEventName: data.hook_event_name || 'UserPromptSubmit',
            additionalContext: sections.join('\n\n'),
        },
    };
}
/**
 * The `run/*` modules are imported lazily: their chain costs ~100ms to load,
 * which on a UserPromptSubmit hook was paid for every prompt even though only
 * `/command` invocations against a live Session ever reach them.
 */
async function buildCanonicalSessionSection(cwd, state, skill) {
    const { SessionStore } = await import('../run/store.js');
    const store = new SessionStore(cwd);
    const { resolveSessionContextFromStore } = await import('../run/v3/resolve-context-store.js');
    const v3Resolution = resolveSessionContextFromStore(store);
    if (v3Resolution.ok) {
        const record = store.readSessionRecordReadOnly(v3Resolution.session_id);
        const { sessionStateV30ReadSchema } = await import('../run/schemas.js');
        const parsed = sessionStateV30ReadSchema.safeParse(record);
        if (parsed.success)
            return buildV30SessionSection(cwd, parsed.data, skill);
    }
    let sessionId = state.active_session_id;
    if (sessionId) {
        try {
            // A v3 binding that failed resolution must stay fail-closed; legacy
            // rendering remains tolerant of pre-schema canonical Session fixtures.
            const raw = JSON.parse(readFileSync(join(cwd, '.workflow', 'sessions', sessionId, 'session.json'), 'utf8'));
            if (raw.schema_version === 'session/3.0')
                return null;
        }
        catch {
            return null;
        }
    }
    else {
        if (!v3Resolution.ok && v3Resolution.error.code !== 'SESSION_CONTEXT_UNRESOLVED')
            return null;
        const candidates = store
            .listSessionsReadOnly({ statuses: ['running', 'paused'] })
            .candidates;
        if (candidates.length === 1)
            sessionId = candidates[0].sessionId;
    }
    if (!sessionId)
        return null;
    return buildLegacySessionSection(cwd, sessionId, skill);
}
async function buildV30SessionSection(cwd, session, skill) {
    const status = session.status === 'paused' ? 'open' : session.status;
    const activeRunIds = [...new Set(session.active_run_ids)].sort();
    const lines = [
        `## Session Context for ${skill.skill}`,
        `Session: ${session.session_id} | ${status} | ${session.objective}`,
        `Active Runs: ${activeRunIds.length > 0 ? activeRunIds.join(', ') : '-'}`,
        KNOWLEDGE_POLICY,
    ];
    try {
        const { artifactRegistrySchema } = await import('../run/schemas.js');
        const registry = artifactRegistrySchema.parse(JSON.parse(readFileSync(join(cwd, '.workflow', 'sessions', session.session_id, session.artifacts_ref), 'utf8')));
        appendArtifactAliases(lines, registry);
    }
    catch {
        // A partial v3 Session still contributes its canonical objective and Runs.
    }
    await appendKnowledgeBacklog(lines, cwd, session.session_id);
    return lines.join('\n');
}
async function buildLegacySessionSection(cwd, sessionId, skill) {
    const sessionDir = join(cwd, '.workflow', 'sessions', sessionId);
    try {
        const session = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
        const registry = JSON.parse(readFileSync(join(sessionDir, 'artifacts.json'), 'utf8'));
        const lines = [
            `## Session Context for ${skill.skill}`,
            `Session: ${sessionId} | ${session.status ?? 'unknown'} | ${session.intent ?? ''}`,
            `Run: ${session.active_run_id ?? session.latest_completed_run_id ?? '-'}`,
            KNOWLEDGE_POLICY,
        ];
        appendArtifactAliases(lines, registry);
        await appendKnowledgeBacklog(lines, cwd, sessionId);
        try {
            const { inspectSessionContinuation, renderContinuationCard } = await import('../run/continuation.js');
            lines.push('', renderContinuationCard(inspectSessionContinuation(cwd, sessionId)));
        }
        catch {
            // Legacy or partially initialized Session: keep the basic context only.
        }
        return lines.join('\n');
    }
    catch {
        return null;
    }
}
function appendArtifactAliases(lines, registry) {
    const aliases = Object.entries(registry.aliases ?? {});
    if (aliases.length === 0)
        return;
    lines.push('Artifacts:');
    for (const [alias, id] of aliases.slice(0, 12)) {
        const artifact = registry.artifacts?.[id];
        if (!artifact)
            continue;
        lines.push(`- ${alias} → ${id} | ${artifact.kind ?? 'artifact'} | ${artifact.status ?? 'unknown'} | ${artifact.relative_path ?? ''}`);
    }
}
async function appendKnowledgeBacklog(lines, cwd, sessionId) {
    try {
        const { summarizeSessionKnowledge } = await import('../run/knowledge.js');
        const knowledge = summarizeSessionKnowledge(cwd, sessionId, { readOnly: true });
        const pending = knowledge.candidates.filter(candidate => candidate.status === 'pending');
        const promoting = knowledge.candidates.filter(candidate => candidate.status === 'promoting');
        lines.push(`Knowledge backlog: ${pending.length} pending | `
            + `${pending.filter(candidate => candidate.stage === 'corroborated').length} corroborated | `
            + `${promoting.length} promoting | review: maestro knowledge review ${sessionId}`);
    }
    catch {
        // Partial Sessions still expose their canonical identity and knowledge policy.
    }
}
//# sourceMappingURL=skill-context.js.map