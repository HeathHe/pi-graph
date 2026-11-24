import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  applyNativeMcpMigration, backupNativeMcpMigration, collectNativeMcpMigrationInput,
  planNativeMcpMigration, previewNativeMcpMigration, registerNativeMcpMigration,
  rollbackNativeMcpMigration, type NativeMigrationInput, type NativeMcpMigrationPlan,
} from "../src/mcp/native-migration.ts";
import { isToolExcluded } from "../src/mcp/types.ts";

const ids = ["shared-global", "pi-global", "shared-project", "pi-project"] as const;
function input(raws: (Record<string, unknown> | null)[], root = resolve("migration-fixture")): NativeMigrationInput {
  const paths = [join(root, "shared-global.json"), join(root, "agent", "mcp.json"), join(root, ".mcp.json"), join(root, ".pi", "mcp.json")];
  return {
    sources: ids.map((id, index) => ({ id, path: paths[index], text: raws[index] === null ? null : JSON.stringify(raws[index] ?? {}) })),
    globalTarget: paths[1], projectTarget: paths[3], projectTrusted: true,
  };
}
function raw(plan: NativeMcpMigrationPlan, scope: "global" | "project" = "global"): any {
  const write = plan.writes.find((entry) => entry.scope === scope);
  assert.ok(write, `missing ${scope} write`);
  return JSON.parse(write.afterText);
}
function codes(plan: NativeMcpMigrationPlan): string[] { return plan.blockers.map((issue) => issue.code); }
function fixture(t: any, raws: (Record<string, unknown> | null)[]): NativeMigrationInput {
  const dir = fs.mkdtempSync(join(tmpdir(), "native-mcp-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = input(raws, dir);
  for (const source of data.sources) {
    fs.mkdirSync(resolve(source.path, ".."), { recursive: true });
    if (source.text !== null) fs.writeFileSync(source.path, source.text);
  }
  return data;
}
function exposure(config: any, tool: string): string {
  if (Object.hasOwn(config.toolExposure ?? {}, tool)) return config.toolExposure[tool];
  for (const [pattern, value] of Object.entries(config.toolExposure ?? {})) {
    if (pattern.includes("*") && new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(tool)) return value as string;
  }
  return config.exposure ?? "codemode";
}

test("four-source shallow field merge, first import wins, per-source explicit override, unknown roots and native fields", () => {
  const data = input([
    { mcpServers: { svc: { command: "server", args: ["original"], env: { OLD: "old" }, enabled: false } }, extra: { preserved: true } },
    { imports: ["cursor", "claude-code"], mcpServers: { svc: { args: ["pi"], timeout: 3 } }, autoEnableCodemode: false },
    { mcpServers: { svc: { env: { PROJECT: "new" } }, projectOnly: { command: "project" } }, projectRoot: [1, 2] },
    { mcpServers: { svc: { args: ["final"], exposure: "deferred", toolExposure: { "read*": "direct" } } }, note: "kept" },
  ]);
  data.imports = [
    { kind: "cursor", path: resolve("migration-fixture/cursor.json"), text: JSON.stringify({ "mcp-servers": { imported: { command: "first", args: ["one"] }, svc: { cwd: "dir" } } }) },
    { kind: "claude-code", path: resolve("migration-fixture/claude.json"), text: JSON.stringify({ mcpServers: { imported: { command: "second", env: { SHOULD_NOT_MERGE: "x" } } } }) },
  ];
  const plan = planNativeMcpMigration(data);
  assert.deepEqual(plan.blockers, []);
  const global = raw(plan);
  const project = raw(plan, "project");
  assert.deepEqual(global.extra, { preserved: true });
  assert.equal(global.autoEnableCodemode, false);
  assert.equal(global.mcpServers.svc.command, "server");
  assert.deepEqual(global.mcpServers.svc.args, ["pi"]);
  assert.equal(global.mcpServers.svc.enabled, false);
  assert.equal(global.mcpServers.svc.cwd, "dir");
  assert.equal(global.mcpServers.imported.command, "first");
  assert.equal(global.mcpServers.imported.env, undefined);
  assert.deepEqual(project.mcpServers.svc.env, { PROJECT: "new" });
  assert.deepEqual(project.mcpServers.svc.args, ["final"]);
  assert.equal(project.mcpServers.svc.command, "server");
  assert.equal(project.mcpServers.svc.enabled, false);
  assert.equal(project.mcpServers.svc.exposure, "deferred");
  assert.deepEqual(project.mcpServers.svc.toolExposure, { "read*": "direct" });
  assert.equal(project.mcpServers.svc.timeout, 3);
  assert.deepEqual(project.projectRoot, [1, 2]);
  assert.equal(project.note, "kept");
  assert.equal(project.imports, undefined);
  assert.equal(project.settings, undefined);
  assert.equal(global.mcpServers.projectOnly, undefined);
  assert.equal(plan.origins["project:svc"].requiresProjectTrust, true);
  assert.equal(plan.origins["project:svc"].paths.length, 5);
});

test("project-relative import requested from global remains project-gated; untrusted projection uses later global import", () => {
  const data = input([null, { imports: ["vscode", "cursor"], mcpServers: {} }, null, null]);
  data.imports = [
    { kind: "vscode", path: resolve("migration-fixture/.vscode/mcp.json"), text: JSON.stringify({ mcpServers: { workspace: { command: "workspace-secret" }, overlap: { command: "workspace" } } }) },
    { kind: "cursor", path: resolve("migration-fixture/cursor.json"), text: JSON.stringify({ mcpServers: { overlap: { command: "global" } } }) },
  ];
  const plan = planNativeMcpMigration(data);
  assert.deepEqual(plan.blockers, []);
  assert.equal(raw(plan).mcpServers.workspace, undefined);
  assert.equal(raw(plan).mcpServers.overlap.command, "global");
  assert.equal(raw(plan, "project").mcpServers.overlap.command, "workspace");
  assert.equal(raw(plan, "project").mcpServers.workspace.command, "workspace-secret");
  assert.ok(codes(planNativeMcpMigration({ ...data, projectTrusted: false })).includes("project-trust"));
});

test("directTools booleans/selection and timeout milliseconds map without dropping native patterns", () => {
  const plan = planNativeMcpMigration(input([null, {
    settings: { directTools: true, requestTimeoutMs: 1250 },
    mcpServers: {
      all: { command: "all" },
      none: { command: "none", directTools: false, requestTimeoutMs: 2500.5 },
      selected: { command: "selected", directTools: ["read", "delete"], excludeTools: ["delete"], toolExposure: { "*": "deferred" } },
    },
  }, null, null]));
  assert.deepEqual(plan.blockers, []);
  const servers = raw(plan).mcpServers;
  assert.equal(servers.all.exposure, "direct");
  assert.equal(servers.all.timeout, 1.25);
  assert.equal(servers.none.exposure, "codemode");
  assert.equal(servers.none.timeout, 2.5005);
  assert.equal(servers.selected.exposure, "codemode");
  assert.equal(exposure(servers.selected, "read"), "direct");
  assert.equal(exposure(servers.selected, "delete"), "hidden");
  assert.equal(servers.selected.toolExposure["*"], "deferred");
});

test("literal exclusions enumerate original/prefixed/short normalized names; exact hidden beats all patterns", () => {
  const exclusions = ["my_server_mcp_read_file", "my_server_write-file", "remove-file"];
  const plan = planNativeMcpMigration(input([null, { mcpServers: { "my-server-mcp": { command: "server", excludeTools: exclusions, toolExposure: { "*": "direct", "read*": "codemode" } } } }, null, null]));
  assert.deepEqual(plan.blockers, []);
  const config = raw(plan).mcpServers["my-server-mcp"];
  const tools = ["read_file", "read-file", "my_server_mcp_read_file", "my-server-mcp-read-file", "write_file", "write-file", "my_server_write_file", "remove-file", "remove_file", "read_file_extra", "remove", "other"];
  for (const tool of tools) assert.equal(exposure(config, tool) === "hidden", isToolExcluded(tool, "my-server-mcp", "server", exclusions), tool);
  assert.equal(config.toolExposure["*"], "direct");
  assert.equal(config.toolExposure["read*"], "codemode");
});

test("wildcards and pre-existing exact exposure conflicts block rather than broadening/weakening denial", () => {
  for (const entry of [
    { excludeTools: ["delete_*"] }, { directTools: ["literal*"] },
    { excludeTools: ["delete"], toolExposure: { delete: "direct" } },
    { directTools: ["read"], toolExposure: { read: "hidden" } },
    { directTools: true, exposure: "codemode" },
    { excludeTools: ["get_secret_resource"] },
  ]) assert.ok(planNativeMcpMigration(input([null, { mcpServers: { svc: { command: "server", ...entry } } }, null, null])).blockers.length);
});

test("OAuth redirect/client config and bearer env map; no legacy token fields or stores", () => {
  const plan = planNativeMcpMigration(input([null, {
    mcpServers: {
      oauth: { url: "https://example.test/mcp", auth: "oauth", oauth: { grantType: "authorization_code", clientId: "id", clientSecret: "${OAUTH_SECRET}", scope: "read", redirectUri: "http://localhost:8765/exact" } },
      bearer: { url: "https://example.test/mcp", auth: "bearer", bearerTokenEnv: "TOKEN_ENV" },
      literal: { url: "https://example.test/mcp", auth: "bearer", bearerToken: "secret-token" },
      denied: { url: "https://example.test/mcp", auth: false, oauth: false, headers: { Authorization: "static" } },
    },
  }, null, null]));
  assert.deepEqual(plan.blockers, []);
  const servers = raw(plan).mcpServers;
  assert.deepEqual(servers.oauth.oauth, { clientId: "id", clientSecret: "${OAUTH_SECRET}", scope: "read", callbackUrl: "http://localhost:8765/exact" });
  assert.deepEqual(servers.bearer.headers, { Authorization: "Bearer ${TOKEN_ENV}" });
  assert.equal(servers.literal.headers.Authorization, "Bearer secret-token");
  assert.equal(servers.denied.oauth, undefined);
  for (const server of Object.values(servers) as any[]) {
    assert.equal(server.auth, undefined);
    assert.equal(server.bearerToken, undefined);
    assert.equal(server.bearerTokenEnv, undefined);
  }
  assert.ok(plan.warnings.some((issue) => issue.code === "oauth-login"));
});

test("unsupported SSE/names/denial/resources/prefix/timeouts/OAuth/lifecycle/settings all fail closed", () => {
  const examples: [Record<string, unknown>, string][] = [
    [{ type: "sse", url: "https://example.test/mcp" }, "sse"],
    [{ url: "https://example.test/sse" }, "sse"],
    [{ url: "https://example.test/mcp", auth: false }, "auth-denial"],
    [{ url: "https://example.test/mcp", oauth: false }, "auth-denial"],
    [{ url: "https://example.test/mcp", headers: { "X-API": "secret" } }, "auth-denial"],
    [{ exposeResources: false }, "resources"], [{ exposeResources: true }, "resources"],
    [{ requestTimeoutMs: 0 }, "timeout"], [{ timeout: 2, requestTimeoutMs: 1000 }, "timeout"],
    [{ url: "https://example.test/mcp", oauth: { grantType: "client_credentials" } }, "oauth-grant"],
    [{ url: "https://example.test/mcp", oauth: { redirectUri: "https://example.test/callback" } }, "oauth-redirect"],
    [{ url: "https://example.test/mcp", oauth: { redirectUri: "http://localhost/callback" } }, "oauth-redirect"],
    [{ lifecycle: "lazy" }, "lifecycle"], [{ idleTimeout: 10 }, "lifecycle"],
    [{ env: { SECRET: "!echo secret" } }, "value-semantics"],
    [{ headers: { Authorization: "$env:TOKEN" } }, "value-semantics"],
    [{ oauth: { tokens: { accessToken: "secret" } } }, "oauth"],
  ];
  for (const [entry, code] of examples) {
    const plan = planNativeMcpMigration(input([null, { mcpServers: { svc: { command: "server", ...entry, ...(entry.url ? { command: undefined } : {}) } } }, null, null]));
    assert.ok(codes(plan).includes(code), `${code}: ${JSON.stringify(entry)}`);
  }
  assert.ok(codes(planNativeMcpMigration(input([null, { mcpServers: { "bad/name": { command: "server" } } }, null, null]))).includes("server-name"));
  for (const settings of [{ toolPrefix: "server" }, { samplingAutoApprove: true }, { disableProxyTool: true }, { outputGuard: false }]) assert.ok(planNativeMcpMigration(input([null, { mcpServers: { svc: { command: "server" } }, settings }, null, null])).blockers.length);
  const eager = planNativeMcpMigration(input([null, { mcpServers: { svc: { command: "server", lifecycle: "eager", idleTimeout: 0 } } }, null, null]));
  assert.deepEqual(eager.blockers, []);
});

test("Apps/Fabric gaps are explicit blockers, not substitutes for a legacy manager", () => {
  const data = input([null, { mcpServers: {} }, null, null]);
  const plan = planNativeMcpMigration({ ...data, legacyFeatures: { apps: true, fabric: true } });
  assert.deepEqual(codes(plan), ["mcp-apps", "fabric-route"]);
});

test("redacted preview never emits untrusted names, command/args/env/URL/OAuth/unknown-root values or field names", () => {
  const secret = "DO_NOT_SHOW_ME";
  const data = input([null, {
    [secret]: secret,
    mcpServers: { [secret]: { command: secret, args: [secret], env: { [secret]: `!${secret}` }, url: `https://${secret}.test?token=${secret}`, headers: { Authorization: secret }, oauth: { clientSecret: secret, [secret]: secret }, directTools: [secret], excludeTools: [secret], [secret]: secret } },
    settings: { [secret]: secret },
  }, null, null]);
  data.sources = data.sources.map((source) => ({ ...source, path: source.path.replace("migration-fixture", secret) }));
  data.globalTarget = data.sources[1].path;
  data.projectTarget = data.sources[3].path;
  const preview = previewNativeMcpMigration(planNativeMcpMigration(data));
  assert.equal(preview.includes(secret), false);
  assert.ok(preview.includes("dry-run"));
  assert.ok(preview.includes('"canApply": false'));
});

test("invalid JSON/imports and untrusted project sources are reported, never silently lost", () => {
  const data = input([null, { imports: ["unknown", "cursor"] }, { mcpServers: { project: { command: "project" } } }, null]);
  data.projectTrusted = false;
  data.sources[0].text = '{"secret-value"';
  const plan = planNativeMcpMigration(data);
  for (const code of ["invalid-json", "project-trust", "import-kind", "import-missing"]) assert.ok(codes(plan).includes(code));
  assert.equal(raw(plan).mcpServers.project, undefined);
});

test("apply requires explicit approval, backups are byte-exact/private, sources/imports untouched, repeat plan is no-op", (t) => {
  const data = fixture(t, [{ extra: "kept", mcpServers: { global: { command: "global" } } }, null, { mcpServers: { project: { command: "project", enabled: false } } }, null]);
  const plan = planNativeMcpMigration(data);
  assert.throws(() => applyNativeMcpMigration(plan, { approved: false }), /approval/);
  assert.equal(fs.existsSync(data.globalTarget), false);
  const receipt = applyNativeMcpMigration(plan, { approved: true })!;
  assert.equal(receipt.state, "committed");
  assert.equal(receipt.version, 1);
  for (const source of [data.sources[0], data.sources[2]]) assert.equal(fs.readFileSync(source.path, "utf8"), source.text);
  for (const file of receipt.files) {
    assert.equal(fs.readFileSync(file.backupPath, "utf8"), "");
    if (process.platform !== "win32") assert.equal(fs.statSync(file.backupPath).mode & 0o777, 0o600);
  }
  const again = planNativeMcpMigration({ ...data, sources: data.sources.map((source) => ({ ...source, text: fs.existsSync(source.path) ? fs.readFileSync(source.path, "utf8") : null })) });
  assert.deepEqual(again.blockers, []);
  assert.deepEqual(again.writes, []);
  assert.equal(applyNativeMcpMigration(again, { approved: true }), null);
  assert.equal(fs.readFileSync(receipt.receiptPath, "utf8").includes("command"), false);
  rollbackNativeMcpMigration(receipt.receiptPath, { approved: true });
  assert.equal(fs.existsSync(data.globalTarget), false);
  assert.equal(fs.existsSync(data.projectTarget), false);
  assert.equal(rollbackNativeMcpMigration(receipt.receiptPath, { approved: true }).state, "rolled-back");
});

test("standalone backup and rollback restore existing exact bytes and detect corrupted backups/post-migration edits", (t) => {
  const data = fixture(t, [null, { mcpServers: { svc: { command: "server", directTools: true } } }, null, null]);
  const plan = planNativeMcpMigration(data);
  const backup = backupNativeMcpMigration(plan, { approved: true })!;
  assert.equal(backup.state, "prepared");
  assert.equal(fs.readFileSync(data.globalTarget, "utf8"), data.sources[1].text);
  const receipt = applyNativeMcpMigration(plan, { approved: true })!;
  const migrated = fs.readFileSync(data.globalTarget, "utf8");
  fs.writeFileSync(data.globalTarget, "external edit");
  assert.throws(() => rollbackNativeMcpMigration(receipt.receiptPath, { approved: true }), /post-migration/);
  assert.equal(fs.readFileSync(data.globalTarget, "utf8"), "external edit");
  fs.writeFileSync(data.globalTarget, migrated);
  const originalBackup = fs.readFileSync(receipt.files[0].backupPath, "utf8");
  fs.writeFileSync(receipt.files[0].backupPath, "corrupted");
  assert.throws(() => rollbackNativeMcpMigration(receipt.receiptPath, { approved: true }), /checksum/);
  fs.writeFileSync(receipt.files[0].backupPath, originalBackup);
  assert.throws(() => rollbackNativeMcpMigration(receipt.receiptPath, { approved: false }), /approval/);
  rollbackNativeMcpMigration(receipt.receiptPath, { approved: true });
  assert.equal(fs.readFileSync(data.globalTarget, "utf8"), data.sources[1].text);
});

test("source/import CAS rejects edits after dry-run before creating any backups", (t) => {
  const data = fixture(t, [{ mcpServers: { svc: { command: "server" } } }, null, null, null]);
  const plan = planNativeMcpMigration(data);
  fs.writeFileSync(data.sources[0].path, "changed");
  assert.throws(() => applyNativeMcpMigration(plan, { approved: true }), /source changed/);
  assert.equal(fs.existsSync(data.globalTarget), false);
  assert.deepEqual(fs.readdirSync(join(data.globalTarget, "..")).filter((file) => file.includes("migration")), []);
});

test("second commit failure rolls back the first atomic commit; prepared receipt supports crash recovery", (t) => {
  const data = fixture(t, [{ mcpServers: { global: { command: "global" } } }, null, { mcpServers: { project: { command: "project" } } }, null]);
  const plan = planNativeMcpMigration(data);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === data.projectTarget) throw new Error("forced second commit failure");
    return rename(from, to);
  });
  assert.throws(() => applyNativeMcpMigration(plan, { approved: true }), /forced second commit failure/);
  assert.equal(fs.existsSync(data.globalTarget), false);
  assert.equal(fs.existsSync(data.projectTarget), false);
  const receiptPath = join(dirnameOf(data.globalTarget), fs.readdirSync(dirnameOf(data.globalTarget)).find((file) => file.includes("migration-v1-") && file.endsWith(".json"))!);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, "utf8")).state, "prepared");
  assert.equal(rollbackNativeMcpMigration(receiptPath, { approved: true }).state, "rolled-back");
  for (const target of [data.globalTarget, data.projectTarget]) assert.deepEqual(fs.readdirSync(dirnameOf(target)).filter((file) => file.endsWith(".tmp") || file.endsWith(".lock")), []);
});
function dirnameOf(path: string): string { return resolve(path, ".."); }

