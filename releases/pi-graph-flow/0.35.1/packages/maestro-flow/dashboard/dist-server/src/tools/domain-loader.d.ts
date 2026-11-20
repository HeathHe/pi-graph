/**
 * Domain Loader — CRUD for .workflow/domain/glossary.yaml
 *
 * Provides read/write operations with file locking, auto-backup, mtime cache,
 * and schema validation. All write operations go through GlossaryLock.
 *
 * Migration: reads glossary.json as fallback for backward compatibility,
 * but always writes glossary.yaml.
 */
import { type ValidationError, type ValidationWarning } from './domain-schema.js';
export interface DomainTerm {
    id: string;
    canonical: string;
    aliases: string[];
    definition: string;
    relationships: string[];
    keywords: string[];
    concept_ref?: string;
    rewrite_hints?: Record<string, string>;
    tier?: 'core' | 'extended' | 'peripheral';
    status?: 'active' | 'deprecated';
    deprecated_info?: {
        reason: string;
        successor_id?: string;
        deprecated_at: string;
    };
    source: {
        kind: 'discover' | 'finish-work' | 'manual' | 'import';
        session?: string;
        registered_at: string;
    };
}
export interface DomainGlossary {
    $schema: string;
    project?: string;
    terms: DomainTerm[];
}
export interface GlossaryLoadResult {
    exists: boolean;
    glossary: DomainGlossary | null;
    activeTerms: DomainTerm[];
    isEmpty: boolean;
}
export declare class GlossaryLock {
    private lockPath;
    private held;
    constructor(workflowRoot: string);
    acquire(): void;
    release(): void;
    withLock<T>(fn: () => T): T;
}
export declare function readGlossary(workflowRoot: string): DomainGlossary;
export declare function readGlossaryCached(workflowRoot: string): DomainGlossary;
export declare function loadGlossary(projectPath: string): GlossaryLoadResult;
export declare function initDomain(workflowRoot: string, project?: string): string;
export declare function addTerm(workflowRoot: string, term: DomainTerm): void;
export declare function updateTerm(workflowRoot: string, termId: string, updates: Partial<Omit<DomainTerm, 'id'>>): void;
export declare function removeTerm(workflowRoot: string, termId: string): {
    warnings: string[];
};
export declare function deprecateTerm(workflowRoot: string, termId: string, reason: string, successorId?: string): void;
export declare function validateGlossaryFile(workflowRoot: string): {
    errors: ValidationError[];
    warnings: ValidationWarning[];
};
