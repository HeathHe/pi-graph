import { tuiT } from "./tui-i18n.ts";
// Teammate remains an optional peer. Missing/older peers yield unconfirmed native facts.
const nativeApi = await import("pi-maestro-teammate/v1/observation").catch(() => undefined);
export const NATIVE_VIEW_INVALIDATED = "pi-graph-next:native-view-invalidated/1";
export const describeNativeEntity: NonNullable<typeof nativeApi>["nativeViewDescriptorOfEntity"] | undefined = nativeApi?.nativeViewDescriptorOfEntity;
import type { NativeExecutionSnapshot } from "pi-maestro-teammate/v1/observation";
import type { AgentRow } from "./types.ts";

export interface NativeProjectionContext {
  readonly cwd: string;
  readonly sessionManager: {getSessionId(): string; getLeafId(): string | null; getBranch(): readonly {id:string}[]};
}
function fact(snapshot: NativeExecutionSnapshot | undefined, ownerId?: string, detached = false): NonNullable<AgentRow["nativeObservation"]> {
  return {
    ownerId,
    invocationId: snapshot?.nativeInvocationId,
    sequence: snapshot?.sequence ?? 0,
    state: snapshot?.process.close ? "closed" : snapshot?.process.exit ? "awaiting-close" : snapshot?.process.startObserved ? "running" : "unconfirmed",
    currentTurnState: snapshot?.currentTurn?.state,
    unsettled: snapshot?.process.startObserved === true && !snapshot.process.close,
    detached,
    retained:false,
  };
}
function decorate(row: AgentRow, snapshot: NativeExecutionSnapshot | undefined, ownerId?: string, detached = false, retainedHint = false): AgentRow {
  const nativeObservation = fact(snapshot, ownerId, detached);
  const turnState = snapshot?.currentTurn?.state;
  const unsettledTurn = turnState === "queued" || turnState === "running" || turnState === "unknown";
  // These are copies for display. A previous turn's result-ready flags cannot
  // describe new or unconfirmed work, but remain untouched in the legacy store.
  const displayedRow = unsettledTurn ? {...row, resultReadyAt: undefined,
    ...(row.runtime ? {runtime: {...row.runtime, resultReady: false}} : {})} : row;
  const retained = !detached && !unsettledTurn && (retainedHint || row.status === "sleeping" || row.status === "done"
    || row.resultReadyAt !== undefined || row.runtime?.resultReady === true
    || snapshot?.lastResult?.wakeable === true || snapshot?.lastResult?.lifecyclePending === true);
  nativeObservation.retained = retained;
  // Physical liveness is not business activity. Warm/result-ready owners remain background.
  const terminalOwner = row.status === "failed" || row.status === "terminated";
  const status = !detached && !terminalOwner && turnState === "running" ? "running"
    : !detached && !terminalOwner && turnState === "queued" ? "pending"
    : !detached && turnState === "unknown" && row.status !== "failed" && row.status !== "terminated" ? "pending"
    : retained && (row.status === "running" || row.status === "pending") ? "sleeping"
    : nativeObservation.state === "running" && (detached || row.status === "pending") ? "running"
    : detached && nativeObservation.state === "awaiting-close" ? "pending"
    : nativeObservation.state === "unconfirmed" && row.status === "running" ? "pending" : row.status;
  const logicalLabel = turnState === "unknown" ? tuiT("native.turnUnknown")
    : turnState === "queued" ? tuiT("native.turnQueued")
    : turnState === "running" ? tuiT("native.turnRunning") : undefined;
  const physicalLabel = retained && nativeObservation.state === "running" ? tuiT("native.retained") : tuiT(`native.${nativeObservation.state}`);
  const label = [detached ? tuiT("native.detached") : undefined, logicalLabel, physicalLabel].filter(Boolean).join(" · ");
  return {...displayedRow,status,nativeObservation,phase:row.phase ? `${label} · ${row.phase}` : label,tail:row.tail ? `${label} · ${row.tail}` : label};
}
/** All four surfaces consume this same derived roster. No raw row mutation or native generation guesses. */
export function projectNativeRows(rows: AgentRow[], ctx: NativeProjectionContext | undefined): AgentRow[] {
  let source: ReturnType<NonNullable<typeof nativeApi>["lookupNativeViewSource"]>;
  try { if(ctx) source = nativeApi?.lookupNativeViewSource?.({manager:ctx.sessionManager,sessionId:ctx.sessionManager.getSessionId(),cwd:ctx.cwd}); } catch { /* unsupported host */ }
  const represented = new Set<string>();
  const projected = rows.map(row=>{
    const descriptor = row.nativeViewDescriptor ?? nativeApi?.nativeLegacyViewDescriptor?.(row.correlationId,
      row.workspaceId && row.sessionId && row.sourceId && row.sessionGeneration !== undefined
        ? {workspaceId:row.workspaceId,sessionId:row.sessionId,sourceId:row.sourceId,generation:row.sessionGeneration} : undefined);
    const current = source && descriptor ? nativeApi?.readNativeView?.(source,descriptor) : undefined;
    if(current?.view.current) represented.add(`${current.ownerId}:${current.view.current.nativeInvocationId}`);
    return decorate(row,current?.view.current,current?.ownerId);
  });
  for(const pending of (source ? nativeApi?.readNativeSource?.(source)?.pending : undefined) ?? []) {
    const key = `${pending.ownerId}:${pending.snapshot.nativeInvocationId}`;
    if(represented.has(key)) continue;
    projected.push(decorate({correlationId:`native-pending:${key}`,agent:pending.agent,name:undefined,role:pending.agent,
      task:tuiT("native.physical"),status:"pending",tail:"",startedAt:pending.observedSince,lastActivityAt:pending.observedSince},pending.snapshot,pending.ownerId,pending.detached,pending.retained));
  }
  return projected;
}
