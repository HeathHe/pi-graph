import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeCardText, toolCallLine, toolResultLine } from "pi-cockpit/src/quiet-tools.ts";
import { getVisibleTasks } from "../tools/todo.ts";
import {
  SshHostProviderError,
  registerSshHostProvider,
  type SshHostProvider,
} from "pi-maestro-teammate/v1/ssh-hosts";
import type {
  SshHostProfile,
  SshHostReferenceSummary,
} from "pi-maestro-backend-core/v1/ssh";
import { EncryptedSshStore, defaultSshManagerStorePath } from "./encrypted-store.ts";
import { SshExecutor, type SshExecutionResult } from "./executor.ts";
import { registerSshBg, type SshBgManager, type SshBgJobStatus } from "./ssh-bg.ts";
import {
  SshGatewayCapabilityError,
  SshGatewayClientPool,
  type SshGatewayActionResult,
  type SshGatewayInput,
} from "./gateway-client.ts";
import { SshGatewayBootstrapManager } from "./gateway-bootstrap.ts";
import { GatewayCompletionRouter } from "./gateway-completion-router.ts";
import { pairSshGateway, sshGatewayGuide, unpairSshGateway } from "./guide.ts";
import { SshToolParams, parseSshToolInput, type ParsedSshToolInput, type SshToolInput } from "./llm-tool.ts";
import {
  SSH_HOST_ID_PATTERN,
  SSH_HOST_KEY_PATTERN,
  SSH_MAX_PRIVATE_KEY_BYTES,
  createSshHostId,
  createSshKeyId,
  reverseSshHostDependencyClosure,
  validateSshHost,
  validateSshKey,
  type SshAuth,
  type SshHost,
  type SshKey,
  type SshShell,
} from "./model.ts";
import {
  discoverOpenSshConfig,
  type DiscoverOpenSshOptions,
  type OpenSshDiscoveryResult,
  type OpenSshImportCandidate,
} from "./openssh-config.ts";
import { pinUntrustedHostsFromKnownHosts } from "./known-hosts.ts";
import {
  extractHeadlessArgs,
  headlessField,
  parseHeadlessBoolean,
  parseHeadlessList,
  splitCommandArgs,
} from "../tui/headless-args.ts";
import { supportsCustomOverlay } from "pi-maestro-settings-core/ui";
import { SshStatusMonitor, type SshHostOperationalStatus } from "./status-monitor.ts";
import {
  TeammateRemoteChannelBroker,
  sshHostReferenceIssue,
} from "./remote-channel.ts";
import {
  CurrentUserPiConfigSource,
  SshPiConfigSyncTransport,
  syncPiConfig,
  type PiConfigLocalSource,
  type PiConfigSyncAudit,
  type PiConfigSyncTransport,
} from "./pi-config-sync.ts";
import {
  MaskedSecretInput,
  SshHostManagerOverlay,
  SshHostPickerOverlay,
  type SshHostManagerAction,
  type SshManagerTheme,
  type SshManagerView,
} from "./tui.ts";
import { getTuiLocale } from "../tui/locale.ts";
import { editSshHostForm, editSshKeyForm } from "./host-form.ts";

const SSH_STATUS_KEY = "maestro-ssh";

function sshUi(english: string, chinese: string): string {
  return getTuiLocale() === "zh-CN" ? chinese : english;
}

interface SshToolTargetDetails {
  label: string;
  host: string;
  user: string;
  port: number;
  shell: SshShell;
}

interface SshToolDetails {
  hostId?: string;
  target?: SshToolTargetDetails;
  action?: string;
  tool?: string;
  summary?: string;
  sessionId?: string;
  jobId?: string;
  status?: SshBgJobStatus;
  background?: boolean;
  outputTail?: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}

export interface RegisterSshManagerOptions {
  storePath?: string;
  store?: EncryptedSshStore;
  executor?: SshExecutor;
  gatewayPool?: SshGatewayClientPool;
  gatewayBootstrap?: SshGatewayBootstrapManager;
  monitor?: SshStatusMonitor;
  discoverOpenSsh?: (options?: DiscoverOpenSshOptions) => Promise<OpenSshDiscoveryResult>;
  configSource?: PiConfigLocalSource;
  configSyncTransport?: (host: SshHost) => PiConfigSyncTransport;
  configSyncAudit?: PiConfigSyncAudit;
}

