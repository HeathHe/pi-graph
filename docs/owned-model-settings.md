# 独立模型与子 Agent 设置

先复制 [模型配置示例](../examples/graph-models.example.json) 为项目 `.pi/graph-models.json`，复制 [岗位示例](../examples/agents/custom-worker.md) 为 `.pi/agents/custom-worker.md`，再替换示例服务的信息。两份文件使用虚构端点和环境变量引用，不含密钥；JSON 不能包含注释。

也可直接编辑项目或全局 `graph-models.json` 与岗位 `agents/<name>.md`，即可独立定义模型和子 Agent；不必通过界面创建。`/graph-models` 是同一配置格式的可选交互入口。保存后新 Graph 使用新配置，已经运行的 Graph 保留启动时的配置。

项目配置写入当前工作目录的 `.pi/graph-models.json`，全局配置写入 Pi Agent 目录的 `graph-models.json`（默认 `~/.pi/agent/graph-models.json`）。项目设置优先于全局设置，原岗位模型作为未配置时的默认值。岗位文件保存在相应范围的 `agents/<name>.md`；编辑只处理这个确切文件，创建不会覆盖已有岗位。

## 直接编辑配置文件

使用本机的 VS Code 或其他纯文本编辑器，打开项目工作目录。创建或打开 `.pi/graph-models.json`；若使用全局配置，则打开 Pi Agent 目录下的 `graph-models.json`，默认位置为 `~/.pi/agent/graph-models.json`。不存在时创建相应目录和文件，已有文件时先保留原内容，按下面格式增加或修改字段。JSON 不能写注释、不能有末尾多余逗号。

下面是一份完整可复制结构。`graph-custom/model-id` 的 URL、模型 ID 和能力都是占位示例，使用前替换为实际服务信息。选择官方 Kimi/Grok 时使用 Pi 已有订阅，不需要增加 `models` 定义。

```json
{
  "version": 1,
  "models": {
    "graph-custom/model-id": {
      "provider": "graph-custom",
      "id": "model-id",
      "name": "My custom model",
      "api": "openai-completions",
      "baseUrl": "https://example.com/v1",
      "input": ["text"],
      "contextWindow": 128000,
      "maxTokens": 8192,
      "reasoning": false,
      "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
      "auth": {"type": "env", "variable": "CUSTOM_MODEL_API_KEY"}
    }
  },
  "profiles": {
    "economy": {
      "model": "wisdomrouter/glm-5.3-flash",
      "fallbackModels": ["kimi-coding/k3"],
      "thinking": "low"
    }
  },
  "roles": {
    "local-researcher": {"profile": "economy"},
    "custom-reader": {
      "model": "graph-custom/model-id",
      "fallbackModels": [],
      "thinking": "off"
    }
  }
}
```

模型密钥不能写入此 JSON。`auth.variable` 仅指环境变量名称，密钥由启动 Pi 的进程环境提供；`auth: {"type":"pi","provider":"wisdomrouter"}` 可引用既有普通 Pi 凭证。这里不会复制凭证，也不会验证服务已经开通。官方 `xai`、`kimi-coding` 订阅凭证禁止转发到自定义端点。

| 字段 | 含义 |
| --- | --- |
| `version` | 必须为 `1` |
| `roles` | 必须为对象；键是已发现的岗位名称，值可配置 `model`、`fallbackModels`、`thinking`、`profile` |
| `profiles` | 必须为对象；具名模型方案，可配置 `model`、`fallbackModels`、`thinking` |
| `models` | 可省略；自定义模型对象，键必须恰好等于定义中的 `provider/id` |
| `model` | 完整的 `provider/model`；不能只填模型简称 |
| `fallbackModels` | 有序备用模型数组；`[]` 明确关闭该字段的替补链 |
| `thinking` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，仍须模型实际支持 |
| `profile` | 引用 `profiles` 中存在的方案名；单独的同范围字段可覆盖方案 |

项目配置按字段优先于全局配置。没有项目覆盖的普通字段继承全局；项目明确选择方案时，选中方案优先于全局岗位单独模型覆盖。岗位单独字段优先于其选中的方案。未配置的字段继续使用岗位 Markdown 的原默认值；任务明确填写的模型/思考提示优先，但仍必须通过模型范围和工具权限预检。同名项目自定义模型定义覆盖全局完整定义，不逐字段拼接模型端点与认证方式。

保存后在 Pi 输入 `/graph-models list` 检查读取结果与来源。语法错误、未知字段或不可用模型会明确报错；错误配置不会默默变成空配置，也不会借机启动替补。正常情况显示配置、可用模型和岗位。修改只影响下一次新 Graph；已有 Graph 的模型定义、端点、思考等级、工具和提示词保持冻结。实际供应商 API 和账号授权仍需另行验证，当前自测使用固定本地响应。

## 直接编辑岗位 Markdown

项目岗位放在 `.pi/agents/`，全局岗位放在 Pi Agent 目录的 `agents/`（默认 `~/.pi/agent/agents/`）。用纯文本编辑器新建 `.pi/agents/local-researcher.md`，可复制：

