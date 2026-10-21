import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostSdk } from "../../src/runtime/host-sdk.ts";
const NAME="@earendil-works/pi-coding-agent";
const repository=resolve(fileURLToPath(new URL("../../",import.meta.url)));
const within=(root:string,path:string)=>{const rel=relative(root,path);return rel===""||(!isAbsolute(rel)&&rel!==".."&&!rel.startsWith(".."+sep));};
export interface TestPiCli {root:string;cli:string;version:string;managedVersion?:string;}
/** Test-only: validate a root obtained from the actual installed executable, never an SDK environment override. */
export async function testCliFromRoot(candidate:string,executable?:string):Promise<TestPiCli>{
 const root=await realpath(candidate);
 if(within(await realpath(repository),root))throw Error("Refuse extension-owned development Pi SDK");
 for(let parent=dirname(root);;parent=dirname(parent)){
  let owner:any;try{owner=JSON.parse(await readFile(join(parent,"package.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(owner?.name==="pi-graph"||Array.isArray(owner?.pi?.extensions))throw Error("Refuse extension-owned development Pi SDK");
  if(dirname(parent)===parent)break;
 }
 const pkg=JSON.parse(await readFile(join(root,"package.json"),"utf8"));
 if(pkg.name!==NAME||typeof pkg.version!=="string"||!pkg.version.trim())throw Error("Invalid installed Pi package identity");
 const bin=typeof pkg.bin==="string"?pkg.bin:pkg.bin?.pi,entry=pkg.exports?.["."]?.import;
 if(typeof bin!=="string"||!bin||isAbsolute(bin)||typeof entry!=="string"||!entry.startsWith("./"))throw Error("Installed Pi lacks relative CLI/import entries");
 const inside=async(value:string)=>{const lexical=resolve(root,value);if(!within(root,lexical))throw Error("Pi entry escapes package");const canonical=await realpath(lexical);if(!within(root,canonical)||!(await lstat(canonical)).isFile())throw Error("Pi entry escapes package or is not a regular file");return canonical;};
 const cli=await inside(bin);await inside(entry);
 if(executable&&cli!==await realpath(executable))throw Error("Installed Pi executable disagrees with package bin entry");
 // Reuse the existing public capability contract; this does not change production discovery or frozen identities.
 await loadHostSdk(root);
 return {root,cli,version:pkg.version};
}
async function rootOfExecutable(executable:string):Promise<string|undefined>{
 let dir=dirname(executable);
 for(let index=0;index<8;index++){
  let pkg:any;try{pkg=JSON.parse(await readFile(join(dir,"package.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(pkg?.name===NAME)return dir;
  const parent=dirname(dir);if(parent===dir)break;dir=parent;
 }
 return undefined;
}
export async function testCliFromExecutable(path:string):Promise<TestPiCli>{
 const executable=await realpath(path);
 const root=await rootOfExecutable(executable);if(root)return testCliFromRoot(root,executable);
 // Only the known managed launcher layout is interpreted. Never execute or source arbitrary shell code.
 if(basename(executable)!=="pi"||basename(dirname(executable))!=="bin")throw Error("Pi executable is not a recognized installation");
 const launcher=await readFile(executable,"utf8");
 if(!launcher.startsWith("#!/bin/sh\n")||!launcher.includes("pi_current_file=$pi_agent_dir/install/current-version")||!launcher.includes("pi_release_dir=$pi_agent_dir/install/releases/$pi_current_version")||!launcher.includes('exec "$pi_release_bin" "$@"'))throw Error("Unrecognized managed Pi launcher");
 const install=join(dirname(dirname(executable)),"install"),installRoot=await realpath(install),pointer=join(install,"current-version");
 if((await lstat(pointer)).isSymbolicLink()||!(await lstat(pointer)).isFile())throw Error("Managed Pi version pointer must be a regular file");
 const pointerBytes=await readFile(pointer),raw=pointerBytes.toString("utf8"),version=raw.endsWith("\n")?raw.slice(0,-1):raw;
 if(raw.length>256||!version||version==="."||version===".."||!/^[0-9A-Za-z._+-]+$/.test(version))throw Error("Invalid managed Pi version component");
 const releases=await realpath(join(install,"releases")),selected=join(releases,version),selectedInfo=await lstat(selected);
 if(selectedInfo.isSymbolicLink()||!selectedInfo.isDirectory())throw Error("Managed Pi selected release must be a regular directory");
 const release=await realpath(selected);
 if(!within(installRoot,releases)||!within(releases,release)||release===releases)throw Error("Managed Pi release escapes installation");
 const bin=join(release,"node_modules/.bin/pi"),canonicalBin=await realpath(bin);
 if(!within(release,canonicalBin))throw Error("Managed Pi CLI escapes selected release");
 const sdkRoot=await rootOfExecutable(canonicalBin);if(!sdkRoot||!within(release,await realpath(sdkRoot)))throw Error("Managed Pi package is outside selected release");
 const result=await testCliFromRoot(sdkRoot,canonicalBin);
 if((await lstat(pointer)).isSymbolicLink()||!(await readFile(pointer)).equals(pointerBytes))throw Error("Managed Pi version changed during discovery");
 return {...result,managedVersion:version};
}
export async function discoverTestPiFromPath(pathValue=process.env.PATH??""):Promise<TestPiCli>{
 for(const entry of pathValue.split(delimiter)){
  if(!entry||!isAbsolute(entry))continue;
  const candidate=join(entry,"pi");
  try{await access(candidate,constants.X_OK);}catch(error){if(["ENOENT","EACCES","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??""))continue;throw error;}
  // The first shell-visible Pi is authoritative; invalid identity must not fall through to a dev SDK.
  return testCliFromExecutable(candidate);
 }
 throw Error("Cannot locate an installed Pi CLI on absolute PATH entries");
}