export function registerSshManager(
  pi: ExtensionAPI,
  options: RegisterSshManagerOptions = {},
): void {
  const store = options.store ?? new EncryptedSshStore({ path: options.storePath ?? defaultSshManagerStorePath() });
  const executor = options.executor ?? new SshExecutor(undefined, store);
  const gatewayPool = options.gatewayPool ?? new SshGatewayClientPool(executor, { bindingSource: store });
  const gatewayBootstrap = options.gatewayBootstrap ?? new SshGatewayBootstrapManager(executor, {
    onOwnedChannelClose: (hostId) => gatewayPool.invalidateHost(hostId),
  });
  const monitor = options.monitor ?? new SshStatusMonitor(store, executor);
  const discoverOpenSsh = options.discoverOpenSsh ?? discoverOpenSshConfig;
  const configSource = options.configSource ?? new CurrentUserPiConfigSource();
  const configSyncTransport = options.configSyncTransport ?? ((host: SshHost) => new SshPiConfigSyncTransport(executor, host));
  const remoteChannelBroker = new TeammateRemoteChannelBroker(store, executor);
  const selected = new Map<string, string>();
  let activeContext: ExtensionContext | undefined;
  let sshBackground: SshBgManager | undefined;

  // Launch receipt/cursor persistence advances the encrypted document revision,
  // but must not churn the transport cache. This HMAC changes only when the
  // effective connection chain or Gateway endpoint credentials change.
  const connectionFence = (hostId: string): string => store.getConnectionConfigFence(hostId);
  const selectionFence = connectionFence;
  const completionRouter = new GatewayCompletionRouter({
    pool: gatewayPool,
    store,
    resolveTarget(binding) {
      if (store.locked) return undefined;
      const host = store.getHosts().find((candidate) => candidate.id === binding.hostId);
      if (!host || store.getEffectiveHostDigest(host.id) !== binding.effectiveHostDigest) return undefined;
      return { host, effectiveDigest: binding.effectiveHostDigest, cacheFence: connectionFence(host.id) };
    },
    deliver(binding, completion) {
      const ctx = activeContext;
      if (!ctx || ctx.sessionManager.getSessionId() !== binding.piSessionRef) return;
      pi.sendMessage({
        customType: "ssh-gateway-complete",
        content: completion.content,
        display: true,
        details: {
          bindingId: binding.bindingId,
          deliveryId: completion.deliveryId,
          handle: binding.executionHandle,
          status: completion.status,
          hostId: binding.hostId,
        },
      }, {
        deliverAs: "followUp",
        triggerTurn: true,
      });
    },
  });

  let monitorResume: Promise<void> | undefined;
  const resumeActiveMonitoring = (): Promise<void> => {
    if (monitorResume) return monitorResume;
    const operation = (async () => {
      const ctx = activeContext;
      if (!ctx || store.locked) return;
      const piSessionRef = ctx.sessionManager?.getSessionId?.();
      if (!piSessionRef) return;
      completionRouter.setActiveSession(piSessionRef);
      const targets = store.getHosts().map((host) => ({
        host,
        effectiveDigest: store.getEffectiveHostDigest(host.id),
        cacheFence: connectionFence(host.id),
      }));
      await completionRouter.resumeActiveSession(targets);
    })();
    const tracked = operation.finally(() => {
      if (monitorResume === tracked) monitorResume = undefined;
    });
    monitorResume = tracked;
    return tracked;
  };
  const scheduleActiveMonitoring = (): void => {
    void resumeActiveMonitoring().catch(() => undefined);
  };
  const invalidateGatewayHost = async (hostId: string): Promise<void> => {
    sshBackground?.invalidateHost(hostId);
    await gatewayPool.invalidateHost(hostId);
    await gatewayBootstrap.invalidateHost(hostId);
  };
  const invalidateAllGatewayHosts = async (): Promise<void> => {
    sshBackground?.invalidateAll();
    await gatewayPool.close();
    await gatewayBootstrap.invalidateAll();
  };

  const setSelectionStatus = (ctx: ExtensionContext | undefined, hosts: readonly SshHost[]): void => {
    if (hosts.length === 0) {
      ctx?.ui.setStatus(SSH_STATUS_KEY, undefined);
      return;
    }
    if (hosts.length === 1) {
      const host = hosts[0]!;
      ctx?.ui.setStatus(SSH_STATUS_KEY, `SSH · ${host.label} · ${formatSshAddress(host.host, host.port)}`);
      return;
    }
    ctx?.ui.setStatus(SSH_STATUS_KEY, `SSH · ${hosts.length} attached · ${hosts.map((host) => host.label).join(", ")}`);
  };

  const selectedHostsForDisplay = (): SshHost[] => {
    if (store.locked) {
      const staleIds = [...selected.keys()];
      selected.clear();
      for (const id of staleIds) void invalidateGatewayHost(id).catch(() => undefined);
      setSelectionStatus(activeContext, []);
      return [];
    }
    const hosts = new Map(store.getHosts().map((host) => [host.id, host]));
    const valid: SshHost[] = [];
    const stale: string[] = [];
    for (const [id, digest] of selected) {
      const host = hosts.get(id);
      if (host && selectionFence(id) === digest) valid.push(host);
      else stale.push(id);
    }
    if (stale.length > 0) {
      for (const id of stale) {
        selected.delete(id);
        void invalidateGatewayHost(id).catch(() => undefined);
      }
      setSelectionStatus(activeContext, valid);
    }
    return valid;
  };

  const singleSelectedHostForDisplay = (): SshHost | undefined => {
    const hosts = selectedHostsForDisplay();
    return hosts.length === 1 ? hosts[0] : undefined;
  };

  const replaceSelection = (hosts: readonly SshHost[], ctx: ExtensionContext): void => {
    activeContext = ctx;
    const next = new Map(hosts.map((host) => [host.id, selectionFence(host.id)]));
    for (const [id, digest] of selected) {
      if (next.get(id) !== digest) void invalidateGatewayHost(id).catch(() => undefined);
    }
    selected.clear();
    for (const [id, digest] of next) selected.set(id, digest);
    setSelectionStatus(ctx, hosts);
  };

  const attachHost = (host: SshHost, ctx: ExtensionContext): void => {
    activeContext = ctx;
    const digest = selectionFence(host.id);
    if (selected.has(host.id) && selected.get(host.id) !== digest) {
      void invalidateGatewayHost(host.id).catch(() => undefined);
    }
    selected.set(host.id, digest);
    setSelectionStatus(ctx, selectedHostsForDisplay());
  };

  const removeSelectionIds = (
    hostIds: Iterable<string>,
    ctx: ExtensionContext | undefined = activeContext,
    invalidate = true,
  ): void => {
    for (const id of new Set(hostIds)) {
      if (!selected.delete(id)) continue;
      if (invalidate) void invalidateGatewayHost(id).catch(() => undefined);
    }
    setSelectionStatus(ctx, selectedHostsForDisplay());
  };

  const clearSelection = (ctx: ExtensionContext | undefined = activeContext): void => {
    const previousIds = [...selected.keys()];
    selected.clear();
    for (const id of previousIds) void invalidateGatewayHost(id).catch(() => undefined);
    ctx?.ui.setStatus(SSH_STATUS_KEY, undefined);
  };

  const currentSelectedHost = (): SshHost => {
    const hadSelection = selected.size > 0;
    const hosts = selectedHostsForDisplay();
    if (hosts.length === 0) {
      if (hadSelection) throw new Error("The selected SSH server changed. Use action=targets or send #ssh to select it again.");
      throw new Error("No SSH server is selected. Use action=targets with an unlocked manager and pass targetId, or send #ssh to choose a default.");
    }
    if (hosts.length > 1) {
      throw new Error("Multiple SSH servers are attached. Use action=targets and pass one targetId per SSH call.");
    }
    return hosts[0]!;
  };

  const resolveExecutionHost = (targetId?: string): SshHost => {
    if (targetId === undefined) return currentSelectedHost();
    if (!SSH_HOST_ID_PATTERN.test(targetId)) throw new Error("SSH target id is invalid");
    const host = store.getHosts().find((candidate) => candidate.id === targetId);
    if (!host) throw new Error(`SSH target ${JSON.stringify(targetId)} is unavailable`);
    return host;
  };

  const targetHostForDisplay = (targetId?: string): SshHost | undefined => {
    if (targetId === undefined) return singleSelectedHostForDisplay();
    if (store.locked || !SSH_HOST_ID_PATTERN.test(targetId)) return undefined;
    return store.getHosts().find((candidate) => candidate.id === targetId);
  };

  const refreshStore = async (): Promise<void> => {
    if (store.locked) throw new Error("SSH manager is locked. Send #ssh or open /ssh to unlock it.");
    await store.reload();
    await pinUntrustedHostsFromKnownHosts(store.getHosts(), (host, fingerprint) => store.updateHost(host.id, { ...host, hostKey: fingerprint }));
  };

  sshBackground = registerSshBg(pi, {
    executor,
    resolveTarget: async (targetId) => {
      await refreshStore();
      const host = resolveExecutionHost(targetId);
      return { host, fence: connectionFence(host.id) };
    },
  }, false);

  const prepareAttachmentSelection = async (ctx: ExtensionContext): Promise<boolean> => {
    const wasLocked = store.locked;
    if (!await ensureUnlocked(ctx, store)) return false;
    await refreshStore();
    if (wasLocked) monitor.reconcile();
    scheduleActiveMonitoring();
    return true;
  };

  const activateHost = async (hostId: string): Promise<void> => {
    const ctx = activeContext;
    if (!ctx) {
      throw new SshHostProviderError(
        "provider-unavailable",
        "SSH host activation requires an active host session.",
      );
    }
    if (!await ensureUnlocked(ctx, store)) {
      clearSelection(ctx);
      throw new SshHostProviderError(
        "manager-locked",
        "SSH manager remains locked because activation was cancelled.",
      );
    }
    let hosts: SshHost[];
    try {
      await refreshStore();
      monitor.reconcile();
      scheduleActiveMonitoring();
      hosts = store.getHosts();
    } catch {
      clearSelection(ctx);
      throw new SshHostProviderError(
        "refresh-failed",
        "SSH manager could not be refreshed. Open /ssh in the host session and verify the encrypted store.",
      );
    }
    const host = hosts.find((candidate) => candidate.id === hostId);
    if (!host) {
      throw new SshHostProviderError(
        "host-not-found",
        `SSH host reference ${JSON.stringify(hostId)} was not found in the unlocked manager.`,
      );
    }
    replaceSelection([host], ctx);
  };

  const providerRegistration = registerSshHostProvider(createSshManagerHostProvider(store, {
    selectedIds: () => selectedHostsForDisplay().map((host) => host.id),
    activate: activateHost,
    openTeammateRemoteChannel: (hostRef, signal) => remoteChannelBroker.open(hostRef, signal),
  }));

  const sshTool: ToolDefinition<typeof SshToolParams, SshToolDetails> = {
    name: "ssh",
    label: "SSH",
    renderShell: "self",
    description: `Execute a bounded command, manage background jobs, or use the built-in Pi Maestro Gateway on any configured SSH server after the user unlocks the manager.

Use action=targets to list provider-owned target ids, then pass targetId on a command or Gateway action. job_start backgrounds immediately and returns jobId/sessionId; job_run waits up to timeout then detaches; job_exec appends a command on the same SSH TCP session and backgrounds it immediately; job_status, job_wait, job_kill, job_list, and job_close provide job control. ensure_gateway may start a non-persistent Gateway whose lifetime is tied to the current local Pi session. Omitting targetId works only when exactly one #ssh server is attached and is an error when none or multiple are attached. The tool never accepts host or authentication parameters. Gateway actions and sync_pi_config use fixed remote commands that cannot be overridden. sync_pi_config accepts only fixed categories; the host resolves current-user Pi files internally and never exposes their paths or contents. start_pi snapshots only explicitly selected existing tasks from the current local Pi Todo and launches an independent remote Gateway session; it never synchronizes or completes either Todo authority. Server configuration stays in the encrypted user-level SSH manager. #ssh selection remains independent of teammate and remote-worker routing. Each resolved target decides whether ordinary commands run through bash or PowerShell.`,
    promptSnippet: "List targets, execute foreground commands, manage job_start/job_run/job_exec/job_status/job_wait/job_kill/job_list/job_close background SSH jobs, or use Gateway actions by targetId.",
    promptGuidelines: [
      "Use read-only inspection before mutations unless the user explicitly requested a change.",
      "Use action=guide for local Gateway setup instructions; it does not contact a server.",
      "Use action=targets after unlock and pass only a returned targetId; never invent target ids or connection parameters.",
      "Use action=ensure_gateway only when the remote Gateway is unavailable and a daemon tied to the current local Pi session is acceptable; it never replaces durable remote service setup.",
      "Use job_start for long-running commands, then pass its sessionId to job_exec or job_start to append commands on the same SSH TCP connection. job_exec always backgrounds immediately; use job_run only when foreground waiting is explicitly desired.",
      "Use job_wait once or wait for the ssh-bg-complete notification; use job_status only to inspect output and job_kill to stop a job.",
      "For action=call, first use action=describe with the targetId and Gateway tool name; pass the returned tool inputSchema exactly in args. Dynamic call args are intentionally generic at this outer tool boundary.",
      "For session.start-pi, use the returned taskId or monitorHandle as monitor.handle; do not rename it to taskId when calling monitor.",
      "Never read or print private keys, passwords, tokens, credential stores, or host-key material.",
      "Do not claim access while the SSH manager is locked or to a target not returned by action=targets.",
    ],
    parameters: SshToolParams,
    async execute(
      _id: string,
      params: SshToolInput,
      signal: AbortSignal,
    ) {
      let parsed: ParsedSshToolInput;
      try {
        parsed = parseSshToolInput(params);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
          details: { exitCode: null, signal: null, durationMs: 0, summary: "invalid arguments" },
        };
      }
      if (parsed.kind === "job") {
        if (!sshBackground) throw new Error("SSH background manager is unavailable");
        return sshBackground.execute(parsed.input, signal);
      }
      const requestedTargetId = parsedTargetId(parsed);
      const details = (
        result?: SshExecutionResult,
        host?: SshHost,
        gatewayResult?: SshGatewayActionResult,
      ): SshToolDetails => ({
        ...(host
          ? { hostId: host.id, target: sshToolTargetDetails(host) }
          : requestedTargetId === undefined && singleSelectedHostForDisplay()
            ? { hostId: singleSelectedHostForDisplay()!.id }
            : {}),
        ...(gatewayResult ? {
          action: gatewayResult.action,
          ...(gatewayResult.tool ? { tool: gatewayResult.tool } : {}),
          summary: gatewayResult.summary,
        } : {}),
        exitCode: result?.exitCode ?? null,
        signal: result?.signal ?? null,
        durationMs: result?.durationMs ?? gatewayResult?.durationMs ?? 0,
      });
      if (parsed.kind === "guide") {
        return {
          content: [{ type: "text" as const, text: sshGatewayGuide() }],
          details: {
            action: "guide",
            summary: "local gateway guide",
            exitCode: null,
            signal: null,
            durationMs: 0,
          },
        };
      }

      let executionHost: SshHost | undefined;
      try {
        await refreshStore();
        scheduleActiveMonitoring();
        if (parsed.kind === "targets") {
          const selectedIds = new Set(selectedHostsForDisplay().map((host) => host.id));
          const targets = store.getHosts().map((host) => ({
            targetId: host.id,
            label: host.label,
            shell: host.shell,
            selected: selectedIds.has(host.id),
          }));
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ targets }, null, 2) }],
            details: {
              action: "targets",
              summary: `${targets.length} configured target${targets.length === 1 ? "" : "s"}`,
              exitCode: null,
              signal: null,
              durationMs: 0,
            },
          };
        }
        if (!("action" in params) && !("command" in params)) {
          throw new Error("SSH call requires a command or an action. Use action=targets to list configured servers.");
        }
        executionHost = resolveExecutionHost(requestedTargetId);
        if (parsed.kind === "command") {
          const result = await executor.execute(executionHost, {
            command: parsed.command,
            ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
            ...(parsed.timeout !== undefined ? { timeout: parsed.timeout } : {}),
          }, { signal });
          const output = [
            result.stdout ? `stdout:\n${result.stdout}` : "",
            result.stderr ? `stderr:\n${result.stderr}` : "",
            `exit=${result.exitCode ?? "unknown"}${result.signal ? ` signal=${result.signal}` : ""}`,
          ].filter(Boolean).join("\n\n");
          return {
            content: [{ type: "text" as const, text: output }],
            ...(result.exitCode !== 0 ? { isError: true } : {}),
            details: details(result, executionHost),
          };
        }
        if (parsed.kind === "sync_pi_config") {
          const fence = connectionFence(executionHost.id);
          const syncResult = await syncPiConfig({
            categories: parsed.categories,
            source: configSource,
            transport: configSyncTransport(executionHost),
            signal,
            audit: options.configSyncAudit,
            assertFence: async () => {
              await refreshStore();
              if (connectionFence(executionHost!.id) !== fence) throw new Error("SSH target changed before configuration transfer");
            },
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(syncResult, null, 2) }],
            details: {
              ...details(undefined, executionHost),
              action: "sync_pi_config",
              summary: `${syncResult.receipts.length} configuration categor${syncResult.receipts.length === 1 ? "y" : "ies"} synchronized`,
            },
          };
        }
        if (parsed.kind === "ensure_gateway") {
          const effectiveDigest = store.getEffectiveHostDigest(executionHost.id);
          const cacheFence = connectionFence(executionHost.id);
          const bootstrap = await gatewayBootstrap.ensure(
            executionHost,
            effectiveDigest,
            cacheFence,
            async (probeSignal) => {
              try {
                await gatewayPool.execute(
                  executionHost!,
                  effectiveDigest,
                  { action: "status" },
                  probeSignal,
                  undefined,
                  cacheFence,
                );
                return true;
              } catch (error) {
                if (error instanceof SshGatewayCapabilityError) return false;
                throw error;
              }
            },
            { timeoutSeconds: parsed.timeout, signal },
          );
          const summary = bootstrap.started
            ? "gateway started · local-session"
            : "gateway already running";
          return {
            content: [{ type: "text" as const, text: JSON.stringify(bootstrap, null, 2) }],
            details: {
              ...details(undefined, executionHost),
              action: "ensure_gateway",
              summary,
            },
          };
        }
        const startPiContext = parsed.kind === "start_pi"
          ? {
              piSessionRef: activeContext?.sessionManager.getSessionId?.() ?? "",
              todos: getVisibleTasks(),
            }
          : undefined;
        if (parsed.kind === "start_pi" && !startPiContext?.piSessionRef) {
          throw new Error("start_pi requires an active local Pi session");
        }
        const gatewayResult = await gatewayPool.execute(
          executionHost,
          store.getEffectiveHostDigest(executionHost.id),
          sshGatewayExecuteInput(parsed),
          signal,
          startPiContext,
          connectionFence(executionHost.id),
        );
        return {
          content: [{ type: "text" as const, text: gatewayResult.text }],
          ...(gatewayResult.isError ? { isError: true } : {}),
          details: details(undefined, executionHost, gatewayResult),
        };
      } catch (error) {
        if (store.locked) clearSelection();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
          details: {
            ...details(undefined, executionHost),
            ...sshToolFailureDetails(parsed),
          },
        };
      }
    },
    renderCall(args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      const targetId = "targetId" in args && typeof args.targetId === "string" ? args.targetId : undefined;
      const target = targetHostForDisplay(targetId);
      return toolCallLine(theme, "ssh", formatSshToolArgument(args, target ? sshToolTargetDetails(target) : undefined));
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text("", 0, 0);
      const details = result.details as SshToolDetails | undefined;
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      const isError = context.isError === true
        || (result as { isError?: boolean }).isError === true
        || (typeof details?.exitCode === "number" && details.exitCode !== 0);
      const fallbackHost = singleSelectedHostForDisplay();
      return toolResultLine(theme, {
        name: "ssh",
        ok: !isError,
        arg: formatSshToolArgument(
          context.args,
          details?.target ?? (fallbackHost ? sshToolTargetDetails(fallbackHost) : undefined),
        ),
        summary: formatSshResultSummary(details, isError),
        expanded: options.expanded,
        detail: text,
      });
    },
  };

  pi.registerTool(sshTool);

  pi.registerCommand("ssh", {
    description: "Open the independent encrypted SSH server manager TUI.",
    async handler(args, ctx) {
      activeContext = ctx;
      const { positionals, fields } = extractHeadlessArgs(splitCommandArgs(args));
      const sub = positionals[0]?.toLowerCase() ?? "";
      if (sub && sub !== "open") {
        const bindings: ManagerBindings = {
          selectedIds: () => selectedHostsForDisplay().map((host) => host.id),
          replace: (host) => replaceSelection([host], ctx),
          toggle: (host) => selected.has(host.id)
            ? removeSelectionIds([host.id], ctx)
            : attachHost(host, ctx),
          remove: (hostIds) => removeSelectionIds(hostIds, ctx, false),
          clear: () => clearSelection(ctx),
          invalidate: invalidateGatewayHost,
          invalidateAll: invalidateAllGatewayHosts,
        };
        await runSshHeadless(ctx, store, executor, monitor, bindings, sub, positionals.slice(1), fields);
        return;
      }
      if (args.trim()) {
        ctx.ui.notify(SSH_HEADLESS_USAGE, "warning");
        return;
      }
      if (!supportsCustomOverlay(ctx)) {
        ctx.ui.notify(`SSH manager 面板需要 TUI overlay。${SSH_HEADLESS_USAGE}`, "warning");
        return;
      }
      await runManager(ctx, store, executor, monitor, discoverOpenSsh, {
        selectedIds: () => selectedHostsForDisplay().map((host) => host.id),
        replace: (host) => replaceSelection([host], ctx),
        toggle: (host) => selected.has(host.id)
          ? removeSelectionIds([host.id], ctx)
          : attachHost(host, ctx),
        remove: (hostIds) => removeSelectionIds(hostIds, ctx, false),
        clear: () => clearSelection(ctx),
        invalidate: invalidateGatewayHost,
        invalidateAll: invalidateAllGatewayHosts,
      });
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return;
    const input = event.text.trim();
    const isPicker = input.toLowerCase() === "#ssh";
    const canonicalMatch = /^#ssh:([+-]?)([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/iu.exec(input);
    if (!isPicker && !canonicalMatch) return;
    if ((event.images?.length ?? 0) > 0) {
      ctx.ui.notify("SSH selection controls do not accept images. Remove the image and try again.", "warning");
      return { action: "handled" as const };
    }
    activeContext = ctx;

    if (canonicalMatch) {
      const operation = canonicalMatch[1]!;
      const hostId = canonicalMatch[2]!;
      try {
        if (operation === "-") {
          if (!await prepareAttachmentSelection(ctx)) return { action: "handled" as const };
          const wasAttached = selected.has(hostId);
          removeSelectionIds([hostId], ctx);
          ctx.ui.notify(wasAttached ? `SSH server detached: ${hostId}.` : `SSH server was not attached: ${hostId}.`, "info");
        } else if (operation === "+") {
          if (!await prepareAttachmentSelection(ctx)) return { action: "handled" as const };
          const host = store.getHosts().find((candidate) => candidate.id === hostId);
          if (!host) throw new Error(`SSH target ${JSON.stringify(hostId)} is unavailable`);
          attachHost(host, ctx);
          ctx.ui.notify(`SSH server attached: ${host.label}.`, "info");
        } else {
          await activateHost(hostId);
          const host = currentSelectedHost();
          ctx.ui.notify(`SSH server selected exclusively: ${host.label}.`, "info");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
      return { action: "handled" as const };
    }

    if (!await ensureUnlocked(ctx, store)) return { action: "handled" as const };
    try {
      await refreshStore();
    } catch (error) {
      clearSelection(ctx);
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      return { action: "handled" as const };
    }
    monitor.reconcile();
    const hosts = store.getHosts();
    if (hosts.length === 0) {
      ctx.ui.notify("No SSH servers configured. Open /ssh and press A to add one.", "warning");
      return { action: "handled" as const };
    }
    const hostIds = await showHostPickerOverlay(ctx, hosts, selectedHostsForDisplay().map((host) => host.id));
    if (hostIds !== undefined) {
      const byId = new Map(hosts.map((host) => [host.id, host]));
      const picked = hostIds.map((id) => byId.get(id)).filter((host): host is SshHost => host !== undefined);
      replaceSelection(picked, ctx);
      ctx.ui.notify(picked.length === 0
        ? "All SSH servers detached."
        : `${picked.length} SSH server${picked.length === 1 ? "" : "s"} attached: ${picked.map((host) => host.label).join(", ")}.`, "info");
    }
    return { action: "handled" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    activeContext = ctx;
    if (store.locked) {
      clearSelection(ctx);
      return undefined;
    }
    try {
      await store.reload();
      scheduleActiveMonitoring();
      const attachedHosts = selectedHostsForDisplay();
      const safeAttachments = JSON.stringify(attachedHosts.map((host) => ({
        id: host.id,
        label: host.label,
        shell: host.shell,
      }))).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e").replace(/&/gu, "\\u0026");
      const omissionRule = attachedHosts.length === 1
        ? "Exactly one SSH server is attached, so omitting targetId resolves to that attachment."
        : attachedHosts.length > 1
          ? "Multiple SSH servers are attached, so every SSH call must pass one explicit targetId; omission is an error."
          : "No SSH server is attached, so omitting targetId is an error.";
      const systemPrompt = `${event.systemPrompt}\n\n<ssh-management-context>\nThe independent encrypted SSH manager is unlocked. Gateway endpoint and credentials remain internal and are never included in this prompt. The agent may access any configured server through the ssh tool by first calling action=targets and then passing a provider-owned targetId. Use ssh job_start for long-running remote commands: it returns a jobId and sessionId; job_exec or job_start with that sessionId appends commands on the same SSH TCP connection and backgrounds them. Use job_run only when foreground waiting is explicitly desired. Attached SSH metadata (id, label, and shell only): ${safeAttachments}. ${omissionRule} targetId never contains host or authentication data. ensure_gateway can start a non-persistent remote Gateway tied to this local Pi session and accepts only targetId plus an optional timeout. sync_pi_config accepts only targetId and fixed categories (models, auth, teammate); local paths and contents are resolved and transferred by the host outside model-visible arguments and results. start_pi accepts only local todoIds, an optional objective/agent/timeout, targetId, and requestId; the host reads and sanitizes current local Pi Todo tasks and session identity. Gateway actions always use fixed remote commands and never accept host, authentication, command, remote cwd, sessionId, snapshot, or callback overrides. #ssh attachments do not select or configure teammate routing. Remote Monitor calls use the returned launch receipt and never update local Pi Todo. Never use remote-worker or expose credentials.\n</ssh-management-context>`;
      return { systemPrompt };
    } catch {
      clearSelection(ctx);
      return undefined;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    sshBackground?.initialize();
    completionRouter.setActiveSession(ctx.sessionManager?.getSessionId?.());
    clearSelection(ctx);
    if (!store.locked) scheduleActiveMonitoring();
  });
  pi.on("session_shutdown", async () => {
    selected.clear();
    activeContext?.ui.setStatus(SSH_STATUS_KEY, undefined);
    providerRegistration.dispose();
    remoteChannelBroker.close();
    monitor.shutdown();
    await sshBackground?.close();
    await completionRouter.dispose().catch(() => undefined);
    store.lock();
    await gatewayPool.close();
    await gatewayBootstrap.close();
    activeContext = undefined;
  });
}

interface SshManagerHostProviderOptions {
  /** Backward-compatible scalar selection source for external provider callers. */
  selectedId?: () => string | undefined;
  selectedIds?: () => readonly string[];
  activate?: (hostId: string) => Promise<void>;
  openTeammateRemoteChannel?: NonNullable<SshHostProvider["openTeammateRemoteChannel"]>;
}

/** Build the non-secret runtime provider backed by one unlocked SSH manager. */
export function createSshManagerHostProvider(
  store: EncryptedSshStore,
  options: SshManagerHostProviderOptions = {},
): SshHostProvider {
  const refreshedHosts = async (): Promise<SshHost[]> => {
    if (store.locked) {
      throw new SshHostProviderError(
        "manager-locked",
        "SSH manager is locked. Open /ssh in the host session to unlock it.",
      );
    }
    try {
      await store.reload();
      return store.getHosts();
    } catch {
      throw new SshHostProviderError(
        "refresh-failed",
        "SSH manager could not be refreshed. Open /ssh in the host session and verify the encrypted store.",
      );
    }
  };

  return {
    async list(): Promise<readonly SshHostReferenceSummary[]> {
      return (await refreshedHosts()).map(summarizeSshHost);
    },
    async listPickerEntries() {
      const hosts = await refreshedHosts();
      const scalarSelectedId = options.selectedId?.();
      const selectedIds = new Set(options.selectedIds?.() ?? (scalarSelectedId ? [scalarSelectedId] : []));
      return hosts.map((host) => ({
        id: host.id,
        label: host.label,
        host: host.host,
        user: host.user,
        port: host.port,
        shell: host.shell,
        selected: selectedIds.has(host.id),
      }));
    },
    ...(options.activate ? { activate: options.activate } : {}),
    ...(options.openTeammateRemoteChannel
      ? { openTeammateRemoteChannel: options.openTeammateRemoteChannel }
      : {}),
    async resolve(hostRef: string): Promise<SshHostProfile> {
      const host = (await refreshedHosts()).find((candidate) => candidate.id === hostRef);
      if (!host) {
        throw new SshHostProviderError(
          "host-not-found",
          `SSH host reference ${JSON.stringify(hostRef)} was not found in the unlocked manager.`,
        );
      }
      return sshHostProfile(host);
    },
  };
}

function summarizeSshHost(host: SshHost): SshHostReferenceSummary {
  const issue = sshHostReferenceIssue(host);
  return issue
    ? { id: host.id, label: host.label, compatible: false, issue }
    : { id: host.id, label: host.label, compatible: true };
}

function sshHostProfile(host: SshHost): SshHostProfile {
  const issue = sshHostReferenceIssue(host);
  if (issue) {
    throw new SshHostProviderError(
      "host-incompatible",
      `SSH host reference ${JSON.stringify(host.id)} is incompatible with teammate SSH consumers: ${issue}.`,
    );
  }
  if (host.hostKey === null) throw new SshHostProviderError("host-incompatible", "SSH host has not been trusted by an explicit Test.");
  let authentication: SshHostProfile["authentication"];
  if (host.auth.kind === "agent") authentication = { kind: "agent" };
  else if (host.auth.kind === "identity") authentication = { kind: "identity", identityFile: host.auth.path };
  else {
    throw new SshHostProviderError("host-incompatible", "SSH host uses unsupported password authentication.");
  }
  return {
    id: host.id,
    label: host.label,
    host: host.host,
    user: host.user,
    port: host.port,
    shell: "bash",
    hostKeySha256: host.hostKey,
    authentication,
  };
}

interface ManagerBindings {
  selectedIds: () => readonly string[];
  replace: (host: SshHost) => void;
  toggle: (host: SshHost) => void;
  remove: (hostIds: readonly string[]) => void;
  clear: () => void;
  invalidate: (hostId: string) => Promise<void>;
  invalidateAll: () => Promise<void>;
}

async function runManager(
  ctx: ExtensionContext,
  store: EncryptedSshStore,
  executor: SshExecutor,
  monitor: SshStatusMonitor,
  discoverOpenSsh: (options?: DiscoverOpenSshOptions) => Promise<OpenSshDiscoveryResult>,
  bindings: ManagerBindings,
): Promise<void> {
  if (!await ensureUnlocked(ctx, store)) return;
  monitor.reconcile();
  let query = "";
  let view: SshManagerView = "hosts";
  let focusedHostId: string | undefined;
  let notice: string | undefined;
  while (!store.locked) {
    const action = await showManagerOverlay(ctx, store.getHosts(), store.getKeys(), monitor.getStatuses(), bindings.selectedIds(), focusedHostId, query, view, notice);
    query = action.query;
    view = action.view ?? view;
    focusedHostId = action.hostId ?? focusedHostId;
    notice = undefined;
    if (action.kind === "close") return;
    if (action.kind === "lock") {
      bindings.clear(); monitor.lock(); store.lock();
      try {
        await bindings.invalidateAll();
      } finally {
        ctx.ui.notify(sshUi("SSH manager locked and the in-memory key was cleared.", "SSH 管理器已锁定，内存中的密钥已清除。"), "info");
      }
      return;
    }
    try {
      if (action.kind === "add-key") {
        const key = await importManagedKeyWizard(ctx);
        if (key) { await store.addKey(key); monitor.reconcile(); notice = sshUi(`Imported key ${key.label}`, `已导入密钥 ${key.label}`); }
        continue;
      }
      if (action.kind === "edit-key" || action.kind === "replace-key" || action.kind === "delete-key") {
        const key = store.getKeys().find((candidate) => candidate.id === action.keyId);
        if (!key) { notice = sshUi("Selected SSH key is no longer available", "选中的 SSH 密钥已不可用"); continue; }
        const affected = dependencyClosureForKey(store.getHosts(), key.id);
        if (action.kind === "edit-key") {
          const label = await ctx.ui.input(sshUi("Managed key label", "托管密钥名称"), key.label);
          if (label !== undefined) await store.updateKey(key.id, { ...key, label: label.trim() });
          else continue;
        } else if (action.kind === "replace-key") {
          const replacement = await importManagedKeyWizard(ctx, key);
          if (!replacement) continue;
          await store.updateKey(key.id, replacement);
        } else {
          if (!await ctx.ui.confirm(sshUi(`Delete ${key.label}?`, `删除 ${key.label}？`), sshUi("Referenced keys cannot be deleted.", "被服务器引用的密钥不能删除。"))) continue;
          await store.deleteKey(key.id);
        }
        await invalidateHostIds(affected, bindings); monitor.reconcile(); notice = action.kind === "delete-key" ? sshUi(`Deleted key ${key.label}`, `已删除密钥 ${key.label}`) : sshUi(`Updated key ${key.label}`, `已更新密钥 ${key.label}`);
        continue;
      }
      if (action.kind === "import") {
        notice = await importOpenSshWizard(ctx, store, discoverOpenSsh);
        monitor.reconcile();
        continue;
      }
      if (action.kind === "add") {
        const host = await editHostWizard(ctx, store.getHosts(), store.getKeys());
        if (host) { await store.addHost(host); monitor.reconcile(); notice = sshUi(`Added ${host.label}`, `已添加 ${host.label}`); }
        continue;
      }
      const host = store.getHosts().find((candidate) => candidate.id === action.hostId);
      if (!host) { notice = sshUi("Selected SSH server is no longer available", "选中的 SSH 服务器已不可用"); continue; }
      if (action.kind === "toggle-select") {
        bindings.toggle(host);
        notice = bindings.selectedIds().includes(host.id) ? sshUi(`Attached ${host.label}`, `已附加 ${host.label}`) : sshUi(`Detached ${host.label}`, `已取消附加 ${host.label}`);
        continue;
      }
      if (action.kind === "select") { bindings.replace(host); ctx.ui.notify(sshUi(`SSH server selected exclusively: ${host.label}.`, `已单独选中 SSH 服务器：${host.label}。`), "info"); return; }
      if (action.kind === "edit") {
        const before = store.getReverseDependencyClosure(host.id);
        const replacement = await editHostWizard(ctx, store.getHosts(), store.getKeys(), host);
        if (!replacement) continue;
        const affected = new Set([...before, ...store.getReverseDependencyClosure(host.id)]);
        await invalidateHostIds(affected, bindings);
        await unpairGatewayHostIds(affected, store, executor);
        await store.updateHost(host.id, replacement);
        monitor.reconcile(); notice = sshUi(`Updated ${replacement.label}; affected selections and sessions were cleared`, `已更新 ${replacement.label}；受影响的选择和会话已清除`);
        continue;
      }
      if (action.kind === "delete") {
        if (!await ctx.ui.confirm(sshUi(`Delete ${host.label}?`, `删除 ${host.label}？`), sshUi("Referenced jump hosts cannot be deleted.", "被引用的跳板主机不能删除。"))) continue;
        const affected = store.getReverseDependencyClosure(host.id);
        await invalidateHostIds(affected, bindings);
        await unpairGatewayHostIds(affected, store, executor);
        await store.deleteHost(host.id);
        monitor.reconcile(); notice = sshUi(`Deleted ${host.label}`, `已删除 ${host.label}`);
        continue;
      }
      if (action.kind === "reset") {
        if (!await ctx.ui.confirm(sshUi(`Reset trust for ${host.label}?`, `重置 ${host.label} 的信任？`), sshUi("The saved host identity will be removed and monitoring disabled.", "已保存的主机身份将被删除，同时关闭监控。"))) continue;
        if (!await ctx.ui.confirm(sshUi("Confirm trust reset", "确认重置信任"), sshUi("A future Test will establish trust again.", "稍后可通过测试连接重新建立信任。"))) continue;
        const affected = store.getReverseDependencyClosure(host.id);
        await invalidateHostIds(affected, bindings);
        await unpairGatewayHostIds(affected, store, executor);
        await store.updateHost(host.id, { ...host, hostKey: null, monitorEnabled: false });
        monitor.reconcile(); notice = sshUi(`Trust reset for ${host.label}`, `已重置 ${host.label} 的信任`);
        continue;
      }
      if (action.kind === "test") {
        notice = await testAndTrustSshHost(ctx, store, executor, host);
        await invalidateHostIds(store.getReverseDependencyClosure(host.id), bindings);
        monitor.reconcile();
      }
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }
  }
}

async function ensureUnlocked(ctx: ExtensionContext, store: EncryptedSshStore, passwordOverride?: string): Promise<boolean> {
  if (!store.locked) return true;
  const exists = await pathExists(store.path);
  if (!exists) {
    if (passwordOverride !== undefined) {
      if (passwordOverride.length < 8) {
        ctx.ui.notify(sshUi("Master password must contain at least 8 characters.", "主密码至少需要 8 个字符。"), "warning");
        return false;
      }
      try {
        await store.create(passwordOverride);
        return true;
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return false;
      }
    }
    while (true) {
      const password = await showSecretInput(ctx, sshUi("Create SSH manager", "创建 SSH 管理器"), sshUi("New master password (minimum 8 characters)", "新主密码（至少 8 个字符）"));
      if (password === undefined) return false;
      if (password.length < 8) {
        ctx.ui.notify(sshUi("Master password must contain at least 8 characters. Try again or press Esc to cancel.", "主密码至少需要 8 个字符。请重试或按 Esc 取消。"), "warning");
        continue;
      }
      const confirmation = await showSecretInput(ctx, sshUi("Create SSH manager", "创建 SSH 管理器"), sshUi("Confirm master password", "确认主密码"));
      if (confirmation === undefined) return false;
      if (password !== confirmation) {
        ctx.ui.notify(sshUi("Master passwords do not match. Try again or press Esc to cancel.", "两次主密码不一致。请重试或按 Esc 取消。"), "warning");
        continue;
      }
      try {
        await store.create(password);
        return true;
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return false;
      }
    }
  }
  const password = passwordOverride ?? await showSecretInput(ctx, sshUi("Unlock SSH manager", "解锁 SSH 管理器"), sshUi("Master password", "主密码"));
  if (password === undefined) return false;
  try {
    await store.unlock(password);
    return true;
  } catch {
    ctx.ui.notify(sshUi("Unable to unlock SSH manager. Check the master password and encrypted file.", "无法解锁 SSH 管理器，请检查主密码和加密文件。"), "error");
    return false;
  }
}

export type IdentityPassphraseEditAction = "keep" | "replace" | "remove";

export interface SshAuthenticationChoice {
  kind: SshAuth["kind"];
  label: string;
  available: boolean;
}

/** Order authentication choices for the current runtime and explain what each one uses. */
export function sshAuthenticationChoices(
  current: SshAuth["kind"] | undefined,
  agentSocket = process.env.SSH_AUTH_SOCK,
  managedKeys: readonly SshKey[] = [],
): SshAuthenticationChoice[] {
  const agentAvailable = Boolean(agentSocket);
  const defaults: SshAuth["kind"][] = [
    ...(managedKeys.length > 0 ? ["key" as const] : []),
    ...(agentAvailable ? ["agent" as const] : []),
    "identity",
    "password",
  ];
  const order = current === undefined
    ? defaults
    : [current, ...defaults.filter((kind) => kind !== current)];
  return order.map((kind) => {
    if (kind === "agent") {
      return {
        kind,
        label: agentAvailable
          ? "Loaded key via SSH_AUTH_SOCK — advanced (managed by ssh-agent/ssh-add)"
          : "Loaded key via SSH_AUTH_SOCK — currently unavailable",
        available: agentAvailable,
      };
    }
    if (kind === "key") return { kind, label: "Managed encrypted key — stored in this SSH manager", available: managedKeys.length > 0 };
    if (kind === "identity") return { kind, label: "Local private key file — explicit reference only; recommended when ssh user@host already works", available: true };
    return { kind, label: "Server password — store it in the encrypted SSH manager", available: true };
  });
}

/** Find a conventional regular private-key file without reading its contents. */
export async function findDefaultSshIdentityPath(homeDirectory = homedir()): Promise<string | undefined> {
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const candidate = join(homeDirectory, ".ssh", name);
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Discover private-key files by their header, without exposing key contents to the picker. */
export async function listSshPrivateKeyPaths(homeDirectory = homedir()): Promise<string[]> {
  const directory = join(homeDirectory, ".ssh");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
  } catch { return []; }
  let names: string[];
  try { names = (await readdir(directory)).sort().slice(0, 256); } catch { return []; }
  const paths: string[] = [];
  for (const name of names) {
    if (name.endsWith(".pub")) continue;
    const path = join(directory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > SSH_MAX_PRIVATE_KEY_BYTES) continue;
      handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      const after = await handle.stat();
      if (!after.isFile() || after.size !== before.size) continue;
      const header = Buffer.alloc(64);
      try {
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (/^-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----\r?\n/u.test(header.toString("ascii", 0, bytesRead))) paths.push(path);
      } finally { header.fill(0); }
    } catch { /* Ignore inaccessible candidates; manual paths remain available. */ }
    finally { await handle?.close(); }
    if (paths.length >= 64) break;
  }
  return paths;
}

export async function chooseSshPrivateKeyPath(ctx: ExtensionContext, prompt: string, suggestedPath?: string, homeDirectory = homedir()): Promise<string | undefined> {
  const candidates = await listSshPrivateKeyPaths(homeDirectory);
  if (candidates.length > 0) {
    const manual = sshUi("Enter private key path manually…", "手动输入私钥路径…");
    const options = [...new Set([...(suggestedPath ? [suggestedPath] : []), ...candidates]), manual];
    const selected = await ctx.ui.select(sshUi("Select local private key file", "选择本地私钥文件"), options);
    if (selected === undefined || selected !== manual) return selected;
  }
  return ctx.ui.input(prompt, suggestedPath ?? "");
}

/** Apply the explicit identity-passphrase edit selected by the operator. */
export function identityPassphraseAfterEdit(
  current: string | undefined,
  action: IdentityPassphraseEditAction,
  replacement?: string,
): string | undefined {
  if (action === "keep") return current;
  if (action === "remove") return undefined;
  if (!replacement) throw new Error("Replacement identity passphrase cannot be empty");
  return replacement;
}

/** Extract one unambiguous pinned fingerprint from direct or ssh-keygen output. */
export function normalizeSshHostKeyFingerprint(value: string): string {
  const trimmed = value.trim();
  if (SSH_HOST_KEY_PATTERN.test(trimmed)) return trimmed;
  const candidates = [...new Set(trimmed.split(/\s+/u).filter((part) => SSH_HOST_KEY_PATTERN.test(part)))];
  return candidates.length === 1 ? candidates[0]! : trimmed;
}

async function editHostWizard(
  ctx: ExtensionContext,
  hosts: readonly SshHost[],
  keys: readonly SshKey[],
  current?: SshHost,
): Promise<SshHost | undefined> {
  return editSshHostForm(ctx, {
    current, hosts, keys, identityPaths: await listSshPrivateKeyPaths(),
    suggestedPath: current?.auth.kind === "identity" ? current.auth.path : await findDefaultSshIdentityPath(),
    agentAvailable: Boolean(process.env.SSH_AUTH_SOCK),
    normalizePin: normalizeSshHostKeyFingerprint,
    locale: getTuiLocale(),
  });
}

async function unpairGatewayHostIds(ids: Iterable<string>, store: EncryptedSshStore, executor: SshExecutor): Promise<void> {
  for (const id of new Set(ids)) if (store.getGatewayBinding(id)) await unpairSshGateway(store, executor, id);
}

async function invalidateHostIds(ids: Iterable<string>, bindings: ManagerBindings): Promise<void> {
  const unique = [...new Set(ids)];
  await Promise.all(unique.map((id) => bindings.invalidate(id)));
  bindings.remove(unique);
}

function dependencyClosureForKey(hosts: readonly SshHost[], keyId: string): string[] {
  const affected = new Set<string>();
  for (const host of hosts) {
    if (host.auth.kind !== "key" || host.auth.keyId !== keyId) continue;
    for (const id of reverseSshHostDependencyClosure(hosts, host.id)) affected.add(id);
  }
  return [...affected];
}

/** Test remains the explicit TOFU confirm path. Unique known_hosts matches pin without Test. */
export async function testAndTrustSshHost(ctx: ExtensionContext, store: EncryptedSshStore, executor: SshExecutor, snapshot: SshHost): Promise<string> {
  const revision = store.revision;
  const digest = store.getEffectiveHostDigest(snapshot.id);
  const result = await executor.testConnection(snapshot.id);
  if (result.effectiveDigest !== undefined && result.effectiveDigest !== digest) throw new Error("SSH configuration changed during connection test");
  await store.reload();
  let current = store.getHosts().find((host) => host.id === snapshot.id);
  if (!current || !sameHostExceptPin(current, snapshot)) throw new Error("SSH host changed during connection test; trust was not saved");
  if (current.hostKey === result.fingerprint && snapshot.hostKey === null) return sshUi(`Connection succeeded: ${current.label} (trust was saved concurrently)`, `连接成功：${current.label}（信任已同时保存）`);
  if (store.revision !== revision) throw new Error("SSH manager changed during connection test; trust was not saved");
  if (store.getEffectiveHostDigest(snapshot.id) !== digest) throw new Error("SSH configuration changed during connection test");
  if (snapshot.hostKey !== null) return sshUi(`Connection succeeded: ${snapshot.label}`, `连接成功：${snapshot.label}`);
  if (!await ctx.ui.confirm(sshUi(`Trust ${snapshot.label}?`, `信任 ${snapshot.label}？`), sshUi("Save the identity observed by this Test?", "保存本次测试识别到的主机身份？"))) return sshUi(`Connection succeeded without saving trust: ${snapshot.label}`, `连接成功，但未保存信任：${snapshot.label}`);

  await store.reload();
  current = store.getHosts().find((host) => host.id === snapshot.id);
  if (!current || !sameHostExceptPin(current, snapshot)) throw new Error("SSH host changed while trust confirmation was open; trust was not saved");
  if (current.hostKey === result.fingerprint) return sshUi(`Connection succeeded: ${current.label} (trust was saved concurrently)`, `连接成功：${current.label}（信任已同时保存）`);
  if (current.hostKey !== null) throw new Error("SSH host trust changed while confirmation was open; trust was not saved");
  if (store.revision !== revision) throw new Error("SSH manager changed while trust confirmation was open; trust was not saved");
  if (store.getEffectiveHostDigest(snapshot.id) !== digest) throw new Error("SSH configuration changed while trust confirmation was open; trust was not saved");
  try {
    await store.updateHost(snapshot.id, { ...current, hostKey: result.fingerprint });
  } catch (error) {
    await store.reload().catch(() => undefined);
    const raced = store.locked ? undefined : store.getHosts().find((host) => host.id === snapshot.id);
    if (raced && raced.hostKey === result.fingerprint && sameHostExceptPin(raced, snapshot)) return sshUi(`Connection succeeded: ${snapshot.label} (trust was saved concurrently)`, `连接成功：${snapshot.label}（信任已同时保存）`);
    throw error;
  }
  return sshUi(`Connection succeeded and trust saved: ${snapshot.label}`, `连接成功且已保存信任：${snapshot.label}`);
}

function sameHostExceptPin(left: SshHost, right: SshHost): boolean {
  return JSON.stringify({ ...left, hostKey: null }) === JSON.stringify({ ...right, hostKey: null });
}

async function importManagedKeyWizard(ctx: ExtensionContext, current?: SshKey): Promise<SshKey | undefined> {
  const choice = await editSshKeyForm(ctx, await listSshPrivateKeyPaths(), current);
  if (!choice) return undefined;
  return importManagedSshKey(choice.path, choice.label, choice.passphrase, current);
}

/** Read one explicitly named regular key file, derive only its public fingerprint, and scrub the read buffer. */
export async function importManagedSshKey(path: string, label: string, passphrase?: string, current?: SshKey): Promise<SshKey> {
  const resolvedPath = path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
  const info = await lstat(resolvedPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > SSH_MAX_PRIVATE_KEY_BYTES) throw new Error("Private key must be a bounded regular non-symlink file");
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await open(resolvedPath, flags);
  let bytes: Buffer | undefined;
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.size !== info.size) throw new Error("Private key changed during import");
    bytes = Buffer.alloc(Number(after.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("Private key changed during import");
      offset += read.bytesRead;
    }
    const fingerprint = await fingerprintPrivateKey(resolvedPath);
    return validateSshKey({
      id: current?.id ?? createSshKeyId(), label, privateKey: bytes.toString("utf8"), ...(passphrase ? { passphrase } : {}),
      publicKeyFingerprint: fingerprint, createdAt: current?.createdAt ?? new Date().toISOString(),
    });
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

async function fingerprintPrivateKey(path: string): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => execFile("ssh-keygen", ["-lf", path, "-E", "sha256"], { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, output) => error ? reject(new Error("ssh-keygen could not read the private key")) : resolve(output)));
  const fingerprint = normalizeSshHostKeyFingerprint(stdout);
  if (!SSH_HOST_KEY_PATTERN.test(fingerprint)) throw new Error("ssh-keygen returned no unambiguous SHA256 fingerprint");
  return fingerprint;
}

async function importOpenSshWizard(ctx: ExtensionContext, store: EncryptedSshStore, discover: (options?: DiscoverOpenSshOptions) => Promise<OpenSshDiscoveryResult>): Promise<string> {
  const preview = await discover();
  if (!preview.configFound) {
    const keyNotice = await hasPrivateKeyFiles(dirname(preview.configPath)) ? sshUi("; private-key files exist, but no hosts were guessed from their names", "；发现私钥文件，但不会根据文件名猜测服务器") : "";
    return `${sshUi("No OpenSSH host config was found", "未找到 OpenSSH 主机配置")}${keyNotice}`;
  }
  if (preview.candidates.length === 0) return `${sshUi("OpenSSH config contains no explicit importable Host aliases", "OpenSSH 配置中没有可导入的明确 Host 别名")}${preview.warnings.length ? sshUi(` (${preview.warnings.length} warnings)`, `（${preview.warnings.length} 条警告）`) : ""}`;
  const accepted: OpenSshImportCandidate[] = [];
  for (const candidate of preview.candidates) {
    const summary = `${candidate.user ?? sshUi("user required", "需填写用户名")}@${formatSshAddress(candidate.hostName, candidate.port)} · ${sshUi(`${candidate.identities.length} identity reference(s)`, `${candidate.identities.length} 个私钥引用`)} · ${sshUi(`${candidate.warnings.length} warning(s)`, `${candidate.warnings.length} 条警告`)}`;
    if (await ctx.ui.confirm(sshUi(`Import OpenSSH host ${candidate.alias}?`, `导入 OpenSSH 主机 ${candidate.alias}？`), summary)) accepted.push(candidate);
  }
  if (accepted.length === 0) return sshUi("OpenSSH import cancelled", "已取消 OpenSSH 导入");
  if (!await ctx.ui.confirm(sshUi(`Import ${accepted.length} OpenSSH host(s)?`, `导入 ${accepted.length} 个 OpenSSH 主机？`), sshUi("Unique known_hosts identities are pinned automatically; remaining hosts stay untrusted with monitoring off.", "可唯一匹配 known_hosts 的主机身份会自动固定；其他主机保持未信任且关闭监控。"))) return sshUi("OpenSSH import cancelled", "已取消 OpenSSH 导入");
  const existing = store.getHosts();
  const existingKeys = store.getKeys();
  const importedKeys: SshKey[] = [];
  const ids = new Map(accepted.map((candidate) => [candidate.alias, createSshHostId()]));
  const existingAliases = new Map(existing.map((host) => [host.label, host.id]));
  const additions: SshHost[] = [];
  for (const candidate of accepted) {
    const user = candidate.user ?? await ctx.ui.input(sshUi(`SSH username for ${candidate.alias}`, `${candidate.alias} 的 SSH 用户名`), "");
    if (!user) throw new Error(sshUi(`OpenSSH host ${candidate.alias} requires an explicit username`, `OpenSSH 主机 ${candidate.alias} 需要填写用户名`));
    let jumpHostId: string | null = null;
    if (candidate.proxyJumpAliases.length > 0) {
      if (candidate.proxyJumpAliases.length !== 1) throw new Error(sshUi(`OpenSSH host ${candidate.alias} has a ProxyJump chain that must be imported as explicit hosts`, `OpenSSH 主机 ${candidate.alias} 的 ProxyJump 链需要逐个导入为明确的主机`));
      const alias = candidate.proxyJumpAliases[0]!;
      jumpHostId = ids.get(alias) ?? existingAliases.get(alias) ?? null;
      if (!jumpHostId) throw new Error(sshUi(`ProxyJump alias ${alias} is not an accepted or existing host`, `ProxyJump 别名 ${alias} 不是已接受或已存在的主机`));
    }
    let auth: SshAuth = { kind: "agent" };
    if (candidate.identities.length > 0) {
      if (candidate.identities.length > 1) throw new Error(sshUi(`OpenSSH host ${candidate.alias} requires an explicit identity choice`, `OpenSSH 主机 ${candidate.alias} 需要明确选择一个私钥`));
      const identityPath = candidate.identities[0]!.path;
      if (await ctx.ui.confirm(sshUi(`Encrypt identity for ${candidate.alias}?`, `加密保存 ${candidate.alias} 的私钥？`), sshUi("No keeps an explicit path reference; Yes imports the key into this manager.", "选择否则保留私钥文件路径引用；选择是则导入并加密保存私钥。"))) {
        const passphrase = await showSecretInput(ctx, sshUi("Private key passphrase", "私钥口令"), sshUi("Optional; leave empty for none", "可选；留空表示无口令"));
        if (passphrase === undefined) throw new Error(sshUi("OpenSSH key import cancelled", "已取消 OpenSSH 密钥导入"));
        const key = await importManagedSshKey(identityPath, `${candidate.alias} key`, passphrase || undefined);
        importedKeys.push(key);
        auth = { kind: "key", keyId: key.id };
      } else {
        auth = { kind: "identity", path: identityPath };
      }
    }
    additions.push(validateSshHost({ id: ids.get(candidate.alias), label: candidate.alias, host: candidate.hostName, user, port: candidate.port, shell: "bash", hostKey: null, auth, tags: [], jumpHostId, monitorEnabled: false }));
  }
  await pinUntrustedHostsFromKnownHosts(additions, async (host, fingerprint) => {
    const index = additions.findIndex((candidate) => candidate.id === host.id);
    if (index >= 0) additions[index] = { ...host, hostKey: fingerprint };
  });
  await store.saveConfiguration([...existing, ...additions], [...existingKeys, ...importedKeys]);
  const pinned = additions.filter((host) => host.hostKey !== null).length;
  return sshUi(`Imported ${additions.length} OpenSSH host(s)${pinned ? ` (${pinned} pinned from known_hosts)` : ""}${importedKeys.length ? ` and ${importedKeys.length} encrypted key(s)` : "; identities remain explicit path references"}`, `已导入 ${additions.length} 个 OpenSSH 主机${pinned ? `（${pinned} 个从 known_hosts 固定身份）` : ""}${importedKeys.length ? `和 ${importedKeys.length} 个加密密钥` : "；私钥仍以明确文件路径引用"}`);
}

async function hasPrivateKeyFiles(directory = join(homedir(), ".ssh")): Promise<boolean> {
  let names: string[];
  try { names = (await readdir(directory)).slice(0, 256); } catch { return false; }
  for (const name of names) {
    if (!/^id_[A-Za-z0-9._-]+$/u.test(name) || name.endsWith(".pub")) continue;
    try { const info = await lstat(join(directory, name)); if (info.isFile() && !info.isSymbolicLink()) return true; } catch { /* ignore */ }
  }
  return false;
}

function showSecretInput(
  ctx: ExtensionContext,
  title: string,
  prompt: string,
): Promise<string | undefined> {
  // RPC/headless 模式没有 custom overlay：退回普通 input（明文可见，但功能可用）。
  if (!supportsCustomOverlay(ctx)) return ctx.ui.input(title, prompt);
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => new MaskedSecretInput({
    title,
    prompt,
    theme: theme as SshManagerTheme,
    requestRender: () => tui.requestRender(),
    done,
  }), { overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "50%" } });
}

