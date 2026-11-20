/** Provider response orchestration; every I/O capability belongs to the original Host. */
export interface ProviderKeyResponsePorts {
  readOrigin(): Promise<{ id: string } | undefined>;
  markAndAdvance(keyId: string, status: number): Promise<{ advancedTo?: string } | undefined>;
  isEnabled(): boolean;
  reload(): Promise<void>;
  notify(message: string, level: "warning"): void;
}
export async function handleProviderKeyResponse(providerId: string, status: number, host: ProviderKeyResponsePorts): Promise<void> {
  if (![401, 403, 429].includes(status) && status < 500) return;
  const resolved = await host.readOrigin();
  if (!resolved || resolved.id === "legacy") return;
  const switched = await host.markAndAdvance(resolved.id, status);
  if (!switched) return;
  if (host.isEnabled()) await host.reload();
  host.notify(switched.advancedTo
    ? `${providerId} key ${resolved.id} failed (HTTP ${status}); selection advanced to ${switched.advancedTo}.`
    : `${providerId} key ${resolved.id} failed (HTTP ${status}).`, "warning");
}
