# pi-graph

Durable DAG execution for Pi. `pi-graph` compiles a supplied GraphSpec, launches one independent `pi-subagents` async run per node, persists every transition, isolates writes, validates results, and unlocks dependents only after Supervisor `ACCEPTED`.

The main model still owns task understanding and the first draft. Before a new Graph can start, the bundled planning gate requires its structured task assessment, applies deterministic planning/risk floors, routes tactical or strategic strengthening to an independent model, and requires a second-model review of the complete derivation. The Graph runtime then executes only the approved DAG; it does not replace `pi-subagents`/`pi-convergence`.

## Recommended configuration

`pi-graph` does not pin or patch `pi-subagents`. Pi supplies the current official runtime through the `pi-subagents` peer dependency (`>=0.40.0`), while development and CI install `pi-subagents@latest`. Runtime compatibility is decided by the public `subagents:rpc:v1` capability contract, not by version equality. Paste this `graph` block into the user-local `settings.json` to use the current defaults:

```json
{
  "graph": {
    "enabled": true,
    "maxConcurrency": 3,
    "readOnlyBurst": 3,
    "maxSpawnBudget": 20,
    "rpcTimeoutMs": 10000,
    "validationTimeoutMs": 300000,
    "notifyOnComplete": true,
    "runtimeV2Dispatch": true,
    "resourceLimits": {},
    "history": {
      "autoCompact": true,
      "compactAfterDays": 7,
      "autoPrune": false,
      "emergencyPurge": false,
      "pruneAfterDays": 180,
      "trashGraceDays": 7,
      "maxStorageGB": 5,
      "targetStorageGB": 4,
      "keepRecentTerminal": 50
    }
  }
}
```

These values parse to the same effective configuration as `parseGraphConfig({})`. `runsDir` is intentionally omitted so the parser uses the current Pi agent directory's `graph-runs` subdirectory instead of baking a machine-specific path into shared configuration; the GiB settings normalize to the parser's byte values.

Run `/graphs recommend` to inspect the live public-RPC capabilities (`ping`, async `spawn`, `status`, `stop`, `resume`, model provenance, attempted-model provenance, structured provider failures, and exact-model/fallback control), audit the peer/dev dependency policy, validate `settings.graph`, and print the effective recommended block. The runtime version is displayed only for diagnosis. The equivalent tool action is `graph { action: "recommend" }`. This is configuration inspection only and does not recommend models.

The model router repeats the handshake after each Pi startup or `/reload`. It reports base RPC compatibility, model-provenance observability, and controlled-routing readiness separately. The current public RPC does not have to advertise per-call fallback disablement: before a managed launch, the adapters use the public `pi-subagents/preflight` export to prove that the effective Agent contract contains exactly the one sealed model. In `shadow` mode, incompatibility is recorded and excluded from comparable samples without blocking the subagent call. In `require` mode, missing RPC/provenance support, failed preflight, or caller-supplied `fallbackModels` blocks controlled execution. The adapter never imports private `pi-subagents` source, guesses from text, or falls back to an older package.

Every new node workspace contains `.pi-graph/source-git-evidence.txt`. The Supervisor derives it directly from each Git repository reached by the declared `readScope` or `writeScope`, limits `status` and `diff HEAD` to those scoped paths, records the branch and repository/git-dir/common-dir identities, seals the evidence digest into the node contract, and regenerates it before acceptance. This lets a reviewer inspect dirty changes without shell access or `.git` exposure; a concurrent repository identity, HEAD, index, or scoped working-tree change makes the attempt stale instead of accepting or applying outdated work.

Graph `acceptance.criteria` is a declared, persisted review contract: it is shown to the child and remains available to the parent/Supervisor for inspection, but natural-language criteria are not silently treated as machine-verified. `validationCommands` are the Graph layer's deterministic checks. When semantic child-side checking is required, configure the separate `childAcceptance` contract explicitly; Graph acceptance is never implicitly projected into it.

API keys belong only in the user's local `auth.json` or environment variables. Documentation and examples must never contain real keys, and the recommended configuration intentionally contains no `provider` or `model` fields.

## Runtime contract

