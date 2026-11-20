export type RelayFailureReason = "unavailable" | "timeout" | "send-failed" | "aborted";
export type RelayResult<T> = {ok:true;result:T} | {ok:false;reason:RelayFailureReason;error?:string};
export interface RelayPorts<Timer> {
  available(): boolean;
  connected(): boolean;
  id(): string;
  correlationId(): string | undefined;
  send(message: unknown, done: (error?: Error | null) => void): void;
  listen(message: (message: unknown) => void, disconnect: () => void): void;
  timer(callback: () => void, ms: number): Timer;
  clear(timer: Timer | undefined): void;
}
export interface RelayState<Timer> {
  installed:boolean;
  pending:Map<string,{resolve(value:unknown):void;fail(reason:RelayFailureReason,error?:string):void;timer:Timer}>;
}
export function createRelayLifecycle<Timer>(ports: RelayPorts<Timer>, inherited?:unknown) {
  if(inherited!==undefined && (typeof inherited!=="object" || inherited===null ||
    typeof (inherited as RelayState<Timer>).installed!=="boolean" || !((inherited as RelayState<Timer>).pending instanceof Map)))
    throw new Error("Unknown relay lifecycle shape");
  const state:RelayState<Timer>=(inherited as RelayState<Timer>|undefined)??{installed:false,pending:new Map()};
  for(const [id,item] of state.pending)if(typeof id!=="string"||!item||typeof item.resolve!=="function"||typeof item.fail!=="function"||!("timer" in item))throw new Error("Unknown relay pending shape");
  const pending=state.pending;
  function install() {
    if (state.installed) return;
    state.installed = true;
    ports.listen(message => {
      const record = message as Record<string, unknown>;
      if (record?.type !== "teammate_interaction_response" || typeof record.requestId !== "string") return;
      pending.get(record.requestId)?.resolve(record.result);
    }, () => { for (const item of [...pending.values()]) item.fail("unavailable"); });
  }
  function failure(error:unknown): RelayResult<never> {
    const message=error instanceof Error?error.message:String(error);
    const code=error&&typeof error==="object"&&"code" in error?String(error.code??""):"";
    return !ports.connected()||code==="EPIPE"||code==="ERR_IPC_CHANNEL_CLOSED"||/\bEPIPE\b/u.test(message)
      ?{ok:false,reason:"unavailable"}:{ok:false,reason:"send-failed",error:message};
  }
  return Object.assign(state,{async request<T>(interaction:"permission"|"question",payload:Record<string,unknown>,timeoutMs=10*60_000,signal?:AbortSignal):Promise<RelayResult<T>> {
    if(!ports.available())return {ok:false,reason:"unavailable"};
    if(signal?.aborted)return {ok:false,reason:"aborted"};
    install(); const requestId=ports.id();
    return new Promise(resolve=>{
      let settled=false;let timer:Timer|undefined;
      const finish=(result:RelayResult<T>)=>{if(settled)return;settled=true;ports.clear(timer);signal?.removeEventListener("abort",onAbort);pending.delete(requestId);resolve(result);};
      const onAbort=()=>{try{ports.send({type:"teammate_proxy_cancel",requestId,reason:"aborted"},()=>{});}catch{}finish({ok:false,reason:"aborted"});};
      timer=ports.timer(()=>finish({ok:false,reason:"timeout"}),timeoutMs);
      signal?.addEventListener("abort",onAbort,{once:true});
      if(signal?.aborted){onAbort();return;}
      pending.set(requestId,{timer:timer!,resolve:value=>finish({ok:true,result:value as T}),fail:(reason,error)=>finish({ok:false,reason,...(error===undefined?{}:{error})})});
      try { ports.send({type:"teammate_interaction_request",requestId,interaction,correlationId:ports.correlationId(),payload},error=>{if(error)finish(failure(error));}); }
      catch(error){finish(failure(error));}
    });
  }});
}
