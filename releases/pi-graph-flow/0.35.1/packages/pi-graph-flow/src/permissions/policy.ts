import { createPermissionPolicy } from "pi-graph-permission-core";
import { permissionPathPort } from "./path-adapter.ts";
export type { PermissionDecision } from "pi-graph-permission-core";
export const { canonicalToolName, evaluatePermission, suggestedAllowRule, matchesPermissionRule } = createPermissionPolicy(permissionPathPort);
