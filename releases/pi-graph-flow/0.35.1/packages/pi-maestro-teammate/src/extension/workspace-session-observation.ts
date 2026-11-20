import {workspaceSessionObservationSnapshot as session,workspaceTodosObservationSnapshot as todos} from 'pi-graph-observability/execution';
import type {ObservationDetail,ObservationTarget,ObservationSnapshot} from '../public/v1/observation.ts';
import {workspaceWindowLifecycle,type WorkspaceOwnerSnapshot} from './workspace-peers.ts';
import {sessionProgressInput} from '../observability/host-adapter.ts';
export type {WorkspaceSessionObservationItem,WorkspaceTodoObservationItem} from 'pi-graph-observability/execution';
export function workspaceSessionObservationSnapshot(owner:WorkspaceOwnerSnapshot,target:ObservationTarget,detail:ObservationDetail,lines:number,cursor?:string):ObservationSnapshot{return session(sessionProgressInput(owner,workspaceWindowLifecycle(owner)),target,detail,lines,cursor);}
export function workspaceTodosObservationSnapshot(owner:WorkspaceOwnerSnapshot,target:ObservationTarget,detail:ObservationDetail,lines:number):ObservationSnapshot{return todos(sessionProgressInput(owner,workspaceWindowLifecycle(owner)),target,detail,lines);}
