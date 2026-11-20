import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { showApiModelEditor, type ApiModelFormField, type ApiModelFormValues } from "../tui/api-model-editor.ts";
import { getTuiLocale } from "../tui/locale.ts";
import { createSshHostId, validateSshHost, type SshAuth, type SshHost, type SshKey } from "./model.ts";

const TEXT = {
  en: {
    add: "Add SSH server", edit: "Edit SSH server", connection: "Connection", authentication: "Authentication", advanced: "Advanced",
    label: "Label *", host: "Hostname or IP *", user: "Username *", port: "Port *", shell: "Remote shell *",
    auth: "Authentication *", agent: "SSH agent", identity: "Local private key", key: "Managed key", password: "Server password",
    identityFile: "Private key file *", identityPath: "Other key path", managedKey: "Managed key *",
    secret: "Password *", passphrase: "Key passphrase", hostKey: "Pinned host SHA256", tags: "Tags (comma separated)",
    jump: "Jump host", direct: "Direct connection", monitor: "Monitoring", browse: "Enter another path…",
    identityHelp: "Only used with local private key; select a detected file or enter another path.",
    secretHelp: "Only used with server password; the value is never shown.",
    keyHelp: "Only used with managed key authentication.",
    missing: "Fill in the required fields (*).", invalid: "Check the SSH host fields and authentication settings.",
    unavailable: "SSH agent is unavailable in this Pi process.", path: "Select a private key or enter its full path.",
    managed: "Select an imported managed key.", passwordRequired: "Enter the server password.",
    addKey: "Import SSH private key", replaceKey: "Replace SSH private key", keyLabel: "Key label *",
    importHelp: "Select a detected private key, or enter its full path. The file is encrypted in this manager.",
    importMissing: "Enter a key label and select a private key file.",
  },
  "zh-CN": {
    add: "添加 SSH 服务器", edit: "编辑 SSH 服务器", connection: "连接", authentication: "身份验证", advanced: "高级设置",
    label: "名称 *", host: "主机名或 IP *", user: "用户名 *", port: "端口 *", shell: "远程 Shell *",
    auth: "认证方式 *", agent: "SSH 代理", identity: "本地私钥", key: "托管密钥", password: "服务器密码",
    identityFile: "私钥文件 *", identityPath: "其他私钥路径", managedKey: "托管密钥 *",
    secret: "密码 *", passphrase: "私钥口令", hostKey: "固定主机 SHA256 指纹", tags: "标签（逗号分隔）",
    jump: "跳板主机", direct: "直接连接", monitor: "连接监控", browse: "输入其他路径…",
    identityHelp: "仅本地私钥认证使用；选择识别到的文件，或填写其他路径。",
    secretHelp: "仅服务器密码认证使用；密码不会显示。",
    keyHelp: "仅托管密钥认证使用。",
    missing: "请填写带 * 的必填项。", invalid: "请检查 SSH 主机字段和认证设置。",
    unavailable: "当前 Pi 进程无法使用 SSH 代理。", path: "请选择私钥或填写完整路径。",
    managed: "请选择已导入的托管密钥。", passwordRequired: "请输入服务器密码。",
    addKey: "导入 SSH 私钥", replaceKey: "替换 SSH 私钥", keyLabel: "密钥名称 *",
    importHelp: "选择识别到的私钥，或填写完整路径。文件将加密保存在管理器中。",
    importMissing: "请填写密钥名称并选择私钥文件。",
  },
} as const;

export interface SshHostFormOptions {
  current?: SshHost;
  hosts: readonly SshHost[];
  keys: readonly SshKey[];
  identityPaths: readonly string[];
  suggestedPath?: string;
  agentAvailable: boolean;
  normalizePin: (value: string) => string;
  locale?: SupportedSettingsLocale;
}

