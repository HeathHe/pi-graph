# pi-graph

> **当前版本（current）：V3** —— 默认隐形、显式调用的单机持久化 DAG 执行器。
> 产品合同见 `docs/product-definition.md`，技术合同见 `docs/v3-technical-contract.md`；二者冲突时以技术合同为准。
> 治理层（planning/routing/visual）已退出核心并按 Phase 3 归档（`archive/governance-v2`）。

`pi-graph` 是 Pi 的单机持久化 DAG 执行器：调用方显式提交 GraphSpec，它按依赖执行节点、隔离工作区、验证本地写入并持久化执行证据；证据充分时可在同机同仓库安全恢复，否则进入 `needs_attention`。它为每个节点启动一个独立的 `pi-subagents` 异步运行，持久化每一次状态迁移，只有 Supervisor 判定 `ACCEPTED` 的节点才解锁下游。

**默认不干预普通会话。** 不调用 `graph` 工具的会话中，pi-graph 零工具调用、零日志、零网络（D5 探针）。它不判断是否使用 Graph、不拆解任务、不选择模型，也不观察普通 turn 或 subagent。

## 非目标（V3 明确不做，代码中不存在）

- 不判断是否使用 Graph、不拆解任务、不选择模型——这些是调用方（`agent-workflow` / 父级 Agent）的职责。
- 不观察普通 turn 或 subagent；普通会话中 pi-graph 不可见。
- 不强制任务评估、规划复核、模型路由、视觉证据——治理层已退出核心并归档。
- 不承诺 OS 级沙箱：工作区隔离与 Guard 是 **Pi 工具边界，不是操作系统安全沙箱**。
- 不读取治理配置（`model-registry.json` / `routing-policy.json`）；旧配置探测只存在于显式的 `graph doctor` / 迁移命令中。
- 不制造归因证据：不写规划来源、不写 unknown 占位、无任何读取方消费影子记录做决策。

## 兼容矩阵

| 运行版本 | 处理 |
| --- | --- |
| V3 run（snapshot v3 + auth v4） | 新 Graph 使用；现场验证后才恢复 |
| V2 run（含治理收据） | 冻结 legacy 策略：监控已知 child、完成 validated/applying；禁止新派发、重路由、模型降级、新 retry；其余 `needs_attention`。PlanningReceipt 保持原样，不清空 |
| V1 run（旧目录格式） | 只读展示，不支持 resume，不迁移 |

## Recommended configuration

`pi-graph` 不锁定或修补 `pi-subagents`。Pi 通过 `pi-subagents` peer dependency 提供当前官方运行时；运行时兼容性由公共 `subagents:rpc:v1` 能力合同决定，不按版本号相等判断。把下面的 `graph` 块粘贴进用户本地 `settings.json` 即可使用当前默认值：

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

这些值解析结果与 `parseGraphConfig({})` 一致。`runsDir` 故意省略，解析器使用当前 Pi agent 目录的 `graph-runs` 子目录，避免把机器特定路径写进共享配置。

## 使用

Graph 工具暴露的 action 精确为：`start`、`status`、`list`、`stop`、`resume`、`doctor`（无 `recommend`，无任何 gate 类动作）。`/graphs` 运维命令包括：`doctor`、`storage`、`maintain`、`pin`、`archive`、`compact`、`delete`、`trash`、`restore`、`purge`、`acknowledge`、`discard-control`、`discard-staging`、`discard-trash`、`resume`。

GraphSpec v3 节点必填：`taskId`、`agent`、`task`、`sideEffect`；可选 `dependsOn`、`inputArtifacts`、`outputArtifact`、`timeoutMs`、`retryPolicy.{maxAttempts,retryOn,backoffMs}`、`readScope`、`writeScope`、`acceptance`（声明式）、`validationCommands`、`childAcceptance`。