function showHostPickerOverlay(
  ctx: ExtensionContext,
  hosts: readonly SshHost[],
  selectedHostIds: readonly string[],
): Promise<string[] | undefined> {
  return ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => new SshHostPickerOverlay({
    hosts,
    selectedHostIds,
    theme: theme as SshManagerTheme,
    requestRender: () => tui.requestRender(),
    done,
  }), { overlay: true, overlayOptions: { anchor: "center", width: "86%", maxHeight: "80%" } });
}

function showManagerOverlay(
  ctx: ExtensionContext,
  hosts: readonly SshHost[],
  keys: readonly SshKey[],
  statuses: ReadonlyMap<string, SshHostOperationalStatus>,
  selectedHostIds: readonly string[],
  initialHostId: string | undefined,
  initialQuery: string,
  initialView: SshManagerView,
  notice?: string,
): Promise<SshHostManagerAction> {
  return ctx.ui.custom<SshHostManagerAction>((tui, theme, _keybindings, done) => new SshHostManagerOverlay({
    hosts, keys, statuses, selectedHostIds, theme: theme as SshManagerTheme, requestRender: () => tui.requestRender(), done,
    initialHostId, initialQuery, initialView, ...(notice ? { notice } : {}),
  }), { overlay: true, overlayOptions: { anchor: "center", width: "94%", maxHeight: "90%" } });
}

