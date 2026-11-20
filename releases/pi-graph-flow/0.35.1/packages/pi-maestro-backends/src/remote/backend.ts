import { createRemoteBackend as createCoreRemoteBackend } from "pi-graph-provider-backend/remote";
import { resolveStructuredOutput, structuredOutputInstruction } from "../dsh/structured-output.ts";
import type { RemoteManagerFactory } from "pi-graph-provider-backend/remote";
export type { RemoteManagerFactory } from "pi-graph-provider-backend/remote";
export function createRemoteBackend(managerOf: RemoteManagerFactory) {
  return createCoreRemoteBackend(managerOf, { resolveStructuredOutput, structuredOutputInstruction });
}
