import { isRepositoryApplicable } from '../repository/applicability.js';
import { isDeprecatedKnowledgeEntry } from '../utils/knowledge-lifecycle.js';
export const LOAD_SELECTION_TYPES = [
    'spec', 'knowhow', 'note', 'domain', 'issue', 'project', 'roadmap',
    'session', 'scratch',
];
function matchesType(entry, type) {
    if (type === 'session')
        return entry.category === 'session';
    if (type === 'scratch')
        return entry.category === 'scratch';
    return entry.type === type;
}
function matchesRepository(entry, selection) {
    if (!isRepositoryApplicable(entry, selection.applicableRepoId))
        return false;
    if (!selection.originExplicit)
        return true;
    if (selection.targetRepoId)
        return (entry.repoId ?? entry.source.repoId) === selection.targetRepoId;
    return (entry.alias ?? entry.source.alias) === selection.targetAlias;
}
function findEntry(entries, rawId, selection) {
    const exact = entries.find(entry => entry.id === rawId);
    if (exact && matchesRepository(exact, selection))
        return exact;
    const lower = rawId.toLowerCase();
    const candidates = [lower];
    if (selection.type !== 'session' && selection.type !== 'scratch' && !lower.startsWith(`${selection.type}-`)) {
        candidates.push(`${selection.type}-${lower}`);
    }
    for (const candidate of candidates) {
        const match = entries.find(entry => entry.id.toLowerCase() === candidate && matchesRepository(entry, selection));
        if (match)
            return match;
    }
    if (selection.originExplicit) {
        return entries.find(entry => matchesType(entry, selection.type)
            && matchesRepository(entry, selection)
            && (entry.id.toLowerCase() === lower || entry.id.toLowerCase().endsWith(`:${lower}`))) ?? null;
    }
    return null;
}
function metadataEntry(entry) {
    const { body: _body, related: _related, ext: _ext, ...metadata } = entry;
    return metadata;
}
/** Apply the exact load ordering/filtering before response serialization. */
export function applyDaemonLoadSelection(source, selection) {
    let entries;
    if (selection.ids && selection.ids.length > 0) {
        entries = selection.ids
            .map(id => findEntry(source, id, selection))
            .filter((entry) => entry !== null
            && (selection.includeDeprecated || !isDeprecatedKnowledgeEntry(entry))
            && matchesRepository(entry, selection));
    }
    else {
        entries = source.filter(entry => matchesType(entry, selection.type)
            && (selection.includeDeprecated || !isDeprecatedKnowledgeEntry(entry))
            && matchesRepository(entry, selection));
        if (selection.category)
            entries = entries.filter(entry => entry.category === selection.category);
        if (selection.keyword) {
            const keyword = selection.keyword.toLowerCase();
            entries = entries.filter(entry => entry.title.toLowerCase().includes(keyword)
                || entry.body.toLowerCase().includes(keyword));
        }
        if (selection.tag) {
            const tag = selection.tag.toLowerCase();
            entries = entries.filter(entry => entry.tags.includes(tag));
        }
        if (selection.type === 'session' || selection.type === 'scratch') {
            entries.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
        }
        else {
            entries.sort((a, b) => {
                const aStub = !a.body;
                const bStub = !b.body;
                if (aStub !== bStub)
                    return aStub ? 1 : -1;
                return a.title.localeCompare(b.title);
            });
        }
        entries = entries.slice(0, selection.limit);
    }
    return selection.projection === 'metadata' ? entries.map(metadataEntry) : entries;
}
//# sourceMappingURL=load-selection.js.map