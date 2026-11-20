import type { AgentSession, AgentSessionConfig, CreateAgentSessionResult, ExtensionRunner, ResourceLoader, InlineExtension, SessionManager, SettingsManager, CreateAgentSessionOptions, CreateAgentSessionServicesOptions, CreateAgentSessionFromServicesOptions } from "./sdk-types.js";
export type RetireReason = "reload" | "replace" | "dispose" | "startup-failed";
export interface SessionLifecyclePort {
  capture(session: AgentSession): void;
  publish(session: AgentSession, runner: ExtensionRunner): void;
  fence(session: AgentSession, reason: RetireReason): void;
}
export interface RuntimeInput {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly extensionFactories: readonly InlineExtension[];
}
export interface RuntimeComposition {
  readonly extensionFactories?: readonly InlineExtension[];
  readonly lifecycle: SessionLifecyclePort;
  readonly resourceLoader?: ResourceLoader;
  failStartup(error: unknown): void;
}
export interface TrustedHostOptions {
  prepareRuntime(input: RuntimeInput): RuntimeComposition;
}
// Additive declarations for the derived five leaves. Stock declarations remain untouched.
export interface HostedSessionOptions extends CreateAgentSessionOptions {
  hostLifecycle?: SessionLifecyclePort;
}
export interface HostedServicesOptions extends CreateAgentSessionServicesOptions {
  resourceLoader?: ResourceLoader;
}
export interface HostedFromServicesOptions extends CreateAgentSessionFromServicesOptions {
  hostLifecycle?: SessionLifecyclePort;
}

export interface HostedAgentSession extends AgentSession {
  retireHostSession(reason: RetireReason): void;
}
export interface HostedSessionConfig extends AgentSessionConfig {
  hostLifecycle?: SessionLifecyclePort;
}
export interface HostedSessionResult extends Omit<CreateAgentSessionResult, "session"> {
  session: HostedAgentSession;
}
