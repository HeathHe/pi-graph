# Computer Use 原生桌面能力安装指南

本文档用于 `/install` 的 `computer-use` 安装项。它配置的是窗口、截图、鼠标、键盘、剪贴板和平台原生可访问性能力；视觉权重由独立的 `computer-use-weights` 安装项负责。

## PURPOSE

让 `computer_use` 在 Windows、macOS 和 Linux X11 上使用已验证的 provider，并在不满足系统条件时保持 fail-closed。Wayland 的全局窗口、截图、激活、输入和可访问性能力不会被本指南强行打开。

## INTERACTIVE INPUTS

执行安装或写入系统配置前，必须先向用户确认：

- 是否允许安装 Node optional dependencies，以及当前系统级工具或 Python 包
- 是否允许在后续操作中授予当前终端/Node 进程的系统权限
- Windows 是否使用默认 `python`，或通过 `PI_COMPUTER_USE_PYTHON` 指定 Python 可执行文件
- Linux 是否运行 X11；若是，是否允许安装 `xdotool`、ImageMagick 或 `scrot`

不要代替用户点击 macOS 的隐私设置，也不要绕过 Windows、macOS 或 Linux 桌面权限提示。

## PROVIDER MATRIX

| 平台 | 已接入能力 | 额外条件 | 明确限制 |
|---|---|---|---|
| Windows | `pi-graph-window-info`、`node-window-manager`、`pi-graph-desktop-automation`、`screenshot-desktop` | Python 3.10+、`pywinauto`、`pywin32` 可选用于 UIA | UIA 依赖缺失时 `accessibility` 保持 unavailable；屏幕录制/受保护窗口仍可能受限 |
| macOS | `pi-graph-window-info`、`node-window-manager`、`pi-graph-desktop-automation`、`screenshot-desktop` | 用户授予 Screen Recording 和 Accessibility/Input Monitoring 权限 | 未配置 AX bridge 时 `ui_tree`/语义控件保持 unavailable |
| Linux X11 | `pi-graph-window-info`、`pi-graph-desktop-automation`、`screenshot-desktop`；固定 argv 的 `xdotool` 用于激活 | X11、`xdotool`、ImageMagick 或 `scrot` | 未安装 `xdotool` 时只能报告窗口列表，不能安全激活窗口 |
| Linux Wayland | 仅允许显式图片输入和不依赖全局桌面的能力 | 使用 compositor/portal 专用实现需另行验证 | 全局窗口、截图、激活、输入、剪贴板和 accessibility 保持 `WAYLAND_RESTRICTED` |

窗口截图只有在 client bounds 已被平台 provider 验证时才会启用；macOS/Linux 当前应使用 `screen` 或 `region`，不能把外层窗口 bounds 当成 client origin。

> **当前依赖：** Pi Graph 直接加载 `pi-graph-window-info@9.0.1` 和 `pi-graph-desktop-automation@4.2.7`，不使用 npm aliases。后者直接依赖 `pi-graph-desktop-shared@4.2.7` 和 `pi-graph-desktop-provider-api@4.2.7`。这些是修补 fork，不是官方支持承诺；来源和许可见 [RELEASE.md](../../../RELEASE.md)。此前 Windows x64 / Node 22.22 的安装和只读 API 验证属于旧 aliases，不证明改名后的包或其他平台已通过验证。

声明 optional dependencies 不代表它们已安装或已获得桌面权限。获得安装授权后，在源码仓库根目录运行 `npm ci --include=optional`，通过 npm workspace 解析 Graph 包；该命令会运行依赖的安装脚本。源码检出不保证这些 Graph 名称在 registry 上可用。若使用本地 tarball，在同一次安装中提供插件及其所需的 Graph tarball，并提供上述四个原生 provider 相关的本地 tarball，再使用 `--include=optional`，不要用旧 aliases 补齐依赖。

从源码仓库根目录验证 provider 契约：

```bash
node --experimental-transform-types --test packages/pi-graph/test/computer-use-native-provider-contract.test.mjs
```

不要静态导入这些 provider。运行时能力探测必须继续允许插件在 optional dependencies 缺失时启动。

## STEP 2: WINDOWS UIA (OPTIONAL)

只有需要 Windows `ui_tree`、`find_control` 或语义控件操作时才安装 Python bridge 依赖：

```bash
python -m pip install pywinauto pywin32
```

从仓库工作区验证固定 argv bridge：

```bash
python optional/computer-use-windows-bridge.py --action probe
```

预期输出是一行 JSON，包含 `"ok":true` 和 `"provider":"pywinauto-uia"`。如果输出 `DEPENDENCY_UNAVAILABLE`，窗口列表、截图和 nut-js 输入仍可用，但 accessibility 必须保持 unavailable。

Python bridge 只接受固定的 action/参数组合，Node 通过 `runBridgeProcess` 以 `shell:false` 调用。不要把 bridge 改成 PowerShell、`cmd /c`、任意脚本或未验证的 `SendInput` 回退。

可选地指定 Python：

```bash
export PI_COMPUTER_USE_PYTHON='C:/Path/To/python.exe'
```

## STEP 3: MACOS PERMISSIONS

首次使用前，在 **System Settings → Privacy & Security** 中由用户确认并授权：

- Screen Recording：用于 `screenshot-desktop` 截图
- Accessibility：用于窗口激活和未来经过验证的 AX provider
- Input Monitoring：若系统提示 `nut-js` 输入需要该权限

授权后重新运行 `computer_use.capabilities` 和 `computer_use.permissions`。状态为 `prompt`、`denied` 或 `unknown` 时，不得把它当成已授权继续执行输入。

## STEP 4: LINUX X11

确认会话：

```bash
printf '%s\n' "${XDG_SESSION_TYPE:-unknown}"
```

在 Debian/Ubuntu 上，安装固定命令 provider 和截图后端前必须获得用户确认：

```bash
sudo apt-get install xdotool imagemagick
```

也可以使用 `scrot` 作为截图后端：

```bash
sudo apt-get install xdotool scrot
```

重新运行 `computer_use.capabilities`。`window_control` 只有在 `xdotool --version` 探测成功后才显示为 degraded provider；激活后仍必须由 `pi-graph-window-info` 验证前台窗口。

## STEP 5: VERIFICATION

先观察，不产生鼠标或键盘输入：

```bash
node --experimental-transform-types --input-type=module -e "import { createDesktopAdapter } from './src/tools/computer-use/platform/index.ts'; const a=createDesktopAdapter(); console.log(await a.permissions()); console.log(await a.listWindows({visibleOnly:true}));"
```

然后按当前平台选择只读截图验证：

```bash
node --experimental-transform-types --input-type=module -e "import { createDesktopAdapter } from './src/tools/computer-use/platform/index.ts'; const a=createDesktopAdapter(); const f=await a.capture({source:'screen'}); console.log(f.image, f.bytes.byteLength);"
```

必须满足：

- 能力状态反映真实 provider，而不是仅因为平台名称就报告 available
- 截图是有效、非空、物理像素坐标有明确 origin 的 PNG
- Linux Wayland 的全局操作返回 `WAYLAND_RESTRICTED`
- Windows 缺少 Python 依赖时 UIA 返回结构化 `DEPENDENCY_UNAVAILABLE`
- 在用户明确授权前不调用 click、drag、press、type 或 paste

## PERMISSION AND SAFETY BOUNDARY

系统权限、前台窗口、网络游戏目标和破坏性输入仍由 `ComputerUseManager` 统一校验。安装完成不等于获得授权；每次输入仍遵循 observe → act → verify，诊断像素近零时锁定窗口并要求重新探测。
