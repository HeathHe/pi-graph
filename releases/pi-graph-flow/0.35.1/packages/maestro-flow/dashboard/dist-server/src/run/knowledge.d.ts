import { z } from 'zod';
import { type CommandRun, type ReportFrontmatter } from './schemas.js';
import { SessionStore, type ExecutionRunSidecarAuthority, type StoreTransaction } from './store.js';
import { type KnowledgeReconciliation } from '../knowledge/reconciliation-schema.js';
import { type RepositoryContext } from '../repository/context.js';
export declare const sessionKnowledgeEvidenceRootSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
}, z.core.$strict>], "kind">;
export declare const knowledgeInputSignalSchema: z.ZodEnum<{
    consumed: "consumed";
    cited: "cited";
    validated: "validated";
    contradicted: "contradicted";
}>;
export declare const knowledgeInputSchema: z.ZodObject<{
    knowledge_id: z.ZodString;
    signal: z.ZodEnum<{
        consumed: "consumed";
        cited: "cited";
        validated: "validated";
        contradicted: "contradicted";
    }>;
    source: z.ZodEnum<{
        search: "search";
        manual: "manual";
        load: "load";
        injection: "injection";
    }>;
    count: z.ZodNumber;
    first_recorded_at: z.ZodString;
    last_recorded_at: z.ZodString;
    evidence: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const sessionKnowledgeCandidateSourceSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
    candidate_version: z.ZodLiteral<1>;
    session_id: z.ZodString;
    observed_activity_revision: z.ZodNumber;
    content_hash: z.ZodString;
    evidence_roots: z.ZodArray<z.ZodString>;
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
}, z.core.$strict>;
export declare const legacyKnowledgePromotionReceiptSchema: z.ZodObject<{
    outcome: z.ZodEnum<{
        created: "created";
        reaffirmed: "reaffirmed";
    }>;
    promoted_at: z.ZodString;
    content_hash: z.ZodString;
}, z.core.$strict>;
export declare const knowledgePromotionIntentV11Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"knowledge-promotion-intent/1.1">;
    planned_id: z.ZodString;
    target_repo_id: z.ZodString;
    payload_hash: z.ZodString;
    started_at: z.ZodString;
}, z.core.$strict>;
export declare const knowledgePromotionReceiptV11Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"knowledge-promotion-receipt/1.1">;
    outcome: z.ZodEnum<{
        created: "created";
        reaffirmed: "reaffirmed";
    }>;
    promoted_at: z.ZodString;
    content_hash: z.ZodString;
    target_repo_id: z.ZodString;
    target_workspace_id: z.ZodString;
    target_alias_snapshot: z.ZodString;
    planned_id: z.ZodString;
    acknowledged_payload_hash: z.ZodString;
}, z.core.$strict>;
export declare const legacyKnowledgeCandidateSchema: z.ZodObject<{
    candidate_id: z.ZodString;
    target: z.ZodEnum<{
        spec: "spec";
        knowhow: "knowhow";
    }>;
    action: z.ZodEnum<{
        supersede: "supersede";
        propose: "propose";
        reaffirm: "reaffirm";
        contest: "contest";
    }>;
    title: z.ZodString;
    content: z.ZodString;
    category: z.ZodNullable<z.ZodString>;
    source_kind: z.ZodEnum<{
        manual: "manual";
        decision: "decision";
        constraint: "constraint";
    }>;
    evidence_refs: z.ZodArray<z.ZodString>;
    occurrences: z.ZodNumber;
    first_recorded_at: z.ZodString;
    last_recorded_at: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        rejected: "rejected";
        promoted: "promoted";
        promoting: "promoting";
    }>;
    promoted_id: z.ZodNullable<z.ZodString>;
    promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        outcome: z.ZodEnum<{
            created: "created";
            reaffirmed: "reaffirmed";
        }>;
        promoted_at: z.ZodString;
        content_hash: z.ZodString;
    }, z.core.$strict>>>;
    source_snapshot: z.ZodOptional<z.ZodObject<{
        schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
        candidate_version: z.ZodLiteral<1>;
        session_id: z.ZodString;
        observed_activity_revision: z.ZodNumber;
        content_hash: z.ZodString;
        evidence_roots: z.ZodArray<z.ZodString>;
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
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const candidateRepositoryBindingV11Schema: z.ZodObject<{
    source_repo_id: z.ZodString;
    source_workspace_id: z.ZodString;
    target_repo_id: z.ZodString;
    target_alias_snapshot: z.ZodString;
}, z.core.$strict>;
export declare const canonicalKnowledgeCandidatePayloadV11Schema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"spec">;
    category: z.ZodEnum<{
        learning: "learning";
        review: "review";
        test: "test";
        debug: "debug";
        coding: "coding";
        arch: "arch";
        ui: "ui";
    }>;
    title: z.ZodString;
    content: z.ZodString;
    keywords: z.ZodArray<z.ZodString>;
    sourceRef: z.ZodNullable<z.ZodString>;
    relatedPaths: z.ZodArray<z.ZodString>;
    appliesToRepoIds: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"knowhow">;
    type: z.ZodEnum<{
        session: "session";
        template: "template";
        decision: "decision";
        reference: "reference";
        blueprint: "blueprint";
        tip: "tip";
        recipe: "recipe";
        asset: "asset";
        document: "document";
    }>;
    title: z.ZodString;
    content: z.ZodString;
    keywords: z.ZodArray<z.ZodString>;
    category: z.ZodNullable<z.ZodEnum<{
        learning: "learning";
        review: "review";
        test: "test";
        debug: "debug";
        coding: "coding";
        arch: "arch";
        ui: "ui";
    }>>;
    sourceRef: z.ZodNullable<z.ZodString>;
    relatedPaths: z.ZodArray<z.ZodString>;
    appliesToRepoIds: z.ZodArray<z.ZodString>;
    summary: z.ZodString;
    language: z.ZodNullable<z.ZodString>;
    decisionState: z.ZodNullable<z.ZodEnum<{
        superseded: "superseded";
        accepted: "accepted";
        proposed: "proposed";
    }>>;
    lifecycleStatus: z.ZodEnum<{
        active: "active";
        deprecated: "deprecated";
    }>;
    tool: z.ZodBoolean;
}, z.core.$strict>], "kind">;
export declare const knowledgeCandidateV11Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"knowledge-candidate/1.1">;
    candidate_id: z.ZodString;
    repository_binding: z.ZodObject<{
        source_repo_id: z.ZodString;
        source_workspace_id: z.ZodString;
        target_repo_id: z.ZodString;
        target_alias_snapshot: z.ZodString;
    }, z.core.$strict>;
    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"spec">;
        category: z.ZodEnum<{
            learning: "learning";
            review: "review";
            test: "test";
            debug: "debug";
            coding: "coding";
            arch: "arch";
            ui: "ui";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        keywords: z.ZodArray<z.ZodString>;
        sourceRef: z.ZodNullable<z.ZodString>;
        relatedPaths: z.ZodArray<z.ZodString>;
        appliesToRepoIds: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"knowhow">;
        type: z.ZodEnum<{
            session: "session";
            template: "template";
            decision: "decision";
            reference: "reference";
            blueprint: "blueprint";
            tip: "tip";
            recipe: "recipe";
            asset: "asset";
            document: "document";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        keywords: z.ZodArray<z.ZodString>;
        category: z.ZodNullable<z.ZodEnum<{
            learning: "learning";
            review: "review";
            test: "test";
            debug: "debug";
            coding: "coding";
            arch: "arch";
            ui: "ui";
        }>>;
        sourceRef: z.ZodNullable<z.ZodString>;
        relatedPaths: z.ZodArray<z.ZodString>;
        appliesToRepoIds: z.ZodArray<z.ZodString>;
        summary: z.ZodString;
        language: z.ZodNullable<z.ZodString>;
        decisionState: z.ZodNullable<z.ZodEnum<{
            superseded: "superseded";
            accepted: "accepted";
            proposed: "proposed";
        }>>;
        lifecycleStatus: z.ZodEnum<{
            active: "active";
            deprecated: "deprecated";
        }>;
        tool: z.ZodBoolean;
    }, z.core.$strict>], "kind">;
    target: z.ZodEnum<{
        spec: "spec";
        knowhow: "knowhow";
    }>;
    action: z.ZodEnum<{
        supersede: "supersede";
        propose: "propose";
        reaffirm: "reaffirm";
        contest: "contest";
    }>;
    title: z.ZodString;
    content: z.ZodString;
    category: z.ZodNullable<z.ZodString>;
    source_kind: z.ZodEnum<{
        manual: "manual";
        decision: "decision";
        constraint: "constraint";
    }>;
    evidence_refs: z.ZodArray<z.ZodString>;
    occurrences: z.ZodNumber;
    first_recorded_at: z.ZodString;
    last_recorded_at: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        rejected: "rejected";
        promoted: "promoted";
        promoting: "promoting";
    }>;
    promoted_id: z.ZodNullable<z.ZodString>;
    promotion_intent: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"knowledge-promotion-intent/1.1">;
        planned_id: z.ZodString;
        target_repo_id: z.ZodString;
        payload_hash: z.ZodString;
        started_at: z.ZodString;
    }, z.core.$strict>>>;
    promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"knowledge-promotion-receipt/1.1">;
        outcome: z.ZodEnum<{
            created: "created";
            reaffirmed: "reaffirmed";
        }>;
        promoted_at: z.ZodString;
        content_hash: z.ZodString;
        target_repo_id: z.ZodString;
        target_workspace_id: z.ZodString;
        target_alias_snapshot: z.ZodString;
        planned_id: z.ZodString;
        acknowledged_payload_hash: z.ZodString;
    }, z.core.$strict>>>;
    source_snapshot: z.ZodOptional<z.ZodObject<{
        schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
        candidate_version: z.ZodLiteral<1>;
        session_id: z.ZodString;
        observed_activity_revision: z.ZodNumber;
        content_hash: z.ZodString;
        evidence_roots: z.ZodArray<z.ZodString>;
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
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const knowledgeCandidateSchema: z.ZodUnion<readonly [z.ZodObject<{
    schema_version: z.ZodLiteral<"knowledge-candidate/1.1">;
    candidate_id: z.ZodString;
    repository_binding: z.ZodObject<{
        source_repo_id: z.ZodString;
        source_workspace_id: z.ZodString;
        target_repo_id: z.ZodString;
        target_alias_snapshot: z.ZodString;
    }, z.core.$strict>;
    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"spec">;
        category: z.ZodEnum<{
            learning: "learning";
            review: "review";
            test: "test";
            debug: "debug";
            coding: "coding";
            arch: "arch";
            ui: "ui";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        keywords: z.ZodArray<z.ZodString>;
        sourceRef: z.ZodNullable<z.ZodString>;
        relatedPaths: z.ZodArray<z.ZodString>;
        appliesToRepoIds: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"knowhow">;
        type: z.ZodEnum<{
            session: "session";
            template: "template";
            decision: "decision";
            reference: "reference";
            blueprint: "blueprint";
            tip: "tip";
            recipe: "recipe";
            asset: "asset";
            document: "document";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        keywords: z.ZodArray<z.ZodString>;
        category: z.ZodNullable<z.ZodEnum<{
            learning: "learning";
            review: "review";
            test: "test";
            debug: "debug";
            coding: "coding";
            arch: "arch";
            ui: "ui";
        }>>;
        sourceRef: z.ZodNullable<z.ZodString>;
        relatedPaths: z.ZodArray<z.ZodString>;
        appliesToRepoIds: z.ZodArray<z.ZodString>;
        summary: z.ZodString;
        language: z.ZodNullable<z.ZodString>;
        decisionState: z.ZodNullable<z.ZodEnum<{
            superseded: "superseded";
            accepted: "accepted";
            proposed: "proposed";
        }>>;
        lifecycleStatus: z.ZodEnum<{
            active: "active";
            deprecated: "deprecated";
        }>;
        tool: z.ZodBoolean;
    }, z.core.$strict>], "kind">;
    target: z.ZodEnum<{
        spec: "spec";
        knowhow: "knowhow";
    }>;
    action: z.ZodEnum<{
        supersede: "supersede";
        propose: "propose";
        reaffirm: "reaffirm";
        contest: "contest";
    }>;
    title: z.ZodString;
    content: z.ZodString;
    category: z.ZodNullable<z.ZodString>;
    source_kind: z.ZodEnum<{
        manual: "manual";
        decision: "decision";
        constraint: "constraint";
    }>;
    evidence_refs: z.ZodArray<z.ZodString>;
    occurrences: z.ZodNumber;
    first_recorded_at: z.ZodString;
    last_recorded_at: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        rejected: "rejected";
        promoted: "promoted";
        promoting: "promoting";
    }>;
    promoted_id: z.ZodNullable<z.ZodString>;
    promotion_intent: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"knowledge-promotion-intent/1.1">;
        planned_id: z.ZodString;
        target_repo_id: z.ZodString;
        payload_hash: z.ZodString;
        started_at: z.ZodString;
    }, z.core.$strict>>>;
    promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"knowledge-promotion-receipt/1.1">;
        outcome: z.ZodEnum<{
            created: "created";
            reaffirmed: "reaffirmed";
        }>;
        promoted_at: z.ZodString;
        content_hash: z.ZodString;
        target_repo_id: z.ZodString;
        target_workspace_id: z.ZodString;
        target_alias_snapshot: z.ZodString;
        planned_id: z.ZodString;
        acknowledged_payload_hash: z.ZodString;
    }, z.core.$strict>>>;
    source_snapshot: z.ZodOptional<z.ZodObject<{
        schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
        candidate_version: z.ZodLiteral<1>;
        session_id: z.ZodString;
        observed_activity_revision: z.ZodNumber;
        content_hash: z.ZodString;
        evidence_roots: z.ZodArray<z.ZodString>;
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
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    candidate_id: z.ZodString;
    target: z.ZodEnum<{
        spec: "spec";
        knowhow: "knowhow";
    }>;
    action: z.ZodEnum<{
        supersede: "supersede";
        propose: "propose";
        reaffirm: "reaffirm";
        contest: "contest";
    }>;
    title: z.ZodString;
    content: z.ZodString;
    category: z.ZodNullable<z.ZodString>;
    source_kind: z.ZodEnum<{
        manual: "manual";
        decision: "decision";
        constraint: "constraint";
    }>;
    evidence_refs: z.ZodArray<z.ZodString>;
    occurrences: z.ZodNumber;
    first_recorded_at: z.ZodString;
    last_recorded_at: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        rejected: "rejected";
        promoted: "promoted";
        promoting: "promoting";
    }>;
    promoted_id: z.ZodNullable<z.ZodString>;
    promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        outcome: z.ZodEnum<{
            created: "created";
            reaffirmed: "reaffirmed";
        }>;
        promoted_at: z.ZodString;
        content_hash: z.ZodString;
    }, z.core.$strict>>>;
    source_snapshot: z.ZodOptional<z.ZodObject<{
        schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
        candidate_version: z.ZodLiteral<1>;
        session_id: z.ZodString;
        observed_activity_revision: z.ZodNumber;
        content_hash: z.ZodString;
        evidence_roots: z.ZodArray<z.ZodString>;
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
    }, z.core.$strict>>;
}, z.core.$strict>]>;
export type KnowledgeInputSource = z.infer<typeof knowledgeInputSchema>['source'];
export type KnowledgeInput = z.infer<typeof knowledgeInputSchema>;
export interface KnowledgeLedgerDraft {
    schema_version?: string;
    source_repository?: {
        repo_id: string;
        workspace_id: string;
    };
    inputs: KnowledgeInput[];
    candidates: KnowledgeCandidate[];
}
export declare const runKnowledgeDeltaV10Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"run-knowledge-delta/1.0">;
    session_id: z.ZodString;
    run_id: z.ZodString;
    revision: z.ZodNumber;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    inputs: z.ZodArray<z.ZodObject<{
        knowledge_id: z.ZodString;
        signal: z.ZodEnum<{
            consumed: "consumed";
            cited: "cited";
            validated: "validated";
            contradicted: "contradicted";
        }>;
        source: z.ZodEnum<{
            search: "search";
            manual: "manual";
            load: "load";
            injection: "injection";
        }>;
        count: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        evidence: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    candidates: z.ZodArray<z.ZodObject<{
        candidate_id: z.ZodString;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const runKnowledgeDeltaV11Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"run-knowledge-delta/1.1">;
    session_id: z.ZodString;
    run_id: z.ZodString;
    source_repository: z.ZodObject<{
        repo_id: z.ZodString;
        workspace_id: z.ZodString;
    }, z.core.$strict>;
    revision: z.ZodNumber;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    inputs: z.ZodArray<z.ZodObject<{
        knowledge_id: z.ZodString;
        signal: z.ZodEnum<{
            consumed: "consumed";
            cited: "cited";
            validated: "validated";
            contradicted: "contradicted";
        }>;
        source: z.ZodEnum<{
            search: "search";
            manual: "manual";
            load: "load";
            injection: "injection";
        }>;
        count: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        evidence: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    candidates: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        schema_version: z.ZodLiteral<"knowledge-candidate/1.1">;
        candidate_id: z.ZodString;
        repository_binding: z.ZodObject<{
            source_repo_id: z.ZodString;
            source_workspace_id: z.ZodString;
            target_repo_id: z.ZodString;
            target_alias_snapshot: z.ZodString;
        }, z.core.$strict>;
        payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"spec">;
            category: z.ZodEnum<{
                learning: "learning";
                review: "review";
                test: "test";
                debug: "debug";
                coding: "coding";
                arch: "arch";
                ui: "ui";
            }>;
            title: z.ZodString;
            content: z.ZodString;
            keywords: z.ZodArray<z.ZodString>;
            sourceRef: z.ZodNullable<z.ZodString>;
            relatedPaths: z.ZodArray<z.ZodString>;
            appliesToRepoIds: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"knowhow">;
            type: z.ZodEnum<{
                session: "session";
                template: "template";
                decision: "decision";
                reference: "reference";
                blueprint: "blueprint";
                tip: "tip";
                recipe: "recipe";
                asset: "asset";
                document: "document";
            }>;
            title: z.ZodString;
            content: z.ZodString;
            keywords: z.ZodArray<z.ZodString>;
            category: z.ZodNullable<z.ZodEnum<{
                learning: "learning";
                review: "review";
                test: "test";
                debug: "debug";
                coding: "coding";
                arch: "arch";
                ui: "ui";
            }>>;
            sourceRef: z.ZodNullable<z.ZodString>;
            relatedPaths: z.ZodArray<z.ZodString>;
            appliesToRepoIds: z.ZodArray<z.ZodString>;
            summary: z.ZodString;
            language: z.ZodNullable<z.ZodString>;
            decisionState: z.ZodNullable<z.ZodEnum<{
                superseded: "superseded";
                accepted: "accepted";
                proposed: "proposed";
            }>>;
            lifecycleStatus: z.ZodEnum<{
                active: "active";
                deprecated: "deprecated";
            }>;
            tool: z.ZodBoolean;
        }, z.core.$strict>], "kind">;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_intent: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            schema_version: z.ZodLiteral<"knowledge-promotion-intent/1.1">;
            planned_id: z.ZodString;
            target_repo_id: z.ZodString;
            payload_hash: z.ZodString;
            started_at: z.ZodString;
        }, z.core.$strict>>>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            schema_version: z.ZodLiteral<"knowledge-promotion-receipt/1.1">;
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
            target_repo_id: z.ZodString;
            target_workspace_id: z.ZodString;
            target_alias_snapshot: z.ZodString;
            planned_id: z.ZodString;
            acknowledged_payload_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        candidate_id: z.ZodString;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export declare const runKnowledgeDeltaSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    schema_version: z.ZodLiteral<"run-knowledge-delta/1.0">;
    session_id: z.ZodString;
    run_id: z.ZodString;
    revision: z.ZodNumber;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    inputs: z.ZodArray<z.ZodObject<{
        knowledge_id: z.ZodString;
        signal: z.ZodEnum<{
            consumed: "consumed";
            cited: "cited";
            validated: "validated";
            contradicted: "contradicted";
        }>;
        source: z.ZodEnum<{
            search: "search";
            manual: "manual";
            load: "load";
            injection: "injection";
        }>;
        count: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        evidence: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    candidates: z.ZodArray<z.ZodObject<{
        candidate_id: z.ZodString;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodLiteral<"run-knowledge-delta/1.1">;
    session_id: z.ZodString;
    run_id: z.ZodString;
    source_repository: z.ZodObject<{
        repo_id: z.ZodString;
        workspace_id: z.ZodString;
    }, z.core.$strict>;
    revision: z.ZodNumber;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    inputs: z.ZodArray<z.ZodObject<{
        knowledge_id: z.ZodString;
        signal: z.ZodEnum<{
            consumed: "consumed";
            cited: "cited";
            validated: "validated";
            contradicted: "contradicted";
        }>;
        source: z.ZodEnum<{
            search: "search";
            manual: "manual";
            load: "load";
            injection: "injection";
        }>;
        count: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        evidence: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    candidates: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        schema_version: z.ZodLiteral<"knowledge-candidate/1.1">;
        candidate_id: z.ZodString;
        repository_binding: z.ZodObject<{
            source_repo_id: z.ZodString;
            source_workspace_id: z.ZodString;
            target_repo_id: z.ZodString;
            target_alias_snapshot: z.ZodString;
        }, z.core.$strict>;
        payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"spec">;
            category: z.ZodEnum<{
                learning: "learning";
                review: "review";
                test: "test";
                debug: "debug";
                coding: "coding";
                arch: "arch";
                ui: "ui";
            }>;
            title: z.ZodString;
            content: z.ZodString;
            keywords: z.ZodArray<z.ZodString>;
            sourceRef: z.ZodNullable<z.ZodString>;
            relatedPaths: z.ZodArray<z.ZodString>;
            appliesToRepoIds: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"knowhow">;
            type: z.ZodEnum<{
                session: "session";
                template: "template";
                decision: "decision";
                reference: "reference";
                blueprint: "blueprint";
                tip: "tip";
                recipe: "recipe";
                asset: "asset";
                document: "document";
            }>;
            title: z.ZodString;
            content: z.ZodString;
            keywords: z.ZodArray<z.ZodString>;
            category: z.ZodNullable<z.ZodEnum<{
                learning: "learning";
                review: "review";
                test: "test";
                debug: "debug";
                coding: "coding";
                arch: "arch";
                ui: "ui";
            }>>;
            sourceRef: z.ZodNullable<z.ZodString>;
            relatedPaths: z.ZodArray<z.ZodString>;
            appliesToRepoIds: z.ZodArray<z.ZodString>;
            summary: z.ZodString;
            language: z.ZodNullable<z.ZodString>;
            decisionState: z.ZodNullable<z.ZodEnum<{
                superseded: "superseded";
                accepted: "accepted";
                proposed: "proposed";
            }>>;
            lifecycleStatus: z.ZodEnum<{
                active: "active";
                deprecated: "deprecated";
            }>;
            tool: z.ZodBoolean;
        }, z.core.$strict>], "kind">;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_intent: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            schema_version: z.ZodLiteral<"knowledge-promotion-intent/1.1">;
            planned_id: z.ZodString;
            target_repo_id: z.ZodString;
            payload_hash: z.ZodString;
            started_at: z.ZodString;
        }, z.core.$strict>>>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            schema_version: z.ZodLiteral<"knowledge-promotion-receipt/1.1">;
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
            target_repo_id: z.ZodString;
            target_workspace_id: z.ZodString;
            target_alias_snapshot: z.ZodString;
            planned_id: z.ZodString;
            acknowledged_payload_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        candidate_id: z.ZodString;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>]>>;
}, z.core.$strict>], "schema_version">;
export declare const sessionKnowledgeDeltaV10Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"session-knowledge-delta/1.0">;
    session_id: z.ZodString;
    revision: z.ZodNumber;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    inputs: z.ZodArray<z.ZodObject<{
        knowledge_id: z.ZodString;
        signal: z.ZodEnum<{
            consumed: "consumed";
            cited: "cited";
            validated: "validated";
            contradicted: "contradicted";
        }>;
        source: z.ZodEnum<{
            search: "search";
            manual: "manual";
            load: "load";
            injection: "injection";
        }>;
        count: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        evidence: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    candidates: z.ZodArray<z.ZodObject<{
        candidate_id: z.ZodString;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const sessionKnowledgeDeltaV11Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"session-knowledge-delta/1.1">;
    session_id: z.ZodString;
    source_repository: z.ZodObject<{
        repo_id: z.ZodString;
        workspace_id: z.ZodString;
    }, z.core.$strict>;
    revision: z.ZodNumber;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    inputs: z.ZodArray<z.ZodObject<{
        knowledge_id: z.ZodString;
        signal: z.ZodEnum<{
            consumed: "consumed";
            cited: "cited";
            validated: "validated";
            contradicted: "contradicted";
        }>;
        source: z.ZodEnum<{
            search: "search";
            manual: "manual";
            load: "load";
            injection: "injection";
        }>;
        count: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        evidence: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    candidates: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        schema_version: z.ZodLiteral<"knowledge-candidate/1.1">;
        candidate_id: z.ZodString;
        repository_binding: z.ZodObject<{
            source_repo_id: z.ZodString;
            source_workspace_id: z.ZodString;
            target_repo_id: z.ZodString;
            target_alias_snapshot: z.ZodString;
        }, z.core.$strict>;
        payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"spec">;
            category: z.ZodEnum<{
                learning: "learning";
                review: "review";
                test: "test";
                debug: "debug";
                coding: "coding";
                arch: "arch";
                ui: "ui";
            }>;
            title: z.ZodString;
            content: z.ZodString;
            keywords: z.ZodArray<z.ZodString>;
            sourceRef: z.ZodNullable<z.ZodString>;
            relatedPaths: z.ZodArray<z.ZodString>;
            appliesToRepoIds: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"knowhow">;
            type: z.ZodEnum<{
                session: "session";
                template: "template";
                decision: "decision";
                reference: "reference";
                blueprint: "blueprint";
                tip: "tip";
                recipe: "recipe";
                asset: "asset";
                document: "document";
            }>;
            title: z.ZodString;
            content: z.ZodString;
            keywords: z.ZodArray<z.ZodString>;
            category: z.ZodNullable<z.ZodEnum<{
                learning: "learning";
                review: "review";
                test: "test";
                debug: "debug";
                coding: "coding";
                arch: "arch";
                ui: "ui";
            }>>;
            sourceRef: z.ZodNullable<z.ZodString>;
            relatedPaths: z.ZodArray<z.ZodString>;
            appliesToRepoIds: z.ZodArray<z.ZodString>;
            summary: z.ZodString;
            language: z.ZodNullable<z.ZodString>;
            decisionState: z.ZodNullable<z.ZodEnum<{
                superseded: "superseded";
                accepted: "accepted";
                proposed: "proposed";
            }>>;
            lifecycleStatus: z.ZodEnum<{
                active: "active";
                deprecated: "deprecated";
            }>;
            tool: z.ZodBoolean;
        }, z.core.$strict>], "kind">;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_intent: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            schema_version: z.ZodLiteral<"knowledge-promotion-intent/1.1">;
            planned_id: z.ZodString;
            target_repo_id: z.ZodString;
            payload_hash: z.ZodString;
            started_at: z.ZodString;
        }, z.core.$strict>>>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            schema_version: z.ZodLiteral<"knowledge-promotion-receipt/1.1">;
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
            target_repo_id: z.ZodString;
            target_workspace_id: z.ZodString;
            target_alias_snapshot: z.ZodString;
            planned_id: z.ZodString;
            acknowledged_payload_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        candidate_id: z.ZodString;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export declare const sessionKnowledgeDeltaSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    schema_version: z.ZodLiteral<"session-knowledge-delta/1.0">;
    session_id: z.ZodString;
    revision: z.ZodNumber;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    inputs: z.ZodArray<z.ZodObject<{
        knowledge_id: z.ZodString;
        signal: z.ZodEnum<{
            consumed: "consumed";
            cited: "cited";
            validated: "validated";
            contradicted: "contradicted";
        }>;
        source: z.ZodEnum<{
            search: "search";
            manual: "manual";
            load: "load";
            injection: "injection";
        }>;
        count: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        evidence: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    candidates: z.ZodArray<z.ZodObject<{
        candidate_id: z.ZodString;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodLiteral<"session-knowledge-delta/1.1">;
    session_id: z.ZodString;
    source_repository: z.ZodObject<{
        repo_id: z.ZodString;
        workspace_id: z.ZodString;
    }, z.core.$strict>;
    revision: z.ZodNumber;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    inputs: z.ZodArray<z.ZodObject<{
        knowledge_id: z.ZodString;
        signal: z.ZodEnum<{
            consumed: "consumed";
            cited: "cited";
            validated: "validated";
            contradicted: "contradicted";
        }>;
        source: z.ZodEnum<{
            search: "search";
            manual: "manual";
            load: "load";
            injection: "injection";
        }>;
        count: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        evidence: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    candidates: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        schema_version: z.ZodLiteral<"knowledge-candidate/1.1">;
        candidate_id: z.ZodString;
        repository_binding: z.ZodObject<{
            source_repo_id: z.ZodString;
            source_workspace_id: z.ZodString;
            target_repo_id: z.ZodString;
            target_alias_snapshot: z.ZodString;
        }, z.core.$strict>;
        payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"spec">;
            category: z.ZodEnum<{
                learning: "learning";
                review: "review";
                test: "test";
                debug: "debug";
                coding: "coding";
                arch: "arch";
                ui: "ui";
            }>;
            title: z.ZodString;
            content: z.ZodString;
            keywords: z.ZodArray<z.ZodString>;
            sourceRef: z.ZodNullable<z.ZodString>;
            relatedPaths: z.ZodArray<z.ZodString>;
            appliesToRepoIds: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"knowhow">;
            type: z.ZodEnum<{
                session: "session";
                template: "template";
                decision: "decision";
                reference: "reference";
                blueprint: "blueprint";
                tip: "tip";
                recipe: "recipe";
                asset: "asset";
                document: "document";
            }>;
            title: z.ZodString;
            content: z.ZodString;
            keywords: z.ZodArray<z.ZodString>;
            category: z.ZodNullable<z.ZodEnum<{
                learning: "learning";
                review: "review";
                test: "test";
                debug: "debug";
                coding: "coding";
                arch: "arch";
                ui: "ui";
            }>>;
            sourceRef: z.ZodNullable<z.ZodString>;
            relatedPaths: z.ZodArray<z.ZodString>;
            appliesToRepoIds: z.ZodArray<z.ZodString>;
            summary: z.ZodString;
            language: z.ZodNullable<z.ZodString>;
            decisionState: z.ZodNullable<z.ZodEnum<{
                superseded: "superseded";
                accepted: "accepted";
                proposed: "proposed";
            }>>;
            lifecycleStatus: z.ZodEnum<{
                active: "active";
                deprecated: "deprecated";
            }>;
            tool: z.ZodBoolean;
        }, z.core.$strict>], "kind">;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_intent: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            schema_version: z.ZodLiteral<"knowledge-promotion-intent/1.1">;
            planned_id: z.ZodString;
            target_repo_id: z.ZodString;
            payload_hash: z.ZodString;
            started_at: z.ZodString;
        }, z.core.$strict>>>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            schema_version: z.ZodLiteral<"knowledge-promotion-receipt/1.1">;
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
            target_repo_id: z.ZodString;
            target_workspace_id: z.ZodString;
            target_alias_snapshot: z.ZodString;
            planned_id: z.ZodString;
            acknowledged_payload_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        candidate_id: z.ZodString;
        target: z.ZodEnum<{
            spec: "spec";
            knowhow: "knowhow";
        }>;
        action: z.ZodEnum<{
            supersede: "supersede";
            propose: "propose";
            reaffirm: "reaffirm";
            contest: "contest";
        }>;
        title: z.ZodString;
        content: z.ZodString;
        category: z.ZodNullable<z.ZodString>;
        source_kind: z.ZodEnum<{
            manual: "manual";
            decision: "decision";
            constraint: "constraint";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
        occurrences: z.ZodNumber;
        first_recorded_at: z.ZodString;
        last_recorded_at: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            rejected: "rejected";
            promoted: "promoted";
            promoting: "promoting";
        }>;
        promoted_id: z.ZodNullable<z.ZodString>;
        promotion_receipt: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            outcome: z.ZodEnum<{
                created: "created";
                reaffirmed: "reaffirmed";
            }>;
            promoted_at: z.ZodString;
            content_hash: z.ZodString;
        }, z.core.$strict>>>;
        source_snapshot: z.ZodOptional<z.ZodObject<{
            schema_version: z.ZodLiteral<"session-knowledge-candidate-source/1.0">;
            candidate_version: z.ZodLiteral<1>;
            session_id: z.ZodString;
            observed_activity_revision: z.ZodNumber;
            content_hash: z.ZodString;
            evidence_roots: z.ZodArray<z.ZodString>;
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
        }, z.core.$strict>>;
    }, z.core.$strict>]>>;
}, z.core.$strict>], "schema_version">;
export type RunKnowledgeDelta = z.infer<typeof runKnowledgeDeltaSchema>;
export type SessionKnowledgeDelta = z.infer<typeof sessionKnowledgeDeltaSchema>;
export type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>;
export type KnowledgeCandidateV11 = z.infer<typeof knowledgeCandidateV11Schema>;
export type CanonicalKnowledgeCandidatePayloadV11 = z.infer<typeof canonicalKnowledgeCandidatePayloadV11Schema>;
export type SessionKnowledgeCandidateSource = z.infer<typeof sessionKnowledgeCandidateSourceSchema>;
export type SessionKnowledgeEvidenceRoot = z.infer<typeof sessionKnowledgeEvidenceRootSchema>;
export type KnowledgeInputSignal = z.infer<typeof knowledgeInputSignalSchema>;
export interface SessionKnowledgeSummary {
    schema_version: 'session-knowledge-summary/1.0';
    session_id: string;
    run_count: number;
    ledger_count: number;
    input_totals: Record<KnowledgeInputSignal, number>;
    /** Signal totals broken down by attribution source (load/search/injection/manual). */
    input_totals_by_source: Record<KnowledgeInputSource, Record<KnowledgeInputSignal, number>>;
    /** Knowledge-id-level attribution detail, in ledger order. */
    inputs: Array<{
        run_id: string;
        /** Origin of the attribution ledger ('session' for session-level deltas). */
        origin?: 'run' | 'session';
        knowledge_id: string;
        signal: KnowledgeInputSignal;
        source: KnowledgeInputSource;
        count: number;
        evidence?: string[];
    }>;
    unique_inputs: number;
    candidates: Array<KnowledgeCandidate & {
        run_ids: string[];
        /** Origin of the candidate ledger ('session' for session-level deltas). */
        origin?: 'run' | 'session';
        stage: 'observed' | 'corroborated';
    }>;
}
export interface PromoteSessionKnowledgeOptions {
    candidateIds?: string[];
    all?: boolean;
    /** Optional human selector used only to assert the already-frozen target. */
    targetRepository?: string;
    /** Internal deterministic interleaving hook used by focused CAS tests. */
    _beforeFinalSessionValidation?: () => void;
    /** Wrapper-supplied corpus/receipt validator, executed under the final store lock. */
    _finalSessionValidation?: (store: SessionStore) => void;
    /** Internal crash-saga hook: fires after a durable target write and acknowledgment. */
    _afterTargetWrite?: (candidateId: string) => void;
}
export interface KnowledgePromotionResult {
    schema_version: 'knowledge-promotion-result/1.0';
    session_id: string;
    promoted: Array<{
        candidate_id: string;
        target: KnowledgeCandidate['target'];
        promoted_id: string;
        outcome: 'created' | 'reaffirmed';
    }>;
    already_promoted: Array<{
        candidate_id: string;
        promoted_id: string;
    }>;
    skipped_observed: string[];
    skipped_review_required: string[];
    skipped_suppressed: string[];
    skipped_blocked: string[];
}
export interface KnowledgeReconciliationCard {
    schema_version: 'knowledge-reconciliation-card/1.0';
    run: {
        unique_inputs: number;
        signals: Record<KnowledgeInputSignal, number>;
        knowledge_ids: string[];
    };
    session: {
        unique_inputs: number;
        pending_candidates: number;
        corroborated_candidates: number;
        promoting_candidates: number;
        promoted_candidates: number;
    };
    policy: {
        search_and_injection: 'exposure_only';
        explicit_load: 'consumed';
        record: 'explicit_attribution';
        completion: 'stage_candidates';
        promotion: 'explicit_review';
    };
    review: {
        command: string;
        promote_template: string;
    };
    reconciliation?: {
        status: 'missing' | 'fresh' | 'stale';
        duplicates: number;
        conflicts: number;
        review_required: number;
        suppressed: number;
        command: string;
    };
}
export interface KnowledgeCandidateReceipt {
    schema_version: 'knowledge-candidate-receipt/1.0';
    staged_candidate_ids: string[];
    staged_count: number;
    review_command: string;
    promote_template: string;
}
export declare function sourceRepositoryBinding(projectRoot: string): {
    repo_id: string;
    workspace_id: string;
} | null;
export declare function createSessionDelta(sessionId: string, now?: string, sourceRepository?: {
    repo_id: string;
    workspace_id: string;
} | null): SessionKnowledgeDelta;
export declare function runKnowledgeDeltaPath(store: SessionStore, sessionId: string, runId: string): string;
export declare function sessionKnowledgeDeltaPath(store: SessionStore, sessionId: string): string;
export declare function readSessionKnowledgeDelta(store: SessionStore, sessionId: string, readOnly?: boolean): SessionKnowledgeDelta;
export declare const SESSION_RECONCILIATION_RUN_ID = "session";
export declare function sessionReconciliationPath(store: SessionStore, sessionId: string): string;
export declare function readSessionKnowledgeReconciliation(store: SessionStore, sessionId: string, readOnly?: boolean): KnowledgeReconciliation | null;
/**
 * Snapshot hash over pending session-ledger candidates; the session receipt's
 * freshness anchor (mirrors knowledgeCandidateSnapshotHash for run deltas).
 */
