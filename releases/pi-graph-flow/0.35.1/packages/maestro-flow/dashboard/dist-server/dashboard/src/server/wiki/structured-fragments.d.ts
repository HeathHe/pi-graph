/**
 * Internal recall unit used by the opt-in structured embedding index.  A
 * fragment never becomes a public search result: `parentId` remains the
 * externally visible WikiEntry id and the indexer collapses fragment hits
 * back to that id before returning results.
 */
export type SearchFragmentKind = 'markdown' | 'text' | 'code';
export interface SearchFragmentRange {
    /** 1-based inclusive source line range. */
    startLine: number;
    endLine: number;
    /** UTF-16 source offsets, start inclusive/end exclusive. */
    startChar?: number;
    endChar?: number;
}
export interface SearchFragment {
    /** Stable internal id; never expose this as a WikiEntry id. */
    fragmentId: string;
    /** Existing WikiEntry/MaestroGraph id retained as the result identity. */
    parentId: string;
    /** Text sent to the embedding provider. */
    text: string;
    range: SearchFragmentRange;
    /** Heading path from the document root, or an empty array for plain text. */
    breadcrumb: string[];
    kind: SearchFragmentKind;
    /** SHA-256 of the exact embedding text (not a provider/model hash). */
    contentHash: string;
    /** Chunk policy which produced this fragment. */
    policyChecksum: string;
}
export interface StructuredFragmentPolicy {
    schema: 'search-fragments/1';
    /** Maximum embedding text budget in UTF-16 characters. */
    maxChars: number;
    /** Overlap between adjacent long-section fragments. */
    overlapChars: number;
    /** Markdown heading depth considered for hierarchy. */
    maxHeadingLevel: number;
    /** Number of source lines used when no character range is available. */
    textLineBudget: number;
}
/**
 * Deliberately conservative defaults.  They are part of the checksum: changing
 * any value invalidates structured artifacts instead of mixing old vectors
 * with newly generated fragments.
 */
export declare const STRUCTURED_FRAGMENT_POLICY: Readonly<StructuredFragmentPolicy>;
export declare function structuredFragmentPolicyChecksum(policy?: StructuredFragmentPolicy): string;
export declare const STRUCTURED_FRAGMENT_POLICY_CHECKSUM: string;
/** Structured chunks stay explicitly opt-in until ranking/performance gates pass. */
export declare function isStructuredChunksEnabled(value?: string | undefined): boolean;
export interface SearchFragmentDocument {
    id: string;
    title?: string;
    summary?: string;
    tags?: readonly string[];
    body?: string;
    /** `code` selects MaestroGraph fields below; no parser is invoked here. */
    kind?: SearchFragmentKind;
    filePath?: string | null;
    symbol?: string | null;
    qualifiedName?: string | null;
    signature?: string | null;
    language?: string | null;
    definition?: string | null;
    sourceType?: string | null;
    startLine?: number;
    endLine?: number;
}
/** Build all deterministic structured fragments for one Wiki/MaestroGraph doc. */
export declare function buildSearchFragments(document: SearchFragmentDocument, policy?: StructuredFragmentPolicy): SearchFragment[];
/** Build fragments in input order; no sorting or graph/parser side effects. */
export declare function buildStructuredFragments(documents: readonly SearchFragmentDocument[], policy?: StructuredFragmentPolicy): SearchFragment[];
/** MaestroGraph fields used by code embeddings, kept parser-independent. */
export interface MaestroGraphCodeContext {
    id: string;
    filePath: string;
    kind: string;
    language: string;
    name: string;
    qualifiedName?: string;
    signature?: string;
    definition?: string;
    docstring?: string;
    startLine?: number;
    endLine?: number;
    sourceType?: string;
}
export declare function maestroGraphCodeDocument(node: MaestroGraphCodeContext): SearchFragmentDocument;
