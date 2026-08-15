# pi-graph 产品定义 v3（定稿）

> 状态：第 0 阶段定稿。本文档是后续重构的合同，任何偏离必须先修改本文档。
> 基线：main @ d64c87f（tag `v1-governed`），pi-subagents 0.49.0，tsc 通过，519/519 测试全绿。

## 一句话定义

**pi-graph 是默认不干预普通会话、仅由调用方显式提交 GraphSpec 创建运行的单机持久化 DAG 执行器。它按依赖执行节点、隔离工作区、验证本地写入并持久化执行证据；证据充分时可在同机同仓库安全恢复，否则进入 needs_attention。它不判断是否使用 Graph、不拆解任务、不选择模型，也不观察普通 turn 或 subagent。**

## 目标（做什么）

| 职责 | 精确含义 |
|---|---|
| 编译 | GraphSpec → 校验后的 DAG（拓扑排序、环检测、依赖/产物检查）；非法输入给结构化错误 |
| 调度 | 按拓扑依赖执行，遵守并发上限与重试策略；不承诺配额、优先级或跨机调度 |
| 隔离 | 工作区隔离：节点在声明范围内写入，writeBaseline 差分检查覆盖全部节点；这是 Pi 工具边界，**不是 OS 级安全沙箱** |
| 验证 | 本地写入节点必须配置确定性验证命令（白名单可执行、shell:false、总超时、字节级输出上限、signal/终止原因可观测）；纯读节点只需执行成功；自然语言 acceptance 默认仅作声明，不参与判定，除非显式配置机器验证或 childAcceptance |
| 持久化 | 每次状态迁移落盘（原子写）；运行事件 append-only 记录执行事实 |
| 恢复 | 证据完整、进程身份可确认、版本兼容时同机同仓库安全恢复；否则停止并进入 needs_attention。**不承诺任何崩溃自动续跑，不是 exactly-once** |
| 守护 | Guard 限制 Pi 工具边界（文件/工具白名单）；子 Agent shell 继续禁用；runner 验证命令使用窄能力白名单 exec |

## 非目标（不做，且代码中不存在）

- 不判断是否使用 Graph、不拆解任务、不选择模型（这些是调用方职责）
- 不观察普通 turn 或 subagent——普通会话中 pi-graph 零工具调用、零日志、零网络
- 不强制任务评估、规划复核、模型路由、视觉证据——治理层（planning/routing/visual）退出核心
- 不承诺 OS 级沙箱；README 与文档禁用 sandbox 措辞
- 不读取治理配置（model-registry.json / routing-policy.json）；旧配置探测只存在于显式的 `graph doctor` / 迁移命令中
- 不制造归因证据：影子记录只记可客观核实的事实，缺失记 unknown，代码中无任何读取方消费影子记录做决策

## V3 契约

### GraphSpec 节点字段

必填：`taskId`、`agent`、`task`；可选：`dependsOn`、`inputArtifacts`、`outputArtifact`、`timeoutMs`、`retryPolicy.maxAttempts`、`writeScope`、`acceptance`（声明式）、`validationCommands`、`childAcceptance`。

规则：
- `local_write` 节点必须同时声明非空 `writeScope` 和非空、确定性的 `validationCommands`，否则编译失败；纯读节点豁免（判定依据：声明的 `sideEffect` 与 `writeScope`）。V3 MVP sideEffect 白名单：none / local_read / local_write。
- `childAcceptance` 只能作为 `validationCommands` 之外的附加语义复核层，不能替代机器验证命令。
- 无拓扑依赖且 `writeScope` 重叠的节点必须在编译期拒绝；存在拓扑依赖时允许按依赖顺序执行。
- 自然语言 acceptance 默认仅声明（declared），机器验证通过时才标 verified。

### 持久化与恢复语义

