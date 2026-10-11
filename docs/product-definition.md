# pi-graph 产品定义：纯 DAG V3

> 状态：当前产品合同。本文描述已经投入生产入口的 V3，而不是迁移计划或双内核过渡方案。字段、持久化格式和错误语义以 [v3-technical-contract.md](v3-technical-contract.md) 为准。

## 一句话定义

**pi-graph 是 Pi 生态中的单机持久化 DAG 执行器：调用方显式提交 GraphSpec V3，它负责编译拓扑、调度 `pi-subagents`、隔离与验证本地写入、持久化 Attempt 证据，并在证据充分时恢复执行。**

调用方决定为什么使用图、图里有哪些节点，以及每个节点需要哪个 capability（能力）或 exact Agent。Pi Binding adapter 在 admission 前把 capability 解析成一个确定的 Agent；之后 pi-graph Core 只执行已经解析好的图。

```text
Pi Binding / Admission
  capabilityId / requires / model + budget hints
                    ↓ exact resolution + preflight + freeze
Pure DAG Core
  compile → schedule → verify → persist/recover
                    ↓ bounded runtime projection
Observability / Pi TUI
  actual model · child session · usage · tool progress · live DAG
```

## 产品边界

| 负责 | 不负责 |
| --- | --- |
| 严格编译 GraphSpec V3 | 自动判断任务是否值得使用 Graph 或生成 GraphSpec |
| 按共享 capability 合同确定性绑定 exact Agent | 启发式选 Agent、自动生成角色或在 Core 内路由 |
| 拓扑排序、环检测、依赖与产物检查 | 自动拆解目标或生成计划 |
| 按依赖和并发上限调度节点 | 计划审核、任务风险分级或准入门 |
| 把显式 model/thinking/budget hints 交给 `pi-subagents` | 模型注册表、候选排序、降级或 provider retry |
| `when accepted|failed` 条件分支 | 要求截图、视觉证据或视觉审核 |
| shadow workspace、Guard、验证与原子 apply | OS 级安全沙箱或远程执行平台 |
| Attempt、journal、lease 与恢复 | 跨机器分布式调度或 exactly-once 承诺 |
| pause/resume/stop/retry 运维 | 普通 Pi turn 的旁路观察或自动介入 |

V3 没有治理层、规划门、routing policy、model registry、visual evidence 管线或 legacy 执行内核。`routing`、`routingProfile`、`planning` 等治理字段不是“被忽略”，而是由边界校验递归拒绝。公开 authoring 中允许的 `model`、`thinking` 和预算字段会在 Binding 层规范化为不可变 launch evidence；纯 DAG Core 不解释它们，也不读取 capability catalog。

Pi 宿主适配层会通过 `before_agent_start` 给父 Agent 追加固定、幂等的 `PI-GRAPH Routing` 提示，说明复杂协调任务与普通一两个独立委派的选择边界。该提示不分析任务、不生成 GraphSpec、不触发后台运行；Graph 仍然只在父 Agent 显式调用 `graph` 工具后启动。因此这属于工具选择说明，不属于 DAG Core 路由或自动介入。

## 用户价值

### 1. 可预测的执行

同一 GraphSpec 经过确定性规范化后得到稳定的拓扑顺序和 digest。普通下游只在依赖 `accepted` 后解锁；失败分支必须显式写 `when.status: "failed"`，不会发生隐藏条件或隐式路由。

### 2. 可安全审查的本地写入

子 Agent 不直接修改源工作区。它在每个 Attempt 的隔离 shadow workspace 中工作；同图写 Attempt 由 FIFO 写锁整段串行。Supervisor 记录读写 baseline、检查实际变更、运行确定性验证，再在源文件没有并发漂移时执行原子 apply。发生冲突时报告 `workspace_conflict`，不静默覆盖。

### 3. 可恢复、可解释

