# pi-graph 产品定义：纯 DAG V3

> 状态：当前产品合同。本文描述已经投入生产入口的 V3，而不是迁移计划或双内核过渡方案。字段、持久化格式和错误语义以 [v3-technical-contract.md](v3-technical-contract.md) 为准。

## 一句话定义

**pi-graph 是 Pi 生态中的单机持久化 DAG 执行器：调用方显式提交 GraphSpec V3，它负责编译拓扑、调度 `pi-subagents`、隔离与验证本地写入、持久化 Attempt 证据，并在证据充分时恢复执行。**

调用方决定为什么使用图、图里有哪些节点、每个节点使用哪个 Agent。pi-graph 只执行已经给定的图。

## 产品边界

| 负责 | 不负责 |
| --- | --- |
| 严格编译 GraphSpec V3 | 判断任务是否值得使用 Graph |
| 拓扑排序、环检测、依赖与产物检查 | 自动拆解目标或生成计划 |
| 按依赖和并发上限调度节点 | 计划审核、任务风险分级或准入门 |
| OPEN/SEALED 动态拓扑 | 模型选择、模型路由、降级或 provider 策略 |
| `when accepted|failed` 条件分支 | 要求截图、视觉证据或视觉审核 |
| shadow workspace、Guard、验证与原子 apply | OS 级安全沙箱或远程执行平台 |
| Attempt、journal、lease 与恢复 | 跨机器分布式调度或 exactly-once 承诺 |
| pause/resume/stop/retry 运维 | 普通 Pi turn 的旁路观察或自动介入 |

V3 没有治理层、规划门、routing policy、model registry、visual evidence 管线或 legacy 执行内核。相关字段不是“被忽略”，而是由编译器递归拒绝，避免它们重新进入执行合同。

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

每个节点精确引用一个项目 Agent，通过 `pi-subagents` 公共 RPC 异步执行。Agent 定义在 admission 时冻结，pending 节点不会因为磁盘中的 Agent 文件后来变化而偷偷换角色。`agents` action 只暴露名称、描述与别名，不泄露模型或内部路由配置。

## 核心产品语义

### Graph 与节点

- Graph 最多 512 个节点；一次 `append` 最多 64 个。
- 图并发范围为 1..6，默认 2；节点完成后立即解锁自己的下游，没有整批 barrier。
- 节点 `sideEffect` 只允许 `none`、`local_read`、`local_write`。
- `local_write` 必须有明确 `writeScope` 和至少一条确定性 `validationCommands`。
- 编译器拒绝无依赖顺序却发生读写/写写 scope 重叠的节点；调用方可以用显式依赖建立合法顺序。
- `readOnly: true` 的图不能包含 `local_write`；Guard 同时拒绝写工具。
- `toolFilter` 是精确图级 allow-list，而不是 Agent 或模型选择器。

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
- Pi session shutdown：对本 session 正在监督的图先提交 pause，而不是把它们伪装成失败。
- session start：扫描非终态 V3 run；持久意图允许时恢复，暂停意图保持不动。

如果 stop 或 timeout 后无法确认 child 已终止，节点进入 `needs_attention`。如果 RPC emit 边界之后无法找回同一 stable request ID 对应的 child，也进入 `needs_attention`；系统不会盲目派发第二个 child。

## 公开操作面

`graph` 工具只提供以下 14 个 action：

```text
start  load  status  list  doctor  pause  resume  stop
templates  agents  retry  append  cancel  seal
```

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
- tarball 只包含 V3 源码、两个扩展入口、模板和 README，不携带旧内核或治理实现。
- 普通 Pi 会话如果没有调用 `graph`，pi-graph 不评估、规划或路由用户任务。

## 明示限制

- 单机、单文件系统运行；不是分布式工作流服务。
- Guard 是 Pi 工具层控制，不是 OS 沙箱；同一 OS 用户下的恶意进程不在保证范围内。
- `workspace` 当前只允许 `shadow`；V3 不宣称提供 git worktree 或其他 workspace 模式。
- 外部写工具不在 V3 副作用合同内。被 `toolFilter` 允许的非文件工具仍必须被 Guard 识别为只读，否则 fail closed。
- GraphSpec 和验证命令是无人值守执行输入，必须来自受信调用方。
