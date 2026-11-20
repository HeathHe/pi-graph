import { z } from 'zod';
export declare const boundaryContractSchema: z.ZodObject<{
    in_scope: z.ZodArray<z.ZodString>;
    out_of_scope: z.ZodArray<z.ZodString>;
    constraints: z.ZodArray<z.ZodString>;
    definition_of_done: z.ZodString;
}, z.core.$strict>;
export declare const pendingRetryTokenSchema: z.ZodObject<{
    token: z.ZodString;
    session_id: z.ZodString;
    parent_run_id: z.ZodString;
    chain_step_id: z.ZodString;
    command: z.ZodString;
    issued_at: z.ZodString;
    expires_at: z.ZodString;
}, z.core.$strict>;
export declare const orchestrationStepStatusSchema: z.ZodEnum<{
    running: "running";
    completed: "completed";
    failed: "failed";
    skipped: "skipped";
    pending: "pending";
    sealed: "sealed";
}>;
declare const orchestrationStepSchema: z.ZodObject<{
    step_id: z.ZodString;
    command: z.ZodString;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        skipped: "skipped";
        pending: "pending";
        sealed: "sealed";
    }>;
    run_id: z.ZodNullable<z.ZodString>;
    inserted_by: z.ZodString;
    decision_ref: z.ZodNullable<z.ZodString>;
    args: z.ZodOptional<z.ZodString>;
    stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    retry: z.ZodOptional<z.ZodObject<{
        count: z.ZodNumber;
        max: z.ZodNumber;
    }, z.core.$strict>>;
    pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        session_id: z.ZodString;
        parent_run_id: z.ZodString;
        chain_step_id: z.ZodString;
        command: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$strict>;
