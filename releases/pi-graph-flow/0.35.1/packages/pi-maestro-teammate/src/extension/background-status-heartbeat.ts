import {createBackgroundStatusHeartbeat as createCore,createBackgroundStatusHeartbeatForHost as createForHost} from 'pi-graph-observability/execution';
import type {BackgroundStatusSnapshot,BackgroundStatusHeartbeatMessage,BackgroundStatusHeartbeatController} from 'pi-graph-observability/execution';
export {BACKGROUND_STATUS_HEARTBEAT_MS,supportsNativeCacheWarming} from 'pi-graph-observability/execution';
export type {BackgroundStatusTeammate,BackgroundStatusBashJob,BackgroundStatusSnapshot,BackgroundStatusHeartbeatMessage,BackgroundStatusHeartbeatController} from 'pi-graph-observability/execution';
import {buildBackgroundStatusHeartbeatMessage as buildCore} from 'pi-graph-observability/execution';
interface BackgroundStatusHeartbeatScheduler {
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface BackgroundStatusHeartbeatOptions {
  capture: () => BackgroundStatusSnapshot;
  deliver: (message: BackgroundStatusHeartbeatMessage) => boolean;
  intervalMs?: number;
  now?: () => number;
  scheduler?: BackgroundStatusHeartbeatScheduler;
}


function adapt(options:BackgroundStatusHeartbeatOptions){const scheduler=options.scheduler??{setTimeout:(cb:()=>void,ms:number)=>setTimeout(cb,ms),clearTimeout:(timer:ReturnType<typeof setTimeout>)=>clearTimeout(timer)};return {capture:options.capture,deliver:options.deliver,intervalMs:options.intervalMs,clock:{now:options.now??Date.now,schedule(ms:number,fn:()=>void){const timer=scheduler.setTimeout(fn,ms);timer.unref?.();return {cancel:()=>scheduler.clearTimeout(timer)};}}};}
export function createBackgroundStatusHeartbeat(options:BackgroundStatusHeartbeatOptions):BackgroundStatusHeartbeatController{return createCore(adapt(options));}
export function createBackgroundStatusHeartbeatForHost(version:string|undefined,options:BackgroundStatusHeartbeatOptions):BackgroundStatusHeartbeatController{return createForHost(version,adapt(options));}
export function buildBackgroundStatusHeartbeatMessage(input:BackgroundStatusSnapshot,observedAt=Date.now()):BackgroundStatusHeartbeatMessage{return buildCore(input,observedAt);}
