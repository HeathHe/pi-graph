# pi-graph V3 技术合同

> 本文定义当前唯一生产内核的公开输入、执行状态、持久化与恢复语义。它不是实施阶段计划。产品目标见 [product-definition.md](product-definition.md)；若两者冲突，以本文为准并同步修订产品文档。

## 1. 范围与版本

pi-graph 只接受并创建以下组合：

| 载体 | 版本 | 含义 |
| --- | --- | --- |
| GraphSpec | `schemaVersion: 3` | 调用方提交的唯一图输入格式 |
| Snapshot | `schemaVersion: 3` | 从 journal 与 Attempt 证据重建的运行投影 |
| Authorization | `schemaVersion: 4`, `runtimeSchemaVersion: 3` | 不可变 admission、源目录身份与编译投影 |
| Attempt / workspace / validation / acceptance | `schemaVersion: 1` | 单次节点执行的权威证据 |
| Control | `schemaVersion: 1` | 持久化 operator desired state |
| Mutation / retry journal | `schemaVersion: 1` | append-only 拓扑变更和显式重试意图 |

新运行没有第二条执行路径：`extensions/pi-graph.ts` 只创建 `V3GraphHost`，Host 只使用 `src/v3/**`。

V3 明确不包含：

- 任务评估、目标拆解、计划生成或计划复核；
- 模型选择、模型路由、降级、模型注册表或 provider retry；
- visual evidence 或截图验收；
- 普通 Pi turn 的监听、自动准入或强制门链；
- GraphSpec 的 legacy 转换或双内核分流。

编译器会递归拒绝 `model`、`thinking`、`routing`、`planning`、`routingProfile`、`planningReceipt`、`resolvedModel` 等治理字段；Authorization V4 也拒绝这类字段。

## 2. GraphSpec V3

### 2.1 顶层

```ts
interface GraphSpecV3 {
  schemaVersion: 3;
  graphId?: string;
  goal: string;
  nodes: GraphNodeSpecV3[];
  maxConcurrency?: number;
  failFast?: boolean;
  workspace?: "shadow";
  readOnly?: boolean;
  toolFilter?: string[];
  mode?: "sealed" | "open";
}
```