declare const taskDecompositionItemSchema: z.ZodObject<{
    id: z.ZodString;
    goal: z.ZodString;
    boundary: z.ZodOptional<z.ZodString>;
    done_when: z.ZodOptional<z.ZodString>;
    evidence: z.ZodOptional<z.ZodString>;
    lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
    status: z.ZodEnum<{
        pending: "pending";
        superseded: "superseded";
        done: "done";
    }>;
    completion_confirmed: z.ZodOptional<z.ZodBoolean>;
    completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
declare const goalChangelogEntrySchema: z.ZodObject<{
    id: z.ZodString;
    timestamp: z.ZodString;
    change_type: z.ZodEnum<{
        modify: "modify";
        boundary: "boundary";
        add: "add";
        remove: "remove";
    }>;
    reason: z.ZodString;
    impact_assessment: z.ZodOptional<z.ZodObject<{
        risk_level: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>;
        invalidated_steps: z.ZodArray<z.ZodNumber>;
        new_steps_inserted: z.ZodNumber;
    }, z.core.$strict>>;
    before: z.ZodObject<{
        goals: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            goal: z.ZodString;
            done_when: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        boundary_snippet: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    after: z.ZodObject<{
        goals: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            goal: z.ZodString;
            done_when: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        boundary_snippet: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const positionSchema: z.ZodObject<{
    lifecycle: z.ZodString;
    phase: z.ZodNullable<z.ZodNumber>;
    phase_is_new: z.ZodBoolean;
    milestone: z.ZodString;
    planning_mode: z.ZodNullable<z.ZodString>;
    passed_gates: z.ZodArray<z.ZodString>;
    scope_verdict: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const decompositionSchema: z.ZodObject<{
    execution_criteria: z.ZodArray<z.ZodString>;
    goals: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        goal: z.ZodString;
        boundary: z.ZodOptional<z.ZodString>;
        done_when: z.ZodOptional<z.ZodString>;
        evidence: z.ZodOptional<z.ZodString>;
        lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
        status: z.ZodEnum<{
            pending: "pending";
            superseded: "superseded";
            done: "done";
        }>;
        completion_confirmed: z.ZodOptional<z.ZodBoolean>;
        completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    changelog: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        timestamp: z.ZodString;
        change_type: z.ZodEnum<{
            modify: "modify";
            boundary: "boundary";
            add: "add";
            remove: "remove";
        }>;
        reason: z.ZodString;
        impact_assessment: z.ZodOptional<z.ZodObject<{
            risk_level: z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>;
            invalidated_steps: z.ZodArray<z.ZodNumber>;
            new_steps_inserted: z.ZodNumber;
        }, z.core.$strict>>;
        before: z.ZodObject<{
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                done_when: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            boundary_snippet: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        after: z.ZodObject<{
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                done_when: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            boundary_snippet: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
}, z.core.$strict>;
declare const leaseSchema: z.ZodObject<{
    owner: z.ZodNullable<z.ZodString>;
    epoch: z.ZodNumber;
    id: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
declare const executorSchema: z.ZodObject<{
    platform: z.ZodString;
    cli_tool: z.ZodString;
}, z.core.$strict>;
export declare const decisionPointStatusSchema: z.ZodEnum<{
    pending: "pending";
    passed: "passed";
    escalated: "escalated";
}>;
export declare const executionLeaseSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"execution-lease/1.0">;
    session_id: z.ZodString;
    execution_id: z.ZodString;
    owner_id: z.ZodString;
    owner_kind: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        agy: "agy";
        manual: "manual";
    }>;
    epoch: z.ZodNumber;
    lease_id: z.ZodString;
    acquired_at: z.ZodString;
    heartbeat_at: z.ZodString;
    handoff_to: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const executionStateSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"execution/1.0">;
    execution_id: z.ZodString;
    session_id: z.ZodString;
    generation: z.ZodNumber;
    status: z.ZodEnum<{
        paused: "paused";
        sealed: "sealed";
        active: "active";
    }>;
    revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    chain: z.ZodArray<z.ZodObject<{
        step_id: z.ZodString;
        command: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            completed: "completed";
            failed: "failed";
            skipped: "skipped";
            pending: "pending";
            sealed: "sealed";
        }>;
        run_id: z.ZodNullable<z.ZodString>;
        inserted_by: z.ZodString;
        decision_ref: z.ZodNullable<z.ZodString>;
        args: z.ZodOptional<z.ZodString>;
        stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        retry: z.ZodOptional<z.ZodObject<{
            count: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$strict>>;
        pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            token: z.ZodString;
            session_id: z.ZodString;
            parent_run_id: z.ZodString;
            chain_step_id: z.ZodString;
            command: z.ZodString;
            issued_at: z.ZodString;
            expires_at: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    decision_points: z.ZodArray<z.ZodObject<{
        point_id: z.ZodString;
        after_step_id: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            pending: "pending";
            passed: "passed";
            escalated: "escalated";
        }>;
        retry_count: z.ZodNumber;
        max_retries: z.ZodNumber;
        evidence_ref: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    gates_ref: z.ZodString;
    artifacts_ref: z.ZodString;
    evidence_ref: z.ZodString;
    lease: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"execution-lease/1.0">;
        session_id: z.ZodString;
        execution_id: z.ZodString;
        owner_id: z.ZodString;
        owner_kind: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
            agy: "agy";
            manual: "manual";
        }>;
        epoch: z.ZodNumber;
        lease_id: z.ZodString;
        acquired_at: z.ZodString;
        heartbeat_at: z.ZodString;
        handoff_to: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    sealed_at: z.ZodNullable<z.ZodString>;
    seal_summary: z.ZodNullable<z.ZodString>;
    final_outcome: z.ZodNullable<z.ZodEnum<{
        failed: "failed";
        done: "done";
        done_with_concerns: "done_with_concerns";
    }>>;
}, z.core.$strict>;
/** Canonical execution/1.0 writer schema. */
export declare const executionSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"execution/1.0">;
    execution_id: z.ZodString;
    session_id: z.ZodString;
    generation: z.ZodNumber;
    status: z.ZodEnum<{
        paused: "paused";
        sealed: "sealed";
        active: "active";
    }>;
    revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    chain: z.ZodArray<z.ZodObject<{
        step_id: z.ZodString;
        command: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            completed: "completed";
            failed: "failed";
            skipped: "skipped";
            pending: "pending";
            sealed: "sealed";
        }>;
        run_id: z.ZodNullable<z.ZodString>;
        inserted_by: z.ZodString;
        decision_ref: z.ZodNullable<z.ZodString>;
        args: z.ZodOptional<z.ZodString>;
        stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        retry: z.ZodOptional<z.ZodObject<{
            count: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$strict>>;
        pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            token: z.ZodString;
            session_id: z.ZodString;
            parent_run_id: z.ZodString;
            chain_step_id: z.ZodString;
            command: z.ZodString;
            issued_at: z.ZodString;
            expires_at: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    decision_points: z.ZodArray<z.ZodObject<{
        point_id: z.ZodString;
        after_step_id: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            pending: "pending";
            passed: "passed";
            escalated: "escalated";
        }>;
        retry_count: z.ZodNumber;
        max_retries: z.ZodNumber;
        evidence_ref: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    gates_ref: z.ZodString;
    artifacts_ref: z.ZodString;
    evidence_ref: z.ZodString;
    lease: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"execution-lease/1.0">;
        session_id: z.ZodString;
        execution_id: z.ZodString;
        owner_id: z.ZodString;
        owner_kind: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
            agy: "agy";
            manual: "manual";
        }>;
        epoch: z.ZodNumber;
        lease_id: z.ZodString;
        acquired_at: z.ZodString;
        heartbeat_at: z.ZodString;
        handoff_to: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    sealed_at: z.ZodNullable<z.ZodString>;
    seal_summary: z.ZodNullable<z.ZodString>;
    final_outcome: z.ZodNullable<z.ZodEnum<{
        failed: "failed";
        done: "done";
        done_with_concerns: "done_with_concerns";
    }>>;
}, z.core.$strict>;
export declare const sessionStateV1ReadSchema: z.ZodObject<{
    schema_version: z.ZodEnum<{
        "session/1.0": "session/1.0";
        "session/1.1": "session/1.1";
    }>;
    session_id: z.ZodString;
    intent: z.ZodString;
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    requests: z.ZodArray<z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const sessionStateV12Schema: z.ZodObject<{
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    session_id: z.ZodString;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    intent: z.ZodString;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"session/1.2">;
    intent_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"intent-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        command: z.ZodString;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
        source: z.ZodEnum<{
            persisted: "persisted";
            derived_legacy: "derived_legacy";
        }>;
        backfill_status: z.ZodEnum<{
            native: "native";
            derived: "derived";
            collision: "collision";
            unavailable: "unavailable";
        }>;
        empty: z.ZodBoolean;
    }, z.core.$strict>>;
    provenance: z.ZodObject<{
        source: z.ZodEnum<{
            fork: "fork";
            native: "native";
            import: "import";
            "legacy-inferred": "legacy-inferred";
        }>;
        forked_from: z.ZodNullable<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        imported_from: z.ZodArray<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        created_by: z.ZodString;
    }, z.core.$strict>;
    requests: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodLiteral<"transition">;
        status: z.ZodEnum<{
            applied: "applied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-request/1.0">;
            request_id: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            normalized_request_hash: z.ZodString;
            requested_at: z.ZodString;
            preconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
        outcome: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-outcome/1.0">;
            transition_id: z.ZodString;
            request_id: z.ZodString;
            request_hash: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            status: z.ZodEnum<{
                applied: "applied";
                rejected: "rejected";
            }>;
            applied_at: z.ZodString;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            postconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            exit_code: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
            error_code: z.ZodNullable<z.ZodString>;
            result_hash: z.ZodString;
            result: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>]>>;
    ralph_authority: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"ralph-authority/1.0">;
        engine: z.ZodLiteral<"ralph">;
        canonical_complete: z.ZodBoolean;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const sessionStateV13Schema: z.ZodObject<{
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    session_id: z.ZodString;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    provenance: z.ZodObject<{
        source: z.ZodEnum<{
            fork: "fork";
            native: "native";
            import: "import";
            "legacy-inferred": "legacy-inferred";
        }>;
        forked_from: z.ZodNullable<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        imported_from: z.ZodArray<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        created_by: z.ZodString;
    }, z.core.$strict>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    intent: z.ZodString;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
    intent_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"intent-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        command: z.ZodString;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
        source: z.ZodEnum<{
            persisted: "persisted";
            derived_legacy: "derived_legacy";
        }>;
        backfill_status: z.ZodEnum<{
            native: "native";
            derived: "derived";
            collision: "collision";
            unavailable: "unavailable";
        }>;
        empty: z.ZodBoolean;
    }, z.core.$strict>>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    requests: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodLiteral<"transition">;
        status: z.ZodEnum<{
            applied: "applied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-request/1.0">;
            request_id: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            normalized_request_hash: z.ZodString;
            requested_at: z.ZodString;
            preconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
        outcome: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-outcome/1.0">;
            transition_id: z.ZodString;
            request_id: z.ZodString;
            request_hash: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            status: z.ZodEnum<{
                applied: "applied";
                rejected: "rejected";
            }>;
            applied_at: z.ZodString;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            postconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            exit_code: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
            error_code: z.ZodNullable<z.ZodString>;
            result_hash: z.ZodString;
            result: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>]>>;
    ralph_authority: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"ralph-authority/1.0">;
        engine: z.ZodLiteral<"ralph">;
        canonical_complete: z.ZodBoolean;
    }, z.core.$strict>>;
    schema_version: z.ZodLiteral<"session/1.3">;
    topic_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"topic-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        source: z.ZodEnum<{
            explicit: "explicit";
            workflow: "workflow";
            "legacy-intent": "legacy-intent";
        }>;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        identity_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/**
 * Statusless Session identity/index authority. Execution lifecycle, chain,
 * gates, artifacts, and evidence deliberately live outside this strict shape.
 */
export declare const sessionStateV20Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"session/2.0">;
    session_id: z.ZodString;
    intent: z.ZodString;
    topic_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"topic-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        source: z.ZodEnum<{
            explicit: "explicit";
            workflow: "workflow";
            "legacy-intent": "legacy-intent";
        }>;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        identity_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
    }, z.core.$strict>>;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    current_execution_id: z.ZodNullable<z.ZodString>;
    latest_execution_id: z.ZodNullable<z.ZodString>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    archived_at: z.ZodNullable<z.ZodString>;
    archived_by: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const sessionStatusV30Schema: z.ZodEnum<{
    completed: "completed";
    failed: "failed";
    archived: "archived";
    open: "open";
}>;
export declare const sessionChainStepV30Schema: z.ZodObject<{
    step_id: z.ZodString;
    command: z.ZodString;
    args: z.ZodArray<z.ZodString>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        skipped: "skipped";
        pending: "pending";
    }>;
    run_ids: z.ZodArray<z.ZodString>;
    goal_ref: z.ZodNullable<z.ZodString>;
    decision_ref: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    decision_refs: z.ZodArray<z.ZodString>;
    stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export declare const sessionDecisionRefV30Schema: z.ZodObject<{
    decision_id: z.ZodString;
    after_step_id: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        resolved: "resolved";
        escalated: "escalated";
        open: "open";
    }>;
    evidence_refs: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
/** Session/Run minimal-state authority. activity_revision is observational, never a CAS target. */
export declare const sessionStateV30Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"session/3.0">;
    session_id: z.ZodString;
    objective: z.ZodString;
    definition_of_done: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
        archived: "archived";
        open: "open";
    }>;
    orchestration_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    chain: z.ZodArray<z.ZodObject<{
        step_id: z.ZodString;
        command: z.ZodString;
        args: z.ZodArray<z.ZodString>;
        status: z.ZodEnum<{
            running: "running";
            completed: "completed";
            failed: "failed";
            skipped: "skipped";
            pending: "pending";
        }>;
        run_ids: z.ZodArray<z.ZodString>;
        goal_ref: z.ZodNullable<z.ZodString>;
        decision_ref: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        decision_refs: z.ZodArray<z.ZodString>;
        stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    decisions: z.ZodArray<z.ZodObject<{
        decision_id: z.ZodString;
        after_step_id: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            resolved: "resolved";
            escalated: "escalated";
            open: "open";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    active_run_ids: z.ZodArray<z.ZodString>;
    artifacts_ref: z.ZodString;
    evidence_ref: z.ZodString;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    archived_at: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/**
 * Read-tolerant session/3.0 variant. Pre-simplification documents may still
 * carry the retired `identity_revision`/`gates_ref` fields and the retired
 * `paused` status. Retired keys are stripped on read (the write path stays
 * strict and never re-emits them); callers map `paused` to `open` (the
 * engine no longer has a paused Session status — see SessionStore.readSessionV30).
 */
export declare const sessionStateV30ReadSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"session/3.0">;
    session_id: z.ZodString;
    objective: z.ZodString;
    definition_of_done: z.ZodString;
    orchestration_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    chain: z.ZodArray<z.ZodObject<{
        step_id: z.ZodString;
        command: z.ZodString;
        args: z.ZodArray<z.ZodString>;
        status: z.ZodEnum<{
            running: "running";
            completed: "completed";
            failed: "failed";
            skipped: "skipped";
            pending: "pending";
        }>;
        run_ids: z.ZodArray<z.ZodString>;
        goal_ref: z.ZodNullable<z.ZodString>;
        decision_ref: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        decision_refs: z.ZodArray<z.ZodString>;
        stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    decisions: z.ZodArray<z.ZodObject<{
        decision_id: z.ZodString;
        after_step_id: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            resolved: "resolved";
            escalated: "escalated";
            open: "open";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    active_run_ids: z.ZodArray<z.ZodString>;
    artifacts_ref: z.ZodString;
    evidence_ref: z.ZodString;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    archived_at: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        paused: "paused";
        completed: "completed";
        failed: "failed";
        archived: "archived";
        open: "open";
    }>;
}, z.core.$strip>;
export declare const sessionSchemaWriterSchema: z.ZodEnum<{
    "session/1.3": "session/1.3";
    "session/2.0": "session/2.0";
    "session/3.0": "session/3.0";
}>;
export declare const sessionSchemaSelectionSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"session-schema-selection/1.0">;
    writer: z.ZodEnum<{
        "session/1.3": "session/1.3";
        "session/2.0": "session/2.0";
        "session/3.0": "session/3.0";
    }>;
    features: z.ZodObject<{
        session_statusless: z.ZodBoolean;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const projectSessionSchemaConfigSchema: z.ZodObject<{
    session_schema: z.ZodOptional<z.ZodObject<{
        schema_version: z.ZodLiteral<"session-schema-selection/1.0">;
        writer: z.ZodEnum<{
            "session/1.3": "session/1.3";
            "session/2.0": "session/2.0";
            "session/3.0": "session/3.0";
        }>;
        features: z.ZodObject<{
            session_statusless: z.ZodBoolean;
        }, z.core.$strict>;
    }, z.core.$strict>>;
}, z.core.$loose>;
declare const sessionStateUnknownSchema: z.ZodObject<{
    schema_version: z.ZodString;
}, z.core.$loose>;
export type SessionStateInput = z.infer<typeof sessionStateV1ReadSchema> | z.infer<typeof sessionStateV12Schema> | z.infer<typeof sessionStateV13Schema> | z.infer<typeof sessionStateUnknownSchema>;
export declare function normalizeSessionState(session: SessionStateInput): z.infer<typeof sessionStateV13Schema>;
/** Strict known-version reader with schema_version as the type discriminator. */
export declare const knownSessionStateReadSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    schema_version: z.ZodLiteral<"session/3.0">;
    session_id: z.ZodString;
    objective: z.ZodString;
    definition_of_done: z.ZodString;
    orchestration_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    chain: z.ZodArray<z.ZodObject<{
        step_id: z.ZodString;
        command: z.ZodString;
        args: z.ZodArray<z.ZodString>;
        status: z.ZodEnum<{
            running: "running";
            completed: "completed";
            failed: "failed";
            skipped: "skipped";
            pending: "pending";
        }>;
        run_ids: z.ZodArray<z.ZodString>;
        goal_ref: z.ZodNullable<z.ZodString>;
        decision_ref: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        decision_refs: z.ZodArray<z.ZodString>;
        stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    decisions: z.ZodArray<z.ZodObject<{
        decision_id: z.ZodString;
        after_step_id: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            resolved: "resolved";
            escalated: "escalated";
            open: "open";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    active_run_ids: z.ZodArray<z.ZodString>;
    artifacts_ref: z.ZodString;
    evidence_ref: z.ZodString;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    archived_at: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        paused: "paused";
        completed: "completed";
        failed: "failed";
        archived: "archived";
        open: "open";
    }>;
}, z.core.$strip>, z.ZodObject<{
    schema_version: z.ZodLiteral<"session/2.0">;
    session_id: z.ZodString;
    intent: z.ZodString;
    topic_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"topic-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        source: z.ZodEnum<{
            explicit: "explicit";
            workflow: "workflow";
            "legacy-intent": "legacy-intent";
        }>;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        identity_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
    }, z.core.$strict>>;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    current_execution_id: z.ZodNullable<z.ZodString>;
    latest_execution_id: z.ZodNullable<z.ZodString>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    archived_at: z.ZodNullable<z.ZodString>;
    archived_by: z.ZodNullable<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    session_id: z.ZodString;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    provenance: z.ZodObject<{
        source: z.ZodEnum<{
            fork: "fork";
            native: "native";
            import: "import";
            "legacy-inferred": "legacy-inferred";
        }>;
        forked_from: z.ZodNullable<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        imported_from: z.ZodArray<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        created_by: z.ZodString;
    }, z.core.$strict>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    intent: z.ZodString;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
    intent_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"intent-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        command: z.ZodString;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
        source: z.ZodEnum<{
            persisted: "persisted";
            derived_legacy: "derived_legacy";
        }>;
        backfill_status: z.ZodEnum<{
            native: "native";
            derived: "derived";
            collision: "collision";
            unavailable: "unavailable";
        }>;
        empty: z.ZodBoolean;
    }, z.core.$strict>>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    requests: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodLiteral<"transition">;
        status: z.ZodEnum<{
            applied: "applied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-request/1.0">;
            request_id: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            normalized_request_hash: z.ZodString;
            requested_at: z.ZodString;
            preconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
        outcome: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-outcome/1.0">;
            transition_id: z.ZodString;
            request_id: z.ZodString;
            request_hash: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            status: z.ZodEnum<{
                applied: "applied";
                rejected: "rejected";
            }>;
            applied_at: z.ZodString;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            postconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            exit_code: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
            error_code: z.ZodNullable<z.ZodString>;
            result_hash: z.ZodString;
            result: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>]>>;
    ralph_authority: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"ralph-authority/1.0">;
        engine: z.ZodLiteral<"ralph">;
        canonical_complete: z.ZodBoolean;
    }, z.core.$strict>>;
    schema_version: z.ZodLiteral<"session/1.3">;
    topic_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"topic-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        source: z.ZodEnum<{
            explicit: "explicit";
            workflow: "workflow";
            "legacy-intent": "legacy-intent";
        }>;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        identity_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    session_id: z.ZodString;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    intent: z.ZodString;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"session/1.2">;
    intent_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"intent-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        command: z.ZodString;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
        source: z.ZodEnum<{
            persisted: "persisted";
            derived_legacy: "derived_legacy";
        }>;
        backfill_status: z.ZodEnum<{
            native: "native";
            derived: "derived";
            collision: "collision";
            unavailable: "unavailable";
        }>;
        empty: z.ZodBoolean;
    }, z.core.$strict>>;
    provenance: z.ZodObject<{
        source: z.ZodEnum<{
            fork: "fork";
            native: "native";
            import: "import";
            "legacy-inferred": "legacy-inferred";
        }>;
        forked_from: z.ZodNullable<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        imported_from: z.ZodArray<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        created_by: z.ZodString;
    }, z.core.$strict>;
    requests: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodLiteral<"transition">;
        status: z.ZodEnum<{
            applied: "applied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-request/1.0">;
            request_id: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            normalized_request_hash: z.ZodString;
            requested_at: z.ZodString;
            preconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
        outcome: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-outcome/1.0">;
            transition_id: z.ZodString;
            request_id: z.ZodString;
            request_hash: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            status: z.ZodEnum<{
                applied: "applied";
                rejected: "rejected";
            }>;
            applied_at: z.ZodString;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            postconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            exit_code: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
            error_code: z.ZodNullable<z.ZodString>;
            result_hash: z.ZodString;
            result: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>]>>;
    ralph_authority: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"ralph-authority/1.0">;
        engine: z.ZodLiteral<"ralph">;
        canonical_complete: z.ZodBoolean;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodEnum<{
        "session/1.0": "session/1.0";
        "session/1.1": "session/1.1";
    }>;
    session_id: z.ZodString;
    intent: z.ZodString;
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    requests: z.ZodArray<z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
}, z.core.$strict>], "schema_version">;
/** Typed reader for known generations plus the existing future-version fallback. */
export declare const sessionStateReadSchema: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
    schema_version: z.ZodLiteral<"session/3.0">;
    session_id: z.ZodString;
    objective: z.ZodString;
    definition_of_done: z.ZodString;
    orchestration_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    chain: z.ZodArray<z.ZodObject<{
        step_id: z.ZodString;
        command: z.ZodString;
        args: z.ZodArray<z.ZodString>;
        status: z.ZodEnum<{
            running: "running";
            completed: "completed";
            failed: "failed";
            skipped: "skipped";
            pending: "pending";
        }>;
        run_ids: z.ZodArray<z.ZodString>;
        goal_ref: z.ZodNullable<z.ZodString>;
        decision_ref: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        decision_refs: z.ZodArray<z.ZodString>;
        stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    decisions: z.ZodArray<z.ZodObject<{
        decision_id: z.ZodString;
        after_step_id: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            resolved: "resolved";
            escalated: "escalated";
            open: "open";
        }>;
        evidence_refs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    active_run_ids: z.ZodArray<z.ZodString>;
    artifacts_ref: z.ZodString;
    evidence_ref: z.ZodString;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    archived_at: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        paused: "paused";
        completed: "completed";
        failed: "failed";
        archived: "archived";
        open: "open";
    }>;
}, z.core.$strip>, z.ZodObject<{
    schema_version: z.ZodLiteral<"session/2.0">;
    session_id: z.ZodString;
    intent: z.ZodString;
    topic_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"topic-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        source: z.ZodEnum<{
            explicit: "explicit";
            workflow: "workflow";
            "legacy-intent": "legacy-intent";
        }>;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        identity_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
    }, z.core.$strict>>;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    current_execution_id: z.ZodNullable<z.ZodString>;
    latest_execution_id: z.ZodNullable<z.ZodString>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    archived_at: z.ZodNullable<z.ZodString>;
    archived_by: z.ZodNullable<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    session_id: z.ZodString;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    provenance: z.ZodObject<{
        source: z.ZodEnum<{
            fork: "fork";
            native: "native";
            import: "import";
            "legacy-inferred": "legacy-inferred";
        }>;
        forked_from: z.ZodNullable<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        imported_from: z.ZodArray<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        created_by: z.ZodString;
    }, z.core.$strict>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    intent: z.ZodString;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
    intent_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"intent-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        command: z.ZodString;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
        source: z.ZodEnum<{
            persisted: "persisted";
            derived_legacy: "derived_legacy";
        }>;
        backfill_status: z.ZodEnum<{
            native: "native";
            derived: "derived";
            collision: "collision";
            unavailable: "unavailable";
        }>;
        empty: z.ZodBoolean;
    }, z.core.$strict>>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    requests: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodLiteral<"transition">;
        status: z.ZodEnum<{
            applied: "applied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-request/1.0">;
            request_id: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            normalized_request_hash: z.ZodString;
            requested_at: z.ZodString;
            preconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
        outcome: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-outcome/1.0">;
            transition_id: z.ZodString;
            request_id: z.ZodString;
            request_hash: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            status: z.ZodEnum<{
                applied: "applied";
                rejected: "rejected";
            }>;
            applied_at: z.ZodString;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            postconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            exit_code: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
            error_code: z.ZodNullable<z.ZodString>;
            result_hash: z.ZodString;
            result: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>]>>;
    ralph_authority: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"ralph-authority/1.0">;
        engine: z.ZodLiteral<"ralph">;
        canonical_complete: z.ZodBoolean;
    }, z.core.$strict>>;
    schema_version: z.ZodLiteral<"session/1.3">;
    topic_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"topic-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        source: z.ZodEnum<{
            explicit: "explicit";
            workflow: "workflow";
            "legacy-intent": "legacy-intent";
        }>;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        identity_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    session_id: z.ZodString;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    intent: z.ZodString;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"session/1.2">;
    intent_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"intent-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        command: z.ZodString;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
        source: z.ZodEnum<{
            persisted: "persisted";
            derived_legacy: "derived_legacy";
        }>;
        backfill_status: z.ZodEnum<{
            native: "native";
            derived: "derived";
            collision: "collision";
            unavailable: "unavailable";
        }>;
        empty: z.ZodBoolean;
    }, z.core.$strict>>;
    provenance: z.ZodObject<{
        source: z.ZodEnum<{
            fork: "fork";
            native: "native";
            import: "import";
            "legacy-inferred": "legacy-inferred";
        }>;
        forked_from: z.ZodNullable<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        imported_from: z.ZodArray<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        created_by: z.ZodString;
    }, z.core.$strict>;
    requests: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodLiteral<"transition">;
        status: z.ZodEnum<{
            applied: "applied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-request/1.0">;
            request_id: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            normalized_request_hash: z.ZodString;
            requested_at: z.ZodString;
            preconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
        outcome: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-outcome/1.0">;
            transition_id: z.ZodString;
            request_id: z.ZodString;
            request_hash: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            status: z.ZodEnum<{
                applied: "applied";
                rejected: "rejected";
            }>;
            applied_at: z.ZodString;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            postconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            exit_code: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
            error_code: z.ZodNullable<z.ZodString>;
            result_hash: z.ZodString;
            result: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>]>>;
    ralph_authority: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"ralph-authority/1.0">;
        engine: z.ZodLiteral<"ralph">;
        canonical_complete: z.ZodBoolean;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodEnum<{
        "session/1.0": "session/1.0";
        "session/1.1": "session/1.1";
    }>;
    session_id: z.ZodString;
    intent: z.ZodString;
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    requests: z.ZodArray<z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
}, z.core.$strict>], "schema_version">, z.ZodObject<{
    schema_version: z.ZodString;
}, z.core.$loose>]>;
/** Backward-compatible legacy reader. It intentionally rejects session/2.0 and session/3.0. */
export declare const sessionStateSchema: z.ZodPipe<z.ZodUnion<readonly [z.ZodObject<{
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    session_id: z.ZodString;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    provenance: z.ZodObject<{
        source: z.ZodEnum<{
            fork: "fork";
            native: "native";
            import: "import";
            "legacy-inferred": "legacy-inferred";
        }>;
        forked_from: z.ZodNullable<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        imported_from: z.ZodArray<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        created_by: z.ZodString;
    }, z.core.$strict>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    intent: z.ZodString;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
    intent_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"intent-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        command: z.ZodString;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
        source: z.ZodEnum<{
            persisted: "persisted";
            derived_legacy: "derived_legacy";
        }>;
        backfill_status: z.ZodEnum<{
            native: "native";
            derived: "derived";
            collision: "collision";
            unavailable: "unavailable";
        }>;
        empty: z.ZodBoolean;
    }, z.core.$strict>>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    requests: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodLiteral<"transition">;
        status: z.ZodEnum<{
            applied: "applied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-request/1.0">;
            request_id: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            normalized_request_hash: z.ZodString;
            requested_at: z.ZodString;
            preconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
        outcome: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-outcome/1.0">;
            transition_id: z.ZodString;
            request_id: z.ZodString;
            request_hash: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            status: z.ZodEnum<{
                applied: "applied";
                rejected: "rejected";
            }>;
            applied_at: z.ZodString;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            postconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            exit_code: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
            error_code: z.ZodNullable<z.ZodString>;
            result_hash: z.ZodString;
            result: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>]>>;
    ralph_authority: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"ralph-authority/1.0">;
        engine: z.ZodLiteral<"ralph">;
        canonical_complete: z.ZodBoolean;
    }, z.core.$strict>>;
    schema_version: z.ZodLiteral<"session/1.3">;
    topic_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"topic-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        source: z.ZodEnum<{
            explicit: "explicit";
            workflow: "workflow";
            "legacy-intent": "legacy-intent";
        }>;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        identity_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    session_id: z.ZodString;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    intent: z.ZodString;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"session/1.2">;
    intent_identity: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"intent-identity/1.0">;
        normalization: z.ZodLiteral<"NFKC+unicode-lower+whitespace-collapse/1">;
        workspace_id: z.ZodString;
        command: z.ZodString;
        verbatim: z.ZodString;
        normalized: z.ZodString;
        normalized_length: z.ZodNumber;
        normalized_hash: z.ZodString;
        revision: z.ZodLiteral<1>;
        source: z.ZodEnum<{
            persisted: "persisted";
            derived_legacy: "derived_legacy";
        }>;
        backfill_status: z.ZodEnum<{
            native: "native";
            derived: "derived";
            collision: "collision";
            unavailable: "unavailable";
        }>;
        empty: z.ZodBoolean;
    }, z.core.$strict>>;
    provenance: z.ZodObject<{
        source: z.ZodEnum<{
            fork: "fork";
            native: "native";
            import: "import";
            "legacy-inferred": "legacy-inferred";
        }>;
        forked_from: z.ZodNullable<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        imported_from: z.ZodArray<z.ZodObject<{
            workspace_id: z.ZodString;
            workspace_link_name: z.ZodNullable<z.ZodString>;
            session_id: z.ZodString;
            session_schema_version: z.ZodEnum<{
                "session/1.0": "session/1.0";
                "session/1.1": "session/1.1";
                "session/1.2": "session/1.2";
                "session/1.3": "session/1.3";
            }>;
            session_identity_revision: z.ZodNumber;
            session_activity_revision: z.ZodNumber;
            session_hash: z.ZodString;
            run_id: z.ZodString;
            run_schema_version: z.ZodEnum<{
                "command-run/1.0": "command-run/1.0";
                "command-run/1.1": "command-run/1.1";
                "command-run/1.2": "command-run/1.2";
                "command-run/1.3": "command-run/1.3";
            }>;
            run_hash: z.ZodString;
            artifact_registry_revision: z.ZodNumber;
            selected_artifacts: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                relative_path: z.ZodString;
                content_hash: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        created_by: z.ZodString;
    }, z.core.$strict>;
    requests: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodLiteral<"transition">;
        status: z.ZodEnum<{
            applied: "applied";
            rejected: "rejected";
        }>;
        payload: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-request/1.0">;
            request_id: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            normalized_request_hash: z.ZodString;
            requested_at: z.ZodString;
            preconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
        outcome: z.ZodObject<{
            schema_version: z.ZodLiteral<"transition-outcome/1.0">;
            transition_id: z.ZodString;
            request_id: z.ZodString;
            request_hash: z.ZodString;
            operation: z.ZodEnum<{
                fork: "fork";
                create: "create";
                decide: "decide";
                import: "import";
                resume: "resume";
                next: "next";
                complete: "complete";
                resolve: "resolve";
                "ralph-retry": "ralph-retry";
                "chain-insert": "chain-insert";
                "chain-replace": "chain-replace";
                "chain-skip": "chain-skip";
                "meta-update": "meta-update";
                "accept-reuse": "accept-reuse";
                "artifact-republish": "artifact-republish";
            }>;
            status: z.ZodEnum<{
                applied: "applied";
                rejected: "rejected";
            }>;
            applied_at: z.ZodString;
            subject: z.ZodObject<{
                session_id: z.ZodString;
                run_id: z.ZodNullable<z.ZodString>;
                chain_step_id: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            postconditions: z.ZodObject<{
                session_identity_revision: z.ZodNumber;
                session_activity_revision: z.ZodNumber;
                active_run_id: z.ZodNullable<z.ZodString>;
                run_hash: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            exit_code: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
            error_code: z.ZodNullable<z.ZodString>;
            result_hash: z.ZodString;
            result: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>]>>;
    ralph_authority: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"ralph-authority/1.0">;
        engine: z.ZodLiteral<"ralph">;
        canonical_complete: z.ZodBoolean;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodEnum<{
        "session/1.0": "session/1.0";
        "session/1.1": "session/1.1";
    }>;
    session_id: z.ZodString;
    intent: z.ZodString;
    status: z.ZodEnum<{
        paused: "paused";
        running: "running";
        failed: "failed";
        sealed: "sealed";
        archived: "archived";
    }>;
    identity_revision: z.ZodNumber;
    activity_revision: z.ZodNumber;
    active_run_id: z.ZodNullable<z.ZodString>;
    latest_completed_run_id: z.ZodNullable<z.ZodString>;
    boundary_contract: z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>;
    orchestration: z.ZodObject<{
        engine: z.ZodEnum<{
            ralph: "ralph";
            manual: "manual";
            coordinator: "coordinator";
        }>;
        quality_mode: z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>;
        auto_mode: z.ZodBoolean;
        chain: z.ZodArray<z.ZodObject<{
            step_id: z.ZodString;
            command: z.ZodString;
            status: z.ZodEnum<{
                running: "running";
                completed: "completed";
                failed: "failed";
                skipped: "skipped";
                pending: "pending";
                sealed: "sealed";
            }>;
            run_id: z.ZodNullable<z.ZodString>;
            inserted_by: z.ZodString;
            decision_ref: z.ZodNullable<z.ZodString>;
            args: z.ZodOptional<z.ZodString>;
            stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            retry: z.ZodOptional<z.ZodObject<{
                count: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$strict>>;
            pending_retry: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                token: z.ZodString;
                session_id: z.ZodString;
                parent_run_id: z.ZodString;
                chain_step_id: z.ZodString;
                command: z.ZodString;
                issued_at: z.ZodString;
                expires_at: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        decision_points: z.ZodArray<z.ZodObject<{
            point_id: z.ZodString;
            after_step_id: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                pending: "pending";
                passed: "passed";
                escalated: "escalated";
            }>;
            retry_count: z.ZodNumber;
            max_retries: z.ZodNumber;
            evidence_ref: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        position: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            lifecycle: z.ZodString;
            phase: z.ZodNullable<z.ZodNumber>;
            phase_is_new: z.ZodBoolean;
            milestone: z.ZodString;
            planning_mode: z.ZodNullable<z.ZodString>;
            passed_gates: z.ZodArray<z.ZodString>;
            scope_verdict: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        decomposition: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            execution_criteria: z.ZodArray<z.ZodString>;
            goals: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                goal: z.ZodString;
                boundary: z.ZodOptional<z.ZodString>;
                done_when: z.ZodOptional<z.ZodString>;
                evidence: z.ZodOptional<z.ZodString>;
                lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
                status: z.ZodEnum<{
                    pending: "pending";
                    superseded: "superseded";
                    done: "done";
                }>;
                completion_confirmed: z.ZodOptional<z.ZodBoolean>;
                completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>;
            changelog: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                timestamp: z.ZodString;
                change_type: z.ZodEnum<{
                    modify: "modify";
                    boundary: "boundary";
                    add: "add";
                    remove: "remove";
                }>;
                reason: z.ZodString;
                impact_assessment: z.ZodOptional<z.ZodObject<{
                    risk_level: z.ZodEnum<{
                        low: "low";
                        medium: "medium";
                        high: "high";
                    }>;
                    invalidated_steps: z.ZodArray<z.ZodNumber>;
                    new_steps_inserted: z.ZodNumber;
                }, z.core.$strict>>;
                before: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
                after: z.ZodObject<{
                    goals: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        goal: z.ZodString;
                        done_when: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    boundary_snippet: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        lease: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            owner: z.ZodNullable<z.ZodString>;
            epoch: z.ZodNumber;
            id: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>>;
        executor: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            platform: z.ZodString;
            cli_tool: z.ZodString;
        }, z.core.$strict>>>>;
    }, z.core.$strict>;
    requests: z.ZodArray<z.ZodObject<{
        request_id: z.ZodString;
        type: z.ZodString;
        status: z.ZodString;
        payload: z.ZodUnknown;
        claimed_by_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    lifecycle: z.ZodObject<{
        sealed_at: z.ZodNullable<z.ZodString>;
        seal_summary: z.ZodNullable<z.ZodString>;
        promoted_spec_ids: z.ZodArray<z.ZodString>;
        promoted_knowhow_ids: z.ZodArray<z.ZodString>;
        forked_from: z.ZodNullable<z.ZodObject<{
            session_id: z.ZodString;
            run_id: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    refs: z.ZodObject<{
        gates: z.ZodLiteral<"gates.json">;
        artifacts: z.ZodLiteral<"artifacts.json">;
        evidence: z.ZodLiteral<"evidence.json">;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodString;
}, z.core.$loose>]>, z.ZodTransform<{
    status: "paused" | "running" | "failed" | "sealed" | "archived";
    session_id: string;
    identity_revision: number;
    activity_revision: number;
    active_run_id: string | null;
    provenance: {
        source: "fork" | "native" | "import" | "legacy-inferred";
        forked_from: {
            workspace_id: string;
            workspace_link_name: string | null;
            session_id: string;
            session_schema_version: "session/1.0" | "session/1.1" | "session/1.2" | "session/1.3";
            session_identity_revision: number;
            session_activity_revision: number;
            session_hash: string;
            run_id: string;
            run_schema_version: "command-run/1.0" | "command-run/1.1" | "command-run/1.2" | "command-run/1.3";
            run_hash: string;
            artifact_registry_revision: number;
            selected_artifacts: {
                kind: string;
                relative_path: string;
                content_hash: string;
            }[];
        } | null;
        imported_from: {
            workspace_id: string;
            workspace_link_name: string | null;
            session_id: string;
            session_schema_version: "session/1.0" | "session/1.1" | "session/1.2" | "session/1.3";
            session_identity_revision: number;
            session_activity_revision: number;
            session_hash: string;
            run_id: string;
            run_schema_version: "command-run/1.0" | "command-run/1.1" | "command-run/1.2" | "command-run/1.3";
            run_hash: string;
            artifact_registry_revision: number;
            selected_artifacts: {
                kind: string;
                relative_path: string;
                content_hash: string;
            }[];
        }[];
        created_by: string;
    };
    orchestration: {
        engine: "ralph" | "manual" | "coordinator";
        quality_mode: "quick" | "standard" | "full";
        auto_mode: boolean;
        chain: {
            step_id: string;
            command: string;
            status: "running" | "completed" | "failed" | "skipped" | "pending" | "sealed";
            run_id: string | null;
            inserted_by: string;
            decision_ref: string | null;
            args?: string | undefined;
            stage?: string | null | undefined;
            goal_ref?: string | null | undefined;
            retry?: {
                count: number;
                max: number;
            } | undefined;
            pending_retry?: {
                token: string;
                session_id: string;
                parent_run_id: string;
                chain_step_id: string;
                command: string;
                issued_at: string;
                expires_at: string;
            } | null | undefined;
        }[];
        decision_points: {
            point_id: string;
            after_step_id: string | null;
            status: "pending" | "passed" | "escalated";
            retry_count: number;
            max_retries: number;
            evidence_ref: string | null;
        }[];
        position: {
            lifecycle: string;
            phase: number | null;
            phase_is_new: boolean;
            milestone: string;
            planning_mode: string | null;
            passed_gates: string[];
            scope_verdict: string | null;
        } | null;
        decomposition: {
            execution_criteria: string[];
            goals: {
                id: string;
                goal: string;
                status: "pending" | "superseded" | "done";
                boundary?: string | undefined;
                done_when?: string | undefined;
                evidence?: string | undefined;
                lifecycle?: string[] | undefined;
                completion_confirmed?: boolean | undefined;
                completed_at?: string | null | undefined;
                superseded_by?: string | null | undefined;
                superseded_at?: string | null | undefined;
                origin?: string | null | undefined;
            }[];
            changelog: {
                id: string;
                timestamp: string;
                change_type: "modify" | "boundary" | "add" | "remove";
                reason: string;
                before: {
                    goals: {
                        id: string;
                        goal: string;
                        done_when?: string | undefined;
                    }[];
                    boundary_snippet?: string | undefined;
                };
                after: {
                    goals: {
                        id: string;
                        goal: string;
                        done_when?: string | undefined;
                    }[];
                    boundary_snippet?: string | undefined;
                };
                impact_assessment?: {
                    risk_level: "low" | "medium" | "high";
                    invalidated_steps: number[];
                    new_steps_inserted: number;
                } | undefined;
            }[];
        } | null;
        lease: {
            owner: string | null;
            epoch: number;
            id: string | null;
        } | null;
        executor: {
            platform: string;
            cli_tool: string;
        } | null;
    };
    intent: string;
    boundary_contract: {
        in_scope: string[];
        out_of_scope: string[];
        constraints: string[];
        definition_of_done: string;
    };
    refs: {
        gates: "gates.json";
        artifacts: "artifacts.json";
        evidence: "evidence.json";
    };
    intent_identity: {
        schema_version: "intent-identity/1.0";
        normalization: "NFKC+unicode-lower+whitespace-collapse/1";
        workspace_id: string;
        command: string;
        verbatim: string;
        normalized: string;
        normalized_length: number;
        normalized_hash: string;
        revision: 1;
        source: "persisted" | "derived_legacy";
        backfill_status: "native" | "derived" | "collision" | "unavailable";
        empty: boolean;
    } | null;
    lifecycle: {
        sealed_at: string | null;
        seal_summary: string | null;
        promoted_spec_ids: string[];
        promoted_knowhow_ids: string[];
        forked_from: {
            session_id: string;
            run_id: string;
        } | null;
    };
    latest_completed_run_id: string | null;
    requests: ({
        request_id: string;
        type: "transition";
        status: "applied" | "rejected";
        payload: {
            schema_version: "transition-request/1.0";
            request_id: string;
            operation: "fork" | "create" | "decide" | "import" | "resume" | "next" | "complete" | "resolve" | "ralph-retry" | "chain-insert" | "chain-replace" | "chain-skip" | "meta-update" | "accept-reuse" | "artifact-republish";
            subject: {
                session_id: string;
                run_id: string | null;
                chain_step_id: string | null;
            };
            normalized_request_hash: string;
            requested_at: string;
            preconditions: {
                session_identity_revision: number;
                session_activity_revision: number;
                active_run_id: string | null;
                run_hash: string | null;
                artifact_registry_revision: number | null;
            };
            payload: Record<string, unknown>;
        };
        claimed_by_run_id: string | null;
        outcome: {
            schema_version: "transition-outcome/1.0";
            transition_id: string;
            request_id: string;
            request_hash: string;
            operation: "fork" | "create" | "decide" | "import" | "resume" | "next" | "complete" | "resolve" | "ralph-retry" | "chain-insert" | "chain-replace" | "chain-skip" | "meta-update" | "accept-reuse" | "artifact-republish";
            status: "applied" | "rejected";
            applied_at: string;
            subject: {
                session_id: string;
                run_id: string | null;
                chain_step_id: string | null;
            };
            postconditions: {
                session_identity_revision: number;
                session_activity_revision: number;
                active_run_id: string | null;
                run_hash: string | null;
                artifact_registry_revision: number | null;
            };
            exit_code: 0 | 1 | 2 | 3;
            error_code: string | null;
            result_hash: string;
            result: Record<string, unknown>;
        };
    } | {
        request_id: string;
        type: string;
        status: string;
        payload: unknown;
        claimed_by_run_id: string | null;
    })[];
    ralph_authority: {
        schema_version: "ralph-authority/1.0";
        engine: "ralph";
        canonical_complete: boolean;
    } | null;
    schema_version: "session/1.3";
    topic_identity: {
        schema_version: "topic-identity/1.0";
        normalization: "NFKC+unicode-lower+whitespace-collapse/1";
        workspace_id: string;
        source: "explicit" | "workflow" | "legacy-intent";
        verbatim: string;
        normalized: string;
        normalized_length: number;
        normalized_hash: string;
        identity_hash: string;
        revision: 1;
    } | null;
}, {
    [x: string]: unknown;
    schema_version: string;
} | {
    schema_version: "session/1.0" | "session/1.1";
    session_id: string;
    intent: string;
    status: "paused" | "running" | "failed" | "sealed" | "archived";
    identity_revision: number;
    activity_revision: number;
    active_run_id: string | null;
    latest_completed_run_id: string | null;
    boundary_contract: {
        in_scope: string[];
        out_of_scope: string[];
        constraints: string[];
        definition_of_done: string;
    };
    orchestration: {
        engine: "ralph" | "manual" | "coordinator";
        quality_mode: "quick" | "standard" | "full";
        auto_mode: boolean;
        chain: {
            step_id: string;
            command: string;
            status: "running" | "completed" | "failed" | "skipped" | "pending" | "sealed";
            run_id: string | null;
            inserted_by: string;
            decision_ref: string | null;
            args?: string | undefined;
            stage?: string | null | undefined;
            goal_ref?: string | null | undefined;
            retry?: {
                count: number;
                max: number;
            } | undefined;
            pending_retry?: {
                token: string;
                session_id: string;
                parent_run_id: string;
                chain_step_id: string;
                command: string;
                issued_at: string;
                expires_at: string;
            } | null | undefined;
        }[];
        decision_points: {
            point_id: string;
            after_step_id: string | null;
            status: "pending" | "passed" | "escalated";
            retry_count: number;
            max_retries: number;
            evidence_ref: string | null;
        }[];
        position: {
            lifecycle: string;
            phase: number | null;
            phase_is_new: boolean;
            milestone: string;
            planning_mode: string | null;
            passed_gates: string[];
            scope_verdict: string | null;
        } | null;
        decomposition: {
            execution_criteria: string[];
            goals: {
                id: string;
                goal: string;
                status: "pending" | "superseded" | "done";
                boundary?: string | undefined;
                done_when?: string | undefined;
                evidence?: string | undefined;
                lifecycle?: string[] | undefined;
                completion_confirmed?: boolean | undefined;
                completed_at?: string | null | undefined;
                superseded_by?: string | null | undefined;
                superseded_at?: string | null | undefined;
                origin?: string | null | undefined;
            }[];
            changelog: {
                id: string;
                timestamp: string;
                change_type: "modify" | "boundary" | "add" | "remove";
                reason: string;
                before: {
                    goals: {
                        id: string;
                        goal: string;
                        done_when?: string | undefined;
                    }[];
                    boundary_snippet?: string | undefined;
                };
                after: {
                    goals: {
                        id: string;
                        goal: string;
                        done_when?: string | undefined;
                    }[];
                    boundary_snippet?: string | undefined;
                };
                impact_assessment?: {
                    risk_level: "low" | "medium" | "high";
                    invalidated_steps: number[];
                    new_steps_inserted: number;
                } | undefined;
            }[];
        } | null;
        lease: {
            owner: string | null;
            epoch: number;
            id: string | null;
        } | null;
        executor: {
            platform: string;
            cli_tool: string;
        } | null;
    };
    requests: {
        request_id: string;
        type: string;
        status: string;
        payload: unknown;
        claimed_by_run_id: string | null;
    }[];
    lifecycle: {
        sealed_at: string | null;
        seal_summary: string | null;
        promoted_spec_ids: string[];
        promoted_knowhow_ids: string[];
        forked_from: {
            session_id: string;
            run_id: string;
        } | null;
    };
    refs: {
        gates: "gates.json";
        artifacts: "artifacts.json";
        evidence: "evidence.json";
    };
} | {
    status: "paused" | "running" | "failed" | "sealed" | "archived";
    session_id: string;
    identity_revision: number;
    activity_revision: number;
    active_run_id: string | null;
    orchestration: {
        engine: "ralph" | "manual" | "coordinator";
        quality_mode: "quick" | "standard" | "full";
        auto_mode: boolean;
        chain: {
            step_id: string;
            command: string;
            status: "running" | "completed" | "failed" | "skipped" | "pending" | "sealed";
            run_id: string | null;
            inserted_by: string;
            decision_ref: string | null;
            args?: string | undefined;
            stage?: string | null | undefined;
            goal_ref?: string | null | undefined;
            retry?: {
                count: number;
                max: number;
            } | undefined;
            pending_retry?: {
                token: string;
                session_id: string;
                parent_run_id: string;
                chain_step_id: string;
                command: string;
                issued_at: string;
                expires_at: string;
            } | null | undefined;
        }[];
        decision_points: {
            point_id: string;
            after_step_id: string | null;
            status: "pending" | "passed" | "escalated";
            retry_count: number;
            max_retries: number;
            evidence_ref: string | null;
        }[];
        position: {
            lifecycle: string;
            phase: number | null;
            phase_is_new: boolean;
            milestone: string;
            planning_mode: string | null;
            passed_gates: string[];
            scope_verdict: string | null;
        } | null;
        decomposition: {
            execution_criteria: string[];
            goals: {
                id: string;
                goal: string;
                status: "pending" | "superseded" | "done";
                boundary?: string | undefined;
                done_when?: string | undefined;
                evidence?: string | undefined;
                lifecycle?: string[] | undefined;
                completion_confirmed?: boolean | undefined;
                completed_at?: string | null | undefined;
                superseded_by?: string | null | undefined;
                superseded_at?: string | null | undefined;
                origin?: string | null | undefined;
            }[];
            changelog: {
                id: string;
                timestamp: string;
                change_type: "modify" | "boundary" | "add" | "remove";
                reason: string;
                before: {
                    goals: {
                        id: string;
                        goal: string;
                        done_when?: string | undefined;
                    }[];
                    boundary_snippet?: string | undefined;
                };
                after: {
                    goals: {
                        id: string;
                        goal: string;
                        done_when?: string | undefined;
                    }[];
                    boundary_snippet?: string | undefined;
                };
                impact_assessment?: {
                    risk_level: "low" | "medium" | "high";
                    invalidated_steps: number[];
                    new_steps_inserted: number;
                } | undefined;
            }[];
        } | null;
        lease: {
            owner: string | null;
            epoch: number;
            id: string | null;
        } | null;
        executor: {
            platform: string;
            cli_tool: string;
        } | null;
    };
    intent: string;
    boundary_contract: {
        in_scope: string[];
        out_of_scope: string[];
        constraints: string[];
        definition_of_done: string;
    };
    refs: {
        gates: "gates.json";
        artifacts: "artifacts.json";
        evidence: "evidence.json";
    };
    lifecycle: {
        sealed_at: string | null;
        seal_summary: string | null;
        promoted_spec_ids: string[];
        promoted_knowhow_ids: string[];
        forked_from: {
            session_id: string;
            run_id: string;
        } | null;
    };
    latest_completed_run_id: string | null;
    schema_version: "session/1.2";
    intent_identity: {
        schema_version: "intent-identity/1.0";
        normalization: "NFKC+unicode-lower+whitespace-collapse/1";
        workspace_id: string;
        command: string;
        verbatim: string;
        normalized: string;
        normalized_length: number;
        normalized_hash: string;
        revision: 1;
        source: "persisted" | "derived_legacy";
        backfill_status: "native" | "derived" | "collision" | "unavailable";
        empty: boolean;
    } | null;
    provenance: {
        source: "fork" | "native" | "import" | "legacy-inferred";
        forked_from: {
            workspace_id: string;
            workspace_link_name: string | null;
            session_id: string;
            session_schema_version: "session/1.0" | "session/1.1" | "session/1.2" | "session/1.3";
            session_identity_revision: number;
            session_activity_revision: number;
            session_hash: string;
            run_id: string;
            run_schema_version: "command-run/1.0" | "command-run/1.1" | "command-run/1.2" | "command-run/1.3";
            run_hash: string;
            artifact_registry_revision: number;
            selected_artifacts: {
                kind: string;
                relative_path: string;
                content_hash: string;
            }[];
        } | null;
        imported_from: {
            workspace_id: string;
            workspace_link_name: string | null;
            session_id: string;
            session_schema_version: "session/1.0" | "session/1.1" | "session/1.2" | "session/1.3";
            session_identity_revision: number;
            session_activity_revision: number;
            session_hash: string;
            run_id: string;
            run_schema_version: "command-run/1.0" | "command-run/1.1" | "command-run/1.2" | "command-run/1.3";
            run_hash: string;
            artifact_registry_revision: number;
            selected_artifacts: {
                kind: string;
                relative_path: string;
                content_hash: string;
            }[];
        }[];
        created_by: string;
    };
    requests: ({
        request_id: string;
        type: "transition";
        status: "applied" | "rejected";
        payload: {
            schema_version: "transition-request/1.0";
            request_id: string;
            operation: "fork" | "create" | "decide" | "import" | "resume" | "next" | "complete" | "resolve" | "ralph-retry" | "chain-insert" | "chain-replace" | "chain-skip" | "meta-update" | "accept-reuse" | "artifact-republish";
            subject: {
                session_id: string;
                run_id: string | null;
                chain_step_id: string | null;
            };
            normalized_request_hash: string;
            requested_at: string;
            preconditions: {
                session_identity_revision: number;
                session_activity_revision: number;
                active_run_id: string | null;
                run_hash: string | null;
                artifact_registry_revision: number | null;
            };
            payload: Record<string, unknown>;
        };
        claimed_by_run_id: string | null;
        outcome: {
            schema_version: "transition-outcome/1.0";
            transition_id: string;
            request_id: string;
            request_hash: string;
            operation: "fork" | "create" | "decide" | "import" | "resume" | "next" | "complete" | "resolve" | "ralph-retry" | "chain-insert" | "chain-replace" | "chain-skip" | "meta-update" | "accept-reuse" | "artifact-republish";
            status: "applied" | "rejected";
            applied_at: string;
            subject: {
                session_id: string;
                run_id: string | null;
                chain_step_id: string | null;
            };
            postconditions: {
                session_identity_revision: number;
                session_activity_revision: number;
                active_run_id: string | null;
                run_hash: string | null;
                artifact_registry_revision: number | null;
            };
            exit_code: 0 | 1 | 2 | 3;
            error_code: string | null;
            result_hash: string;
            result: Record<string, unknown>;
        };
    } | {
        request_id: string;
        type: string;
        status: string;
        payload: unknown;
        claimed_by_run_id: string | null;
    })[];
    ralph_authority: {
        schema_version: "ralph-authority/1.0";
        engine: "ralph";
        canonical_complete: boolean;
    } | null;
} | {
    status: "paused" | "running" | "failed" | "sealed" | "archived";
    session_id: string;
    identity_revision: number;
    activity_revision: number;
    active_run_id: string | null;
    provenance: {
        source: "fork" | "native" | "import" | "legacy-inferred";
        forked_from: {
            workspace_id: string;
            workspace_link_name: string | null;
            session_id: string;
            session_schema_version: "session/1.0" | "session/1.1" | "session/1.2" | "session/1.3";
            session_identity_revision: number;
            session_activity_revision: number;
            session_hash: string;
            run_id: string;
            run_schema_version: "command-run/1.0" | "command-run/1.1" | "command-run/1.2" | "command-run/1.3";
            run_hash: string;
            artifact_registry_revision: number;
            selected_artifacts: {
                kind: string;
                relative_path: string;
                content_hash: string;
            }[];
        } | null;
        imported_from: {
            workspace_id: string;
            workspace_link_name: string | null;
            session_id: string;
            session_schema_version: "session/1.0" | "session/1.1" | "session/1.2" | "session/1.3";
            session_identity_revision: number;
            session_activity_revision: number;
            session_hash: string;
            run_id: string;
            run_schema_version: "command-run/1.0" | "command-run/1.1" | "command-run/1.2" | "command-run/1.3";
            run_hash: string;
            artifact_registry_revision: number;
            selected_artifacts: {
                kind: string;
                relative_path: string;
                content_hash: string;
            }[];
        }[];
        created_by: string;
    };
    orchestration: {
        engine: "ralph" | "manual" | "coordinator";
        quality_mode: "quick" | "standard" | "full";
        auto_mode: boolean;
        chain: {
            step_id: string;
            command: string;
            status: "running" | "completed" | "failed" | "skipped" | "pending" | "sealed";
            run_id: string | null;
            inserted_by: string;
            decision_ref: string | null;
            args?: string | undefined;
            stage?: string | null | undefined;
            goal_ref?: string | null | undefined;
            retry?: {
                count: number;
                max: number;
            } | undefined;
            pending_retry?: {
                token: string;
                session_id: string;
                parent_run_id: string;
                chain_step_id: string;
                command: string;
                issued_at: string;
                expires_at: string;
            } | null | undefined;
        }[];
        decision_points: {
            point_id: string;
            after_step_id: string | null;
            status: "pending" | "passed" | "escalated";
            retry_count: number;
            max_retries: number;
            evidence_ref: string | null;
        }[];
        position: {
            lifecycle: string;
            phase: number | null;
            phase_is_new: boolean;
            milestone: string;
            planning_mode: string | null;
            passed_gates: string[];
            scope_verdict: string | null;
        } | null;
        decomposition: {
            execution_criteria: string[];
            goals: {
                id: string;
                goal: string;
                status: "pending" | "superseded" | "done";
                boundary?: string | undefined;
                done_when?: string | undefined;
                evidence?: string | undefined;
                lifecycle?: string[] | undefined;
                completion_confirmed?: boolean | undefined;
                completed_at?: string | null | undefined;
                superseded_by?: string | null | undefined;
                superseded_at?: string | null | undefined;
                origin?: string | null | undefined;
            }[];
            changelog: {
                id: string;
                timestamp: string;
                change_type: "modify" | "boundary" | "add" | "remove";
                reason: string;
                before: {
                    goals: {
                        id: string;
                        goal: string;
                        done_when?: string | undefined;
                    }[];
                    boundary_snippet?: string | undefined;
                };
                after: {
                    goals: {
                        id: string;
                        goal: string;
                        done_when?: string | undefined;
                    }[];
                    boundary_snippet?: string | undefined;
                };
                impact_assessment?: {
                    risk_level: "low" | "medium" | "high";
                    invalidated_steps: number[];
                    new_steps_inserted: number;
                } | undefined;
            }[];
        } | null;
        lease: {
            owner: string | null;
            epoch: number;
            id: string | null;
        } | null;
        executor: {
            platform: string;
            cli_tool: string;
        } | null;
    };
    intent: string;
    boundary_contract: {
        in_scope: string[];
        out_of_scope: string[];
        constraints: string[];
        definition_of_done: string;
    };
    refs: {
        gates: "gates.json";
        artifacts: "artifacts.json";
        evidence: "evidence.json";
    };
    intent_identity: {
        schema_version: "intent-identity/1.0";
        normalization: "NFKC+unicode-lower+whitespace-collapse/1";
        workspace_id: string;
        command: string;
        verbatim: string;
        normalized: string;
        normalized_length: number;
        normalized_hash: string;
        revision: 1;
        source: "persisted" | "derived_legacy";
        backfill_status: "native" | "derived" | "collision" | "unavailable";
        empty: boolean;
    } | null;
    lifecycle: {
        sealed_at: string | null;
        seal_summary: string | null;
        promoted_spec_ids: string[];
        promoted_knowhow_ids: string[];
        forked_from: {
            session_id: string;
            run_id: string;
        } | null;
    };
    latest_completed_run_id: string | null;
    requests: ({
        request_id: string;
        type: "transition";
        status: "applied" | "rejected";
        payload: {
            schema_version: "transition-request/1.0";
            request_id: string;
            operation: "fork" | "create" | "decide" | "import" | "resume" | "next" | "complete" | "resolve" | "ralph-retry" | "chain-insert" | "chain-replace" | "chain-skip" | "meta-update" | "accept-reuse" | "artifact-republish";
            subject: {
                session_id: string;
                run_id: string | null;
                chain_step_id: string | null;
            };
            normalized_request_hash: string;
            requested_at: string;
            preconditions: {
                session_identity_revision: number;
                session_activity_revision: number;
                active_run_id: string | null;
                run_hash: string | null;
                artifact_registry_revision: number | null;
            };
            payload: Record<string, unknown>;
        };
        claimed_by_run_id: string | null;
        outcome: {
            schema_version: "transition-outcome/1.0";
            transition_id: string;
            request_id: string;
            request_hash: string;
            operation: "fork" | "create" | "decide" | "import" | "resume" | "next" | "complete" | "resolve" | "ralph-retry" | "chain-insert" | "chain-replace" | "chain-skip" | "meta-update" | "accept-reuse" | "artifact-republish";
            status: "applied" | "rejected";
            applied_at: string;
            subject: {
                session_id: string;
                run_id: string | null;
                chain_step_id: string | null;
            };
            postconditions: {
                session_identity_revision: number;
                session_activity_revision: number;
                active_run_id: string | null;
                run_hash: string | null;
                artifact_registry_revision: number | null;
            };
            exit_code: 0 | 1 | 2 | 3;
            error_code: string | null;
            result_hash: string;
            result: Record<string, unknown>;
        };
    } | {
        request_id: string;
        type: string;
        status: string;
        payload: unknown;
        claimed_by_run_id: string | null;
    })[];
    ralph_authority: {
        schema_version: "ralph-authority/1.0";
        engine: "ralph";
        canonical_complete: boolean;
    } | null;
    schema_version: "session/1.3";
    topic_identity: {
        schema_version: "topic-identity/1.0";
        normalization: "NFKC+unicode-lower+whitespace-collapse/1";
        workspace_id: string;
        source: "explicit" | "workflow" | "legacy-intent";
        verbatim: string;
        normalized: string;
        normalized_length: number;
        normalized_hash: string;
        identity_hash: string;
        revision: 1;
    } | null;
}>>;
export declare const gateSchema: z.ZodObject<{
    key: z.ZodString;
    title: z.ZodString;
    scope: z.ZodEnum<{
        phase: "phase";
        session: "session";
        knowledge: "knowledge";
        transition: "transition";
        entry: "entry";
        exit: "exit";
    }>;
    run_id: z.ZodNullable<z.ZodString>;
    required: z.ZodBoolean;
    blocking: z.ZodBoolean;
    applicable_modes: z.ZodArray<z.ZodEnum<{
        quick: "quick";
        standard: "standard";
        full: "full";
    }>>;
    status: z.ZodEnum<{
        running: "running";
        failed: "failed";
        skipped: "skipped";
        pending: "pending";
        blocked: "blocked";
        passed: "passed";
        waived: "waived";
    }>;
    check: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"session">;
        field: z.ZodString;
        equals: z.ZodUnknown;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"artifact">;
        kind: z.ZodString;
        require_status: z.ZodOptional<z.ZodLiteral<"sealed">>;
        alias: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"file">;
        path: z.ZodString;
        exists: z.ZodBoolean;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"schema">;
        artifact_ref: z.ZodString;
        schema_id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"command">;
        argv: z.ZodArray<z.ZodString>;
        expect_exit: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"decision">;
        point: z.ZodString;
        outcome: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"manual">;
        prompt: z.ZodString;
    }, z.core.$strict>], "type">;
    evidence_refs: z.ZodArray<z.ZodString>;
    waiver: z.ZodNullable<z.ZodObject<{
        reason: z.ZodString;
        approved_by: z.ZodString;
        approved_at: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const gateRegistrySchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"gates/1.0">;
    revision: z.ZodNumber;
    gates: z.ZodRecord<z.ZodString, z.ZodObject<{
        key: z.ZodString;
        title: z.ZodString;
        scope: z.ZodEnum<{
            phase: "phase";
            session: "session";
            knowledge: "knowledge";
            transition: "transition";
            entry: "entry";
            exit: "exit";
        }>;
        run_id: z.ZodNullable<z.ZodString>;
        required: z.ZodBoolean;
        blocking: z.ZodBoolean;
        applicable_modes: z.ZodArray<z.ZodEnum<{
            quick: "quick";
            standard: "standard";
            full: "full";
        }>>;
        status: z.ZodEnum<{
            running: "running";
            failed: "failed";
            skipped: "skipped";
            pending: "pending";
            blocked: "blocked";
            passed: "passed";
            waived: "waived";
        }>;
        check: z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"session">;
            field: z.ZodString;
            equals: z.ZodUnknown;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"artifact">;
            kind: z.ZodString;
            require_status: z.ZodOptional<z.ZodLiteral<"sealed">>;
            alias: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"file">;
            path: z.ZodString;
            exists: z.ZodBoolean;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"schema">;
            artifact_ref: z.ZodString;
            schema_id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"command">;
            argv: z.ZodArray<z.ZodString>;
            expect_exit: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"decision">;
            point: z.ZodString;
            outcome: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"manual">;
            prompt: z.ZodString;
        }, z.core.$strict>], "type">;
        evidence_refs: z.ZodArray<z.ZodString>;
        waiver: z.ZodNullable<z.ZodObject<{
            reason: z.ZodString;
            approved_by: z.ZodString;
            approved_at: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    summary: z.ZodObject<{
        total: z.ZodNumber;
        passed: z.ZodNumber;
        blocked: z.ZodNumber;
        failed: z.ZodNumber;
        active_gate_ids: z.ZodArray<z.ZodString>;
        blocking_run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const artifactSchema: z.ZodObject<{
    kind: z.ZodString;
    role: z.ZodEnum<{
        primary: "primary";
        attachment: "attachment";
        evidence: "evidence";
        checkpoint: "checkpoint";
        report: "report";
    }>;
    producer_run_id: z.ZodString;
    relative_path: z.ZodString;
    media_type: z.ZodString;
    schema_version: z.ZodString;
    content_hash: z.ZodString;
    size: z.ZodNumber;
    status: z.ZodEnum<{
        invalid: "invalid";
        sealed: "sealed";
        draft: "draft";
        superseded: "superseded";
    }>;
    derived_from: z.ZodArray<z.ZodString>;
    replaces: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const artifactRegistrySchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"artifacts/1.0">;
    revision: z.ZodNumber;
    artifacts: z.ZodRecord<z.ZodString, z.ZodObject<{
        kind: z.ZodString;
        role: z.ZodEnum<{
            primary: "primary";
            attachment: "attachment";
            evidence: "evidence";
            checkpoint: "checkpoint";
            report: "report";
        }>;
        producer_run_id: z.ZodString;
        relative_path: z.ZodString;
        media_type: z.ZodString;
        schema_version: z.ZodString;
        content_hash: z.ZodString;
        size: z.ZodNumber;
        status: z.ZodEnum<{
            invalid: "invalid";
            sealed: "sealed";
            draft: "draft";
            superseded: "superseded";
        }>;
        derived_from: z.ZodArray<z.ZodString>;
        replaces: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    aliases: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$strict>;
export declare const evidenceRecordSchema: z.ZodObject<{
    run_id: z.ZodString;
    command: z.ZodString;
    kind: z.ZodString;
    point: z.ZodString;
    claim: z.ZodString;
    outcome: z.ZodString;
    rationale: z.ZodString;
    status: z.ZodEnum<{
        superseded: "superseded";
        rejected: "rejected";
        accepted: "accepted";
        proposed: "proposed";
    }>;
    artifact_refs: z.ZodArray<z.ZodString>;
    gate_refs: z.ZodArray<z.ZodString>;
    source_refs: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const evidenceStoreSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"evidence/1.0">;
    revision: z.ZodNumber;
    records: z.ZodRecord<z.ZodString, z.ZodObject<{
        run_id: z.ZodString;
        command: z.ZodString;
        kind: z.ZodString;
        point: z.ZodString;
        claim: z.ZodString;
        outcome: z.ZodString;
        rationale: z.ZodString;
        status: z.ZodEnum<{
            superseded: "superseded";
            rejected: "rejected";
            accepted: "accepted";
            proposed: "proposed";
        }>;
        artifact_refs: z.ZodArray<z.ZodString>;
        gate_refs: z.ZodArray<z.ZodString>;
        source_refs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const handoffSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"command-handoff/1.0">;
    producer_run_id: z.ZodString;
    command: z.ZodString;
    verdict: z.ZodEnum<{
        failed: "failed";
        blocked: "blocked";
        ready: "ready";
        ready_with_concerns: "ready_with_concerns";
    }>;
    summary: z.ZodString;
    constraints: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<{
            open: "open";
            locked: "locked";
            deferred: "deferred";
        }>;
        text: z.ZodString;
    }, z.core.$strict>>;
    decisions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<{
            rejected: "rejected";
            accepted: "accepted";
            proposed: "proposed";
        }>;
        text: z.ZodString;
    }, z.core.$strict>>;
    concerns: z.ZodArray<z.ZodString>;
    artifact_refs: z.ZodArray<z.ZodString>;
    next: z.ZodArray<z.ZodObject<{
        command: z.ZodString;
        reason: z.ZodString;
        needs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>;
export declare const targetPlatformSchema: z.ZodEnum<{
    claude: "claude";
    codex: "codex";
    pi: "pi";
    grok: "grok";
    agy: "agy";
    "agents-standard": "agents-standard";
    cursor: "cursor";
}>;
export declare const goalBindingSchema: z.ZodObject<{
    provider: z.ZodString;
    external_id: z.ZodNullable<z.ZodString>;
    step_goal_ref: z.ZodNullable<z.ZodString>;
    observed_status: z.ZodEnum<{
        unknown: "unknown";
        blocked: "blocked";
        active: "active";
        complete: "complete";
    }>;
    observed_at: z.ZodString;
}, z.core.$strict>;
export declare const dispatchExpectationSchema: z.ZodObject<{
    run_id: z.ZodString;
    chain_step_id: z.ZodString;
    team_task_id: z.ZodString;
    revision: z.ZodNumber;
    dispatched_at: z.ZodString;
}, z.core.$strict>;
export declare const runCheckpointSchema: z.ZodObject<{
    run_id: z.ZodString;
    chain_step_id: z.ZodString;
    team_task_id: z.ZodString;
    revision: z.ZodNumber;
    artifact_id: z.ZodNullable<z.ZodString>;
    verdict: z.ZodEnum<{
        unknown: "unknown";
        pass: "pass";
        warn: "warn";
        block: "block";
    }>;
    authoritative: z.ZodBoolean;
    updated_at: z.ZodString;
}, z.core.$strict>;
export declare const retryFenceSchema: z.ZodObject<{
    token: z.ZodString;
    chain_step_id: z.ZodString;
    issued_at: z.ZodString;
    expires_at: z.ZodString;
    consumed_at: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const commandRunV1Schema: z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.0">;
}, z.core.$strict>;
export declare const commandRunV11Schema: z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.1">;
    chain_step_id: z.ZodNullable<z.ZodString>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const commandRunV12Schema: z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.2">;
    chain_step_id: z.ZodNullable<z.ZodString>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const commandRunV13Schema: z.ZodObject<{
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    sealed_at: z.ZodNullable<z.ZodString>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    session_id: z.ZodString;
    run_id: z.ZodString;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    chain_step_id: z.ZodNullable<z.ZodString>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    parent_run_id: z.ZodNullable<z.ZodString>;
    completed_at: z.ZodNullable<z.ZodString>;
    started_at: z.ZodString;
    sequence: z.ZodNumber;
    gate_ids: z.ZodArray<z.ZodString>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<"command-run/1.3">;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
        reuse_assessments: z.ZodArray<z.ZodObject<{
            schema_version: z.ZodLiteral<"reuse-assessment/1.0">;
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            source_fence: z.ZodObject<{
                schema_version: z.ZodLiteral<"reuse-source-fence/1.0">;
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            assessment_hash: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const commandRunV14Schema: z.ZodObject<{
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    sealed_at: z.ZodNullable<z.ZodString>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    session_id: z.ZodString;
    run_id: z.ZodString;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    chain_step_id: z.ZodNullable<z.ZodString>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    parent_run_id: z.ZodNullable<z.ZodString>;
    completed_at: z.ZodNullable<z.ZodString>;
    started_at: z.ZodString;
    sequence: z.ZodNumber;
    gate_ids: z.ZodArray<z.ZodString>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<"command-run/1.4">;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
        reuse_assessments: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            assessment_hash: z.ZodString;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            schema_version: z.ZodLiteral<"reuse-assessment/1.1">;
            source_fence: z.ZodObject<{
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
                schema_version: z.ZodLiteral<"reuse-source-fence/1.1">;
                execution_seal_receipt: z.ZodObject<{
                    execution_id: z.ZodString;
                    generation: z.ZodNumber;
                    sealed_at: z.ZodString;
                    relative_path: z.ZodString;
                    overall_hash: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            schema_version: z.ZodLiteral<"reuse-assessment/1.0">;
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            source_fence: z.ZodObject<{
                schema_version: z.ZodLiteral<"reuse-source-fence/1.0">;
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            assessment_hash: z.ZodString;
        }, z.core.$strict>]>>;
    }, z.core.$strict>;
    execution_id: z.ZodString;
    generation: z.ZodNumber;
}, z.core.$strict>;
export declare const runStatusV30Schema: z.ZodEnum<{
    running: "running";
    completed: "completed";
    failed: "failed";
    pending: "pending";
    blocked: "blocked";
    sealed: "sealed";
    cancelled: "cancelled";
}>;
export declare const runV30Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"run/3.0">;
    run_id: z.ZodString;
    session_id: z.ZodString;
    step_id: z.ZodString;
    parent_run_id: z.ZodNullable<z.ZodString>;
    retry_of_run_id: z.ZodNullable<z.ZodString>;
    attempt: z.ZodNumber;
    command: z.ZodString;
    args: z.ZodArray<z.ZodString>;
    command_contract_hash: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    goal: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        pending: "pending";
        blocked: "blocked";
        sealed: "sealed";
        cancelled: "cancelled";
    }>;
    revision: z.ZodNumber;
    actor_id: z.ZodString;
    input_refs: z.ZodArray<z.ZodString>;
    output_refs: z.ZodArray<z.ZodString>;
    primary_artifact_id: z.ZodNullable<z.ZodString>;
    verdict: z.ZodNullable<z.ZodEnum<{
        blocked: "blocked";
        done: "done";
        done_with_concerns: "done_with_concerns";
        needs_retry: "needs_retry";
    }>>;
    summary: z.ZodNullable<z.ZodString>;
    legacy_execution_generation: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    created_at: z.ZodString;
    started_at: z.ZodNullable<z.ZodString>;
    ended_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/**
 * Read-tolerant run/3.0 variant. Pre-simplification documents may still carry
 * the retired `participant_id`/`gate_refs` fields; they are stripped on read
 * so the write path stays strict and never re-emits them.
 */
export declare const runV30ReadSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"run/3.0">;
    run_id: z.ZodString;
    session_id: z.ZodString;
    step_id: z.ZodString;
    parent_run_id: z.ZodNullable<z.ZodString>;
    retry_of_run_id: z.ZodNullable<z.ZodString>;
    attempt: z.ZodNumber;
    command: z.ZodString;
    args: z.ZodArray<z.ZodString>;
    command_contract_hash: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    goal: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        pending: "pending";
        blocked: "blocked";
        sealed: "sealed";
        cancelled: "cancelled";
    }>;
    revision: z.ZodNumber;
    actor_id: z.ZodString;
    input_refs: z.ZodArray<z.ZodString>;
    output_refs: z.ZodArray<z.ZodString>;
    primary_artifact_id: z.ZodNullable<z.ZodString>;
    verdict: z.ZodNullable<z.ZodEnum<{
        blocked: "blocked";
        done: "done";
        done_with_concerns: "done_with_concerns";
        needs_retry: "needs_retry";
    }>>;
    summary: z.ZodNullable<z.ZodString>;
    legacy_execution_generation: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    created_at: z.ZodString;
    started_at: z.ZodNullable<z.ZodString>;
    ended_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const commandRunReadSchema: z.ZodUnion<readonly [z.ZodObject<{
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    sealed_at: z.ZodNullable<z.ZodString>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    session_id: z.ZodString;
    run_id: z.ZodString;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    chain_step_id: z.ZodNullable<z.ZodString>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    parent_run_id: z.ZodNullable<z.ZodString>;
    completed_at: z.ZodNullable<z.ZodString>;
    started_at: z.ZodString;
    sequence: z.ZodNumber;
    gate_ids: z.ZodArray<z.ZodString>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<"command-run/1.4">;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
        reuse_assessments: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            assessment_hash: z.ZodString;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            schema_version: z.ZodLiteral<"reuse-assessment/1.1">;
            source_fence: z.ZodObject<{
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
                schema_version: z.ZodLiteral<"reuse-source-fence/1.1">;
                execution_seal_receipt: z.ZodObject<{
                    execution_id: z.ZodString;
                    generation: z.ZodNumber;
                    sealed_at: z.ZodString;
                    relative_path: z.ZodString;
                    overall_hash: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            schema_version: z.ZodLiteral<"reuse-assessment/1.0">;
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            source_fence: z.ZodObject<{
                schema_version: z.ZodLiteral<"reuse-source-fence/1.0">;
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            assessment_hash: z.ZodString;
        }, z.core.$strict>]>>;
    }, z.core.$strict>;
    execution_id: z.ZodString;
    generation: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    sealed_at: z.ZodNullable<z.ZodString>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    session_id: z.ZodString;
    run_id: z.ZodString;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    chain_step_id: z.ZodNullable<z.ZodString>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    parent_run_id: z.ZodNullable<z.ZodString>;
    completed_at: z.ZodNullable<z.ZodString>;
    started_at: z.ZodString;
    sequence: z.ZodNumber;
    gate_ids: z.ZodArray<z.ZodString>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<"command-run/1.3">;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
        reuse_assessments: z.ZodArray<z.ZodObject<{
            schema_version: z.ZodLiteral<"reuse-assessment/1.0">;
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            source_fence: z.ZodObject<{
                schema_version: z.ZodLiteral<"reuse-source-fence/1.0">;
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            assessment_hash: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.2">;
    chain_step_id: z.ZodNullable<z.ZodString>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.1">;
    chain_step_id: z.ZodNullable<z.ZodString>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.0">;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodString;
}, z.core.$loose>]>;
/** Canonical Run reader for legacy command-run documents, v3, and unknown future versions. */
export declare const runReadSchema: z.ZodUnion<readonly [z.ZodObject<{
    schema_version: z.ZodLiteral<"run/3.0">;
    run_id: z.ZodString;
    session_id: z.ZodString;
    step_id: z.ZodString;
    parent_run_id: z.ZodNullable<z.ZodString>;
    retry_of_run_id: z.ZodNullable<z.ZodString>;
    attempt: z.ZodNumber;
    command: z.ZodString;
    args: z.ZodArray<z.ZodString>;
    command_contract_hash: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    goal: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        pending: "pending";
        blocked: "blocked";
        sealed: "sealed";
        cancelled: "cancelled";
    }>;
    revision: z.ZodNumber;
    actor_id: z.ZodString;
    input_refs: z.ZodArray<z.ZodString>;
    output_refs: z.ZodArray<z.ZodString>;
    primary_artifact_id: z.ZodNullable<z.ZodString>;
    verdict: z.ZodNullable<z.ZodEnum<{
        blocked: "blocked";
        done: "done";
        done_with_concerns: "done_with_concerns";
        needs_retry: "needs_retry";
    }>>;
    summary: z.ZodNullable<z.ZodString>;
    legacy_execution_generation: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    created_at: z.ZodString;
    started_at: z.ZodNullable<z.ZodString>;
    ended_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    sealed_at: z.ZodNullable<z.ZodString>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    session_id: z.ZodString;
    run_id: z.ZodString;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    chain_step_id: z.ZodNullable<z.ZodString>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    parent_run_id: z.ZodNullable<z.ZodString>;
    completed_at: z.ZodNullable<z.ZodString>;
    started_at: z.ZodString;
    sequence: z.ZodNumber;
    gate_ids: z.ZodArray<z.ZodString>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<"command-run/1.4">;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
        reuse_assessments: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            assessment_hash: z.ZodString;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            schema_version: z.ZodLiteral<"reuse-assessment/1.1">;
            source_fence: z.ZodObject<{
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
                schema_version: z.ZodLiteral<"reuse-source-fence/1.1">;
                execution_seal_receipt: z.ZodObject<{
                    execution_id: z.ZodString;
                    generation: z.ZodNumber;
                    sealed_at: z.ZodString;
                    relative_path: z.ZodString;
                    overall_hash: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            schema_version: z.ZodLiteral<"reuse-assessment/1.0">;
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            source_fence: z.ZodObject<{
                schema_version: z.ZodLiteral<"reuse-source-fence/1.0">;
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            assessment_hash: z.ZodString;
        }, z.core.$strict>]>>;
    }, z.core.$strict>;
    execution_id: z.ZodString;
    generation: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    sealed_at: z.ZodNullable<z.ZodString>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    session_id: z.ZodString;
    run_id: z.ZodString;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    chain_step_id: z.ZodNullable<z.ZodString>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    parent_run_id: z.ZodNullable<z.ZodString>;
    completed_at: z.ZodNullable<z.ZodString>;
    started_at: z.ZodString;
    sequence: z.ZodNumber;
    gate_ids: z.ZodArray<z.ZodString>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<"command-run/1.3">;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
        reuse_assessments: z.ZodArray<z.ZodObject<{
            schema_version: z.ZodLiteral<"reuse-assessment/1.0">;
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            source_fence: z.ZodObject<{
                schema_version: z.ZodLiteral<"reuse-source-fence/1.0">;
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            assessment_hash: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.2">;
    chain_step_id: z.ZodNullable<z.ZodString>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.1">;
    chain_step_id: z.ZodNullable<z.ZodString>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.0">;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodString;
}, z.core.$loose>]>;
export type CommandRunInput = z.infer<typeof commandRunReadSchema>;
export type RunRead = z.infer<typeof runReadSchema>;
export type CommandRun = z.infer<typeof commandRunV13Schema>;
export type CommandRunV14 = z.infer<typeof commandRunV14Schema>;
export type RunV30 = z.infer<typeof runV30Schema>;
export declare function normalizeCommandRun(run: CommandRunInput, fallbackPlatform?: z.infer<typeof targetPlatformSchema>): CommandRun;
/**
 * Promote either compatibility or execution-bound input to command-run/1.4.
 * Callers reading a legacy Run must supply its resolved Execution binding;
 * no synthetic execution identity is inferred at the schema boundary.
 */
export declare function normalizeCommandRunV14(run: CommandRunInput, binding?: {
    execution_id: string;
    generation: number;
}, fallbackPlatform?: z.infer<typeof targetPlatformSchema>): CommandRunV14;
/** Backward-compatible read schema. New legacy-path writes must use commandRunV13Schema. */
export declare const commandRunSchema: z.ZodPipe<z.ZodUnion<readonly [z.ZodObject<{
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    sealed_at: z.ZodNullable<z.ZodString>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    session_id: z.ZodString;
    run_id: z.ZodString;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    chain_step_id: z.ZodNullable<z.ZodString>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    parent_run_id: z.ZodNullable<z.ZodString>;
    completed_at: z.ZodNullable<z.ZodString>;
    started_at: z.ZodString;
    sequence: z.ZodNumber;
    gate_ids: z.ZodArray<z.ZodString>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<"command-run/1.4">;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
        reuse_assessments: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            assessment_hash: z.ZodString;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            schema_version: z.ZodLiteral<"reuse-assessment/1.1">;
            source_fence: z.ZodObject<{
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
                schema_version: z.ZodLiteral<"reuse-source-fence/1.1">;
                execution_seal_receipt: z.ZodObject<{
                    execution_id: z.ZodString;
                    generation: z.ZodNumber;
                    sealed_at: z.ZodString;
                    relative_path: z.ZodString;
                    overall_hash: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            schema_version: z.ZodLiteral<"reuse-assessment/1.0">;
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            source_fence: z.ZodObject<{
                schema_version: z.ZodLiteral<"reuse-source-fence/1.0">;
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            assessment_hash: z.ZodString;
        }, z.core.$strict>]>>;
    }, z.core.$strict>;
    execution_id: z.ZodString;
    generation: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    sealed_at: z.ZodNullable<z.ZodString>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    session_id: z.ZodString;
    run_id: z.ZodString;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    chain_step_id: z.ZodNullable<z.ZodString>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    parent_run_id: z.ZodNullable<z.ZodString>;
    completed_at: z.ZodNullable<z.ZodString>;
    started_at: z.ZodString;
    sequence: z.ZodNumber;
    gate_ids: z.ZodArray<z.ZodString>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<"command-run/1.3">;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
        reuse_assessments: z.ZodArray<z.ZodObject<{
            schema_version: z.ZodLiteral<"reuse-assessment/1.0">;
            decision: z.ZodEnum<{
                REUSE: "REUSE";
                REVIEW: "REVIEW";
                CONFLICT: "CONFLICT";
                REJECT: "REJECT";
            }>;
            reason_codes: z.ZodArray<z.ZodString>;
            consumer: z.ZodObject<{
                kind: z.ZodString;
                alias: z.ZodNullable<z.ZodString>;
                schema: z.ZodNullable<z.ZodString>;
                role: z.ZodNullable<z.ZodEnum<{
                    primary: "primary";
                    attachment: "attachment";
                    evidence: "evidence";
                    checkpoint: "checkpoint";
                }>>;
            }, z.core.$strict>;
            source_fence: z.ZodObject<{
                schema_version: z.ZodLiteral<"reuse-source-fence/1.0">;
                workspace_id: z.ZodString;
                session_id: z.ZodString;
                producer_run_id: z.ZodString;
                producer_run_hash: z.ZodNullable<z.ZodString>;
                producer_status: z.ZodEnum<{
                    running: "running";
                    completed: "completed";
                    failed: "failed";
                    created: "created";
                    blocked: "blocked";
                    sealed: "sealed";
                }>;
                artifact_id: z.ZodString;
                artifact_role: z.ZodString;
                artifact_status: z.ZodEnum<{
                    invalid: "invalid";
                    sealed: "sealed";
                    draft: "draft";
                    superseded: "superseded";
                }>;
                artifact_hash: z.ZodNullable<z.ZodString>;
                observed_artifact_hash: z.ZodNullable<z.ZodString>;
                artifact_schema: z.ZodNullable<z.ZodString>;
                artifact_registry_revision: z.ZodNullable<z.ZodNumber>;
                producer_contract_hash: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            assessment_hash: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.2">;
    chain_step_id: z.ZodNullable<z.ZodString>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    contract_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"contract-snapshot/1.0">;
        contract_version: z.ZodEnum<{
            "command-contract/1.0": "command-contract/1.0";
            "command-contract/2.0": "command-contract/2.0";
            "command-contract/2.1": "command-contract/2.1";
        }>;
        normalized: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        snapshot_hash: z.ZodString;
        parser_version: z.ZodLiteral<"maestro-command-contract/2">;
        captured_at: z.ZodString;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    guidance_snapshot: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"guidance-snapshot/1.0">;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        prepare_hash: z.ZodNullable<z.ZodString>;
        workflow_hash: z.ZodNullable<z.ZodString>;
        run_mode_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_decision: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-decision/1.0">;
        decision_id: z.ZodString;
        request_id: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "explicit-create": "explicit-create";
            "chain-next": "chain-next";
            retry: "retry";
            resume: "resume";
        }>;
        authority: z.ZodEnum<{
            "legacy-inferred": "legacy-inferred";
            "explicit-command": "explicit-command";
            "chain-transition": "chain-transition";
            "confirmation-token": "confirmation-token";
        }>;
        decided_at: z.ZodString;
        session_identity_revision: z.ZodNumber;
        session_activity_revision: z.ZodNumber;
        confirmation_token_hash: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    creation_provenance: z.ZodObject<{
        schema_version: z.ZodLiteral<"creation-provenance/1.0">;
        provenance: z.ZodEnum<{
            fork: "fork";
            import: "import";
            "legacy-inferred": "legacy-inferred";
            "native-v2": "native-v2";
            "verified-v1": "verified-v1";
        }>;
        source_workspace_id: z.ZodNullable<z.ZodString>;
        source_session_id: z.ZodNullable<z.ZodString>;
        source_run_id: z.ZodNullable<z.ZodString>;
        imported_artifact_hashes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    transition: z.ZodNullable<z.ZodObject<{
        transition_id: z.ZodString;
        request_id: z.ZodString;
        outcome_hash: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.1">;
    chain_step_id: z.ZodNullable<z.ZodString>;
    resolved_platform: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
        grok: "grok";
        agy: "agy";
        "agents-standard": "agents-standard";
        cursor: "cursor";
    }>;
    goal_binding: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        external_id: z.ZodNullable<z.ZodString>;
        step_goal_ref: z.ZodNullable<z.ZodString>;
        observed_status: z.ZodEnum<{
            unknown: "unknown";
            blocked: "blocked";
            active: "active";
            complete: "complete";
        }>;
        observed_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint_expectation: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        dispatched_at: z.ZodString;
    }, z.core.$strict>>;
    checkpoint: z.ZodNullable<z.ZodObject<{
        run_id: z.ZodString;
        chain_step_id: z.ZodString;
        team_task_id: z.ZodString;
        revision: z.ZodNumber;
        artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            pass: "pass";
            warn: "warn";
            block: "block";
        }>;
        authoritative: z.ZodBoolean;
        updated_at: z.ZodString;
    }, z.core.$strict>>;
    retry_fence: z.ZodNullable<z.ZodObject<{
        token: z.ZodString;
        chain_step_id: z.ZodString;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        consumed_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    session_id: z.ZodString;
    run_id: z.ZodString;
    sequence: z.ZodNumber;
    parent_run_id: z.ZodNullable<z.ZodString>;
    command: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        source_path: z.ZodString;
        content_hash: z.ZodString;
        resolved_prompt_hash: z.ZodString;
        contract_hash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        failed: "failed";
        created: "created";
        blocked: "blocked";
        sealed: "sealed";
    }>;
    input: z.ZodObject<{
        args: z.ZodArray<z.ZodString>;
        consumes: z.ZodArray<z.ZodString>;
        context_identity_revision: z.ZodNumber;
    }, z.core.$strict>;
    gate_ids: z.ZodArray<z.ZodString>;
    output: z.ZodObject<{
        produces: z.ZodArray<z.ZodString>;
        primary_artifact_id: z.ZodNullable<z.ZodString>;
        verdict: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>>;
    }, z.core.$strict>;
    handoff: z.ZodNullable<z.ZodObject<{
        schema_version: z.ZodLiteral<"command-handoff/1.0">;
        producer_run_id: z.ZodString;
        command: z.ZodString;
        verdict: z.ZodEnum<{
            failed: "failed";
            blocked: "blocked";
            ready: "ready";
            ready_with_concerns: "ready_with_concerns";
        }>;
        summary: z.ZodString;
        constraints: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                open: "open";
                locked: "locked";
                deferred: "deferred";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        decisions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            status: z.ZodEnum<{
                rejected: "rejected";
                accepted: "accepted";
                proposed: "proposed";
            }>;
            text: z.ZodString;
        }, z.core.$strict>>;
        concerns: z.ZodArray<z.ZodString>;
        artifact_refs: z.ZodArray<z.ZodString>;
        next: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            reason: z.ZodString;
            needs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodNullable<z.ZodString>;
    sealed_at: z.ZodNullable<z.ZodString>;
    schema_version: z.ZodLiteral<"command-run/1.0">;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodString;
}, z.core.$loose>]>, z.ZodTransform<{
    command: {
        name: string;
        version: string;
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        contract_hash?: string | undefined;
    };
    status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
    sealed_at: string | null;
    checkpoint: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        artifact_id: string | null;
        verdict: "unknown" | "pass" | "warn" | "block";
        authoritative: boolean;
        updated_at: string;
    } | null;
    session_id: string;
    run_id: string;
    output: {
        produces: string[];
        primary_artifact_id: string | null;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns" | null;
    };
    chain_step_id: string | null;
    transition: {
        transition_id: string;
        request_id: string;
        outcome_hash: string;
    } | null;
    contract_snapshot: {
        schema_version: "contract-snapshot/1.0";
        contract_version: "command-contract/1.0" | "command-contract/2.0" | "command-contract/2.1";
        normalized: Record<string, unknown>;
        snapshot_hash: string;
        parser_version: "maestro-command-contract/2";
        captured_at: string;
        warnings: string[];
    } | null;
    guidance_snapshot: {
        schema_version: "guidance-snapshot/1.0";
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        prepare_hash: string | null;
        workflow_hash: string | null;
        run_mode_hash: string | null;
    } | null;
    resolved_platform: "claude" | "codex" | "pi" | "grok" | "agy" | "agents-standard" | "cursor";
    parent_run_id: string | null;
    completed_at: string | null;
    started_at: string;
    sequence: number;
    gate_ids: string[];
    handoff: {
        schema_version: "command-handoff/1.0";
        producer_run_id: string;
        command: string;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns";
        summary: string;
        constraints: {
            id: string;
            status: "open" | "locked" | "deferred";
            text: string;
        }[];
        decisions: {
            id: string;
            status: "rejected" | "accepted" | "proposed";
            text: string;
        }[];
        concerns: string[];
        artifact_refs: string[];
        next: {
            command: string;
            reason: string;
            needs: string[];
        }[];
        details: Record<string, unknown>;
    } | null;
    goal_binding: {
        provider: string;
        external_id: string | null;
        step_goal_ref: string | null;
        observed_status: "unknown" | "blocked" | "active" | "complete";
        observed_at: string;
    } | null;
    checkpoint_expectation: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        dispatched_at: string;
    } | null;
    retry_fence: {
        token: string;
        chain_step_id: string;
        issued_at: string;
        expires_at: string;
        consumed_at: string | null;
    } | null;
    creation_decision: {
        schema_version: "creation-decision/1.0";
        decision_id: string;
        request_id: string | null;
        mode: "fork" | "import" | "explicit-create" | "chain-next" | "retry" | "resume";
        authority: "legacy-inferred" | "explicit-command" | "chain-transition" | "confirmation-token";
        decided_at: string;
        session_identity_revision: number;
        session_activity_revision: number;
        confirmation_token_hash: string | null;
    } | null;
    creation_provenance: {
        schema_version: "creation-provenance/1.0";
        provenance: "fork" | "import" | "legacy-inferred" | "native-v2" | "verified-v1";
        source_workspace_id: string | null;
        source_session_id: string | null;
        source_run_id: string | null;
        imported_artifact_hashes: string[];
    };
    schema_version: "command-run/1.3";
    input: {
        args: string[];
        consumes: string[];
        context_identity_revision: number;
        reuse_assessments: {
            schema_version: "reuse-assessment/1.0";
            decision: "REUSE" | "REVIEW" | "CONFLICT" | "REJECT";
            reason_codes: string[];
            consumer: {
                kind: string;
                alias: string | null;
                schema: string | null;
                role: "primary" | "attachment" | "evidence" | "checkpoint" | null;
            };
            source_fence: {
                schema_version: "reuse-source-fence/1.0";
                workspace_id: string;
                session_id: string;
                producer_run_id: string;
                producer_run_hash: string | null;
                producer_status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
                artifact_id: string;
                artifact_role: string;
                artifact_status: "invalid" | "sealed" | "draft" | "superseded";
                artifact_hash: string | null;
                observed_artifact_hash: string | null;
                artifact_schema: string | null;
                artifact_registry_revision: number | null;
                producer_contract_hash: string | null;
            };
            assessment_hash: string;
        }[];
    };
}, {
    [x: string]: unknown;
    schema_version: string;
} | {
    session_id: string;
    run_id: string;
    sequence: number;
    parent_run_id: string | null;
    command: {
        name: string;
        version: string;
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        contract_hash?: string | undefined;
    };
    status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
    input: {
        args: string[];
        consumes: string[];
        context_identity_revision: number;
    };
    gate_ids: string[];
    output: {
        produces: string[];
        primary_artifact_id: string | null;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns" | null;
    };
    handoff: {
        schema_version: "command-handoff/1.0";
        producer_run_id: string;
        command: string;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns";
        summary: string;
        constraints: {
            id: string;
            status: "open" | "locked" | "deferred";
            text: string;
        }[];
        decisions: {
            id: string;
            status: "rejected" | "accepted" | "proposed";
            text: string;
        }[];
        concerns: string[];
        artifact_refs: string[];
        next: {
            command: string;
            reason: string;
            needs: string[];
        }[];
        details: Record<string, unknown>;
    } | null;
    started_at: string;
    completed_at: string | null;
    sealed_at: string | null;
    schema_version: "command-run/1.0";
} | {
    session_id: string;
    run_id: string;
    sequence: number;
    parent_run_id: string | null;
    command: {
        name: string;
        version: string;
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        contract_hash?: string | undefined;
    };
    status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
    input: {
        args: string[];
        consumes: string[];
        context_identity_revision: number;
    };
    gate_ids: string[];
    output: {
        produces: string[];
        primary_artifact_id: string | null;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns" | null;
    };
    handoff: {
        schema_version: "command-handoff/1.0";
        producer_run_id: string;
        command: string;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns";
        summary: string;
        constraints: {
            id: string;
            status: "open" | "locked" | "deferred";
            text: string;
        }[];
        decisions: {
            id: string;
            status: "rejected" | "accepted" | "proposed";
            text: string;
        }[];
        concerns: string[];
        artifact_refs: string[];
        next: {
            command: string;
            reason: string;
            needs: string[];
        }[];
        details: Record<string, unknown>;
    } | null;
    started_at: string;
    completed_at: string | null;
    sealed_at: string | null;
    schema_version: "command-run/1.1";
    chain_step_id: string | null;
    resolved_platform: "claude" | "codex" | "pi" | "grok" | "agy" | "agents-standard" | "cursor";
    goal_binding: {
        provider: string;
        external_id: string | null;
        step_goal_ref: string | null;
        observed_status: "unknown" | "blocked" | "active" | "complete";
        observed_at: string;
    } | null;
    checkpoint_expectation: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        dispatched_at: string;
    } | null;
    checkpoint: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        artifact_id: string | null;
        verdict: "unknown" | "pass" | "warn" | "block";
        authoritative: boolean;
        updated_at: string;
    } | null;
    retry_fence: {
        token: string;
        chain_step_id: string;
        issued_at: string;
        expires_at: string;
        consumed_at: string | null;
    } | null;
} | {
    session_id: string;
    run_id: string;
    sequence: number;
    parent_run_id: string | null;
    command: {
        name: string;
        version: string;
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        contract_hash?: string | undefined;
    };
    status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
    input: {
        args: string[];
        consumes: string[];
        context_identity_revision: number;
    };
    gate_ids: string[];
    output: {
        produces: string[];
        primary_artifact_id: string | null;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns" | null;
    };
    handoff: {
        schema_version: "command-handoff/1.0";
        producer_run_id: string;
        command: string;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns";
        summary: string;
        constraints: {
            id: string;
            status: "open" | "locked" | "deferred";
            text: string;
        }[];
        decisions: {
            id: string;
            status: "rejected" | "accepted" | "proposed";
            text: string;
        }[];
        concerns: string[];
        artifact_refs: string[];
        next: {
            command: string;
            reason: string;
            needs: string[];
        }[];
        details: Record<string, unknown>;
    } | null;
    started_at: string;
    completed_at: string | null;
    sealed_at: string | null;
    schema_version: "command-run/1.2";
    chain_step_id: string | null;
    resolved_platform: "claude" | "codex" | "pi" | "grok" | "agy" | "agents-standard" | "cursor";
    goal_binding: {
        provider: string;
        external_id: string | null;
        step_goal_ref: string | null;
        observed_status: "unknown" | "blocked" | "active" | "complete";
        observed_at: string;
    } | null;
    checkpoint_expectation: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        dispatched_at: string;
    } | null;
    checkpoint: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        artifact_id: string | null;
        verdict: "unknown" | "pass" | "warn" | "block";
        authoritative: boolean;
        updated_at: string;
    } | null;
    retry_fence: {
        token: string;
        chain_step_id: string;
        issued_at: string;
        expires_at: string;
        consumed_at: string | null;
    } | null;
    contract_snapshot: {
        schema_version: "contract-snapshot/1.0";
        contract_version: "command-contract/1.0" | "command-contract/2.0" | "command-contract/2.1";
        normalized: Record<string, unknown>;
        snapshot_hash: string;
        parser_version: "maestro-command-contract/2";
        captured_at: string;
        warnings: string[];
    } | null;
    guidance_snapshot: {
        schema_version: "guidance-snapshot/1.0";
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        prepare_hash: string | null;
        workflow_hash: string | null;
        run_mode_hash: string | null;
    } | null;
    creation_decision: {
        schema_version: "creation-decision/1.0";
        decision_id: string;
        request_id: string | null;
        mode: "fork" | "import" | "explicit-create" | "chain-next" | "retry" | "resume";
        authority: "legacy-inferred" | "explicit-command" | "chain-transition" | "confirmation-token";
        decided_at: string;
        session_identity_revision: number;
        session_activity_revision: number;
        confirmation_token_hash: string | null;
    } | null;
    creation_provenance: {
        schema_version: "creation-provenance/1.0";
        provenance: "fork" | "import" | "legacy-inferred" | "native-v2" | "verified-v1";
        source_workspace_id: string | null;
        source_session_id: string | null;
        source_run_id: string | null;
        imported_artifact_hashes: string[];
    };
    transition: {
        transition_id: string;
        request_id: string;
        outcome_hash: string;
    } | null;
} | {
    command: {
        name: string;
        version: string;
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        contract_hash?: string | undefined;
    };
    status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
    sealed_at: string | null;
    checkpoint: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        artifact_id: string | null;
        verdict: "unknown" | "pass" | "warn" | "block";
        authoritative: boolean;
        updated_at: string;
    } | null;
    session_id: string;
    run_id: string;
    output: {
        produces: string[];
        primary_artifact_id: string | null;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns" | null;
    };
    chain_step_id: string | null;
    transition: {
        transition_id: string;
        request_id: string;
        outcome_hash: string;
    } | null;
    contract_snapshot: {
        schema_version: "contract-snapshot/1.0";
        contract_version: "command-contract/1.0" | "command-contract/2.0" | "command-contract/2.1";
        normalized: Record<string, unknown>;
        snapshot_hash: string;
        parser_version: "maestro-command-contract/2";
        captured_at: string;
        warnings: string[];
    } | null;
    guidance_snapshot: {
        schema_version: "guidance-snapshot/1.0";
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        prepare_hash: string | null;
        workflow_hash: string | null;
        run_mode_hash: string | null;
    } | null;
    resolved_platform: "claude" | "codex" | "pi" | "grok" | "agy" | "agents-standard" | "cursor";
    parent_run_id: string | null;
    completed_at: string | null;
    started_at: string;
    sequence: number;
    gate_ids: string[];
    handoff: {
        schema_version: "command-handoff/1.0";
        producer_run_id: string;
        command: string;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns";
        summary: string;
        constraints: {
            id: string;
            status: "open" | "locked" | "deferred";
            text: string;
        }[];
        decisions: {
            id: string;
            status: "rejected" | "accepted" | "proposed";
            text: string;
        }[];
        concerns: string[];
        artifact_refs: string[];
        next: {
            command: string;
            reason: string;
            needs: string[];
        }[];
        details: Record<string, unknown>;
    } | null;
    goal_binding: {
        provider: string;
        external_id: string | null;
        step_goal_ref: string | null;
        observed_status: "unknown" | "blocked" | "active" | "complete";
        observed_at: string;
    } | null;
    checkpoint_expectation: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        dispatched_at: string;
    } | null;
    retry_fence: {
        token: string;
        chain_step_id: string;
        issued_at: string;
        expires_at: string;
        consumed_at: string | null;
    } | null;
    creation_decision: {
        schema_version: "creation-decision/1.0";
        decision_id: string;
        request_id: string | null;
        mode: "fork" | "import" | "explicit-create" | "chain-next" | "retry" | "resume";
        authority: "legacy-inferred" | "explicit-command" | "chain-transition" | "confirmation-token";
        decided_at: string;
        session_identity_revision: number;
        session_activity_revision: number;
        confirmation_token_hash: string | null;
    } | null;
    creation_provenance: {
        schema_version: "creation-provenance/1.0";
        provenance: "fork" | "import" | "legacy-inferred" | "native-v2" | "verified-v1";
        source_workspace_id: string | null;
        source_session_id: string | null;
        source_run_id: string | null;
        imported_artifact_hashes: string[];
    };
    schema_version: "command-run/1.3";
    input: {
        args: string[];
        consumes: string[];
        context_identity_revision: number;
        reuse_assessments: {
            schema_version: "reuse-assessment/1.0";
            decision: "REUSE" | "REVIEW" | "CONFLICT" | "REJECT";
            reason_codes: string[];
            consumer: {
                kind: string;
                alias: string | null;
                schema: string | null;
                role: "primary" | "attachment" | "evidence" | "checkpoint" | null;
            };
            source_fence: {
                schema_version: "reuse-source-fence/1.0";
                workspace_id: string;
                session_id: string;
                producer_run_id: string;
                producer_run_hash: string | null;
                producer_status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
                artifact_id: string;
                artifact_role: string;
                artifact_status: "invalid" | "sealed" | "draft" | "superseded";
                artifact_hash: string | null;
                observed_artifact_hash: string | null;
                artifact_schema: string | null;
                artifact_registry_revision: number | null;
                producer_contract_hash: string | null;
            };
            assessment_hash: string;
        }[];
    };
} | {
    command: {
        name: string;
        version: string;
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        contract_hash?: string | undefined;
    };
    status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
    sealed_at: string | null;
    checkpoint: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        artifact_id: string | null;
        verdict: "unknown" | "pass" | "warn" | "block";
        authoritative: boolean;
        updated_at: string;
    } | null;
    session_id: string;
    run_id: string;
    output: {
        produces: string[];
        primary_artifact_id: string | null;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns" | null;
    };
    chain_step_id: string | null;
    transition: {
        transition_id: string;
        request_id: string;
        outcome_hash: string;
    } | null;
    contract_snapshot: {
        schema_version: "contract-snapshot/1.0";
        contract_version: "command-contract/1.0" | "command-contract/2.0" | "command-contract/2.1";
        normalized: Record<string, unknown>;
        snapshot_hash: string;
        parser_version: "maestro-command-contract/2";
        captured_at: string;
        warnings: string[];
    } | null;
    guidance_snapshot: {
        schema_version: "guidance-snapshot/1.0";
        source_path: string;
        content_hash: string;
        resolved_prompt_hash: string;
        prepare_hash: string | null;
        workflow_hash: string | null;
        run_mode_hash: string | null;
    } | null;
    resolved_platform: "claude" | "codex" | "pi" | "grok" | "agy" | "agents-standard" | "cursor";
    parent_run_id: string | null;
    completed_at: string | null;
    started_at: string;
    sequence: number;
    gate_ids: string[];
    handoff: {
        schema_version: "command-handoff/1.0";
        producer_run_id: string;
        command: string;
        verdict: "failed" | "blocked" | "ready" | "ready_with_concerns";
        summary: string;
        constraints: {
            id: string;
            status: "open" | "locked" | "deferred";
            text: string;
        }[];
        decisions: {
            id: string;
            status: "rejected" | "accepted" | "proposed";
            text: string;
        }[];
        concerns: string[];
        artifact_refs: string[];
        next: {
            command: string;
            reason: string;
            needs: string[];
        }[];
        details: Record<string, unknown>;
    } | null;
    goal_binding: {
        provider: string;
        external_id: string | null;
        step_goal_ref: string | null;
        observed_status: "unknown" | "blocked" | "active" | "complete";
        observed_at: string;
    } | null;
    checkpoint_expectation: {
        run_id: string;
        chain_step_id: string;
        team_task_id: string;
        revision: number;
        dispatched_at: string;
    } | null;
    retry_fence: {
        token: string;
        chain_step_id: string;
        issued_at: string;
        expires_at: string;
        consumed_at: string | null;
    } | null;
    creation_decision: {
        schema_version: "creation-decision/1.0";
        decision_id: string;
        request_id: string | null;
        mode: "fork" | "import" | "explicit-create" | "chain-next" | "retry" | "resume";
        authority: "legacy-inferred" | "explicit-command" | "chain-transition" | "confirmation-token";
        decided_at: string;
        session_identity_revision: number;
        session_activity_revision: number;
        confirmation_token_hash: string | null;
    } | null;
    creation_provenance: {
        schema_version: "creation-provenance/1.0";
        provenance: "fork" | "import" | "legacy-inferred" | "native-v2" | "verified-v1";
        source_workspace_id: string | null;
        source_session_id: string | null;
        source_run_id: string | null;
        imported_artifact_hashes: string[];
    };
    schema_version: "command-run/1.4";
    input: {
        args: string[];
        consumes: string[];
        context_identity_revision: number;
        reuse_assessments: ({
            schema_version: "reuse-assessment/1.0";
            decision: "REUSE" | "REVIEW" | "CONFLICT" | "REJECT";
            reason_codes: string[];
            consumer: {
                kind: string;
                alias: string | null;
                schema: string | null;
                role: "primary" | "attachment" | "evidence" | "checkpoint" | null;
            };
            source_fence: {
                schema_version: "reuse-source-fence/1.0";
                workspace_id: string;
                session_id: string;
                producer_run_id: string;
                producer_run_hash: string | null;
                producer_status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
                artifact_id: string;
                artifact_role: string;
                artifact_status: "invalid" | "sealed" | "draft" | "superseded";
                artifact_hash: string | null;
                observed_artifact_hash: string | null;
                artifact_schema: string | null;
                artifact_registry_revision: number | null;
                producer_contract_hash: string | null;
            };
            assessment_hash: string;
        } | {
            decision: "REUSE" | "REVIEW" | "CONFLICT" | "REJECT";
            assessment_hash: string;
            reason_codes: string[];
            consumer: {
                kind: string;
                alias: string | null;
                schema: string | null;
                role: "primary" | "attachment" | "evidence" | "checkpoint" | null;
            };
            schema_version: "reuse-assessment/1.1";
            source_fence: {
                workspace_id: string;
                session_id: string;
                producer_run_id: string;
                producer_run_hash: string | null;
                artifact_id: string;
                artifact_role: string;
                artifact_hash: string | null;
                observed_artifact_hash: string | null;
                producer_status: "running" | "completed" | "failed" | "created" | "blocked" | "sealed";
                artifact_status: "invalid" | "sealed" | "draft" | "superseded";
                artifact_schema: string | null;
                artifact_registry_revision: number | null;
                producer_contract_hash: string | null;
                schema_version: "reuse-source-fence/1.1";
                execution_seal_receipt: {
                    execution_id: string;
                    generation: number;
                    sealed_at: string;
                    relative_path: string;
                    overall_hash: string;
                };
            };
        })[];
    };
    execution_id: string;
    generation: number;
}>>;
export declare const artifactMetaSchema: z.ZodObject<{
    kind: z.ZodString;
    schema: z.ZodString;
    role: z.ZodOptional<z.ZodEnum<{
        primary: "primary";
        attachment: "attachment";
        evidence: "evidence";
        checkpoint: "checkpoint";
        report: "report";
    }>>;
    alias: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const reportFrontmatterSchema: z.ZodPipe<z.ZodObject<{
    verdict: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodDefault<z.ZodEnum<{
        failed: "failed";
        blocked: "blocked";
        ready: "ready";
        ready_with_concerns: "ready_with_concerns";
    }>>>;
    summary: z.ZodDefault<z.ZodString>;
    constraints: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        status: z.ZodEnum<{
            open: "open";
            locked: "locked";
            deferred: "deferred";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        locked: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        open: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        deferred: z.ZodString;
    }, z.core.$strict>]>, z.ZodTransform<{
        text: string;
        status: "open" | "locked" | "deferred";
        id?: string | undefined;
    }, string | {
        text: string;
        status: "open" | "locked" | "deferred";
        id?: string | undefined;
    } | {
        locked: string;
    } | {
        open: string;
    } | {
        deferred: string;
    }>>>>;
    decisions: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        status: z.ZodEnum<{
            rejected: "rejected";
            accepted: "accepted";
            proposed: "proposed";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        proposed: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        accepted: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        rejected: z.ZodString;
    }, z.core.$strict>]>, z.ZodTransform<{
        text: string;
        status: "rejected" | "accepted" | "proposed";
        id?: string | undefined;
    }, string | {
        text: string;
        status: "rejected" | "accepted" | "proposed";
        id?: string | undefined;
    } | {
        proposed: string;
    } | {
        accepted: string;
    } | {
        rejected: string;
    }>>>>;
    concerns: z.ZodDefault<z.ZodArray<z.ZodString>>;
    next: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        command: z.ZodString;
        reason: z.ZodDefault<z.ZodString>;
        needs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>]>>>;
    details: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$loose>, z.ZodTransform<{
    constraints: {
        id: string;
        text: string;
        status: "open" | "locked" | "deferred";
    }[];
    decisions: {
        id: string;
        text: string;
        status: "rejected" | "accepted" | "proposed";
    }[];
    next: {
        command: string;
        reason: string;
        needs: string[];
    }[];
    verdict: "failed" | "blocked" | "ready" | "ready_with_concerns";
    summary: string;
    concerns: string[];
    details: Record<string, unknown>;
}, {
    [x: string]: unknown;
    verdict: "failed" | "blocked" | "ready" | "ready_with_concerns";
    summary: string;
    constraints: {
        text: string;
        status: "open" | "locked" | "deferred";
        id?: string | undefined;
    }[];
    decisions: {
        text: string;
        status: "rejected" | "accepted" | "proposed";
        id?: string | undefined;
    }[];
    concerns: string[];
    next: (string | {
        command: string;
        reason: string;
        needs: string[];
    })[];
    details: Record<string, unknown>;
}>>;
export type SessionState = z.infer<typeof sessionStateV13Schema>;
export type SessionIdentityV20 = z.infer<typeof sessionStateV20Schema>;
export type SessionStateV30 = z.infer<typeof sessionStateV30Schema>;
export type SessionStateRead = z.infer<typeof sessionStateReadSchema>;
export type SessionSchemaWriter = z.infer<typeof sessionSchemaWriterSchema>;
export type SessionSchemaSelection = z.infer<typeof sessionSchemaSelectionSchema>;
export type Execution = z.infer<typeof executionSchema>;
export type ExecutionState = Execution;
export type ExecutionLease = z.infer<typeof executionLeaseSchema>;
export type OrchestrationStep = z.infer<typeof orchestrationStepSchema>;
export type PendingRetryToken = z.infer<typeof pendingRetryTokenSchema>;
export type OrchestrationPosition = z.infer<typeof positionSchema>;
export type OrchestrationDecomposition = z.infer<typeof decompositionSchema>;
export type OrchestrationLease = z.infer<typeof leaseSchema>;
export type OrchestrationExecutor = z.infer<typeof executorSchema>;
export type TaskDecompositionItem = z.infer<typeof taskDecompositionItemSchema>;
export type GoalChangelogEntry = z.infer<typeof goalChangelogEntrySchema>;
export type Gate = z.infer<typeof gateSchema>;
export type GateRegistry = z.infer<typeof gateRegistrySchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactRegistry = z.infer<typeof artifactRegistrySchema>;
export type EvidenceStore = z.infer<typeof evidenceStoreSchema>;
export type Handoff = z.infer<typeof handoffSchema>;
export type GoalBinding = z.infer<typeof goalBindingSchema>;
export type DispatchExpectation = z.infer<typeof dispatchExpectationSchema>;
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>;
export type ArtifactMeta = z.infer<typeof artifactMetaSchema>;
export type ReportFrontmatter = z.infer<typeof reportFrontmatterSchema>;
export {};
//# sourceMappingURL=schemas.d.ts.map