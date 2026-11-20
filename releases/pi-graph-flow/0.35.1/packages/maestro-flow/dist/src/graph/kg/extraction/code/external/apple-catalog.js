import appleCatalogV1 from './apple-catalog.v1.json' with { type: 'json' };
export const APPLE_EXTERNAL_CATALOG_SCHEMA_VERSION = 'apple-external-catalog/1.0';
const ROOT_FIELDS = ['schema_version', 'entries'];
const ENTRY_FIELDS = [
    'module',
    'objcName',
    'kind',
    'swiftVisibleAliases',
    'parent',
    'protocols',
];
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED_NAME_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;
export function makeAppleExternalFilePath(module) {
    return `@external/apple/${module}`;
}
export function makeAppleExternalNodeId(module, objcName) {
    return `code:${makeAppleExternalFilePath(module)}:${objcName}`;
}
export function makeAppleExternalQualifiedName(module, objcName) {
    return `${module}.${objcName}`;
}
/**
 * Validates an in-package catalog value. The loader intentionally has no
 * projectRoot, SDK path, or filesystem override surface.
 */
export function loadAppleExternalCatalog(source = appleCatalogV1) {
    const root = requireRecord(source, 'root');
    assertExactFields(root, ROOT_FIELDS, 'root');
    if (root.schema_version !== APPLE_EXTERNAL_CATALOG_SCHEMA_VERSION) {
        throw catalogError(`unsupported schema_version: ${String(root.schema_version)}`);
    }
    if (!Array.isArray(root.entries)) {
        throw catalogError('entries must be an array');
    }
    const entries = root.entries.map((value, index) => parseEntry(value, index));
    const entriesByNodeId = new Map();
    const entriesByQualifiedName = new Map();
    for (const entry of entries) {
        const nodeId = makeAppleExternalNodeId(entry.module, entry.objcName);
        if (entriesByNodeId.has(nodeId)) {
            throw catalogError(`duplicate stable ID: ${nodeId}`);
        }
        entriesByNodeId.set(nodeId, entry);
        entriesByQualifiedName.set(makeAppleExternalQualifiedName(entry.module, entry.objcName), entry);
    }
    validateAliases(entries);
    validateRelations(entries, entriesByQualifiedName);
    return Object.freeze({
        schemaVersion: APPLE_EXTERNAL_CATALOG_SCHEMA_VERSION,
        entries: Object.freeze(entries),
        entriesByNodeId,
        entriesByQualifiedName,
    });
}
export const SHIPPED_APPLE_EXTERNAL_CATALOG = loadAppleExternalCatalog();
/** Returns only exact canonical-name or explicitly declared Swift alias matches. */
export function findAppleExternalCatalogCandidates(reference, catalog = SHIPPED_APPLE_EXTERNAL_CATALOG) {
    if (reference.lookupScope !== 'external' && reference.lookupScope !== 'project-and-external') {
        return [];
    }
    if (reference.targetLanguageHints.length > 0
        && !reference.targetLanguageHints.includes('objc')
        && !reference.targetLanguageHints.includes('unknown')) {
        return [];
    }
    const rawTargetName = reference.rawTargetName;
    const rawIsQualified = rawTargetName.includes('.');
    const moduleHints = new Set(reference.moduleHints);
    const matches = [];
    for (const entry of catalog.entries) {
        if (reference.targetKindHints.length > 0
            && !reference.targetKindHints.includes(entry.kind)) {
            continue;
        }
        // An explicit qualified target is stronger than ambient import hints.
        if (!rawIsQualified && moduleHints.size > 0 && !moduleHints.has(entry.module)) {
            continue;
        }
        const canonicalQualifiedName = makeAppleExternalQualifiedName(entry.module, entry.objcName);
        const canonicalMatches = rawIsQualified
            ? rawTargetName === canonicalQualifiedName
            : rawTargetName === entry.objcName;
        const matchedAlias = reference.origin.language === 'swift'
            ? entry.swiftVisibleAliases.find(alias => (rawIsQualified
                ? rawTargetName === makeAppleExternalQualifiedName(entry.module, alias)
                : rawTargetName === alias))
            : undefined;
        if (!canonicalMatches && !matchedAlias)
            continue;
        matches.push({
            referenceRefKey: reference.refKey,
            rawTargetName,
            matchKind: canonicalMatches ? 'canonical' : 'swift-alias',
            matchedCatalogName: canonicalMatches
                ? canonicalQualifiedName
                : makeAppleExternalQualifiedName(entry.module, matchedAlias),
            canonicalNodeId: makeAppleExternalNodeId(entry.module, entry.objcName),
            canonicalQualifiedName,
            canonicalObjcName: entry.objcName,
            module: entry.module,
            kind: entry.kind,
        });
    }
    return matches.sort((left, right) => byteCompare(left.canonicalNodeId, right.canonicalNodeId));
}
/**
 * Materializes referenced Apple entries plus their explicit catalog ancestors.
 * Unreferenced, non-ancestor catalog entries never enter the project graph.
 */