| 字段 | 合同 |
| --- | --- |
| `schemaVersion` | 必须精确为 `3` |
| `graphId` | 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`；省略时为 `graph-<sourceGraphSpecDigest 前16位>` |
| `goal` | 非空，最多 2000 字符 |
| `nodes` | 最多 512；SEALED 图至少 1 个，OPEN 图允许 0 个 |
| `maxConcurrency` | 整数 1..6，默认 2 |
| `failFast` | boolean，默认 `false` |
| `workspace` | 只能是 `shadow`，默认 `shadow` |
| `readOnly` | 默认 `false`；为 true 时编译期拒绝 `local_write`，运行时 Guard 拒绝写工具 |
| `toolFilter` | 无重复的精确工具名 allow-list；名称匹配 `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$` |
| `mode` | `sealed`（默认）或 `open` |

`sourceGraphSpecDigest` 对调用方原始 JSON 值的 canonical form 计算 SHA-256。编译投影另算 `graphDigest`；这两个 digest 分别绑定输入材料和规范化执行合同。

### 2.2 节点

```ts
interface GraphNodeSpecV3 {
  taskId: string;
  agent: string;
  task: string;
  dependsOn?: string[];
  when?: { node: string; status: "accepted" | "failed" };
  inputArtifacts?: string[];
  outputArtifact?: string;
  readScope?: Array<{ kind: "file" | "tree"; path: string }>;
  writeScope?: Array<{ kind: "file" | "tree"; path: string }>;
  sideEffect: "none" | "local_read" | "local_write";
  timeoutMs?: number;
  retryPolicy?: {
    maxAttempts?: number;
    retryOn?: Array<"task_failed" | "validation" | "timeout" | "workspace_conflict">;
    backoffMs?: number;
  };
  acceptance?: string;
  validationCommands?: string[];
}
```

规则：

- `taskId` 匹配 `^[a-z0-9][a-z0-9-]*$`，最长 200 个字符，图内唯一；长度边界保证它可安全用于 durable filename。
- `agent` 和 `task` 必须是非空字符串；`agent` 在 admission/dispatch 前通过 `pi-subagents` preflight。
- `dependsOn`、`inputArtifacts`、`toolFilter` 及 retry reason 不允许重复。
- `when.node` 不能是自己，必须存在，并且必须同时列入本节点的 `dependsOn`。
- `outputArtifact` 省略时为 `<graphId>/<taskId>/out`；所有 artifact path 都是项目相对路径。
- `sideEffect` 只允许三个枚举值；`external_read`、`external_write` 以及其他值均拒绝。
- 非 `local_write` 节点不能声明非空 `writeScope`。
- `local_write` 必须同时有非空 `writeScope` 和非空 `validationCommands`。
- `timeoutMs` 若提供必须是正整数；不提供时没有隐式 Attempt deadline。
- `retryPolicy` 默认 `{ maxAttempts: 1, retryOn: [], backoffMs: 5000 }`；`maxAttempts` 为 1..5，`backoffMs >= 0`。
- `acceptance` 是声明文本，不参与机器判定；只有 `local_write` 的确定性 `validationCommands` 能产生 machine-verified 验收。

### 2.3 路径与保护目录

Scope 和 artifact 必须是规范化相对路径，不能包含 NUL、绝对路径、盘符绝对路径或 `..`。下列控制路径不能成为 scope/artifact：

```text
.git
.pi-graph
.pi-subagents
.pi/agents
```

大小写比较使用 portability key，避免大小写不敏感文件系统上的别名绕过。workspace 复制与 apply 还会拒绝声明 scope 内的符号链接。

## 3. 编译合同

`compileGraphSpecV3` 是 spec、capsule、模板、append 回放和 Authorization 现场验证共用的唯一编译器。

编译按以下不变量执行：

1. 拒绝治理字段和所有未知字段；
2. 规范化默认值、scope、artifact、retry policy 与工具名；
3. 校验 taskId 唯一、依赖存在、`when` 来源是直接依赖；
4. 使用确定性 Kahn 排序生成 `topologicalOrder`；同一 ready 集按 taskId 排序；
5. 若排序不能消费全部节点，返回 `DEPENDENCY_CYCLE`；
6. 要求每个 `inputArtifact` 由该节点的祖先精确产生；
7. 拒绝两个 output artifact 路径相同或互为父子；
8. 拒绝同一节点内部重叠的 write scopes；
9. 对不存在祖先/后代顺序的节点，拒绝 write/write、read/write 或 write/read scope 重叠；
10. 生成 canonical source digest 和 compiled projection digest。

有明确依赖顺序的节点允许 scope 重叠，因为调度会等待上游 `accepted`。无顺序节点必须可安全并行，不能依赖运行时碰运气解决冲突。

`validationCommands` 在编译期解析为 argv。拒绝 shell operator、路径逃逸、内联 Node/Python 代码、会改变 cwd 的 package-manager 参数、会下载包的 `npx` 调用以及写型 git 子命令。允许的 executable 精确为：

```text
npm npx pnpm yarn bun node tsc vitest jest eslint prettier
pytest python3 ruff go cargo git test jq
```

## 4. 拓扑生命周期与 revision CAS

### 4.1 SEALED

`mode` 省略或为 `sealed` 时，图在 admission 后拓扑不可变。节点全部形成终态后，图投影为 `complete`、`failed`、`stopped` 或 `needs_attention`。

### 4.2 OPEN

OPEN 图的动态字段为：

```text
topology: open | sealed
revision: non-negative safe integer
sealed: boolean
```

revision 0 表示还没有 journal mutation。OPEN 图暂时没有可运行节点时为 `idle`，不是完成。

### 4.3 `append`

- 仅 OPEN、未 seal 的图可用；
- 必须携带当前 `expectedRevision`；
- 每次追加 1..64 个节点，整图仍不得超过 512；
- 只能增加新的不可变节点，不能修改旧节点、旧依赖或旧字段；
- 可依赖旧节点或同批新节点；整个候选图重新经过 V3 编译器；
- 不能让新节点依赖已经取消的分支；
- production Host 在提交前冻结新节点的 Agent 定义；
- 成功后 revision 加一，并唤醒 `idle` runner。

### 4.4 `cancel`

- 仅 OPEN、未 seal 的图可用；
- 必须携带当前 `expectedRevision`；
- `cascade: true` 时把请求节点的完整后代闭包写入 tombstone；
- accepted、prepared、dispatched、running、verifying、applying 和 `needs_attention` 节点不能取消；
- 取消状态读取与 mutation 发布位于同一 Supervisor fence 内；prepared Attempt 和 cancel 不可能基于过期观察同时成功；
- cancel 是 projection authority，不为未执行节点制造 Attempt。

### 4.5 `seal`

`seal` 提交最后一条 mutation 并永久关闭拓扑；它不停止正在运行的节点。seal 后不能再 append/cancel，runner 才开始计算最终图终态。

### 4.6 journal 原子性

每条 mutation 写入：

```text
mutation-journal/revision-0000000000000001.json
```

记录包含 base graph digest、前一记录 digest、revision 和自身 digest，形成连续链。发布使用同文件系统 staging file、`fsync` 和 no-replace hard-link 边界；最终文件要么不存在，要么指向完整、已同步的字节。revision 不匹配返回 `REVISION_CONFLICT`，调用方必须 reload 后重试。

## 5. 调度与状态

### 5.1 ACCEPTED 解锁

普通依赖只有 `accepted` 才满足。runner 没有“同层全部完成”屏障：节点一旦 accepted，其就绪下游立即竞争并发名额。

### 5.2 `when`

`when` 只观察一个直接依赖：

- 实际终态与条件相同：该依赖边满足；
- 实际为 accepted/failed 但不匹配：当前节点 `skipped`；
- 条件来源被 skipped：当前节点 `skipped`；
- 条件来源 failed/aborted/needs_attention/blocked/cancelled 且不满足条件：当前节点 `blocked`；
- 条件来源未终态：当前节点等待。

除条件来源外，其他直接依赖仍必须 accepted。`when.status: "failed"` 是唯一允许失败边解锁的机制。

### 5.3 节点状态

真实 Attempt phase：

```text
prepared → dispatched → running → verifying → applying → accepted
                                      ↘ failed / aborted / needs_attention
