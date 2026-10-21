# pi-graph

English is expanded by default. Click either language heading to expand or collapse it; close the other section to switch languages.
默认展开英文。点击语言标题可展开或收起；收起另一语言即可切换。

<details>
<summary>简体中文</summary>

`pi-graph` 是 Pi 生态中的单机、持久化 DAG 执行器。调用方提交一份 `GraphSpec V3`，执行器负责编译有向无环图、按依赖并发运行自有 SDK 子 Agent 节点、验证本地写入，并把恢复所需证据持久化到磁盘。

模型与岗位配置文件是一等入口：直接编辑项目 `.pi/graph-models.json`、全局 `~/.pi/agent/graph-models.json` 和相应 `agents/<name>.md`。可复制 [JSON 配置](examples/graph-models.example.json) 与 [岗位 Markdown](examples/agents/custom-worker.md)；完整字段说明及优先级见 [独立模型与岗位设置](docs/owned-model-settings.md)；`/graph-models` 是同一配置格式的交互入口。配置只影响新 Graph，已有 Graph 保留冻结模型、工具、提示词及模型定义。

运行层由本项目直接管理当前安装的宿主 Pi SDK：自有 RPC、独立 OS worker、guardian 退出监管、状态/结果证据与持久邮箱。无需 `pi-subagents` 或 `pi-intercom`。启动前检查必要 SDK API 和 session 生命周期能力；缺少能力时明确拒绝，不能用扩展开发依赖中的另一版本代替。

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

用户配置与续接边界分别见[模型与岗位设置](docs/owned-model-settings.md)和[原会话续接](docs/session-continuation.md)。

## 安装与运行要求

0.2.2 更新终端任务展示、宿主 SDK 兼容与有界超时续接，并修复任务结束与暂停请求交错时错误返回运行中的问题。变更见 [CHANGELOG](CHANGELOG.md)。

要求 Node.js `>=22.19.0` 和已安装的 Pi。运行使用宿主提供的 Pi SDK，启动时核验必要 API 与会话生命周期；开发依赖固定为 `1.0.4`，不是要求宿主必须使用这一精确版本。缺少必要能力时拒绝启动，不偷偷切换另一个 SDK。

安装 npm 上已发布的稳定版（`latest`），在终端执行：

```bash
pi install npm:pi-graph
```

默认安装会记录到 Pi 的用户配置。新会话加载扩展后应能看到 `graph` 工具及 `/graphs`、`/graph-models` 命令。已有会话先等待任务结束，再重新启动 Pi；不要在活跃 Graph 中替换运行时代码。

更新前先等待所有任务结束并退出 Pi；在终端按需选择一条命令执行，更新后重新启动 Pi：

```bash
pi update --extensions                 # 更新全部已安装扩展
pi update --extension npm:pi-graph      # 只更新 Pi Graph
```

单数 `--extension` 后必须提供安装来源。此前使用固定版本（如 `npm:pi-graph@0.2.1`）的用户，先在原安装范围重新执行 `pi install npm:pi-graph`，改为跟随稳定版；原来用 `-l` 安装的，仍在原项目目录执行 `pi install npm:pi-graph -l`。只有 npm 发布了更高版本才会有新更新；同版本不会获取本机尚未发布的修复。

发布前可在隔离目录用 `npm install /absolute/path/pi-graph-0.2.1.tgz` 检查真实包，再使用独立空 Pi 配置目录临时加载：

```bash
release_agent_dir="$(mktemp -d)"
PI_CODING_AGENT_DIR="$release_agent_dir" pi -e /absolute/path/to/node_modules/pi-graph
```

`-e` 不写入安装声明，隔离变量避免复用现有 Pi 配置；不修改 `HOME`。只检查扩展加载，不输入真实模型任务或登录模型服务。`.tgz` 是 npm 包归档，不能直接当作 Pi 的单扩展文件加载。完整命令和本人 npm 登录步骤见发布流程。

不需要安装 `pi-subagents`、`pi-intercom`；已有重复扩展应先核对安装来源，在无活跃任务时由用户移除，不能直接删除历史运行数据。shell 保护依赖 macOS `sandbox-exec`；其他系统或该命令不可用时，运行器拒绝未受保护的 shell。只读与其他工具仍须通过各自启动前检查，这不承诺其他平台完整功能可用，也不构成外部服务或同一 OS 用户的完整安全隔离。

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

## 同一会话协调多个项目

`graph` 的外层可选 `projectRoot` 可为新 Graph 选择用户已授权的项目目录，支持绝对路径，或相对于当前会话目录的路径。不传时沿用当前会话目录。它也适用于 `agents` 和仅编译源的 `load`（`spec`、`capsule` 或 `template`）。回执显示规范化后的实际项目路径。

每个 Graph 仍只绑定一个项目；它不会更改主会话目录、扩大主会话工具权限或自动授予目录授权。已有 Graph 的 `load`（按 `id`）、`wait`、`status`、`retry`、`resume`、`append` 等操作不能传入 `projectRoot`，始终使用已保存的项目。`readScope`、`writeScope`、胶囊相对路径及项目 Agent 均基于选中的项目；原有路径隔离与校验照常执行。

例如，同一会话先建立 Todo：`A 项目检查` → `B 项目修改`，然后分别提交两个 Graph（使用不同 `graphId`）：

```json
{"action":"start","projectRoot":"/authorized/project-a","spec":{"schemaVersion":3,"graphId":"check-a","goal":"检查 A","nodes":[{"taskId":"check","agent":"generalist","task":"只读检查授权范围","sideEffect":"none"}]}}
```

等待 A 真正验收完成，读取结果并更新或关联 Todo 后，再提交 B：

```json
{"action":"start","projectRoot":"/authorized/project-b","spec":{"schemaVersion":3,"graphId":"change-b","goal":"处理 B 的授权工作","nodes":[{"taskId":"inspect","agent":"generalist","task":"根据已核对的结论检查 B","sideEffect":"none"}]}}
```

示例 Agent 须在对应项目或用户 Agent 中真实存在；写操作仍需明确范围和验证命令。Todo 协调多个 Graph 的进度，不会自动把它们变成跨项目 DAG，也不会自动传送产物。需要物料时，先核对并显式准备目标项目内的输入，不跨根绕过隔离保护。

## 分层总计划

一个总目标写在 `graph_todo set.goal`。任务仍以一个 flat `items` 数组保存，使用可选 `parentId` 明确父子关系；不从标题、旧聊天或现有 Graph 自动猜分组。最多 **8 层任务项、128 项（含分组）**，总目标本身不计层数。旧的 flat 计划保持原样。

```json
{"action":"set","expectedRevision":0,"goal":"完成登录接入","items":[
  {"id":"prepare","title":"核对接入条件","status":"pending"},
  {"id":"contract","parentId":"prepare","title":"核对平台契约","status":"pending","assignee":"backend-developer"},
  {"id":"implementation","title":"实施与验证","status":"pending"},
  {"id":"implement","parentId":"implementation","title":"实现接入","status":"pending","dependsOn":["contract"],"assignee":"backend-developer"},
  {"id":"parent-review","parentId":"implementation","title":"主会话审核证据","status":"pending","dependsOn":["implement"],"assignee":"parent"}
]}
```

有子项的项是**分组**：保存的 `status` 必须是 `pending`，不设置 `assignee`、Graph `links` 或非空 `dependsOn`。分组只从后代叶项汇总，不是执行者，不能手工标为完成，也不能 `link` 或用于 `graph start.todoBinding`。显示的分组完成数与总进度只计算不同叶项，不把父组再计一遍；人工叶的完成仍与 Graph 验收区分。

依赖只允许**叶 → 叶**，可以跨组，不能引用分组；层级不自动产生派发先后关系。批量绑定叶项时，仍必须证明对应 Graph 节点具有真实 accepted 依赖路径。显示号如 `#1.2` 由同父项在原数组中的顺序生成；状态、标题和折叠不改号。操作 API 使用稳定 `id`，不使用显示号。

`update` 省略 `parentId` 保持位置；字符串明确移动；`parentId:null` 明确移到根（记录中移除此字段）。不能把已有 Graph 关联或执行状态的叶静默改成分组，也不能用 `update` 把分组最后一个子项移走留下空组。需要整体调整时用 `set` 明确重建并去掉空父项：它仍是新的计划周期，旧记录保留为历史，不能冒充旧任务已完成。

原生终端按实际可用宽度显示树、稳定编号和编号旁状态。标题在左，已观测项目、Agent 与实际模型在空间充足时同排靠右；窄屏先换行标题，再显示身份。完成项保持原位置与真实完成状态，不自动按旧观察顺序收起。总览之后固定显示当前执行任务；空间不足优先保当前身份与真实风险，并提供更多项目和详情入口，不用计划模型冒充实际模型。

`Alt+T` 控制整体展开/收起；`Alt+Shift+T` 打开总计划详情。分组收展只改变界面，不修改计划记录或重新派发。Inspector 中 `c` 仅隐藏/显示本面板的完成项，不改变底部任务状态；`h` 查看生命周期历史，`v` 恢复当前计划显示。输入草稿与原快捷键保留。

记录沿用 `pi-graph-todo/1` 与 `version:1`，新增字段为可选。新版本读取旧 flat 记录无需迁移；**旧二进制不能读取含 `parentId` 的新树记录**，会按严格校验显示计划待核实，不会静默退回旧完成状态。降级前应使用支持树结构的版本查看与整理计划。

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

- 输入区上方显示可折叠的独立总计划或 Graph 执行清单，下方显示实际活动 Agent 树；总计划完成数与 Graph 已验收数分别统计。优先当前活动图，其他已观测记录及待处理图按数量显示，详情仍可查看。工具 START 只显示“已提交”，WAIT 只显示“正在等待结果 / 等待已结束”；使用无背景色单行呈现，展开仍保留详细数据。
- `/graphs view` 选择一个 Graph；`/graphs view <graph-id>` 直接打开。↑↓ 或 j/k 选任务，Enter 查看详情，l 查看原始状态 JSON，PgUp/PgDn 翻页，Esc 返回，q 关闭。
- 查看面板只读，不会接管、重跑或停止任务。原始记录页展示当前持久状态和失败证据，不是完整会话日志。刷新失败时保留上次状态并明确提示。
- 成功、失败、未执行、运行、排队、停止、取消、跳过分别计数。只有停止请求及节点中止证据都存在时，才显示“已停止 · 含 N 项失败”。“控制探测有响应”只说明运行器可回应，不等于模型有进展。
- Graph 管理自有 child 的状态、摘要与详情，不再依赖 pi-subagents 的 Async/Fleet 展示行。
- 已有 Pi 会话待任务结束后重新启动，确保加载完整的新运行时代码；新会话直接加载。

启动前主 Agent 响应中断会明确显示“未执行 · 主 Agent 响应中断”；不会将尚未调用的 graph 工具显示为子任务执行失败。Graph 不修改上游的展示归属或会话身份。

### 总计划、执行任务与成员

`Alt+G` 打开统一面板，列表中 `p` / `t` / `a` 切换总计划、执行任务、成员，`g` 选择图。稳定命令为 `/graphs todo`、`/graphs tasks`、`/graphs agents`、`/graphs history`；终端需将 Option 配置为 Meta 才能识别快捷键，不支持时使用命令。计划项 Enter 展示关联，↑↓ 选择关联后 Enter 打开原任务详情。

