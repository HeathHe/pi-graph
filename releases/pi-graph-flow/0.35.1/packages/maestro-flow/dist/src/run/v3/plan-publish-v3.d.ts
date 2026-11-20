import { automaticSessionId, derivePlanPublishRequestId } from '../plan-publish.js';
export interface PublishPlanV3Options {
    projectRoot: string;
    sourcePath: string;
    sourceRoot?: string;
    sessionId?: string;
    intent?: string;
    topic?: string;
    handoffKey: string;
    sourcePiSession?: string;
    planRevision?: number;
    approvedAt?: string;
    requestId?: string;
    actor?: string;
    reason?: string;
    evidence?: string[];
}
export interface PublishPlanV3Result {
    schema_version: 'plan-publish-result/1.2';
    session_id: string;
    run_id: string;
    artifact_id: string;
    artifact_path: string;
    handoff_key: string;
    source_checksum: string;
    source_pi_session: string | null;
    plan_revision: number;
    approved_at: string;
    request_id: string;
    created_session: boolean;
    replayed: boolean;
    transition: {
        request_id: string;
        transition_id: string;
        status: 'applied' | 'replayed';
    };
    next: {
        suggest_only: true;
        command: string;
        reason: string;
    };
}
/**
 * Publish an approved Pi Markdown Plan through the v3 Run lifecycle.
 *
 * Programmatic equivalent of:
 *   maestro session open "<intent>" --id <slug> --chain plan-publish ...
 *   maestro run next --session <slug> ...
 *   <write outputs/plan.json>
 *   maestro run complete <run-id> --advance --verdict done ...
 *
 * Returns the sealed artifact identity for the Pi plan-workflow consumers.
 */
export declare function publishPlanV3(options: PublishPlanV3Options): PublishPlanV3Result;
export { derivePlanPublishRequestId, automaticSessionId };
//# sourceMappingURL=plan-publish-v3.d.ts.map