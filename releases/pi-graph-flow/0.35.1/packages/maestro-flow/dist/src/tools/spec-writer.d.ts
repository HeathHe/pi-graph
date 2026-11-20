/**
 * Spec Writer
 *
 * Append new spec entries to the appropriate category file.
 * Uses spec-entry-parser for formatting and spec-loader for directory resolution.
 */
import { type SpecCategory, type SpecScope } from './spec-loader.js';
import { type RepositoryMutationContext } from '../repository/context.js';
/** Maximum content size (in characters) before auto-redirecting to knowhow */
export declare const MAX_SPEC_ENTRY_SIZE = 2048;
export interface SpecAddResult {
    ok: boolean;
    file: string;
    category: SpecCategory;
    title: string;
    duplicate: boolean;
    /** Set to true when content exceeded MAX_SPEC_ENTRY_SIZE and was redirected to knowhow */
    redirected?: boolean;
    /** Path to the knowhow file when redirected */
    knowhowRef?: string;
    /** Auto-captured git evidence (commit hash) */
    evidence?: string;
    /** Stable identity assigned to the new entry (undefined for title duplicates). */
    sid?: string;
    /** True when an explicit sid replay matched every canonical caller-owned field. */
    replayed?: boolean;
}
export type SpecWriteContext = RepositoryMutationContext;
export interface SpecAppendOptions {
    allowDuplicateTitle?: boolean;
    /** Explicit host-resolved physical repository context. */
    operationContext?: SpecWriteContext;
    relatedPaths?: string[];
    appliesToRepoIds?: string[];
    /** Internal recursion fence: authority was revalidated under target locks. */
    mutationValidated?: boolean;
}
export interface CanonicalSpecWriteInput extends Record<string, unknown> {
    category: SpecCategory;
    title: string;
    content: string;
    keywords?: string[];
    sourceRef?: string | null;
    relatedPaths?: string[];
    appliesToRepoIds?: string[];
    /** Canonical ID-only physical target, verified against the resolved context. */
    targetRepoId?: string;
    scope?: SpecScope;
    uid?: string;
    sid?: string;
    allowDuplicateTitle?: boolean;
}
/** Canonical object contract for ordinary Spec creation. */
export declare function writeSpecEntry(context: SpecWriteContext, input: CanonicalSpecWriteInput): SpecAddResult;
/**
 * Append a new spec entry to the appropriate file for the given category.
 *
 * - Resolves target directory via scope
 * - Creates directory and file if missing
 * - Skips duplicates (case-insensitive title match)
 * - Formats entry using `formatNewEntry` and appends to file
 * - Auto-redirects to knowhow when content exceeds MAX_SPEC_ENTRY_SIZE
 */
export declare function appendSpecEntry(projectPath: string, category: SpecCategory, title: string, content: string, keywords: string[], source?: string, scope?: SpecScope, uid?: string, description?: string, sidOverride?: string, options?: SpecAppendOptions): SpecAddResult;
/**
 * Append a spec index entry that references a knowhow document.
 * The entry body is a summary, with a ref attribute pointing to the knowhow file.
 */
export declare function appendSpecEntryWithRef(projectPath: string, category: SpecCategory, title: string, summary: string, keywords: string[], ref: string, source?: string, scope?: SpecScope, uid?: string, sidOverride?: string, options?: SpecAppendOptions): SpecAddResult;
//# sourceMappingURL=spec-writer.d.ts.map