function sshToolTargetDetails(host: SshHost): SshToolTargetDetails {
  return {
    label: host.label,
    host: host.host,
    user: host.user,
    port: host.port,
    shell: host.shell,
  };
}

function formatSshAddress(host: string, port: number): string {
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${address}:${port}`;
}

function parsedTargetId(parsed: ParsedSshToolInput): string | undefined {
  return parsed.kind === "guide" || parsed.kind === "targets" || parsed.kind === "job" ? undefined : parsed.targetId;
}

function sshGatewayExecuteInput(parsed: ParsedSshToolInput): Exclude<SshGatewayInput, { action: "guide" }> {
  if (parsed.kind === "status" || parsed.kind === "list") return { action: parsed.kind };
  if (parsed.kind === "describe") return { action: "describe", tool: parsed.tool };
  if (parsed.kind === "call") {
    return {
      action: "call",
      tool: parsed.tool,
      ...(parsed.args ? { args: parsed.args } : {}),
      ...(parsed.timeout !== undefined ? { timeout: parsed.timeout } : {}),
    };
  }
  if (parsed.kind === "start_pi") {
    return {
      action: "start_pi",
      requestId: parsed.requestId,
      ...(parsed.todoIds ? { todoIds: parsed.todoIds } : {}),
      ...(parsed.objective ? { objective: parsed.objective } : {}),
      ...(parsed.agent ? { agent: parsed.agent } : {}),
      ...(parsed.timeout !== undefined ? { timeout: parsed.timeout } : {}),
    };
  }
  throw new Error("SSH Gateway action is not executable");
}

function sshToolFailureDetails(parsed: ParsedSshToolInput): Partial<SshToolDetails> {
  if (parsed.kind === "command" || parsed.kind === "job") return {};
  return {
    action: parsed.kind,
    ...(parsed.kind === "describe" || parsed.kind === "call" ? { tool: parsed.tool } : {}),
    summary: parsed.kind === "targets"
      ? "target listing failed"
      : parsed.kind === "sync_pi_config"
        ? "configuration sync failed"
        : parsed.kind === "ensure_gateway"
          ? "gateway bootstrap failed"
          : "gateway failed",
  };
}

function formatSshToolArgument(args: Partial<SshToolInput>, target?: SshToolTargetDetails): string {
  const parts: string[] = [];
  if (target) {
    const label = sanitizeCardText(target.label, 128);
    const user = sanitizeCardText(target.user, 128);
    const host = sanitizeCardText(target.host, 253);
    parts.push(`${label} · ${user}@${formatSshAddress(host, target.port)}`, target.shell);
  }
  if ("action" in args && typeof args.action === "string") {
    if (args.action.startsWith("job_")) {
      parts.push(`job ${sanitizeCardText(args.action.slice(4), 32)}`);
      const record = args as Record<string, unknown>;
      if (typeof record.jobId === "string") parts.push(sanitizeCardText(record.jobId, 128));
      if (typeof record.sessionId === "string") parts.push(sanitizeCardText(record.sessionId, 128));
      return parts.join(" · ");
    }
    parts.push(args.action === "targets" ? "targets" : `gateway ${sanitizeCardText(args.action, 32)}`);
    if ((args.action === "describe" || args.action === "call") && typeof args.tool === "string") {
      parts.push(sanitizeCardText(args.tool, 128));
    }
    return parts.join(" · ");
  }
  if ("cwd" in args && typeof args.cwd === "string" && args.cwd) parts.push(`cwd ${sanitizeCardText(args.cwd, 80)}`);
  if ("command" in args && typeof args.command === "string" && args.command) parts.push(sanitizeCardText(args.command, 160));
  return parts.join(" · ");
}

function formatSshResultSummary(details: SshToolDetails | undefined, isError: boolean): string {
  const parts: string[] = [];
  if (details?.jobId && details.status) parts.push(`${details.jobId} · ${details.status}`);
  else if (details?.summary) parts.push(details.summary);
  else if (typeof details?.exitCode === "number") parts.push(`exit ${details.exitCode}`);
  else if (!details?.signal) parts.push(isError ? "failed" : "exit unknown");
  if (details?.signal) parts.push(`signal ${details.signal}`);
  if (details && details.durationMs > 0) parts.push(`${details.durationMs}ms`);
  return parts.join(" · ");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const SSH_HEADLESS_USAGE =
  "用法：/ssh [list|add --label=.. --host=.. --user=.. --auth=agent|password|identity|key ...|edit <id|label> --field=..|delete <id|label> [--yes]|monitor <id|label> on|off|trust <id|label>|reset <id|label> [--yes]|import-key --path=.. --label=.. [--passphrase=..]|pair <id>|unpair <id>|attach <id|label>|detach <id|label>|detach-all|select <id|label>]（可加 --master-password=..）";

function sshHostFromHeadless(
  fields: Record<string, string>,
  hosts: readonly SshHost[],
  keys: readonly SshKey[],
  current: SshHost | undefined,
): { host: SshHost } | { error: string } {
  const field = (...names: string[]) => headlessField(fields, ...names);
  const label = (field("label", "name") ?? current?.label ?? "").trim();
  const hostname = (field("host", "hostname") ?? current?.host ?? "").trim();
  const user = (field("user", "username") ?? current?.user ?? "").trim();
  const portRaw = field("port");
  const port = portRaw !== undefined ? Number(portRaw.trim()) : current?.port ?? 22;
  if (!Number.isSafeInteger(port) || port <= 0) return { error: "--port must be a positive integer" };
  const shell = (field("shell") ?? current?.shell ?? "bash").toLowerCase();
  if (shell !== "bash" && shell !== "powershell") return { error: "--shell expects bash|powershell" };
  const hostKeyRaw = field("hostKey", "host-key");
  const hostKey = hostKeyRaw === undefined
    ? current?.hostKey ?? null
    : normalizeSshHostKeyFingerprint(hostKeyRaw) || null;

  const authKind = field("auth", "authType", "auth-type")?.toLowerCase();
  let auth: SshAuth | undefined;
  if (authKind === undefined) {
    auth = current?.auth;
  } else if (authKind === "agent") {
    auth = { kind: "agent" };
  } else if (authKind === "password") {
    const password = field("password");
    const existing = current?.auth.kind === "password" ? current.auth.password : undefined;
    if (!password && !existing) return { error: "--auth=password requires --password=<secret>" };
    auth = { kind: "password", password: password || existing! };
  } else if (authKind === "identity") {
    const path = field("identity", "identityPath", "identity-path");
    const existing = current?.auth.kind === "identity" ? current.auth : undefined;
    const finalPath = path ?? existing?.path;
    if (!finalPath) return { error: "--auth=identity requires --identity=<path>" };
    const passphrase = field("passphrase") ?? existing?.passphrase;
    auth = { kind: "identity", path: finalPath, ...(passphrase ? { passphrase } : {}) };
  } else if (authKind === "key") {
    const ref = field("key", "keyId", "key-id", "managedKey", "managed-key");
    const key = ref ? keys.find((candidate) => candidate.id === ref || candidate.label === ref) : undefined;
    if (!key) return { error: "--auth=key requires --key=<managed key id|label>" };
    auth = { kind: "key", keyId: key.id };
  } else {
    return { error: "--auth expects agent|password|identity|key" };
  }
  if (!auth) return { error: "add 需要 --auth=agent|password|identity|key（edit 时缺省沿用现有 auth）" };

  const tagsRaw = field("tags");
  const tags = tagsRaw !== undefined ? parseHeadlessList(tagsRaw) : current?.tags ?? [];
  const jumpRaw = field("jumpHost", "jump-host", "jumpHostId", "jump-host-id");
  let jumpHostId: string | null | undefined;
  if (jumpRaw === undefined) jumpHostId = current?.jumpHostId ?? null;
  else if (["none", "null", "-", ""].includes(jumpRaw.toLowerCase())) jumpHostId = null;
  else jumpHostId = hosts.find((candidate) => candidate.id === jumpRaw || candidate.label === jumpRaw)?.id;
  if (jumpHostId === undefined) return { error: `Jump host not found: ${jumpRaw}` };
  if (current && jumpHostId === current.id) return { error: "A host cannot be its own jump host" };
  const monitorRaw = field("monitor", "monitorEnabled", "monitor-enabled");
  const monitorEnabled = monitorRaw === undefined
    ? current?.monitorEnabled ?? false
    : parseHeadlessBoolean(monitorRaw);
  if (monitorEnabled === undefined) return { error: "--monitor expects on|off" };

  try {
    return {
      host: validateSshHost({
        id: current?.id ?? createSshHostId(),
        label,
        host: hostname,
        user,
        port,
        shell,
        hostKey,
        auth,
        tags,
        jumpHostId,
        monitorEnabled,
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function findSshHost(hosts: readonly SshHost[], ref: string | undefined): SshHost | undefined {
  if (!ref) return undefined;
  return hosts.find((host) => host.id === ref || host.label === ref)
    ?? hosts.find((host) => host.label.toLowerCase() === ref.toLowerCase());
}

/** /ssh 的 headless 路径：所有配置写都经过同一个 EncryptedSshStore。 */
async function runSshHeadless(
  ctx: ExtensionContext,
  store: EncryptedSshStore,
  executor: SshExecutor,
  monitor: SshStatusMonitor,
  bindings: ManagerBindings,
  sub: string,
  rest: string[],
  fields: Record<string, string>,
): Promise<void> {
  const masterPassword = headlessField(fields, "masterPassword", "master-password");
  const assumeYes = parseHeadlessBoolean(headlessField(fields, "yes") ?? "") === true;
  const targetRef = rest[0] ?? headlessField(fields, "id", "target", "host-id");
  const findTarget = () => {
    const host = findSshHost(store.getHosts(), targetRef);
    if (!host) ctx.ui.notify(`SSH host not found: ${targetRef ?? "(missing)"}`, "warning");
    return host;
  };
  const tryOp = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
  };

  switch (sub) {
    case "pair":
    case "unpair": {
      const hostId = targetRef ?? "";
      if (!SSH_HOST_ID_PATTERN.test(hostId)) {
        ctx.ui.notify(`Usage: /ssh ${sub} <targetId>`, "warning");
        return;
      }
      if (!await ensureUnlocked(ctx, store, masterPassword)) return;
      await tryOp(async () => {
        await bindings.invalidate(hostId);
        if (sub === "pair") {
          const receipt = await pairSshGateway(store, executor, hostId);
          ctx.ui.notify(`Secure Gateway pairing saved for target ${receipt.hostId}; expiry is recorded in the encrypted store.`, "info");
        } else {
          const removed = await unpairSshGateway(store, executor, hostId);
          ctx.ui.notify(removed ? "Secure Gateway pairing removed; stdio fallback is active." : "No Gateway pairing was stored for that target.", "info");
        }
        bindings.remove([hostId]);
      });
      return;
    }
    case "list":
    case "ls": {
      if (!await ensureUnlocked(ctx, store, masterPassword)) return;
      const hosts = store.getHosts();
      const keys = store.getKeys();
      const lines = [
        ...hosts.map((host) =>
          `${host.id}  ${host.label}  ${host.user}@${formatSshAddress(host.host, host.port)}  auth=${host.auth.kind}${host.hostKey ? " trusted" : ""}${host.monitorEnabled ? " monitor" : ""}`),
        ...keys.map((key) => `key:${key.id}  ${key.label}  ${key.publicKeyFingerprint}`),
      ];
      ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "SSH manager 为空。", "info");
      return;
    }
    case "add":
    case "edit": {
      if (!await ensureUnlocked(ctx, store, masterPassword)) return;
      const current = sub === "edit" ? findTarget() : undefined;
      if (sub === "edit" && !current) return;
      const built = sshHostFromHeadless(fields, store.getHosts(), store.getKeys(), current);
      if ("error" in built) {
        ctx.ui.notify(`${built.error}\n${SSH_HEADLESS_USAGE}`, "warning");
        return;
      }
      await tryOp(async () => {
        if (current) {
          const affected = new Set([...store.getReverseDependencyClosure(current.id), ...store.getReverseDependencyClosure(built.host.id)]);
          await invalidateHostIds(affected, bindings);
          await unpairGatewayHostIds(affected, store, executor);
          await store.updateHost(current.id, built.host);
          ctx.ui.notify(`Updated ${built.host.label}; affected selections and sessions were cleared`, "info");
        } else {
          await store.addHost(built.host);
          ctx.ui.notify(`Added ${built.host.label}`, "info");
        }
        monitor.reconcile();
      });
      return;
    }
    case "delete":
    case "remove": {
      if (!await ensureUnlocked(ctx, store, masterPassword)) return;
      const host = findTarget();
      if (!host) return;
      const confirmed = assumeYes || await ctx.ui.confirm(`Delete ${host.label}?`, "Referenced jump hosts cannot be deleted.");
      if (!confirmed) return;
      await tryOp(async () => {
        const affected = store.getReverseDependencyClosure(host.id);
        await invalidateHostIds(affected, bindings);
        await unpairGatewayHostIds(affected, store, executor);
        await store.deleteHost(host.id);
        monitor.reconcile();
        ctx.ui.notify(`Deleted ${host.label}`, "info");
      });
      return;
    }
    case "monitor": {
      if (!await ensureUnlocked(ctx, store, masterPassword)) return;
      const host = findTarget();
      if (!host) return;
      const raw = rest[1] ?? headlessField(fields, "enabled", "monitor");
      const enabled = raw !== undefined ? parseHeadlessBoolean(raw) : undefined;
      if (enabled === undefined) {
        ctx.ui.notify("Usage: /ssh monitor <id|label> on|off", "warning");
        return;
      }
      await tryOp(async () => {
        await store.updateHost(host.id, { ...host, monitorEnabled: enabled });
        monitor.reconcile();
        ctx.ui.notify(`Monitoring ${enabled ? "enabled" : "disabled"}: ${host.label}`, "info");
      });
      return;
    }
    case "trust":
    case "test": {
      if (!await ensureUnlocked(ctx, store, masterPassword)) return;
      const host = findTarget();
      if (!host) return;
      await tryOp(async () => {
        const message = await testAndTrustSshHost(ctx, store, executor, host);
        if (message.startsWith("Connection succeeded")) {
          await invalidateHostIds(store.getReverseDependencyClosure(host.id), bindings);
          monitor.reconcile();
        }
        ctx.ui.notify(message, "info");
      });
      return;
    }
    case "reset": {
      if (!await ensureUnlocked(ctx, store, masterPassword)) return;
      const host = findTarget();
      if (!host) return;
      const confirmed = assumeYes || (await ctx.ui.confirm(`Reset trust for ${host.label}?`, "The saved host identity will be removed and monitoring disabled.")
        && await ctx.ui.confirm("Confirm trust reset", "A future Test will establish trust again."));
      if (!confirmed) return;
      await tryOp(async () => {
        const affected = store.getReverseDependencyClosure(host.id);
        await invalidateHostIds(affected, bindings);
        await unpairGatewayHostIds(affected, store, executor);
        await store.updateHost(host.id, { ...host, hostKey: null, monitorEnabled: false });
        monitor.reconcile();
        ctx.ui.notify(`Trust reset for ${host.label}`, "info");
      });
      return;
    }
    case "import-key": {
      if (!await ensureUnlocked(ctx, store, masterPassword)) return;
      const path = headlessField(fields, "path", "file") ?? rest[0];
      const label = headlessField(fields, "label", "name") ?? rest[1];
      if (!path || !label) {
        ctx.ui.notify("Usage: /ssh import-key --path=<private-key-file> --label=<name> [--passphrase=..]", "warning");
        return;
      }
      await tryOp(async () => {
        const key = await importManagedSshKey(path, label.trim(), headlessField(fields, "passphrase") || undefined);
        await store.addKey(key);
        monitor.reconcile();
        ctx.ui.notify(`Imported key ${key.label}`, "info");
      });
      return;
    }
    case "attach":
    case "select": {
      if (!await ensureUnlocked(ctx, store, masterPassword)) return;
      const host = findTarget();
      if (!host) return;
      bindings.replace(host);
      ctx.ui.notify(`SSH server selected exclusively: ${host.label}.`, "info");
      return;
    }
    case "detach": {
      const host = findTarget();
      if (!host) return;
      bindings.remove([host.id]);
      ctx.ui.notify(`Detached ${host.label}`, "info");
      return;
    }
    case "detach-all":
    case "clear": {
      bindings.clear();
      ctx.ui.notify("SSH selection cleared.", "info");
      return;
    }
    default:
      ctx.ui.notify(SSH_HEADLESS_USAGE, "warning");
  }
}
