import { createRemoteRequest as coreCreateRemoteRequest, REMOTE_JSONRPC_VERSION, REMOTE_MAX_LINE_BYTES, REMOTE_MAX_ID_LENGTH, REMOTE_MAX_OBJECTIVE_BYTES } from "pi-graph-provider-backend/protocol/remote-run";
import type { RemoteJsonRpcId, RemoteJsonRpcRequest, RemoteJsonRpcNotification, RemoteJsonRpcSuccess, RemoteJsonRpcErrorObject, RemoteJsonRpcFailure, RemoteJsonRpcEnvelope, RemoteWindowBridgeAdvertisement, RemoteInitializeParams, RemoteInitializeResult, RemoteRunStartParams, RemoteRunStartResult, RemoteRunAttachParams, RemoteRunAttachResult, RemoteRunInputParams, RemoteRunInputResult, RemoteRunCancelParams, RemoteRunCancelResult, RemoteRunListParams, RemoteRunListResult } from "pi-graph-provider-backend/protocol/remote-run";
/** remote/2 JSON-RPC 2.0 envelopes carried as bounded NDJSON records. */

import type {
  RemoteCommandArgv,
  RemoteDriverId,
  RemoteInputMode,
  RemoteProtocolVersion,
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunIdentity,
  RemoteRunSnapshot,
  RemoteStatus,
  RemoteWorkerHeartbeat,
  RemoteWorkerIdentity,
  RemoteWorkspaceConfig,
} from "./types.ts";
import { REMOTE_PROTOCOL_VERSION } from "./types.ts";
import type {
  RemoteWindowListParams,
  RemoteWindowListResult,
  RemoteWindowMessageNotification,
  RemoteWindowObserveParams,
  RemoteWindowObserveResult,
  RemoteWindowReceiptParams,
  RemoteWindowReceiptResult,
  RemoteWindowSendParams,
  RemoteWindowSendResult,
  RemoteWindowStateNotification,
} from "./window-protocol.ts";

export * from "./window-protocol.ts";

export type RemoteWindowBridgeDiagnosticCode =
  | "host-unreachable"
  | "daemon-incompatible"
  | "plugin-missing"
  | "protocol-too-old"
  | "no-active-window";

export type RemoteWindowBridgeNegotiation =
  | {
    status: "supported";
    advertisement: RemoteWindowBridgeAdvertisement;
    windowProtocolVersion: number;
  }
  | {
    status: "unsupported" | "upgrade-required";
    code: RemoteWindowBridgeDiagnosticCode;
    message: string;
  };

export interface RemoteRequestParamsByMethod {
  "remote/initialize": RemoteInitializeParams;
  "run/start": RemoteRunStartParams;
  "run/attach": RemoteRunAttachParams;
  "run/input": RemoteRunInputParams;
  "run/cancel": RemoteRunCancelParams;
  "run/list": RemoteRunListParams;
  "window/list": RemoteWindowListParams;
  "window/observe": RemoteWindowObserveParams;
  "window/send": RemoteWindowSendParams;
  "window/receipt": RemoteWindowReceiptParams;
}

export interface RemoteResultByMethod {
  "remote/initialize": RemoteInitializeResult;
  "run/start": RemoteRunStartResult;
  "run/attach": RemoteRunAttachResult;
  "run/input": RemoteRunInputResult;
  "run/cancel": RemoteRunCancelResult;
  "run/list": RemoteRunListResult;
  "window/list": RemoteWindowListResult;
  "window/observe": RemoteWindowObserveResult;
  "window/send": RemoteWindowSendResult;
  "window/receipt": RemoteWindowReceiptResult;
}

export type RemoteTypedRequest<Method extends RemoteRequestMethod> = RemoteJsonRpcRequest<
  Method,
  RemoteRequestParamsByMethod[Method]
>;

export type RemoteProtocolNotification =
  | RemoteJsonRpcNotification<"run/state", Extract<RemoteRunEvent, { type: "run/state" }>>
  | RemoteJsonRpcNotification<"run/event", Extract<RemoteRunEvent, { type: "run/event" }>>
  | RemoteJsonRpcNotification<"run/result", Extract<RemoteRunEvent, { type: "run/result" }>>
  | RemoteJsonRpcNotification<"window/state", RemoteWindowStateNotification>
  | RemoteJsonRpcNotification<"window/message", RemoteWindowMessageNotification>
  | RemoteJsonRpcNotification<"worker/heartbeat", RemoteWorkerHeartbeat>;

export type RemoteProtocolRequest = {
  [Method in RemoteRequestMethod]: RemoteTypedRequest<Method>;
}[RemoteRequestMethod];

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBridgeVersionList(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error(`Invalid remote window bridge ${label}`);
  const versions: number[] = [];
  for (const version of value) {
    if (!Number.isInteger(version) || version < 1 || version > 65_535 || versions.includes(version)) {
      throw new Error(`Invalid remote window bridge ${label}`);
    }
    versions.push(version);
  }
  return Object.freeze(versions.sort((left, right) => left - right));
}

