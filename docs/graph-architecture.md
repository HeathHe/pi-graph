# pi-graph 架构详解

`pi-graph` 是 Pi 的持久化 DAG 执行引擎：把父级 Agent 提交的 GraphSpec 编译成一个有向无环图，为每个节点启动独立的 `pi-subagents` 异步子 Agent，持久化每一次状态迁移，隔离写入，做确定性验证，只有 Supervisor 判定 `ACCEPTED` 的节点才能解锁下游。

它**故意不做**：是否该用 Graph 的判断、目标拆解、模型选择、上下文搜索。这些是 `agent-workflow` 和父级 Agent 的职责。

---

## 一、分层结构

| 层 | 文件 | 职责 |
|---|---|---|
| 入口 | `extensions/pi-graph.ts` | 注册 `graph` 工具（start/status/list/stop/resume/doctor）与 `/graphs` 运维命令；向 pi-subagents 注册 background-work provider，防止 headless 会话在节点间退出 |
| 护栏 | `extensions/pi-graph-guard.ts` | 注入子 Agent workspace 的策略护栏；默认 `allowBash:false`，路径类工具限制在声明 scope 内，畸形合同 fail closed |
| 管理 | `src/manager.ts` (`GraphManager`) | 图级生命周期：start/stop/resume/list、session_start 认领本会话的活跃图、session_shutdown 挂起监督、维护任务 |
| 编译 | `src/compile.ts` | GraphSpec → CompiledGraph：路径 canonicalize（realpath、禁止逃逸 cwd）、DAG 无环检查、**编译期拒绝 writeScope 重叠的并行节点** |
| 调度 | `src/runner.ts` (`GraphRunner`) | DAG 主循环：并发控制（默认 2，只读突发 3）、`resourceClass` 车道限流、provider 冷却、重试调度（业务 `maxAttempts` 与 `maxProviderRetries` 分离） |
| 执行 | `src/executor.ts` (`NodeExecutor`) | 单节点单 attempt 的完整状态机（见下） |
| 隔离 | `src/workspace.ts` | git 仓库用 detached worktree，其他用 shadow workspace；写入先落在隔离区，验证通过后才回放源仓库 |
| 验证 | `src/validation.ts` | `validationCommands`：argv 无 shell 执行、可执行文件白名单、禁止内联解释器载荷与路径逃逸 |
| 派发 | `src/rpc.ts` + `src/child-runtime.ts` | 通过 pi-subagents RPC 派发 async 子 Agent；dispatch ledger + lineage + nonce 保证"派发结果未知时查找/保护，绝不盲目重发" |
| 持久化 | `src/store.ts` (`GraphStore`) | 原子写 + fsync（文件与父目录）；`snapshot.json` 投影、`events.jsonl` 观测、attempt/acceptance 权威记录 |
| 一致性 | `src/claims.ts` / `leases.ts` / `reservations.ts` | fencing claim（PID+进程启动身份）防两个会话同时监督同一张图；写 scope 有内存 lease + 跨进程 source reservation 两级保护 |
| 恢复 | `src/reconciler.ts` | 崩溃后从证据链重建可信投影；证据缺失/矛盾时创建受保护 incident 而不是猜 |
| 运维 | `src/doctor.ts` / `src/retention.ts` | 只读体检；历史压缩、Trash 宽限期删除、存储报告 |

---

## 二、流程图：从 graph 工具调用到 ACCEPTED

![pi-graph 主流程图](images/pi-graph-flowchart.png)