export function createSshHostForm(options: SshHostFormOptions): {
  title: string;
  fields: ApiModelFormField[];
  validate: (values: ApiModelFormValues) => string[];
  host: (values: ApiModelFormValues) => SshHost;
} {
  const text = TEXT[getTuiLocale(options.locale)];
  const current = options.current;
  const id = current?.id ?? createSshHostId();
  const paths = [...new Set([...(current?.auth.kind === "identity" ? [current.auth.path] : []), ...options.identityPaths])];
  const manual = "manual";
  const authKind = current?.auth.kind ?? (options.keys.length ? "key" : options.agentAvailable ? "agent" : "identity");
  const identityChoice = current?.auth.kind === "identity" && paths.includes(current.auth.path)
    ? current.auth.path : options.suggestedPath && paths.includes(options.suggestedPath)
      ? options.suggestedPath : paths[0] ?? manual;
  const fields: ApiModelFormField[] = [
    { id: "connection", label: text.connection, kind: "section", value: "" },
    { id: "label", label: text.label, kind: "text", value: current?.label ?? "" },
    { id: "hostname", label: text.host, kind: "text", value: current?.host ?? "" },
    { id: "username", label: text.user, kind: "text", value: current?.user ?? "" },
    { id: "port", label: text.port, kind: "number", value: String(current?.port ?? 22) },
    { id: "shell", label: text.shell, kind: "choice", value: current?.shell ?? "bash", choices: [
      { label: "bash", value: "bash" }, { label: "PowerShell", value: "powershell" },
    ] },
    { id: "authentication", label: text.authentication, kind: "section", value: "" },
    { id: "auth", label: text.auth, kind: "choice", value: authKind, choices: [
      ...(options.keys.length || authKind === "key" ? [{ label: text.key, value: "key" }] : []),
      ...(options.agentAvailable || authKind === "agent" ? [{ label: text.agent, value: "agent" }] : []),
      { label: text.identity, value: "identity" }, { label: text.password, value: "password" },
    ] },
    { id: "identityFile", label: text.identityFile, kind: "choice", value: identityChoice, choices: [
      ...paths.map((path) => ({ label: path, value: path })), { label: text.browse, value: manual },
    ], help: text.identityHelp },
    { id: "identityPath", label: text.identityPath, kind: "text", value: current?.auth.kind === "identity" ? current.auth.path : options.suggestedPath ?? "", help: text.identityHelp },
    { id: "identityPassphrase", label: text.passphrase, kind: "secret", value: current?.auth.kind === "identity" ? current.auth.passphrase ?? "" : "", redact: true },
    { id: "managedKey", label: text.managedKey, kind: "choice", value: current?.auth.kind === "key" ? current.auth.keyId : options.keys[0]?.id ?? "", choices: options.keys.map((key) => ({ label: key.label, value: key.id })), help: text.keyHelp },
    { id: "password", label: text.secret, kind: "secret", value: current?.auth.kind === "password" ? current.auth.password : "", redact: true, help: text.secretHelp },
    { id: "advanced", label: text.advanced, kind: "section", value: "" },
    { id: "hostKey", label: text.hostKey, kind: "text", value: current?.hostKey ?? "" },
    { id: "tags", label: text.tags, kind: "text", value: current?.tags.join(", ") ?? "" },
    { id: "jumpHost", label: text.jump, kind: "choice", value: current?.jumpHostId ?? "", choices: [
      { label: text.direct, value: "" }, ...options.hosts.filter((entry) => entry.id !== current?.id).map((entry) => ({ label: entry.label, value: entry.id })),
    ] },
    { id: "monitor", label: text.monitor, kind: "toggle", value: current?.monitorEnabled ?? false },
  ];
  const secret = (values: ApiModelFormValues, id: string) => String(values[id] ?? "");
  const value = (values: ApiModelFormValues, id: string) => secret(values, id).trim();
  const host = (values: ApiModelFormValues): SshHost => {
    const kind = value(values, "auth");
    let auth: SshAuth;
    if (kind === "key") auth = { kind: "key", keyId: value(values, "managedKey") };
    else if (kind === "agent") auth = { kind: "agent" };
    else if (kind === "identity") {
      const path = value(values, "identityFile") === manual ? value(values, "identityPath") : value(values, "identityFile");
      const passphrase = secret(values, "identityPassphrase");
      auth = { kind: "identity", path, ...(passphrase ? { passphrase } : {}) };
    } else if (kind === "password") auth = { kind: "password", password: secret(values, "password") };
    else throw new Error("Invalid SSH authentication method");
    const hostKey = options.normalizePin(value(values, "hostKey"));
    return validateSshHost({
      id, label: value(values, "label"), host: value(values, "hostname"),
      user: value(values, "username"), port: Number(value(values, "port")), shell: value(values, "shell"),
      hostKey: hostKey || null, auth, tags: value(values, "tags").split(",").map((tag) => tag.trim()).filter(Boolean),
      jumpHostId: value(values, "jumpHost") || null, monitorEnabled: values.monitor === true,
    });
  };
  const validate = (values: ApiModelFormValues): string[] => {
    if (!["label", "hostname", "username", "port"].every((id) => value(values, id))) return [text.missing];
    const kind = value(values, "auth");
    if (!["agent", "identity", "key", "password"].includes(kind)) return [text.invalid];
    if (kind === "agent" && !options.agentAvailable) return [text.unavailable];
    if (kind === "key" && !options.keys.some((key) => key.id === value(values, "managedKey"))) return [text.managed];
    if (kind === "password" && !secret(values, "password")) return [text.passwordRequired];
    if (kind === "identity" && !(value(values, "identityFile") === manual ? value(values, "identityPath") : value(values, "identityFile"))) return [text.path];
    try { host(values); return []; } catch { return [text.invalid]; }
  };
  return { title: current ? text.edit : text.add, fields, validate, host };
}

