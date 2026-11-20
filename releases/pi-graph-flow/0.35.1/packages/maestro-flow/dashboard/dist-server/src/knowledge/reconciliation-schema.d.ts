import { z } from 'zod';
export declare const knowledgeDispositionSchema: z.ZodEnum<{
    extends: "extends";
    related: "related";
    unique: "unique";
    exact_duplicate: "exact_duplicate";
    semantic_duplicate: "semantic_duplicate";
    potential_conflict: "potential_conflict";
    supersede_candidate: "supersede_candidate";
}>;
export declare const knowledgePromotionEligibilitySchema: z.ZodEnum<{
    review_required: "review_required";
    suppressed: "suppressed";
    eligible: "eligible";
}>;
export declare const knowledgeResolutionSchema: z.ZodObject<{
    status: z.ZodEnum<{
        automatic: "automatic";
        confirmed: "confirmed";
    }>;
    reason: z.ZodString;
    resolved_at: z.ZodString;
}, z.core.$strict>;
export declare const knowledgeReconciliationMatchSchema: z.ZodObject<{
    knowledge_id: z.ZodString;
    target: z.ZodEnum<{
        spec: "spec";
        knowhow: "knowhow";
    }>;
    title: z.ZodString;
    relation: z.ZodEnum<{
        extends: "extends";
        related: "related";
        exact_duplicate: "exact_duplicate";
        semantic_duplicate: "semantic_duplicate";
        potential_conflict: "potential_conflict";
        supersede_candidate: "supersede_candidate";
    }>;
    scores: z.ZodObject<{
        lexical: z.ZodNumber;
        semantic: z.ZodNumber;
        title: z.ZodNumber;
        relation: z.ZodNumber;
        stance: z.ZodNumber;
        composite: z.ZodNumber;
    }, z.core.$strict>;
    novelty: z.ZodNumber;
    evidence: z.ZodArray<z.ZodString>;
    target_content_hash: z.ZodString;
    source_path: z.ZodString;
    source_line: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export declare const knowledgeCandidateReconciliationSchema: z.ZodObject<{
    candidate_id: z.ZodString;
    disposition: z.ZodEnum<{
        extends: "extends";
        related: "related";
        unique: "unique";
        exact_duplicate: "exact_duplicate";
        semantic_duplicate: "semantic_duplicate";
        potential_conflict: "potential_conflict";
        supersede_candidate: "supersede_candidate";
    }>;
    promotion_eligibility: z.ZodEnum<{
        review_required: "review_required";
        suppressed: "suppressed";
        eligible: "eligible";
    }>;
    canonical_id: z.ZodNullable<z.ZodString>;
    matches: z.ZodArray<z.ZodObject<{
        knowledge_id: z.ZodString;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        title: z.ZodString;
        relation: z.ZodEnum<{
            extends: "extends";
            related: "related";
            exact_duplicate: "exact_duplicate";
            semantic_duplicate: "semantic_duplicate";
            potential_conflict: "potential_conflict";
            supersede_candidate: "supersede_candidate";
        }>;
        scores: z.ZodObject<{
            lexical: z.ZodNumber;
            semantic: z.ZodNumber;
            title: z.ZodNumber;
            relation: z.ZodNumber;
            stance: z.ZodNumber;
            composite: z.ZodNumber;
        }, z.core.$strict>;
        novelty: z.ZodNumber;
        evidence: z.ZodArray<z.ZodString>;
        target_content_hash: z.ZodString;
        source_path: z.ZodString;
        source_line: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>>;
    resolution: z.ZodNullable<z.ZodObject<{
        status: z.ZodEnum<{
            automatic: "automatic";
            confirmed: "confirmed";
        }>;
        reason: z.ZodString;
        resolved_at: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const sessionKnowledgeReceiptCandidateSchema: z.ZodUnion<readonly [z.ZodObject<{
    candidate_id: z.ZodString;
    candidate_version: z.ZodLiteral<1>;
    observed_activity_revision: z.ZodNumber;
    content_hash: z.ZodString;
    evidence_root_hash: z.ZodString;
    evidence_root_descriptors: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"file">;
        ref: z.ZodString;
        path: z.ZodString;
        anchor: z.ZodNullable<z.ZodString>;
        content_hash: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"run">;
        ref: z.ZodString;
        run_id: z.ZodString;
        path: z.ZodString;
        content_hash: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"artifact">;
        ref: z.ZodString;
        artifact_id: z.ZodString;
        path: z.ZodString;
        content_hash: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"inline">;
        ref: z.ZodString;
        encoding: z.ZodLiteral<"utf8">;
        content: z.ZodString;
        content_hash: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"transcript">;
        ref: z.ZodString;
        path: z.ZodString;
        content_hash: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strict>], "kind">>>;
    status: z.ZodOptional<z.ZodLiteral<"ok">>;
}, z.core.$strict>, z.ZodObject<{
    candidate_id: z.ZodString;
    status: z.ZodLiteral<"blocked">;
    block_reason: z.ZodString;
}, z.core.$strict>]>;
export declare const sessionKnowledgeReceiptSourceSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"session-knowledge-reconciliation-source/1.0">;
    session_activity_revision: z.ZodNumber;
    evidence_root_hash: z.ZodString;
    candidates: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        candidate_id: z.ZodString;
        candidate_version: z.ZodLiteral<1>;
        observed_activity_revision: z.ZodNumber;
        content_hash: z.ZodString;
        evidence_root_hash: z.ZodString;
        evidence_root_descriptors: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            ref: z.ZodString;
            path: z.ZodString;
            anchor: z.ZodNullable<z.ZodString>;
            content_hash: z.ZodString;
            size: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"run">;
            ref: z.ZodString;
            run_id: z.ZodString;
            path: z.ZodString;
            content_hash: z.ZodString;
            size: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"artifact">;
            ref: z.ZodString;
            artifact_id: z.ZodString;
            path: z.ZodString;
            content_hash: z.ZodString;
            size: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"inline">;
            ref: z.ZodString;
            encoding: z.ZodLiteral<"utf8">;
            content: z.ZodString;
            content_hash: z.ZodString;
            size: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"transcript">;
            ref: z.ZodString;
            path: z.ZodString;
            content_hash: z.ZodString;
            size: z.ZodNumber;
        }, z.core.$strict>], "kind">>>;
        status: z.ZodOptional<z.ZodLiteral<"ok">>;
    }, z.core.$strict>, z.ZodObject<{
        candidate_id: z.ZodString;
        status: z.ZodLiteral<"blocked">;
        block_reason: z.ZodString;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export declare const knowledgeReconciliationSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"knowledge-reconciliation/1.0">;
    session_id: z.ZodString;
    run_id: z.ZodString;
    candidate_snapshot_hash: z.ZodString;
    corpus_fingerprint: z.ZodString;
    matcher_revision: z.ZodLiteral<"semantic-delta/1.0">;
    generated_at: z.ZodString;
    retrieval: z.ZodObject<{
        mode: z.ZodEnum<{
            "lexical-kg": "lexical-kg";
            hybrid: "hybrid";
        }>;
        embedding_used: z.ZodBoolean;
        candidate_limit: z.ZodNumber;
        identity_documents: z.ZodNumber;
        semantic_documents: z.ZodNumber;
        relation_documents: z.ZodNumber;
    }, z.core.$strict>;
    counts: z.ZodObject<{
        candidates: z.ZodNumber;
        unique: z.ZodNumber;
        duplicates: z.ZodNumber;
        related: z.ZodNumber;
        conflicts: z.ZodNumber;
        review_required: z.ZodNumber;
        suppressed: z.ZodNumber;
    }, z.core.$strict>;
    candidates: z.ZodArray<z.ZodObject<{
        candidate_id: z.ZodString;
        disposition: z.ZodEnum<{
            extends: "extends";
            related: "related";
            unique: "unique";
            exact_duplicate: "exact_duplicate";
            semantic_duplicate: "semantic_duplicate";
            potential_conflict: "potential_conflict";
            supersede_candidate: "supersede_candidate";
        }>;
        promotion_eligibility: z.ZodEnum<{
            review_required: "review_required";
            suppressed: "suppressed";
            eligible: "eligible";
        }>;
        canonical_id: z.ZodNullable<z.ZodString>;
        matches: z.ZodArray<z.ZodObject<{
            knowledge_id: z.ZodString;
            target: z.ZodEnum<{
                spec: "spec";
                knowhow: "knowhow";
            }>;
            title: z.ZodString;
            relation: z.ZodEnum<{
                extends: "extends";
                related: "related";
                exact_duplicate: "exact_duplicate";
                semantic_duplicate: "semantic_duplicate";
                potential_conflict: "potential_conflict";
                supersede_candidate: "supersede_candidate";
            }>;
            scores: z.ZodObject<{
                lexical: z.ZodNumber;
                semantic: z.ZodNumber;
                title: z.ZodNumber;
                relation: z.ZodNumber;
                stance: z.ZodNumber;
                composite: z.ZodNumber;
            }, z.core.$strict>;
            novelty: z.ZodNumber;
            evidence: z.ZodArray<z.ZodString>;
            target_content_hash: z.ZodString;
            source_path: z.ZodString;
            source_line: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>>;
        resolution: z.ZodNullable<z.ZodObject<{
            status: z.ZodEnum<{
                automatic: "automatic";
                confirmed: "confirmed";
            }>;
            reason: z.ZodString;
            resolved_at: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    session_source: z.ZodOptional<z.ZodObject<{
        schema_version: z.ZodLiteral<"session-knowledge-reconciliation-source/1.0">;
        session_activity_revision: z.ZodNumber;
        evidence_root_hash: z.ZodString;
        candidates: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            candidate_id: z.ZodString;
            candidate_version: z.ZodLiteral<1>;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_root_hash: z.ZodString;
            evidence_root_descriptors: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"file">;
                ref: z.ZodString;
                path: z.ZodString;
                anchor: z.ZodNullable<z.ZodString>;
                content_hash: z.ZodString;
                size: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"run">;
                ref: z.ZodString;
                run_id: z.ZodString;
                path: z.ZodString;
                content_hash: z.ZodString;
                size: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"artifact">;
                ref: z.ZodString;
                artifact_id: z.ZodString;
                path: z.ZodString;
                content_hash: z.ZodString;
                size: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"inline">;
                ref: z.ZodString;
                encoding: z.ZodLiteral<"utf8">;
                content: z.ZodString;
                content_hash: z.ZodString;
                size: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"transcript">;
                ref: z.ZodString;
                path: z.ZodString;
                content_hash: z.ZodString;
                size: z.ZodNumber;
            }, z.core.$strict>], "kind">>>;
            status: z.ZodOptional<z.ZodLiteral<"ok">>;
        }, z.core.$strict>, z.ZodObject<{
            candidate_id: z.ZodString;
            status: z.ZodLiteral<"blocked">;
            block_reason: z.ZodString;
        }, z.core.$strict>]>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type KnowledgeDisposition = z.infer<typeof knowledgeDispositionSchema>;
export type KnowledgePromotionEligibility = z.infer<typeof knowledgePromotionEligibilitySchema>;
export type KnowledgeReconciliation = z.infer<typeof knowledgeReconciliationSchema>;
export type KnowledgeCandidateReconciliation = z.infer<typeof knowledgeCandidateReconciliationSchema>;
