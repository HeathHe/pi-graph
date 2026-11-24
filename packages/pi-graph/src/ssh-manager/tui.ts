import {
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import {
  fit,
  frame,
  headerLine,
  helpLine,
  rule,
  type FrameTheme,
} from "../tui/ui-primitives.ts";
import {
  BracketedPasteDecoder,
  removeLastGrapheme,
  sanitizeSingleLineInput,
} from "../tui/input-text.ts";
import { getTuiLocale } from "../tui/locale.ts";
import type { SshHost, SshKey } from "./model.ts";
import type { SshHostOperationalStatus } from "./status-monitor.ts";

export interface SshManagerTheme extends FrameTheme {}

const SSH_TUI_TEXT = {
  en: {
    secretCompact: "Secret input · Esc",
    secretFooter: "Enter confirm · Esc cancel · Ctrl+U clear · Backspace delete",
    managerCompact: "SSH {view} · {count} · Esc",
    managerTitle: "SSH Manager",
    hosts: "Hosts",
    keys: "Keys",
    noHosts: "○ no SSH servers configured",
    noKeys: "○ no SSH keys configured",
    noMatches: "○ no {view} match the current filter",
    firstHost: "Press A to add your first SSH server; I imports OpenSSH config.",
    firstKey: "Press A to import a private key from a detected file or an explicit path.",
    filtering: "Filtering: {query} · Esc clear",
    filterHint: "type label, endpoint, user, or tag",
    listHelp: "Tab/H/K switch Hosts/Keys · / filter · showing {count}",
    close: "Esc close",
    select: "↑↓ select",
    attach: "Space attach",
    useOnly: "Enter use only",
    add: "A add",
    edit: "E edit",
    delete: "D delete",
    test: "T test",
    reset: "R reset",
    import: "I import",
    lock: "L lock",
    rename: "E rename",
    replace: "R replace",
    direct: "direct",
    missingJump: "missing jump",
    trusted: "trusted",
    untrusted: "untrusted",
    disabled: "disabled",
    checking: "checking",
    online: "online",
    offline: "offline",
    tags: "tags {tags}",
    jump: "jump {jump}",
    monitor: "monitor {status}",
    identity: "identity",
    password: "password",
    key: "key {label}",
    missingKey: "missing",
    agent: "agent",
    created: "created {date}",
    bytes: "{count} bytes",
    pickerCompact: "SSH targets · {count} attached · Esc",
    pickerTitle: "Attach SSH servers", pickerCount: "{count} attached",
    pickerEmpty: "○ no SSH servers match the current filter",
    pickerHelp: "↑↓ select · Space toggle · Enter apply · / filter",
    pickerFooter: "Esc cancel · selection remains local to this Pi session",
  },
  "zh-CN": {
    secretCompact: "密码输入 · Esc",
    secretFooter: "Enter 确认 · Esc 取消 · Ctrl+U 清空 · Backspace 删除",
    managerCompact: "SSH {view} · {count} · Esc",
    managerTitle: "SSH 管理器",
    hosts: "主机",
    keys: "密钥",
    noHosts: "○ 尚未配置 SSH 服务器",
    noKeys: "○ 尚未配置 SSH 密钥",
    noMatches: "○ 没有{view}符合当前筛选条件",
    firstHost: "按 A 添加第一台 SSH 服务器；按 I 导入 OpenSSH 配置。",
    firstKey: "按 A 从识别到的文件或指定路径导入私钥。",
    filtering: "筛选中：{query} · Esc 清除",
    filterHint: "输入标签、地址、用户或标记",
    listHelp: "Tab/H/K 切换主机/密钥 · / 筛选 · 显示 {count} 项",
    close: "Esc 关闭",
    select: "↑↓ 选择",
    attach: "Space 附加",
    useOnly: "Enter 仅使用此项",
    add: "A 添加",
    edit: "E 编辑",
    delete: "D 删除",
    test: "T 测试",
    reset: "R 重置",
    import: "I 导入",
    lock: "L 锁定",
    rename: "E 重命名",
    replace: "R 替换",
    direct: "直连",
    missingJump: "跳板机缺失",
    trusted: "已信任",
    untrusted: "未信任",
    disabled: "已禁用",
    checking: "检查中",
    online: "在线",
    offline: "离线",
    tags: "标记 {tags}",
    jump: "跳板 {jump}",
    monitor: "监控 {status}",
    identity: "身份文件",
    password: "密码",
    key: "密钥 {label}",
    missingKey: "缺失",
    agent: "代理",
    created: "创建于 {date}",
    bytes: "{count} 字节",
    pickerCompact: "SSH 目标 · 已附加 {count} 项 · Esc",
    pickerTitle: "附加 SSH 服务器", pickerCount: "已附加 {count} 项",
    pickerEmpty: "○ 没有 SSH 服务器符合当前筛选条件",
    pickerHelp: "↑↓ 选择 · Space 切换 · Enter 应用 · / 筛选",
    pickerFooter: "Esc 取消 · 选择仅在当前 Pi 会话中生效",
  },
} as const;

type SshTuiLocale = ReturnType<typeof getTuiLocale>;
type SshTuiTextKey = keyof typeof SSH_TUI_TEXT.en;

function sshText(key: SshTuiTextKey, locale: SshTuiLocale, vars?: Readonly<Record<string, string | number>>): string {
  const template: string = SSH_TUI_TEXT[locale][key];
  return vars ? template.replace(/\{(\w+)\}/gu, (_match, name: string) =>
    vars[name] === undefined ? `{${name}}` : String(vars[name])) : template;
}

export interface MaskedSecretInputParams {
  title: string;
  prompt: string;
  theme: SshManagerTheme;
  requestRender: () => void;
  done: (secret: string | undefined) => void;
  maximumLength?: number;
}

export class MaskedSecretInput implements Component, Focusable {
  focused = false;
  private value = "";

  constructor(private readonly params: MaskedSecretInputParams) {}
  invalidate(): void {}
  dispose(): void { this.value = ""; }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    const locale = getTuiLocale();
    if (safeWidth < 20) return [fit(sshText("secretCompact", locale), safeWidth)];
    const inner = safeWidth - 2;
    const masked = this.value.length > 0 ? "*".repeat(Math.min(this.value.length, Math.max(1, inner - 4))) : "";
    return frame([
      headerLine(this.params.theme, this.params.title, [], inner), rule(inner),
      helpLine(this.params.theme, this.params.prompt, inner), fit(`› ${masked}`, inner), rule(inner),
      fit(sshText("secretFooter", locale), inner),
    ], safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.value = ""; this.params.done(undefined); return; }
    if (matchesKey(data, Key.enter) || data === "\r") { const result = this.value; this.value = ""; this.params.done(result); return; }
    if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") { this.value = removeLastGrapheme(this.value); this.params.requestRender(); return; }
    if (data === "\x15" || matchesKey(data, Key.ctrl("u"))) { this.value = ""; this.params.requestRender(); return; }
    if (data.startsWith("\x1b") && !data.startsWith("\x1b[200~")) return;
    const printable = sanitizeSecretInput(data);
    if (!printable) return;
    this.value = [...`${this.value}${printable}`].slice(0, this.params.maximumLength ?? 4096).join("");
    this.params.requestRender();
  }
}

