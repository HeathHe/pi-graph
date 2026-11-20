import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { dirname, join, parse, resolve, relative, isAbsolute, sep } from "node:path";
import type { ExtensionAPI, McpExposure } from "@earendil-works/pi-coding-agent";
import {
  findAvailableImportConfigs, getGenericGlobalConfigPath, getPiGlobalConfigPath,
  getProjectConfigPath, getProjectPiConfigPath,
} from "./config.ts";
import { getAgentPath } from "./agent-dir.ts";
import { getServerPrefix } from "./types.ts";

/** Config operation version, not a second MCP runtime/config schema. */
export const NATIVE_MCP_MIGRATION_VERSION = 1 as const;
const MARKER = "_maestroNativeMcpMigration";
type JsonObject = Record<string, unknown>;
type Scope = "global" | "project";
export type MigrationSourceId = "shared-global" | "pi-global" | "shared-project" | "pi-project";
export interface MigrationDocument { path: string; text: string | null }
export interface NativeMigrationSource extends MigrationDocument { id: MigrationSourceId }
export interface NativeMigrationImport extends MigrationDocument { kind: string }
export interface NativeMigrationInput {
  sources: NativeMigrationSource[];
  imports?: NativeMigrationImport[];
  globalTarget: string;
  projectTarget: string;
  projectTrusted: boolean;
  legacyFeatures?: { apps?: boolean; fabric?: boolean; appsMetadataUnreadable?: boolean };
}
export interface MigrationIssue {
  code: string;
  scope?: Scope;
  server?: string;
  field?: string;
  message: string;
}
export interface MigrationMapping {
  scope: Scope;
  server?: string;
  field: string;
  result: "lossless" | "blocked" | "preserved";
}
export interface MigrationWrite extends MigrationDocument { scope: Scope; afterText: string }
/** Contains secrets. Never print this object: use previewNativeMcpMigration(). */
export interface NativeMcpMigrationPlan {
  version: typeof NATIVE_MCP_MIGRATION_VERSION;
  snapshots: MigrationDocument[];
  writes: MigrationWrite[];
  blockers: MigrationIssue[];
  warnings: MigrationIssue[];
  mappings: MigrationMapping[];
  origins: Record<string, { paths: string[]; requiresProjectTrust: boolean }>;
}
const ORDER: MigrationSourceId[] = ["shared-global", "pi-global", "shared-project", "pi-project"];
const IMPORT_KINDS = new Set(["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "vscode"]);
const EXPOSURES = new Set(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);
const hash = (text: string | null): string => createHash("sha256").update(text === null ? "absent" : `file:${text}`).digest("hex");
const record = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const stringRecord = (value: unknown): value is Record<string, string> => record(value) && Object.values(value).every((item) => typeof item === "string");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Pure planner. No reads, command execution, token-store access, or writes. */
export function planNativeMcpMigration(input: NativeMigrationInput): NativeMcpMigrationPlan {
  const plan: NativeMcpMigrationPlan = {
    version: 1, snapshots: [], writes: [], blockers: [], warnings: [], mappings: [], origins: Object.create(null),
  };
  const fail = (code: string, message: string, scope?: Scope, server?: string, field?: string): void => {
    plan.blockers.push({ code, message, scope, server, field });
    if (scope && field) plan.mappings.push({ scope, server, field, result: "blocked" });
  };
  const raws = new Map<string, JsonObject>();
  const snapshots = new Map<string, MigrationDocument>();
  function read(doc: MigrationDocument): JsonObject {
    const path = resolve(doc.path);
    const previous = snapshots.get(path);
    if (previous && previous.text !== doc.text) fail("inconsistent-input", "Conflicting snapshots of one file.");
    snapshots.set(path, { path, text: doc.text });
    if (doc.text === null) return {};
    try {
      const raw: unknown = JSON.parse(doc.text);
      if (!record(raw)) throw new Error();
      raws.set(path, raw);
      return raw;
    } catch {
      fail("invalid-json", "A source is not a valid JSON object; no files will be changed.");
      return {};
    }
  }
  const sources = ORDER.flatMap((id) => input.sources.filter((source) => source.id === id));
  for (const id of ORDER) {
    if (sources.filter((source) => source.id === id).length !== 1) fail("source-set", "Provide exactly one snapshot for each of the four legacy sources.");
  }
  if (resolve(input.globalTarget) === resolve(input.projectTarget)) fail("target-scope", "Global and project targets must be distinct.");
  if (sources.find((s) => s.id === "pi-global")?.path && resolve(sources.find((s) => s.id === "pi-global")!.path) !== resolve(input.globalTarget)) fail("target-scope", "Global target must be the Pi global source.");
  if (sources.find((s) => s.id === "pi-project")?.path && resolve(sources.find((s) => s.id === "pi-project")!.path) !== resolve(input.projectTarget)) fail("target-scope", "Project target must be the Pi project source.");
  for (const source of sources) read(source);
  const imported = new Map<string, { doc: NativeMigrationImport; raw?: JsonObject }>();
  for (const doc of input.imports ?? []) {
    // Discovery chooses the first existing candidate. Unrequested imports must not affect the plan.
    if (!imported.has(doc.kind)) imported.set(doc.kind, { doc });
  }
  if (input.legacyFeatures?.apps) fail("mcp-apps", "Native MCP omits App resources and has no AppBridge host/client handoff API. Migration needs an explicit decision for this unsupported capability.");
  if (input.legacyFeatures?.appsMetadataUnreadable) fail("mcp-apps-unknown", "Legacy App metadata is unreadable; review App usage before migration.");
  if (input.legacyFeatures?.fabric) fail("fabric-route", "Native config/ExtensionAPI cannot express a generation-fenced Fabric route lease, per-call validation or mount revocation. Migration needs an explicit decision for this unsupported capability.");
  if (!input.projectTrusted && sources.some((s) => s.id.includes("project") && s.text !== null)) fail("project-trust", "Project migration requires workspace trust; project config must not be flattened into global config.");

  // A migration is a frozen snapshot, not a continuing compatibility-import loader.
  const marked = sources.filter((s) => record(raws.get(resolve(s.path))?.[MARKER]));
  if (marked.length) {
    for (const source of marked) {
      const marker = raws.get(resolve(source.path))![MARKER] as JsonObject;
      if (marker.version !== 1 || !Array.isArray(marker.watches)) {
        fail("migration-version", "Unknown or invalid migration marker; use a verified rollback before retrying.");
        continue;
      }
      for (const watch of marker.watches) {
        if (record(watch) && typeof watch.path === "string") {
          const doc = (input.imports ?? []).find((item) => resolve(item.path) === resolve(watch.path as string));
          if (doc) snapshots.set(resolve(doc.path), { path: resolve(doc.path), text: doc.text });
        }
        if (!record(watch) || typeof watch.path !== "string" || typeof watch.hash !== "string" || hash(snapshots.get(resolve(watch.path))?.text ?? null) !== watch.hash) {
          fail("migration-source-changed", "A snapshotted legacy source/import changed after migration; use rollback and re-plan rather than silently merging it.");
        }
      }
    }
    const unmarkedPi = sources.some((s) => s.id.startsWith("pi-") && s.text !== null && !record(raws.get(resolve(s.path))?.[MARKER]));
    if (unmarkedPi) fail("partial-migration", "Mixed migrated/unmigrated Pi config requires explicit review or rollback.");
    plan.snapshots = [...snapshots.values()];
    return plan;
  }

  type State = { servers: Record<string, JsonObject>; settings: JsonObject; root: JsonObject; origins: Map<string, Set<string>> };
  const state: State = { servers: Object.create(null), settings: {}, root: {}, origins: new Map() };
  const globalOnly: State = { servers: Object.create(null), settings: {}, root: {}, origins: new Map() };
  let globalState: State | undefined;
  let projectImport = false;
  const cloneState = (value = state): State => ({ servers: structuredClone(value.servers), settings: structuredClone(value.settings), root: structuredClone(value.root), origins: new Map([...value.origins].map(([k, v]) => [k, new Set(v)])) });
  const add = (name: string, value: unknown, paths: Set<string>, scope: Scope, destination = state): void => {
    if (!record(value)) { fail("server-shape", "Server entry must be an object.", scope, name); return; }
    destination.servers[name] = { ...destination.servers[name], ...value };
    destination.origins.set(name, new Set([...(destination.origins.get(name) ?? []), ...paths]));
  };
  function serverMap(raw: JsonObject, scope: Scope, kind?: string): JsonObject {
    const map = kind && ["claude-code", "claude-desktop", "codex"].includes(kind)
      ? raw.mcpServers : raw.mcpServers ?? raw["mcp-servers"];
    if (map === undefined) return {};
    if (!record(map)) { fail("server-map", "mcpServers must be an object.", scope); return {}; }
    return map;
  }
  for (const source of sources) {
    const scope: Scope = source.id.includes("project") ? "project" : "global";
    if (scope === "project" && !globalState) globalState = cloneState(globalOnly);
    if (scope === "project" && !input.projectTrusted) continue;
    const raw = raws.get(resolve(source.path)) ?? {};
    const local: Record<string, JsonObject> = Object.create(null);
    const localPaths = new Map<string, Set<string>>();
    const untrustedLocal: Record<string, JsonObject> = Object.create(null);
    const untrustedPaths = new Map<string, Set<string>>();
    if (raw.imports !== undefined && !strings(raw.imports)) fail("imports-shape", "imports must be an array of known import kinds.", scope);
    for (const kind of strings(raw.imports) ? raw.imports : []) {
      if (!IMPORT_KINDS.has(kind)) { fail("import-kind", "An import kind is unsupported by the legacy loader.", scope); continue; }
      if (kind === "vscode") projectImport = true;
      if (kind === "vscode" && !input.projectTrusted) { fail("project-trust", "A project-relative import requires workspace trust.", scope); continue; }
      const item = imported.get(kind);
      if (!item || item.doc.text === null) { fail("import-missing", "A requested import file is unavailable; migration cannot silently discard it.", scope); continue; }
      item.raw ??= read(item.doc);
      for (const [name, value] of Object.entries(serverMap(item.raw, scope, kind))) {
        if (!record(value)) { fail("server-shape", "Imported server entry must be an object.", scope, name); continue; }
        if (!Object.hasOwn(local, name)) { // first import wins, whole definition
          local[name] = { ...value };
          localPaths.set(name, new Set([resolve(source.path), resolve(item.doc.path)]));
        }
        if (scope === "global" && kind !== "vscode" && !Object.hasOwn(untrustedLocal, name)) {
          untrustedLocal[name] = { ...value };
          untrustedPaths.set(name, new Set([resolve(source.path), resolve(item.doc.path)]));
        }
      }
    }
    for (const [name, value] of Object.entries(serverMap(raw, scope))) {
      if (!record(value)) { fail("server-shape", "Server entry must be an object.", scope, name); continue; }
      local[name] = { ...local[name], ...value };
      localPaths.set(name, new Set([...(localPaths.get(name) ?? []), resolve(source.path)]));
      if (scope === "global") {
        untrustedLocal[name] = { ...untrustedLocal[name], ...value };
        untrustedPaths.set(name, new Set([...(untrustedPaths.get(name) ?? []), resolve(source.path)]));
      }
    }
    for (const [name, value] of Object.entries(local)) add(name, value, localPaths.get(name)!, scope);
    if (scope === "global") for (const [name, value] of Object.entries(untrustedLocal)) add(name, value, untrustedPaths.get(name)!, scope, globalOnly);
    if (raw.settings !== undefined && !record(raw.settings)) fail("settings-shape", "Legacy settings must be an object.", scope);
    if (record(raw.settings)) state.settings = { ...state.settings, ...raw.settings };
    // Preserve unknown root fields and native fields, not only the fields the legacy loader knew.
    const { mcpServers: _servers, "mcp-servers": _alias, imports: _imports, settings: _settings, [MARKER]: _marker, ...root } = raw;
    state.root = { ...state.root, ...root };
    if (scope === "global") { globalOnly.root = { ...globalOnly.root, ...root }; globalOnly.settings = { ...state.settings }; }
    if (raw.apps !== undefined) fail("mcp-apps", "Legacy Apps configuration has no native AppBridge equivalent.", scope);
    if (raw.fabric !== undefined) fail("fabric-route", "Fabric mounts cannot be serialized as static native MCP connections.", scope);
  }
  globalState ??= cloneState(globalOnly);
  const projectPresent = projectImport || sources.some((s) => s.id.includes("project") && s.text !== null);
  const watches = [...snapshots.values()].filter((doc) => ![resolve(input.globalTarget), resolve(input.projectTarget)].includes(doc.path)).map((doc) => ({ path: doc.path, hash: hash(doc.text) }));
  const targets: [Scope, string, State][] = [["global", input.globalTarget, globalState]];
  if (input.projectTrusted && projectPresent) targets.push(["project", input.projectTarget, cloneState()]);
  for (const [scope, path, projection] of targets) {
    for (const key of Object.keys(projection.settings)) {
      if (!["directTools", "requestTimeoutMs", "toolPrefix"].includes(key)) fail("unsupported-setting", "A legacy global setting has no lossless native configuration equivalent.", scope, undefined, key);
    }
    if (projection.settings.toolPrefix !== undefined) fail("tool-prefix", "Native names are fixed to mcp__server__tool; legacy prefix/permission references cannot be preserved.", scope, undefined, "toolPrefix");
    if (projection.settings.directTools !== undefined && typeof projection.settings.directTools !== "boolean") fail("direct-tools", "Global directTools must be boolean.", scope, undefined, "directTools");
    const servers: JsonObject = Object.create(null);
    for (const [name, entry] of Object.entries(projection.servers)) {
      servers[name] = convertServer(name, entry, projection.settings, scope, plan, fail);
      plan.origins[`${scope}:${name}`] = { paths: [...(projection.origins.get(name) ?? [])], requiresProjectTrust: scope === "project" };
    }
    if (projection.root.autoEnableCodemode !== undefined && typeof projection.root.autoEnableCodemode !== "boolean") fail("native-root", "autoEnableCodemode must be boolean.", scope);
    const raw = { ...projection.root, mcpServers: servers, [MARKER]: { version: 1, watches, origins: Object.fromEntries(Object.entries(plan.origins).filter(([key]) => key.startsWith(`${scope}:`))) } };
    const before = snapshots.get(resolve(path))?.text ?? null;
    const afterText = json(raw);
    if (before !== afterText && (before !== null || Object.keys(servers).length || Object.keys(projection.root).length)) plan.writes.push({ scope, path: resolve(path), text: before, afterText });
  }
  plan.snapshots = [...snapshots.values()];
  plan.warnings.push({ code: "native-runtime", message: "Native tool names, codemode discovery, resource tools, eager startup and output handling replace the legacy defaults. Review permission references before applying." });
  plan.warnings.push({ code: "oauth-login", message: "Legacy OAuth tokens are never read or copied. Use /mcp login <server> after migration, then /reload." });
  plan.warnings.push({ code: "runtime-features", message: "Apps/Fabric usage not represented in config must be reviewed separately; config conversion cannot provide those runtime integrations." });
  return plan;
}

function convertServer(
  name: string, source: JsonObject, settings: JsonObject, scope: Scope, plan: NativeMcpMigrationPlan,
  fail: (code: string, message: string, scope?: Scope, server?: string, field?: string) => void,
): JsonObject {
  const entry = structuredClone(source);
  const blocked = (field: string, message: string, code = "unsupported-server-field"): void => fail(code, message, scope, name, field);
  const mapped = (field: string, result: MigrationMapping["result"] = "lossless"): void => { plan.mappings.push({ scope, server: name, field, result }); };
  if (!/^[A-Za-z0-9_-]+$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) blocked("name", "Server name cannot safely be represented by native MCP.", "server-name");
  const native = new Set(["command", "args", "env", "cwd", "url", "headers", "enabled", "type", "timeout", "exposure", "toolExposure", "oauth"]);
  const legacy = new Set(["auth", "bearerToken", "bearerTokenEnv", "directTools", "excludeTools", "requestTimeoutMs", "lifecycle", "idleTimeout", "exposeResources", "debug"]);
  for (const key of Object.keys(entry)) {
    if (native.has(key)) mapped(key, "preserved");
    else if (!legacy.has(key)) blocked(key, "Unknown server option cannot be assumed lossless in native MCP.");
  }
  if (entry.type === "sse" || (typeof entry.url === "string" && /\/sse\/?(?:[?#].*)?$/i.test(entry.url))) blocked("type", "Legacy SSE is unsupported; supply a verified streamable HTTP endpoint manually.", "sse");
  else if (entry.type !== undefined && !["stdio", "http", "streamable-http"].includes(String(entry.type))) blocked("type", "Unsupported native transport type.", "transport");
  if (entry.url !== undefined) {
    try { if (typeof entry.url !== "string" || !/^https?:$/.test(new URL(entry.url).protocol)) throw new Error(); }
    catch { blocked("url", "Native HTTP URL must be a valid http or https URL.", "transport"); }
    if (entry.type === "stdio") blocked("type", "URL and stdio type conflict.", "transport");
  } else if (typeof entry.command !== "string" || !entry.command.trim() || (entry.type !== undefined && entry.type !== "stdio")) blocked("command", "Native stdio requires one executable and a compatible transport type.", "transport");
  if (entry.command !== undefined && entry.url !== undefined) blocked("command", "Ambiguous command and URL configuration requires manual review.", "transport");
  if (entry.args !== undefined && !strings(entry.args)) blocked("args", "args must be strings.");
  for (const field of ["env", "headers"]) {
    if (entry[field] !== undefined && !stringRecord(entry[field])) blocked(field, "Environment/header values must be strings.");
    if (stringRecord(entry[field])) {
      for (const value of Object.values(entry[field])) {
        if (value.startsWith("!") || /\$env:|\$\{input:/.test(value)) blocked(field, "Legacy literal/unsupported interpolation must not become native command execution or change value semantics.", "value-semantics");
      }
    }
  }
  // Native expands ~/ in arguments but legacy does not; legacy expands env in cwd.
  if (strings(entry.args) && entry.args.some((arg) => arg.startsWith("~/"))) blocked("args", "Native expands home paths in arguments that legacy passed literally.", "value-semantics");
  if (entry.cwd !== undefined && (typeof entry.cwd !== "string" || /\$|^~\\/.test(entry.cwd))) blocked("cwd", "Legacy cwd interpolation has no lossless native equivalent.", "value-semantics");
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") blocked("enabled", "enabled must be boolean.");
  if (entry.timeout !== undefined && (typeof entry.timeout !== "number" || !Number.isFinite(entry.timeout) || entry.timeout <= 0)) blocked("timeout", "Native timeout must be finite positive seconds.");
  const ms = entry.requestTimeoutMs !== undefined ? entry.requestTimeoutMs : settings.requestTimeoutMs;
  if (ms !== undefined) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) blocked("requestTimeoutMs", "Non-positive/invalid legacy timeout cannot be interpreted as a native timeout.", "timeout");
    else if (entry.timeout !== undefined && entry.timeout !== ms / 1000) blocked("requestTimeoutMs", "Legacy and native timeouts conflict.", "timeout");
    else { entry.timeout = ms / 1000; mapped("requestTimeoutMs"); }
  }
  if (entry.lifecycle !== undefined) {
    if (entry.lifecycle === "eager" && (entry.idleTimeout === undefined || entry.idleTimeout === 0)) mapped("lifecycle");
    else blocked("lifecycle", "Native config cannot preserve lazy/keep-alive/idle connection policy.", "lifecycle");
  }
  if (entry.idleTimeout !== undefined && !(entry.lifecycle === "eager" && entry.idleTimeout === 0)) blocked("idleTimeout", "Native MCP has no idle-timeout configuration.", "lifecycle");
  if (entry.exposeResources !== undefined) blocked("exposeResources", "Native resources use shared list/read tools and have no independent per-server resource switch or legacy synthetic names.", "resources");
  if (entry.debug !== undefined) blocked("debug", "Native logging does not preserve the legacy stderr debug switch.", "logging");

  const hasAuthHeader = stringRecord(entry.headers) && Object.keys(entry.headers).some((key) => key.toLowerCase() === "authorization");
  if (entry.auth !== undefined && ![false, "bearer", "oauth"].includes(entry.auth as never)) blocked("auth", "Unknown authentication policy.", "auth");
  if ((entry.auth === false || entry.oauth === false) && !hasAuthHeader) blocked("auth", "Native HTTP auto-OAuth cannot express explicit authentication denial.", "auth-denial");
  if (entry.auth === "oauth" && hasAuthHeader) blocked("auth", "Native Authorization headers suppress OAuth; explicit legacy OAuth conflicts.", "auth");
  if (entry.url && entry.auth === undefined && entry.oauth !== false && stringRecord(entry.headers) && Object.keys(entry.headers).length > 0 && !hasAuthHeader) blocked("headers", "Legacy custom headers suppressed implicit OAuth; native requires an Authorization header to suppress it.", "auth-denial");
  if (entry.auth === "bearer") {
    const token = entry.bearerToken;
    const env = entry.bearerTokenEnv;
    if (token !== undefined && typeof token !== "string") blocked("bearerToken", "Bearer token must be a string.", "auth");
    else if (token === undefined && (typeof env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env))) blocked("bearerTokenEnv", "Bearer configuration needs a token or a valid environment variable name.", "auth");
    else if (typeof token === "string" && /\$env:/.test(token)) blocked("bearerToken", "Unsupported legacy bearer interpolation requires manual conversion.", "auth");
    else {
      if (hasAuthHeader && stringRecord(entry.headers) && Object.keys(entry.headers).some((key) => key.toLowerCase() === "authorization" && key !== "Authorization")) blocked("headers", "Ambiguous Authorization header casing requires manual review.", "auth");
      entry.headers = { ...(record(entry.headers) ? entry.headers : {}), Authorization: `Bearer ${token ?? `\${${env}}`}` };
      mapped("auth.bearer");
    }
  } else if (entry.bearerToken !== undefined || entry.bearerTokenEnv !== undefined) blocked("bearerToken", "Inactive legacy bearer credentials must be reviewed rather than copied as inert secrets.", "auth");
  if (record(entry.oauth)) {
    const oauth = { ...entry.oauth };
    for (const field of Object.keys(oauth)) {
      if (!["clientId", "clientSecret", "scope", "redirectUri", "grantType", "callbackUrl", "callbackPort"].includes(field)) blocked(`oauth.${field}`, "Native OAuth cannot preserve this registration option.", "oauth");
    }
    if (oauth.grantType !== undefined && oauth.grantType !== "authorization_code") blocked("oauth.grantType", "Native MCP has no client_credentials grant configuration.", "oauth-grant");
    if (oauth.redirectUri !== undefined) {
      if (oauth.callbackUrl !== undefined && oauth.callbackUrl !== oauth.redirectUri) blocked("oauth.redirectUri", "Legacy/native OAuth redirect settings conflict.", "oauth-redirect");
      else { oauth.callbackUrl = oauth.redirectUri; mapped("oauth.redirectUri"); }
    }
    if (oauth.callbackUrl !== undefined) {
      try {
        if (typeof oauth.callbackUrl !== "string") throw new Error();
        const url = new URL(oauth.callbackUrl);
        if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search || url.hash || url.username || url.password || (oauth.redirectUri !== undefined && !url.port)) throw new Error();
        if (oauth.callbackPort !== undefined && oauth.callbackPort !== Number(url.port)) throw new Error();
      } catch { blocked("oauth.callbackUrl", "Exact legacy redirect must have a fixed HTTP loopback port and no query, fragment or credentials.", "oauth-redirect"); }
    }
    if (oauth.callbackPort !== undefined && (typeof oauth.callbackPort !== "number" || !Number.isInteger(oauth.callbackPort) || oauth.callbackPort < 1 || oauth.callbackPort > 65535)) blocked("oauth.callbackPort", "Invalid OAuth callback port.", "oauth-redirect");
    for (const field of ["clientId", "clientSecret", "scope"]) {
      if (oauth[field] !== undefined && typeof oauth[field] !== "string") blocked(`oauth.${field}`, "OAuth settings must be strings.", "oauth");
      if (typeof oauth[field] === "string" && (oauth[field].startsWith("!") || /\$env:/.test(oauth[field]))) blocked(`oauth.${field}`, "OAuth value resolution changes between backends.", "value-semantics");
    }
    delete oauth.redirectUri; delete oauth.grantType;
    entry.oauth = oauth;
  } else if (entry.oauth !== undefined && entry.oauth !== false) blocked("oauth", "oauth must be a configuration object.", "oauth");
  if (entry.oauth === false) delete entry.oauth;
  if (entry.auth !== undefined) mapped("auth");

  if (entry.exposure !== undefined && !EXPOSURES.has(String(entry.exposure))) blocked("exposure", "Unknown native exposure.", "exposure");
  const exposure: Record<string, McpExposure> = Object.create(null);
  if (entry.toolExposure !== undefined && (!record(entry.toolExposure) || Object.values(entry.toolExposure).some((value) => !EXPOSURES.has(String(value))))) blocked("toolExposure", "Invalid native toolExposure.", "exposure");
  else if (record(entry.toolExposure)) Object.assign(exposure, entry.toolExposure);
  const direct = entry.directTools !== undefined ? entry.directTools : settings.directTools;
  if (direct !== undefined && typeof direct !== "boolean" && !strings(direct)) blocked("directTools", "directTools must be boolean or exact original tool names.", "direct-tools");
  const wanted = direct === true ? "direct" : "codemode";
  if (direct !== undefined) {
    if (entry.exposure !== undefined && entry.exposure !== wanted) blocked("directTools", "Legacy directTools and existing native exposure conflict.", "exposure-conflict");
    else { entry.exposure = wanted; mapped("directTools"); }
  }
  if (strings(direct)) {
    for (const tool of direct) {
      if (tool.includes("*")) { blocked("directTools", "A literal '*' tool name cannot become a native exposure pattern.", "wildcard"); continue; }
      if (Object.hasOwn(exposure, tool) && exposure[tool] !== "direct") blocked("directTools", "Legacy direct selection conflicts with an existing exact native exposure.", "exposure-conflict");
      else exposure[tool] = "direct";
    }
  }
  if (entry.excludeTools !== undefined && !strings(entry.excludeTools)) blocked("excludeTools", "excludeTools must contain literal names.", "exclusions");
  const prefix = ["server", "none", "short"].includes(String(settings.toolPrefix)) ? settings.toolPrefix as "server" | "none" | "short" : "server";
  for (const excluded of strings(entry.excludeTools) ? entry.excludeTools : []) {
    if (excluded.includes("*")) { blocked("excludeTools", "Legacy exclusions are literal, not glob patterns; a literal '*' cannot be safely expressed by native toolExposure.", "wildcard"); continue; }
    const normalized = excluded.replaceAll("-", "_");
    const candidates = new Set([normalized]);
    for (const mode of [prefix, "server", "short"] as const) {
      const p = getServerPrefix(name, mode);
      if (p && normalized.startsWith(`${p}_`)) candidates.add(normalized.slice(p.length + 1));
    }
    // Legacy compares normalized original and all three prefix aliases. Enumerating exact
    // spellings avoids broadening that literal denial into a native glob, even for future tools.
    for (const candidate of candidates) {
      if (candidate.startsWith("get_")) blocked("excludeTools", "A legacy synthetic resource denial cannot be enforced by native toolExposure on the shared read-resource tool.", "resource-denial");
      if ((candidate.match(/_/g)?.length ?? 0) > 10) { blocked("excludeTools", "Exclusion alias expansion exceeds the safe exact-name bound.", "exclusions"); continue; }
      let spellings = [""];
      for (const char of candidate) spellings = char === "_" ? spellings.flatMap((s) => [`${s}_`, `${s}-`]) : spellings.map((s) => s + char);
      for (const tool of spellings) {
        if (Object.hasOwn(exposure, tool) && exposure[tool] !== "hidden" && record(source.toolExposure) && Object.hasOwn(source.toolExposure, tool)) blocked("excludeTools", "Legacy denial conflicts with an existing native exact exposure; review instead of weakening it.", "exposure-conflict");
        exposure[tool] = "hidden"; // exact beats patterns; denial beats generated direct selection
      }
    }
    mapped("excludeTools");
  }
  if (Object.keys(exposure).length) entry.toolExposure = exposure;
  for (const field of legacy) delete entry[field];
  return entry;
}

/** Deliberately allowlist-only: no raw paths, server/tool names, commands, URLs, secrets or error text. */
export function previewNativeMcpMigration(plan: NativeMcpMigrationPlan): string {
  const publicFields = new Set([
    "name", "command", "args", "env", "cwd", "url", "headers", "enabled", "type", "timeout",
    "exposure", "toolExposure", "oauth", "auth", "auth.bearer", "bearerToken", "bearerTokenEnv",
    "directTools", "excludeTools", "requestTimeoutMs", "lifecycle", "idleTimeout", "exposeResources",
    "debug", "toolPrefix", "sampling", "samplingAutoApprove", "elicitation", "outputGuard",
    "disableProxyTool", "oauth.clientId", "oauth.clientSecret", "oauth.scope", "oauth.grantType",
    "oauth.redirectUri", "oauth.callbackUrl", "oauth.callbackPort",
  ]);
  const labels = new Map<string, string>();
  const label = (scope: Scope | undefined, server: string | undefined): string | undefined => {
    if (server === undefined) return undefined;
    const key = `${scope}:${server}`;
    if (!labels.has(key)) labels.set(key, `server-${labels.size + 1}`);
    return labels.get(key);
  };
  const field = (value: string | undefined): string | undefined => value === undefined ? undefined : publicFields.has(value) ? value : "unsupported-field";
  return json({
    version: plan.version, mode: "dry-run", canApply: !plan.blockers.length,
    files: plan.writes.map((write) => ({ scope: write.scope, changed: true, servers: Object.keys((JSON.parse(write.afterText) as JsonObject).mcpServers as JsonObject).length })),
    blockers: plan.blockers.map((issue) => ({ code: issue.code, scope: issue.scope, server: label(issue.scope, issue.server), field: field(issue.field), reason: issue.message })),
    warnings: plan.warnings.map(({ code, message }) => ({ code, message })),
    mappings: plan.mappings.map((mapping) => ({ scope: mapping.scope, server: label(mapping.scope, mapping.server), field: field(mapping.field), result: mapping.result })),
    prerequisites: ["Run migration in a Pi session with builtin:mcp disabled so native startup cannot consume unmigrated legacy fields."],
    nativeTools: { discovery: "Opt in with defaultTools: [\"+tool_search\"] and enable builtin:tool-search; explicit CLI tool restrictions still apply.", codemode: "Optional; enable separately only for tools intended for scripts." },
    next: "Only explicit apply plus interactive approval writes files. OAuth tokens are not copied; use /mcp login <server> and /reload after enabling native MCP.",
  });
}

function nodeError(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && error.code === code; }
function safeParents(path: string, create = false): void {
  const parent = dirname(resolve(path));
  let current = parse(parent).root;
  for (const part of relative(current, parent).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe migration parent directory");
    } catch (error) {
      if (!create || !nodeError(error, "ENOENT")) throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe migration parent directory");
    }
  }
}
function readSafe(path: string): string | null {
  safeParents(path);
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe migration file");
    const bytes = fs.readFileSync(path);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes.toString("utf8");
  } catch (error) { if (nodeError(error, "ENOENT")) return null; throw error; }
}
function snapshot(path: string): MigrationDocument {
  try { return { path: resolve(path), text: readSafe(path) }; }
  catch (error) { if (nodeError(error, "ENOENT")) return { path: resolve(path), text: null }; throw error; }
}
/** Reads config and optional Apps metadata only; never reads an OAuth token store. */
export function collectNativeMcpMigrationInput(cwd: string, projectTrusted: boolean): NativeMigrationInput {
  const globalTarget = getPiGlobalConfigPath();
  const projectTarget = getProjectPiConfigPath(cwd);
  const paths = [getGenericGlobalConfigPath(), globalTarget, getProjectConfigPath(cwd), projectTarget];
  const sources = ORDER.map((id, index) => ({ id, ...snapshot(paths[index]) }));
  const imports = findAvailableImportConfigs(cwd).map(({ kind, path }) => ({ kind, ...snapshot(path) }));
  let apps = false;
  let appsMetadataUnreadable = false;
  const cache = snapshot(getAgentPath("mcp-cache.json"));
  if (cache.text !== null) {
    try {
      const parsed: unknown = JSON.parse(cache.text);
      if (record(parsed) && record(parsed.servers)) apps = Object.values(parsed.servers).some((server) => record(server) && Array.isArray(server.tools) && server.tools.some((tool) => record(tool) && (tool.uiResourceUri !== undefined || tool.uiStreamMode !== undefined)));
      else appsMetadataUnreadable = true;
    } catch {
      appsMetadataUnreadable = true;
    }
  }
  return { sources, imports, globalTarget, projectTarget, projectTrusted, legacyFeatures: { apps, appsMetadataUnreadable } };
}

export interface MigrationBackupFile { path: string; backupPath: string; existed: boolean; beforeHash: string; afterHash: string }
export interface NativeMigrationReceipt {
  version: typeof NATIVE_MCP_MIGRATION_VERSION;
  state: "prepared" | "committed" | "rolled-back";
  files: MigrationBackupFile[];
  receiptPath: string;
}
function assertSnapshot(doc: MigrationDocument): void {
  if (snapshot(doc.path).text !== doc.text) throw new Error("Migration source changed; re-run dry-run and approval");
}
function privateWrite(path: string, text: string): void {
  safeParents(path);
  const fd = fs.openSync(path, "wx", 0o600);
  try {
    // Revalidate after open: a parent swap must not send secret backup bytes elsewhere.
    safeParents(path);
    const opened = fs.fstatSync(fd);
    const named = fs.lstatSync(path);
    if (!named.isFile() || named.isSymbolicLink() || named.ino !== opened.ino || named.dev !== opened.dev) throw new Error("Migration file replaced during open");
    fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function replace(path: string, text: string, expected: string | null): void {
  safeParents(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    privateWrite(temp, text);
    safeParents(path);
    if (readSafe(path) !== expected) throw new Error("Migration destination changed; refusing overwrite");
    fs.renameSync(temp, path);
  } finally { try { fs.unlinkSync(temp); } catch (error) { if (!nodeError(error, "ENOENT")) throw error; } }
}
function locked<T>(paths: string[], run: () => T): T {
  const locks: { path: string; token: string }[] = [];
  try {
    for (const path of [...new Set(paths.map((p) => resolve(p)))].sort()) {
      safeParents(path, true);
      const lock = `${path}.maestro-migration.lock`;
      const token = randomUUID();
      privateWrite(lock, token); // no automatic stale-lock takeover
      locks.push({ path: lock, token });
    }
    return run();
  } finally {
    for (const lock of locks.reverse()) if (readSafe(lock.path) === lock.token) fs.unlinkSync(lock.path);
  }
}
/** Backs up ALL destinations durably before the first config rename. Requires explicit approval. */
export function backupNativeMcpMigration(plan: NativeMcpMigrationPlan, options: { approved: boolean }): NativeMigrationReceipt | null {
  if (!options.approved) throw new Error("Explicit migration approval required");
  if (plan.version !== 1 || plan.blockers.length) throw new Error("Migration has blockers or an unsupported version");
  if (!plan.writes.length) return null;
  for (const doc of plan.snapshots) assertSnapshot(doc);
  const id = randomUUID();
  const files: MigrationBackupFile[] = [];
  for (const write of plan.writes) {
    assertSnapshot(write);
    safeParents(write.path, true);
    const backupPath = `${write.path}.maestro-migration-v1-${id}.bak`;
    privateWrite(backupPath, write.text ?? "");
    files.push({ path: resolve(write.path), backupPath, existed: write.text !== null, beforeHash: hash(write.text), afterHash: hash(write.afterText) });
  }
  const receiptPath = `${plan.writes[0].path}.maestro-migration-v1-${id}.json`;
  const receipt: NativeMigrationReceipt = { version: 1, state: "prepared", files, receiptPath };
  privateWrite(receiptPath, json(receipt));
  return receipt;
}
/** Atomic per-file commits, with transaction-wide rollback on failure; crash recovery uses the prepared receipt. */
export function applyNativeMcpMigration(plan: NativeMcpMigrationPlan, options: { approved: boolean }): NativeMigrationReceipt | null {
  if (!options.approved) throw new Error("Explicit migration approval required");
  if (plan.version !== 1 || plan.blockers.length) throw new Error("Migration has blockers or an unsupported version");
  if (!plan.writes.length) return null;
  return locked(plan.writes.map((w) => w.path), () => {
    const receipt = backupNativeMcpMigration(plan, options)!;
    const committed: MigrationWrite[] = [];
    try {
      for (const write of plan.writes) {
        for (const doc of plan.snapshots) if (!committed.some((w) => w.path === doc.path)) assertSnapshot(doc);
        replace(write.path, write.afterText, write.text);
        committed.push(write);
      }
      const before = readSafe(receipt.receiptPath);
      receipt.state = "committed";
      replace(receipt.receiptPath, json(receipt), before);
      return receipt;
    } catch (error) {
      // Do not clobber intervening external changes; leave the receipt/backups for explicit recovery.
      for (const write of committed.reverse()) {
        if (readSafe(write.path) !== write.afterText) throw new Error("Migration recovery conflict; recover with the prepared receipt");
        if (write.text === null) fs.unlinkSync(write.path);
        else replace(write.path, write.text, write.afterText);
      }
      throw error;
    }
  });
}
/** Restores only checksum-verified backups and refuses to overwrite post-migration edits. */
export function rollbackNativeMcpMigration(receiptPath: string, options: { approved: boolean; allowedTargets?: readonly string[] }): NativeMigrationReceipt {
  if (!options.approved) throw new Error("Explicit rollback approval required");
  const text = readSafe(resolve(receiptPath));
  if (text === null) throw new Error("Migration receipt not found");
  const parsed: unknown = JSON.parse(text);
  if (!record(parsed) || parsed.version !== 1 || !["prepared", "committed", "rolled-back"].includes(String(parsed.state)) || !Array.isArray(parsed.files) || parsed.receiptPath !== resolve(receiptPath)) throw new Error("Invalid migration receipt");
  const receipt = parsed as unknown as NativeMigrationReceipt;
  const paths = new Set<string>();
  for (const file of receipt.files) {
    if (!record(file) || typeof file.path !== "string" || !isAbsolute(file.path) || typeof file.backupPath !== "string" || dirname(file.path) !== dirname(file.backupPath) || !file.backupPath.startsWith(`${file.path}.maestro-migration-v1-`) || !file.backupPath.endsWith(".bak") || typeof file.existed !== "boolean" || !/^[a-f0-9]{64}$/.test(file.beforeHash) || !/^[a-f0-9]{64}$/.test(file.afterHash) || paths.has(file.path)) throw new Error("Invalid migration backup descriptor");
    if (options.allowedTargets && !options.allowedTargets.some((path) => resolve(path) === file.path)) throw new Error("Migration rollback target is outside the approved config scope");
    paths.add(file.path);
  }
  return locked([...paths], () => {
    if (readSafe(receipt.receiptPath) !== text) throw new Error("Migration receipt changed");
    const restores = receipt.files.map((file) => {
      const backup = readSafe(file.backupPath);
      if (backup === null || hash(file.existed ? backup : null) !== file.beforeHash || (!file.existed && backup !== "")) throw new Error("Migration backup checksum mismatch");
      const current = readSafe(file.path);
      if (![file.beforeHash, file.afterHash].includes(hash(current))) throw new Error("Rollback would overwrite post-migration changes");
      return { file, backup, current };
    });
    for (const { file, backup, current } of restores) {
      if (hash(current) === file.beforeHash) continue;
      if (file.existed) replace(file.path, backup, current);
      else { if (readSafe(file.path) !== current) throw new Error("Rollback destination changed"); fs.unlinkSync(file.path); }
    }
    receipt.state = "rolled-back";
    replace(receipt.receiptPath, json(receipt), text);
    return receipt;
  });
}

/** Call only in the native backend branch. Does not register /mcp, any tool, or --mcp-config. */
export function registerNativeMcpMigration(pi: ExtensionAPI): void {
  pi.registerCommand("maestro-mcp-migrate", {
    description: "Preview legacy MCP configuration migration (redacted); explicit apply requires approval",
    handler: async (args, ctx) => {
      const verb = args.trim();
      if (verb && verb !== "dry-run" && verb !== "apply" && !verb.startsWith("rollback ")) {
        ctx.ui.notify("Usage: /maestro-mcp-migrate [dry-run|apply|rollback <receipt-path>]", "warning");
        return;
      }
      try {
        if (verb.startsWith("rollback ")) {
          if (!ctx.hasUI || !await ctx.ui.confirm("Roll back MCP migration?", "Restore checksum-verified backups only if configurations have not been edited since migration?")) return;
          const allowedTargets = [getPiGlobalConfigPath(), ...(ctx.isProjectTrusted() ? [getProjectPiConfigPath(ctx.cwd)] : [])];
          rollbackNativeMcpMigration(verb.slice(9).trim(), { approved: true, allowedTargets });
          ctx.ui.notify("MCP configuration rollback complete. Run /reload.", "info");
          return;
        }
        const plan = planNativeMcpMigration(collectNativeMcpMigrationInput(ctx.cwd, ctx.isProjectTrusted()));
        ctx.ui.notify(previewNativeMcpMigration(plan), plan.blockers.length ? "warning" : "info");
        if (verb !== "apply" || plan.blockers.length || !plan.writes.length) return;
        if (!ctx.hasUI) { ctx.ui.notify("Migration apply requires interactive approval; dry-run only.", "warning"); return; }
        if (!await ctx.ui.confirm("Apply MCP config migration v1?", "Write only Pi global/project MCP config, keep private backups, and preserve project trust. Native names/defaults change. OAuth tokens are not copied. Shared/import files are not modified.")) return;
        // Recheck workspace trust after the asynchronous approval dialog.
        if (!ctx.isProjectTrusted() && plan.writes.some((w) => w.scope === "project")) throw new Error("Project trust changed");
        const receipt = applyNativeMcpMigration(plan, { approved: true });
        ctx.ui.notify(`MCP config migration complete. Backup receipt: ${receipt?.receiptPath ?? "none"}. Use /mcp login <server> and /reload.`, "info");
      } catch {
        // OS/JSON errors may contain file content, URLs or command arguments. Never echo them.
        ctx.ui.notify("MCP migration refused or failed. No secrets were displayed. Re-run dry-run; inspect the private backup receipt for recovery if an apply was interrupted.", "error");
      }
    },
  });
}
