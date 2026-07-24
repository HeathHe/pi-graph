# pi-graph

Durable DAG execution for Pi. `pi-graph` compiles a supplied GraphSpec, launches one independent `pi-subagents` async run per node, persists every transition, isolates writes, validates results, and unlocks dependents only after Supervisor `ACCEPTED`.

It deliberately does not decide whether a Graph is needed, decompose the user's goal, select models, search context, or replace `pi-subagents`/`pi-convergence`.

## Runtime contract

- GraphSpec remains schema v1. New runs use Runtime V2; existing Runtime V1 runs remain readable and recoverable without in-place migration.
- V2 treats `authorization.json`, per-attempt authority records, validated results, and acceptance records as durable evidence. `snapshot.json` is a recoverable projection, while `events.jsonl` is observability only.
- Atomic state writes fsync the file and parent directory. External fencing claims prevent two Pi sessions from supervising the same graph, including while a run directory is moved. New claims and source reservations bind both the PID and its process-start identity so PID reuse does not preserve abandoned ownership.
- Every V2 attempt has a stable nonce, persistent source reservation, deterministic child request identity, dispatch ledger, and lineage. Source reservation acquire, release, and active-record garbage collection share a cross-process transaction gate; completed records move atomically into `.history`, whose retention scan runs outside that gate because history is immutable and no longer grants ownership. Once dispatch may have escaped, the same attempt is looked up or protected; it is never blindly emitted again.
- Default graph concurrency is 2; eligible read-only nodes may burst to 3.
- Unordered overlapping writers are rejected at compile time. Runtime V2 also rejects `external_write`.
- Clean Git repositories use detached worktrees. Other work uses declared-scope shadow workspaces.
- Every attempt writes to an attempt-private output path. Only a validated, accepted attempt is atomically published under `artifacts/`.
- Monitoring has no implicit child deadline. A child is stopped for elapsed time only when its node explicitly declares `timeoutMs`; resource waits remain observable without killing an active child.
- Provider throttling and transient provider failures are recorded as typed failure evidence. `maxProviderRetries` is separate from business `maxAttempts`, uses bounded exponential backoff, and still counts toward `maxSpawnBudget`.
- `resourceClass` and `graph.resourceLimits` provide generic concurrency lanes (falling back to `agent:<agent-name>`). A provider cooldown pauses other ready nodes in the same lane without embedding provider-specific policy in Graph.
- Every non-accepted terminal attempt preserves a partial Result Manifest, output when available, and isolated-workspace write digests. A retry receives a bounded `recovery-handoff.md`; failed workspace changes are never applied automatically.
- Local writes require at least one deterministic validation command. Validation runs without a shell, uses an executable allowlist, blocks inline interpreter payloads and path escapes, and is cancelled before source apply when the Graph stops or suspends.
- Workspace changes are applied only after child completion and deterministic validation. Multi-file apply uses an identity-bound v2 plan, full preflight, digested backups, durable plan writes, and interrupted-apply recovery.
- Child shell access is off by default. A local-write node must explicitly opt in with `allowBash: true`; deterministic supervisor validation does not require child shell access.
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

- `graph { spec }` or `graph { action: "start", spec }`: compile and start asynchronously.
- `graph { action: "status", id }`: inspect persisted state.
- `graph { action: "list" }`: list graph runs.
- `graph { action: "doctor" }`: validate V1 state or the complete V2 evidence chain without writing or repairing anything. Run and Graph-lock inspection use bounded concurrency, while report ordering remains deterministic. Live transaction claims are treated as normal activity; stale or malformed claims and active source-reservation damage are reported.
- `graph { action: "stop", id }`: stop and confirm active children where possible.
- `graph { action: "resume", id }`: adopt a recoverable run. A known queued, running, or completed child is monitored in place. Missing, stopped, failed, paused, or ambiguous children are never replaced inside the same graph; reconcile them and start a new graph when more work is required.

The package executes a supplied graph only. Routing, decomposition, model choice, and domain workflow policy remain in `agent-workflow` or the parent Agent.

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
- `npm run test:soak`: run the default 60-second long-task scenario plus suspend/resume and overlapping-writer contention checks.
- `PI_GRAPH_SOAK_MS=300000 npm run test:soak`: extend the sustained DAG phase to approximately five minutes. The accepted range is 15 seconds to 30 minutes.

The soak test uses deterministic simulated subagents so it can exercise dispatch, persistence, retry, recovery, and locking without consuming model quota. It verifies bounded concurrency, duplicate-dispatch prevention, monotonic events, authoritative reload, event-listener cleanup, source-reservation cleanup, and temporary async-run cleanup.

## Trust boundary

`pi-graph-guard` is a policy guard for Pi tools, not an operating-system sandbox. Before dispatch, the effective builtin, package, user, or project agent is materialized into the isolated workspace with Graph Guard merged into `subagentOnlyExtensions`; this also preserves ancestor project agents and agents that declare their own extensions. With the default `allowBash: false`, path-bearing tools are constrained to the declared scopes and malformed contracts fail closed. Enabling `allowBash` lets trusted project code and a trusted child model run shell commands inside the isolated workspace; shell parsing cannot prove containment against deliberately obfuscated commands. Supervisor validation can also execute trusted project tests, so GraphSpecs and repositories must be treated as trusted inputs for unattended runs.

Durability and path checks cover process crashes, power-loss publication boundaries, stale claims, static symbolic links, and ordinary concurrent Pi processes. Initialization uses exclusive file creation, repeated inode/realpath checks, directory `fsync` before and after publication, and a Graph-keyed mutation gate for Graph lock creation and orphan cleanup. Keyed claims use deterministic scope prefixes to avoid scanning unrelated live contenders while retaining compatibility with legacy unscoped claims. Like other user-space Node extensions, it does not claim to defend against a hostile process running as the same OS user that continuously swaps filesystem objects between individual system calls; protecting against that attacker requires an OS sandbox or native `openat`-style containment.
