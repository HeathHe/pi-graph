// src/graph/kg/resolution/name-matcher.ts
// 6 级名称匹配策略链 — 从 CodeGraph 复用
// 参考: plan-maestrograph.md Gap 修补 8 + codegraph/src/resolution/name-matcher.ts
// ---------------------------------------------------------------------------
// 6 级匹配策略链 (按优先级)
// ---------------------------------------------------------------------------
/**
 * 名称匹配入口 — 按优先级依次尝试 6 种策略
 * 返回最匹配的结果, 或 null (无匹配)
 */
export function matchReference(referenceName, candidates, context) {
    if (candidates.length === 0)
        return null;
    // Strategy 1: 精确名称匹配
    const exact = candidates.filter(c => c.name === referenceName);
    if (exact.length === 1) {
        return { qualifiedName: exact[0].qualifiedName, confidence: 1.0, strategy: 'exact-name', filePath: exact[0].filePath };
    }
    if (exact.length > 1) {
        // 多个精确匹配 — 用路径邻近度消歧
        const disambiguated = disambiguateByProximity(exact, context?.fromFilePath);
        if (disambiguated) {
            return { ...disambiguated, confidence: 0.95 };
        }
        return { qualifiedName: exact[0].qualifiedName, confidence: 0.8, strategy: 'exact-name', filePath: exact[0].filePath };
    }
    // Strategy 2: 限定名后缀匹配
    const suffix = candidates.filter(c => c.qualifiedName.endsWith(`.${referenceName}`));
    if (suffix.length === 1) {
        return { qualifiedName: suffix[0].qualifiedName, confidence: 0.9, strategy: 'qualified-suffix', filePath: suffix[0].filePath };
    }
    if (suffix.length > 1) {
        const disambiguated = disambiguateByProximity(suffix, context?.fromFilePath);
        if (disambiguated)
            return { ...disambiguated, confidence: 0.85 };
        return { qualifiedName: suffix[0].qualifiedName, confidence: 0.7, strategy: 'qualified-suffix', filePath: suffix[0].filePath };
    }
    // Strategy 3: 文件路径匹配 — import 路径推导出 file path
    if (referenceName.includes('/') || referenceName.startsWith('.')) {
        const normalized = referenceName.replace(/\\/g, '/').replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, '');
        const pathMatch = candidates.filter(c => {
            const normalizedPath = c.filePath.replace(/\\/g, '/');
            return normalizedPath.includes(normalized) || normalized.endsWith(normalizedPath.split('/').pop() ?? '');
        });
        if (pathMatch.length > 0) {
            return { qualifiedName: pathMatch[0].qualifiedName, confidence: 0.85, strategy: 'file-path', filePath: pathMatch[0].filePath };
        }
    }
    // Strategy 4: 方法调用解析 — receiver.method() → 查找 receiver 类型的 method
    if (context?.receiverType && referenceName.includes('.')) {
        const methodName = referenceName.split('.').pop();
        const receiverCandidates = candidates.filter(c => c.qualifiedName.includes(context.receiverType) && c.name === methodName);
        if (receiverCandidates.length > 0) {
            return { qualifiedName: receiverCandidates[0].qualifiedName, confidence: 0.8, strategy: 'method-call', filePath: receiverCandidates[0].filePath };
        }
    }
    // Strategy 5: 模糊匹配 — camelCase 分词后子集匹配
    const refTokens = tokenize(referenceName.toLowerCase());
    const fuzzyMatches = [];
    for (const c of candidates) {
        const candTokens = tokenize(c.name.toLowerCase());
        const overlap = computeTokenOverlap(refTokens, candTokens);
        if (overlap >= 0.5) {
            fuzzyMatches.push({ candidate: c, overlap });
        }
    }
    if (fuzzyMatches.length > 0) {
        fuzzyMatches.sort((a, b) => b.overlap - a.overlap);
        const best = fuzzyMatches[0];
        return {
            qualifiedName: best.candidate.qualifiedName,
            confidence: best.overlap * 0.7, // 模糊匹配降权
            strategy: 'fuzzy-tokens',
            filePath: best.candidate.filePath,
        };
    }
    // Strategy 6: 路径邻近度评分 — 同目录/同模块加分
    const proximityMatch = disambiguateByProximity(candidates, context?.fromFilePath);
    if (proximityMatch && proximityMatch.confidence >= 0.3) {
        return proximityMatch;
    }
    return null;
}
// ---------------------------------------------------------------------------
// 路径邻近度消歧
// ---------------------------------------------------------------------------
function disambiguateByProximity(candidates, fromFilePath) {
    if (!fromFilePath || candidates.length === 0)
        return null;
    const normalizedFrom = fromFilePath.replace(/\\/g, '/');
    const fromParts = normalizedFrom.split('/');
    let best = null;
    let bestScore = -1;
    for (const c of candidates) {
        const normalizedCand = c.filePath.replace(/\\/g, '/');
        const candParts = normalizedCand.split('/');
        // 同目录加分 (+0.5)
        const sameDir = fromParts.slice(0, -1).join('/') === candParts.slice(0, -1).join('/');
        let score = sameDir ? 0.5 : 0;
        // 共享路径前缀加分
        let sharedPrefix = 0;
        for (let i = 0; i < Math.min(fromParts.length - 1, candParts.length - 1); i++) {
            if (fromParts[i] === candParts[i])
                sharedPrefix++;
            else
                break;
        }
        score += sharedPrefix * 0.1;
        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }
    if (best && bestScore > 0) {
        return {
            qualifiedName: best.qualifiedName,
            confidence: Math.min(bestScore, 1.0),
            strategy: 'path-proximity',
            filePath: best.filePath,
        };
    }
    return null;
}
// ---------------------------------------------------------------------------
// 分词工具
// ---------------------------------------------------------------------------
/**
 * 驼峰/蛇形/SCREAMING_SNAKE/dot 分词
 */
export function tokenize(identifier) {
    const tokens = [];
    // 分割 snake_case / SCREAMING_SNAKE
    for (const part of identifier.split(/[_.\s]+/)) {
        if (!part)
            continue;
        // 分割 camelCase / PascalCase
        const camelParts = part.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
        for (const cp of camelParts.split('_')) {
            const lower = cp.toLowerCase();
            if (lower.length > 0)
                tokens.push(lower);
        }
    }
    return tokens;
}
/**
 * 计算两组 token 的重叠度 (Jaccard-like)
 */
function computeTokenOverlap(a, b) {
    if (a.length === 0 || b.length === 0)
        return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const t of setA) {
        if (setB.has(t))
            intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
}
//# sourceMappingURL=name-matcher.js.map