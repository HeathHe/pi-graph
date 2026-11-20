declare module "m18:hosted-main" {
  export function main(args: string[], options?: import("./sdk-types.js").MainOptions, hostOptions?: import("./host-types.js").TrustedHostOptions): Promise<void>;
}
declare module "m18:hosted-sdk" {
  export function createAgentSession(options?: import("./host-types.js").HostedSessionOptions): Promise<import("./host-types.js").HostedSessionResult>;
}
declare module "m18:hosted-session" {
  export const AgentSession: typeof import("@earendil-works/pi-coding-agent").AgentSession;
}
declare module "m18:hosted-runtime" {
  export const AgentSessionRuntime: typeof import("@earendil-works/pi-coding-agent").AgentSessionRuntime;
  export const createAgentSessionRuntime: typeof import("@earendil-works/pi-coding-agent").createAgentSessionRuntime;
}
declare module "m18:hosted-services" {
  export function createAgentSessionServices(options: import("./host-types.js").HostedServicesOptions): Promise<import("./sdk-types.js").AgentSessionServices>;
  export function createAgentSessionFromServices(options: import("./host-types.js").HostedFromServicesOptions): Promise<import("./host-types.js").HostedSessionResult>;
}