export declare function sessionKnowledgeSnapshotHash(delta: SessionKnowledgeDelta): string;
export interface KnowledgeCandidateIdentityV11 {
    targetRepoId: string;
    appliesToRepoIds: string[];
    payload: CanonicalKnowledgeCandidatePayloadV11;
}
export declare function knowledgeCandidateId(targetOrIdentity: KnowledgeCandidate['target'] | KnowledgeCandidateIdentityV11, content?: string): string;
export declare function isKnowledgeCandidateV11(candidate: KnowledgeCandidate): candidate is KnowledgeCandidateV11;
/**
 * Explicit write-time upgrade. Reads never rewrite legacy deltas, and legacy
 * candidate objects are retained byte-for-byte inside the upgraded container.
 */
export declare function upgradeKnowledgeLedgerForStaging(draft: KnowledgeLedgerDraft, source: Pick<RepositoryContext, 'repoId' | 'workspaceId' | 'identityPersisted'> | null, family: 'run' | 'session'): void;
export declare function knowledgeCandidateContentHash(value: string): string;
export declare function knowledgeCandidatePayloadHash(candidate: KnowledgeCandidateV11): string;
export declare function normalizeKnowledgeEvidenceRoots(refs: readonly string[]): string[];
export declare function knowledgeEvidenceRootHash(refs: readonly string[]): string;
export declare function resolveSessionKnowledgeEvidenceRoots(projectRoot: string, store: SessionStore, sessionId: string, refs: readonly string[]): SessionKnowledgeEvidenceRoot[];
export declare function createSessionKnowledgeCandidateSource(projectRoot: string, store: SessionStore, sessionId: string, observedActivityRevision: number, content: string, evidenceRefs: readonly string[]): SessionKnowledgeCandidateSource;
export declare function assertSessionKnowledgeCandidateSource(candidate: KnowledgeCandidate, sessionId: string): SessionKnowledgeCandidateSource;
export declare function revalidateSessionKnowledgeCandidateSource(projectRoot: string, store: SessionStore, candidate: KnowledgeCandidate, sessionId: string): SessionKnowledgeCandidateSource;
export declare function addInput(draft: KnowledgeLedgerDraft, knowledgeId: string, signal: KnowledgeInputSignal, source: z.infer<typeof knowledgeInputSchema>['source'], now: string, evidence?: readonly string[]): void;
export declare function addCandidate(draft: KnowledgeLedgerDraft, input: {
    target: KnowledgeCandidate['target'];
    action: KnowledgeCandidate['action'];
    title: string;
    content: string;
    category: string | null;
    source_kind: KnowledgeCandidate['source_kind'];
    evidence_refs: string[];
    source_snapshot?: SessionKnowledgeCandidateSource;
    target_repository?: Pick<RepositoryContext, 'repoId' | 'workspaceId' | 'alias'>;
    keywords?: string[];
    sourceRef?: string | null;
    relatedPaths?: string[];
    appliesToRepoIds?: string[];
    type?: string | null;
    language?: string | null;
    decisionState?: string | null;
    lifecycleStatus?: string | null;
    tool?: boolean;
}, now: string): string;
export interface KnowledgeCandidateDraft {
    candidate_id: string;
    schema_version?: 'knowledge-candidate/1.1';
    repository_binding?: KnowledgeCandidateV11['repository_binding'];
    payload?: CanonicalKnowledgeCandidatePayloadV11;
    target: KnowledgeCandidate['target'];
    action: KnowledgeCandidate['action'];
    title: string;
    content: string;
    category: string | null;
    source_kind: KnowledgeCandidate['source_kind'];
    evidence_refs: string[];
}
/**
 * Project accepted report decisions and locked constraints without mutating the
 * Run ledger. Reconciliation uses this view before completion; the same facts
 * are persisted by stageHandoffKnowledgeCandidates in the completion transaction.
 */
