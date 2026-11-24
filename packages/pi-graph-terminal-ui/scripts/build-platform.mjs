#!/usr/bin/env node
// Build the pi-graph-terminal-ui release binary for a Rust target triple and emit a
// publishable platform package (pi-graph-terminal-ui-<os>-<cpu>) under platforms/.
//
//   node scripts/build-platform.mjs --target x86_64-pc-windows-msvc
//   node scripts/build-platform.mjs --target x86_64-pc-windows-msvc --skip-build
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_DIR, "..", "..");
const TUI_WORKSPACE = path.join(REPO_ROOT, "pi-tui");

const TARGETS = {
  "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64", exe: "pi-graph-fluent-tui.exe" },
  "x86_64-unknown-linux-gnu": { os: "linux", cpu: "x64", exe: "pi-graph-fluent-tui" },
  "aarch64-unknown-linux-gnu": { os: "linux", cpu: "arm64", exe: "pi-graph-fluent-tui" },
  "x86_64-apple-darwin": { os: "darwin", cpu: "x64", exe: "pi-graph-fluent-tui" },
  "aarch64-apple-darwin": { os: "darwin", cpu: "arm64", exe: "pi-graph-fluent-tui" },
};

const args = process.argv.slice(2);
const target = args[args.indexOf("--target") + 1];
const skipBuild = args.includes("--skip-build");
const spec = TARGETS[target];
if (!spec) {
  console.error(
    `unknown --target "${target}"; supported: ${Object.keys(TARGETS).join(", ")}`,
  );
  process.exit(1);
}

const { name: launcherName, version } = JSON.parse(
  fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"),
);

// Keep the crate's --version output aligned with the npm version.
const cargoToml = path.join(TUI_WORKSPACE, "crates", "tui", "Cargo.toml");
const toml = fs.readFileSync(cargoToml, "utf8");
const synced = toml.replace(/^version = ".*"$/m, `version = "${version}"`);
if (synced !== toml) {
  fs.writeFileSync(cargoToml, synced);
  console.log(`synced crate version -> ${version}`);
}

if (!skipBuild) {
  execFileSync(
    "cargo",
    ["build", "--release", "-p", "pi-graph-fluent-tui", "--target", target],
    { cwd: TUI_WORKSPACE, stdio: "inherit" },
  );
}

const built = path.join(TUI_WORKSPACE, "target", target, "release", spec.exe);
if (!fs.existsSync(built)) {
  console.error(`binary not found: ${built}`);
  process.exit(1);
}

const name = `${launcherName}-${spec.os}-${spec.cpu}`;
const outDir = path.join(PKG_DIR, "platforms", name);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "bin"), { recursive: true });
fs.writeFileSync(
  path.join(outDir, "package.json"),
  `${JSON.stringify(
    {
      name,
      version,
      description: `Prebuilt pi-graph-terminal-ui binary (${spec.os}/${spec.cpu}).`,
      license: "MIT",
      os: [spec.os],
      cpu: [spec.cpu],
      files: ["bin/"],
    },
    null,
    2,
  )}\n`,
);
const dest = path.join(outDir, "bin", spec.exe);
fs.copyFileSync(built, dest);
fs.chmodSync(dest, 0o755);
console.log(`${name}@${version} -> ${path.relative(REPO_ROOT, outDir)}`);