```markdown
---
name: local-researcher
description: Read only the documents assigned by the parent
model: kimi-coding/k3
thinking: high
tools: [read, grep, find, ls]
systemPromptMode: replace
inheritProjectContext: true
inheritGlobalContext: false
inheritSkills: false
defaultContext: fresh
---

只阅读父任务指定的资料，报告结论和依据。
不修改文件；资料不足时明确报告缺少什么。
```

文件开头两行 `---` 包住的 YAML 是岗位属性，后面的正文是岗位提示词。`name` 是选择岗位用的名字，`description` 是用途说明，`tools` 是允许使用的工具名数组；列出工具不会绕过父权限和 Graph Guard。`systemPromptMode: replace` 使用本岗位提示词，`append` 将其附加到 SDK 提示词。继承字段决定是否读取项目规则、全局规则和技能。已有扩展或复杂字段应保留；不支持的外部 runner、未能解析的 MCP、权限规则等会明确拒绝，不悄悄扩大权限。

同名岗位以项目定义优先于用户定义和包内定义。保存岗位后再新建 Graph；修改当前 Graph 已冻结的角色文件不会替换其执行尝试。删除岗位文件会影响后续发现与启动，应先核对名称和范围。文件配置与命令使用相同读取流程，不需要额外注册插件。

## 可选的交互与命令入口

在 Pi 的消息输入框输入 `/graph-models`，按菜单选择查看、配置模型、切换模型方案或创建、编辑、删除岗位。它读写上述文件，取消输入不会保存。

## 角色模型与方案

下列命令均在 Pi 消息输入框执行，不是在终端执行。`scope` 为 `project` 或 `global`，默认 `project`。

```text
/graph-models list
/graph-models set {"scope":"project","role":"researcher","value":{"model":"kimi-coding/k3","fallbackModels":["wisdomrouter/glm-5.3"],"thinking":"high"}}
/graph-models profile {"scope":"project","name":"economy","value":{"model":"wisdomrouter/glm-5.3-flash","fallbackModels":["kimi-coding/k3"],"thinking":"low"}}
/graph-models useprofile {"scope":"project","role":"researcher","profile":"economy"}
```

`useprofile` 清除所选范围内该岗位的单独模型覆盖，让选中的方案生效。再使用 `set` 可覆盖方案中的个别字段。`fallbackModels: []` 表示不设置替补；替补是否能启动仍由 Graph 的工具、权限、模型可用性和安全重试条件决定。

Kimi 直接选择既有官方 `kimi-coding/k3`。Grok 直接选择既有官方 `xai/...` 模型。不能把它们伪装成自定义中转模型，也不能将其官方订阅凭证转发给自定义端点。

## 自定义模型定义

自定义提供方名称以 `graph-` 开头，避免覆盖 Pi 已有提供方。下面的模型名称、URL 与环境变量名称都是示例，需改成实际服务的信息。环境变量只保存名称，实际密钥由启动 Pi 的环境提供；不要把密钥写入命令、岗位提示词或此配置文件。

```text
/graph-models modelset {"scope":"project","value":{"provider":"graph-custom","id":"model-id","name":"My model","api":"openai-completions","baseUrl":"https://example.com/v1","input":["text"],"contextWindow":128000,"maxTokens":8192,"reasoning":false,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"auth":{"type":"env","variable":"CUSTOM_MODEL_API_KEY"}}}
/graph-models set {"scope":"project","role":"researcher","value":{"model":"graph-custom/model-id","fallbackModels":[]}}
```

可使用 `auth: {"type":"pi","provider":"wisdomrouter"}` 引用已存在的普通 Pi 凭证提供方。这里仅保存引用，不复制密钥；`xai` 和 `kimi-coding` 官方订阅凭证禁止用于自定义提供方。

`input` 声明模型支持 `text`、`image` 或两者；只填写实际能力。`contextWindow` 是上下文容量，`maxTokens` 是最大输出量；后者不能大于前者。`reasoning` 表示是否支持思考。`cost` 是用量估算的价格元数据，不会替你购买或开通模型。模型 URL 不能含用户名、密码、查询串或片段。

`modelset` 同时用于创建和修改完整定义。删除所选范围的定义：

```text
/graph-models modeldelete {"scope":"project","provider":"graph-custom","id":"model-id"}
```

删除项目覆盖后，可能重新使用同名全局定义。删除不会自动改写引用该模型的岗位；若没有剩余可用定义，后续启动需要重新配置。已有 Graph 的冻结配置不变。

## 岗位创建、编辑和删除

```text
/graph-models rolecreate {"scope":"project","name":"local-researcher","description":"只读检查指定资料","prompt":"只阅读父任务明确提供的文件，报告证据，不修改文件。","tools":["read","grep","find","ls"],"model":"kimi-coding/k3","thinking":"high"}
/graph-models roleedit {"scope":"project","name":"local-researcher","value":{"prompt":"只阅读指定资料，列出结论和依据。","tools":["read","grep"]}}
/graph-models roledelete {"scope":"project","name":"local-researcher"}
```

删除命令会删除所选范围的确切岗位文件，需确认岗位名称和范围；界面删除会显示确认提示。包内提供的岗位不能通过任意路径参数改写。修改提示词或工具不会绕过 Graph 的既有权限限制。
