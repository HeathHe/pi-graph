# Phase 3 治理归档矩阵（R1–R4）

> 依据 `docs/product-definition.md` Phase 3：治理代码 Git tag/分支归档，不留主分支 `archive/` 目录。
> 归档 tag：`archive/governance-v2`（指向 Phase 3 前最后一个全绿提交 `19e3a1c`，`npm test` 643/643 绿）。
> 本文件记录 R1 测试归属、R2 保留覆盖、R3 移除映射，供 PR 评审。测试数量只报数、不断言（R4）。

## 归档模块集

| 归档模块 | 职责 |
| --- | --- |
| `src/model-routing/` | 模型路由：策略评估、运行时状态、provider 冷却、决策封印、影子观测 |
| `src/subagent-router/` | 父级路由/规划门禁/能力目录/视觉证据/规划运行时（planning-gate、planning-runtime、coordinator、capability-registry、parent-route、route-ledger、visual-context、visual-evidence） |
| `src/model-routing-adapter.ts` | 治理边界适配器（graphRoutingTaskBinding、blockGraphRoutingDecision、authorizeLegacyMax、routingAttemptBudget 等） |
| `src/recommend.ts` | `recommend` 工具/动作 |
| `extensions/subagent-model-router.ts` | 治理扩展（assess_task、plan_graph、review_graph_spec、analyze_visual_evidence、routed_subagent） |

## R1 测试归档映射

归档当且仅当测试 import 命中归档模块集；import 可移除且不改被测对象的核心测试留主线。

| 测试文件 | 命中归档 import | 处理 |
| --- | --- | --- |
| `tests/model-routing.test.ts` | model-routing/*、model-routing-adapter | 归档 |
| `tests/planning-gate.test.ts` | model-routing/provider-cooldown、subagent-router/planning-gate | 归档 |
| `tests/planning-runtime.test.ts` | subagent-router/planning-runtime、model-routing/types | 归档 |
| `tests/recommend.test.ts` | recommend | 归档 |
| `tests/runtime-v2-foundation.test.ts` | subagent-router/planning-gate（PlanningReceipt 等） | 归档 |
| `tests/subagent-parent-routing.test.ts` | subagent-router/*（能力目录/协调器/父路由/路由账本/视觉） | 归档（D2 探针移入 extension-smoke，见下） |
| `tests/turn-gate.test.ts` | model-routing/types、subagent-router/planning-gate | 归档 |
| `tests/visual-context.test.ts` | subagent-router/visual-context | 归档 |
| `tests/visual-evidence.test.ts` | subagent-router/visual-evidence | 归档 |
| `tests/manager.test.ts` | model-routing/evaluate-routing-policy、model-routing/types、model-routing-adapter | **留主线**：D1 后 core 将 legacy routing decision 视为 opaque，fixture 改为本地构造（移除 3 处治理 import，被测对象 GraphManager 不变） |

D2 探针（"only the retained pi extensions are autoloaded"）是 Phase 2 回归守卫、不依赖治理 import，已移至 `tests/extension-smoke.test.ts` 保留。

## R2 保留覆盖

归档后保留测试 416/416 绿。保留 src 文件覆盖情况（行为覆盖，含经保留模块传递）：

- `src/reservations.ts`：原唯一直接 import 测试（runtime-v2-foundation）已归档；保留的行为覆盖为
  `tests/retention.test.ts`（`garbageCollectSourceReservations` symlink 防护）与
  `tests/snapshot-v2.test.ts`（doctor `inspectSourceReservations` 畸形保留报告），二者 import 的
  `src/retention.ts`/`src/doctor.ts` 直接调用 reservations。
- `src/durable.ts`、`src/remote-tools.ts`：基线（归档 tag 点）即无直接 import 测试，由
  child-runtime/workspace/executor 等保留路径行为覆盖，归档不改变其覆盖状态。
- `src/v3/{claims,durable,index,lease,lifecycle,path-safety,preflight,projection}.ts`：
  v3 内核内部模块，经 v3-host/v3-runner/v3-recovery/v3-verify/v3-phase2 等保留测试行为覆盖，
  基线即如此，归档不改变其覆盖状态。
- 其余每个保留 src 文件均被至少一个保留测试直接 import。

## R3 移除职责映射

| 移除测试 | 对应移除职责 |
| --- | --- |
| `model-routing.test.ts` | 路由策略评估、preflight 审计、routed 派发、legacy max 授权、影子观测摘要 |
| `planning-gate.test.ts` | planning gate 准入、provider cooldown/重试延迟 |
| `planning-runtime.test.ts` | planning child identity、planning evidence |
| `recommend.test.ts` | recommend 工具/动作 |
| `runtime-v2-foundation.test.ts` | 依赖 PlanningReceipt/planning-gate 的 runtime-v2 基础（核心路径由 runner.integration + runtime-v2-execution 保留覆盖） |
| `subagent-parent-routing.test.ts` | 父路由协调器、能力目录、父路由分类、路由账本、视觉路由/证据租约、routed_subagent 扩展接线 |
| `turn-gate.test.ts` | turn gate |
| `visual-context.test.ts` | 视觉上下文存储 |
| `visual-evidence.test.ts` | 视觉证据临时目录/租约/任务 |
| `manager.test.ts`（3 处 fixture） | 不再构造真实治理 RoutingDecision；改用 opaque 本地 fixture 断言冻结 writer 契约 |

## R4 归档 tag

- `archive/governance-pre-d1` @ `d5ea6d5`：D1 前状态（含被移除的 9 个 controlled-routing e2e 测试与完整治理代码），tag 点全绿。
- `archive/governance-v2` @ `19e3a1c`：Phase 3 归档点，含完整治理模块集与全部治理测试，`npm test` 643/643 绿。

## 测试数量（只报数、不断言）

- 归档前主链（Phase 2 末，`19e3a1c`）：643。
- 归档后主链（Phase 3，本提交）：416。
- 差异：-227（9 个治理测试文件 + manager/compile/extension 的 D1 冻结化调整已在 Phase 2 完成，Phase 3 为归档裁减）。
