// ---------------------------------------------------------------------------
// normalizeTask — convert raw TASK JSON (from .task/*.json) into TaskCard shape.
// Shared between usePhaseTasks and useIssueTasks hooks.
// Raw files use task_id, top-level status, and lack the meta wrapper.
// ---------------------------------------------------------------------------
export function normalizeTask(raw) {
    const r = raw;
    const id = (r.task_id ?? r.id ?? '');
    const status = (r.meta?.status ?? r.status ?? 'pending');
    const wave = (r.meta?.wave ?? r.wave ?? 0);
    const convergence = r.convergence;
    return {
        id,
        title: (r.title ?? ''),
        description: (r.description ?? ''),
        type: (r.type ?? 'feature'),
        priority: (r.priority ?? 'medium'),
        effort: (r.effort ?? ''),
        action: (r.action ?? ''),
        scope: (r.scope ?? ''),
        focus_paths: (r.focus_paths ?? []),
        depends_on: (r.depends_on ?? []),
        parallel_group: (r.parallel_group ?? null),
        convergence: {
            criteria: (convergence?.criteria ?? []),
            verification: (convergence?.verification ?? ''),
            definition_of_done: (convergence?.definition_of_done ?? ''),
        },
        files: Array.isArray(r.files)
            ? r.files.map((f) => typeof f === 'string'
                ? { path: f, action: '', target: '', change: '' }
                : f)
            : [],
        implementation: (r.implementation ?? []),
        test: {
            commands: [],
            unit: [],
            integration: [],
            success_metrics: [],
            ...(r.test ?? {}),
        },
        reference: {
            pattern: '',
            files: (r.read_first ?? []),
            examples: null,
            ...(r.reference ?? {}),
        },
        rationale: {
            chosen_approach: '',
            decision_factors: [],
            tradeoffs: null,
            ...(r.rationale ?? {}),
        },
        risks: (r.risks ?? []),
        code_skeleton: (r.code_skeleton ?? null),
        doc_context: {
            affected_features: [],
            affected_components: [],
            affected_requirements: [],
            adr_ids: [],
            ...(r.doc_context ?? {}),
        },
        meta: {
            status: status,
            estimated_time: (r.estimated_time ?? null),
            risk: (r.risk ?? 'low'),
            autonomous: (r.autonomous ?? false),
            checkpoint: (r.checkpoint ?? false),
            wave,
            execution_group: (r.execution_group ?? null),
            executor: (r.executor ?? ''),
        },
    };
}
//# sourceMappingURL=normalize-task.js.map