/** One classifier registration owns config/source generation; the engine remains the actual IO adapter. */
export function createClassifierSession<Config>(initial:Config) {
 let config=initial,cwd:string|undefined,sessionId:string|undefined,runtime:unknown,loading:Promise<Config>|undefined,generation=0,disposed=false,panel:AbortController|undefined;
 const fence=()=>{generation++;panel?.abort();panel=undefined;};
 return {
  get config(){return config;},get cwd(){return cwd;},get sessionId(){return sessionId;},get runtime(){return runtime;},get loading(){return loading;},get generation(){return generation;},get disposed(){return disposed;},get panel(){return panel;},
  apply(value:Config){config=value;},bind(nextCwd:string,nextSession:string|undefined,nextRuntime:unknown){cwd=nextCwd;sessionId=nextSession;runtime=nextRuntime;},
  setLoading(value:Promise<Config>){loading=value;},finishLoading(value:Promise<Config>){if(loading===value)loading=undefined;},
  fence,dispose(){disposed=true;fence();},resetCwd(){cwd=undefined;},setPanel(value:AbortController){panel=value;},finishPanel(value:AbortController){if(panel===value)panel=undefined;},
 };
}
