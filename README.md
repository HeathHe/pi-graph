# pi-graph

`pi-graph` 是 Pi 生态中的单机、持久化 DAG 执行器。调用方提交一份 `GraphSpec V3`，执行器负责编译有向无环图、按依赖并发运行自有 SDK 子 Agent 节点、验证本地写入，并把恢复所需证据持久化到磁盘。

模型与岗位配置文件是一等入口：直接编辑项目 `.pi/graph-models.json`、全局 `~/.pi/agent/graph-models.json` 和相应 `agents/<name>.md`。可复制 [JSON 配置](examples/graph-models.example.json) 与 [岗位 Markdown](examples/agents/custom-worker.md)；完整字段说明及优先级见 [独立模型与岗位设置](docs/owned-model-settings.md)；`/graph-models` 是同一配置格式的交互入口。配置只影响新 Graph，已有 Graph 保留冻结模型、工具、提示词及模型定义。

运行层由本项目直接管理当前安装的宿主 Pi SDK：自有 RPC、独立 OS worker、guardian 退出监管、状态/结果证据与持久邮箱。无需 `pi-subagents` 或 `pi-intercom`，未安装或依赖 Maestro。启动前检查必要 SDK API 和 session 生命周期能力；缺少能力时明确拒绝，不能用扩展开发依赖中的另一版本代替。

当前生产入口由三个边界清楚的层组成；中间仍只有一套 V3 DAG 内核：

```text
Pi Binding / Admission
  capabilityId / requires / exact agent / model + budget hints
                         ↓ 解析、preflight、固定 admission 证据
Resolved GraphSpec V3 → compileGraphSpecV3 → V3GraphRunner → verify/apply → durable evidence
                                                                    ↓
Pi Observability / TUI
  actual agent/model · child session · usage · current tool · live DAG
```

扩展入口先读取 `routing-policy.json`，用能力目录中的 `routingProfile` 按候选顺序调用自有 Agent/model preflight，选出本次 authoring 的 `model` / `thinking`；显式 model 与策略冲突时 fail closed。Binding 随后从 `subagent-capabilities.json` 把能力 ID **精确映射为一个 Agent**，再把不可变证据交给 Core。候选选择只发生在扩展 Admission adapter，DAG Core 不读取可变模型注册表或重新选择策略；运行时只在完整证据满足时推进已冻结的替补候选；`routing`、`routingProfile`、`planning` 等字段仍不得写入公开 GraphSpec。

它不替调用方拆解目标、不复核计划，也不要求 visual evidence。Pi 扩展会在每个父 Agent turn 前注入一段固定、幂等的 `PI-GRAPH Routing` 合同，要求实际子 Agent 委派统一使用 `graph`：单项工作使用单节点，fan-out/fan-in、依赖链、实现加独立测试/审查使用相应多节点结构；同一份合同也直接用于 `graph` 工具描述，避免两处漂移。这仍只是 prompt guidance，不会自行启动 Graph，也不会把已启动的普通 subagent 自动转换为节点。没有实际调用 `graph` 时，DAG Core 不会介入。`/graphs doctor` 和 `graph doctor` 会显示合同版本、SHA-256 及最近一次注入判断，但不保存 system prompt 或用户内容。

产品边界见 [docs/product-definition.md](docs/product-definition.md)，完整字段与恢复语义见 [docs/v3-technical-contract.md](docs/v3-technical-contract.md)，实现分层见 [docs/graph-architecture.md](docs/graph-architecture.md)。

## 安装与运行要求

0.2.0 是自有运行时迁移版本；本说明属于发布准备，不表示 npm 已发布或本轮完整检查已通过。检查与发布边界见 [npm 发布流程](docs/npm-release.md)，变更见 [CHANGELOG](CHANGELOG.md)。

要求 Node.js `>=22.19.0` 和已安装的 Pi。运行使用宿主提供的 Pi SDK，启动时核验必要 API 与会话生命周期；开发依赖固定为 `1.0.4`，不是要求宿主必须使用这一精确版本。缺少必要能力时拒绝启动，不偷偷切换另一个 SDK。

**正式发布且核实 registry 版本后**，在终端执行：

```bash
pi install npm:pi-graph@0.2.0
```

默认安装会记录到 Pi 的用户配置。新会话加载扩展后应能看到 `graph` 工具及 `/graphs`、`/graph-models` 命令。已有会话先等待任务结束，再重新启动 Pi；不要在活跃 Graph 中替换运行时代码。

发布前可在隔离目录用 `npm install /absolute/path/pi-graph-0.2.0.tgz` 检查真实包，再使用独立空 Pi 配置目录临时加载：

```bash
release_agent_dir="$(mktemp -d)"
PI_CODING_AGENT_DIR="$release_agent_dir" pi -e /absolute/path/to/node_modules/pi-graph
```

`-e` 不写入安装声明，隔离变量避免复用现有 Pi 配置；不修改 `HOME`。只检查扩展加载，不输入真实模型任务或登录模型服务。`.tgz` 是 npm 包归档，不能直接当作 Pi 的单扩展文件加载。完整命令和本人 npm 登录步骤见发布流程。

不需要安装 `pi-subagents`、`pi-intercom` 或 Maestro；已有重复扩展应先核对安装来源，在无活跃任务时由用户移除，不能直接删除历史运行数据。shell 保护依赖 macOS `sandbox-exec`；其他系统或该命令不可用时，运行器拒绝未受保护的 shell。只读与其他工具仍须通过各自启动前检查，这不承诺其他平台完整功能可用，也不构成外部服务或同一 OS 用户的完整安全隔离。

## 核心能力