```mermaid
flowchart TD
    A["父级 Agent 调用 graph 工具<br/>{ action: start, spec }"] --> B["extensions/pi-graph.ts<br/>GraphManager.start"]
    B --> C["src/compile.ts<br/>编译期静态校验"]
    C -->|路径逃逸 / 环 /<br/>写范围重叠| CX["GraphCompileError<br/>拒绝"]
    C -->|通过| D["src/store.ts<br/>创建 run 目录<br/>~/.pi/agent/graph-runs/&lt;graphId&gt;/"]
    D --> E["src/runner.ts GraphRunner.run<br/>获取 Supervisor fencing claim"]
    E --> F{"DAG 主循环<br/>reconcile + canStart"}

    F -->|"依赖全部 ACCEPTED<br/>且有并发容量"| G["src/executor.ts<br/>NodeExecutor.execute"]
    G --> H{"有 writeScope?"}
    H -->|是| I["获取 lease +<br/>source reservation"]
    H -->|否| J
    I -->|被占用| RW["resource_wait<br/>1s 后重试"]
    RW --> F
    I -->|获得| J["prepareWorkspace<br/>git worktree 或 shadow<br/>拷贝 input artifacts"]
    J --> K["写入 recovery-handoff.md<br/>（若是重试 attempt）"]
    K --> L["leased → dispatching<br/>写 attempt authority +<br/>dispatch ledger"]
    L --> M["child-runtime 派发<br/>pi-subagents async 子 Agent"]
    M -->|RPC 超时| LU{"resolveDispatch<br/>找回同一 attempt?"}
    LU -->|找不到| ST["stale<br/>绝不盲目重发"]
    LU -->|找回| N
    M -->|成功| N["running<br/>等待子 Agent 完成"]
    N -->|子 Agent failed| F1["classifyChildFailure<br/>区分 provider/dispatch/<br/>timeout/validation"]
    N -->|complete| O["collecting<br/>校验 output artifact<br/>必须是常规文件、不逃逸"]
    O --> P["verifying<br/>runValidations<br/>确定性验证命令"]
    P -->|验证失败| F2["failed<br/>retryKind=validation"]
    P -->|通过| Q["写 validated-result.json<br/>记录 outputDigest"]
    Q --> R["workspace.apply<br/>隔离区写回源仓库<br/>（多文件 v2 plan + 备份 + 断点恢复）"]
    R --> S["原子 rename 发布<br/>attempt 私有输出 → artifacts/"]
    S --> T["写 acceptance 记录<br/>manifestDigest + outputDigest"]
    T --> U["ACCEPTED<br/>解锁下游节点"]
    U --> F

    F1 --> RT{"可重试?<br/>retryOn + maxAttempts /<br/>maxProviderRetries"}
    F2 --> RT
    RT -->|是| RJ["retry_wait<br/>指数退避<br/>provider 同车道冷却"]
    RJ --> F
    RT -->|否| FT["failed / blocked<br/>下游级联 blocked"]

    F -->|"全部节点 terminal"| Z{"汇总图状态"}
    Z -->|全部 accepted| Z1["complete"]
    Z -->|有 stale / dispatch_unknown| Z2["needs_attention"]
    Z -->|有 failed| Z3["failed"]
```

---

## 三、流程图：崩溃恢复（resume / session_start 认领）

```mermaid
flowchart TD
    A["graph resume / session_start"] --> B["GraphManager 校验<br/>fencing claim 归属"]
    B --> C["reconciler.loadOrRebuildValidatedRun<br/>校验 V2 证据链"]
    C -->|证据缺失/矛盾| INC["受保护 incident<br/>不猜、不自动重建"]
    C -->|证据一致| D["GraphRunner.run 恢复"]
    D --> E{"逐节点检查最新 attempt"}
    E -->|authority 已 accepted| P1["直接投影为 ACCEPTED"]
    E -->|authority 到 validated/applying| P2["从 validated-result.json<br/>续跑 finalize（apply→发布→验收）"]
    E -->|running/dispatching| P3["resolveDispatch 找回<br/>子 Agent 身份，原地监控"]
    E -->|找回失败/身份歧义| P4["stale<br/>不创建替代 attempt"]
    E -->|collecting/verifying 且输出已存在| P5["从本地输出继续验证"]
    P1 --> F["继续 DAG 主循环"]
    P2 --> F
    P3 --> F
    P5 --> F
```

---

## 四、脑图：模块全景

![pi-graph 模块脑图](images/pi-graph-mindmap.png)

