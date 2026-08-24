# pi-graph V3 架构

pi-graph 当前只有一个职责：可靠执行调用方已经定义好的 DAG。生产链路从 `extensions/pi-graph.ts` 进入 `src/v3/**`，不存在旧 GraphManager、治理门或模型路由旁路。

```text
GraphSpec / capsule / template
            │
            ▼
 compileGraphSpecV3
            │
            ▼
 V3GraphHost ── durable control / mutation / retry
            │
            ▼
 V3GraphRunner ── Supervisor lease + generation fence
            │
            ├── pi-subagents RPC child
            ├── shadow workspace + Graph Guard
            ├── deterministic validation + atomic apply
            └── Attempt / acceptance / artifact evidence
```

## 1. 分层

| 层 | 主要文件 | 责任 |
| --- | --- | --- |
| Pi 入口 | `extensions/pi-graph.ts` | 注册 14 个 `graph` actions、`/graphs`、background-work provider 和 session 生命周期 |
| Child 护栏 | `extensions/pi-graph-guard.ts` | 执行 node contract：scope、readOnly、toolFilter、保护路径、bash 禁用 |
| 输入 | `src/v3/graph-capsule.ts`, `templates.ts` | 安全读取 `.graph.json`、类型化输入替换、内置模板 |
| 编译 | `src/v3/compiler.ts` | 严格 schema、拓扑排序、环/依赖/artifact/scope 检查、digest |
| Admission | `src/v3/initialize.ts`, `authorization.ts`, `source-identity.ts` | 原子创建 run、绑定源目录身份、写 Authorization V4 和初始 Snapshot V3 |
| Host | `src/v3/host.ts`, `config.ts` | start/load/status/list/control、恢复认领、动态变更、显式 retry |
| Control | `src/v3/control.ts` | `running/paused/stopped` desired state 与 revision CAS |
| 动态拓扑 | `src/v3/mutations.ts` | OPEN/SEALED、append/cancel/seal、revision CAS、digest-chain journal |
| 调度 | `src/v3/runner.ts`, `scheduler.ts` | dependency readiness、when、并发、failFast、Attempt 状态机、恢复 |
| 派发 | `src/v3/dispatch.ts`, `rpc.ts` | stable request ID、durable emit intent、child 监控/停止/找回 |
| Workspace | `src/v3/workspace.ts` | shadow workspace、Agent freeze、baseline、write inspection、atomic apply |
| 验证 | `src/v3/validation-command.ts`, `verify.ts` | argv 白名单、shell:false、deadline、字节上限、进程树终止 |
| 证据 | `src/v3/attempt.ts`, `events.ts`, `projection.ts`, `snapshot.ts` | Attempt/validation/acceptance、最佳努力事件、可重建 snapshot |
| 排他写者 | `src/v3/lease.ts`, `claims.ts` | PID+process identity lease、单调 Supervisor generation fence |
| 重试 | `src/v3/retry.ts` | 目标+下游 retry intent、Attempt baselines、崩溃后一次性继续 |
| 数据交接 | `src/v3/capsule.ts` | 有界、不可信的直接依赖 output capsule |
| 原子原语 | `src/v3/durable.ts`, `digests.ts`, `path-safety.ts` | fsync/rename/link、canonical digest、可信目录锚 |

## 2. 从 `graph start` 到完成

```mermaid
flowchart TD
  A["graph start<br/>spec / capsule / template"] --> B["解析来源与 typed overrides"]
  B --> C["compileGraphSpecV3"]
  C -->|非法字段、环、scope/artifact 冲突| X["结构化拒绝"]
  C --> D["原子初始化 run<br/>authorization + snapshot + control"]
  D --> E["冻结所有项目 Agent 定义"]
  E --> F["V3GraphRunner 获取 lease/fence"]
  F --> G{"刷新 mutation/control<br/>计算 ready 节点"}
  G -->|pause 且无 in-flight| P["paused"]
  G -->|stop| S["停止并确认 child"]
  G -->|OPEN 暂无工作| I["idle，等待 append/seal"]
  G -->|ready + 并发容量| H["创建 Attempt"]
  H --> W["准备 shadow workspace<br/>物化 Agent + Guard contract"]
  W --> Q["写 dispatch prepared/emitting intent"]
  Q --> R["pi-subagents RPC child"]
  R --> V["持久 child outcome"]
  V --> K{"local_write?"}
  K -->|否| A1["发布 artifact + declared acceptance"]
  K -->|是| L["FIFO 写槽：验证 → inspect → atomic apply"]
  L -->|失败/冲突| F1["failed 或按 policy retry"]
  L -->|成功| A2["发布 artifact + machine-verified acceptance"]
  A1 --> G
  A2 --> G
  G -->|SEALED 且全部 terminal| Z["complete / failed / stopped / needs_attention"]
```