- 编译 `GraphSpec V3`，检查未知依赖、依赖环、产物关系、路径与并行读写冲突。
- authoring spec 可用 `capabilityId` 或 `requires` 从共享能力目录选择 exact Agent；多个能力必须全部指向同一个 Agent，选择结果与 Agent 定义在 admission 时冻结。
- 节点可声明 `model`、`thinking`、`turnBudget`、`toolBudget`、`usageBudget` 与 `maxTokens`。Core 只读取解析后的 `launch` 证据，不读取能力目录。
- 固定 DAG 默认使用 `mode: "sealed"`；`mode: "open"` 支持 `append`、`cancel`、`seal` 和 revision CAS（比较并交换）。
- `when: { node, status: "accepted" | "failed" }` 提供最小条件分支；条件不匹配的节点直接投影为 `skipped`，不创建子 Agent。
- 每个节点在独立 shadow workspace 中运行；同图 `local_write` Attempt 由 FIFO 写锁串行，必须通过确定性 `validationCommands`，之后才原子回写源工作区。
- `pause`、`resume`、`stop` 写入持久化 `control.json`；Pi 会话关闭时活跃图先进入可恢复的暂停意图。
- Supervisor lease、单调 generation fence、稳定 dispatch request ID 和完整 Attempt 证据共同支持崩溃恢复。
- 自动重试与显式 `retry` 都保留历史；每个节点整个生命周期最多 100 个 Attempt。
- 上游输出通过有界、具名、标注为不可信数据的 dependency capsule 交给直接下游；产物同时保留逐 Attempt 历史和 latest 别名。
- `.graph.json` capsule 支持 `string`、`number`、`boolean` 类型输入；内置 `research-report`、`code-review`、`doc-write` 三个模板。
- 新图默认 `inherited`，可信父工具上界传给自有 child launch 与 Guard；图级或节点 `readOnly`、非空 `toolFilter`、Agent 显式工具限制继续生效。旧任务缺少权限字段时仍为 strict。
- Pi 工具卡和会话 widget 实时展示 DAG 进度、requested/resolved/actual Agent 与模型、child run/session、token/cost/turn usage，以及当前工具和路径。除已上报 token/cost 用于后续 Attempt 的 usage-budget 核算外，这些投影不参与验收或恢复决策。
- `start` 保持快速异步返回；它的工具卡和会话 widget 会继续跟随后台状态。需要让当前调用阻塞到图进入稳定状态并取得最终结果时，使用 `wait`。取消 `wait` 只停止观察，不会停止 Graph。

## 最小示例

下面的图先生成文档，再读取结果做复核。`contractPolicy: "strict"` 表示两个 capability 必须在共享目录中完整匹配；目录决定 exact Agent，图本身不硬编码 Agent 名称。

```json
{
  "action": "start",
  "spec": {
    "schemaVersion": 3,
    "graphId": "write-guide",
    "goal": "生成并复核使用指南",
    "contractPolicy": "strict",
    "nodes": [
      {
        "taskId": "write",
        "capabilityId": "write.document",
        "task": "把使用指南写入 docs/guide.md。",
        "sideEffect": "local_write",
        "writeScope": [{ "kind": "file", "path": "docs/guide.md" }],
        "validationCommands": ["test -s docs/guide.md"],
        "thinking": "high",
        "turnBudget": { "maxTurns": 8, "graceTurns": 1 },
        "usageBudget": { "tokens": { "soft": 12000, "hard": 16000 } }
      },
      {
        "taskId": "review",
        "capabilityId": "edit.document",
        "task": "复核 docs/guide.md 的完整性并给出结论，不修改文件。",
        "dependsOn": ["write"],
        "sideEffect": "local_read",
        "readScope": [{ "kind": "file", "path": "docs/guide.md" }]
      }
    ]
  }
}
```

`start` 接受后异步执行并返回 `graphId` 与初始快照。只读取一次状态可调用：

```json
{ "action": "status", "id": "write-guide" }
```

`start` 返回后的工具卡和 DAG widget 会继续实时更新。若调用方还需要阻塞等待，直到图到达 `complete`、`failed`、`stopped`、`paused`、`idle`、`waiting_input` 或 `needs_attention`，可调用：

```json
{ "action": "wait", "id": "write-guide" }
```

中止这次工具调用只会停止 watching；Graph 继续在后台运行。真正停止执行必须显式调用 `stop`。

## 动态图

OPEN 图可以从空拓扑开始。每次变更都必须提交调用方刚读取到的 `revision`；过期 revision 会返回冲突，不会覆盖别人的变更。

