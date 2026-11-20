/**
 * Domain Matcher — CJK-aware term matching for domain glossary injection
 */
// ============================================================================
// CJK detection
// ============================================================================
const CJK_RANGE = /[一-鿿぀-ゟ゠-ヿ가-힯]/;
function isCJK(char) {
    return CJK_RANGE.test(char);
}
// ============================================================================
// Core matching
// ============================================================================
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function matchAlias(prompt, alias) {
    if (!alias || alias.length === 0)
        return false;
    if (CJK_RANGE.test(alias)) {
        // CJK has no word boundaries. Use length-based protection:
        // - Reject single-char aliases (too generic)
        // - ≥3 char aliases: direct includes() (specific enough)
        // - 2 char aliases: includes() is acceptable — domain terms are proper
        //   nouns and false positives are rare/benign (extra context injected)
        if (alias.length < 2)
            return false;
        return prompt.includes(alias);
    }
    const re = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i');
    return re.test(prompt);
}
// ============================================================================
// Batch matching with relationship propagation
// ============================================================================
export function matchDomainTerms(prompt, terms) {
    const directMatches = [];
    const matchedIds = new Set();
    for (const term of terms) {
        if ((term.status ?? 'active') !== 'active' && (term.status ?? 'active') !== 'deprecated')
            continue;
        let matched = false;
        let matchedBy = 'canonical';
        let matchedToken = '';
        // 1. canonical match (case-insensitive)
        if (matchAlias(prompt, term.canonical)) {
            matched = true;
            matchedBy = 'canonical';
            matchedToken = term.canonical;
        }
        // 2. alias match
        if (!matched) {
            for (const alias of term.aliases) {
                if (matchAlias(prompt, alias)) {
                    matched = true;
                    matchedBy = 'alias';
                    matchedToken = alias;
                    break;
                }
            }
        }
        // 3. keyword match (fuzzy — same logic but lower priority)
        if (!matched) {
            for (const kw of term.keywords ?? []) {
                if (matchAlias(prompt, kw)) {
                    matched = true;
                    matchedBy = 'keyword';
                    matchedToken = kw;
                    break;
                }
            }
        }
        if (matched) {
            matchedIds.add(term.id);
            directMatches.push({
                termId: term.id,
                canonical: term.canonical,
                definition: term.definition,
                matchedBy,
                matchedToken,
            });
        }
    }
    // 1-level relationship propagation (visited set prevents duplicates)
    const propagatedIds = [];
    const visited = new Set(matchedIds);
    for (const match of directMatches) {
        const term = terms.find(t => t.id === match.termId);
        if (!term)
            continue;
        for (const relId of term.relationships ?? []) {
            if (!visited.has(relId)) {
                visited.add(relId);
                propagatedIds.push(relId);
            }
        }
    }
    return { directMatches, propagatedIds };
}
// ============================================================================
// Rewrite hints extraction
// ============================================================================
export function collectRewriteHints(matchedTermIds, terms) {
    const hints = Object.create(null);
    for (const id of matchedTermIds) {
        const term = terms.find(t => t.id === id);
        if (!term?.rewrite_hints)
            continue;
        for (const [k, v] of Object.entries(term.rewrite_hints)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype')
                continue;
            hints[k] = v;
        }
    }
    return hints;
}
//# sourceMappingURL=domain-matcher.js.map