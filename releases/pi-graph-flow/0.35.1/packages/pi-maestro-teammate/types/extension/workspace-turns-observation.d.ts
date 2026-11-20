import type { ObservationDetail, ObservationTarget, ObservationReadOptions, ObservationSnapshot } from '../public/v1/observation.ts';
import { type WorkspaceOwnerSnapshot } from './workspace-peers.ts';
export { groupWorkspacePeerTurns } from 'pi-graph-observability/execution';
export type { WorkspacePeerTurn } from 'pi-graph-observability/execution';
export declare function workspaceTurnsSnapshot(owner: WorkspaceOwnerSnapshot, target: ObservationTarget, detail: ObservationDetail, lines: number, options: ObservationReadOptions): ObservationSnapshot;