- GraphSpec remains schema v1. New runs use Runtime V2; existing Runtime V1 runs remain readable and recoverable without in-place migration.
- Optional `taskRisk`, `routingProfile`, `producerRefs`, and structured `maxAuthorization` fields opt a node into shared model routing. `resolvedModel` is runtime provenance and is rejected as GraphSpec input.
- Routed attempts seal and persist a `RoutingDecision` before the child request digest and dispatch ledger are created. When the runtime supplies structured provider-failure evidence, a transient provider retry stays inside the same attempt and sealed decision but first destroys and rebuilds the isolated workspace from the unchanged source baseline, then creates a separately sealed provider dispatch/session/ledger. Only an evidence-authorized candidate degradation starts a new attempt and creates a new parent-linked decision. When the active runtime does not advertise and return that evidence, these automatic retry/degradation paths remain inactive.
- V2 treats `authorization.json`, its digest-bound planning receipt, per-attempt authority records, validated results, and acceptance records as durable evidence. The receipt binds the user turn, Flash assessment and first draft, expert output, final GraphSpec, routing configuration, reviewer provenance, and Graph run. `snapshot.json` is a recoverable projection, while `events.jsonl` is observability only.
- Atomic state writes fsync the file and parent directory. External fencing claims prevent two Pi sessions from supervising the same graph, including while a run directory is moved. New claims and source reservations bind both the PID and its process-start identity so PID reuse does not preserve abandoned ownership.
- Every V2 attempt has a stable nonce, persistent source reservation, deterministic child request identity, dispatch ledger, and lineage. Source reservation acquire, release, and active-record garbage collection share a cross-process transaction gate; completed records move atomically into `.history`, whose retention scan runs outside that gate because history is immutable and no longer grants ownership. Once dispatch may have escaped, the same attempt is looked up or protected; it is never blindly emitted again.
- A GraphSpec that omits `maxConcurrency` uses a per-graph base concurrency of 2. The user-level `settings.graph.maxConcurrency` execution cap defaults to 3; with the default `readOnlyBurst` of 3, eligible read-only nodes may use the third slot.
- Unordered overlapping local writers are rejected at compile time. Strict external reads must declare the exact eligible non-file tool names in their remote resource scopes; the child Guard blocks other non-file tools. Runtime V2 currently rejects `external_write`: declarative target/approval/idempotency/readback/compensation fields are retained for planning and legacy inspection, but new execution remains blocked until a trusted approval broker and Supervisor readback journal exist.
- Clean Git repositories use detached worktrees. Other work uses declared-scope shadow workspaces.
- Every attempt writes to an attempt-private output path. Only a validated, accepted attempt is atomically published under `artifacts/`.
- Monitoring has no implicit child deadline. A child is stopped for elapsed time only when its node explicitly declares `timeoutMs`; resource waits remain observable without killing an active child.
- Provider throttling and transient provider failures are eligible for typed failure evidence only when the runtime emits the structured failure fields; free-form error text is never classified as retryable. On a compatible runtime, `maxProviderRetries` is separate from business `maxAttempts`, uses bounded exponential backoff, and every provider dispatch still counts toward `maxSpawnBudget`.
- `resourceClass` and `graph.resourceLimits` provide generic concurrency lanes (falling back to `agent:<agent-name>`). A provider cooldown pauses other ready nodes in the same lane without embedding provider-specific policy in Graph.
- Every non-accepted terminal attempt preserves a partial Result Manifest, output when available, and isolated-workspace write digests. A retry receives a bounded `recovery-handoff.md`; failed workspace changes are never applied automatically.
- Local writes require at least one deterministic validation command. Validation runs without a shell, uses an executable allowlist, blocks inline interpreter payloads and path escapes, and is cancelled before source apply when the Graph stops or suspends.
- Workspace changes are applied only after child completion and deterministic validation. Multi-file apply uses an identity-bound v2 plan, full preflight, digested backups, durable plan writes, and interrupted-apply recovery.
- Child shell access is disabled. `allowBash: true` is rejected because shell commands can hide filesystem and network authority behind expansion or substitution. Deterministic supervisor validation does not require child shell access.
- Apply-back fingerprints declared read sources, input artifacts, and write targets. It refuses stale results, changed source parents, symlink swaps, and files changed while a node was running.
- `paused` children become `waiting_input`. Session shutdown suspends supervision without killing children; only the matching owner session can recover them later.
- Stop is a durable desired state. Recovery can rebuild only a fully accepted terminal projection from matching authority and acceptance evidence. Missing, ambiguous, or contradictory evidence creates a protected incident instead of guessing.
- The package registers with `pi-subagents/background-work`, so headless Pi remains alive between graph nodes.
- `maxSpawnBudget` is an admission limit for new GraphSpecs. Lowering it later does not invalidate or block recovery of a run that was already authorized.

