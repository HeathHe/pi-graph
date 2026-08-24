# pi-graph

`pi-graph` 是 Pi 生态中的单机、持久化 DAG 执行器。调用方提交一份 `GraphSpec V3`，执行器负责编译有向无环图、按依赖并发运行 `pi-subagents` 节点、验证本地写入，并把恢复所需证据持久化到磁盘。

运行时要求 `pi-subagents ^0.49.0`；V3 使用该兼容线公开的 preflight、background-work 与 RPC 持久身份合同。

当前生产入口只有一套 V3 内核：

```text
graph start → compileGraphSpecV3 → V3GraphRunner → verify/apply → durable evidence
```

它不评估任务、不替调用方拆解目标、不复核计划、不选择或降级模型，也不要求 visual evidence。`model`、`routing`、`planning` 等字段会在编译期被拒绝。

产品边界见 [docs/product-definition.md](docs/product-definition.md)，完整字段与恢复语义见 [docs/v3-technical-contract.md](docs/v3-technical-contract.md)，实现分层见 [docs/graph-architecture.md](docs/graph-architecture.md)。

## 核心能力

- 编译 `GraphSpec V3`，检查未知依赖、依赖环、产物关系、路径与并行读写冲突。
- 固定 DAG 默认使用 `mode: "sealed"`；`mode: "open"` 支持 `append`、`cancel`、`seal` 和 revision CAS（比较并交换）。
- `when: { node, status: "accepted" | "failed" }` 提供最小条件分支；条件不匹配的节点直接投影为 `skipped`，不创建子 Agent。
- 每个节点在独立 shadow workspace 中运行；同图 `local_write` Attempt 由 FIFO 写锁串行，必须通过确定性 `validationCommands`，之后才原子回写源工作区。
- `pause`、`resume`、`stop` 写入持久化 `control.json`；Pi 会话关闭时活跃图先进入可恢复的暂停意图。
- Supervisor lease、单调 generation fence、稳定 dispatch request ID 和完整 Attempt 证据共同支持崩溃恢复。
- 自动重试与显式 `retry` 都保留历史；每个节点整个生命周期最多 100 个 Attempt。
- 上游输出通过有界、具名、标注为不可信数据的 dependency capsule 交给直接下游；产物同时保留逐 Attempt 历史和 latest 别名。
- `.graph.json` capsule 支持 `string`、`number`、`boolean` 类型输入；内置 `research-report`、`code-review`、`doc-write` 三个模板。
- 图级 `readOnly` 和精确 `toolFilter` 由子 Agent Guard 执行；子 Agent 的 `bash` 始终禁用。

## 最小示例

下面的图先生成文档，再读取结果做复核。`document-writer` 和 `code-reviewer` 必须是项目 `.pi/agents` 中可用的 Agent 名称。

```json
{
  "action": "start",
  "spec": {
    "schemaVersion": 3,
    "graphId": "write-guide",
    "goal": "生成并复核使用指南",
    "nodes": [
      {
        "taskId": "write",
        "agent": "document-writer",
        "task": "把使用指南写入 docs/guide.md。",
        "sideEffect": "local_write",
        "writeScope": [{ "kind": "file", "path": "docs/guide.md" }],
        "validationCommands": ["test -s docs/guide.md"],
        "timeoutMs": 600000
      },
      {
        "taskId": "review",
        "agent": "code-reviewer",
        "task": "复核 docs/guide.md 的完整性并给出结论，不修改文件。",
        "dependsOn": ["write"],
        "sideEffect": "local_read",
        "readScope": [{ "kind": "file", "path": "docs/guide.md" }],
        "timeoutMs": 300000
      }
    ]
  }
}
```

`start` 接受后异步执行并返回 `graphId` 与初始快照。随后可调用：

```json
{ "action": "status", "id": "write-guide" }
```

## 动态图

OPEN 图可以从空拓扑开始。每次变更都必须提交调用方刚读取到的 `revision`；过期 revision 会返回冲突，不会覆盖别人的变更。

```json
{
  "action": "start",
  "spec": {
    "schemaVersion": 3,
    "graphId": "release-check",
    "goal": "动态追加发布检查",
    "mode": "open",
    "nodes": []
  }
}
```

```json
{
  "action": "append",
  "id": "release-check",
  "revision": 0,
  "nodes": [
    {
      "taskId": "review",
      "agent": "code-reviewer",
      "task": "检查当前发布内容并返回结论。",
      "sideEffect": "local_read",
      "readScope": [{ "kind": "tree", "path": "." }]
    }
  ]
}
```

```json
{ "action": "seal", "id": "release-check", "revision": 1 }
```

OPEN 图暂时没有可执行节点时是 `idle`，仍可继续追加；只有 SEALED 图才计算最终的 `complete` 或 `failed`。`seal` 不等于 `stop`，`stop` 也不会自动封存拓扑。

## GraphSpec V3 摘要

顶层字段：

| 字段 | 语义 |
| --- | --- |
| `schemaVersion` | 必须为 `3` |
| `graphId` | 可选；省略时由源 GraphSpec digest 确定性生成 |
| `goal` | 必填，1..2000 字符 |
| `nodes` | SEALED 图 1..512 个；OPEN 图可为空 |
| `mode` | `sealed`（默认）或 `open` |
| `maxConcurrency` | 1..6，默认 2 |
| `failFast` | 默认 `false` |
| `workspace` | 只能是 `shadow`，默认 `shadow` |
| `readOnly` | 禁止 `local_write`，并让 Guard 拒绝写工具 |
| `toolFilter` | 图级精确工具 allow-list |