父级可用 `graph_todo` 明确维护总计划；不会自动提取聊天计划，也不迁移其他 Todo 插件的数据。先 `list` 读取修订号，再带 `expectedRevision` 写入。子 Agent 不注册此工具。例子：

```json
{"action":"set","expectedRevision":0,"items":[{"id":"delivery","title":"完成交付验收","status":"pending"}]}
```

- `list` 只读；`set` 替换全计划；`update` 用 `id` 修改单项 `title` / `status`；`link` 用 `id` 和 `links:[{graphId,runInstanceId,taskId}]` 替换关联。写操作都必须使用最新 `expectedRevision`，最多 128 项，每项标题最多 400 字符。
- 未关联项标为“人工”；人工完成不等于 Graph 验收。关联项只按当前会话、准确运行实例中节点的最新 attempt 投影；所有关联都 accepted 才完成，缺失、读取失败或跨会话显示待核实。关联不会启动或授权 Graph。
- 计划通过 Pi 原生 `pi-graph-todo/1` session entry 保存；分支恢复当前分支内容，修订号在会话中累积。新空会话可能只在内存，界面明确区分已保存、会话内存与保存未确认；保存报错不自动重试。
- 面板查看、切换和刷新不写计划，也不触发模型或控制 Graph。当前会话已观测记录的计数不是磁盘全部历史。8 行终端只保留状态和详情入口。
- 源码修改不会进入已经运行的 Pi 会话。任务结束后更新 Pi 实际加载的安装副本，再重新启动；仅修改源码仓库或仅重启不能更新另一个安装副本。不要在活跃任务中替换安装副本或重载。


可信退出证明与 Graph 状态分开显示：当准确绑定当前会话、Graph/run、任务 attempt、原生运行和 runner 的物理退出证明成立，而保存的任务仍为 running/dispatched 时，显示“进程已退出，Graph 状态待核对”，不再列为活动成员，也不能从该成员发送消息。原 phase/status 和文件不变，不自动验收、恢复或重派。continuation 仅完整封存且最终 generation/ledger 一致的证明可确认；needs_attention 缺完整封存时只显示“退出证据未核实”，不能据此断言进程已退出。缺失、旧身份、worker-only、单独 stopped 状态或请求超时均不是可信 runner 退出证明。


不活动邮箱的 `send/reply/ack/wait` 返回明确的非成功回执：`code=mailbox_inactive`、`delivery=not_sent`、`taskRestarted=false`、`canRetry=false`。仅 Graph 已处于终态才提示任务已结束；运行中或未知状态提示核对运行状态。紧凑与展开界面都会说明消息未发送，不可自动重试；`receive/read/status` 仍可只读检查历史。后续要求交给主会话，先核对既有结果，再仅安排剩余工作；子任务结束不等于总目标完成，等待人工授权不应创建 watcher 或重派。跨会话 owner 校验及已关闭收件人规则不变。

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

等待也会消费只读、严格身份匹配的物理退出证据：子进程已退出但 Graph 尚未收尾时返回 `attention_required`，不把退出当作验收成功。`waitEvidence.kind` 区分 `confirmed_exit`、`exit_unverified`、`observation_unavailable` 和 `supervisor_attention`；无法确认时省略 `graphContinuesRunning`，不能据旧 running 状态宣称全部子任务仍运行。每次状态、证据和回执读取最多等待 5 秒；这是单次读取保护，不是任务总时限。取消只停止等待，读取失败或监督租约释放都不单独证明退出，不会自动重试、恢复或重新派发。


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

统一面板始终保留任务 ID，并显示岗位、已观测实际模型和当前或最近工具；缺失字段省略。最多两名实际活动 Agent，更多成员显示数量。当前活动图优先；其他本会话已观测记录及待处理图合并为可打开的计数，不展开多个历史警告。总计划与 Graph 验收分别统计，不猜测并发、权限或额度原因。收起摘要不停止任务。

在 `/graphs` 中选中任务并按 Enter，查看真实观测的工具、路径、工具调用次数、实际模型及最近活动绝对时间；工具展开视图也显示这些事实。缺失信息明确标注未观测到，已结束任务标注最后观测，异常或未来时间标注待核对。时间久远本身不意味着失败或无响应；具体异常沿用已有监管证据。显示不修改执行状态，也不启动额外计时器。`m/o/l/Esc` 保持原有行为。

### 续读结果与待处理请求

首次读取节点结果时，使用完整的 graph 工具参数，例如：

```json
{"action":"result","id":"my-graph","node":"my-task"}
```

读取整个 Graph 状态时省略 `node`；读取待处理请求时使用 `{"action":"attention","id":"my-graph"}`。`limit` 默认为 **4096**，最大为 **8192 Unicode 码点**（按 Unicode 字符计数，不是字节或 token）。超过 8192 会被拒绝，不会自动缩小。返回内容还受字节预算限制，因此一页实际字符数可能小于 `limit`。

把响应正文解析为 JSON，依次拼接其中的 `text`，再将 **`nextRequest` 原样作为下一次 graph 调用参数**，直到它为 `null`。不要增加 `limit`，也不要为了读取更多内容而重新运行任务。节点结果的续读参数包含实际 `attempt`，因此后续出现的新尝试不会悄悄替换正在读取的结果。Graph 状态和待处理请求可能在读取期间变化；若 `sha256` 改变，应从 `offset: 0` 重新读取。


### 摘要、完整结果与分页读取

摘要聚焦真实活动任务所在的 Graph；无活动任务时显示最近需处理记录，其他本会话已观测记录通过计数和历史入口查看。Inspector 详情保留选中任务供核对；成员列表在活动任务退出后选择下一名可见成员。

在节点详情按 `o` 阅读已校验的保存产物，按 `f` 阅读固定执行尝试的原生结果；`n` 继续下一页，`Esc` 返回详情。`f` 会标明 `native_capture`（原生捕获）或 `fallback`（既有尝试记录回退），并显示 `complete:true`（完整性已验证）、`complete:null`（完整性未证明）或 `complete:false`（已截断）。缺少原生捕获时不会重新执行任务，也不会扩大既有保存产物约 64 KiB 的存储上限；读至来源末尾不等于模型原输出必然完整。

工具 `graph action=result` 和 `action=attention` 按 Unicode 字符分页，默认 4096、最大 8192，字节预算可能缩短单页。严格复制返回的整个 `nextRequest`，直到它为 `null`；其中 `expectedSha256` 固定整份来源的内容版本，节点结果同时固定 `attempt`。来源改变或缓存无法恢复时返回 `source_changed`、`recoverable:true`、`isError:false` 和不含正文的恢复指令。丢弃已收集旧页，完整复制 `restartRequest` 从 offset 0 自动重读最多一次，保持 limit，无需再问用户授权；不要重跑、停止或回放任务。若同一读取再次要求恢复，停止该路径循环，转 `/graphs` 详情或报告原因。attention 和不带 node 的 result 使用独立只读快照，逐页保持原始内容和哈希；有效续页刷新120秒闲置期限，最长寿命10分钟。缓存最多32条、总16MiB，冷启动、容量淘汰或过期会明确要求重新读取。带 node/attempt 的结果始终重新校验真实证据与digest，不缓存以掩盖篡改。权限、非法参数和完整性错误仍为真实错误。固定快照的续页必须完整复制 `nextRequest`，不支持缺少 expectedSha256 的裸 offset 续页。仅节点结果读取兼容旧裸 offset，该用法不能保证多页属于同一版本。

这些改进确保：异步读取前确定同一路径的接收顺序，已保存结果不被冲突覆盖，分页内容与摘要显示分别保持一致性。适配使用本项目自有 SDK runtime 契约。同路径到达顺序保证限于同进程中已绑定的接收器；跨进程及绑定前缓存不承诺全局到达顺序。

默认紧凑卡片隐藏任务全文、日志路径和工具参数路径；ctrl+o 展开仍保留原生详情。Graph 摘要始终保留任务 ID，并显示岗位、已观测的实际模型、状态和真实问题，只在依赖明确时显示下一项。新运行不使用 native 维护清单；历史补丁备份不是安装步骤。

### 安全的运行时模型接替

Graph 对新准入的 capability 路由节点支持有限的运行时模型接替。routing profile 明确配置 `budget.modelDegradations > 0`，或独立岗位配置明确提供 `fallbackModels` 时，在准入阶段冻结同岗位的合规备用模型；不会自动捕获主会话模型、思考级别或追加父模型备用；能力路由预算明确为0、显式fallbackModels:[]，或旧Graph未冻结候选时不启用。显式指定的模型是第一选择；常规按序策略只取配置列表中它后方的候选，candidatePool=all-compatible则从配置批准的其他兼容候选中冻结备用，并保持预算与能力守卫。候选须保持 Agent、工具和扩展合同一致，并满足图片输入能力、模型可用范围、跨模型家族，以及配置批准的供应商、模型范围及能力约束。启动前无法合规冻结的候选不会在运行时临时加入。

未启用新续接协议的已冻结计划，仍只认自有运行器完整的 `preActivityEvidence`：独立 worker 内的官方 Pi SDK session、订阅早于 prompt、一次内部 launch、零工具启动/assistant toolCall/孤立工具结果、原始 assistant error、prompt 结束与 commands/shutdown 正常完成、无取消/中断/超时/晚活动。Graph 另外核对真实进程退出、receipt/session/run/step 身份、已持久化的 Graph Guard workspace 绑定与实际模型。最终错误必须与该结构化供应商诊断一致；模型身份校验/结果结构校验失败，以及已报告文件修改或 mutation attempted/observed，均拒绝接替。界面 `toolCount=0`、日志未显示工具、任务正文里的错误、普通输出摘要均不能授权重放。仅根据明确的供应商额度诊断判断，不猜测额度恢复时间。

旧零活动路径通过证明后，先持久化失败 Attempt 和接替合同，再用新的 Attempt 与唯一派发身份启动下一冻结模型；静态 Graph/授权摘要不变，权限不扩大，失败模型在本节点接替链内不再回放。候选耗尽、节点累计用量不足或缺少用量证据、生命周期 Attempt 上限都会终止接替。尚未派发的备用任务遇到暂停会保留 prepared 记录、返回 paused 并释放运行所有权；恢复使用同一候选和派发身份。compact Graph 摘要只在备用运行期间显示一行接替原因，其余证据在 `/graphs`。

这里的“零工具”仅证明受控 Pi 任务尚未开始执行工具，不承诺任意第三方扩展初始化无副作用；未知 ambient/Agent 扩展、未知 factory、external/herdr 路径和未完整关闭的会话不会自动接替。新准入且冻结 `sessionContinuationVersion: 1` 的任务另有独立续接证明：供应商明确失败、SDK prompt 完全结束且没有排队、执行中或未知效果时，在同一 AgentSession / logical run / Attempt 内切换模型，只发送固定短续接消息，保留已完成工具结果、工作目录、邮箱与累计预算。受控内部 checkpoint 请求还可在严格会话/部署/身份校验与正常物理退出证明后，由 guardian 从原会话记录续接；它不是任意进程退出或 crash 的自动恢复。模型候选仍只消费一次，按实际模型分段记录用量。未知扩展可保持合法首模型执行，但不自动续接。详见[原会话续接与安全检查点](docs/session-continuation.md)。未知外部操作恢复、跨任务全局熔断和自动恢复旧失败 Graph 仍不支持。历史 timed Graph 保持既有只读/人工核对规则；本功能不延长原有时间边界。