## GraphSpec v1

```json
{
  "schemaVersion": 1,
  "contractPolicy": "strict",
  "goal": "Research two alternatives and synthesize a decision",
  "nodes": [
    {
      "taskId": "research-a",
      "agent": "researcher",
      "capabilityId": "read.research",
      "acceptance": "Cite the sources used and state unresolved uncertainty.",
      "resourceClass": "provider:research",
      "task": "Research alternative A",
      "outputArtifact": "research-a.md",
      "readScope": [],
      "resourceScopes": [{ "kind": "domain", "resource": "sources.example", "access": "read", "toolNames": ["web_search"] }],
      "sideEffect": "external_read",
      "retryPolicy": {
        "maxAttempts": 1,
        "maxProviderRetries": 2,
        "providerBackoffMs": 5000
      }
    },
    {
      "taskId": "research-b",
      "agent": "researcher",
      "capabilityId": "read.research",
      "acceptance": "Cite the sources used and state unresolved uncertainty.",
      "task": "Research alternative B",
      "outputArtifact": "research-b.md",
      "readScope": [],
      "resourceScopes": [{ "kind": "domain", "resource": "sources.example", "access": "read", "toolNames": ["web_search"] }],
      "sideEffect": "external_read"
    },
    {
      "taskId": "decision",
      "agent": "decision-reviewer",
      "capabilityId": "review.decision",
      "acceptance": "Compare both accepted inputs and give an evidence-linked recommendation.",
      "task": "Compare the supplied research and recommend a decision",
      "dependsOn": ["research-a", "research-b"],
      "inputArtifacts": ["research-a.md", "research-b.md"],
      "outputArtifact": "decision.md",
      "readScope": [],
      "sideEffect": "none"
    }
  ]
}
```

State lives under `~/.pi/agent/graph-runs/<graphId>/`.

## Tool actions

- `assess_task { assessment, draftSpec? }`: mandatory first action for every user turn. The active main model must be exactly DeepSeek V4 Flash at `max`. It submits the two-axis task assessment; every non-`direct` result must also include Flash's first GraphSpec draft. The receipt records the runtime-observed parent model. Unknown connector/MCP/browser tools are conservatively treated as external `R2` capabilities, and a real tool call above the assessed risk is blocked until reassessment.
- `plan_graph { context? }`: consume the assessment and draft already bound by `assess_task`. `direct` stays in the main model; `tactical` uses exactly K3 high; `strategic` uses exactly GPT-5.6 Sol high; any `R3` uses exactly Sol xhigh. Planning profiles must set `modelDegradations: 0`; planner failure therefore fails closed instead of silently changing the planning model. Deterministic floors can upgrade but never downgrade Flash's proposal.
- `review_graph_spec { spec }`: give an independent model the original request, locked constraints, Flash assessment/draft, planner output, and exact final GraphSpec. Only a matching v2 lineage PASS mints a one-use receipt.
- `graph { spec }` or `graph { action: "start", spec }`: compile and start asynchronously only after both gates pass for the exact current user turn and GraphSpec.
- `graph { action: "status", id }`: inspect persisted state.
- `graph { action: "list" }`: list graph runs.
- `graph { action: "doctor" }`: validate V1 state or the complete V2 evidence chain without writing or repairing anything. Run and Graph-lock inspection use bounded concurrency, while report ordering remains deterministic. Live transaction claims are treated as normal activity; stale or malformed claims and active source-reservation damage are reported.
- `graph { action: "recommend" }`: inspect the installed dependency and current Graph configuration, then return the recommended effective settings without changing files.
- `graph { action: "stop", id }`: stop and confirm active children where possible.
- `graph { action: "resume", id }`: adopt a recoverable run. A known queued, running, or completed child is monitored in place. A paused child must first be resumed or stopped in `pi-subagents` and is never duplicated. Missing, stopped, failed, or ambiguous children are not replaced, except for a childless L3 routing stop: explicit resume durably closes the old attempt and performs a fresh policy evaluation in a new bounded attempt. Once the routing re-evaluation budget is exhausted, resume is rejected.

