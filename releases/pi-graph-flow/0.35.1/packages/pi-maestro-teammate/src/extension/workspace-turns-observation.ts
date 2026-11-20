import {workspaceTurnsSnapshot as turns} from 'pi-graph-observability/execution';
import type {ObservationDetail,ObservationTarget,ObservationReadOptions,ObservationSnapshot} from '../public/v1/observation.ts';
import {workspaceWindowLifecycle,type WorkspaceOwnerSnapshot} from './workspace-peers.ts';
import {sessionProgressInput} from '../observability/host-adapter.ts';
export {groupWorkspacePeerTurns} from 'pi-graph-observability/execution';
export type {WorkspacePeerTurn} from 'pi-graph-observability/execution';
export function workspaceTurnsSnapshot(owner:WorkspaceOwnerSnapshot,target:ObservationTarget,detail:ObservationDetail,lines:number,options:ObservationReadOptions):ObservationSnapshot{return turns(sessionProgressInput(owner,workspaceWindowLifecycle(owner)),target,detail,lines,options);}
