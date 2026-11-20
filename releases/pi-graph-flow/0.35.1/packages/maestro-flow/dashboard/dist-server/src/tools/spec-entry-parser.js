/**
 * Spec Entry Parser
 *
 * Parses `<spec-entry>` closed-tag blocks from spec markdown files.
 * Supports dual-format: new `<spec-entry>` tags + legacy heading-based entries.
 */
import { CANONICAL_KNOWLEDGE_CATEGORIES, knowhowFileToWikiId, normalizeCanonicalKnowledgeContent, } from '../utils/frontmatter.js';
export const VALID_CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'contested'];
export const VALID_STATUS = ['active', 'deprecated'];
// ============================================================================
// Valid categories (shared with spec-loader)
// ============================================================================
export const VALID_CATEGORIES = CANONICAL_KNOWLEDGE_CATEGORIES;
// ============================================================================
// Core regex
// ============================================================================
/** Matches `<spec-entry ...attributes...>...content...</spec-entry>` across lines */
const SPEC_ENTRY_RE = /<spec-entry\s+([^>]+)>([\s\S]*?)<\/spec-entry>/g;
/** Extracts key="value" attribute pairs */
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
/** Matches ### heading inside entry content */
const HEADING_RE = /^###\s+(.+)$/m;
/** Legacy format: ### [category] [date] title  OR  ### [date] type: title */
const LEGACY_HEADING_RE = /^###\s+(?:\[[\w-]+\]\s+)?\[(\d{4}-\d{2}-\d{2}(?:\s[\d:]+)?)\]\s*(.+)$/;
/** Date validation */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// ============================================================================
// Parser
// ============================================================================
/**
 * Parse spec file content into structured entries.
 * Returns new-format `<spec-entry>` entries, legacy heading entries, and any errors.
 */
export function parseSpecEntries(content) {
    const entries = [];
    const errors = [];
    // Track which character ranges are consumed by <spec-entry> blocks
    const consumed = [];
    // Pass 1: Extract <spec-entry> blocks
    let match;
    SPEC_ENTRY_RE.lastIndex = 0;
    while ((match = SPEC_ENTRY_RE.exec(content)) !== null) {
        const attrStr = match[1];
        const body = match[2];
        const blockStart = match.index;
        const blockEnd = blockStart + match[0].length;
        const lineStart = lineNumber(content, blockStart);
        const lineEnd = lineNumber(content, blockEnd);
        consumed.push({ start: blockStart, end: blockEnd });
        // Parse attributes
        const attrs = parseAttributes(attrStr);
        // Extract title: attribute > ### heading > empty
        const titleMatch = body.match(HEADING_RE);
        const title = attrs.title || (titleMatch ? titleMatch[1].trim() : '');
        // Validate and build entry
        const ref = attrs.ref || undefined;
        const confidence = attrs.confidence;
        const conflictMarker = attrs['conflict-marker'] || undefined;
        const conflictNote = attrs['conflict-note'] || undefined;
        const conflictDate = attrs['conflict-date'] || undefined;
        const normalized = normalizeCanonicalKnowledgeContent({
            title,
            content: body.trim(),
            category: attrs.category,
            specCategory: attrs.specCategory,
            keywords: attrs.keywords ? attrs.keywords.split(',') : undefined,
            tags: attrs.tags ? attrs.tags.split(',') : undefined,
            sourceRef: attrs.sourceRef ?? attrs['source-ref'],
            source: attrs.source,
            relatedPaths: (attrs.relatedPaths ?? attrs['related-paths'])?.split(','),
            codePaths: attrs.codePaths?.split(','),
            appliesToRepoIds: (attrs.appliesToRepoIds ?? attrs['applies-to-repo-ids'])?.split(','),
            lifecycleStatus: attrs.lifecycleStatus ?? attrs['lifecycle-status'],
            status: attrs.status,
        });
        const rawLifecycle = attrs.lifecycleStatus ?? attrs['lifecycle-status'];
        const lifecycleWasExplicit = rawLifecycle === 'active'
            || rawLifecycle === 'deprecated'
            || attrs.status === 'active'
            || attrs.status === 'deprecated'
            || attrs.status === 'superseded';
        const lifecycleStatus = lifecycleWasExplicit ? normalized.lifecycleStatus : undefined;
        const entry = {
            category: normalized.category ?? attrs.category ?? '',
            keywords: normalized.keywords.map(k => k.toLowerCase()),
            date: attrs.date ?? '',
            sourceRef: normalized.sourceRef ?? undefined,
            source: normalized.sourceRef ?? undefined,
            ref,
            relatedPaths: normalized.relatedPaths,
            appliesToRepoIds: normalized.appliesToRepoIds,
            description: attrs.description || undefined,
            domain: attrs.domain || undefined,
            confidence: confidence && VALID_CONFIDENCE_LEVELS.includes(confidence) ? confidence : undefined,
            conflictMarker,
            conflictNote,
            conflictDate,
            sid: attrs.sid || undefined,
            supersedes: attrs.supersedes || undefined,
            supersededBy: attrs['superseded-by'] || undefined,
            lifecycleStatus,
            status: lifecycleStatus,
            title,
            content: normalized.content.trim(),
            lineStart,
            lineEnd,
        };
        entries.push(entry);
        // Collect validation errors
        const validationErrors = [...normalized.errors, ...validateSpecEntry(entry)];
        for (const msg of validationErrors) {
            errors.push({ line: lineStart, message: msg });
        }
    }
    // Pass 2: Extract legacy entries from remaining text
    const legacy = parseLegacyEntries(content, consumed);
    return { entries, legacy, errors };
}
// ============================================================================
// Validation
// ============================================================================
/**
 * Validate a single parsed entry. Returns array of error messages (empty = valid).
 */