The parent Agent owns the first interpretation, classification, and draft, but is not the sole gatekeeper. The Turn Gate blocks ordinary tools until `assess_task`; deterministic task, GraphSpec, and actual-tool floors may only raise tier/risk; non-direct work blocks parent-side write/bash/subagent execution and must continue through planning, review, and Graph. Omitting assessment schedules at most one bounded repair turn. The reviewed routing configuration digest is checked again at Graph admission and recovery, and every persisted node RoutingDecision must use that same digest.

## Shared subagent and model routing

The package autoloads exactly three runtime Extensions: `pi-graph` executes an explicit GraphSpec, `pi-graph-guard` enforces child node scope, and `subagent-model-router` is the single parent-side policy entry. The parent router dynamically resolves the formal capability candidates through the public `pi-subagents/preflight` and `pi-subagents/capability-ceiling` exports, reads `description` only from the preflight-selected Agent definition, and injects a bounded metadata catalog before the parent model starts. The catalog is not an authorization grant; every launch is preflighted again.

Explicit product-perspective requests require `product-manager`, while screenshot UI, layout, and interaction-review requests require `interaction-designer`. Images are copied into bounded, mode-`0600` verified snapshots protected by integrity checks and bound to the current session and workspace. Each turn receives a new random `visualEvidenceId` lease restricted to that turn's prompt and allowed Agent; the lease moves through `issued`, `consumed`, and `revoked`, is bound to the first `toolCallId` that consumes it, and permits only an idempotent retry by that same call. The required domain Agent receives the original request plus a verified path/hash manifest and must inspect the snapshots with its read tool.

In balanced retention mode, one successfully analyzed single-image context has a 10-minute idle limit and a non-renewable 30-minute absolute limit. An accepted related follow-up slides the idle deadline before its new one-turn lease is issued, so a prompt submitted near the idle boundary is not deleted while waiting for dispatch; only successful follow-ups count toward the maximum of three, and the absolute limit never moves. An active lease protects an in-flight task across the idle deadline, with up to five minutes of execution grace capped by the 30-minute hard limit; the absolute deadline never receives additional grace. Strict mode releases the asset after the current turn instead of retaining it for follow-up; set `PI_VISUAL_RETENTION_MODE=strict` before starting Pi to enable it. Unrelated input clears the live context, and multi-image assets are released at turn end rather than being ambiguously reused; the user must attach the intended image again for a pixel-dependent follow-up. Assets are also released on failure, expiry, replacement, or session shutdown. Expired context remains only as a tombstone carrying its reason (`expired_idle`, `expired_absolute`, `follow_up_limit`, or `ambiguous_multiple_images`): an explicit reference to unavailable pixels requires re-attachment by default, while an explicit request to continue from prior textual conclusions must state that the original image was not re-opened. After a reload or restart has cleared in-memory context, an explicit reference to an earlier image also fails closed with the same re-attachment policy. Cleanup failure revokes every lease immediately, retains retry state, and writes a deletion-request marker before background retries; crash recovery schedules cleanup only for eligible temporary directories bearing the package's ownership marker. `pi-subagents` is unchanged: the private handle is resolved and injected into the sealed text task inside `subagent-model-router`.

`multimodal-analyzer` remains the visual fact adapter, not the owner of every image task. Plain UI/product reviews go directly to the domain Agent. OCR, exact-position, marked-region, multi-image, comparison, blurred/cropped, and explicit verification requests first collect validated analyzer evidence and then continue to the domain Agent with both that evidence and the original snapshots. Non-domain image questions continue to use the analyzer. A turn-bound route ledger requires the exact Agent and `visualEvidenceId`, prevents parent-side read/search/bash from silently replacing the specialist call, and schedules at most one repair turn when dispatch was omitted. Ordinary explanations remain parent-direct. The analyzer's `recommendedAgent` field is advisory evidence and never completes or authorizes a downstream route by itself.

Runtime policy has one external source split by responsibility:

