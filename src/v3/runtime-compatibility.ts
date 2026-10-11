/** Read-only upgrade detection; never applies patches or changes running tasks. */
export function checkNativeRuntimePatch(_manifestPath?: string): string | undefined {
 // Independent execution layer has no pi-subagents byte patches.

 return undefined;
}

/** Check the loaded public bridge, never package bytes or private patches. */
export function verifySubagentCapabilities(value: unknown): void {
 const ping = value as Record<string, any> | undefined;
 const capabilities = ping?.capabilities;
 const missing: string[] = [];
 if (ping?.runtimeKind !== 'pi-graph-sdk/1') missing.push('owned runtime identity');
 if (ping?.version !== 1) missing.push("RPC v1");
 for (const method of ["spawn", "status", "stop"]) {
  if (!Array.isArray(ping?.methods) || !ping.methods.includes(method)) missing.push(method);
 }
 for (const name of ["asyncSpawn", "status", "stop"]) if (capabilities?.[name] !== true) missing.push(name);
 if (capabilities?.processTerminalProof?.version !== 1 || capabilities.processTerminalProof.lifecycleArtifactVersion !== 3) missing.push("process-terminal proof v1 / lifecycle v3");
 if (capabilities?.launchResolvedExtensions?.version !== 1) missing.push("launchResolvedExtensions v1");
 if (capabilities?.runtimeAcknowledgedExtensions?.version !== 1) missing.push("runtimeAcknowledgedExtensions v1");
 if (ping?.events?.asyncComplete !== "pi-graph:child-complete") missing.push("asyncComplete event");
 if (missing.length) throw new Error(`pi-graph owned runtime incompatible: missing ${missing.join(", ")}. No child was started. Load a runtime providing these public capabilities and reload Pi.`);
}
