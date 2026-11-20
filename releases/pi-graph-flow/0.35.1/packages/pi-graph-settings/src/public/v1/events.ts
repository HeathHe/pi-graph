import type { SupportedSettingsLocale } from "./i18n.ts";
import type { SettingsContextV1, SettingsProviderV1 } from "./provider.ts";
import type { SettingsActivationPlan, SettingsResourceRevision, SettingsSnapshot } from "./schema.ts";

export const SETTINGS_PROTOCOL_VERSION = 1 as const;

export const SETTINGS_DISCOVER_EVENT = "pi-graph-next:settings:discover" as const;
export const SETTINGS_ANNOUNCE_EVENT = "pi-graph-next:settings:announce" as const;
export const SETTINGS_CHANGED_EVENT = "pi-graph-next:settings:changed" as const;
export const SETTINGS_LOCALE_EVENT = "pi-graph-next:settings:locale" as const;

export interface SettingsDiscoverEventV1 {
  version: typeof SETTINGS_PROTOCOL_VERSION;
  /** Correlates provider announcements with one discovery broadcast. */
  requestId: string;
  context: SettingsContextV1;
}

export interface SettingsAnnounceEventV1 {
  version: typeof SETTINGS_PROTOCOL_VERSION;
  requestId?: string;
  providerId: string;
  instanceId: string;
  /** Same-process event buses may carry the provider methods directly. */
  provider: SettingsProviderV1;
}

export interface SettingsChangedEventV1 {
  version: typeof SETTINGS_PROTOCOL_VERSION;
  providerId: string;
  providerInstanceId: string;
  transactionId?: string;
  changedKeys: readonly string[];
  snapshot?: SettingsSnapshot;
  revisions?: readonly SettingsResourceRevision[];
  activation?: readonly SettingsActivationPlan[];
}

export interface SettingsLocaleEventV1 {
  version: typeof SETTINGS_PROTOCOL_VERSION;
  locale: SupportedSettingsLocale;
  generation: string;
}

export interface SettingsEventMapV1 {
  "pi-graph-next:settings:discover": SettingsDiscoverEventV1;
  "pi-graph-next:settings:announce": SettingsAnnounceEventV1;
  "pi-graph-next:settings:changed": SettingsChangedEventV1;
  "pi-graph-next:settings:locale": SettingsLocaleEventV1;
}
