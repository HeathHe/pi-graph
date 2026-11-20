export interface RecoveryFailureRecordV1 {
  code: string;
  layer: "provider" | "transport" | "recovery";
  phase: string;
  sequence: number;
  sanitizedMessage: string;
  model?: string;
}

export interface RecoveryDecisionRecordV1 {
  code: string;
  sequence: number;
  decision: string;
  evidenceRef?: string;
}

export interface RecoveryFailureChainV1 {
  version: 1;
  initiating?: RecoveryFailureRecordV1;
  decisions: readonly RecoveryDecisionRecordV1[];
  terminal?: RecoveryFailureRecordV1;
}

/** Backend-origin terminal refusal facts; recovery decisions remain Host-owned. */
export interface BackendTerminalRefusalV1 extends RecoveryFailureRecordV1 {
  code: "backend-refused";
  layer: "recovery";
  phase: "backend-terminal";
}
