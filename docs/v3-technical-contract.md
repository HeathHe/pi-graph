# pi-graph V3 技术合同（Phase 0.2 归一化）

> 范围：本文档只定义合同，不实现代码。约束：禁止修改 src/ 与 extensions/，禁止开始 child dispatch，禁止删除治理代码。
> 本文档是 V3 的唯一技术合同；`docs/product-definition.md` 是产品合同。二者冲突时以本文档为准，发现冲突必须修订本文档或本条款。

## 1. 三个版本轴（归一化）

| 轴 | 载体 | 现有版本 | V3 目标 |
|---|---|---|---|
| Runtime | run 目录 `snapshot.json` | V1（基础）、V2（+runInstanceId/planningAdmissionId/lifecycleRevision/fencingGeneration） | **V3：snapshot schemaVersion 3**（新运行只写 V3） |
| AuthorizationRecord | run 目录 `authorization.json` | v2（legacy 无收据）、v3（强制 PlanningReceipt 绑定） | **V4：authorization schemaVersion 4，且带 `runtimeSchemaVersion: 3`**；旧 v2/v3 字节不变 |
| PlanningReceipt | authorization.json 内嵌 / 规划门签发 | schemaVersion 2 | 不再签发、不再校验、不写入新运行；旧 receipt 原样保留 |

**合法格式组合（唯一识别规则）**：

| 组合 | 判定 | 处理 |
|---|---|---|
| snapshot-v1 / 无 authorization.json | legacy-readonly | 只读展示，不恢复 |
| snapshot-v2 + authorization-v2 或 v3 | legacy | 按 §6 冻结 writer 策略 |
| snapshot-v3 + authorization-v4（runtimeSchemaVersion=3） | V3 | 按 V3 恢复语义 |
| 其他任何组合（版本缺失/混搭/未知） | invalid | **needs_attention，不重写、不迁移、不猜测** |

## 2. GraphSpec V3 schema

顶层：

```ts
interface GraphSpecV3 {
  schemaVersion: 3;              // 必填，字面量 3
  graphId?: string;              // 缺省：调用时生成
  goal: string;                  // 必填，非空，≤2000 字符
  nodes: GraphNodeSpecV3[];      // 必填，≥1，taskId 唯一
  maxConcurrency?: number;       // 缺省 2；上限受 settings.graph.maxConcurrency 约束
  failFast?: boolean;            // 缺省 false
  workspace?: "auto" | "shadow" | "git"; // 缺省 "auto"
}
```

节点：

```ts
interface GraphNodeSpecV3 {
  taskId: string;                // 必填，^[a-z0-9][a-z0-9-]*$，图内唯一
  agent: string;                 // 必填，运行时 preflight 校验存在性
  task: string;                  // 必填，非空
  dependsOn?: string[];          // 缺省 []；必须引用图中已有 taskId，禁止环
  inputArtifacts?: string[];     // 缺省 []；必须是上游 outputArtifact
  outputArtifact?: string;       // 缺省：编译器生成确定性内部产物（`<graphId>/<taskId>/out` 命名规则，稳定可推导）
  readScope?: ScopeEntry[];      // 缺省 []；仅读，Guard 强制
  writeScope?: ScopeEntry[];     // 缺省 []；写范围，冲突规则见 §4
  sideEffect: "none" | "local_read" | "local_write"; // 必填；external_read/external_write 暂不进入 V3（见 §2a）
  timeoutMs?: number;            // 缺省：**无隐式任务 deadline**（超时只在节点显式声明时存在）
  retryPolicy?: {                // 缺省 { maxAttempts: 1, retryOn: [], backoffMs: 5000 }
    maxAttempts: number;         // 1..5
    retryOn: Array<"task_failed" | "validation" | "timeout" | "workspace_conflict">; // 缺省 []
    backoffMs: number;           // ≥0，缺省 5000
  };
  acceptance?: string;           // 可选；自然语言声明，默认仅记录不参与判定
  validationCommands?: string[]; // local_write 必填非空，见 §3
  childAcceptance?: {            // 可选；显式配置才参与判定，不能替代 validationCommands
    criteria: string[];
    reviewer?: "child" | "supervisor"; // 缺省 "child"
  };
}
```

### 2a. sideEffect 白名单（V3 MVP）