export async function editSshHostForm(ctx: ExtensionContext, options: SshHostFormOptions): Promise<SshHost | undefined> {
  const form = createSshHostForm(options);
  const result = await showApiModelEditor(ctx, { title: form.title, fields: form.fields, validate: form.validate, locale: options.locale });
  if (!result) return undefined;
  return form.host(result.values);
}

export function createSshKeyForm(paths: readonly string[], current?: SshKey, locale?: SupportedSettingsLocale): {
  title: string;
  fields: ApiModelFormField[];
  validate: (values: ApiModelFormValues) => string[];
  key: (values: ApiModelFormValues) => { label: string; path: string; passphrase?: string };
} {
  const text = TEXT[getTuiLocale(locale)];
  const fields: ApiModelFormField[] = [
    { id: "label", label: text.keyLabel, kind: "text", value: current?.label ?? "" },
    { id: "file", label: text.identityFile, kind: "choice", value: "manual", choices: [
      ...paths.map((path) => ({ label: path, value: path })), { label: text.browse, value: "manual" },
    ], help: text.importHelp },
    { id: "path", label: text.identityPath, kind: "text", value: "", help: text.importHelp },
    { id: "passphrase", label: text.passphrase, kind: "secret", value: current?.passphrase ?? "", redact: true },
  ];
  const key = (values: ApiModelFormValues) => {
    const label = String(values.label ?? "").trim();
    const path = String(values.file === "manual" ? values.path ?? "" : values.file ?? "").trim();
    const passphrase = String(values.passphrase ?? "");
    return { label, path, ...(passphrase ? { passphrase } : {}) };
  };
  const validate = (values: ApiModelFormValues): string[] => {
    const result = key(values);
    if (!result.label || !result.path) return [text.importMissing];
    if (result.label.length > 128 || result.path.length > 4096 || result.passphrase && result.passphrase.length > 4096) return [text.invalid];
    return [];
  };
  return { title: current ? text.replaceKey : text.addKey, fields, validate, key };
}

export async function editSshKeyForm(ctx: ExtensionContext, paths: readonly string[], current?: SshKey): Promise<{ label: string; path: string; passphrase?: string } | undefined> {
  const locale = getTuiLocale();
  const form = createSshKeyForm(paths, current, locale);
  const result = await showApiModelEditor(ctx, { title: form.title, fields: form.fields, validate: form.validate, locale });
  return result ? form.key(result.values) : undefined;
}