test("destination changed during staging is not clobbered; concurrent operation lock is never stolen", (t) => {
  const data = fixture(t, [null, { mcpServers: { svc: { command: "old", directTools: true } } }, null, null]);
  const plan = planNativeMcpMigration(data);
  const fsync = fs.fsyncSync;
  let writes = 0;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    fsync(fd);
    if (++writes === 4) fs.writeFileSync(data.globalTarget, "external-edit"); // lock, backup, receipt, staging
  });
  assert.throws(() => applyNativeMcpMigration(plan, { approved: true }), /destination changed/);
  assert.equal(fs.readFileSync(data.globalTarget, "utf8"), "external-edit");
  t.mock.restoreAll();
  fs.writeFileSync(data.globalTarget, data.sources[1].text!);
  fs.writeFileSync(`${data.globalTarget}.maestro-migration.lock`, "other-operation");
  assert.throws(() => applyNativeMcpMigration(plan, { approved: true }));
  assert.equal(fs.readFileSync(`${data.globalTarget}.maestro-migration.lock`, "utf8"), "other-operation");
});

test("unsafe parent/destination symlinks are refused and never write outside the workspace", (t) => {
  const data = fixture(t, [{ mcpServers: { svc: { command: "server" } } }, null, null, null]);
  const outside = fs.mkdtempSync(join(tmpdir(), "native-mcp-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(dirnameOf(data.globalTarget), { recursive: true });
  try { fs.symlinkSync(outside, dirnameOf(data.globalTarget), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.skip("symlink privileges unavailable"); return; } throw error; }
  assert.throws(() => applyNativeMcpMigration(planNativeMcpMigration(data), { approved: true }), /Unsafe migration parent/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("changed watched source after migration blocks rerun instead of silently re-importing", (t) => {
  const data = fixture(t, [{ mcpServers: { svc: { command: "server" } } }, null, null, null]);
  applyNativeMcpMigration(planNativeMcpMigration(data), { approved: true });
  fs.writeFileSync(data.sources[0].path, JSON.stringify({ mcpServers: { svc: { command: "changed" } } }));
  const changed = { ...data, sources: data.sources.map((source) => ({ ...source, text: fs.existsSync(source.path) ? fs.readFileSync(source.path, "utf8") : null })) };
  assert.ok(codes(planNativeMcpMigration(changed)).includes("migration-source-changed"));
});

test("collector reads four sources/import paths in isolated HOME without OAuth access and detects Apps metadata", (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "native-mcp-collector-"));
  const home = join(dir, "home");
  const cwd = join(dir, "workspace");
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  fs.writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: { svc: { command: "server" } } }));
  fs.writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "mcp-cache.json"), JSON.stringify({ servers: { svc: { tools: [{ uiResourceUri: "ui://app" }] } } }));
  const read = fs.readFileSync;
  const lstat = fs.lstatSync;
  const seen: string[] = [];
  t.mock.method(fs, "lstatSync", (path: fs.PathLike, ...args: any[]) => {
    const p = resolve(String(path));
    if (!p.startsWith(dir) && !dir.startsWith(`${p}\\`) && !dir.startsWith(`${p}/`)) throw Object.assign(new Error("isolated fixture"), { code: "ENOENT" });
    return (lstat as any)(path, ...args);
  });
  t.mock.method(fs, "readFileSync", (path: fs.PathOrFileDescriptor, ...args: any[]) => { seen.push(String(path)); assert.ok(resolve(String(path)).startsWith(dir)); return (read as any)(path, ...args); });
  const collected = collectNativeMcpMigrationInput(cwd, true);
  assert.deepEqual(collected.sources.map((source) => source.id), ids);
  assert.equal(collected.legacyFeatures?.apps, true);
  assert.equal(seen.some((path) => /oauth|mcp-auth/.test(path)), false);
  // Global helper caches homedir on import; the lstat guard excludes all non-fixture config files.
});