- 新 V3 运行：snapshot schemaVersion 3 + authorization schemaVersion 4（runtimeSchemaVersion 3）；authorization 只承载不可变图级 admission，attempt 级状态由 attempt.json / workspace.json / validated-result.json / acceptance.json 承载。
- 旧 V2/V3 证据保持原样，由冻结的 legacy 兼容层处理：V1 不 resume；V2 只允许监控已知 child、完成 validated/applying；禁止新派发、重路由、模型降级、新 retry；其余 needs_attention。
- 恢复判定只来自现场验证（digest、owner/child 身份、版本、runtime 能力），不信任持久化的完整性标记。

### 影子记录（thin shadow）

- 只记录 Graph 运行内部事实：提交者（sessionId）、GraphSpec digest/摘要、节点执行与工具调用事实、验收方式（machine-verified / declared）。
- schema 显式标记 unverified、append-only、有界保留；生产执行路径可写事件但**不读取事件影响决策**；离线诊断工具可读。
- 规划来源缺失记 unknown，禁止推断补全；`provenance_note` 可选自由文本，任何输出中永久标注 unverified。

## 兼容矩阵

| 运行版本 | 处理 | 说明 |
|---|---|---|
| V1 run（旧目录格式） | 只读展示，**不支持 resume** | 不迁移 |
| V2 run（含治理收据） | 冻结 legacy 策略：监控已知 child、完成 validated/applying；禁止新派发/重路由/降级/新 retry | PlanningReceipt 保持原样，不清空 |
| V3 run（snapshot v3 + auth v4） | 新 Graph 使用；现场验证后才恢复 | 恢复语义按技术合同 §6 |

## 验收清单

### 端到端测试（必须新增）

- **E2E-1 三节点图**：临时目录、真实 store/快照、不 mock；目录中不放任何治理配置文件。断言：退出码 0；产物字节级正确；依赖序满足（n2.start ≥ n1.end）；日志零次读取治理配置路径。
- **E2E-2 杀进程恢复**：三节点链，n2 延时；n1 completed 且 n2 running 时 SIGKILL；重启后断言 n1 副作用恰好一次、n2 至多重跑一次、全图 completed、store 完整性校验通过、无残留 lease 阻塞（陈旧锁接管）。
- **E2E-3 零配置安装**：干净目录 clone + `npm install`（node ≥22.19.0）；断言治理配置文件不存在、E2E-1 通过、运行期零治理配置读取（负向探针）、扩展加载清单 == 保留集。

### 职责与依赖消失判据

- D1 import 图：核心对归档模块集引用数为 0（tsc + 依赖图工具，覆盖 src/ 与 extensions/）。
- D2 扩展加载：`pi.extensions` 仅含保留入口，运行时加载清单逐项相等。
- D3 工具动作：注册动作集合与预期保留清单精确相等，无 routing/policy/recommend/gate 类动作。
- D4 门禁死亡探针：无规划凭据、无治理配置的提交上任务第一步不因门禁失败。
- D5 空会话隐形探针：加载扩展但不调用 graph 的空会话中，工具调用/日志/网络均为 0。

### 测试保留规则

- R1：测试随治理归档走当且仅当其 import 命中归档模块集；可移除 import 而不改变被测对象的核心测试留主线。
- R2：每个保留 src 文件至少被一个保留测试覆盖。
- R3：移除测试与被移除职责一一映射，映射表进 PR 可评审。
- R4：归档 tag 点 `npm test` 全绿；测试数量只报数、不断言。

### 遥测（不进验收门）

- 行数仅报告：核心落在 9–11k 属正常；≥15k 提示治理残留；≤6k 提示误删恢复/锁/隔离。
- 提交策略：禁止 +19k 行级单提交。

## 阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0（本阶段） | 文档定稿、基线建立、冻结 v1-governed | 本文档 + 基线记录 |
| 1 | V3 旁路内核：新 Graph 走 V3，旧运行兼容恢复 | 兼容矩阵 + E2E-1/2 首版 |
| 2 | 治理退出核心：门禁拆除、依赖清零（authority 拆函数、claims 保留核心） | D1–D5 全绿 |
| 3 | 治理代码 Git tag/分支归档（不留主分支 archive/ 目录） | R1–R4 + tag 点可构建可测试 |
| 4 | 文档收口：README、graph-architecture.md 重写与非目标对齐 | 文档与代码一致 |