升级宿主 SDK 后按必要 API 和实际生命周期检查兼容，不按精确版本号拒绝；开发依赖固定为 1.0.4，宿主兼容由必要 API 和生命周期检查决定；不会自动套用历史 native 补丁。待当前任务结束后重新启动 Pi 才能加载新的运行时代码。

### 子 Agent 备用链与主会话分离

新 Graph 及追加节点的备用链只来自明确岗位/profile配置；不会自动追加当前主会话模型，不额外增加预算，也不把同型号候选移动到末尾或覆盖其思考级别。岗位显式配置的模型即使与主会话同型号，仍按原配置顺序和权限使用。`fallbackModels: []` 与有效零预算保持关闭；同会话续接和 checkpoint 也只消费已经冻结的明确候选。

父工具权限上界、第二意见排除主生产者家族等正常父上下文用途保留。`modelScope.allow` 中的 `inherit` 只是允许当前父型号的许可，不会生成备用候选；没有明确首选模型时沿用父模型的既有行为是另一项默认规则，本轮未改变。

更新磁盘代码不会自动热更新所有已打开 Pi 会话，也不会重写旧 Graph 的冻结链。等待当前任务结束后重启相应 Pi 会话，新建 Graph 或追加节点才使用新准入策略；旧授权、snapshot 和 digest 保持原样，不自动停止或重放旧任务。已完成工具不通过重新派发原任务来恢复。

## 许可证

本项目使用 [MIT License](LICENSE)，版权为 2026 HeathHe。运行依赖仍遵守各自许可证。

</details>

<details open>
<summary>English</summary>

`pi-graph` is a single-machine, persistent DAG executor in the Pi ecosystem. The caller submits a `GraphSpec V3`; the executor compiles the directed acyclic graph, runs its owned SDK child Agent nodes concurrently according to dependencies, validates local writes, and persists the evidence needed for recovery to disk.

Model and role configuration files are first-class entry points: edit the project's `.pi/graph-models.json`, the global `~/.pi/agent/graph-models.json`, and the corresponding `agents/<name>.md` directly. Copy the [JSON configuration](examples/graph-models.example.json) and [role Markdown](examples/agents/custom-worker.md); see [Independent model and role settings](docs/owned-model-settings.md) for all fields and precedence. `/graph-models` provides an interactive entry point for the same configuration format. Configuration affects only new Graphs; existing Graphs retain their frozen models, tools, prompts, and model definitions.

This project directly manages the currently installed host Pi SDK at runtime: owned RPC, separate OS workers, guardian exit supervision, state/result evidence, and a durable mailbox. Neither `pi-subagents` nor `pi-intercom` is required. Required SDK APIs and session lifecycle capabilities are checked before startup. Missing capabilities cause an explicit refusal; another version from the extension's development dependencies cannot be substituted.

The production entry point has three layers with clear boundaries; there is still just one V3 DAG core in the middle:

```text
Pi Binding / Admission
  capabilityId / requires / exact agent / model + budget hints
                         ↓ resolution, preflight, frozen admission evidence
Resolved GraphSpec V3 → compileGraphSpecV3 → V3GraphRunner → verify/apply → durable evidence
                                                                    ↓
Pi Observability / TUI
  actual agent/model · child session · usage · current tool · live DAG
```

The extension entry point first reads `routing-policy.json`. Using `routingProfile` from the capability catalog, it runs owned Agent/model preflight in candidate order to choose the authoring `model` / `thinking` for this admission; an explicit model conflicting with policy fails closed. Binding then **maps each capability ID to exactly one Agent** through `subagent-capabilities.json`, and passes immutable evidence to Core. Candidate selection happens only in the extension Admission adapter. DAG Core neither reads a mutable model registry nor selects policy again; runtime advances frozen fallback candidates only when complete evidence satisfies the requirements. Fields such as `routing`, `routingProfile`, and `planning` must still not appear in the public GraphSpec.

It does not decompose the caller's goals, review plans, or require visual evidence. Before every parent Agent turn, the Pi extension injects a fixed, idempotent `PI-GRAPH Routing` contract requiring actual child Agent delegation to use `graph`: single tasks use one node; fan-out/fan-in, dependency chains, and implementation with independent testing/review use the corresponding multi-node structures. The same contract is used directly in the `graph` tool description to prevent divergence. This remains prompt guidance: it does not start Graphs itself or automatically convert already-started ordinary subagents into nodes. Without an actual `graph` call, DAG Core does not intervene. `/graphs doctor` and `graph doctor` show the contract version, SHA-256, and the most recent injection decision, without saving the system prompt or user content.

See [model and role settings](docs/owned-model-settings.md) and [session continuation](docs/session-continuation.md) for configuration and recovery boundaries.

## Installation and runtime requirements

0.2.2 updates terminal task presentation, host SDK compatibility, and bounded timeout continuation, and fixes a race between task completion and pause requests. See [CHANGELOG](CHANGELOG.md).

Node.js `>=22.19.0` and an installed Pi are required. Runtime uses the host-provided Pi SDK and verifies required APIs and session lifecycle capabilities at startup. Development dependencies are pinned to `1.0.4`; this does not require the host to use that exact version. Missing required capabilities cause startup refusal, without silently switching to another SDK.

To install the published stable release (`latest`) from npm, run in a terminal:

```bash
pi install npm:pi-graph
```

By default, installation is recorded in Pi's user configuration. After a new session loads the extension, the `graph` tool and `/graphs`, `/graph-models` commands should be available. For existing sessions, wait for tasks to finish, then restart Pi; do not replace runtime code during an active Graph.

Before updating, wait for all tasks to finish and exit Pi. Choose one of these commands in a terminal, then restart Pi:

```bash
pi update --extensions                 # Update all installed extensions
pi update --extension npm:pi-graph      # Update Pi Graph only
```

The singular `--extension` requires a source argument. If you previously installed a pinned version (such as `npm:pi-graph@0.2.1`), rerun `pi install npm:pi-graph` in the same installation scope to follow stable releases; if you used `-l`, run `pi install npm:pi-graph -l` from the original project directory. New updates require a higher version published to npm; the same version will not fetch unpublished local fixes.

Before publication, inspect the actual package in an isolated directory with `npm install /absolute/path/pi-graph-0.2.1.tgz`, then load it temporarily using a separate, empty Pi configuration directory:

```bash
release_agent_dir="$(mktemp -d)"
PI_CODING_AGENT_DIR="$release_agent_dir" pi -e /absolute/path/to/node_modules/pi-graph
```

`-e` does not write an installation declaration. The isolation variable prevents reuse of existing Pi configuration; `HOME` is unchanged. Check extension loading only: do not submit real model tasks or log in to model services. A `.tgz` is an npm package archive and cannot be loaded directly as a single Pi extension file. See the release workflow for complete commands and personal npm login steps.

There is no need to install `pi-subagents`, `pi-intercom`. For existing duplicate extensions, first check their installation sources; users should remove them when no tasks are active, without directly deleting historical run data. Shell protection depends on macOS `sandbox-exec`; on other systems, or when that command is unavailable, the runner refuses unprotected shell execution. Read-only and other tools must still pass their own preflight checks. This does not promise complete functionality on other platforms or full security isolation from external services or the same OS user.

## Core capabilities

- Compile `GraphSpec V3`, checking unknown dependencies, dependency cycles, artifact relationships, paths, and concurrent read/write conflicts.
- Authoring specs can use `capabilityId` or `requires` to select an exact Agent from the shared capability catalog. Multiple capabilities must all point to the same Agent; the selection and Agent definition are frozen at admission.
- Nodes may declare `model`, `thinking`, `turnBudget`, `toolBudget`, `usageBudget`, and `maxTokens`. Core reads only resolved `launch` evidence, not the capability catalog.
- Fixed DAGs default to `mode: "sealed"`; `mode: "open"` supports `append`, `cancel`, `seal`, and revision CAS (compare-and-swap).
- `when: { node, status: "accepted" | "failed" }` provides minimal conditional branching. Nodes whose conditions do not match are projected directly as `skipped`, without creating a child Agent.
- Each node runs in a separate shadow workspace. `local_write` Attempts in the same graph are serialized by a FIFO write lock and must pass deterministic `validationCommands` before atomic write-back to the source workspace.
- `pause`, `resume`, and `stop` write durable `control.json`; when a Pi session closes, active graphs first enter a recoverable pause intent.
- Supervisor leases, monotonic generation fences, stable dispatch request IDs, and complete Attempt evidence jointly support crash recovery.
- Automatic retries and explicit `retry` both preserve history; each node has at most 100 Attempts over its entire lifecycle.
- Upstream output reaches direct downstream nodes through bounded, named dependency capsules marked as untrusted data. Artifacts retain both per-Attempt history and a latest alias.
- `.graph.json` capsules support `string`, `number`, and `boolean` inputs, with three built-in templates: `research-report`, `code-review`, and `doc-write`.
- New graphs default to `inherited`; the trusted parent tool ceiling is passed to owned child launch and Guard. Graph-level or node-level `readOnly`, nonempty `toolFilter`, and explicit Agent tool restrictions remain effective. Old tasks without permission fields remain strict.
- Pi tool cards and session widgets display live DAG progress, requested/resolved/actual Agents and models, child run/session, token/cost/turn usage, and the current tool and path. Except for reported token/cost contributing to usage-budget accounting for subsequent Attempts, these projections do not drive acceptance or recovery decisions.
- `start` returns quickly and asynchronously; its tool card and session widget continue following background state. Use `wait` to block the current call until the graph reaches a stable state and obtain its final result. Cancelling `wait` stops observation only, not the Graph.

## Minimal example

This graph first writes documentation, then reads the result for review. `contractPolicy: "strict"` means both capabilities must fully match the shared catalog. The catalog determines the exact Agent; the graph does not hard-code Agent names.

```json
{
  "action": "start",
  "spec": {
    "schemaVersion": 3,
    "graphId": "write-guide",
    "goal": "Write and review a user guide",
    "contractPolicy": "strict",
    "nodes": [
      {
        "taskId": "write",
        "capabilityId": "write.document",
        "task": "Write the user guide to docs/guide.md.",
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
        "task": "Review docs/guide.md for completeness and return a conclusion without modifying files.",
        "dependsOn": ["write"],
        "sideEffect": "local_read",
        "readScope": [{ "kind": "file", "path": "docs/guide.md" }]
      }
    ]
  }
}
```

Once accepted, `start` executes asynchronously and returns the `graphId` and initial snapshot. To read state once, call:

```json
{ "action": "status", "id": "write-guide" }
```

After `start` returns, the tool card and DAG widget keep updating live. If the caller also needs a blocking wait until the graph reaches `complete`, `failed`, `stopped`, `paused`, `idle`, `waiting_input`, or `needs_attention`, call:

```json
{ "action": "wait", "id": "write-guide" }
```

Interrupting this tool call only stops watching; the Graph continues in the background. To actually stop execution, call `stop` explicitly.

## Dynamic graphs

An OPEN graph may start with an empty topology. Every change must submit the `revision` the caller just read. An outdated revision returns a conflict instead of overwriting someone else's changes.

```json
{
  "action": "start",
  "spec": {
    "schemaVersion": 3,
    "graphId": "release-check",
    "goal": "Append release checks dynamically",
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
      "task": "Check the current release content and return a conclusion.",
      "sideEffect": "local_read",
      "readScope": [{ "kind": "tree", "path": "." }]
    }
  ]
}
```

```json
{ "action": "seal", "id": "release-check", "revision": 1 }
```