export type SshManagerView = "hosts" | "keys";
export type SshHostManagerActionKind =
  | "select" | "toggle-select" | "add" | "edit" | "delete" | "test" | "reset" | "import"
  | "add-key" | "edit-key" | "replace-key" | "delete-key" | "lock" | "close";

export interface SshHostManagerAction {
  kind: SshHostManagerActionKind;
  hostId?: string;
  keyId?: string;
  query: string;
  view?: SshManagerView;
}

export interface SshHostManagerParams {
  hosts: readonly SshHost[];
  keys?: readonly SshKey[];
  statuses?: ReadonlyMap<string, SshHostOperationalStatus>;
  selectedHostIds?: readonly string[];
  theme: SshManagerTheme;
  requestRender: () => void;
  done: (action: SshHostManagerAction) => void;
  initialHostId?: string;
  initialQuery?: string;
  initialView?: SshManagerView;
  notice?: string;
}

const MAX_VISIBLE_ROWS = 12;

export class SshHostManagerOverlay implements Component, Focusable {
  focused = false;
  private query: string;
  private filtering = false;
  private selected = 0;
  private view: SshManagerView;
  private readonly pasteDecoder = new BracketedPasteDecoder();

  constructor(private readonly params: SshHostManagerParams) {
    this.query = params.initialQuery ?? "";
    this.view = params.initialView ?? "hosts";
    if (this.view === "hosts" && params.initialHostId) {
      const index = this.filteredHosts().findIndex((host) => host.id === params.initialHostId);
      if (index >= 0) this.selected = index;
    }
  }
  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    const rowsForView = this.view === "hosts" ? this.filteredHosts() : this.filteredKeys();
    this.selected = clampIndex(this.selected, rowsForView.length);
    const locale = getTuiLocale();
    const viewLabel = sshText(this.view, locale);
    if (safeWidth < 20) return [fit(sshText("managerCompact", locale, { view: viewLabel, count: rowsForView.length }), safeWidth)];
    const inner = safeWidth - 2;
    const total = this.view === "hosts" ? this.params.hosts.length : (this.params.keys?.length ?? 0);
    const rows: string[] = [
      headerLine(this.params.theme, sshText("managerTitle", locale), [`[${viewLabel}]`, `${rowsForView.length}/${total}`], inner),
      rule(inner),
    ];
    if (rowsForView.length === 0) {
      const empty = total === 0 ? sshText(this.view === "hosts" ? "noHosts" : "noKeys", locale) : sshText("noMatches", locale, { view: viewLabel });
      rows.push(fit(this.params.theme.fg("warning", empty), inner));
      if (total === 0) rows.push(fit(sshText(this.view === "hosts" ? "firstHost" : "firstKey", locale), inner));
    } else {
      const start = visibleStart(this.selected, rowsForView.length, MAX_VISIBLE_ROWS);
      for (let offset = 0; offset < Math.min(MAX_VISIBLE_ROWS, rowsForView.length); offset += 1) {
        const index = start + offset;
        const value = rowsForView[index]!;
        const marker = index === this.selected ? this.params.theme.fg("accent", "›") : " ";
        const summary = this.view === "hosts" ? this.hostSummary(value as SshHost, index === this.selected, locale) : this.keySummary(value as SshKey, index === this.selected, locale);
        const attached = this.view === "hosts" && this.params.selectedHostIds?.includes((value as SshHost).id) ? "[x]" : this.view === "hosts" ? "[ ]" : "";
        rows.push(fit(`${marker} ${attached ? `${attached} ` : ""}${summary}`, inner));
      }
    }
    rows.push(helpLine(this.params.theme, this.filtering
      ? sshText("filtering", locale, { query: this.query || sshText("filterHint", locale) })
      : sshText("listHelp", locale, { count: rowsForView.length }), inner));
    if (this.params.notice) rows.push(fit(this.params.theme.fg("warning", this.params.notice), inner));
    const actionKeys: SshTuiTextKey[] = this.view === "hosts"
      ? ["close", "select", "attach", "useOnly", "add", "edit", "delete", "test", "reset", "import", "lock"]
      : ["close", "select", "import", "rename", "replace", "delete", "lock"];
    rows.push(rule(inner), fitSegments(inner, actionKeys.map((key) => sshText(key, locale))));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.filtering) { this.filtering = false; this.query = ""; this.selected = 0; this.params.requestRender(); }
      else this.finish("close", false);
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.pageUp)) return this.move(-MAX_VISIBLE_ROWS);
    if (matchesKey(data, Key.pageDown)) return this.move(MAX_VISIBLE_ROWS);
    if (this.filtering) {
      if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") { this.query = removeLastGrapheme(this.query); this.selected = 0; this.params.requestRender(); return; }
      const printable = decodeFilterInput(this.pasteDecoder, data);
      if (!printable) return;
      this.query = `${this.query}${printable}`.slice(0, 256); this.selected = 0; this.params.requestRender(); return;
    }
    if (matchesKey(data, Key.tab) || data === "h" || data === "H" || data === "k" || data === "K") {
      this.view = this.view === "hosts" ? "keys" : "hosts"; this.selected = 0; this.params.requestRender(); return;
    }
    if (data === "/") { this.filtering = true; this.params.requestRender(); return; }
    if (this.view === "hosts") {
      if (matchesKey(data, Key.space) || data === " ") return this.finish("toggle-select", true);
      if (matchesKey(data, Key.enter) || data === "\r") return this.finish("select", true);
      if (data === "a" || data === "A") return this.finish("add", false);
      if (data === "e" || data === "E") return this.finish("edit", true);
      if (data === "d" || data === "D") return this.finish("delete", true);
      if (data === "t" || data === "T") return this.finish("test", true);
      if (data === "r" || data === "R") return this.finish("reset", true);
      if (data === "i" || data === "I") return this.finish("import", false);
    } else {
      if (data === "a" || data === "A") return this.finish("add-key", false);
      if (data === "e" || data === "E") return this.finish("edit-key", true);
      if (data === "r" || data === "R") return this.finish("replace-key", true);
      if (data === "d" || data === "D") return this.finish("delete-key", true);
    }
    if (data === "l" || data === "L") return this.finish("lock", false);
  }

  private hostSummary(host: SshHost, selected: boolean, locale: SshTuiLocale): string {
    const label = selected ? this.params.theme.bold(host.label) : host.label;
    const jump = host.jumpHostId ? this.params.hosts.find((candidate) => candidate.id === host.jumpHostId)?.label ?? sshText("missingJump", locale) : sshText("direct", locale);
    const trust = sshText(host.hostKey === null ? "untrusted" : "trusted", locale);
    const monitor = this.params.statuses?.get(host.id)?.status ?? (host.monitorEnabled ? "checking" : "disabled");
    const tags = (host.tags?.length ?? 0) > 0 ? ` · ${sshText("tags", locale, { tags: host.tags.join(",") })}` : "";
    return `${label} · ${host.user}@${formatAddress(host.host, host.port)} · ${host.shell} · ${authKindLabel(host, this.params.keys, locale)}${tags} · ${sshText("jump", locale, { jump })} · ${trust} · ${sshText("monitor", locale, { status: sshText(monitor, locale) })}`;
  }

  private keySummary(key: SshKey, selected: boolean, locale: SshTuiLocale): string {
    const label = selected ? this.params.theme.bold(key.label) : key.label;
    return `${label} · ${key.publicKeyFingerprint} · ${sshText("created", locale, { date: key.createdAt })} · ${sshText("bytes", locale, { count: Buffer.byteLength(key.privateKey, "utf8") })}`;
  }

  private filteredHosts(): SshHost[] {
    const terms = termsFrom(this.query);
    return this.params.hosts.filter((host) => {
      const jump = host.jumpHostId ? this.params.hosts.find((candidate) => candidate.id === host.jumpHostId)?.label ?? "" : "direct";
      const haystack = `${host.label} ${host.host} ${host.user} ${host.port} ${host.shell} ${host.auth.kind} ${(host.tags ?? []).join(" ")} ${jump}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  private filteredKeys(): SshKey[] {
    const terms = termsFrom(this.query);
    return (this.params.keys ?? []).filter((key) => terms.every((term) => `${key.label} ${fingerprintAlgorithm(key.publicKeyFingerprint)} ${key.createdAt}`.toLocaleLowerCase().includes(term)));
  }

  private move(delta: number): void {
    const count = this.view === "hosts" ? this.filteredHosts().length : this.filteredKeys().length;
    this.selected = count === 0 ? 0 : (this.selected + delta % count + count) % count;
    this.params.requestRender();
  }

  private finish(kind: SshHostManagerActionKind, needsItem: boolean): void {
    const host = this.view === "hosts" ? this.filteredHosts()[this.selected] : undefined;
    const key = this.view === "keys" ? this.filteredKeys()[this.selected] : undefined;
    if (needsItem && !host && !key) return;
    this.params.done({ kind, ...(host ? { hostId: host.id } : {}), ...(key ? { keyId: key.id } : {}), query: this.query, view: this.view });
  }
}

export interface SshHostPickerParams {
  hosts: readonly SshHost[];
  selectedHostIds?: readonly string[];
  theme: SshManagerTheme;
  requestRender: () => void;
  done: (hostIds: string[] | undefined) => void;
}

export class SshHostPickerOverlay implements Component, Focusable {
  focused = false;
  private query = "";
  private filtering = false;
  private selected = 0;
  private touched = false;
  private readonly selectedHostIds: string[];
  private readonly pasteDecoder = new BracketedPasteDecoder();

  constructor(private readonly params: SshHostPickerParams) {
    const available = new Set(params.hosts.map((host) => host.id));
    this.selectedHostIds = [...new Set(params.selectedHostIds ?? [])].filter((id) => available.has(id));
  }
  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    const hosts = this.filteredHosts();
    this.selected = clampIndex(this.selected, hosts.length);
    const locale = getTuiLocale();
    if (safeWidth < 20) return [fit(sshText("pickerCompact", locale, { count: this.selectedHostIds.length }), safeWidth)];
    const inner = safeWidth - 2;
    const rows = [
      headerLine(this.params.theme, sshText("pickerTitle", locale), [sshText("pickerCount", locale, { count: this.selectedHostIds.length }), `${hosts.length}/${this.params.hosts.length}`], inner),
      rule(inner),
    ];
    if (hosts.length === 0) {
      rows.push(fit(this.params.theme.fg("warning", sshText(this.params.hosts.length === 0 ? "noHosts" : "pickerEmpty", locale)), inner));
    } else {
      const start = visibleStart(this.selected, hosts.length, MAX_VISIBLE_ROWS);
      for (let offset = 0; offset < Math.min(MAX_VISIBLE_ROWS, hosts.length); offset += 1) {
        const index = start + offset;
        const host = hosts[index]!;
        const marker = index === this.selected ? this.params.theme.fg("accent", "›") : " ";
        const checked = this.selectedHostIds.includes(host.id) ? "[x]" : "[ ]";
        const label = index === this.selected ? this.params.theme.bold(host.label) : host.label;
        rows.push(fit(`${marker} ${checked} ${label} · ${host.user}@${formatAddress(host.host, host.port)} · ${host.shell} · id=${host.id}`, inner));
      }
    }
    rows.push(helpLine(this.params.theme, this.filtering
      ? sshText("filtering", locale, { query: this.query || sshText("filterHint", locale) })
      : sshText("pickerHelp", locale), inner));
    rows.push(rule(inner), fit(sshText("pickerFooter", locale), inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.filtering) { this.filtering = false; this.query = ""; this.selected = 0; this.params.requestRender(); }
      else this.params.done(undefined);
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.pageUp)) return this.move(-MAX_VISIBLE_ROWS);
    if (matchesKey(data, Key.pageDown)) return this.move(MAX_VISIBLE_ROWS);
    if (this.filtering) {
      if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") { this.query = removeLastGrapheme(this.query); this.selected = 0; this.params.requestRender(); return; }
      const printable = decodeFilterInput(this.pasteDecoder, data);
      if (!printable) return;
      this.query = `${this.query}${printable}`.slice(0, 256); this.selected = 0; this.params.requestRender(); return;
    }
    if (data === "/") { this.filtering = true; this.params.requestRender(); return; }
    if (matchesKey(data, Key.space) || data === " ") {
      const host = this.filteredHosts()[this.selected];
      if (!host) return;
      const index = this.selectedHostIds.indexOf(host.id);
      if (index >= 0) this.selectedHostIds.splice(index, 1);
      else this.selectedHostIds.push(host.id);
      this.touched = true;
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      const host = this.filteredHosts()[this.selected];
      if (!this.touched && this.selectedHostIds.length === 0 && host) this.selectedHostIds.push(host.id);
      this.params.done([...this.selectedHostIds]);
    }
  }

  private filteredHosts(): SshHost[] {
    const terms = termsFrom(this.query);
    return this.params.hosts.filter((host) => terms.every((term) => `${host.label} ${host.host} ${host.user} ${host.port} ${host.shell} ${(host.tags ?? []).join(" ")}`.toLocaleLowerCase().includes(term)));
  }

  private move(delta: number): void {
    const count = this.filteredHosts().length;
    this.selected = count === 0 ? 0 : (this.selected + delta % count + count) % count;
    this.params.requestRender();
  }
}

function authKindLabel(host: SshHost, keys: readonly SshKey[] | undefined, locale: SshTuiLocale): string {
  if (host.auth.kind === "identity") return sshText("identity", locale);
  if (host.auth.kind === "password") return sshText("password", locale);
  if (host.auth.kind === "key") { const keyId = host.auth.keyId; return sshText("key", locale, { label: keys?.find((key) => key.id === keyId)?.label ?? sshText("missingKey", locale) }); }
  return sshText("agent", locale);
}
function fingerprintAlgorithm(fingerprint: string): string { return fingerprint.startsWith("SHA256:") ? "SHA256 public key" : "public key"; }
function formatAddress(host: string, port: number): string { return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`; }
function termsFrom(value: string): string[] { return value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean); }
function sanitizeSecretInput(value: string): string { return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "").replace(/[\r\n\x00-\x1f\x7f]/gu, ""); }
function decodeFilterInput(decoder: BracketedPasteDecoder, data: string): string {
  return decoder.feed(data)
    .filter((token) => token.kind === "paste" || !token.text.startsWith("\x1b"))
    .map((token) => sanitizeSingleLineInput(token.text))
    .join("");
}
function visibleStart(selected: number, length: number, maximum: number): number { return length <= maximum ? 0 : Math.min(Math.max(0, selected - maximum + 1), length - maximum); }
function clampIndex(index: number, length: number): number { return length === 0 ? 0 : Math.min(Math.max(0, index), length - 1); }
function fitSegments(width: number, segments: readonly string[]): string { const kept: string[] = []; for (const segment of segments) { const candidate = [...kept, segment].join(" · "); if (visibleWidth(candidate) > width) break; kept.push(segment); } return fit(kept.length > 0 ? kept.join(" · ") : segments[0] ?? "", width); }