```mermaid
mindmap
  root((pi-graph<br/>持久化 DAG 执行))
    入口层
      graph 工具
        start / status / list
        stop / resume / doctor
      /graphs 运维命令
        doctor / storage / maintain
        pin / archive / compact
        delete / trash / restore / purge
      pi-graph-guard
        子 Agent 工具护栏
        allowBash 默认关闭
    编译层 compile.ts
      路径 canonicalize
      DAG 无环检查
      writeScope 重叠拒绝
      external_write 拒绝（V2）
    调度层 runner.ts
      DAG 主循环
      并发控制
        默认 maxConcurrency 2
        只读突发 3
        resourceClass 车道
        provider 冷却
      重试策略
        maxAttempts 业务重试
        maxProviderRetries 独立
        指数退避上限 300s
      failFast
      durable stop
    执行层 executor.ts
      attempt 状态机
        leased → dispatching
        running → collecting
        verifying → accepted
      recovery-handoff.md
      Result Manifest
      先验证后发布
    隔离层 workspace.ts
      git detached worktree
      shadow workspace
      apply 回写
        v2 plan + 全量预检
        digest 备份
        中断恢复
      baseline 指纹防陈旧
    派发层
      rpc.ts
        pi-subagents RPC 客户端
        async run 身份校验
      child-runtime.ts
        attempt nonce
        dispatch ledger
        lineage 血缘
        防重复派发
    持久化层 store.ts
      原子写 + fsync
      snapshot.json 投影
      events.jsonl 观测
      authority 权威记录
    一致性
      claims.ts fencing
        PID + 进程启动身份
        防多会话监督
      leases.ts 内存写锁
      reservations.ts
        跨进程源事务预留
        事务门 + 历史归档
    恢复层 reconciler.ts
      证据链校验
      终态投影重建
      受保护 incident
    运维层
      doctor.ts 只读体检
      retention.ts
        压缩 → Trash 宽限 → 清除
        5GiB 软上限
      config.ts 配置加载
```

---

## 五、关键设计决策

1. **Graph 只执行给定的 DAG**。路由、拆解、模型选择留在 `agent-workflow` / 父级 Agent；Graph 不自行扩张目标，也不替代 pi-convergence。
2. **ACCEPTED 是唯一的解锁信号**。一个节点必须同时满足：子 Agent 完成 + 确定性验证通过 + workspace 变更回放完成 + Result Manifest 生成。下游通过 `inputArtifacts` 消费已发布产物，不能在任务正文里隐式依赖未验收结果。
3. **先隔离、先验证、后发布**。子 Agent 的写入发生在 worktree/shadow 隔离区；输出先落 attempt 私有路径，验证通过后才原子 `rename` 到 `artifacts/`。失败的 workspace 变更永不自动应用。
4. **派发宁可 stale 不可重复**。一旦派发可能已经逃逸（RPC 超时、进程崩溃），同一 attempt 只能被查找或保护，绝不盲目重发——配合 nonce、dispatch ledger、lineage 实现。
5. **权威在证据，不在投影**。Runtime V2 中 `authorization.json`、attempt 记录、validated result、acceptance 记录是权威；`snapshot.json` 是可重建投影，`events.jsonl` 只是观测。恢复时证据缺失或矛盾就创建受保护 incident，绝不猜测。
6. **监控无隐式 deadline**。子 Agent 只有在节点显式声明 `timeoutMs` 时才因耗时被杀；资源等待可观测但不杀活跃子 Agent。
7. **provider 故障与业务故障分离**。`maxProviderRetries` 独立计数、独立指数退避，同 `resourceClass` 车道的其他节点会被冷却暂停，但不挤占业务 `maxAttempts`。

## 六、验证方式

- `npm test`：确定性回归套件（编译、快照、租约、保留策略、RPC 生命周期、失败分类等）。
- `npm run test:soak`：60 秒长任务场景 + 挂起/恢复 + 写冲突压测；用确定性模拟子 Agent，不消耗模型配额。
- `PI_GRAPH_SOAK_MS=300000 npm run test:soak`：延长到约 5 分钟（合法区间 15 秒 ~ 30 分钟）。