An OPEN graph with no currently executable nodes is `idle` and can still accept additions. Only a SEALED graph computes a final `complete` or `failed` state. `seal` is not `stop`, and `stop` does not automatically seal the topology.

## GraphSpec V3 summary

Top-level fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Must be `3` |
| `graphId` | Optional; deterministically generated from the source GraphSpec digest if omitted |
| `goal` | Required, 1..2000 characters |
| `nodes` | 1..512 for SEALED graphs; OPEN graphs may be empty |
| `mode` | `sealed` (default) or `open` |
| `maxConcurrency` | 1..6, default 2 |
| `failFast` | Default `false` |
| `workspace` | Only `shadow`, default `shadow` |
| `readOnly` | Read-only graph or node: forbids local_write/external_write, all shell execution, and external tools not proven read-only |
| `toolFilter` | Exact graph-level tool allow-list |
| `contractPolicy` | Authoring-only: `standard` (default) or `strict`; strict requires a complete capability catalog match for every node |

Nodes require `taskId`, `task`, and `sideEffect`, and specify an execution role through `agent`, `capabilityId`, or `requires`; strict contracts must use capabilities. `requires` is an array of capability IDs, not tools or npm dependencies. `taskId` permits only lowercase ASCII letters, digits, and hyphens, with a maximum of 200 characters. Common optional fields include `dependsOn`, `when`, `inputArtifacts`, `outputArtifact`, `readScope`, `writeScope`, `retryPolicy`, `acceptance`, `validationCommands`, and launch hints.

Key rules:

- For new graphs, `sideEffect` allows `none`, `local_read`, `local_write`, `external_read`, and `external_write`; old strict graphs still allow only the first three.
- `local_write` requires both nonempty `writeScope` and nonempty `validationCommands`.
- New Graphs do not accept `timeoutMs`: nodes, Attempts, child Agents, and validation have no execution duration limit. Historical deadlines are retained only for audit; old tasks must be inspected before recovery and cannot be automatically dispatched again.
- `retryPolicy` retains historical read/write compatibility. Automatic recovery is governed uniformly by the safety rules below, at most once; `maxAttempts` and `retryOn` do not relax them. `backoffMs` only determines how long to wait after recoverability is confirmed.
- Natural-language `acceptance` is merely recorded. Non-writing nodes use `declared` acceptance after normal child completion. Only `local_write` nodes use `machine-verified` after machine validation and successful apply; external nodes always remain `declared`/`verified=false`.

### Agent Binding and launch hints

- `capabilityId: "review.code"` denotes one capability. `requires: ["review.code", "review.spec"]` requires all these capabilities to map to the same Agent in the current catalog; otherwise admission fails.
- When both `agent` and a capability are declared, they must match exactly. An unknown explicit Agent never degrades to a temporary Agent.
- `contractPolicy: "strict"` requires a complete catalog match, without fallback even when temporary Agents are enabled.
- `model` is the caller's requested value. Fixed `modelPolicy.model` or owned preflight produces the resolved value; only child lifecycle reports provide the actual value. All three are persisted and displayed separately and cannot stand in for one another.
- Provider isolation has two boundaries: Binding rejects extension Provider primary/fallback known to the parent Pi; child Graph Guard rejects the current Provider registered or overridden by Agent extensions at the cancellable `input` boundary. Ordinary `models.json` / built-in Providers and Agent extensions registering only custom tools remain usable.
- `turnBudget` and `toolBudget` are enforced by the owned child SDK lifecycle. `usageBudget` is a cumulative budget shared across all Attempts of a node; a retry receives only the remaining allowance after historical reported usage is deducted. If historical dispatches lack configured usage evidence, the next dispatch is refused. Owned children also check frozen budgets at subsequent provider requests and tool boundaries and refuse continued execution beyond hard limits. `maxTokens` is a separate output limit for each provider request, tightened by child Graph Guard using native payload fields at the `before_provider_request` boundary. Its minimum is 16; unknown payload shapes fail closed.
- The extension-side Admission adapter reads `routingProfile` from the capability catalog. It selects the first model passing owned preflight in the candidate order from `routing-policy.json`. The selection becomes ordinary `model` / `thinking` authoring hints, then is frozen by existing Binding. Recovery reads only frozen evidence, without rereading policy.
- Each Admission captures one policy and capability catalog. Routing and Binding reuse the same catalog object and check its digest, exact Agent, and requested model. Disk changes during a call affect only the next Admission.
- Nodes requiring a different model family must obtain trusted identities for every direct producer. Fixed Agents in the same batch use owned preflight's resolved model; dynamic `append` accepts only actual models from verified accepted Attempts or frozen resolved models. Missing identities or conflicting evidence fail closed; requested/selected models never impersonate runtime actual models.
- Single-node tasks are also dispatched through Graph for the same routing, permissions, shadow workspace, and durable results. This version has no direct subagent entry point from the old components.
- Jev shadow calls only the existing WisdomRouter `/v1/systemone`, with the request model fixed to the dynamic alias `jev-latest`, and records the actual model returned in the response. It observes only the closed classification set `fast/deep/research/review/human` and confidence, without changing official routing. Credentials are read only from the environment or existing `models.json`, never written to policy, source, or results.

The persisted `admissionLaunchContractDigest` proves only the source Agent, authoring task, and preflight hints knowable at admission. Actual dispatch also adds Graph Guard, dependency capsules, and shadow workspace information. The `launchContractDigest` reported by the child lifecycle is separate runtime evidence; the two digests need not be equal.

## The `graph` tool

Main public actions:

| Action | Purpose |
| --- | --- |
| `start` | Create and asynchronously start a graph from an inline spec, capsule, or template |
| `wait` | Continuously project live state onto the current tool card; return at a stable graph boundary; cancelling observation does not stop the graph |
| `load` | Compile input only, or load an existing V3 run in place; does not create a new execution |
| `status` | Read a reconstructible state projection once |
| `list` | List persisted V3 runs |
| `doctor` | Report stale leases, orphan workspaces, invalid runs, and `needs_attention` |
| `pause` | Persist pause intent and wait for the current Supervisor to become quiescent |
| `resume` | Recover a paused or crash-interrupted run |
| `stop` | Persist stop intent, stop children, and wait for stop results |
| `templates` | List the three built-in capsule templates |
| `agents` | List shared `capabilityId → Agent` mappings and project Agents in `.pi/agents`; does not expose model/routing policy metadata |
| `retry` | Rerun a terminal node and its non-cancelled downstream nodes, retaining original Attempts |
| `append` | Append 1..64 immutable new nodes to an OPEN graph |
| `cancel` | Tombstone still-cancellable nodes in an OPEN graph; may cascade downstream |
| `seal` | Permanently seal an OPEN topology |
| `result` | Read saved results by attempt, digest, and page |
| `usage` | Read actually observed usage |
| `attention` | Read current pending requests and exceptions |
| `mailbox` | Send, receive, reply to, and acknowledge messages in the currently authorized mailbox |

For manual operations, `/graphs` provides `doctor`, `list`, `status`, `pause`, `resume`, and `stop`.

## Capsules and templates

`graph start` and `graph load` must choose exactly one input source from `spec`, `capsule`, and `template`. A `.graph.json` capsule has this structure:

```text
manifest + source.spec + intent + inputs + requires + provenance?
```

`requires.readOnly` and `requires.toolFilter` are not display-only information: after resolution, they enter the final GraphSpec and pass through the same V3 compiler. Templates use exactly the same capsule compilation path.

Example:

```json
{
  "action": "start",
  "template": "code-review",
  "overrides": {
    "target": "src/v3",
    "focus": "Crash recovery and concurrency consistency"
  }
}
```

### Template API migration

Built-in templates now explicitly separate two steps:

- Synchronous `resolveBuiltinGraphTemplateV3` / `resolveBuiltinGraphTemplateCapsuleV3` only substitute placeholders and return an authoring spec still containing capabilities; it cannot go directly to the pure Core compiler.
- Production execution must `await bindBuiltinGraphTemplateV3` or `bindBuiltinGraphTemplateCapsuleV3`, completing capability admission before obtaining an exact-Agent GraphSpec.

The old `loadBuiltinGraphTemplateV3` / `loadBuiltinGraphTemplateCapsuleV3` names have been removed to avoid silently changing return semantics under the same name.

## Configuration

V3 reads only the following four execution options from `settings.json.graph`; other historical `graph` fields do not enter execution decisions. Independent model and role configuration is provided separately by `graph-models.json` and role Markdown; see the configuration entry points above.

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

- `enabled` defaults to `true`.
- `runsDir` defaults to `graph-runs` under the Pi agent directory.
- `rpcTimeoutMs` defaults to 10000, with a maximum of 300000.
- `allowTemporaryAgent` defaults to `false`. The built-in `pi-graph.graph-worker` is allowed only when this is explicitly `true`, the contract is not strict, there is no exact capability match, and the node does not specify `agent`. This is an auditable fallback, not automatic Agent generation.

## Persistence and recovery

When Pi starts, reloads, or switches sessions, it automatically checks and recovers only Graphs whose original session ID matches the current session. A new session in the same directory, or a branched session, does not automatically take over old Graphs or show their summaries. History remains available through `/graphs list` and `/graphs status <graph-id>`, or explicit recovery with `/graphs resume <graph-id>`. Pause intents still require explicit resume.

Each run directory contains immutable admission, reconstructible snapshots, durable control intents, a Supervisor fence, topology/retry journals, node Attempt evidence, and versioned artifacts. `snapshot.json` is not the sole authority: recovery recompiles admission, replays journals, and reads Attempt evidence.

Dispatch first persists a stable request ID and request digest. A `prepared` intent can safely be emitted once during recovery. If the process crashes after the `emitting` boundary but before exact child binding is persisted, recovery enters `needs_attention` instead of blindly creating duplicate children. Owned runtime validates durable intent against the request digest and owner identity; the same identity can locate the original worker. Replay is still refused when earlier dispatch effects are uncertain. If child termination cannot be confirmed after stop, the run likewise enters `needs_attention`.

## Trust boundaries

Graph Guard is a Pi tool-layer guardrail. For authorized shell execution, the owned runner additionally uses macOS `sandbox-exec` to protect runtime control files, configuration, and credential paths; this is not complete isolation from all external effects. Other platforms or missing `sandbox-exec` cause unprotected shell execution to be refused. New graphs inherit the actual parent session tool ceiling, allowing authorized bash, reads across working directories, and already-loaded external tools. Parent ambient/MCP extensions are not loaded automatically; missing tools must be reported accurately. Explicit read-only tasks reject bash, file writes, and external tools not proven read-only. Nonempty toolFilter and explicit Agent tools still limit business tools. Trusted frozen flow separately grants graph_mailbox control-plane permissions, without granting file or shell capabilities.

`external_read` / `external_write` use declared acceptance (verified=false), which does not mean machine validation or rollback capability. Dispatched inherited nodes that are not read-only must not be replayed automatically or through a retry closure. Inspect actual outcomes first, then create a graph containing only remaining work.

Local Pi native shell and Supervisor run as the same OS user. Inherited validation supports shell, mise, environment-variable prefixes, and absolute command paths, and requires the current parent tool ceiling to allow bash. Supervisor spawn does not automatically inherit future tool-approval extensions; such environments need adaptation through execution entry points supported by those approval extensions. Old strict tasks retain their original command constraints. Guard changes may require manual inspection of old frozen tasks because of digest mismatch; permissions are not silently elevated.

