# pi-graph-terminal-ui

A fast, fluent terminal UI for [pi](https://github.com/badlogic/pi-mono) — streaming
markdown, tool-call cards, drag-select copy, context/cost metering, and a
companion tray for background tasks.

## Install

Once the Graph launcher and optional platform packages are published:

```sh
npm install -g pi-graph-terminal-ui
```

Prebuilt binaries ship for Windows (x64), macOS (x64/arm64), and Linux
(x64/arm64) — no Rust toolchain required.

## Usage

`pi` must be installed and on your `PATH` (the TUI drives pi over its RPC
protocol).

```sh
pi-f            # launch
pi-graph-fluent-tui   # same thing, long name
```

Options:

```
--pi <path>        explicit pi binary path (or set PI_BIN)
--theme <name>     dark|light|nord|solarized-dark|solarized-light|high-contrast
--pi-args "<args>" extra arguments forwarded to pi
```

## Highlights

- Streaming markdown with syntax highlighting, tables, and code blocks
- Tool-call cards with collapsible output; drag-select + right-click to copy
- Status bar: cwd, git branch, context-window meter, token usage, cost
- Interrupt with Esc (double-press to hard-abort)
- Companion tray for teammates / background tasks