- `local_write` 节点必须同时声明非空 `writeScope` 与非空、确定性的 `validationCommands`，否则编译失败；纯读节点豁免。V3 sideEffect 白名单：`none` / `local_read` / `local_write`。
- 无拓扑依赖且 `writeScope` 重叠的节点编译期拒绝；有拓扑依赖时按依赖顺序执行。
- 自然语言 `acceptance` 默认仅声明（declared），机器验证通过时才标 verified；`childAcceptance` 只能作为 `validationCommands` 之外的附加语义复核层，不能替代机器验证命令。
- API key 只存在于用户本地 `auth.json` 或环境变量；推荐配置不含 `provider` / `model` 字段。

## Runtime contract

- GraphSpec 保持 schema v1；新运行使用 Runtime V2/V3（snapshot schemaVersion 3 + authorization schemaVersion 4），旧运行保持原样由冻结 legacy 兼容层处理，不做原地迁移。
- 每次状态迁移原子写落盘（文件与父目录 fsync）；`authorization.json` 只承载不可变图级 admission，attempt 级状态由 attempt 记录、validated result、acceptance 记录承载；`snapshot.json` 是可重建投影，`events.jsonl` 只是观测。
- 派发宁可 stale 不可重复：一旦派发可能逃逸（RPC 超时、进程崩溃），同一 attempt 只能被查找或保护，绝不盲目重发——配合 attempt nonce、dispatch ledger、lineage 实现。
- 恢复判定只来自现场验证（digest、owner/child 身份、版本、runtime 能力），不信任持久化的完整性标记；证据缺失或矛盾时创建受保护 incident 而不是猜。
- provider 故障与业务故障分离：`maxProviderRetries` 独立计数、独立指数退避；`maxAttempts` 是业务重试预算，二者不互相挤占。

## 存储与历史

Terminal 历史采用两阶段策略：先崩溃可恢复的事务压缩，再单次、digest 绑定地移到同盘 Trash。活跃运行、未确认的 `needs_attention`、开放事务、受保护 incident、被 pin 的运行、归档运行与不可验证 child 永不自动压缩或清除。`pi-subagents` 的存储单独报告，本包永不删除。

`autoPrune` 默认关闭。显式开启时，只有超过 180 天、且在最近 50 条之外、已压缩的 `complete` 或 `stopped` 运行才可清除；普通清除始终遵守 Trash 宽限期。跨过 5 GiB 软上限可能跳过宽限期，但只有 `autoPrune` 与独立的 `emergencyPurge` 同时显式开启才生效。

运维命令：

- `/graphs doctor`：检查证据与控制面健康；命令处理器本身不修改运行数据。
- `/graphs storage`：报告 Graph、Trash 与控制/恢复存储，不修改运行数据；孤儿清理暂存与中断的 `.initialize-*` 目录计入软上限。

## 验证

- `npm run check`：tsc 零错误 + 打包清单校验。
- `npm test`：隔离测试启动器（独立 TMPDIR）下的确定性回归套件，覆盖编译、快照、租约、保留策略、RPC 生命周期、失败分类、V3 内核与 E2E-1/E2E-2（SIGKILL 恢复）等。
- `npm run test:soak`：60 秒长任务场景 + 挂起/恢复 + 写冲突压测；用确定性模拟子 Agent，不消耗模型配额。
- `PI_GRAPH_SOAK_MS=300000 npm run test:soak`：延长到约 5 分钟（合法区间 15 秒 ~ 30 分钟）。

## Trust boundary

`pi-graph-guard` 是 Pi 工具的策略护栏，**不是操作系统沙箱**。派发前把有效 Agent 定义物化进隔离 workspace，并合并 Guard 到 `subagentOnlyExtensions`；路径类工具限制在声明 scope 内、畸形合同 fail closed、子 Agent shell 禁用（shell 解析无法对精心混淆的命令证明包含）。Supervisor 验证可执行可信项目测试，因此 GraphSpec 与仓库应被视为无人值守运行的受信输入。

持久化与路径检查覆盖进程崩溃、断电发布边界、陈旧 claim、静态符号链接与普通并发 Pi 进程。与其他用户态 Node 扩展一样，它不声称抵御以同一 OS 用户运行、能在两次系统调用之间持续替换文件系统对象的恶意进程；该等级的对抗保证需要 OS 沙箱或基于目录句柄的原生原语。