- `$PI_CODING_AGENT_DIR/model-registry.json`: model facts only (`model`, `provider`, `family`, `providerDomain`, optional aliases, supported thinking levels, and declared input modalities).
- `$PI_CODING_AGENT_DIR/routing-policy.json`: agent-to-profile references, ordered candidates, constraints, enforcement, retry/degradation budgets, and trusted Ed25519 issuer keys for `max` authorization.

The package contains no fallback model matrix. Missing files are a no-op for legacy Graph nodes and the default ordinary-subagent shadow observer. An explicit Graph `routingProfile`, or ordinary routing configured with `enforcement: "require"` (or `PI_MODEL_ROUTING_ENFORCEMENT=require`), fails closed when configuration or provenance is insufficient.

Capability-sensitive profiles can declare `constraints.requiredInputModalities` (currently `text` and `image`). A single dispatch may also add a sealed, narrowing-only modality requirement; visual evidence automatically adds `image` even when the domain profile is normally modality-neutral. Every eligible candidate must declare the combined modalities in the model registry, and require-mode selection also needs the active Pi model snapshot to confirm them. Retry and degradation cannot relax the sealed requirement. This prevents a fallback from silently dropping image input support.

Minimal shapes:

```json
{
  "schemaVersion": 1,
  "models": [
    {
      "model": "provider/model-id",
      "provider": "provider",
      "family": "model-family",
      "providerDomain": "independent-failure-domain",
      "thinkingLevels": ["high", "max"]
    }
  ]
}
```

```json
{
  "schemaVersion": 1,
  "enforcement": "shadow",
  "planningProfiles": {
    "tactical": "tactical-planning",
    "strategic": "strategic-planning",
    "strategicHighRisk": "strategic-planning-high-risk"
  },
  "agentProfiles": {
    "code-reviewer": "ordinary-code-review",
    "reviewer": "ordinary-code-review"
  },
  "profiles": {
    "tactical-planning": {
      "enforcement": "require",
      "candidates": [
        { "model": "kimi-coding/k3", "thinking": "high", "level": "L0" }
      ],
      "budget": { "providerRetries": 1, "modelDegradations": 0 }
    },
    "strategic-planning": {
      "enforcement": "require",
      "candidates": [
        { "model": "wisdomrouter/gpt-5.6-sol", "thinking": "high", "level": "L0" }
      ],
      "budget": { "providerRetries": 1, "modelDegradations": 0 }
    },
    "strategic-planning-high-risk": {
      "enforcement": "require",
      "candidates": [
        { "model": "wisdomrouter/gpt-5.6-sol", "thinking": "xhigh", "level": "L0" }
      ],
      "budget": { "providerRetries": 1, "modelDegradations": 0 }
    },
    "ordinary-code-review": {
      "candidates": [
        { "model": "provider/model-id", "thinking": "high", "level": "L0" }
      ],
      "constraints": {
        "requireCrossFamilyFromProducers": true,
        "requireProviderDomainSeparation": true,
        "highRiskMinimumIdentityConfidence": "runtime_reported",
        "maximumAutomaticFallback": "L1",
        "allowAutomaticMax": false
      },
      "budget": { "providerRetries": 1, "modelDegradations": 1 }
    }
  }
}
```

Use `code-reviewer` as the canonical code-review Agent name. `reviewer` is retained only as a compatibility alias for existing tasks and Graphs. Disable the bundled canonical `reviewer` through `subagents.agentOverrides.reviewer.disabled` so it cannot take precedence over that alias. Product definition and interaction behavior are separate read-only roles: `product-manager` produces the product brief, then `interaction-designer` turns an approved brief into an interaction specification. Neither role replaces implementation or code review.

For ordinary one-off code review, map both names to a profile whose `producerSource` is `active_main`; this compares the reviewer against the active parent model. Existing Graph review profiles may keep `producerSource: "accepted_manifests"`, because Graph review must derive producer identity only from accepted upstream Result Manifests.

`maximumAutomaticFallback` limits how far candidate degradation may go after compatible structured failure evidence exists; it does not make fallback available by itself. High-risk tasks default to `L1` even when the field is omitted; crossing the cap produces L3 and waits for a person instead of silently selecting L2.

