/** Authentication Host assembly: original writer/SDK/UI callbacks are bound by the actual public entry. */
import { createProviderAuthOwner, registerProviderConnections, type ProviderAuthContext, type ProviderAuthPorts, type ProviderAuthWriteResult, type ProviderRegistrationHost } from "pi-graph-provider-backend/auth";
export function createProviderAuthHost<P, C extends ProviderAuthContext, R extends ProviderAuthWriteResult, L extends string>(ports: ProviderAuthPorts<P,C,R,L>) {
  return createProviderAuthOwner(ports);
}
export function registerProviderAuthHost(ports: ProviderRegistrationHost): void { registerProviderConnections(ports); }
