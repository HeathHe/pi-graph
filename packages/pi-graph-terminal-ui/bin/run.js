#!/usr/bin/env node
"use strict";
// Thin launcher: resolve the platform-specific optional package carrying the
// prebuilt Rust binary and exec it, forwarding argv/stdio/exit status.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const PLATFORMS = {
  "win32-x64": "pi-graph-terminal-ui-win32-x64",
  "linux-x64": "pi-graph-terminal-ui-linux-x64",
  "linux-arm64": "pi-graph-terminal-ui-linux-arm64",
  "darwin-x64": "pi-graph-terminal-ui-darwin-x64",
  "darwin-arm64": "pi-graph-terminal-ui-darwin-arm64",
};

const key = `${process.platform}-${process.arch}`;
const pkg = PLATFORMS[key];
if (!pkg) {
  console.error(`pi-graph-terminal-ui: unsupported platform ${key}`);
  process.exit(1);
}

let pkgDir;
try {
  pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
} catch {
  console.error(
    `pi-graph-terminal-ui: platform package "${pkg}" is not installed.\n` +
      "It ships via optionalDependencies — reinstall without --no-optional.",
  );
  process.exit(1);
}

const exe = path.join(
  pkgDir,
  "bin",
  process.platform === "win32" ? "pi-graph-fluent-tui.exe" : "pi-graph-fluent-tui",
);
const r = spawnSync(exe, process.argv.slice(2), { stdio: "inherit" });
if (r.error) {
  console.error(`pi-graph-terminal-ui: failed to launch ${exe}: ${r.error.message}`);
  process.exit(1);
}
if (r.signal) {
  process.kill(process.pid, r.signal);
} else {
  process.exit(r.status ?? 1);
}