```

`queued` 是尚未创建 Attempt 的投影。`skipped`、`blocked`、`cancelled` 是由 immutable topology、mutation journal 和 Attempt 终态推导的 synthetic projection；它们不创建伪执行证据。

终态 Attempt phase 为 `accepted`、`failed`、`aborted`、`needs_attention`。

### 5.4 图状态

可能的 snapshot status：

```text
queued running idle stopping complete failed stopped paused waiting_input needs_attention
```

当前调度器实际产生 `queued`、`running`、`idle`、`stopping`、`complete`、`failed`、`stopped`、`paused`、`needs_attention`；`waiting_input` 是保留的合法投影值。

任何节点 `needs_attention` 都使图为 `needs_attention`。SEALED 图全部 terminal 且至少一项 failed 时为 `failed`；全部非失败终态时为 `complete`，存在 aborted 时为 `stopped`。OPEN 图全部当前节点 terminal 时为 `idle`。

## 6. Attempt 执行合同

### 6.1 Attempt 身份与上限

每个 Attempt 有递增 `attempt`、随机 `attemptNonce`、`supervisorEpoch` 和不可变创建时间。自动重试和显式 retry 共用历史，任何节点最多 100 个 Attempt；Attempt 101 必须拒绝。

### 6.2 全 Attempt deadline

如果节点声明 `timeoutMs`，创建 Attempt 时立即写入绝对 `deadlineAt`。下列阶段全部共享这一条墙钟预算：

```text
input artifacts
workspace preparation
Agent preflight
dependency capsule
dispatch intent + RPC emit
child monitoring
child result persistence
validation
workspace inspection + apply
artifact + acceptance publication
crash recovery
```

恢复不会生成新 deadline，也不会因进程重启获得额外时间。任何阶段剩余时间小于等于 0 时分类为 `timeout`。

### 6.3 durable dispatch intent

派发前顺序持久化：

1. `dispatchIntent.state: "prepared"`；
2. 同一 intent 更新为 `state: "emitting"` 并记录 `emittedAt`；
3. 调用 `pi-subagents` RPC，stable request ID 为 `pi-graph-v3-<attemptNonce>`；
4. 持久化 `{ asyncId, asyncDir, requestDigest, dispatchedAt }` binding。

进程在 emit 附近中断时，恢复逻辑以 stable request ID、request digest 和时间边界查找原 child：

- 找到唯一匹配 binding：继续同一 Attempt；
- 找不到或身份歧义：`dispatch_unknown` → `needs_attention`；
- 已跨 emit 边界时禁止盲目再派发。

### 6.4 child 结果与终止确认

child 终态映射：

| Child | Node failure |
| --- | --- |
| `complete` | 进入验证/验收 |
| `failed` | `task_failed` |
| `stopped` | `child_stopped` |
| `paused` | `child_paused`，Graph 不接管或复制它 |

timeout、AbortSignal 或 graph stop 需要终止 child。Supervisor 必须等待 `pi-subagents` 的 stop 确认（默认确认窗口 5 秒）；无法确认时写入 `dispatch_unknown` 并把 Attempt 置为 `needs_attention`。系统不能在 child 仍可能运行时声称安全停止。

### 6.5 自动 retry

可自动重试的 failure 只有 GraphSpec `retryOn` 四类。`dispatch_unknown`、`child_paused`、`child_stopped` 和 internal 不在自动 retry 白名单。每次失败先形成不可变 failed Attempt，再按 `backoffMs` 调度下一次；同时受 spec 的 1..5 上限和 100 次终身上限约束。

## 7. Workspace、Guard、验证与 apply

### 7.1 shadow workspace

每个 Attempt 使用：

```text
<runDir>/shadow/<taskId>-<attempt>/workspace
```

只复制声明的 read/write scope 和已验收 input artifacts。workspace evidence 记录：

- source/workspace 路径；
- readBaseline 和 writeBaseline SHA-256；
- input artifact digest；
- node contract digest；
- workspace kind（当前为 `shadow`）。

Agent 定义和 Graph Guard 在 admission 时冻结并做 digest 绑定，之后物化到 workspace 的 `.pi/agents`。Guard 文件或冻结 Agent 漂移时拒绝 dispatch/resume。

### 7.2 Guard

子 Agent contract 包含绝对 read/write scope、图级 `readOnly`、精确 `toolFilter`、保护路径和 input baseline。

- `read`、`write`、`edit`、`grep`、`find`、`ls` 的路径必须位于声明 scope；
- write/edit 只能进入 write scope；
- `.git`、`.pi/agents`、`.pi-subagents`、`.pi-graph` 等控制路径受保护；
- `bash` 总是拒绝；
- 非文件工具必须在 `toolFilter` 中，且 Guard 必须把它识别为只读远程工具；
- 不支持的 path-bearing 工具 fail closed；
- contract 缺失时扩展不介入，contract 畸形时 fail closed。

这是 Pi 工具边界，不是 OS 沙箱。

### 7.3 确定性验证

`local_write` child 完成后，Supervisor 在 shadow workspace 内顺序运行 `validationCommands`：

- `spawn(..., { shell: false })`；
- 默认每条命令最多 300000 ms，但永远不超过 Attempt 剩余时间；
- stdout/stderr 各自默认最多 64 KiB，按字节截断并记录 flag；
- timeout/abort 对进程组先 SIGTERM，2 秒后 SIGKILL；
- 第一条失败命令终止后续验证；
- command、exitCode、signal、timedOut、输出、截断 flag、duration 全部写入 `validated-result.json`。

### 7.4 冲突检测与 apply

验证后 `inspectWrites` 比较 shadow 与 writeBaseline，生成实际 writes。apply 前再次比较源工作区当前 digest 与 baseline：

- 不一致：`workspace_conflict`，不覆盖源文件；
- 一致：创建带备份的 apply plan，逐文件原子 copy/rename 或删除；
- apply plan 持久化 `prepared`、`applying`、`committed`，允许中断恢复；
- authoritative apply 位于 Supervisor fence 内。

编译器已经排除无顺序节点的 scope 重叠。除此之外，runner 仍把每个 `local_write` 的完整 Attempt（workspace、child、验证、apply 与验收）放入单图 FIFO 写锁；同图写节点不会彼此交叠，读节点仍可并发。

## 8. Dependency capsule 与 artifact

### 8.1 dependency capsule

每个节点启动前，从声明顺序的直接依赖读取持久 child output：

- 普通依赖只交接 accepted output；
- 与 `when.status: "failed"` 匹配的依赖可交接 failed output；
- 每路最多 12000 个 JSON 序列化字符；
- 全部依赖合计最多 32000；
- 公平分配预算，截断条目标记 `truncated` 与 `originalChars`；
- 以具名 JSON 数组附加到当前 task，并明确标记为 untrusted data。

resume/retry 继续使用持久化的原上游 output，不依赖内存缓存。

### 8.2 artifact

逻辑 `outputArtifact` 建立编译期数据依赖。物理产物按 taskId 发布：

```text
artifacts/<taskId>/attempt-<N>.txt   # 不可覆盖历史
artifacts/<taskId>.txt               # latest convenience alias
```

history 使用 create-new 语义；同一路径已存在但内容不同视为错误。latest 只在 history 完整落盘后原子更新。acceptance 最后发布，不能引用尚未落盘的 artifact。

`inputArtifacts` 在 child 启动前复制到：

```text
<workspace>/.pi-graph/inputs/<logical-artifact-name>
```

输入必须是单一普通文件，digest 被写入 workspace evidence。

## 9. 验收证据

`acceptance.json` 包含 method、verified、validatedResultDigest、attemptDigest、supervisorEpoch 和可选声明文本。

| 节点 | method | verified | 接受条件 |
| --- | --- | --- | --- |
| `none` / `local_read` | `declared` | `false` | child complete + artifact 发布成功 |
| `local_write` | `machine-verified` | `true` | child complete + validations 全过 + apply 成功 + artifact 发布成功 |

`acceptance` 自然语言不会变成机器事实。production runner 只产生 `declared` 或 `machine-verified` 两种方法。

下游只以 Attempt terminal `accepted` 解锁，不以 child 自报“完成”、自然语言 verdict 或 events 流解锁。

## 10. 持久化布局与权威

典型 run：

```text
<runsDir>/<graphId>/
├── authorization.json
├── snapshot.json
├── control.json
├── lease.json                         # 活跃 Supervisor 存在时
├── supervisor-fence.json
├── events.jsonl
├── events.truncated.json              # 达到事件上限时
├── mutation-journal/
│   └── revision-0000000000000001.json
├── retry-journal/
│   └── revision-0000000000000001.json
├── agent-profiles/<taskId>.json
├── nodes/<taskId>/attempts/<N>/
│   ├── attempt.json
│   ├── workspace.json
│   ├── validated-result.json          # local_write
│   ├── acceptance.json                # accepted
│   └── apply-plan.json                # local_write apply
├── artifacts/
│   ├── <taskId>/attempt-<N>.txt
│   └── <taskId>.txt
├── sessions/<taskId>/
└── shadow/<taskId>-<N>/workspace      # 活跃/可恢复 Attempt
```

权威关系：

- `authorization.json`：不可变 base GraphSpec、compiled projection、digests、session/source identity；
- mutation journal：动态拓扑、revision、cancel tombstone 和 seal authority；
- retry journal：显式 retry intent 与每个目标节点的 Attempt baseline；
- Attempt/workspace/validation/acceptance：执行事实；
- `control.json`：调用方期望的 running/paused/stopped；
- `supervisor-fence.json` + live lease：谁有写 authority；
- `snapshot.json`：可由以上事实重建的便利投影；
- `events.jsonl`：`unverified: true` 的最佳努力观测流，不参与调度或恢复决策。

事件单条最多 16 KiB、最多 10000 条、合计最多 16 MiB。达到上限后写 sidecar 并停止追加；事件失败永远不能回滚已经提交的执行事实。

关键 JSON 和 authority 记录通过临时文件、file `fsync`、原子 rename/link 和父目录 `fsync` 发布。初始化还使用独占 owner lock 与目录 inode 检查，避免竞争 runDir 或符号链接替换。

## 11. Supervisor lease 与 generation fencing

同一 run 同时只能有一个 Supervisor。lease 绑定：

```text
runInstanceId + pid + processIdentity + token + heartbeat
```

PID 存活本身不够；takeover 必须同时检查进程启动身份，防 PID 重用。持久 `supervisor-fence.json` 为每次 acquisition 预留并递增 generation，generation 永不复用，即使进程在 lease 发布中途崩溃也会烧掉该代。

所有 authoritative mutation 通过 `lease.withFence`：

- Attempt 首次创建与更新；
- snapshot 发布；
- validation/acceptance 证据写入；
- workspace apply；
- append/cancel/seal；
- retry intent。

lease 失效后旧 Supervisor 不能继续写。发现 live holder、ledger/lease 不一致或无法验证身份时，fail closed 为 `needs_attention`。

## 12. Control、恢复与显式 retry

### 12.1 `control.json`

```ts
interface V3RunControl {
  schemaVersion: 1;
  runInstanceId: string;
  graphId: string;
  desiredState: "running" | "paused" | "stopped";
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

底层 control mutation 支持 `expectedRevision` CAS；公开 `graph pause/resume/stop` 提交无条件新 revision。desired state 与 observed snapshot status 分离，避免把“请求停止”和“已经安全停止”混为一谈。

### 12.2 pause

先提交 paused intent，再停止启动新节点；已经运行的 child 不被 pause 强杀，完成收尾后 runner 返回 `paused`。session shutdown 对所有本进程监督的图执行这一流程，使关闭会话成为可恢复暂停，而不是失败或 aborted。

### 12.3 resume / adoption

resume 重放 base GraphSpec、mutation journal、retry journal，重新读取每个节点最新 Attempt：

- accepted/failed/aborted/needs_attention：保留终态；
- applying：恢复 apply plan；
- verifying 且有 child：继续验证/apply；
- dispatched/running 且有 binding：继续监控原 child；
- prepared + durable dispatch intent：根据 intent 状态安全发出或找回原 child；
- prepared 但没有 durable intent：`dispatch_unknown`，不猜测。

session start 的 adoption scan 只处理 V3 run：paused desired state 保持暂停；running desired state 恢复非终态；stopped intent 完成安全停止；pending retry intent 优先恢复。live competing lease 或证据错误报告 `needs_attention`。

### 12.4 stop

先提交 stopped intent。活跃 Supervisor 请求 child stop；没有本地 Supervisor 时，Host 现场加载 run、获取 lease 并执行停止恢复。不能获得 authority 或不能确认 child termination 时不伪造 stopped。

### 12.5 explicit retry

只允许 run 已经 terminal 且没有另一个 pending retry intent时调用。目标必须有 terminal Attempt，且不能属于 cancelled closure。

retry target set 为：

```text
目标节点 + 所有未取消后代
```

提交时在 live fence 内读取每个 target 的最新 Attempt number，写入 digest-chained retry journal。恢复只对仍处于该 baseline 的节点执行一次新 Attempt；已经越过 baseline 的节点不会被重复 reset。accepted 的非后代保持不变。

`host.retry()` 在提交 intent、启动新 Supervisor 后立即返回当时的投影；不会等待本轮重跑终态。调用方需要最终结果时使用 `waitForCompletion()` 或继续查询 `status`。持久 retry 语义不依赖调用方保持连接。

## 13. Capsule 与模板合同

### 13.1 `.graph.json`

capsule 文件：

```ts
interface V3GraphCapsule {
  manifest: { name: string; version: string; description: string };
  source: { type: "graph-spec"; spec: Record<string, unknown> };
  intent: string;
  inputs: Record<string, {
    type: "string" | "number" | "boolean";
    required: boolean;
    default?: string | number | boolean;
    description?: string;
  }>;
  requires: { readOnly: boolean; toolFilter: string[] };
  provenance?: { created: string; author?: string; source?: string };
}
```

- 文件名必须以 `.graph.json` 结尾，最大 1 MiB；
- 读取使用稳定文件身份检查，不接受读取过程中被替换的内容；
- override 不得包含未声明输入，类型必须精确匹配；
- `{{input}}` 可递归替换 JSON value，不替换 object key；完整 value placeholder 保留 number/boolean 类型；
- 未闭合、未知或未解析 placeholder 拒绝；
- `requires.readOnly/toolFilter` 写入 resolved GraphSpec，属于执行 authority；
- placeholder 解析后必须再次经过唯一 V3 compiler。

### 13.2 内置模板

| 名称 | 需要输入 | 默认/可选输入 | requires |
| --- | --- | --- | --- |
| `research-report` | `topic` | `depth`, `audience` | readOnly；`read`, `web_search`, `fetch_content`, `get_search_content` |
| `code-review` | `target` | `focus`, `requirements` | readOnly；`read`, `grep`, `find` |
| `doc-write` | `doc_path`, `subject` | `style` | write；`read`, `write`, `edit` |

内置模板从同一 `.graph.json` 资源解析，不能绕过 capsule 或 GraphSpec 校验。

## 14. 公开 API 与配置

### 14.1 `graph` action

动作集合必须精确为：

```text
start load status list doctor pause resume stop
templates agents retry append cancel seal
```

行为摘要：

- `start`：恰选 spec/capsule/template，初始化后异步返回；同一 toolCallId 同参数幂等复用，同 ID 不同参数拒绝；
- `load`：无 id 时仅编译；有 id 时重建并返回 durable run；
- `status/list`：读取 V3 投影；不列出或执行其他格式；
- `doctor`：报告 stale lease、orphan shadow、invalid run、needs_attention；
- `pause/resume/stop`：持久控制并按上节执行；
- `templates/agents`：只读发现；
- `retry`：提交目标节点+下游的 durable retry；
- `append/cancel/seal`：必须携带动态 topology revision。

`/graphs` 人工命令精确支持：

```text
doctor list status pause resume stop
```

### 14.2 配置

V3 只读取：

```ts
interface V3GraphConfig {
  enabled: boolean;     // default true
  runsDir: string;      // default <Pi agent dir>/graph-runs
  rpcTimeoutMs: number; // default 10000, clamped at 300000
}
```

历史 graph settings 不会被解释成调度、路由或保留策略。

## 15. 与 dsh-graph 的对齐矩阵

两者共享架构思想，但不是 wire-compatible，也不复制宿主特有字段。

| 能力 | dsh-graph 现状 | pi-graph V3 | 对齐结论 |
| --- | --- | --- | --- |
| DAG 编译 | `compileGraphSpec`，拓扑排序与环检 | `compileGraphSpecV3`，另加 scope/artifact/保护路径严格检查 | 核心对齐，Pi 输入更严格 |
| Graph schema | GraphSpec v1；`agent/requires/model/defaultModel` 等宿主字段 | `schemaVersion: 3`；`agent` 必填；无 model/requires/defaultModel | 概念对齐，格式不兼容 |
| 固定/动态图 | SEALED/OPEN | SEALED/OPEN | 对齐 |
| 动态操作 | append/cancel/seal + revision CAS | append/cancel/seal + revision CAS | 对齐 |
| mutation authority | 聚合在 `run.json`，明确单 Host writer | 独立 digest-chain journal + no-replace 发布 + Supervisor fence | Pi 强化跨进程写者排他 |
| 条件节点 | `when accepted|failed`，不匹配 skipped | 相同语义 | 对齐 |
| ACCEPTED 门控 | 普通下游仅由 accepted 解锁 | 相同语义 | 对齐 |
| dependency output | 每路 12k、合计 32k、不可信 JSON | 相同预算与标记 | 精确对齐 |
| local write | 共享 cwd 前后指纹；单图 `localWriteLock` 串行整段写节点 | 单图 FIFO 锁同样串行完整写 Attempt；另加独立 shadow、baseline、validation 与原子 apply | 调度语义对齐，Pi 隔离更强 |
| 跨 run 写冲突 | 同 cwd 跨 run 没有写锁，调用方规避 | baseline 在 apply 前检查，冲突为 `workspace_conflict` | Pi 提供更强冲突检测，但不是 OS 锁 |
| 验证 | local_write 必须 deterministic validation | 相同；另有编译期 executable/argv 白名单 | 对齐并强化 |
| Attempt | 完整历史，节点最多 100 | 多文件不可变证据，节点最多 100 | 对齐 |
| deadline | 整节点墙钟预算 | 整 Attempt 绝对 deadline，恢复不重置 | 对齐 |
| artifact | `attempt-N.txt` + latest alias | 相同物理模式 | 精确对齐 |
| 持久 run | 单一 `run.json` 为权威，events 派生 | authorization + journals + Attempt evidence 为权威，snapshot 投影，events 派生 | 原则对齐，存储拆分不同 |
| 崩溃处理 | `recoverOrphans` 把遗留运行转 interrupted/stopped，再由 resume/retry 新推进 | stable dispatch identity；证据充分时在同一 Attempt 续监控/验证/apply | Pi 恢复更细粒度 |
| stop/resume/retry | 支持 | 支持 | 对齐 |
| pause | 无独立 durable pause action | durable pause + session shutdown pause | Pi 扩展 |
| child stop confirmation | Host abort/状态收尾 | 必须确认 public RPC stop；未知则 needs_attention | Pi 强化 |
| writer fencing | 单 runDir 单 Host 约束 | PID+process identity lease、monotonic generation fence | Pi 强化 |
| Agent 配置 | DSH preset role、capability 匹配、临时 Agent、模型偏好 | 精确 `.pi/agents` 名称，admission freeze，公共 preflight；不选模型 | 宿主适配不同 |
| `readOnly` | 与角色 toolFilter/只读 allow-list 取交集 | compiler 禁 local_write，Guard 执行 graph toolFilter 和只读工具判断 | 目标对齐，实现不同 |
| capsule/templates | 三个内置模板，typed envelope | 三个同类模板，共用 typed `.graph.json` 编译器 | 对齐 |
| 并发 | 默认 8，最大 32 | 默认 2，最大 6 | 有意不同 |
| 工具动作 | 12 个，无 `pause/doctor` | 14 个，增加 `pause/doctor` | Pi 扩展 |
| 模型字段 | Graph 传偏好给 DSH Host，Graph 自身不做路由 | 编译器完全拒绝模型/路由字段 | Pi 保持纯执行器边界 |

## 16. 必须保持的不变量

任何实现改动不得破坏：

1. 没有 accepted 证据，下游普通边永不解锁；
2. local_write 未验证或未 apply 完成，永不 accepted；
3. acceptance 永不引用尚未发布的 artifact；
4. emit 边界之后身份未知，永不盲目重派；
5. stop/timeout 未确认 child 终止，永不报告安全终态；
6. lease/fence 失效的 Supervisor 永不继续 authority write；
7. dynamic mutation revision 过期，永不覆盖新 revision；
8. cancel 与首次 prepared Attempt 由同一 fence 决胜；
9. retry 只从 durable baseline 产生一次新执行，不覆盖历史；
10. snapshot/events 可丢失或重建，不得反过来覆盖 authority evidence；
11. GraphSpec、Authorization 与公开 action 中不得重新引入规划、治理或模型路由；
12. Guard 只能被描述为工具边界，不得声称 OS 沙箱。
