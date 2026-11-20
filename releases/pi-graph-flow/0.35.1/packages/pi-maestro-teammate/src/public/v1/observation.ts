import type {AgentRuntimeDiagnosisV1,MessageProvenanceV1} from '../../shared/types.ts';
import {ObservationRegistry,createObserveService,formatObserveResult as formatCore} from 'pi-graph-observability/execution';
import type {ObservationSnapshot as CoreSnapshot,ObservationProvider as CoreProvider,ObserveResult as CoreResult} from 'pi-graph-observability/execution';
import {hostClock} from '../../observability/host-adapter.ts';
export type {ObservationAction,ObservationDetail,ObservationView,ObservationWaitMode,ObservationPhase,ObservationOutcome,ObservationWaitStatus,ObservationTarget,ObservationCapabilities,ObservationPage,ObservationReadOptions,ObservationWaitOptions,ObserveParams} from 'pi-graph-observability/execution';
export {WATCH_MAX_TRANSITIONS,WATCH_MAX_TRANSITION_BYTES,OBSERVATION_TEXT_MAX_BYTES,boundObservationText,observationJson} from 'pi-graph-observability/execution';
export type ObservationSnapshot=CoreSnapshot<AgentRuntimeDiagnosisV1>;
export type ObservationProvider=CoreProvider<AgentRuntimeDiagnosisV1>;
export type ObserveResult=CoreResult<AgentRuntimeDiagnosisV1>;
const key=Symbol.for('pi-graph-observability.typed-observation-registry.v1');
const shared=globalThis as typeof globalThis & Record<symbol,unknown>;
const registry=(shared[key]??=new ObservationRegistry<AgentRuntimeDiagnosisV1>()) as ObservationRegistry<AgentRuntimeDiagnosisV1>;
export const registerObservationProvider=(provider:ObservationProvider):(()=>void)=>registry.register(provider);
export const getObservationProvider=(kind:string):ObservationProvider|undefined=>registry.get(kind);
export const listObservationProviders=():ObservationProvider[]=>registry.list();
export const observeTargets=createObserveService(registry,hostClock).observeTargets;
export function formatObserveResult(result:ObserveResult,verbose=false):string[]{return formatCore(result,verbose,diagnosisDetail);}
export function diagnosisProvenanceLine(
  label: "trigger" | "last-message",
  provenance: MessageProvenanceV1,
): string {
  const sender = provenance.sender.kind === "teammate-agent"
    ? `teammate-agent:${provenance.sender.correlationId}`
    : provenance.confidence === "unknown"
      ? `unknown${provenance.legacyLabel ? ` (legacy=${provenance.legacyLabel})` : ""}`
      : `${provenance.sender.kind}:${provenance.sender.ownerId}`;
  const identity = provenance.messageId ? ` message=${provenance.messageId}` : "";
  const semantics = `${provenance.messageKind ? ` kind=${provenance.messageKind}` : ""}${provenance.deliveryMode ? ` mode=${provenance.deliveryMode}` : ""}`;
  return `${label}: source=${provenance.source} confidence=${provenance.confidence} sender=${sender}${identity}${semantics}`;
}

export function diagnosisDetail(diagnosis: AgentRuntimeDiagnosisV1): string[] {
  return [
    `lifecycle=${diagnosis.lifecycle}${diagnosis.phase ? ` phase=${diagnosis.phase}` : ""} health=${diagnosis.health} activity=${diagnosis.activity} tool=${diagnosis.toolActivity} resultReady=${diagnosis.resultReady}`,
    `reason=${diagnosis.reasonCode} fallback=${diagnosis.fallbackDisposition}`,
    diagnosisProvenanceLine("trigger", diagnosis.trigger),
    ...(diagnosis.lastMessage
      ? [`last-message-role=${diagnosis.lastMessage.role} timestamp=${diagnosis.lastMessage.timestamp}`, diagnosisProvenanceLine("last-message", diagnosis.lastMessage.provenance)]
      : ["last-message: unavailable"]),
    ...(diagnosis.previousOutcome
      ? [`previous-outcome=${diagnosis.previousOutcome.status} settledAt=${diagnosis.previousOutcome.settledAt}${diagnosis.previousOutcome.message ? ` message=${diagnosis.previousOutcome.message}` : ""}`]
      : []),
  ];
}

export { readNativeExecutionSnapshot } from "../../run-executor/native-observation.ts";
export type { NativeExecutionSnapshot, NativeExecutionIdentity, NativeCurrentTurnObservation } from "../../run-executor/native-observation.ts";

export { readNativeCurrent, subscribeNativeCurrent } from "../../run-executor/native-current-view.ts";
export type { NativeCurrentReadCapability, NativeCurrentView } from "../../run-executor/native-current-view.ts";

export { lookupNativeViewSource, readNativeView, readNativeSource, nativeViewDescriptorOfEntity, nativeLegacyViewDescriptor, NATIVE_VIEW_INVALIDATED } from "../../run-executor/native-view-source.ts";
export type { NativeViewSource, NativeViewDescriptor, NativeViewRow, NativePendingView, NativeSourceSnapshot } from "../../run-executor/native-view-source.ts";
