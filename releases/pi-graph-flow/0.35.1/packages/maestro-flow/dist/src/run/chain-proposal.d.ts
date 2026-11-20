import { z } from 'zod';
import type { ArtifactScanResult, DiscoveredArtifact } from './artifacts.js';
import type { ChainEffect, CommandContract } from './contract.js';
import type { CommandRun } from './schemas.js';
import type { SessionBundle } from './store.js';
export declare const chainProposalOperationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    op: z.ZodLiteral<"insert">;
    after: z.ZodString;
    command: z.ZodString;
    args: z.ZodOptional<z.ZodString>;
    stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    decision_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>, z.ZodObject<{
    op: z.ZodLiteral<"replace">;
    step_id: z.ZodString;
    command: z.ZodOptional<z.ZodString>;
    args: z.ZodOptional<z.ZodString>;
    stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>, z.ZodObject<{
    op: z.ZodLiteral<"skip">;
    step_id: z.ZodString;
    reason: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    op: z.ZodLiteral<"decide">;
    point_id: z.ZodString;
    verdict: z.ZodEnum<{
        proceed: "proceed";
        fix: "fix";
        escalate: "escalate";
    }>;
    confidence: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>;
    summary: z.ZodOptional<z.ZodString>;
    evidence: z.ZodOptional<z.ZodString>;
}, z.core.$strict>], "op">;
export declare const chainProposalV10Schema: z.ZodObject<{
    _meta: z.ZodObject<{
        kind: z.ZodLiteral<"chain-proposal">;
        schema: z.ZodLiteral<"chain-proposal/1.0">;
        role: z.ZodOptional<z.ZodEnum<{
            primary: "primary";
            attachment: "attachment";
            evidence: "evidence";
            checkpoint: "checkpoint";
            report: "report";
        }>>;
        alias: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    proposal_id: z.ZodString;
    source: z.ZodObject<{
        session_id: z.ZodString;
        run_id: z.ZodString;
        skill: z.ZodString;
    }, z.core.$strict>;
    reason: z.ZodString;
    operations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        op: z.ZodLiteral<"insert">;
        after: z.ZodString;
        command: z.ZodString;
        args: z.ZodOptional<z.ZodString>;
        stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        decision_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>, z.ZodObject<{
        op: z.ZodLiteral<"replace">;
        step_id: z.ZodString;
        command: z.ZodOptional<z.ZodString>;
        args: z.ZodOptional<z.ZodString>;
        stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>, z.ZodObject<{
        op: z.ZodLiteral<"skip">;
        step_id: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        op: z.ZodLiteral<"decide">;
        point_id: z.ZodString;
        verdict: z.ZodEnum<{
            proceed: "proceed";
            fix: "fix";
            escalate: "escalate";
        }>;
        confidence: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>;
        summary: z.ZodOptional<z.ZodString>;
        evidence: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>], "op">>;
}, z.core.$strict>;
export type ChainProposal = z.infer<typeof chainProposalV10Schema>;
export interface ValidatedChainProposal {
    proposal: ChainProposal;
    artifact: DiscoveredArtifact;
    path: string;
}
export interface AppliedChainProposalOperation {
    op: ChainEffect;
    target: string;
    status: string;
}
export declare function applyChainProposal(draft: SessionBundle, proposal: ChainProposal): AppliedChainProposalOperation[];
export declare function validateChainProposalArtifacts(runDir: string, bundle: SessionBundle, run: CommandRun, contract: CommandContract, scan: ArtifactScanResult, options?: {
    preflight?: boolean;
    validateCommand?: (command: string, args: string[]) => void;
}): ValidatedChainProposal[];
export declare function selectChainProposal(runDir: string, requestedPath: string, proposals: readonly ValidatedChainProposal[]): ValidatedChainProposal;
//# sourceMappingURL=chain-proposal.d.ts.map