关键边界：

1. `start` 在初始化完成后异步返回，不等待全图完成。
2. child 自报 complete 不是 ACCEPTED；写节点还必须验证并 apply。
3. acceptance 最后发布，所以不会指向半写产物。
4. 一个节点 accepted 后立即解锁自己的下游，不等待无关同层节点。
5. 单图所有 `local_write` 节点按获得写槽的 FIFO 顺序串行整个 Attempt，读节点仍可并发。

## 3. 编译后的图

编译器把输入转成 `CompiledGraphV3`：

```text
sourceGraphSpec + sourceGraphSpecDigest
compiled nodes + topologicalOrder
graphDigest
maxConcurrency + failFast + workspace=shadow
mode(open 仅显式保留；sealed 为默认省略表示)
```

编译器是所有入口的共同信任边界：内联 spec、capsule、模板、append 后候选图、恢复时 Authorization 都会再次经过它。这样动态拓扑和恢复不能绕过首次 admission 规则。

scope 冲突检查同时考虑 read/write：无祖先关系的两个节点如果可能触碰同一路径，会在执行前被拒绝。有显式依赖顺序时允许重叠，因为上游必须 accepted 后下游才可运行。

## 4. 调度模型

### 普通依赖

普通节点的全部 `dependsOn` 必须 accepted。failed、aborted、needs_attention 或 cancelled 依赖会让下游 blocked；skipped 依赖使下游 skipped。

### 条件依赖

`when` 只允许观察一个直接依赖的 accepted 或 failed。匹配的 failed 边可以解锁条件节点，但不会修改原失败 Attempt，因此最终图仍能反映失败。

### synthetic state

`skipped`、`blocked`、`cancelled` 不对应 child 执行。`scheduler.ts` 从拓扑、cancel journal 与真实 Attempt 终态计算 fixed point；`projection.ts` 把结果写进 snapshot。恢复时可以重新推导，而不需要伪造 Attempt 文件。

### 并发与写槽

- 图并发默认 2，最大 6。
- read/none 节点只受图并发上限控制。
- `local_write` 节点从 Attempt 开始到终态持有单图 FIFO 写槽，避免多个写 child 的工作期交叠。
- 动态 mutation 正在 fence 内提交时，runner 暂停启动新节点，避免新拓扑与旧 ready 观察交错。
- `failFast` 为 true 时，任何 failed/needs_attention 终态会阻止继续启动未开始节点；in-flight 节点先正常收尾。

## 5. OPEN/SEALED 与 mutation

```mermaid
stateDiagram-v2
  [*] --> OPEN: start mode=open
  OPEN --> OPEN: append(revision)
  OPEN --> OPEN: cancel(revision)
  OPEN --> SEALED: seal(revision)
  [*] --> SEALED: start mode=sealed
  SEALED --> [*]: terminal projection
```

拓扑状态与执行状态正交：OPEN 可以 running 或 idle；SEALED 可以 queued/running/terminal。每次 append/cancel/seal 都在 live Supervisor fence 中重新读取当前 journal、比较 revision、验证候选结果，再 no-replace 发布下一条完整记录。

cancel 和 Attempt 创建争用同一 fence：cancel 先赢时节点保持 Attempt-free cancelled；Attempt `prepared` 先赢时 cancel fail closed。这个顺序点避免“已经启动但又被投影成从未执行”的矛盾。

## 6. Attempt 状态机

```mermaid
stateDiagram-v2
  [*] --> prepared
  prepared --> dispatched: binding persisted
  dispatched --> running
  running --> verifying: child complete
  verifying --> applying: local_write validations passed
  applying --> accepted: apply + artifact + acceptance
  verifying --> accepted: none/local_read artifact + acceptance
  prepared --> failed
  dispatched --> failed
  running --> failed
  verifying --> failed
  applying --> failed
  prepared --> aborted: stop
  running --> aborted: confirmed stop
  prepared --> needs_attention: dispatch identity unknown
  running --> needs_attention: child stop unconfirmed
```

每次 phase 更新都落在独立 `attempt.json` 中，并带 run/graph/task/attempt/nonce/epoch 身份。自动 retry 创建下一个数字 Attempt；历史 Attempt 不覆盖。显式 retry 也从最新 baseline 增一，每节点总上限 100。

`timeoutMs` 被转换成 Attempt 创建时的绝对 `deadlineAt`。所有异步阶段每次开始都计算剩余时间；恢复仍读取同一个 deadline。

## 7. 派发崩溃窗口

RPC 调用不是原子文件操作，因此 runner 在 emit 前建立 durable intent：