Ordinary `subagent` routing starts in shadow mode: it evaluates all single, task-list, sequential-chain, static-parallel, and dynamic-parallel children and records observations, but does not change the requested model or fallback candidates. Managed calls are deliberately blocked when require mode is enabled because ordinary tool parameters remain mutable across Extensions. Use `routed_subagent` for idempotent read-only text work and Graph for writes, named artifacts, partial output, fan-out, or other non-idempotent work.

Use the separately registered `routed_subagent` tool for a one-off read-only, idempotent subagent that needs a sealed exact model. Provider retry or degradation is enabled only when the active runtime explicitly advertises and returns structured provider-failure evidence; free-form error text never authorizes another dispatch. Without that evidence, exact-model routing can still work while runtime provider retry and automatic model degradation remain disabled. When a compatible runtime supplies the evidence, provider retries reuse the same decision and an allowed candidate change receives a new decision. Its `timeoutMs` is one total deadline shared by all phases. Every terminal response fails closed unless the runtime reports the sealed model, thinking level, launch contract, and the parent observes the same trusted Extension contents before and after dispatch. The delegation response does not carry child Extension acknowledgements, so this routed seal must not be described as proof of what the child loaded. Controlled Graph nodes add that separate check: completed output is rejected unless `runtimeAcknowledgedExtensions` confirms `pi-graph-guard` with no omitted acknowledgements. Graph nodes otherwise use the same outer routing policy and provider-dispatch lifecycle.

Text such as `[Producer model: ...]` is never treated as verified provenance. Graph reviewers read model identity only from upstream ACCEPTED Result Manifests. `max` is not selected automatically unless the user-managed profile explicitly sets `constraints.allowAutomaticMax: true`; use that narrow profile-level exception only for a role whose global default the user has deliberately set to `max`. Inside such a profile, both automatic selection and an explicit request for the same configured `max` candidate use that profile-level authorization. Everywhere else, an explicit per-task `max` request still requires a valid, unexpired, single-use authorization bound to the exact task and model, containing `issuer`, `keyId`, and an Ed25519 signature. The public key must appear under `routing-policy.json` → `maxAuthorizationIssuers`; routed and legacy explicit-`max` Graph nodes both verify that trusted signature before dispatch. Consumed authorization IDs are recorded under `$PI_CODING_AGENT_DIR/model-routing/max-authorization-uses` with exclusive creation so another process cannot replay them. A retry or crash recovery of the same task/model observes the original consumption idempotently.

## History and storage

Terminal history uses a two-stage policy: crash-recoverable transactional compaction first, then a single-run, digest-bound move to same-disk Trash. Active runs, unacknowledged `needs_attention`, open transactions, protected incidents, pinned runs, archived runs, and unverifiable children are never automatically compacted or pruned. `pi-subagents` storage is reported separately and is never deleted by this package.

Safe defaults:

```json
{
  "graph": {
    "runtimeV2Dispatch": true,
    "resourceLimits": {
      "agent:frontend-developer": 1
    },
    "history": {
      "autoCompact": true,
      "compactAfterDays": 7,
      "autoPrune": false,
      "emergencyPurge": false,
      "pruneAfterDays": 180,
      "trashGraceDays": 7,
      "maxStorageGB": 5,
      "targetStorageGB": 4,
      "keepRecentTerminal": 50
    }
  }
}
```

`autoPrune` is intentionally off. When enabled explicitly, only compacted `complete` or `stopped` runs older than 180 days and outside the most recent 50 are eligible. Ordinary purging always honors the Trash grace period. Crossing the 5 GiB soft limit may bypass that grace only when both `autoPrune` and the separate `emergencyPurge` switch are explicitly enabled.

Operational commands:

