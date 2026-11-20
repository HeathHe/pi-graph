import {
  formatSkillsForPrompt,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { getTuiLocale } from "../tui/locale.ts";
import { loadSkillConfig, type SkillDefaults } from "./skill-config.ts";
import { SkillManagerStore, type ManagedSkill, type ManagedSkillGroup, type OptionalSkill } from "./skill-manager-store.ts";
import {
  SkillManagerOverlay,
  type SkillManagerAction,
  type SkillManagerUiState,
} from "./skill-manager-tui.ts";
import {
  extractHeadlessArgs,
  headlessField,
  parseHeadlessBoolean,
  splitCommandArgs,
} from "../tui/headless-args.ts";
import { supportsCustomOverlay } from "pi-maestro-settings-core/ui";

export interface SkillManagerResult {
  configChanged: boolean;
}

const CATALOGS = {
  en: {
    "command.description": "Manage skill loading state and model-invocation permissions",
    "notify.noTui": "The Skill Manager requires an interactive TUI.",
    "notice.noSkills": "No skills found",
    "input.title": "New skill group",
    "input.prompt": "Enter a group name",
    "notice.createCancelled": "Group creation cancelled",
    "notice.createOk": "Group created · {name}",
    "notice.createFailed": "Failed to create group · {message}",
    "notice.moveNeedSkill": "Cannot move · select a skill first",
    "defaultGroup": "Default prefix group",
    "select.title": "Move {name}",
    "notice.moveCancelled": "Move cancelled",
    "notice.moveOk": "Moved · {name} → {target}",
    "notice.moveFailed": "Failed to move · {message}",
    "notice.deleteForbidden": "Cannot delete · the default prefix group is generated from skill names",
    "confirm.title": "Delete group “{name}”?",
    "confirm.detail": "Skills in the group return to the default prefix group; the skills themselves are not deleted.",
    "notice.deleteCancelled": "Group deletion cancelled",
    "notice.deleteOk": "Group deleted · {name}",
    "notice.deleteFailed": "Failed to delete group · {message}",
    "notice.installOk": "Installed optional skill · {name} · reload after closing",
    "notice.installFailed": "Install failed · {message}",
    "notice.noSelection": "Cannot act · no skill or group selected",
    "status.toggling": "Skill · {action} {name}…",
    "status.action.enable": "enabling",
    "status.action.disable": "disabling",
    "notice.toggledOn": "Enabled · {name} · reload after closing",
    "notice.toggledOff": "Disabled · {name} · reload after closing",
    "status.togglingGroup": "Skill · toggling group {name}…",
    "notice.toggleGroupOk": "Group load state toggled · {name} · reload after closing",
    "status.invocation": "Skill · {action} model invocation {name}…",
    "status.action.allow": "allowing",
    "status.action.forbid": "forbidding",
    "notice.invocationAllowed": "Model invocation allowed · {name} · reload after closing",
    "notice.invocationManual": "Manual-only invocation · {name} · reload after closing",
    "status.togglingGroupInvocation": "Skill · toggling group model invocation {name}…",
    "notice.toggleGroupInvocationOk": "Group model invocation toggled · {name} · reload after closing",
    "notice.updateFailed": "Update failed · {message}",
  },
  "zh-CN": {
    "command.description": "管理 Skill 的加载状态与模型主动调用权限",
    "notify.noTui": "Skill 管理器需要交互式 TUI。",
    "notice.noSkills": "没有发现 Skill",
    "input.title": "新建 Skill 分组",
    "input.prompt": "输入分组名称",
    "notice.createCancelled": "已取消新建分组",
    "notice.createOk": "已新建分组 · {name}",
    "notice.createFailed": "新建分组失败 · {message}",
    "notice.moveNeedSkill": "无法移动 · 请选择一个 Skill",
    "defaultGroup": "默认前缀分组",
    "select.title": "移动 {name}",
    "notice.moveCancelled": "已取消移动",
    "notice.moveOk": "已移动 · {name} → {target}",
    "notice.moveFailed": "移动失败 · {message}",
    "notice.deleteForbidden": "无法删除 · 默认前缀分组由 Skill 名称自动生成",
    "confirm.title": "删除分组「{name}」？",
    "confirm.detail": "组内 Skill 会返回默认前缀分组，Skill 本身不会被删除。",
    "notice.deleteCancelled": "已取消删除分组",
    "notice.deleteOk": "已删除分组 · {name}",
    "notice.deleteFailed": "删除分组失败 · {message}",
    "notice.installOk": "已安装选装 Skill · {name} · 重启后生效",
    "notice.installFailed": "安装失败 · {message}",
    "notice.noSelection": "无法操作 · 未选择 Skill 或分组",
    "status.toggling": "Skill · 正在{action} {name}…",
    "status.action.enable": "启用",
    "status.action.disable": "停用",
    "notice.toggledOn": "已启用 · {name} · 关闭后重载",
    "notice.toggledOff": "已停用 · {name} · 关闭后重载",
    "status.togglingGroup": "Skill · 正在切换分组 {name}…",
    "notice.toggleGroupOk": "已切换分组加载状态 · {name} · 关闭后重载",
    "status.invocation": "Skill · 正在{action}模型调用 {name}…",
    "status.action.allow": "允许",
    "status.action.forbid": "禁止",
    "notice.invocationAllowed": "已允许模型主动调用 · {name} · 关闭后重载",
    "notice.invocationManual": "已设为仅手动调用 · {name} · 关闭后重载",
    "status.togglingGroupInvocation": "Skill · 正在切换分组模型调用 {name}…",
    "notice.toggleGroupInvocationOk": "已切换分组模型调用状态 · {name} · 关闭后重载",
    "notice.updateFailed": "更新失败 · {message}",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

function t(locale: SupportedSettingsLocale, key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
  const catalog = CATALOGS[locale] ?? CATALOGS.en;
  const template: unknown = catalog[key];
  const text = typeof template === "string" ? template : CATALOGS.en[key] as string;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

export function registerSkillManager(pi: ExtensionAPI): void {
  pi.registerCommand("skills", {
    description: t(getTuiLocale(), "command.description"),
    async handler(args, ctx) {
      const locale = getTuiLocale();
      const { positionals, fields } = extractHeadlessArgs(splitCommandArgs(args));
      const sub = positionals[0]?.toLowerCase() ?? "";
      if (sub && sub !== "open") {
        const changed = await runSkillManagerHeadless(ctx, new SkillManagerStore(ctx.cwd), sub, positionals.slice(1), fields, locale);
        if (changed) await ctx.reload();
        return;
      }
      if (!supportsCustomOverlay(ctx)) {
        ctx.ui.notify(
          `${t(locale, "notify.noTui")} Headless: /skills list|create-group <name>|delete-group <name> [--yes]|install <name>|assign <skill> [group]|enable <name> [--group]|disable <name> [--group]|allow-invocation <name> [--group]|forbid-invocation <name> [--group]`,
          "error",
        );
        return;
      }
      const result = await runSkillManager(ctx, new SkillManagerStore(ctx.cwd), locale);
      if (result.configChanged) {
        await ctx.reload();
        return;
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const { config } = await loadSkillConfig(ctx.cwd);
      const systemPrompt = applySkillModelInvocationConfig(
        event.systemPrompt,
        event.systemPromptOptions.skills ?? [],
        config.skills,
      );
      return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
    } catch (error) {
      console.error(
        `[maestro] Skill model-invocation config warning: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  });
}

export async function runSkillManager(
  ctx: ExtensionContext,
  store: SkillManagerStore,
  explicitLocale?: SupportedSettingsLocale,
): Promise<SkillManagerResult> {
  const locale = getTuiLocale(explicitLocale);
  let snapshot = await store.load();
  let optionalSkills = await store.loadOptionalSkills();
  let uiState: Partial<SkillManagerUiState> = { query: "" };
  let notice = snapshot.skills.length === 0 ? t(locale, "notice.noSkills") : undefined;
  let configChanged = false;

  while (true) {
    const action = await openSkillManagerOverlay(ctx, snapshot.skills, snapshot.groups, optionalSkills, uiState, notice, locale);
    uiState = action.uiState;
    if (action.kind === "close") break;

    if (action.kind === "create-group") {
      const name = await ctx.ui.input(t(locale, "input.title"), t(locale, "input.prompt"));
      if (!name) {
        notice = t(locale, "notice.createCancelled");
        continue;
      }
      try {
        snapshot = await store.createGroup(name);
        configChanged = true;
        notice = t(locale, "notice.createOk", { name: name.trim() });
        uiState = { ...uiState, selectedKey: `group:custom:${name.trim()}` };
      } catch (error) {
        notice = t(locale, "notice.createFailed", { message: errorMessage(error) });
      }
      continue;
    }

    const selected = action.skillPath
      ? snapshot.skills.find((skill) => skill.filePath === action.skillPath)
      : undefined;
    const selectedGroup = action.groupName
      ? snapshot.groups.find((group) => group.name === action.groupName && group.custom === action.groupCustom)
      : undefined;

    if (action.kind === "install-optional") {
      if (!action.optionalName) {
        notice = t(locale, "notice.noSelection");
        continue;
      }
      try {
        optionalSkills = await store.installOptionalSkill(action.optionalName);
        snapshot = await store.load();
        configChanged = true;
        notice = t(locale, "notice.installOk", { name: action.optionalName });
        uiState = { ...uiState, selectedKey: `skill:${joinOptionalInstalledPath(action.optionalName)}` };
      } catch (error) {
        notice = t(locale, "notice.installFailed", { message: errorMessage(error) });
      }
      continue;
    }

    if (action.kind === "assign-group") {
      if (!selected) {
        notice = t(locale, "notice.moveNeedSkill");
        continue;
      }
      const defaultGroup = t(locale, "defaultGroup");
      const customGroups = snapshot.groups.filter((group) => group.custom).map((group) => group.name);
      const target = await ctx.ui.select(t(locale, "select.title", { name: selected.name }), [defaultGroup, ...customGroups]);
      if (!target) {
        notice = t(locale, "notice.moveCancelled");
        continue;
      }
      try {
        snapshot = await store.assignSkillToGroup(selected.name, target === defaultGroup ? undefined : target);
        configChanged = true;
        notice = t(locale, "notice.moveOk", { name: selected.name, target });
        uiState = { ...uiState, selectedKey: `skill:${selected.filePath}` };
      } catch (error) {
        notice = t(locale, "notice.moveFailed", { message: errorMessage(error) });
      }
      continue;
    }

    if (action.kind === "delete-group") {
      if (!selectedGroup?.custom) {
        notice = t(locale, "notice.deleteForbidden");
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        t(locale, "confirm.title", { name: selectedGroup.name }),
        t(locale, "confirm.detail"),
      );
      if (!confirmed) {
        notice = t(locale, "notice.deleteCancelled");
        continue;
      }
      try {
        snapshot = await store.deleteGroup(selectedGroup.name);
        configChanged = true;
        notice = t(locale, "notice.deleteOk", { name: selectedGroup.name });
        uiState = { ...uiState, selectedKey: undefined };
      } catch (error) {
        notice = t(locale, "notice.deleteFailed", { message: errorMessage(error) });
      }
      continue;
    }

    if (!selected && !selectedGroup) {
      notice = t(locale, "notice.noSelection");
      continue;
    }

    try {
      if (action.kind === "toggle-enabled") {
        if (selected) {
          const actionLabel = selected.enabled ? t(locale, "status.action.disable") : t(locale, "status.action.enable");
          ctx.ui.setStatus("skill-manager", t(locale, "status.toggling", { action: actionLabel, name: selected.name }));
          snapshot = await store.toggleEnabled(selected);
          notice = t(locale, selected.enabled ? "notice.toggledOff" : "notice.toggledOn", { name: selected.name });
        } else {
          ctx.ui.setStatus("skill-manager", t(locale, "status.togglingGroup", { name: selectedGroup!.name }));
          snapshot = await store.toggleGroupEnabled(selectedGroup!);
          notice = t(locale, "notice.toggleGroupOk", { name: selectedGroup!.name });
        }
      } else {
        if (selected) {
          const actionLabel = selected.disableModelInvocation ? t(locale, "status.action.allow") : t(locale, "status.action.forbid");
          ctx.ui.setStatus("skill-manager", t(locale, "status.invocation", { action: actionLabel, name: selected.name }));
          snapshot = await store.toggleModelInvocation(selected);
          notice = selected.disableModelInvocation
            ? t(locale, "notice.invocationAllowed", { name: selected.name })
            : t(locale, "notice.invocationManual", { name: selected.name });
        } else {
          ctx.ui.setStatus("skill-manager", t(locale, "status.togglingGroupInvocation", { name: selectedGroup!.name }));
          snapshot = await store.toggleGroupModelInvocation(selectedGroup!);
          notice = t(locale, "notice.toggleGroupInvocationOk", { name: selectedGroup!.name });
        }
      }
      configChanged = true;
      uiState = {
        ...uiState,
        selectedKey: selected ? `skill:${selected.filePath}` : action.uiState.selectedKey,
      };
    } catch (error) {
      notice = t(locale, "notice.updateFailed", { message: errorMessage(error) });
    } finally {
      ctx.ui.setStatus("skill-manager", undefined);
    }
  }

  return { configChanged };
}

const SKILL_HEADLESS_USAGE =
  "用法：/skills list|create-group <name>|delete-group <name> [--yes]|install <name>|assign <skill> [group]|enable <name> [--group]|disable <name> [--group]|allow-invocation <name> [--group]|forbid-invocation <name> [--group]";

/**
 * /skills 的 headless 变更路径：不走 overlay，直接调用 store 的确定性写入。
 * 返回是否有配置变更（调用方据此决定是否 ctx.reload()）。
 */
async function runSkillManagerHeadless(
  ctx: ExtensionContext,
  store: SkillManagerStore,
  sub: string,
  rest: string[],
  fields: Record<string, string>,
  locale: SupportedSettingsLocale,
): Promise<boolean> {
  const nameArg = rest[0] ?? headlessField(fields, "name", "skill");
  const groupOnly = parseHeadlessBoolean(headlessField(fields, "group") ?? "") === true;
  const assumeYes = parseHeadlessBoolean(headlessField(fields, "yes") ?? "") === true;
  const findSkill = (snapshot: Awaited<ReturnType<SkillManagerStore["load"]>>, name: string) =>
    snapshot.skills.find((skill) => skill.name === name || skill.filePath === name);
  const findGroup = (snapshot: Awaited<ReturnType<SkillManagerStore["load"]>>, name: string) =>
    snapshot.groups.find((group) => group.name === name);

  switch (sub) {
    case "list":
    case "ls": {
      const [snapshot, optional] = await Promise.all([store.load(), store.loadOptionalSkills()]);
      const lines = [
        ...snapshot.groups.map((group) => `[group${group.custom ? " custom" : ""}] ${group.name} (${group.skills.length})`),
        ...snapshot.skills.map((skill) =>
          `${skill.enabled ? "on " : "off"} ${skill.name}${skill.disableModelInvocation ? " [no-model-invocation]" : ""}`),
        ...optional.filter((entry) => !entry.installed).map((entry) => `optional ${entry.name}`),
      ];
      ctx.ui.notify(lines.length > 0 ? lines.join("\n") : t(locale, "notice.noSkills"), "info");
      return false;
    }
    case "create-group": {
      if (!nameArg) {
        ctx.ui.notify(SKILL_HEADLESS_USAGE, "warning");
        return false;
      }
      try {
        await store.createGroup(nameArg);
        ctx.ui.notify(t(locale, "notice.createOk", { name: nameArg.trim() }), "info");
        return true;
      } catch (error) {
        ctx.ui.notify(t(locale, "notice.createFailed", { message: errorMessage(error) }), "warning");
        return false;
      }
    }
    case "delete-group": {
      if (!nameArg) {
        ctx.ui.notify(SKILL_HEADLESS_USAGE, "warning");
        return false;
      }
      const snapshot = await store.load();
      const group = findGroup(snapshot, nameArg);
      if (!group?.custom) {
        ctx.ui.notify(t(locale, "notice.deleteForbidden"), "warning");
        return false;
      }
      const confirmed = assumeYes || await ctx.ui.confirm(
        t(locale, "confirm.title", { name: group.name }),
        t(locale, "confirm.detail"),
      );
      if (!confirmed) {
        ctx.ui.notify(t(locale, "notice.deleteCancelled"), "info");
        return false;
      }
      try {
        await store.deleteGroup(group.name);
        ctx.ui.notify(t(locale, "notice.deleteOk", { name: group.name }), "info");
        return true;
      } catch (error) {
        ctx.ui.notify(t(locale, "notice.deleteFailed", { message: errorMessage(error) }), "warning");
        return false;
      }
    }
    case "install": {
      if (!nameArg) {
        ctx.ui.notify(SKILL_HEADLESS_USAGE, "warning");
        return false;
      }
      try {
        await store.installOptionalSkill(nameArg);
        ctx.ui.notify(t(locale, "notice.installOk", { name: nameArg }), "info");
        return true;
      } catch (error) {
        ctx.ui.notify(t(locale, "notice.installFailed", { message: errorMessage(error) }), "warning");
        return false;
      }
    }
    case "assign": {
      if (!nameArg) {
        ctx.ui.notify(SKILL_HEADLESS_USAGE, "warning");
        return false;
      }
      const snapshot = await store.load();
      const skill = findSkill(snapshot, nameArg);
      if (!skill) {
        ctx.ui.notify(`Skill "${nameArg}" 不存在`, "warning");
        return false;
      }
      const groupArg = rest[1] ?? headlessField(fields, "group", "to");
      const target = groupArg && !["default", "none", "-"].includes(groupArg.toLowerCase()) ? groupArg : undefined;
      try {
        await store.assignSkillToGroup(skill.name, target);
        ctx.ui.notify(t(locale, "notice.moveOk", { name: skill.name, target: target ?? t(locale, "defaultGroup") }), "info");
        return true;
      } catch (error) {
        ctx.ui.notify(t(locale, "notice.moveFailed", { message: errorMessage(error) }), "warning");
        return false;
      }
    }
    case "enable":
    case "disable": {
      if (!nameArg) {
        ctx.ui.notify(SKILL_HEADLESS_USAGE, "warning");
        return false;
      }
      const want = sub === "enable";
      const snapshot = await store.load();
      const skill = groupOnly ? undefined : findSkill(snapshot, nameArg);
      try {
        if (skill) {
          await store.setEnabled(skill, want);
          ctx.ui.notify(t(locale, want ? "notice.toggledOn" : "notice.toggledOff", { name: skill.name }), "info");
          return true;
        }
        const group = findGroup(snapshot, nameArg);
        if (!group) {
          ctx.ui.notify(`Skill/分组 "${nameArg}" 不存在`, "warning");
          return false;
        }
        await store.setGroupEnabled(group, want);
        ctx.ui.notify(t(locale, "notice.toggleGroupOk", { name: group.name }), "info");
        return true;
      } catch (error) {
        ctx.ui.notify(t(locale, "notice.updateFailed", { message: errorMessage(error) }), "warning");
        return false;
      }
    }
    case "allow-invocation":
    case "forbid-invocation": {
      if (!nameArg) {
        ctx.ui.notify(SKILL_HEADLESS_USAGE, "warning");
        return false;
      }
      const disable = sub === "forbid-invocation";
      const snapshot = await store.load();
      const skill = groupOnly ? undefined : findSkill(snapshot, nameArg);
      try {
        if (skill) {
          await store.setModelInvocation(skill, disable);
          ctx.ui.notify(t(locale, disable ? "notice.invocationManual" : "notice.invocationAllowed", { name: skill.name }), "info");
          return true;
        }
        const group = findGroup(snapshot, nameArg);
        if (!group) {
          ctx.ui.notify(`Skill/分组 "${nameArg}" 不存在`, "warning");
          return false;
        }
        await store.setGroupModelInvocation(group, disable);
        ctx.ui.notify(t(locale, "notice.toggleGroupInvocationOk", { name: group.name }), "info");
        return true;
      } catch (error) {
        ctx.ui.notify(t(locale, "notice.updateFailed", { message: errorMessage(error) }), "warning");
        return false;
      }
    }
    default:
      ctx.ui.notify(SKILL_HEADLESS_USAGE, "warning");
      return false;
  }
}

export function applySkillModelInvocationConfig(
  systemPrompt: string,
  skills: readonly Skill[],
  config: Readonly<Record<string, SkillDefaults>>,
): string {
  const effectiveSkills = skills.map((skill) => {
    const configured = config[skill.name]?.["disable-model-invocation"];
    return configured === undefined
      ? skill
      : { ...skill, disableModelInvocation: configured };
  });
  const originalSection = formatSkillsForPrompt([...skills]);
  const effectiveSection = formatSkillsForPrompt(effectiveSkills);
  if (originalSection === effectiveSection) return systemPrompt;
  if (originalSection && systemPrompt.includes(originalSection)) {
    return systemPrompt.replace(originalSection, effectiveSection);
  }
  if (!effectiveSection) return systemPrompt;
  const dateMarker = "\nCurrent date:";
  const dateIndex = systemPrompt.lastIndexOf(dateMarker);
  return dateIndex >= 0
    ? `${systemPrompt.slice(0, dateIndex)}${effectiveSection}${systemPrompt.slice(dateIndex)}`
    : `${systemPrompt}${effectiveSection}`;
}

async function openSkillManagerOverlay(
  ctx: ExtensionContext,
  skills: ManagedSkill[],
  groups: ManagedSkillGroup[],
  optionalSkills: OptionalSkill[],
  initialState: Partial<SkillManagerUiState>,
  notice: string | undefined,
  locale: SupportedSettingsLocale,
): Promise<SkillManagerAction> {
  return ctx.ui.custom<SkillManagerAction>((tui, theme, _keybindings, done) =>
    new SkillManagerOverlay({
      skills,
      groups,
      optionalSkills,
      theme,
      notice,
      initialState,
      locale,
      getTerminalRows: () => tui.terminal?.rows,
      requestRender: () => tui.requestRender(),
      done,
    }), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" },
  });
}

function joinOptionalInstalledPath(name: string): string {
  // After install the skill lives in <cwd>/.pi/skills/<name>/SKILL.md; the exact
  // path is resolved on the next snapshot, so keep selection on the optional row.
  return `optional:${name}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