运行的关键事实不只存在内存里：Graph admission、拓扑 mutation、控制意图、派发身份、child 结果、验证结果、apply 结果、验收记录和产物都持久化。恢复时读取这些事实并重新构建投影；身份或证据不能确认时进入 `needs_attention`，不猜测、不盲目重复派发。

### 4. 可生长的图

固定任务直接使用默认 SEALED 图。探索型或增量型任务可以创建 OPEN 图：以 revision CAS 追加新节点、取消未开始分支，最后显式 seal。OPEN 图队列暂空时保持 `idle`，不会被误报为完成。

### 5. Pi 原生接入

节点可以精确引用一个 Agent，也可以用 `capabilityId` / `requires` 请求共享能力目录中的角色。Binding 要求所有 capability 完整映射到同一个 Agent；同时提供显式 Agent 时必须与目录结果一致。选择结果、catalog/entry digest 和 Agent 定义在 admission 时固定，pending 节点不会因为磁盘内容后来变化而偷偷换角色。

Admission 还保存 `admissionLaunchContractDigest`，但它只是 source Agent、authoring task 和当时 preflight hints 的预检证据。dispatch 时的真实合同还包含 Graph Guard、dependency capsule 和 shadow workspace 等运行时信息；其 `launchContractDigest` 由 child lifecycle 独立报告，不与 admission digest 混为一谈。

`model` 是 requested 值，能力目录中的 fixed model 与 `pi-subagents` preflight 形成 resolved 值，child lifecycle 报告的是 actual 值。产品必须把 requested/resolved/actual 分开展示和持久化，不能用请求值冒充实际运行模型。实时 Pi 工具卡、DAG widget 与 status 同时展示 child run/session、token/cost/turn usage、当前工具和路径。除已上报 token/cost 用于后续 Attempt 的 usage-budget fail-closed 核算外，这些投影不参与调度、验收或恢复权威。

Binding 检查 resolved primary 与全部 fallback candidate。只要 Provider 当前由父 Pi Extension 注册或覆盖，admission 就会 fail closed。Agent 只在 Child 内注册或覆盖 Provider 时，Graph Guard 会在 Pi 0.81 可取消的 `input` 边界比较当前实际 Provider 与 Child registry，并在 Agent/transport 启动前返回 `handled`。不能只依赖 `before_provider_request`，因为扩展的自定义 `streamSimple` 可以绕过该 hook。`models.json` 定义且未被扩展注册/覆盖的普通 Provider 继续按 Pi 原生配置工作。

临时 Agent 默认 fail closed。只有用户明确设置 `settings.graph.allowTemporaryAgent: true`、节点未指定 Agent、能力完全没有 exact match 且合同不是 strict 时，Binding 才可选择包内置的 `pi-graph.graph-worker`。未知显式 Agent、能力映射冲突和 strict graph 永不 fallback。

## 核心产品语义

### Graph 与节点

- Graph 最多 512 个节点；一次 `append` 最多 64 个。
- 图并发范围为 1..6，默认 2；节点完成后立即解锁自己的下游，没有整批 barrier。
- 节点 `sideEffect` 只允许 `none`、`local_read`、`local_write`。
- `local_write` 必须有明确 `writeScope` 和至少一条确定性 `validationCommands`。
- 编译器拒绝无依赖顺序却发生读写/写写 scope 重叠的节点；调用方可以用显式依赖建立合法顺序。
- `readOnly: true` 的图不能包含 `local_write`；Guard 同时拒绝写工具。
- `toolFilter` 是精确图级 allow-list，而不是 Agent 或模型选择器。
- `turnBudget` 与 `toolBudget` 由 `pi-subagents` 执行。`usageBudget` 是每个节点跨全部 Attempt 共享的累计预算；后续 Attempt 只收到扣除历史已上报 usage 后的剩余额度。hard 命中，或已经越过 dispatch 边界却缺少所配置的 token/cost 证据时，pi-graph 会在新 workspace/child dispatch 前 fail closed；它不会中止已经运行的 child。`maxTokens` 是独立的单次 provider 请求输出上限，由 child Graph Guard 在 provider payload 边界强制收紧；最小值为 16，未知 payload 形状 fail closed。