export function validateSpecEntry(entry) {
    const errors = [];
    if (!entry.category) {
        errors.push('Missing required attribute: category');
    }
    else if (!VALID_CATEGORIES.includes(entry.category)) {
        errors.push(`Invalid category "${entry.category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`);
    }
    if (entry.keywords.length === 0) {
        errors.push('Missing required attribute: keywords (need at least 1)');
    }
    if (!entry.date) {
        errors.push('Missing required attribute: date');
    }
    else if (!DATE_RE.test(entry.date)) {
        errors.push(`Invalid date format "${entry.date}". Expected YYYY-MM-DD`);
    }
    return errors;
}
/**
 * Validate that entry category matches the expected file category.
 */
export function validateCategoryMatch(entry, fileCategory) {
    if (entry.category && entry.category !== fileCategory) {
        return `Entry category "${entry.category}" does not match file category "${fileCategory}"`;
    }
    return null;
}
// ============================================================================
// Formatting
// ============================================================================
/**
 * Format parsed entries for display output.
 * Strips `<spec-entry>` tags, shows clean content.
 * If keyword provided, highlights matched entries.
 */
export function formatSpecEntries(entries, keyword) {
    const filtered = keyword
        ? entries.filter(e => e.keywords.includes(keyword.toLowerCase()))
        : entries;
    if (filtered.length === 0)
        return '';
    const normal = filtered.filter(e => e.confidence !== 'contested');
    const contested = filtered.filter(e => e.confidence === 'contested');
    const parts = [];
    if (normal.length > 0) {
        parts.push(normal.map(formatEntryClean).join('\n\n---\n\n'));
    }
    if (contested.length > 0) {
        parts.push(`> **${contested.length} contested entries** (pending audit review)\n\n` +
            contested.map(formatEntryClean).join('\n\n---\n\n'));
    }
    return parts.join('\n\n---\n\n');
}
/**
 * Format a single parsed entry as clean markdown with metadata line.
 *
 * Input content:  `### Title\n\nBody`
 * Output:         `### Title\n> category · kw1, kw2 · date · source\n\nBody`
 */
