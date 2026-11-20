import type { CallToolRequest, CallToolResult, ReadResourceRequest, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

/** Trusted, per-App closure; never populated from browser request fields. */
export interface NativeAppOperationPort {
  current(): boolean;
  call(input: CallToolRequest["params"], signal: AbortSignal): Promise<CallToolResult>;
  read(input: ReadResourceRequest["params"], signal: AbortSignal): Promise<ReadResourceResult>;
  cancel(operationId: string): void;
}
