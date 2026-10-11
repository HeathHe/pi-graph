# npm 0.2.0 发布准备与验证

目标包为 `pi-graph@0.2.0`，许可证为 MIT（2026 HeathHe）。下面是可执行的检查步骤，不是“已经通过”的结果。本轮实际 pack、干净安装和完整测试由执行任务保存证据；正式发布前还须核实 npm 包名历史、账户与写入权限，并取得发布授权。此流程不自动 push、创建 GitHub release 或发布 npm 包。

## 本地检查与包内容

在本项目根目录、使用 Node.js `>=22.19.0` 执行：

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run pack:check
npm pack --ignore-scripts
```

前三项分别安装锁定开发依赖、检查类型、运行测试；dry-run 检查包文件清单，最后生成 `pi-graph-0.2.0.tgz`。保留命令退出码、完整日志、tarball SHA256 和 npm 清单。包应包含 `extensions/`、`src/runtime/`、`src/v3/`、`agents/`、`templates/`、`docs/`、`examples/`、README、CHANGELOG、LICENSE；不应包含用户配置、凭据、运行记录、测试工作区或旧 native 维护备份。

运行 SDK 使用宿主 Pi，开发依赖固定为 1.0.4。peer dependency 的宽版本声明不是所有宿主版本已验证的声明：实际加载与启动必须通过必要 API 和 session 生命周期检查。

## 干净安装与临时加载

为避免改变现有 Pi 安装声明，在新的临时目录检查真实 tarball；把下面路径替换为刚生成包的绝对路径：

```bash
release_check_dir="$(mktemp -d)"
cd "$release_check_dir"
npm init -y
npm install --ignore-scripts --omit=dev /absolute/path/pi-graph-0.2.0.tgz
npm ls --omit=dev
release_agent_dir="$release_check_dir/pi-agent"
mkdir -p "$release_agent_dir"
PI_CODING_AGENT_DIR="$release_agent_dir" pi -e "$release_check_dir/node_modules/pi-graph"
```

npm 安装在这个临时目录写入依赖，可能访问配置的 registry。`PI_CODING_AGENT_DIR` 将 Pi 指向新建的独立空配置目录；不复用或修改 `HOME`，不复制现有配置和凭据。Pi 的 `-e` 只临时加载包目录，不保存安装声明。打开后应能看到 `graph` 工具以及 `/graphs`、`/graph-models`；不要输入任务或 prompt 真实模型，不在该目录登录模型服务。退出 Pi 后保留安装日志。默认 Pi 启动会使用既有配置，不能省略这里的隔离变量而声称不会读取现有凭据。不要直接 `pi -e ...tgz`：Pi 的本地文件入口是扩展文件，归档应先由 npm 安装为目录。

隔离测试还应使用固定本地响应验证自有 SDK worker 的注册模型、冻结配置、结果/用量和物理退出证明。macOS shell 路径需核对 `sandbox-exec`，其他平台或缺少保护程序时应验证明确拒绝未保护 shell；不要把启动拒绝写成跨平台运行成功。宿主测试与开发 SDK fixture 的结果分开记录，不把 fixture 通过当成真实服务可用。

## 发布 dry-run 与 registry 核对

```bash
npm publish --dry-run --ignore-scripts --registry=https://registry.npmjs.org/
npm view pi-graph versions --json --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

第一项只检查发布清单，不上传包；后两项只读核实包历史和当前账户。若包名已存在，必须核对所有权及已有版本，不能仅凭本地 `name/version` 判断可发布；若 registry 返回 404、认证或网络错误，保留原始错误并区分包不存在、权限不足与查询失败。dry-run 成功也不能证明有正式发布权限。不得输出 token、完整认证头或用户凭据。

## 由本人完成 npm 登录

本轮官方 registry 的 `npm whoami` 返回 HTTP 401，当前查询没有可用认证；这不是发布成功或已取得包写入权限的证明。登录由账户本人完成，检查任务不代为登录，也不接收密码、验证码或 token。

在你的 Mac 上按 `Command + 空格`，输入“终端”并回车，执行：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

按 npm 给出的提示在浏览器完成本人账户登录与验证，然后回到终端。正常结果是第二条命令显示你的 npm 用户名，而不是 401；仍需核对该账户对 `pi-graph` 的发布权限及 0.2.0 是否已存在。登录不会自动发布，核实后仍按下面的授权边界处理。

## 正式发布边界

本地检查、完整测试、干净安装、包内容及 registry 核实完成后，提供具体 tarball/hash、版本和账户核对结果供用户审阅。正式 `npm publish` 是对外写入，需要明确授权；本文不执行也不预先宣称发布成功。成功发布并核实 registry 后，用户才可安装：

```bash
pi install npm:pi-graph@0.2.0
```

默认命令写入 Pi 用户安装声明；项目安装另用 Pi 的 `--local` 并遵守项目信任边界。新代码需在活跃 Graph 结束后重新启动 Pi 才加载。旧协议历史保留只读，不靠发布、安装或重新加载重放原任务。
