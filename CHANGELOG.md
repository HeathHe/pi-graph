# Changelog

## 0.2.4 — 2026-10-21

- 增加当前/历史 Todo 义务与交付显示生命周期：精确接替、暂缓和恢复使用原生会话记录；未交付任务默认可见，明确收起与成功交付才收敛，未知副作用不自动重试或清除。
- 修复已消费结果重复唤醒，固定显示当前执行与精确实际身份，保留多关联历史风险、完整宽度和 Inspector 本面板完成项显隐。
- 支持显式授权 projectRoot 创建独立项目 Graph；缺少必需验收文件归类为 validation 失败，保留原结果与路径安全检查。改进安装宿主 CLI 的离线测试发现。
- Add native-session Todo lifecycle metadata for exact replacement, scope and delivery; unresolved current tasks remain visible unless explicitly collapsed. Preserve unknown side-effect safeguards and existing Graph acceptance rules.
- Avoid redundant wake turns after exact result consumption, keep current execution and observed identities visible, support authorized project roots, and report missing required evidence as validation failure. Improve installed-host CLI test discovery.

## 0.2.3 — 2026-10-20

- 增加显式分层总计划与叶项绑定校验；Todo 按终端可用宽度自适应，标题在左、已观测项目/Agent/模型靠右，窄屏有界换行。保留稳定编号、真实异常与实际身份，完成项原位显示。
- Add explicit nested plans with validated leaf bindings and adaptive terminal Todo rows: titles stay left, observed project/Agent/model identities align right, and narrow views wrap safely. Preserve stable numbering, real warnings and observed identities; completed items remain in place.

- 等待收尾消费严格核验的子进程退出证据并返回待处理状态；单次读取、取消、清理与回执有界，不设置任务总时限、不自动重试，也不自动回写旧任务状态。
- Graph wait consumes strictly verified child-exit proof and yields attention. Individual reads, cancellation, cleanup and receipts are bounded, without a task-wide deadline, automatic retry or automatic rewriting of old durable state.


## 0.2.2 — 2026-10-16

- 增加独立总计划与 Graph 任务联动，终端按任务显示责任岗位、实际模型、运行活动和依赖等待；正常等待使用中性提示，失败与待处理状态保留警告。
- 整理工具回执与详情，保留原始结果、分页和验收证据；输出读取不等于验收，不重复追加同一完成通知。
- 修正宿主 Pi SDK 定位、模型定义与会话身份校验，运行跟随当前宿主，开发依赖不替代宿主运行时。
- 新准入且具备完整安全证明的 continuation-v1 任务，可在同一会话及模型下对短暂传输故障续接最多一次；次数先持久化，停止、未知效果、预算不足和重复失败仍安全停止。旧失败 Graph 不自动迁移或重跑。
- 修复暂停请求与最后一个运行任务结束同时发生时错误返回 running 的竞态；任务结束后重新读取持久控制状态，保持 paused，并以同一已准备身份恢复。
- npm 包仅保留运行文件、配置示例和用户指南，排除内部设计与发布资料；保留 MIT 许可证。
- Add plan-linked terminal task rows, observed Agent/model identities, neutral dependency waits, structured receipts, host SDK compatibility checks, and at most one proof-gated same-session transient retry for newly admitted continuation-v1 runs. Old failed runs are not replayed automatically.

## 0.2.1 — 2026-10-13

- 同一 npm README 提供完整 English / 简体中文可折叠区块，默认展开英文；保留全部技术规则、示例和安全边界。
- Add complete English and Simplified Chinese sections in the same npm README, with English expanded by default. Preserve all technical rules, examples, and safety boundaries.
- 仅文档及版本更新；运行逻辑与 0.2.0 一致。Documentation and version metadata only; runtime behavior is unchanged from 0.2.0.

## 0.2.0 — 已发布

本版本已发布到 npm，记录自有运行时迁移。发布包、干净安装、完整测试与 registry 结果以对应保存的验证记录为准。

- 用自有 Pi SDK controller、独立 worker、guardian 和 RPC 接管子 Agent 启动、状态、结果和退出证明，移除对 `pi-subagents` / `pi-intercom` 的运行依赖；保留 V3 DAG、shadow 验证与回写、持久控制及 Attempt 历史。
- 统一采用持久 `graph_mailbox` 通信，父级决定通过有身份校验的请求和回复传递；消息不扩大工具或文件权限，普通点对点通知不回灌主模型。
- 引入独立 `graph-models.json` 模型/岗位配置、profiles、备用模型及自定义模型定义；提供 `/graph-models` 和可复制示例。准入冻结模型、工具、提示词及执行配置，修改配置不影响已有 Graph。
- 继承可信父工具上界，并保持岗位工具限制、readOnly 和 scope；已授权 shell 使用 macOS `sandbox-exec` 保护控制文件与凭据路径，无法保护时拒绝执行。
- 模型故障接替仅推进已冻结候选（新准入的备用链只来自显式岗位/profile配置，不自动追加主会话模型）：新协议可在SDK完全结束且无未知效果时同会话切模型，保留已完成工具、权限和累计预算；受控内部checkpoint经完整身份/部署/会话与正常物理退出证明后从原记录续接。旧计划继续使用零工具活动的新Attempt路径，不迁移旧失败Graph或恢复未知crash。详见[原会话续接与安全检查点](docs/session-continuation.md)。
- 紧凑总览最多展示两条实际岗位/模型/工具，排队显示数量或下一项；Inspector 保留状态、结果、产物和邮箱交互。结果分页来源变化提供只读恢复指令，详情读取异常不改写已经验收的执行结果。
- 启动前诊断保留实际模型准入原因，明确拒绝过期显式指定；仅可信身份和合格供应商错误允许按剩余预算检查获批候选。供应商/模型家族限制由配置与最新批准策略共同校验，项目覆盖不能绕过全局拒绝。
- npm 包包含自有运行时、V3 内核、扩展、角色、模板、配置示例和文档；排除旧 native 维护备份。许可证为 MIT（2026 HeathHe）。

旧协议运行保留结果与只读历史，不自动迁移或重新派发。升级前等待活跃任务结束，重新启动 Pi 后使用新代码。真实供应商联网、登录凭证及外部服务健康不属于本次本地发布验证。
