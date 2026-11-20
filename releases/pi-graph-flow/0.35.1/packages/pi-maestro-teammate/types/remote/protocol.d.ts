import type { RemoteJsonRpcId, RemoteJsonRpcRequest, RemoteJsonRpcNotification, RemoteWindowBridgeAdvertisement, RemoteInitializeParams, RemoteInitializeResult, RemoteRunStartParams, RemoteRunStartResult, RemoteRunAttachParams, RemoteRunAttachResult, RemoteRunInputParams, RemoteRunInputResult, RemoteRunCancelParams, RemoteRunCancelResult, RemoteRunListParams, RemoteRunListResult } from "pi-graph-provider-backend/protocol/remote-run";
/** remote/2 JSON-RPC 2.0 envelopes carried as bounded NDJSON records. */
import type { RemoteRunEvent, RemoteWorkerHeartbeat, RemoteWorkspaceConfig } from "./types.ts";
import type { RemoteWindowListParams, RemoteWindowListResult, RemoteWindowMessageNotification, RemoteWindowObserveParams, RemoteWindowObserveResult, RemoteWindowReceiptParams, RemoteWindowReceiptResult, RemoteWindowSendParams, RemoteWindowSendResult, RemoteWindowStateNotification } from "./window-protocol.ts";
export * from "./window-protocol.ts";
export type RemoteWindowBridgeDiagnosticCode = "host-unreachable" | "daemon-incompatible" | "plugin-missing" | "protocol-too-old" | "no-active-window";
export type RemoteWindowBridgeNegotiation = {
    status: "supported";
    advertisement: RemoteWindowBridgeAdvertisement;
    windowProtocolVersion: number;
} | {
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
export type RemoteTypedRequest<Method extends RemoteRequestMethod> = RemoteJsonRpcRequest<Method, RemoteRequestParamsByMethod[Method]>;
export type RemoteProtocolNotification = RemoteJsonRpcNotification<"run/state", Extract<RemoteRunEvent, {
    type: "run/state";
}>> | RemoteJsonRpcNotification<"run/event", Extract<RemoteRunEvent, {
    type: "run/event";
}>> | RemoteJsonRpcNotification<"run/result", Extract<RemoteRunEvent, {
    type: "run/result";
}>> | RemoteJsonRpcNotification<"window/state", RemoteWindowStateNotification> | RemoteJsonRpcNotification<"window/message", RemoteWindowMessageNotification> | RemoteJsonRpcNotification<"worker/heartbeat", RemoteWorkerHeartbeat>;
export type RemoteProtocolRequest = {
    [Method in RemoteRequestMethod]: RemoteTypedRequest<Method>;
}[RemoteRequestMethod];
/** Strictly normalizes the daemon's optional, untrusted window-bridge advertisement. */
export declare function normalizeRemoteWindowBridgeAdvertisement(value: unknown): RemoteWindowBridgeAdvertisement;
/**
 * Negotiates only the optional window surface. A missing/old bridge never
 * invalidates the already-negotiated remote run protocol.
 */
export declare function negotiateRemoteWindowBridge(workspace: Pick<RemoteWorkspaceConfig, "requiredPlugin" | "minimumWindowProtocol">, result: RemoteInitializeResult, activeWindowCount?: number): RemoteWindowBridgeNegotiation;
export declare function createRemoteRequest<Method extends RemoteRequestMethod>(id: RemoteJsonRpcId, method: Method, params: RemoteRequestParamsByMethod[Method]): RemoteTypedRequest<Method>;
export { REMOTE_JSONRPC_VERSION, REMOTE_MAX_LINE_BYTES, REMOTE_MAX_ID_LENGTH, REMOTE_MAX_OBJECTIVE_BYTES, parseRemoteEnvelopeLine, encodeRemoteEnvelope, captureMatches } from "pi-graph-provider-backend/protocol/remote-run";
export type { RemoteJsonRpcId, RemoteJsonRpcRequest, RemoteJsonRpcNotification, RemoteJsonRpcSuccess, RemoteJsonRpcErrorObject, RemoteJsonRpcFailure, RemoteJsonRpcEnvelope, RemoteWindowBridgeAdvertisement, RemoteInitializeParams, RemoteInitializeResult, RemoteRunStartParams, RemoteRunStartResult, RemoteRunAttachParams, RemoteRunAttachResult, RemoteRunInputParams, RemoteRunInputResult, RemoteRunCancelParams, RemoteRunCancelResult, RemoteRunListParams, RemoteRunListResult } from "pi-graph-provider-backend/protocol/remote-run";
export type RemoteRequestMethod = "remote/initialize" | "run/start" | "run/attach" | "run/input" | "run/cancel" | "run/list" | "window/list" | "window/observe" | "window/send" | "window/receipt";
export type RemoteNotificationMethod = RemoteRunEvent["type"] | RemoteWorkerHeartbeat["type"];