- 允许：`none`、`local_read`（外部读取工具禁用，仅本地读）、`local_write`。
- `external_read` / `external_write` **暂不进入 V3**：编译器拒绝并提示"V3 MVP 未开放外部副作用"。
- retryPolicy 不再有 provider/model 专属项（maxProviderRetries、providerBackoffMs、modelDegradations 全部删除）；V3 对提供方瞬时失败一律由 failure 分类记录，不自动换模型/换通道。

### 2b. 旧字段兼容策略（V1 字段 → V3）

| 旧字段 | 策略 |
|---|---|
| `model` / `thinking` / `resolvedModel` | V3 拒绝（治理专属；resolvedModel 从来只是运行时溯源） |
| `routingProfile` / `taskRisk` / `producerRefs` / `maxAuthorization` | V3 拒绝，错误信息注明"治理字段已退出核心" |
| `retryPolicy{maxProviderRetries,providerBackoffMs}` | V3 拒绝（见 2a）；`maxAttempts` 升为 retryPolicy.maxAttempts |
| `contractPolicy` | V3 拒绝；strict 语义并入本 schema |
| `context` / `cwd` | V3 拒绝（由调用环境确定） |
| `toolBudget` / `priority` / `resourceClass` / `allowDelete` / `allowBash` | V3 拒绝；allowBash 永远非法 |
| `readScope` / `writeScope` | 保留，语义不变 |

拒绝策略统一：编译期报错，错误对象含 taskId 与字段名；不静默剥离。

## 3. local_write 验证规则

1. `sideEffect: "local_write"` 的节点，`validationCommands` 必须非空且全部通过 `validateValidationCommand`（白名单、无 shell、路径与内联执行拒绝、git 只读子命令、npx --no-install）。
2. **childAcceptance 不能替代 validationCommands**：它是语义复核附加层；只有 validationCommands 全部通过，写范围才 apply 到源工作区。
3. 非 local_write 节点不强制验证命令；判定依据是声明的 sideEffect 与 writeScope。
4. `writeBaseline` 差分检查对所有节点无条件执行：只覆盖声明范围，不宣称全工作区防线；超范围写由 Guard 拒绝。
5. 验证命令执行安全（V3 补全，基于现状 gap）：
   - 已有：可执行白名单、shell:false、64KB 输出截断、NUL/路径逃逸/内联求值拒绝。
   - V3 必须补：总超时（默认 300s，受 settings.graph.validationTimeoutMs 约束）、stdout/stderr 各自封顶并记录截断标记、ValidationResult 增加 `signal` 字段。
   - 明确非沙箱：验证命令不是 OS 级安全边界，只是可复验的验收锚点。

## 4. 写冲突规则

1. 两节点存在拓扑依赖且 writeScope 重叠 → 合法，顺序执行。
2. 两节点无拓扑依赖且 writeScope 重叠 → 编译拒绝，错误含两个 taskId 与重叠路径。
3. 同一节点内 writeScope 条目互不重叠。
4. `readScope` 与任意节点 `writeScope` 重叠：依赖关系保证顺序则合法；无序则编译拒绝。
5. 运行时防线：源工作区 apply 前重验冲突；图运行期间主会话的手动编辑由 apply 冲突检测报告，不静默覆盖。

## 5. V3 权威证据 schema

`authorization.json` 只表示**不可变图级 admission**（授权信封 + 编译投影 + 图级 digest），不承载 attempt 级状态。V3 文件布局：

| 文件 | 路径 | 职责 | digest 关系 |
|---|---|---|---|
| `authorization.json` | run 根 | 图级 admission：authorization v4 + runtimeSchemaVersion 3；含 `graph`（编译投影）、`graphDigest`、`sourceGraphSpecDigest`、`sessionId`、`createdAt`。**无 planning 字段，无 attempt 状态** | 自含 graphDigest（编译投影的 canonicalDigest） |
| `attempt.json` | `nodes/<taskId>/attempt-<n>/` | 单次 attempt 状态与分发事实（attemptNonce、phase、requestDigest、launchContractDigest、extensionContentDigest、terminalStatus） | 引用 workspace contractDigest；被 authorization 图级链条以外独立校验 |
| `workspace.json` | 同上 | 工作区记录（workspaceKind、workspaceDir、writeBaseline/readBaseline/inputBaseline） | 自带 contractDigest；attempt.json 引用它 |
| `validated-result.json` | 同上 | 验证结果（V3 替代 result-manifest.json）：validation 数组（含 exitCode/signal/截断标记）、writes digest、失败分类 | 自带 schemaVersion + attempt 绑定；acceptance 判定的输入 |
| `acceptance.json` | 同上 | 验收记录：acceptance 文本、判定（declared / machine-verified / child-acceptance）、判定时间、Supervisor 签名 | 引用 validated-result digest 与 attempt.json digest |
| `snapshot.json` | run 根 | 可恢复投影（从 authority + attempt 文件重建的冗余快照） | 投影（损坏可重建，不以它做独立裁决） |
| `events.jsonl` | run 根 | append-only 观测日志（见 §8） | 观测（永不用于裁决） |

