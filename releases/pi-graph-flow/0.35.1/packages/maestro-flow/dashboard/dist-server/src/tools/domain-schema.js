/**
 * Domain Schema — runtime validation for glossary.yaml (or .json fallback)
 */
// ============================================================================
// Schema validation
// ============================================================================
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_DEFINITION_LENGTH = 200;
export function validateGlossary(data) {
    const errors = [];
    if (!data || typeof data !== 'object')
        return [{ path: '$', message: 'must be object' }];
    const obj = data;
    if (!Array.isArray(obj.terms))
        return [{ path: '$.terms', message: 'must be array' }];
    const seenIds = new Set();
    for (let i = 0; i < obj.terms.length; i++) {
        const term = obj.terms[i];
        const p = `$.terms[${i}]`;
        if (typeof term.id !== 'string' || !KEBAB_RE.test(term.id))
            errors.push({ path: `${p}.id`, message: 'must be kebab-case string' });
        else if (seenIds.has(term.id))
            errors.push({ path: `${p}.id`, message: `duplicate: ${term.id}` });
        else
            seenIds.add(term.id);
        if (typeof term.canonical !== 'string' || !term.canonical.length)
            errors.push({ path: `${p}.canonical`, message: 'required non-empty string' });
        if (typeof term.definition !== 'string' || !term.definition.length)
            errors.push({ path: `${p}.definition`, message: 'required non-empty string' });
        else if (term.definition.length > MAX_DEFINITION_LENGTH)
            errors.push({ path: `${p}.definition`, message: `exceeds ${MAX_DEFINITION_LENGTH} chars` });
        if (!Array.isArray(term.aliases))
            errors.push({ path: `${p}.aliases`, message: 'must be string array' });
        if (term.source != null && typeof term.source !== 'object')
            errors.push({ path: `${p}.source`, message: 'must be object if present' });
        else if (term.source != null) {
            const src = term.source;
            if (typeof src.kind !== 'string')
                errors.push({ path: `${p}.source.kind`, message: 'required string' });
        }
        if (term.tier != null && !['core', 'extended', 'peripheral'].includes(term.tier))
            errors.push({ path: `${p}.tier`, message: 'must be core|extended|peripheral' });
        if (term.status != null && !['active', 'deprecated'].includes(term.status))
            errors.push({ path: `${p}.status`, message: 'must be active|deprecated' });
    }
    // Dangling relationships are checked by validateRelationships (warnings, not errors)
    return errors;
}
// ============================================================================
// Relationship cycle detection
// ============================================================================
const MAX_CYCLE_DEPTH = 5;
export function validateRelationships(terms) {
    const warnings = [];
    const graph = new Map(terms.map(t => [t.id, t.relationships ?? []]));
    const allIds = new Set(terms.map(t => t.id));
    // Dangling relationship detection
    for (const term of terms) {
        for (const relId of term.relationships ?? []) {
            if (!allIds.has(relId)) {
                warnings.push({ termId: term.id, kind: 'dangling', message: `dangling relationship: "${relId}" does not exist` });
            }
        }
    }
    for (const term of terms) {
        const rels = graph.get(term.id) ?? [];
        // Self-loop detection
        if (rels.includes(term.id)) {
            warnings.push({
                termId: term.id,
                kind: 'cycle',
                message: `self-referencing relationship: ${term.id} → ${term.id}`,
            });
        }
        // BFS cycle detection (depth >= 2)
        const visited = new Set([term.id]);
        let frontier = rels.filter(r => r !== term.id && !visited.has(r));
        for (const r of frontier)
            visited.add(r);
        let depth = 1;
        while (frontier.length > 0 && depth < MAX_CYCLE_DEPTH) {
            const next = [];
            for (const id of frontier) {
                for (const neighbor of graph.get(id) ?? []) {
                    if (neighbor === term.id) {
                        warnings.push({
                            termId: term.id,
                            kind: 'cycle',
                            message: `cycle detected at depth ${depth + 1}: ${term.id} → ... → ${term.id}`,
                        });
                    }
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        next.push(neighbor);
                    }
                }
            }
            frontier = next;
            depth++;
        }
    }
    return warnings;
}
//# sourceMappingURL=domain-schema.js.map