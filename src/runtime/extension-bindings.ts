/** Bounded, canonical Graph-owned extension binding transport. */
const namespace=/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})\/[1-9][0-9]{0,8}$/u;
export function normalizeExtensionBindings(input:unknown):{value:Record<string,unknown>;json:string}|undefined {
 if(input===undefined)return undefined;
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('extensionBindings must be a plain JSON object.');
 const keys=Object.keys(input);if(keys.length>16)throw new Error('extensionBindings has too many namespaces.');
 for(const key of keys)if(!namespace.test(key))throw new Error(`extensionBindings namespace '${key}' must use a package-like name followed by '/<positive-version>'.`);
 let properties=0;const seen=new Set<object>();
 const visit=(raw:unknown,depth:number):unknown=>{
  if(raw===null||typeof raw==='string'||typeof raw==='boolean')return raw;
  if(typeof raw==='number'){if(!Number.isFinite(raw))throw new Error('extensionBindings requires finite numbers.');return raw;}
  if(!raw||typeof raw!=='object'||depth>16||seen.has(raw))throw new Error('extensionBindings requires bounded, acyclic JSON data.');
  if(Object.getOwnPropertySymbols(raw).length)throw new Error('extensionBindings cannot contain symbol keys.');
  seen.add(raw);
  try{
   if(Array.isArray(raw)){const values=[];for(let i=0;i<raw.length;i++){if(!Object.hasOwn(raw,i)||++properties>256)throw new Error('extensionBindings array exceeds bounded JSON data.');values.push(visit(raw[i],depth+1));}return Object.freeze(values);}
   if(Object.getPrototypeOf(raw)!==Object.prototype&&Object.getPrototypeOf(raw)!==null)throw new Error('extensionBindings requires plain JSON objects.');
   const value:Record<string,unknown>={};
   for(const key of Object.keys(raw).sort()){const descriptor=Object.getOwnPropertyDescriptor(raw,key)!;if(!('value'in descriptor)||++properties>256)throw new Error('extensionBindings requires bounded data properties.');Object.defineProperty(value,key,{value:visit(descriptor.value,depth+1),enumerable:true});}
   return Object.freeze(value);
  }finally{seen.delete(raw);}
 };
 const value=visit(input,0) as Record<string,unknown>;const json=JSON.stringify(value);
 if(Buffer.byteLength(json,'utf8')>16*1024)throw new Error('extensionBindings exceeds 16384 bytes.');
 return {value,json};
}