Graph child communication consistently uses `graph_mailbox`; old `contact_supervisor` / `subagent_supervisor` / intercom communication is disabled inside Graph, without affecting ordinary non-Graph Pi tasks. The parent replies to decision requests through `graph({action:"mailbox",id:"Graph ID",mailbox:{action:"reply",messageId:"Message ID",text:"Decision",idempotencyKey:"Stable reply key"}})`. Ordinary peer-to-peer messages are not relayed to the main model; tools do not expand file or shell permissions.

When dispatching, Graph appends bounded execution context from the digest-bound shadow contract after the complete original task, preserving the original first line and every task/capsule byte: actual shadow cwd, relative read/write scopes, read-only state, and path restrictions. The inline task is the handoff unless it explicitly provides an in-scope handoff file. Children should not guess `../task-handoff.md` / `code-context.md`, access original source or `~` paths, or list directories outside scope. Paths are escaped JSON data; excessive or overly long entries are omitted in full with a count, rather than presenting shortened paths as permissions. Context explains existing Guard permissions without changing tool filtering or protected-directory rules. Untrusted-data markings on the original task and dependency capsule remain unchanged.

## Development validation

```bash
npm run check
npm test
npm run pack:check
```

Node.js `>=22.19.0` is required. Runtime follows the currently installed host Pi SDK, verifying compatibility through required API/lifecycle capabilities; development test dependencies are pinned separately for reproducibility. The release includes owned `src/runtime/`, the V3 core, extensions, roles, and templates, with configuration documentation shipped in the package. This project's discovery reads the packaged `agents/graph-worker.md`. Old native patches and backups are excluded from the release package and are neither current runtime dependencies nor installation steps.

Validation uses the actual SDK, separate workers, and fixed local model responses, covering model registration, configuration freezing, results, usage, and physical exit evidence. Real provider API calls and login-credential network acceptance have not been performed.

### Owned SDK execution and result recovery

The parent session calls the owned controller through `pi-graph:runtime:v1:request/ready/reply`; completion notification is `pi-graph:child-complete`. The controller fixes the owner, request ID/digest, and runtime identity before starting a guardian and separate SDK child. Duplicate dispatch returns only the same saved identity; conflicting requests are rejected without starting another task.

The guardian observes actual child exit and creates runtime-identity-bound `process-terminal.json`. The child saves `intent.json`, `status.json`, `result.json`, and activity evidence. Graph stores the complete result and exit evidence in its Attempt directory, readable even after workspace cleanup. Missing final results, identity mismatches, or incomplete exit evidence cannot masquerade as acceptance.

“Result received,” “process exit confirmed,” and “Graph acceptance passed” are checked separately. A completion label, log tail, vanished PID, or repeated notification alone cannot advance acceptance. Once result and exit evidence are complete, existing workspace checks, machine validation, and write-back continue.

Owned runtime does not create a default overall task timer; RPC handshake, stop confirmation, and network or individual-command fault protection retain separate boundaries. Waiting for human input does not use repeated watcher/timeout restarts; missing human input is handed back to the parent session. State observation does not kill tasks solely for silence, and a responsive parent RPC does not establish model progress.

Old run protocols retain results and read-only history, without automatic conversion or recovery as owned workers. If existing effects cannot be confirmed, inspect evidence first, then create a graph containing only remaining work. Runtime-failure replacement follows only the complete pre-activity evidence below, without guessing “no tools ran” from logs.

### Pi native CLI task panel

- A collapsible Todo widget above the editor shows the independent plan or Graph tasks; a separate tree below the editor shows actual active Agents. Plan completion and Graph acceptance are counted separately. Active work takes priority; other observed records and graphs needing attention remain accessible by count and details. Tool START displays only “Submitted”; WAIT displays only “Waiting for results / Waiting ended,” as a single line without background color. Expanded views retain detailed data.
- `/graphs view` selects a Graph; `/graphs view <graph-id>` opens it directly. ↑↓ or j/k selects tasks, Enter shows details, l shows raw state JSON, PgUp/PgDn changes pages, Esc returns, and q closes.
- The viewer is read-only and does not take over, rerun, or stop tasks. Raw record pages show current persisted state and failure evidence, not complete session logs. Failed refreshes retain the last state with an explicit notice.
- Success, failure, not executed, running, queued, stopped, cancelled, and skipped are counted separately. “Stopped · includes N failures” appears only when both a stop request and node abort evidence exist. “Control probe responsive” means only that the runner can respond, not that the model is progressing.
- Graph manages its own child state, summaries, and details, without relying on pi-subagents Async/Fleet display rows.
- Restart existing Pi sessions after tasks finish to load all new runtime code; new sessions load it directly.

An interrupted main Agent response before startup explicitly displays “Not executed · main Agent response interrupted.” A graph tool that has not been called is not displayed as a failed child task execution. Graph does not change upstream display ownership or session identity.

### Total plan, execution tasks, and Agents

`Alt+G` opens the combined panel. In a list, `p` / `t` / `a` switches plan/tasks/Agents and `g` selects a Graph. Reliable command alternatives are `/graphs todo`, `/graphs tasks`, `/graphs agents`, and `/graphs history`; Option must send Meta for the shortcut. Enter on a plan item shows its links; select a link and press Enter for the existing task details.

The parent-only `graph_todo` tool explicitly maintains the independent plan. It neither extracts plans from chat nor migrates other Todo plugins. Read `list` first; every mutation requires the current `expectedRevision`.

```json
{"action":"set","expectedRevision":0,"items":[{"id":"delivery","title":"Verify delivery","status":"pending"}]}
```

`set` replaces the plan, `update` changes one item's `title` / `status` by `id`, and `link` replaces its `links:[{graphId,runInstanceId,taskId}]`. Maximums are 128 items and 400 characters per title. Unlinked items are manual; manual completion is not Graph acceptance. Linked completion requires every referenced current node attempt to be accepted in the exact session and run. Missing, unreadable, or foreign evidence is unknown; links grant no execution permission.

Plans use native `pi-graph-todo/1` session entries, with branch-local contents and session-wide revisions. Empty sessions may hold entries only in memory; the UI distinguishes durable, memory, and unconfirmed saves. Failed saves are not retried automatically. Viewing and refreshing append nothing and trigger no model or Graph action. Historical counts cover this session's observed collection, not all files on disk. An eight-row terminal keeps only status and the details entry point. After tasks finish, update the installation copy Pi actually loads, then restart normally. Editing a separate source checkout or merely restarting does not update that installed copy; do not replace or reload an active installation.


Physical exit proof and Graph state are displayed separately. When proof matches the current session, Graph/run, task attempt, native run, and runner but the saved task remains running/dispatched, the UI shows “Process exited; Graph state needs verification” and excludes it from active members and messaging. Original phases, statuses, and files remain unchanged; no acceptance, resume, or redispatch is triggered. Continuations require a sealed final generation and matching ledger. Incomplete needs_attention seals are only “exit evidence unverified,” not confirmed exit. Missing or stale identity, worker-only exit, a stopped status alone, and request timeouts do not establish runner exit.


Inactive mailbox `send/reply/ack/wait` returns an explicit unsuccessful receipt: `code=mailbox_inactive`, `delivery=not_sent`, `taskRestarted=false`, and `canRetry=false`. Only a terminal Graph status is described as ended; running or unknown status asks the user to check the run. Both compact and expanded views state that nothing was sent and automatic retry is inappropriate. `receive/read/status` remain read-only history inspection. Bring follow-up requirements to the parent session, inspect existing results, and arrange only remaining work. A finished child does not mean the overall goal is complete; waiting for human authorization must not create a watcher or redispatch. Owner checks and closed-recipient rules remain unchanged.

### CLI information hierarchy (2026-09-09)

- Finished Graphs prioritize result counts, merged reasons, and a details entry point; identical service errors occupy one line. Detailed task IDs and original errors remain in details.
- “Not executed” includes blocked dependencies and fail-fast tasks with durable evidence proving they were not dispatched. Execution records are not rewritten; original failures remain inspectable with `l`. Failures are not hidden when evidence is missing or dispatch intent already exists.
- `/graphs` directly opens the Graph for the current summary; without a current summary, it selects a saved record. `/graphs view` retains the selection list, while `/graphs view <id>` specifies a record.
- `/graphs hide` collapses only the summary; the bottom bar retains state and an expansion entry point. Child supervision and deduplication continue. Enter `/graphs` again for details; closing restores the summary. A new terminal state or attention condition automatically restores the summary.
- Details initially select genuinely failed tasks or tasks needing attention, then list running tasks, and finally unexecuted and completed tasks. Enter shows explanations and next steps, `l` shows raw records, Esc returns, and q closes.
- Parent Agent reporting guidance defaults to a brief completion account, main reason, and one necessary decision, without repeated runtime paths and counts. This influences subsequent model responses without rewriting existing sessions; the model still generates the precise wording.

### Historical authentication errors and current records

Authentication errors in historical tasks indicate only that the corresponding request failed. Summaries no longer directly demand login again. Details separately show the failure time, failure reason, and “Current local login record.” The latter reads only service metadata from auth.json in the Pi agent directory, distinguishing saved OAuth login, API key configuration, no local record found, and unreadable records. “Saved” never means “validity verified”; the entire file's modification time is not used as a service login time. Absence of a local record does not exclude environment variables, runtime secrets, or other configuration.

Opening details, automatic refresh, and pressing r do not call authentication endpoints, refresh tokens, execute secret commands, modify credentials, or automatically retry tasks. Only record existence is shown. Credential values, fingerprints, and current authentication metadata are not written to Graph snapshots, RPC, or logs. Updated login records can refresh within the same historical task's details. Historical tasks retain their actual failed state in lists, details, and raw records.

### CLI notifications and final reporting

Graph consumes owned completion events and saves result records; duplicate notifications do not duplicate acceptance. The parent Agent relies on Graph's acceptance result. Notifications use status messages that do not trigger turns and queued follow-up wakeups to avoid concurrent parent prompt submissions.

Graph's own runtime observation notices are deduplicated by persisted state; finished tasks do not repeatedly generate identical notices.

When `graph wait` encounters `waiting_user`, `suspected_unresponsive`, `storage_error`, `repeated_errors`, `result_unavailable`, or `runtime_exited` on a running node, it returns `attention_required` so the main Agent can address the issue. This ends only the current wait, without stopping Graph or children or imposing an overall task duration. After handling the issue, continue waiting and eventually provide a complete, self-contained combined conclusion.

### No default task deadline, parent-child dialogue, and read-only materials

Owned guardian/child processes add no default task deadline, retaining user stop, RPC handshake, exit supervision, and individual-operation fault checks. Original native installation patches do not participate in new Graph runs.

Graph messages are associated by taskId, attempt, and messageId; parent decision replies return through the same mailbox. Cancellation, stale identity, and read failures are explicit, without automatically replaying old questions or tasks.

Read-only tools are named `graph_readonly_list`, `graph_readonly_find`, and `graph_readonly_sha256`. The parent session actually registers these tools; children receive only the intersection of parent capability ceiling, Agent tools, and Graph toolFilter. They use fs/crypto and do not accept shell commands, env, or cwd overrides. Parameters:

- list: `path`, optional `offset` (0..100000), `limit` (1..200).
- find: the above plus `namePattern` (filename `*`/`?`, no path expressions), `maxDepth` (0..32, default 8).
- sha256: only `path`; outputs SHA256 and file byte count.

