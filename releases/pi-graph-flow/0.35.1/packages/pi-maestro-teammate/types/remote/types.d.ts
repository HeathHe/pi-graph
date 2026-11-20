/** Canonical public data model for the Maestro Remote Worker Protocol. */
export { REMOTE_PROTOCOL_VERSION, REMOTE_STATUSES, isRemoteStatus, isRemoteTerminalStatus } from "pi-graph-provider-backend/protocol/remote-run";
export type { RemoteProtocolVersion, RemoteStatus, RemoteTerminalStatus, RemoteDriverId, RemoteInputMode, RemoteCommandArgv, RemoteWorkerIdentity, RemoteRunIdentity, RemoteRunCapture, RemoteRunSnapshot, RemoteUsage, RemoteToolEvent, RemoteDriverEvent, RemoteRunStateEvent, RemoteRunProgressEvent, RemoteRunResultEvent, RemoteRunEvent, RemoteWorkerHeartbeat } from "pi-graph-provider-backend/protocol/remote-run";
import type { RemoteDriverId, RemoteCommandArgv } from "pi-graph-provider-backend/protocol/remote-run";
export declare const REMOTE_CONFIG_VERSION: 4;
export declare const REMOTE_WINDOW_BRIDGE_PLUGIN_ID: "pi-maestro-teammate";
export type RemoteConfigVersion = typeof REMOTE_CONFIG_VERSION;
export interface RemoteHostConfig {
    host: string;
    user: string;
    port: number;
    hostKeySha256: string;
    /** Local identity-file reference. Omit to use ssh-agent authentication. */
    identityFile?: string;
}
/** A host entry resolved at connection time through the process-local `/ssh` provider. */
export interface RemoteHostReferenceConfig {
    sshHostRef: string;
}
/** Backward-compatible inline host configuration or a provider-owned host reference. */
export type RemoteHostEntry = RemoteHostConfig | RemoteHostReferenceConfig;
export declare function isRemoteHostReferenceConfig(value: RemoteHostEntry): value is RemoteHostReferenceConfig;
export interface RemoteAcpFileSystemPolicy {
    read?: boolean;
    write?: boolean;
    maxReadBytes?: number;
    maxWriteBytes?: number;
}
/** A terminal command an ACP agent may start, bound to a canonical executable. */
export interface RemoteAcpTerminalCommand {
    /** Canonical absolute path to the executable on the remote bridge host. */
    executable: string;
    /** Exact argv after the executable. Requests must match this list byte-for-byte. */
    args: readonly string[];
    /** Exact environment variable names this profile permits the ACP agent to set. */
    environment: readonly string[];
}
export interface RemoteAcpTerminalPolicy {
    /** Explicit command profiles accepted from ACP terminal/create. */
    commands: readonly RemoteAcpTerminalCommand[];
    maxOutputBytes?: number;
    timeoutMs?: number;
    maxProcesses?: number;
}
export interface RemoteAcpPolicy {
    /** Permission requests are denied unless allow-once is explicitly configured and tool-scoped. */
    permissionMode?: "deny" | "allow-once";
    /** Tool names that may receive allow-once grants; unknown tools default to deny. */
    permissionTools?: readonly string[];
    fs?: RemoteAcpFileSystemPolicy;
    terminal?: RemoteAcpTerminalPolicy;
}
export interface RemoteTargetConfig {
    host: string;
    cwd: string;
    driver: RemoteDriverId;
    /** Trusted argv; never populated from a task or model request. */
    command: RemoteCommandArgv;
    /**
     * Trusted environment-variable names to forward from the daemon process to
     * the spawned CLI (e.g. CODEX_API_KEY). Explicit opt-in only; launch-policy
     * variables (PATH, LD_PRELOAD, …) are always rejected.
     */
    env?: readonly string[];
    /** Default-deny ACP client operations. Valid only for ACP targets. */
    acp?: RemoteAcpPolicy;
}
/** A trusted remote Pi workspace eligible for explicit window discovery. */
export interface RemoteWorkspaceConfig {
    host: string;
    /** Trusted absolute POSIX cwd; remote window requests never supply their own cwd. */
    cwd: string;
    requiredPlugin: typeof REMOTE_WINDOW_BRIDGE_PLUGIN_ID;
    minimumWindowProtocol: number;
}
export interface ResolvedRemoteTarget extends RemoteTargetConfig {
    id: string;
    hostConfig: RemoteHostEntry;
}
export interface ResolvedRemoteWorkspace extends RemoteWorkspaceConfig {
    workspaceRef: string;
    hostConfig: RemoteHostEntry;
}