test("registers only the nonconflicting command; dry-run/headless apply/declined apply never write", async (t) => {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const commands: string[] = [];
  const pi = { registerCommand(name: string, definition: any) { commands.push(name); handler = definition.handler; } } as unknown as ExtensionAPI;
  registerNativeMcpMigration(pi);
  assert.deepEqual(commands, ["maestro-mcp-migrate"]);
  const ctx = { hasUI: false, cwd: resolve("migration-fixture"), isProjectTrusted: () => false, ui: { notify() {}, confirm: async () => false } } as unknown as ExtensionCommandContext;
  let writes = 0;
  t.mock.method(fs, "lstatSync", () => { throw Object.assign(new Error("isolated empty config"), { code: "ENOENT" }); });
  t.mock.method(fs, "openSync", () => { writes++; throw new Error("writes forbidden"); });
  await handler!("", ctx);
  await handler!("dry-run", ctx);
  await handler!("apply", ctx);
  await handler!("rollback absent", ctx);
  await handler!("apply --yes", ctx);
  ctx.hasUI = true;
  await handler!("apply", ctx);
  assert.equal(writes, 0);
});

test("command requires apply plus approval and rechecks source/trust after the dialog", async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "native-mcp-command-"));
  const agent = join(dir, "agent");
  const cwd = join(dir, "workspace");
  fs.mkdirSync(agent); fs.mkdirSync(cwd);
  const path = join(agent, "mcp.json");
  const before = JSON.stringify({ mcpServers: { svc: { command: "server", directTools: true } } });
  fs.writeFileSync(path, before);
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (path: fs.PathLike, ...args: any[]) => {
    const p = resolve(String(path));
    if (!p.startsWith(dir) && !dir.startsWith(p + sep)) throw Object.assign(new Error("isolated fixture"), { code: "ENOENT" });
    return (lstat as any)(path, ...args);
  });
  let handler: any;
  registerNativeMcpMigration({ registerCommand(_name: string, command: any) { handler = command.handler; } } as unknown as ExtensionAPI);
  let approvals = 0;
  let approve = false;
  const messages: string[] = [];
  const ctx = { hasUI: true, cwd, isProjectTrusted: () => true, ui: { notify: (text: string) => messages.push(text), confirm: async () => { approvals++; return approve; } } };
  await handler("", ctx);
  assert.equal(approvals, 0);
  assert.equal(fs.readFileSync(path, "utf8"), before);
  await handler("apply", { ...ctx, hasUI: false });
  assert.equal(approvals, 0);
  assert.equal(fs.readFileSync(path, "utf8"), before);
  await handler("apply", ctx);
  assert.equal(approvals, 1);
  assert.equal(fs.readFileSync(path, "utf8"), before);
  await handler("apply", { ...ctx, ui: { ...ctx.ui, confirm: async () => { fs.writeFileSync(path, "external-change"); return true; } } });
  assert.equal(fs.readFileSync(path, "utf8"), "external-change");
  fs.writeFileSync(path, before);
  approve = true;
  await handler("apply", ctx);
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).mcpServers.svc.exposure, "direct");
  assert.ok(messages.some((message) => message.includes("Backup receipt:")));
  assert.ok(fs.readdirSync(agent).some((file) => file.endsWith(".bak")));
});