const CONFIDENCE_BADGES = {
    contested: '[CONTESTED]',
    low: '[LOW CONFIDENCE]',
};
function formatEntryClean(e) {
    const meta = [];
    const badge = e.confidence ? CONFIDENCE_BADGES[e.confidence] : undefined;
    if (badge)
        meta.push(badge);
    if (e.category)
        meta.push(e.category);
    if (e.keywords.length > 0)
        meta.push(e.keywords.join(', '));
    if (e.date)
        meta.push(e.date);
    if (e.source)
        meta.push(e.source);
    if (meta.length === 0 && !e.ref && !e.conflictNote)
        return e.content;
    const metaLine = meta.length > 0 ? `> ${meta.join(' \u00b7 ')}` : '';
    let conflictLine = '';
    if (e.conflictNote) {
        conflictLine = `\n> Conflict: ${e.conflictNote}`;
        if (e.conflictMarker)
            conflictLine += ` (${e.conflictMarker})`;
    }
    let refLine = '';
    if (e.ref) {
        const refId = knowhowFileToWikiId(e.ref.replace(/^knowhow\//, ''));
        refLine = `\n\u2192 Detail: maestro load --type knowhow --id ${refId}`;
    }
    const idx = e.content.indexOf('\n');
    if (idx !== -1 && e.content.trimStart().startsWith('###')) {
        return e.content.slice(0, idx) + (metaLine ? '\n' + metaLine : '') + conflictLine + refLine + e.content.slice(idx);
    }
    return (metaLine ? metaLine + '\n\n' : '') + e.content + conflictLine + refLine;
}
/**
 * Generate a stable spec-entry identity: `S-YYYYMMDD-xxxx`.
 * Mirrors the conflict-marker ID scheme. Assigned at `spec add` time so
 * supersedes/superseded-by references survive line-number drift.
 */
export function generateSid(now = new Date()) {
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).slice(2, 6);
    return `S-${date}-${rand}`;
}
/**
 * Format a single entry for writing to a spec file.
 * Writes `category=` attribute as the primary classifier.
 */
export function formatNewEntry(category, keywords, date, title, content, source, ref, description, confidence, conflictMarker, conflictNote, lifecycle) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const canonical = normalizeCanonicalKnowledgeContent({
        category,
        keywords,
        title,
        content,
        sourceRef: source,
        relatedPaths: lifecycle?.relatedPaths,
        appliesToRepoIds: lifecycle?.appliesToRepoIds,
        lifecycleStatus: lifecycle?.status,
    });
    if (!canonical.category) {
        throw new Error(`Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`);
    }
    if (canonical.errors.length > 0)
        throw new Error(canonical.errors.join('; '));
    const kwStr = canonical.keywords.map(k => k.toLowerCase()).join(',');
    const sourceRefAttr = canonical.sourceRef ? ` sourceRef="${esc(canonical.sourceRef)}"` : '';
    const refAttr = ref ? ` ref="${esc(ref)}"` : '';
    const relatedPathsAttr = canonical.relatedPaths.length > 0
        ? ` relatedPaths="${esc(canonical.relatedPaths.join(','))}"`
        : '';
    const appliesToRepoIdsAttr = canonical.appliesToRepoIds.length > 0
        ? ` appliesToRepoIds="${esc(canonical.appliesToRepoIds.join(','))}"`
        : '';
    const titleAttr = ` title="${esc(title)}"`;
    const confidenceAttr = confidence ? ` confidence="${confidence}"` : '';
    const conflictMarkerAttr = conflictMarker ? ` conflict-marker="${conflictMarker}"` : '';
    const conflictNoteAttr = conflictNote ? ` conflict-note="${conflictNote}"` : '';
    const sidAttr = lifecycle?.sid ? ` sid="${esc(lifecycle.sid)}"` : '';
    const supersedesAttr = lifecycle?.supersedes ? ` supersedes="${esc(lifecycle.supersedes)}"` : '';
    const supersededByAttr = lifecycle?.supersededBy ? ` superseded-by="${esc(lifecycle.supersededBy)}"` : '';
    const lifecycleAttr = lifecycle?.status && lifecycle.status !== 'active'
        ? ` lifecycleStatus="${lifecycle.status}"`
        : '';
    return `<spec-entry category="${canonical.category}" keywords="${kwStr}" date="${date}"${sidAttr}${titleAttr}${sourceRefAttr}${refAttr}${relatedPathsAttr}${appliesToRepoIdsAttr}${confidenceAttr}${conflictMarkerAttr}${conflictNoteAttr}${supersedesAttr}${supersededByAttr}${lifecycleAttr}>\n\n### ${title}\n\n${canonical.content}\n\n</spec-entry>`;
}
// ============================================================================
// Internal helpers
// ============================================================================
function parseAttributes(attrStr) {
    const attrs = {};
    const unescape = (value) => value
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(attrStr)) !== null) {
        attrs[m[1]] = unescape(m[2]);
    }
    return attrs;
}
function lineNumber(content, charIndex) {
    let line = 1;
    for (let i = 0; i < charIndex && i < content.length; i++) {
        if (content[i] === '\n')
            line++;
    }
    return line;
}
/**
 * Parse legacy heading-based entries from text not consumed by <spec-entry> blocks.
 */
function parseLegacyEntries(content, consumed) {
    const lines = content.split('\n');
    const legacy = [];
    // Build a set of line numbers that are inside <spec-entry> blocks
    const consumedLines = new Set();
    for (const range of consumed) {
        const startLine = lineNumber(content, range.start);
        const endLine = lineNumber(content, range.end);
        for (let i = startLine; i <= endLine; i++) {
            consumedLines.add(i);
        }
    }
    let current = null;
    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        if (consumedLines.has(lineNum))
            continue;
        const line = lines[i];
        const m = line.match(LEGACY_HEADING_RE);
        if (m) {
            if (current) {
                const body = current.bodyLines.join('\n').trim();
                if (body) {
                    legacy.push({ title: current.title, content: `### ${current.title}\n\n${body}`, lineStart: current.lineStart });
                }
            }
            current = { title: m[2].trim(), bodyLines: [], lineStart: lineNum };
        }
        else if (current) {
            current.bodyLines.push(line);
        }
    }
    if (current) {
        const body = current.bodyLines.join('\n').trim();
        if (body) {
            legacy.push({ title: current.title, content: `### ${current.title}\n\n${body}`, lineStart: current.lineStart });
        }
    }
    return legacy;
}
//# sourceMappingURL=spec-entry-parser.js.map