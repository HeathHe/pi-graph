import { join,resolve,relative,isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import { resolveHostSdkRoot } from "../../src/runtime/host-sdk.ts";

// CLI fixtures follow the installed package entry rather than an obsolete path.
const root=await resolveHostSdkRoot();
const pkg=JSON.parse(await readFile(join(root,"package.json"),"utf8"));
const entry=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.pi;
if(typeof entry!=='string')throw new Error("Installed Pi SDK has no CLI entry");
const path=resolve(root,entry),fromRoot=relative(root,path);
if(fromRoot.startsWith('..')||isAbsolute(fromRoot))throw new Error("Pi CLI entry escapes its SDK root");
export const piCliPath=path;
