# npm 0.2.1 发布准备与最后操作

目标为pi-graph@0.2.1，MIT（2026 HeathHe）。每次发布准备的结果与冻结归档以对应验收记录为准；本文是操作说明，不预先宣称测试、认证或正式发布已成功。正式publish需明确授权；login/2FA由本人处理，不自动push或变更账户权限。

## 冻结包与本地验证

将下方占位路径替换为本次已验收tarball的绝对路径：

```text
/absolute/path/pi-graph-0.2.1.tgz
```

发布验收记录应保存完整测试、类型、包文件及清洁安装/实际宿主SDK与CLI/隔离worker验证、退出码和SHA256/integrity；交付操作命令应填入确切归档路径。尚未得到成功证据时不能把这些说明当成已验收。发布使用这个固定tarball，不从可能继续变化的工作目录直接publish。用户无需重复Agent已成功完成的测试；失败或取消原样保留，不能用旧基线代替本次结果。

包应包含extensions、src/runtime、src/v3、agents、templates、docs、examples、README、CHANGELOG及LICENSE；排除node_modules、tests、旧维护备份、用户配置/认证/密钥、运行记录、归档与任务证据。运行使用当前宿主Pi，经API能力和session生命周期验证；开发SDK固定1.0.4仅用于可复现fixture，不锁宿主版本，也不保证所有未来版本兼容。

清洁安装位于独立临时项目，npm install --ignore-scripts --omit=dev使用官方registry，实际测试显式空PI_CODING_AGENT_DIR，不复制用户配置/auth、不改HOME或现有Pi安装。CLI仅临时加载已安装包目录；SDK worker仅固定本地响应，无真实供应商推理。macOS保护shell需要sandbox-exec，缺保护时拒绝；本地验证不代表真实provider登录/额度/联网可用。

## 身份、名称与版本

当前身份由本人终端的npm whoami确认，不能沿用以前某次401或成功登录推断现在状态。包名可能存在下架历史；目录查询或未发现目标版本都不证明当前用户拥有包名，也不保证0.2.1可发布。历史name@version不可复用。本轮保留pi-graph@0.2.1，不自动改名或升版；若权限/版本冲突，先核实再决定。

官方说明：[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)、[unpublish policy](https://docs.npmjs.com/policies/unpublish/)。publish --dry-run只模拟归档清单，不上传，不证明真实发布权。

## 本人在Mac终端手工发布的备选流程

按Command+空格，输入“终端”并回车。先执行：

```bash
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

按npm提示在浏览器完成本人登录与需要的2FA，不把密码/验证码/token交给Agent。第二条正常显示本人用户名；登录不自动发布。核对该账户的pi-graph写入权限、当前版本及下架历史。若未登录、没有发布权或0.2.1冲突，停止，不盲改包名/版本。

本轮冻结制品验收成功、本人确认权限并决定正式发布后，才在终端执行：

```bash
npm publish /absolute/path/pi-graph-0.2.1.tgz --access public --tag latest --ignore-scripts --registry=https://registry.npmjs.org/
npm view pi-graph@0.2.1 version dist.integrity --json --registry=https://registry.npmjs.org/
```

npm可能要求浏览器/2FA由本人完成。正常发布后version为0.2.1，dist.integrity与本轮清单一致；出错不能当作已发布。Git提交不是npm技术前提，本轮未提交的修复不能冒称已在旧HEAD中。

正式发布成功并核实后才可pi install npm:pi-graph@0.2.1。更新前等待活跃任务结束，安全重载或重新启动Pi；旧Graph/缺workspace/未知效果历史不因此自动恢复，不重放已完成工具。