节点必填 `taskId`、`agent`、`task`、`sideEffect`。`taskId` 仅允许小写 ASCII 字母、数字和连字符，最长 200 个字符。常用可选字段包括 `dependsOn`、`when`、`inputArtifacts`、`outputArtifact`、`readScope`、`writeScope`、`timeoutMs`、`retryPolicy`、`acceptance` 和 `validationCommands`。

关键规则：

- `sideEffect` 只允许 `none`、`local_read`、`local_write`；不允许外部写副作用。
- `local_write` 必须同时声明非空 `writeScope` 与非空 `validationCommands`。
- `timeoutMs` 是整个 Attempt 的墙钟截止时间，覆盖工作区准备、派发、子 Agent、验证、apply 和产物发布；恢复不会重置它。
- `retryPolicy.maxAttempts` 范围是 1..5；允许的 `retryOn` 为 `task_failed`、`validation`、`timeout`、`workspace_conflict`。
- 自然语言 `acceptance` 只是记录；非写节点在 child 正常完成后使用 `declared` 验收，写节点只有机器验证并成功 apply 后才使用 `machine-verified`。

## `graph` 工具

公开 action 精确为 14 个：

| Action | 用途 |
| --- | --- |
| `start` | 从内联 spec、capsule 或模板创建并异步启动图 |
| `load` | 只编译输入，或现场加载既有 V3 run；不创建新执行 |
| `status` | 读取一次可重建状态投影 |
| `list` | 列出持久化的 V3 runs |
| `doctor` | 报告陈旧 lease、孤儿 workspace、无效 run 和 `needs_attention` |
| `pause` | 持久化暂停意图并等待当前 Supervisor 静止 |
| `resume` | 恢复暂停或崩溃中断的 run |
| `stop` | 持久化停止意图，停止 child，并等待停止结果 |
| `templates` | 列出三个内置 capsule 模板 |
| `agents` | 只列出 `.pi/agents` 的公开名称、描述和别名 |
| `retry` | 重跑一个终态节点及其未取消下游，保留原 Attempt |
| `append` | 向 OPEN 图追加 1..64 个不可变新节点 |
| `cancel` | 在 OPEN 图中 tombstone 尚可取消的节点；可级联下游 |
| `seal` | 永久封存 OPEN 拓扑 |

`/graphs` 命令提供 `doctor`、`list`、`status`、`pause`、`resume`、`stop`，用于人工运维。

## Capsule 与模板

`graph start` 和 `graph load` 必须在 `spec`、`capsule`、`template` 三种来源中恰选一种。`.graph.json` capsule 的结构为：

```text
manifest + source.spec + intent + inputs + requires + provenance?
```

`requires.readOnly` 与 `requires.toolFilter` 不是展示信息：解析后会写入最终 GraphSpec，再经过同一个 V3 编译器。模板也走完全相同的 capsule 编译路径。

示例：

```json
{
  "action": "start",
  "template": "code-review",
  "overrides": {
    "target": "src/v3",
    "focus": "崩溃恢复与并发一致性"
  }
}
```

## 配置

V3 只读取三个配置项；其他历史 `graph` 配置即使仍在 `settings.json` 中，也不会进入执行决策。

```json
{
  "graph": {
    "enabled": true,
    "runsDir": "/absolute/path/to/graph-runs",
    "rpcTimeoutMs": 10000
  }
}
```

- `enabled` 默认 `true`。
- `runsDir` 默认是 Pi agent 目录下的 `graph-runs`。
- `rpcTimeoutMs` 默认 10000，最大 300000。

## 持久化与恢复

每个 run 目录包含不可变 admission、可重建快照、持久控制意图、Supervisor fence、拓扑/重试 journal、节点 Attempt 证据和版本化产物。`snapshot.json` 不是唯一权威；恢复会重新编译 admission、重放 journal，并读取 Attempt 证据。

派发先持久化稳定 request ID 与 request digest。进程若在 RPC emit 边界附近崩溃，恢复流程只查找同一次派发；不能确认身份时进入 `needs_attention`，不会盲目创建重复 child。timeout 或 stop 后若无法确认 child 已终止，同样进入 `needs_attention`。

## 信任边界

Graph Guard 是 Pi 工具层护栏，不是操作系统沙箱。它约束已知文件工具、图级 `toolFilter`、只读远程工具和保护目录；`bash` 始终禁用。Supervisor 自己会执行 GraphSpec 中的确定性验证命令，因此 GraphSpec 与项目仓库仍应被视为受信输入。

## 与 dsh-graph 的关系

V3 的核心架构参考了 `dsh-graph`：编译 DAG、ACCEPTED 解锁、OPEN/SEALED、revision CAS、条件节点、Attempt 历史、dependency capsule、版本化产物和 capsule 模板。Pi 版本不是源码移植：它使用 `pi-subagents` RPC、shadow workspace、Authorization/Attempt 多文件证据和跨进程 Supervisor fencing；准确差异见技术合同的“dsh-graph 对齐矩阵”。

## 开发验证

```bash
npm run check
npm test
npm run pack:check
```

Node.js 要求 `>=22.19.0`。发布清单只包含 `extensions/`、`src/v3/`、`templates/` 和 `README.md`。
