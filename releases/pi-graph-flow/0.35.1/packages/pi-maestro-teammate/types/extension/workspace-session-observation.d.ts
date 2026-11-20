import type { ObservationDetail, ObservationTarget, ObservationSnapshot } from '../public/v1/observation.ts';
import { type WorkspaceOwnerSnapshot } from './workspace-peers.ts';
export type { WorkspaceSessionObservationItem, WorkspaceTodoObservationItem } from 'pi-graph-observability/execution';
export declare function workspaceSessionObservationSnapshot(owner: WorkspaceOwnerSnapshot, target: ObservationTarget, detail: ObservationDetail, lines: number, cursor?: string): ObservationSnapshot;
export declare function workspaceTodosObservationSnapshot(owner: WorkspaceOwnerSnapshot, target: ObservationTarget, detail: ObservationDetail, lines: number): ObservationSnapshot;