test("unrequested malformed import does not change legacy merge semantics; native callbackUrl may omit its port", () => {
  const data = input([null, { mcpServers: { svc: { url: "https://example.test/mcp", oauth: { callbackUrl: "http://localhost/callback" }, exposure: "deferred", timeout: 42 } } }, null, null]);
  data.imports = [{ kind: "cursor", path: resolve("unused.json"), text: "invalid JSON" }];
  const plan = planNativeMcpMigration(data);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.snapshots.some((doc) => doc.path.endsWith("unused.json")), false);
  assert.equal(raw(plan).mcpServers.svc.oauth.callbackUrl, "http://localhost/callback");
  assert.equal(raw(plan).mcpServers.svc.timeout, 42);
  assert.equal(raw(plan).mcpServers.svc.exposure, "deferred");
});

test("preview includes actionable public fields and refusal reasons without exposing server identifiers", () => {
  const plan = planNativeMcpMigration(input([null, { mcpServers: { private_name: { command: "server", requestTimeoutMs: 2500, exposeResources: false } } }, null, null]));
  const preview = previewNativeMcpMigration(plan);
  assert.match(preview, /requestTimeoutMs/);
  assert.match(preview, /exposeResources/);
  assert.match(preview, /independent per-server resource switch/);
  assert.doesNotMatch(preview, /private_name/);
  assert.match(preview, /server-1/);
});