```text
prepared intent
    ↓
emitting intent（RPC 边界可能已经跨过）
    ↓
dispatch binding（asyncId + asyncDir + requestDigest）
```

stable request ID 来自 Attempt nonce。若进程在 emitting 后崩溃，新 Supervisor 先向 `pi-subagents` 找回相同 request；找不到就进入 `needs_attention`，不会重发一个“看起来相同”的 child。

stop/timeout 也遵循同一原则：发送 child stop 后必须得到确认。确认窗口耗尽意味着 child 可能仍存活，因此不能安全重试或宣布 stopped。

## 8. 写入安全链

```mermaid
flowchart LR
  A["源 scope baseline"] --> B["shadow workspace"]
  B --> C["Graph Guard 限制 child 工具"]
  C --> D["validationCommands"]
  D --> E["inspect actual writes"]
  E --> F{"源 baseline 仍相同?"}
  F -->|否| G["workspace_conflict"]
  F -->|是| H["durable apply plan"]
  H --> I["逐文件原子 apply"]
  I --> J["machine-verified acceptance"]
```

Graph Guard 与 shadow workspace 分工不同：

- shadow 降低错误 child 直接破坏源文件的风险；
- Guard 在 Pi tool-call 边界限制读写 scope、工具名和保护目录；
- baseline 检查发现 source 在 child 工作期间被其他进程改变；
- deterministic validation 验证结果，而不是验证 child 的自我陈述；
- apply plan 处理进程在多文件提交中途崩溃的恢复。

它们仍不是 OS sandbox；直接以同一用户操作文件系统的恶意代码不在保证范围内。

## 9. 证据与投影

```text
不可变/append-only authority
  authorization.json
  mutation-journal/*
  retry-journal/*
  nodes/*/attempts/*/{attempt,workspace,validated-result,acceptance}.json
  artifacts/*/attempt-N.txt

持久控制 authority
  control.json
  supervisor-fence.json
  lease.json（只在持有期间存在）

可重建/观测
  snapshot.json
  artifacts/<taskId>.txt（latest alias）
  events.jsonl（unverified，best effort）
```

恢复顺序是“重新编译 admission → 重放 mutation → 读取 retry baseline → 校验 lease/source/Agent/workspace/Attempt → 重建 snapshot”。不能从 `events.jsonl` 推导 authority，也不能因为 snapshot 写着 running 就盲目信任旧进程仍拥有执行权。

## 10. Supervisor fencing

lease 用 PID 加进程启动身份防 PID 重用；generation ledger 在每次 acquire/takeover 时单调递增。旧 generation 的 capability 即使还留在内存里，也无法通过 `assertCurrent`/`withFence`。

fence 覆盖 Attempt 写入、snapshot、apply、acceptance、mutation 和 retry。它既是“单 Supervisor”约束，也是动态 cancel 与 Attempt create 的线性化点。

## 11. pause、resume、stop、retry

控制意图和观察状态分开：

- `pause` 先写 control，再禁止新 dispatch；现有 child 收尾后 paused。
- `resume` 把 desired state 改为 running，现场校验证据并继续。
- `stop` 写 stopped intent，要求活跃 child 确认停止，未开始节点转 aborted。
- session shutdown 等价于对本 session 的活跃图 durable pause。
- `retry` 只在整图 terminal 时提交，目标节点及其未取消下游按 durable baseline 重跑。

重启 adoption scan 尊重 `control.json`：paused 不擅自继续，stopped 不擅自变 running，pending retry 在拿到新 lease 后继续。

## 12. 与 dsh-graph 的架构映射

pi-graph 保留了 dsh-graph 的关键形状：

```text
compiler              → compiler.ts
event-driven DAG loop → runner.ts + scheduler.ts
OPEN mutation         → mutations.ts
Attempt history       → attempt.ts
dependency hand-off   → capsule.ts
capsule/templates     → graph-capsule.ts + templates.ts
versioned artifacts   → runner.ts artifact publication
localWriteLock        → runner.ts FIFO local-write slot
```

宿主适配和耐久性实现不同：dsh-graph 聚合 `run.json` 并假设单 Host writer；pi-graph 使用 `pi-subagents` RPC、多文件证据、shadow apply、durable control 以及跨进程 lease generation fence。这里的目标是复用已验证的架构语义，不是逐文件移植源码。

## 13. 明确删除的架构

主链中不存在以下层或模块角色：

```text
assess_task
plan_graph
review_graph_spec
planning receipt
routing policy / model registry
model resolver / degradation
visual evidence gate
legacy GraphManager / legacy executor
```

任何未来功能如果需要上述能力，应位于调用方或独立扩展，不得悄悄塞回 DAG 执行内核。