export function materializeAppleExternalCatalog(references, options = {}) {
    const catalog = options.catalog ?? SHIPPED_APPLE_EXTERNAL_CATALOG;
    const now = options.now ?? Date.now();
    const matches = [...references]
        .flatMap(reference => findAppleExternalCatalogCandidates(reference, catalog))
        .sort((left, right) => (byteCompare(left.referenceRefKey, right.referenceRefKey)
        || byteCompare(left.canonicalNodeId, right.canonicalNodeId)));
    const selected = new Map();
    const includeEntryAndRelations = (entry) => {
        const qualifiedName = makeAppleExternalQualifiedName(entry.module, entry.objcName);
        if (selected.has(qualifiedName))
            return;
        selected.set(qualifiedName, entry);
        if (entry.parent) {
            includeEntryAndRelations(requireRelationTarget(catalog, entry.parent));
        }
        for (const protocol of entry.protocols) {
            includeEntryAndRelations(requireRelationTarget(catalog, protocol));
        }
    };
    for (const match of matches) {
        const entry = catalog.entriesByNodeId.get(match.canonicalNodeId);
        if (entry)
            includeEntryAndRelations(entry);
    }
    const selectedEntries = [...selected.values()].sort((left, right) => (byteCompare(makeAppleExternalNodeId(left.module, left.objcName), makeAppleExternalNodeId(right.module, right.objcName))));
    const nodes = selectedEntries.map(entry => makeAppleExternalNode(entry, catalog.schemaVersion, now));
    const edges = [];
    for (const entry of selectedEntries) {
        const source = makeAppleExternalNodeId(entry.module, entry.objcName);
        if (entry.parent) {
            const target = requireRelationTarget(catalog, entry.parent);
            edges.push(makeCatalogEdge(source, target, 'extends', 'parent', catalog.schemaVersion));
        }
        for (const protocolName of entry.protocols) {
            const target = requireRelationTarget(catalog, protocolName);
            edges.push(makeCatalogEdge(source, target, entry.kind === 'protocol' ? 'extends' : 'implements', 'protocol', catalog.schemaVersion));
        }
    }
    edges.sort((left, right) => (byteCompare(left.source, right.source)
        || byteCompare(left.target, right.target)
        || byteCompare(left.kind, right.kind)));
    return { nodes, edges, matches };
}
function makeAppleExternalNode(entry, schemaVersion, now) {
    const filePath = makeAppleExternalFilePath(entry.module);
    return {
        id: makeAppleExternalNodeId(entry.module, entry.objcName),
        kind: entry.kind,
        name: entry.objcName,
        qualifiedName: makeAppleExternalQualifiedName(entry.module, entry.objcName),
        filePath,
        language: 'objc',
        startLine: 0,
        endLine: 0,
        startColumn: 0,
        endColumn: 0,
        docstring: '',
        signature: '',
        visibility: 'public',
        isExported: true,
        isAsync: false,
        isStatic: false,
        isAbstract: false,
        decorators: [],
        typeParameters: [],
        sourceType: 'codegraph',
        definition: '',
        aliases: [...entry.swiftVisibleAliases],
        keywords: [],
        category: '',
        roles: [],
        priority: '',
        status: 'active',
        body: '',
        metadata: {
            provider: 'apple',
            module: entry.module,
            catalogSchemaVersion: schemaVersion,
            swiftVisibleAliases: [...entry.swiftVisibleAliases],
            objcCanonicalName: entry.objcName,
        },
        updatedAt: now,
    };
}
function makeCatalogEdge(source, targetEntry, kind, relation, schemaVersion) {
    return {
        source,
        target: makeAppleExternalNodeId(targetEntry.module, targetEntry.objcName),
        kind,
        provenance: 'framework',
        metadata: {
            provider: 'apple',
            relation,
            catalogSchemaVersion: schemaVersion,
        },
    };
}
function parseEntry(value, index) {
    const context = `entries[${index}]`;
    const raw = requireRecord(value, context);
    assertExactFields(raw, ENTRY_FIELDS, context);
    const module = requireIdentifier(raw.module, `${context}.module`);
    const objcName = requireIdentifier(raw.objcName, `${context}.objcName`);
    if (raw.kind !== 'class' && raw.kind !== 'protocol') {
        throw catalogError(`${context}.kind must be class or protocol`);
    }
    const swiftVisibleAliases = requireIdentifierArray(raw.swiftVisibleAliases, `${context}.swiftVisibleAliases`, true);
    if (raw.parent !== null && typeof raw.parent !== 'string') {
        throw catalogError(`${context}.parent must be a qualified name or null`);
    }
    if (typeof raw.parent === 'string') {
        requireQualifiedName(raw.parent, `${context}.parent`);
    }
    const protocols = requireQualifiedNameArray(raw.protocols, `${context}.protocols`);
    return Object.freeze({
        module,
        objcName,
        kind: raw.kind,
        swiftVisibleAliases: Object.freeze(swiftVisibleAliases),
        parent: raw.parent,
        protocols: Object.freeze(protocols),
    });
}
function validateAliases(entries) {
    const canonicalClaims = new Map();
    const aliasClaims = new Map();
    for (const entry of entries) {
        const nodeId = makeAppleExternalNodeId(entry.module, entry.objcName);
        canonicalClaims.set(makeAppleExternalQualifiedName(entry.module, entry.objcName), nodeId);
    }
    for (const entry of entries) {
        const nodeId = makeAppleExternalNodeId(entry.module, entry.objcName);
        for (const alias of entry.swiftVisibleAliases) {
            const qualifiedAlias = makeAppleExternalQualifiedName(entry.module, alias);
            if (canonicalClaims.has(qualifiedAlias)) {
                throw catalogError(`alias collision: ${qualifiedAlias}`);
            }
            const prior = aliasClaims.get(qualifiedAlias);
            if (prior) {
                throw catalogError(`duplicate alias: ${qualifiedAlias} (${prior}, ${nodeId})`);
            }
            aliasClaims.set(qualifiedAlias, nodeId);
        }
    }
}
function validateRelations(entries, entriesByQualifiedName) {
    for (const entry of entries) {
        if (entry.parent) {
            const parent = entriesByQualifiedName.get(entry.parent);
            if (!parent)
                throw catalogError(`missing relation target: ${entry.parent}`);
            if (parent.kind !== 'class') {
                throw catalogError(`parent relation target must be a class: ${entry.parent}`);
            }
        }
        for (const protocolName of entry.protocols) {
            const protocol = entriesByQualifiedName.get(protocolName);
            if (!protocol)
                throw catalogError(`missing relation target: ${protocolName}`);
            if (protocol.kind !== 'protocol') {
                throw catalogError(`protocol relation target must be a protocol: ${protocolName}`);
            }
        }
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (qualifiedName) => {
        if (visited.has(qualifiedName))
            return;
        if (visiting.has(qualifiedName)) {
            throw catalogError(`relation cycle: ${qualifiedName}`);
        }
        visiting.add(qualifiedName);
        const entry = entriesByQualifiedName.get(qualifiedName);
        if (entry.parent)
            visit(entry.parent);
        for (const protocolName of entry.protocols)
            visit(protocolName);
        visiting.delete(qualifiedName);
        visited.add(qualifiedName);
    };
    for (const qualifiedName of entriesByQualifiedName.keys())
        visit(qualifiedName);
}
function requireRelationTarget(catalog, qualifiedName) {
    const target = catalog.entriesByQualifiedName.get(qualifiedName);
    if (!target) {
        // A validated catalog cannot reach this branch; keep materialization fail closed.
        throw catalogError(`missing relation target: ${qualifiedName}`);
    }
    return target;
}
function requireRecord(value, context) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw catalogError(`${context} must be an object`);
    }
    return value;
}
function assertExactFields(value, expected, context) {
    const expectedSet = new Set(expected);
    for (const key of Object.keys(value)) {
        if (!expectedSet.has(key))
            throw catalogError(`unknown field ${context}.${key}`);
    }
    for (const key of expected) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw catalogError(`missing field ${context}.${key}`);
        }
    }
}
function requireIdentifier(value, context) {
    if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
        throw catalogError(`${context} must be an identifier`);
    }
    return value;
}
function requireIdentifierArray(value, context, rejectDuplicates) {
    if (!Array.isArray(value))
        throw catalogError(`${context} must be an array`);
    const result = value.map((item, index) => requireIdentifier(item, `${context}[${index}]`));
    if (rejectDuplicates && new Set(result).size !== result.length) {
        throw catalogError(`duplicate alias: ${context}`);
    }
    return result;
}
function requireQualifiedName(value, context) {
    if (!QUALIFIED_NAME_PATTERN.test(value)) {
        throw catalogError(`${context} must be <Module>.<ObjCName>`);
    }
    return value;
}
function requireQualifiedNameArray(value, context) {
    if (!Array.isArray(value))
        throw catalogError(`${context} must be an array`);
    const result = value.map((item, index) => {
        if (typeof item !== 'string') {
            throw catalogError(`${context}[${index}] must be <Module>.<ObjCName>`);
        }
        return requireQualifiedName(item, `${context}[${index}]`);
    });
    if (new Set(result).size !== result.length) {
        throw catalogError(`duplicate relation target: ${context}`);
    }
    return result;
}
function catalogError(message) {
    return new Error(`Invalid Apple external catalog: ${message}`);
}
function byteCompare(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
//# sourceMappingURL=apple-catalog.js.map