export declare function reportKnowledgeCandidateDrafts(frontmatter: ReportFrontmatter, runId: string): KnowledgeCandidateDraft[];
/**
 * Stable Run candidate fingerprint shared by reconciliation and v3 promotion
 * recovery. Frontmatter candidates shadow no already-staged candidate with the
 * same deterministic ID, matching the review projection exactly.
 */
export declare function runKnowledgeCandidateSnapshotHash(delta: RunKnowledgeDelta, frontmatter: ReportFrontmatter, runId: string): string;
export declare function readRunKnowledgeDelta(store: SessionStore, sessionId: string, runId: string, readOnly?: boolean): RunKnowledgeDelta;
/**
 * Attach explicit knowledge use to the unique active Run. Ambiguous/no-active
 * cases are intentionally ignored because analytics must never guess authority.
 */
export declare function recordActiveRunKnowledgeInputs(projectRoot: string, knowledgeIds: string[], signal?: KnowledgeInputSignal, source?: z.infer<typeof knowledgeInputSchema>['source']): {
    session_id: string;
    run_id: string;
    recorded: number;
} | null;
export type KnowledgeExecutionAuthority = ExecutionRunSidecarAuthority;
/**
 * Record an explicit knowledge relation against one authoritative active Run.
 * Unlike the best-effort load hook, this command-facing surface fails closed.
 */