### 条件分支

`when` 只支持一个直接依赖和两个终态：

```json
{ "node": "review", "status": "accepted" }
```

```json
{ "node": "review", "status": "failed" }
```

条件来源必须同时出现在 `dependsOn`。匹配时节点照常运行；条件不匹配时投影为 `skipped`，不创建 Attempt。其他失败依赖会把下游投影为 `blocked`。失败分支成功也不会抹除原始失败证据，因此 SEALED 图仍会如实反映失败。

### 上游数据交接

`dependsOn` 既表示顺序，也表示直接上游输出的显式交接。每个直接依赖最多贡献 12,000 个 JSON 序列化字符，全部直接依赖合计最多 32,000；扇入时公平分配预算并保留具名条目。交接内容被标注为“不可信 JSON 数据”，不能把上游输出中的指令当作当前节点指令。

`inputArtifacts` 另行把已发布的上游产物复制到当前 shadow workspace 的受保护输入目录。编译器要求每个输入产物恰好由祖先节点的 `outputArtifact` 产生。

### 验收与产物

- 非写节点：child 正常完成后使用 `declared` 方法验收；自然语言 `acceptance` 只作为说明记录。
- 写节点：所有验证命令成功、变更检查通过并 apply 完成后，使用 `machine-verified` 方法验收。
- 每次成功 Attempt 先写不可变 `artifacts/<taskId>/attempt-<N>.txt`，再更新 `artifacts/<taskId>.txt` latest 别名；终态验收只引用已经发布的产物。

### Attempt、deadline 与 retry

每次真实节点执行都有独立 Attempt 证据。`skipped`、`blocked`、`cancelled` 是可重建投影，不伪造 Attempt。

节点声明 `timeoutMs` 时，deadline 从 Attempt 创建开始固定，覆盖输入解析、workspace 准备、Agent preflight、child 派发与监控、验证、apply 和产物/验收发布；崩溃恢复继续使用原 deadline，不重新计时。

自动重试由节点的 `retryPolicy` 控制，单次 GraphSpec 允许 1..5 个 Attempt。显式 `retry` 会重跑目标节点以及所有未取消下游，并把 admission 时的 Attempt baseline 写入 append-only retry journal。自动重试和显式重试共享每节点 100 Attempt 的终身上限。

### 控制与恢复

- `pause`：先持久化 `desiredState: "paused"`，停止启动新节点，等待已运行节点收尾后形成 `paused` 投影。
- `resume`：持久化 `running` 意图并重新监督未完成证据；已经 `accepted` 的节点不会重做。
- `stop`：持久化 `stopped` 意图，要求活跃 child 停止，并把未开始节点安全终止。
- `wait`：只观察 graph；事件更新优先、durable status 轮询兜底。取消 `wait` 不写 control intent，也不停止 graph。
- Pi session shutdown：对本 session 正在监督的图先提交 pause，而不是把它们伪装成失败。
- session start：扫描非终态 V3 run；持久意图允许时恢复，暂停意图保持不动。

如果 stop 或 timeout 后无法确认 child 已终止，节点进入 `needs_attention`。`prepared` dispatch intent 可安全发出一次；如果 RPC 已到达 `emitting` 边界但 exact child binding 尚未持久化，节点同样进入 `needs_attention`。当前 `pi-subagents` 状态不保存可供跨进程反查的外层 request ID，因此系统不会假装找回，也不会盲目派发第二个 child。

## 公开操作面

`graph` 工具只提供以下 15 个 action：

```text
start  wait  load  status  list  doctor  pause  resume  stop
templates  agents  retry  append  cancel  seal
```

