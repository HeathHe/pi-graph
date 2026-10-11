import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { safeBytes } from "./evidence-files.ts";
import type { V3NodeContract } from "./workspace.ts";
export interface InputReadProof { name:string; identity:string; digest:string; }
export function inputArtifactName(contract:V3NodeContract, input:unknown):string|undefined {
 const path=(input as {path?:unknown})?.path;
 if(typeof path!=="string")return;
 const target=resolve(contract.workspaceCwd,path);
 return Object.keys(contract.inputBaseline).find(name=>target===join(contract.workspaceCwd,".pi-graph","inputs",name));
}
export async function proveInputRead(contract:V3NodeContract,name:string):Promise<InputReadProof> {
 const path=join(contract.workspaceCwd,".pi-graph","inputs",name), expected=contract.inputBaseline[name]?.digest;
 if(!expected)throw new Error("Graph input integrity unavailable.");
 const identity=(s:Awaited<ReturnType<typeof lstat>>)=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.nlink].join(":");
 const before=await lstat(path), bytes=await safeBytes(contract.workspaceCwd,`.pi-graph/inputs/${name}`), after=await lstat(path);
 const digest=createHash("sha256").update(bytes).digest("hex");
 if(before.isSymbolicLink() || !before.isFile() || identity(before)!==identity(after) || digest!==expected)throw new Error("Graph input integrity mismatch.");
 return {name,identity:identity(after),digest};
}