Paths are relative to the prepared working directory. Tools reject `..`, symbolic links, special files, and out-of-scope access. Directories return only authorized entries; errors do not include out-of-scope absolute paths. Traversal processes at most 10000 accessible candidates and explicitly returns `truncated`/`nextOffset`; at traversal capacity, narrow the directory or name condition. Explicitly prepared `.pi-graph/inputs` files can be read and verified; other runtime control files remain unreadable. These are file-tool constraints in a trusted extension, not an OS sandbox. Under Graph readOnly, all bash, write, and edit remain refused.

Nodes may declare `requiredMaterials: ["docs/design.md"]` while authorizing the corresponding file or directory in `readScope`. The host checks that materials exist and are in scope from trusted `sourceCwd`. The run initializes only after every node passes; checks repeat during each shadow preparation. Missing or out-of-scope materials fail before startup. MustRead text in tasks is not parsed into permissions; repository paths are not guessed, nor is the entire repository copied. Children use shadow-relative paths; insufficient materials require the parent to correct declarations.

After runtime code updates, wait for current tasks to finish, exit Pi, and reenter with the original launch command. `/reload` alone does not guarantee all SDK module caches are reloaded. This project does not restart active sessions for users. Existing frozen tasks do not automatically change permissions or replay; old protocol tasks retain only inspectable history.

Graph WAIT returns `attention_required` for mailbox decisions, exceptions, results, and runtime health anomalies. Ordinary peer messages do not notify the parent model; the parent handles messages through the unified mailbox action before continuing to wait. Communication no longer reads pi-subagents private supervisor receipts or restores intercom channels.

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

### Esc and cancellation

Pressing Esc in the Pi terminal retains Pi's original cancellation behavior. When Pi actually cancels an executing parent turn, unfinished Graphs explicitly started or waited on by this session are stopped, including children that already yielded attention. Stop runs through the Host's public stop control and is confirmed only after actual child exit. Unconfirmed termination displays `stop_requested` / `needs_attention`. Other sessions and unassociated historical Graphs are unaffected. Esc inside the `/graphs` Inspector only closes the panel. `/reload` retains existing pause-supervision behavior without issuing an Esc stop request. The underlying `waitForGraphSnapshotV3` still only observes state; cancellation policy belongs to the Pi graph tool layer.

While Pi is idle, public APIs cannot reliably distinguish Esc in the input box from Esc in another selection menu, so Graphs are not automatically stopped then. To stop background tasks waiting for attention, use `graph action: "stop"` or `/graphs stop <id>`. Stop confirmation waits at most 3 seconds; on timeout, the actual stop request is retained and reported unconfirmed, and the input box remains usable.

## Bounded results, typed handoff, and explicit fallback

`graph action=result id=<graph> [node=<task>] [attempt=<n>] [offset=<n>] [limit=<n>]` reads the persisted state or native final answer. Offsets count Unicode code points; `nextRequest` provides the complete next call (or `null` at the end), while `nextOffset` remains available, and `sha256` identifies the complete UTF-8 text. The effective page may be smaller than limit to bound JSON bytes. New accepted output is checked against its attempt-bound digest; `complete:null` means completeness is unproven (including legacy/failed output), and `complete:false` means known truncation. An unavailable or corrupt artifact is reported, never replayed to recreate it. The full native capture retains its existing 32 MiB limit. Tool text and details are bounded to 12.5 KiB combined; status projections contain at most six nodes. Use `action=attention` to page pending supervisor requests and `action=usage` to page full usage metadata. Re-read from offset zero if the returned hash changes while an active graph evolves.

Usage distinguishes child runs/attempts from the entire current main session; the latter is not a cost attributable exclusively to this graph. It reads only public session entry identity/model/usage metadata, never copies message content. Actual provider/model, compaction/branch-summary category, zero cost, and unknown/missing metrics remain distinct. Repeated observations are not added twice. Main-session and child scopes are reported separately, not a claimed deduplicated system-wide bill.

Optional `dependencyInputs` selects only verified direct-dependency fields: `{from:"review",field:"status",type:"string",as:"gate"}` or `reason`. The producer uses existing exact `resultContract:"status-json"`. For long files select `{from:"review",field:"evidenceFiles",type:"artifact-list",as:"files"}` and include the producer's `outputArtifact` in `inputArtifacts`; each returned path is readable under `.pi-graph/inputs/` in the consumer workspace. Missing/wrong-type or oversized selected values fail before consumer dispatch; use file references instead of silently truncating typed values. Without selectors, legacy bounded plain-output handoff is retained.

Optional `fallbackAgents:["existing-backup-role"]` requires exact-agent authoring, existing unambiguous fixed-model catalog entries for all roles, and a trusted parent tool ceiling. Capability/model overrides are rejected. Only explicit provider/quota/auth/model unavailability from preflight permits selecting the next role. Unknown diagnostics, validation, tool failures and aborts stop admission. The selected definition and model are frozen in normal binding evidence, alongside candidate catalog identities and selection outcomes. Unprobed candidates are explicitly marked. No provider configuration is changed.

Runtime failures never switch roles merely from an error string; only the frozen candidate plan plus complete owned pre-activity and physical-exit evidence can authorize a safe model replacement. Read the original result/recovery evidence and author an explicit remaining-task contract; do not replay completed writes, external effects or an unknown outcome. Read-only runtime-crash recovery remains the existing distinct same-agent path.

Permissions remain mode-specific: strict denies child bash and enforces scoped tools; inherited follows parent/Agent tool ceilings and readOnly. Inherited declared scopes describe material/scoped-helper access and validated shadow changes, not a general OS sandbox.

### Graph durable mailbox

Children use `graph_mailbox` send, receive, read, reply, ack, wait, and status. to uses an admitted taskId; only decision, exception, and result are allowed to `@parent`. reply derives the recipient from the original message. send/reply require a stable idempotencyKey: the same key and body return the same ID; conflicting bodies are rejected. Sending to an unstarted node only queues a message and never bypasses DAG dependencies. The target attempt is frozen when queued and does not transfer to a new retry generation.

queued means saved successfully; delivered means the client submitted delivery confirmation after receiving the response; acknowledged is the recipient's explicit processing declaration; replied means a reply was sent. Reading does not consume messages. Crashes may show the same messageId again, and ACK cannot prove business actions such as file writes occurred exactly once. Mailboxes do not restart tasks, redispatch them, or independently continue work. wait polls within one tool call until unacknowledged messages arrive, cancellation, or connection failure, without repeatedly starting model turns; exited children are not automatically awakened. receive returns a stable nextCursor usable as a later offset. By default, wait skips ACKed or replied messages, while read can still access history.

Bodies are limited to 1 MiB; persistent state per graph is limited to 15 MiB and 1024 messages. Exceeding limits is explicitly refused. Read large bodies through messageId and paginated read, with offsets in Unicode code points. Messages cannot make the Host read arbitrary files. Existing read permissions for accepted evidenceFiles do not increase through messaging.

The Host uses a private local Unix socket and checks the run lease on each submission. Only local children are supported; no public service port is opened. Communication capabilities come from the frozen Graph control plane; message contents cannot grant permissions. This does not provide security isolation against arbitrary shell execution by the same OS user.

New runs record the protocol version in communication.json. Old protocol runs retain read-only results/state, without automatic migration, historical message replay, or dispatch recovery. Guard file changes can affect future dispatches of old runs, not just at /reload; confirm relevant graphs have ended before updating. Source changes do not automatically reload existing Pi sessions. Parent inspection of ended mailboxes is purely read-only. Replies require an active, authorized Host; viewing does not restart tasks.

### Child context and on-demand materials (contextPolicy v1)

New Graphs freeze `contextPolicy: "v1"` by default; it may explicitly be `"disabled"`. Historical Graphs missing the field remain disabled, without automatic upgrade during recovery. Only in each projection sent to the model, context folding removes exact repeated successful plain-text responses of at least 2048 UTF-8 bytes from builtin `read/grep/find/ls`: tools still run, persistent sessions retain the original text, and the first body in the current projection remains an anchor. Changed arguments or output, errors, images, bash, write tools, mailbox tools, and custom tools with the same names are not folded. Current messages are rescanned each time, without cross-session or pre-compaction caches. Agents configured with custom extensions conservatively disable optimization to avoid later plugins deleting the anchor.

Non-typed accepted dependencies of at least 4096 UTF-8 bytes use a preview of at most 512 code points and a `.pi-graph/inputs/` reference only when `inputArtifacts` is declared, the accepted chain and copy digest pass verification, and the actual tool plan/parent permissions allow builtin read. References list file digests, byte counts, producer/attempt, format, and original acceptance method; `declared` does not become machine acceptance. typed/status/reason and failure diagnostics remain inline. If a single line exceeds the shared builtin read 50 KiB limit, read permissions are missing, or provenance cannot be proven, the existing inline budget is used instead, without adding permissions or tools.

Authorized inputs are checked for safe opening, full digests, and stable file identity before and after builtin read. Changes block reading or discard returned text and mark an error. This check does not promise isolation against malicious modification followed by restoration (ABA) by the same OS user. Large materials may be paged by builtin read line offsets; references themselves grant no new permissions. New guard files make subsequent dispatch with mismatched old frozen guardDigest fail safely; do not automatically replay old tasks. Users must restart Pi after tasks become idle to load all changes in the current process; no automatic reload was performed.

### Viewing artifacts or sending notifications from nodes

Enter `/graphs` in the Pi terminal, select a node with arrow keys, and press Enter for details. `m` closes the panel and opens the native input box. The title fixes Graph, taskId, and attempt; confirmation sends a notification only to that execution attempt's existing mailbox. Cancellation sends nothing. Only a still-running child owned by the current session is allowed; queued, paused, finished, or changed identities are refused. No new model turn starts, and no task resumes or reruns. “Queued” is not proof of delivery or processing. Unknown submission outcomes do not cause automatic resend; the same draft retains its original idempotency key.

Details provide bounded saved-artifact previews. `o` opens a verified accepted saved file bound to a fixed attempt and SHA256; `n` moves to the next page, arrow keys scroll, and Esc returns. `l` still shows raw state JSON. Terminal control characters in text and state are not executed. “Original text” here means the actually saved artifact, not the complete child session or guaranteed-complete model output. Existing artifact storage may truncate at about 64 KiB; a truncation flag explicitly displays “Truncated,” while other cases likewise do not guarantee complete original model output. Missing, unaccepted, digest-changed, or unsafe files cannot be expanded.

### Graph state summaries and activity details

The combined panel always retains task IDs alongside roles, observed actual models, and current or recent tools; missing fields are omitted. At most two actual active Agents are expanded, with additional members counted. Active work has priority; other observed records and graphs needing attention in this session are counted and remain accessible, without expanding multiple historical warnings. Plan completion and Graph acceptance are separate. Concurrency, permissions, or quota causes are not guessed. Collapsing the panel does not stop tasks.

Select a task in `/graphs` and press Enter to view actually observed tools, paths, tool call counts, actual models, and the absolute time of latest activity. Expanded tool views also show these facts. Missing information explicitly says it was not observed; finished tasks show the last observation; abnormal or future timestamps are marked for inspection. Old timestamps alone do not mean failure or unresponsiveness; specific anomalies follow existing supervision evidence. Display does not change execution state or start extra timers. `m/o/l/Esc` retain their behavior.

### Continuing result reads and pending requests

For the first node-result read, use complete graph tool arguments, for example:

```json
{"action":"result","id":"my-graph","node":"my-task"}
```

