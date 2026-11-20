/** Host supplies the ORIGINAL facade's anchors; the core never uses its own module location. */
export interface AgentResourceHost {
  builtinAgentsDir: string;
  packageSearchStart: string;
  homeDir(): string;
  profileAgentDir?(homeDir: string): string | undefined;
  packageAgentsOverride(): string | undefined;
  parseTaskType(value: unknown): string | undefined;
}
let configured: Readonly<AgentResourceHost> | undefined;
export function configureAgentResourceHost(host: AgentResourceHost): void {
  if (!host.builtinAgentsDir || !host.packageSearchStart) throw new Error("Resource host requires original agent roots");
  configured = Object.freeze({ ...host });
}
export function agentHost(): Readonly<AgentResourceHost> {
  if (!configured) throw new Error("Agent resource host is not configured");
  return configured;
}
