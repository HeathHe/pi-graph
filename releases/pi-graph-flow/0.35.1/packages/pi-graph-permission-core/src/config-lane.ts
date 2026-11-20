export interface ConfigLane<Host,Draft> {
 readonly key:string;readonly cwd:string;readonly sessionId:string;readonly host:Host;
 readonly busy:boolean;readonly revision:number|undefined;readonly draft:Draft|undefined;
 close():void;
}
type MutableLane<Host,Draft>={-readonly [K in keyof ConfigLane<Host,Draft>]:ConfigLane<Host,Draft>[K]};
/** Adopt the original registry itself: old closures retain the same maps and lane records. */
export function createConfigLaneRegistry<Host,Draft,Api extends object>(inherited?:unknown) {
 type State={lanes:Map<string,ConfigLane<Host,Draft>>;owners:WeakMap<Api,()=>void>};
 if(inherited!==undefined&&(typeof inherited!=="object"||inherited===null||!((inherited as State).lanes instanceof Map)||!((inherited as State).owners instanceof WeakMap)))throw new Error("Unknown config registry shape");
 const state:State=(inherited as State|undefined)??{lanes:new Map(),owners:new WeakMap()};
 const {lanes,owners}=state;
 for(const [key,lane] of lanes)if(!lane||lane.key!==key||typeof lane.cwd!=="string"||typeof lane.sessionId!=="string"||typeof lane.busy!=="boolean"||typeof lane.close!=="function")throw new Error("Unknown config lane shape");
 return Object.assign(state,{
  create(input:{key:string;cwd:string;sessionId:string;host:Host;close():void}):ConfigLane<Host,Draft> {return {...input,busy:false,revision:undefined,draft:undefined};},
  get:(key:string)=>lanes.get(key),set:(key:string,lane:ConfigLane<Host,Draft>)=>{lanes.set(key,lane);},delete:(key:string)=>lanes.delete(key),
  setBusy:(lane:ConfigLane<Host,Draft>,busy:boolean)=>{(lane as MutableLane<Host,Draft>).busy=busy;},
  stage:(lane:ConfigLane<Host,Draft>,revision:number,draft?:Draft)=>{const row=lane as MutableLane<Host,Draft>;row.revision=revision;row.draft=draft;},
  getOwner:(api:Api)=>owners.get(api),setOwner:(api:Api,dispose:()=>void)=>{owners.set(api,dispose);},deleteOwner:(api:Api)=>owners.delete(api),
 });
}