Omit `node` to read whole-Graph state; use `{"action":"attention","id":"my-graph"}` for pending requests. `limit` defaults to **4096** and has a maximum of **8192 Unicode code points** (Unicode characters, not bytes or tokens). Values above 8192 are refused, not automatically reduced. Responses also have a byte budget, so actual page character counts may be smaller than `limit`.

Parse the response body as JSON, concatenate its `text` values in order, then **use `nextRequest` unchanged as the next graph call's arguments** until it is `null`. Do not increase `limit` or rerun the task to read more. Node-result continuation arguments include the actual `attempt`, so later new attempts do not silently replace the result being read. Graph state and pending requests may change while reading; if `sha256` changes, restart at `offset: 0`.

### Summaries, full results, and paginated reading

The summary focuses on a Graph with active tasks, or a recent record needing attention when none are active. Other observed records in this session remain accessible through counts and history. Inspector details retain the selected task for verification; the Agent list selects the next visible member when one exits.

In node details, press `o` for verified saved artifacts and `f` for native results bound to a fixed execution attempt. `n` continues to the next page; `Esc` returns to details. `f` labels `native_capture` or `fallback` (existing Attempt record fallback), and displays `complete:true` (completeness verified), `complete:null` (completeness unproven), or `complete:false` (truncated). Missing native capture does not rerun tasks or increase the existing approximately 64 KiB saved-artifact storage limit. Reaching the end of a source does not establish that the original model output is necessarily complete.

`graph action=result` and `action=attention` page by Unicode characters, default 4096 and maximum 8192; byte budgets may shorten a page. Copy the entire returned `nextRequest` exactly until it is `null`. Its `expectedSha256` fixes the content version of the entire source; node results also fix `attempt`. A changed source or unrecoverable cache returns `source_changed`, `recoverable:true`, `isError:false`, and recovery instructions without body text. Discard collected old pages and copy the complete `restartRequest` to automatically reread from offset 0 at most once, preserving limit, without requesting user authorization again. Do not rerun, stop, or replay tasks. If the same read again requests recovery, stop looping that path and use `/graphs` details or report the reason. attention and result without node use separate read-only snapshots, preserving original content and hash across pages. Valid continuation refreshes the 120-second idle expiry, with a maximum lifetime of 10 minutes. The cache holds at most 32 entries and 16 MiB total; cold starts, capacity eviction, or expiry explicitly request a restart of reading. Results with node/attempt always revalidate actual evidence and digests, without caching to hide tampering. Permission, invalid-argument, and integrity failures remain real errors. Fixed-snapshot continuation requires the full `nextRequest`; bare offsets without expectedSha256 are unsupported. Only node-result reading remains compatible with old bare offsets, which cannot guarantee multiple pages belong to one version.

These improvements determine same-path reception order before asynchronous reads, prevent conflicting overwrites of saved results, and maintain consistency separately for paginated content and summary displays. Adaptation uses this project's owned SDK runtime contract. Same-path arrival-order guarantees apply only to already-bound receivers in the same process; no global arrival order is promised across processes or pre-binding caches.

Compact cards hide complete task text, log paths, and tool argument paths by default; ctrl+o expansion retains native details. Graph summaries always retain task IDs alongside roles, observed actual models, state, and actual problems, showing a next item only for explicit dependencies. New runs do not use native maintenance manifests; historical patch backups are not installation steps.

### Safe runtime model replacement

Graph supports limited runtime model replacement for newly admitted capability-routed nodes. When a routing profile explicitly sets `budget.modelDegradations > 0`, or independent role configuration explicitly provides `fallbackModels`, compliant backup models for the same role are frozen at admission. The main session model and reasoning level are not captured automatically, nor is the parent model appended as a backup. Replacement is disabled for explicit zero capability-routing budget, explicit fallbackModels:[], or old Graphs with no frozen candidates. An explicitly specified model is first choice. Ordinary ordered policy uses only candidates following it in the configuration list; candidatePool=all-compatible freezes backups from other configuration-approved compatible candidates while retaining budget and capability guards. Candidates must preserve Agent, tool, and extension contracts and satisfy image-input capabilities, available model scope, model-family separation, and configuration-approved provider, model-scope, and capability constraints. Candidates that cannot be compliantly frozen before startup are not added ad hoc at runtime.

Frozen plans not using the new continuation protocol still recognize only the owned runner's complete `preActivityEvidence`: an official Pi SDK session in a separate worker, subscription before prompt, one internal launch, zero tool starts/assistant toolCall/orphan tool results, original assistant error, prompt completion and normal commands/shutdown completion, and no cancellation/interruption/timeout/late activity. Graph additionally checks actual process exit, receipt/session/run/step identities, persisted Graph Guard workspace binding, and actual model. The final error must match structured provider diagnostics. Model identity/result structure validation failures, reported file modifications, or mutation attempted/observed all refuse replacement. UI `toolCount=0`, logs without tools, errors in task text, and ordinary output summaries cannot authorize replay. Quota failures require explicit provider diagnostics; quota recovery time is not guessed.

After the old zero-activity path is proven, failed Attempt and replacement contract are persisted first; the next frozen model starts with a new Attempt and unique dispatch identity. Static Graph/authorization digests remain unchanged, permissions do not expand, and the failed model is not replayed within this node's replacement chain. Exhausted candidates, insufficient cumulative node usage allowance or missing usage evidence, and the lifecycle Attempt limit terminate replacement. A pause before backup dispatch retains its prepared record, returns paused, and releases runtime ownership; resume uses the same candidate and dispatch identity. Compact Graph summaries show one replacement-reason line only while the backup runs; other evidence is in `/graphs`.

“Zero tools” proves only that a controlled Pi task has not started tools; it does not promise effect-free initialization of arbitrary third-party extensions. Unknown ambient/Agent extensions, unknown factories, external/herdr paths, and incompletely closed sessions do not automatically replace models. Newly admitted tasks freezing `sessionContinuationVersion: 1` have separate continuation proof: after explicit provider failure and full SDK prompt completion, with no queued, executing, or unknown effects, models switch within the same AgentSession / logical run / Attempt using only a fixed short continuation message, preserving completed tool results, cwd, mailbox, and cumulative budgets. Controlled internal checkpoint requests can also continue from original session records via guardian after strict session/deployment/identity validation and normal physical-exit evidence; this is not automatic recovery from arbitrary process exit or crash. Each model candidate is still consumed only once, and usage is segmented by actual model. Unknown extensions may run a lawful first model but cannot automatically continue. See [Original session continuation and safe checkpoints](docs/session-continuation.md). Unknown external-operation recovery, cross-task global circuit breaking, and automatic recovery of old failed Graphs remain unsupported. Historical timed Graphs retain existing read-only/manual-inspection rules; this feature does not extend original time boundaries.

After host SDK upgrades, compatibility is checked through required APIs and actual lifecycle, not rejected by exact version number. Development dependencies remain pinned to 1.0.4; host compatibility depends on required API and lifecycle checks, without automatic historical native patches. Restart Pi after current tasks finish to load new runtime code.

### Child Agent fallback chains are separate from the main session

Fallback chains for new Graphs and appended nodes come only from explicit role/profile configuration. They do not automatically append the current main-session model, add budget, move same-model candidates to the end, or override their reasoning levels. A role's explicitly configured model still uses original order and permissions even when it is the same model as the main session. `fallbackModels: []` and effective zero budgets keep replacement disabled; same-session continuation and checkpoints also consume only explicitly frozen candidates.

Normal uses of parent context remain, including the parent tool ceiling and exclusion of main producer families for second opinions. `inherit` in `modelScope.allow` merely permits the current parent model; it does not generate a fallback candidate. Existing use of the parent model when no explicit preferred model exists is a separate default rule, unchanged by this update.

Updating disk code does not hot-update all open Pi sessions or rewrite old Graphs' frozen chains. After current tasks finish, restart the corresponding Pi session; new Graphs or appended nodes then use new admission policy. Old authorization, snapshots, and digests remain unchanged, without automatic stop or replay. Completed tools are not recovered by redispatching the original task.

## License

This project uses the [MIT License](LICENSE), copyright 2026 HeathHe. Runtime dependencies retain their respective licenses.

</details>


### 终端常驻任务堆栈 / Native terminal task stack

Todo 常驻输入框上方，摘要显示完成数量；展开后每个任务独立成行，显示可读任务、责任岗位、实际模型与依赖等待。下方直接显示Agent树行与工具活动，不增加Agent或Graph标题层。默认展开；`Alt+T` 原地展开/收起，或使用 `/graphs expand`、`/graphs collapse`、`/graphs toggle`。展开显示已知依赖、受阻原因与责任岗位。独立总计划优先；没有总计划时明确显示 Graph 任务，不将人工完成计作 Graph 验收。

`Alt+Shift+T` 打开总计划详情，`Alt+R` 打开成员详情；`Alt+G` 与 `/graphs todo/tasks/agents/history` 保留。快捷键需要终端正确发送 Option/Meta，命令可作为可靠替代。下方只统计真实派发且未确认退出的成员；主会话状态单独标示，不计入成员数。模型、工具名和时长仅来自实际观测，长行优先保留状态与任务身份。没有新增模型请求，也不修改输入草稿。

Todo stays above the editor with completion counts. Expanded tasks occupy separate rows showing readable task descriptions, responsible roles, actual models and dependency waits. Below the editor, Agent tree rows and tool activity render directly, without Agent or Graph header rows. Tasks are expanded by default; `Alt+T` expands/collapses in place; `/graphs expand`, `/graphs collapse`, and `/graphs toggle` are command alternatives. Expanded rows show known dependencies, blocking reasons and responsible roles. An independent plan takes priority; without one, the widget explicitly shows Graph tasks. Manual completion remains separate from Graph acceptance.

`Alt+Shift+T` opens plan details, `Alt+R` opens Agent details, and existing `Alt+G` and `/graphs todo/tasks/agents/history` navigation remains available. Terminal Option/Meta configuration affects shortcuts; commands remain reliable alternatives. Only actually dispatched, non-exited child agents count as members. Parent activity is separate; models, tool names and durations use observed facts. Rendering preserves editor drafts and makes no model requests.


### Complete goal plans and event receipts / 完整目标计划与事件回执

For a confirmed goal spanning three or more stages, dependencies, turns or Graphs, the parent first calls `graph_todo list`, then CAS `set` for the full plan before dispatch. Optional `assignee` is an explicit role/name (for example `root`); `dependsOn` lists item IDs in this same plan. References must exist, be unique and acyclic. Existing records without these fields remain supported. Link real Graph/run/task IDs after dispatch; manual completion is not Graph acceptance. Human approval remains blocked, without a watcher or replay. A one-node Graph fallback explicitly means no overall plan has been established.

已确认目标涉及三个以上阶段、依赖、跨轮次或多个Graph时，父会话先`graph_todo list`，再按revision建立完整计划。可选`assignee`明确责任岗位/名称（例如`root`），`dependsOn`引用同计划项ID，禁止不存在、重复或成环引用；旧记录兼容。派发后用真实Graph/run/task关联，人工完成不冒充Graph验收。等待人类授权保持受阻，不建watcher或重放。单Graph回退明确表示尚未建立总计划，不会从旧聊天自动补写。

```json
{"action":"set","expectedRevision":0,"items":[{"id":"design","title":"确认设计","status":"pending","assignee":"root"},{"id":"build","title":"实现并验证","status":"pending","assignee":"backend-developer","dependsOn":["design"]}]}
```

