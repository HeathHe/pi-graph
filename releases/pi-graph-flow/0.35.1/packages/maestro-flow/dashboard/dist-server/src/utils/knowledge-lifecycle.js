/**
 * Shared lifecycle policy for Wiki-backed knowledge entries.
 *
 * Some paths consume the full WikiEntry while hot-path hooks consume the
 * persisted lightweight index. Accept both shapes so deprecated knowledge is
 * hidden consistently across search, load, and prompt injection.
 */
function normalizeStatus(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim().toLowerCase();
    return normalized === 'superseded' ? 'deprecated' : normalized;
}
export function getKnowledgeStatus(entry) {
    const direct = normalizeStatus(entry.status);
    if (direct)
        return direct;
    if (entry.ext && typeof entry.ext === 'object') {
        return normalizeStatus(entry.ext.status);
    }
    return null;
}
export function isDeprecatedKnowledgeEntry(entry) {
    return getKnowledgeStatus(entry) === 'deprecated';
}
//# sourceMappingURL=knowledge-lifecycle.js.map