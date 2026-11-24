import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { SETTINGS_LOCALE_EVENT, SETTINGS_PROTOCOL_VERSION, type SupportedSettingsLocale } from "pi-graph-shared-settings/v1";
import { getTuiLocale, registerTuiLocaleEvents } from "../src/tui/locale.ts";
import {
  createBoundSshToolContext,
  MaskedSecretInput,
  parseSshToolInput,
  SshExecutor,
  SshHostManagerOverlay,
  SshHostPickerOverlay,
  SshToolParams,
  type SshHost,
  type SshHostManagerAction,
  type SshKey,
} from "../src/ssh-manager/index.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};
const PIN = `SHA256:${"A".repeat(43)}`;

const hosts: SshHost[] = [
  {
    id: "alpha-1",
    label: "Alpha server",
    host: "alpha.example.test",
    user: "alice",
    port: 22,
    shell: "bash",
    hostKey: PIN,
    auth: { kind: "password", password: "password-list-secret" },
    tags: ["production", "linux"],
    jumpHostId: null,
    monitorEnabled: true,
  },
  {
    id: "beta-1",
    label: "Beta server",
    host: "beta.example.test",
    user: "bob",
    port: 2200,
    shell: "powershell",
    hostKey: PIN,
    auth: { kind: "identity", path: "/secret/location/id_beta", passphrase: "passphrase-list-secret" },
    tags: ["windows"],
    jumpHostId: "alpha-1",
    monitorEnabled: false,
  },
];

test("masked secret input never renders the master/auth secret and clears it after submit", () => {
  let submitted: string | undefined;
  const input = new MaskedSecretInput({
    title: "Master password",
    prompt: "Unlock encrypted SSH hosts",
    theme,
    requestRender() {},
    done(secret) { submitted = secret; },
  });
  input.handleInput("\x1b[200~master-password-secret\x1b[201~");
  const rendered = input.render(80).join("\n");
  assert.doesNotMatch(rendered, /master-password-secret/);
  assert.match(rendered, /\*+/);
  input.handleInput("\r");
  assert.equal(submitted, "master-password-secret");
  assert.doesNotMatch(input.render(80).join("\n"), /\*/);
});

