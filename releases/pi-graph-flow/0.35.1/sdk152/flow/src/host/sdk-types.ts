// All identity-bearing types resolve through the one canonical public SDK root.
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
export type {
  AgentSession, AgentSessionConfig, ExtensionRunner, ResourceLoader, InlineExtension,
  LoadExtensionsResult, SessionManager, SettingsManager, MainOptions,
  CreateAgentSessionOptions, CreateAgentSessionResult, CreateAgentSessionServicesOptions,
  CreateAgentSessionFromServicesOptions, AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
export type ResourceExtensionPaths = Parameters<ResourceLoader["extendResources"]>[0];
export type ResourceLoaderReloadOptions = NonNullable<Parameters<ResourceLoader["reload"]>[0]>;