Tool results own their native rendering after arrival, replacing the pending call row. Event labels require observed dispatch or acceptance; reading output alone never proves completion. Errors, attention, unfinished waits and pagination remain visible, with original machine content and result references preserved. In-memory receipt evidence does not fabricate identity when an old transcript lacks it.

工具返回后接管原生回执，收起重复调用行。启动/验收事件只使用对应证据；读取结果不等于任务完成。错误、待处理、尚未结束的等待及分页保持可见，原机器数据和结果入口保留。旧会话缺少身份资料时不会猜测。

A symbolic-link scope failure must be addressed by narrowing authorized read/write scopes to required source files/directories. Do not delete normal pnpm links, follow them automatically, or disable isolation checks. Browser-only tasks must not default to whole-repository `.`; required input documents need explicit read scopes.

隔离范围包含符号链接时，应由业务父会话核对剩余工作并缩小必要读写范围；不能删除正常pnpm链接、自动跟随或关闭隔离检查。浏览器任务不能兜底扫描整仓`.`，输入文档须明确列入读取范围。此次仅显示提示，不自动重派失败任务。

### 完整目标计划 → 绑定派发 → 验收进度

对已确认的多阶段目标，先 `graph_todo list`，再一次 `set` 完整计划；可选 `goal` 是用户确认的目标描述。每次 `set` 生成新的 `planId`，后续 `update/link` 保持它；旧 v1 记录仍可读取。不要把旧计划或旧聊天自动当作本轮目标。

```json
{"action":"set","expectedRevision":0,"goal":"实现并验收已确认的改动","items":[{"id":"build","title":"实现","status":"pending","assignee":"developer"},{"id":"review","title":"独立验收","status":"pending","dependsOn":["build"],"assignee":"reviewer"},{"id":"deliver","title":"主会话核对并交付","status":"pending","dependsOn":["review"],"assignee":"root"}]}
```

随后调用 `graph` 的 `start`，在 **GraphSpec 外层**添加：

```json
{"action":"start","spec":{"schemaVersion":3,"goal":"实现与独立验收","nodes":[{"taskId":"implement","agent":"developer","task":"已确认的实现合同","sideEffect":"shadow_write"},{"taskId":"verify","agent":"reviewer","task":"独立验收合同","sideEffect":"none","dependsOn":["implement"]}]},"todoBinding":{"expectedRevision":1,"bindings":[{"todoId":"build","taskIds":["implement"]},{"todoId":"review","taskIds":["verify"]}]}}
```

例中岗位名、任务合同、作用域及授权须替换为本项目真实配置；示例不新增权限。绑定预检在派发前拒绝过期 revision、无效 ID、已完成/未知状态、已有 Graph links 的计划项。已有 links 的工作先核对旧结果，只把剩余工作建立新计划项，不清除记录或重跑。一个计划项可映射本次多个节点；同批计划依赖要求编译后的 Graph 中，每个下游节点都有通往所有相应上游节点的 accepted 依赖路径。

成功启动后，用真实 `graphId/runInstanceId/taskId` 一次 CAS 批量追加 links，不把子进程退出当成验收。`graph_todo list` 持续读取 Graph accepted 证据派生进度；主会话完成自己的交付项后，再按当前 revision 显式 `update`。人工状态与 Graph 验收来源分别显示。

Graph 存储与 Pi 会话记录不是跨存储原子事务。若启动已完成、关联保存未确认，工具返回**已启动、不可重派**的部分成功回执与真实运行身份；折叠和展开回执都提示先 `graph status/result`、`graph_todo list` 核对，再人工修复 links。系统不会因关联失败重启、自动停止或跨分支补写；用户明确 Escape 仍停止对应任务。相同 toolCall 复用已提交回执，不启动第二次。

每轮只读计划摘要有项数/总字符上限，优先 root/parent 未完成项，再其他未完成项；已完成计划明确属于历史。标题和目标仅作为不可信数据，不是新指令或授权；摘要不读取旧聊天、不调用 Host、不写会话。子 Agent 不获得此父计划指导。旧 `start` 不带绑定仍兼容：若有未完成计划，只提醒未关联，不自动修改它。

The parent plan is explicit: `list → set(goal, items) → graph start.todoBinding → list derived acceptance → update parent-owned work`. Bindings are outside GraphSpec and never reach children. A committed Graph with an unconfirmed plan append is a partial success with `started:true` and `canRetry:false`, not permission to replay. Existing linked items cannot start a second run. Completed plans are history; the bounded per-turn snapshot is untrusted read-only data, never authority for a new objective.

### 可读待办与安静回执

待办默认展开，每个任务独立一行；`Alt+T` 收起，`Alt+Shift+T` 查看详情。优先展示总计划中的明确标题；没有总计划时，仅显示“当前任务（未建总计划）”，从同一运行经过身份与摘要核验的授权记录读取目标。多节点缺少精确标题时标明岗位分工概括；目标缺失则明确“目标待补充”，不会拿内部任务编号或任务提示词冒充标题。内部 ID 仍在详情中可查。小窗口优先保留任务及溢出提示，不挤掉编辑器。

正常且身份、节点覆盖、监管证据齐全的 start/wait 回执默认不占行（包括等待中的流式更新）；展开仍可查看。失败、阻塞、用户输入、历史监管异常、退出证据、停止未确认、关联未确认/未绑定提醒及覆盖不完整始终保留。只改变界面，不改变原始工具内容、模型可见结果、计划绑定、Graph 验收或通知行为。

The Todo widget expands into readable task rows by default. Verified authorization goals supply display-only titles; unknown titles remain explicit. Healthy, fully covered start/wait receipts are quiet even during streaming; warnings remain visible, and expanded/raw receipts retain the original facts.

### Agent 与实际模型身份

默认成员栏优先保留规范 Agent 名和实际 `provider/model`，工具次数、时间和 token 只使用剩余空间。`Agent` 表示运行器已上报的实际岗位；只有计划/解析岗位时标为“分配Agent”，完全缺失则显示“Agent待上报”。模型只取实际观测值，缺失明确显示“实际模型待上报”，不会用请求或计划模型代替。

窄窗口可将两项身份拆成两行；高度有限时每项保留可读份额并用省略号标明截短，`Alt+R` 查看完整详情。只要至少有两行可用且存在工作与活动子Agent，待办和子Agent各保留一行；主会话状态与统计不能抢占子Agent的唯一身份行。更小的物理空间仅显示受限标记和详情入口，不承诺无法容纳的完整信息。正常工具回执静默规则不变，内部 taskId 不放回默认成员行。


### 只读定义与精简回执
只读检查使用 `readScope` 指明必要输入，不声明 `writeScope`。`writeScope` 仅适用于已有写入授权的 `local_write`，且必须提供 `validationCommands`。定义冲突会保留原错误码和字段并给出修正说明；不会自动删范围、升级权限或重试，也不说明已有 Graph 从未启动。
正常 start/wait 回执默认静默。监管 `unknown` 本身只表示尚无进展结论；已验收且确认正常退出也不作为警告。真实错误、探测失败、监管请求、退出或身份矛盾、覆盖不足仍显示简短中文提示。展开保留真实身份、用量和原始证据，成员栏继续显示实际 Agent 与模型。


### Todo 身份与完整宿主布局
关联 Todo 同时展示岗位与已上报的实际模型，已验收记录也保留；关联必须精确匹配当前会话、Graph、运行实例和任务，不从最近任务借模型。多成员保持身份配对并显示溢出数量；未启动/未上报明确区分，人工主会话待办不附加子模型。输入下仍只显示运行成员树。
仅由正常未完成前置产生的等待使用中性样式；人工阻塞、未知及真实错误仍提醒。依赖说明只出现一次。宿主会压缩上下组件，长草稿和其他组件在极小窗口可能挤掉整行；完整身份仍可从详情读取，不能保证8行窗口容纳全部内容。

### 有界的同模型请求续接

新准入的 continuation-v1 多候选任务冻结 `transientRetryLimit: 1`：整个 logical run 遇到明确的 assistant 请求超时或连接中断，只有会话已闲置、工具调用与结果完整配对、没有排队/晚到事件、用量已知且权限/部署/模型身份不变时，最多发送一次短继续消息。沿用同一会话、模型与思考级别，保留已完成工具记录，不重派原任务。额外请求计入原 token/cost/turn 预算；持久化预留后即消耗次数，停止或进程崩溃不退还，后续合法模型切换/checkpoint 不重置次数。SDK 内置重试仍关闭。

旧冻结计划未声明该策略时默认不启用；单候选、关闭备用的旧执行路径不自动获得续接能力。已经失败退出的历史 Graph 不迁移、不重跑；工具结果不明、进程异常退出、用户停止、权限或硬预算失败仍拒绝。此功能不保证上游服务不再超时，也不承诺外部副作用恰好一次；重复工具 ID 在执行前拒绝，未知结果不能据此重试。


### TODO 生命周期与历史义务

`graph_todo` 的原 v1 计划仍兼容。`list` 返回当前义务与有界历史摘要；`history` 支持 `offset`、`limit`（最多 8 个旧计划）并返回 `nextOffset`，完整旧项不会每轮注入上下文。计划和生命周期使用各自的 revision，操作只写 Pi 原生会话元信息，不修改 Graph 的验收、权限或进程。

`lifecycle` 入口使用 `planEntryId`、`expectedRevision`、`expectedLifecycleRevision`；`show/hide` 只管显示，`defer/not_needed/restore` 配合叶 ID 与原因调整当前归属；`replace` 使用 list/history 返回的旧、新叶引用及 `identityDigest`，只有同一运行/attempt 的新验收覆盖成立才将原义务移到历史。新失败、未知写入效果、仍待执行的关联任务不会被接替或隐藏洗成成功。`restore` 撤销该叶的范围结论和接替关系，不重跑任务。

普通成功不要求逐项确认：本轮成功工具回执所观察的完整当前义务，在非空最终正文正常结束后重新核对一致，才记为交付并隐藏本目标；其他目标、未关联执行和未知风险仍保留入口。未交付的失败、受阻和待核实任务默认保留当前列表，Alt+T 仍可展开；只有明确 `hide` 或 `explain` 收起意图才使用摘要，普通问题计数不会自动隐藏任务。只有明确的 `explain` 原因意图及该工具成功返回、正常正文交付才记为已说明，已说明不等于已解决。`explain` 仅支持当前目标，历史目标会在写入前拒绝，需先明确整理当前目标。Inspector 的 `h` 查看历史摘要，`v` 恢复当前计划显示；工具 `show` 可同样恢复。旧计划不会根据标题或新任务成功自动推断接替。

Lifecycle metadata is branch-scoped and separate from Graph facts. A successful, nonempty final response can acknowledge an exact successful plan observation; it cannot authorize retries or accept unknown side effects. History, scope changes and replacement are explicit, reversible metadata operations. Inspect `graph_todo history` for paged evidence and use lifecycle CAS revisions; hiding or cancelling an obligation never counts as successful execution.

若原生生命周期追加抛错，显示保持“保存未确认”；重新打开原生会话后核对实际记录，不自动重放该写入。仅重新list不会解除当前实例的不确定保护。

兼容边界：没有 `planId` 的旧 v1 记录仅按各自原生 entry 查看，不推断多个旧 revision 属于同一生命周期。需要长期接替/归属维护时，先显式 `set` 建立新计划周期，再精确关联旧义务；不会自动迁移旧聊天或永久继承无 ID 旧计划的归档状态。