`start` 必须在 admission 后立即返回。Pi 的工具更新回调只在一次工具执行尚未结束时有效；返回后的 `start` 卡通过 renderer invalidation 跟随 session-local live projection，DAG widget 通过原生 UI projection 更新。显式 `wait` 用于让当前调用阻塞到稳定状态，并在 `queued/running/stopping` 时继续，在 `complete/failed/stopped/paused/idle/waiting_input/needs_attention` 时返回。用户中止 `wait` 只释放观察订阅，Graph 继续运行；停止 Graph 必须显式调用 `stop`。

不存在 `assess`、`plan`、`review`、`route`、`recommend`、`gate` 或任何模型管理 action。

输入来源有三种，并且每次 `start`/源 `load` 必须恰选一种：

1. 内联 `spec`；
2. 从当前工作目录解析的 `.graph.json` capsule 路径；
3. 内置模板及 `overrides`。

内置模板：

| 模板 | 拓扑 | 执行约束 |
| --- | --- | --- |
| `research-report` | research → verify → draft | `readOnly`; `read` + 只读研究工具 |
| `code-review` | scout → review → synthesize | `readOnly`; 文件读取工具 |
| `doc-write` | outline → write → review | 文档写节点带 file scope 与存在性验证 |

## 成功标准

一次 V3 重写只有同时满足以下条件，才算产品完成：

- 新 Graph 只经过 V3 compiler、host、runner 和证据层；不存在第二条旧执行路径。
- GraphSpec V3 的拒绝规则、OPEN/SEALED、when、控制和 retry 在真实入口可用。
- `local_write` 未通过验证或遇到 source baseline 冲突时，源工作区不被错误覆盖。
- 崩溃后能从 durable intent 和 Attempt 证据继续；不能确定时 fail closed 到 `needs_attention`。
- timeout/stop 必须确认 child 终止，不能确认时不宣布安全停止。
- tarball 只包含 V3 源码、两个扩展入口、内置临时 Agent、模板和 README，不携带旧内核或治理实现。
- capability authoring 在进入 Core 前被解析为 exact Agent；恢复只读取冻结证据，不重新查询动态目录。
- Pi 界面能区分 requested/resolved/actual 模型，并显示 child session、usage 与实时工具进度。
- `start` 快速返回后，其已完成工具卡仍能通过 renderer invalidation 跟随实时投影；`wait` 能在独立工具卡中阻塞观察。快速终态、取消观察和 session cleanup 都不会遗留 watcher 或误停 Graph。
- 父 Pi Agent 每轮可收到固定的 `PI-GRAPH Routing` 工具选择建议；如果没有实际调用 `graph`，pi-graph 不生成计划、不启动运行，也不接管普通 subagent。

## 明示限制

- 单机、单文件系统运行；不是分布式工作流服务。
- Guard 是 Pi 工具层控制，不是 OS 沙箱；同一 OS 用户下的恶意进程不在保证范围内。
- `workspace` 当前只允许 `shadow`；V3 不宣称提供 git worktree 或其他 workspace 模式。
- 外部写工具不在 V3 副作用合同内。被 `toolFilter` 允许的非文件工具仍必须被 Guard 识别为只读，否则 fail closed。
- GraphSpec 和验证命令是无人值守执行输入，必须来自受信调用方。
- capability catalog 是 Pi 安装/项目合同，不是 DAG Core 配置；非 fixed 的 `modelPolicy` 与 `routingProfile` 不会被 pi-graph 自行求值。


运行时适配：Graph 兼容未修改的 pi-subagents 0.67.x，通过公开 RPC、完成通知、结果回放与进程退出证明接入；在 Graph Attempt 目录保存完整结果和退出证明，二者齐全后才进入验收。Graph 不覆盖上游执行时限，原版单子任务默认 30 分钟。公开证据不足时保留待核对状态，不自动重跑，不安装补丁。详见 README「原版 pi-subagents 适配与结果恢复」。