- `/graphs doctor`: inspect evidence and control-plane health; the command handler itself does not modify run data.
- `/graphs recommend`: inspect the installed dependency and current Graph configuration, then print the recommended effective settings without changing files.
- `/graphs storage`: report Graph, Trash, and control/recovery storage without modifying run data. Orphan purge staging and interrupted `.initialize-*` directories count toward the soft limit.
- `/graphs maintain`: run configured compaction, pruning, authorized recovery, and safe control-record cleanup. A malformed recovery record is isolated so unrelated maintenance continues. Initialization staging with no live Graph Supervisor, dead or process-reused claims, expired partial claim writes, completed source reservations, recovered fencing-generation quarantine, invalid Graph-lock entries, and other metadata-only crash leftovers are reclaimed or archived automatically. Entry-level symbolic links are unlinked without following their targets. Orphan Graph lock metadata is detached under a short graph-keyed mutation gate before deletion, so cleanup cannot remove a claim being created by a concurrent initialization while unrelated Graphs remain parallel. Unknown purge payloads remain protected.
- `/graphs pin <id>` and `/graphs unpin <id>`: protect or release a run.
- `/graphs archive <id>` and `/graphs unarchive <id>`: protect or release an archived run.
- `/graphs acknowledge <id>`: explicitly acknowledge a terminal incident after active children and source transactions have been ruled out; this permits a later separately confirmed manual deletion.
- `/graphs compact <id>`: manually compact a terminal run.
- `/graphs delete <id>`: create a bound prune plan, ask for confirmation, and move the run to same-disk Trash.
- `/graphs trash` and `/graphs restore <trash-id>`: inspect or restore Trash during its grace period. Restored runs are pinned automatically.
- `/graphs purge`: ask for confirmation, then permanently remove only Trash entries whose grace period elapsed.
- `/graphs discard-trash <trash-id-or-handle>`: explicitly and permanently dispose of a malformed protected Trash entry that cannot pass normal metadata validation. Unsafe names are exposed as opaque handles.
- `/graphs discard-staging <staging-id-or-handle>`: after inspection and confirmation, permanently dispose of purge staging whose durable authorization is missing or invalid. Invalid names are exposed as safe opaque handles; non-file authorization records are quarantined before a target-bound discard authorization is committed. Ambiguous Trash/staging pairs remain protected.
- `/graphs discard-control <quarantine-id-or-handle>`: permanently remove inspected quarantine metadata only. It refuses to remove purge metadata that still protects staging data and never deletes a Graph, Trash, or staging payload.

During `session_start`, Pi synchronously adopts only active Graphs owned by the current session. Clean terminal history is read without taking per-run Supervisor locks, while retention maintenance runs in the background so a large history cannot block the input loop. `/graphs maintain` remains the explicit command for waiting on a complete maintenance pass. A fresh process may therefore finish background recovery shortly after the first interactive command; `/graphs doctor` itself remains read-only.

## Verification

- `npm test`: run the deterministic regression suite.
- `npm run test:latest-integration`: verify that the installed development copy matches the remote `pi-subagents@latest`, load its public exports, and validate the Agent alias contract in an isolated temporary Agent directory without modifying package source.
- `npm run test:soak`: run the default 60-second long-task scenario plus suspend/resume and overlapping-writer contention checks.
- `PI_GRAPH_SOAK_MS=300000 npm run test:soak`: extend the sustained DAG phase to approximately five minutes. The accepted range is 15 seconds to 30 minutes.

The soak test uses deterministic simulated subagents so it can exercise dispatch, persistence, retry, recovery, and locking without consuming model quota. It verifies bounded concurrency, duplicate-dispatch prevention, monotonic events, authoritative reload, event-listener cleanup, source-reservation cleanup, and temporary async-run cleanup.

## Trust boundary

`pi-graph-guard` is a policy guard for Pi tools, not an operating-system sandbox. Before dispatch, the effective builtin, package, user, or project agent is materialized into the isolated workspace with Graph Guard merged into `subagentOnlyExtensions`; this also preserves ancestor project agents and agents that declare their own extensions. Path-bearing tools are constrained to the declared scopes, malformed contracts fail closed, and child Bash is rejected because shell parsing cannot prove containment against deliberately obfuscated commands. Supervisor validation can execute trusted project tests, so GraphSpecs and repositories must be treated as trusted inputs for unattended runs.

Durability and path checks cover process crashes, power-loss publication boundaries, stale claims, static symbolic links, and ordinary concurrent Pi processes. Initialization uses exclusive file creation, repeated inode/realpath checks, directory `fsync` before and after publication, and a Graph-keyed mutation gate for Graph lock creation and orphan cleanup. Keyed claims use deterministic scope prefixes to avoid scanning unrelated live contenders while retaining compatibility with legacy unscoped claims. Like other user-space Node extensions, it does not claim to defend against a hostile process running as the same OS user that continuously swaps filesystem objects between individual system calls; protecting against that attacker requires an OS sandbox or native `openat`-style containment.