export declare function recordRunKnowledgeInputs(projectRoot: string, runId: string, knowledgeIds: string[], signal?: KnowledgeInputSignal, source?: z.infer<typeof knowledgeInputSchema>['source'], sessionId?: string, evidence?: readonly string[], executionAuthority?: KnowledgeExecutionAuthority): {
    session_id: string;
    run_id: string;
    recorded: number;
};
export declare function stageRunKnowledgeCandidate(projectRoot: string, runId: string, input: {
    target: KnowledgeCandidate['target'];
    action?: KnowledgeCandidate['action'];
    title: string;
    content: string;
    category?: string | null;
    evidenceRefs?: string[];
    repository?: string;
    keywords?: string[];
    sourceRef?: string | null;
    relatedPaths?: string[];
    appliesToRepoIds?: string[];
    type?: string | null;
    language?: string | null;
    decisionState?: string | null;
    lifecycleStatus?: string | null;
    tool?: boolean;
}, sessionId?: string, executionAuthority?: KnowledgeExecutionAuthority): {
    session_id: string;
    run_id: string;
    candidate_id: string;
    reused: boolean;
};
/**
 * Convert structured handoff facts into pending candidates in the same atomic
 * SessionStore transaction that seals the Run. No project knowledge is written.
 */
export declare function stageHandoffKnowledgeCandidates(store: SessionStore, tx: StoreTransaction, sessionId: string, run: CommandRun): RunKnowledgeDelta | null;
export declare function summarizeSessionKnowledge(projectRoot: string, sessionId: string, options?: {
    readOnly?: boolean;
    strict?: boolean;
}): SessionKnowledgeSummary;
export declare function buildKnowledgeReconciliationCard(projectRoot: string, sessionId: string, runId: string): KnowledgeReconciliationCard;
export declare function knowledgeCandidateReceipt(sessionId: string, delta: RunKnowledgeDelta | null): KnowledgeCandidateReceipt;
export declare function isTranscriptOnlyEvidenceRefs(refs: readonly string[]): boolean;
/**
 * Promote selected pending candidates. `--all` promotes every eligible pending
 * candidate whose source Runs are sealed; observed-only candidates are promoted
 * with a warning rather than being skipped.
 */
export declare function promoteSessionKnowledge(projectRoot: string, sessionId: string, options: PromoteSessionKnowledgeOptions): KnowledgePromotionResult;