不变式：digest 链从 graphDigest（authorization）→ attempt 事实 → validated-result → acceptance 单向引用；snapshot 与 events 都不得反向作为裁决输入。

## 6. 恢复矩阵与 legacy 策略

### V3 运行恢复

每次恢复**现场验证**：digest 链、owner/child 身份（进程身份 + 会话身份）、版本兼容、runtime 能力。全部通过才自动续跑；任一不满足 → needs_attention。**不设 evidenceComplete 布尔裁决**——恢复判定只能来自现场验证结果，不能信任持久化的"完整"标记。不承诺任何崩溃自动续跑，不是 exactly-once。

### 旧运行（legacy）策略

| 版本 | 允许的操作 |
|---|---|
| snapshot-v1（无 authority） | **不 resume**；只读展示 |
| snapshot-v2 + auth-v2/v3 | 只允许：监控已知 child、完成 validated / applying 中的转换。**禁止新派发、重路由、模型降级、新 retry** |
| 其余状态/组合 | needs_attention |

为允许的转换保留**隔离的冻结 legacy writer**：它只能写 legacy 格式的终态转换（validated/applying → 终态），不实现任何新逻辑，不再称为"只读恢复"。

### 状态恢复矩阵

| 状态 | 动作 |
|---|---|
| queued / running（V3，现场验证全过） | 自动续跑 |
| complete / stopped / failed（终态） | 只读展示 |
| paused / waiting_input | 等待原会话或用户显式 resume；不自动推进 |
| **dispatch_unknown（节点或 provider dispatch 状态不明）** | **一律 needs_attention，禁止盲目重派**；人工确认"未逃逸"且证据一致才允许继续 |
| authority 缺失 / digest 不匹配 / 身份不可确认 / 版本不兼容 | needs_attention，不重写、不迁移、不猜测 |
| 锁/租约陈旧（SIGKILL 遗留） | 按租约到期规则释放后重取；释放前提与 authority 证据一致 |

## 7. 默认隐形与 disabled 合同

`graph.enabled=false` 时：

1. 不恢复（不 adopt、不续跑任何 run）；
2. 不维护（不跑 retention/维护任务）；
3. 不启动后台任务（不注册 background-work、不创建会话）；
4. 不建运行目录（不创建 runsDir 及任何 run 骨架）；
5. 不通知（不产生 UI notify）；
6. 不联网（零网络请求）；
7. graph 工具动作返回文档化 disabled 错误；不注入任何 gate prompt、不读取治理配置。

可测试定义：普通会话（direct / 纯读工具 / 本地工具 / subagent 四种任务）在 enabled=true 与 enabled=false 下分别跑差分 E2E，断言两者行为差异仅在于 graph 工具动作的可用性（disabled 错误 vs 可用），其余工具调用数、日志行数、网络请求数**完全一致**。

## 8. Thin shadow 事件 schema

只保留 Graph 内部执行事实，**无规划来源、无自由文本归因**：

```ts
interface V3Event {
  seq: number;
  at: string;                   // ISO8601
  type: "graph.created" | "graph.admitted" | "node.started" | "node.attempt"
      | "node.validation" | "node.terminal" | "graph.terminal" | "graph.recovered";
  graphId: string;
  taskId?: string;
  data: {
    submitterSessionId?: string;
    graphSpecDigest?: string;
    graphSpecSummary?: { nodeCount: number; edgeCount: number };
    attempt?: number;
    validation?: { command: string; ok: boolean; exitCode: number | null; signal?: string };
    status?: string;
    reason?: string;            // 机器可枚举错误码
  };
}
```

