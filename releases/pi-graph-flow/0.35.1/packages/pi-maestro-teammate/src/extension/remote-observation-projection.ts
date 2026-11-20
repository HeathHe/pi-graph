/** Driver types are structural inputs; core retains no execution capability. */
export {REMOTE_PROGRESS_RING_MAX_EVENTS,REMOTE_PROGRESS_RING_MAX_BYTES,createRemoteProgressRing,appendRemoteProgressEvent,groupRemoteTurns} from 'pi-graph-observability/execution';
export type {RemoteProgressEvent,RemoteProgressRing,RemoteTurn,RemoteSessionObservationItem} from 'pi-graph-observability/execution';
import {remoteTurnsSnapshot as coreTurnsSnapshot,remoteSessionSnapshot as coreSessionSnapshot} from 'pi-graph-observability/execution';
import type {RemoteProgressRing} from 'pi-graph-observability/execution';
import type {ObservationDetail,ObservationReadOptions,ObservationSnapshot,ObservationTarget} from '../public/v1/observation.ts';
import type {RemoteRunSnapshot} from '../remote/types.ts';
export const remoteTurnsSnapshot:(snapshot:RemoteRunSnapshot,ring:RemoteProgressRing|undefined,record:{name?:string;objective?:string}|undefined,target:ObservationTarget,detail:ObservationDetail,lines:number,options:ObservationReadOptions)=>ObservationSnapshot=coreTurnsSnapshot;
export const remoteSessionSnapshot:(snapshot:RemoteRunSnapshot,ring:RemoteProgressRing|undefined,record:{name?:string;objective?:string}|undefined,target:ObservationTarget,detail:ObservationDetail,lines:number,options:ObservationReadOptions)=>ObservationSnapshot=coreSessionSnapshot;
