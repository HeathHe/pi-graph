# Role Catalog — Team Coordinate

Dynamic role reference for CSV wave execution. Coordinator uses this catalog during Phase 1 (task analysis) to detect capabilities, assign roles, compute waves, and generate evaluation criteria.

## 1. Signal Detection Table

Scan task description keywords to infer capabilities. Multi-match allowed.

| Signal | Keywords | Role | Prefix | Responsibility |
|--------|----------|------|--------|---------------|
| Research | investigate, explore, compare, survey, find, research, discover, benchmark, study | researcher | RESEARCH | exploration |
| Writing | write, draft, document, article, report, blog, describe, explain, summarize, content | writer | DRAFT | code-gen (docs) |
| Coding | implement, build, code, fix, refactor, develop, create app, program, migrate, port | developer | IMPL | code-gen (code) |
| Design | design, architect, plan, structure, blueprint, model, schema, wireframe, layout | designer | DESIGN | orchestration |
| Analysis | analyze, review, audit, assess, evaluate, inspect, examine, diagnose, profile | analyst | ANALYSIS | read-only |
| Testing | test, verify, validate, QA, quality, check, assert, coverage, regression | tester | TEST | validation |
| Planning | plan, breakdown, organize, schedule, decompose, roadmap, strategy, prioritize | planner | PLAN | orchestration |

**No match**: Default to single `general` role with `TASK` prefix.

**Max 5 roles** per session. Merge overlapping capabilities if exceeded.

## 2. Wave Tier Mapping

| Tier | Wave | Roles | Description |
|------|------|-------|-------------|
| 0 | 1 | researcher, planner | Knowledge gathering (always executes) |
| 1 | 2 | designer, analyst | Design + evaluation (evaluated) |
| 2 | 3 | developer, writer | Creation (evaluated) |
| 3 | 4 | tester, analyst | Validation (evaluated) |

**general** role: assigned to wave matching its task's natural tier.

## 3. Evaluation Criteria Templates

Wave 1 tasks always get `"always"`. Wave 2+ tasks get conditional criteria:

| Wave | Default Criteria | When to Skip |
|------|-----------------|--------------|
| 2 (Design) | `"if wave_1 findings indicate design or architecture needed"` | Research found no design needs |
| 3 (Implement) | `"if task requires code changes or document creation"` | Pure analysis task, no implementation |
| 4 (Validate) | `"if wave_3 produced testable artifacts (files_modified non-empty)"` | No artifacts to validate |

Coordinator MAY customize criteria per-task based on task description specifics.

## 4. Role Behavior Guide

Each role adopts a specific perspective when executing tasks. This section is referenced by the `instruction` parameter of `spawn_agents_on_csv`.

| Role | Perspective | Typical Output |
|------|------------|----------------|
| researcher | Systematic investigation, evidence-driven, hypothesis testing | Research findings, exploration notes |
| developer | Implementation-focused, code modification, testing | Source files, implementation summaries |
| analyst | Multi-dimensional evaluation, scoring, gap identification | Analysis reports, severity matrices |
| designer | Architecture, structure, interface, data model design | Design specs, architecture docs |
| tester | Validation, test creation, regression, coverage analysis | Test results, coverage reports |
| planner | Decomposition, sequencing, risk assessment, prioritization | Execution plans, task breakdowns |
| writer | Documentation, content creation, clarity, consistency | Written documents, guides |
| general | Adapt to task requirements | Task-specific deliverables |

## 5. Behavioral Traits (Quality Contract)

All agents — regardless of dynamically assigned role — MUST follow these traits. Embedded into the shared `instruction` parameter.

### Accuracy

- Files claimed as **created** → Read to confirm file exists and has content
- Files claimed as **modified** → Read to confirm content actually changed
- Analysis claimed as **complete** → verify deliverable exists

### Quality Gate

- Verify actual output (not planned output) before reporting
- Verification fails → retry execution (max 2 retries)
- Still fails → report `blocked` with details, NOT `completed`

### Error Protocol

- Primary approach fails → try alternative approach
- 2 retries exhausted → report `failed` with evidence
- NEVER skip verification and report completed

### Termination Contract (MANDATORY)

Every spawned worker MUST call `report_agent_job_result` EXACTLY ONCE before exiting. NO exceptions:

| Path | Action |
|------|--------|
| Success | `result_status=completed` after verification passes |
| Failure | `result_status=failed` with error message (build error, file write failure, unrecoverable tool error) |
| Blocked | `result_status=blocked` when upstream missing OR retries exhausted |
| Timeout | Approaching `max_runtime_seconds` → revert partial unsafe work → `result_status=blocked` with error="timeout" |

- NEVER continue indefinitely.
- NEVER exit silently.
- NEVER omit `report_agent_job_result`.

### Hard Constraints

- Do NOT write to `tasks.csv`, `wave-*.csv`, `results.csv` — orchestrator owns those.
- Do NOT call `spawn_agents_on_csv` (no recursion).

## 6. Quality Scoring

| Result | Score | Action |
|--------|-------|--------|
| Pass | >= 80% | result_status = completed |
| Review | 60-79% | result_status = completed (with findings noting warnings) |
| Fail | < 60% | Retry (max 2), then result_status = blocked |

**Scoring Dimensions** (25% each):
- **Completeness**: All required outputs present with substantive content
- **Consistency**: Terminology, formatting, cross-references uniform
- **Accuracy**: Factually correct and verifiable
- **Depth**: Sufficient detail for downstream consumers

## 7. Output Type Derivation

| Task Signal | Output Type | Description |
|-------------|-------------|-------------|
| "write report", "analyze", "research" | artifact | New files in session directory |
| "implement", "modify code", "fix bug" | codebase | Modify existing project files |
| "implement feature + write summary" | mixed | Code changes + session artifact |

## 8. Key File Inference

For task decomposition, infer relevant files from capability and keywords:

| Role | Strategy |
|------|----------|
| researcher | Domain keywords → likely directories (e.g., "auth" → `src/auth/**`) |
| developer | Feature/module keywords → source files |
| designer | Architecture keywords → config/schema files |
| analyst | Target keywords → files under analysis |
| tester | Test target → source + test files |
| writer | Documentation target → relevant source for context |
| planner | No specific files (abstract planning) |

## 9. Complexity Scoring

| Factor | Weight |
|--------|--------|
| Capability count | +1 each |
| Cross-domain (3+ tiers) | +2 |
| Parallel tracks | +1 each |
| Serial depth | +1 per level |

| Total | Level | Role Limit |
|-------|-------|------------|
| 1-3 | Low | 1-2 roles |
| 4-6 | Medium | 2-3 roles |
| 7+ | High | 3-5 roles |
