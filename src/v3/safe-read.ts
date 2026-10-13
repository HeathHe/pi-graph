import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

/** Three total attempts; retry only a proven regular-file atomic replacement. */
export async function readAtomicRegularFile(path: string, options: {
 maxBytes: number; invalidMessage: string; limitMessage?: string; expectedParentRealpath?: string;
}): Promise<string> {
 const parent=dirname(path), initial=await lstat(parent), canonical=await realpath(parent);
 const invalid=()=>new Error(options.invalidMessage);
 if(!initial.isDirectory()||initial.isSymbolicLink()||options.expectedParentRealpath!==undefined&&canonical!==options.expectedParentRealpath)throw invalid();
 const checkParent=async()=>{const info=await lstat(parent);if(!info.isDirectory()||info.isSymbolicLink()||info.dev!==initial.dev||info.ino!==initial.ino||await realpath(parent)!==canonical)throw invalid();};
 const checkFile=(info:Awaited<ReturnType<typeof lstat>>)=>{if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw invalid();if(info.size>options.maxBytes)throw new Error(options.limitMessage??options.invalidMessage);};
 for(let attempt=0;attempt<3;attempt++){
  await checkParent();
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const before=await file.stat();
   if(!before.isFile())throw invalid();
   const replacement=async(old:typeof before)=>{if(old.nlink!==0)throw invalid();await checkParent();const current=await lstat(path);checkFile(current);if(current.dev===old.dev&&current.ino===old.ino)throw invalid();};
   if(before.nlink===0){await replacement(before);continue;}
   checkFile(before);
   const bytes=await file.readFile();
   const after=await file.stat();
   if(after.nlink===0){await replacement(after);continue;}
   checkFile(after);await checkParent();
   if(bytes.length>options.maxBytes)throw new Error(options.limitMessage??options.invalidMessage);
   return bytes.toString("utf8");
  }finally{await file.close();}
 }
 throw invalid();
}
