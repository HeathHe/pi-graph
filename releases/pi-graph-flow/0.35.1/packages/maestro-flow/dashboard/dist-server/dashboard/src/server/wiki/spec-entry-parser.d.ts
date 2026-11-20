/**
 * Spec entry parser — shared between specs routes and WikiIndexer.
 *
 * Extracts SpecEntry objects from markdown body text. Supports both
 * `<spec-entry>` closed-tag format and legacy heading-based format.
 */
import { type KnowledgeLifecycleStatus } from '../../../../shared/knowledge-content.js';
export interface SpecEntry {
    id: string;
    type: string;
    title: string;
    description?: string;
    content: string;
    file: string;
    timestamp: string;
    category: string;
    keywords: string[];
    sourceRef?: string;
    relatedPaths?: string[];
    appliesToRepoIds?: string[];
    language?: string;
    decisionState?: string;
    lifecycleStatus?: KnowledgeLifecycleStatus;
    ref?: string;
    confidence?: string;
    conflictNote?: string;
    sid?: string;
    supersedes?: string;
    supersededBy?: string;
    status?: string;
}
export declare const FILE_CATEGORY_MAP: Record<string, string>;
/** Heading regex: matches ## or ### at start of line. */
export declare const HEADING_RE: RegExp;
/** Detect entry type from heading text or fall back to file-based default. */
export declare function detectEntryType(heading: string, fileName: string): string;
/** Strip [type], [date], and legacy "type:" prefix from heading to get clean title. */
export declare function extractCleanTitle(heading: string): string;
/**
 * Parse markdown body into SpecEntry objects from <spec-entry> blocks.
 */
export declare function parseSpecEntries(body: string, fileName: string, frontmatter?: Record<string, unknown>): SpecEntry[];
/**
 * Parse markdown body into SpecEntry objects from <knowhow-entry> blocks.
 */
export declare function parseKnowhowEntries(body: string, fileName: string, frontmatter?: Record<string, unknown>): SpecEntry[];
