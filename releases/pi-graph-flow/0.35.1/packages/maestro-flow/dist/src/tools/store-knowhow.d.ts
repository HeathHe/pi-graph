/**
 * Store KnowHow Tool — Create and search reusable knowledge entries.
 *
 * Replaces the deprecated core_memory tool. Writes directly to
 * .workflow/knowhow/ as markdown files, automatically indexed by WikiIndexer.
 *
 * Operations: add, search
 * Storage: .workflow/knowhow/{PREFIX}-{timestamp}.md
 *
 * All nine content types share the canonical metadata model:
 *   session, tip, template, recipe, reference, decision, asset, blueprint,
 *   and document. Legacy type-specific aliases are accepted on read/input and
 *   normalized before canonical-only writes.
 */
import { z } from 'zod';
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
import { type RepositoryMutationContext } from '../repository/context.js';
import { type KnowHowCategory, type CanonicalKnowledgeContent } from '../utils/frontmatter.js';
declare const ParamsSchema: z.ZodObject<{
    operation: z.ZodEnum<{
        search: "search";
        add: "add";
        supersede: "supersede";
        history: "history";
        recover: "recover";
    }>;
    id: z.ZodOptional<z.ZodString>;
    explicitId: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodEnum<{
        decision: "decision";
        session: "session";
        tip: "tip";
        template: "template";
        recipe: "recipe";
        reference: "reference";
        asset: "asset";
        blueprint: "blueprint";
        document: "document";
    }>>;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
    body: z.ZodOptional<z.ZodString>;
    keywords: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    language: z.ZodOptional<z.ZodString>;
    lang: z.ZodOptional<z.ZodString>;
    sourceRef: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
    decisionState: z.ZodOptional<z.ZodEnum<{
        superseded: "superseded";
        accepted: "accepted";
        proposed: "proposed";
    }>>;
    lifecycleStatus: z.ZodOptional<z.ZodEnum<{
        active: "active";
        deprecated: "deprecated";
    }>>;
    status: z.ZodOptional<z.ZodEnum<{
        superseded: "superseded";
        active: "active";
        accepted: "accepted";
        proposed: "proposed";
        deprecated: "deprecated";
    }>>;
    assetType: z.ZodOptional<z.ZodString>;
    relatedPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    codePaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    appliesToRepoIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    targetRepoId: z.ZodOptional<z.ZodString>;
    tool: z.ZodOptional<z.ZodBoolean>;
    category: z.ZodOptional<z.ZodString>;
    specCategory: z.ZodOptional<z.ZodString>;
    query: z.ZodOptional<z.ZodString>;
    repo: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    oldId: z.ZodOptional<z.ZodString>;
    newId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type Params = z.infer<typeof ParamsSchema>;
export interface KnowhowAddResult {
    schema_version: 'knowhow-add-result/1.0';
    operation: 'add';
    id: string;
    filename: string;
    path: string;
    created: string;
    replayed: boolean;
    type: KnowHowCategory;
    message: string;
    warnings?: string[];
}
export declare function renderKnowhowDocument(canonical: CanonicalKnowledgeContent & {
    type: KnowHowCategory;
}, created: string): string;
export type KnowhowWriteContext = RepositoryMutationContext;
export declare function executeAdd(params: Params, context?: KnowhowWriteContext): CcwToolResult;
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>, operationContext?: KnowhowWriteContext): Promise<CcwToolResult>;
export {};
//# sourceMappingURL=store-knowhow.d.ts.map