/** Strictly normalizes the daemon's optional, untrusted window-bridge advertisement. */
export function normalizeRemoteWindowBridgeAdvertisement(value: unknown): RemoteWindowBridgeAdvertisement {
  if (!plainObject(value)) throw new Error("Invalid remote window bridge advertisement");
  const allowed = new Set([
    "pluginId",
    "pluginVersion",
    "workspacePeerVersions",
    "relayVersions",
    "runtimeVersions",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Invalid remote window bridge advertisement");
  }
  if (typeof value.pluginId !== "string"
    || !value.pluginId
    || value.pluginId.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.pluginId)
    || typeof value.pluginVersion !== "string"
    || !value.pluginVersion
    || value.pluginVersion.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.pluginVersion)) {
    throw new Error("Invalid remote window bridge plugin identity");
  }
  return Object.freeze({
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    workspacePeerVersions: normalizeBridgeVersionList(value.workspacePeerVersions, "workspacePeerVersions"),
    relayVersions: normalizeBridgeVersionList(value.relayVersions, "relayVersions"),
    runtimeVersions: normalizeBridgeVersionList(value.runtimeVersions, "runtimeVersions"),
  });
}

/**
 * Negotiates only the optional window surface. A missing/old bridge never
 * invalidates the already-negotiated remote run protocol.
 */
export function negotiateRemoteWindowBridge(
  workspace: Pick<RemoteWorkspaceConfig, "requiredPlugin" | "minimumWindowProtocol">,
  result: RemoteInitializeResult,
  activeWindowCount?: number,
): RemoteWindowBridgeNegotiation {
  if (result.windowBridge === undefined) {
    return {
      status: "unsupported",
      code: "plugin-missing",
      message: `Remote daemon did not advertise required plugin ${workspace.requiredPlugin}`,
    };
  }
  let advertisement: RemoteWindowBridgeAdvertisement;
  try {
    advertisement = normalizeRemoteWindowBridgeAdvertisement(result.windowBridge);
  } catch (error) {
    return {
      status: "upgrade-required",
      code: "daemon-incompatible",
      message: error instanceof Error ? error.message : "Invalid remote window bridge advertisement",
    };
  }
  if (advertisement.pluginId !== workspace.requiredPlugin) {
    return {
      status: "unsupported",
      code: "plugin-missing",
      message: `Remote daemon advertised ${advertisement.pluginId}, not required plugin ${workspace.requiredPlugin}`,
    };
  }
  const windowProtocolVersion = [...advertisement.workspacePeerVersions]
    .filter((version) => version >= workspace.minimumWindowProtocol)
    .sort((left, right) => right - left)[0];
  if (windowProtocolVersion === undefined) {
    return {
      status: "upgrade-required",
      code: "protocol-too-old",
      message: `Remote window protocol is older than required version ${workspace.minimumWindowProtocol}`,
    };
  }
  if (activeWindowCount !== undefined
    && (!Number.isSafeInteger(activeWindowCount) || activeWindowCount < 0)) {
    return {
      status: "upgrade-required",
      code: "daemon-incompatible",
      message: "Remote daemon returned an invalid active window count",
    };
  }
  if (activeWindowCount === 0) {
    return {
      status: "unsupported",
      code: "no-active-window",
      message: "Remote workspace has no active compatible teammate window",
    };
  }
  return { status: "supported", advertisement, windowProtocolVersion };
}

export function createRemoteRequest<Method extends RemoteRequestMethod>(
  id: RemoteJsonRpcId,
  method: Method,
  params: RemoteRequestParamsByMethod[Method],
): RemoteTypedRequest<Method> {
  return coreCreateRemoteRequest(id, method, params);
}


export { REMOTE_JSONRPC_VERSION, REMOTE_MAX_LINE_BYTES, REMOTE_MAX_ID_LENGTH, REMOTE_MAX_OBJECTIVE_BYTES, parseRemoteEnvelopeLine, encodeRemoteEnvelope, captureMatches } from "pi-graph-provider-backend/protocol/remote-run";
export type { RemoteJsonRpcId, RemoteJsonRpcRequest, RemoteJsonRpcNotification, RemoteJsonRpcSuccess, RemoteJsonRpcErrorObject, RemoteJsonRpcFailure, RemoteJsonRpcEnvelope, RemoteWindowBridgeAdvertisement, RemoteInitializeParams, RemoteInitializeResult, RemoteRunStartParams, RemoteRunStartResult, RemoteRunAttachParams, RemoteRunAttachResult, RemoteRunInputParams, RemoteRunInputResult, RemoteRunCancelParams, RemoteRunCancelResult, RemoteRunListParams, RemoteRunListResult } from "pi-graph-provider-backend/protocol/remote-run";
export type RemoteRequestMethod = "remote/initialize" | "run/start" | "run/attach" | "run/input" | "run/cancel" | "run/list" | "window/list" | "window/observe" | "window/send" | "window/receipt";
export type RemoteNotificationMethod = RemoteRunEvent["type"] | RemoteWorkerHeartbeat["type"];