test("rollback refuses targets outside the approved scope before restoring any destination", (t) => {
  const data = fixture(t, [{ mcpServers: { global: { command: "global" } } }, null, { mcpServers: { project: { command: "project" } } }, null]);
  const receipt = applyNativeMcpMigration(planNativeMcpMigration(data), { approved: true })!;
  const beforeGlobal = fs.readFileSync(data.globalTarget, "utf8");
  const beforeProject = fs.readFileSync(data.projectTarget, "utf8");
  assert.throws(() => rollbackNativeMcpMigration(receipt.receiptPath, { approved: true, allowedTargets: [data.globalTarget] }), /approved config scope/);
  assert.equal(fs.readFileSync(data.globalTarget, "utf8"), beforeGlobal);
  assert.equal(fs.readFileSync(data.projectTarget, "utf8"), beforeProject);
});

test("unreadable App metadata is an explicit migration blocker", () => {
  const plan = planNativeMcpMigration({ ...input([null, { mcpServers: {} }, null, null]), legacyFeatures: { appsMetadataUnreadable: true } });
  assert.ok(codes(plan).includes("mcp-apps-unknown"));
});

test("generated config is accepted by native Pi and its real exposure matcher preserves denial", async (t) => {
  const data = fixture(t, [null, { mcpServers: { svc: { command: "server", directTools: true, excludeTools: ["delete"], requestTimeoutMs: 1250 } } }, null, null]);
  applyNativeMcpMigration(planNativeMcpMigration(data), { approved: true });
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const native = await import(new URL("./extensions/mcp/config.js", entry).href);
  const loaded = native.loadMcpConfig({ agentDir: dirnameOf(data.globalTarget), cwd: dirnameOf(dirnameOf(data.projectTarget)), projectTrusted: true });
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.servers.length, 1);
  assert.equal(loaded.servers[0].config.timeout, 1.25);
  assert.equal(native.getMcpToolExposure(loaded.servers[0].config, "delete"), "hidden");
  assert.equal(native.getMcpToolExposure(loaded.servers[0].config, "read"), "direct");
});
