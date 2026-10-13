# Changelog

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