```json
{
  "action": "start",
  "spec": {
    "schemaVersion": 3,
    "graphId": "release-check",
    "goal": "动态追加发布检查",
    "contractPolicy": "strict",
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
      "capabilityId": "review.code",
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
| `readOnly` | 图或节点只读：禁止 local_write/external_write、任意 shell 和未证明只读的外部工具 |
| `toolFilter` | 图级精确工具 allow-list |
| `contractPolicy` | authoring-only：`standard`（默认）或 `strict`；strict 要求每个节点完整匹配 capability catalog |

节点必填 `taskId`、`task`、`sideEffect`，并通过 `agent`、`capabilityId` 或 `requires` 指定执行角色；strict 合同必须使用 capability。`requires` 是 capability ID 数组，不是工具或 npm 依赖。`taskId` 仅允许小写 ASCII 字母、数字和连字符，最长 200 个字符。常用可选字段包括 `dependsOn`、`when`、`inputArtifacts`、`outputArtifact`、`readScope`、`writeScope`、`retryPolicy`、`acceptance`、`validationCommands` 及 launch hints。

关键规则：

- 新图 `sideEffect` 允许 `none`、`local_read`、`local_write`、`external_read`、`external_write`；旧 strict 图仍只允许前三种。
- `local_write` 必须同时声明非空 `writeScope` 与非空 `validationCommands`。
- 新 Graph 不接受 `timeoutMs`：节点、Attempt、子 Agent 和验证均无执行时长上限。历史截止时间只保留用于审计；恢复旧任务必须先核对，不能自动重派。
- `retryPolicy` 保留历史读写兼容；自动恢复由下方安全规则统一决定，最多一次，不因 `maxAttempts` 或 `retryOn` 放宽。`backoffMs` 只决定确认可恢复后等待多久。
- 自然语言 `acceptance` 只是记录；非写节点在 child 正常完成后使用 `declared` 验收，只有 `local_write` 节点在机器验证并成功 apply 后才使用 `machine-verified`；external 节点始终为 `declared`/`verified=false`。

### Agent Binding 与 launch hints

- `capabilityId: "review.code"` 表示一个能力；`requires: ["review.code", "review.spec"]` 要求这些能力在当前目录中都映射到同一个 Agent，否则 admission 失败。
- 同时声明 `agent` 和 capability 时，两者必须精确一致；未知的显式 Agent 永远不会降级为临时 Agent。
- `contractPolicy: "strict"` 要求完整 catalog match，并且即使开启临时 Agent 也不会 fallback。
- `model` 是调用方请求值；fixed `modelPolicy.model` 或 自有 preflight 形成 resolved 值；child lifecycle 报告的才是 actual 值。三者分别持久化和展示，不能互相冒充。
- Provider 隔离有两道边界：Binding 会拒绝父 Pi 已知的 extension Provider primary/fallback；child Graph Guard 会在可取消的 `input` 边界拒绝 Agent 扩展注册或覆盖的当前 Provider。普通 `models.json` / built-in Provider，以及只注册自定义工具的 Agent 扩展继续可用。
- `turnBudget` 与 `toolBudget` 由自有 child SDK 生命周期执行。`usageBudget` 是每个节点跨全部 Attempt 共享的累计预算；重试只获得扣除历史已上报 usage 后的剩余额度。历史派发缺少所配置的 usage 证据时，下次 dispatch 前拒绝；自有 child 同时在后续 provider 请求与工具边界检查冻结预算，超过 hard 上限拒绝继续执行。`maxTokens` 是独立的单次 provider 请求输出上限，由 child Graph Guard 在 `before_provider_request` 边界按原生 payload 字段收紧；最小值为 16，未知 payload 形状会 fail closed。
- 能力目录中的 `routingProfile` 由扩展侧 Admission adapter 读取；它按 `routing-policy.json` 的候选顺序选择首个通过自有 preflight 的模型。选择结果会变成普通 `model` / `thinking` authoring hints，再由现有 Binding 冻结；恢复只读冻结证据，不重读策略。
- 一次 Admission 只捕获一份 policy 与 capability catalog。Routing 和 Binding 复用同一份 catalog 对象，并核对 catalog digest、exact Agent 与 requested model；调用期间磁盘文件变化只影响下一次 Admission。
- 要求跨家族的节点必须取得每个直接 producer 的可信身份。同批 fixed Agent 使用自有 preflight 的 resolved model；动态 `append` 只接受已验证的 accepted Attempt 中的 actual model 或已冻结的 resolved model。身份缺失或证据冲突会 fail closed，requested/selected model 不会冒充 runtime actual。
- 单节点任务也通过 Graph 派发，以取得同样的路由、权限、shadow workspace 与持久结果；本版本不提供旧组件的 direct subagent 入口。
- Jev shadow 只调用现有 WisdomRouter `/v1/systemone`，请求模型固定写成动态别名 `jev-latest`，并记录响应返回的 actual model。它只观测 `fast/deep/research/review/human` 闭集分类及置信度，不改变正式路由；凭据只从环境或既有 `models.json` 读取，不写入策略、源码或结果。

Admission 持久化的 `admissionLaunchContractDigest` 只证明当时可知的 source Agent、authoring task 和 preflight hints。真正 dispatch 还会加入 Graph Guard、dependency capsule 和 shadow workspace 信息；child lifecycle 报告的 `launchContractDigest` 是独立的运行时证据，不要求两者相等。

## `graph` 工具

主要公开 action：

| Action | 用途 |
| --- | --- |
| `start` | 从内联 spec、capsule 或模板创建并异步启动图 |
| `wait` | 持续投影实时状态到当前工具卡；图到达稳定边界时返回，取消观察不停止图 |
| `load` | 只编译输入，或现场加载既有 V3 run；不创建新执行 |
| `status` | 读取一次可重建状态投影 |
| `list` | 列出持久化的 V3 runs |
| `doctor` | 报告陈旧 lease、孤儿 workspace、无效 run 和 `needs_attention` |
| `pause` | 持久化暂停意图并等待当前 Supervisor 静止 |
| `resume` | 恢复暂停或崩溃中断的 run |
| `stop` | 持久化停止意图，停止 child，并等待停止结果 |
| `templates` | 列出三个内置 capsule 模板 |
| `agents` | 列出共享 `capabilityId → Agent` 映射，以及 `.pi/agents` 的项目 Agent；不暴露 model/routing policy 元数据 |
| `retry` | 重跑一个终态节点及其未取消下游，保留原 Attempt |
| `append` | 向 OPEN 图追加 1..64 个不可变新节点 |
| `cancel` | 在 OPEN 图中 tombstone 尚可取消的节点；可级联下游 |
| `seal` | 永久封存 OPEN 拓扑 |
| `result` | 按 attempt、摘要与分页读取已保存结果 |
| `usage` | 读取实际观测的用量 |
| `attention` | 读取当前待处理请求与异常 |
| `mailbox` | 在当前授权邮箱中收发、回复和确认消息 |

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

### 模板 API 迁移

内置模板现在明确分成两步：

- 同步 `resolveBuiltinGraphTemplateV3` / `resolveBuiltinGraphTemplateCapsuleV3` 只替换 placeholder，返回仍含 capability 的 authoring spec；它不能直接交给纯 Core 编译器。
- 生产执行必须 `await bindBuiltinGraphTemplateV3` 或 `bindBuiltinGraphTemplateCapsuleV3`，先完成 capability admission，再获得 exact-Agent GraphSpec。

旧的 `loadBuiltinGraphTemplateV3` / `loadBuiltinGraphTemplateCapsuleV3` 名称已删除，避免用同一个名称暗中改变返回语义。

## 配置

V3 的 `settings.json.graph` 执行选项只读取以下四项；其他历史 `graph` 字段不会进入执行决策。独立模型与岗位配置另由 `graph-models.json` 和岗位 Markdown 提供，见前文配置入口。

```json
{
  "graph": {
    "enabled": true,
    "runsDir": "/absolute/path/to/graph-runs",
    "rpcTimeoutMs": 10000,
    "allowTemporaryAgent": false
  }
}
```

- `enabled` 默认 `true`。
- `runsDir` 默认是 Pi agent 目录下的 `graph-runs`。
- `rpcTimeoutMs` 默认 10000，最大 300000。
- `allowTemporaryAgent` 默认 `false`。只有显式设为 `true`、合同不是 strict、没有 exact capability match 且节点未指定 `agent` 时，才允许使用包内置的 `pi-graph.graph-worker`；这是一条可审计的 fallback，不是自动生成 Agent。

## 持久化与恢复

Pi 启动、重载或切换会话时，只自动检查并恢复原始会话 ID 与当前会话一致的 Graph；同目录新会话和分叉会话不会自动接管旧 Graph 或显示其摘要。历史记录仍保留，可通过 `/graphs list`、`/graphs status <graph-id>` 查看，或用 `/graphs resume <graph-id>` 明确恢复；暂停意图仍需显式恢复。

每个 run 目录包含不可变 admission、可重建快照、持久控制意图、Supervisor fence、拓扑/重试 journal、节点 Attempt 证据和版本化产物。`snapshot.json` 不是唯一权威；恢复会重新编译 admission、重放 journal，并读取 Attempt 证据。

派发先持久化稳定 request ID 与 request digest。`prepared` intent 可在恢复时安全发出一次；进程若在 `emitting` 边界后、exact child binding 持久化前崩溃，恢复流程进入 `needs_attention`，不会盲目创建重复 child。自有 runtime 以 request digest 与 owner identity 校验持久 intent，同一身份可定位原 worker；不确定旧派发是否产生副作用时仍拒绝重放。stop 后若无法确认 child 已终止，同样进入 `needs_attention`。

## 信任边界

Graph Guard 是 Pi 工具层护栏。自有运行器另对已授权 shell 使用 macOS `sandbox-exec`，保护运行控制文件、配置和凭证路径；不是对所有外部副作用的完整隔离。其他平台或缺少 `sandbox-exec` 时拒绝不受保护的 shell。新图继承父会话实际工具上界，允许已授权 bash、跨工作目录读取与已装载的外部工具；不自动装载父 ambient/MCP 扩展，缺失工具必须如实报告。明确只读任务拒绝 bash、文件写和未证明只读的外部工具。非空 toolFilter 与 Agent 显式 tools 仍限制业务工具；graph_mailbox 由可信冻结流程单独授予控制面权限，不授予文件或 shell 能力。

`external_read` / `external_write` 使用 declared 验收（verified=false），不代表机器验证或可回滚。已发出的非只读 inherited 节点不得自动或通过 retry 闭包重放；先核对实际结果，再创建仅含剩余工作的图。

本机 Pi 原生 shell 与 Supervisor 以同一 OS 用户执行；inherited 验证支持 shell、mise、环境变量前缀及绝对命令路径，并要求当前父工具上界允许 bash。Supervisor spawn 不自动继承未来新增的工具审批扩展；该环境须通过审批扩展支持的执行入口适配。旧 strict 任务保持原命令约束。修改 Guard 后旧已冻结任务可能因摘要不符需要人工核对，不会静默提权。

Graph 子任务通信统一使用 `graph_mailbox`，旧 `contact_supervisor` / `subagent_supervisor` / intercom 通信在 Graph 内禁用；普通 Pi 非 Graph 任务不受影响。主线程通过 `graph({action:"mailbox",id:"图 ID",mailbox:{action:"reply",messageId:"消息 ID",text:"决定",idempotencyKey:"稳定回复键"}})` 回复决策请求。普通点对点消息不转述给主模型；工具不扩大文件或 shell 权限。

Graph 派发任务时在完整原任务之后追加来自 digest-bound shadow contract 的有界执行上下文，保留原任务首行和全部 task/capsule 字节：实际 shadow cwd、相对读写 scope、只读状态和路径限制。内联 task 就是 handoff，除非任务明确提供 scope 内的交接文件；child 不应猜测 `../task-handoff.md` / `code-context.md`、访问原始 source 或 `~` 路径，也不能在 scope 外列目录。路径以转义 JSON 数据呈现；过长或过多条目整体省略并标明数量，不用截短路径冒充权限。上下文只是现有 Guard 权限的说明，不改变其工具过滤和保护目录规则；原任务与 dependency capsule 的不可信数据标记保持原样。

## 与 dsh-graph 的关系

V3 的核心架构参考了 `dsh-graph`：编译 DAG、ACCEPTED 解锁、OPEN/SEALED、revision CAS、条件节点、Attempt 历史、dependency capsule、版本化产物和 capsule 模板。Pi 版本不是源码移植：它使用自有 `pi-graph:runtime:v1` RPC、shadow workspace、Authorization/Attempt 多文件证据和跨进程 Supervisor fencing；准确差异见技术合同的“dsh-graph 对齐矩阵”。

## 开发验证

```bash
npm run check
npm test
npm run pack:check
```

Node.js 要求 `>=22.19.0`，运行跟随当前安装的宿主 Pi SDK，按必要 API/生命周期能力验证兼容；开发测试依赖单独固定以便复现。发布包含自有 `src/runtime/`、V3 内核、扩展、角色与模板；配置文档随包交付。包内 `agents/graph-worker.md` 由本项目 discovery 读取。旧 native 补丁与备份不包含在发布包内，不是当前运行依赖或安装步骤。

验证使用实际 SDK、独立 worker 和固定本地模型响应，涵盖模型注册、配置冻结、结果、用量与物理退出证明；未进行真实供应商 API 或登录凭证的联网验收。

### 自有 SDK 运行与结果恢复

父会话通过 `pi-graph:runtime:v1:request/ready/reply` 调用自有 controller；完成通知为 `pi-graph:child-complete`。controller 固定 owner、request ID/digest 与运行身份，再启动 guardian 和独立 SDK child。重复派发只返回同一已保存身份，冲突请求拒绝，不另开任务。

guardian 观察真实 child 退出，生成与运行身份绑定的 `process-terminal.json`；child 保存 `intent.json`、`status.json`、`result.json` 与活动证据。Graph 把完整结果和退出证明存入自身 Attempt 目录，工作区清理后仍可读取。缺少最终结果、身份错配或退出证明不完整时，不冒充已验收。

“收到结果”“确认进程退出”“通过 Graph 验收”分别检查。仅有完成标签、日志尾部、PID 消失或重复通知都不能推进验收。结果与退出证明齐全后，继续已有工作区检查、机器验证与回写流程。

自有 runtime 不建立默认总任务计时器；RPC 握手、停止确认和网络或单次命令故障保护仍有独立边界。人工等待不通过反复 watcher/超时重启实现，缺少人工输入时交回父会话。状态观察不因静默时长自行杀任务，父 RPC 可回应也不代表模型有进展。

旧运行协议保留结果与只读历史，不自动转换或恢复为自有 worker。无法确认已有副作用时，先核对证据，再建立只包含剩余工作的图。runtime 故障后的接替仅按下文完整 pre-activity 证据执行，不能根据日志猜测“没有运行工具”。

### Pi 原生 CLI 任务面板

- 底部显示有界、可收起摘要：状态、分类计数、最多两条运行岗位及合并原因。工具 START 只显示“已提交”，WAIT 只显示“正在等待结果 / 等待已结束”；使用无背景色单行呈现，展开仍保留详细数据。
- `/graphs view` 选择一个 Graph；`/graphs view <graph-id>` 直接打开。↑↓ 或 j/k 选任务，Enter 查看详情，l 查看原始状态 JSON，PgUp/PgDn 翻页，Esc 返回，q 关闭。
- 查看面板只读，不会接管、重跑或停止任务。原始记录页展示当前持久状态和失败证据，不是完整会话日志。刷新失败时保留上次状态并明确提示。
- 成功、失败、未执行、运行、排队、停止、取消、跳过分别计数。只有停止请求及节点中止证据都存在时，才显示“已停止 · 含 N 项失败”。“控制探测有响应”只说明运行器可回应，不等于模型有进展。
- Graph 管理自有 child 的状态、摘要与详情，不再依赖 pi-subagents 的 Async/Fleet 展示行。
- 已有 Pi 会话待任务结束后重新启动，确保加载完整的新运行时代码；新会话直接加载。

启动前主 Agent 响应中断会明确显示“未执行 · 主 Agent 响应中断”；不会将尚未调用的 graph 工具显示为子任务执行失败。Graph 不修改上游的展示归属或会话身份。

### CLI 信息层级（2026-09-09）

- 已结束的 Graph 优先显示结果计数、合并后的原因和详情入口；相同服务错误只占一行。详细任务编号与原始错误在详情中查看。
- `未执行` 包括依赖受阻，以及有持久证据证明未派发的 fail-fast 任务；不改写执行记录，原始失败仍可按 `l` 核对。证据缺失或已有派发意图时不会隐藏失败。
- 输入 `/graphs` 直接打开当前摘要对应的 Graph；没有当前摘要时选择保存的记录。`/graphs view` 保留选择列表，`/graphs view <id>` 指定记录。
- `/graphs hide` 只收起摘要，底栏保留状态和展开入口；子任务监管和去重继续。重新输入 `/graphs` 打开详情，关闭后恢复摘要；出现新的终态或待处理情况时自动恢复摘要。
- 详情默认选中真正失败或需要处理的任务，接着列运行任务，最后列未执行和已完成任务。Enter 查看说明与下一步，`l` 查看原始记录，Esc 返回，q 关闭。
- 父 Agent 汇报提示默认简述完成情况、主要原因和一个必要决策，不重复运行路径和计数。此提示影响后续模型回复，不会改写已有会话；具体措辞仍由模型生成。

### 历史认证错误与当前记录

历史任务的身份验证错误只说明当次请求失败，摘要不再直接要求重新登录。详情分开展示当次失败时间、失败原因和“本机当前登录记录”。后者只读取 Pi agent 目录中 auth.json 的对应服务元数据，区分已保存 OAuth 登录、API 密钥配置、未找到本机记录与不可读取；始终不把“已保存”当成“有效性已验证”，也不把全文件修改时间当作某个服务的登录时间。未找到本机记录不排除环境变量、运行时密钥或其他配置。

打开详情、自动刷新与按 r 刷新都不会调用认证接口、刷新 token、执行密钥命令、修改凭据或自动重试任务。只显示记录是否存在，不把凭据值、指纹或当前认证元数据写入 Graph 快照、RPC 或日志；登录记录更新可以在同一历史任务详情中刷新显示。历史任务在列表、详情与原始记录中仍保持实际失败状态。


### CLI 通知与最终汇总

Graph 消费自有完成事件并保存结果记录，重复通知不会重复验收；父 Agent 以 Graph 的验收结果为准。通知采用不触发回合的状态消息与排队 follow-up 唤醒，避免并发提交父 prompt。

Graph 自己的运行观察提醒按持久状态去重，已结束任务不会反复产生相同提醒。

`graph wait` 遇到运行中节点的 `waiting_user`、`suspected_unresponsive`、`storage_error`、`repeated_errors`、`result_unavailable` 或 `runtime_exited` 时返回 `attention_required`，让主 Agent 能处理问题。它只结束当前等待，不停止 Graph 或子任务，也不设置任务总时长。处理后继续等待，最后给出完整、自包含的综合结论。

### 无默认任务期限、主子对话与只读材料

自有 guardian/child 不添加默认任务 deadline，保留用户停止、RPC 握手、退出监管和单次操作故障检查。原 native 安装补丁不参与新 Graph 运行。

Graph 消息以 taskId、attempt、messageId 关联；主线程决策回复经同一邮箱返回。取消、失效身份和读取失败明确呈现，不自动重放旧问题或任务。

只读工具名称为 `graph_readonly_list`、`graph_readonly_find`、`graph_readonly_sha256`。父会话真实注册这些工具，子会话仅获得父 capability ceiling、Agent tools 和 Graph toolFilter 的交集。它们用 fs/crypto，不接受 shell command、env 或 cwd 覆盖。参数：

- list：`path`，可选 `offset`（0..100000）、`limit`（1..200）。
- find：上述参数及 `namePattern`（文件名 `*`/`?`，不支持路径表达式）、`maxDepth`（0..32，默认 8）。
- sha256：仅 `path`，输出 SHA256 和文件字节数。

路径相对准备好的工作目录。工具拒绝 `..`、符号链接、特殊文件与越界访问；目录只返回授权条目，错误不包含越界绝对路径。遍历最多处理 10000 个可访问候选，结果明确返回 `truncated`/`nextOffset`；达到遍历容量时应缩小目录或名称条件。显式准备的 `.pi-graph/inputs` 文件可读取校验，其他运行控制文件仍禁读。这是受信扩展中的文件工具约束，不是 OS 沙箱。Graph readOnly 下任意 bash、write、edit 仍被拒绝。

节点可声明 `requiredMaterials: ["docs/design.md"]`，同时在 `readScope` 中授权对应文件或目录。host 从可信 `sourceCwd` 检查材料存在且在 scope 内；全部节点检查通过才初始化运行，每次准备 shadow 再检查。缺少材料或超出 scope 会在启动前失败。任务正文里的 MustRead 不会被解析成权限，不会猜仓库路径或复制整仓。子任务使用 shadow 相对路径，材料不足须由主线程纠正声明。

运行代码更新后，等待当前任务结束，再退出 Pi 并用原启动命令重新进入；仅 `/reload` 不保证所有 SDK 模块缓存都重新加载。本项目不会替用户重启活跃会话。已有冻结任务不会自动更换权限或重放，旧协议任务只保留可核对的历史。

Graph WAIT 对邮箱中的决策、异常、结果以及运行健康异常返回 `attention_required`。普通 peer 消息不产生父模型通知；主线程使用统一 mailbox action 处理后继续等待。通信不再读取 pi-subagents 私有 supervisor receipt，也不恢复 intercom 通道。

### Explicit result and evidence handoff

New nodes may opt into `resultContract: "status-json"`. The child must end with exact JSON
`{"status":"pass","reason":"verified findings"}`, `blocked`, or `fail`. A non-pass or invalid result
finishes the node as failed, suppresses automatic retry, and prevents ordinary accepted-only dependents
from starting. An explicit `when: {node: "review", status: "failed"}` still permits a failure handler.
This is a declared business verdict, not a claim of machine validation or permission to perform new actions.

For external work that needs later review or archiving, declare exact non-secret files:

```json
{"evidenceFiles":[{"path":"evidence/report.json","nonSecret":true}],"outputArtifact":"proof"}
```

The declaration explicitly authorizes retention of those files. Never declare credentials or session
files. Only regular, non-linked workspace-relative files are copied before workspace cleanup (32 MiB
per file, 64 MiB total, at most 64 files). The durable location is
`artifacts/<taskId>/attempt-<N>-files/files/<path>` with an integrity manifest whose digest is bound to
Attempt and acceptance evidence. Consumers declaring `inputArtifacts:["proof"]` receive the original
text artifact and the declared file at `.pi-graph/inputs/proof.files/evidence/report.json`. Both the
manifest and file bytes are verified before accepted evidence is consumed. Missing or changed declared
files prevent acceptance; the full workspace is still cleaned. Failed/blocked terminal children also
retain available declared evidence before cleanup. A missing declared file fails the retention step;
partial copies are not an accepted evidence bundle.

Existing graphs retain their result semantics; already deleted files cannot be recovered. Graph mailbox replaces native supervisor communication for new graphs. Request text never grants additional authority; Graph does not answer or approve requests automatically.

### Esc 与取消

在 Pi 终端按 Esc 会保留 Pi 原有的取消行为，当 Pi 确实取消正在执行的父轮时，停止本次会话明确启动或等待过的未完成 Graph（包括已让出关注状态的子任务）。停止通过 Host 公共 stop 控制执行，等子任务真实退出后才确认；无法确认会显示 `stop_requested` / `needs_attention`。其他会话及未关联历史 Graph 不受影响。`/graphs` Inspector 内 Esc 仅关闭面板；`/reload` 延续原有暂停监督行为，不发出 Esc 停止请求。底层 `waitForGraphSnapshotV3` 仍只观察状态，取消政策属于 Pi graph 工具层。

Pi 空闲时无法通过公共 API 可靠区分输入框 Esc 和其他选择菜单 Esc，因此此时不自动停止 Graph。需要停止等待关注的后台任务时，使用 `graph action: "stop"` 或 `/graphs stop <id>`。停止确认等待最多 3 秒，超时保留实际停止请求并报告未确认，输入框可继续使用。


## Bounded results, typed handoff, and explicit fallback

`graph action=result id=<graph> [node=<task>] [attempt=<n>] [offset=<n>] [limit=<n>]` reads the persisted state or native final answer. Offsets count Unicode code points; `nextRequest` provides the complete next call (or `null` at the end), while `nextOffset` remains available, and `sha256` identifies the complete UTF-8 text. The effective page may be smaller than limit to bound JSON bytes. New accepted output is checked against its attempt-bound digest; `complete:null` means completeness is unproven (including legacy/failed output), and `complete:false` means known truncation. An unavailable or corrupt artifact is reported, never replayed to recreate it. The full native capture retains its existing 32 MiB limit. Tool text and details are bounded to 12.5 KiB combined; status projections contain at most six nodes. Use `action=attention` to page pending supervisor requests and `action=usage` to page full usage metadata. Re-read from offset zero if the returned hash changes while an active graph evolves.

Usage distinguishes child runs/attempts from the entire current main session; the latter is not a cost attributable exclusively to this graph. It reads only public session entry identity/model/usage metadata, never copies message content. Actual provider/model, compaction/branch-summary category, zero cost, and unknown/missing metrics remain distinct. Repeated observations are not added twice. Main-session and child scopes are reported separately, not a claimed deduplicated system-wide bill.

Optional `dependencyInputs` selects only verified direct-dependency fields: `{from:"review",field:"status",type:"string",as:"gate"}` or `reason`. The producer uses existing exact `resultContract:"status-json"`. For long files select `{from:"review",field:"evidenceFiles",type:"artifact-list",as:"files"}` and include the producer's `outputArtifact` in `inputArtifacts`; each returned path is readable under `.pi-graph/inputs/` in the consumer workspace. Missing/wrong-type or oversized selected values fail before consumer dispatch; use file references instead of silently truncating typed values. Without selectors, legacy bounded plain-output handoff is retained.

Optional `fallbackAgents:["existing-backup-role"]` requires exact-agent authoring, existing unambiguous fixed-model catalog entries for all roles, and a trusted parent tool ceiling. Capability/model overrides are rejected. Only explicit provider/quota/auth/model unavailability from preflight permits selecting the next role. Unknown diagnostics, validation, tool failures and aborts stop admission. The selected definition and model are frozen in normal binding evidence, alongside candidate catalog identities and selection outcomes. Unprobed candidates are explicitly marked. No provider configuration is changed.

Runtime failures never switch roles merely from an error string; only the frozen candidate plan plus complete owned pre-activity and physical-exit evidence can authorize a safe model replacement. Read the original result/recovery evidence and author an explicit remaining-task contract; do not replay completed writes, external effects or an unknown outcome. Read-only runtime-crash recovery remains the existing distinct same-agent path.

Permissions remain mode-specific: strict denies child bash and enforces scoped tools; inherited follows parent/Agent tool ceilings and readOnly. Inherited declared scopes describe material/scoped-helper access and validated shadow changes, not a general OS sandbox.


### Graph 持久邮箱

子任务使用 `graph_mailbox` 的 send、receive、read、reply、ack、wait、status。to 使用已准入 taskId；向 `@parent` 只允许 decision、exception、result，reply 从原消息推导收件人。send/reply 必须提供稳定 idempotencyKey；同键同正文返回同一 ID，正文冲突被拒绝。向尚未启动节点发送只排队，不绕过 DAG；目标 attempt 在排队时冻结，不转交重试的新代际。

queued 表示保存成功；delivered 表示客户端收到响应后提交了投递确认；acknowledged 是收件人显式处理声明；replied 表示已回复。读取不消费消息。崩溃可能重复展示同一 messageId，ACK 不能证明文件写入等业务动作恰好发生一次。邮箱不重启任务、不重复派发或自行续作。wait 在同一次工具调用内轮询，直到收到未确认消息、取消或连接失败，不反复启动模型回合；没有对已退出子任务的自动唤醒。receive 返回稳定 nextCursor，可作为后续 offset；默认 wait 跳过已 ACK 或已回复消息，read 仍可读取历史。

正文上限 1 MiB，单图持久状态上限 15 MiB、1024 条消息，超过明确拒绝。大正文用 messageId 和 read 分页读取，offset 单位是 Unicode 码点；不允许通过消息让 Host 读取任意文件。现有 accepted evidenceFiles 的读取权限不因发消息而增加。

Host 使用本机私有 Unix socket 和每次提交的运行 lease 校验；只支持本机子任务，不启动公开服务端口。通信能力来自冻结的 Graph 控制面，消息内容不能授予权限。它不提供同一 OS 用户下任意 shell 的安全隔离。

新运行记录 communication.json 协议版本。旧协议运行保留结果/状态只读，不自动迁移、重放历史消息或恢复派发。修改 guard 文件即可影响旧运行未来派发，不仅是 /reload 时；更新前须确认相关图已结束。源码更新不会自动重载已有 Pi 会话。已结束邮箱的主线程查看是纯只读；回复需要活跃且授权的 Host，不借查看重启任务。

### 子任务上下文与按需资料（contextPolicy v1）

新建 Graph 默认冻结 `contextPolicy: "v1"`；可显式设为 `"disabled"`。历史 Graph 缺此字段时保持关闭，恢复不自动升级。上下文只在每次送给模型的投影中折叠至少 2048 UTF-8 字节的精确重复 builtin `read/grep/find/ls` 成功纯文本：工具仍执行、持久会话保留原文、当前投影内首份正文保留为 anchor。输入参数或输出变化、错误、图片、bash、写工具、邮箱和自定义同名工具不折叠。每次重新扫描当前消息，不依赖跨会话或压缩前缓存。配置自定义扩展的 Agent 保守关闭优化，避免后续插件删除 anchor。

至少 4096 UTF-8 字节的非 typed accepted 依赖，只有已声明 `inputArtifacts`、通过 accepted chain 和复制摘要验证，且实际工具计划/父权限允许 builtin read 时，才使用最多 512 码点预览及 `.pi-graph/inputs/` 引用。引用列出文件摘要、字节数、producer/attempt、格式及原验收方法；`declared` 不会变为机器验收。typed/status/reason 和失败诊断保留 inline。单行超过 builtin read 共同 50 KiB 限制、缺 read 权限或无法证明来源时，回退既有 inline 预算；不增加权限或工具。

授权输入在 builtin read 前后检查安全打开、完整摘要及稳定文件身份；变化时阻止读取或丢弃返回正文并标记错误。该检查不承诺同一 OS 用户恶意修改后恢复（ABA）隔离。大材料可按 builtin read 的行 offset 分页；引用自身不授予新权限。新 guard 文件会使旧冻结 guardDigest 不一致的后续派发安全拒绝；不要自动重放旧任务。当前进程需在任务空闲后由用户重新启动 Pi 才加载全部修改，本次未自动重载。

### 从节点查看产物或发送通知

在 Pi 终端输入 `/graphs`，用上下键选择节点，Enter 查看详情。`m` 关闭面板后打开原生输入框；标题固定显示 Graph、taskId 和 attempt，确认后只向该执行尝试的现有邮箱发送通知。取消不发送；只允许当前会话所属且仍在运行的 child，排队、暂停、结束或身份已变化均拒绝，不启动新模型回合、不恢复或重跑任务。回执“已入队”不代表送达或处理；未知提交结果不会自动重发，相同草稿保留原幂等键。

详情提供有界保存产物预览；`o` 按固定 attempt 和 SHA256 查看已校验 accepted 保存文件，`n` 下一页，上下键滚动，Esc 返回。`l` 仍查看原始状态 JSON。正文和状态中的终端控制字符不会执行。这里的“原文”是实际保存的产物，不是完整子会话或保证完整的模型输出：既有产物存储可能约64 KiB截断，含截断标志时明确显示“已截断”，其余也不承诺模型原输出完整。缺失、未验收、摘要变化或不安全文件拒绝展开。

### Graph 状态摘要与活动详情

Graph 自有摘要显示整体状态与分类计数，最多两条运行岗位、实际模型和当前或最近完成工具；已有岗位名时不重复任务 ID，字段缺失直接省略。更多运行只显示数量，排队只给数量或有明确依赖的下一项；不猜测并发、权限或额度原因，也不自动翻译任务 ID。最近最多三个 Graph 各自显示摘要，其他 Graph 仍可通过 `/graphs` 查看；收起摘要不停止任务。

在 `/graphs` 中选中任务并按 Enter，查看真实观测的工具、路径、工具调用次数、实际模型及最近活动绝对时间；工具展开视图也显示这些事实。缺失信息明确标注未观测到，已结束任务标注最后观测，异常或未来时间标注待核对。时间久远本身不意味着失败或无响应；具体异常沿用已有监管证据。显示不修改执行状态，也不启动额外计时器。`m/o/l/Esc` 保持原有行为。

### 续读结果与待处理请求

首次读取节点结果时，使用完整的 graph 工具参数，例如：

```json
{"action":"result","id":"my-graph","node":"my-task"}
```

读取整个 Graph 状态时省略 `node`；读取待处理请求时使用 `{"action":"attention","id":"my-graph"}`。`limit` 默认为 **4096**，最大为 **8192 Unicode 码点**（按 Unicode 字符计数，不是字节或 token）。超过 8192 会被拒绝，不会自动缩小。返回内容还受字节预算限制，因此一页实际字符数可能小于 `limit`。

把响应正文解析为 JSON，依次拼接其中的 `text`，再将 **`nextRequest` 原样作为下一次 graph 调用参数**，直到它为 `null`。不要增加 `limit`，也不要为了读取更多内容而重新运行任务。节点结果的续读参数包含实际 `attempt`，因此后续出现的新尝试不会悄悄替换正在读取的结果。Graph 状态和待处理请求可能在读取期间变化；若 `sha256` 改变，应从 `offset: 0` 重新读取。


### 摘要、完整结果与分页读取

顶部最近三个 Graph 按运行实例及稳定摘要更新顺序排列。活动时间、工具计数等详情仍随新快照更新，但不会单独把 Graph 挤入最近三个；阶段、任务数量或排队原因的摘要变化仍会更新顺序。Inspector 保留当前选中任务，新快照用于刷新详情。

在节点详情按 `o` 阅读已校验的保存产物，按 `f` 阅读固定执行尝试的原生结果；`n` 继续下一页，`Esc` 返回详情。`f` 会标明 `native_capture`（原生捕获）或 `fallback`（既有尝试记录回退），并显示 `complete:true`（完整性已验证）、`complete:null`（完整性未证明）或 `complete:false`（已截断）。缺少原生捕获时不会重新执行任务，也不会扩大既有保存产物约 64 KiB 的存储上限；读至来源末尾不等于模型原输出必然完整。

工具 `graph action=result` 和 `action=attention` 按 Unicode 字符分页，默认 4096、最大 8192，字节预算可能缩短单页。严格复制返回的整个 `nextRequest`，直到它为 `null`；其中 `expectedSha256` 固定整份来源的内容版本，节点结果同时固定 `attempt`。来源改变或缓存无法恢复时返回 `source_changed`、`recoverable:true`、`isError:false` 和不含正文的恢复指令。丢弃已收集旧页，完整复制 `restartRequest` 从 offset 0 自动重读最多一次，保持 limit，无需再问用户授权；不要重跑、停止或回放任务。若同一读取再次要求恢复，停止该路径循环，转 `/graphs` 详情或报告原因。attention 和不带 node 的 result 使用独立只读快照，逐页保持原始内容和哈希；有效续页刷新120秒闲置期限，最长寿命10分钟。缓存最多32条、总16MiB，冷启动、容量淘汰或过期会明确要求重新读取。带 node/attempt 的结果始终重新校验真实证据与digest，不缓存以掩盖篡改。权限、非法参数和完整性错误仍为真实错误。固定快照的续页必须完整复制 `nextRequest`，不支持缺少 expectedSha256 的裸 offset 续页。仅节点结果读取兼容旧裸 offset，该用法不能保证多页属于同一版本。

这些改进参考 [pi-maestro-flow](https://github.com/catlog22/pi-maestro-flow) 的 [completion ownership](https://github.com/catlog22/pi-maestro-flow/blob/master/packages/pi-maestro-teammate/src/completion-outbox/coordinator.ts)、[内容身份](https://github.com/catlog22/pi-maestro-flow/blob/master/packages/pi-maestro-teammate/src/public/v1/completion-durability.ts) 与 [冲突保护](https://github.com/catlog22/pi-maestro-flow/blob/master/packages/pi-maestro-teammate/src/completion-outbox/file-store.ts) 原则：异步读取前确定同一路径的接收顺序，已保存结果不被冲突覆盖，分页内容与摘要显示分别保持一致性。适配使用本项目自有 SDK runtime 契约，并未引入 Maestro API、outbox 或存储迁移。同路径到达顺序保证限于同进程中已绑定的接收器；跨进程及绑定前缓存不承诺全局到达顺序。

默认紧凑卡片隐藏任务全文、日志路径和工具参数路径；ctrl+o 展开仍保留原生详情。Graph 摘要保留岗位或短任务 ID、状态和真实问题，只在依赖明确时显示下一项。新运行不使用 native 维护清单；历史补丁备份不是安装步骤。

### 安全的运行时模型接替

参考 Maestro 的错误分类、候选推进及不重放副作用原则，Graph 对新准入的 capability 路由节点支持有限的运行时模型接替。routing profile 明确配置 `budget.modelDegradations > 0`，或独立岗位配置明确提供 `fallbackModels` 时，在准入阶段冻结同岗位的合规备用模型；未配置替补链、能力路由预算明确为 0，或旧 Graph 未冻结候选时不启用。显式指定的模型是第一选择，备用只取配置列表中它后方的候选，不自动倒回前面的较弱模型。候选须保持 Agent、工具和扩展合同一致，并满足图片输入能力、模型可用范围、跨模型家族和官方 Kimi Coding (`kimi-coding/k3`) 与官方 Grok (`xai/...`) 限定。启动前无法合规冻结的候选不会在运行时临时加入。

运行时只认自有运行器完整的 `preActivityEvidence`：独立 worker 内的官方 Pi SDK session、订阅早于 prompt、一次内部 launch、零工具启动/assistant toolCall/孤立工具结果、原始 assistant error、prompt 结束与 commands/shutdown 正常完成、无取消/中断/超时/晚活动。Graph 另外核对真实进程退出、receipt/session/run/step 身份、已持久化的 Graph Guard workspace 绑定与实际模型。最终错误必须与该结构化供应商诊断一致；模型身份校验/结果结构校验失败，以及已报告文件修改或 mutation attempted/observed，均拒绝接替。界面 `toolCount=0`、日志未显示工具、任务正文里的错误、普通输出摘要均不能授权重放。本次 Kimi HTTP 403 的 “You've reached your 5-hour usage limit” 被识别为额度问题；不猜测额度恢复时间。

通过证明后，先持久化失败 Attempt 和接替合同，再用新的 Attempt 与唯一派发身份启动下一冻结模型；静态 Graph/授权摘要不变，权限不扩大，失败模型在本节点接替链内不再回放。候选耗尽、节点累计用量不足或缺少用量证据、生命周期 Attempt 上限都会终止接替。尚未派发的备用任务遇到暂停会保留 prepared 记录、返回 paused 并释放运行所有权；恢复使用同一候选和派发身份。compact Graph 摘要只在备用运行期间显示一行接替原因，其余证据在 `/graphs`。

这里的“零工具”仅证明受控 Pi 任务尚未开始执行工具，不承诺任意第三方扩展初始化无副作用；未知 ambient/Agent 扩展、未知 factory、external/herdr 路径和未完整关闭的会话不会自动接替。已执行工具后的会话续接、未知外部操作恢复、跨任务全局熔断和自动恢复旧失败 Graph 不在本阶段范围。历史 timed Graph 保持既有只读/人工核对规则；本功能不延长原有时间边界。

升级宿主 SDK 后按必要 API 和实际生命周期检查兼容，不按精确版本号拒绝；开发依赖固定为 1.0.4，宿主兼容由必要 API 和生命周期检查决定；不会自动套用历史 native 补丁。待当前任务结束后重新启动 Pi 才能加载新的运行时代码。

## 参考与来源

任务编排、邮箱与完成归属的设计参考 [pi-maestro-flow](https://github.com/catlog22/pi-maestro-flow)，自有启动接口也参考原 [pi-subagents](https://github.com/nicobailon/pi-subagents) 契约。当前低层 utility 独立实现，没有整包安装、运行依赖或逐段源码移植；不把“允许参考 MIT 工具代码”描述为实际复制。Pi SDK 仍由宿主安装提供。


## 许可证

本项目使用 [MIT License](LICENSE)，版权为 2026 HeathHe。运行依赖仍遵守各自许可证；设计参考不代表复制或安装相应项目。
