/** Hook state is session-owned; execution/trust persistence remain injected Host effects. */
export function createHookLifecycle<Loaded>() {
 let loaded:Loaded|undefined,active=false,lifecycle=new AbortController(),toggles:Record<string,boolean>={},turnId:string|undefined,stopHookActive=false;
 const pendingContext:string[]=[];const toolContext=new Map<string,string[]>();
 return {
  get loaded(){return loaded;},get active(){return active;},get lifecycle(){return lifecycle;},get toggles():Readonly<Record<string,boolean>>{return toggles;},get turnId(){return turnId;},get stopHookActive(){return stopHookActive;},
  get pendingContext():readonly string[]{return pendingContext;},
  resetLifecycle(){lifecycle.abort();lifecycle=new AbortController();return lifecycle;},
  isCurrent(expected:AbortController){return expected===lifecycle&&!expected.signal.aborted;},
  assertCurrent(expected:AbortController){if(expected!==lifecycle||expected.signal.aborted)throw new Error("Hook lifecycle changed");},
  setLoaded(value:Loaded|undefined){loaded=value;},setActive(value:boolean){active=value;},setToggles(value:Record<string,boolean>){toggles=value;},
  setTurn(value:string|undefined){turnId=value;},ensureTurn(id:()=>string){return turnId??=id();},setStopActive(value:boolean){stopHookActive=value;},
  clearPending(){pendingContext.length=0;},appendPending(values:readonly string[]){pendingContext.push(...values);},takePending(){return pendingContext.splice(0);},
  setToolContext(id:string,value:string[]){toolContext.set(id,value);},getToolContext(id:string){return toolContext.get(id);},deleteToolContext(id:string){toolContext.delete(id);},clearToolContext(){toolContext.clear();},
 };
}