test("SSH host manager lists no secrets and implements explicit slash filtering and actions", () => withSshLocale("en", () => {
  let action: SshHostManagerAction | undefined;
  const overlay = new SshHostManagerOverlay({
    hosts,
    selectedHostIds: ["alpha-1"],
    theme,
    requestRender() {},
    done(next) { action = next; },
  });

  const rendered = overlay.render(140).join("\n");
  assert.match(rendered, /\[x\].*Alpha server/);
  assert.match(rendered, /\[ \].*Beta server/);
  assert.match(rendered, /alice@alpha\.example\.test:22/);
  assert.match(rendered, /tags production,linux.*jump direct.*trusted.*monitor checking/);
  assert.match(rendered, /jump Alpha server.*monitor disabled/);
  assert.doesNotMatch(rendered, /password-list-secret|passphrase-list-secret|secret\/location|SHA256:/);
  for (let width = 1; width <= 120; width += 1) {
    for (const line of overlay.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
  }

  overlay.handleInput("/");
  overlay.handleInput("\x1b[200~windows\x1b[201~");
  const filtered = overlay.render(100).join("\n");
  assert.match(filtered, /Beta server/);
  assert.doesNotMatch(filtered, /Alpha server/);
  overlay.handleInput("T");
  assert.equal(action, undefined, "action keys are text while filter mode is active");
  overlay.handleInput("\x1b");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("T");
  assert.equal(action?.kind, "test");
  assert.equal(action?.hostId, "beta-1");

  action = undefined;
  const emptyOverlay = new SshHostManagerOverlay({ hosts: [], theme, requestRender() {}, done(next) { action = next; } });
  const emptyRendered = emptyOverlay.render(100).join("\n");
  assert.match(emptyRendered, /no SSH servers configured/);
  assert.match(emptyRendered, /Press A to add your first SSH server/);
  emptyOverlay.handleInput("A");
  assert.equal(action?.kind, "add");

  action = undefined;
  const addOverlay = new SshHostManagerOverlay({ hosts, theme, requestRender() {}, done(next) { action = next; } });
  addOverlay.handleInput("A");
  assert.equal(action?.kind, "add");
  const selectOverlay = new SshHostManagerOverlay({ hosts, selectedHostIds: ["alpha-1"], initialHostId: "beta-1", theme, requestRender() {}, done(next) { action = next; } });
  selectOverlay.handleInput(" ");
  assert.equal(action?.kind, "toggle-select");
  assert.equal(action?.hostId, "beta-1");

  action = undefined;
  const exclusiveOverlay = new SshHostManagerOverlay({ hosts, selectedHostIds: ["alpha-1", "beta-1"], theme, requestRender() {}, done(next) { action = next; } });
  exclusiveOverlay.handleInput("\x1b[B");
  exclusiveOverlay.handleInput("\r");
  assert.equal(action?.kind, "select");
  assert.equal(action?.hostId, "beta-1");

  action = undefined;
  const lockOverlay = new SshHostManagerOverlay({ hosts, theme, requestRender() {}, done(next) { action = next; } });
  lockOverlay.handleInput("L");
  assert.equal(action?.kind, "lock");
}));

test("SSH attachment picker supports multi-select, legacy Enter, filtering, and cancel", () => {
  let picked: string[] | undefined;
  let completed = false;
  const picker = new SshHostPickerOverlay({
    hosts,
    theme,
    requestRender() {},
    done(value) { completed = true; picked = value; },
  });
  assert.match(picker.render(120).join("\n"), /\[ \].*Alpha server[\s\S]*\[ \].*Beta server/);
  assert.doesNotMatch(picker.render(120).join("\n"), /password-list-secret|passphrase-list-secret|SHA256:/);
  picker.handleInput(" ");
  picker.handleInput("\x1b[B");
  picker.handleInput(" ");
  picker.handleInput("\r");
  assert.equal(completed, true);
  assert.deepEqual(picked, ["alpha-1", "beta-1"]);

  completed = false;
  picked = undefined;
  const legacyPicker = new SshHostPickerOverlay({ hosts, theme, requestRender() {}, done(value) { completed = true; picked = value; } });
  legacyPicker.handleInput("\r");
  assert.equal(completed, true);
  assert.deepEqual(picked, ["alpha-1"], "Enter without prior toggles preserves the old single-select flow");

  completed = false;
  const filteredPicker = new SshHostPickerOverlay({ hosts, theme, requestRender() {}, done(value) { completed = true; picked = value; } });
  filteredPicker.handleInput("/");
  filteredPicker.handleInput("\x1b[200~win");
  assert.match(filteredPicker.render(100).join("\n"), /Alpha server/, "an incomplete paste remains buffered");
  filteredPicker.handleInput("dows\x1b[201~");
  assert.match(filteredPicker.render(100).join("\n"), /Beta server/);
  assert.doesNotMatch(filteredPicker.render(100).join("\n"), /Alpha server/);
  filteredPicker.handleInput(" ");
  assert.equal(completed, false, "Space remains filter text while filtering");
  filteredPicker.handleInput("\x1b");
  assert.match(filteredPicker.render(100).join("\n"), /Alpha server/);
  filteredPicker.handleInput("\x1b");
  assert.equal(completed, true);
  assert.equal(picked, undefined);
});

test("SSH attachment picker localizes its controls without changing selection", () => {
  for (const locale of ["en", "zh-CN"] as const) withSshLocale(locale, () => {
    let picked: string[] | undefined;
    const picker = new SshHostPickerOverlay({ hosts, theme, requestRender() {}, done(value) { picked = value; } });
    const rendered = picker.render(120).join("\n");
    assert.match(rendered, locale === "en" ? /Attach SSH servers.*attached/ : /附加 SSH 服务器.*已附加/);
    assert.match(rendered, locale === "en" ? /Enter apply/ : /Enter 应用/);
    assert.doesNotMatch(rendered, /password-list-secret|passphrase-list-secret/);
    picker.handleInput(" ");
    picker.handleInput("\r");
    assert.deepEqual(picked, ["alpha-1"]);
  });
});

test("SSH manager Keys view renders metadata only and exposes managed-key CRUD", () => withSshLocale("en", () => {
  const keys: SshKey[] = [{
    id: "key-1", label: "Deploy key", privateKey: "private-key-secret", passphrase: "key-passphrase-secret",
    publicKeyFingerprint: PIN, createdAt: "2026-01-01T00:00:00.000Z",
  }];
  let action: SshHostManagerAction | undefined;
  const overlay = new SshHostManagerOverlay({ hosts, keys, theme, requestRender() {}, done(next) { action = next; } });
  overlay.handleInput("K");
  const rendered = overlay.render(120).join("\n");
  assert.match(rendered, /\[Keys\].*1\/1/);
  assert.match(rendered, new RegExp(`Deploy key.*${PIN.replace(/[+]/gu, "\\+")}.*2026-01-01.*18 bytes`));
  assert.doesNotMatch(rendered, /private-key-secret|key-passphrase-secret/);
  overlay.handleInput("R");
  assert.equal(action?.kind, "replace-key");
  assert.equal(action?.keyId, "key-1");
}));

test("SSH manager and masked secret input render English and Chinese chrome without changing hotkeys or user data", () => {
  const keys: SshKey[] = [{
    id: "key-1", label: "Deploy key", privateKey: "private-key-secret", passphrase: "secret",
    publicKeyFingerprint: PIN, createdAt: "2026-01-01T00:00:00.000Z",
  }];
  const statuses = new Map([["alpha-1", { status: "online" as const, checkedAt: null }]]);
  for (const locale of ["en", "zh-CN"] as const) withSshLocale(locale, () => {
    let action: SshHostManagerAction | undefined;
    const overlay = new SshHostManagerOverlay({ hosts, keys, statuses, theme, requestRender() {}, done(next) { action = next; } });
    const rendered = overlay.render(140).join("\n");
    assert.match(rendered, /Alpha server|Beta server/);
    assert.match(rendered, /production,linux/);
    assert.doesNotMatch(rendered, /password-list-secret|passphrase-list-secret|SHA256:/);
    if (locale === "en") {
      assert.match(rendered, /SSH Manager.*\[Hosts\]/);
      assert.match(rendered, /tags production,linux.*jump direct.*trusted.*monitor online/);
      assert.match(rendered, /Esc close.*↑↓ select/);
    } else {
      assert.match(rendered, /SSH 管理器.*\[主机\]/);
      assert.match(rendered, /标记 production,linux.*跳板 直连.*已信任.*监控 在线/);
      assert.match(rendered, /Esc 关闭.*↑↓ 选择/);
      assert.doesNotMatch(rendered, /SSH Manager|monitor online/);
    }
    overlay.handleInput("/");
    assert.match(overlay.render(140).join("\n"), locale === "en" ? /Filtering:.*Esc clear/ : /筛选中：.*Esc 清除/);
    overlay.handleInput("Beta");
    overlay.handleInput("\x1b");
    assert.match(overlay.render(140).join("\n"), /Alpha server/, "filter Esc returns to the manager");
    assert.equal(action, undefined);
    overlay.handleInput("K");
    const keyView = overlay.render(140).join("\n");
    assert.match(keyView, /Deploy key/);
    assert.match(keyView, new RegExp(PIN));
    assert.match(keyView, locale === "en" ? /\[Keys\]/ : /\[密钥\]/);
    assert.match(keyView, locale === "en" ? /created 2026-01-01/ : /创建于 2026-01-01/);
    overlay.handleInput("R");
    assert.equal(action?.kind, "replace-key");

    const missingJump: SshHost = {
      ...hosts[0]!, label: "保留MyLabel", hostKey: null, jumpHostId: "missing-host",
      auth: { kind: "key", keyId: "key-1" }, tags: ["用户Tag"],
    };
    const exceptional = new SshHostManagerOverlay({
      hosts: [missingJump], keys, statuses: new Map([[missingJump.id, { status: "offline", checkedAt: null }]]),
      theme, requestRender() {}, done() {},
    });
    const exceptionalView = exceptional.render(140).join("\n");
    assert.match(exceptionalView, /保留MyLabel/);
    assert.match(exceptionalView, /用户Tag/);
    assert.match(exceptionalView, locale === "en"
      ? /key Deploy key.*jump missing jump.*untrusted.*monitor offline/
      : /密钥 Deploy key.*跳板 跳板机缺失.*未信任.*监控 离线/);
    for (let width = 1; width <= 120; width += 1) {
      for (const line of exceptional.render(width)) assert.ok(visibleWidth(line) <= width, `locale ${locale}, width ${width}`);
    }

    const empty = new SshHostManagerOverlay({ hosts: [], theme, requestRender() {}, done() {} });
    assert.match(empty.render(140).join("\n"), locale === "en" ? /no SSH servers configured.*\n.*Press A/ : /尚未配置 SSH 服务器.*\n.*按 A/);
    empty.handleInput("K");
    assert.match(empty.render(140).join("\n"), locale === "en" ? /no SSH keys configured/ : /尚未配置 SSH 密钥/);
    const secret = new MaskedSecretInput({ title: "Master password", prompt: "Unlock SSH", theme, requestRender() {}, done() {} });
    secret.handleInput("sensitive-password");
    const secretView = secret.render(100).join("\n");
    assert.match(secretView, /Master password.*\n/);
    assert.doesNotMatch(secretView, /sensitive-password/);
    assert.match(secretView, locale === "en" ? /Enter confirm.*Esc cancel/ : /Enter 确认.*Esc 取消/);
    assert.match(secret.render(19).join("\n"), locale === "en" ? /Secret input/ : /密码输入/);
  });
});

function withSshLocale(locale: SupportedSettingsLocale, run: () => void): void {
  const previous = getTuiLocale();
  let listener: ((payload: unknown) => void) | undefined;
  const dispose = registerTuiLocaleEvents({ on(event, handler) {
    assert.equal(event, SETTINGS_LOCALE_EVENT);
    listener = handler;
  } });
  const emit = (value: SupportedSettingsLocale): void => listener?.({ version: SETTINGS_PROTOCOL_VERSION, locale: value, generation: "ssh-tui-test" });
  try { emit(locale); run(); }
  finally { emit(previous); dispose(); }
}

test("LLM SSH tool schema keeps legacy commands and Gateway actions hostless", async () => {
  assert.doesNotThrow(() => parseSshToolInput({ command: "id", cwd: "/srv", timeout: 5 }));
  assert.doesNotThrow(() => parseSshToolInput({ action: "describe", tool: "host" }));
  assert.throws(() => parseSshToolInput({ command: "id", action: "status" }));
  assert.equal(Value.Check(SshToolParams, { action: "status", host: "alpha.example.test" }), false);
  assert.equal(Value.Check(SshToolParams, { action: "call", tool: "host", auth: {}, password: "secret" }), false);
  assert.equal(Value.Check(SshToolParams, { action: "job_start", targetId: "alpha-1", command: "sleep 10" }), true);
  assert.equal(Value.Check(SshToolParams, { action: "job_exec", sessionId: "ssh-session-1", command: "echo next" }), true);
  assert.throws(() => parseSshToolInput({ action: "job_exec", targetId: "alpha-1", sessionId: "ssh-session-1", command: "echo next" }));

  const provider = { current: [...hosts], getHosts() { return this.current; } };
  const context = createBoundSshToolContext(provider, new SshExecutor(), "alpha-1");
  assert.equal(context.hostId, "alpha-1");
  assert.match(context.systemContext, /command, cwd, and timeout only/);
  assert.doesNotMatch(context.systemContext, /password-list-secret|alpha\.example\.test/);
  provider.current = [];
  await assert.rejects(context.execute({ command: "id" }), /selected SSH host is unavailable/i);
});