禁止项：无 planner/plannerAttribution/provenance_note 字段；无任何读取方消费 events 做决策；缺失即缺省，不写推断占位；离线诊断工具可读。

## 9. 模块、扩展与命令枚举

**core（V3 主线保留）**：`types.ts`、`compile.ts`、`config.ts`、`validation.ts`、`executor.ts`、`store.ts`、`snapshot.ts`、`durable.ts`、`failure.ts`、`lifecycle.ts`、`manager.ts`、`runner.ts`、`child-runtime.ts`、`rpc.ts`、`workspace.ts`、`retention.ts`、`doctor.ts`、`leases.ts`、`claims.ts`、`reservations.ts`、`reconciler.ts`（治理依赖移除后）、`pi-subagents-compat.ts`。

**pi-subagents-preflight.ts 拆分**：
- 留核心：Agent 存在性检查（resolveManagedAgentDefinition 的 agent 解析）、公共 RPC 检查（resolveSubagentLaunchContract / resolveCurrentSubagentCapabilityCeiling 存在性与可调用）、Extension/Guard seal（graphGuardRuntimeDigest、packageRuntimeContentDigest、contentTreeDigest、packageLockFor）。
- 归档（模型路由专属）：AvailableModelSnapshot、modelCandidates 校验与"恰好一个 sealed model"路由断言、审计输出中的路由字段。

**authority.ts 拆函数**：执行账本 schema + digest 工具留 core（更名 authorization.ts）；规划收据校验与硬编码模型表随治理归档。

**legacy-compat（V3 新增）**：V1/V2 snapshot/authorization 与旧 PlanningReceipt 的冻结解析器 + §6 冻结 legacy writer；只写允许的终态转换。

**archive（git 归档，不留在主线）**：`model-routing/`、`subagent-router/`、`model-routing-adapter.ts`、preflight 的路由专属函数段、`recommend.ts`、authority 的治理函数段、`extensions/subagent-model-router.ts`、治理系测试文件（R1 规则机械决定）。

**保留扩展**：`extensions/pi-graph.ts`、`extensions/pi-graph-guard.ts`。
**保留命令/动作**：`graph { start, status, list, stop, resume, doctor }`；`/graphs` 对应收敛；`assess_task`、`plan_graph`、`review_graph_spec`、`recommend` 随治理移除。

## 10. 依赖通道

- **certified**：devDependencies 固定 `pi-subagents@0.49.0`；`npm ci` + `npm run check` + `npm test` + `npm run pack:check` 为正式基线。
- **drift（非阻塞）**：`.github/workflows/pi-subagents-latest.yml`（`npm install --no-save pi-subagents@latest` + `test:latest-integration`）；drift 失败不阻塞合并，只产生报告。
- peerDependencies 范围（`>=0.40.0`）不变；运行时兼容以公共 RPC 契约为准。

## 11. 测试 manifest 规范

产物 `docs/v3-baseline-manifest.json`：

```json
{
  "manifestVersion": 1,
  "baseline": { "testedCommit": "<sha>", "archiveTag": "v1-governed", "lockHash": "<sha256 of testedCommit's package-lock.json>" },
  "environment": { "node": "<v>", "npm": "<v>", "os": "<os.release()>", "arch": "<arch>" },
  "channels": { "piSubagentsCertified": "0.49.0", "piSubagentsDrift": "latest" },
  "checks": { "dependencies": { "package.json": "0.49.0", "package-lock": "0.49.0", "node_modules": "0.49.0" } },
  "check": { "command": "npm run check", "exitCode": 0 },
  "tests": { "perFileTap": {...}, "fullSuite": { "command": "npm test", "officialTotal": 519, "pass": 519, "fail": 0 } },
  "pack": { "command": "npm run pack:check", "exitCode": 0 }
}
```

生成工具 `scripts/v3-baseline-manifest.ts` 的硬性规则：
- os 用 `os.release()`，arch 独立字段；
- 校验 package.json、package-lock.json、node_modules 三处 pi-subagents 均为 0.49.0，任一不符即失败；
- `lockHash` 必须等于 **testedCommit**（`git show <commit>:package-lock.json`）的内容哈希，不是工作区文件；
- 同时记录 per-file TAP（层级测试名）与 full-suite 519/519 官方统计。
